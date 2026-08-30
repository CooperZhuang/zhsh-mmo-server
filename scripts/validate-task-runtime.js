'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  EVENT_TYPES,
  MemoryRuntimeStorage,
  SqliteRuntimeStorage,
  SqliteTaskCatalog,
  TaskRuntimeEngine,
} = require('../src/task-runtime');
const { runFirstTaskChain } = require('../src/task-runtime/first-chain-driver');

const PROJECT_ROOT = path.resolve(__dirname,'..');

function valueAfter(args,name,fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

function comparable(state) {
  return stableJson({
    node: state.player.current_map_node_canonical_id,
    money: state.player.money,
    experience: state.player.experience,
    tasks: state.tasks,
    progress: state.progress,
    inventory: state.inventory,
    grants: state.reward_grants,
    flags: state.flags,
  });
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function addCheck(checks,name,passed,details = {}) {
  checks.push({ name,passed:Boolean(passed),...details });
}

function runValidation({ databasePath,outputPath }) {
  if (!fs.existsSync(databasePath)) throw new Error(`Existing static database does not exist: ${databasePath}`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-task-runtime-validation-'));
  const copyPath = path.join(temporaryRoot,'runtime-validation.sqlite');
  fs.copyFileSync(databasePath,copyPath);
  let sqliteStorage;
  try {
    sqliteStorage = new SqliteRuntimeStorage(copyPath);
    const catalog = new SqliteTaskCatalog(sqliteStorage.db);
    const tasks = catalog.listSeriesTasks('task.series.01');
    const clock = () => '2026-07-17T00:00:00.000Z';
    const memoryStorage = new MemoryRuntimeStorage();
    const memoryEngine = new TaskRuntimeEngine({ catalog,storage:memoryStorage,clock });
    memoryEngine.createPlayer('player.validation.memory');
    const memoryRun = runFirstTaskChain(memoryEngine,'player.validation.memory','validation-memory');
    const sqliteEngine = new TaskRuntimeEngine({ catalog,storage:sqliteStorage,clock });
    sqliteEngine.createPlayer('player.validation.sqlite');
    const sqliteRun = runFirstTaskChain(sqliteEngine,'player.validation.sqlite','validation-sqlite');
    const memoryState = memoryRun.state;
    const sqliteState = sqliteRun.state;
    const checks = [];

    addCheck(checks,'task1_loads_exactly_13_tasks',tasks.length === 13,{ actual:tasks.length,expected:13 });
    addCheck(checks,'first_task_acceptance_event_succeeds',memoryRun.events.some((entry) => entry.result.action === 'accepted' && entry.result.task_canonical_id === tasks[0].canonical_id));
    addCheck(checks,'all_prerequisites_are_satisfied_before_completion',tasks.slice(1).every((task,index) => task.prerequisites.length === 1 && task.prerequisites[0] === tasks[index].canonical_id));
    addCheck(checks,'wrong_npc_and_location_do_not_advance',validateWrongEntityRejection(catalog,clock));
    const chainEventTypes = [...new Set(memoryRun.events.map((entry) => entry.event.type))].sort();
    const eventTypes = [...EVENT_TYPES].sort();
    const supportedEventTypes = new Set(eventTypes);
    addCheck(checks,'required_event_types_are_supported',chainEventTypes.every((type) => supportedEventTypes.has(type)),{ event_types:eventTypes,first_chain_event_types:chainEventTypes });
    addCheck(checks,'all_original_normalized_quantities_are_met',tasks.every((task) => task.targets.every((target) => memoryState.progress[`${task.canonical_id}|${target.canonical_id}`] === target.required_quantity)));
    addCheck(checks,'correct_submission_npcs_complete_tasks',Object.values(memoryState.tasks).every((task) => task.status === 'completed'));
    addCheck(checks,'rewards_have_one_grant_per_definition',Object.keys(memoryState.reward_grants).length === tasks.reduce((sum,task) => sum + task.rewards.length,0),{ grant_count:Object.keys(memoryState.reward_grants).length });
    addCheck(checks,'explicit_successors_unlock_in_order',tasks.slice(0,-1).every((task,index) => task.successors.length === 1 && task.successors[0] === tasks[index + 1].canonical_id));
    const reloaded = sqliteStorage.loadPlayer('player.validation.sqlite');
    addCheck(checks,'sqlite_save_reload_preserves_state',comparable(reloaded) === comparable(sqliteState));
    const submitEvent = sqliteRun.events.findLast((entry) => entry.event.type === 'submit_to_npc').event;
    const beforeReplay = comparable(sqliteStorage.loadPlayer('player.validation.sqlite'));
    const replayResult = sqliteEngine.processEvent('player.validation.sqlite',submitEvent);
    addCheck(checks,'repeated_event_and_reward_are_idempotent',replayResult.idempotent_replay === true && comparable(sqliteStorage.loadPlayer('player.validation.sqlite')) === beforeReplay);
    addCheck(checks,'transaction_failure_rolls_back',validateStorageRollback(sqliteStorage));
    addCheck(checks,'task1_prerequisite_graph_is_acyclic',isAcyclic(tasks));
    addCheck(checks,'no_cross_series_prerequisite_exists',catalog.countCrossSeriesPrerequisites() === 0,{ actual:catalog.countCrossSeriesPrerequisites() });
    addCheck(checks,'all_32_conflicts_remain_unresolved',catalog.countUnresolvedConflicts() === 32,{ actual:catalog.countUnresolvedConflicts(),expected:32 });
    const foreignKeyViolations = sqliteStorage.db.prepare('PRAGMA foreign_key_check').all();
    addCheck(checks,'sqlite_foreign_key_violations_are_zero',foreignKeyViolations.length === 0,{ actual:foreignKeyViolations.length });
    addCheck(checks,'memory_and_sqlite_adapters_match',comparable(memoryState) === comparable(sqliteState));
    addCheck(checks,'first_chain_completes_all_13_tasks',Object.values(sqliteState.tasks).filter((task) => task.status === 'completed').length === 13);

    const sourceLabelRewards = tasks.flatMap((task) => task.rewards
      .filter((reward) => reward.resolution_status === 'source_label_only' && reward.reward_kind === 'item')
      .map((reward) => ({
        task_canonical_id: task.canonical_id,
        reward_canonical_id: reward.canonical_id,
        dependency_canonical_id: reward.dependency_canonical_id,
        original_reward_name: reward.reward_name,
        original_raw_quantity: reward.raw_quantity,
        normalized_quantity: reward.quantity,
        resolution_status: reward.resolution_status,
        runtime_treatment: 'recorded_source_label_only_not_inventory',
      })));
    const report = {
      schema_version: '1.0.0',
      generated_at: new Date().toISOString(),
      source_database: path.relative(PROJECT_ROOT,databasePath).replaceAll('\\','/'),
      static_content_reimported: false,
      passed: checks.every((check) => check.passed),
      summary: {
        checks: checks.length,
        passed: checks.filter((check) => check.passed).length,
        failed: checks.filter((check) => !check.passed).length,
        task_count: tasks.length,
        completed_task_count: Object.values(sqliteState.tasks).filter((task) => task.status === 'completed').length,
        money: sqliteState.player.money,
        experience: sqliteState.player.experience,
        reward_grant_count: Object.keys(sqliteState.reward_grants).length,
        blocked_task_count: Object.values(sqliteState.tasks).filter((task) => task.status === 'blocked').length,
        unresolved_conflict_count: catalog.countUnresolvedConflicts(),
      },
      event_types: eventTypes,
      first_chain_event_types: chainEventTypes,
      blocked_tasks: tasks.filter((task) => task.blocking_reasons.length).map((task) => ({ canonical_id:task.canonical_id,blocking_reasons:task.blocking_reasons })),
      non_inventory_source_label_rewards: sourceLabelRewards,
      checks,
    };
    fs.mkdirSync(path.dirname(outputPath),{ recursive:true });
    fs.writeFileSync(outputPath,`${JSON.stringify(report,null,2)}\n`,'utf8');
    return report;
  } finally {
    sqliteStorage?.close();
    fs.rmSync(temporaryRoot,{ recursive:true,force:true });
  }
}

function validateWrongEntityRejection(catalog,clock) {
  const storage = new MemoryRuntimeStorage();
  const engine = new TaskRuntimeEngine({ catalog,storage,clock });
  const playerId = 'player.validation.wrong';
  engine.createPlayer(playerId);
  const first = catalog.listSeriesTasks('task.series.01')[0];
  let wrongNpc = false;
  let wrongLocation = false;
  try { engine.processEvent(playerId,{ event_id:'wrong-npc',type:'talk_to_npc',npc_canonical_id:first.completion_npc_canonical_id,location_canonical_id:first.receive_location_canonical_id }); }
  catch { wrongNpc = true; }
  try { engine.processEvent(playerId,{ event_id:'wrong-location',type:'talk_to_npc',npc_canonical_id:first.issuer_npc_canonical_id,location_canonical_id:first.submit_location_canonical_id }); }
  catch { wrongLocation = true; }
  return wrongNpc && wrongLocation && engine.loadPlayer(playerId).tasks[first.canonical_id].status === 'available';
}

function validateStorageRollback(storage) {
  const before = storage.loadPlayer('player.validation.sqlite').player.money;
  try {
    storage.transact('player.validation.sqlite',(state) => { state.player.money += 99; throw new Error('rollback probe'); });
  } catch (error) {
    if (error.message !== 'rollback probe') throw error;
  }
  return storage.loadPlayer('player.validation.sqlite').player.money === before;
}

function isAcyclic(tasks) {
  const byId = new Map(tasks.map((task) => [task.canonical_id,task]));
  for (const task of tasks) {
    const seen = new Set();
    let current = task;
    while (current.prerequisites.length) {
      if (seen.has(current.canonical_id)) return false;
      seen.add(current.canonical_id);
      current = byId.get(current.prerequisites[0]);
      if (!current) return false;
    }
  }
  return true;
}

try {
  const args = process.argv.slice(2);
  const databasePath = path.resolve(valueAfter(args,'--database',path.join(PROJECT_ROOT,'data','zhsh-content.sqlite')));
  const outputPath = path.resolve(valueAfter(args,'--output',path.join(PROJECT_ROOT,'docs','development','task-runtime-validation.json')));
  const report = runValidation({ databasePath,outputPath });
  process.stdout.write(`${JSON.stringify({ passed:report.passed,summary:report.summary,output:path.relative(PROJECT_ROOT,outputPath).replaceAll('\\','/') },null,2)}\n`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}

module.exports = { runValidation };
