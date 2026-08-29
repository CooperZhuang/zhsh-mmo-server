'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createSaveApi } = require('../web/save-service');
const { createLogger, createLogEndpoint } = require('../web/logger');
const { buildBrowser } = require('./build-browser');

const root = path.resolve(__dirname,'..');
const distRoot = process.env.ZHSH_SKIP_BROWSER_BUILD==='1' ? path.join(root,'dist') : buildBrowser().distRoot;
if (!fs.existsSync(path.join(distRoot,'index.html'))) throw new Error('Browser dist is missing; run node scripts/build-browser.js before starting with ZHSH_SKIP_BROWSER_BUILD=1');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';
const contentTypes = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png' };

const logger = createLogger({ filename: 'dev-server.log' });
const logEndpoint = createLogEndpoint(logger);

const saveApi = createSaveApi({ databasePath: path.join(distRoot,'.zhsh-player-saves.sqlite') });
process.once('exit',()=>{try{saveApi.close();}catch{}});

function requestMeta(pathname, request) {
  const meta = { method: request.method, remote_ip: request.socket?.remoteAddress ?? null, content_length: Number(request.headers['content-length'] ?? 0) || null };
  if (pathname && (pathname === '/api/saves' || pathname.startsWith('/api/saves/') || pathname === '/api/active' || pathname.startsWith('/api/active/'))) {
    meta.group = 'api'; meta.api = pathname.startsWith('/api/saves') ? 'saves' : 'active';
    const rest = pathname.slice(meta.api === 'saves' ? '/api/saves/'.length : '/api/active/'.length);
    if (rest) meta.player_id = rest;
  } else if (pathname && pathname.startsWith('/api/')) { meta.group = 'api'; meta.api = pathname.split('/')[2] ?? ''; }
  return meta;
}

const server = http.createServer((request,response) => {
  const startedAt = Date.now();
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname); }
  catch { response.writeHead(400);response.end('Bad Request');logger.warn('http','GET invalid url -> 400');return; }
  const meta = requestMeta(pathname, request);
  response.on('finish',() => {
    const duration = Date.now() - startedAt;
    const level = response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http',`${request.method} ${pathname} -> ${response.statusCode} (${duration}ms)`,{ ...meta, status: response.statusCode, duration_ms: duration });
  });
  if (logEndpoint(request,response,pathname,new URL(request.url,'http://localhost'))) return;
  if (saveApi.handle(request,response,pathname,new URL(request.url,'http://localhost'))) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405);response.end('Method Not Allowed');return; }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(distRoot,relative);
  if (!filePath.startsWith(`${distRoot}${path.sep}`) && filePath !== path.join(distRoot,'index.html')) { response.writeHead(403);response.end('Forbidden');return; }
  fs.readFile(filePath,(error,data) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500);response.end('Not found');return; }
    response.writeHead(200,{ 'Content-Type':contentTypes[path.extname(filePath)] ?? 'application/octet-stream','Cache-Control':'no-store' });
    response.end(data);
  });
});

server.on('error',(error) => {
  logger.error('server','listen failed',{ reason: error.message, stack: error.stack, port });
  process.stderr.write(`开发服务器启动失败：${error.message}\n`);
  process.exit(1);
});
server.listen(port,host,() => {
  logger.info('server','listening',{ host, port, pid: process.pid });
  console.log(`ZHSH browser slice: http://${host}:${port}`);
});
process.once('SIGINT',() => logger.info('server','shutdown initiated',{ signal: 'SIGINT' }));
process.once('SIGTERM',() => logger.info('server','shutdown initiated',{ signal: 'SIGTERM' }));
