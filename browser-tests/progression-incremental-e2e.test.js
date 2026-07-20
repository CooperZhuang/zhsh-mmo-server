'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {after,before,test}=require('node:test');
const {DomGameplayScenario}=require('./dom-gameplay-runner');
const {startStaticServer,stopStaticServer}=require('./edge-cdp');
const {trainFormalRecord}=require('./formal-training-helper');

const root=path.resolve(__dirname,'..');
const fixturePath=path.join(root,'tests','fixtures','browser-save-v3-formal-57-of-57.json');
const baseline=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
const accepted72=JSON.parse(fs.readFileSync(path.join(root,'data','runtime','formal-stage-start-72.json'),'utf8'));
const accepted72Record=JSON.parse(fs.readFileSync(path.join(root,accepted72.completed_task_evidence.path),'utf8'));
const accepted72TaskIds=accepted72Record.completed_task_canonical_ids;
let server;const evidence=[];

before(async()=>{server=await startStaticServer(root);});
after(async()=>{
  await stopStaticServer(server);const directory=process.env.ZHSH_BROWSER_E2E_EVIDENCE_DIR??path.join(root,'artifacts','progression-stage','raw');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'progression-incremental-results.json'),
    `${JSON.stringify({schema_version:1,scenarios:evidence},null,2)}\n`,'utf8');
});

test('incremental DOM: imported 57-task save executes source-driven training and reaches the new continuous prefixes',{timeout:20*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'progression-incremental',legacyFixture:baseline,allowedTaskIds:accepted72TaskIds});const started=Date.now();
  try{
    scenario.startedAt=new Date().toISOString();scenario.stage='import accepted 57-task save';await scenario.openBrowser();await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="import-save"]'),{label:'formal save import control'});
    await scenario.page.chooseFile('[data-action="import-save"]',fixturePath);scenario.uiClicks+=1;await scenario.waitPage('location');
    scenario.currentNode=baseline.state.player.current_map_node_canonical_id;await scenario.measure('progression_incremental_import');
    const beforeIds=new Set(Object.entries(baseline.state.tasks).filter(([,entry])=>entry.status==='completed').map(([id])=>id));
    await scenario.selectSeries('task.series.05');for(const id of ['task.series.05.032','task.series.05.033','task.series.05.034','task.series.05.035'])await scenario.completeTask(scenario.taskById.get(id));
    const retained=await scenario.exportSave('retained-61-before-formal-training');const acceptedTasks=scenario.content.tasks.filter((task)=>accepted72TaskIds.includes(task.canonical_id));
    const targetLevel=Math.max(...acceptedTasks.map((task)=>Number(task.level_requirement??1)));
    const training=await trainFormalRecord({content:scenario.content,record:retained.record,targetLevel});const trainedFile=path.join(scenario.downloadRoot,'formal-trained-61.json');
    scenario.formalTraining.push({from_level:retained.state.player.level,to_level:targetLevel,attempts:training.attempts,victories:training.victories,
      losses:training.losses,recoveries:training.recoveries,planner_worst_attempt_bound:training.plan.total_reasonable_worst_attempts});
    fs.writeFileSync(trainedFile,`${JSON.stringify(training.record,null,2)}\n`,'utf8');await scenario.importSave(trainedFile);
    const visibleAllocation=training.plan.level_segments.flatMap((entry)=>entry.encounter_allocations)[0];assert.ok(visibleAllocation);await scenario.reach(visibleAllocation.location_canonical_id);
    await scenario.ensurePage('encounter');assert.equal(await scenario.page.countVisible(`[data-combat-start=${JSON.stringify(visibleAllocation.monster_canonical_id)}]`),1);
    await scenario.ensureLocationPage();await scenario.completeExpandedSeries();
    const expectedIds=accepted72TaskIds;assert.equal([...scenario.completed].filter((id)=>expectedIds.includes(id)).length,expectedIds.length);
    const newlyCompleted=expectedIds.filter((id)=>!beforeIds.has(id));assert.ok(newlyCompleted.length>4,'progression stage must extend beyond the retained maritime prefix');
    await scenario.refreshAndVerifyProgress();const exported=await scenario.exportSave('progression-incremental-final');
    assert.equal(Object.entries(exported.state.tasks).filter(([id,entry])=>entry.status==='completed'&&expectedIds.includes(id)).length,expectedIds.length);
    assert.ok(exported.state.player.level>=targetLevel);
    scenario.endedAt=new Date().toISOString();scenario.durationMs=Date.now()-started;const result=scenario.result(exported.state);
    evidence.push({...result,imported_baseline_completed:beforeIds.size,newly_completed_task_ids:newlyCompleted,
      source_driven_training:true,training_runtime:`formal CombatRuntime + movement + voyage + recovery on ${training.storage_runtime}; no direct state mutation`,
      training_victories:training.victories,training_recoveries:training.recoveries,final_level:exported.state.player.level});
    process.stdout.write(`ZHSH_PROGRESSION_INCREMENTAL:${JSON.stringify(evidence[0])}\n`);
  }finally{
    if(scenario.page){scenario.collectPageDiagnostics();await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});
