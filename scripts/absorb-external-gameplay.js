'use strict';
/**
 * absorb-external-gameplay.js — 吸收外部仓库《纵横四海：潮汐纪事》的玩法机制（幂等）
 *
 * 依据：docs/design/external-absorption-summary.md 第 1/2 节
 * 目标（数值锚定，不破坏平衡）：
 *  - 怪物状态效果 effect（中毒/虚弱/诅咒/缓慢）+ 周期技能 special（伤害倍增）
 *    —— 仅对高频平民怪按名语义注入；属性不手写，仍由 monster.type-level 派生。
 *  - 装备套装 set_id 标记 + 2/4/6 分段共鸣 —— 仅加 bonus 层，不改单件基础属性。
 *
 * 自愈联动：战斗结算在 formal-gameplay.js 已支持 effect/special；本脚本只写数据。
 */
const path = require('node:path');
const {
  PROJECT_ROOT, openDatabase, hash, stableJson,
} = require('../src/data/database');

const DB_PATH = path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite');
function mkStats() { return { inserted: 0, updated: 0, skipped: 0, failures: 0, tables: {} }; }

// ---- 怪物状态效果（按名语义；等级/类型沿用现有公式） -------------------------
const MONSTER_EFFECTS = {
  '野狼':    { effect: { name: '中毒', chance: 0.12, rounds: 3 } },
  '偷矿者':  { effect: { name: '缓慢', chance: 0.14, rounds: 2 } },
  '灰熊':    { effect: { name: '虚弱', chance: 0.28, rounds: 3 }, special: { name: '裂地重击', every: 3, damage_multiplier: 1.45 } },
  '病鸡':    { effect: { name: '中毒', chance: 0.14, rounds: 2 } },
  '野猪':    { effect: { name: '中毒', chance: 0.10, rounds: 2 } },
  '老虎':    { effect: { name: '虚弱', chance: 0.18, rounds: 2 }, special: { name: '猛虎扑击', every: 4, damage_multiplier: 1.40 } },
  '鳄鱼':    { effect: { name: '中毒', chance: 0.16, rounds: 3 } },
  '走私者':  { effect: { name: '缓慢', chance: 0.14, rounds: 2 } },
  '乌龟':    { effect: { name: '缓慢', chance: 0.10, rounds: 2 } },
  '海贼':    { effect: { name: '中毒', chance: 0.12, rounds: 2 } },
  '海贼头目':{ effect: { name: '诅咒', chance: 0.20, rounds: 3 }, special: { name: '海盗突袭', every: 3, damage_multiplier: 1.40 } },
  '白虎':    { effect: { name: '虚弱', chance: 0.22, rounds: 3 }, special: { name: '白虎咆哮', every: 4, damage_multiplier: 1.45 } },
  '棕熊':    { effect: { name: '虚弱', chance: 0.25, rounds: 3 }, special: { name: '熊掌重拍', every: 3, damage_multiplier: 1.42 } },
  '猛虎':    { effect: { name: '虚弱', chance: 0.20, rounds: 2 }, special: { name: '猛虎扑击', every: 4, damage_multiplier: 1.40 } },
  '疯牛':    { effect: { name: '虚弱', chance: 0.18, rounds: 2 }, special: { name: '蛮牛冲撞', every: 3, damage_multiplier: 1.38 } },
  '野兔':    { effect: { name: '缓慢', chance: 0.10, rounds: 2 } },
};

function applyMonsterEffects(db, stats) {
  for (const [name, meta] of Object.entries(MONSTER_EFFECTS)) {
    const rows = db.prepare('SELECT id FROM monster_definitions WHERE display_name=?').all(name);
    for (const row of rows) {
      const effectJson = meta.effect ? stableJson(meta.effect) : null;
      const specialJson = meta.special ? stableJson(meta.special) : null;
      const cur = db.prepare('SELECT effect, special FROM monster_definitions WHERE id=?').get(row.id);
      if ((cur.effect ?? null) !== effectJson || (cur.special ?? null) !== specialJson) {
        db.prepare('UPDATE monster_definitions SET effect=?, special=? WHERE id=?').run(effectJson, specialJson, Number(row.id));
        stats.updated += 1;
      } else { stats.skipped += 1; }
    }
  }
}

// ---- 装备套装分段共鸣（2/4/6；数值锚定现有装备区间） -------------------------
// set_bonuses 数值取同套单件属性的 ~25%/50%/75% 量级，平滑叠加、不破坏平衡。
const EQUIPMENT_SETS = {
  'set.columbus': {
    member: (displayName) => displayName.includes('哥伦布'), // 7 件：锤/刃/胸甲/防御服/帽/铁盔/皮长靴
    bonuses: [
      { pieces: 2, stats: { attack: 4, defense: 3 } },
      { pieces: 4, stats: { attack: 9, defense: 7, max_health: 20 } },
      { pieces: 6, stats: { attack: 16, defense: 13, max_health: 40, morale: 10 } },
    ],
  },
  'set.dragon': {
    member: (displayName) => displayName.includes('龙') && !/龙珠/.test(displayName), // 龙主题装备（避开剧情龙珠）
    bonuses: [
      { pieces: 2, stats: { attack: 5, agility: 2 } },
      { pieces: 4, stats: { attack: 12, agility: 5, max_health: 24 } },
      { pieces: 6, stats: { attack: 20, agility: 8, max_health: 48, defense: 10 } },
    ],
  },
  'set.voyage': {
    member: (displayName) => displayName.includes('航海'),
    bonuses: [
      { pieces: 2, stats: { agility: 3 } },
      { pieces: 4, stats: { agility: 6, max_health: 18 } },
    ],
  },
};

function applyEquipmentSets(db, stats) {
  const equipmentRows = db.prepare(`
    SELECT e.id, ce.canonical_id, ce.display_name, ce.normalized_data_json
    FROM equipment e JOIN content_entities ce ON ce.id=e.content_entity_id`).all();
  for (const [setId, setDef] of Object.entries(EQUIPMENT_SETS)) {
    stats.tables[setId] ??= 0;
    for (const row of equipmentRows) {
      if (!setDef.member(row.display_name)) continue;
      let attrs;
      try { attrs = JSON.parse(row.normalized_data_json); } catch { continue; }
      if (typeof attrs !== 'object' || attrs === null) attrs = {};
      if (attrs.set_id === setId && stableJson(attrs.set_bonuses ?? null) === stableJson(setDef.bonuses)) {
        stats.skipped += 1; continue;
      }
      attrs.set_id = setId;
      attrs.set_bonuses = setDef.bonuses;
      db.prepare('UPDATE content_entities SET normalized_data_json=? WHERE canonical_id=?')
        .run(stableJson(attrs), row.canonical_id);
      stats.tables[setId] += 1; stats.updated += 1;
    }
  }
}

function main() {
  const db = openDatabase(DB_PATH);
  const stats = mkStats();
  try {
    db.exec('BEGIN IMMEDIATE');
    applyMonsterEffects(db, stats);
    applyEquipmentSets(db, stats);
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
module.exports = { applyMonsterEffects, applyEquipmentSets, main };
