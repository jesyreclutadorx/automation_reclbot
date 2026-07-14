const express = require('express');
const { exiftool } = require('exiftool-vendored');
const puppeteer = require('puppeteer');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/iniciar_despliegue', async (req, res) => {
    const { id_impresion, auth_key } = req.body;

    // Validación de seguridad básica
    if (auth_key !== process.env.API_AUTH_KEY) {
        return res.status(401).send('No autorizado');
    }

    res.status(200).send('Proceso de publicación iniciado en segundo plano.');

    try {
        // 1. Obtener la información de la cola de impresión desde Supabase
        const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/NAG_COLA_IMPRESION?id=eq.${id_impresion}`, {
            headers: {
                "apikey": process.env.SUPABASE_KEY,
                "Authorization": `Bearer ${process.env.SUPABASE_KEY}`
            }
        });
        const [registro] = await response.json();

        if (!registro) throw new Error("Registro no encontrado en Supabase");

        // 2. Descargar el video temporalmente a disco
        const videoPath = 'video_temporal.mp4';
        const videoRes = await fetch(registro.video_url_final);
        const fileStream = fs.createWriteStream(videoPath);
        await new Promise((resolve, reject) => {
            videoRes.body.pipe(fileStream);
            videoRes.body.on("error", reject);
            fileStream.on("finish", resolve);
        });

        // 3. PASO QUIRÚRGICO: Borrar metadatos del video con Exiftool
        await exiftool.write(videoPath, { all: '' });
        
        // Limpieza de archivos de respaldo que crea Exiftool automáticamente
        if (fs.existsSync('video_temporal.mp4_original')) {
            fs.unlinkSync('video_temporal.mp4_original');
        }

        // 4. Iniciar Puppeteer para publicación automatizada
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // Cargar cookies de sesión previamente guardadas para evitar login de contraseña
        const cookies = JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
        await page.setCookie(...cookies);

       // 5. Entrar al grupo de Facebook de destino
await page.goto(registro.plataforma); 
await page.waitForNetworkIdle();

try {
    // 6. Buscar el botón de "Interactuar como" (suele tener una imagen pequeña de tu perfil)
    // Usamos selectores basados en accesibilidad (aria-label) que son más estables en Facebook
    const selectorSelector = '[aria-label*="Interactuar como"], [aria-label*="Interact as"]';
    await page.waitForSelector(selectorSelector, { timeout: 5000 });
    await page.click(selectorSelector);

    // 7. Esperar a que se abra la ventanita con la lista de tus páginas
    await page.waitForTimeout(2000);

    // 8. Hacer clic específicamente en la página que indica la base de datos (NAG_COLA_IMPRESION.cuenta_emisora)
    // El robot buscará el texto exacto, por ejemplo: "Page_FB_01_Añejada"
    const targetPageText = registro.cuenta_emisora;
    const [pageOption] = await page.$x(`//span[contains(text(), "${targetPageText}")]`);
    
    if (pageOption) {
        await pageOption.click();
        console.log(`Identidad cambiada con éxito a: ${targetPageText}`);
        // Esperar 3 segundos para que Facebook procese el cambio de perfil dentro del grupo
        await page.waitForTimeout(3000); 
    } else {
        console.log(`No se encontró la página ${targetPageText} en la lista. Publicando con perfil personal.`);
    }
} catch (e) {
    console.log("No se requirió cambio de identidad o el botón no está disponible. Procediendo directo.");
}

        // Simular escritura humana de Spintax
        await page.waitForSelector('text=Escribe algo...');
        await page.click('text=Escribe algo...');
        await page.keyboard.type(registro.copy_spintax, { delay: 100 });

        // Cargar el video sanitizado y publicar
        const inputUpload = await page.$('input[type="file"]');
        await inputUpload.uploadFile(videoPath);
        await page.click('text=Publicar');

        await page.waitForNavigation();
        await browser.close();

        // 9. Actualizar estatus en Supabase a PUBLICADO
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/NAG_COLA_IMPRESION?id=eq.${id_impresion}`, {
            method: 'PATCH',
            headers: {
                "apikey": process.env.SUPABASE_KEY,
                "Authorization": `Bearer ${process.env.SUPABASE_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ status_publicacion: 'PUBLICADO' })
        });

        // Limpiar el video local
        fs.unlinkSync(videoPath);

    } catch (error) {
        console.error("Fallo en despliegue:", error);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en puerto: ${PORT}`);
});
