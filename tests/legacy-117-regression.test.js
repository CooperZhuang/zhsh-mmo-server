'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {after,test}=require('node:test');
const {exportTask1Content}=require('../scripts/export-task1-content');

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-legacy-117-regression-'));
const legacy=exportTask1Content({
  outputPath:path.join(temporary,'task1-content.json'),
  selectionPath:path.resolve('data','generated','runnable-task-selection.json'),
});
const production=require('../web/generated/task1-content.json');
const productionById=new Map(production.tasks.map((entry)=>[entry.canonical_id,entry]));

test('the fixed 143-task audit set retains identical runtime task semantics inside the 651-task production package',()=>{
  assert.equal(legacy.tasks.length,143);
  for(const legacyTask of legacy.tasks){
    const productionTask=productionById.get(legacyTask.canonical_id);
    assert.ok(productionTask,legacyTask.canonical_id);
    assert.deepEqual(project(productionTask),project(legacyTask),legacyTask.canonical_id);
  }
});

after(()=>fs.rmSync(temporary,{recursive:true,force:true}));

function project(task){
  return {
    canonical_id:task.canonical_id,
    series_canonical_id:task.series_canonical_id,
    level_requirement:task.level_requirement,
    receive_location_canonical_id:task.receive_location_canonical_id,
    submit_location_canonical_id:task.submit_location_canonical_id,
    target_location_canonical_id:task.target_location_canonical_id,
    issuer_npc_canonical_id:task.issuer_npc_canonical_id,
    completion_npc_canonical_id:task.completion_npc_canonical_id,
    source_prerequisites:task.source_prerequisites,
    source_successors:task.source_successors,
    targets:task.targets.map((entry)=>({
      canonical_id:entry.canonical_id,target_kind:entry.target_kind,entity_canonical_id:entry.entity_canonical_id,
      required_quantity:entry.required_quantity,
    })),
    rewards:task.rewards.map((entry)=>({
      canonical_id:entry.canonical_id,reward_type:entry.reward_type,reward_name:entry.reward_name,
      quantity:entry.quantity,content_entity_canonical_id:entry.content_entity_canonical_id,
    })),
  };
}
