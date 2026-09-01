'use strict';
/**
 * absorb-recipe-trade.js — 吸收外部仓库《潮汐纪事》玩法型任务目标数据层（幂等）
 *
 * 依据：docs/design/external-gameplay-targets-plan.md（外部数值 + 本地缩放）
 * 目标：为 cook / trade_order / trade_sell / prepare_voyage / trade_reputation
 *       目标提供落地数据层（recipes / trade_goods / trade_orders / convoy_items），
 *       数值锚定本项目现有基准（装备 lil=300+6Lv、怪物公式、商品 base_price≈500）。
 *
 * 只写数据；运行时（Cook/Order/etc）在 formal-gameplay.js 消费这些表导出内容。
 */
const path = require('node:path');
const { PROJECT_ROOT, openDatabase, hash, stableJson, upsertCanonical } = require('../src/data/database');

const DB_PATH = path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite');
function sig(prefix, value) { return `${prefix}.${hash(value, 16)}`; }
function mkStats() { return { inserted: 0, updated: 0, skipped: 0, failures: 0, tables: {}, recipe_items: 0 }; }
function ensureTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  port_city_canonical_id TEXT NOT NULL,
  cargo_json TEXT NOT NULL CHECK(json_valid(cargo_json)),
  silver_cost REAL NOT NULL,
  result_item_canonical_id TEXT NOT NULL,
  description TEXT NOT NULL,
  source_canonical_id TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS trade_goods (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  space INTEGER NOT NULL,
  supply INTEGER NOT NULL,
  demand INTEGER NOT NULL,
  origin_city_canonical_id TEXT NOT NULL,
  prices_json TEXT NOT NULL CHECK(json_valid(prices_json)),
  source_canonical_id TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS trade_orders (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  port_city_canonical_id TEXT NOT NULL,
  good_canonical_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  bonus REAL NOT NULL,
  reputation INTEGER NOT NULL,
  description TEXT NOT NULL,
  source_canonical_id TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS convoy_items (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  price REAL NOT NULL,
  effect_json TEXT NOT NULL CHECK(json_valid(effect_json)),
  description TEXT NOT NULL,
  source_canonical_id TEXT
) STRICT;
  `);
}

// ---- 本地缩放锚点 ----
// 装备价格 lj≈300+6*Lv；武器 attack≈6+0.9*Lv；重甲 defense≈0.85*Lv。
// 物品 heal 基准：牛肉馅饼 heal:50(300 铜)、曲奇饼 heal:80(3000 铜)、泉水(500)。
// 商品价格：goods.json region specialty base_price≈500。

// ---- 餐食配方（外部 RECIPES 结构 → 本地锚定） ----
// cargo 用现有物品 display_name 查找内容库物品（不存在则跳过该配送）；
// result 为新餐食物品（效果锚定装备+heal 曲线，price 锚定 300~3000）。
const RECIPES = [
  {
    name: '海风炖汤',
    port_city: '威尼斯', // 汉堡/雅典等城市填写；由脚本映射到 canonical_id
    cargo: ['牛肉馅饼', '泉水'],
    result: {
      name: '海风炖汤',
      price: 800,
      buff: { attack: 6, defense: 4, max_health: 40, battles: 3 },
    },
    description: '恢复体力，并在接下来3场战斗中获得攻击、防御和体力加成。',
  },
  {
    name: '远洋餐食',
    port_city: '雅典',
    cargo: ['曲奇饼', '泉水'],
    result: {
      name: '远洋餐食',
      price: 1400,
      buff: { attack: 12, defense: 8, max_health: 80, agility: 4, battles: 4 },
    },
    description: '远航主食，补给充分，接下来的4场战斗中全面提升属性。',
  },
];

// ---- 贸易商品（外部 TRADE_GOODS 结构；价格按本项目商品基准缩放） ----
// prices 键用城市 display_name；原产港低价、异港高价，梯度沿用外部比例。
const TRADE_GOODS = [
  { name: '威尼斯玻璃', unit: '箱', space: 2, supply: 8, demand: 7, origin: '威尼斯',
    prices: { '威尼斯': 380, '拉古扎': 520, '亚历山大': 620, '开普敦': 700, '泉州': 660, '雅典': 540, '扬州': 710, '阿姆斯特丹': 800 } },
  { name: '羊毛布', unit: '捆', space: 1, supply: 15, demand: 12, origin: '拉古扎',
    prices: { '威尼斯': 430, '拉古扎': 330, '亚历山大': 470, '开普敦': 580, '泉州': 720, '雅典': 420, '扬州': 780, '阿姆斯特丹': 520 } },
  { name: '橄榄油', unit: '桶', space: 2, supply: 9, demand: 8, origin: '拉古扎',
    prices: { '威尼斯': 480, '拉古扎': 340, '亚历山大': 460, '开普敦': 540, '泉州': 630, '雅典': 420, '扬州': 680, '阿姆斯特丹': 570 } },
  { name: '香料', unit: '袋', space: 1, supply: 14, demand: 11, origin: '亚历山大',
    prices: { '威尼斯': 650, '拉古扎': 540, '亚历山大': 360, '开普敦': 720, '泉州': 690, '雅典': 610, '扬州': 840, '阿姆斯特丹': 780 } },
  { name: '柑橘', unit: '筐', space: 1, supply: 17, demand: 13, origin: '马赛',
    prices: { '威尼斯': 420, '拉古扎': 400, '亚历山大': 450, '开普敦': 520, '泉州': 610, '雅典': 440, '扬州': 660, '阿姆斯特丹': 580 } },
  { name: '青瓷', unit: '箱', space: 2, supply: 8, demand: 7, origin: '泉州',
    prices: { '威尼斯': 760, '拉古扎': 720, '亚历山大': 840, '开普敦': 940, '泉州': 420, '雅典': 780, '扬州': 520, '阿姆斯特丹': 860 } },
  { name: '桑蚕丝', unit: '匹', space: 1, supply: 13, demand: 10, origin: '扬州',
    prices: { '威尼斯': 860, '拉古扎': 820, '亚历山大': 920, '开普敦': 1020, '泉州': 580, '雅典': 820, '扬州': 460, '阿姆斯特丹': 940 } },
];

// ---- 港口订单（外部 TRADE_ORDERS 结构；bonus 锚定商品价差，reputation 累积） ----
const TRADE_ORDERS = [
  { title: '灯塔修缮急单', port_city: '亚历山大', good: '威尼斯玻璃', amount: 3, bonus: 450, reputation: 2, description: '灯塔镜室急需耐高温的威尼斯玻璃。' },
  { title: '石墙港灯油', port_city: '拉古扎', good: '橄榄油', amount: 4, bonus: 380, reputation: 2, description: '城墙守夜人要在风季前补足灯油。' },
  { title: '总督玻璃宴具', port_city: '拉古扎', good: '威尼斯玻璃', amount: 2, bonus: 320, reputation: 2, description: '总督府宴会需要一批威尼斯玻璃器皿。' },
  { title: '庆典香料', port_city: '威尼斯', good: '香料', amount: 3, bonus: 300, reputation: 2, description: '庆典厨房高价收购三袋香料。' },
  { title: '卫队冬装', port_city: '威尼斯', good: '羊毛布', amount: 4, bonus: 260, reputation: 2, description: '城防队为冬季巡逻订购羊毛布。' },
  { title: '舰队防坏血病补给', port_city: '马赛', good: '柑橘', amount: 5, bonus: 340, reputation: 2, description: '巡航舰队需要新鲜柑橘补充远航餐食。' },
  { title: '北河驱兽香', port_city: '开普敦', good: '香料', amount: 4, bonus: 600, reputation: 3, description: '向导队需要香料驱散北河洞窟中的毒虫。' },
  { title: '镇妖镜片', port_city: '泉州', good: '威尼斯玻璃', amount: 3, bonus: 700, reputation: 3, description: '需要纯净玻璃重制照破妖气的古镜。' },
  { title: '地脉长明油', port_city: '雅典', good: '橄榄油', amount: 4, bonus: 760, reputation: 3, description: '王陵远征需要优质橄榄油点亮祭灯。' },
  { title: '北海玉纱拍卖', port_city: '阿姆斯特丹', good: '桑蚕丝', amount: 4, bonus: 900, reputation: 3, description: '拍卖行正在征集完整的桑蚕丝。' },
];

// ---- 护航物（外部 ship_owner 对话提及；price 锚定物品区价，效果=降低航程风险/抵消风暴） ----
const CONVOY_ITEMS = [
  { name: '护航物资', price: 600, effect: { risk_reduction: 0.25, storm_block: 1 }, description: '出航前购买，本航程危险遭遇降低并抵消一次风暴。' },
  { name: '精制护航徽章', price: 1500, effect: { risk_reduction: 0.4, storm_block: 2 }, description: '高阶护航物，显著降低高危遭遇并抵消两次风暴。' },
];

function findCity(db, name) {
  const row = db.prepare('SELECT canonical_id FROM cities WHERE display_name=?').get(name);
  return row?.canonical_id ?? null;
}
function findItem(db, name) {
  const ce = db.prepare(`SELECT ce.canonical_id FROM content_entities ce JOIN items i ON i.content_entity_id=ce.id WHERE ce.display_name=? LIMIT 1`).get(name);
  return ce?.canonical_id ?? null;
}
function ensureMealItem(db, meta, stats) {
  const canonicalId = sig('runtime.meal', meta.name);
  const recordCanonical = `derived.meal.${hash(canonicalId, 16)}`;
  const rec = upsertCanonical(db, 'restoration_records', {
    canonical_id: recordCanonical, record_origin: 'overlay', entity_kind: 'item',
    display_name: meta.name, raw_value_json: '{}',
    normalized_value_json: stableJson({ name: meta.name, catalog: 'mealItems', price: meta.price, buff: meta.buff, tip: meta.description }),
    restoration_status: 'APPROVED_OVERLAY', confidence: 'A', originality_status: 'UNVERIFIED_AS_ORIGINAL',
    decision_reason: 'absorb-recipe-trade', conflicts_json: '[]', runtime_selection: 'approved_overlay',
    content_hash: hash(`meal|${canonicalId}|${stableJson(meta)}`),
  }, stats);
  // overlay 记录必须有 restoration_resolutions 条目（validator complete_provenance 校验）
  const resolutionExists = db.prepare('SELECT id FROM restoration_resolutions WHERE derived_record_id=?').get(Number(rec.id));
  if (!resolutionExists) {
    db.prepare(`INSERT INTO restoration_resolutions (resolution_id,action,entity_kind,derived_record_id,derived_canonical_id,display_name,restoration_status,originality_status,confidence,runtime_policy,decision_reason,unresolved_fields_json,created_from_baseline_commit,content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`resolution.meal.${hash(canonicalId, 16)}`, 'create_derived_entity', 'item', Number(rec.id), canonicalId,
        meta.name, 'APPROVED_OVERLAY', 'UNVERIFIED_AS_ORIGINAL', 'A', 'approved_overlay', 'absorb-recipe-trade', '[]',
        'f61da146c551436d2c3afd5da4eb3eb817b8ab13', hash(canonicalId, 32));
  }
  const normalized = { name: meta.name, catalog: 'mealItems', price: meta.price, buff: meta.buff, tip: meta.description };
  db.prepare(`INSERT INTO content_entities (canonical_id,source_record_id,source_canonical_id,entity_category,display_name,raw_data_json,normalized_data_json) VALUES (?,?,?,?,?,?,?)`)
    .run(canonicalId, Number(rec.id), canonicalId, 'item', meta.name, '{}', stableJson(normalized));
  const ce = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(canonicalId);
  db.prepare('INSERT INTO items (content_entity_id,catalog,price) VALUES (?,?,?)').run(ce.id, 'mealItems', meta.price);
  stats.recipe_items += 1; stats.inserted += 1;
  return canonicalId;
}

function applyRecipes(db, stats) {
  for (const recipe of RECIPES) {
    const cityId = findCity(db, recipe.port_city);
    if (!cityId) { stats.failures += 1; continue; }
    const cargo = {};
    let missing = false;
    for (const ing of recipe.cargo) {
      const itemId = findItem(db, ing);
      if (!itemId) { missing = true; break; }
      cargo[itemId] = (cargo[itemId] ?? 0) + 1;
    }
    if (missing) { stats.failures += 1; continue; }
    const resultId = ensureMealItem(db, recipe.result, stats);
    const canonicalId = sig('recipe', recipe.name);
    const existing = db.prepare('SELECT id FROM recipes WHERE canonical_id=?').get(canonicalId);
    if (existing) { stats.skipped += 1; continue; }
    db.prepare(`INSERT INTO recipes (canonical_id,display_name,port_city_canonical_id,cargo_json,silver_cost,result_item_canonical_id,description,source_canonical_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(canonicalId, recipe.name, cityId, stableJson(cargo), recipe.buff ? 0 : 5, resultId, recipe.description, canonicalId);
    stats.tables.recipes = (stats.tables.recipes ?? 0) + 1; stats.inserted += 1;
  }
}

function applyTradeGoods(db, stats) {
  for (const good of TRADE_GOODS) {
    const cityId = findCity(db, good.origin);
    if (!cityId) { stats.failures += 1; continue; }
    const canonicalId = sig('trade_good', good.name);
    const existing = db.prepare('SELECT id FROM trade_goods WHERE canonical_id=?').get(canonicalId);
    const prices = {}; let missing = false;
    for (const [cityName, price] of Object.entries(good.prices)) {
      const cid = findCity(db, cityName);
      if (!cid) { missing = true; break; }
      prices[cid] = price;
    }
    if (missing) { stats.failures += 1; continue; }
    const rowJson = stableJson({ prices });
    if (existing) {
      const cur = db.prepare('SELECT prices_json FROM trade_goods WHERE canonical_id=?').get(canonicalId);
      if (cur?.prices_json !== rowJson) { db.prepare('UPDATE trade_goods SET prices_json=? WHERE canonical_id=?').run(rowJson, canonicalId); stats.updated += 1; }
      else stats.skipped += 1;
      continue;
    }
    db.prepare(`INSERT INTO trade_goods (canonical_id,display_name,unit,space,supply,demand,origin_city_canonical_id,prices_json,source_canonical_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(canonicalId, good.name, good.unit, good.space, good.supply, good.demand, cityId, rowJson, canonicalId);
    stats.tables.trade_goods = (stats.tables.trade_goods ?? 0) + 1; stats.inserted += 1;
  }
}

function applyTradeOrders(db, stats) {
  for (const order of TRADE_ORDERS) {
    const cityId = findCity(db, order.port_city);
    const goodId = db.prepare('SELECT canonical_id FROM trade_goods WHERE display_name=?').get(order.good)?.canonical_id;
    if (!cityId || !goodId) { stats.failures += 1; continue; }
    const canonicalId = sig('trade_order', order.title);
    const existing = db.prepare('SELECT id FROM trade_orders WHERE canonical_id=?').get(canonicalId);
    if (existing) { stats.skipped += 1; continue; }
    db.prepare(`INSERT INTO trade_orders (canonical_id,title,port_city_canonical_id,good_canonical_id,amount,bonus,reputation,description,source_canonical_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(canonicalId, order.title, cityId, goodId, order.amount, order.bonus, order.reputation, order.description, canonicalId);
    stats.tables.trade_orders = (stats.tables.trade_orders ?? 0) + 1; stats.inserted += 1;
  }
}

function applyConvoyItems(db, stats) {
  for (const item of CONVOY_ITEMS) {
    const canonicalId = sig('convoy_item', item.name);
    const existing = db.prepare('SELECT id FROM convoy_items WHERE canonical_id=?').get(canonicalId);
    if (existing) { stats.skipped += 1; continue; }
    db.prepare(`INSERT INTO convoy_items (canonical_id,display_name,price,effect_json,description,source_canonical_id) VALUES (?,?,?,?,?,?)`)
      .run(canonicalId, item.name, item.price, stableJson(item.effect), item.description, canonicalId);
    stats.tables.convoy_items = (stats.tables.convoy_items ?? 0) + 1; stats.inserted += 1;
  }
}

function main() {
  const db = openDatabase(process.env.ZHSH_DB_PATH ?? DB_PATH);
  const stats = mkStats();
  try {
    db.exec('BEGIN IMMEDIATE');
    ensureTables(db);
    applyRecipes(db, stats);
    applyTradeGoods(db, stats);
    applyTradeOrders(db, stats);
    applyConvoyItems(db, stats);
    db.exec('COMMIT');
    process.stdout.write(`${JSON.stringify({ ok: true, stats }, null, 2)}\n`);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, stats }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    try { db.close(); } catch {}
  }
}

if (require.main === module) main();
module.exports = { applyRecipes, applyTradeGoods, applyTradeOrders, applyConvoyItems, main };
