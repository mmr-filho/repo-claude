// Servidor estático + proxy reverso para a API do Sigilo (inclui upgrade de WebSocket).
// Serve o app exportado para web e encaminha as rotas da API, para o navegador falar com tudo na mesma origem.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export function serve({ dist, apiPort, port }) {
  const API = /^\/(q|health)(\/|\?|$)/;
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };

  const server = http.createServer((req, res) => {
    if (API.test(req.url)) {
      const up = http.request({ host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      req.pipe(up);
      return;
    }
    let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(apiPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`), '', ''];
      up.write(lines.join('\r\n'));
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
