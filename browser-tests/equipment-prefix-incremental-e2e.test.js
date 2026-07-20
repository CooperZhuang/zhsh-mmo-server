'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {after,before,test}=require('node:test');
const {DomGameplayScenario}=require('./dom-gameplay-runner');
const {startStaticServer,stopStaticServer}=require('./edge-cdp');

const root=path.resolve(__dirname,'..');
const fixturePath=path.join(root,'tests','fixtures','browser-save-v3-formal-71-of-71.json');
const baselineBytes=fs.readFileSync(fixturePath);
const baseline=JSON.parse(baselineBytes);
const taskId='task.series.02.012';
let server;const evidence=[];

function selector(attribute,value){return `[${attribute}=${JSON.stringify(String(value))}]`;}

before(async()=>{server=await startStaticServer(root);});
after(async()=>{
  await stopStaticServer(server);
  const directory=process.env.ZHSH_BROWSER_E2E_EVIDENCE_DIR??path.join(root,'artifacts','equipment-combat-stage','raw');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'equipment-prefix-incremental-dom-results.json'),`${JSON.stringify({schema_version:1,scenarios:evidence},null,2)}\n`,'utf8');
});

test('incremental DOM imports the accepted 71-task fixture and naturally completes only 02.012',{timeout:10*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'equipment-prefix-incremental',legacyFixture:baseline});
  const started=Date.now();const targetEvidence=[];
  try{
    scenario.startedAt=new Date().toISOString();scenario.stage='import accepted 71-task save';
    await scenario.openBrowser();await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="import-save"]'),{label:'formal save import control'});
    await scenario.page.chooseFile('[data-action="import-save"]',fixturePath);scenario.uiClicks+=1;await scenario.waitPage('location');
    scenario.currentNode=baseline.state.player.current_map_node_canonical_id;
    const initialStatus=await scenario.readStatus();assert.equal(initialStatus.completed,71);assert.equal(initialStatus.total,72);
    const task=scenario.taskById.get(taskId);assert.ok(task);
    await scenario.selectSeries(task.series_canonical_id);
    await scenario.reach(task.receive_location_canonical_id);await scenario.visitNpc(task.issuer_npc_canonical_id);
    await scenario.npcAction(task.issuer_npc_canonical_id);

    for(const target of task.targets){
      const drop=scenario.content.drop_relations.find((entry)=>entry.canonical_id===target.runtime_resolution.formal_source_canonical_id);
      assert.ok(drop,`missing drop ${target.canonical_id}`);
      const placement=scenario.content.monster_placements.find((entry)=>entry.monster_canonical_id===drop.monster_canonical_id&&
        entry.location_canonical_id===(drop.location_canonical_id??task.target_location_canonical_id));
      assert.ok(placement,`missing placement ${target.canonical_id}`);
      await scenario.reach(placement.location_canonical_id);
      const visibleSourceLocation=await scenario.page.text('.current-location');
      await scenario.ensurePage('encounter');
      assert.equal(await scenario.page.countVisible(selector('data-combat-start',drop.monster_canonical_id)),1,'source encounter must be visible in DOM');
      let attempts=0;
      while(!(await scenario.taskProgressComplete(task.canonical_id,target.canonical_id))){
        attempts+=1;assert.ok(attempts<=25,`${target.raw_name} exceeded source-derived attempt bound`);
        await scenario.reach(placement.location_canonical_id);await scenario.recoverIfNeeded(placement.location_canonical_id);
        const outcome=await scenario.fight(drop.monster_canonical_id);
        if(outcome==='lost')await scenario.reach(placement.location_canonical_id);
      }
      await scenario.ensurePage('backpack');
      assert.equal(await scenario.page.countVisible(`${selector('data-page','item')}${selector('data-item-id',target.entity_canonical_id)}`),1,
        `${target.raw_name} must be visible in the DOM backpack`);
      const targetSave=await scenario.exportSave(`obtained-${target.target_order}`);
      assert.ok(Number(targetSave.state.inventory[target.entity_canonical_id]??0)>=target.required_quantity);
      targetEvidence.push({target_canonical_id:target.canonical_id,item_canonical_id:target.entity_canonical_id,item_name:target.raw_name,
        source_kind:'monster_drop',source_location_canonical_id:placement.location_canonical_id,visible_source_location:visibleSourceLocation,
        source_monster_canonical_id:drop.monster_canonical_id,attempts,inventory_quantity:targetSave.state.inventory[target.entity_canonical_id],
        encounter_control_visible:true,backpack_item_visible:true});
    }

    await scenario.reach(task.submit_location_canonical_id);await scenario.visitNpc(task.completion_npc_canonical_id);
    await scenario.npcAction(task.completion_npc_canonical_id);scenario.markCompleted(task);
    const finalStatus=await scenario.readStatus();assert.equal(finalStatus.completed,72);assert.equal(finalStatus.total,72);
    await scenario.refreshAndVerifyProgress();const exported=await scenario.exportSave('equipment-prefix-incremental-final');
    assert.equal(exported.state.tasks[taskId].status,'completed');
    const newlyCompleted=Object.entries(exported.state.tasks).filter(([id,state])=>state.status==='completed'&&baseline.state.tasks[id]?.status!=='completed').map(([id])=>id).sort();
    assert.deepEqual(newlyCompleted,[taskId]);
    assert.deepEqual(fs.readFileSync(fixturePath),baselineBytes,'accepted fixture must remain byte-for-byte immutable');
    scenario.endedAt=new Date().toISOString();scenario.durationMs=Date.now()-started;
    evidence.push({...scenario.result(exported.state),selection_hash:scenario.content.runnable_task_selection.selection_hash,
      imported_fixture:'tests/fixtures/browser-save-v3-formal-71-of-71.json',imported_fixture_checksum:baseline.checksum,
      initial_completed_task_count:71,newly_completed_task_canonical_ids:newlyCompleted,target_evidence:targetEvidence,
      browser_ui_actions:scenario.uiClicks,formal_runtime_adapter_actions:0,direct_storage_mutations:0});
    process.stdout.write(`ZHSH_EQUIPMENT_INCREMENTAL_DOM:${JSON.stringify(evidence[0])}\n`);
  }finally{
    if(scenario.page){scenario.collectPageDiagnostics();await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});
