'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { test }=require('node:test');
const { selectionHashPayload }=require('../scripts/select-runnable-tasks');

const selection=require('../data/generated/runnable-task-selection.json');
const globalSelection=require('../data/generated/global-runtime-task-selection.json');
const content=require('../web/generated/task1-content.json');
const acceptedStage=require('../data/runtime/accepted-stage-start-78.json');
const matrix=require('../data/generated/task-playability-matrix.json');

test('runnable selector output carries a stable semantic hash and complete counts',()=>{
  assert.match(selection.selection_hash,/^[0-9a-f]{64}$/);
  assert.equal(selection.selected_task_count,selection.selected_tasks.length);
  assert.equal(selection.unselected_tasks.length,651-selection.selected_task_count);
  assert.equal(content.runnable_task_selection.selection_hash,globalSelection.selection_hash);
  assert.equal(globalSelection.selected_task_count,651);
});


test('accepted 78-task history is retained without re-running downstream combat proofs',()=>{
  assert.equal(selection.formal_stage_start.selected_task_count,78);
  assert.equal(content.runnable_task_selection.formal_stage_start_selected_task_count,78);
  assert.equal(acceptedStage.completed_task_canonical_ids.length,78);
  const selectedById=new Map(selection.selected_tasks.map((entry)=>[entry.canonical_id,entry]));
  for(const id of acceptedStage.completed_task_canonical_ids){
    const task=selectedById.get(id);assert.ok(task,`accepted task missing: ${id}`);
    assert.equal(task.evidence.equipment_acquisition_proofs,undefined,`accepted task re-proved: ${id}`);
  }
});

test('development matrix covers all 651 tasks without claiming full DOM acceptance',()=>{
  assert.equal(matrix.validation_mode,'development');
  assert.equal(matrix.total_tasks,651);
  assert.equal(matrix.formal_core_playable_count,0);
  assert.equal(matrix.status_counts.selected_pending_validation,117);
  assert.equal(matrix.status_counts.not_selected_blocked,534);
});

test('selection hash payload excludes volatile generation metadata',()=>{
  const semantic={selected_task_count:71,selected_tasks:['task.series.12.091']};
  assert.deepEqual(selectionHashPayload({...semantic,source_head:'a',generated_at:'2026-07-18T00:00:00.000Z',reference_commits:{zhsh:'1'}}),semantic);
  assert.deepEqual(selectionHashPayload({...semantic,source_head:'b',generated_at:'2026-07-19T00:00:00.000Z',reference_commits:{zhsh:'2'}}),semantic);
});

test('selection has no unresolved dependency or undecided restoration conflict',()=>{
  assert.ok(selection.selected_task_count>=50);
  assert.ok(selection.selected_task_count>51,'third batch must preserve all 51 accepted tasks and admit evidence-closed additions');
  for(const task of selection.selected_tasks)assert.equal(task.evidence.formal_runtime_path!==null,true,task.canonical_id);
  const selectedIds=new Set(selection.selected_tasks.map((task)=>task.canonical_id));
  for(const task of selection.unselected_tasks.filter((entry)=>selectedIds.has(entry.canonical_id)))assert.fail(`selected task also blocked: ${task.canonical_id}`);
  assert.ok(selection.unselected_tasks.every((task)=>task.blocking_reasons.every((reason)=>reason.code!=='unresolved_dependency')),'adjudication must close every unresolved dependency');
});

test('selector closes level gates with source-derived duration, cache and recovery bounds',()=>{
  assert.ok(selection.level_gate_requirements.length>0);
  assert.ok(selection.selected_tasks.every((task)=>task.evidence.level_closure?.closure_status==='closed'));
  for(const segment of selection.level_reachability) {
    assert.ok(segment.representative_monster?.location_canonical_id);
    assert.ok(segment.estimated_fight_count>0);
    assert.ok(segment.level_segments.length>0);
    assert.ok(segment.reasonable_worst_attempts>=segment.estimated_fight_count);
    assert.ok(segment.level_segments.every((entry)=>entry.reasonable&&entry.training_session_count>=1&&entry.maximum_session_minutes<=entry.source_session_limit_minutes));
    assert.ok(segment.level_segments.every((entry)=>entry.reasonable_worst_minutes<=entry.source_session_limit_minutes||entry.session_continuation_required&&entry.session_continuation_allowed));
    assert.ok(segment.level_segments.every((entry)=>entry.recovery.money_closed&&entry.requirements.unobtained_equipment===false));
    assert.equal(segment.balance_anomaly,false);
  }
  const levelBlocks=selection.unselected_tasks.filter((task)=>task.blocking_reasons.some((reason)=>reason.code==='level_balance_anomaly'));
  assert.ok(levelBlocks.every((task)=>task.blocking_reasons.find((reason)=>reason.code==='level_balance_anomaly').details.balance_anomaly));
  const selectorSource=fs.readFileSync(path.resolve('scripts','select-runnable-tasks.js'),'utf8');
  assert.doesNotMatch(selectorSource,/balance_anomaly_fight_limit|estimated\s*<=\s*30/);
});

test('all selected locations, NPCs, monsters, items, shops and voyage pairs are exported',()=>{
  const resources=selection.resources;
  const exportedTaskIds=new Set(content.tasks.map((task)=>task.canonical_id));
  for(const id of resources.task_canonical_ids)assert.ok(exportedTaskIds.has(id),id);
  for(const id of resources.location_canonical_ids)assert.ok(content.locations.some((entry)=>entry.canonical_id===id),id);
  for(const id of resources.npc_canonical_ids)assert.ok(content.npcs.some((entry)=>entry.canonical_id===id),id);
  for(const id of resources.monster_canonical_ids)assert.ok(content.monsters.some((entry)=>entry.canonical_id===id),id);
  for(const pair of resources.route_pairs)assert.ok(content.voyage_routes.some((route)=>route.from_city_canonical_id===pair.from_city_canonical_id&&route.to_city_canonical_id===pair.to_city_canonical_id),JSON.stringify(pair));
  assert.ok(content.shop_entries.every((entry)=>entry.location_canonical_id&&entry.map_node_canonical_id));
  for(const task of selection.selected_tasks)for(const placement of task.evidence.contextual_npc_placements??[])
    assert.ok(content.npc_placements.some((entry)=>entry.npc_canonical_id===placement.npc_canonical_id&&entry.location_canonical_id===placement.location_canonical_id));
});

test('source market prices and monster items close task goods without direct inventory injection',()=>{
  const resolutions=selection.selected_tasks.flatMap((entry)=>entry.runtime_item_resolutions);
  assert.ok(resolutions.some((entry)=>entry.formal_source.source_kind==='monster_drop'&&entry.formal_source.location_canonical_id));
  const blockedCandidateResolutions=selection.unselected_tasks.flatMap((entry)=>entry.runtime_item_resolutions??[]);
  assert.ok(blockedCandidateResolutions.some((entry)=>entry.formal_source.source_kind==='market'));
  for(const resolution of resolutions.filter((entry)=>entry.formal_source.source_kind==='market'))
    assert.ok(content.shop_entries.some((entry)=>entry.task_target_canonical_id===resolution.target_canonical_id&&entry.inventory_weight_exempt));
});

test('selected series are complete or exact prefixes with no skipped prerequisite',()=>{
  const selectedIds=new Set(selection.selected_tasks.map((entry)=>entry.canonical_id));
  for(const series of selection.selected_series) {
    const tasks=content.tasks.filter((task)=>task.series_canonical_id===series.canonical_id&&selectedIds.has(task.canonical_id));
    assert.equal(tasks.length,series.selected_task_count);
    for(const task of tasks)for(const prerequisite of task.source_prerequisites)assert.ok(selectedIds.has(prerequisite),`${task.canonical_id} skips ${prerequisite}`);
  }
});

test('browser production content matches the global runtime selection while retaining every legacy audit task',()=>{
  assert.equal(content.tasks.length,globalSelection.selected_task_count);
  assert.equal(content.series.length,globalSelection.selected_series_count);
  assert.equal(content.runnable_task_selection.selection_hash,globalSelection.selection_hash);
  const exportedIds=new Set(content.tasks.map((task)=>task.canonical_id));
  assert.ok(selection.selected_tasks.every((task)=>exportedIds.has(task.canonical_id)));
});

test('selector algorithm contains no task id, series id, or selected count allowlist',()=>{
  const source=fs.readFileSync(path.resolve('scripts','select-runnable-tasks.js'),'utf8');
  assert.doesNotMatch(source,/task\.series\.\d{2}(?:\.\w+)?/);
  assert.doesNotMatch(source,/selected_task_count\s*[<>=!]+\s*\d+/);
  assert.match(source,/maximal playable prefix from series start/);
});

test('formal validation harness forbids preview providers and direct progress injection',()=>{
  const source=fs.readFileSync(path.resolve('tests','formal-core-e2e.test.js'),'utf8');
  assert.doesNotMatch(source,/PreviewEncounterProvider|PreviewTravelProvider/);
  assert.doesNotMatch(source,/type:\s*['"](?:arrive_at_location|defeat_monster|obtain_item)['"]/);
  assert.doesNotMatch(source,/\.train\s*\(/);
  for(const runtime of ['CombatRuntime','EconomyRuntime','ShipRuntime','VoyageRuntime','RecoveryRuntime'])assert.match(source,new RegExp(runtime));
});
