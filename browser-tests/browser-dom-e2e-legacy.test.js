'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {after,before,test}=require('node:test');
const {runDomGameplayScenario}=require('./dom-gameplay-runner');
const {startStaticServer,stopStaticServer}=require('./edge-cdp');

const root=path.resolve(__dirname,'..');
const legacyFixture=JSON.parse(fs.readFileSync(path.join(root,'tests','fixtures','browser-save-v1-real-1-of-13.json'),'utf8'));
const accepted25=JSON.parse(fs.readFileSync(path.join(root,'tests','fixtures','formal-playable-task-ids-at-a97.json'),'utf8'));
const evidence=[];let server;

before(async()=>{server=await startStaticServer(root);});
after(async()=>{
  await stopStaticServer(server);
  const evidenceDirectory=process.env.ZHSH_BROWSER_E2E_EVIDENCE_DIR??path.join(root,'artifacts','series-05-fishing-diving-palace-stage','raw');
  if(evidenceDirectory){fs.mkdirSync(evidenceDirectory,{recursive:true});const file=path.join(evidenceDirectory,'browser-dom-e2e-results.json');
    const prior=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).scenarios??[]:[];
    const scenarios=[...new Map([...prior,...evidence].map((entry)=>[entry.scenario,entry])).values()];
    fs.writeFileSync(file,`${JSON.stringify({schema_version:1,scenarios},null,2)}\n`,'utf8');}
});

test('DOM browser E2E: real legacy 1/13 save imports, preserves checkpoint and completes every selected task', {timeout:4*60*60*1000}, async()=>{
  const result=await runDomGameplayScenario({root,url:server.url,scenario:'legacy-1-of-13',legacyFixture,checkpointTaskIds:accepted25.task_canonical_ids});evidence.push(result);
  process.stdout.write(`ZHSH_DOM_E2E:${JSON.stringify({scenario:result.scenario,duration_ms:result.duration_ms,completed_task_count:result.completed_task_count,checkpoint:result.legacy_checkpoint_task_count,series:result.formal_series_count,console:result.console,battle:result.battle})}\n`);
});
