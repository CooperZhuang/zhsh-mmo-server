'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const analysis=require('../data/generated/global-blocker-analysis.json');
const selection=require('../data/generated/runnable-task-selection.json');
const simulations=require('../data/generated/global-module-simulation-results.json');

test('global blocker analysis reproduces the accepted baseline and current 651-task partition',()=>{
  assert.equal(analysis.accepted_baseline.selected_task_count,148);
  assert.equal(analysis.current_result.selected_task_count,selection.selected_task_count);
  assert.equal(analysis.current_result.remaining_task_count,selection.unselected_tasks.length);
  assert.equal(analysis.current_result.selected_task_count+analysis.current_result.remaining_task_count,651);
  assert.equal(analysis.current_root_blocker_clusters.length,6);
});

test('isolated module deltas and combination synergy are explicit rather than inferred',()=>{
  const modules=new Map(analysis.module_candidates.map((entry)=>[entry.module,entry]));
  assert.equal(modules.get('training_session_continuation').actual_simulated_unlock_delta,0);
  assert.equal(modules.get('task_described_item_sources').actual_simulated_unlock_delta,-5);
  assert.equal(modules.get('projected_task_entry_combat_state').actual_simulated_unlock_delta,0);
  assert.equal(analysis.current_result.combined_simulated_unlock_delta,-5);
});

test('module deltas come from five persisted selector simulations',()=>{
  assert.equal(simulations.cases.baseline_all_modules_disabled.selected_task_count,148);
  assert.equal(simulations.cases.training_session_continuation.selected_task_count,148);
  assert.equal(simulations.cases.task_described_item_sources.selected_task_count,143);
  assert.equal(simulations.cases.projected_task_entry_combat_state.selected_task_count,148);
  assert.equal(simulations.cases.combined.selected_task_count,143);
  assert.equal(analysis.simulation_evidence.artifact,'data/generated/global-module-simulation-results.json');
});
