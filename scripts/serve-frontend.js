/**
 * scripts/serve-frontend.js
 * Lightweight HTTP server for the frontend (so fetch() works without CORS issues).
 * Run: node scripts/serve-frontend.js
 * Open: http://localhost:3000
 */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT    = 3000;
const FRONTEND = path.join(__dirname, '..', 'frontend');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

http.createServer((req, res) => {
  let filePath = path.join(FRONTEND, req.url === '/' ? 'index.html' : req.url);
  // Prevent directory traversal
  if (!filePath.startsWith(FRONTEND)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  console.log(`\n  MailBlast Frontend  →  http://localhost:${PORT}\n`);
});
