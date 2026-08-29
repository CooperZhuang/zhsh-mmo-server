'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { assertPlayerState, cloneState } = require('./runtime-storage');
const { upgradeGameplayState } = require('./gameplay-state');

const MIGRATION_PATHS = [
  path.resolve(__dirname, '..', '..', 'db', 'migrations', '003-task-runtime.sql'),
  path.resolve(__dirname, '..', '..', 'db', 'migrations', '004-formal-gameplay-runtime.sql'),
];
const MIGRATION_PATH = MIGRATION_PATHS[0];

class SqliteRuntimeStorage {
  constructor(databaseOrPath) {
    this.ownsDatabase = typeof databaseOrPath === 'string';
    this.db = this.ownsDatabase ? new DatabaseSync(path.resolve(databaseOrPath)) : databaseOrPath;
    if (!this.db) throw new Error('SQLite runtime storage requires a database or database path');
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.applyMigration();
  }

  applyMigration() {
    for (const migrationPath of MIGRATION_PATHS) this.db.exec(fs.readFileSync(migrationPath, 'utf8'));
  }

  hasPlayer(playerCanonicalId) {
    return Boolean(this.db.prepare('SELECT 1 present FROM player_profiles WHERE canonical_id=?').get(playerCanonicalId));
  }

  createPlayer(state) {
    assertPlayerState(state);
    if (this.hasPlayer(state.player.canonical_id)) throw new Error(`Player already exists: ${state.player.canonical_id}`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insertPlayerState(state);
      this.db.exec('COMMIT');
      return this.loadPlayer(state.player.canonical_id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  resetPlayer(playerCanonicalId, state) {
    assertPlayerState(state);
    if (state.player.canonical_id !== playerCanonicalId) throw new Error('Reset player id mismatch');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM player_profiles WHERE canonical_id=?').run(playerCanonicalId);
      this.insertPlayerState(state);
      this.db.exec('COMMIT');
      return this.loadPlayer(playerCanonicalId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  loadPlayer(playerCanonicalId) {
    const player = this.db.prepare(`
      SELECT canonical_id,current_map_node_canonical_id,money,experience,created_at,updated_at
      FROM player_profiles WHERE canonical_id=?
    `).get(playerCanonicalId);
    if (!player) throw new Error(`Player does not exist: ${playerCanonicalId}`);
    const tasks = Object.fromEntries(this.db.prepare(`
      SELECT task_canonical_id,status,current_step,reward_status,block_reason_json
      FROM player_tasks WHERE player_canonical_id=? ORDER BY task_canonical_id
    `).all(playerCanonicalId).map((row) => [row.task_canonical_id, {
      status: row.status,
      current_step: Number(row.current_step),
      reward_status: row.reward_status,
      block_reasons: JSON.parse(row.block_reason_json),
    }]));
    const progress = Object.fromEntries(this.db.prepare(`
      SELECT task_canonical_id,target_canonical_id,current_quantity
      FROM player_task_progress WHERE player_canonical_id=? ORDER BY task_canonical_id,target_canonical_id
    `).all(playerCanonicalId).map((row) => [`${row.task_canonical_id}|${row.target_canonical_id}`, Number(row.current_quantity)]));
    const inventory = Object.fromEntries(this.db.prepare(`
      SELECT content_entity_canonical_id,quantity FROM player_inventory
      WHERE player_canonical_id=? ORDER BY content_entity_canonical_id
    `).all(playerCanonicalId).map((row) => [row.content_entity_canonical_id, Number(row.quantity)]));
    const rewardGrants = Object.fromEntries(this.db.prepare(`
      SELECT task_canonical_id,reward_canonical_id,quantity,effect_status FROM player_reward_grants
      WHERE player_canonical_id=? ORDER BY reward_canonical_id
    `).all(playerCanonicalId).map((row) => [row.reward_canonical_id, {
      task_canonical_id: row.task_canonical_id,
      quantity: Number(row.quantity),
      effect_status: row.effect_status,
    }]));
    const flags = Object.fromEntries(this.db.prepare(`
      SELECT flag_key,value_json FROM player_story_flags WHERE player_canonical_id=? ORDER BY flag_key
    `).all(playerCanonicalId).map((row) => [row.flag_key, JSON.parse(row.value_json)]));
    const processedEvents = Object.fromEntries(this.db.prepare(`
      SELECT event_id,event_type,payload_json,result_json,processed_at FROM player_processed_events
      WHERE player_canonical_id=? ORDER BY event_id
    `).all(playerCanonicalId).map((row) => [row.event_id, {
      event_type: row.event_type,
      payload: JSON.parse(row.payload_json),
      result: JSON.parse(row.result_json),
      processed_at: row.processed_at,
    }]));
    const unlocked = this.db.prepare(`
      SELECT map_node_canonical_id FROM player_unlocked_map_nodes
      WHERE player_canonical_id=? ORDER BY map_node_canonical_id
    `).all(playerCanonicalId).map((row) => row.map_node_canonical_id);
    const gameplay = this.db.prepare(`SELECT state_json FROM player_gameplay_state WHERE player_canonical_id=?`).get(playerCanonicalId);
    const gameplayJson = gameplay ? JSON.parse(gameplay.state_json) : {};
    return normalizeStateNumbers(upgradeGameplayState({
      ...gameplayJson,
      player: { ...(gameplayJson.player ?? {}), ...player, canonical_id: player.canonical_id },
      unlocked_map_nodes: unlocked,
      tasks,
      progress,
      inventory,
      reward_grants: rewardGrants,
      flags,
      processed_events: processedEvents,
    }));
  }

  transact(playerCanonicalId, operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const working = this.loadPlayer(playerCanonicalId);
      const result = operation(working);
      assertPlayerState(working);
      this.replacePlayerState(working);
      this.db.exec('COMMIT');
      return cloneState(result);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  replacePlayerState(state) {
    const playerId = state.player.canonical_id;
    for (const table of ['player_gameplay_state','player_processed_events','player_story_flags','player_reward_grants','player_inventory','player_task_progress','player_tasks','player_unlocked_map_nodes']) {
      this.db.prepare(`DELETE FROM ${table} WHERE player_canonical_id=?`).run(playerId);
    }
    this.db.prepare(`
      UPDATE player_profiles SET current_map_node_canonical_id=?,money=?,experience=?,updated_at=? WHERE canonical_id=?
    `).run(state.player.current_map_node_canonical_id,state.player.money,state.player.experience,state.player.updated_at,playerId);
    this.insertChildren(state);
  }

  insertPlayerState(state) {
    const player = state.player;
    this.db.prepare(`
      INSERT INTO player_profiles(canonical_id,current_map_node_canonical_id,money,experience,created_at,updated_at)
      VALUES (?,?,?,?,?,?)
    `).run(player.canonical_id,player.current_map_node_canonical_id,player.money,player.experience,player.created_at,player.updated_at);
    this.insertChildren(state);
  }

  insertChildren(state) {
    const playerId = state.player.canonical_id;
    const insertUnlocked = this.db.prepare('INSERT INTO player_unlocked_map_nodes VALUES (?,?)');
    for (const nodeId of state.unlocked_map_nodes) insertUnlocked.run(playerId,nodeId);
    const insertTask = this.db.prepare('INSERT INTO player_tasks VALUES (?,?,?,?,?,?)');
    for (const [taskId, task] of Object.entries(state.tasks)) {
      insertTask.run(playerId,taskId,task.status,task.current_step,task.reward_status,JSON.stringify(task.block_reasons));
    }
    const insertProgress = this.db.prepare('INSERT INTO player_task_progress VALUES (?,?,?,?)');
    for (const [key, quantity] of Object.entries(state.progress)) {
      const separator = key.indexOf('|');
      insertProgress.run(playerId,key.slice(0,separator),key.slice(separator + 1),quantity);
    }
    const insertInventory = this.db.prepare('INSERT INTO player_inventory VALUES (?,?,?)');
    for (const [contentId, quantity] of Object.entries(state.inventory)) insertInventory.run(playerId,contentId,quantity);
    const insertGrant = this.db.prepare('INSERT INTO player_reward_grants VALUES (?,?,?,?,?)');
    for (const [rewardId, grant] of Object.entries(state.reward_grants)) {
      insertGrant.run(playerId,grant.task_canonical_id,rewardId,grant.quantity,grant.effect_status);
    }
    const insertFlag = this.db.prepare('INSERT INTO player_story_flags VALUES (?,?,?)');
    for (const [key, value] of Object.entries(state.flags)) insertFlag.run(playerId,key,JSON.stringify(value));
    const insertEvent = this.db.prepare('INSERT INTO player_processed_events VALUES (?,?,?,?,?,?)');
    for (const [eventId, event] of Object.entries(state.processed_events)) {
      insertEvent.run(playerId,eventId,event.event_type,JSON.stringify(event.payload),JSON.stringify(event.result),event.processed_at);
    }
    const gameplay = gameplayProjection(state);
    this.db.prepare('INSERT INTO player_gameplay_state VALUES (?,?,?)').run(playerId,state.schema_version,JSON.stringify(gameplay));
  }

  close() {
    if (this.ownsDatabase) this.db.close();
  }
}

function normalizeStateNumbers(state) {
  state.player.money = Number(state.player.money);
  state.player.experience = Number(state.player.experience);
  return state;
}

function gameplayProjection(state) {
  return {
    schema_version:state.schema_version,
    player:{
      level:state.player.level,max_health:state.player.max_health,current_health:state.player.current_health,
      base_attack:state.player.base_attack,base_max_attack:state.player.base_max_attack,
      base_defense:state.player.base_defense,base_agility:state.player.base_agility,morale:state.player.morale,
      reputation:state.player.reputation,title:state.player.title,
      pets:state.player.pets,crew:state.player.crew,skills:state.player.skills,skill_points:state.player.skill_points,
    },
    inventory_capacity:state.inventory_capacity,owned_ships:state.owned_ships,current_ship_canonical_id:state.current_ship_canonical_id,
    voyage:state.voyage,combat:state.combat,equipment:state.equipment,shop_transactions:state.shop_transactions,
    drop_settlements:state.drop_settlements,gameplay_events:state.gameplay_events,
    equipment_instances:state.equipment_instances,
    guild:state.guild,city_influence:state.city_influence,occupied_cities:state.occupied_cities,
    player_memory:state.player_memory,npc_affinity:state.npc_affinity,
    runtime_tasks:state.runtime_tasks,runtime_progress:state.runtime_progress,
    cargo:state.cargo,cargo_capacity:state.cargo_capacity,
  };
}

module.exports = { MIGRATION_PATH,MIGRATION_PATHS,SqliteRuntimeStorage };
