'use strict';

const { SqliteTaskCatalog } = require('./sqlite-task-catalog');
const { SqliteRuntimeStorage } = require('./sqlite-runtime-storage');
const { MemoryRuntimeStorage } = require('./memory-runtime-storage');
const { EVENT_TYPES, TaskRuntimeEngine } = require('./task-engine');
const { RUNTIME_STORAGE_METHODS,TASK_CATALOG_METHODS } = require('./ports');
const { BrowserTaskCatalog } = require('./browser-task-catalog');
const { BrowserRuntimeStorage,IndexedDbDurableStore,RemoteDurableStore,RemoteCharacterRegistry,checksum,makeEnvelope,validateAndUpgradeEnvelope } = require('./browser-runtime-storage');
const { UiFeedback,buildCityMapEntries } = require('./classic-ui-model');
const gameplayState = require('./gameplay-state');
const formalGameplay = require('./formal-gameplay');
const equipmentAcquisition = require('./equipment-acquisition');
const progressionPlanner = require('./progression-planner');
const combatSurvival = require('./combat-survival');
const staminaItem = require('./stamina-item');
const taskItemLedger=require('./task-item-ledger');
const npcDuel=require('./npc-duel');

function openSqliteRuntime(databasePath, options = {}) {
  const storage = new SqliteRuntimeStorage(databasePath);
  const catalog = new SqliteTaskCatalog(storage.db);
  const engine = new TaskRuntimeEngine({ catalog, storage, ...options });
  return { catalog, storage, engine, close: () => storage.close() };
}

module.exports = {
  EVENT_TYPES,
  BrowserRuntimeStorage,
  BrowserTaskCatalog,
  makeEnvelope,
  checksum,
  validateAndUpgradeEnvelope,
  IndexedDbDurableStore,
  RemoteDurableStore,
  RemoteCharacterRegistry,
  RUNTIME_STORAGE_METHODS,
  MemoryRuntimeStorage,
  SqliteRuntimeStorage,
  SqliteTaskCatalog,
  TASK_CATALOG_METHODS,
  TaskRuntimeEngine,
  UiFeedback,
  buildCityMapEntries,
  openSqliteRuntime,
  ...gameplayState,
  ...formalGameplay,
  ...equipmentAcquisition,
  ...progressionPlanner,
  ...combatSurvival,
  ...staminaItem,
  ...taskItemLedger,
  ...npcDuel,
};
