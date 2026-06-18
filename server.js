const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 5500;
const API_TARGET = 'https://music-api.gdstudio.xyz';

const MIME = {
    '.html': 'text/html;charset=utf-8',
    '.css': 'text/css;charset=utf-8',
    '.js': 'application/javascript;charset=utf-8',
    '.json': 'application/json;charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

http.createServer((req, res) => {
    const parsed = url.parse(req.url);
    const pathname = parsed.pathname;

    // Proxy API requests
    if (pathname === '/proxy') {
        const query = parsed.search || '';
        const targetUrl = `${API_TARGET}/api.php${query}`;
        console.log(`[Proxy] ${targetUrl}`);

        const proxyReq = https.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'application/json',
            },
            timeout: 30000,
        }, (proxyRes) => {
            let body = '';
            proxyRes.on('data', chunk => body += chunk);
            proxyRes.on('end', () => {
                res.writeHead(proxyRes.statusCode, {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': proxyRes.headers['content-type'] || 'application/json',
                });
                res.end(body);
            });
        });

        proxyReq.on('error', (err) => {
            console.error(`[Proxy Error] ${err.message}`);
            res.writeHead(502, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            res.writeHead(504, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy timeout' }));
        });

        return;
    }

    // Serve static files
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    const ext = path.extname(filePath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`API proxy -> ${API_TARGET}`);
});
