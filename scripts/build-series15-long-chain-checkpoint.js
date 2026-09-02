#!/usr/bin/env node
'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {
  BrowserTaskCatalog,LEVEL_THRESHOLDS,MemoryRuntimeStorage,TaskRuntimeEngine,
  applyExperienceProgression,makeEnvelope,validateAndUpgradeEnvelope,
}=require('../src/task-runtime');

const root=path.resolve(__dirname,'..');
const content=read('web/generated/task1-content.json');
const source=validateAndUpgradeEnvelope(read('tests/fixtures/browser-save-v4-formal-72-of-72.json'));
const terminalTaskId='task.series.15.454';
const firstEvidenceTaskId='task.series.15.455';
const evidenceTaskIds=range(455,472).map((number)=>`task.series.15.${number}`);
const equipmentIds=[
  'entity.equipment.c9913b879b85ee45','entity.equipment.0d3eeb9b40ed3b7e','entity.equipment.e156a287baf90005',
  'entity.equipment.a2e1b812d0cfd5b9','entity.equipment.22176e1ac0fa66e3','entity.equipment.1ef177807961d5b6',
  'entity.equipment.d319659d3957c117','entity.equipment.67dc4911873e9eed',
];
const slotByType={1:'weapon',2:'headgear',3:'clothes',4:'belt',5:'shoes',6:'accessories',7:'offhand'};
const taskById=new Map(content.tasks.map((task)=>[task.canonical_id,task]));
const equipmentById=new Map(content.equipment.map((entry)=>[entry.canonical_id,entry]));
const historicalTasks=content.tasks.filter((task)=>task.series_canonical_id==='task.series.15'&&task.sequence_position<=taskById.get(terminalTaskId).sequence_position);
const conflictTasks=historicalTasks.filter((task)=>task.directory_status==='data_conflict');
const completedHistoricalTasks=historicalTasks.filter((task)=>task.directory_status!=='data_conflict');
const targetLevel=200;
const targetExperience=Number(LEVEL_THRESHOLDS[targetLevel-1]);
const state=structuredClone(source.state);
const baseline={level:state.player.level,experience:state.player.experience,money:state.player.money,completed_task_count:completedCount(state)};
const rewardTotals={experience:0,money:0,source_label_items:0,resolved_items_recorded_as_historically_consumed:0};
const historicalRewardIds=[];
const now='2026-07-20T00:00:00.000Z';

const catalog=new BrowserTaskCatalog(content);
const storage=new MemoryRuntimeStorage();
storage.createPlayer(state);
const engine=new TaskRuntimeEngine({catalog,storage,clock:()=>now,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id)});
engine.synchronizeDefinitions(source.player_canonical_id);
storage.transact(source.player_canonical_id,(draft)=>{
  for(const task of completedHistoricalTasks){
    const runtime=draft.tasks[task.canonical_id];
    runtime.status='completed';runtime.current_step=3;
    runtime.reward_status=task.rewards.some((reward)=>reward.resolution_status==='source_label_only')?'granted_with_source_label_records':'granted';
    runtime.block_reasons=[];
    for(const target of task.targets)draft.progress[`${task.canonical_id}|${target.canonical_id}`]=Number(target.required_quantity);
    draft.flags[`task.completed.${task.canonical_id}`]=true;
    for(const reward of task.rewards){
      historicalRewardIds.push(reward.canonical_id);
      if(reward.reward_kind==='experience'){rewardTotals.experience+=Number(reward.quantity);draft.reward_grants[reward.canonical_id]={task_canonical_id:task.canonical_id,quantity:Number(reward.quantity),effect_status:'applied'};}
      else if(reward.reward_kind==='money'){rewardTotals.money+=Number(reward.quantity);draft.reward_grants[reward.canonical_id]={task_canonical_id:task.canonical_id,quantity:Number(reward.quantity),effect_status:'applied'};}
      else if(reward.content_entity_canonical_id&&reward.resolution_status==='resolved'){
        rewardTotals.resolved_items_recorded_as_historically_consumed+=Number(reward.quantity);
        draft.reward_grants[reward.canonical_id]={task_canonical_id:task.canonical_id,quantity:Number(reward.quantity),effect_status:'applied'};
      }else{
        rewardTotals.source_label_items+=Number(reward.quantity);
        draft.reward_grants[reward.canonical_id]={task_canonical_id:task.canonical_id,quantity:Number(reward.quantity),effect_status:'recorded_source_label_only'};
      }
    }
  }
  for(const task of conflictTasks){
    const runtime=draft.tasks[task.canonical_id];runtime.status='blocked';runtime.current_step=0;runtime.reward_status='not_granted';runtime.block_reasons=structuredClone(task.blocking_reasons);
    delete draft.flags[`task.completed.${task.canonical_id}`];
    for(const target of task.targets)draft.progress[`${task.canonical_id}|${target.canonical_id}`]=0;
  }
  draft.player.money=Number(draft.player.money)+rewardTotals.money;
  draft.player.experience=Math.max(Number(draft.player.experience)+rewardTotals.experience,targetExperience);
  applyExperienceProgression(draft);
  if(draft.player.level!==targetLevel)throw new Error(`Checkpoint progression ended at level ${draft.player.level}, expected ${targetLevel}`);

  const priorEquipment={...draft.equipment,accessories:[...(draft.equipment.accessories??[])]};
  for(const itemId of [priorEquipment.weapon,priorEquipment.offhand,priorEquipment.headgear,priorEquipment.clothes,priorEquipment.belt,priorEquipment.shoes,...priorEquipment.accessories].filter(Boolean))
    draft.inventory[itemId]=Number(draft.inventory[itemId]??0)+1;
  draft.equipment={weapon:null,offhand:null,headgear:null,clothes:null,belt:null,shoes:null,accessories:[null,null,null]};
  let accessoryIndex=0;
  for(const itemId of equipmentIds){
    const item=equipmentById.get(itemId);if(!item)throw new Error(`Checkpoint equipment missing: ${itemId}`);
    const slot=slotByType[Number(item.equipment_type)];if(!slot)throw new Error(`Checkpoint equipment slot unresolved: ${itemId}`);
    if(slot==='accessories')draft.equipment.accessories[accessoryIndex++]=itemId;else draft.equipment[slot]=itemId;
    delete draft.inventory[itemId];
  }

  const evidenceItems=new Set();
  for(const taskId of evidenceTaskIds){
    const task=taskById.get(taskId);
    const runtime=draft.tasks[taskId];runtime.status='locked';runtime.current_step=0;runtime.reward_status='not_granted';runtime.block_reasons=structuredClone(task.blocking_reasons??[]);
    delete draft.flags[`task.completed.${taskId}`];
    for(const target of task.targets){draft.progress[`${taskId}|${target.canonical_id}`]=0;if(target.target_kind==='item')evidenceItems.add(target.entity_canonical_id);}
    for(const reward of task.rewards){delete draft.reward_grants[reward.canonical_id];if(reward.content_entity_canonical_id)evidenceItems.add(reward.content_entity_canonical_id);}
  }
  for(const itemId of evidenceItems)delete draft.inventory[itemId];
  draft.task_item_ledger={schema_version:1,reservations:{},grants:{},consumptions:{},abandonments:{}};
  draft.combat=null;draft.voyage=null;draft.fishing=null;draft.maritime_encounter=null;draft.dungeon=null;
  draft.active_series_canonical_id='task.series.15';
  const firstTask=taskById.get(firstEvidenceTaskId);const firstNode=catalog.getNodeForLocation(firstTask.receive_location_canonical_id);
  draft.player.current_map_node_canonical_id=firstNode.map_node_canonical_id;
  if(!draft.unlocked_map_nodes.includes(firstNode.map_node_canonical_id))draft.unlocked_map_nodes.push(firstNode.map_node_canonical_id);
  draft.player.current_health=draft.player.max_health;
  draft.player.updated_at=now;
  draft.flags['uat.precondition.series15_through_454']=true;
  draft.flags['uat.precondition.level_200']=true;
  draft.flags['uat.precondition.source_backed_loadout']=true;
  return {applied:true};
});
engine.refreshAvailability(source.player_canonical_id);
const finalState=engine.loadPlayer(source.player_canonical_id);
assertCheckpoint(finalState);
const record=makeEnvelope(finalState,Number(source.revision)+1);
const fixturePath=path.join(root,'tests','fixtures','browser-save-v5-series15-454-level200.json');
const auditPath=path.join(root,'artifacts','browser-acceptance-stage','raw','series15-454-checkpoint-audit.json');
fs.mkdirSync(path.dirname(auditPath),{recursive:true});
fs.writeFileSync(fixturePath,`${JSON.stringify(record,null,2)}\n`);
const audit={
  schema_version:1,record_kind:'series15_representative_chain_release_acceptance_precondition',generated_at:now,
  source_fixture:'tests/fixtures/browser-save-v4-formal-72-of-72.json',output_fixture:path.relative(root,fixturePath),
  evidence_scope:{included_task_canonical_ids:evidenceTaskIds,excluded_history_terminal_task_canonical_id:terminalTaskId,
    statement:'Only browser actions and resulting runtime state for task.series.15.455 through task.series.15.472 count as representative-chain acceptance evidence.'},
  historical_precondition:{series_canonical_id:'task.series.15',first_task_canonical_id:historicalTasks[0].canonical_id,terminal_task_canonical_id:terminalTaskId,
    completed_task_count:completedHistoricalTasks.length,completed_task_canonical_ids:completedHistoricalTasks.map((task)=>task.canonical_id),
    retained_conflicts:conflictTasks.map((task)=>({task_canonical_id:task.canonical_id,status:'blocked',directory_status:task.directory_status,blocking_reasons:task.blocking_reasons})),
    direct_task_state_mutations:completedHistoricalTasks.length,
    exclusion:'Historical task statuses are a disclosed fixture precondition and are not acceptance evidence; no task in the 15.455-15.472 evidence scope is completed, progressed, rewarded, or supplied with its task items.'},
  reward_accounting:{baseline,reward_totals:rewardTotals,historical_reward_grant_count:historicalRewardIds.length,
    final_experience:finalState.player.experience,final_money:finalState.player.money,
    level_checkpoint_experience_supplement:Math.max(0,targetExperience-(baseline.experience+rewardTotals.experience))},
  level_checkpoint:{target_level:targetLevel,source_declared_gate_task_canonical_id:'task.series.15.470',source_declared_gate_level:200,
    exclusion:'This establishes the source-declared level gate only; it is not evidence that the current progression economy reaches level 200 within the browser acceptance budget.'},
  equipment_checkpoint:{equipment_canonical_ids:equipmentIds,equipment:equipmentIds.map((id)=>{const item=equipmentById.get(id);return {canonical_id:id,display_name:item.display_name,equipment_type:item.equipment_type,required_level:item.required_level};}),
    exclusion:'The source-backed loadout is a disclosed combat precondition; equipment acquisition is outside the 18-task chain evidence scope.'},
  combat_consumable_budget:{item_display_name:'体力宝',quantity:3,unit_price:200000,total_price:600000,
    acquisition_rule:'The browser scenario must purchase all three items through the formal shop UI before task.series.15.470; no item quantity is injected into the checkpoint.',
    derivation:'Deterministic source combat closure requires three automatic uses against the level-117 type-6 妖龙 with the disclosed level-200 loadout.'},
  initial_evidence_scope_state:{first_task_status:finalState.tasks[firstEvidenceTaskId].status,completed_evidence_tasks:evidenceTaskIds.filter((id)=>finalState.tasks[id].status==='completed'),
    progressed_evidence_targets:evidenceTaskIds.flatMap((id)=>taskById.get(id).targets.map((target)=>({key:`${id}|${target.canonical_id}`,value:Number(finalState.progress[`${id}|${target.canonical_id}`]??0)}))).filter((entry)=>entry.value!==0),
    active_task_item_reservations:Object.keys(finalState.task_item_ledger.reservations),money:finalState.player.money,level:finalState.player.level,current_map_node_canonical_id:finalState.player.current_map_node_canonical_id},
};
fs.writeFileSync(auditPath,`${JSON.stringify(audit,null,2)}\n`);
process.stdout.write(`${JSON.stringify({fixture:path.relative(root,fixturePath),audit:path.relative(root,auditPath),historical_completed:completedHistoricalTasks.length,
  retained_conflicts:conflictTasks.map((task)=>task.canonical_id),first_evidence_task_status:finalState.tasks[firstEvidenceTaskId].status,level:finalState.player.level,money:finalState.player.money},null,2)}\n`);

function assertCheckpoint(checkpoint){
  if(checkpoint.tasks[terminalTaskId].status!=='completed')throw new Error(`${terminalTaskId} is not completed`);
  // 15.269 已被 adjudication 解析为 runnable_pending_validation(有源)，不再作为历史 conflict 保留。
  if(checkpoint.tasks[firstEvidenceTaskId].status!=='available')throw new Error(`${firstEvidenceTaskId} is not available`);
  for(const taskId of evidenceTaskIds){
    if(checkpoint.tasks[taskId].status==='completed')throw new Error(`Evidence task was pre-completed: ${taskId}`);
    for(const target of taskById.get(taskId).targets)if(Number(checkpoint.progress[`${taskId}|${target.canonical_id}`]??0)!==0)throw new Error(`Evidence target was pre-progressed: ${target.canonical_id}`);
  }
  if(checkpoint.player.level!==targetLevel)throw new Error('Checkpoint level mismatch');
  if(checkpoint.player.money<600000)throw new Error('Checkpoint cannot fund the finite three-item stamina proof');
  if(Object.keys(checkpoint.task_item_ledger.reservations).length)throw new Error('Checkpoint contains active task-item reservations');
}
function completedCount(value){return Object.values(value.tasks??{}).filter((entry)=>entry.status==='completed').length;}
function range(start,end){return Array.from({length:end-start+1},(_,index)=>start+index);}
function read(relative){return JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));}
