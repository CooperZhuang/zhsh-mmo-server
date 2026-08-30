'use strict';
/**
 * 纵横四海 · AI 连环世界事件（跨区因果链）
 *
 * 打破孤立事件模板：经济引擎触发一个事件后，AI 依该事件与当前世界状态生成
 * 一个有因果关联的**后续**事件（如 旱灾→饥荒→商队劫掠→护送任务→公会政变），
 * 跨区级联、随事件消退而熄灭。让世界"有故事在发生"，而非随机模板。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaJson, MODEL_LIGHT } = require('../ai/ai-decision-service');

const CATEGORIES = ['economy', 'weather', 'encounter'];
const EFFECT_KINDS = ['price', 'supply', 'weather', 'discovery'];
const FIELDS = ['food', 'specialty', 'material', 'luxury'];

/**
 * 依前一事件 + 当前世界状态，生成一个因果关联的后续事件（async，失败返回 null）。
 * parentEvent: { id, name, region, effect_kind, target_field, strength, tip }
 * state: { weather, regionSupply, activeEvents, regions }
 */
async function decideChainEvent(parentEvent, state) {
  const summary = {
    上一事件: parentEvent ? `${parentEvent.name}（${parentEvent.region}，${parentEvent.tip ?? ''}）` : '无',
    天气: state.weather,
    区域供需: state.regionSupply,
    正在发生: state.activeEvents,
    区域列表: state.regions,
  };
  const prompt = `你是《纵横四海》文字网游的世界剧情策划。当前世界在发生「${parentEvent?.name ?? '新变故'}」，可能引发连锁反应。
请据此构思**一件因果相关的后续事件**（上一个事件导致的下一个变化，如旱灾→饥荒蔓延、海盗封锁→航线改道→物价动荡）。
可影响区域(必须从这些 slug 中选一个)：${(state.regions ?? []).join('，')}。
只输出一个 JSON 对象，字段：
{"id":"链式事件唯一英文id","name":"中文事件名(≤12字)","region":"上述区域 slug 之一","category":"${CATEGORIES.join('/')}","effect_kind":"${EFFECT_KINDS.join('/')}","target_field":"${FIELDS.join('/')}","strength":-0.3到0.35,"duration":2到8,"tip":"一句话剧情描述(说明与上一事件的因果,≤40字)","chain":true}
strength 正数=涨价/短缺，负数=跌价/富余。只输出 JSON。`;
  try {
    const obj = await ollamaJson(prompt, { model: MODEL_LIGHT, think: false });
    if (process.env.ZHSH_DEBUG_CHAIN) console.error('[AI-CHAIN] obj:', JSON.stringify(obj), '| regions:', JSON.stringify(state.regions?.slice(0,2)));
    // 规范化区域：AI 可能输出中文名或 slug；regionNames 提供 slug→中文映射
    const regionNames = state.regionNames ?? {};
    let region = obj?.region;
    if (region && !state.regions.includes(region)) {
      const byName = Object.entries(regionNames).find(([, name]) => name === region || String(region).includes(name));
      if (byName) region = byName[0];
    }
    if (!obj?.name || !region || !state.regions.includes(region)) return null;
    return {
      id: String(obj.id || 'chain_event').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32),
      name: String(obj.name).slice(0, 12),
      tag: String(obj.tag || '事件').slice(0, 8),
      category: CATEGORIES.includes(obj.category) ? obj.category : 'economy',
      region,
      effect_kind: EFFECT_KINDS.includes(obj.effect_kind) ? obj.effect_kind : 'supply',
      target_field: FIELDS.includes(obj.target_field) ? obj.target_field : 'food',
      strength: Math.max(-0.3, Math.min(0.35, Number(obj.strength ?? 0.15))),
      duration: Math.max(2, Math.min(8, Number(obj.duration ?? 4))),
      tip: String(obj.tip ?? '').slice(0, 80),
      ai_generated: true,
      chain: true,
    };
  } catch (err) {
    console.error('[AI-CHAIN] chain event error:', err?.message);
    return null;
  }
}

module.exports = { decideChainEvent, CATEGORIES, EFFECT_KINDS, FIELDS };
