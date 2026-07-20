'use strict';

const { assertPlayerState, cloneState } = require('./runtime-storage');

class MemoryRuntimeStorage {
  constructor() {
    this.players = new Map();
  }

  hasPlayer(playerCanonicalId) {
    return this.players.has(playerCanonicalId);
  }

  createPlayer(state) {
    assertPlayerState(state);
    const id = state.player.canonical_id;
    if (this.players.has(id)) throw new Error(`Player already exists: ${id}`);
    this.players.set(id, cloneState(state));
    return this.loadPlayer(id);
  }

  loadPlayer(playerCanonicalId) {
    const state = this.players.get(playerCanonicalId);
    if (!state) throw new Error(`Player does not exist: ${playerCanonicalId}`);
    return cloneState(state);
  }

  resetPlayer(playerCanonicalId, state) {
    assertPlayerState(state);
    if (state.player.canonical_id !== playerCanonicalId) throw new Error('Reset player id mismatch');
    this.players.set(playerCanonicalId, cloneState(state));
    return this.loadPlayer(playerCanonicalId);
  }

  transact(playerCanonicalId, operation) {
    const working = this.loadPlayer(playerCanonicalId);
    const result = operation(working);
    assertPlayerState(working);
    this.players.set(playerCanonicalId, cloneState(working));
    return cloneState(result);
  }

  close() {}
}

module.exports = { MemoryRuntimeStorage };
