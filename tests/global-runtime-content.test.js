'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');

const selection=read('data/generated/global-runtime-task-selection.json');
const directory=read('data/generated/unified-task-directory.json');
const content=read('web/generated/task1-content.json');
const browserAcceptance=read('data/generated/browser-acceptance-validation-matrix.json');

function task(id){return content.tasks.find((entry)=>entry.canonical_id===id);}
function selectedTask(id){return selection.selected_tasks.find((entry)=>entry.canonical_id===id);}

test('global runtime exports all 651 tasks while preserving truthful directory statuses',()=>{
  assert.equal(selection.selected_task_count,651);assert.equal(content.tasks.length,651);assert.equal(selection.runtime_runnable_task_count,649);
  const validatedCount=78+browserAcceptance.promoted_task_count;
  assert.deepEqual(selection.status_counts,{data_conflict:2,runnable_pending_validation:651-2-validatedCount,validated:validatedCount});
  assert.deepEqual(directory.status_counts,selection.status_counts);
  assert.equal(content.tasks.filter((entry)=>entry.blocking_reasons.length===0).length,649);
  assert.equal(content.tasks.filter((entry)=>entry.directory_status==='validated').length,validatedCount);
  assert.equal(content.tasks.filter((entry)=>entry.directory_status==='data_conflict').length,2);
  assert.equal(content.tasks.filter((entry)=>entry.directory_status==='evidence_missing').length,0);
});

test('task-chain item rewards and downstream targets share the same runtime inventory identity',()=>{
  const scaleTarget=task('task.series.15.471').targets[0];
  const scaleReward=task('task.series.15.470').rewards.find((entry)=>entry.reward_name==='龙鳞');
  const pearlReward=task('task.series.15.471').rewards.find((entry)=>entry.reward_name==='黑珍珠');
  const pearlTarget=task('task.series.15.472').targets[0];
  assert.equal(scaleTarget.entity_canonical_id,scaleReward.content_entity_canonical_id);
  assert.equal(pearlTarget.entity_canonical_id,pearlReward.content_entity_canonical_id);
  assert.equal(scaleTarget.task_item_policy.acquisition_mode,'prerequisite_reward');
  assert.equal(pearlTarget.task_item_policy.source_task_canonical_id,'task.series.15.471');
  assert.equal(scaleReward.resolution_status,'resolved');assert.equal(pearlReward.resolution_status,'resolved');
});

test('explicit receive-dialogue handoffs create acceptance grants without duplicating adjacent chain rewards',()=>{
  const powder=task('task.series.15.459').targets[0];
  assert.equal(powder.task_item_policy.acquisition_mode,'grant_on_accept');
  assert.equal(powder.runtime_resolution.source_kind,'task_acceptance_grant');
  assert.equal(powder.runtime_resolution.rule,'explicit_receive_dialogue_item_handoff');
  assert.match(selectedTask('task.series.15.459').runtime_item_resolutions[0].formal_source.evidence_locator,/魔法药粉制作完成了/);

  const pearl=task('task.series.15.457').targets[0];
  assert.equal(pearl.task_item_policy.acquisition_mode,'prerequisite_reward');
  assert.equal(pearl.runtime_resolution.source_kind,'task_chain_reward');
  assert.notEqual(pearl.runtime_resolution.rule,'explicit_receive_dialogue_item_handoff');

  const genericHandoffs=content.tasks.flatMap((entry)=>entry.targets.filter((target)=>
    target.runtime_resolution?.rule==='explicit_receive_dialogue_item_handoff').map((target)=>({task:entry,target})));
  assert.equal(genericHandoffs.length,15);
  for(const {task:entry,target} of genericHandoffs){
    assert.equal(entry.task_type,'送物品',entry.canonical_id);
    assert.equal(target.task_item_policy.acquisition_mode,'grant_on_accept',entry.canonical_id);
    assert.equal(target.task_item_policy.abandonment,'rollback_acceptance_grant',entry.canonical_id);
    assert.equal(target.task_item_policy.consumption,'submit_only',entry.canonical_id);
  }
});

test('吕洞宾 is exported as an NPC duel target without fabricating a monster or normal drop settlement',()=>{
  const duelTask=task('task.series.15.698');const target=duelTask.targets[0];
  assert.equal(target.target_kind,'npc_duel');assert.equal(target.original_target_kind,'monster');
  assert.equal(target.npc_duel.settlement,'task_progress_only');assert.equal(target.npc_duel.drop_policy,'none');
  assert.ok(content.npcs.some((entry)=>entry.canonical_id===target.entity_canonical_id&&entry.display_name==='吕洞宾'));
  assert.ok(content.npc_placements.some((entry)=>entry.npc_canonical_id===target.entity_canonical_id&&entry.location_canonical_id===duelTask.target_location_canonical_id));
  assert.equal(content.monsters.some((entry)=>entry.canonical_id===target.entity_canonical_id),false);
});


test('evidence audit resolves six source-backed exceptions and retains only the two irreducible conflicts',()=>{
  const resolved=['task.series.15.264','task.series.15.415','task.series.15.457','task.series.15.463','task.series.15.583','task.series.15.728'];
  for(const id of resolved){
    const expectedStatus=browserAcceptance.promoted_task_canonical_ids.includes(id)?'validated':'runnable_pending_validation';
    assert.equal(task(id).directory_status,expectedStatus,id);assert.equal(task(id).blocking_reasons.length,0,id);
  }
  assert.equal(task('task.series.15.269').directory_status,'data_conflict');
  assert.equal(task('task.series.15.601').directory_status,'data_conflict');
  const hammer=task('task.series.15.264');
  assert.equal(hammer.target_location_canonical_id,'entity.location.cfbacab4f4db489a');
  assert.equal(hammer.targets[0].runtime_resolution.source_kind,'monster_drop');
  const zombie=task('task.series.15.415');
  assert.equal(zombie.targets[0].entity_canonical_id,'derived.monster_definition.b6c33ddc0a318a25');
  assert.ok(content.monster_placements.some((entry)=>entry.monster_canonical_id===zombie.targets[0].entity_canonical_id&&entry.location_canonical_id===zombie.target_location_canonical_id&&entry.location_resolution_status==='task_scoped_evidence_overlay'));
  const pearl=task('task.series.15.457');
  assert.equal(pearl.targets[0].task_item_policy.source_task_canonical_id,'task.series.15.456');
  assert.equal(task('task.series.15.456').rewards.find((entry)=>entry.reward_name==='黑珍珠').content_entity_canonical_id,pearl.targets[0].entity_canonical_id);
  const net=task('task.series.15.463');
  assert.equal(net.targets[0].task_item_policy.acquisition_mode,'grant_on_accept');
  const deepPearl=task('task.series.15.728');
  assert.equal(deepPearl.targets[0].required_quantity,5);
  assert.ok(content.monster_placements.some((entry)=>entry.monster_canonical_id==='derived.monster_definition.ea809ac6a2d77833'&&entry.location_canonical_id===deepPearl.target_location_canonical_id&&entry.location_resolution_status==='task_scoped_evidence_overlay'));
});

test('every operational task has resolved runtime target identities and all task relations stay inside the package',()=>{
  const ids=new Set(content.tasks.map((entry)=>entry.canonical_id));
  for(const entry of content.tasks.filter((candidate)=>candidate.blocking_reasons.length===0)){
    for(const relation of [...entry.prerequisites,...entry.successors])assert.ok(ids.has(relation),`${entry.canonical_id} relation ${relation}`);
    for(const target of entry.targets)assert.ok(target.entity_canonical_id,`${target.canonical_id} runtime entity`);
  }
});

function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
