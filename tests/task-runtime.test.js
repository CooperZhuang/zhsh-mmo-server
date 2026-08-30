'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { after,before,test } = require('node:test');
const {
  MemoryRuntimeStorage,
  SqliteRuntimeStorage,
  SqliteTaskCatalog,
  TaskRuntimeEngine,
} = require('../src/task-runtime');
const { runFirstTaskChain,runTaskSequence } = require('../src/task-runtime/first-chain-driver');

const sourceDatabase = path.resolve('data','zhsh-content.sqlite');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-task-runtime-'));
const runtimeDatabase = path.join(temporaryRoot,'runtime.sqlite');
let catalogDb;
let catalog;
let playerSequence = 0;

before(() => {
  if (!fs.existsSync(sourceDatabase)) throw new Error(`Existing static database is required: ${sourceDatabase}`);
  fs.copyFileSync(sourceDatabase,runtimeDatabase);
  catalogDb = new DatabaseSync(sourceDatabase,{ readOnly:true });
  catalogDb.exec('PRAGMA foreign_keys=ON');
  catalog = new SqliteTaskCatalog(catalogDb);
});
after(() => {
  catalogDb?.close();
  fs.rmSync(temporaryRoot,{ recursive:true,force:true });
});

function memoryEngine(options = {}) {
  const storage = new MemoryRuntimeStorage();
  const engine = new TaskRuntimeEngine({ catalog,storage,clock:() => '2026-07-17T00:00:00.000Z',...options });
  const playerId = `player.memory.${playerSequence += 1}`;
  engine.createPlayer(playerId);
  return { engine,storage,playerId };
}

function projectState(state) {
  return {
    current_map_node_canonical_id: state.player.current_map_node_canonical_id,
    money: state.player.money,
    experience: state.player.experience,
    tasks: state.tasks,
    progress: state.progress,
    inventory: state.inventory,
    reward_grants: state.reward_grants,
    flags: state.flags,
  };
}

test('1. task1 exactly loads 13 tasks with original content, source state and canonical ids',() => {
  const tasks = catalog.listSeriesTasks('task.series.01');
  assert.equal(tasks.length,13);
  for (const task of tasks) {
    assert.match(task.canonical_id,/^task\.series\.01\./);
    assert.ok(task.display_name && task.description && task.raw_value && task.normalized_value);
    assert.equal(task.steps.length,3);
    assert.ok(task.dialogues.length > 0);
    assert.ok(task.restoration_status);
    assert.ok(task.source_canonical_id);
  }
});

test('2. first task is available and accepting it requires the exact issuer at the current location',() => {
  const { engine,playerId } = memoryEngine();
  const first = catalog.listSeriesTasks('task.series.01')[0];
  const result = engine.processEvent(playerId,{ event_id:'accept-1',type:'talk_to_npc',npc_canonical_id:first.issuer_npc_canonical_id,location_canonical_id:first.receive_location_canonical_id });
  assert.equal(result.action,'accepted');
  assert.equal(engine.loadPlayer(playerId).tasks[first.canonical_id].status,'accepted');
});

test('3. a task with an unmet explicit prerequisite cannot be accepted',() => {
  const { engine,playerId } = memoryEngine();
  const second = catalog.listSeriesTasks('task.series.01')[1];
  engine.processEvent(playerId,{ event_id:'arrive-second',type:'arrive_at_location',location_canonical_id:second.receive_location_canonical_id });
  const result = engine.processEvent(playerId,{ event_id:'try-second',type:'talk_to_npc',npc_canonical_id:second.issuer_npc_canonical_id,location_canonical_id:second.receive_location_canonical_id });
  assert.equal(result.applied,false);
  assert.equal(engine.loadPlayer(playerId).tasks[second.canonical_id].status,'locked');
});

test('4. wrong NPC and wrong location are rejected without progress',() => {
  const { engine,playerId } = memoryEngine();
  const first = catalog.listSeriesTasks('task.series.01')[0];
  assert.throws(() => engine.processEvent(playerId,{ event_id:'wrong-npc',type:'talk_to_npc',npc_canonical_id:first.completion_npc_canonical_id,location_canonical_id:first.receive_location_canonical_id }),/NPC is not at/);
  assert.throws(() => engine.processEvent(playerId,{ event_id:'wrong-location',type:'talk_to_npc',npc_canonical_id:first.issuer_npc_canonical_id,location_canonical_id:first.submit_location_canonical_id }),/does not match/);
  assert.equal(engine.loadPlayer(playerId).tasks[first.canonical_id].status,'available');
});

test('5. talk, kill, item and arrival events use resolved formal entities',() => {
  const { engine,playerId } = memoryEngine();
  const result = runFirstTaskChain(engine,playerId,'event-types');
  const types = new Set(result.events.map((entry) => entry.event.type));
  for (const type of ['talk_to_npc','defeat_monster','obtain_item','arrive_at_location','submit_to_npc']) assert.ok(types.has(type));
  assert.ok(result.events.every((entry) => Object.keys(entry.event).some((key) => key.endsWith('_canonical_id'))));
});

test('6. a kill objective below its original normalized quantity is not completable',() => {
  const { engine,playerId } = memoryEngine();
  const tasks = catalog.listSeriesTasks('task.series.01');
  runTaskSequence(engine,playerId,tasks.slice(0,2),'quantity-prefix');
  const task = tasks[2];
  engine.processEvent(playerId,{ event_id:'q-arrive-issuer',type:'arrive_at_location',location_canonical_id:task.receive_location_canonical_id });
  engine.processEvent(playerId,{ event_id:'q-accept',type:'talk_to_npc',npc_canonical_id:task.issuer_npc_canonical_id,location_canonical_id:task.receive_location_canonical_id });
  engine.processEvent(playerId,{ event_id:'q-arrive-target',type:'arrive_at_location',location_canonical_id:task.target_location_canonical_id });
  engine.processEvent(playerId,{ event_id:'q-kill-2',type:'defeat_monster',monster_canonical_id:task.targets[0].entity_canonical_id,location_canonical_id:task.target_location_canonical_id,quantity:2 });
  assert.equal(engine.loadPlayer(playerId).tasks[task.canonical_id].status,'in_progress');
});

test('7. the exact completion NPC submits a completable task and unlocks only its explicit successor',() => {
  const { engine,playerId } = memoryEngine();
  const tasks = catalog.listSeriesTasks('task.series.01');
  runTaskSequence(engine,playerId,tasks.slice(0,1),'submit-one');
  const state = engine.loadPlayer(playerId);
  assert.equal(state.tasks[tasks[0].canonical_id].status,'completed');
  assert.equal(state.tasks[tasks[1].canonical_id].status,'available');
  assert.equal(state.tasks[tasks[2].canonical_id].status,'locked');
});

test('8. rewards are granted once and a replayed submit event is idempotent',() => {
  const { engine,playerId } = memoryEngine();
  const first = catalog.listSeriesTasks('task.series.01')[0];
  const run = runTaskSequence(engine,playerId,[first],'reward-once');
  const submit = run.events.find((entry) => entry.event.type === 'submit_to_npc').event;
  const before = engine.loadPlayer(playerId);
  const replay = engine.processEvent(playerId,submit);
  const after = engine.loadPlayer(playerId);
  assert.equal(replay.idempotent_replay,true);
  assert.equal(after.player.money,before.player.money);
  assert.equal(after.player.experience,before.player.experience);
  assert.equal(Object.keys(after.reward_grants).length,Object.keys(before.reward_grants).length);
});

test('9. repeated objective event id does not accumulate progress twice',() => {
  const { engine,playerId } = memoryEngine();
  const tasks = catalog.listSeriesTasks('task.series.01');
  runTaskSequence(engine,playerId,tasks.slice(0,2),'repeat-prefix');
  const task = tasks[2];
  engine.processEvent(playerId,{ event_id:'repeat-arrive-issuer',type:'arrive_at_location',location_canonical_id:task.receive_location_canonical_id });
  engine.processEvent(playerId,{ event_id:'repeat-accept',type:'talk_to_npc',npc_canonical_id:task.issuer_npc_canonical_id,location_canonical_id:task.receive_location_canonical_id });
  engine.processEvent(playerId,{ event_id:'repeat-arrive-target',type:'arrive_at_location',location_canonical_id:task.target_location_canonical_id });
  const event = { event_id:'same-kill',type:'defeat_monster',monster_canonical_id:task.targets[0].entity_canonical_id,location_canonical_id:task.target_location_canonical_id,quantity:1 };
  engine.processEvent(playerId,event);
  engine.processEvent(playerId,event);
  assert.equal(engine.loadPlayer(playerId).progress[`${task.canonical_id}|${task.targets[0].canonical_id}`],1);
});

test('10. consume_item removes only a defined item and is itself replay safe',() => {
  const { engine,playerId } = memoryEngine();
  const item = catalog.listSeriesTasks('task.series.01')[8].targets[0].entity_canonical_id;
  const location = engine.getCurrentLocation(playerId).location_canonical_id;
  engine.processEvent(playerId,{ event_id:'obtain-consume',type:'obtain_item',item_canonical_id:item,location_canonical_id:location,quantity:2 });
  const consume = { event_id:'consume-once',type:'consume_item',item_canonical_id:item,location_canonical_id:location,quantity:1 };
  engine.processEvent(playerId,consume);
  engine.processEvent(playerId,consume);
  assert.equal(engine.loadPlayer(playerId).inventory[item],1);
});

test('11. SQLite save and reopen restores exact progress and inventory state',() => {
  const playerId = `player.sqlite.reload.${playerSequence += 1}`;
  let storage = new SqliteRuntimeStorage(runtimeDatabase);
  let engine = new TaskRuntimeEngine({ catalog:new SqliteTaskCatalog(storage.db),storage,clock:() => '2026-07-17T00:00:00.000Z' });
  engine.createPlayer(playerId);
  const first = engine.catalog.listSeriesTasks('task.series.01')[0];
  engine.processEvent(playerId,{ event_id:'reload-accept',type:'talk_to_npc',npc_canonical_id:first.issuer_npc_canonical_id,location_canonical_id:first.receive_location_canonical_id });
  const before = projectState(engine.loadPlayer(playerId));
  storage.close();
  storage = new SqliteRuntimeStorage(runtimeDatabase);
  engine = new TaskRuntimeEngine({ catalog:new SqliteTaskCatalog(storage.db),storage,clock:() => '2026-07-17T00:00:00.000Z' });
  assert.deepEqual(projectState(engine.loadPlayer(playerId)),before);
  storage.close();
});

test('12. a fault after item consumption rolls back item, task and reward changes',() => {
  const storage = new SqliteRuntimeStorage(runtimeDatabase);
  const localCatalog = new SqliteTaskCatalog(storage.db);
  const playerId = `player.sqlite.rollback.${playerSequence += 1}`;
  let engine = new TaskRuntimeEngine({ catalog:localCatalog,storage,clock:() => '2026-07-17T00:00:00.000Z' });
  engine.createPlayer(playerId);
  const tasks = localCatalog.listSeriesTasks('task.series.01');
  runTaskSequence(engine,playerId,tasks.slice(0,8),'rollback-prefix');
  const task = tasks[8];
  engine.processEvent(playerId,{ event_id:'rb-arrive',type:'arrive_at_location',location_canonical_id:task.receive_location_canonical_id });
  engine.processEvent(playerId,{ event_id:'rb-accept',type:'talk_to_npc',npc_canonical_id:task.issuer_npc_canonical_id,location_canonical_id:task.receive_location_canonical_id });
  engine.processEvent(playerId,{ event_id:'rb-obtain',type:'obtain_item',item_canonical_id:task.targets[0].entity_canonical_id,location_canonical_id:task.receive_location_canonical_id,quantity:1 });
  engine = new TaskRuntimeEngine({ catalog:localCatalog,storage,clock:() => '2026-07-17T00:00:00.000Z',faultInjector:(stage) => { if (stage === 'after_task_item_consumption') throw new Error('injected rollback'); } });
  assert.throws(() => engine.processEvent(playerId,{ event_id:'rb-submit',type:'submit_to_npc',npc_canonical_id:task.completion_npc_canonical_id,location_canonical_id:task.submit_location_canonical_id }),/injected rollback/);
  const state = engine.loadPlayer(playerId);
  assert.equal(state.inventory[task.targets[0].entity_canonical_id],1);
  assert.equal(state.tasks[task.canonical_id].status,'completable');
  assert.equal(state.tasks[task.canonical_id].reward_status,'not_granted');
  storage.close();
});

test('13. task1 explicit prerequisite graph is acyclic',() => {
  const tasks = catalog.listSeriesTasks('task.series.01');
  const byId = new Map(tasks.map((task) => [task.canonical_id,task]));
  for (const task of tasks) {
    const seen = new Set();
    let current = task;
    while (current.prerequisites.length) {
      assert.equal(seen.has(current.canonical_id),false,`cycle at ${current.canonical_id}`);
      seen.add(current.canonical_id);
      current = byId.get(current.prerequisites[0]);
    }
  }
});

test('14. no cross-series prerequisite was generated',() => assert.equal(catalog.countCrossSeriesPrerequisites(),0));

test('15. all 32 restoration conflicts remain unresolved',() => assert.equal(catalog.countUnresolvedConflicts(),32));

test('16. runtime SQLite database has zero foreign-key violations',() => {
  const db = new DatabaseSync(runtimeDatabase,{ readOnly:true });
  try { assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]); } finally { db.close(); }
});

test('17. memory and SQLite adapters produce the same task result',() => {
  const memory = memoryEngine();
  runFirstTaskChain(memory.engine,memory.playerId,'adapter-memory');
  const sqliteStorage = new SqliteRuntimeStorage(runtimeDatabase);
  const sqliteCatalog = new SqliteTaskCatalog(sqliteStorage.db);
  const sqliteEngine = new TaskRuntimeEngine({ catalog:sqliteCatalog,storage:sqliteStorage,clock:() => '2026-07-17T00:00:00.000Z' });
  const sqlitePlayer = `player.sqlite.adapter.${playerSequence += 1}`;
  sqliteEngine.createPlayer(sqlitePlayer);
  runFirstTaskChain(sqliteEngine,sqlitePlayer,'adapter-sqlite');
  assert.deepEqual(projectState(sqliteEngine.loadPlayer(sqlitePlayer)),projectState(memory.engine.loadPlayer(memory.playerId)));
  sqliteStorage.close();
});

test('18. all 13 first-chain tasks run from available to completed',() => {
  const { engine,playerId } = memoryEngine();
  runFirstTaskChain(engine,playerId,'complete-all');
  const state = engine.loadPlayer(playerId);
  assert.equal(Object.values(state.tasks).filter((task) => task.status === 'completed').length,13);
  assert.equal(state.player.money,2900);
  assert.equal(state.player.experience,29000);
});

test('19. reputation rewards stay auditable, apply to reputation, and never fabricate inventory items',() => {
  const { engine,playerId } = memoryEngine();
  runFirstTaskChain(engine,playerId,'source-label-ledger');
  const state = engine.loadPlayer(playerId);
  const appliedGrants = Object.values(state.reward_grants).filter((grant) => grant.effect_status === 'applied');
  assert.equal(appliedGrants.length,39);
  assert.equal(Object.keys(state.inventory).length,0);
  assert.equal(state.player.reputation,21);
  assert.ok(Object.values(state.tasks).every((task) => ['granted','granted_with_source_label_records'].includes(task.reward_status)));
});

test('20. adjacent move follows a stored connection and current-location NPC query uses placements',() => {
  const { engine,playerId } = memoryEngine();
  const firstHop = engine.listAdjacentLocations(playerId)[0];
  const move = engine.move(playerId,firstHop.map_node_canonical_id,'move-connection');
  assert.equal(move.movement_connection_canonical_id,firstHop.connection_canonical_id);
  const welfare = catalog.getNodeForLocation(catalog.listSeriesTasks('task.series.01')[0].submit_location_canonical_id);
  const secondMove = engine.move(playerId,welfare.map_node_canonical_id,'move-welfare');
  assert.equal(secondMove.current_map_node_canonical_id,welfare.map_node_canonical_id);
  assert.ok(engine.listCurrentNpcs(playerId).length > 0);
});

test('21. cross-city source movement starts and lands at formal ports without a global unlock table',()=>{
  const {engine,storage,playerId}=memoryEngine();
  const ports=catalogDb.prepare(`
    SELECT mn.canonical_id map_node_canonical_id,c.canonical_id city_canonical_id
    FROM map_nodes mn JOIN locations l ON l.id=mn.location_id JOIN cities c ON c.id=l.city_id
    WHERE l.display_name='码头' ORDER BY c.canonical_id LIMIT 2
  `).all();
  assert.equal(ports.length,2);storage.transact(playerId,(state)=>{state.player.current_map_node_canonical_id=ports[0].map_node_canonical_id;return null;});
  const result=engine.travelToCityPort(playerId,ports[1].map_node_canonical_id,'city-port-transfer');
  assert.equal(result.movement_mode,'cross_city_port');assert.equal(result.source_city_canonical_id,ports[0].city_canonical_id);assert.equal(result.destination_city_canonical_id,ports[1].city_canonical_id);
  assert.equal(engine.loadPlayer(playerId).player.current_map_node_canonical_id,ports[1].map_node_canonical_id);
  assert.equal(engine.travelToCityPort(playerId,ports[1].map_node_canonical_id,'city-port-transfer').idempotent_replay,true);
  const nonPort=catalog.listSeriesTasks('task.series.01')[0].receive_location_canonical_id;
  storage.transact(playerId,(state)=>{state.player.current_map_node_canonical_id=catalog.getNodeForLocation(nonPort).map_node_canonical_id;return null;});
  assert.throws(()=>engine.travelToCityPort(playerId,ports[0].map_node_canonical_id,'city-port-invalid'),/must start at the current city port/);
});

test('22. runtime state tables do not duplicate task, NPC or location text fields',() => {
  const db = new DatabaseSync(runtimeDatabase,{ readOnly:true });
  try {
    for (const table of ['player_profiles','player_tasks','player_task_progress','player_inventory','player_reward_grants']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      assert.equal(columns.some((name) => /display_name|description|original_text|npc_name|location_name/.test(name)),false,table);
    }
  } finally { db.close(); }
});

test('22. event id collision with a different payload is rejected',() => {
  const { engine,playerId } = memoryEngine();
  const location = engine.getCurrentLocation(playerId).location_canonical_id;
  const item = catalog.listSeriesTasks('task.series.01')[8].targets[0].entity_canonical_id;
  engine.processEvent(playerId,{ event_id:'collision',type:'obtain_item',item_canonical_id:item,location_canonical_id:location,quantity:1 });
  assert.throws(() => engine.processEvent(playerId,{ event_id:'collision',type:'obtain_item',item_canonical_id:item,location_canonical_id:location,quantity:2 }),/collision/);
  assert.equal(engine.loadPlayer(playerId).inventory[item],1);
});
