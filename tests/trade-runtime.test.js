'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TradeOrderRuntime, TradeSellRuntime, VoyagePrepRuntime, TradeReputationRuntime } = require('../src/task-runtime/formal-gameplay');

// 与 cook-runtime.test.js 相同的内存存储语义：operation 直接 mutate state，返回 result
function memStorage(initial) {
  if (!initial.gameplay_events) initial.gameplay_events = {};
  let state = initial;
  return {
    transact(playerId, fn) { const result = fn(state); state.player.updated_at = 'now'; return result; },
    getState() { return state; },
  };
}

const CONTENT = {
  map_nodes: [
    { map_node_canonical_id: 'node.venice.dock', location_canonical_id: 'loc.venice.dock' },
    { map_node_canonical_id: 'node.athens.dock', location_canonical_id: 'loc.athens.dock' },
  ],
  locations: [
    { canonical_id: 'loc.venice.dock', city_canonical_id: 'city.venice' },
    { canonical_id: 'loc.athens.dock', city_canonical_id: 'city.athens' },
  ],
};
function baseState(node) {
  return { player: { base_attack: 10, base_defense: 5, base_agility: 3, max_health: 100, morale: 0, money: 1000, level: 1, experience: 0, current_map_node_canonical_id: node }, inventory: {}, equipment: { accessories: [] } };
}
function catalogFor(orders, goods, convoy) {
  return {
    content: CONTENT,
    getTradeOrder(id) { return orders.find((o) => o.canonical_id === id); },
    getTradeGood(id) { return goods.find((g) => g.canonical_id === id); },
    getConvoyItem(id) { return convoy.find((c) => c.canonical_id === id); },
  };
}

test('trade order deliver requires goods, charges none, awards bonus + port reputation', () => {
  const order = { canonical_id: 'order.lamp', port_city_canonical_id: 'city.venice', good_canonical_id: 'good.oil', amount: 4, bonus: 380, reputation: 2 };
  const st = baseState('node.venice.dock');
  st.inventory = { 'good.oil': 4 };
  const rt = new TradeOrderRuntime({ storage: memStorage(st), catalog: catalogFor([order], [], []) });
  const res = rt.deliverOrder('p1', 'order.lamp', 'ev1');
  assert.equal(res.applied, true);
  assert.equal(res.action, 'trade_order_delivered');
  assert.equal(res.bonus, 380);
  assert.equal(res.reputation, 2);
  assert.equal(st.player.money, 1000 + 380);
  assert.equal(st.inventory['good.oil'], undefined); // 交付后删除
  assert.equal(st.city_reputation['city.venice'], 2);
});

test('trade order deliver rejects insufficient goods', () => {
  const order = { canonical_id: 'order.lamp', port_city_canonical_id: 'city.venice', good_canonical_id: 'good.oil', amount: 4, bonus: 380, reputation: 2 };
  const st = baseState('node.venice.dock');
  st.inventory = { 'good.oil': 2 };
  const rt = new TradeOrderRuntime({ storage: memStorage(st), catalog: catalogFor([order], [], []) });
  assert.throws(() => rt.deliverOrder('p1', 'order.lamp', 'ev1'), /商品不足/);
});

test('trade order deliver rejects wrong port', () => {
  const order = { canonical_id: 'order.lamp', port_city_canonical_id: 'city.venice', good_canonical_id: 'good.oil', amount: 4, bonus: 380, reputation: 2 };
  const st = baseState('node.athens.dock'); // 不在威尼斯
  st.inventory = { 'good.oil': 4 };
  const rt = new TradeOrderRuntime({ storage: memStorage(st), catalog: catalogFor([order], [], []) });
  assert.throws(() => rt.deliverOrder('p1', 'order.lamp', 'ev1'), /须在订单指定港口交付/);
});

test('trade sell sells at current port price and awards money', () => {
  const good = { canonical_id: 'good.glass', prices: { 'city.venice': 620, 'city.athens': 400 } };
  const st = baseState('node.venice.dock');
  st.inventory = { 'good.glass': 3 };
  const rt = new TradeSellRuntime({ storage: memStorage(st), catalog: catalogFor([], [good], []) });
  const res = rt.sell('p1', 'good.glass', 3, 'ev1');
  assert.equal(res.applied, true);
  assert.equal(res.unit_price, 620);
  assert.equal(res.gained, 620 * 3);
  assert.equal(st.player.money, 1000 + 620 * 3);
  assert.equal(st.inventory['good.glass'], undefined);
});

test('trade sell rejects when good has no buy price at current port', () => {
  const good = { canonical_id: 'good.glass', prices: { 'city.venice': 620 } };
  const st = baseState('node.athens.dock'); // 雅典无该商品收购价
  st.inventory = { 'good.glass': 1 };
  const rt = new TradeSellRuntime({ storage: memStorage(st), catalog: catalogFor([], [good], []) });
  assert.throws(() => rt.sell('p1', 'good.glass', 1, 'ev1'), /无收购价/);
});

test('convoy purchase deducts money and increments bundle stock', () => {
  const item = { canonical_id: 'convoy.esm', price: 600, effect: { risk_reduction: 0.25, storm_block: 1 } };
  const st = baseState('node.venice.dock');
  const rt = new VoyagePrepRuntime({ storage: memStorage(st), catalog: catalogFor([], [], [item]) });
  const res = rt.purchase('p1', 'convoy.esm', 'ev1');
  assert.equal(res.applied, true);
  assert.equal(res.bundle_count, 1);
  assert.equal(st.player.money, 1000 - 600);
  assert.equal(st.convoy_bundles['convoy.esm'], 1);
  assert.deepEqual(res.effect, { risk_reduction: 0.25, storm_block: 1 });
});

test('convoy purchase rejects insufficient money', () => {
  const item = { canonical_id: 'convoy.esm', price: 600, effect: {} };
  const st = baseState('node.venice.dock');
  st.player.money = 100;
  const rt = new VoyagePrepRuntime({ storage: memStorage(st), catalog: catalogFor([], [], [item]) });
  assert.throws(() => rt.purchase('p1', 'convoy.esm', 'ev1'), /铜贝不足/);
});

test('port reputation view sums across cities', () => {
  const st = baseState('node.venice.dock');
  st.city_reputation = { 'city.venice': 2, 'city.athens': 3 };
  const rt = new TradeReputationRuntime({ storage: memStorage(st), catalog: catalogFor([], [], []) });
  const res = rt.view('p1', 'ev1');
  assert.equal(res.applied, true);
  assert.equal(res.total, 5);
  assert.deepEqual(res.city_reputation, { 'city.venice': 2, 'city.athens': 3 });
});
