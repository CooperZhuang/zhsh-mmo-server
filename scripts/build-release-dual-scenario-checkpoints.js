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
const terminalTaskId='task.series.15.697';
const firstEvidenceTaskId='task.series.15.698';
const evidenceTaskIds=range(698,706).map((number)=>`task.series.15.${number}`);
const targetLevel=106;
const nextLevel=107;
const targetExperience=Number(LEVEL_THRESHOLDS[nextLevel-1])-1000;
const now='2026-07-20T02:00:00.000Z';
const taskById=new Map(content.tasks.map((task)=>[task.canonical_id,task]));
const equipmentById=new Map(content.equipment.map((entry)=>[entry.canonical_id,entry]));
const historicalTasks=content.tasks.filter((task)=>task.series_canonical_id==='task.series.15'&&task.sequence_position<=taskById.get(terminalTaskId).sequence_position);
const conflictTasks=historicalTasks.filter((task)=>task.directory_status==='data_conflict');
const completedHistoricalTasks=historicalTasks.filter((task)=>task.directory_status!=='data_conflict');
const loadout=selectLoadout(content.equipment,targetLevel,{leaveClothesEmpty:true});
const state=structuredClone(source.state);
const baseline={level:state.player.level,experience:state.player.experience,money:state.player.money,completed_task_count:completedCount(state)};
const rewardTotals={experience:0,money:0,source_label_items:0,resolved_items_recorded_as_historically_consumed:0};

const catalog=new BrowserTaskCatalog(content);
const storage=new MemoryRuntimeStorage();storage.createPlayer(state);
const engine=new TaskRuntimeEngine({catalog,storage,clock:()=>now,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id)});
engine.synchronizeDefinitions(source.player_canonical_id);
storage.transact(source.player_canonical_id,(draft)=>{
  for(const task of completedHistoricalTasks){
    const runtime=draft.tasks[task.canonical_id];runtime.status='completed';runtime.current_step=3;
    runtime.reward_status=task.rewards.some((reward)=>reward.resolution_status==='source_label_only')?'granted_with_source_label_records':'granted';runtime.block_reasons=[];
    for(const target of task.targets)draft.progress[`${task.canonical_id}|${target.canonical_id}`]=Number(target.required_quantity);
    draft.flags[`task.completed.${task.canonical_id}`]=true;
    for(const reward of task.rewards){
      if(reward.reward_kind==='experience'){rewardTotals.experience+=Number(reward.quantity);draft.reward_grants[reward.canonical_id]={task_canonical_id:task.canonical_id,quantity:Number(reward.quantity),effect_status:'applied'};}
      else if(reward.reward_kind==='money'){rewardTotals.money+=Number(reward.quantity);draft.reward_grants[reward.canonical_id]={task_canonical_id:task.canonical_id,quantity:Number(reward.quantity),effect_status:'applied'};}
      else if(reward.content_entity_canonical_id&&reward.resolution_status==='resolved'){
        rewardTotals.resolved_items_recorded_as_historically_consumed+=Number(reward.quantity);draft.reward_grants[reward.canonical_id]={task_canonical_id:task.canonical_id,quantity:Number(reward.quantity),effect_status:'applied'};
      }else{rewardTotals.source_label_items+=Number(reward.quantity);draft.reward_grants[reward.canonical_id]={task_canonical_id:task.canonical_id,quantity:Number(reward.quantity),effect_status:'recorded_source_label_only'};}
    }
  }
  for(const task of conflictTasks){
    const runtime=draft.tasks[task.canonical_id];runtime.status='blocked';runtime.current_step=0;runtime.reward_status='not_granted';runtime.block_reasons=structuredClone(task.blocking_reasons);
    delete draft.flags[`task.completed.${task.canonical_id}`];for(const target of task.targets)draft.progress[`${task.canonical_id}|${target.canonical_id}`]=0;
  }
  draft.player.money=Math.max(1500000,Number(draft.player.money)+rewardTotals.money);
  draft.player.experience=targetExperience;setPlayerLevelWithStats(draft,targetLevel);
  if(draft.player.level!==targetLevel)throw new Error(`Land checkpoint ended at level ${draft.player.level}, expected ${targetLevel}`);

  for(const itemId of equippedIds(draft.equipment))draft.inventory[itemId]=Number(draft.inventory[itemId]??0)+1;
  draft.equipment={weapon:null,offhand:null,headgear:null,clothes:null,belt:null,shoes:null,accessories:[null,null,null]};
  for(const [slot,value] of Object.entries(loadout)){
    if(slot==='accessories'){draft.equipment.accessories=[...value];for(const id of value)delete draft.inventory[id];}
    else{draft.equipment[slot]=value;if(value)delete draft.inventory[value];}
  }

  const evidenceItems=new Set();
  for(const taskId of evidenceTaskIds){
    const task=taskById.get(taskId);const runtime=draft.tasks[taskId];runtime.status='locked';runtime.current_step=0;runtime.reward_status='not_granted';runtime.block_reasons=structuredClone(task.blocking_reasons??[]);
    delete draft.flags[`task.completed.${taskId}`];
    for(const target of task.targets){draft.progress[`${taskId}|${target.canonical_id}`]=0;if(target.target_kind==='item')evidenceItems.add(target.entity_canonical_id);}
    for(const reward of task.rewards){delete draft.reward_grants[reward.canonical_id];if(reward.content_entity_canonical_id)evidenceItems.add(reward.content_entity_canonical_id);}
  }
  for(const itemId of evidenceItems)delete draft.inventory[itemId];
  const stamina=content.shop_entries.find((entry)=>entry.display_name==='体力宝');if(stamina)delete draft.inventory[stamina.content_entity_canonical_id];
  draft.task_item_ledger={schema_version:1,reservations:{},grants:{},consumptions:{},abandonments:{}};
  draft.combat=null;draft.npc_duel=null;draft.voyage=null;draft.fishing=null;draft.maritime_encounter=null;draft.dungeon=null;
  draft.active_series_canonical_id='task.series.15';
  const firstTask=taskById.get(firstEvidenceTaskId);const firstNode=catalog.getNodeForLocation(firstTask.receive_location_canonical_id);
  draft.player.current_map_node_canonical_id=firstNode.map_node_canonical_id;if(!draft.unlocked_map_nodes.includes(firstNode.map_node_canonical_id))draft.unlocked_map_nodes.push(firstNode.map_node_canonical_id);
  draft.player.current_health=draft.player.max_health;draft.player.updated_at=now;
  draft.flags['uat.precondition.series15_through_697']=true;draft.flags['uat.precondition.level_106_near_107']=true;draft.flags['uat.precondition.source_backed_land_loadout']=true;
  return {applied:true};
});
engine.refreshAvailability(source.player_canonical_id);
const finalState=engine.loadPlayer(source.player_canonical_id);assertCheckpoint(finalState);
const record=makeEnvelope(finalState,Number(source.revision)+1);
const fixturePath=path.join(root,'tests','fixtures','browser-save-v5-series15-697-level106.json');
const auditPath=path.join(root,'artifacts','browser-acceptance-stage','raw','series15-697-land-checkpoint-audit.json');
fs.mkdirSync(path.dirname(auditPath),{recursive:true});
fs.writeFileSync(fixturePath,`${JSON.stringify(record,null,2)}\n`);
const audit={
  schema_version:1,record_kind:'release_dual_scenario_land_precondition',generated_at:now,
  source_fixture:'tests/fixtures/browser-save-v4-formal-72-of-72.json',output_fixture:path.relative(root,fixturePath),
  evidence_scope:{included_task_canonical_ids:evidenceTaskIds,training_evidence:'one visible repeatable wild encounter must cross level 106 to 107 before task.series.15.698',
    statement:'Historical task statuses, starting experience and equipped loadout are disclosed preconditions. Only visible browser actions after import count as dual-scenario evidence.'},
  historical_precondition:{terminal_task_canonical_id:terminalTaskId,completed_task_count:completedHistoricalTasks.length,retained_conflicts:conflictTasks.map((task)=>task.canonical_id),direct_task_state_mutations:completedHistoricalTasks.length},
  progression_precondition:{starting_level:targetLevel,starting_experience:targetExperience,next_level:nextLevel,next_level_threshold:Number(LEVEL_THRESHOLDS[nextLevel-1]),remaining_experience:1000,
    disclosed_reason:'The imported source threshold table is non-monotonic around levels 101-102, so the exact level-106 checkpoint is established with the same per-level stat growth formula; the browser must still earn the final 1000 experience through a visible fight.'},
  economy_precondition:{starting_money:finalState.player.money,stamina_item_preloaded:false},
  equipment_precondition:{loadout,items:Object.values(loadout).flat().filter(Boolean).map((id)=>{const item=equipmentById.get(id);return {canonical_id:id,display_name:item.display_name,required_level:item.required_level,equipment_type:item.equipment_type};}),clothes_slot_intentionally_empty:true,
    reason:'A source-backed equipment drop obtained during the visible training fight must enter inventory and be equipped through the browser UI.'},
  initial_evidence_scope_state:{first_task_status:finalState.tasks[firstEvidenceTaskId].status,completed_evidence_tasks:evidenceTaskIds.filter((id)=>finalState.tasks[id].status==='completed'),
    progressed_evidence_targets:evidenceTaskIds.flatMap((id)=>taskById.get(id).targets.map((target)=>({key:`${id}|${target.canonical_id}`,value:Number(finalState.progress[`${id}|${target.canonical_id}`]??0)}))).filter((entry)=>entry.value!==0),
    task_item_reservations:Object.keys(finalState.task_item_ledger.reservations),level:finalState.player.level,experience:finalState.player.experience,money:finalState.player.money,current_map_node_canonical_id:finalState.player.current_map_node_canonical_id},
};
fs.writeFileSync(auditPath,`${JSON.stringify(audit,null,2)}\n`);
process.stdout.write(`${JSON.stringify({fixture:path.relative(root,fixturePath),audit:path.relative(root,auditPath),historical_completed:completedHistoricalTasks.length,retained_conflicts:conflictTasks.map((task)=>task.canonical_id),first_task_status:finalState.tasks[firstEvidenceTaskId].status,level:finalState.player.level,experience:finalState.player.experience,money:finalState.player.money,loadout},null,2)}\n`);

function assertCheckpoint(checkpoint){
  if(checkpoint.tasks[terminalTaskId].status!=='completed')throw new Error(`${terminalTaskId} not completed`);
  for(const id of ['task.series.15.269','task.series.15.601'])if(checkpoint.tasks[id].status!=='blocked')throw new Error(`${id} conflict was not retained`);
  if(checkpoint.tasks[firstEvidenceTaskId].status!=='locked')throw new Error(`${firstEvidenceTaskId} must be locked until the visible level-up`);
  if(checkpoint.player.level!==targetLevel||checkpoint.player.experience!==targetExperience)throw new Error('Progression precondition mismatch');
  for(const taskId of evidenceTaskIds){if(checkpoint.tasks[taskId].status==='completed')throw new Error(`Evidence task pre-completed: ${taskId}`);for(const target of taskById.get(taskId).targets)if(Number(checkpoint.progress[`${taskId}|${target.canonical_id}`]??0)!==0)throw new Error(`Evidence target pre-progressed: ${target.canonical_id}`);}
  if(Object.keys(checkpoint.task_item_ledger.reservations).length)throw new Error('Checkpoint contains task-item reservations');
  if(checkpoint.equipment.clothes!==null)throw new Error('Land checkpoint clothes slot must be empty');
}
function setPlayerLevelWithStats(state,target){const player=state.player;const before=Number(player.level??1);if(target<before)throw new Error('Cannot lower checkpoint level');for(let next=before+1;next<=target;next+=1){const healthGain=10+Math.floor(next/5);player.max_health+=healthGain;player.current_health=Math.min(player.max_health,player.current_health+healthGain);player.base_attack+=2+Math.floor(next/10);player.base_max_attack+=2+Math.floor(next/10);player.base_defense+=1+Math.floor(next/15);player.base_agility+=1;player.morale+=5;}player.level=target;}
function selectLoadout(items,level,{leaveClothesEmpty=false}={}){
  const slotByType={1:'weapon',2:'headgear',3:'clothes',4:'belt',5:'shoes',6:'accessories',7:'offhand'};const bySlot=new Map();
  for(const item of items.filter((entry)=>Number(entry.required_level??1)<=level)){
    const slot=slotByType[Number(item.equipment_type)];if(!slot||(leaveClothesEmpty&&slot==='clothes'))continue;
    if(slot==='accessories'){const values=bySlot.get(slot)??[];values.push(item);bySlot.set(slot,values);continue;}
    const current=bySlot.get(slot);if(!current||score(item)>score(current))bySlot.set(slot,item);
  }
  const accessories=(bySlot.get('accessories')??[]).sort((a,b)=>score(b)-score(a)).slice(0,3).map((item)=>item.canonical_id);
  return {weapon:bySlot.get('weapon')?.canonical_id??null,offhand:bySlot.get('offhand')?.canonical_id??null,headgear:bySlot.get('headgear')?.canonical_id??null,clothes:null,belt:bySlot.get('belt')?.canonical_id??null,shoes:bySlot.get('shoes')?.canonical_id??null,accessories};
}
function score(entry){return Number(entry.attack??entry.attributes?.attack??0)+Number(entry.max_attack??entry.maxAttack??entry.attributes?.maxAttack??0)+Number(entry.defense??entry.attributes?.defense??0)*3+Number(entry.agility??entry.attributes?.agility??0)*2+Number(entry.health??entry.attributes?.health??0);}
function equippedIds(equipment){return [equipment.weapon,equipment.offhand,equipment.headgear,equipment.clothes,equipment.belt,equipment.shoes,...(equipment.accessories??[])].filter(Boolean);}
function completedCount(value){return Object.values(value.tasks??{}).filter((entry)=>entry.status==='completed').length;}
function range(start,end){return Array.from({length:end-start+1},(_,index)=>start+index);}
function read(relative){return JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));}
