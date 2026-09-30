'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError, createRoutingService } = require('./routing.cjs');

// Explizite Freigabeliste statt eines Dateiservers für den Projektordner.
const publicFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/script.js', ['script.js', 'text/javascript; charset=utf-8']],
    ['/tankstellen.json', ['tankstellen.json', 'application/json; charset=utf-8']]
]);
function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
}
async function readJson(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new AppError(415, 'JSON-Anfrage erforderlich.');
    let text = '';
    for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 4096) throw new AppError(413, 'Die Anfrage ist zu groß.');
    }
    try { return JSON.parse(text); } catch { throw new AppError(400, 'Ungültige Anfrage.'); }
}
function createServer({ service, root = __dirname }) {
    return http.createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        try {
            // Lokaler Betrieb; fremde Webseiten dürfen keine kostenpflichtigen API-Aufrufe auslösen.
            if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) throw new AppError(403, 'Nur lokaler Zugriff erlaubt.');
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (url.pathname.startsWith('/api/')) {
                if (req.method !== 'POST') throw new AppError(405, 'Bitte POST verwenden.');
                if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== url.origin)) {
                    throw new AppError(403, 'Anfrage von einer fremden Webseite abgelehnt.');
                }
                const body = await readJson(req);
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Ungültige Anfrage.');
                if (url.pathname === '/api/geocode') return json(res, 200, await service.geocode(body.query));
                if (url.pathname === '/api/routes') return json(res, 200, await service.routes(body.candidateId));
                throw new AppError(404, 'Nicht gefunden.');
            }
            if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(405, 'Methode nicht erlaubt.');
            const asset = publicFiles.get(url.pathname);
            if (!asset) throw new AppError(404, 'Nicht gefunden.');
            const content = await fs.readFile(path.join(root, asset[0]));
            res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
            res.end(req.method === 'HEAD' ? undefined : content);
        } catch (error) {
            // Niemals ORS-Antworten, Schlüssel oder interne Fehlerdetails an den Browser weiterreichen.
            json(res, error instanceof AppError ? error.status : 500,
                { error: error instanceof AppError ? error.message : 'Interner Fehler. Bitte den Server neu starten.' });
        }
    });
}
async function main() {
    try { process.loadEnvFile(path.join(__dirname, '.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Die lokale .env-Datei konnte nicht geladen werden.'); }
    const { tankstellen } = JSON.parse(await fs.readFile(path.join(__dirname, 'tankstellen.json'), 'utf8'));
    if (!Array.isArray(tankstellen) || new Set(tankstellen.map(t => t.id)).size !== tankstellen.length) {
        throw new Error('Tankstellendaten benötigen eindeutige IDs.');
    }
    const service = createRoutingService({ stations: tankstellen, apiKey: process.env.ORS_API_KEY,
        nominatimUrl: process.env.NOMINATIM_URL || undefined, userAgent: process.env.NOMINATIM_USER_AGENT || undefined });
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ungültiger PORT in .env.');
    const server = createServer({ service });
    server.on('error', error => {
        console.error(error.code === 'EADDRINUSE' ? `Port ${port} ist belegt. Beende den alten Server oder ändere PORT in .env.` : 'Der lokale Server konnte nicht gestartet werden.');
        process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`Tankstellen finder: http://localhost:${port}`));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createServer };
