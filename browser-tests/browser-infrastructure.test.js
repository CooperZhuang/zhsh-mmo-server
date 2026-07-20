'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {findEdgeExecutable,launchEdge,startStaticServer,stopStaticServer}=require('./edge-cdp');

const root=path.resolve(__dirname,'..');

test('browser infrastructure discovers Chromium, serves the app, returns CDP results, and exits cleanly',{timeout:45_000},async()=>{
  const executable=findEdgeExecutable();assert.ok(fs.existsSync(executable),`browser executable missing: ${executable}`);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-browser-infra-'));let server;let page;
  const priorInline=process.env.ZHSH_BROWSER_INLINE_APP;
  try{
    server=await startStaticServer(root);
    process.env.ZHSH_BROWSER_INLINE_APP='1';
    page=await launchEdge({profileDirectory:path.join(temp,'profile'),downloadRoot:path.join(temp,'downloads'),inlineRoot:root});
    await page.navigate(server.url);
    assert.equal(await page.evaluate('document.readyState'),'complete');
    assert.equal(await page.evaluate("Boolean(document.querySelector('.wap-page'))"),true);
    assert.equal(await page.evaluate('21*2'),42);
  }finally{
    if(priorInline===undefined)delete process.env.ZHSH_BROWSER_INLINE_APP;else process.env.ZHSH_BROWSER_INLINE_APP=priorInline;
    if(page)await page.close();
    if(server)await stopStaticServer(server);
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
