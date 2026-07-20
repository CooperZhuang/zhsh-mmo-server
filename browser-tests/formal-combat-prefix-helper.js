'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {assertPlayerState}=require('../src/task-runtime/runtime-storage');
const {BrowserTaskCatalog,CombatRuntime,DropRuntime,EconomyRuntime,FormalGameplayCatalog,RecoveryRuntime,TaskRuntimeEngine,VoyageRuntime,effectiveStats,makeEnvelope,validateAndUpgradeEnvelope}=require('../src/task-runtime');

class IsolatedPrefixStorage{
  constructor(state){this.state=structuredClone(assertPlayerState(state));}
  hasPlayer(id){return this.state.player.canonical_id===id;}
  loadPlayer(id){if(!this.hasPlayer(id))throw new Error(`Player does not exist: ${id}`);return this.state;}
  createPlayer(){throw new Error('Prefix player already exists');}
  resetPlayer(id,state){if(state.player.canonical_id!==id)throw new Error('Reset player id mismatch');this.state=structuredClone(assertPlayerState(state));return this.state;}
  transact(id,operation){if(!this.hasPlayer(id))throw new Error(`Player does not exist: ${id}`);const result=operation(this.state);assertPlayerState(this.state);return structuredClone(result);}
}

async function completeFormalCombatPrefix({content,record,taskCanonicalIds,staminaSource=null}){
  const envelope=validateAndUpgradeEnvelope(record),storage=new IsolatedPrefixStorage(envelope.state);const playerId=envelope.player_canonical_id;
  const clock=()=> '2026-07-19T00:00:00.000Z';const taskCatalog=new BrowserTaskCatalog(content);const engine=new TaskRuntimeEngine({catalog:taskCatalog,storage,clock,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id)});engine.synchronizeDefinitions(playerId);
  const catalog=new FormalGameplayCatalog(content);const drops=new DropRuntime({storage,catalog,taskEngine:engine,random:()=>0.99,clock});
  let combatRandom=()=>0.5;const combat=new CombatRuntime({storage,catalog,taskEngine:engine,dropRuntime:drops,random:()=>combatRandom(),clock});
  const recovery=new RecoveryRuntime({storage,catalog,clock});const voyage=new VoyageRuntime({storage,catalog,taskEngine:engine,clock});const economy=new EconomyRuntime({storage,catalog,taskEngine:engine,clock});let sequence=0;
  const event=(name)=>`dom-prefix.${String(++sequence).padStart(6,'0')}.${name}`;let attempts=0,victories=0,losses=0,recoveries=0,voyages=0;

  async function reach(locationId){const current=engine.getCurrentLocation(playerId),destination=taskCatalog.getNodeForLocation(locationId);
    if(current.city_canonical_id!==destination.city_canonical_id){const route=content.voyage_routes.find((entry)=>entry.from_city_canonical_id===current.city_canonical_id&&entry.to_city_canonical_id===destination.city_canonical_id);
      assert.ok(route,`Formal prefix route missing to ${locationId}`);await reach(route.from_port_location_canonical_id);voyage.start(playerId,route.canonical_id,event('voyage-start'));
      while(engine.loadPlayer(playerId).voyage){const active=engine.loadPlayer(playerId).voyage;voyage.advance(playerId,event('voyage-advance'),{ticks:Math.ceil(active.remaining_distance/active.speed)});}voyages+=1;return reach(locationId);}
    const path=findPath(taskCatalog,current.map_node_canonical_id,destination.map_node_canonical_id);for(const node of path.slice(1))engine.move(playerId,node,event('move'));
  }
  async function recoverIfNeeded(returnLocation){const state=engine.loadPlayer(playerId),maximum=effectiveStats(state,catalog).max_health;if(state.player.current_health>=Math.ceil(maximum*0.4))return;
    const service=catalog.listRecoveryServices()[0];await reach(service.location_canonical_id);const result=recovery.recover(playerId,service.canonical_id,event('recover'));if(result.applied)recoveries+=1;await reach(returnLocation);
  }
  async function fight(monsterId,locationId){await reach(locationId);await recoverIfNeeded(locationId);attempts+=1;
    combatRandom=seededRandom(staminaSource&&attempts===1?`45|${monsterId}|stamina|0`:`${monsterId}|${attempts}`);
    combat.start(playerId,monsterId,event('combat-start'));const result=combat.attack(playerId,event('combat-attack'),{rounds:1000});
    if(result.action==='combat_won'){victories+=1;return true;}assert.equal(result.action,'combat_lost');losses+=1;return false;
  }

  if(staminaSource){await reach(staminaSource.location_canonical_id);const purchase=economy.buy(playerId,staminaSource.shop_entry_canonical_id,1,event('stamina-buy'));assert.equal(purchase.applied,true);}
  for(const taskId of taskCanonicalIds){const task=taskCatalog.getTask(taskId);assert.ok(task,taskId);const runtime=engine.loadPlayer(playerId).tasks[taskId];if(runtime.status==='completed')continue;
    await reach(task.receive_location_canonical_id);if(runtime.status!=='completable')engine.processEvent(playerId,{event_id:event('accept'),type:'talk_to_npc',npc_canonical_id:task.issuer_npc_canonical_id,location_canonical_id:task.receive_location_canonical_id});
    for(const target of task.targets){if(target.target_kind==='npc'){await reach(task.submit_location_canonical_id);engine.processEvent(playerId,{event_id:event('talk-target'),type:'talk_to_npc',npc_canonical_id:target.entity_canonical_id,location_canonical_id:task.submit_location_canonical_id});}
      else if(target.target_kind==='monster'){let wins=0;while(wins<Number(target.required_quantity)){assert.ok(attempts<500,'Formal prefix combat bound exceeded');if(await fight(target.entity_canonical_id,task.target_location_canonical_id))wins+=1;}}
      else throw new Error(`Unsupported combat-prefix target kind: ${target.target_kind}`);}
    await reach(task.submit_location_canonical_id);const result=engine.processEvent(playerId,{event_id:event('submit'),type:'submit_to_npc',npc_canonical_id:task.completion_npc_canonical_id,location_canonical_id:task.submit_location_canonical_id});
    assert.equal(result.action,'completed',taskId);
  }
  const final=engine.loadPlayer(playerId);for(const taskId of taskCanonicalIds)assert.equal(final.tasks[taskId].status,'completed',taskId);
  if(staminaSource)assert.equal(Number(final.inventory[staminaSource.item_canonical_id]??0),0,'The finite stamina allocation must be consumed by the formal root combat');
  return {record:makeEnvelope(final,Number(envelope.revision)+1),task_canonical_ids:taskCanonicalIds,attempts,victories,losses,recoveries,voyages,
    stamina_item_canonical_id:staminaSource?.item_canonical_id??null,direct_state_mutations:0,
    storage_runtime:'isolated transactional prefix adapter using TaskRuntimeEngine, CombatRuntime, VoyageRuntime and RecoveryRuntime'};
}

function seededRandom(seed){let state=crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};}
function findPath(catalog,from,to){if(from===to)return[from];const previous=new Map([[from,null]]),queue=[from];while(queue.length){const current=queue.shift();for(const node of catalog.listAdjacentNodes(current)){const id=node.map_node_canonical_id;if(previous.has(id))continue;previous.set(id,current);if(id===to){const result=[to];let cursor=current;while(cursor){result.push(cursor);cursor=previous.get(cursor);}return result.reverse();}queue.push(id);}}throw new Error(`Formal prefix path missing: ${from} -> ${to}`);}

module.exports={completeFormalCombatPrefix};
