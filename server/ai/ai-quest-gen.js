'use strict';
/**
 * 纵横四海 · AI 世界驱动支线生成
 *
 * 动态支线不是"玩家随时请求"的，而是**世界发展状态的投影**：
 * 世界经济引擎触发事件（风暴/瘟疫/商路中断等）后，AI 依据该事件本身
 * 生成一条与事件因果绑定的支线（如风暴→护送遇险商船；瘟疫→收集药材），
 * 在事件所在区域可接取；事件消退时未接取支线随之退场。
 *
 * AI 失败返回 null（不产生支线，不破坏主流程）。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaJson, MODEL_LIGHT } = require('./ai-decision-service');

/**
 * 依据触发的事件生成一条因果绑定的动态支线（async）。AI 失败返回 null。
 * event: { name, region, effect_kind, target_field, strength, duration, tip }
 * ctx:   { region（区域显示名）, regionId, npcs（该区域可用NPC名）, memorySummary（世界近期大事摘要） }
 */
async function aiGenerateWorldSidequest(event, ctx = {}) {
  if (!event?.name) return null;
  const region = ctx.region || event.region || '未知海域';
  const memorySummary = ctx.memorySummary || '无特别往事';
  const npcs = (ctx.npcs && ctx.npcs.length) ? ctx.npcs : ['酒馆老板'];
  const prompt = `你是文字网游《纵横四海》的关卡设计。当前世界正发生事件：「${event.name}」（区域：${region}，影响：${event.tip || event.effect_kind || '未知'}）。
这是世界变化带来的新情况，因此涌现一条与之因果相关的支线任务——玩家帮区域里的人应对这场变故。只输出 JSON：
{
  "canonical_id": "side.dyn.${(ctx.regionId || 'world').replace(/[^a-zA-Z0-9._-]/g, '_')}.${String(Date.now()).slice(-6)}",
  "display_name": "支线名（14字内，贴合${event.name}）",
  "description": "一句话任务描述（说明与事件的关联，30字内）",
  "task_type": "sidequest",
  "level_requirement": 1,
  "targets": [{ "target_kind": "npc", "entity_canonical_id": "${npcs[0] || 'npc'} ", "required_quantity": 1 }],
  "rewards": [{ "reward_kind": "money", "quantity": 250 }, { "reward_kind": "experience", "quantity": 180 }],
  "dialogues": [
    { "phase": "receive", "normalized_text": "接取对白（提及${event.name}，20字内）" },
    { "phase": "submit", "normalized_text": "提交对白（事件告一段落，20字内）" }
  ],
  "prerequisites": [],
  "successors": [],
  "blocking_reasons": []
}`;
  try {
    const raw = await ollamaJson(prompt, {
      system: '你是文字网游关卡设计，只输出合法的JSON支线任务定义。',
      temperature: 0.95, maxTokens: 700, model: MODEL_LIGHT, think: false,
    });
    const task = raw?.targets && raw?.display_name ? raw : null;
    if (!task) return null;
    task.task_type = task.task_type || 'sidequest';
    task.level_requirement = task.level_requirement ?? 1;
    task.prerequisites = task.prerequisites ?? [];
    task.successors = task.successors ?? [];
    task.blocking_reasons = task.blocking_reasons ?? [];
    task.dialogues = task.dialogues ?? [];
    // 记录绑定的事件与区域，供生命周期清理
    task.bound_event = event.name;
    task.bound_region = region;
    task.ai_generated = true;
    return task;
  } catch {
    return null;
  }
}

module.exports = { aiGenerateWorldSidequest };
