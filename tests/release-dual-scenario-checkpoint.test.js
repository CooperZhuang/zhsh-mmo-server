'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const {validateAndUpgradeEnvelope}=require('../src/task-runtime');

const content=JSON.parse(fs.readFileSync('web/generated/task1-content.json','utf8'));
const record=JSON.parse(fs.readFileSync('tests/fixtures/browser-save-v5-series15-697-level106.json','utf8'));
const audit=JSON.parse(fs.readFileSync('tests/fixtures/series15-697-land-checkpoint-audit.json','utf8'));
const state=validateAndUpgradeEnvelope(record).state;
const evidenceTaskIds=Array.from({length:9},(_,index)=>`task.series.15.${698+index}`);
const taskById=new Map(content.tasks.map((entry)=>[entry.canonical_id,entry]));

test('land release-scenario checkpoint is valid and stops at the disclosed level gate',()=>{
  assert.equal(state.tasks['task.series.15.697'].status,'completed');
  assert.equal(state.tasks['task.series.15.698'].status,'locked');
  assert.equal(state.player.level,106);
  assert.equal(audit.progression_precondition.next_level,107);
  assert.equal(audit.progression_precondition.next_level_threshold-state.player.experience,1000);
  assert.equal(state.tasks['task.series.15.269'].status,'blocked');
  assert.equal(state.tasks['task.series.15.601'].status,'blocked');
  assert.deepEqual(audit.historical_precondition.retained_conflicts,['task.series.15.269','task.series.15.601']);
  assert.equal(audit.historical_precondition.terminal_task_canonical_id,'task.series.15.697');
});

test('land release-scenario evidence tasks contain no injected completion, target progress or reward settlement',()=>{
  const evidenceItems=new Set();
  for(const taskId of evidenceTaskIds){
    const task=taskById.get(taskId);assert.ok(task,taskId);
    assert.notEqual(state.tasks[taskId].status,'completed',taskId);
    assert.equal(state.tasks[taskId].reward_status,'not_granted',taskId);
    assert.equal(state.flags[`task.completed.${taskId}`],undefined,taskId);
    for(const target of task.targets){
      assert.equal(Number(state.progress[`${taskId}|${target.canonical_id}`]??0),0,target.canonical_id);
      if(target.target_kind==='item')evidenceItems.add(target.entity_canonical_id);
    }
    for(const reward of task.rewards){
      assert.equal(state.reward_grants[reward.canonical_id],undefined,reward.canonical_id);
      if(reward.content_entity_canonical_id)evidenceItems.add(reward.content_entity_canonical_id);
    }
  }
  for(const itemId of evidenceItems)assert.equal(state.inventory[itemId],undefined,itemId);
  assert.deepEqual(state.task_item_ledger.reservations,{});
});

test('land release-scenario economy and equipment preconditions leave visible browser work to prove',()=>{
  const staminaItem=content.shop_entries.find((entry)=>entry.display_name==='体力宝'&&Number(entry.price)===200000)?.content_entity_canonical_id;
  assert.ok(staminaItem);
  assert.equal(state.inventory[staminaItem],undefined,'combat consumables must be bought in the browser scenario');
  assert.equal(state.player.money,audit.economy_precondition.starting_money);
  assert.equal(state.equipment.clothes,null,'training drop must have an empty source slot to demonstrate visible equip');
  assert.equal(audit.equipment_precondition.clothes_slot_intentionally_empty,true);
  assert.deepEqual(state.equipment,audit.equipment_precondition.loadout);
  assert.deepEqual(audit.evidence_scope.included_task_canonical_ids,evidenceTaskIds);
  assert.equal(audit.initial_evidence_scope_state.completed_evidence_tasks.length,0);
  assert.equal(audit.initial_evidence_scope_state.progressed_evidence_targets.length,0);
});
