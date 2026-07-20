'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {assertPlayerState}=require('../src/task-runtime/runtime-storage');
const {
  BrowserTaskCatalog,CombatRuntime,DropRuntime,FormalGameplayCatalog,RecoveryRuntime,
  TaskRuntimeEngine,VoyageRuntime,effectiveStats,makeEnvelope,planTrainingPath,validateAndUpgradeEnvelope,
}=require('../src/task-runtime');

class IsolatedTrainingStorage{
  constructor(state){this.state=structuredClone(assertPlayerState(state));}
  hasPlayer(id){return this.state.player.canonical_id===id;}
  createPlayer(state){if(this.state)throw new Error('Training player already exists');this.state=structuredClone(assertPlayerState(state));return this.state;}
  loadPlayer(id){if(!this.hasPlayer(id))throw new Error(`Player does not exist: ${id}`);return this.state;}
  resetPlayer(id,state){if(state.player.canonical_id!==id)throw new Error('Reset player id mismatch');this.state=structuredClone(assertPlayerState(state));return this.state;}
  transact(id,operation){if(!this.hasPlayer(id))throw new Error(`Player does not exist: ${id}`);const result=operation(this.state);assertPlayerState(this.state);return structuredClone(result);}
}

async function trainFormalRecord({content,record,targetLevel}){
  const envelope=validateAndUpgradeEnvelope(record),storage=new IsolatedTrainingStorage(envelope.state);
  const playerId=envelope.player_canonical_id;const taskCatalog=new BrowserTaskCatalog(content);const clock=()=> '2026-07-18T00:00:00.000Z';
  const engine=new TaskRuntimeEngine({catalog:taskCatalog,storage,clock,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id)});engine.synchronizeDefinitions(playerId);
  const catalog=new FormalGameplayCatalog(content);let combatRandom=()=>0.5;const sampleIndexes=new Map();const drops=new DropRuntime({storage,catalog,taskEngine:engine,random:()=>0.99,clock});
  const combat=new CombatRuntime({storage,catalog,taskEngine:engine,dropRuntime:drops,random:()=>combatRandom(),clock});const recovery=new RecoveryRuntime({storage,catalog,clock});
  const voyage=new VoyageRuntime({storage,catalog,taskEngine:engine,clock});let sequence=0;const event=(name)=>`dom-pretrain.${String(++sequence).padStart(6,'0')}.${name}`;
  const state=engine.loadPlayer(playerId);const encounters=content.monster_placements.filter((placement)=>placement.repeatable&&placement.encounter_type==='wild').map((placement)=>{
    const monster=content.monsters.find((entry)=>entry.canonical_id===placement.monster_canonical_id);const location=content.locations.find((entry)=>entry.canonical_id===placement.location_canonical_id);
    return monster?{...monster,monster_canonical_id:monster.canonical_id,monster_name:monster.display_name,location_canonical_id:placement.location_canonical_id,
      city_canonical_id:location?.city_canonical_id,encounter_type:placement.encounter_type,repeatable:true}:null;
  }).filter(Boolean);
  const equippedIds=[...Object.entries(state.equipment).filter(([key])=>key!=='accessories').map(([,id])=>id),...state.equipment.accessories].filter(Boolean);
  const actualEquipment=equippedIds.map((id)=>content.equipment.find((entry)=>entry.canonical_id===id)).filter(Boolean);
  const reachableLocationIds=collectReachableTravelLocations({content,catalog:taskCatalog,state});
  const plan=planTrainingPath({currentLevel:state.player.level,currentExperience:state.player.experience,targetLevel,encounters,reachableLocationIds,
    rewardRules:content.gameplay_rules.monster_rewards,progressionRules:content.gameplay_rules.progression,actualEquipment});
  assert.equal(plan.formally_executable,true,'Formal pretraining plan must be source-closed');let victories=0,recoveries=0,attempts=0,losses=0;
  const recoveryService=catalog.listRecoveryServices().find((entry)=>reachableLocationIds.includes(entry.location_canonical_id));
  assert.ok(recoveryService,'Formal pretraining requires a reachable recovery service');

  async function reach(locationId){
    const destination=taskCatalog.getNodeForLocation(locationId);assert.ok(destination,`Formal pretraining destination missing for ${locationId}`);
    const currentNode=engine.loadPlayer(playerId).player.current_map_node_canonical_id;
    const path=findTravelPath({content,catalog:taskCatalog,state:engine.loadPlayer(playerId),from:currentNode,to:destination.map_node_canonical_id});
    for(const step of path){
      if(step.kind==='move')engine.move(playerId,step.to,event('move'));
      else {voyage.start(playerId,step.route.canonical_id,event('voyage-start'));
        while(engine.loadPlayer(playerId).voyage){const active=engine.loadPlayer(playerId).voyage;voyage.advance(playerId,event('voyage-advance'),{ticks:Math.ceil(active.remaining_distance/active.speed)});}}
    }
  }
  async function recoverIfNeeded(returnLocation){const current=engine.loadPlayer(playerId),maximum=effectiveStats(current,catalog).max_health;if(current.player.current_health>=maximum)return;
    await reach(recoveryService.location_canonical_id);recovery.recover(playerId,recoveryService.canonical_id,event('recover'));recoveries+=1;await reach(returnLocation);}
  async function fight(monsterId,locationId){await reach(locationId);await recoverIfNeeded(locationId);const playerLevel=engine.loadPlayer(playerId).player.level;
    const key=`${playerLevel}|${monsterId}|${locationId}`,sample=sampleIndexes.get(key)??0;sampleIndexes.set(key,sample+1);combatRandom=seededRandom(`${key}|${sample%256}`);
    combat.start(playerId,monsterId,event('combat-start'));attempts+=1;
    const result=combat.attack(playerId,event('combat-attack'),{rounds:1000});if(result.action==='combat_won'){victories+=1;return true;}
    assert.equal(result.action,'combat_lost');losses+=1;return false;}
  for(const segment of plan.level_segments)for(const allocation of segment.encounter_allocations)for(let wins=0;wins<allocation.planned_victories&&engine.loadPlayer(playerId).player.level<targetLevel;){
    assert.ok(attempts<plan.total_reasonable_worst_attempts,'Formal pretraining exceeded the planner attempt bound');
    if(await fight(allocation.monster_canonical_id,allocation.location_canonical_id))wins+=1;
  }
  const final=engine.loadPlayer(playerId);assert.ok(final.player.level>=targetLevel);
  return {record:makeEnvelope(final,Number(envelope.revision)+1),plan,attempts,victories,losses,recoveries,final_level:final.player.level,
    final_experience:final.player.experience,storage_runtime:'isolated transactional training adapter with a single validated browser-envelope export'};
}

function seededRandom(seed){let state=crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};}
function routeAvailable(route,state){return Boolean(state.current_ship_canonical_id&&state.owned_ships[state.current_ship_canonical_id])
  &&(!route.required_task_canonical_id||(route.allowed_task_statuses??[]).includes(state.tasks[route.required_task_canonical_id]?.status));}
function travelEdges({content,catalog,state,nodeId}){
  const moves=catalog.listAdjacentNodes(nodeId).map((node)=>({kind:'move',to:node.map_node_canonical_id}));
  const voyages=content.voyage_routes.filter((route)=>route.from_port_map_node_canonical_id===nodeId&&routeAvailable(route,state))
    .map((route)=>({kind:'voyage',to:route.to_port_map_node_canonical_id,route}));
  return [...moves,...voyages];
}
function findTravelPath({content,catalog,state,from,to}){
  if(from===to)return[];
  const previous=new Map([[from,null]]),previousEdge=new Map(),queue=[from];
  while(queue.length){const current=queue.shift();for(const edge of travelEdges({content,catalog,state,nodeId:current})){
    if(previous.has(edge.to))continue;previous.set(edge.to,current);previousEdge.set(edge.to,edge);
    if(edge.to===to){const result=[];let cursor=to;while(cursor!==from){result.push(previousEdge.get(cursor));cursor=previous.get(cursor);}return result.reverse();}
    queue.push(edge.to);
  }}
  throw new Error(`Formal pretraining travel path missing: ${from} -> ${to}`);
}
function collectReachableTravelLocations({content,catalog,state}){
  const start=state.player.current_map_node_canonical_id,visited=new Set([start]),queue=[start];
  while(queue.length){const current=queue.shift();for(const edge of travelEdges({content,catalog,state,nodeId:current}))if(!visited.has(edge.to)){visited.add(edge.to);queue.push(edge.to);}}
  return content.map_nodes.filter((node)=>node.location_canonical_id&&visited.has(node.map_node_canonical_id)).map((node)=>node.location_canonical_id);
}

module.exports={collectReachableTravelLocations,findTravelPath,trainFormalRecord};
