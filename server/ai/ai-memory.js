'use strict';
/**
 * 纵横四海 · 世界记忆层
 *
 * 让 AI 从"无状态单点生成"升级为"有记忆生成"。提供三类记忆：
 *   - player_memory：玩家的关键事迹（击败的BOSS、帮助的NPC、达成的重要事件）
 *   - npc_affinity：玩家对 NPC 的好感度（驱动 NPC 台词/态度的变化）
 *   - world_event_log：世界事件日志（经济引擎已有 eventLog，供世界上下文注入）
 *
 * 所有记忆写入都是"记录"（去重、封顶），供各 AI 场景在生成时注入。
 * AI 失败不影响游戏（记忆仅增强上下文，不承担正确性）。
 */
const { upgradeGameplayState } = require('../../src/task-runtime/gameplay-state');

const MEMORY_CAP = 40; // 玩家事迹封顶，超出滚动丢弃最旧
const AFFINITY_MIN = -50;
const AFFINITY_MAX = 50;

/** 规范化记忆项（若记忆数组是旧结构/被破坏则不 panic） */
function _normMemory(memory) {
  if (!Array.isArray(memory)) return [];
  return memory.filter((m) => m && typeof m.text === 'string' && m.text.length > 0);
}

/**
 * 记录一条玩家事迹。gameplay state 由调用方传入（含 player_memory），
 * 返回规范化后的记忆数组（调用方负责回写 state.player_memory）。
 * 去重：若已有相同 type+text 则仅刷新时间戳，不重复追加。
 */
function recordPlayerMemory(state, { type, text, importance = 1 }) {
  if (!state || !text) return state;
  if (!Array.isArray(state.player_memory)) state.player_memory = [];
  const normalized = _normMemory(state.player_memory);
  const existing = normalized.find((m) => m.type === type && m.text === text);
  if (existing) {
    existing.timestamp = Date.now();
    existing.importance = Math.max(existing.importance ?? 1, importance);
    state.player_memory = normalized;
    return state;
  }
  normalized.push({ id: `${type}:${Date.now().toString(36)}`, type, text, importance, timestamp: Date.now() });
  if (normalized.length > MEMORY_CAP) normalized.splice(0, normalized.length - MEMORY_CAP);
  state.player_memory = normalized;
  return state;
}

/**
 * 调整对某 NPC 的好感度。npc_affinity = { [npcId]: { value, memo, updated_at } }。
 * 返回新的 npc_affinity 对象。
 */
function adjustNpcAffinity(state, npcId, delta, memo) {
  if (!state || !npcId) return state;
  if (!state.npc_affinity || typeof state.npc_affinity !== 'object' || Array.isArray(state.npc_affinity)) state.npc_affinity = {};
  const cur = state.npc_affinity[npcId] ?? { value: 0, memo: '', updated_at: Date.now() };
  cur.value = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, (cur.value ?? 0) + delta));
  cur.updated_at = Date.now();
  if (memo) cur.memo = memo;
  state.npc_affinity[npcId] = cur;
  return state;
}

/**
 * 从玩家记忆中"回忆"与 query 最相关的片段（供 AI 注入）。
 * 简单优先级：文本含 query 关键词优先，其次按 importance 取最近。返回字符串数组。
 */
function recallPlayerMemory(state, { query = '', limit = 4 } = {}) {
  const memory = _normMemory(state?.player_memory);
  if (memory.length === 0) return [];
  const tokens = (query || '').split(/[\s,，、]+/).filter(Boolean);
  const scored = memory.map((m) => {
    let score = (m.importance ?? 1);
    if (tokens.length) {
      const matched = tokens.filter((t) => m.text.includes(t)).length;
      if (matched) score += matched * 5;
    }
    return { m, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || (b.m.timestamp ?? 0) - (a.m.timestamp ?? 0))
    .slice(0, limit)
    .map(({ m }) => m.text);
}

/** 从记忆里取对新 NPC 的好感度（无记录返回 0） */
function getNpcAffinity(state, npcId) {
  if (!state?.npc_affinity) return 0;
  return state.npc_affinity[npcId]?.value ?? 0;
}

/**
 * 组装世界上下文对象（供 AI 场景注入）。从经济引擎 snapshot 提取事件 + 天气。
 * 返回一个可 JSON 序列化、紧凑的上下文片段。
 */
function buildWorldContext(snapshot) {
  if (!snapshot) return { 事件: '无', 天气: '未知' };
  const events = (snapshot.activeEvents ?? []).slice(0, 3)
    .map((e) => `${e.name}（${e.region ?? '全域'}）`)
    .join('、') || '无';
  const weather = Object.entries(snapshot.weather ?? {}).slice(0, 3)
    .map(([r, w]) => `${r}:${w}`)
    .join('、') || '未知';
  return { 事件: events, 天气: weather, 经济_tick: snapshot.tick_count ?? 0 };
}

/**
 * 将记忆注入到 AI 生成上下文。返回一个紧凑中文记忆摘要字符串，
 * 供调用方拼进 prompt（若无记忆返回''，不打扰生成）。
 */
function memoryDigest(state, { npcId = null, query = '' } = {}) {
  const parts = [];
  const memories = recallPlayerMemory(state, { query, limit: 3 });
  if (memories.length) parts.push(`玩家过往事迹：${memories.join('；')}`);
  if (npcId) {
    const aff = getNpcAffinity(state, npcId);
    if (aff !== 0) parts.push(`与${npcId}的好感度：${aff > 0 ? '+爱戴' : '-疏远'}(${aff})`);
  }
  return parts.join('。');
}

module.exports = {
  MEMORY_CAP, AFFINITY_MIN, AFFINITY_MAX,
  recordPlayerMemory, adjustNpcAffinity, recallPlayerMemory,
  getNpcAffinity, buildWorldContext, memoryDigest,
};
