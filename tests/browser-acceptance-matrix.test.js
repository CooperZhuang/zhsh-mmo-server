'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.resolve(__dirname,'..');
const read=(relative)=>JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));

test('public release matrix promotes public-executor semantic siblings and keeps bounded exceptions',()=>{
  const matrix=read('data/generated/browser-acceptance-validation-matrix.json');
  assert.equal(matrix.promoted_task_count,570);
  assert.equal(matrix.newly_promoted_task_count,544);
  assert.equal(matrix.retained_prior_browser_promotion_count,26);
  assert.deepEqual(matrix.excluded_task_canonical_ids,['task.series.15.706']);
  assert.equal(matrix.promoted_task_canonical_ids.includes('task.series.15.706'),false);
  assert.deepEqual(matrix.retained_data_conflict_task_canonical_ids,['task.series.15.269','task.series.15.601']);
  assert.deepEqual(matrix.resulting_status_counts,{validated:648,runnable_pending_validation:1,data_conflict:2});
  assert.equal(matrix.groups.every((group)=>group.public_executors.includes('TaskRuntimeEngine')&&group.coverage_conditions.length>=7),true);
});

test('unified directory reflects the browser acceptance batch without changing conflicts',()=>{
  const matrix=read('data/generated/browser-acceptance-validation-matrix.json');
  const directory=read('data/generated/unified-task-directory.json');
  const byId=new Map(directory.tasks.map((task)=>[task.canonical_id,task]));
  for(const id of matrix.promoted_task_canonical_ids)assert.equal(byId.get(id)?.status,'validated',id);
  // 裁决推进后：15.269/15.601 已由 data_conflict 升为 runnable_pending_validation，仅 15.706 待验证
  assert.equal(byId.get('task.series.15.706')?.status,'runnable_pending_validation');
  assert.equal(directory.status_counts.data_conflict??0,0,'adjudication closed all data conflicts');
  assert.equal(directory.status_counts.validated,648);
  assert.equal(directory.status_counts.runnable_pending_validation,3);
});
