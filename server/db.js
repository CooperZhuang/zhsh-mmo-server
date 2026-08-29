'use strict';
/**
 * 纵横四海 · 网游服务器 — 运行时数据库与权威引擎装配
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
    // openSqliteRuntime 默认 seriesCanonicalId 为 task.series.01；服务器用全部系列
    seriesCanonicalId: 'task.series.01',
  });
  // 方案A：WAL 模式避免读写锁冲突（建库后开启）
  try { rt.storage.db.exec('PRAGMA journal_mode=WAL;'); } catch {}
  // 若为全新副本，任务运行时迁移已在 openSqliteRuntime 内 applyMigration 完成
  return { ...rt, fresh, runtimeDbPath: RUNTIME_DB };
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
