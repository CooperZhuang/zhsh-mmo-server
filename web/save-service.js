'use strict';

const { DatabaseSync } = require('node:sqlite');

/**
 * Server-side player save store.
 *
 * Persists raw browser save envelopes (opaque JSON) keyed by player_canonical_id,
 * plus the identity of the most-recently-used character (active_player_id).
 * The browser runtime owns all validation, checksum and schema-upgrade logic
 * (see src/task-runtime/browser-runtime-storage.js); this store is a durable
 * sink so that any device reaching the same server shares the same character
 * states and, by default, resumes the last-used character.
 */
class PlayerSaveStore {
  constructor(databasePath) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS player_saves (
        player_canonical_id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS server_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  list() {
    return this.db
      .prepare('SELECT envelope_json FROM player_saves ORDER BY player_canonical_id')
      .all()
      .map((row) => JSON.parse(row.envelope_json));
  }

  get(playerCanonicalId) {
    const row = this.db
      .prepare('SELECT envelope_json FROM player_saves WHERE player_canonical_id=?')
      .get(playerCanonicalId);
    return row ? JSON.parse(row.envelope_json) : null;
  }

  put(playerCanonicalId, envelope) {
    this.db
      .prepare(`
        INSERT INTO player_saves (player_canonical_id, envelope_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(player_canonical_id) DO UPDATE SET
          envelope_json=excluded.envelope_json,
          updated_at=excluded.updated_at
      `)
      .run(playerCanonicalId, JSON.stringify(envelope), new Date().toISOString());
  }

  delete(playerCanonicalId) {
    this.db.prepare('DELETE FROM player_saves WHERE player_canonical_id=?').run(playerCanonicalId);
    const active = this.getActivePlayerId();
    if (active === playerCanonicalId) this.setActivePlayerId(null);
  }

  getActivePlayerId() {
    const row = this.db.prepare('SELECT value FROM server_settings WHERE key=?').get('active_player_id');
    return row ? (row.value || null) : null;
  }

  setActivePlayerId(playerCanonicalId) {
    this.db.prepare(`INSERT INTO server_settings (key,value) VALUES ('active_player_id',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(playerCanonicalId ?? '');
  }

  close() {
    this.db.close();
  }
}

const SAVES_PREFIX = '/api/saves';
const ACTIVE_PREFIX = '/api/active';
const PLAYER_ID_PATTERN = /^[\p{L}\p{N}._-]+$/u;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        reject(new Error('Save body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(payload);
}

function validPlayerId(value) {
  return typeof value === 'string' && value.length <= 128 && PLAYER_ID_PATTERN.test(value);
}

function handleSavesApi(request, response, pathname, url, store) {
  const rest = pathname.slice(SAVES_PREFIX.length);
  const playerId = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : '';

  if (pathname === SAVES_PREFIX) {
    if (request.method === 'GET') {
      sendJson(response, 200, { saves: store.list() });
      return;
    }
    sendJson(response, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (!playerId || !validPlayerId(playerId)) {
    sendJson(response, 400, { error: 'Invalid player id' });
    return;
  }

  if (request.method === 'GET') {
    const envelope = store.get(playerId);
    if (!envelope) {
      sendJson(response, 404, { error: 'Not found' });
    } else {
      sendJson(response, 200, envelope);
    }
    return;
  }

  if (request.method === 'PUT') {
    readBody(request)
      .then((text) => {
        let envelope;
        try {
          envelope = JSON.parse(text);
        } catch {
          sendJson(response, 400, { error: 'Body is not valid JSON' });
          return;
        }
        if (!envelope || envelope.player_canonical_id !== playerId) {
          sendJson(response, 400, { error: 'Envelope player id mismatch' });
          return;
        }
        store.put(playerId, envelope);
        store.setActivePlayerId(playerId);
        sendJson(response, 200, { ok: true });
      })
      .catch((error) => sendJson(response, 400, { error: error.message }));
    return;
  }

  if (request.method === 'DELETE') {
    store.delete(playerId);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 405, { error: 'Method Not Allowed' });
}

function handleActiveApi(request, response, pathname, url, store) {
  if (pathname === ACTIVE_PREFIX && request.method === 'GET') {
    sendJson(response, 200, { player_canonical_id: store.getActivePlayerId() });
    return;
  }
  if (pathname === ACTIVE_PREFIX && request.method === 'PUT') {
    readBody(request)
      .then((text) => {
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          sendJson(response, 400, { error: 'Body is not valid JSON' });
          return;
        }
        const id = body?.player_canonical_id ?? null;
        if (id !== null && !validPlayerId(id)) {
          sendJson(response, 400, { error: 'Invalid player id' });
          return;
        }
        store.setActivePlayerId(id);
        sendJson(response, 200, { ok: true });
      })
      .catch((error) => sendJson(response, 400, { error: error.message }));
    return;
  }
  sendJson(response, 405, { error: 'Method Not Allowed' });
}

/**
 * Routes /api/saves and /api/active. Returns true when the request was handled
 * (including a 4xx/5xx for those prefixes); returns false when the pathname is
 * outside this API and the static handler should serve it.
 */
function handleSaveApi(request, response, pathname, url, store) {
  if (pathname.startsWith(SAVES_PREFIX)) {
    handleSavesApi(request, response, pathname, url, store);
    return true;
  }
  if (pathname.startsWith(ACTIVE_PREFIX)) {
    handleActiveApi(request, response, pathname, url, store);
    return true;
  }
  return false;
}

function createSaveApi({ databasePath }) {
  const store = new PlayerSaveStore(databasePath);
  return {
    store,
    handle: (request, response, pathname, url) => handleSaveApi(request, response, pathname, url, store),
    close: () => store.close(),
  };
}

module.exports = { PlayerSaveStore, createSaveApi, handleSaveApi };
