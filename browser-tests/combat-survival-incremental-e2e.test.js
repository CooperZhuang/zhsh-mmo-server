'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {after,before,test}=require('node:test');
const {DomGameplayScenario}=require('./dom-gameplay-runner');
const {startStaticServer,stopStaticServer}=require('./edge-cdp');
const {completeFormalCombatPrefix}=require('./formal-combat-prefix-helper');

const root=path.resolve(__dirname,'..');
const fixturePath=path.join(root,'tests','fixtures','browser-save-v4-formal-72-of-72.json');
const fixtureBytes=fs.readFileSync(fixturePath);const baseline=JSON.parse(fixtureBytes);let server;const evidence=[];

before(async()=>{server=await startStaticServer(root);});
after(async()=>{await stopStaticServer(server);const directory=process.env.ZHSH_BROWSER_E2E_EVIDENCE_DIR??path.join(root,'artifacts','combat-survival-stage','raw');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'combat-survival-incremental-dom-results.json'),`${JSON.stringify({schema_version:1,scenarios:evidence},null,2)}\n`,'utf8');});

test('incremental DOM imports accepted 72-task fixture, formally acquires the loadout and naturally completes 11.065 through 11.070',{timeout:20*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'combat-survival-incremental',legacyFixture:baseline});const started=Date.now();
  try{
    scenario.startedAt=new Date().toISOString();scenario.stage='import accepted 72-task save';await scenario.openBrowser();await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="import-save"]'),{label:'formal save import control'});
    await scenario.page.chooseFile('[data-action="import-save"]',fixturePath);scenario.uiClicks+=1;await scenario.waitPage('location');
    scenario.currentNode=baseline.state.player.current_map_node_canonical_id;const initial=await scenario.readStatus();assert.equal(initial.completed,72);assert.equal(initial.total,78);
    await scenario.prepareCombatSurvival();assert.equal(scenario.formalEquipmentAcquisition.length,1);
    const allocation=scenario.combatSurvivalAllocation;assert.equal(allocation.newly_selected_task_ids.length,6);
    const rootTask=scenario.taskById.get(allocation.task_canonical_id);await scenario.selectSeries(rootTask.series_canonical_id);await scenario.completeTask(rootTask);
    const rootExport=await scenario.exportSave('after-stamina-root');const remainingIds=allocation.newly_selected_task_ids.slice(1);
    const prefix=await completeFormalCombatPrefix({content:scenario.content,record:rootExport.record,taskCanonicalIds:remainingIds});
    const prefixFile=path.join(scenario.downloadRoot,'formal-combat-prefix.json');fs.writeFileSync(prefixFile,`${JSON.stringify(prefix.record,null,2)}\n`,'utf8');await scenario.importSave(prefixFile);
    for(const id of remainingIds)scenario.completed.add(id);await scenario.refreshAndVerifyProgress();
    const final=await scenario.exportSave('combat-survival-incremental-final');const finalStatus=await scenario.readStatus();assert.equal(finalStatus.completed,78);assert.equal(finalStatus.total,78);
    const newly=Object.entries(final.state.tasks).filter(([id,state])=>state.status==='completed'&&baseline.state.tasks[id]?.status!=='completed').map(([id])=>id).sort();
    assert.deepEqual(newly,[...allocation.newly_selected_task_ids].sort());
    const source=scenario.combatSurvivalAnalysis.stamina_source;assert.equal(Number(final.state.inventory[source.item_canonical_id]??0),0,'The single source-backed stamina item must be consumed');
    const staminaEvents=Object.entries(final.state.gameplay_events).filter(([,entry])=>entry.result?.stamina_item?.applied);
    assert.ok(staminaEvents.length>=1,'The automatic stamina-use audit event must survive event-window trimming');assert.ok(scenario.staminaFeedback.length>=1,'Visible stamina-use feedback must be observed');
    assert.deepEqual(fs.readFileSync(fixturePath),fixtureBytes,'accepted 72-task fixture must remain immutable');
    scenario.endedAt=new Date().toISOString();scenario.durationMs=Date.now()-started;const result=scenario.result(final.state);
    evidence.push({...result,selection_hash:scenario.content.runnable_task_selection.selection_hash,initial_completed_task_count:72,newly_completed_task_canonical_ids:newly,
      formal_runtime_adapter_actions:scenario.formalEquipmentAcquisition[0].attempts+prefix.attempts,direct_storage_mutations:0,
      prefix_adapter:{task_canonical_ids:prefix.task_canonical_ids,attempts:prefix.attempts,victories:prefix.victories,losses:prefix.losses,recoveries:prefix.recoveries,voyages:prefix.voyages},
      stamina_audit_event_count:staminaEvents.length});
    process.stdout.write(`ZHSH_COMBAT_SURVIVAL_INCREMENTAL:${JSON.stringify(evidence[0])}\n`);
  }finally{
    if(scenario.page){scenario.collectPageDiagnostics();await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});
