'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  BrowserRuntimeStorage,BrowserTaskCatalog,MemoryRuntimeStorage,
  SqliteRuntimeStorage,SqliteTaskCatalog,TaskRuntimeEngine,UiFeedback,buildCityMapEntries,
} = require('../src/task-runtime');
const { runFirstTaskChain } = require('../src/task-runtime/first-chain-driver');
const { exportTask1Content } = require('../scripts/export-task1-content');
const { createDeterministicZip } = require('../scripts/package-runnable-task-expansion');

const content = JSON.parse(fs.readFileSync(path.resolve('web','generated','task1-content.json'),'utf8'));
const browserCatalog = new BrowserTaskCatalog(content);

test('classic UI feedback preserves failures through render reads and clears them only after success',() => {
  const feedback = new UiFeedback();
  feedback.succeed('旧成功消息');
  feedback.fail(new Error('存档写入失败'));
  assert.deepEqual(feedback.snapshot(),{ message:'',error:'存档写入失败' });
  assert.deepEqual(feedback.snapshot(),{ message:'',error:'存档写入失败' });
  feedback.succeed('存档已恢复');
  assert.deepEqual(feedback.snapshot(),{ message:'存档已恢复',error:'' });
});

test('city map model shows the full current-city overview but enables only formal adjacent moves',async () => {
  const { engine,playerId } = await browserEngine('player.browser.map-overview');
  const current = engine.getCurrentLocation(playerId);
  const adjacent = engine.listAdjacentLocations(playerId);
  const entries = buildCityMapEntries(content,current,adjacent);
  const cityNodeCount = content.map_nodes.filter((node) => node.city_canonical_id === current.city_canonical_id).length;
  assert.equal(entries.length,cityNodeCount);
  assert.equal(entries.filter((entry) => entry.is_current).length,1);
  assert.deepEqual(entries.filter((entry) => entry.can_move).map((entry) => entry.map_node_canonical_id).sort(),
    adjacent.map((entry) => entry.map_node_canonical_id).sort());
  assert.ok(entries.some((entry) => !entry.is_current && !entry.can_move),'overview must include a non-teleportable city location');
});

test('browser UI uses the user-confirmed classic mobile equivalent page structure',() => {
  const appSource = fs.readFileSync(path.resolve('web','app.js'),'utf8');
  const styles = fs.readFileSync(path.resolve('web','styles.css'),'utf8');
  const index = fs.readFileSync(path.resolve('web','index.html'),'utf8');
  assert.match(appSource,/梦想的驱动，财富的蛊惑/);
  assert.match(appSource,/location:renderLocationPage,map:renderMapPage,world:renderWorldPage,npc:renderNpcPage/);
  assert.match(appSource,/backpack:renderBackpackPage,item:renderItemDetailPage,encounter:renderFormalEncounterPage,shop:renderFormalShopPage,voyage:renderFormalVoyagePage/);
  assert.match(appSource,/class="current-location"/);
  assert.match(appSource,/const npcCanonicalId = page\.npcId/);
  assert.match(appSource,/getAttribute\('data-npc-id'\)/);
  assert.match(appSource,/app\.addEventListener\('click'/);
  assert.match(appSource,/captureMode \? 'player\.browser\.task1\.uat-capture' : 'player\.browser\.task1'/);
  assert.match(appSource,/!equipmentIds\.has\(id\)&&Number\(gameplayCatalog\.getItem\(id\)\?\.normalized_data\?\.type\)===4/);
  assert.match(appSource,/__ZHSH_UAT_FISHING_RANDOM__/);
  assert.match(appSource,/data-page="npc" data-npc-id/);
  assert.match(appSource,/data-page="task" data-task-id/);
  assert.match(appSource,/data-shop-buy/);
  assert.match(appSource,/data-shop-sell/);
  assert.match(appSource,/data-recovery/);
  assert.match(appSource,/listMonstersAtMapNode/);
  assert.match(appSource,/data-dungeon-enter/);
  assert.match(appSource,/data-equip-item/);
  assert.match(appSource,/data-unequip-slot/);
  assert.doesNotMatch(appSource,/PreviewEncounterProvider|PreviewTravelProvider|renderEncounterPage|renderShopPage|renderVoyagePage/);
  assert.doesNotMatch(appSource,/\.train\s*\(/);
  assert.doesNotMatch(appSource,/\/(?:13|25)(?:<|\s)/);
  assert.match(styles,/max-width:420px/);
  assert.match(styles,/button\.text-link[\s\S]*color:var\(--link\)[\s\S]*text-decoration:underline/);
  assert.doesNotMatch(styles,/grid-template-columns|border-radius|\.panel|\.card/);
  assert.doesNotMatch(index,/PROVISIONAL_TECHNICAL_UI/);
  assert.doesNotMatch(index,/经典手机版等价复原 · 非像素级原版复刻/);
});

test('real 390x844 browser QA keeps a usable wap page and wrapping reward text',() => {
  const qa = JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','browser-free-encounter-qa.json'),'utf8'));
  assert.deepEqual(qa.viewport,{ width:390,height:844 });
  for (const page of qa.pages) {
    assert.equal(page.layout.viewport_width,390,page.page);
    assert.ok(page.layout.body_client_width>=350,page.page);
    assert.equal(page.layout.wap_page_client_width,page.layout.body_client_width,page.page);
    assert.ok(page.layout.document_scroll_width<=page.layout.viewport_width,page.page);
    assert.equal(page.layout.horizontal_overflow,false,page.page);
  }
  const encounter = qa.pages.find((page) => page.page === 'free_encounters');
  assert.ok(encounter);
  assert.deepEqual(encounter.reward_text_constraint.computed_style,{
    overflow_wrap:'anywhere',word_break:'break-all',white_space:'normal',
  });
  assert.ok(encounter.reward_text_constraint.rows.every((row) => row.scroll_width<=row.client_width));
});

test('final review ZIP uses deterministic DEFLATE compression',() => {
  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-deflate-test-'));
  const source=path.join(temporaryRoot,'source');
  const first=path.join(temporaryRoot,'first.zip');
  const second=path.join(temporaryRoot,'second.zip');
  try {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source,'repeatable.txt'),'纵横四海'.repeat(1024),'utf8');
    createDeterministicZip(source,first);
    createDeterministicZip(source,second);
    const firstBytes=fs.readFileSync(first);
    assert.deepEqual(firstBytes,fs.readFileSync(second));
    assert.equal(firstBytes.readUInt16LE(8),8,'ZIP local header must use DEFLATE');
    assert.ok(firstBytes.readUInt32LE(18)<firstBytes.readUInt32LE(22),'fixture must be compressed');
  } finally { fs.rmSync(temporaryRoot,{recursive:true,force:true}); }
});

class FakeDurableStore {
  constructor(records = []) { this.records = new Map(records.map((record) => [record.player_canonical_id,structuredClone(record)]));this.putCount=0; }
  async list() { return [...this.records.values()].map((record) => structuredClone(record)); }
  async put(record) { this.putCount+=1;this.records.set(record.player_canonical_id,structuredClone(record)); }
  close() {}
}

async function browserEngine(playerId = 'player.browser.test') {
  const durableStore = new FakeDurableStore();
  const storage = new BrowserRuntimeStorage({ durableStore });
  await storage.ready();
  const engine = new TaskRuntimeEngine({ catalog:browserCatalog,storage,clock:() => '2026-07-17T00:00:00.000Z' });
  engine.createPlayer(playerId);
  await storage.flush();
  return { durableStore,engine,playerId,storage };
}

function projection(state) {
  return { current_map_node_canonical_id:state.player.current_map_node_canonical_id,money:state.player.money,experience:state.player.experience,
    tasks:state.tasks,progress:state.progress,inventory:state.inventory,reward_grants:state.reward_grants,flags:state.flags };
}

test('browser content export is deterministic, traceable and matches the runnable selector',() => {
  const temporary = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-task1-export-')),'task1.json');
  try {
    const first = exportTask1Content({ outputPath:temporary });
    const firstBytes = fs.readFileSync(temporary);
    const second = exportTask1Content({ outputPath:temporary });
    assert.deepEqual(fs.readFileSync(temporary),firstBytes);
    assert.equal(first.content_sha256,second.content_sha256);
    assert.equal(first.tasks.length,first.runnable_task_selection.selected_task_count);
    assert.equal(first.series.length,first.runnable_task_selection.selected_series_count);
    assert.ok(first.tasks.length>=50);
    assert.ok(first.locations.length < 641);
    assert.ok(first.tasks.every((task) => task.source_canonical_id && task.steps.every((step) => step.source_canonical_id)
      && task.targets.every((target) => target.source_canonical_id) && task.rewards.every((reward) => reward.source_canonical_id)));
    assert.ok(first.location_connections.every((edge) => edge.source_canonical_id && edge.runtime_capability === 'queryable'));
  } finally { fs.rmSync(path.dirname(temporary),{ recursive:true,force:true }); }
});

test('browser storage creates, atomically saves, reloads, resets, exports and imports a player',async () => {
  const { durableStore,engine,playerId,storage } = await browserEngine();
  const first = browserCatalog.listSeriesTasks('task.series.01')[0];
  engine.processEvent(playerId,{ event_id:'accept',type:'talk_to_npc',npc_canonical_id:first.issuer_npc_canonical_id,location_canonical_id:first.receive_location_canonical_id });
  await storage.flush();
  const reopened = new BrowserRuntimeStorage({ durableStore });
  await reopened.ready();
  assert.equal(reopened.loadPlayer(playerId).tasks[first.canonical_id].status,'accepted');
  const exported = reopened.exportPlayer(playerId);
  reopened.resetPlayer(playerId,engine.buildInitialState(playerId));
  await reopened.flush();
  assert.equal(reopened.loadPlayer(playerId).tasks[first.canonical_id].status,'available');
  await reopened.importPlayer(exported,{ expectedPlayerCanonicalId:playerId });
  assert.equal(reopened.loadPlayer(playerId).tasks[first.canonical_id].status,'accepted');
});

test('browser storage coalesces superseded synchronous revisions and flushes the latest valid envelope',async()=>{
  const durableStore=new FakeDurableStore();const storage=new BrowserRuntimeStorage({durableStore});await storage.ready();
  const engine=new TaskRuntimeEngine({catalog:browserCatalog,storage,clock:()=> '2026-07-18T00:00:00.000Z'});const playerId='player.browser.coalesced';
  engine.createPlayer(playerId);const first=browserCatalog.listSeriesTasks('task.series.01')[0];
  engine.processEvent(playerId,{event_id:'coalesced.accept',type:'talk_to_npc',npc_canonical_id:first.issuer_npc_canonical_id,location_canonical_id:first.receive_location_canonical_id});
  await storage.flush();assert.equal(durableStore.putCount,1);
  const persisted=durableStore.records.get(playerId);assert.equal(persisted.revision,2);assert.match(persisted.checksum,/^fnv1a32:/);
  const reopened=new BrowserRuntimeStorage({durableStore});await reopened.ready();assert.equal(reopened.loadPlayer(playerId).tasks[first.canonical_id].status,'accepted');
});

test('browser storage rejects corrupted saves and upgrades schema version zero records',async () => {
  const created = await browserEngine('player.browser.upgrade');
  const valid = structuredClone(created.durableStore.records.get(created.playerId));
  const legacy = { player_canonical_id:created.playerId,schema_version:0,revision:valid.revision,state:valid.state };
  const upgradedStore = new FakeDurableStore([legacy]);
  const upgraded = new BrowserRuntimeStorage({ durableStore:upgradedStore });
  await upgraded.ready();
  assert.equal(upgraded.hasPlayer(created.playerId),true);
  assert.equal(upgradedStore.records.get(created.playerId).schema_version,2);
  const corrupt = structuredClone(upgradedStore.records.get(created.playerId));
  corrupt.state.player.money = 999;
  const corruptStorage = new BrowserRuntimeStorage({ durableStore:new FakeDurableStore([corrupt]) });
  await corruptStorage.ready();
  assert.equal(corruptStorage.hasPlayer(created.playerId),false);
  assert.match(corruptStorage.corruptRecords.get(created.playerId),/checksum/);
});

test('real schema v1 1-of-13 browser save migrates losslessly and discovers all new series',async()=>{
  const legacy=JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','browser-save-v1-real-1-of-13.json'),'utf8'));
  assert.equal(legacy.fixture_provenance.source_commit,'502abf70b1867fe33e02333553a7c8def9e35b20');
  const original={tasks:structuredClone(legacy.state.tasks),inventory:structuredClone(legacy.state.inventory),
    reward_grants:structuredClone(legacy.state.reward_grants),processed_events:structuredClone(legacy.state.processed_events)};
  const durableStore=new FakeDurableStore([legacy]);const storage=new BrowserRuntimeStorage({durableStore});await storage.ready();
  const migrated=storage.loadPlayer(legacy.player_canonical_id);assert.equal(migrated.schema_version,5);
  assert.equal(migrated.player.current_map_node_canonical_id,'derived.map_node.location.96481d67f171db13');
  assert.equal(browserCatalog.getMapNode(migrated.player.current_map_node_canonical_id).display_name,'铁匠铺');
  assert.equal(migrated.player.money,100);assert.equal(migrated.player.experience,1000);
  assert.equal(Object.values(migrated.tasks).filter((task)=>task.status==='completed').length,1);
  assert.deepEqual(migrated.tasks,original.tasks);assert.deepEqual(migrated.inventory,original.inventory);
  assert.deepEqual(migrated.reward_grants,original.reward_grants);assert.deepEqual(migrated.processed_events,original.processed_events);
  const engine=new TaskRuntimeEngine({catalog:browserCatalog,storage,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id)});
  const synchronized=engine.synchronizeDefinitions(legacy.player_canonical_id);assert.equal(synchronized.added_task_canonical_ids.length,content.tasks.length-13);
  const expanded=engine.loadPlayer(legacy.player_canonical_id);assert.equal(Object.keys(expanded.tasks).length,content.tasks.length);
  assert.equal(expanded.player.defeat_return_map_node_canonical_id,content.gameplay_rules.defeat_return.map_node_canonical_id);
  const serialized=storage.exportPlayer(legacy.player_canonical_id);const importedStore=new FakeDurableStore();const importedStorage=new BrowserRuntimeStorage({durableStore:importedStore});await importedStorage.ready();
  await importedStorage.importPlayer(serialized,{expectedPlayerCanonicalId:legacy.player_canonical_id});
  assert.deepEqual(importedStorage.loadPlayer(legacy.player_canonical_id),expanded);
});

test('memory, SQLite and browser adapters produce the same complete task1 state',async () => {
  const memoryStorage = new MemoryRuntimeStorage();
  const memoryEngine = new TaskRuntimeEngine({ catalog:browserCatalog,storage:memoryStorage,clock:() => '2026-07-17T00:00:00.000Z' });
  memoryEngine.createPlayer('player.memory.browser-comparison');
  const memory = runFirstTaskChain(memoryEngine,'player.memory.browser-comparison','memory-browser-comparison').state;
  const browser = await browserEngine('player.browser.comparison');
  const browserState = runFirstTaskChain(browser.engine,browser.playerId,'memory-browser-comparison').state;
  await browser.storage.flush();

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-browser-sqlite-'));
  const databasePath = path.join(temporaryRoot,'runtime.sqlite');
  fs.copyFileSync(path.resolve('data','zhsh-content.sqlite'),databasePath);
  const sqliteStorage = new SqliteRuntimeStorage(databasePath);
  try {
    const sqliteCatalog = new SqliteTaskCatalog(sqliteStorage.db);
    const sqliteEngine = new TaskRuntimeEngine({ catalog:sqliteCatalog,storage:sqliteStorage,clock:() => '2026-07-17T00:00:00.000Z' });
    sqliteEngine.createPlayer('player.sqlite.browser-comparison');
    const sqlite = runFirstTaskChain(sqliteEngine,'player.sqlite.browser-comparison','memory-browser-comparison').state;
    assert.deepEqual(projection(browserState),projection(memory));
    assert.deepEqual(projection(browserState),projection(sqlite));
  } finally { sqliteStorage.close();fs.rmSync(temporaryRoot,{ recursive:true,force:true }); }
});

test('generated browser capability excludes preview routes and providers from normal output',()=>{
  const bundle=fs.readFileSync(path.resolve('web','generated','task-runtime-browser.js'),'utf8');
  assert.equal(content.legacy_compatibility.preview_routes_supported,false);
  assert.equal(content.legacy_compatibility.normal_runtime_reads_this_section,false);
  assert.doesNotMatch(bundle,/PreviewEncounterProvider|PreviewTravelProvider|preview-encounter-provider|travel-provider/);
});

test('new browser saves hold all selected series and expose an independent series selector',async()=>{
  const durableStore=new FakeDurableStore();const storage=new BrowserRuntimeStorage({durableStore});await storage.ready();
  const engine=new TaskRuntimeEngine({catalog:browserCatalog,storage,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id),clock:()=> '2026-07-17T00:00:00.000Z'});
  const playerId='player.browser.multi-series';engine.createPlayer(playerId);
  assert.equal(Object.keys(engine.loadPlayer(playerId).tasks).length,content.tasks.length);
  engine.selectSeries(playerId,'task.series.03','select-series-03');
  const view=engine.getPlayerView(playerId);assert.equal(view.active_series_canonical_id,'task.series.03');assert.equal(view.task_chain.length,1);
  assert.equal(view.all_task_chain.length,content.tasks.length);assert.equal(view.task_series.length,content.series.length);
  assert.equal(engine.selectSeries(playerId,'task.series.03','select-series-03').idempotent_replay,true);
});
