'use strict';
/**
 * 纵横四海 · AI 战斗叙述
 *
 * 战斗胜利/失败回合结算后，用轻量模型(4b)为这场战斗生成一句贴合情境的叙述，
 * 增强战斗"演出感"。异步生成、缓存复用；AI 失败返回模板叙述保底。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaGenerate, MODEL_LIGHT } = require('./ai-decision-service');

/** 生成一场战斗的叙述（async，规则保底）。outcome: 战斗胜利/战斗失败 */
async function aiCombatNarrative({ outcome, monsterName, playerLevel, playerHealth, rounds }) {
  const ctx = {
    结果: outcome,
    敌人: monsterName || '对手',
    我方等级: playerLevel,
    剩余体力: playerHealth,
    战斗回合: rounds,
  };
  const prompt = `你是《纵横四海》文字网游的战斗旁白。为下列战斗写一句 45 字以内的中文叙述，
${outcome === '战斗胜利' ? '表现凯旋的豪迈' : '表现落败的狼狈与不甘'}，略带航海武侠文风。只输出叙述本身：
${JSON.stringify(ctx)}`;
  try {
    const raw = await ollamaGenerate(prompt, { system: '你是文字网游战斗旁白，用精炼中文一句话描写战况。', temperature: 0.85, maxTokens: 80, model: MODEL_LIGHT, think: false });
    const line = String(raw || '').trim().split('\n')[0].slice(0, 60);
    if (line) return { line, outcome, source: 'ai' };
  } catch {}
  return { line: outcome === '战斗胜利' ? `一番恶战后，${monsterName ?? '敌人'}终于应声倒地。` : `力有不逮，你且战且退，暂避锋芒。`, outcome, source: 'fallback' };
}

module.exports = { aiCombatNarrative };
