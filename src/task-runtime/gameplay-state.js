'use strict';

const GAMEPLAY_SCHEMA_VERSION = 6;
const INVENTORY_CAPACITY = 200;

const LEVEL_THRESHOLDS = Object.freeze(require('../../data/runtime/level-experience.json').thresholds);

function createGameplayState(player = {}) {
  return {
    schema_version: GAMEPLAY_SCHEMA_VERSION,
    player: {
      level: 1,
      max_health: 100,
      current_health: 100,
      base_attack: 50,
      base_max_attack: 80,
      base_defense: 4,
      base_agility: 3,
      morale: 50,
      luck: 60,
      pets: [],
      crew: [],
      skills: {},
      skill_points: 0,
      reputation: 0,
      title: '水手',
      money: 0,
      ...player,
    },
    inventory_capacity: INVENTORY_CAPACITY,
    owned_ships: {},
    current_ship_canonical_id: null,
    voyage: null,
    fishing: null,
    maritime_encounter: null,
    combat: null,
    dungeon: null,
    equipment: {
      weapon: null,offhand: null,headgear: null,clothes: null,belt: null,shoes: null,
      accessories: [null,null,null],
    },
    equipment_instances: {},
    shop_transactions: {},
    drop_settlements: {},
    encounter_defeats: {},
    gameplay_events: {},
    task_item_ledger: { schema_version:1,reservations:{},grants:{},consumptions:{},abandonments:{} },
    npc_duel: null,
    guild: null,
    city_influence: {},
    occupied_cities: [],
    // 世界记忆层：玩家个人事迹（AI 场景注入上下文）与 NPC 好感度
    player_memory: [],
    npc_affinity: {},
    // 动态任务（AI 世界支线）：运行时态用独立 JSON 容器（无 sqlite FK 约束），与
    // 静态任务的 state.tasks/state.progress（sqlite 持久化）区分，保证动态任务完整可玩。
    runtime_tasks: {},
    runtime_progress: {},
    // 市场货物栏（cargo）：goods 商品（货物）与 player_inventory 的随身物品/装备
    // (FK content_entities) 语义不同，用独立 JSON 容器持久化，避免外键阻断且贴合
    // 航海贸易『货舱』语义。
    cargo: {},
    cargo_capacity: 100,
  };
}

function upgradeGameplayState(state) {
  const defaults = createGameplayState(state?.player ?? {});
  const upgraded = { ...defaults,...state,player:{ ...defaults.player,...state.player } };
  upgraded.schema_version = GAMEPLAY_SCHEMA_VERSION;
  upgraded.equipment = { ...defaults.equipment,...state.equipment };
  upgraded.equipment.accessories = [...(state.equipment?.accessories ?? defaults.equipment.accessories)].slice(0,3);
  while (upgraded.equipment.accessories.length < 3) upgraded.equipment.accessories.push(null);
  for (const key of ['owned_ships','shop_transactions','drop_settlements','encounter_defeats','gameplay_events','equipment_instances','city_influence']) {
    if (!upgraded[key] || typeof upgraded[key] !== 'object' || Array.isArray(upgraded[key])) upgraded[key] = {};
  }
  if (upgraded.guild === undefined) upgraded.guild = null;
  if (!Array.isArray(upgraded.occupied_cities)) upgraded.occupied_cities = [];
  if (!Array.isArray(upgraded.player.pets)) upgraded.player.pets = [];
  if (!Array.isArray(upgraded.player.crew)) upgraded.player.crew = [];
  if (!upgraded.player.skills || typeof upgraded.player.skills !== 'object') upgraded.player.skills = {};
  if (upgraded.player.skill_points === undefined) upgraded.player.skill_points = 0;
  if (upgraded.player.reputation === undefined) upgraded.player.reputation = 0;
  if (!upgraded.player.title) upgraded.player.title = '水手';
  if (!Array.isArray(upgraded.player_memory)) upgraded.player_memory = [];
  if (!upgraded.npc_affinity || typeof upgraded.npc_affinity !== 'object' || Array.isArray(upgraded.npc_affinity)) upgraded.npc_affinity = {};
  if (!upgraded.runtime_tasks || typeof upgraded.runtime_tasks !== 'object' || Array.isArray(upgraded.runtime_tasks)) upgraded.runtime_tasks = {};
  if (!upgraded.runtime_progress || typeof upgraded.runtime_progress !== 'object' || Array.isArray(upgraded.runtime_progress)) upgraded.runtime_progress = {};
  if (!upgraded.cargo || typeof upgraded.cargo !== 'object' || Array.isArray(upgraded.cargo)) upgraded.cargo = {};
  if (upgraded.cargo_capacity === undefined) upgraded.cargo_capacity = 100;
  const {ensureTaskItemLedger}=require('./task-item-ledger');ensureTaskItemLedger(upgraded);
  if(upgraded.npc_duel===undefined)upgraded.npc_duel=null;
  applyExperienceProgression(upgraded);
  return upgraded;
}

function applyExperienceProgression(state) {
  const player = state.player;
  const before = Number(player.level ?? 1);
  let level = Math.max(1,before);
  while (level < LEVEL_THRESHOLDS.length && Number(player.experience ?? 0) >= LEVEL_THRESHOLDS[level]) level += 1;
  for (let next = before + 1;next <= level;next += 1) {
    const healthGain = 10 + Math.floor(next / 5);
    player.max_health += healthGain;
    player.current_health = Math.min(player.max_health,player.current_health + healthGain);
    player.base_attack += 2 + Math.floor(next / 10);
    player.base_max_attack += 2 + Math.floor(next / 10);
    player.base_defense += 1 + Math.floor(next / 15);
    player.base_agility += 1;
    player.morale += 5;
    player.skill_points = (player.skill_points ?? 0) + 1;
  }
  player.level = level;
  return { before,after:level,levels_gained:level-before };
}

function inventoryUsed(state) {
  return Object.values(state.inventory ?? {}).reduce((sum,value) => sum + Number(value),0);
}

module.exports = { GAMEPLAY_SCHEMA_VERSION,INVENTORY_CAPACITY,LEVEL_THRESHOLDS,createGameplayState,upgradeGameplayState,applyExperienceProgression,inventoryUsed };
