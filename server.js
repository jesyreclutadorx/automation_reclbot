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

        // Ir al grupo de Facebook de destino
        await page.goto(registro.plataforma); // Asume que el campo 'plataforma' contiene la URL del grupo de FB

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

        // 5. Actualizar estatus en Supabase a PUBLICADO
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
