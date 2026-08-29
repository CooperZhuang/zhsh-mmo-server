'use strict';
/**
 * 纵横四海 · AI 船员（同伴人格 + 忠诚）
 *
 * 船员随从不只是数值加成：他们有自己的性格，会说话、记得与玩家的共事，
 * 忠诚度随并肩作战涨跌。为战斗/事件生成一句贴合人格/忠诚度的发言。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaGenerate, MODEL_LIGHT } = require('./ai-decision-service');

/** 生成某船员在战斗/事件后的一句发言（贴合性格与忠诚度，async，规则保底）。 */
async function aiCrewLine({ crewName, personality, loyalty, mood, worldContext }) {
  const loyaltyTone = Number(loyalty ?? 60) >= 70 ? '极其信任你'
    : Number(loyalty ?? 60) >= 45 ? '愿意追随你'
    : Number(loyalty ?? 60) >= 30 ? '有些动摇'
    : '心生离意';
  const prompt = `你是《纵横四海》的船员（${crewName}，性格${personality}）。当前忠诚：${loyaltyTone}，${mood ?? '正在出海'}。
说一句 30 字内的中文台词，贴合你的性格与对船长的态度${worldContext ? `，可提及世界动态：${worldContext}` : ''}。只输出台词本身，不要前缀。`;
  try {
    const raw = await ollamaGenerate(prompt, { system: '你是文字网游里性格鲜明的船员，说一句贴合人格的中文台词。', temperature: 0.9, maxTokens: 50, model: MODEL_LIGHT, think: false });
    const line = String(raw || '').trim().split('\n')[0].slice(0, 40);
    if (line) return { line, crew: crewName, source: 'ai' };
  } catch {}
  // 保底台词（贴合忠诚度）
  const fallback = loyaltyTone === '极其信任你' ? '船长，我这条命就交给你了。'
    : loyaltyTone === '愿意追随你' ? '船长，风浪再大我也跟着你。'
    : loyaltyTone === '有些动摇' ? '船长，这趟买卖……当真值得吗？'
    : '船长，我得为自己想想了。';
  return { line: `${crewName}：${fallback}`, crew: crewName, source: 'fallback' };
}

/** 根据忠诚度折算船员对玩家属性加成的乘数（高忠诚加成放大，低忠诚削弱/离队）。 */
function loyaltyFactor(loyalty) {
  const l = Number(loyalty ?? 60);
  if (l >= 80) return 1.2;
  if (l >= 60) return 1.0;
  if (l >= 40) return 0.8;
  if (l >= 25) return 0.5;
  return 0; // 极低忠诚：不再提供加成
}

module.exports = { aiCrewLine, loyaltyFactor };
