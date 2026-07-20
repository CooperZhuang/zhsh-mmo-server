'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { after,test } = require('node:test');
const {acquireFormalLoadout}=require('../browser-tests/formal-equipment-acquisition-helper');
const {completeFormalCombatPrefix}=require('../browser-tests/formal-combat-prefix-helper');
const {
  BrowserRuntimeStorage,
  validateAndUpgradeEnvelope,
  BrowserTaskCatalog,
  CombatRuntime,
  deterministicCombatProof,
  DropRuntime,
  EconomyRuntime,
  EquipmentRuntime,
  effectiveStats,
  FishingRuntime,
  FormalGameplayCatalog,
  RecoveryRuntime,
  ShipRuntime,
  TaskRuntimeEngine,
  VoyageRuntime,
  planTrainingPath,
} = require('../src/task-runtime');

const content=JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','accepted-78-task1-content.json'),'utf8'));
const accepted25=JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','formal-playable-task-ids-at-a97.json'),'utf8'));
const accepted72=JSON.parse(fs.readFileSync(path.resolve('data','runtime','formal-stage-start-72.json'),'utf8'));
const accepted72EvidencePath=path.resolve(accepted72.completed_task_evidence.path);
const accepted72EvidenceBytes=fs.readFileSync(accepted72EvidencePath);
const accepted72RepositoryBytes=Buffer.from(accepted72EvidenceBytes.toString('utf8').replace(/\r\n/g,'\n'));
assert.equal(crypto.createHash('sha256').update(accepted72RepositoryBytes).digest('hex'),accepted72.completed_task_evidence.sha256);
const accepted72Evidence=JSON.parse(accepted72EvidenceBytes);
const accepted72TaskIds=accepted72.completed_task_evidence.json_pointer==='/state/tasks (status=completed)'
  ?Object.entries(accepted72Evidence.state?.tasks??{}).filter(([,task])=>task.status==='completed').map(([id])=>id).sort()
  :accepted72Evidence.completed_task_canonical_ids;
assert.equal(accepted72TaskIds.length,accepted72.selected_task_count);
const accepted72FixturePath=path.resolve('tests','fixtures','browser-save-v4-formal-72-of-72.json');
const equipmentAnalysis=JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','accepted-78-equipment-acquisition-analysis.json'),'utf8'));
const combatSurvivalAnalysis=JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','accepted-78-combat-survival-analysis.json'),'utf8'));

class FakeDurableStore {
  constructor(records = []) { this.records = new Map(records.map((record) => [record.player_canonical_id,structuredClone(record)])); }
  async list() { return [...this.records.values()].map((record) => structuredClone(record)); }
  async put(record) { this.records.set(record.player_canonical_id,structuredClone(record)); }
  close() {}
}

class ControlledRandom {
  constructor() { this.mode = 'lose';this.index = 0;this.seeded=null; }
  use(mode,seed='formal-stamina') { this.mode=mode;this.index=0;this.seeded=mode==='stamina'?seededRandom(seed):null; }
  next() {
    if(this.seeded)return this.seeded();
    const values = this.mode === 'lose' ? [0,0.99,0.99,0] : [0.99,0,0,0.99];
    const value = values[this.index % values.length];this.index += 1;return value;
  }
}

async function createFormalFixture(legacyRecord=null) {
  const durableStore = new FakeDurableStore(legacyRecord?[legacyRecord]:[]);
  const random = new ControlledRandom();
  const clock = () => '2026-07-17T00:00:00.000Z';
  const playerId = legacyRecord?.player_canonical_id ?? 'player.formal-core.e2e';
  let runtime;

  async function reopen() {
    const storage = new BrowserRuntimeStorage({ durableStore });
    await storage.ready();
    const taskCatalog = new BrowserTaskCatalog(content);
    const engine = new TaskRuntimeEngine({ catalog:taskCatalog,storage,clock,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id) });
    const catalog = new FormalGameplayCatalog(content);
    const drops = new DropRuntime({ storage,catalog,taskEngine:engine,random:() => 0.99,clock });
    runtime = {
      storage,taskCatalog,engine,catalog,
      combat:new CombatRuntime({ storage,catalog,taskEngine:engine,dropRuntime:drops,random:() => random.next(),clock }),
      economy:new EconomyRuntime({ storage,catalog,taskEngine:engine,clock }),
      equipment:new EquipmentRuntime({ storage,catalog,clock }),
      fishing:new FishingRuntime({ storage,catalog,taskEngine:engine,random:()=>0,clock }),
      recovery:new RecoveryRuntime({ storage,catalog,clock }),
      ships:new ShipRuntime({ storage,catalog,clock }),
      voyage:new VoyageRuntime({ storage,catalog,taskEngine:engine,clock }),
    };
    return runtime;
  }

  await reopen();
  if(runtime.storage.hasPlayer(playerId))runtime.engine.synchronizeDefinitions(playerId);else runtime.engine.createPlayer(playerId);
  await runtime.storage.flush();
  return { durableStore,playerId,random,reopen,get runtime() { return runtime; } };
}

async function runFormalCore(legacyRecord=null,{checkpointTaskIds=[],terminalTaskIds=[]}={}) {
  const fixture = await createFormalFixture(legacyRecord);
  let sequence = 0;
  let lost = 0;
  let recovered = 0;
  let retreated = 0;
  const levelReachability=[];
  const levelGateObservations=new Map();
  let combatReplayVerified=false;
  const legacyRewardGrants=legacyRecord?structuredClone(legacyRecord.state.reward_grants):null;
  const checkpointSet=new Set(checkpointTaskIds);let checkpoint=null;let combatSurvivalPrepared=false;
  const terminalSet=new Set(terminalTaskIds);
  const next = (label) => `formal.${String(++sequence).padStart(4,'0')}.${label}`;
  const trace=(message)=>{if(process.env.ZHSH_E2E_TRACE)process.stderr.write(`[e2e] ${message}\n`);};

  function observeLevelGate(task) {
    const requiredLevel=Number(task.level_requirement??1);if(levelGateObservations.has(requiredLevel))return;
    const state=fixture.runtime.engine.loadPlayer(fixture.playerId);
    levelGateObservations.set(requiredLevel,{required_level:requiredLevel,current_level:state.player.level,current_experience:state.player.experience,
      actual_fight_count:0,recovery_count:0,closure_path:'selected_task_rewards_and_mandatory_task_encounters',balance_anomaly:false});
  }

  async function reach(locationId) {
    const { engine,taskCatalog } = fixture.runtime;
    const current = engine.getCurrentLocation(fixture.playerId);
    const destination = taskCatalog.getNodeForLocation(locationId);
    if (current.city_canonical_id !== destination.city_canonical_id) {
      const route=content.voyage_routes.find((entry)=>entry.from_city_canonical_id===current.city_canonical_id&&entry.to_city_canonical_id===destination.city_canonical_id);
      assert.ok(route,`no formal voyage route to ${locationId}`);
      await reach(route.from_port_location_canonical_id);
      fixture.runtime.voyage.start(fixture.playerId,route.canonical_id,next('voyage-start'));
      while(fixture.runtime.engine.loadPlayer(fixture.playerId).voyage)advanceVoyage();
      return reach(locationId);
    }
    const pathNodes = findPath(taskCatalog,current.map_node_canonical_id,destination.map_node_canonical_id);
    for (const nodeId of pathNodes.slice(1)) engine.move(fixture.playerId,nodeId,next('move'));
  }

  async function fight(monsterId,{ reloadAfterStart=false }={}) {
    const monster=fixture.runtime.catalog.getMonster(monsterId);
    const currentNode=fixture.runtime.engine.loadPlayer(fixture.playerId).player.current_map_node_canonical_id;
    assert.ok(fixture.runtime.catalog.listMonsterPlacements(monsterId).some((entry)=>entry.map_node_canonical_id===currentNode),`combat location mismatch for ${monster.display_name}`);
    fixture.runtime.combat.start(fixture.playerId,monsterId,next('combat-start'));
    if (reloadAfterStart) { await fixture.runtime.storage.flush();await fixture.reopen(); }
    while (fixture.runtime.engine.loadPlayer(fixture.playerId).combat) {
      if (fixture.random.mode === 'lose') fixture.random.use('lose');
      const attackEvent=next('combat-attack');const result = fixture.runtime.combat.attack(fixture.playerId,attackEvent,{ rounds:1000 });
      if(result.action==='combat_won'&&!combatReplayVerified) {assert.equal(fixture.runtime.combat.attack(fixture.playerId,attackEvent,{rounds:1000}).idempotent_replay,true);combatReplayVerified=true;}
      if (result.action === 'combat_lost') {
        lost += 1;
        const service = fixture.runtime.catalog.listRecoveryServices()[0];
        assert.ok(service,'formal content must expose a recovery service reachable after defeat');
        await reach(service.location_canonical_id);
        const outcome = fixture.runtime.recovery.recover(fixture.playerId,service.canonical_id,next('recover'));
        assert.equal(outcome.action,'health_recovered');
        recovered += 1;
        fixture.random.use('win');
        await fixture.runtime.storage.flush();
        return 'lost';
      }
    }
    await fixture.runtime.storage.flush();
    return 'won';
  }

  async function recoverForGrinding(record,returnLocationId) {
    const state=fixture.runtime.engine.loadPlayer(fixture.playerId);const maximum=effectiveStats(state,fixture.runtime.catalog).max_health;
    if(state.player.current_health>=Math.ceil(maximum*0.4))return;
    const service=fixture.runtime.catalog.listRecoveryServices()[0];
    await reach(service.location_canonical_id);
    const result=fixture.runtime.recovery.recover(fixture.playerId,service.canonical_id,next('grind-recovery'));
    if(result.action==='health_recovered'){record.recovery_count+=1;recovered+=1;if(returnLocationId)await reach(returnLocationId);}
  }

  async function reachLevelThroughFormalEncounters(requiredLevel) {
    fixture.random.use('win');
    const before=fixture.runtime.engine.loadPlayer(fixture.playerId);
    const encounters=content.monster_placements.filter((placement)=>placement.repeatable&&placement.encounter_type==='wild').map((placement)=>{
      const monster=content.monsters.find((entry)=>entry.canonical_id===placement.monster_canonical_id);
      return monster?{...monster,monster_canonical_id:monster.canonical_id,monster_name:monster.display_name,
        location_canonical_id:placement.location_canonical_id,city_canonical_id:content.locations.find((entry)=>entry.canonical_id===placement.location_canonical_id)?.city_canonical_id,
        encounter_type:placement.encounter_type,repeatable:placement.repeatable}:null;
    }).filter(Boolean);
    const equippedIds=[...Object.entries(before.equipment).filter(([key])=>key!=='accessories').map(([,id])=>id),...before.equipment.accessories].filter(Boolean);
    const actualEquipment=equippedIds.map((id)=>content.equipment.find((entry)=>entry.canonical_id===id)).filter(Boolean);
    const plan=planTrainingPath({currentLevel:before.player.level,currentExperience:before.player.experience,targetLevel:requiredLevel,
      encounters,rewardRules:content.gameplay_rules.monster_rewards,progressionRules:content.gameplay_rules.progression,actualEquipment});
    assert.equal(plan.formally_executable,true,`source-driven progression plan blocked level ${before.player.level} -> ${requiredLevel}`);
    const record={...plan,task_gate_required_level:requiredLevel,actual_fight_count:0,recovery_count:0};
    for(const segment of plan.level_segments)for(const allocation of segment.encounter_allocations) {
      await reach(allocation.location_canonical_id);
      for(let victory=0;victory<allocation.planned_victories&&fixture.runtime.engine.loadPlayer(fixture.playerId).player.level<requiredLevel;){
        const outcome=await fight(allocation.monster_canonical_id);
        if(outcome==='won'){victory+=1;record.actual_fight_count+=1;}else await reach(allocation.location_canonical_id);
        await recoverForGrinding(record,allocation.location_canonical_id);
        assert.ok(record.actual_fight_count<=plan.total_reasonable_worst_attempts,
          `source-driven progression bound exceeded for level ${before.player.level} -> ${requiredLevel}`);
      }
    }
    const after=fixture.runtime.engine.loadPlayer(fixture.playerId);
    assert.ok(after.player.level>=requiredLevel,`formal training stopped at level ${after.player.level}, requires ${requiredLevel}`);
    record.result_level=after.player.level;record.result_experience=after.player.experience;levelReachability.push(record);
    trace(`formal grinding ${record.actual_fight_count} victories -> level ${record.result_level}`);
    const segments=levelReachability.filter((entry)=>entry.task_gate_required_level===requiredLevel);
    levelGateObservations.set(requiredLevel,{required_level:requiredLevel,actual_fight_count:segments.reduce((sum,entry)=>sum+entry.actual_fight_count,0),
      recovery_count:segments.reduce((sum,entry)=>sum+entry.recovery_count,0),progression_plans:segments,
      closure_path:'repeatable_formal_location_encounters',balance_anomaly:false});
    equipBestOwned();await fixture.runtime.storage.flush();fixture.runtime.engine.refreshAvailability(fixture.playerId);
  }

  function advanceVoyage() {
    const voyage=fixture.runtime.engine.loadPlayer(fixture.playerId).voyage;
    const eventId=next('voyage-advance');const ticks=Math.ceil(voyage.remaining_distance/voyage.speed);
    const result=fixture.runtime.voyage.advance(fixture.playerId,eventId,{ ticks });
    if(result.action==='voyage_arrived')assert.equal(fixture.runtime.voyage.advance(fixture.playerId,eventId,{ ticks }).idempotent_replay,true);
    return result;
  }

  function equipBestOwned() {
    const state=fixture.runtime.engine.loadPlayer(fixture.playerId);const level=state.player.level;
    const candidates=content.equipment.filter((entry)=>(state.inventory[entry.canonical_id]??0)>0&&Number(entry.required_level??1)<=level)
      .sort((a,b)=>equipmentScore(b)-equipmentScore(a)||a.canonical_id.localeCompare(b.canonical_id));
    for(const type of [1,2,3,4,5,7]) {const item=candidates.find((entry)=>Number(entry.equipment_type)===type);if(item)fixture.runtime.equipment.equip(fixture.playerId,item.canonical_id,next('equip'));}
    for(const [index,item] of candidates.filter((entry)=>Number(entry.equipment_type)===6).slice(0,3).entries())fixture.runtime.equipment.equip(fixture.playerId,item.canonical_id,next('equip-accessory'),index);
  }

  const task1 = fixture.runtime.taskCatalog.listSeriesTasks('task.series.01');
  assert.equal(task1.length,13);
  for (const task of task1) {
    observeLevelGate(task);
    let taskStatus=fixture.runtime.engine.loadPlayer(fixture.playerId).tasks[task.canonical_id].status;
    if(taskStatus==='completed')continue;
    if(taskStatus!=='completable') {
      await reach(task.receive_location_canonical_id);
      const accepted = fixture.runtime.engine.processEvent(fixture.playerId,{
        event_id:next('talk'),type:'talk_to_npc',npc_canonical_id:task.issuer_npc_canonical_id,
        location_canonical_id:task.receive_location_canonical_id,
      });
      assert.equal(accepted.action,'accepted');
    }

    if (taskStatus!=='completable'&&task.canonical_id === 'task.series.01.011') {
      const currentCity=fixture.runtime.engine.getCurrentLocation(fixture.playerId).city_canonical_id;
      const destinationCity=fixture.runtime.taskCatalog.getNodeForLocation(task.submit_location_canonical_id).city_canonical_id;
      const inbound = content.voyage_routes.find((route) => route.from_city_canonical_id===currentCity&&route.to_city_canonical_id===destinationCity);
      await reach(inbound.from_port_location_canonical_id);
      fixture.runtime.voyage.start(fixture.playerId,inbound.canonical_id,next('voyage-start'));
      while (fixture.runtime.engine.loadPlayer(fixture.playerId).voyage) advanceVoyage();
    }

    for (const target of taskStatus==='completable'?[]:task.targets) {
      if (target.target_kind === 'monster') {
        await reach(task.target_location_canonical_id);
        let defeated = 0;
        while (defeated < target.required_quantity) {
          const outcome = await fight(target.entity_canonical_id,{ reloadAfterStart:defeated === 0 && task.canonical_id === 'task.series.01.004' });
          if (outcome === 'won') defeated += 1;
          else await reach(task.target_location_canonical_id);
        }
      } else if (target.target_kind === 'item' && task.canonical_id === 'task.series.01.007') {
        const entry = content.shop_entries.find((candidate) => candidate.task_item_canonical_id === target.entity_canonical_id);
        assert.ok(entry);
        await reach(entry.location_canonical_id);
        fixture.runtime.economy.buy(fixture.playerId,entry.canonical_id,1,next('shop-buy'));
      } else if (target.target_kind === 'npc') {
        await reach(task.submit_location_canonical_id);
        fixture.runtime.engine.processEvent(fixture.playerId,{
          event_id:next('talk-target'),type:'talk_to_npc',npc_canonical_id:target.entity_canonical_id,
          location_canonical_id:task.submit_location_canonical_id,
        });
      }
    }

    if (taskStatus!=='completable'&&task.canonical_id === 'task.series.01.010') {
      const currentCity=fixture.runtime.engine.getCurrentLocation(fixture.playerId).city_canonical_id;
      const destinationCity=fixture.runtime.taskCatalog.getNodeForLocation(task.submit_location_canonical_id).city_canonical_id;
      const outbound = content.voyage_routes.find((route) => route.from_city_canonical_id===currentCity&&route.to_city_canonical_id===destinationCity);
      await reach(outbound.from_port_location_canonical_id);
      const ship = content.ships.find((candidate) => candidate.port_map_node_canonical_id === outbound.from_port_map_node_canonical_id);
      fixture.runtime.ships.purchase(fixture.playerId,ship.canonical_id,next('ship-buy'));
      fixture.runtime.voyage.start(fixture.playerId,outbound.canonical_id,next('voyage-start'));
      fixture.runtime.voyage.advance(fixture.playerId,next('voyage-advance'));
      await fixture.runtime.storage.flush();
      await fixture.reopen();
      while (fixture.runtime.engine.loadPlayer(fixture.playerId).voyage) advanceVoyage();
    }

    await reach(task.submit_location_canonical_id);
    const completed = fixture.runtime.engine.processEvent(fixture.playerId,{
      event_id:next('submit'),type:'submit_to_npc',npc_canonical_id:task.completion_npc_canonical_id,
      location_canonical_id:task.submit_location_canonical_id,
    });
    assert.equal(completed.action,'completed');
  }

  const farm = content.monsters.find((monster) => monster.display_name === '野狼');
  const farmPlacement = content.monster_placements.find((entry) => entry.monster_canonical_id === farm.canonical_id);
  await reach(farmPlacement.location_canonical_id);
  while (fixture.runtime.engine.loadPlayer(fixture.playerId).player.money < 500) await fight(farm.canonical_id);
  fixture.runtime.combat.start(fixture.playerId,farm.canonical_id,next('retreat-start'));
  const retreatEvent = next('retreat');
  const firstRetreat = fixture.runtime.combat.retreat(fixture.playerId,retreatEvent);
  const repeatedRetreat = fixture.runtime.combat.retreat(fixture.playerId,retreatEvent);
  assert.equal(firstRetreat.action,'combat_retreated');
  assert.equal(repeatedRetreat.idempotent_replay,true);
  retreated += 1;

  async function prepareCombatSurvival(){
    const exported=JSON.parse(fixture.runtime.storage.exportPlayer(fixture.playerId));
    const acquisition=await acquireFormalLoadout({content,record:exported,equipmentAnalysis,taskCanonicalId:combatSurvivalAnalysis.chosen_allocation.task_canonical_id});
    await fixture.runtime.storage.importPlayer(JSON.stringify(acquisition.record),{expectedPlayerCanonicalId:fixture.playerId});fixture.runtime.engine.synchronizeDefinitions(fixture.playerId);
    await reach(combatSurvivalAnalysis.stamina_source.location_canonical_id);
    const bought=fixture.runtime.economy.buy(fixture.playerId,combatSurvivalAnalysis.stamina_source.shop_entry_canonical_id,1,next('stamina-buy'));
    assert.equal(bought.applied,true);combatSurvivalPrepared=true;
  }

  const expandedSeries=content.series.map((entry)=>entry.canonical_id).filter((id)=>id!=='task.series.01');
  const expandedTasks=new Map(expandedSeries.map((seriesId)=>[seriesId,fixture.runtime.taskCatalog.listSeriesTasks(seriesId)]));
  const positions=new Map(expandedSeries.map((seriesId)=>{const tasks=expandedTasks.get(seriesId);let position=0;
    while(position<tasks.length&&fixture.runtime.engine.loadPlayer(fixture.playerId).tasks[tasks[position].canonical_id].status==='completed')position+=1;
    return [seriesId,position];}));
  const terminalComplete=()=>terminalSet.size&&[...terminalSet].every((id)=>fixture.runtime.engine.loadPlayer(fixture.playerId).tasks[id]?.status==='completed');
  while(!terminalComplete()&&[...positions].some(([seriesId,position])=>position<expandedTasks.get(seriesId).length)) {
    const heads=expandedSeries.map((seriesId)=>({seriesId,task:expandedTasks.get(seriesId)[positions.get(seriesId)]})).filter((entry)=>entry.task);
    const checkpointPending=checkpointSet.size&&!checkpoint&&[...checkpointSet].some((id)=>fixture.runtime.engine.loadPlayer(fixture.playerId).tasks[id]?.status!=='completed');
    const eligibleHeads=(checkpointPending?heads.filter((entry)=>checkpointSet.has(entry.task.canonical_id)):heads)
      .filter((entry)=>!terminalSet.size||terminalSet.has(entry.task.canonical_id));
    const playerLevel=fixture.runtime.engine.loadPlayer(fixture.playerId).player.level;
    const executionLevel=(task)=>combatSurvivalAnalysis.chosen_allocation.newly_selected_task_ids.includes(task.canonical_id)?Number(task.level_requirement??1):taskExecutionLevel(task);
    const completedCount=Object.values(fixture.runtime.engine.loadPlayer(fixture.playerId).tasks).filter((task)=>task.status==='completed').length;
    const stageBaselineReady=completedCount>=accepted72.selected_task_count;
    const schedulableHeads=eligibleHeads.filter((entry)=>entry.task.canonical_id!==combatSurvivalAnalysis.chosen_allocation.task_canonical_id||stageBaselineReady);
    const available=schedulableHeads.filter((entry)=>executionLevel(entry.task)<=playerLevel)
      .sort((a,b)=>executionLevel(a.task)-executionLevel(b.task)||a.seriesId.localeCompare(b.seriesId));
    if(!available.length) {
      assert.ok(schedulableHeads.length,'accepted checkpoint or combat-survival baseline is not a schedulable series prefix');
      const requiredLevel=Math.min(...schedulableHeads.map((entry)=>executionLevel(entry.task)));
      assert.ok(requiredLevel>playerLevel,`formal scheduler stalled at level ${playerLevel}; next schedulable level is ${requiredLevel}`);
      await reachLevelThroughFormalEncounters(requiredLevel);
      continue;
    }
    const { seriesId,task }=available[0];
    if(task.canonical_id===combatSurvivalAnalysis.chosen_allocation.task_canonical_id&&!combatSurvivalPrepared)await prepareCombatSurvival();
    if(task.canonical_id===combatSurvivalAnalysis.chosen_allocation.task_canonical_id)fixture.random.use('stamina',`45|${task.targets[0].entity_canonical_id}|stamina|0`);
    else fixture.random.use('win');
    observeLevelGate(task);
    trace(`task ${task.canonical_id} level ${playerLevel}`);
    fixture.runtime.engine.selectSeries(fixture.playerId,seriesId,next('series-select'));
    fixture.runtime.engine.refreshAvailability(fixture.playerId);
    await reach(task.receive_location_canonical_id);
    const accepted=fixture.runtime.engine.processEvent(fixture.playerId,{event_id:next('talk'),type:'talk_to_npc',
      npc_canonical_id:task.issuer_npc_canonical_id,location_canonical_id:task.receive_location_canonical_id});
    assert.equal(accepted.action,'accepted',task.canonical_id);
    for(const target of task.targets) {
      if(target.target_kind==='monster') {
        await reach(task.target_location_canonical_id);
        let defeated=0;while(defeated<target.required_quantity){const outcome=await fight(target.entity_canonical_id);if(outcome==='won')defeated+=1;else await reach(task.target_location_canonical_id);}
      } else if(target.target_kind==='npc') {
        await reach(task.submit_location_canonical_id);
        fixture.runtime.engine.processEvent(fixture.playerId,{event_id:next('talk-target'),type:'talk_to_npc',
          npc_canonical_id:target.entity_canonical_id,location_canonical_id:task.submit_location_canonical_id});
      } else if(target.target_kind==='item') {
        const runtimeTask=fixture.runtime.engine.loadPlayer(fixture.playerId).tasks[task.canonical_id];
        if(runtimeTask.status!=='completable') {
          if(target.runtime_resolution?.source_kind==='fishing') {
            const catchDefinition=content.maritime.fishing.catches.find((entry)=>entry.content_entity_canonical_id===target.entity_canonical_id);
            const rod=content.maritime.fishing.gear.find((entry)=>Number(entry.type)===14);
            const bait=content.maritime.fishing.gear.find((entry)=>entry.canonical_id===catchDefinition.bait_content_entity_canonical_id);
            const state=fixture.runtime.engine.loadPlayer(fixture.playerId);
            const rodEntry=content.shop_entries.find((entry)=>entry.map_node_canonical_id===state.player.current_map_node_canonical_id&&entry.content_entity_canonical_id===rod.canonical_id);
            const baitEntry=content.shop_entries.find((entry)=>entry.map_node_canonical_id===state.player.current_map_node_canonical_id&&entry.content_entity_canonical_id===bait.canonical_id);
            assert.ok(rodEntry&&baitEntry,`formal fishing vendor missing: ${task.canonical_id}`);
            fixture.runtime.economy.buy(fixture.playerId,rodEntry.canonical_id,1,next('rod-buy'));
            fixture.runtime.economy.buy(fixture.playerId,baitEntry.canonical_id,1,next('bait-buy'));
            const pair=catchDefinition.route_pairs[0];const route=content.voyage_routes.find((entry)=>
              entry.from_city_canonical_id===pair.from_city_canonical_id&&entry.to_city_canonical_id===pair.to_city_canonical_id);
            assert.ok(route);await reach(route.from_port_location_canonical_id);
            fixture.runtime.voyage.start(fixture.playerId,route.canonical_id,next('fishing-voyage-start'));
            fixture.runtime.fishing.start(fixture.playerId,rod.canonical_id,bait.canonical_id,next('fishing-start'));
            fixture.runtime.fishing.cast(fixture.playerId,next('fishing-cast'));
            assert.equal(fixture.runtime.fishing.reel(fixture.playerId,next('fishing-reel')).action,'fish_caught');
            fixture.runtime.fishing.stop(fixture.playerId,next('fishing-stop'));
            while(fixture.runtime.engine.loadPlayer(fixture.playerId).voyage)advanceVoyage();
          } else {
          const entry=content.shop_entries.find((candidate)=>candidate.task_target_canonical_id===target.canonical_id);
          const drop=content.drop_relations.find((candidate)=>candidate.canonical_id===target.runtime_resolution?.formal_source_canonical_id);
          assert.ok(entry||drop,`formal item source missing: ${task.canonical_id}`);
          if(entry) {await reach(entry.location_canonical_id);fixture.runtime.economy.buy(fixture.playerId,entry.canonical_id,target.required_quantity,next('shop-buy'));}
          else {
            const placement=content.monster_placements.find((candidate)=>candidate.monster_canonical_id===drop.monster_canonical_id
              &&candidate.location_canonical_id===(drop.location_canonical_id??task.target_location_canonical_id));
            assert.ok(placement,`formal drop encounter missing: ${task.canonical_id}`);await reach(placement.location_canonical_id);
            let sourceEncounters=0;let sourceAttempts=0;
            const sourceAttemptBound=Math.ceil(Number(target.required_quantity)/Math.max(0.01,Number(drop.probability??0.4))*2);
            while((fixture.runtime.engine.loadPlayer(fixture.playerId).progress[`${task.canonical_id}|${target.canonical_id}`]??0)<target.required_quantity) {
              sourceAttempts+=1;
              const outcome=await fight(drop.monster_canonical_id);if(outcome==='lost')await reach(placement.location_canonical_id);else sourceEncounters+=1;
              assert.ok(sourceAttempts<=sourceAttemptBound,
                `guaranteed active-task drop did not settle within the source-derived bound: ${task.canonical_id} ${target.raw_name}`);
            }
          }
          }
        }
        assert.equal(fixture.runtime.engine.loadPlayer(fixture.playerId).progress[`${task.canonical_id}|${target.canonical_id}`],target.required_quantity,`formal item source did not advance: ${task.canonical_id}`);
      }
    }
    assert.equal(fixture.runtime.engine.loadPlayer(fixture.playerId).tasks[task.canonical_id].status,'completable',`formal targets incomplete: ${task.canonical_id}`);
    await reach(task.submit_location_canonical_id);
    const submitPayload={event_id:next('submit'),type:'submit_to_npc',npc_canonical_id:task.completion_npc_canonical_id,location_canonical_id:task.submit_location_canonical_id};
    const completed=fixture.runtime.engine.processEvent(fixture.playerId,submitPayload);
    assert.equal(completed.action,'completed',task.canonical_id);
    assert.equal(fixture.runtime.engine.processEvent(fixture.playerId,submitPayload).idempotent_replay,true);
    equipBestOwned();
    positions.set(seriesId,positions.get(seriesId)+1);
    if(checkpointSet.size&&!checkpoint&&[...checkpointSet].every((id)=>fixture.runtime.engine.loadPlayer(fixture.playerId).tasks[id]?.status==='completed')) {
      await fixture.runtime.storage.flush();await fixture.reopen();const state=fixture.runtime.engine.loadPlayer(fixture.playerId);
      checkpoint={source_head:accepted25.source_head,completed_task_count:checkpointSet.size,reward_grants:structuredClone(state.reward_grants),
        level:state.player.level,experience:state.player.experience,money:state.player.money,reloaded:true};
    }
  }

  await fixture.runtime.storage.flush();
  await fixture.reopen();
  const final = fixture.runtime.engine.loadPlayer(fixture.playerId);
  const completedTaskCount=Object.values(final.tasks).filter((task) => task.status === 'completed').length;
  assert.equal(completedTaskCount,terminalSet.size||content.tasks.length);
  assert.ok(lost>=1);
  assert.ok(recovered>=lost,'every combat loss must be recovered; proactive grind recovery is also counted');
  assert.equal(retreated,1);
  assert.equal(combatReplayVerified,true);
  assert.equal(final.voyage,null);
  assert.equal(final.combat,null);
  assert.ok(Object.keys(final.drop_settlements).length > 0);
  assert.ok(final.owned_ships[final.current_ship_canonical_id]);
  if(legacyRewardGrants)for(const [rewardId,value] of Object.entries(legacyRewardGrants))assert.deepEqual(final.reward_grants[rewardId],value,`legacy reward changed: ${rewardId}`);
  if(checkpoint)for(const [rewardId,value] of Object.entries(checkpoint.reward_grants))assert.deepEqual(final.reward_grants[rewardId],value,`accepted-25 reward changed: ${rewardId}`);
  return { player_canonical_id:fixture.playerId,selected_task_count:content.tasks.length,
    completed_task_count:completedTaskCount,
    reward_grant_count:Object.keys(final.reward_grants).length,lost,recovered,retreated,level_reachability:levelReachability,
    level_gate_summary:[...levelGateObservations.values()].sort((a,b)=>a.required_level-b.required_level),accepted_25_checkpoint:checkpoint,
    save_envelope:JSON.parse(fixture.runtime.storage.exportPlayer(fixture.playerId)),state:final };
}

async function runCapturedScenario(scenario,legacyRecord=null,options={}) {
  const result=await runFormalCore(legacyRecord,options);
  if(process.env.ZHSH_CAPTURE_LEVEL_REACHABILITY==='1')process.stdout.write(`ZHSH_LEVEL_REACHABILITY:${JSON.stringify({scenario,
    player_canonical_id:result.player_canonical_id,selected_task_count:result.selected_task_count,completed_task_count:result.completed_task_count,
    level_reachability:result.level_reachability.map(compactTrainingPlan),
    level_gate_summary:result.level_gate_summary.map((entry)=>({...entry,progression_plans:(entry.progression_plans??[]).map(compactTrainingPlan)})),
    accepted_25_checkpoint:result.accepted_25_checkpoint?{...result.accepted_25_checkpoint,reward_grants:undefined}:null})}\n`);
  return result;
}

async function runComposedScenario(scenario,baselineEvidenceFile){
  const baseline=JSON.parse(fs.readFileSync(path.resolve(baselineEvidenceFile),'utf8'));
  assert.equal(baseline.exit_code,0);assert.equal(baseline.test_count,1);
  assert.equal(baseline.formal_result.scenario,scenario);
  assert.equal(baseline.formal_result.selected_task_count,accepted72.selected_task_count);
  assert.equal(baseline.formal_result.completed_task_count,accepted72.selected_task_count);
  const source=JSON.parse(fs.readFileSync(accepted72FixturePath,'utf8'));
  const acquisition=await acquireFormalLoadout({content,record:source,equipmentAnalysis,taskCanonicalId:combatSurvivalAnalysis.chosen_allocation.task_canonical_id});
  const extension=await completeFormalCombatPrefix({content,record:acquisition.record,
    taskCanonicalIds:combatSurvivalAnalysis.chosen_allocation.newly_selected_task_ids,staminaSource:combatSurvivalAnalysis.stamina_source});
  const envelope=validateAndUpgradeEnvelope(extension.record);
  const completed=Object.values(envelope.state.tasks).filter((task)=>task.status==='completed').length;
  assert.equal(completed,content.tasks.length);assert.equal(extension.direct_state_mutations,0);
  const result={scenario,player_canonical_id:envelope.player_canonical_id,selected_task_count:content.tasks.length,completed_task_count:completed,
    level_reachability:(baseline.formal_result.level_reachability??[]).map(compactTrainingPlan),
    level_gate_summary:(baseline.formal_result.level_gate_summary??[]).map((entry)=>({...entry,progression_plans:(entry.progression_plans??[]).map(compactTrainingPlan)})),
    accepted_25_checkpoint:baseline.formal_result.accepted_25_checkpoint??null,baseline_evidence_file:baselineEvidenceFile,
    baseline_git_head:baseline.git_head,incremental_source_fixture:'tests/fixtures/browser-save-v4-formal-72-of-72.json',
    incremental_task_canonical_ids:combatSurvivalAnalysis.chosen_allocation.newly_selected_task_ids,
    incremental_runtime_adapter_actions:extension.record.revision-source.revision,direct_state_mutations:0};
  if(process.env.ZHSH_CAPTURE_LEVEL_REACHABILITY==='1')process.stdout.write(`ZHSH_LEVEL_REACHABILITY:${JSON.stringify(result)}\n`);
  return result;
}

test('formal core completes every selected browser task from a new save without preview or direct task-state events',()=>process.env.ZHSH_RUN_FULL_FORMAL_CORE==='1'
  ?runCapturedScenario('new_browser_save')
  :runComposedScenario('new_browser_save','tests/fixtures/formal-core-new.json'));
test('formal core migrates the real legacy save, reloads at the accepted 25-task checkpoint and completes every added task',()=>process.env.ZHSH_RUN_FULL_FORMAL_CORE==='1'
  ?runCapturedScenario('legacy_25_task_checkpoint_migration',JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','browser-save-v1-real-1-of-13.json'),'utf8')),
    {checkpointTaskIds:accepted25.task_canonical_ids})
  :runComposedScenario('legacy_25_task_checkpoint_migration','tests/fixtures/formal-core-legacy.json'));

test('accepted 72-task formal export fixture is generated only through the formal runtime adapter',async()=>{
  if(process.env.ZHSH_REBUILD_ACCEPTED_72_FIXTURE==='1'){
    const source=JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','browser-save-v3-formal-57-of-57.json'),'utf8'));
    const result=await runFormalCore(source,{terminalTaskIds:accepted72TaskIds});
    fs.writeFileSync(accepted72FixturePath,`${JSON.stringify(result.save_envelope,null,2)}\n`,'utf8');
  }
  const envelope=validateAndUpgradeEnvelope(JSON.parse(fs.readFileSync(accepted72FixturePath,'utf8')));
  const completed=Object.entries(envelope.state.tasks).filter(([,task])=>task.status==='completed').map(([id])=>id).sort();
  assert.deepEqual(completed,[...accepted72TaskIds].sort());
  assert.equal(completed.length,accepted72.selected_task_count);
});

test('formal runtime adapter continues the accepted 72-task export through every natural new prefix',async()=>{
  const sourceBytes=fs.readFileSync(accepted72FixturePath);
  const source=JSON.parse(sourceBytes);
  const beforeChecksum=source.checksum;
  const targetIds=[...combatSurvivalAnalysis.chosen_allocation.newly_selected_task_ids];
  const acquisition=await acquireFormalLoadout({content,record:source,equipmentAnalysis,taskCanonicalId:combatSurvivalAnalysis.chosen_allocation.task_canonical_id});
  const result=await completeFormalCombatPrefix({content,record:acquisition.record,taskCanonicalIds:targetIds,staminaSource:combatSurvivalAnalysis.stamina_source});
  const finalEnvelope=validateAndUpgradeEnvelope(result.record);
  const completed=Object.entries(finalEnvelope.state.tasks).filter(([,task])=>task.status==='completed').map(([id])=>id);
  const newlyCompleted=completed.filter((id)=>!accepted72TaskIds.includes(id)).sort();
  assert.equal(completed.length,content.tasks.length);
  assert.deepEqual(newlyCompleted,['task.series.11.065','task.series.11.066','task.series.11.067','task.series.11.068','task.series.11.069','task.series.11.070']);
  assert.equal(JSON.parse(sourceBytes).checksum,beforeChecksum,'accepted fixture must remain immutable');
  assert.equal(result.direct_state_mutations,0);
  if(process.env.ZHSH_CAPTURE_INCREMENTAL_FORMAL==='1')process.stdout.write(`ZHSH_INCREMENTAL_FORMAL:${JSON.stringify({
    source_fixture:'tests/fixtures/browser-save-v4-formal-72-of-72.json',source_checksum:beforeChecksum,
    final_checksum:result.record.checksum,initial_completed:accepted72TaskIds.length,final_completed:completed.length,
    newly_completed_task_canonical_ids:newlyCompleted,formal_runtime_adapter_actions:result.record.revision-source.revision,
    browser_ui_actions:0,direct_storage_mutations:0,save_envelope:result.record})}\n`);
});

after(()=>{
  if(process.env.ZHSH_E2E_METRICS==='1')process.stdout.write(`ZHSH_PROCESS_METRICS:${JSON.stringify({memory_usage:process.memoryUsage(),resource_usage:process.resourceUsage()})}\n`);
});

function findPath(catalog,from,to) {
  if (from === to) return [from];
  const previous = new Map([[from,null]]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    for (const node of catalog.listAdjacentNodes(current)) {
      if (previous.has(node.map_node_canonical_id)) continue;
      previous.set(node.map_node_canonical_id,current);
      if (node.map_node_canonical_id === to) {
        const result=[to];let cursor=current;
        while (cursor) { result.push(cursor);cursor=previous.get(cursor); }
        return result.reverse();
      }
      queue.push(node.map_node_canonical_id);
    }
  }
  throw new Error(`No formal location connection path: ${from} -> ${to}`);
}

function seededRandom(seed){let state=2166136261;for(const character of String(seed)){state^=character.codePointAt(0);state=Math.imul(state,16777619)>>>0;}if(state===0)state=0x9e3779b9;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};}

function equipmentScore(entry){return Number(entry.attack??0)+Number(entry.max_attack??0)+Number(entry.defense??0)*3+Number(entry.agility??0)*2+Number(entry.health??0);}

function taskExecutionLevel(task){
  const requiredLevel=Number(task.level_requirement??1),monsters=[];
  for(const target of task.targets??[]){
    if(target.target_kind==='monster')monsters.push(content.monsters.find((entry)=>entry.canonical_id===target.entity_canonical_id));
    if(target.target_kind==='item'){
      const drop=content.drop_relations.find((entry)=>entry.canonical_id===target.runtime_resolution?.formal_source_canonical_id);
      if(drop)monsters.push(content.monsters.find((entry)=>entry.canonical_id===drop.monster_canonical_id));
    }
  }
  const combatMonsters=monsters.filter(Boolean);if(!combatMonsters.length)return requiredLevel;
  for(let level=requiredLevel;level<=210;level+=1)if(combatMonsters.every((monster)=>deterministicCombatProof(level,monster,[]).closed))return level;
  return requiredLevel;
}

function compactTrainingPlan(plan){
  return {planner_rule_id:plan.planner_rule_id,current_level:plan.current_level,target_level:plan.target_level,
    task_gate_required_level:plan.task_gate_required_level,total_planned_victories:plan.total_planned_victories,
    total_reasonable_worst_attempts:plan.total_reasonable_worst_attempts,reasonable_worst_minutes:Math.round((plan.level_segments??[])
      .reduce((sum,entry)=>sum+Number(entry.reasonable_worst_minutes??0),0)*1000)/1000,actual_fight_count:plan.actual_fight_count,
    recovery_count:plan.recovery_count,result_level:plan.result_level,result_experience:plan.result_experience,
    recovery_and_funding_closed:plan.recovery_and_funding_closed,requires_unobtained_equipment:plan.requires_unobtained_equipment,
    requires_ship:plan.requires_ship,requires_party:plan.requires_party};
}

module.exports={ runFormalCore };
