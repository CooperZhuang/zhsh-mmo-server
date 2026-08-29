'use strict';
/**
 * 纵横四海 · AI 市场顾问
 *
 * 玩家在市场页向 AI 咨询"此刻该买卖什么"：结合玩家所在区域、当前供需/天气/
 * 活跃事件、玩家资金与货舱，生成针对性的买卖建议。作为对 intel 情报的
 * 即时、个性化补充。AI 失败返回规则保底建议。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaGenerate, MODEL_LIGHT } = require('../ai/ai-decision-service');

const CAT_LABEL = { food: '粮食', specialty: '特产', material: '材料', luxury: '奢侈品' };
const CAT_NAME = { food: '粮食', specialty: '特产', material: '材料', luxury: '奢侈品' };

/** 生成当前区域的买卖建议（async，规则保底） */
async function aiMarketAdvice({ regionName, weather, supply, activeEvents, money, holds, capacity }) {
  const supplyLabel = Object.entries(supply ?? {}).map(([k, v]) => `${CAT_LABEL[k] ?? k}价约${(v).toFixed(2)}`).join('、');
  const ctx = {
    所在区域: regionName,
    天气: weather,
    区域供需: supplyLabel,
    正在发生: (activeEvents || []).slice(0, 3).join('、') || '无',
    我的资金: `${money} 铜`,
    货舱: `${holds}/${capacity}`,
  };
  const prompt = `你是《纵横四海》的行商顾问。玩家当前在「${regionName}」，世界状态：${JSON.stringify(ctx)}。
请给出针对性的买卖建议：此刻在此区域最该买入或卖出的 1~2 类物资及理由，并提示风险（天气/事件）。
用 90 字以内中文、口语化、可直接照做。不要输出 JSON 或思考。`;
  try {
    const raw = await ollamaGenerate(prompt, { system: '你是精明的航海行商顾问，给出直接可执行的买卖建议。', temperature: 0.8, maxTokens: 140, model: MODEL_LIGHT, think: false });
    const text = String(raw || '').trim().split('\n')[0].slice(0, 140);
    if (text) return { advice: text, region: regionName, source: 'ai' };
  } catch {}
  // 规则保底：找该区域供需明显偏离的类别
  let advice = '各区域供需平稳，暂无强烈套利提示，可结合天下页情报谨慎交易。';
  for (const [cat, v] of Object.entries(supply ?? {})) {
    if (v >= 1.1) { advice = `${regionName}${CAT_NAME[cat] ?? cat}富余、价格走低，适合低价买入囤货。`; break; }
    if (v <= 0.9) { advice = `${regionName}${CAT_NAME[cat] ?? cat}紧缺、价格走高，若有存货可卖出获利。`; break; }
  }
  return { advice, region: regionName, source: 'fallback' };
}

module.exports = { aiMarketAdvice };
