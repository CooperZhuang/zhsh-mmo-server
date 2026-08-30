'use strict';
/**
 * 纵横四海 · AI 任务情境叙述
 *
 * 玩家接取或提交任务时，由 AI 依据 NPC 口吻 / 任务目标 / 玩家状态，生成一句
 * 情境化的旁白/鼓励叙述，补充既有脚本对话，让任务流转更有生命力。异步生成、
 * 短时缓存；AI 失败保底。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaGenerate, MODEL_LIGHT } = require('./ai-decision-service');

/** 生成任务情境叙述（async，规则保底）。phase: 接受/提交 */
async function aiTaskNarrative({ npcName, taskName, phase, playerTitle, playerLevel }) {
  const instruct = phase === '接受'
    ? '玩家刚接下一项委托，请以NPC口吻说一句鼓励/叮嘱（40字内）'
    : '玩家刚完成委托回来复命，请以NPC口吻说一句赞许/交代（40字内）';
  const ctx = { 委托: taskName, 委托NPC: npcName, 阶段: phase, 玩家: `${playerTitle} Lv.${playerLevel}` };
  const prompt = `你是《纵横四海》文字网游的NPC（${npcName}）。${instruct}，可提及委托「${taskName}」。只输出台词：
${JSON.stringify(ctx)}`;
  try {
    const raw = await ollamaGenerate(prompt, { system: '你是文字网游NPC，用一句精炼中文表达对玩家委托的鼓励或赞许。', temperature: 0.85, maxTokens: 70, model: MODEL_LIGHT, think: false });
    const line = String(raw || '').trim().split('\n')[0].slice(0, 55);
    if (line) return { line, task: taskName, phase, source: 'ai' };
  } catch {}
  return { line: phase === '接受' ? `${npcName}：这委托就拜托你了，路上小心。` : `${npcName}：办得好！有你在我就放心了。`, task: taskName, phase, source: 'fallback' };
}

module.exports = { aiTaskNarrative };
