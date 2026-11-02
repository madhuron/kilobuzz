// Dev-режим: открывает интерфейс в обычном браузере (без Electron) на http://localhost:5173
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../src/renderer');
const extra = process.argv[2] ? path.resolve(process.argv[2]) : null; // папка с тестовыми треками → /media/
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = url.startsWith('/media/') && extra
    ? path.join(extra, path.basename(url))
    : path.join(root, path.normalize(url === '/' ? '/index.html' : url));
  if (!file.startsWith(root) && !(extra && file.startsWith(extra))) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(5173, () => console.log('http://localhost:5173'));
