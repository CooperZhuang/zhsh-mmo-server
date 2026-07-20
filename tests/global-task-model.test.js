'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {evaluateAllTasks}=require('../scripts/select-runnable-tasks');
const rules=require('../data/runtime/task-golden-rules.json');
const graph=require('../data/generated/global-task-standard-graph.json');
const fitting=require('../data/generated/global-task-fitting-results.json');
const exceptions=require('../data/generated/global-task-exception-clusters.json');
const directory=require('../data/generated/unified-task-directory.json');
const browserAcceptance=require('../data/generated/browser-acceptance-validation-matrix.json');

const evaluation=evaluateAllTasks();
const evaluationById=new Map(evaluation.tasks.map((entry)=>[entry.canonical_id,entry]));

function resolution(taskId,rule){
  return evaluationById.get(taskId).runtime_item_resolutions.find((entry)=>entry.resolution_rule===rule);
}

test('golden rules and the unified directory cover all 651 tasks without using the legacy prefix as an existence gate',()=>{
  assert.equal(rules.rule_set_id,'zhsh.task-golden-rules.v1');
  assert.equal(rules.rules.length,20);
  assert.equal(graph.task_count,651);
  assert.equal(new Set(graph.tasks.map((entry)=>entry.canonical_id)).size,651);
  assert.equal(fitting.remaining_task_count,534);
  assert.equal(directory.total_task_count,651);
  const validatedCount=78+browserAcceptance.promoted_task_count;
  assert.deepEqual(directory.status_counts,{
    data_conflict:2,
    runnable_pending_validation:651-2-validatedCount,
    validated:validatedCount,
  });
  assert.equal(Object.values(directory.status_counts).reduce((sum,value)=>sum+value,0),651);
  assert.equal(fitting.class_summary.filter((entry)=>entry.class_id<=4).reduce((sum,entry)=>sum+entry.count,0),523);
  assert.equal(exceptions.exception_task_count,11);
});

test('independent fitting evaluates every task and leaves only eleven intrinsic exception tasks',()=>{
  assert.equal(evaluation.task_count,651);
  assert.equal(evaluation.tasks.filter((entry)=>entry.direct_fit).length,640);
  assert.deepEqual(evaluation.tasks.filter((entry)=>!entry.direct_fit).map((entry)=>entry.canonical_id),[
    'task.series.15.264','task.series.15.269','task.series.15.415','task.series.15.457','task.series.15.463',
    'task.series.15.471','task.series.15.472','task.series.15.583','task.series.15.601','task.series.15.698','task.series.15.728',
  ]);
});

test('shared mapping algorithms resolve contextual NPCs, task-described drops and migrated collection targets',()=>{
  assert.equal(graph.tasks.filter((entry)=>entry.npcs.contextual_definitions.length>0).length,35);
  assert.ok(graph.tasks.find((entry)=>entry.canonical_id==='task.series.13.169').npcs.contextual_definitions
    .some((entry)=>entry.display_name==='垂钓老人'));

  for(const id of ['task.series.13.160','task.series.14.175','task.series.15.254']){
    assert.ok(resolution(id,'source_explicit_task_described_encounter_drop'),`${id} must use the task-described drop resolver`);
    assert.equal(evaluationById.get(id).direct_fit,true);
  }
  for(const id of ['task.series.15.631','task.series.15.652']){
    const mapped=resolution(id,'normalize_migrated_collection_target_to_item');
    assert.equal(mapped?.target_kind_override,'item');
    assert.equal(evaluationById.get(id).direct_fit,true);
  }
});

test('route waypoints are formal destinations rather than missing ports',()=>{
  for(const id of ['task.series.15.634','task.series.15.649','task.series.15.688','task.series.15.699']){
    const entry=evaluationById.get(id);
    assert.equal(entry.direct_fit,true);
    assert.ok(entry.evidence.route_waypoint_destinations.some((waypoint)=>waypoint.city_display_name==='蓬莱仙岛'));
    assert.ok(!entry.blocking_reasons.some((reason)=>reason.code==='voyage_port_or_coordinate_missing'));
  }
});
