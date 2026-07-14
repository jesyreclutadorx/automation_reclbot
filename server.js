const express = require('express');
const { exiftool } = require('exiftool-vendored');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const fetch = require('node-fetch');

// Activar el camuflaje contra sistemas de detección WebGL/Canvas/UserAgent
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/iniciar_despliegue', async (req, res) => {
    const { id_impresion, auth_key } = req.body;

    if (auth_key !== process.env.API_AUTH_KEY) {
        return res.status(401).send('No autorizado');
    }

    res.status(200).send('Proceso de publicación iniciado en segundo plano.');

    try {
        // 1. Obtener la fila correspondiente en Supabase
        const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/NAG_COLA_IMPRESION?id=eq.${id_impresion}`, {
            headers: {
                "apikey": process.env.SUPABASE_KEY,
                "Authorization": `Bearer ${process.env.SUPABASE_KEY}`
            }
        });
        const [registro] = await response.json();

        if (!registro) throw new Error("Registro no encontrado en Supabase");

        // Determinar extensión del archivo de forma segura
        const esVideo = registro.video_url_final.toLowerCase().endsWith('.mp4');
        const fileExtension = esVideo ? '.mp4' : '.jpg';
        const mediaPath = `asset_temporal${fileExtension}`;

        // 2. Descargar el archivo dinámicamente (video o imagen)
        const mediaRes = await fetch(registro.video_url_final);
        const fileStream = fs.createWriteStream(mediaPath);
        await new Promise((resolve, reject) => {
            mediaRes.body.pipe(fileStream);
            mediaRes.body.on("error", reject);
            fileStream.on("finish", resolve);
        });

        // 3. Sanitizado de Metadatos con Exiftool (Agnóstico a la extensión)
        await exiftool.write(mediaPath, { all: '' });
        
        if (fs.existsSync(`${mediaPath}_original`)) {
            fs.unlinkSync(`${mediaPath}_original`);
        }

        // 4. Lanzar Puppeteer con el escudo de evasión Stealth activado
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        const page = await browser.newPage();

        // Evitar fugas de identidad del navegador simulado
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const cookies = JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
        await page.setCookie(...cookies);

        // Ir al grupo de Facebook
        await page.goto(registro.plataforma); 
        await page.waitForNetworkIdle();

        // 5. Cambio de Identidad a la Página Emisora (Usa selectores estructurales ARIA)
        try {
            const selectorSelector = '[aria-label*="Interactuar como"], [aria-label*="Interact as"]';
            await page.waitForSelector(selectorSelector, { timeout: 5000 });
            await page.click(selectorSelector);
            await page.waitForTimeout(2000);

            const targetPageText = registro.cuenta_emisora;
            const [pageOption] = await page.$x(`//span[contains(text(), "${targetPageText}")]`);
            
            if (pageOption) {
                await pageOption.click();
                await page.waitForTimeout(3000); 
            }
        } catch (e) {
            console.log("No se requirió cambio de identidad o el selector no estuvo disponible.");
        }

        // 6. EVASIÓN DEL DOM DINÁMICO: Enfoque y Apertura de Ventana de Creación (Composer)
        // El contenedor del feed del grupo siempre está bajo el rol 'main'. El botón para abrir el creador tiene rol 'button'.
        const postTriggerSelector = 'div[role="main"] div[role="button"]';
        await page.waitForSelector(postTriggerSelector, { timeout: 15000 });
        await page.focus(postTriggerSelector);
        
        // Presionamos Enter nativo en el elemento enfocado por teclado para abrir el modal
        await page.keyboard.press('Enter');

        // 7. Navegación por Foco de Teclado WCAG dentro de la Ventana Modal
        // Por leyes de accesibilidad, al abrirse la publicación se levanta un contenedor con el rol 'dialog'
        const dialogSelector = 'div[role="dialog"]';
        await page.waitForSelector(dialogSelector, { timeout: 10000 });
        
        // Presionamos 'Tab' para forzar que el cursor del navegador se posicione dentro del Rich Text Editor (caja de texto)
        await page.keyboard.press('Tab');
        await page.waitForTimeout(1000);

        // Escribimos el Spintax directamente sobre el foco activo de teclado (sin buscar selectores de la caja de texto)
        await page.keyboard.type(registro.copy_spintax, { delay: 100 });
        await page.waitForTimeout(2000);

        // 8. Cargar el Multimedia Sanitizado
        // El campo de carga de archivos (input type=file) es nativo de HTML y se encuentra siempre dentro del diálogo modal
        const fileInputSelector = 'div[role="dialog"] input[type="file"]';
        await page.waitForSelector(fileInputSelector, { timeout: 5000 });
        const inputUpload = await page.$(fileInputSelector);
        await inputUpload.uploadFile(mediaPath);

        // Dar un tiempo prudente para el procesamiento local de la carga del archivo (video o imagen)
        await page.waitForTimeout(6000);

        // 9. Re-enfocar el editor y Publicar mediante Atajo de Teclado Universal
        // Hacemos un clic directo en la caja de texto rica (textbox) de la modal para asegurar el foco de teclado
        const textboxSelector = 'div[role="dialog"] [role="textbox"]';
        await page.waitForSelector(textboxSelector, { timeout: 5000 });
        await page.click(textboxSelector);
        await page.waitForTimeout(1000);

        // Enviamos la publicación mediante 'Ctrl + Enter' (atajo de accesibilidad nativo del framework Lexical/Draft.js de Meta)
        // Esto elimina por completo la necesidad de buscar y hacer clic en el botón físico de "Publicar"
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');

        // Esperar a que la página procese y guarde el envío en red antes de cerrar el navegador
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
            console.log("Navegación tras publicación excedió tiempo límite, pero el comando fue enviado.");
        });
        
        await browser.close();

        // 10. Actualizar estatus en Supabase a PUBLICADO
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/NAG_COLA_IMPRESION?id=eq.${id_impresion}`, {
            method: 'PATCH',
            headers: {
                "apikey": process.env.SUPABASE_KEY,
                "Authorization": `Bearer ${process.env.SUPABASE_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ status_publicacion: 'PUBLICADO' })
        });

        fs.unlinkSync(mediaPath);

    } catch (error) {
        console.error("Fallo en despliegue:", error);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en puerto: ${PORT}`);
});
