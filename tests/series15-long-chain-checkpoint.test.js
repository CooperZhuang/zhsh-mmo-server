'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const {validateAndUpgradeEnvelope}=require('../src/task-runtime');

const content=JSON.parse(fs.readFileSync('web/generated/task1-content.json','utf8'));
const record=JSON.parse(fs.readFileSync('tests/fixtures/browser-save-v5-series15-454-level200.json','utf8'));
const audit=JSON.parse(fs.readFileSync('tests/fixtures/series15-454-checkpoint-audit.json','utf8'));
const state=validateAndUpgradeEnvelope(record).state;
const task=(id)=>content.tasks.find((entry)=>entry.canonical_id===id);
const evidenceTaskIds=Array.from({length:18},(_,index)=>`task.series.15.${455+index}`);

test('series15 representative-chain checkpoint is checksum-valid and stops exactly before 15.455',()=>{
  assert.equal(state.tasks['task.series.15.454'].status,'completed');
  assert.equal(state.tasks['task.series.15.455'].status,'available');
  assert.equal(state.tasks['task.series.15.269'].status,'blocked');
  assert.equal(audit.historical_precondition.retained_conflicts[0].task_canonical_id,'task.series.15.269');
  assert.equal(audit.historical_precondition.direct_task_state_mutations,187);
  assert.equal(audit.evidence_scope.included_task_canonical_ids.length,18);
});

test('no representative-chain task progress, reward, item or reservation is injected',()=>{
  const evidenceItemIds=new Set();
  for(const taskId of evidenceTaskIds){
    assert.notEqual(state.tasks[taskId].status,'completed',taskId);
    assert.equal(state.tasks[taskId].reward_status,'not_granted',taskId);
    assert.equal(state.flags[`task.completed.${taskId}`],undefined,taskId);
    for(const target of task(taskId).targets){
      assert.equal(Number(state.progress[`${taskId}|${target.canonical_id}`]??0),0,target.canonical_id);
      if(target.target_kind==='item')evidenceItemIds.add(target.entity_canonical_id);
    }
    for(const reward of task(taskId).rewards){
      assert.equal(state.reward_grants[reward.canonical_id],undefined,reward.canonical_id);
      if(reward.content_entity_canonical_id)evidenceItemIds.add(reward.content_entity_canonical_id);
    }
  }
  for(const itemId of evidenceItemIds)assert.equal(state.inventory[itemId],undefined,itemId);
  assert.deepEqual(state.task_item_ledger.reservations,{});
  assert.deepEqual(state.task_item_ledger.grants,{});
});

test('the disclosed checkpoint satisfies only finite chain preconditions',()=>{
  assert.equal(state.player.level,200);
  assert.ok(state.player.money>=600000);
  assert.equal(audit.level_checkpoint.source_declared_gate_task_canonical_id,'task.series.15.470');
  assert.equal(audit.level_checkpoint.source_declared_gate_level,200);
  assert.equal(audit.equipment_checkpoint.equipment_canonical_ids.length,8);
  assert.equal(audit.combat_consumable_budget.item_display_name,'体力宝');
  assert.equal(audit.combat_consumable_budget.quantity,3);
  assert.equal(audit.combat_consumable_budget.total_price,600000);
  assert.deepEqual([state.equipment.weapon,state.equipment.headgear,state.equipment.clothes,state.equipment.belt,state.equipment.shoes,...state.equipment.accessories],audit.equipment_checkpoint.equipment_canonical_ids);
  assert.equal(audit.initial_evidence_scope_state.completed_evidence_tasks.length,0);
  assert.equal(audit.initial_evidence_scope_state.progressed_evidence_targets.length,0);
});
