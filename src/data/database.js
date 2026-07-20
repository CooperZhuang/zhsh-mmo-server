'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SCHEMA_PATH = path.join(PROJECT_ROOT, 'db', 'schema.sql');
const V1_MIGRATION_PATH = path.join(PROJECT_ROOT, 'db', 'migrations', '002-full-static-content.sql');

function assertRuntimeCapabilities() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`Incompatible Node.js ${process.version}: this importer requires Node.js 22.5+ with built-in node:sqlite.`);
  }
  try {
    const sqlite = require('node:sqlite');
    if (typeof sqlite.DatabaseSync !== 'function') throw new Error('DatabaseSync is unavailable');
    return sqlite;
  } catch (error) {
    throw new Error(`Incompatible Node.js runtime: built-in node:sqlite is required (${error.message}).`);
  }
}

function stableJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function hash(value, length = 64) {
  const input = Buffer.isBuffer(value) || typeof value === 'string' ? value : stableJson(value);
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}

function openDatabase(filename = ':memory:') {
  const { DatabaseSync } = assertRuntimeCapabilities();
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

function initializeSchema(db, schemaPath = DEFAULT_SCHEMA_PATH) {
  const hasMetadata = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_metadata'").get();
  if (Number(hasMetadata.count) > 0) {
    const version = db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").get()?.value;
    if (version === '1') {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`BEGIN IMMEDIATE;\n${fs.readFileSync(V1_MIGRATION_PATH, 'utf8')}\nCOMMIT;`);
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
        throw new Error(`Schema v1 to v2 migration failed: ${error.message}`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
}

function getRowByCanonicalId(db, table, canonicalId) {
  return db.prepare(`SELECT * FROM ${table} WHERE canonical_id = ?`).get(canonicalId);
}

function getId(db, table, canonicalId) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE canonical_id = ?`).get(canonicalId);
  if (!row) throw new Error(`Missing dependency: ${table}.${canonicalId}`);
  return Number(row.id);
}

function rowsEqual(existing, values) {
  return Object.entries(values).every(([key, value]) => {
    const left = existing[key];
    if (typeof left === 'bigint') return Number(left) === value;
    return left === value;
  });
}

function recordOperation(stats, table, operation) {
  stats[operation] += 1;
  stats.tables[table] ??= { inserted: 0, updated: 0, skipped: 0 };
  stats.tables[table][operation] += 1;
}

function upsertCanonical(db, table, values, stats) {
  const existing = getRowByCanonicalId(db, table, values.canonical_id);
  if (!existing) {
    const keys = Object.keys(values);
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((key) => values[key]));
    recordOperation(stats, table, 'inserted');
    return getRowByCanonicalId(db, table, values.canonical_id);
  }
  if (rowsEqual(existing, values)) {
    recordOperation(stats, table, 'skipped');
    return existing;
  }
  const keys = Object.keys(values).filter((key) => key !== 'canonical_id');
  db.prepare(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE canonical_id = ?`).run(...keys.map((key) => values[key]), values.canonical_id);
  recordOperation(stats, table, 'updated');
  return getRowByCanonicalId(db, table, values.canonical_id);
}

function upsertComposite(db, table, keyValues, values, stats) {
  const where = Object.keys(keyValues).map((key) => `${key} = ?`).join(' AND ');
  const existing = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...Object.values(keyValues));
  const merged = { ...keyValues, ...values };
  if (!existing) {
    const keys = Object.keys(merged);
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((key) => merged[key]));
    recordOperation(stats, table, 'inserted');
    return;
  }
  if (rowsEqual(existing, merged)) {
    recordOperation(stats, table, 'skipped');
    return;
  }
  const keys = Object.keys(values);
  db.prepare(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE ${where}`).run(...keys.map((key) => values[key]), ...Object.values(keyValues));
  recordOperation(stats, table, 'updated');
}

function createStats() {
  return { inserted: 0, updated: 0, skipped: 0, conflicts: 0, failures: 0, tables: {} };
}

module.exports = {
  assertRuntimeCapabilities,
  DEFAULT_SCHEMA_PATH,
  PROJECT_ROOT,
  createStats,
  getId,
  hash,
  initializeSchema,
  openDatabase,
  stableJson,
  upsertCanonical,
  upsertComposite,
};
