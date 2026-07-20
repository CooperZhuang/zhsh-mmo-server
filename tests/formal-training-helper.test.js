'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const content=require('../web/generated/task1-content.json');
const fixture=require('./fixtures/browser-save-v3-formal-57-of-57.json');
const {validateAndUpgradeEnvelope}=require('../src/task-runtime');
const {collectReachableTravelLocations,trainFormalRecord}=require('../browser-tests/formal-training-helper');

test('global browser content excludes unreachable training islands from the accepted fixture travel closure',()=>{
  const state=validateAndUpgradeEnvelope(fixture).state;const {BrowserTaskCatalog}=require('../src/task-runtime');
  const reachable=collectReachableTravelLocations({content,catalog:new BrowserTaskCatalog(content),state});
  assert.ok(reachable.includes('entity.location.6f923866e793a6df'));
  assert.equal(reachable.includes('entity.location.258c6e4199be18ab'),false,'Penglai has no formal voyage route and must not enter training plans');
});

test('source-driven training bridge exports a valid save without mutating its accepted fixture',async()=>{
  const before=structuredClone(fixture);const result=await trainFormalRecord({content,record:fixture,targetLevel:38});
  assert.deepEqual(fixture,before);assert.equal(validateAndUpgradeEnvelope(result.record).state.player.level,38);
  assert.ok(result.victories>0);assert.ok(result.losses>0);assert.ok(result.attempts<=result.plan.total_reasonable_worst_attempts);
  assert.match(result.storage_runtime,/isolated transactional training adapter/);
});
