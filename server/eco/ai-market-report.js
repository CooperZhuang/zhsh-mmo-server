'use strict';
/**
 * 纵横四海 · AI 市场情报综述
 *
 * 经济 tick 时由大模型依据当前世界状态（各区域天气/供需/活跃事件）生成一段
 * 玩家可读的"市场/天气情报综述"，指明哪些区域哪类物资有套利空间、天气是否
 * 适宜出航。解析失败由 WorldEconomy.ruleReport 保底。
 *
 * 依赖：server/ai/ai-decision-service.js（统一 ollama 服务）。
 */
const { ollamaGenerate } = require('../ai/ai-decision-service');

const CAT_LABEL = { food: '粮食', specialty: '特产', material: '材料', luxury: '奢侈品' };

async function aiMarketReport(state) {
  const summary = {
    区域天气: state.weather,
    区域供需: state.regionSupply,
    正在发生的事件: (state.activeEvents ?? []).map((e) => `${e.name}（${e.region}·影响${CAT_LABEL[e.field] ?? e.field}）`),
  };
  const prompt = `你是《纵横四海》文字网游的行商顾问。当前世界状态：${JSON.stringify(summary)}。
请为玩家写一段 120 字以内的市场/天气情报，指出：
1) 哪些区域哪类物资此刻有套利/囤积机会（供需明显偏离1的区域）；
2) 有哪些正在发生的事件值得注意（海盗封锁/丰收/风暴等及其影响）；
3) 天气对出航/贸易的整体建议。
用中文口语化叙述，不要输出 JSON，不要重复系统信息。`;
  const raw = await ollamaGenerate(prompt, { system: '你是经验丰富的航海行商，用精炼中文给出实用情报。', temperature: 0.7, maxTokens: 220 });
  return {
    summary: String(raw || '').trim().slice(0, 160),
    generated_at: new Date().toISOString(),
    source: 'ai',
  };
}

module.exports = { aiMarketReport };
