'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildBrowser } = require('./build-browser');

const root = path.resolve(__dirname,'..');
const distRoot = process.env.ZHSH_SKIP_BROWSER_BUILD==='1' ? path.join(root,'dist') : buildBrowser().distRoot;
if (!fs.existsSync(path.join(distRoot,'index.html'))) throw new Error('Browser dist is missing; run node scripts/build-browser.js before starting with ZHSH_SKIP_BROWSER_BUILD=1');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';
const contentTypes = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png' };

const server = http.createServer((request,response) => {
  const pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(distRoot,relative);
  if (!filePath.startsWith(`${distRoot}${path.sep}`) && filePath !== path.join(distRoot,'index.html')) { response.writeHead(403);response.end('Forbidden');return; }
  fs.readFile(filePath,(error,data) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500);response.end('Not found');return; }
    response.writeHead(200,{ 'Content-Type':contentTypes[path.extname(filePath)] ?? 'application/octet-stream','Cache-Control':'no-store' });
    response.end(data);
  });
});

server.listen(port,host,() => console.log(`ZHSH browser slice: http://${host}:${port}`));
