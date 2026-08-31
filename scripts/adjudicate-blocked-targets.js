'use strict';
/**
 * adjudicate-blocked-targets.js — 70 个 blocked 任务的裁决落库脚本（幂等）
 *
 * 依据：docs/design/blocked-targets-adjudication.md
 * 目的：把原版任务文本引用的物品实体、掉落/购买/任务链传递闭环、以及类型裁决
 *       固化进 data/zhsh-content.sqlite，使 dependency_references 可解析，
 *       engine 不再把对应任务标记为 blocked（60 条 blocked_missing + 15 条 cross_type）。
 *       另含原版掉落行补齐：46 对裁决物品的原版（baseline）掉落行解析到裁决实体，
 *       不再停在 source_label_only（见 completeAdjudicationBaselineDrops）。
 *
 * 幂等：全部用 database.js 的 upsertCanonical / 显式 UPDATE；canonical_id 沿用
 *       signatureCanonical = `${prefix}.${hash(value,16)}` 惯例。
 */
const path = require('node:path');
const fs = require('node:fs');
const {
  PROJECT_ROOT, openDatabase, hash, stableJson, upsertCanonical,
} = require('../src/data/database');

const DB_PATH = path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite');

/**
 * 运行时 id 映射：以重建后的 web/generated/task1-content.json 为准。
 * 服务端引擎（SqliteTaskCatalog，读 SQLite）与 formal gameplay（读该 JSON）必须
 * 对同一物品使用同一 canonical_id；而 player_inventory.content_entity_canonical_id
 * 外键指向 SQLite content_entities，因此 SQLite 侧实体必须用 JSON 侧的
 * runtime.task_chain.item.* / runtime.market_item.* / runtime.item.* id。
 */
const RUNTIME_CONTENT_PATH = path.join(PROJECT_ROOT, 'web', 'generated', 'task1-content.json');
function loadRuntimeItemIds() {
  const byName = new Map();
  if (!fs.existsSync(RUNTIME_CONTENT_PATH)) return byName;
  const content = JSON.parse(fs.readFileSync(RUNTIME_CONTENT_PATH, 'utf8'));
  for (const entity of content.content_entities ?? []) {
    if (entity.entity_category !== 'item') continue;
    const norm = entity.normalized_data ?? {};
    byName.set(entity.display_name, {
      canonical_id: entity.canonical_id,
      normalized_data: norm,
      catalog: norm.catalog ?? null,
      price: norm.price ?? null,
    });
  }
  return byName;
}

function sig(prefix, value) { return `${prefix}.${hash(value, 16)}`; }

/**
 * 为 overlay 恢复记录补 provenance（restoration_resolutions 行）。
 * validator 的 complete_provenance 要求：record_origin='overlay' 的记录必须挂一条
 * restoration_resolutions（derived_record_id 指向该记录，与 restoration-resolution-overlay.json
 * 的 create_derived_entity 同构）。
 */
function attachOverlayResolution(db, rec, stats) {
  if (!rec?.id || !rec?.canonical_id) return null;
  const existing = db.prepare('SELECT id FROM restoration_resolutions WHERE derived_record_id=?').get(Number(rec.id));
  if (existing) return { id: Number(existing.id), resolution_id: existing.resolution_id };
  const entityKind = rec.entity_kind ?? 'item';
  const resolutionId = `resolution.${entityKind}.${hash(rec.canonical_id, 16)}`;
  db.prepare(`INSERT INTO restoration_resolutions (resolution_id,action,entity_kind,derived_record_id,derived_canonical_id,display_name,restoration_status,originality_status,confidence,runtime_policy,decision_reason,unresolved_fields_json,created_from_baseline_commit,content_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(resolutionId, 'create_derived_entity', entityKind, Number(rec.id), rec.canonical_id, rec.display_name ?? null,
      rec.restoration_status ?? 'APPROVED_OVERLAY', rec.originality_status ?? 'UNVERIFIED_AS_ORIGINAL',
      rec.confidence ?? 'A', rec.runtime_selection ?? 'approved_overlay', rec.decision_reason ?? 'blocked-targets-adjudication',
      stableJson(rec.unresolved_fields ?? []), rec.created_from_baseline_commit ?? 'f61da146c551436d2c3afd5da4eb3eb817b8ab13',
      rec.content_hash ?? hash(rec.canonical_id, 32));
  stats.updated += 1;
  return { id: Number(existing?.id ?? 0), resolution_id: resolutionId };
}
function mkStats() { return { inserted: 0, updated: 0, skipped: 0, failures: 0, tables: {} }; }

// ---- 物品域（47 缺失 + 10 裁决，去重） -------------------------------------
const ITEMS = {
  山猪肉:{catalog:'taskItems'}, 龙虾肉:{catalog:'taskItems'}, 走私酒:{catalog:'taskItems'},
  乌龟壳:{catalog:'taskItems'}, 鲨鱼皮:{catalog:'taskItems'}, 兔毛:{catalog:'taskItems'},
  鳄鱼肉:{catalog:'taskItems'}, 虎皮:{catalog:'taskItems'}, 玳瑁壳:{catalog:'taskItems'},
  蛇胆:{catalog:'taskItems'}, 精铁矿:{catalog:'taskItems'}, 奶牛:{catalog:'taskItems'},
  锤子:{catalog:'taskItems'}, 白云果:{catalog:'taskItems'}, 破碎的破界符:{catalog:'taskItems'},
  千年黑珍珠:{catalog:'taskItems'}, 凤凰羽毛:{catalog:'taskItems'}, 巨红蜈蚣触须:{catalog:'taskItems'},
  亚特兰蒂斯航海图:{catalog:'taskItems'}, 岩虫壳:{catalog:'taskItems'}, 发光的岩石:{catalog:'taskItems'},
  野猪火腿:{catalog:'taskItems'}, 野狼王的粪便:{catalog:'taskItems'}, 红牛角:{catalog:'taskItems'},
  水晶矿:{catalog:'taskItems'}, 熊皮:{catalog:'taskItems'}, 玄龟壳:{catalog:'taskItems'},
  犯人档案:{catalog:'taskItems'}, 新鲜茶叶:{catalog:'taskItems'}, 玄铁矿石:{catalog:'taskItems'},
  枯木枝:{catalog:'taskItems'}, 火蝙蝠血液:{catalog:'taskItems'}, 云之果:{catalog:'taskItems'},
  火灵芝:{catalog:'taskItems'}, 千年白雪:{catalog:'taskItems'}, 地火精华:{catalog:'taskItems'},
  水之精:{catalog:'taskItems'}, 小良的毛笔:{catalog:'taskItems'}, 黑珍珠:{catalog:'taskItems'},
  龙鳞:{catalog:'taskItems'}, 渔网:{catalog:'taskAcceptanceItems'},
  黑铁矿:{catalog:'taskItems'}, 红薯:{catalog:'taskItems'}, 棕树木:{catalog:'taskItems'},
  熟透的葡萄:{catalog:'taskItems'}, 地蜘蛛:{catalog:'taskItems'}, 茯苓:{catalog:'taskItems'},
  玫瑰花:{catalog:'taskItems'}, 蛇牙草:{catalog:'taskItems'},
  陶瓷:{catalog:'shopItems',price:50}, 香草:{catalog:'shopItems',price:50}, 茶:{catalog:'shopItems',price:50},
  米:{catalog:'shopItems',price:10}, 木材:{catalog:'shopItems',price:50}, 小麦:{catalog:'shopItems',price:25},
  丝织品:{catalog:'shopItems',price:50}, 人参:{catalog:'shopItems',price:50},
};

// task_target 的 dependency_reference canonical_id -> 应解析到的物品名
const TARGET_RESOLUTION = {
  'task.series.02.012.target.01.reference':'山猪肉','task.series.02.012.target.02.reference':'龙虾肉',
  'task.series.04.018.target.01.reference':'走私酒','task.series.04.020.target.01.reference':'乌龟壳',
  'task.series.05.035.target.01.reference':'鲨鱼皮','task.series.07.042.target.01.reference':'兔毛',
  'task.series.08.047.target.01.reference':'鳄鱼肉','task.series.09.048.target.01.reference':'虎皮',
  'task.series.10.055.target.01.reference':'玳瑁壳','task.series.10.056.target.01.reference':'鳄鱼肉',
  'task.series.10.056.target.02.reference':'龙虾肉','task.series.10.056.target.03.reference':'山猪肉',
  'task.series.11.085.target.01.reference':'蛇胆','task.series.12.098.target.01.reference':'凤凰羽毛',
  'task.series.13.101.target.01.reference':'陶瓷','task.series.13.102.target.01.reference':'香草',
  'task.series.13.102.target.02.reference':'茶','task.series.13.103.target.01.reference':'陶瓷',
  'task.series.13.105.target.01.reference':'米','task.series.13.106.target.01.reference':'木材',
  'task.series.13.108.target.01.reference':'小麦','task.series.13.112.target.01.reference':'精铁矿',
  'task.series.13.120.target.01.reference':'陶瓷','task.series.13.122.target.01.reference':'丝织品',
  'task.series.13.128.target.01.reference':'木材','task.series.13.138.target.01.reference':'人参',
  'task.series.13.144.target.01.reference':'人参','task.series.13.159.target.01.reference':'巨红蜈蚣触须',
  'task.series.13.160.target.01.reference':'亚特兰蒂斯航海图','task.series.13.164.target.01.reference':'岩虫壳',
  'task.series.13.165.target.01.reference':'发光的岩石','task.series.14.175.target.01.reference':'野猪火腿',
  'task.series.15.192.target.01.reference':'鲨鱼皮','task.series.15.224.target.01.reference':'野狼王的粪便',
  'task.series.15.254.target.01.reference':'红牛角','task.series.15.264.target.01.reference':'锤子',
  'task.series.15.268.target.01.reference':'水晶矿','task.series.15.269.target.01.reference':'熊皮',
  'task.series.15.270.target.01.reference':'玄龟壳','task.series.15.290.target.01.reference':'犯人档案',
  'task.series.15.411.target.01.reference':'新鲜茶叶','task.series.15.416.target.01.reference':'玄铁矿石',
  'task.series.15.453.target.01.reference':'枯木枝','task.series.15.457.target.01.reference':'黑珍珠',
  'task.series.15.458.target.01.reference':'枯木枝','task.series.15.463.target.01.reference':'渔网',
  'task.series.15.466.target.01.reference':'火蝙蝠血液','task.series.15.467.target.01.reference':'火蝙蝠血液',
  'task.series.15.471.target.01.reference':'龙鳞','task.series.15.472.target.01.reference':'黑珍珠',
  'task.series.15.560.target.01.reference':'白云果','task.series.15.583.target.01.reference':'破碎的破界符',
  'task.series.15.584.target.01.reference':'云之果','task.series.15.601.target.01.reference':'小良的毛笔',
  'task.series.15.631.target.01.reference':'破碎的破界符','task.series.15.652.target.01.reference':'白云果',
  'task.series.15.670.target.01.reference':'火灵芝','task.series.15.726.target.01.reference':'千年白雪',
  'task.series.15.727.target.01.reference':'地火精华','task.series.15.728.target.01.reference':'千年黑珍珠',
  // cross_type（干佛草模式：target_kind=item，同名怪物已存在）
  'task.series.11.073.target.01.reference':'奶牛','task.series.13.129.target.01.reference':'黑铁矿',
  'task.series.13.134.target.01.reference':'红薯','task.series.15.181.target.01.reference':'棕树木',
  'task.series.15.186.target.01.reference':'熟透的葡萄','task.series.15.245.target.01.reference':'地蜘蛛',
  'task.series.15.245.target.02.reference':'茯苓','task.series.15.280.target.01.reference':'玫瑰花',
  'task.series.15.439.target.01.reference':'蛇牙草','task.series.15.561.target.01.reference':'水之精',
  'task.series.15.585.target.01.reference':'水之精','task.series.15.655.target.01.reference':'茯苓',
  'task.series.15.656.target.01.reference':'地蜘蛛',
};

// drop_relations：物品名 -> [宿主怪物名]（同名怪物 100% 掉落）
const DROP_HOSTS = {
  山猪肉:['山猪'], 龙虾肉:['龙虾'], 走私酒:['走私者'], 乌龟壳:['乌龟'], 鲨鱼皮:['鲨鱼','鲨鱼'],
  兔毛:['野兔'], 鳄鱼肉:['鳄鱼','鳄鱼'], 虎皮:['白虎'], 玳瑁壳:['玳瑁'], 蛇胆:['双头蛇'],
  精铁矿:['强悍劫匪'], 奶牛:['奶牛'], 锤子:['沼泽鼠'], 白云果:['白云之精'], 破碎的破界符:['白骨骷髅'],
  千年黑珍珠:['黑蚌'], 凤凰羽毛:['凤凰'], 巨红蜈蚣触须:['巨红蜈蚣'], 亚特兰蒂斯航海图:['巨红蜈蚣王'],
  岩虫壳:['火山岩虫'], 发光的岩石:['火岩结晶'], 野猪火腿:['红野猪'], 野狼王的粪便:['野狼王'],
  红牛角:['红牛头怪'], 水晶矿:['僵尸'], 熊皮:['巨熊'], 玄龟壳:['沼泽玄龟'], 犯人档案:['金丝猴'],
  新鲜茶叶:['茶虫'], 玄铁矿石:['血僵尸'], 枯木枝:['枯木树妖'], 火蝙蝠血液:['火蝙蝠'], 云之果:['白云之精'],
  火灵芝:['火山岩虫头领'], 千年白雪:['雪精灵'], 地火精华:['地火结晶'], 水之精:['清水之精'],
  小良的毛笔:['邪恶僵尸'], 黑铁矿:['黑铁矿'], 红薯:['红薯'], 棕树木:['棕树木'], 熟透的葡萄:['熟透的葡萄'],
  地蜘蛛:['地蜘蛛'], 茯苓:['茯苓'], 玫瑰花:['玫瑰花'], 蛇牙草:['蛇牙草'],
};

// C 组市场购买：物品名 -> 城市
const MARKET_PURCHASES = { 陶瓷:'泉州', 香草:'锡兰', 茶:'锡兰', 米:'孟买', 木材:'马达加斯加', 小麦:'长安', 丝织品:'杭州', 人参:'京都' };

// ③ 需新增安置的怪物
const NEW_PLACEMENTS = {
  '龙虾':{city:'威尼斯',location:'浅海'}, '巨红蜈蚣王':{city:'威尼斯',location:'甘风峡谷'},
  '僵尸':{city:'威尼斯',location:'矿山'}, '巨熊':{city:'威尼斯',location:'枯树林'},
  '火蝙蝠':{city:'莫桑比克',location:'幽暗谷'}, '黑蚌':{city:'大阪',location:'深海'},
  '白骨骷髅':{city:'长安',location:'望马坡'},
};

// ---- 落库辅助 --------------------------------------------------------------
function findMonsterId(db, name, level) {
  const rows = db.prepare('SELECT id,level FROM monster_definitions WHERE display_name=?').all(name);
  if (level != null) { const hit = rows.find((r) => Number(r.level) === Number(level)); if (hit) return Number(hit.id); }
  if (rows.length) return Number(rows[0].id);
  return null;
}
function findCityId(db, cityName) { return db.prepare('SELECT id FROM cities WHERE display_name=?').get(cityName)?.id ?? null; }
function findLocationId(db, cityId, locationName) { return db.prepare('SELECT id FROM locations WHERE city_id=? AND display_name=?').get(cityId, locationName)?.id ?? null; }

function ensureItemEntity(db, name, meta, stats, rtIds) {
  const runtime = rtIds.get(name);
  const finalCid = runtime?.canonical_id ?? sig('runtime.item', name);
  const normalized = runtime?.normalized_data
    ? { ...runtime.normalized_data, name }
    : { catalog: meta.catalog === 'shopItems' ? 'marketItems' : meta.catalog, name, price: meta.price ?? null };
  const catalog = runtime?.catalog ?? normalized.catalog ?? 'taskItems';
  const price = runtime?.price ?? meta.price ?? null;
  // 与运行时 JSON 强制对账：同名物品若存在非最终 id 的版本行，且最终 id 行不存在 → 改名；
  // 若最终 id 行已存在（双版本并存）→ 删除多余版本行（仅当无任何依赖引用指向它）。
  const legacyCid = sig('entity.item', name);
  if (legacyCid !== finalCid) {
    const legacy = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(legacyCid);
    if (legacy) {
      const finalRow = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(finalCid);
      if (!finalRow) {
        db.prepare('UPDATE content_entities SET canonical_id=?, source_canonical_id=? WHERE id=?').run(finalCid, finalCid, Number(legacy.id));
        stats.updated += 1;
      } else {
        // 双版本并存：仅当无引用时移除多余版本（drop/target/reward 引用均按行 id）
        const refs = db.prepare(`
          SELECT COUNT(*) c FROM (
            SELECT id FROM dependency_references WHERE resolved_content_entity_id=?
            UNION ALL SELECT id FROM task_targets WHERE content_entity_canonical_id=?
            UNION ALL SELECT id FROM task_rewards WHERE content_entity_canonical_id=?
          )`).get(Number(legacy.id), Number(legacy.id), Number(legacy.id)).c;
        if (Number(refs) === 0) {
          db.prepare('DELETE FROM items WHERE content_entity_id=?').run(Number(legacy.id));
          db.prepare('DELETE FROM content_entities WHERE id=?').run(Number(legacy.id));
          stats.updated += 1;
          stats.duplicate_item_rows_removed = (stats.duplicate_item_rows_removed ?? 0) + 1;
        } else {
          stats.failures += 1;
        }
      }
    }
  }
  const rec = upsertCanonical(db, 'restoration_records', {
    canonical_id: `derived.item.${hash(name, 16)}`, record_origin: 'overlay', entity_kind: 'item',
    display_name: name, raw_value_json: '{}', normalized_value_json: stableJson(normalized),
    restoration_status: 'APPROVED_OVERLAY', confidence: 'A', originality_status: 'UNVERIFIED_AS_ORIGINAL',
    decision_reason: 'blocked-targets-adjudication', conflicts_json: '[]', runtime_selection: 'approved_overlay',
    content_hash: hash(`item|${name}|${stableJson(normalized)}`),
  }, stats);
  let ce = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(finalCid);
  if (!ce) {
    db.prepare(`INSERT INTO content_entities (canonical_id,source_record_id,source_canonical_id,entity_category,display_name,raw_data_json,normalized_data_json) VALUES (?,?,?,?,?,?,?)`)
      .run(finalCid, Number(rec.id), finalCid, 'item', name, '{}', stableJson(normalized));
    stats.inserted += 1;
    ce = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(finalCid);
  } else {
    db.prepare('UPDATE content_entities SET normalized_data_json=? WHERE id=?').run(stableJson(normalized), Number(ce.id));
    stats.skipped += 1;
  }
  const itemExists = db.prepare('SELECT id FROM items WHERE content_entity_id=?').get(ce.id);
  if (!itemExists) {
    db.prepare('INSERT INTO items (content_entity_id,catalog,price) VALUES (?,?,?)').run(ce.id, catalog, price);
    stats.inserted += 1;
  } else {
    db.prepare('UPDATE items SET catalog=?, price=? WHERE content_entity_id=?').run(catalog, price, Number(ce.id));
    stats.skipped += 1;
  }
  return { entityId: Number(ce.id), canonicalId: finalCid };
}

function resolveTargetReference(db, refCanonicalId, entityId, kind, stats) {
  const row = db.prepare('SELECT id FROM dependency_references WHERE canonical_id=?').get(refCanonicalId);
  if (!row || entityId == null) { stats.failures += 1; return false; }
  const col = kind === 'item' ? 'resolved_content_entity_id' : kind === 'monster' ? 'resolved_monster_definition_id' : 'resolved_npc_definition_id';
  db.prepare(`UPDATE dependency_references SET resolution_status='resolved', ${col}=?, runtime_capability='queryable' WHERE id=?`).run(entityId, Number(row.id));
  stats.updated += 1;
  return true;
}

function ensureDropReference(db, cid, ctx, rawName, category, resolved, stats) {
  const rec = upsertCanonical(db, 'restoration_records', {
    canonical_id: `derived.dependency.${hash(`${ctx}|${cid}`, 16)}`, record_origin: 'overlay', entity_kind: 'dependency',
    display_name: `${ctx}:${rawName}`, raw_value_json: '{}', normalized_value_json: stableJson({ ctx, rawName, category }),
    restoration_status: 'APPROVED_OVERLAY', confidence: 'A', originality_status: 'UNVERIFIED_AS_ORIGINAL',
    decision_reason: 'blocked-targets-adjudication', conflicts_json: '[]', runtime_selection: 'approved_overlay',
    content_hash: hash(`dep|${ctx}|${cid}`),
  }, stats);
  let row = db.prepare('SELECT id FROM dependency_references WHERE canonical_id=?').get(cid);
  if (!row) {
    const isMonster = resolved.resolved_monster_definition_id != null;
    const resolvedCol = isMonster ? 'resolved_monster_definition_id' : 'resolved_content_entity_id';
    const resolvedVal = isMonster ? Number(resolved.resolved_monster_definition_id) : Number(resolved.resolved_content_entity_id);
    db.prepare(`INSERT INTO dependency_references (canonical_id,source_record_id,source_canonical_id,reference_context,raw_name,raw_category,raw_quantity,resolution_status,${resolvedCol},candidate_canonical_ids_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(cid, Number(rec.id), cid, ctx, rawName, category, null, 'resolved', resolvedVal, '[]', 'queryable');
    row = db.prepare('SELECT id FROM dependency_references WHERE canonical_id=?').get(cid);
    stats.inserted += 1;
  } else {
    if (resolved.resolved_monster_definition_id != null) {
      db.prepare("UPDATE dependency_references SET resolution_status='resolved',resolved_monster_definition_id=?,runtime_capability='queryable' WHERE id=?").run(Number(resolved.resolved_monster_definition_id), Number(row.id));
    } else if (resolved.resolved_content_entity_id != null) {
      db.prepare("UPDATE dependency_references SET resolution_status='resolved',resolved_content_entity_id=?,runtime_capability='queryable' WHERE id=?").run(Number(resolved.resolved_content_entity_id), Number(row.id));
    }
    stats.updated += 1;
  }
  return { id: Number(row.id), rid: Number(rec.id) };
}

function ensureDrop(db, monsterName, itemName, stats) {
  const monsterId = findMonsterId(db, monsterName);
  const item = db.prepare("SELECT ce.id FROM content_entities ce JOIN items i ON i.content_entity_id=ce.id WHERE ce.display_name=? AND ce.entity_category='item'").get(itemName);
  if (!monsterId || !item) { stats.failures += 1; return; }
  const monDef = db.prepare('SELECT canonical_id FROM monster_definitions WHERE id=?').get(monsterId);
  const tgtCid = sig('entity.drop_target', `${monDef.canonical_id}|${itemName}`);
  const tgtRef = ensureDropReference(db, tgtCid, 'drop_target', itemName, 'item', { resolved_content_entity_id: item.id }, stats);
  const dropCid = sig('entity.drop', `${monDef.canonical_id}|${itemName}`);
  const existing = db.prepare('SELECT id FROM drop_relations WHERE canonical_id=?').get(dropCid);
  if (!existing) {
    const srcCid = sig('entity.drop_source', `${monDef.canonical_id}|${itemName}`);
    const srcRef = ensureDropReference(db, srcCid, 'drop_source', monsterName, 'monster', { resolved_monster_definition_id: monsterId }, stats);
    db.prepare('INSERT INTO drop_relations (canonical_id,source_record_id,source_canonical_id,source_reference_id,target_reference_id,probability,quantity,raw_data_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(dropCid, Number(srcRef.rid), monDef.canonical_id, Number(srcRef.id), Number(tgtRef.id), 0.4, 1, stableJson({ source: 'monsterItems', item: itemName }), 'queryable');
    stats.inserted += 1;
  }
}

function ensureShopEntry(db, cityName, itemName, stats) {
  const city = db.prepare('SELECT id FROM cities WHERE display_name=?').get(cityName);
  const item = db.prepare("SELECT ce.id FROM content_entities ce JOIN items i ON i.content_entity_id=ce.id WHERE ce.display_name=? AND ce.entity_category='item'").get(itemName);
  if (!city || !item) { stats.failures += 1; return; }
  const def = db.prepare('SELECT id FROM shop_definitions WHERE display_name=? OR display_name=?').get(`${cityName}-百宝箱`, `${cityName}-老鼠药`) ?? db.prepare('SELECT id FROM shop_definitions WHERE display_name LIKE ?').get(`${cityName}-%`);
  if (!def) { stats.failures += 1; return; }
  const refCid = sig('entity.shop_entry', `${cityName}|${itemName}`);
  const ref = ensureDropReference(db, refCid, 'shop_entry', itemName, 'item', { resolved_content_entity_id: item.id }, stats);
  const cid = sig('entity.shop_item', `${cityName}|${itemName}`);
  const existing = db.prepare('SELECT id FROM shop_entries WHERE canonical_id=?').get(cid);
  if (!existing) {
    db.prepare('INSERT INTO shop_entries (canonical_id,shop_definition_id,source_record_id,source_canonical_id,content_reference_id,price,raw_data_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?)')
      .run(cid, Number(def.id), Number(ref.rid), cid, Number(ref.id), ITEMS[itemName].price ?? null, stableJson({ city: cityName, item: itemName }), 'queryable');
    stats.inserted += 1;
  }
}

/**
 * 清理早期 seed 生成的 entity.drop.* 行（幂等）。
 * 这些行与选择文件的 runtime.drop.* resolution 指向同一物品实体，会双写掉落。
 */
function cleanupSeedDrops(db, stats) {
  let removed = 0;
  for (const name of Object.keys(ITEMS)) {
    const payload = stableJson({ source: 'monsterItems', item: name });
    const rows = db.prepare("SELECT id FROM drop_relations WHERE canonical_id LIKE 'entity.drop.%' AND probability=1 AND raw_data_json=? AND quantity=1").all(payload);
    for (const row of rows) { db.prepare('DELETE FROM drop_relations WHERE id=?').run(Number(row.id)); removed += 1; }
  }
  if (removed) { stats.updated += 1; stats.cleaned_drop_rows = removed; }
}

/**
 * 补解析原版 importer 遗留的跨类型引用（幂等）：
 * 1) drop_target 类（怪物掉落同名采集物，如 水之精<-清水之精）→ resolve 到已入库的物品实体；
 * 2) task_reward 类（如 12.099 游侠腰带，实为装备实体）→ resolve 到装备实体；
 * 3) 无怪物来源的 drop 行（drop_source 引用 NPC 名误标）→ 删除该行。
 */
function resolveOrphanRefs(db, stats) {
  let resolved = 0;
  const refs = db.prepare(`
    SELECT r.id, r.raw_name, r.reference_context
    FROM dependency_references r
    WHERE r.resolution_status IN ('cross_type_suspected','ambiguous') AND r.resolution_status != 'resolved'
      AND (r.resolved_content_entity_id IS NULL OR r.reference_context='task_reward')`).all();
  for (const ref of refs) {
    const entity = db.prepare(`SELECT id FROM content_entities WHERE display_name=? ORDER BY id LIMIT 1`).get(ref.raw_name);
    if (!entity) continue;
    db.prepare("UPDATE dependency_references SET resolution_status='resolved',resolved_content_entity_id=?,runtime_capability='queryable' WHERE id=?").run(Number(entity.id), Number(ref.id));
    resolved += 1;
  }
  if (resolved) { stats.updated += 1; stats.resolved_orphan_refs = resolved; }
  // 仅处置明确失配的孤儿源：drop_source 引用错标为 NPC 名（原版记录 阿巴斯→黑铁矿）。
  // 注意：原版大量 source_label_only 的掉落行源引用未解析属既有状态（导出时 join 跳过），
  // 不做批量删除，避免破坏原版 data 行；其中 46 对裁决对应的行由
  // completeAdjudicationBaselineDrops 补齐（源/目标引用解析到裁决实体）。
  const orphanDrops = db.prepare(`
    SELECT d.id FROM drop_relations d
    JOIN dependency_references s ON s.id=d.source_reference_id
    WHERE s.canonical_id='entity.drop.7e13dfefe3a20715.source'`).all();
  if (orphanDrops.length) {
    for (const row of orphanDrops) db.prepare('DELETE FROM drop_relations WHERE id=?').run(Number(row.id));
    stats.cleaned_orphan_drop_rows = orphanDrops.length;
  }
}

/**
 * 补齐原版掉落行（46 对裁决的物品）：其原版（baseline，config/monsterDrops.json /
 * monsterItems.json 直录）掉落行在裁决落库时未重解析，仍停留在 source_label_only /
 * blocked（导出 join 跳过，仅作为原版资料保留）。本段把目标引用解析到裁决物品实体
 * （与 .overlay 行同实体），源引用按运行时权威（web/generated/task1-content.json 的
 * (怪物|物品) resolution，即选择文件 monster_drop 的落库镜像）解析到怪物定义；
 * 运行时无 resolution 的歧义源按裁决指定（如 妖龙→龙鳞 = Lv117）。
 * 源本身无实体的行（如 邪恶花精，仅出现在 monsterItems.json、无任何安置/定义）不虚构
 * 实体：目标侧照常补齐，源侧保持 label_only 原样保留。
 * 幂等：已解析/已 queryable 的行跳过。
 */
function completeAdjudicationBaselineDrops(db, itemEntity, stats) {
  const authority = loadRuntimeDropAuthority();
  const adjudicatedNames = new Set(Object.keys(ITEMS));
  const rows = db.prepare(`
    SELECT d.id drop_id,
           s.id src_id, s.raw_name src_name, s.resolution_status src_status, s.resolved_monster_definition_id src_mid,
           t.id tgt_id, t.raw_name tgt_name, t.resolution_status tgt_status, t.resolved_content_entity_id tgt_eid
    FROM drop_relations d
    JOIN restoration_records rec ON rec.id=d.source_record_id
    JOIN dependency_references s ON s.id=d.source_reference_id
    JOIN dependency_references t ON t.id=d.target_reference_id
    WHERE rec.record_origin='baseline' AND d.runtime_capability='blocked'`).all();
  let targetFixed = 0, sourceFixed = 0, capFixed = 0, unresolvable = 0;
  for (const row of rows) {
    if (!adjudicatedNames.has(row.tgt_name)) continue;
    const item = itemEntity[row.tgt_name];
    if (!item) { stats.failures += 1; continue; }
    // 目标引用：解析到裁决物品实体（与 overlay 掉落行同实体）
    let targetReady = row.tgt_status === 'resolved' && Number(row.tgt_eid) === Number(item.entityId);
    if (!targetReady) {
      db.prepare("UPDATE dependency_references SET resolution_status='resolved',resolved_content_entity_id=?,runtime_capability='queryable' WHERE id=?")
        .run(Number(item.entityId), Number(row.tgt_id));
      targetFixed += 1;
      targetReady = true;
    }
    // 源引用：已解析→保留；歧义/未解析→运行时权威（JSON (怪物|物品) resolution）；
    // 权威缺失且命中裁决指定→按指定；仍无实体→保持 label_only 原样保留。
    let sourceReady = row.src_status === 'resolved';
    if (!sourceReady) {
      const authorityCid = authority.pairMonster.get(`${row.src_name}\u0000${row.tgt_name}`);
      let def = authorityCid ? db.prepare('SELECT id FROM monster_definitions WHERE canonical_id=?').get(authorityCid) : null;
      if (!def && row.src_name === '妖龙' && row.tgt_name === '龙鳞') {
        def = db.prepare('SELECT id FROM monster_definitions WHERE display_name=? AND level=?').get('妖龙', 117); // 15.470 裁决：Lv117 杭州/西湖湖底
      }
      if (!def) {
        // 同名定义兜底：idle-assets-integration 建成同名怪物后（如 邪恶花精），原版掉落源不再悬空
        def = db.prepare('SELECT id FROM monster_definitions WHERE display_name=? ORDER BY id LIMIT 1').get(row.src_name);
      }
      if (def && Number(def.id) !== Number(row.src_mid)) {
        db.prepare("UPDATE dependency_references SET resolution_status='resolved',resolved_monster_definition_id=?,runtime_capability='queryable' WHERE id=?")
          .run(Number(def.id), Number(row.src_id));
        sourceFixed += 1;
        sourceReady = true;
      } else if (def) {
        sourceReady = true;
      } else {
        unresolvable += 1;
      }
    }
    if (!targetReady || !sourceReady) continue;
    const cap = db.prepare('SELECT runtime_capability FROM drop_relations WHERE id=?').get(row.drop_id).runtime_capability;
    if (cap !== 'queryable') {
      db.prepare("UPDATE drop_relations SET runtime_capability='queryable' WHERE id=?").run(Number(row.drop_id));
      capFixed += 1;
    }
  }
  if (targetFixed || sourceFixed || capFixed) {
    stats.updated += 1;
    stats.baseline_drop_targets_resolved = targetFixed;
    stats.baseline_drop_sources_resolved = sourceFixed;
    stats.baseline_drop_caps_fixed = capFixed;
  }
  if (unresolvable) stats.baseline_drops_source_unresolvable = unresolvable;
}

/**
 * 运行时掉落权威：web/generated/task1-content.json（选择文件 monster_drop resolution
 * 的导出镜像）中 (怪物名|物品名) → 怪物定义 canonical_id。与 loadRuntimeItemIds 同源，
 * 作为歧义源引用的裁决依据（与导出层 dedupe 同口径）。
 */
function loadRuntimeDropAuthority() {
  const entityName = new Map();
  const monsterName = new Map();
  const pairMonster = new Map();
  if (!fs.existsSync(RUNTIME_CONTENT_PATH)) return { pairMonster };
  const content = JSON.parse(fs.readFileSync(RUNTIME_CONTENT_PATH, 'utf8'));
  for (const e of content.content_entities ?? []) entityName.set(e.canonical_id, e.display_name);
  for (const e of content.equipment ?? []) entityName.set(e.canonical_id, e.display_name);
  for (const m of content.monsters ?? []) monsterName.set(m.canonical_id, m.display_name);
  for (const d of content.drop_relations ?? []) {
    const itemName = d.content_entity_canonical_id ? entityName.get(d.content_entity_canonical_id) : null;
    const monsterNm = d.monster_canonical_id ? monsterName.get(d.monster_canonical_id) : null;
    if (!itemName || !monsterNm) continue;
    const key = `${monsterNm}\u0000${itemName}`;
    // 同名多级（如 僵尸 Lv104/113）：任务场景 resolution（guaranteed_for_active_task）
    // 优先 —— 与裁决指定的宿主（15.415 矿洞僵尸 Lv113）同口径。
    if (!pairMonster.has(key) || d.guaranteed_for_active_task) pairMonster.set(key, d.monster_canonical_id);
  }
  return { pairMonster };
}

/**
 * NPC 错位裁决（引擎口径：listNpcsAtNode/isNpcAtLocation）：以任务原文本为准。
 * - A 类：NPC 唯一/可多驻、文本地点明确 → 在同城补 npc_placements（NPC 常住该点）；
 * - B 类：NPC 唯一驻留点 == 文本地点 → 把任务接取/提交位置改到该 canonical；
 * - C 类：NPC 指派错误（文本找的人 ≠ 库里引用的定义）→ 改 issuer/completion 引用（含位置）。
 * 幂等：全部走"存在即跳过/相等即跳过"。
 */
const NPC_PLACEMENT_FIXES = [
  // A 类：npc_canonical_id @ city/location
  { npc: 'derived.npc_definition.9b24322b8a4c3383', city: '亚丁', location: '古村落' },        // 阿巴斯 13.125-142
  { npc: 'derived.npc_definition.b48d09bfb7238066', city: '威尼斯', location: '住宅区' },        // 老人 15.287/288
  { npc: 'derived.npc_definition.112c41537d305d9c', city: '孟买', location: '养蜂屋' },          // 养蜂人 15.438/439
  { npc: 'derived.npc_definition.2130dba0818dff6d', city: '阿尔及尔', location: '居民区' },      // 大卫 15.455-457
  { npc: 'derived.npc_definition.4559aa62e59f03ff', city: '威尼斯', location: '废墟' },          // 索隆亚 15.291
  { npc: 'derived.npc_definition.9b6822ddc148d273', city: '威尼斯', location: '废弃堡垒' },      // 索隆亚监狱长 15.297
  { npc: 'derived.npc_definition.1a591b9cfe3b0695', city: '泉州', location: '酒馆' },            // 商人李 15.233
  { npc: 'derived.npc_definition.199c696318fc94a6', city: '亚特兰蒂斯', location: '码头' },      // 卡拉迪 13.162
  { npc: 'derived.npc_definition.6b51943c56cebd0a', city: '泉州', location: '丹霞山' },          // 狐仙小美 12.092/093（文本"丹霞山寻找狐仙小美"）
];

const NPC_LOCATION_RETARGETS = [
  // B 类：任务位置改到 NPC 唯一驻留点（task | side | 目标位置 canonical）
  ['task.series.15.497', 'submit', 'entity.location.8594952d4c68cbde'], // 蒙面人@威尼斯/荒野
  ['task.series.15.498', 'submit', 'entity.location.8594952d4c68cbde'],
  ['task.series.15.615', 'submit', 'entity.location.eaf3b23904bb6425'], // 警犬暴风@威尼斯/码头
  ['task.series.15.302', 'submit', 'entity.location.e28ff0fd9c85bf7d'], // 佐佐木@大阪/宅邸
  ['task.series.14.177', 'submit', 'entity.location.d671d0826cdb3016'], // 小丫@泉州/渔村
  ['task.series.15.634', 'submit', 'entity.location.891e95eceda9850a'], // 韩湘子@泉州/蓬莱仙岛云霄阁
  ['task.series.15.635', 'receive', 'entity.location.891e95eceda9850a'],
  ['task.series.15.635', 'submit', 'entity.location.891e95eceda9850a'],
  ['task.series.15.636', 'receive', 'entity.location.891e95eceda9850a'],
  ['task.series.15.647', 'submit', 'entity.location.891e95eceda9850a'],
  ['task.series.15.649', 'receive', 'entity.location.891e95eceda9850a'],
  ['task.series.15.688', 'submit', 'entity.location.891e95eceda9850a'],
  ['task.series.15.689', 'receive', 'entity.location.891e95eceda9850a'],
  ['task.series.13.166', 'submit', 'entity.location.15ae6a8396268cff'], // 江湖郎中@亚特兰蒂斯/酒馆
];

/**
 * 商店购买任务的 target id 对齐：引擎侧（SQLite）target 引用 allItems 目录实体，
 * 而购买走导出层 shop_entries 的 shopItems/marketItems 实体（EconomyRuntime.buy 落包 id）。
 * 服务端混合栈下两侧 id 必须一致，否则"买了东西任务不推进"。对齐到 JSON 导出层的 id。
 */
const SHOP_TARGET_ID_FIXES = [
  ['task.series.01.007.target.01.reference', 'entity.item.d14f96158fc5c4ec'], // 潜水镜
  ['task.series.05.023.target.01.reference', 'entity.item.7e58577435fee1fe'], // 狮子奶
  ['task.series.09.049.target.01.reference', 'entity.item.097b440c291db16d'], // 金瓶梅
  ['task.series.11.083.target.01.reference', 'entity.item.e6393da032f3c186'], // 香料
  ['task.series.13.116.target.01.reference', 'entity.item.7e58577435fee1fe'], // 狮子奶
  ['task.series.15.187.target.01.reference', 'entity.item.fd4174760618fabc'], // 泉水
  ['task.series.15.514.target.01.reference', 'runtime.market_item.97e7141015fbe129'], // 茶具
];

function fixShopTargetIds(db, stats) {
  let fixed = 0;
  for (const [refCid, targetEntityId] of SHOP_TARGET_ID_FIXES) {
    const ref = db.prepare('SELECT id,resolved_content_entity_id FROM dependency_references WHERE canonical_id=?').get(refCid);
    if (!ref) { stats.failures += 1; continue; }
    let entity = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(targetEntityId);
    if (!entity) {
      // shopItems/marketItems 实体未入 SQLite：按 JSON normalized_data 克隆（目录与定价与导出层一致）
      const content = JSON.parse(fs.readFileSync(RUNTIME_CONTENT_PATH, 'utf8'));
      const rt = (content.content_entities ?? []).find((e) => e.canonical_id === targetEntityId);
      if (!rt) { stats.failures += 1; continue; }
      const rec = upsertCanonical(db, 'restoration_records', {
        canonical_id: `derived.item.${hash(rt.display_name, 16)}.shop-variant`, record_origin: 'overlay', entity_kind: 'item',
        display_name: rt.display_name, raw_value_json: '{}', normalized_value_json: stableJson(rt.normalized_data ?? {}),
        restoration_status: 'APPROVED_OVERLAY', confidence: 'A', originality_status: 'UNVERIFIED_AS_ORIGINAL',
        decision_reason: 'blocked-targets-adjudication-shop-target-id', conflicts_json: '[]', runtime_selection: 'approved_overlay',
        content_hash: hash(`item-shop|${targetEntityId}`),
      }, stats);
      db.prepare(`INSERT INTO content_entities (canonical_id,source_record_id,source_canonical_id,entity_category,display_name,raw_data_json,normalized_data_json) VALUES (?,?,?,?,?,?,?)`)
        .run(targetEntityId, Number(rec.id), targetEntityId, 'item', rt.display_name, '{}', stableJson(rt.normalized_data ?? {}));
      entity = db.prepare('SELECT id FROM content_entities WHERE canonical_id=?').get(targetEntityId);
      db.prepare('INSERT INTO items (content_entity_id,catalog,price) VALUES (?,?,?)')
        .run(Number(entity.id), rt.normalized_data?.catalog ?? 'shopItems', rt.normalized_data?.price ?? null);
      stats.inserted += 1;
    }
    if (Number(ref.resolved_content_entity_id) === Number(entity.id)) continue;
    db.prepare("UPDATE dependency_references SET resolution_status='resolved',resolved_content_entity_id=?,runtime_capability='queryable' WHERE id=?").run(Number(entity.id), Number(ref.id));
    fixed += 1;
  }
  if (fixed) { stats.shop_target_ids_fixed = fixed; stats.updated += 1; }
}

const NPC_REFERENCE_FIXES = [
  // C 类：NPC 指派修正（task | side | npc canonical | 位置 canonical）
  ['task.series.05.039', 'issuer', 'derived.npc_definition.22ba5d6986eb91c4', 'entity.location.5be6ea0b60be0270'], // 罗西@威尼斯/居民区
  ['task.series.13.143', 'issuer', 'derived.npc_definition.03030119c55991e5', 'entity.location.14af2737a7ce2013'], // 侯赛因@荷姆兹/商店
  ['task.series.13.163', 'issuer', 'derived.npc_definition.6bfe677a55c86a02', 'entity.location.d578c5c2a89afaed'], // 马尔巴克@亚特兰蒂斯/村庄
  ['task.series.13.163', 'completion', 'derived.npc_definition.6bfe677a55c86a02', 'entity.location.d578c5c2a89afaed'],
  ['task.series.15.440', 'issuer', 'derived.npc_definition.1162e05bf414051a', 'entity.location.ef9343fa9b5c9210'], // 兰特斯@突尼斯/警察局
  ['task.series.15.519', 'completion', 'derived.npc_definition.a3bb0b619be3f60f', 'entity.location.5ac449a61f94e309'], // 张真人@长安/三清观
  ['task.series.15.520', 'issuer', 'derived.npc_definition.a3bb0b619be3f60f', 'entity.location.5ac449a61f94e309'],
  ['task.series.15.520', 'completion', 'derived.npc_definition.a3bb0b619be3f60f', 'entity.location.5ac449a61f94e309'],
  ['task.series.15.521', 'issuer', 'derived.npc_definition.a3bb0b619be3f60f', 'entity.location.5ac449a61f94e309'],
  ['task.series.07.041', 'issuer', 'derived.npc_definition.a73122cf3fc3ea7d', 'entity.location.4a8af28f92e5aa61'], // 露丝@威尼斯/酒馆
];

function fixNpcAdjudication(db, stats) {
  let placements = 0, retargeted = 0, refixed = 0;
  // A 类：补放置（存在即跳过；NPC/城市/位置任一缺则失败计数）
  for (const fix of NPC_PLACEMENT_FIXES) {
    const npc = db.prepare('SELECT id FROM npc_definitions WHERE canonical_id=?').get(fix.npc);
    const city = db.prepare('SELECT id FROM cities WHERE display_name=?').get(fix.city);
    const loc = city ? db.prepare('SELECT id,canonical_id FROM locations WHERE city_id=? AND display_name=?').get(city.id, fix.location) : null;
    if (!npc || !loc) { stats.failures += 1; continue; }
    const cid = sig('entity.npc_placement', `${fix.npc}|${loc.canonical_id}`);
    if (db.prepare('SELECT id FROM npc_placements WHERE canonical_id=?').get(cid)) continue;
    const displayName = db.prepare('SELECT display_name FROM npc_definitions WHERE id=?').get(npc.id).display_name;
    const node = db.prepare('SELECT id FROM map_nodes WHERE location_id=? AND runtime_capability=?').get(loc.id, 'queryable');
    if (!node) { stats.failures += 1; continue; }
    const rec = upsertCanonical(db, 'restoration_records', {
      canonical_id: `derived.npc_placement.${hash(`${fix.npc}|${loc.canonical_id}`, 16)}`, record_origin: 'overlay', entity_kind: 'npc_placement',
      display_name: `${displayName}@${fix.city}/${fix.location}`, raw_value_json: '{}',
      normalized_value_json: stableJson({ npc: displayName, city: fix.city, location: fix.location }),
      restoration_status: 'APPROVED_OVERLAY', confidence: 'A', originality_status: 'UNVERIFIED_AS_ORIGINAL',
      decision_reason: 'blocked-targets-adjudication-npc-location', conflicts_json: '[]', runtime_selection: 'approved_overlay',
      content_hash: hash(`npcp|${fix.npc}|${fix.city}|${fix.location}`),
    }, stats);
    db.prepare(`INSERT INTO npc_placements (canonical_id,source_record_id,source_canonical_id,npc_definition_id,map_node_id,location_id,runtime_capability)
      VALUES (?,?,?,?,?,?,?)`)
      .run(cid, Number(rec.id), cid, Number(npc.id), Number(node.id), Number(loc.id), 'queryable');
    placements += 1;
  }
  // B 类：改任务位置
  for (const [taskId, side, locCid] of NPC_LOCATION_RETARGETS) {
    const taskRow = db.prepare('SELECT id FROM task_definitions WHERE canonical_id=?').get(taskId);
    if (!taskRow) { stats.failures += 1; continue; }
    const loc = db.prepare('SELECT id FROM locations WHERE canonical_id=?').get(locCid);
    if (!loc) { stats.failures += 1; continue; }
    const col = side === 'receive' ? 'receive_location_id' : 'submit_location_id';
    const cur = db.prepare(`SELECT ${col} FROM task_definitions WHERE id=?`).get(taskRow.id)[col];
    if (Number(cur) === Number(loc.id)) continue;
    db.prepare(`UPDATE task_definitions SET ${col}=? WHERE id=?`).run(Number(loc.id), Number(taskRow.id));
    retargeted += 1;
  }
  // C 类：改 NPC 指派（含位置）
  for (const [taskId, side, npcCid, locCid] of NPC_REFERENCE_FIXES) {
    const taskRow = db.prepare('SELECT id FROM task_definitions WHERE canonical_id=?').get(taskId);
    const npc = db.prepare('SELECT id FROM npc_definitions WHERE canonical_id=?').get(npcCid);
    const loc = db.prepare('SELECT id FROM locations WHERE canonical_id=?').get(locCid);
    if (!taskRow || !npc || !loc) { stats.failures += 1; continue; }
    const npcCol = side === 'issuer' ? 'issuer_npc_definition_id' : 'completion_npc_definition_id';
    const locCol = side === 'issuer' ? 'receive_location_id' : 'submit_location_id';
    const curNpc = db.prepare(`SELECT ${npcCol} FROM task_definitions WHERE id=?`).get(taskRow.id)[npcCol];
    const curLoc = db.prepare(`SELECT ${locCol} FROM task_definitions WHERE id=?`).get(taskRow.id)[locCol];
    const sameNpc = Number(curNpc) === Number(npc.id);
    const sameLoc = Number(curLoc) === Number(loc.id);
    if (sameNpc && sameLoc) continue;
    db.prepare(`UPDATE task_definitions SET ${npcCol}=?,${locCol}=? WHERE id=?`).run(Number(npc.id), Number(loc.id), Number(taskRow.id));
    refixed += 1;
  }
  if (placements) { stats.npc_placements_added = placements; stats.updated += 1; }
  if (retargeted) { stats.npc_locations_retargeted = retargeted; stats.updated += 1; }
  if (refixed) { stats.npc_references_fixed = refixed; stats.updated += 1; }
}

/**
 * 尾部统一补 provenance：所有 record_origin='overlay' 且缺 restoration_resolutions 的记录
 * （含早期版本 seed 创建的记录与后续新增），保证 validator complete_provenance 通过。
 */
function ensureAllOverlayResolutions(db, stats) {
  const missing = db.prepare(`
    SELECT r.id,r.canonical_id,r.display_name,r.entity_kind,r.restoration_status,r.originality_status,
      r.confidence,r.runtime_selection,r.decision_reason,r.raw_value_json,r.normalized_value_json,r.content_hash
    FROM restoration_records r
    WHERE r.record_origin='overlay' AND NOT EXISTS(SELECT 1 FROM restoration_resolutions x WHERE x.derived_record_id=r.id)`).all();
  for (const rec of missing) {
    const normalized = (() => { try { return JSON.parse(rec.normalized_value_json ?? '{}'); } catch { return {}; } })();
    const resolutionId = `resolution.${rec.entity_kind ?? 'item'}.${hash(rec.canonical_id, 16)}`;
    db.prepare(`INSERT INTO restoration_resolutions (resolution_id,action,entity_kind,derived_record_id,derived_canonical_id,display_name,restoration_status,originality_status,confidence,runtime_policy,decision_reason,unresolved_fields_json,created_from_baseline_commit,content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(resolutionId, 'create_derived_entity', rec.entity_kind ?? 'item', Number(rec.id), rec.canonical_id,
        rec.display_name ?? null, rec.restoration_status ?? 'APPROVED_OVERLAY', rec.originality_status ?? 'UNVERIFIED_AS_ORIGINAL',
        rec.confidence ?? 'A', rec.runtime_selection ?? 'approved_overlay', rec.decision_reason ?? 'blocked-targets-adjudication',
        stableJson(normalized?.unresolved_fields ?? []), 'f61da146c551436d2c3afd5da4eb3eb817b8ab13', rec.content_hash ?? hash(rec.canonical_id, 32));
    stats.updated += 1;
  }
  return missing.length;
}

function ensureRewardGrant(db, taskCid, itemName, itemEnt, stats) {  if (!itemEnt) { stats.failures += 1; return; }
  const task = db.prepare('SELECT id FROM task_definitions WHERE canonical_id=?').get(taskCid);
  if (!task) { stats.failures += 1; return; }
  const exists = db.prepare(`SELECT tr.id, tr.dependency_reference_id FROM task_rewards tr WHERE tr.task_id=? AND tr.reward_name=?`).get(task.id, itemName);
  if (exists) {
    // 既有原版奖励行：引用未解析时补齐到裁决实体（导出层要求 resolved 才入运行时身份）
    if (exists.dependency_reference_id) {
      const ref = db.prepare('SELECT id, resolution_status, resolved_content_entity_id FROM dependency_references WHERE id=?').get(exists.dependency_reference_id);
      if (ref && (ref.resolution_status !== 'resolved' || Number(ref.resolved_content_entity_id ?? 0) !== Number(itemEnt.entityId))) {
        db.prepare("UPDATE dependency_references SET resolution_status='resolved',resolved_content_entity_id=?,runtime_capability='queryable' WHERE id=?").run(Number(itemEnt.entityId), Number(ref.id));
        stats.updated += 1;
      }
    }
    return;
  }
  const refCid = sig('entity.task_reward', `${taskCid}|${itemName}`);
  const ref = ensureDropReference(db, refCid, 'task_reward', itemName, 'item', { resolved_content_entity_id: itemEnt.entityId }, stats);
  const orderRow = db.prepare('SELECT COALESCE(MAX(reward_order),0) o FROM task_rewards WHERE task_id=?').get(task.id);
  db.prepare('INSERT INTO task_rewards (canonical_id,task_id,source_record_id,source_canonical_id,reward_order,reward_kind,reward_name,raw_quantity,normalized_quantity,dependency_reference_id,raw_value_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(sig('entity.task_reward', `${taskCid}|${itemName}`), Number(task.id), Number(ref.rid), taskCid, Number(orderRow.o) + 1, 'item', itemName, '1', 1, Number(ref.id), stableJson({ item: itemName, quantity: 1 }));
  stats.inserted += 1;
}

// ---- 主入口 ---------------------------------------------------------------
function runAdjudicate({ dbPath = DB_PATH, dryRun = false } = {}) {
  const stats = mkStats();
  const db = openDatabase(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const rtIds = loadRuntimeItemIds();
    const itemEntity = {};
    for (const [name, meta] of Object.entries(ITEMS)) itemEntity[name] = ensureItemEntity(db, name, meta, stats, rtIds);
    // 15.631/15.652 原版把收集物名误标为 monster 目标，文本是“杀白骨骷髅/白云之精收集物”，修正为 item 收集
    for (const tid of ['task.series.15.631', 'task.series.15.652']) {
      db.prepare("UPDATE task_targets SET target_kind='item' WHERE task_id=(SELECT id FROM task_definitions WHERE canonical_id=?)").run(tid);
    }
    for (const [refCid, name] of Object.entries(TARGET_RESOLUTION)) {
      if (itemEntity[name]) resolveTargetReference(db, refCid, itemEntity[name].entityId, 'item', stats);
    }
    resolveOrphanRefs(db, stats);
    // 掉落实体以库内 drop_relations 为准（select-runnable-tasks 的 evaluateAllTasks
    // 从库推 formal source；选择文件只是导出快照）。市场采购条目仍由选择文件 market 类
    // resolution 提供（导出层 runtime.market_entry.*，无库内双写）。
    for (const [itemName, hosts] of Object.entries(DROP_HOSTS)) for (const host of hosts) ensureDrop(db, host, itemName, stats);
    // 46 对裁决的物品：原版（baseline）掉落行本段补齐（目标/源引用 → 裁决实体）
    completeAdjudicationBaselineDrops(db, itemEntity, stats);
    for (const [monsterName, p] of Object.entries(NEW_PLACEMENTS)) {
      const monsterId = findMonsterId(db, monsterName);
      const cityId = findCityId(db, p.city);
      const locId = findLocationId(db, cityId, p.location);
      if (!monsterId || !locId) { stats.failures += 1; continue; }
      const cid = sig('entity.monster_placement', `${monsterName}|${p.city}|${p.location}`);
      const existing = db.prepare('SELECT id FROM monster_placements WHERE canonical_id=?').get(cid);
      if (!existing) {
        const rec = upsertCanonical(db, 'restoration_records', {
          canonical_id: `derived.monster_placement.${hash(`${monsterName}|${p.city}|${p.location}`, 16)}`, record_origin: 'overlay', entity_kind: 'monster_placement',
          display_name: `${monsterName}@${p.city}/${p.location}`, raw_value_json: '{}', normalized_value_json: stableJson({ monster: monsterName, city: p.city, location: p.location }),
          restoration_status: 'APPROVED_OVERLAY', confidence: 'A', originality_status: 'UNVERIFIED_AS_ORIGINAL',
          decision_reason: 'blocked-targets-adjudication', conflicts_json: '[]', runtime_selection: 'approved_overlay',
          content_hash: hash(`mp|${monsterName}|${p.city}|${p.location}`),
        }, stats);
        db.prepare('INSERT INTO monster_placements (canonical_id,source_record_id,source_canonical_id,monster_definition_id,location_id,raw_city_name,raw_location_name,location_resolution_status,raw_data_json,normalized_data_json,runtime_capability) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(cid, Number(rec.id), cid, Number(monsterId), Number(locId), p.city, p.location, 'resolved', '{}', stableJson({ monster: monsterName, city: p.city, location: p.location }), 'queryable');
        stats.inserted += 1;
      }
    }
    ensureRewardGrant(db, 'task.series.15.462', '渔网', itemEntity['渔网'], stats);
    ensureRewardGrant(db, 'task.series.15.471', '黑珍珠', itemEntity['黑珍珠'], stats);
    // 链传递前置奖励（引擎侧同步）：15.456 杀海怪得黑珍珠、15.470 杀妖龙得龙鳞
    ensureRewardGrant(db, 'task.series.15.456', '黑珍珠', itemEntity['黑珍珠'], stats);
    ensureRewardGrant(db, 'task.series.15.470', '龙鳞', itemEntity['龙鳞'], stats);
    fixNpcAdjudication(db, stats);
    fixShopTargetIds(db, stats);
    ensureAllOverlayResolutions(db, stats);
    const zombieLv113 = findMonsterId(db, '僵尸', 113);
    resolveTargetReference(db, 'task.series.15.415.target.01.reference', zombieLv113, 'monster', stats);
    const luNpc = db.prepare("SELECT id FROM npc_definitions WHERE display_name='吕洞宾'").get();
    if (luNpc) {
      db.prepare("UPDATE task_targets SET target_kind='npc_duel' WHERE dependency_reference_id=(SELECT id FROM dependency_references WHERE canonical_id='task.series.15.698.target.01.reference')").run();
      db.prepare("UPDATE dependency_references SET resolution_status='resolved',resolved_npc_definition_id=?,runtime_capability='queryable' WHERE canonical_id='task.series.15.698.target.01.reference'").run(Number(luNpc.id));
      stats.updated += 1;
    }
    if (dryRun) { db.exec('ROLLBACK'); } else { db.exec('COMMIT'); }
    const remain = db.prepare("SELECT COUNT(*) c FROM dependency_references WHERE resolution_status IN ('blocked_missing_definition','cross_type_suspected')").get();
    return { ok: true, stats, remaining_unresolved_task_refs: Number(remain.c), db: path.relative(PROJECT_ROOT, dbPath) };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    return { ok: false, error: error.message, stats };
  } finally {
    try { db.close(); } catch {}
  }
}

module.exports = { runAdjudicate };
if (require.main === module) {
  const result = runAdjudicate({ dryRun: process.argv.includes('--dry-run') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
