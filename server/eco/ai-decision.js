'use strict';
/**
 * 纵横四海 · 世界经济 AI 决策层
 *
 * 用 ollama 依据当前世界经济状态（天气/供需/活跃事件）生成下一次世界事件：
 * 事件名称、影响区域、影响类型（价格/供应/天气/遭遇）、强度、持续时长、剧情描述。
 * 输出为结构化 JSON；解析失败或超界由规则层保底（world-economy 内）。
 *
 * 依赖：http://127.0.0.1:11434（ollama），qwen3.5:9b。
 */
const { ollamaJson, MODEL_LIGHT } = require('../ai/ai-decision-service');
const CATEGORIES = ['economy', 'weather', 'encounter'];
const EFFECT_KINDS = ['price', 'supply', 'weather', 'discovery'];
const FIELDS = ['food', 'specialty', 'material', 'luxury'];

/**
 * 生成一次世界事件（AI 决策）。返回规范化事件对象，失败返回 null（规则层接管）。
 * @param {object} state  { weather, regionSupply, activeEvents, regions }
 */
async function decideEvent(state) {
  const summary = {
    天气: state.weather,
    区域供需: state.regionSupply,
    正在发生: state.activeEvents,
    区域列表: state.regions,
  };
  const prompt = `你是《纵横四海》文字网游的世界剧情与经济策划。当前世界状态：${JSON.stringify(summary)}。
请构思一件正在世界上发生的事件（影响商品价格或天气或产生新遭遇）。请只输出一个 JSON 对象，字段：
{"id":"唯一英文id","name":"中文事件名(≤12字)","region":"影响区域(必须来自区域列表)","category":"${CATEGORIES.join('/')}","effect_kind":"${EFFECT_KINDS.join('/')}","target_field":"${FIELDS.join('/')}","strength":-0.3到0.35的小数,"duration":2到8整数,"tip":"一句话剧情描述(≤40字)","tag":"事件/天气/遭遇"}
strength 为价格或供应影响的强度：正数=涨价/短缺，负数=跌价/富余。只输出 JSON。`;
  const raw = await ollamaJson(prompt, { model: MODEL_LIGHT, think: false });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const obj = JSON.parse(m[0]);
  // 规范化/校验
  if (!obj?.name || !obj?.region || !state.regions.includes(obj.region)) return null;
  return {
    id: String(obj.id || 'ai_event').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32),
    name: String(obj.name).slice(0, 12),
    region: obj.region,
    category: CATEGORIES.includes(obj.category) ? obj.category : 'economy',
    effect_kind: EFFECT_KINDS.includes(obj.effect_kind) ? obj.effect_kind : 'supply',
    target_field: FIELDS.includes(obj.target_field) ? obj.target_field : 'food',
    strength: Math.max(-0.3, Math.min(0.35, Number(obj.strength ?? 0.15))),
    duration: Math.max(2, Math.min(8, Math.round(Number(obj.duration ?? 4)))),
    tip: String(obj.tip || '').slice(0, 40),
    tag: obj.tag ?? '事件',
  };
}

module.exports = { decideEvent, ollamaJson, MODEL_LIGHT };
