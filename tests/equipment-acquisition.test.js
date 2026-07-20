'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {planEquipmentAcquisition,selectActualLoadout}=require('../src/task-runtime');

function equipment(id,type,attributes={},sources=[]){return {canonical_id:id,display_name:id,required_level:1,equipment_type:type,attributes,acquisition_sources:sources};}
function monster(id,level=1,type=5){return {canonical_id:id,display_name:id,level,monster_type:type};}

test('actual loadout never duplicates equipment and limits accessories to three obtained items',()=>{
  const values=[equipment('ring.1',6,{attack:1}),equipment('ring.2',6,{attack:2}),equipment('ring.3',6,{attack:3}),equipment('ring.4',6,{attack:4})];
  assert.deepEqual(selectActualLoadout(values,10).map((entry)=>entry.canonical_id),['ring.2','ring.3','ring.4']);
});

test('planner closes a target already survivable from the accepted terminal without inventing equipment',()=>{
  const plan=planEquipmentAcquisition({current_state:{level:45},target_monster:monster('source.material',22,5),equipment_candidates:[]});
  assert.equal(plan.closed,true);assert.deepEqual(plan.actual_loadout,[]);assert.deepEqual(plan.acquired_equipment,[]);
});

test('planner detects equipment that is required to defeat its own source monster',()=>{
  const source=monster('monster.circular',10,6);
  const item=equipment('equipment.circular',1,{attack:5000,maxAttack:5000,health:5000},[{canonical_id:'drop.circular',source_kind:'monster_drop',
    location_canonical_id:'location.circular',monster:source,effective_probability:0.2,evidence_status:'SOURCE_EXPLICIT'}]);
  const plan=planEquipmentAcquisition({current_state:{level:1},target_monster:source,equipment_candidates:[item],reachable_location_canonical_ids:['location.circular']});
  assert.equal(plan.closed,false);assert.ok(plan.cycle_dependencies.some((cycle)=>cycle[0]==='equipment.circular'&&cycle.at(-1)==='equipment.circular'));
  assert.ok(plan.rejected_sources.some((entry)=>entry.reason==='source_monster_not_survivable_before_acquisition'));
});

test('planner rejects future task rewards and does not convert them into owned equipment',()=>{
  const target=monster('monster.future',10,6);const item=equipment('equipment.future',1,{attack:9999,maxAttack:9999},[
    {canonical_id:'reward.future',source_kind:'task_reward',task_canonical_id:'task.future'}]);
  const plan=planEquipmentAcquisition({current_state:{level:10,completed_task_canonical_ids:[]},target_monster:target,equipment_candidates:[item]});
  assert.equal(plan.closed,false);assert.deepEqual(plan.actual_loadout,[]);
  assert.ok(plan.rejected_sources.some((entry)=>entry.reason==='future_task_reward_not_allowed'));
});

test('selector preserves accepted history without re-proving it and records real current combat roots',()=>{
  const selection=require('../data/generated/runnable-task-selection.json');
  const analysis=require('../data/generated/equipment-acquisition-analysis.json');
  const detail=(summary)=>analysis.plans.find((entry)=>entry.canonical_id===summary.canonical_id).plan;
  const closed=selection.selected_tasks.find((entry)=>entry.canonical_id==='task.series.02.012');assert.ok(closed);
  assert.equal(closed.evidence.equipment_acquisition_proofs,undefined);
  for(const id of ['task.series.05.036','task.series.10.057']){
    const blocked=selection.unselected_tasks.find((entry)=>entry.canonical_id===id);assert.ok(blocked,id);
    const plan=detail(blocked.blocking_reasons[0].requirements[0].combat_proof.acquisition_plan);
    assert.equal(plan.acquisition_closed,true,id);assert.equal(plan.target_combat_closed,false,id);
    assert.equal(plan.target_combat_proof.win_probability,0,id);
  }
  const staminaClosed=selection.selected_tasks.find((entry)=>entry.canonical_id==='task.series.11.065');assert.ok(staminaClosed);
  assert.equal(staminaClosed.selection_reason,'maximal_continuous_series_prefix');
  assert.equal(staminaClosed.evidence.equipment_acquisition_proofs,undefined);
  const nextBlocked=selection.unselected_tasks.find((entry)=>entry.canonical_id==='task.series.11.071');assert.ok(nextBlocked);
  assert.equal(nextBlocked.blocking_reasons[0].code,'combat_consumable_budget_exhausted');
});
