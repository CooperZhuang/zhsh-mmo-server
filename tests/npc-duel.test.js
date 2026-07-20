'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {MemoryRuntimeStorage}=require('../src/task-runtime/memory-runtime-storage');
const {createGameplayState}=require('../src/task-runtime/gameplay-state');
const {NpcDuelRuntime,npcDuelStats}=require('../src/task-runtime/npc-duel');

function fixture(){
  const task={canonical_id:'task.series.99.001',series_canonical_id:'task.series.99',level_requirement:1,target_location_canonical_id:'location.arena',
    targets:[{canonical_id:'task.series.99.001.target.01',target_kind:'npc_duel',entity_canonical_id:'npc.trainer',required_quantity:1,npc_duel:{level:1}}]};
  const taskCatalog={content:{npcs:[{canonical_id:'npc.trainer',display_name:'训练师',level:1}]},getTask:(id)=>id===task.canonical_id?task:null,
    getMapNode:()=>({map_node_canonical_id:'node.arena',location_canonical_id:'location.arena'}),listNpcsAtNode:()=>[{npc_canonical_id:'npc.trainer'}]};
  const gameplayCatalog={getEquipment:()=>{throw new Error('none');}};
  const state={...createGameplayState({canonical_id:'player.duel',current_map_node_canonical_id:'node.arena',current_health:100,max_health:100,
      base_attack:50,base_max_attack:80,base_defense:4,base_agility:3,morale:50,money:0,experience:0,updated_at:''}),
    unlocked_map_nodes:['node.arena'],inventory:{},tasks:{[task.canonical_id]:{status:'accepted'}},
    progress:{[`${task.canonical_id}|${task.targets[0].canonical_id}`]:0},reward_grants:{},flags:{},processed_events:{},active_series_canonical_id:'task.series.99'};
  const storage=new MemoryRuntimeStorage();storage.createPlayer(state);
  const events=[];const taskEngine={processEvent:(_id,event)=>{events.push(event);return{applied:true};}};
  return {task,taskCatalog,gameplayCatalog,storage,taskEngine,events};
}

test('NPC duel stats are derived from the task/NPC definition and explicitly marked as runtime inference',()=>{
  const stats=npcDuelStats({level:1},{level_requirement:107},{npc_duel:{level:107}});assert.equal(stats.level,107);
  assert.equal(stats.rule_status,'RELIABLE_RUNTIME_INFERENCE');assert.equal(stats.rule_id,'zhsh.npc-duel.task-level.v1');
});

test('NPC duel victory advances the task through defeat_npc and grants no monster rewards or drops',()=>{
  const f=fixture();const duel=new NpcDuelRuntime({...f,random:()=>0.5,clock:()=> '2026-07-19T00:00:00.000Z'});
  const started=duel.start('player.duel','npc.trainer','duel.start');assert.equal(started.action,'npc_duel_started');
  const result=duel.attack('player.duel','duel.attack',{rounds:20});assert.equal(result.action,'npc_duel_won');
  assert.equal(result.experience,0);assert.equal(result.money,0);assert.deepEqual(result.drops,[]);
  assert.equal(f.events.length,1);assert.equal(f.events[0].type,'defeat_npc');assert.equal(f.events[0].npc_canonical_id,'npc.trainer');
});

test('NPC duel defeat is nonlethal, preserves position and leaves retry available',()=>{
  const f=fixture();f.storage.transact('player.duel',(state)=>{state.player.current_health=1;state.player.base_attack=1;state.player.base_max_attack=1;return null;});
  const duel=new NpcDuelRuntime({...f,random:()=>0.5});duel.start('player.duel','npc.trainer','loss.start');const result=duel.attack('player.duel','loss.attack',{rounds:1});
  assert.equal(result.action,'npc_duel_lost');assert.equal(result.current_health,1);assert.equal(result.world_position_preserved,true);assert.equal(result.retry_available,true);assert.equal(f.events.length,0);
});
