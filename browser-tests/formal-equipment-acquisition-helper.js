'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {assertPlayerState}=require('../src/task-runtime/runtime-storage');
const {
  BrowserTaskCatalog,CombatRuntime,DropRuntime,EquipmentRuntime,FormalGameplayCatalog,
  RecoveryRuntime,TaskRuntimeEngine,VoyageRuntime,effectiveStats,makeEnvelope,validateAndUpgradeEnvelope,
}=require('../src/task-runtime');

class IsolatedAcquisitionStorage{
  constructor(state){this.state=structuredClone(assertPlayerState(state));}
  hasPlayer(id){return this.state.player.canonical_id===id;}
  createPlayer(state){if(this.state)throw new Error('Acquisition player already exists');this.state=structuredClone(assertPlayerState(state));return this.state;}
  loadPlayer(id){if(!this.hasPlayer(id))throw new Error(`Player does not exist: ${id}`);return this.state;}
  resetPlayer(id,state){if(state.player.canonical_id!==id)throw new Error('Reset player id mismatch');this.state=structuredClone(assertPlayerState(state));return this.state;}
  transact(id,operation){if(!this.hasPlayer(id))throw new Error(`Player does not exist: ${id}`);const result=operation(this.state);assertPlayerState(this.state);return structuredClone(result);}
}

async function acquireFormalLoadout({content,record,equipmentAnalysis,taskCanonicalId='task.series.11.065'}){
  const envelope=validateAndUpgradeEnvelope(record);const storage=new IsolatedAcquisitionStorage(envelope.state);
  const playerId=envelope.player_canonical_id;const taskCatalog=new BrowserTaskCatalog(content);const clock=()=> '2026-07-18T00:00:00.000Z';
  const engine=new TaskRuntimeEngine({catalog:taskCatalog,storage,clock,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id)});engine.synchronizeDefinitions(playerId);
  const catalog=new FormalGameplayCatalog(content);const recovery=new RecoveryRuntime({storage,catalog,clock});
  const voyage=new VoyageRuntime({storage,catalog,taskEngine:engine,clock});const equipment=new EquipmentRuntime({storage,catalog,clock});
  const planRecord=equipmentAnalysis.plans.find((entry)=>entry.task_canonical_id===taskCanonicalId);
  assert.ok(planRecord?.plan?.acquisition_closed,`Formal equipment plan is not closed for ${taskCanonicalId}`);
  const sourceByEquipment=new Map(planRecord.plan.acquired_equipment.map((entry)=>[entry.equipment_canonical_id,entry]));
  const desired=planRecord.plan.actual_loadout.map((entry)=>({ ...entry,source:sourceByEquipment.get(entry.canonical_id) }));
  assert.ok(desired.length>0,'Formal equipment loadout is empty');assert.ok(desired.every((entry)=>entry.source?.acquisition_closed),'Formal loadout contains an unresolved source');
  let sequence=0;const event=(name)=>`dom-preloadout.${String(++sequence).padStart(6,'0')}.${name}`;
  let attempts=0,victories=0,losses=0,recoveries=0,voyages=0;const acquisitions=[];

  async function reach(locationId){const current=engine.getCurrentLocation(playerId),destination=taskCatalog.getNodeForLocation(locationId);
    if(current.city_canonical_id!==destination.city_canonical_id){const route=content.voyage_routes.find((entry)=>entry.from_city_canonical_id===current.city_canonical_id&&entry.to_city_canonical_id===destination.city_canonical_id);
      assert.ok(route,`Formal equipment route missing to ${locationId}`);await reach(route.from_port_location_canonical_id);voyage.start(playerId,route.canonical_id,event('voyage-start'));
      while(engine.loadPlayer(playerId).voyage){const active=engine.loadPlayer(playerId).voyage;voyage.advance(playerId,event('voyage-advance'),{ticks:Math.ceil(active.remaining_distance/active.speed)});}voyages+=1;return reach(locationId);}
    const path=findPath(taskCatalog,current.map_node_canonical_id,destination.map_node_canonical_id);for(const node of path.slice(1))engine.move(playerId,node,event('move'));
  }
  async function recoverIfNeeded(returnLocation){const current=engine.loadPlayer(playerId),maximum=effectiveStats(current,catalog).max_health;if(current.player.current_health>=maximum)return;
    const service=catalog.listRecoveryServices().find((entry)=>Number(entry.fee??0)===0)??catalog.listRecoveryServices()[0];assert.ok(service,'Formal recovery service is missing');
    await reach(service.location_canonical_id);const result=recovery.recover(playerId,service.canonical_id,event('recover'));if(result.applied)recoveries+=1;await reach(returnLocation);
  }
  async function fightFor(item){const source=item.source;const monsterId=source.actual_source.monster_canonical_id;const locationId=source.actual_source.location_canonical_id;
    const maximumAttempts=Number(source.reasonable_worst_attempts??300);let localAttempts=0;
    while((engine.loadPlayer(playerId).inventory[item.canonical_id]??0)<1){localAttempts+=1;attempts+=1;assert.ok(localAttempts<=maximumAttempts,`Equipment acquisition exceeded source-backed attempt bound: ${item.display_name}`);
      await reach(locationId);await recoverIfNeeded(locationId);const combatRandom=seededRandom(`${item.canonical_id}|combat|${localAttempts-1}`);
      const dropRandom=targetEquipmentRandom(catalog,monsterId,item.canonical_id);
      const drops=new DropRuntime({storage,catalog,taskEngine:engine,random:dropRandom,clock});
      const combat=new CombatRuntime({storage,catalog,taskEngine:engine,dropRuntime:drops,random:combatRandom,clock});
      combat.start(playerId,monsterId,event('combat-start'));const result=combat.attack(playerId,event('combat-attack'),{rounds:1000});
      if(result.action==='combat_won')victories+=1;else {assert.equal(result.action,'combat_lost');losses+=1;continue;}
      assert.ok((engine.loadPlayer(playerId).inventory[item.canonical_id]??0)>=1,`Deterministic UAT drop did not produce ${item.display_name}`);
    }
    acquisitions.push({equipment_canonical_id:item.canonical_id,display_name:item.display_name,source_monster_canonical_id:monsterId,
      source_location_canonical_id:locationId,attempts:localAttempts,drop_control:'formal DropRuntime with deterministic UAT random; no inventory mutation'});
  }

  for(const item of desired)if((engine.loadPlayer(playerId).inventory[item.canonical_id]??0)<1&&!isEquipped(engine.loadPlayer(playerId),item.canonical_id))await fightFor(item);
  let accessoryIndex=0;
  for(const item of desired){if(isEquipped(engine.loadPlayer(playerId),item.canonical_id))continue;const index=item.slot==='accessories'?accessoryIndex++:null;
    const result=equipment.equip(playerId,item.canonical_id,event('equip'),index);assert.equal(result.applied,true);}
  const final=engine.loadPlayer(playerId);for(const item of desired)assert.equal(isEquipped(final,item.canonical_id),true,`Formal equipment was not equipped: ${item.display_name}`);
  return {record:makeEnvelope(final,Number(envelope.revision)+1),task_canonical_id:taskCanonicalId,loadout:desired.map((entry)=>({canonical_id:entry.canonical_id,display_name:entry.display_name,slot:entry.slot})),
    acquisitions,attempts,victories,losses,recoveries,voyages,direct_state_mutations:0,
    storage_runtime:'isolated transactional equipment adapter using CombatRuntime, DropRuntime, VoyageRuntime, RecoveryRuntime and EquipmentRuntime'};
}

function isEquipped(state,itemId){return Object.entries(state.equipment).some(([key,value])=>key==='accessories'?value.includes(itemId):value===itemId);}
function targetEquipmentRandom(catalog,monsterId,targetId){const pool=catalog.listDrops(monsterId).filter((entry)=>entry.drop_kind==='equipment');const weighted=pool.map((drop)=>{const item=catalog.getItem(drop.content_entity_canonical_id);const level=Number(item?.required_level??item?.level??1);return {drop,weight:level<=30?70:level<=100?Math.max(30,70-Math.floor((level-30)*(40/70))):29};});
  const index=weighted.findIndex((entry)=>entry.drop.content_entity_canonical_id===targetId);assert.ok(index>=0,`Target equipment is not in the monster pool: ${targetId}`);
  const total=weighted.reduce((sum,entry)=>sum+entry.weight,0);const before=weighted.slice(0,index).reduce((sum,entry)=>sum+entry.weight,0);const targetRoll=(before+weighted[index].weight/2)/total;
  const values=[0,targetRoll];return()=>values.length?values.shift():0.99;
}
function seededRandom(seed){let state=crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};}
function findPath(catalog,from,to){if(from===to)return[from];const previous=new Map([[from,null]]),queue=[from];while(queue.length){const current=queue.shift();for(const node of catalog.listAdjacentNodes(current)){
  const id=node.map_node_canonical_id;if(previous.has(id))continue;previous.set(id,current);if(id===to){const result=[to];let cursor=current;while(cursor){result.push(cursor);cursor=previous.get(cursor);}return result.reverse();}queue.push(id);}}
  throw new Error(`Formal equipment path missing: ${from} -> ${to}`);}

module.exports={acquireFormalLoadout};
