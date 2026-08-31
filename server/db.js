'use strict';
/**
 * 纵横四海 · 网游服务器 — 运行时数据库与裁决引擎装配
 *
 * 单库方案：玩家存档表（player_profiles 等）与内容表外键互引，必须同库。
 * 做法：复制内容库到 server/data/runtime.sqlite 作为服务端运行时库，
 *      不污染原始内容库；用 openSqliteRuntime 装配 catalog+storage+engine。
 */
const path = require('node:path');
const fs = require('node:fs');
const { openSqliteRuntime } = require('../src/task-runtime/index.js');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_DB = process.env.ZHSH_CONTENT_DB || path.join(ROOT, 'data', 'zhsh-content.sqlite');
const RUNTIME_DB = process.env.ZHSH_RUNTIME_DB || path.join(__dirname, 'data', 'runtime.sqlite');
const ACCOUNT_DB = path.join(__dirname, 'data', 'accounts.db');

function ensureRuntimeDb() {
  fs.mkdirSync(path.dirname(RUNTIME_DB), { recursive: true });
  const fresh = !fs.existsSync(RUNTIME_DB);
  if (fresh) fs.copyFileSync(CONTENT_DB, RUNTIME_DB);
  return fresh;
}

function openAuthority() {
  if (!fs.existsSync(CONTENT_DB)) throw new Error(`内容库缺失: ${CONTENT_DB}`);
  const fresh = ensureRuntimeDb();
  const rt = openSqliteRuntime(RUNTIME_DB, {
    // 主线以原版任务线为骨架：加载全部 15 个系列，从 task.series.01 起步，按序推进至系列15。
    seriesCanonicalId: 'task.series.01',
    seriesCanonicalIds: ['task.series.01','task.series.02','task.series.03','task.series.04','task.series.05','task.series.06','task.series.07','task.series.08','task.series.09','task.series.10','task.series.11','task.series.12','task.series.13','task.series.14','task.series.15'],
  });
  // 引擎 createPlayer 的 defeat_return 取自 catalog.content.gameplay_rules；
  // SQLite 目录不持有内容包，这里挂上权威 gameplay_rules（否则败退回退到出生点酒馆）。
  try {
    rt.catalog.content = { gameplay_rules: JSON.parse(fs.readFileSync(path.join(path.dirname(CONTENT_DB), '..', 'web', 'generated', 'task1-content.json'), 'utf8')).gameplay_rules };
  } catch { /* 规则缺失时维持 firstNode 兜底 */ }
  // 方案A：WAL 模式避免读写锁冲突（建库后开启）
  try { rt.storage.db.exec('PRAGMA journal_mode=WAL;'); } catch {}
  // 若为全新副本，任务运行时迁移已在 openSqliteRuntime 内 applyMigration 完成
  return { ...rt, fresh, runtimeDbPath: RUNTIME_DB };
}

/**
 * 把选择文件（global-runtime-task-selection.json）的任务上下文 NPC 放置灌入引擎目录。
 * 与浏览器导出层同源同语义：部分任务的接取/提交 NPC 只在其任务位置出现于
 * runtime.npc_placement.*（contextual），SQLite 引擎补齐后才能完成"对话接取→提交"校验。
 */
function feedContextualNpcPlacements(catalog) {
  const selectionPath = path.join(ROOT, 'data', 'generated', 'global-runtime-task-selection.json');
  if (!fs.existsSync(selectionPath)) return;
  const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  let count = 0;
  for (const task of selection.selected_tasks ?? []) {
    for (const placement of task.evidence?.contextual_npc_placements ?? []) {
      catalog.addContextualNpcPlacement(placement.npc_canonical_id, placement.location_canonical_id, {
        task_canonical_id: placement.task_canonical_id ?? task.canonical_id,
        appearance_statuses: placement.appearance_statuses ?? [],
      });
      count += 1;
    }
  }
  if (count) console.log(`[ZHSH] contextual NPC placements registered: ${count}`);
}

/** 账号库（独立 sqlite，非玩家存档） */
function openAccountStore() {
  fs.mkdirSync(path.dirname(ACCOUNT_DB), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(ACCOUNT_DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      player_canonical_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

module.exports = { openAuthority, openAccountStore, CONTENT_DB, RUNTIME_DB, ACCOUNT_DB };
