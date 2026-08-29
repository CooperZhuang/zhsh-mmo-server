'use strict';

const childProcess=require('node:child_process');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const os=require('node:os');
const {createSaveApi}=require('./save-service');

const root=__dirname;
const listenPort=20109;
const lockPath=path.join(root,'.zhsh-game-server.lock');
const listenHost='0.0.0.0';
const mimeTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.txt':'text/plain; charset=utf-8'};
let server=null;let lockOwned=false;let shuttingDown=false;

const saveApi=createSaveApi({databasePath:path.join(root,'.zhsh-player-saves.sqlite')});
process.once('exit',()=>{try{saveApi.close();}catch{}});

function existingServer(){
  if(!fs.existsSync(lockPath))return null;
  try{const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));process.kill(Number(lock.pid),0);
    for(let attempt=0;attempt<30&&!lock.url;attempt+=1){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);Object.assign(lock,JSON.parse(fs.readFileSync(lockPath,'utf8')));}
    return lock.url?lock:null;
  }catch{try{fs.rmSync(lockPath,{force:true});}catch{}return null;}
}
function acquireLock(){
  const existing=existingServer();if(existing)return existing;
  try{const descriptor=fs.openSync(lockPath,'wx');fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,url:null}));fs.closeSync(descriptor);lockOwned=true;return null;}
  catch(error){if(error.code!=='EEXIST')throw error;return existingServer()??{pid:null,url:null,starting:true};}
}
function openBrowser(url){
  if(process.platform==='win32'){const child=childProcess.spawn('cmd.exe',['/d','/s','/c',`start "" "${url}"`],{detached:true,stdio:'ignore',windowsHide:true});child.unref();return;}
  const command=process.platform==='darwin'?'open':'xdg-open';const child=childProcess.spawn(command,[url],{detached:true,stdio:'ignore'});child.unref();
}
function requestHandler(request,response){
  if(!['GET','HEAD','PUT','DELETE'].includes(request.method)){response.writeHead(405,{'Content-Type':'text/plain; charset=utf-8'});response.end('Method Not Allowed');return;}
  let pathname;try{pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);}catch{response.writeHead(400);response.end('Bad Request');return;}
  if(saveApi.handle(request,response,pathname,new URL(request.url,'http://127.0.0.1')))return;
  if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405,{'Content-Type':'text/plain; charset=utf-8'});response.end('Method Not Allowed');return;}
  const relative=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');const filePath=path.resolve(root,relative);
  if(filePath!==path.join(root,'index.html')&&!filePath.startsWith(`${root}${path.sep}`)){response.writeHead(403);response.end('Forbidden');return;}
  fs.readFile(filePath,(error,data)=>{if(error){response.writeHead(error.code==='ENOENT'?404:500,{'Content-Type':'text/plain; charset=utf-8'});response.end(error.code==='ENOENT'?'Not Found':'Server Error');return;}
    response.writeHead(200,{'Content-Type':mimeTypes[path.extname(filePath).toLowerCase()]??'application/octet-stream','Cache-Control':'no-store'});if(request.method==='HEAD')response.end();else response.end(data);});
}
function localAddresses(){
  const addresses=[];
  const interfaces=os.networkInterfaces();
  for(const name of Object.keys(interfaces)){
    for(const iface of interfaces[name]||[]){
      if(iface.family==='IPv4'&&!iface.internal){addresses.push(iface.address);}
    }
  }
  return addresses;
}
function listen(){
  server=http.createServer(requestHandler);server.once('error',(error)=>{if(error.code==='EADDRINUSE'){cleanup();process.stderr.write(`端口 ${listenPort} 已被占用，请关闭占用该端口的程序后重试。\n`);process.exit(1);}fail(error);});
  server.listen(listenPort,listenHost,()=>{const localUrl=`http://127.0.0.1:${listenPort}/`;const lan=localAddresses();fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,port:listenPort,url:localUrl}),'utf8');
    let message=`\n游戏已启动：${localUrl}\n`;
    if(lan.length){message+=`局域网设备请访问：\n`+lan.map((address)=>`  http://${address}:${listenPort}/\n`).join('');}
    message+=`关闭此窗口或按 Ctrl+C 即可停止游戏。\n\n`;
    process.stdout.write(message);if(process.argv.includes('--open'))openBrowser(localUrl);});
}
function cleanup(){if(lockOwned){try{const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));if(Number(lock.pid)===process.pid)fs.rmSync(lockPath,{force:true});}catch{}lockOwned=false;}}
function shutdown(){if(shuttingDown)return;shuttingDown=true;if(server)server.close(()=>{cleanup();process.exit(0);});else{cleanup();process.exit(0);}setTimeout(()=>{cleanup();process.exit(0);},1500).unref();}
function fail(error){cleanup();process.stderr.write(`游戏服务器启动失败：${error.message}\n`);process.exit(1);}

const existing=acquireLock();
if(existing){process.stdout.write(existing.url?`游戏已经在运行：${existing.url}\n`:'游戏正在启动，请稍候。\n');if(existing.url&&process.argv.includes('--open'))openBrowser(existing.url);process.exit(0);}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);process.once('exit',cleanup);process.once('uncaughtException',fail);listen();
