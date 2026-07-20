'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {after,before,test}=require('node:test');
const {DomGameplayScenario}=require('./dom-gameplay-runner');
const {startStaticServer,stopStaticServer}=require('./edge-cdp');

const root=path.resolve(__dirname,'..');
const fixturePath=path.join(root,'tests','fixtures','browser-save-v3-formal-57-of-57.json');
const baseline=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
let server;const evidence=[];

before(async()=>{server=await startStaticServer(root);});
after(async()=>{
  await stopStaticServer(server);const directory=process.env.ZHSH_BROWSER_E2E_EVIDENCE_DIR??path.join(root,'artifacts','series-05-fishing-diving-palace-stage','raw');
  if(directory){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'maritime-incremental-results.json'),`${JSON.stringify({schema_version:1,scenarios:evidence},null,2)}\n`,'utf8');}
});

test('incremental DOM: imported 57/57 save completes the selected maritime prefix and persists the palace loop',{timeout:20*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'maritime-incremental',legacyFixture:baseline});const started=Date.now();
  try{
    scenario.startedAt=new Date().toISOString();scenario.stage='open and import accepted 57 save';await scenario.openBrowser();await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="import-save"]'),{label:'formal save import control'});
    await scenario.page.chooseFile('[data-action="import-save"]',fixturePath);scenario.uiClicks+=1;await scenario.waitPage('location');
    scenario.currentNode=baseline.state.player.current_map_node_canonical_id;await scenario.measure('incremental_import');
    await scenario.selectSeries('task.series.05');
    for(const id of ['task.series.05.032','task.series.05.033','task.series.05.034','task.series.05.035'])await scenario.completeTask(scenario.taskById.get(id));
    assert.equal(scenario.completed.size,61);scenario.stage='refresh after new prefix';await scenario.refreshAndVerifyProgress();

    scenario.stage='discover Sea Emperor Palace';const city=scenario.cityForNode(scenario.currentNode);
    const route=scenario.content.voyage_routes.find((entry)=>entry.from_city_canonical_id===city);assert.ok(route,'Current city must expose a formal voyage route');
    await scenario.reach(route.from_port_location_canonical_id);await scenario.ensurePage('voyage');await scenario.click(`[data-voyage-start=${JSON.stringify(route.canonical_id)}]`,{save:true});
    let discovered=false;
    for(let attempt=0;attempt<800&&!discovered;attempt+=1){await scenario.click('[data-diving-attempt="1"]',{save:true});discovered=await scenario.page.countVisible('[data-diving-enter="1"]')===1;}
    assert.equal(discovered,true,'Source 5% diving roll did not discover the palace within the bounded visible attempts');await scenario.measure('diving_discovery');
    await scenario.click('[data-diving-enter="1"]',{save:true});await scenario.waitPage('encounter');await scenario.measure('sea_emperor_palace');

    scenario.stage='palace refresh and browser reopen';await scenario.page.reload();scenario.pageRefreshes+=1;
    await scenario.page.waitFor(()=>document.querySelector('[data-action="continue-game"]'),{label:'continue after palace refresh'});await scenario.click('[data-action="continue-game"]');await scenario.waitPage('location');
    await scenario.ensurePage('encounter');await scenario.restartBrowser();await scenario.ensurePage('encounter');
    const palace=scenario.content.dungeons.find((entry)=>entry.display_name==='海皇宫殿');const guardian=palace.stages[0].monster;
    await scenario.click(`[data-combat-start=${JSON.stringify(guardian.canonical_id)}]`,{save:true});await scenario.click('[data-combat-retreat="1"]',{save:true});await scenario.waitPage('encounter');scenario.battle.retreated+=1;
    assert.match(await scenario.page.text('.message'),/撤退成功/);await scenario.click('[data-dungeon-exit="1"]',{save:true});await scenario.waitPage('voyage');
    for(let step=0;step<500;step+=1){if(await scenario.page.pageName()==='location')break;await scenario.advanceVoyageStep();}
    await scenario.waitPage('location');scenario.currentNode=route.to_port_map_node_canonical_id;

    scenario.stage='export import round trip';const before=await scenario.exportSave('maritime-before-roundtrip');
    assert.equal(before.state.schema_version,4);assert.equal(before.state.voyage,null);assert.equal(before.state.dungeon,null);assert.equal(before.state.maritime_encounter,null);
    assert.deepEqual(['task.series.05.032','task.series.05.033','task.series.05.034','task.series.05.035'].map((id)=>before.state.tasks[id].status),['completed','completed','completed','completed']);
    await scenario.importSave(before.file);const after=await scenario.exportSave('maritime-after-roundtrip');scenario.assertEquivalentSettlement(before.state,after.state);
    scenario.endedAt=new Date().toISOString();scenario.durationMs=Date.now()-started;const result=scenario.result(after.state);evidence.push({...result,
      imported_baseline_completed:57,newly_completed_task_ids:['task.series.05.032','task.series.05.033','task.series.05.034','task.series.05.035'],
      palace_refresh_verified:true,palace_browser_reopen_verified:true,palace_retreat_verified:true,palace_exit_verified:true});
    process.stdout.write(`ZHSH_MARITIME_INCREMENTAL:${JSON.stringify(evidence[0])}\n`);
  }finally{
    if(scenario.page){scenario.collectPageDiagnostics();await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});
