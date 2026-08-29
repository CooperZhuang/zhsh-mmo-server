'use strict';
/**
 * 纵横四海 · AI 发现物叙事描述
 *
 * 玩家探索发现某发现物时，由 AI 生成一段贴合该发现物与所在区域的探索叙事描述，
 * 替代固定的干巴巴 tip，增强"发现"的成就感。异步生成、缓存复用；AI 失败保底。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaGenerate, MODEL_LIGHT } = require('./ai-decision-service');

/** 生成发现物的叙事描述（async，规则保底） */
async function aiDiscoveryDescription({ discoveryName, region, playerLevel, playerTitle, discoveredCount }) {
  const ctx = {
    发现物: discoveryName,
    所在区域: region,
    玩家等级: playerLevel,
    玩家头衔: playerTitle,
    已发现数: discoveredCount,
  };
  const prompt = `你是《纵横四海》文字网游的探索叙事者。玩家刚刚发现了「${discoveryName}」。请写一段 60 字以内、
契合「${region}」风物的中文探索发现叙述，体现发现这个奇物的惊叹与氛围，出海探险文人笔法。只输出叙述：
${JSON.stringify(ctx)}`;
  try {
    const raw = await ollamaGenerate(prompt, { system: '你是航海探索叙事者，用精炼中文描写发现奇物的氛围。', temperature: 0.9, maxTokens: 100, model: MODEL_LIGHT, think: false });
    const text = String(raw || '').trim().split('\n')[0].slice(0, 80);
    if (text) return { description: text, discovery: discoveryName, source: 'ai' };
  } catch {}
  return { description: `拨开层层迷雾，${discoveryName}静静躺在「${region}」的秘境之中，等待有缘人。`, discovery: discoveryName, source: 'fallback' };
}

module.exports = { aiDiscoveryDescription };
