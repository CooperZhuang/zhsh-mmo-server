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
const taskIds=['task.series.05.032','task.series.05.033','task.series.05.034','task.series.05.035'];
let server;const evidence=[];

before(async()=>{server=await startStaticServer(root);});
after(async()=>{
  await stopStaticServer(server);
  const directory=process.env.ZHSH_BROWSER_E2E_EVIDENCE_DIR??path.join(root,'artifacts','browser-acceptance-stage','raw');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'release-maritime-scenario-dom-results.json'),`${JSON.stringify({schema_version:1,scenarios:evidence},null,2)}\n`,'utf8');
});

test('release DOM maritime scenario proves fishing, cross-city task flow, diving, palace persistence and save recovery',{timeout:20*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'release-maritime',legacyFixture:baseline,allowedTaskIds:taskIds});
  const started=Date.now();const coverage=[];
  try{
    scenario.startedAt=new Date().toISOString();scenario.stage='import accepted 57-task checkpoint';
    await scenario.openBrowser();await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="import-save"]'),{label:'formal save import control'});
    await scenario.page.chooseFile('[data-action="import-save"]',fixturePath);scenario.uiClicks+=1;await scenario.waitPage('location');
    await scenario.page.waitFor(()=>document.querySelector('#save-status')?.textContent==='导入结果已保存',{label:'maritime checkpoint import completion'});
    scenario.currentNode=baseline.state.player.current_map_node_canonical_id;await scenario.measure('release_maritime_import');await scenario.selectSeries('task.series.05');

    const initial=await scenario.exportSave('release-maritime-initial');
    for(const id of taskIds)assert.notEqual(initial.state.tasks[id].status,'completed',id);
    for(const id of taskIds)await scenario.completeTask(scenario.taskById.get(id));
    assert.equal(scenario.completed.size,61);coverage.push('route-constrained fishing','voyage item acquisition','cross-city NPC submission','task item carry and consumption','shallow-water collection');

    scenario.stage='refresh after maritime task prefix';await scenario.refreshAndVerifyProgress();
    const city=scenario.cityForNode(scenario.currentNode);
    const route=scenario.content.voyage_routes.find((entry)=>entry.from_city_canonical_id===city);assert.ok(route,'Current city must expose a formal voyage route');
    const fromPort=scenario.nodeById.get(route.from_port_map_node_canonical_id);const toPort=scenario.nodeById.get(route.to_port_map_node_canonical_id);
    assert.ok(fromPort&&toPort&&fromPort.city_canonical_id!==toPort.city_canonical_id,'release voyage must cross cities');
    await scenario.reach(route.from_port_location_canonical_id);await scenario.ensurePage('voyage');await scenario.measure('release_maritime_voyage_start');
    await scenario.click(`[data-voyage-start=${JSON.stringify(route.canonical_id)}]`,{save:true});

    scenario.stage='deterministic source-probability diving discovery';
    await scenario.click('[data-diving-attempt="1"]',{save:true});
    assert.equal(await scenario.page.countVisible('[data-diving-enter="1"]'),1,'UAT random boundary must exercise the source 5% discovery branch once');
    assert.match(await scenario.page.text('.message'),/发现海皇宫殿/);await scenario.measure('diving_discovery');
    await scenario.click('[data-diving-enter="1"]',{save:true});await scenario.waitPage('encounter');await scenario.measure('sea_emperor_palace');
    coverage.push('city and port entry','formal voyage route','cross-city port arrival','diving discovery','special maritime scene');

    scenario.stage='palace refresh and browser reopen';
    await scenario.page.reload();scenario.pageRefreshes+=1;
    await scenario.page.waitFor(()=>document.querySelector('[data-action="continue-game"]'),{label:'continue after palace refresh'});await scenario.click('[data-action="continue-game"]');await scenario.waitPage('location');
    await scenario.ensurePage('encounter');await scenario.restartBrowser();await scenario.ensurePage('encounter');
    const palace=scenario.content.dungeons.find((entry)=>entry.display_name==='海皇宫殿');assert.ok(palace);
    const guardian=palace.stages[0].monster;
    await scenario.click(`[data-combat-start=${JSON.stringify(guardian.canonical_id)}]`,{save:true});
    await scenario.click('[data-combat-retreat="1"]',{save:true});await scenario.waitPage('encounter');scenario.battle.retreated+=1;
    assert.match(await scenario.page.text('.message'),/撤退成功/);
    await scenario.click('[data-dungeon-exit="1"]',{save:true});await scenario.waitPage('voyage');
    coverage.push('page refresh persistence','browser reopen persistence','dungeon encounter and bounded retreat','return to active voyage');

    for(let step=0;step<500;step+=1){if(await scenario.page.pageName()==='location')break;await scenario.advanceVoyageStep();}
    await scenario.waitPage('location');scenario.currentNode=route.to_port_map_node_canonical_id;
    const arrival=await scenario.exportSave('release-maritime-arrival');
    assert.equal(arrival.state.player.current_map_node_canonical_id,route.to_port_map_node_canonical_id);
    assert.equal(arrival.state.voyage,null);assert.equal(arrival.state.dungeon,null);assert.equal(arrival.state.maritime_encounter,null);

    scenario.stage='maritime export import round trip';
    for(const id of taskIds)assert.equal(arrival.state.tasks[id].status,'completed',id);
    await scenario.importSave(arrival.file);const roundTrip=await scenario.exportSave('release-maritime-roundtrip');scenario.assertEquivalentSettlement(arrival.state,roundTrip.state);
    for(const id of taskIds)assert.equal(roundTrip.state.tasks[id].status,'completed',id);
    assert.equal(roundTrip.state.player.current_map_node_canonical_id,route.to_port_map_node_canonical_id);

    scenario.endedAt=new Date().toISOString();scenario.durationMs=Date.now()-started;const result=scenario.result(roundTrip.state);
    evidence.push({...result,checkpoint_fixture:'tests/fixtures/browser-save-v3-formal-57-of-57.json',imported_baseline_completed:57,
      evidence_task_canonical_ids:taskIds,evidence_task_count:taskIds.length,completed_evidence_task_count:taskIds.length,coverage:[...new Set(coverage)],
      voyage:{route_canonical_id:route.canonical_id,from_city_canonical_id:route.from_city_canonical_id,to_city_canonical_id:route.to_city_canonical_id,
        from_port_location_canonical_id:route.from_port_location_canonical_id,to_port_location_canonical_id:route.to_port_location_canonical_id,arrival_map_node_canonical_id:route.to_port_map_node_canonical_id},
      diving_random_control:{scope:'DivingRuntime in DOM UAT only',rolls:[0,0],source_encounter_probability:scenario.content.maritime.diving.encounter_probability,
        selected_source_dungeon_order_index:0,note:'Controls only the random branch; all voyage, discovery, entry, refresh, retreat, exit and arrival state changes use visible browser actions.'},
      palace_refresh_verified:true,palace_browser_reopen_verified:true,palace_retreat_verified:true,palace_exit_to_voyage_verified:true,
      final_cross_city_arrival_verified:true,final_export_import_state_equivalent:true,direct_browser_storage_writes:false});
    process.stdout.write(`ZHSH_RELEASE_MARITIME:${JSON.stringify(evidence[0])}\n`);
  }finally{
    if(scenario.page){scenario.collectPageDiagnostics();await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});
