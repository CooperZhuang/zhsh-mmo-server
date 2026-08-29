'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Structured, rotating file logger for the ZHSH game server.
 *
 * Every entry is written as a single JSON line (one object per line) so logs can
 * be grep'd, jq-filtered and replayed like an event stream. The same entry is
 * mirrored to stdout/stderr for operators watching the terminal.
 *
 * Rotation is size based: once the primary file exceeds `maxBytes`, it is rolled
 * to `.1`, existing rolls shift up (`.1` -> `.2`, ...), and only `maxFiles` are kept.
 * Writes are synchronous (appendFileSync) so nothing is lost when the process is
 * killed or calls process.exit() — a requirement for a game server that shuts
 * down on Ctrl+C / SIGINT / SIGTERM.
 */
const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

function defaultLevel() {
  const value = String(process.env.ZHSH_LOG_LEVEL || 'INFO').toUpperCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, value) ? value : 'INFO';
}

function defaultLogDir() {
  return path.join(__dirname, '.zhsh-logs');
}

class Logger {
  constructor({
    dir = defaultLogDir(),
    filename = 'game.log',
    level = defaultLevel(),
    maxBytes = 5 * 1024 * 1024,
    maxFiles = 5,
    mirrorConsole = true,
  } = {}) {
    this.dir = dir;
    this.filename = filename;
    this.filePath = path.join(dir, filename);
    this.level = level;
    this.threshold = LEVELS[level];
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.mirrorConsole = mirrorConsole;
    this.warnings = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.filePath)) fs.closeSync(fs.openSync(this.filePath, 'a'));
    } catch (error) {
      // Never let a logging failure take down the game server.
      this.warnings.push({ at: new Date().toISOString(), error: error.message });
      this.filePath = null;
    }
  }

  log(level, cat, msg, meta) {
    const name = String(level || 'INFO').toUpperCase();
    const weight = LEVELS[name] ?? LEVELS.INFO;
    if (weight < this.threshold) return;
    const entry = { ts: new Date().toISOString(), level: name, cat: String(cat || 'app'), msg: String(msg ?? '') };
    if (meta !== undefined && meta !== null) entry.meta = meta;
    const line = JSON.stringify(entry);
    this._write(line);
    this._mirror(entry);
  }

  debug(cat, msg, meta) { this.log('DEBUG', cat, msg, meta); }
  info(cat, msg, meta) { this.log('INFO', cat, msg, meta); }
  warn(cat, msg, meta) { this.log('WARN', cat, msg, meta); }
  error(cat, msg, meta) { this.log('ERROR', cat, msg, meta); }

  _write(line) {
    if (!this.filePath) return;
    try {
      let size = 0;
      try { size = fs.statSync(this.filePath).size; } catch {}
      fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
      if (size + line.length + 1 > this.maxBytes) this._rotate();
    } catch (error) {
      // Never throw out of a log write; degrade to console only.
      this.filePath = null;
      try { process.stderr.write(`[logger] write failed: ${error.message}\n`); } catch {}
    }
  }

  _rotate() {
    try {
      const keep = Math.max(1, this.maxFiles);
      for (let i = keep - 1; i >= 1; i -= 1) {
        const from = `${this.filePath}.${i}`;
        const to = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(from)) {
          fs.rmSync(to, { force: true });
          fs.renameSync(from, to);
        }
      }
      fs.rmSync(`${this.filePath}.1`, { force: true });
      fs.renameSync(this.filePath, `${this.filePath}.1`);
      fs.closeSync(fs.openSync(this.filePath, 'a'));
    } catch (error) {
      try { process.stderr.write(`[logger] rotate failed: ${error.message}\n`); } catch {}
    }
  }

  _mirror(entry) {
    if (!this.mirrorConsole) return;
    const method = entry.level === 'ERROR' ? 'error' : entry.level === 'WARN' ? 'warn' : entry.level === 'DEBUG' ? 'log' : 'log';
    const stream = entry.level === 'ERROR' || entry.level === 'WARN' ? process.stderr : process.stdout;
    const time = entry.ts.slice(11, 23);
    stream.write(`[${time}] ${entry.level} ${entry.cat}: ${entry.msg}${entry.meta !== undefined ? ` ${JSON.stringify(entry.meta)}` : ''}\n`);
  }
}

function createLogger(options) {
  return new Logger(options);
}

const LOG_PREFIX = '/api/logs';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CLIENT_ENTRIES = 500;
const MAX_FIELD_LEN = 2048;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Log body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sanitizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const level = String(raw.level || 'INFO').toUpperCase();
  const normalized = LEVEL_NAMES.includes(level) ? level : 'INFO';
  const cat = String(raw.cat || 'client').slice(0, 128);
  const msg = String(raw.msg ?? '').slice(0, MAX_FIELD_LEN);
  let meta;
  try { meta = raw.meta === undefined ? undefined : JSON.stringify(raw.meta).slice(0, MAX_FIELD_LEN); } catch { meta = undefined; }
  const ts = typeof raw.ts === 'string' ? raw.ts.slice(0, 40) : undefined;
  return { level: normalized, cat: `browser.${cat}`, msg, meta: meta === undefined ? undefined : { raw: meta }, ts, index };
}

/**
 * Routes POST /api/logs (the browser log bridge). Returns true when the request
 * was handled; returns false when the pathname is outside this endpoint so the
 * caller can fall through to other handlers / the static file server.
 */
function createLogEndpoint(logger) {
  return function handleLogEndpoint(request, response, pathname) {
    if (pathname !== LOG_PREFIX) return false;
    if (request.method !== 'POST') {
      response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return true;
    }
    readBody(request)
      .then((text) => {
        let payload;
        try { payload = JSON.parse(text); } catch { payload = null; }
        const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.logs) ? payload.logs : null;
        if (!entries || entries.length === 0) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'No log entries' }));
          return;
        }
        let accepted = 0;
        for (const [index, raw] of entries.slice(0, MAX_CLIENT_ENTRIES).entries()) {
          const entry = sanitizeEntry(raw, index);
          if (!entry) continue;
          logger.log(entry.level, entry.cat, entry.msg, entry.ts ? { ts: entry.ts, ...entry.meta } : entry.meta);
          accepted += 1;
        }
        logger.info('client', `bridge accepted ${accepted}/${entries.length} browser log entries`);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ ok: true, accepted }));
      })
      .catch((error) => {
        logger.warn('client', 'log bridge rejected a payload', { reason: error.message });
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      });
    return true;
  };
}

module.exports = { Logger, createLogger, createLogEndpoint, LEVELS, LOG_PREFIX };
