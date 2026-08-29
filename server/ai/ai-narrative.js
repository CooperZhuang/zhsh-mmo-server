'use strict';
/**
 * 纵横四海 · AI 世界叙述
 *
 * 为世界事件生成叙事性播报文本（AI 拟广播员口吻），供 WS world_event 广播与
 * 玩家阅读。异步生成、不阻塞事件触发；失败返回模板化叙述保底。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaGenerate } = require('../ai/ai-decision-service');

const CAT_LABEL = { food: '粮食', specialty: '特产', material: '材料', luxury: '奢侈品' };
const KIND_LABEL = { price: '物价', supply: '供应', weather: '天气', discovery: '发现', encounter: '遭遇' };

/** 生成一次世界事件的叙述播报（异步，失败保底模板） */
async function aiEventNarrative(event) {
  const ctx = {
    事件: event.name,
    区域: event.region,
    类别: event.tag,
    影响: `${KIND_LABEL[event.effect_kind] ?? event.effect_kind} 影响 ${CAT_LABEL[event.target_field] ?? event.target_field}`,
    强度: Number(event.strength ?? 0).toFixed(2),
    补充: event.tip ?? '',
  };
  const prompt = `你是《纵横四海》文字网游的世界播报员。请为下面的事件写一段 80 字以内的兴味播报，
用中文口语化、略带紧张或喜庆的航海电台风格，开篇可用【${event.name}】。只输出播报正文：\n${JSON.stringify(ctx)}`;
  try {
    const raw = await ollamaGenerate(prompt, { system: '你是航海世界电台播报员，用简洁生动的中文播报世界事件。', temperature: 0.85, maxTokens: 160 });
    return { narrative: String(raw || '').trim().slice(0, 140), event_name: event.name };
  } catch {
    return { narrative: `【${event.name}】${event.tip ?? '世界发生了新的变故。'}`, event_name: event.name, fallback: true };
  }
}

module.exports = { aiEventNarrative };
