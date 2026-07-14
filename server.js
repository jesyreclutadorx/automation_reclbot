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

        // 5. Cambio de Identidad a la Página Emisora
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
            console.log("No se requirió cambio de identidad o selector no disponible.");
        }

        // 6. Selección de Caja de Texto Mediante Atributos de Accesibilidad (Anti-cambios del DOM)
        // Apuntamos al elemento interactivo del ed
