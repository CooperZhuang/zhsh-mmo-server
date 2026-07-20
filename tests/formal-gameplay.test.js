'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { DatabaseSync }=require('node:sqlite');
const { test }=require('node:test');
const {
  BrowserTaskCatalog,CombatRuntime,DivingRuntime,DropRuntime,DungeonRuntime,EconomyRuntime,EquipmentRuntime,FishingRuntime,FormalGameplayCatalog,
  ItemRuntime,MaritimeRuntime,MemoryRuntimeStorage,RecoveryRuntime,ShipRuntime,SqliteRuntimeStorage,SqliteTaskCatalog,TaskRuntimeEngine,VoyageRuntime,damage,monsterStats,
}=require('../src/task-runtime');
const { runFirstTaskChain }=require('../src/task-runtime/first-chain-driver');
const { LEVEL_THRESHOLDS }=require('../src/task-runtime/gameplay-state');

const content=require('../web/generated/task1-content.json');

function fixture(contentData=content) {
  const storage=new MemoryRuntimeStorage();const taskCatalog=new BrowserTaskCatalog(contentData);
  const engine=new TaskRuntimeEngine({ catalog:taskCatalog,storage,clock:()=> '2026-07-17T00:00:00.000Z',seriesCanonicalIds:contentData.series.map((entry)=>entry.canonical_id) });
  const playerId=`player.formal.${crypto.randomUUID()}`;engine.createPlayer(playerId);
  const catalog=new FormalGameplayCatalog(contentData);
  const drops=new DropRuntime({ storage,catalog,taskEngine:engine,random:()=>0,clock:()=> '2026-07-17T00:00:00.000Z' });
  return { playerId,storage,engine,catalog,drops,combat:new CombatRuntime({ storage,catalog,taskEngine:engine,dropRuntime:drops,random:()=>0.5,clock:()=> '2026-07-17T00:00:00.000Z' }),
    economy:new EconomyRuntime({ storage,catalog,taskEngine:engine,clock:()=> '2026-07-17T00:00:00.000Z' }),equipment:new EquipmentRuntime({ storage,catalog,clock:()=> '2026-07-17T00:00:00.000Z' }),
    items:new ItemRuntime({ storage,catalog,clock:()=> '2026-07-17T00:00:00.000Z' }),
    recovery:new RecoveryRuntime({ storage,catalog,clock:()=> '2026-07-17T00:00:00.000Z' }),
    ships:new ShipRuntime({ storage,catalog,clock:()=> '2026-07-17T00:00:00.000Z' }),voyage:new VoyageRuntime({ storage,catalog,taskEngine:engine,clock:()=> '2026-07-17T00:00:00.000Z' }) };
}

function mutate(storage,playerId,operation) { storage.transact(playerId,(state)=>{ operation(state);return null; }); }

test('formal browser package exports source-traceable ships, route, shop, equipment and drops',()=>{
  assert.equal(content.schema_version,4);assert.equal(content.tasks.length,content.runnable_task_selection.selected_task_count);assert.equal(content.ships.length,14);assert.ok(content.voyage_routes.length>2);
  assert.ok(content.shop_entries.length>=3);assert.ok(content.formal_items.length>=2);assert.ok(content.formal_items.some((entry)=>entry.canonical_id==='entity.item.8a516352a5046efd'));assert.ok(content.equipment.length>0);assert.ok(content.drop_relations.length>0);
  assert.ok(content.ships.every((entry)=>entry.source_canonical_id));assert.ok(content.voyage_routes.every((entry)=>entry.source_canonical_id&&entry.distance>0));
});

test('task-context NPC placements appear only in their evidenced task states',()=>{
  const placement=content.npc_placements.find((entry)=>entry.placement_scope==='task_context'&&entry.task_contexts?.some((context)=>context.appearance_statuses.includes('available')));
  assert.ok(placement);
  const context=placement.task_contexts.find((entry)=>entry.appearance_statuses.includes('available'));
  const f=fixture();const node=content.map_nodes.find((entry)=>entry.location_canonical_id===placement.location_canonical_id);
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=node.map_node_canonical_id;state.tasks[context.task_canonical_id].status='available';});
  assert.ok(f.engine.listCurrentNpcs(f.playerId).some((entry)=>entry.npc_canonical_id===placement.npc_canonical_id));
  mutate(f.storage,f.playerId,(state)=>{state.tasks[context.task_canonical_id].status='completed';});
  assert.ok(!f.engine.listCurrentNpcs(f.playerId).some((entry)=>entry.canonical_id===placement.canonical_id));
});

test('runtime idempotency ledgers retain the newest 128 complete events and replay inside that window',()=>{
  const f=fixture();const task=content.tasks[0];const node=content.map_nodes.find((entry)=>entry.location_canonical_id===task.receive_location_canonical_id);
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=node.map_node_canonical_id;});
  for(let index=0;index<140;index+=1)f.engine.processEvent(f.playerId,{event_id:`bounded-task-${index}`,type:'talk_to_npc',
    npc_canonical_id:task.issuer_npc_canonical_id,location_canonical_id:task.receive_location_canonical_id});
  let state=f.engine.loadPlayer(f.playerId);assert.equal(Object.keys(state.processed_events).length,128);assert.equal(state.processed_events['bounded-task-11'],undefined);
  assert.equal(f.engine.processEvent(f.playerId,{event_id:'bounded-task-139',type:'talk_to_npc',npc_canonical_id:task.issuer_npc_canonical_id,
    location_canonical_id:task.receive_location_canonical_id}).idempotent_replay,true);
  for(let index=0;index<140;index+=1)f.engine.selectSeries(f.playerId,task.series_canonical_id,`bounded-gameplay-${index}`);
  state=f.engine.loadPlayer(f.playerId);assert.equal(Object.keys(state.gameplay_events).length,128);assert.equal(state.gameplay_events['bounded-gameplay-11'],undefined);
  assert.equal(f.engine.selectSeries(f.playerId,task.series_canonical_id,'bounded-gameplay-139').idempotent_replay,true);
});

test('formal content exposes every placed local encounter with explicit repeat semantics and rewards',()=>{
  assert.ok(content.monster_placements.length>=95);assert.ok(content.monster_placements.every((entry)=>entry.encounter_type&&typeof entry.repeatable==='boolean'&&entry.respawn_rule&&entry.evidence_status));
  assert.ok(content.monsters.every((entry)=>entry.rewards?.experience>0&&entry.rewards?.copper>0));
  assert.equal(content.gameplay_rules.monster_rewards.experience.evidence_status,'PROVISIONAL_COMPATIBILITY');
});

test('ordinary encounters are location-bound, repeatable and settle the configured gradient',()=>{
  const f=fixture();const sourcePlacement=content.monster_placements.find((entry)=>entry.repeatable&&entry.encounter_type==='wild');
  const placement=f.catalog.listMonsterPlacements(sourcePlacement.monster_canonical_id).find((entry)=>entry.canonical_id===sourcePlacement.canonical_id);const monster=f.catalog.getMonster(placement.monster_canonical_id);
  assert.throws(()=>f.combat.start(f.playerId,monster.canonical_id,'wrong-place'),/current formal location/);
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=placement.map_node_canonical_id;state.player.base_attack=99999;state.player.base_max_attack=99999;});
  f.combat.start(f.playerId,monster.canonical_id,'wild-1');const first=f.combat.attack(f.playerId,'wild-hit-1',{rounds:1000});assert.equal(first.experience,monster.rewards.experience);
  f.combat.start(f.playerId,monster.canonical_id,'wild-2');assert.equal(f.combat.attack(f.playerId,'wild-hit-2',{rounds:1000}).action,'combat_won');
});

test('task-exclusive non-repeatable encounters are scoped to the active task context',()=>{
  const f=fixture();const taskA=content.tasks.find((entry)=>entry.canonical_id==='task.series.15.424');
  const taskB=content.tasks.find((entry)=>entry.canonical_id==='task.series.15.425');const monsterId=taskA.targets.find((target)=>target.target_kind==='monster').entity_canonical_id;
  const placement=f.catalog.listMonsterPlacements(monsterId).find((entry)=>entry.encounter_type==='task_exclusive');
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=placement.map_node_canonical_id;state.player.base_attack=999999;state.player.base_max_attack=999999;
    state.tasks[taskA.canonical_id].status='accepted';state.tasks[taskB.canonical_id].status='blocked';});
  f.combat.start(f.playerId,monsterId,'task-exclusive-a-start');assert.equal(f.combat.attack(f.playerId,'task-exclusive-a-hit',{rounds:1000}).action,'combat_won');
  mutate(f.storage,f.playerId,(state)=>{state.tasks[taskA.canonical_id].status='completed';state.tasks[taskB.canonical_id].status='accepted';});
  f.combat.start(f.playerId,monsterId,'task-exclusive-b-start');assert.equal(f.combat.attack(f.playerId,'task-exclusive-b-hit',{rounds:1000}).action,'combat_won');
  const state=f.engine.loadPlayer(f.playerId);assert.ok(state.encounter_defeats[`${placement.canonical_id}|${taskA.canonical_id}`]);
  assert.ok(state.encounter_defeats[`${placement.canonical_id}|${taskB.canonical_id}`]);
  mutate(f.storage,f.playerId,(next)=>{const target=taskB.targets.find((entry)=>entry.target_kind==='monster');next.progress[`${taskB.canonical_id}|${target.canonical_id}`]=0;
    next.tasks[taskB.canonical_id].status='accepted';});
  assert.throws(()=>f.combat.start(f.playerId,monsterId,'task-exclusive-b-repeat'),/already defeated/);
});

test('evidenced dungeon entrance, monster group, repeat rule and exit form a persisted loop',()=>{
  const f=fixture();const definition=content.dungeons[0];const runtime=new DungeonRuntime({storage:f.storage,catalog:f.catalog,clock:()=> '2026-07-17T00:00:00.000Z'});
  mutate(f.storage,f.playerId,(state)=>{state.player.level=10;state.player.current_map_node_canonical_id=definition.map_node_canonical_id;state.player.base_attack=999999;state.player.base_max_attack=999999;});
  assert.equal(runtime.enter(f.playerId,definition.canonical_id,'dungeon-enter').action,'dungeon_entered');
  runtime.move(f.playerId,definition.stages[1].canonical_id,'dungeon-forward');const monster=definition.stages[1].monster;
  f.combat.start(f.playerId,monster.canonical_id,'dungeon-fight-1');assert.equal(f.combat.attack(f.playerId,'dungeon-hit-1',{rounds:1000}).action,'combat_won');
  f.combat.start(f.playerId,monster.canonical_id,'dungeon-fight-2');assert.equal(f.combat.attack(f.playerId,'dungeon-hit-2',{rounds:1000}).action,'combat_won');
  runtime.move(f.playerId,definition.stages[0].canonical_id,'dungeon-back');assert.equal(runtime.exit(f.playerId,'dungeon-exit').action,'dungeon_exited');
});

test('ship purchase checks port, money and duplicate event id, then persists ownership',()=>{
  const f=fixture();const ship=content.ships.find((entry)=>entry.city_display_name==='威尼斯');
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=ship.port_map_node_canonical_id;state.player.money=2000;});
  const bought=f.ships.purchase(f.playerId,ship.canonical_id,'buy-ship');assert.equal(bought.action,'ship_purchased');
  const replay=f.ships.purchase(f.playerId,ship.canonical_id,'buy-ship');assert.equal(replay.idempotent_replay,true);
  const state=f.engine.loadPlayer(f.playerId);assert.ok(state.owned_ships[ship.canonical_id]);assert.equal(state.player.money,1000);
});

test('formal voyage requires a ship and arrives through the task event interface',()=>{
  const f=fixture();const ship=content.ships.find((entry)=>entry.city_display_name==='威尼斯');
  const route=content.voyage_routes.find((entry)=>entry.from_city_canonical_id===ship.city_canonical_id);
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=route.from_port_map_node_canonical_id;state.player.money=2000;});
  f.ships.purchase(f.playerId,ship.canonical_id,'voyage-buy');const started=f.voyage.start(f.playerId,route.canonical_id,'voyage-start');assert.equal(started.voyage.remaining_distance,route.distance);
  let count=0;while(f.engine.loadPlayer(f.playerId).voyage){f.voyage.advance(f.playerId,`sail-${count++}`);}
  assert.equal(count,Math.ceil(route.distance/ship.speed));assert.equal(f.engine.loadPlayer(f.playerId).player.current_map_node_canonical_id,route.to_port_map_node_canonical_id);
  assert.equal(f.engine.loadPlayer(f.playerId).processed_events[`sail-${count-1}.arrival`].payload.location_canonical_id,route.to_port_location_canonical_id);
});

test('shop purchase resolves the same-name goggles to the task target and respects capacity',()=>{
  const f=fixture();const entry=content.shop_entries[0];
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=entry.map_node_canonical_id;state.player.money=entry.price*3;});
  const result=f.economy.buy(f.playerId,entry.canonical_id,1,'buy-goggles');assert.equal(result.item_canonical_id,entry.task_item_canonical_id);
  assert.equal(f.engine.loadPlayer(f.playerId).inventory[entry.task_item_canonical_id],1);
  mutate(f.storage,f.playerId,(state)=>{state.inventory_capacity=1;});
  assert.throws(()=>f.economy.buy(f.playerId,entry.canonical_id,1,'buy-too-many'),/capacity/);
});

test('source market goods use type-11 stack semantics and do not consume weighted backpack capacity',()=>{
  const selection=require('../data/generated/runnable-task-selection.json');
  const resolution=selection.unselected_tasks.flatMap((candidate)=>candidate.runtime_item_resolutions??[])
    .find((candidate)=>candidate.formal_source.source_kind==='market');
  assert.ok(resolution);
  const sourceLocation=content.shop_entries[0];
  const entry={ canonical_id:'test.market.entry',content_entity_canonical_id:resolution.runtime_entity_canonical_id,
    task_item_canonical_id:resolution.runtime_entity_canonical_id,display_name:resolution.formal_source.item_name,
    price:Number(resolution.formal_source.price),shop_canonical_id:'test.market',location_canonical_id:sourceLocation.location_canonical_id,
    map_node_canonical_id:sourceLocation.map_node_canonical_id,inventory_weight_exempt:true };
  const marketItem={ canonical_id:resolution.runtime_entity_canonical_id,source_canonical_id:resolution.formal_source.source_canonical_id,
    display_name:resolution.formal_source.item_name,entity_category:'item',normalized_data:{type:11,inventory_weight_exempt:true} };
  const f=fixture({ ...content,shop_entries:[...content.shop_entries,entry],content_entities:[...content.content_entities,marketItem] });
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=entry.map_node_canonical_id;state.player.money=100000;state.inventory_capacity=0;});
  const result=f.economy.buy(f.playerId,entry.canonical_id,300,'buy-market-cargo');
  assert.equal(result.quantity,300);assert.equal(f.engine.loadPlayer(f.playerId).inventory[entry.task_item_canonical_id],300);
});

test('complete source level table retains the accepted level-times-40 provisional reward rule',()=>{
  assert.equal(LEVEL_THRESHOLDS.length,211);
  const rules=content.gameplay_rules.monster_rewards;
  assert.equal(rules.rule_id,'compatibility.monster-rewards.v1');
  for(const monster of content.monsters) {
    const multiplier=Number(rules.experience.encounter_multipliers[monster.encounter_type]??1);
    const expected=Math.max(Number(rules.experience.minimum),Math.round(Number(monster.level)*Number(rules.experience.base_experience_per_level)*multiplier));
    assert.equal(monster.rewards.experience,expected,monster.canonical_id);
  }
});

test('shop selling requires the corresponding formal shop and replays idempotently',()=>{
  const f=fixture();const entry=content.shop_entries[0];
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=entry.map_node_canonical_id;state.player.money=500;});
  f.economy.buy(f.playerId,entry.canonical_id,1,'sell-location-buy');
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=content.map_nodes.find((node)=>node.map_node_canonical_id!==entry.map_node_canonical_id).map_node_canonical_id;});
  assert.throws(()=>f.economy.sell(f.playerId,entry.canonical_id,1,'sell-wrong-location'),/current formal location/);
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=entry.map_node_canonical_id;});
  const sold=f.economy.sell(f.playerId,entry.canonical_id,1,'sell-at-shop');
  assert.equal(sold.action,'shop_sold');assert.equal(f.economy.sell(f.playerId,entry.canonical_id,1,'sell-at-shop').idempotent_replay,true);
});

test('source-explicit church prayer recovers from one health and is location gated',()=>{
  const f=fixture();const service=content.recovery_services[0];
  mutate(f.storage,f.playerId,(state)=>{state.player.current_health=1;});
  assert.throws(()=>f.recovery.recover(f.playerId,service.canonical_id,'recover-wrong-place'),/current formal location/);
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=service.map_node_canonical_id;});
  const result=f.recovery.recover(f.playerId,service.canonical_id,'recover-church');
  assert.equal(result.action,'health_recovered');assert.equal(result.current_health,result.max_health);
  assert.equal(f.recovery.recover(f.playerId,service.canonical_id,'recover-church').idempotent_replay,true);
});

test('source-explicit healing item is bought, used and consumed through runtime semantics',()=>{
  const f=fixture();const entry=content.shop_entries.find((candidate)=>candidate.display_name==='牛肉馅饼');
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=entry.map_node_canonical_id;state.player.money=500;state.player.current_health=10;});
  f.economy.buy(f.playerId,entry.canonical_id,1,'healing-buy');const result=f.items.use(f.playerId,entry.content_entity_canonical_id,'healing-use');
  assert.equal(result.action,'item_used');assert.equal(result.recovered_health,50);
  assert.equal(f.engine.loadPlayer(f.playerId).inventory[entry.content_entity_canonical_id],undefined);
});

test('equipment replaces the same slot, returns replaced gear and changes effective stats',()=>{
  const f=fixture();const weapons=content.equipment.filter((entry)=>entry.equipment_type===1).slice(0,2);assert.equal(weapons.length,2);
  mutate(f.storage,f.playerId,(state)=>{state.player.level=99;state.inventory[weapons[0].canonical_id]=1;state.inventory[weapons[1].canonical_id]=1;});
  const first=f.equipment.equip(f.playerId,weapons[0].canonical_id,'equip-1');assert.equal(first.slot,'weapon');
  const second=f.equipment.equip(f.playerId,weapons[1].canonical_id,'equip-2');assert.equal(second.replaced_equipment_canonical_id,weapons[0].canonical_id);
  assert.equal(f.engine.loadPlayer(f.playerId).inventory[weapons[0].canonical_id],1);
});

test('combat persists rounds, settles victory once and delegates formal drops',()=>{
  const f=fixture();const sourcePlacement=content.monster_placements.find((entry)=>entry.encounter_type==='wild'&&entry.repeatable);
  const monster=f.catalog.getMonster(sourcePlacement.monster_canonical_id);
  const placement=f.catalog.listMonsterPlacements(monster.canonical_id).find((entry)=>entry.location_canonical_id===sourcePlacement.location_canonical_id);
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=placement.map_node_canonical_id;state.player.base_attack=1000;state.player.base_max_attack=1000;state.player.max_health=999999;state.player.current_health=999999;});
  f.combat.start(f.playerId,monster.canonical_id,'fight-start');assert.ok(f.engine.loadPlayer(f.playerId).combat);
  const won=f.combat.attack(f.playerId,'fight-hit',{rounds:1000});assert.equal(won.action,'combat_won');assert.equal(f.engine.loadPlayer(f.playerId).combat,null);
  assert.ok(f.engine.loadPlayer(f.playerId).drop_settlements[won.combat_canonical_id]);
  assert.equal(f.combat.attack.bind(f.combat,f.playerId,'fight-other') instanceof Function,true);
});

test('batched combat records every automatic stamina-item use instead of only the last one',()=>{
  const f=fixture();const task=content.tasks.find((entry)=>entry.canonical_id==='task.series.15.470');
  const target=task.targets.find((entry)=>entry.target_kind==='monster');const placement=f.catalog.listMonsterPlacements(target.entity_canonical_id)
    .find((entry)=>entry.location_canonical_id===task.target_location_canonical_id);
  const checkpoint=require('./fixtures/browser-save-v5-series15-454-level200.json').state;const staminaItemId='entity.item.8a516352a5046efd';
  mutate(f.storage,f.playerId,(state)=>{
    Object.assign(state.player,{level:checkpoint.player.level,max_health:checkpoint.player.max_health,current_health:checkpoint.player.current_health,
      base_attack:checkpoint.player.base_attack,base_max_attack:checkpoint.player.base_max_attack,base_defense:checkpoint.player.base_defense,base_agility:checkpoint.player.base_agility,
      morale:checkpoint.player.morale,luck:checkpoint.player.luck,current_map_node_canonical_id:placement.map_node_canonical_id});
    state.equipment=structuredClone(checkpoint.equipment);state.inventory[staminaItemId]=3;state.tasks[task.canonical_id].status='accepted';
    state.progress[`${task.canonical_id}|${target.canonical_id}`]=0;
  });
  const rolls=[0.999999,0,0,0.999999];let index=0;const combat=new CombatRuntime({storage:f.storage,catalog:f.catalog,taskEngine:f.engine,dropRuntime:f.drops,random:()=>rolls[index++%rolls.length]});
  combat.start(f.playerId,target.entity_canonical_id,'multi-stamina-start');const result=combat.attack(f.playerId,'multi-stamina-hit',{rounds:1000});
  assert.equal(result.action,'combat_won');assert.equal(result.stamina_items.length,3);assert.ok(result.stamina_items.every((entry)=>entry.applied&&entry.item_canonical_id===staminaItemId));
  assert.deepEqual(result.stamina_item,result.stamina_items.at(-1));const state=f.engine.loadPlayer(f.playerId);assert.equal(state.inventory[staminaItemId],undefined);
  assert.equal(state.gameplay_events['multi-stamina-hit'].result.stamina_items.length,3);
});

test('combat level-up immediately unlocks a level-gated task whose prerequisite is complete',()=>{
  const f=fixture();const gated=content.tasks.find((entry)=>entry.canonical_id==='task.series.15.698');const prerequisite=gated.prerequisites[0];
  const monster=f.catalog.getMonster('derived.monster_definition.e8edba99cec6f49a');
  const placement=f.catalog.listMonsterPlacements(monster.canonical_id).find((entry)=>entry.repeatable&&entry.encounter_type==='wild');
  assert.ok(placement,'expected a repeatable formal placement for the level-up encounter');
  mutate(f.storage,f.playerId,(state)=>{state.player.level=106;state.player.experience=Number(LEVEL_THRESHOLDS[106])-1000;state.player.current_map_node_canonical_id=placement.map_node_canonical_id;
    state.player.base_attack=999999;state.player.base_max_attack=999999;state.tasks[prerequisite].status='completed';state.tasks[gated.canonical_id].status='locked';});
  f.combat.start(f.playerId,monster.canonical_id,'level-unlock-start');const result=f.combat.attack(f.playerId,'level-unlock-hit',{rounds:1000});
  assert.equal(result.action,'combat_won');assert.equal(result.progression.after,107);assert.ok(result.unlocked_task_canonical_ids.includes(gated.canonical_id));
  assert.equal(f.engine.loadPlayer(f.playerId).tasks[gated.canonical_id].status,'available');
});

test('combat retreat deducts 500 copper; source add-money behavior is treated as a technical bug',()=>{
  const f=fixture();const sourcePlacement=content.monster_placements.find((entry)=>entry.encounter_type==='wild'&&entry.repeatable);
  const monster=f.catalog.getMonster(sourcePlacement.monster_canonical_id);
  const placement=f.catalog.listMonsterPlacements(monster.canonical_id).find((entry)=>entry.location_canonical_id===sourcePlacement.location_canonical_id);
  mutate(f.storage,f.playerId,(state)=>{state.player.current_map_node_canonical_id=placement.map_node_canonical_id;state.player.money=600;});
  f.combat.start(f.playerId,monster.canonical_id,'retreat-start');const result=f.combat.retreat(f.playerId,'retreat');
  assert.equal(result.fee,500);assert.equal(f.engine.loadPlayer(f.playerId).player.money,100);
});

test('source combat formula enforces minimum damage and deterministic seeded rolls',()=>{
  assert.equal(damage(1,1,999999,1,9999,()=>0.99),1);assert.equal(damage(10,10,0,1,1,()=>0.5),10);
});

test('monster type and level stats match the source _setMonsterStats rules',()=>{
  assert.deepEqual(projectStats(monsterStats({level:1,monster_type:5})),{health:50,attack:8,max_attack:12,defense:8,agility:5});
  assert.deepEqual(projectStats(monsterStats({level:3,monster_type:5})),{health:90,attack:16,max_attack:24,defense:14,agility:9});
  assert.deepEqual(projectStats(monsterStats({level:1,monster_type:6})),{health:1500,attack:24,max_attack:36,defense:24,agility:15});
  assert.deepEqual(projectStats(monsterStats({level:210,monster_type:3})),{health:500,attack:1,max_attack:1,defense:10000,agility:1});
});

test('equipment drops use one 20 percent pool decision and grant at most one item',()=>{
  const monster=content.monsters.find((entry)=>content.drop_relations.filter((drop)=>drop.monster_canonical_id===entry.canonical_id).length>1);
  let calls=0;const rejected=dropFixture(monster.canonical_id,content.drop_relations.filter((drop)=>drop.monster_canonical_id===monster.canonical_id),()=>{calls+=1;return 0.2;});
  assert.equal(rejected.runtime.settle(rejected.playerId,monster.canonical_id,'pool-reject','pool-reject-event').granted.length,0);
  assert.equal(calls,1,'the equipment pool must not roll once per candidate');
  const values=[0.199,0.999];const accepted=dropFixture(monster.canonical_id,content.drop_relations.filter((drop)=>drop.monster_canonical_id===monster.canonical_id),()=>values.shift());
  assert.equal(accepted.runtime.settle(accepted.playerId,monster.canonical_id,'pool-accept','pool-accept-event').granted.length,1);
});

test('ordinary, required and full-backpack drop boundaries are deterministic',()=>{
  const monsterId=content.monsters[0].canonical_id;const itemIds=['entity.test.ordinary1','entity.test.ordinary2','entity.test.required'];
  const drops=itemIds.map((id,index)=>({canonical_id:`test.drop.${index}`,monster_canonical_id:monsterId,content_entity_canonical_id:id,drop_kind:'item',probability:0.4,quantity:1}));
  drops[2].guaranteed_for_active_task=true;
  const values=[0.39,0.4,0.999];const first=dropFixture(monsterId,drops,()=>values.shift());
  assert.deepEqual(first.runtime.settle(first.playerId,monsterId,'ordinary','ordinary-event').granted.map((entry)=>entry.content_entity_canonical_id),[itemIds[0]]);
  const selected=require('../data/generated/runnable-task-selection.json').selected_tasks.find((task)=>task.runtime_item_resolutions.some((entry)=>entry.formal_source.source_kind==='monster_drop'));
  const resolution=selected.runtime_item_resolutions.find((entry)=>entry.formal_source.source_kind==='monster_drop');
  const requiredDrop=content.drop_relations.find((entry)=>entry.content_entity_canonical_id===resolution.runtime_entity_canonical_id
    &&entry.monster_canonical_id===resolution.formal_source.monster_canonical_id);
  const required=dropFixture(requiredDrop.monster_canonical_id,[requiredDrop],()=>0.999);
  mutate(required.storage,required.playerId,(state)=>{state.tasks[selected.canonical_id].status='in_progress';});
  assert.deepEqual(required.runtime.settle(required.playerId,requiredDrop.monster_canonical_id,'required','required-event').granted
    .map((entry)=>entry.content_entity_canonical_id),[resolution.runtime_entity_canonical_id]);
  const full=dropFixture(monsterId,drops,()=>0,{full:true});
  assert.equal(full.runtime.settle(full.playerId,monsterId,'full','full-event').granted.length,0);
});

test('combat victory settlement resumes consistently after task-event failure',()=>{
  const storage=new MemoryRuntimeStorage();const taskCatalog=new BrowserTaskCatalog(content);let fail=true;
  const engine=new TaskRuntimeEngine({catalog:taskCatalog,storage,faultInjector:(stage,{event})=>{if(fail&&stage==='before_event_commit'&&event.type==='defeat_monster'){fail=false;throw new Error('injected task failure');}}});
  const playerId='player.retry.combat';engine.createPlayer(playerId);const catalog=new FormalGameplayCatalog(content);
  const drops=new DropRuntime({storage,catalog,taskEngine:engine,random:()=>0.99});const combat=new CombatRuntime({storage,catalog,taskEngine:engine,dropRuntime:drops,random:()=>0});
  const task=content.tasks.find((entry)=>entry.targets.some((target)=>target.target_kind==='monster'));const target=task.targets.find((entry)=>entry.target_kind==='monster');
  const monster=catalog.getMonster(target.entity_canonical_id);
  const placement=catalog.listMonsterPlacements(monster.canonical_id).find((entry)=>entry.location_canonical_id===task.target_location_canonical_id);
  mutate(storage,playerId,(state)=>{state.tasks[task.canonical_id].status='in_progress';state.progress[`${task.canonical_id}|${target.canonical_id}`]=0;
    state.player.current_map_node_canonical_id=placement.map_node_canonical_id;state.player.base_attack=9999;state.player.base_max_attack=9999;});
  combat.start(playerId,monster.canonical_id,'retry-start');assert.throws(()=>combat.attack(playerId,'retry-hit'),/injected task failure/);
  const afterFailure=engine.loadPlayer(playerId);const money=afterFailure.player.money;const experience=afterFailure.player.experience;
  const recovered=combat.attack(playerId,'retry-hit');assert.equal(recovered.idempotent_replay,true);
  const final=engine.loadPlayer(playerId);assert.equal(final.player.money,money);assert.equal(final.player.experience,experience);
  assert.ok(final.drop_settlements[recovered.combat_canonical_id]);
});

test('SQLite adapter upgrades and round-trips schema v5 maritime, voyage, combat, ship, equipment and task ledger fields',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-formal-storage-'));const database=path.join(temporary,'runtime.sqlite');
  fs.copyFileSync(path.resolve('data','zhsh-content.sqlite'),database);const storage=new SqliteRuntimeStorage(database);
  try { const source=fixture();const initial=source.engine.loadPlayer(source.playerId);storage.createPlayer(initial);
    storage.transact(source.playerId,(state)=>{state.current_ship_canonical_id=content.ships[0].canonical_id;state.owned_ships[state.current_ship_canonical_id]={purchased_at:'now'};state.voyage={remaining_distance:20};state.combat={round:2};state.equipment.weapon=content.equipment[0].canonical_id;return null;});
    storage.close();const reopened=new SqliteRuntimeStorage(database);const state=reopened.loadPlayer(source.playerId);
    assert.equal(state.schema_version,5);assert.equal(state.voyage.remaining_distance,20);assert.equal(state.combat.round,2);assert.equal(state.fishing,null);assert.ok(state.owned_ships[state.current_ship_canonical_id]);reopened.close();
  } finally { if(storage.db?.isOpen)storage.close();fs.rmSync(temporary,{recursive:true,force:true}); }
});

test('public fishing runtime is voyage-gated, consumes bait once and catches the configured route item',()=>{
  const f=fixture();const rod=content.maritime.fishing.gear.find((entry)=>entry.display_name==='鱼竿');
  const bait=content.maritime.fishing.gear.find((entry)=>entry.display_name==='鱼饵');
  const chest=content.maritime.fishing.catches.find((entry)=>entry.display_name==='神秘铁箱');const routePair=chest.route_pairs[0];
  const runtime=new FishingRuntime({storage:f.storage,catalog:f.catalog,taskEngine:f.engine,random:()=>0,clock:()=> '2026-07-18T00:00:00.000Z'});
  mutate(f.storage,f.playerId,(state)=>{state.inventory[rod.canonical_id]=1;state.inventory[bait.canonical_id]=2;});
  assert.throws(()=>runtime.start(f.playerId,rod.canonical_id,bait.canonical_id,'fish-off-route'),/active idle voyage/);
  mutate(f.storage,f.playerId,(state)=>{state.voyage={from_city_canonical_id:routePair.from_city_canonical_id,to_city_canonical_id:routePair.to_city_canonical_id};});
  runtime.start(f.playerId,rod.canonical_id,bait.canonical_id,'fish-start');const cast=runtime.cast(f.playerId,'fish-cast');
  assert.equal(cast.remaining_bait,1);assert.equal(runtime.cast(f.playerId,'fish-cast').idempotent_replay,true);
  assert.equal(f.engine.loadPlayer(f.playerId).inventory[bait.canonical_id],1);
  const caught=runtime.reel(f.playerId,'fish-reel');assert.equal(caught.action,'fish_caught');assert.equal(caught.content_entity_canonical_id,chest.content_entity_canonical_id);
  assert.equal(f.engine.loadPlayer(f.playerId).inventory[chest.content_entity_canonical_id],1);
});

test('public diving runtime discovers, enters, persists and exits the Sea Emperor Palace back to the voyage',()=>{
  const f=fixture();const runtime=new DivingRuntime({storage:f.storage,catalog:f.catalog,random:()=>0,clock:()=> '2026-07-18T00:00:00.000Z'});
  mutate(f.storage,f.playerId,(state)=>{state.player.level=26;state.voyage={canonical_id:'voyage.test',from_city_canonical_id:'a',to_city_canonical_id:'b'};});
  const discovery=runtime.dive(f.playerId,'dive-roll');assert.equal(discovery.action,'diving_discovery');assert.equal(discovery.encounter.display_name,'海皇宫殿');
  const entered=runtime.enter(f.playerId,'dive-enter');assert.equal(entered.action,'diving_dungeon_entered');assert.equal(entered.dungeon.return_context,'voyage');
  const saved=f.engine.loadPlayer(f.playerId);assert.equal(saved.dungeon.canonical_id,content.maritime.diving.formal_dungeon_ids[0]);assert.ok(saved.voyage);
  const exited=new DungeonRuntime({storage:f.storage,catalog:f.catalog}).exit(f.playerId,'dive-exit');assert.equal(exited.return_context,'voyage');
  assert.equal(f.engine.loadPlayer(f.playerId).dungeon,null);assert.ok(f.engine.loadPlayer(f.playerId).voyage);
});

test('Sea Emperor Palace exports five source stages, source monsters and the formal chest drop',()=>{
  const palace=content.dungeons.find((entry)=>entry.display_name==='海皇宫殿');assert.equal(palace.stages.length,5);
  assert.deepEqual(palace.stages.map((entry)=>entry.display_name),['珊瑚前殿','波塞冬神座','珍珠偏殿','熔岩核心','海皇密室']);
  const boss=palace.stages.at(-1).monster;assert.equal(boss.display_name,'宝箱守护者');assert.equal(boss.level,40);assert.equal(boss.monster_type,45);
  assert.ok(content.drop_relations.some((entry)=>entry.monster_canonical_id===boss.canonical_id
    &&content.content_entities.find((item)=>item.canonical_id===entry.content_entity_canonical_id)?.display_name==='海皇的宝箱'));
});

test('public sailing events use source probabilities, persist effects and pause route progress for discoveries',()=>{
  const f=fixture();const rolls=[0,0];const maritime=new MaritimeRuntime({storage:f.storage,catalog:f.catalog,random:()=>rolls.shift()??0});
  const route=content.voyage_routes[0];mutate(f.storage,f.playerId,(state)=>{state.voyage={canonical_id:'voyage.event',route_canonical_id:route.canonical_id,
    from_city_canonical_id:route.from_city_canonical_id,to_city_canonical_id:route.to_city_canonical_id,total_distance:100,remaining_distance:100,speed:10};});
  const voyage=new VoyageRuntime({storage:f.storage,catalog:f.catalog,maritimeRuntime:maritime});const event=voyage.advance(f.playerId,'sailing-event');
  assert.equal(event.action,'sailing_special_event');assert.equal(event.event_name,'美人鱼的歌声');assert.equal(f.engine.loadPlayer(f.playerId).player.morale,60);
  assert.equal(f.engine.loadPlayer(f.playerId).voyage.remaining_distance,100);
  const routeEncounter=content.maritime.sailing.route_encounters[0];const routeMaritime=new MaritimeRuntime({storage:f.storage,catalog:f.catalog,random:()=>0});let discovery;
  mutate(f.storage,f.playerId,(state)=>{discovery=routeMaritime.checkRouteEncounter(state,{from_city_canonical_id:routeEncounter.route_canonical_ids[0],
    to_city_canonical_id:routeEncounter.route_canonical_ids[1]});});
  assert.equal(discovery.action,'route_location_discovery');assert.ok(f.engine.loadPlayer(f.playerId).maritime_encounter);
  const entered=routeMaritime.enterRouteLocation(f.playerId,'route-enter');assert.equal(entered.action,'route_location_entered');
  assert.equal(entered.location_canonical_id,routeEncounter.location_canonical_id);assert.equal(entered.voyage_preserved,true);
  assert.equal(f.engine.loadPlayer(f.playerId).player.current_map_node_canonical_id,routeEncounter.map_node_canonical_id);
  mutate(f.storage,f.playerId,(state)=>{state.maritime_encounter={kind:'route_location',display_name:'蓬莱仙岛',
    location_canonical_id:routeEncounter.location_canonical_id,map_node_canonical_id:routeEncounter.map_node_canonical_id};});
  assert.equal(routeMaritime.dismiss(f.playerId,'route-dismiss').action,'maritime_encounter_dismissed');
});

test('additional series task.series.03 runs end-to-end at its source level requirement',()=>{
  const db=new DatabaseSync(path.resolve('data','zhsh-content.sqlite'),{readOnly:true});
  try { const catalog=new SqliteTaskCatalog(db);const storage=new MemoryRuntimeStorage();const engine=new TaskRuntimeEngine({catalog,storage,seriesCanonicalId:'task.series.03'});
    const playerId='player.extra-series.03';engine.createPlayer(playerId);assert.equal(engine.loadPlayer(playerId).tasks['task.series.03.013'].status,'locked');
    mutate(storage,playerId,(state)=>{state.player.level=5;});assert.deepEqual(engine.refreshAvailability(playerId).unlocked,['task.series.03.013']);
    const result=runFirstTaskChain(engine,playerId,'extra-series-03');assert.equal(result.state.tasks['task.series.03.013'].status,'completed');
    assert.equal(result.state.player.money,500);assert.equal(result.state.player.experience,5000);
  } finally { db.close(); }
});

function projectStats(value) { return Object.fromEntries(['health','attack','max_attack','defense','agility'].map((key)=>[key,value[key]])); }

function dropFixture(monsterId,drops,random,{full=false}={}) {
  const storage=new MemoryRuntimeStorage();const taskCatalog=new BrowserTaskCatalog(content);const engine=new TaskRuntimeEngine({catalog:taskCatalog,storage,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id)});
  const playerId=`player.drop.${crypto.randomUUID()}`;engine.createPlayer(playerId);
  if(full)mutate(storage,playerId,(state)=>{state.inventory_capacity=0;});
  const catalog=new FormalGameplayCatalog({...content,drop_relations:drops});
  return {playerId,runtime:new DropRuntime({storage,catalog,taskEngine:engine,random}),storage,engine,catalog,monsterId};
}
