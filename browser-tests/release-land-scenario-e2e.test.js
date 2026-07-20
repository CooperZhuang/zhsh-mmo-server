'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {after,before,test}=require('node:test');
const {DomGameplayScenario}=require('./dom-gameplay-runner');
const {startStaticServer,stopStaticServer}=require('./edge-cdp');

const root=path.resolve(__dirname,'..');
const fixturePath=path.join(root,'tests','fixtures','browser-save-v5-series15-697-level106.json');
const checkpoint=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
const completedTaskIds=Array.from({length:8},(_,index)=>`task.series.15.${698+index}`);
const boundaryTaskId='task.series.15.706';
const allowedTaskIds=[...completedTaskIds,boundaryTaskId];
const trainingMonsterId='derived.monster_definition.e8edba99cec6f49a';
const expectedTrainingDropId='entity.equipment.da2d65ff0cc31d45';
const evidence=[];let server;

before(async()=>{server=await startStaticServer(root);});
after(async()=>{
  await stopStaticServer(server);
  const directory=process.env.ZHSH_BROWSER_E2E_EVIDENCE_DIR??path.join(root,'artifacts','browser-acceptance-stage','raw');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'release-land-scenario-dom-results.json'),`${JSON.stringify({schema_version:1,scenarios:evidence},null,2)}\n`,'utf8');
});

test('release DOM land scenario proves level-up, economy, equipment, NPC duel and a bounded boss exclusion through visible actions',{timeout:20*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'release-land',legacyFixture:checkpoint,allowedTaskIds,combatRandomMode:'best-play',dropRandomValue:0.1});
  const started=Date.now();scenario.startedAt=new Date().toISOString();
  const coverage=[];
  try{
    scenario.stage='import audited 15.697 level-106 checkpoint';
    await scenario.openBrowser();await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="import-save"]'),{label:'land checkpoint import control'});
    await scenario.page.chooseFile('[data-action="import-save"]',fixturePath);scenario.uiClicks+=1;await scenario.waitPage('location');
    await scenario.page.waitFor(()=>document.querySelector('#save-status')?.textContent==='导入结果已保存',{label:'land checkpoint import completion'});
    scenario.currentNode=checkpoint.state.player.current_map_node_canonical_id;await scenario.measure('release_land_import');await scenario.selectSeries('task.series.15');

    const initial=await scenario.exportSave('release-land-initial');
    assert.equal(initial.state.player.level,106);assert.equal(initial.state.tasks['task.series.15.698'].status,'locked');
    assert.equal(initial.state.equipment.clothes,null);for(const id of allowedTaskIds)assert.notEqual(initial.state.tasks[id].status,'completed',id);

    scenario.stage='visible formal shop purchase';
    const staminaPurchase=await purchaseStamina(scenario,5);coverage.push('formal shop purchase and money deduction','inventory acquisition');

    scenario.stage='visible ordinary encounter level-up and equipment drop';
    const placement=scenario.content.monster_placements.find((entry)=>entry.monster_canonical_id===trainingMonsterId&&entry.repeatable&&entry.encounter_type==='wild');assert.ok(placement);
    await scenario.reach(placement.location_canonical_id);const trainingResult=await scenario.fight(trainingMonsterId);assert.equal(trainingResult,'won');
    const afterTraining=await scenario.exportSave('release-land-after-training');
    assert.equal(afterTraining.state.player.level,107,'visible ordinary encounter must cross the level gate');
    assert.equal(afterTraining.state.tasks['task.series.15.698'].status,'available','level-gated task must unlock without reload/import');
    assert.equal(afterTraining.state.inventory[expectedTrainingDropId],1,'deterministic UAT drop must be source-backed equipment');
    const dropped=scenario.equipmentById.get(expectedTrainingDropId);assert.ok(dropped);await scenario.equipItem(dropped);
    const afterEquip=await scenario.exportSave('release-land-after-equipment-equip');
    assert.equal(afterEquip.state.equipment.clothes,expectedTrainingDropId);assert.equal(afterEquip.state.inventory[expectedTrainingDropId],undefined);
    coverage.push('repeatable ordinary monster','experience and level progression','source-backed equipment drop','visible equipment equip');

    for(const id of completedTaskIds){
      await scenario.completeTask(scenario.taskById.get(id));
      if(id==='task.series.15.701'||id==='task.series.15.704')await scenario.refreshAndVerifyProgress();
    }
    coverage.push('NPC duel','dialogue and courier chain','acceptance item and submission consumption','continuous reward inheritance');

    scenario.stage='bounded source-balance boundary attempt';
    const boundaryTask=scenario.taskById.get(boundaryTaskId);
    await scenario.reach(boundaryTask.receive_location_canonical_id);await scenario.visitNpc(boundaryTask.issuer_npc_canonical_id);
    assert.equal(await scenario.page.text(`[data-npc-action=${JSON.stringify(boundaryTask.issuer_npc_canonical_id)}]`),'接受任务');
    await scenario.npcAction(boundaryTask.issuer_npc_canonical_id);
    await scenario.reach(boundaryTask.target_location_canonical_id);
    const boundaryResult=await scenario.fight(boundaryTask.targets[0].entity_canonical_id);
    assert.equal(boundaryResult,'lost','level-107 release checkpoint must not fabricate closure against the source level-176 type-6 boss');
    coverage.push('bounded boss failure and exclusion evidence');

    const completed=await scenario.exportSave('release-land-completed');
    for(const id of completedTaskIds)assert.equal(completed.state.tasks[id].status,'completed',id);
    assert.equal(completed.state.tasks[boundaryTaskId].status,'accepted');
    assert.equal(completed.state.tasks[boundaryTaskId].current_step,1,'acceptance step may advance, but the monster objective must remain unsettled');
    assert.equal(completed.state.tasks[boundaryTaskId].reward_status,'not_granted');
    assert.equal(completed.state.reward_grants[boundaryTaskId],undefined);
    assert.equal(completed.state.tasks['task.series.15.707'].status,'locked');
    assert.equal(completed.state.tasks['task.series.15.269'].status,'blocked');assert.equal(completed.state.tasks['task.series.15.601'].status,'blocked');
    assert.equal(completed.state.combat,null);assert.equal(completed.state.npc_duel,null);assert.equal(completed.state.voyage,null);
    assert.ok(scenario.npcDuel.won>=1,'land evidence must include a won NPC duel');
    assert.ok(scenario.battle.won>=1,'land supplemental evidence must include the ordinary training victory');
    assert.ok(scenario.battle.lost>=1,'land supplemental evidence must include the bounded source-balance boss loss');

    scenario.stage='land export import round trip';
    await scenario.importSave(completed.file);const roundTrip=await scenario.exportSave('release-land-roundtrip');scenario.assertEquivalentSettlement(completed.state,roundTrip.state);
    for(const id of completedTaskIds)assert.equal(roundTrip.state.tasks[id].status,'completed',id);
    assert.equal(roundTrip.state.tasks[boundaryTaskId].status,'accepted');

    const consumed=staminaPurchase.quantity-Number(roundTrip.state.inventory[staminaPurchase.item_canonical_id]??0);
    assert.ok(consumed>=0&&consumed<=staminaPurchase.quantity,'stamina consumption must remain within the finite visible purchase budget');
    scenario.endedAt=new Date().toISOString();scenario.durationMs=Date.now()-started;
    const result=scenario.result(roundTrip.state);evidence.push({...result,checkpoint_fixture:'tests/fixtures/browser-save-v5-series15-697-level106.json',
      evidence_task_canonical_ids:allowedTaskIds,evidence_task_count:allowedTaskIds.length,completed_evidence_task_canonical_ids:completedTaskIds,completed_evidence_task_count:completedTaskIds.length,
      coverage:[...new Set(coverage)],training:{monster_canonical_id:trainingMonsterId,starting_level:106,ending_level:107,source_experience_reward:1760,
        dropped_equipment_canonical_id:expectedTrainingDropId,equipped_slot:'clothes'},combat_consumable_budget:{...staminaPurchase,consumed_quantity:consumed},
      excluded_task_canonical_ids:[boundaryTaskId],exclusions:[{task_canonical_id:boundaryTaskId,reason:'Source task gate is level 107 while the formal target 一团黑气 is level 176/type 6. One visible bounded attempt after five visible 体力宝 purchases still loses; no excessive retries or resource injection were permitted.',browser_attempts:1,completion_status:roundTrip.state.tasks[boundaryTaskId].status,reward_status:roundTrip.state.tasks[boundaryTaskId].reward_status}],
      aggregate_boss_coverage:{evidence_path:'artifacts/browser-acceptance-stage/raw/series15-long-chain-dom-results.json',task_range:'task.series.15.455-task.series.15.472',note:'The already committed representative long chain supplies real successful Boss combat coverage; this supplemental scenario records the distinct level-107/level-176 closure boundary honestly.'},
      page_refreshes_inside_chain:2,final_export_import_state_equivalent:true,retained_data_conflict_task_canonical_ids:['task.series.15.269','task.series.15.601'],direct_browser_storage_writes:false});
    process.stdout.write(`ZHSH_RELEASE_LAND:${JSON.stringify(evidence[0])}\n`);
  }finally{
    if(scenario.page){scenario.collectPageDiagnostics();await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});

async function purchaseStamina(scenario,quantity){
  const entry=scenario.content.shop_entries.find((candidate)=>candidate.display_name==='体力宝'&&Number(candidate.price)===200000);assert.ok(entry);
  const before=await scenario.exportSave('release-land-before-stamina-purchase');const prior=Number(before.state.inventory[entry.content_entity_canonical_id]??0);
  await scenario.reach(entry.location_canonical_id);await scenario.ensurePage('shop');await scenario.measure('release_land_shop');
  for(let index=0;index<quantity;index+=1)await scenario.click(`[data-shop-buy=${JSON.stringify(entry.canonical_id)}]`,{save:true});
  const after=await scenario.exportSave('release-land-after-stamina-purchase');assert.equal(after.state.inventory[entry.content_entity_canonical_id],prior+quantity);
  assert.equal(after.state.player.money,before.state.player.money-quantity*Number(entry.price));
  return {item_canonical_id:entry.content_entity_canonical_id,display_name:entry.display_name,shop_entry_canonical_id:entry.canonical_id,quantity,
    unit_price:Number(entry.price),total_price:quantity*Number(entry.price),money_before:before.state.player.money,money_after:after.state.player.money,acquisition:'visible formal shop UI'};
}
