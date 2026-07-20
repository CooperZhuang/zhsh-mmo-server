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
const checkpoint=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
const taskIds=Array.from({length:18},(_,index)=>`task.series.15.${455+index}`);
const evidence=[];let server;

before(async()=>{server=await startStaticServer(root);});
after(async()=>{
  await stopStaticServer(server);
  const directory=process.env.ZHSH_BROWSER_E2E_EVIDENCE_DIR??path.join(root,'artifacts','browser-acceptance-stage','raw');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'series15-long-chain-dom-results.json'),`${JSON.stringify({schema_version:1,scenarios:evidence},null,2)}\n`,'utf8');
});

test('representative DOM chain 15.455 through 15.472 completes through visible browser actions and survives refresh/import',{timeout:15*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'series15-long-chain',legacyFixture:checkpoint,allowedTaskIds:taskIds,combatRandomMode:'best-play'});
  const started=Date.now();scenario.startedAt=new Date().toISOString();
  const lifecycle=[];const combatConsumables=[];
  try{
    scenario.stage='import audited 15.454 checkpoint';
    await scenario.openBrowser();await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="import-save"]'),{label:'series15 checkpoint import control'});
    await scenario.page.chooseFile('[data-action="import-save"]',fixturePath);scenario.uiClicks+=1;await scenario.waitPage('location');
    await scenario.page.waitFor(()=>document.querySelector('#save-status')?.textContent==='导入结果已保存',{label:'series15 checkpoint import completion'});
    scenario.currentNode=checkpoint.state.player.current_map_node_canonical_id;
    await scenario.measure('series15_long_chain_import');
    await scenario.selectSeries('task.series.15');

    const initial=await scenario.exportSave('series15-long-chain-initial');
    assert.equal(initial.state.tasks['task.series.15.454'].status,'completed');
    assert.equal(initial.state.tasks['task.series.15.455'].status,'available');
    for(const id of taskIds)assert.notEqual(initial.state.tasks[id].status,'completed',id);

    for(const id of taskIds){
      const task=scenario.taskById.get(id);assert.ok(task,id);
      if(id==='task.series.15.470')combatConsumables.push(await purchaseFormalStaminaBudget(scenario));
      if(id==='task.series.15.459'||id==='task.series.15.463')await completeAcceptanceGrantTask(scenario,task,lifecycle);
      else await scenario.completeTask(task);

      if(id==='task.series.15.456'){
        const after=await scenario.exportSave('after-15-456-black-pearl-reward');const item=taskItem(scenario,'task.series.15.457');
        assert.equal(after.state.inventory[item],1);lifecycle.push({after_task:id,item_canonical_id:item,quantity:1,transition:'prerequisite_reward_available'});
      }
      if(id==='task.series.15.457'){
        const after=await scenario.exportSave('after-15-457-black-pearl-submit');const item=taskItem(scenario,id);
        assert.equal(after.state.inventory[item],undefined);lifecycle.push({after_task:id,item_canonical_id:item,quantity:0,transition:'submit_consumed'});
      }
      if(id==='task.series.15.459'||id==='task.series.15.463')await scenario.refreshAndVerifyProgress();
      if(id==='task.series.15.470'){
        const after=await scenario.exportSave('after-15-470-dragon-scale-reward');const item=taskItem(scenario,'task.series.15.471');
        assert.equal(after.state.inventory[item],1);assert.equal(after.state.inventory[combatConsumables[0].item_canonical_id],undefined);
        const recordedUses=Object.values(after.state.gameplay_events).flatMap((entry)=>entry.result?.stamina_items??[]).filter((entry)=>entry.applied&&entry.item_canonical_id===combatConsumables[0].item_canonical_id);
        assert.equal(recordedUses.length,3,'妖龙 deterministic closure must record exactly three formal stamina-item uses');
        assert.ok(scenario.staminaFeedback.some((message)=>message.includes('体力宝自动使用×3')),'visible combat feedback must disclose all three stamina-item uses');
        lifecycle.push({after_task:id,item_canonical_id:item,quantity:1,transition:'prerequisite_reward_available'});
      }
      if(id==='task.series.15.471'){
        const after=await scenario.exportSave('after-15-471-scale-consumed-pearl-reward');const scale=taskItem(scenario,id),pearl=taskItem(scenario,'task.series.15.472');
        assert.equal(after.state.inventory[scale],undefined);assert.equal(after.state.inventory[pearl],1);
        lifecycle.push({after_task:id,item_canonical_id:scale,quantity:0,transition:'submit_consumed'},{after_task:id,item_canonical_id:pearl,quantity:1,transition:'next_reward_available'});
      }
      if(id==='task.series.15.472'){
        const after=await scenario.exportSave('after-15-472-final-pearl-submit');const item=taskItem(scenario,id);
        assert.equal(after.state.inventory[item],undefined);lifecycle.push({after_task:id,item_canonical_id:item,quantity:0,transition:'submit_consumed'});
      }
    }

    const completed=await scenario.exportSave('series15-long-chain-completed');
    for(const id of taskIds)assert.equal(completed.state.tasks[id].status,'completed',id);
    assert.equal(completed.state.tasks['task.series.15.473'].status,'available');
    assert.equal(completed.state.tasks['task.series.15.269'].status,'blocked');
    assert.equal(completed.state.combat,null);assert.equal(completed.state.voyage,null);

    scenario.stage='completed task submit control removal';
    const finalTask=scenario.taskById.get('task.series.15.472');
    await scenario.reach(finalTask.submit_location_canonical_id);const beforeDuplicate=await scenario.exportSave('before-15-472-completed-task-revisit');
    await scenario.visitNpc(finalTask.completion_npc_canonical_id);const revisitAction=await scenario.page.text(`[data-npc-action=${JSON.stringify(finalTask.completion_npc_canonical_id)}]`);
    assert.notEqual(revisitAction,'提交任务','completed 15.472 must not expose another submit action even when the NPC offers the next task');
    const afterDuplicate=await scenario.exportSave('after-15-472-completed-task-revisit');scenario.assertEquivalentSettlement(beforeDuplicate.state,afterDuplicate.state);

    scenario.stage='final export import round trip';
    await scenario.importSave(afterDuplicate.file);const roundTrip=await scenario.exportSave('series15-long-chain-roundtrip');scenario.assertEquivalentSettlement(afterDuplicate.state,roundTrip.state);
    for(const id of taskIds)assert.equal(roundTrip.state.tasks[id].status,'completed',id);

    scenario.endedAt=new Date().toISOString();scenario.durationMs=Date.now()-started;
    const result=scenario.result(roundTrip.state);
    evidence.push({...result,checkpoint_fixture:'tests/fixtures/browser-save-v5-series15-454-level200.json',evidence_task_canonical_ids:taskIds,
      evidence_task_count:taskIds.length,completed_evidence_task_count:taskIds.filter((id)=>roundTrip.state.tasks[id].status==='completed').length,
      item_lifecycle:lifecycle,combat_consumables:combatConsumables,mid_chain_refreshes:2,completed_task_submit_control_absent:true,
      duplicate_submission_idempotency_regression:'tests/task-runtime.test.js + tests/task-item-ledger.test.js',final_export_import_state_equivalent:true,
      retained_data_conflict_task_canonical_ids:['task.series.15.269'],direct_browser_storage_writes:false});
    process.stdout.write(`ZHSH_SERIES15_LONG_CHAIN:${JSON.stringify(evidence[0])}\n`);
  }finally{
    if(scenario.page){scenario.collectPageDiagnostics();await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});

async function purchaseFormalStaminaBudget(scenario){
  const quantity=3;const entry=scenario.content.shop_entries.find((candidate)=>candidate.display_name==='体力宝'&&Number(candidate.price)===200000);
  assert.ok(entry,'formal 体力宝 shop entry missing');
  const before=await scenario.exportSave('before-series15-dragon-stamina-purchase');const priorQuantity=Number(before.state.inventory[entry.content_entity_canonical_id]??0);
  await scenario.reach(entry.location_canonical_id);await scenario.ensurePage('shop');
  for(let index=0;index<quantity;index+=1){await scenario.click(`[data-shop-buy=${JSON.stringify(entry.canonical_id)}]`,{save:true});}
  const after=await scenario.exportSave('after-series15-dragon-stamina-purchase');
  assert.equal(after.state.inventory[entry.content_entity_canonical_id],priorQuantity+quantity);
  assert.equal(after.state.player.money,before.state.player.money-quantity*Number(entry.price));
  return {item_canonical_id:entry.content_entity_canonical_id,display_name:entry.display_name,shop_entry_canonical_id:entry.canonical_id,quantity,unit_price:Number(entry.price),total_price:quantity*Number(entry.price),
    acquisition:'visible formal shop UI',direct_state_mutations:0,money_before:before.state.player.money,money_after:after.state.player.money};
}

async function completeAcceptanceGrantTask(scenario,task,lifecycle){
  scenario.stage=`task ${task.canonical_id} acceptance grant`;
  const target=task.targets.find((entry)=>entry.target_kind==='item');assert.ok(target);
  await scenario.reach(task.receive_location_canonical_id);await scenario.visitNpc(task.issuer_npc_canonical_id);
  assert.equal(await scenario.page.text(`[data-npc-action=${JSON.stringify(task.issuer_npc_canonical_id)}]`),'接受任务');
  await scenario.npcAction(task.issuer_npc_canonical_id);
  const accepted=await scenario.exportSave(`accepted-${task.canonical_id}`);
  assert.equal(accepted.state.inventory[target.entity_canonical_id],target.required_quantity);
  assert.equal(accepted.state.tasks[task.canonical_id].status,'completable');
  assert.equal(accepted.state.progress[`${task.canonical_id}|${target.canonical_id}`],target.required_quantity);
  lifecycle.push({after_task_acceptance:task.canonical_id,item_canonical_id:target.entity_canonical_id,quantity:target.required_quantity,transition:'acceptance_grant'});
  await scenario.reach(task.submit_location_canonical_id);await scenario.visitNpc(task.completion_npc_canonical_id);await scenario.npcAction(task.completion_npc_canonical_id);
  assert.match(await scenario.page.text('.message'),/任务已经完成|经验\+|铜贝\+/);scenario.markCompleted(task);await scenario.equipBestOwned();
  const submitted=await scenario.exportSave(`submitted-${task.canonical_id}`);
  assert.equal(submitted.state.inventory[target.entity_canonical_id],undefined);
  assert.equal(submitted.state.tasks[task.canonical_id].status,'completed');
  lifecycle.push({after_task:task.canonical_id,item_canonical_id:target.entity_canonical_id,quantity:0,transition:'submit_consumed'});
}
function taskItem(scenario,taskId){return scenario.taskById.get(taskId).targets.find((entry)=>entry.target_kind==='item').entity_canonical_id;}
