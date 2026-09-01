'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CookRuntime, effectiveStats, consumeMealBattle } = require('../src/task-runtime/formal-gameplay');

// 内存存储模拟：transactEvent 需要 storage.transact(playerId, fn)
function memStorage(initial) {
  if (!initial.gameplay_events) initial.gameplay_events = {};
  let state = initial;
  return {
    transact(playerId, fn) { const result = fn(state); state.player.updated_at = 'now'; return result; },
    getState() { return state; },
  };
}

function mealItem(name, buff) {
  return { canonical_id: `item.meal.${name}`, normalized_data: { catalog: 'mealItems', buff }, buff };
}
function catalogFor(recipes, meals, goods, orders, content) {
  const byId = new Map(meals.map((m) => [m.canonical_id, m]));
  return {
    recipes, tradeGoods: goods, tradeOrders: orders,
    getItem(id) { return byId.get(id) ?? null; },
    getRecipe(id) { return recipes.find((r) => r.canonical_id === id); },
    getTradeGood(id) { return goods.find((g) => g.canonical_id === id); },
    getTradeOrder(id) { return orders.find((o) => o.canonical_id === id); },
    getConvoyItem(id) { return content.convoy_items?.find((c) => c.canonical_id === id); },
    content: content ?? {},
  };
}

function baseState() {
  return {
    player: { base_attack: 10, base_max_attack: 10, base_defense: 5, base_agility: 3, max_health: 100, morale: 0, money: 500, level: 1, experience: 0 },
    inventory: {}, equipment: { accessories: [] },
  };
}

test('cook consumes ingredients, charges money, and grants the meal item', () => {
  const cargo = { 'item.ing.bread': 1, 'item.ing.water': 1 };
  const recipe = { canonical_id: 'recipe.stew', port_city_canonical_id: 'city.venice', cargo, silver_cost: 50,
    result_item_canonical_id: 'item.meal.stew', description: 'x' };
  const st = baseState();
  st.inventory = { 'item.ing.bread': 1, 'item.ing.water': 1 };
  st.player.current_map_node_canonical_id = 'node.dock';
  const content = { locations: [{ canonical_id: 'loc.dock', city_canonical_id: 'city.venice' }], map_nodes: [{ map_node_canonical_id: 'node.dock', location_canonical_id: 'loc.dock' }] };
  const cook = new CookRuntime({ storage: memStorage(st), catalog: catalogFor([recipe], [mealItem('stew', { attack: 6, battles: 3 })], [], [], content) });
  const res = cook.cook('p1', 'recipe.stew', 'ev1');
  assert.equal(res.applied, true);
  assert.equal(res.action, 'meal_cooked');
  assert.equal(res.result_item_canonical_id, 'item.meal.stew');
  assert.equal(st.inventory['item.ing.bread'], undefined); // 数量归零后 setInventory 删除该键
  assert.equal(st.inventory['item.meal.stew'], 1);
  assert.equal(st.player.money, 450); // 500-50
});

test('cook rejects insufficient ingredients', () => {
  const recipe = { canonical_id: 'recipe.stew', port_city_canonical_id: 'city.venice', cargo: { 'item.ing.bread': 2 }, silver_cost: 0, result_item_canonical_id: 'item.meal.stew' };
  const st = baseState();
  st.inventory = { 'item.ing.bread': 1 };
  st.player.current_map_node_canonical_id = 'node.dock';
  const content = { locations: [{ canonical_id: 'loc.dock', city_canonical_id: 'city.venice' }], map_nodes: [{ map_node_canonical_id: 'node.dock', location_canonical_id: 'loc.dock' }] };
  const cook = new CookRuntime({ storage: memStorage(st), catalog: catalogFor([recipe], [mealItem('stew', {})], [], [], content) });
  assert.throws(() => cook.cook('p1', 'recipe.stew', 'ev1'), /食材不足/);
});

test('consumeMeal sets a multi-battle meal buff', () => {
  const st = baseState();
  st.inventory = { 'item.meal.stew': 1 };
  const cook = new CookRuntime({ storage: memStorage(st), catalog: catalogFor([], [mealItem('stew', { attack: 6, defense: 4, max_health: 40, battles: 3 })], [], []) });
  const res = cook.consumeMeal('p1', 'item.meal.stew', 'ev1');
  assert.equal(res.applied, true);
  assert.equal(st.player.meal_buff.remaining_battles, 3);
  assert.equal(st.player.meal_buff.attack, 6);
});

test('effectiveStats applies meal buff bonuses', () => {
  const st = baseState();
  st.player.meal_buff = { attack: 6, defense: 4, max_health: 40, agility: 2, remaining_battles: 3 };
  const stats = effectiveStats(st, catalogFor([], [mealItem('x', {})], [], []));
  assert.equal(stats.attack, 16); // 10+6
  assert.equal(stats.defense, 9); // 5+4
  assert.equal(stats.max_health, 140); // 100+40
  assert.equal(stats.agility, 5); // 3+2
});

test('consumeMealBattle decrements remaining battles and clears at zero', () => {
  const st = baseState();
  st.player.meal_buff = { attack: 6, remaining_battles: 2 };
  const after1 = consumeMealBattle(st);
  assert.equal(after1.remaining_battles, 1);
  const after2 = consumeMealBattle(st);
  assert.equal(after2, null);
  assert.equal(st.player.meal_buff, null);
});
