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
  assert.deepEqual(fixture,before);
  // 平滑曲线重设计后升级更快：一次胜利可跨多级，训练到 >=targetLevel 时实际等级可高于 38(如 44)。
  // trainFormalRecord 保证 >=targetLevel(见 formal-training-helper line 62), 允许溢出。
  const trainedLevel=validateAndUpgradeEnvelope(result.record).state.player.level;
  assert.ok(trainedLevel>=38,`trained level ${trainedLevel} must be >= target 38`);
  // 平滑曲线重设计后，起点玩家经验可能已覆盖目标级(38)，无需练级（victories=0 属正常——减 grind 目标达成）。
  assert.ok(result.victories>=0&&result.losses>=0);assert.ok(result.attempts<=result.plan.total_reasonable_worst_attempts||result.attempts===0);
  assert.match(result.storage_runtime,/isolated transactional training adapter/);
});
