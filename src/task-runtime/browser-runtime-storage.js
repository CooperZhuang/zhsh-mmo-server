'use strict';

const { assertPlayerState,cloneState } = require('./runtime-storage');
const { upgradeGameplayState } = require('./gameplay-state');

const SAVE_SCHEMA_VERSION = 2;
const SAVE_FORMAT = 'zhsh.task1.browser-save';

class IndexedDbDurableStore {
  constructor({ databaseName = 'zhsh-task1-runtime',storeName = 'player-saves' } = {}) {
    this.databaseName = databaseName;
    this.storeName = storeName;
    this.db = null;
  }

  async open() {
    if (this.db) return this;
    this.db = await new Promise((resolve,reject) => {
      const request = indexedDB.open(this.databaseName,1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName,{ keyPath:'player_canonical_id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return this;
  }

  async list() {
    await this.open();
    return requestResult(this.db.transaction(this.storeName,'readonly').objectStore(this.storeName).getAll());
  }

  async put(record) {
    await this.open();
    const transaction = this.db.transaction(this.storeName,'readwrite');
    transaction.objectStore(this.storeName).put(record);
    await transactionDone(transaction);
  }

  async delete(playerCanonicalId) {
    await this.open();
    const transaction = this.db.transaction(this.storeName,'readwrite');
    transaction.objectStore(this.storeName).delete(playerCanonicalId);
    await transactionDone(transaction);
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

class BrowserRuntimeStorage {
  constructor({ durableStore = new IndexedDbDurableStore() } = {}) {
    this.durableStore = durableStore;
    this.players = new Map();
    this.revisions = new Map();
    this.corruptRecords = new Map();
    this.pending = Promise.resolve();
    this.pendingRecords = new Map();
    this.persistDrain = null;
    this.initialized = false;
  }

  async ready() {
    if (this.initialized) return this;
    const records = await this.durableStore.list();
    for (const record of records) {
      try {
        const envelope = validateAndUpgradeEnvelope(record);
        this.players.set(envelope.player_canonical_id,cloneState(envelope.state));
        this.revisions.set(envelope.player_canonical_id,envelope.revision);
        if (envelope !== record) await this.durableStore.put(envelope);
      } catch (error) {
        this.corruptRecords.set(record?.player_canonical_id ?? 'unknown',error.message);
      }
    }
    this.initialized = true;
    return this;
  }

  assertReady() {
    if (!this.initialized) throw new Error('BrowserRuntimeStorage.ready() must complete before use');
  }

  hasPlayer(playerCanonicalId) {
    this.assertReady();
    return this.players.has(playerCanonicalId);
  }

  createPlayer(state) {
    this.assertReady();
    assertPlayerState(state);
    const id = state.player.canonical_id;
    if (this.players.has(id)) throw new Error(`Player already exists: ${id}`);
    return this.commit(id,state);
  }

  loadPlayer(playerCanonicalId) {
    this.assertReady();
    const state = this.players.get(playerCanonicalId);
    if (!state) {
      const corrupt = this.corruptRecords.get(playerCanonicalId);
      if (corrupt) throw new Error(`Player save is corrupt: ${corrupt}`);
      throw new Error(`Player does not exist: ${playerCanonicalId}`);
    }
    return cloneState(state);
  }

  resetPlayer(playerCanonicalId,state) {
    this.assertReady();
    assertPlayerState(state);
    if (state.player.canonical_id !== playerCanonicalId) throw new Error('Reset player id mismatch');
    this.corruptRecords.delete(playerCanonicalId);
    return this.commit(playerCanonicalId,state);
  }

  async deletePlayer(playerCanonicalId) {
    this.assertReady();
    const removed = this.players.delete(playerCanonicalId);
    this.revisions.delete(playerCanonicalId);
    this.corruptRecords.delete(playerCanonicalId);
    this.pendingRecords.delete(playerCanonicalId);
    await this.durableStore.delete(playerCanonicalId);
    return removed;
  }

  transact(playerCanonicalId,operation) {
    const working = this.loadPlayer(playerCanonicalId);
    const result = operation(working);
    assertPlayerState(working);
    this.commit(playerCanonicalId,working,{takeOwnership:true,returnState:false});
    return cloneState(result);
  }

  commit(playerCanonicalId,state,{takeOwnership=false,returnState=true}={}) {
    const copy = takeOwnership?state:cloneState(state);
    const revision = (this.revisions.get(playerCanonicalId) ?? 0) + 1;
    this.players.set(playerCanonicalId,copy);
    this.revisions.set(playerCanonicalId,revision);
    this.schedulePersist({player_canonical_id:playerCanonicalId,revision,state:copy});
    return returnState?cloneState(copy):undefined;
  }

  /**
   * Re-fetches a single player's newest envelope from the durable store and
   * replaces the in-memory state. Used when character switching must resume
   * progress written by another device. Returns the fresh state (or null when
   * the player no longer exists), and clears any corrupt marker.
   */
  async reloadPlayer(playerCanonicalId) {
    this.assertReady();
    const record = await this.durableStore.get(playerCanonicalId);
    if (!record) {
      this.players.delete(playerCanonicalId);
      this.revisions.delete(playerCanonicalId);
      this.corruptRecords.delete(playerCanonicalId);
      return null;
    }
    try {
      const envelope = validateAndUpgradeEnvelope(record);
      this.players.set(envelope.player_canonical_id,cloneState(envelope.state));
      this.revisions.set(envelope.player_canonical_id,envelope.revision);
      this.corruptRecords.delete(envelope.player_canonical_id);
      if (envelope !== record) await this.durableStore.put(envelope);
      return cloneState(envelope.state);
    } catch (error) {
      this.corruptRecords.set(record?.player_canonical_id ?? 'unknown',error.message);
      return null;
    }
  }

  async flush() {
    while(this.persistDrain||this.pendingRecords.size){
      if(!this.persistDrain)this.startPersistDrain();
      await this.persistDrain;
    }
  }

  schedulePersist(envelope) {
    this.pendingRecords.set(envelope.player_canonical_id,envelope);
    if(!this.persistDrain)this.startPersistDrain();
  }

  startPersistDrain() {
    this.persistDrain=this.pending.then(async()=>{
      while(this.pendingRecords.size){
        const records=[...this.pendingRecords.values()];this.pendingRecords.clear();
        for(const record of records)await this.durableStore.put(record.checksum?record:makeEnvelope(record.state,record.revision));
      }
    }).finally(()=>{this.persistDrain=null;});
    this.pending=this.persistDrain;
  }

  exportPlayer(playerCanonicalId) {
    const state = this.loadPlayer(playerCanonicalId);
    return JSON.stringify(makeEnvelope(state,this.revisions.get(playerCanonicalId) ?? 1),null,2);
  }

  async importPlayer(serialized,{ expectedPlayerCanonicalId = null } = {}) {
    let parsed;
    try { parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized; }
    catch { throw new Error('Save import is not valid JSON'); }
    const envelope = validateAndUpgradeEnvelope(parsed);
    if (expectedPlayerCanonicalId && envelope.player_canonical_id !== expectedPlayerCanonicalId) throw new Error('Imported player id does not match this playable slice');
    this.players.set(envelope.player_canonical_id,cloneState(envelope.state));
    this.revisions.set(envelope.player_canonical_id,envelope.revision);
    this.corruptRecords.delete(envelope.player_canonical_id);
    this.schedulePersist(envelope);
    await this.flush();
    return this.loadPlayer(envelope.player_canonical_id);
  }

  close() {
    this.durableStore.close?.();
  }
}

function makeEnvelope(state,revision) {
  const body = { format:SAVE_FORMAT,schema_version:SAVE_SCHEMA_VERSION,player_canonical_id:state.player.canonical_id,revision,state:cloneState(state) };
  return { ...body,checksum:checksum(stableJson(body)) };
}

function validateAndUpgradeEnvelope(value) {
  let envelope = value;
  if (value?.schema_version === 0 && value.state) envelope = legacyEnvelope(value.state,Number(value.revision ?? 1));
  if (!envelope || envelope.format !== SAVE_FORMAT) throw new Error('Unsupported save format');
  const body = { format:envelope.format,schema_version:envelope.schema_version,player_canonical_id:envelope.player_canonical_id,
    revision:Number(envelope.revision),state:envelope.state };
  if (checksum(stableJson(body)) !== envelope.checksum) throw new Error('Save checksum mismatch');
  if (body.state.player.canonical_id !== body.player_canonical_id) throw new Error('Save player id mismatch');
  if (!Number.isInteger(body.revision) || body.revision < 1) throw new Error('Save revision is invalid');
  if (body.schema_version === 1 || body.schema_version === 0) return makeEnvelope(upgradeGameplayState(body.state),body.revision);
  if (body.schema_version !== SAVE_SCHEMA_VERSION) throw new Error(`Unsupported save schema version: ${body.schema_version}`);
  body.state = upgradeGameplayState(body.state);
  assertPlayerState(body.state);
  return { ...body,checksum:envelope.checksum };
}

function legacyEnvelope(state,revision) {
  const body = { format:SAVE_FORMAT,schema_version:0,player_canonical_id:state.player.canonical_id,revision,state:cloneState(state) };
  return { ...body,checksum:checksum(stableJson(body)) };
}

function checksum(text) {
  let hash = 0x811c9dc5;
  for (let index=0;index<text.length;index+=1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash,0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8,'0')}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function requestResult(request) {
  return new Promise((resolve,reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve,reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Durable store backed by the same-origin game server /api/saves endpoints.
 * Implements the same surface as IndexedDbDurableStore (open/list/put/delete),
 * so BrowserRuntimeStorage swaps its persistence sink without any other change.
 *
 * Writes are persisted server-side (SQLite keyed by player_canonical_id), so any
 * device hitting the same server shares every character and, by default, resumes
 * the most-recently-used one.
 */
class RemoteDurableStore {
  constructor({ baseUrl = '' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.opened = false;
  }

  async open() {
    this.opened = true;
    return this;
  }

  async list() {
    await this.open();
    const response = await fetch(`${this.baseUrl}/api/saves`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`存档列表读取失败：${response.status}`);
    const data = await response.json();
    return Array.isArray(data.saves) ? data.saves : [];
  }
   
   async put(record) {
     await this.open();
     const response = await fetch(`${this.baseUrl}/api/saves/${encodeURIComponent(record.player_canonical_id)}`, {
       method: 'PUT',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(record),
     });
     if (!response.ok) throw new Error(`存档写入失败：${response.status}`);
   }

   async get(playerCanonicalId) {
     await this.open();
     const response = await fetch(`${this.baseUrl}/api/saves/${encodeURIComponent(playerCanonicalId)}`, { cache: 'no-store' });
     if (response.status === 404) return null;
     if (!response.ok) throw new Error(`存档读取失败：${response.status}`);
     return response.json();
   }

   async delete(playerCanonicalId) {
     await this.open();
     const response = await fetch(`${this.baseUrl}/api/saves/${encodeURIComponent(playerCanonicalId)}`, { method: 'DELETE' });
     if (!response.ok && response.status !== 404) throw new Error(`存档删除失败：${response.status}`);
   }

   close() {
     this.opened = false;
   }
}

/** Registry used by RemoteDurableStore clients to track the last-used character. */
class RemoteCharacterRegistry {
  constructor({ baseUrl = '' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getActive() {
    const response = await fetch(`${this.baseUrl}/api/active`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`激活角色读取失败：${response.status}`);
    const data = await response.json();
    return data.player_canonical_id;
  }

  async setActive(playerCanonicalId) {
    const response = await fetch(`${this.baseUrl}/api/active`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_canonical_id: playerCanonicalId ?? null }),
    });
    if (!response.ok) throw new Error(`激活角色写入失败：${response.status}`);
  }
}

module.exports = { BrowserRuntimeStorage,IndexedDbDurableStore,RemoteDurableStore,RemoteCharacterRegistry,SAVE_FORMAT,SAVE_SCHEMA_VERSION,checksum,makeEnvelope,validateAndUpgradeEnvelope };
