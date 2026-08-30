'use strict';
/**
 * integrate-idle-assets.js — 闲置视觉资产集成（幂等）
 *
 * 依据：docs/design/idle-assets-integration.md + 资产审计（198 条未绑定映射）
 * 目的：为「未绑定正式实体」的视觉映射补齐事实实体（数值锚定现有公式/曲线），
 *       使 integrate-authoritative-assets 重算后全部行进入 mapped_* 绑定态，
 *       且游戏内（背包/战斗/任务/航海/宠物/钓鱼）实际渲染这些视觉。
 *
 * 数值锚定（约束：不破坏经济与战斗平衡）：
 * - 装备属性按库内同类型曲线（武器 attack≈6+0.9*Lv；重甲 defense≈0.85*Lv；
 *   头盔 defense≈0.15*Lv+morale≈0.38*Lv；靴 defense≈0.5*Lv+agility≈0.3*Lv；
 *   饰品 defense≈0.3*Lv），lj(价格)≈300+6*Lv，全部取自现有装备区间；
 * - 怪物属性由 monster.type-level.v1 公式自动派生（仅选等级/类型）；
 * - 掉落 0.4/1（与库内普通掉落一致，任务激活 guaranteed 由引擎接管）；
 * - 剧情物品 price=null（不可交易），不进入经济系统；
 * - 船只价格/载重/速度锚定库内现有船（1000~26000 区间）；
 * - 支线奖励锚定 sidequests.json 现有区间（500/30 已有先例）。
 *
 * 自愈联动：新增怪物 邪恶花精 后，原版掉落行（邪恶花精→小良的毛笔）
 * 在下一次 completeAdjudicationBaselineDrops 运行中按同名定义解析（见
 * adjudicate-blocked-targets.js 同名解析规则），扔掉悬空 label_only。
 */
const path = require('node:path');
const fs = require('node:fs');
const {
  PROJECT_ROOT, openDatabase, hash, stableJson, upsertCanonical,
} = require('../src/data/database');

const DB_PATH = path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite');
function sig(prefix, value) { return `${prefix}.${hash(value, 16)}`; }
function mkStats() { return { inserted: 0, updated: 0, skipped: 0, failures: 0, tables: {} }; }

// ---- 装备（数值锚定：库内曲线） ------------------------------------------------
// [名称, 类型, 等级, 词条tx, 描述tip]
const EQUIPMENT = {
  '哥伦布之刃':    { type: 1, level: 30, tx: '致命攻+10', tip: '航海家哥伦布的佩刃，传说曾斩断过风暴的船缆。' },
  '哥伦布防御服':  { type: 3, level: 35, tx: '抗迟缓+6', tip: '哥伦布远征队的制式防具，帆布下缝着旧航图。' },
  '哥伦布的铁盔':  { type: 2, level: 34, tx: '抗迟缓+3', tip: '锈迹斑斑的铁盔，内衬写着哥伦布的名字。' },
  '哥伦布皮长靴':  { type: 4, level: 32, tx: '物品掉落+1', tip: '穿过半个旧大陆的皮靴，鞋底还嵌着新大陆的砂。' },
  '桂魄银蟾':      { type: 5, level: 44, tx: '抗诅咒+2', tip: '月宫桂树下的银蟾石，握在掌心有月华微凉。' },
  '玉兔绒衣':      { type: 3, level: 45, tx: '恢复+2', tip: '玉兔绒毛织成的雪白衣衫，触手生温。' },
  '月宫仙子冠':    { type: 2, level: 46, tx: '抗诅咒+3', tip: '月宫仙子的发冠，夜里有桂香萦绕。' },
  '船锚':          { type: 5, level: 25, tx: '体力回复+1', tip: '老水手的旧锚，沉过七处海沟，也能锚定你的航路。' },
  '航海图卷':      { type: 5, level: 28, tx: '声望+1', tip: '泛黄的图卷，标注着早已消失的罗盘航线。' },
  '航海护符':      { type: 5, level: 18, tx: '暴风雨抗性+1', tip: '护符里封着一缕顺风，护佑短途航行的水手。' },
  '航海勋章':      { type: 5, level: 28, tx: '声望+1', tip: '远洋船长们互相赠送的勋章，刻着一艘三桅帆船。' },
  '航海腰带':      { type: 5, level: 22, tx: '抗迟缓+2', tip: '结实的帆绳腰带，挂着打火镰与一根旧铅笔。' },
  '海军匕首':      { type: 1, level: 15, tx: '致命攻+4', tip: '巡航艇水兵的制式匕首，刃口有细密磨痕。' },
  '海军外套':      { type: 3, level: 15, tx: '抗迟缓+2', tip: '防浪的帆布外套，袖口绣着锚徽。' },
  '红宝石戒指':    { type: 5, level: 35, tx: '致命攻+5', tip: '在亚丁集市淘来的红宝石，戒托刻着祝福的古文。' },
};

// ---- 普通物品（price=null 剧情/战利品） --------------------------------------
const ITEMS = {
  '百宝袋':   { tip: '塞得鼓鼓囊囊的帆布袋，谁也不知道里面装了什么。' },
  '黄金金币': { tip: '黄澄澄的金币，海贼们藏在靴筒里的硬通货。' },
};

// ---- 剧情任务物（挂到提及它们的任务，作为奖励进入任务/背包/特殊场景） ----------
const STORY_ITEMS = {
  '通商卷轴': '记载着七国通商口岸与关税的旧卷轴。',
  '通商文书': '商会签发的通商文书，骑缝盖着火漆大印。',
  '密封信函': '封蜡完好的密信，火漆上压着一枚锚形印记。',
  '圣火令': '一柄燃着紫焰的圣火令，是圣火教至高信物。',
  '亚丁权杖': '亚丁总督的权杖，杖头嵌着航海罗盘。',
  '龙珠碎片·赤': '龙珠的一块赤色碎片，捏着发烫。',
  '龙珠碎片·蓝': '龙珠的一块蓝色碎片，像含着一汪海水。',
  '龙珠碎片·绿': '龙珠的一块绿色碎片，映着森林的光。',
  '龙珠碎片·金': '龙珠的一块金色碎片，整颗龙珠拼图的一角。',
  '加封谕旨': '加盖御玺的加封谕旨，受封者姓名处仍是空白。',
  '古航海图': '画着消失航线的古航海图，边缘已经烧灼。',
  '航海罗盘': '指针总指着某个无名岛的方向，从未失灵。',
  '黑铁钥匙': '沉重漆黑的黑钥匙，齿形取自海盗船的龙骨。',
  '铜钥匙': '老旧的铜钥匙，磨损得看不出纹样。',
  '银钥匙': '银钥匙贴着细细的铭牌：交予有缘人。',
  '金钥匙': '金钥匙共有七齿，据说对应七座宝库。',
  '骷髅钥匙': '钥匙柄是一枚骷髅头，海贼口耳相传的不祥之物。',
  '律法纹章': '商埠法庭的律法纹章，象征海商的正当权益。',
  '印蜡官印': '官印的印蜡盒，烙过每一张加封的信函。',
  '蓝纹宝箱': '蓝纹漆器宝箱，开锁处是一枚小小的玉钮。',
  '圣杯': '烛台般大小的圣杯，杯壁刻着潮汐起落。',
  '玉筒': '上好的青玉笔筒，内衬一方古纸。',
  '水晶头骨': '半透明的水晶头骨，额心有月影浮动。',
  '太阳徽章': '太阳纹样的纯铜徽章，暖得像午后甲板。',
  '月影水晶球': '夜光水晶球，球心雾气里隐隐有月影。',
  '古护符': '绳子都磨亮了的古护符，上面刻着看不懂的文字。',
  '青龙玉佩': '青龙纹青玉佩，通体温润，雕的是东方四灵之首。',
  '镇印石盒': '石盒盖上压着一枚镇印，沉得几乎抬不动。',
  '漩涡怀表': '表盘呈漩涡状的怀表，指针逆着走。',
};

// ---- 怪物（等级/类型随副本曲线；属性由 monster.type-level.v1 自动派生） --------
const MONSTERS = {
  '狐仙':     { level: 88, city: '泉州', location: '丹霞山', tip: '丹霞山雾中的狐仙本尊，狐仙小美的真正面貌。' },
  '邪恶花精': { level: 152, city: '杭州', location: '野外', tip: '杭城野外古木孕出的妖花之精，守护着一段旧缘。' },
};
const MONSTER_DROPS = {
  '狐仙': ['百宝袋'],
  '邪恶花精': ['小良的毛笔'], // 原版 monsterItems 掉落源，补齐后不再悬空
};

// ---- C 组装扮掉落（0.4/1，宿主取同区域既有怪物） ------------------------------
const DROP_HOSTS = {
  '哥伦布之刃':   ['亚丁海盗头子', '海贼头目'],
  '哥伦布防御服': ['海盗头子扎布拉'],
  '哥伦布的铁盔': ['海盗头子扎布拉'],
  '哥伦布皮长靴': ['海盗头子扎布拉'],
  '桂魄银蟾':     ['百花妖王'],
  '玉兔绒衣':     ['百花妖王'],
  '月宫仙子冠':   ['百花妖王'],
  '船锚':         ['海盗头子扎布拉'],
  '航海图卷':     ['索马里海盗'],
  '航海护符':     ['挪威海盗'],
  '航海勋章':     ['亚丁海盗头子'],
  '航海腰带':     ['亚丁海盗'],
  '海军匕首':     ['海贼头目'],
  '海军外套':     ['海贼'],
  '红宝石戒指':   ['大毒枭杰克'],
  '百宝袋':       ['海盗头子扎布拉'],
  '黄金金币':     ['亚丁海盗头子'],
  '百宝箱':       ['海盗头子扎布拉'],
};

// ---- 船只（价格/载重/速度锚定库内现有船 1000~26000） --------------------------
const SHIPS = {
  '双桅商船':    { port: '伦敦', price: 7000, weight: 70, speed: 22 },
  '武装商船':    { port: '伦敦', price: 12000, weight: 90, speed: 26 },
  '卡拉维尔帆船':{ port: '开普敦', price: 10500, weight: 65, speed: 30 },
  '海盗船':      { port: '泉州', price: 20000, weight: 110, speed: 34 },
  '幽灵船':      { port: '泉州', price: 26000, weight: 120, speed: 40 },
  '远洋帆船':    { port: '威尼斯', price: 18000, weight: 130, speed: 38 },
  '大型鱼带泡船':{ port: '商城', price: 16000, weight: 100, speed: 42 },
};

// ---- NPC（威尼斯国王 + 隐藏支线：御前嘱托 → 讨伐海盗头子扎布拉） ----------------
const NPCS = {
  '威尼斯国王': { city: '威尼斯', location: '王宫', role: '海商王国的君王，接见有功的船长。' },
};

// ---- 鱼类（渔获，稀有度/价格锚定现有渔获表） ---------------------------------
const FISH = {
  '鲑鱼': { price: 600, tip: '洄游上溯的冷水鱼，肉质肥厚，煮熟后泛着淡粉。', rarity: 'common', locations: [['伦敦', '开普敦']] },
  '螃蟹': { price: 300, tip: '横着走路的海蟹，钓上来时钳子还在咔咔作响。', rarity: 'common', locations: [['威尼斯', '大阪']] },
  '章鱼': { price: 800, tip: '八条腕的深海章鱼，是海怪们的远房亲戚。', rarity: 'uncommon', locations: [['大阪', '亚丁']] },
  '剑鱼': { price: 1500, tip: '顶着铠甲状长喙的大鱼，冲浪时像一支离弦的箭。', rarity: 'rare', locations: [['开普敦', '泉州']] },
};

// ---- 落地辅助 ----------------------------------------------------------------
function ensureOverlayRecord(db, canonicalId, entityKind, displayName, normalized, stats, reason) {
  if (!stats) throw new Error(`stats undefined for overlay ${canonicalId}`);
  const rec = upsertCanonical(db, 'restoration_records', {
    canonical_id: `derived.${entityKind}.${hash(canonicalId, 16)}`, record_origin: 'overlay', entity_kind: entityKind,
    display_name: displayName, raw_value_json: '{}', normalized_value_json: stableJson(normalized),
    restoration_status: 'APPROVED_OVERLAY', confidence: 'A', originality_status: 'UNVERIFIED_AS_ORIGINAL',
    decision_reason: reason, conflicts_json: '[]', runtime_selection: 'approved_overlay',
    content_hash: hash(`${entityKind}|${canonicalId}|${stableJson(normalized)}`),
  }, stats);
  const existing = db.prepare('SELECT id FROM restoration_resolutions WHERE derived_record_id=?').get(Number(rec.id));
  if (!existing) {
    db.prepare(`INSERT INTO restoration_resolutions (resolution_id,action,entity_kind,derived_record_id,derived_canonical_id,display_name,restoration_status,originality_status,confidence,runtime_policy,decision_reason,unresolved_fields_json,created_from_baseline_commit,content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`resolution.${entityKind}.${hash(canonicalId, 16)}`, 'create_derived_entity', entityKind, Number(rec.id), canonicalId,
        displayName, 'APPROVED_OVERLAY', 'UNVERIFIED_AS_ORIGINAL', 'A', 'approved_overlay', reason, '[]',
        'f61da146c551436d2c3afd5da4eb3eb817b8ab13', hash(canonicalId, 32));
  }
  return { id: Number(rec.id) };
}

function ensureEntity(db, canonicalId, entityKind, displayName, normalized, stats, reason, catalogKey = null) {
  let ce = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(canonicalId);
  if (!ce) {
    const rec = ensureOverlayRecord(db, canonicalId, entityKind, displayName, normalized, stats, reason);
    db.prepare(`INSERT INTO content_entities (canonical_id,source_record_id,source_canonical_id,entity_category,display_name,raw_data_json,normalized_data_json) VALUES (?,?,?,?,?,?,?)`)
      .run(canonicalId, Number(rec.id), canonicalId, entityKind, displayName, '{}', stableJson(normalized));
    ce = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(canonicalId);
    stats.inserted += 1;
  }
  return { id: Number(ce.id), canonicalId };
}

function ensureItem(db, name, normalized, stats, catalog = 'taskItems', reason = 'idle-assets-integration') {
  const canonicalId = sig('runtime.item', name);
  const entity = ensureEntity(db, canonicalId, 'item', name, { ...normalized, catalog, name }, stats, reason);
  const exists = db.prepare('SELECT id FROM items WHERE content_entity_id=?').get(entity.id);
  if (!exists) { db.prepare('INSERT INTO items (content_entity_id,catalog,price) VALUES (?,?,?)').run(entity.id, catalog, normalized.price ?? null); stats.inserted += 1; }
  return entity;
}

function ensureEquipment(db, name, meta, stats) {
  const canonicalId = sig('entity.equipment', name);
  const normalized = { name, catalog_key: name, level: meta.level, type: meta.type, lj: 300 + meta.level * 6, tip: meta.tip, tx: meta.tx };
  if (meta.type === 1) { normalized.attack = Math.floor(6 + meta.level * 0.9); normalized.maxAttack = normalized.attack + 10; }
  if (meta.type === 3) { normalized.defense = Math.floor(meta.level * 0.85); }
  if (meta.type === 2) { normalized.defense = Math.floor(meta.level * 0.15); normalized.morale = Math.floor(meta.level * 0.38); }
  if (meta.type === 4) { normalized.defense = Math.floor(meta.level * 0.5); normalized.agility = Math.floor(meta.level * 0.3); }
  if (meta.type === 5) { normalized.defense = Math.floor(meta.level * 0.3); normalized.agility = Math.floor(meta.level * 0.2); normalized.morale = Math.floor(meta.level * 0.25); }
  const entity = ensureEntity(db, canonicalId, 'equipment', name, normalized, stats, 'idle-assets-integration');
  const exists = db.prepare('SELECT id FROM equipment WHERE content_entity_id=?').get(entity.id);
  if (!exists) { db.prepare('INSERT INTO equipment (content_entity_id,catalog_key,level,equipment_type) VALUES (?,?,?,?)').run(entity.id, name, meta.level, meta.type); stats.inserted += 1; }
  return entity;
}

function findEntityByName(db, category, name) {
  const row = db.prepare('SELECT id,canonical_id FROM content_entities WHERE entity_category=? AND display_name=?').get(category, name)
    ?? db.prepare('SELECT id,canonical_id FROM content_entities WHERE display_name=? ORDER BY id LIMIT 1').get(name);
  return row ? { id: Number(row.id), canonicalId: row.canonical_id } : null;
}
function findMonsterId(db, name, level) {
  const rows = db.prepare('SELECT id,level FROM monster_definitions WHERE display_name=?').all(name);
  if (level != null) { const hit = rows.find((r) => Number(r.level) === Number(level)); if (hit) return Number(hit.id); }
  if (rows.length) return Number(rows[0].id);
  return null;
}
function findMonsterCanonical(db, id) { return db.prepare('SELECT canonical_id FROM monster_definitions WHERE id=?').get(id)?.canonical_id; }
function findCityId(db, cityName) { return db.prepare('SELECT id FROM cities WHERE display_name=?').get(cityName)?.id ?? null; }
function findLocationId(db, cityId, locationName) { return db.prepare('SELECT id,canonical_id FROM locations WHERE city_id=? AND display_name=?').get(cityId, locationName); }

function ensureDrop(db, monsterCanonicalId, monsterName, itemCanonicalId, stats) {
  const sourceRefCid = sig('entity.drop_source', `${monsterCanonicalId}|${itemCanonicalId}`);
  const targetRefCid = sig('entity.drop_target', `${monsterCanonicalId}|${itemCanonicalId}`);
  for (const [refCid, kind, rawName] of [[sourceRefCid, 'monster', monsterName], [targetRefCid, 'item', null]]) {
    if (db.prepare('SELECT id FROM dependency_references WHERE canonical_id=?').get(refCid)) continue;
    const rec = ensureOverlayRecord(db, refCid, 'dependency', `${kind}:${rawName ?? itemCanonicalId}`, { ctx: 'drop', rawName: rawName ?? itemCanonicalId, category: kind }, stats, 'idle-assets-integration');
    if (kind === 'monster') {
      const monsterDefId = db.prepare('SELECT id FROM monster_definitions WHERE canonical_id=?').get(monsterCanonicalId)?.id;
      if (!monsterDefId) { stats.failures += 1; throw new Error(`monster definition missing for source ref ${refCid} (${monsterCanonicalId})`); }
      db.prepare(`INSERT INTO dependency_references (canonical_id,source_record_id,source_canonical_id,reference_context,raw_name,raw_category,raw_quantity,resolution_status,resolved_monster_definition_id,candidate_canonical_ids_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(refCid, Number(rec.id), refCid, 'drop_source', rawName, 'monster', null, 'resolved', Number(monsterDefId), '[]', 'queryable');
    } else {
      const item = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(itemCanonicalId);
      if (!item) { stats.failures += 1; throw new Error(`content entity missing for target ref ${refCid} (${itemCanonicalId})`); }
      db.prepare(`INSERT INTO dependency_references (canonical_id,source_record_id,source_canonical_id,reference_context,raw_name,raw_category,raw_quantity,resolution_status,resolved_content_entity_id,candidate_canonical_ids_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(refCid, Number(rec.id), refCid, 'drop_target', itemCanonicalId, 'item', null, 'resolved', Number(item.id), '[]', 'queryable');
    }
  }
  const dropCid = sig('entity.drop', `${monsterCanonicalId}|${itemCanonicalId}`);
  if (db.prepare('SELECT id FROM drop_relations WHERE canonical_id=?').get(dropCid)) return;
  const src = db.prepare('SELECT id,source_record_id FROM dependency_references WHERE canonical_id=?').get(sourceRefCid);
  const tgt = db.prepare('SELECT id,source_record_id FROM dependency_references WHERE canonical_id=?').get(targetRefCid);
  db.prepare('INSERT INTO drop_relations (canonical_id,source_record_id,source_canonical_id,source_reference_id,target_reference_id,probability,quantity,raw_data_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(dropCid, Number(src.source_record_id), monsterCanonicalId, Number(src.id), Number(tgt.id), 0.4, 1, stableJson({ source: 'idle-assets-integration', monster: monsterName }), 'queryable');
  stats.inserted += 1;
}

function ensureReward(db, taskCid, itemCanonicalId, stats) {
  const task = db.prepare('SELECT id FROM task_definitions WHERE canonical_id=?').get(taskCid);
  const item = db.prepare('SELECT display_name FROM content_entities WHERE canonical_id=?').get(itemCanonicalId);
  if (!task || !item) { stats.failures += 1; return; }
  const exists = db.prepare('SELECT id FROM task_rewards WHERE task_id=? AND reward_name=?').get(task.id, item.display_name);
  if (exists) return;
  const refCid = sig('entity.task_reward', `${taskCid}|${item.display_name}`);
  if (!db.prepare('SELECT id FROM dependency_references WHERE canonical_id=?').get(refCid)) {
    const rec = ensureOverlayRecord(db, refCid, 'dependency', `task_reward:${item.display_name}`, { ctx: 'task_reward', rawName: item.display_name, category: 'item' }, stats, 'idle-assets-integration');
    const ent = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(itemCanonicalId);
    db.prepare(`INSERT INTO dependency_references (canonical_id,source_record_id,source_canonical_id,reference_context,raw_name,raw_category,raw_quantity,resolution_status,resolved_content_entity_id,candidate_canonical_ids_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(refCid, Number(rec.id), refCid, 'task_reward', item.display_name, 'item', '1', 'resolved', Number(ent.id), '[]', 'queryable');
  }
  const ref = db.prepare('SELECT id,source_record_id FROM dependency_references WHERE canonical_id=?').get(refCid);
  const orderRow = db.prepare('SELECT COALESCE(MAX(reward_order),0) o FROM task_rewards WHERE task_id=?').get(task.id);
  db.prepare('INSERT INTO task_rewards (canonical_id,task_id,source_record_id,source_canonical_id,reward_order,reward_kind,reward_name,raw_quantity,normalized_quantity,dependency_reference_id,raw_value_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(sig('entity.task_reward', `${taskCid}|${item.display_name}`), Number(task.id), Number(ref.source_record_id), taskCid, Number(orderRow.o) + 1, 'item', item.display_name, '1', 1, Number(ref.id), stableJson({ item: item.display_name, quantity: 1 }));
  stats.inserted += 1;
}

function ensureMonster(db, monsterName, meta, stats) {
  const canonicalId = sig('derived.monster_definition', `${monsterName}|${meta.level}|5`);
  if (!db.prepare('SELECT id FROM monster_definitions WHERE canonical_id=?').get(canonicalId)) {
    const rec = ensureOverlayRecord(db, canonicalId, 'monster_definition', monsterName, { name: monsterName, level: meta.level, type: 5 }, stats, 'idle-assets-integration');
    db.prepare(`INSERT INTO monster_definitions (canonical_id,source_record_id,source_canonical_id,display_name,level,monster_type,identity_signature_json,identity_basis) VALUES (?,?,?,?,?,?,?,?)`)
      .run(canonicalId, Number(rec.id), canonicalId, monsterName, meta.level, 5, stableJson([monsterName, meta.level, 5]), 'exact_name_level_type_and_available_attributes');
    stats.inserted += 1;
  }
  const cityId = findCityId(db, meta.city); const loc = cityId ? findLocationId(db, cityId, meta.location) : null;
  if (loc) {
    const placementCid = sig('entity.monster_placement', `${monsterName}|${meta.city}|${meta.location}`);
    if (!db.prepare('SELECT id FROM monster_placements WHERE canonical_id=?').get(placementCid)) {
      const def = db.prepare('SELECT id FROM monster_definitions WHERE canonical_id=?').get(canonicalId);
      // 既有放置位置迁移（改配置后旧放置作废，避免同怪停留在旧址）
      const oldPlacements = db.prepare('SELECT mp.canonical_id FROM monster_placements mp JOIN monster_definitions md ON md.id=mp.monster_definition_id WHERE md.display_name=?').all(monsterName);
      for (const old of oldPlacements) {
        if (db.prepare('SELECT id FROM monster_placements WHERE canonical_id=?').get(placementCid)?.canonical_id === old.canonical_id) continue;
        db.prepare('DELETE FROM monster_placements WHERE canonical_id=?').run(old.canonical_id);
      }
      const rec = ensureOverlayRecord(db, placementCid, 'monster_placement', `${monsterName}@${meta.city}/${meta.location}`, { monster: monsterName, city: meta.city, location: meta.location }, stats, 'idle-assets-integration');
      db.prepare(`INSERT INTO monster_placements (canonical_id,source_record_id,source_canonical_id,monster_definition_id,location_id,raw_city_name,raw_location_name,location_resolution_status,raw_data_json,normalized_data_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(placementCid, Number(rec.id), placementCid, Number(def.id), Number(loc.id), meta.city, meta.location, 'resolved', '{}', stableJson({ monster: monsterName, city: meta.city, location: meta.location }), 'queryable');
      stats.inserted += 1;
    }
  } else { stats.failures += 1; }
  return canonicalId;
}

function ensureNpc(db, npcName, meta, stats) {
  const canonicalId = sig('derived.npc_definition', npcName);
  if (!db.prepare('SELECT id FROM npc_definitions WHERE canonical_id=?').get(canonicalId)) {
    const rec = ensureOverlayRecord(db, canonicalId, 'npc_definition', npcName, { name: npcName, role: meta.role, region: 'region.mediterranean' }, stats, 'idle-assets-integration');
    db.prepare(`INSERT INTO npc_definitions (canonical_id,source_record_id,source_canonical_id,display_name,level,npc_type,identity_basis) VALUES (?,?,?,?,?,?,?)`)
      .run(canonicalId, Number(rec.id), canonicalId, npcName, 55, 0, 'exact_name_level_type_signature');
    stats.inserted += 1;
  }
  const cityId = findCityId(db, meta.city); const loc = cityId ? findLocationId(db, cityId, meta.location) : null;
  if (loc && loc.id) {
    const cid = sig('entity.npc_placement', `${canonicalId}|${loc.canonical_id}`);
    if (!db.prepare('SELECT id FROM npc_placements WHERE canonical_id=?').get(cid)) {
      const def = db.prepare('SELECT id FROM npc_definitions WHERE canonical_id=?').get(canonicalId);
      const node = db.prepare('SELECT id FROM map_nodes WHERE location_id=? AND runtime_capability=?').get(loc.id, 'queryable');
      const rec = ensureOverlayRecord(db, cid, 'npc_placement', `${npcName}@${meta.city}/${meta.location}`, { npc: npcName, city: meta.city, location: meta.location }, stats, 'idle-assets-integration');
      db.prepare(`INSERT INTO npc_placements (canonical_id,source_record_id,source_canonical_id,npc_definition_id,map_node_id,location_id,runtime_capability) VALUES (?,?,?,?,?,?,?)`)
        .run(cid, Number(rec.id), cid, Number(def.id), Number(node?.id ?? 0), Number(loc.id), 'queryable');
      stats.inserted += 1;
    }
  } else { stats.failures += 1; }
  return canonicalId;
}

function ensureShip(db, name, meta, stats) {
  const canonicalId = sig('entity.ship', name);
  const entity = ensureEntity(db, canonicalId, 'ship', name, { name, port: meta.port, price: meta.price, weight: meta.weight, speed: meta.speed }, stats, 'idle-assets-integration');
  const exists = db.prepare('SELECT id FROM ships WHERE content_entity_id=?').get(entity.id);
  if (!exists) { db.prepare('INSERT INTO ships (content_entity_id,port,price,weight,speed) VALUES (?,?,?,?,?)').run(entity.id, meta.port, meta.price, meta.weight, meta.speed); stats.inserted += 1; }
  return entity;
}

function ensureFish(db, name, meta, stats) {
  const canonicalId = sig('entity.fish', name);
  const entity = ensureEntity(db, canonicalId, 'fish', name, { ...meta, name, type: 13, info: {} }, stats, 'idle-assets-integration');
  const exists = db.prepare('SELECT id FROM fish WHERE content_entity_id=?').get(entity.id);
  if (!exists) { db.prepare('INSERT INTO fish (content_entity_id,rarity,price,locations_json) VALUES (?,?,?,?)').run(entity.id, meta.rarity, meta.price, stableJson(meta.locations ?? [])); stats.inserted += 1; }
  // importer 约定：鱼类同时以 item 实体（catalog=fish）入 content_entities/items，导出按此解析
  const itemCid = sig('entity.item', name);
  const itemEntity = ensureEntity(db, itemCid, 'item', name, { ...meta, name, catalog: 'fish', type: 13, info: {} }, stats, 'idle-assets-integration');
  const itemExists = db.prepare('SELECT id FROM items WHERE content_entity_id=? AND catalog=?').get(itemEntity.id, 'fish');
  if (!itemExists) { db.prepare('INSERT INTO items (content_entity_id,catalog,price) VALUES (?,?,?)').run(itemEntity.id, 'fish', meta.price); stats.inserted += 1; }
  return entity;
}

// 剧情物品→章节任务锚（任务文本含物名则自动命中；否则按剧情令牌挂对应章节任务）
const STORY_TOKENS = {
  '通商卷轴': ['通商', '商会'], '通商文书': ['通商', '商会'], '密封信函': ['密信', '信件', '通商'],
  '亚丁权杖': ['亚丁'], '加封谕旨': ['加封', '谕旨', '圣火'], '古航海图': ['航海图', '海图'],
  '航海罗盘': ['罗盘', '航海'], '黑铁钥匙': ['钥匙', '铁箱'], '铜钥匙': ['钥匙', '铁箱'],
  '银钥匙': ['钥匙', '铁箱'], '金钥匙': ['钥匙', '铁箱'], '骷髅钥匙': ['钥匙', '骷髅'],
  '律法纹章': ['律法', '执法', '通商'], '印蜡官印': ['官印', '加封'], '蓝纹宝箱': ['宝箱', '宝藏'],
  '圣杯': ['圣杯', '宝藏'], '玉筒': ['玉筒', '宝藏'], '水晶头骨': ['头骨', '宝藏'],
  '太阳徽章': ['徽章', '太阳'], '月影水晶球': ['水晶球', '月影'], '古护符': ['护符', '古物'],
  '青龙玉佩': ['玉佩', '青龙'], '镇印石盒': ['镇印', '石盒'], '漩涡怀表': ['怀表', '漩涡'],
};
function findStoryTask(db, name) {
  const variants = [...new Set([name, name.split('·')[0], ...(STORY_TOKENS[name] ?? [])].filter(Boolean))];
  const rows = [];
  for (const variant of variants) {
    for (const r of db.prepare(`SELECT t.canonical_id FROM task_definitions t WHERE t.normalized_value_json LIKE ? OR t.raw_value_json LIKE ?`).all(`%${variant}%`, `%${variant}%`)) {
      if (!rows.some((x) => x.canonical_id === r.canonical_id)) rows.push(r);
    }
    if (rows.length) break;
  }
  if (!rows.length) {
    // 兜底：终幕寻龙链（系列 12/13/15 提及龙珠/碎片/圣火的章节任务）
    for (const r of db.prepare("SELECT t.canonical_id FROM task_definitions t WHERE t.normalized_value_json LIKE '%龙珠%' OR t.raw_value_json LIKE '%龙珠%' OR t.normalized_value_json LIKE '%圣火%' OR t.raw_value_json LIKE '%圣火%' LIMIT 2").all()) {
      if (!rows.some((x) => x.canonical_id === r.canonical_id)) rows.push(r);
    }
  }
  return rows.map((r) => r.canonical_id);
}

// ---- 主入口 -----------------------------------------------------------------
function runIntegrate({ dbPath = DB_PATH, dryRun = false } = {}) {
  const stats = mkStats();
  const db = openDatabase(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const reason = 'idle-assets-integration';
    // 1) 装备 15 + 普通物品 2 + 剧情物 29
    const entityBy = new Map();
    for (const [name, meta] of Object.entries(EQUIPMENT)) entityBy.set(name, ensureEquipment(db, name, meta, stats));
    for (const [name, meta] of Object.entries(ITEMS)) entityBy.set(name, ensureItem(db, name, meta, stats));
    for (const [name, tip] of Object.entries(STORY_ITEMS)) entityBy.set(name, ensureItem(db, name, { tip, price: null }, stats));
    // 2) 怪物 + 放置 + 掉落
    const monsterCanonical = new Map();
    for (const [name, meta] of Object.entries(MONSTERS)) {
      monsterCanonical.set(name, ensureMonster(db, name, meta, stats));
      for (const dropName of MONSTER_DROPS[name] ?? []) {
        const item = entityBy.get(dropName) ?? findEntityByName(db, 'item', dropName);
        if (!item) { stats.failures += 1; continue; }
        ensureDrop(db, monsterCanonical.get(name), name, item.canonicalId, stats);
      }
    }
    // 3) 掉落宿主绑定（既有怪物 + 新实体物品）
    for (const [itemName, hosts] of Object.entries(DROP_HOSTS)) {
      const item = entityBy.get(itemName) ?? findEntityByName(db, 'item', itemName);
      if (!item) { stats.failures += 1; continue; }
      for (const host of hosts) {
        const monsterId = findMonsterId(db, host);
        const monsterCid = monsterId ? findMonsterCanonical(db, monsterId) : null;
        if (!monsterCid) { stats.failures += 1; continue; }
        ensureDrop(db, monsterCid, host, item.canonicalId, stats);
      }
    }
    // 4) NPC + 支线数据（支线 JSON 另注 server/content/sidequests.json）
    for (const [name, meta] of Object.entries(NPCS)) ensureNpc(db, name, meta, stats);
    // 5) 船只 + 鱼
    for (const [name, meta] of Object.entries(SHIPS)) ensureShip(db, name, meta, stats);
    for (const [name, meta] of Object.entries(FISH)) ensureFish(db, name, meta, stats);
    // 6) 剧情物品挂接到提及它们的任务（作为奖励；price=null 不扰经济）
    for (const [name] of Object.entries(STORY_ITEMS)) {
      const item = entityBy.get(name);
      const tasks = findStoryTask(db, name);
      for (const taskCid of tasks.slice(0, 2)) ensureReward(db, taskCid, item.canonicalId, stats);
    }
    if (dryRun) { db.exec('ROLLBACK'); } else { db.exec('COMMIT'); }
    return { ok: true, stats, db: path.relative(PROJECT_ROOT, dbPath) };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    return { ok: false, error: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n'), stats };
  } finally {
    try { db.close(); } catch {}
  }
}

module.exports = { runIntegrate };
if (require.main === module) {
  const result = runIntegrate({ dryRun: process.argv.includes('--dry-run') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
