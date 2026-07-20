'use strict';

const TASK_CATALOG_METHODS = Object.freeze([
  'listSeriesTasks',
  'getTask',
  'getMapNode',
  'getNodeForLocation',
  'listAdjacentNodes',
  'listNpcsAtNode',
  'isNpcAtLocation',
  'isMonsterAtLocation',
  'hasContentEntity',
]);
const RUNTIME_STORAGE_METHODS = Object.freeze([
  'hasPlayer',
  'createPlayer',
  'loadPlayer',
  'resetPlayer',
  'transact',
]);

function assertPort(adapter,name,methods) {
  if (!adapter) throw new Error(`${name} adapter is required`);
  const missing = methods.filter((method) => typeof adapter[method] !== 'function');
  if (missing.length) throw new Error(`${name} adapter is missing methods: ${missing.join(', ')}`);
  return adapter;
}

function assertTaskCatalog(adapter) {
  return assertPort(adapter,'TaskCatalog',TASK_CATALOG_METHODS);
}

function assertRuntimeStorage(adapter) {
  return assertPort(adapter,'RuntimeStorage',RUNTIME_STORAGE_METHODS);
}

module.exports = { RUNTIME_STORAGE_METHODS,TASK_CATALOG_METHODS,assertRuntimeStorage,assertTaskCatalog };
