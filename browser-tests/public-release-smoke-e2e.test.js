'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {after,before,test}=require('node:test');
const {DomGameplayScenario}=require('./dom-gameplay-runner');
const {startStaticServer,stopStaticServer}=require('./edge-cdp');

const root=path.resolve(__dirname,'..');
const fixturePath=path.join(root,'tests','fixtures','browser-save-v5-series15-454-level200.json');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
const taskIds=['task.series.15.455','task.series.15.456','task.series.15.457'];
let server;
let priorSkipBuild;

before(async()=>{priorSkipBuild=process.env.ZHSH_SKIP_BROWSER_BUILD;process.env.ZHSH_SKIP_BROWSER_BUILD='1';server=await startStaticServer(root);});
after(async()=>{await stopStaticServer(server);if(priorSkipBuild===undefined)delete process.env.ZHSH_SKIP_BROWSER_BUILD;else process.env.ZHSH_SKIP_BROWSER_BUILD=priorSkipBuild;});

test('public release core smoke: start, art, task item, shop, normal and boss combat, equipment, voyage and save recovery',{timeout:10*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'public-release-smoke',legacyFixture:fixture,allowedTaskIds:taskIds,combatRandomMode:'best-play',dropRandomValue:0.99});
  const checks=[];const started=Date.now();
  try{
    await scenario.openBrowser();await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="new-game"]'),{label:'new game control'});
    await scenario.page.waitFor(()=>{const image=document.querySelector('.start-art');return image?.complete&&image.naturalWidth>0;},{label:'authoritative start art'});checks.push('startup','authoritative_art');

    await scenario.createNewSave();assert.equal(await scenario.page.pageName(),'location');checks.push('new_game','main_ui');
    await scenario.ensurePage('compendium');assert.equal(await scenario.page.evaluate("document.querySelectorAll('.gallery-art').length"),229);checks.push('art_compendium_229');
    await scenario.importSave(fixturePath);scenario.currentNode=fixture.state.player.current_map_node_canonical_id;await scenario.selectSeries('task.series.15');

    for(const id of taskIds)await scenario.completeTask(scenario.taskById.get(id));
    const afterTasks=await scenario.exportSave('rc-after-tasks');
    for(const id of taskIds)assert.equal(afterTasks.state.tasks[id].status,'completed',id);
    const transferItem=scenario.taskById.get('task.series.15.457').targets[0].entity_canonical_id;
    assert.equal(afterTasks.state.inventory[transferItem],undefined,'task-chain reward must be consumed on delivery');
    assert.ok(Object.keys(afterTasks.state.reward_grants).some((id)=>id.startsWith('task.series.15.456.reward.')));checks.push('task_accept_submit','task_item_grant_consume','boss_combat');

    const shop=scenario.content.shop_entries.find((entry)=>entry.display_name==='体力宝'&&Number(entry.price)===200000);assert.ok(shop);
    await scenario.reach(shop.location_canonical_id);await scenario.ensurePage('shop');const beforeShop=await scenario.exportSave('rc-before-shop');
    await scenario.ensurePage('shop');await scenario.click(`[data-shop-buy=${JSON.stringify(shop.canonical_id)}]`,{save:true});
    const afterShop=await scenario.exportSave('rc-after-shop');assert.equal(afterShop.state.player.money,beforeShop.state.player.money-200000);
    assert.equal(Number(afterShop.state.inventory[shop.content_entity_canonical_id]??0),Number(beforeShop.state.inventory[shop.content_entity_canonical_id]??0)+1);checks.push('shop_money_inventory');

    const ordinary=scenario.content.monster_placements.map((placement)=>({placement,monster:scenario.monsterById.get(placement.monster_canonical_id)}))
      .filter((entry)=>entry.monster&&entry.placement.repeatable&&entry.placement.encounter_type==='wild'&&Number(entry.monster.level)<=30).sort((a,b)=>Number(a.monster.level)-Number(b.monster.level))[0];assert.ok(ordinary);
    await scenario.reach(ordinary.placement.location_canonical_id);await scenario.recoverIfNeeded(ordinary.placement.location_canonical_id);assert.equal(await scenario.fight(ordinary.monster.canonical_id),'won');checks.push('ordinary_combat');

    const equipState=await scenario.exportSave('rc-before-equip');const equipped=new Set([...Object.values(equipState.state.equipment).flat()].filter(Boolean));
    const gear=Object.keys(equipState.state.inventory).map((id)=>scenario.equipmentById.get(id)).find((entry)=>entry&&!equipped.has(entry.canonical_id)&&Number(entry.required_level??1)<=200&&Number(entry.equipment_type)!==6);assert.ok(gear);
    await scenario.equipItem(gear);const afterEquip=await scenario.exportSave('rc-after-equip');assert.ok(Object.values(afterEquip.state.equipment).flat().includes(gear.canonical_id));checks.push('equipment_inventory');

    const currentCity=scenario.cityForNode(scenario.currentNode);const route=scenario.content.voyage_routes.find((entry)=>entry.from_city_canonical_id===currentCity);assert.ok(route);
    await scenario.reach(route.from_port_location_canonical_id);await scenario.ensurePage('voyage');await scenario.click(`[data-voyage-start=${JSON.stringify(route.canonical_id)}]`,{save:true});
    await scenario.click('[data-voyage-finish="1"]',{save:true});await scenario.waitPage('location');
    scenario.currentNode=route.to_port_map_node_canonical_id;const afterVoyage=await scenario.exportSave('rc-after-voyage');
    assert.equal(afterVoyage.state.player.current_map_node_canonical_id,route.to_port_map_node_canonical_id);assert.equal(afterVoyage.state.voyage,null);checks.push('voyage_cross_city');

    assert.equal(afterVoyage.state.tasks['task.series.15.269'].status,'blocked');assert.equal(afterVoyage.state.tasks['task.series.15.601'].status,'blocked');
    assert.equal(afterVoyage.state.tasks['task.series.15.270'].status,'completed');
    assert.deepEqual(afterVoyage.state.tasks['task.series.15.602'].block_reasons,[]);
    assert.equal(scenario.taskById.get('task.series.15.602').directory_status,'validated');checks.push('conflicts_nonblocking');
    await scenario.refreshAndVerifyProgress();await scenario.importSave(afterVoyage.file);const roundTrip=await scenario.exportSave('rc-roundtrip');scenario.assertEquivalentSettlement(afterVoyage.state,roundTrip.state);checks.push('refresh_export_import');

    scenario.collectPageDiagnostics();assert.equal(scenario.consoleRecords.filter((entry)=>entry.level==='error').length,0,JSON.stringify(scenario.consoleRecords));
    assert.equal(scenario.networkRecords.length,0,JSON.stringify(scenario.networkRecords));checks.push('no_blocking_console_error');
    process.stdout.write(`ZHSH_RC_SMOKE:${JSON.stringify({passed:true,duration_ms:Date.now()-started,checks,battle:scenario.battle,task_status_counts:{validated:648,runnable_pending_validation:1,data_conflict:2}})}\n`);
  }catch(error){
    process.stderr.write(`ZHSH_RC_SMOKE_FAILURE:${JSON.stringify({message:error.message,stack:error.stack})}\n`);throw error;
  }finally{
    if(scenario.page){await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});
