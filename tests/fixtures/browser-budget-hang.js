'use strict';

const childProcess=require('node:child_process');
const fs=require('node:fs');
const {test}=require('node:test');

// Spawn during module evaluation so the regression proves that an already-running
// descendant is terminated, instead of racing the node:test callback scheduler.
const child=childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:process.platform!=='win32'});
if(process.env.ZHSH_BUDGET_FIXTURE_PID_FILE)fs.writeFileSync(process.env.ZHSH_BUDGET_FIXTURE_PID_FILE,String(child.pid),'utf8');

test('intentional browser-budget process-tree hang',async()=>{
  await new Promise(()=>{});
});
