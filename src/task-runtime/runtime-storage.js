'use strict';

const { GAMEPLAY_SCHEMA_VERSION }=require('./gameplay-state');

function cloneState(state) {
  return structuredClone(state);
}

function assertPlayerState(state) {
  if (!state?.player?.canonical_id) throw new Error('Player state requires player.canonical_id');
  for (const key of ['tasks','progress','inventory','reward_grants','flags','processed_events']) {
    if (!state[key] || typeof state[key] !== 'object') throw new Error(`Player state requires ${key}`);
  }
  if (!Array.isArray(state.unlocked_map_nodes)) throw new Error('Player state requires unlocked_map_nodes');
  for (const key of ['owned_ships','equipment','shop_transactions','drop_settlements','encounter_defeats','gameplay_events']) {
    if (!state[key] || typeof state[key] !== 'object') throw new Error(`Player state requires ${key}`);
  }
  if (state.schema_version !== GAMEPLAY_SCHEMA_VERSION) throw new Error(`Player state requires schema_version ${GAMEPLAY_SCHEMA_VERSION}`);
  return state;
}

module.exports = { assertPlayerState, cloneState };
