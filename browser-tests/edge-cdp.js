'use strict';

const childProcess=require('node:child_process');
const fs=require('node:fs');
const http=require('node:http');
const net=require('node:net');
const os=require('node:os');
const path=require('node:path');

function delay(milliseconds){return new Promise((resolve)=>setTimeout(resolve,milliseconds));}

function executableOnPath(command){
  if(!command)return null;
  if(path.isAbsolute(command)||command.includes(path.sep))return fs.existsSync(command)?command:null;
  const pathEntries=String(process.env.PATH??'').split(path.delimiter);
  const extensions=process.platform==='win32'?String(process.env.PATHEXT??'.EXE;.CMD;.BAT').split(';'):[''];
  for(const directory of pathEntries)for(const extension of extensions){const candidate=path.join(directory,`${command}${extension}`);if(fs.existsSync(candidate))return candidate;}
  return null;
}

function findEdgeExecutable(){
  const candidates=[process.env.ZHSH_BROWSER_EXECUTABLE,process.env.ZHSH_EDGE_EXECUTABLE,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'microsoft-edge','microsoft-edge-stable','chromium','chromium-browser','google-chrome','google-chrome-stable'];
  const executable=candidates.map(executableOnPath).find(Boolean);
  if(!executable)throw new Error('A Chromium-family browser is required for DOM E2E; set ZHSH_BROWSER_EXECUTABLE (or legacy ZHSH_EDGE_EXECUTABLE)');
  return executable;
}

async function terminateProcessTree(child,{timeout=3000}={}){
  if(!child||child.exitCode!==null)return;
  try{if(process.platform==='win32'){const result=childProcess.spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',timeout:1500});if(result.error||result.status!==0)child.kill('SIGTERM');}else process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
  await Promise.race([new Promise((resolve)=>child.once('exit',resolve)),delay(timeout)]);
  if(child.exitCode===null)try{if(process.platform==='win32'){const result=childProcess.spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',timeout:1500});if(result.error||result.status!==0)child.kill('SIGKILL');}else process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}
  if(child.exitCode===null){for(const stream of [child.stdout,child.stderr])stream?.destroy?.();child.unref?.();}
}


async function freePort(){
  return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
    const {port}=server.address();server.close((error)=>error?reject(error):resolve(port));
  });});
}

async function waitForHttp(url,{timeout=30000}={}){
  const deadline=Date.now()+timeout;let lastError;
  while(Date.now()<deadline){try{await new Promise((resolve,reject)=>{const request=http.get(url,(response)=>{
    response.resume();response.statusCode&&response.statusCode<500?resolve():reject(new Error(`HTTP ${response.statusCode}`));
  });request.once('error',reject);request.setTimeout(1000,()=>request.destroy(new Error('HTTP timeout')));});return;}catch(error){lastError=error;await delay(50);}}
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message??'no response'}`);
}

async function startStaticServer(root){
  const port=await freePort();const output=[];const bindHost=process.env.ZHSH_BROWSER_BIND_HOST??'127.0.0.1';
  const browserHost=process.env.ZHSH_BROWSER_HOST??(bindHost==='0.0.0.0'?'127.0.0.1':bindHost);
  // 服务器权威版（scripts/dev-server.js 已随单人版移除，见 1ef5426）：
  // server/server.js 静态托管 dist/ 与 /api 路由。运行时库用临时副本，
  // 避免污染 server/data/runtime.sqlite（可能被运行中的服务器进程占用）。
  const runtimeDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-browser-runtime-'));
  const runtimeDb=path.join(runtimeDirectory,'runtime.sqlite');
  fs.copyFileSync(path.join(root,'data','zhsh-content.sqlite'),runtimeDb);
  const child=childProcess.spawn(process.execPath,['server/server.js'],
    {cwd:root,env:{...process.env,PORT:String(port),HOST:bindHost,
      ZHSH_RUNTIME_DB:runtimeDb,ZHSH_CONTENT_DB:path.join(root,'data','zhsh-content.sqlite')},
     stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  child.stdout.on('data',(bytes)=>output.push(bytes.toString('utf8')));child.stderr.on('data',(bytes)=>output.push(bytes.toString('utf8')));
  child.once('exit',(code)=>{if(code&&code!==0)output.push(`server exit_code=${code}\n`);});
  try{await waitForHttp(`http://127.0.0.1:${port}/`);return {child,port,url:`http://${browserHost}:${port}/`,output,runtimeDirectory};}
  catch(error){await terminateProcessTree(child);throw new Error(`${error.message}\n${output.join('')}`);}
}

async function stopStaticServer(server){
  if(!server?.child||server.child.exitCode!==null)return;
  await terminateProcessTree(server.child);
  if(server.runtimeDirectory){try{fs.rmSync(server.runtimeDirectory,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}}
}

class CdpClient{
  constructor(url){this.url=url;this.sequence=0;this.pending=new Map();this.listeners=new Map();this.socket=null;}
  async connect(){
    this.socket=new WebSocket(this.url);
    await new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',reject,{once:true});});
    this.socket.addEventListener('message',(event)=>this.#message(event.data));
    this.socket.addEventListener('close',()=>{for(const {reject} of this.pending.values())reject(new Error('DevTools connection closed'));this.pending.clear();});
    return this;
  }
  #message(raw){
    const message=JSON.parse(String(raw));
    if(message.id){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);
      message.error?pending.reject(new Error(`${pending.method}: ${message.error.message}`)):pending.resolve(message.result??{});return;}
    const keys=[message.method,`${message.sessionId??''}:${message.method}`];
    for(const key of keys)for(const listener of this.listeners.get(key)??[])listener(message.params??{});
  }
  send(method,params={},sessionId=null){
    const id=++this.sequence;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,method});
      this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  }
  on(method,listener,{sessionId=null}={}){const key=sessionId?`${sessionId}:${method}`:method;
    if(!this.listeners.has(key))this.listeners.set(key,new Set());this.listeners.get(key).add(listener);return ()=>this.listeners.get(key)?.delete(listener);}
  waitForEvent(method,{sessionId=null,predicate=()=>true,timeout=30000}={}){
    return new Promise((resolve,reject)=>{let timer;const off=this.on(method,(params)=>{if(!predicate(params))return;clearTimeout(timer);off();resolve(params);},{sessionId});
      timer=setTimeout(()=>{off();reject(new Error(`Timed out waiting for DevTools event ${method}`));},timeout);});
  }
  async close(){try{this.socket?.close();}catch{}await delay(20);}
}

async function readJson(url){return new Promise((resolve,reject)=>{const request=http.get(url,(response)=>{const chunks=[];
  response.on('data',(chunk)=>chunks.push(chunk));response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});
});request.once('error',reject);});}

async function waitForFile(file,{timeout=30000}={}){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(fs.existsSync(file))return file;await delay(50);}throw new Error(`Timed out waiting for file ${file}`);}

class EdgePage{
  constructor({client,sessionId,targetId,profileDirectory,process:browserProcess,stderr,browserVersion,downloadRoot,inlineRoot=null}){
    this.client=client;this.sessionId=sessionId;this.targetId=targetId;this.profileDirectory=profileDirectory;this.process=browserProcess;
    this.stderr=stderr;this.browserVersion=browserVersion;this.downloadRoot=downloadRoot;this.inlineRoot=inlineRoot;this.console=[];this.networkErrors=[];this.newDocumentScripts=[];this.inlineScriptsInitialized=false;this.applicationLoadMode='http';this.navigationFallbacks=[];
  }
  async initialize(){
    const send=(method,params={})=>this.client.send(method,params,this.sessionId);
    await Promise.all([send('Page.enable'),send('Runtime.enable'),send('Log.enable'),send('Network.enable'),send('DOM.enable')]);
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    this.client.on('Runtime.consoleAPICalled',(event)=>{if(['warning','warn','error','assert'].includes(event.type))this.console.push({source:'console',level:event.type,message:event.args.map((entry)=>entry.value??entry.description??entry.type).join(' ')});},{sessionId:this.sessionId});
    this.client.on('Runtime.exceptionThrown',(event)=>this.console.push({source:'exception',level:'error',message:event.exceptionDetails?.text??'Uncaught exception'}),{sessionId:this.sessionId});
    this.client.on('Log.entryAdded',(event)=>{if(['warning','error'].includes(event.entry?.level))this.console.push({source:event.entry.source,level:event.entry.level,message:event.entry.text});},{sessionId:this.sessionId});
    this.client.on('Network.loadingFailed',(event)=>this.networkErrors.push({type:'loadingFailed',url:event.url,error:event.errorText,canceled:Boolean(event.canceled)}),{sessionId:this.sessionId});
    this.client.on('Network.responseReceived',(event)=>{if(Number(event.response?.status)>=400)this.networkErrors.push({type:'http',url:event.response.url,status:event.response.status});},{sessionId:this.sessionId});
  }
  send(method,params={}){if(method==='Page.addScriptToEvaluateOnNewDocument'&&params.source)this.newDocumentScripts.push(params.source);return this.client.send(method,params,this.sessionId);}
  async navigate(url){
    if(process.env.ZHSH_BROWSER_INLINE_APP==='1'&&this.inlineRoot){this.applicationLoadMode='inline-explicit';return this.loadInlineApplication();}
    const networkStart=this.networkErrors.length;const loaded=this.client.waitForEvent('Page.loadEventFired',{sessionId:this.sessionId});
    await this.send('Page.navigate',{url});await loaded;await this.waitFor(()=>document.readyState==='complete');
    const finalUrl=await this.evaluate('location.href');
    const blocked=this.networkErrors.slice(networkStart).some((entry)=>entry.error==='net::ERR_BLOCKED_BY_ADMINISTRATOR');
    if(this.inlineRoot&&finalUrl.startsWith('chrome-error://chromewebdata')&&blocked){
      this.navigationFallbacks.push({requested_url:url,reason:'ERR_BLOCKED_BY_ADMINISTRATOR',fallback:'inline_application'});
      this.networkErrors.splice(networkStart);this.applicationLoadMode='inline-policy-fallback';this.inlineScriptsInitialized=true;return this.loadInlineApplication();
    }
    this.applicationLoadMode='http';
  }
  async reload(){
    if((process.env.ZHSH_BROWSER_INLINE_APP==='1'||this.applicationLoadMode.startsWith('inline'))&&this.inlineRoot)return this.loadInlineApplication();
    const loaded=this.client.waitForEvent('Page.loadEventFired',{sessionId:this.sessionId});await this.send('Page.reload',{ignoreCache:true});await loaded;await this.waitFor(()=>document.readyState==='complete');
  }
  async loadInlineApplication(){
    const frameId=(await this.send('Page.getFrameTree')).frameTree.frame.id;const webRoot=path.join(this.inlineRoot,'web');
    const style=fs.readFileSync(path.join(webRoot,'styles.css'),'utf8');let html=fs.readFileSync(path.join(webRoot,'index.html'),'utf8');
    html=html.replace(/<link rel="stylesheet" href="styles\.css">/,`<style>${style.replaceAll('</style>','<\\/style>')}</style>`).replace(/<script type="module" src="app\.js"><\/script>/,'');
    await this.send('Page.setDocumentContent',{frameId,html});
    if(!this.inlineScriptsInitialized){for(const source of this.newDocumentScripts)await this.evaluate(source);this.inlineScriptsInitialized=true;}
    await this.evaluate(`(()=>{if(!globalThis.__ZHSH_UAT_DURABLE_RECORDS__)globalThis.__ZHSH_UAT_DURABLE_RECORDS__=new Map();
      if(!globalThis.__ZHSH_UAT_UUID_SEQUENCE__)globalThis.__ZHSH_UAT_UUID_SEQUENCE__=0;
      if(typeof crypto.randomUUID!=='function')Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=>{const suffix=String(++globalThis.__ZHSH_UAT_UUID_SEQUENCE__).padStart(12,'0');return '00000000-0000-4000-8000-'+suffix;}});
      globalThis.__ZHSH_UAT_DURABLE_STORE__={async list(){return [...globalThis.__ZHSH_UAT_DURABLE_RECORDS__.values()].map((entry)=>structuredClone(entry));},
      async put(record){globalThis.__ZHSH_UAT_DURABLE_RECORDS__.set(record.player_canonical_id,structuredClone(record));},close(){}};})()`);
    const content=fs.readFileSync(path.join(webRoot,'generated','task1-content.json'),'utf8').trim();
    const authoritativeAssetRegistry=JSON.parse(fs.readFileSync(path.join(webRoot,'generated','authoritative-assets.json'),'utf8'));
    for(const entry of authoritativeAssetRegistry.assets){const file=path.join(webRoot,...entry.target_resource_path.split('/'));
      entry.target_resource_path=`data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;}
    const authoritativeAssets=JSON.stringify(authoritativeAssetRegistry);
    const runtime=fs.readFileSync(path.join(webRoot,'generated','task-runtime-browser.js'),'utf8').replace(/^export const /gm,'const ');
    const app=fs.readFileSync(path.join(webRoot,'app.js'),'utf8').replace(/^import .*?from '\.\/generated\/task-runtime-browser\.js';\s*/,'')
      .replace('storage = new BrowserRuntimeStorage();','storage = new BrowserRuntimeStorage({durableStore:globalThis.__ZHSH_UAT_DURABLE_STORE__});');
    const source=`(()=>{${runtime}
const __ZHSH_INLINE_CONTENT__=${content};const __ZHSH_INLINE_VISUALS__=${authoritativeAssets};
const fetch=async(url)=>({ok:true,json:async()=>structuredClone(String(url).includes('authoritative-assets')?__ZHSH_INLINE_VISUALS__:__ZHSH_INLINE_CONTENT__)});
${app}
})()\n//# sourceURL=zhsh-inline-app.js`;
    await this.evaluate(source);await this.waitFor(()=>document.readyState==='complete');
  }
  async evaluate(expression){
    const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
    if(result.exceptionDetails)throw new Error(`Browser evaluation failed: ${result.exceptionDetails.exception?.description??result.exceptionDetails.text}`);
    return result.result?.value;
  }
  async waitFor(pageFunction,{timeout=30000,label='page condition'}={}){
    const source=typeof pageFunction==='function'?`(${pageFunction.toString()})()`:pageFunction;const deadline=Date.now()+timeout;let last;
    while(Date.now()<deadline){try{last=await this.evaluate(source);if(last)return last;}catch(error){last=error.message;}await delay(35);}
    throw new Error(`Timed out waiting for ${label}; last=${typeof last==='string'?last:JSON.stringify(last)}`);
  }
  async countVisible(selector){return this.evaluate(`(()=>Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter((element)=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.visibility!=='hidden'&&style.display!=='none'&&rect.width>0&&rect.height>0;}).length)()`);}
  async click(selector,{waitForSave=false}={}){
    const count=await this.countVisible(selector);if(count!==1)throw new Error(`Expected one visible element for ${selector}, found ${count}`);
    await this.evaluate(`(()=>{const element=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((candidate)=>{const style=getComputedStyle(candidate),rect=candidate.getBoundingClientRect();return style.visibility!=='hidden'&&style.display!=='none'&&rect.width>0&&rect.height>0;});element.scrollIntoView({block:'center'});element.click();return true;})()`);
    if(waitForSave)await this.waitFor(()=>document.querySelector('#save-status')?.textContent!=='正在保存……',{label:`save after ${selector}`});
  }
  async text(selector){return this.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});return element?element.innerText:null;})()`);}
  async pageName(){return this.evaluate("document.body.dataset.page||''");}
  async chooseFile(buttonSelector,filePath){
    await this.send('Page.setInterceptFileChooserDialog',{enabled:true});
    const opened=this.client.waitForEvent('Page.fileChooserOpened',{sessionId:this.sessionId});await this.click(buttonSelector);const chooser=await opened;
    await this.send('DOM.setFileInputFiles',{files:[path.resolve(filePath)],backendNodeId:chooser.backendNodeId});
    await this.send('Page.setInterceptFileChooserDialog',{enabled:false});
  }
  async download(buttonSelector,directory){
    fs.mkdirSync(directory,{recursive:true});await this.client.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:directory,eventsEnabled:true});
    const begin=this.client.waitForEvent('Browser.downloadWillBegin');await this.click(buttonSelector);const started=await begin;
    await this.client.waitForEvent('Browser.downloadProgress',{predicate:(event)=>event.guid===started.guid&&event.state==='completed',timeout:30000});
    return waitForFile(path.join(directory,started.suggestedFilename));
  }
  async close(){
    try{await this.client.send('Browser.close');}catch{}
    await terminateProcessTree(this.process,{timeout:5000});await this.client.close();
  }
}

async function launchEdge({profileDirectory,downloadRoot,inlineRoot=null}){
  fs.mkdirSync(profileDirectory,{recursive:true});fs.mkdirSync(downloadRoot,{recursive:true});const stderr=[];
  const portFile=path.join(profileDirectory,'DevToolsActivePort');if(fs.existsSync(portFile))fs.rmSync(portFile,{force:true});
  const browserProcess=childProcess.spawn(findEdgeExecutable(),[
    '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profileDirectory}`,'--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-popup-blocking',
    '--disable-gpu','--no-sandbox','--no-proxy-server','about:blank',
  ],{stdio:['ignore','ignore','pipe'],detached:process.platform!=='win32'});
  browserProcess.stderr.on('data',(bytes)=>stderr.push(bytes.toString('utf8')));
  // Edge 新版为进程拆分架构（msedge.exe broker 拉起 new_msedge.exe 真身）：broker 在
  // 子浏览器就绪后自行退出（code=0），不代表浏览器已死亡。因此仅当退出码非 0 时
  // 立即判失败；code=0 时继续等 DevToolsActivePort（真身启动中），超时再判失败。
  const browserExit=new Promise((_,reject)=>browserProcess.once('exit',(code,signal)=>{
    if(code!==0)reject(new Error(`Browser exited before DevTools became ready (code=${code}, signal=${signal})\n${stderr.join('')}`));
  }));
  await Promise.race([waitForFile(portFile,{timeout:40000}),browserExit]);
  const [port]=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);const version=await readJson(`http://127.0.0.1:${port}/json/version`);
  let client;try{
    client=await new CdpClient(version.webSocketDebuggerUrl).connect();const {targetId}=await client.send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await client.send('Target.attachToTarget',{targetId,flatten:true});const page=new EdgePage({client,sessionId,targetId,profileDirectory,
      process:browserProcess,stderr,browserVersion:version.Browser,downloadRoot,inlineRoot});await page.initialize();return page;
  }catch(error){await terminateProcessTree(browserProcess);throw new Error(`Browser DevTools startup failed (exit=${browserProcess.exitCode}): ${error.message}\n${stderr.join('')}`,{cause:error});}
}

module.exports={delay,findEdgeExecutable,launchEdge,startStaticServer,stopStaticServer,terminateProcessTree};
