'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {BrowserTaskCatalog,MemoryRuntimeStorage,TaskRuntimeEngine}=require('../src/task-runtime');

const location='entity.location.test';
const node='derived.map_node.location.test';
const npc='derived.npc_definition.test';
const series='task.series.test';
function taskDefinition(id,{prerequisites=[],successors=[],directoryStatus='runnable_pending_validation'}={}){return {
  canonical_id:id,series_canonical_id:series,sequence_position:Number(id.split('.').at(-1)),display_name:id,task_type:'对话',description:id,
  level_requirement:null,prerequisites,successors,directory_status:directoryStatus,blocking_reasons:directoryStatus==='data_conflict'?[{code:'test_conflict'}]:[],
  issuer_npc_canonical_id:npc,completion_npc_canonical_id:npc,receive_location_canonical_id:location,submit_location_canonical_id:location,target_location_canonical_id:location,
  targets:[{canonical_id:`${id}.target.01`,target_kind:'npc',entity_canonical_id:npc,required_quantity:1}],rewards:[],dialogues:[],
};}
const first='task.series.test.001',conflict='task.series.test.002',later='task.series.test.003';
const content={package_id:'zhsh.browser-content',series:[{canonical_id:series}],tasks:[
  taskDefinition(first,{successors:[conflict]}),
  taskDefinition(conflict,{prerequisites:[first],successors:[later],directoryStatus:'data_conflict'}),
  taskDefinition(later,{prerequisites:[conflict]}),
],npcs:[{canonical_id:npc,display_name:'测试 NPC'}],map_nodes:[{map_node_canonical_id:node,location_canonical_id:location,city_canonical_id:'entity.city.test'}],location_connections:[],
  npc_placements:[{npc_canonical_id:npc,location_canonical_id:location,runtime_capability:'queryable',placement_scope:'global'}],content_entities:[],gameplay_rules:{}};

test('data-conflict task stays blocked while its runnable successor uses the nearest effective prerequisite',()=>{
  const catalog=new BrowserTaskCatalog(content),storage=new MemoryRuntimeStorage();
  const engine=new TaskRuntimeEngine({catalog,storage,seriesCanonicalIds:[series],clock:()=> '2026-07-20T00:00:00.000Z'});const player='player.conflict-bypass';
  engine.createPlayer(player);let state=engine.loadPlayer(player);
  assert.equal(state.tasks[first].status,'available');assert.equal(state.tasks[conflict].status,'blocked');assert.equal(state.tasks[later].status,'locked');
  engine.processEvent(player,{event_id:'accept-first',type:'talk_to_npc',npc_canonical_id:npc,location_canonical_id:location});
  engine.processEvent(player,{event_id:'target-first',type:'talk_to_npc',npc_canonical_id:npc,location_canonical_id:location});
  engine.processEvent(player,{event_id:'submit-first',type:'submit_to_npc',npc_canonical_id:npc,location_canonical_id:location});
  state=engine.loadPlayer(player);
  assert.equal(state.tasks[first].status,'completed');assert.equal(state.tasks[conflict].status,'blocked');assert.equal(state.tasks[later].status,'available');
  assert.deepEqual(engine.effectivePrerequisiteIds(catalog.getTask(later)),[first]);
});


test('global conflict nodes preserve their source relations while successors bypass only the blocked node at runtime',()=>{
  const globalContent=require('../web/generated/task1-content.json');
  const catalog=new BrowserTaskCatalog(globalContent),storage=new MemoryRuntimeStorage();
  const engine=new TaskRuntimeEngine({catalog,storage,seriesCanonicalIds:['task.series.15']});
  const bearConflict=catalog.getTask('task.series.15.269');
  const bearSuccessor=catalog.getTask('task.series.15.270');
  const flowerConflict=catalog.getTask('task.series.15.601');
  const flowerSuccessor=catalog.getTask('task.series.15.602');
  assert.equal(bearConflict.directory_status,'data_conflict');
  assert.equal(flowerConflict.directory_status,'data_conflict');
  assert.deepEqual(bearSuccessor.prerequisites,['task.series.15.269']);
  assert.deepEqual(flowerSuccessor.prerequisites,['task.series.15.601']);
  assert.deepEqual(engine.effectivePrerequisiteIds(bearSuccessor),['task.series.15.268']);
  assert.deepEqual(engine.effectivePrerequisiteIds(flowerSuccessor),['task.series.15.600']);
});
