'use strict';
/**
 * 纵横四海 · AI 情境台词
 *
 * 为 NPC 交互生成"情境化闲聊/评价"台词——AI 依据 NPC 身份、玩家当前任务、
 * 世界天气/事件、玩家声望等级、以及玩家与 NPC 的过往记忆/好感度，
 * 生成一句贴合语境的台词。作为对既定脚本对话的增强补充，
 * 让 NPC 世界更具生命力。AI 失败返回保底台词。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaGenerate, MODEL_LIGHT } = require('./ai-decision-service');

/** 生成某 NPC 在当前情境下的一句台词（async，规则保底）。
 *  memorySummary：玩家与 NPC 的过往记忆/好感度摘要（来自 ai-memory.memoryDigest）。
 *  worldContext：世界动向（事件/天气/经济，来自 ai-memory.buildWorldContext）。 */
async function aiNpcBanter({ npcName, npcRole, taskHint, playerTitle, playerLevel, weather, activeEvents, memorySummary = '', worldContext = null, personality = '', dialogueHook = '' }) {
  const ctx = {
    NPC: npcName,
    身份: npcRole || '普通百姓',
    '性格': personality || '自然平实',
    台词切入点: dialogueHook || '回应玩家',
    玩家当前: taskHint ? `正要处理：${taskHint}` : '暂无特别任务',
    玩家身份: `${playerTitle} Lv.${playerLevel}`,
    世界天气: weather || '未知',
    正在发生: (activeEvents || []).slice(0, 2).join('、') || '无',
  };
  const prompt = `你是文字网游《纵横四海》里的一位 NPC（${npcName}，${personality || '普通身份'}）。根据以下情境，说一句 40 字以内的中文台词，
要贴合你的性格（${personality || '自然平实'}），可以提及当前任务、天气、或这个世界正在发生的事。只输出台词本身，不要前缀：
${JSON.stringify(ctx)}${memorySummary ? `\n\n玩家与你的过往：${memorySummary}` : ''}${worldContext ? `\n世界动向：${JSON.stringify(worldContext)}` : ''}`;
  try {
    const raw = await ollamaGenerate(prompt, { system: '你是沉浸的文字网游NPC，说一句贴合情境的中文台词。', temperature: 0.9, maxTokens: 60, model: MODEL_LIGHT, think: false });
    const line = String(raw || '').trim().split('\n')[0].slice(0, 60);
    if (line) return { line, npc: npcName, source: 'ai' };
  } catch {}
  // 保底台词
  return { line: `${npcName}：${taskHint ? '正事要紧，先去办吧。' : ('这天气' + (weather ?? '') + '，出门当心。')}`, npc: npcName, source: 'fallback' };
}

module.exports = { aiNpcBanter };
