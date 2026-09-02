'use strict';
/**
 * 纵横四海 · 老爷爷 AI 顾问
 *
 * 玩家问「接下来该做啥」时，把当前状态（等级/血量/金钱/任务链/背包/所在地）打包成
 * 一个紧凑上下文，交给本地 ollama 生成一段长者口吻的行动建议。异步、失败保底模板。
 *
 * 依赖：server/ai/ai-decision-service.js（统一 ollama 调用 + 并发信号量）。
 */

const { ollamaGenerate, MODEL_LIGHT } = require('./ai-decision-service');

// 任务状态 → 面向玩家的中文标签
const STATUS_LABEL = {
  locked: '未解锁',
  blocked: '受阻',
  available: '可接取',
  accepted: '进行中',
  in_progress: '进行中',
  completable: '可交付',
  completed: '已完成',
};

// 目标类型 → 玩家可理解的怎么做
const TARGET_HINT = {
  npc: '找NPC',
  npc_duel: '与NPC切磋',
  monster: '击败指定怪物',
  item: '收集指定物品',
  cook: '烹饪',
  trade_order: '完成贸易订单',
  trade_sell: '出售货物',
  prepare_voyage: '筹备航海物资',
  trade_reputation: '提升贸易声望',
  upgrade_equipment: '强化装备',
  upgrade_ship: '强化船只',
};

/**
 * 从游戏状态构建一份给「老爷爷」看的紧凑上下文。
 * @param {object} state engine.loadPlayer(playerId) 返回的完整状态
 * @param {object} catalog 内容目录（提供任务/物品/地点定义）
 */
function buildGrandpaContext(state, catalog) {
  const player = state.player ?? {};
  const loc = state.current_location ?? {};
  const activeSeries = state.active_series_canonical_id ?? '';
  const tasks = state.tasks ?? {};
  const progress = state.progress ?? {};
  const inventory = state.inventory ?? {};

  // 当前主线链：取一次 active_series 下尚未完成的链（accept/submit 驱动，靠 status 判序）
  const chain = [];
  for (const [taskId, runtime] of Object.entries(tasks)) {
    const def = catalog.getTask ? catalog.getTask(taskId) : null;
    const defTask = def ?? (catalog.tasks ?? []).find((t) => t.canonical_id === taskId);
    if (!defTask) continue;
    chain.push({
      id: taskId,
      name: defTask.display_name ?? taskId.slice(-8),
      status: runtime.status,
      step: runtime.current_step ?? 0,
      level: defTask.level_requirement ?? 0,
    });
  }
  chain.sort((a, b) => {
    const rank = (s) => ({ locked: 0, blocked: 1, available: 2, accepted: 3, in_progress: 4, completable: 5, completed: 6 }[s] ?? 0);
    return rank(a.status) - rank(b.status) || String(a.id).localeCompare(String(b.id));
  });

  // 下一步：当前人所在地能接/能交、或最早进入「可接取/进行中/可交付」的任务
  const actionable = chain.filter((t) => ['available', 'accepted', 'in_progress', 'completable'].includes(t.status));
  const next = actionable[0] ?? null;

  // 目标粒度：合并任务链中前置任务的剩余需求（取前 8 条）
  const remaining = chain
    .filter((t) => ['accepted', 'in_progress'].includes(t.status))
    .slice(0, 8)
    .map((t) => {
      const defTask = (catalog.tasks ?? []).find((x) => x.canonical_id === t.id);
      const targets = (defTask?.targets ?? defTask?.raw_value?.targets ?? []).map((tg) => {
        const key = `${t.id}|${tg.canonical_id ?? tg.target_canonical_id}`;
        const done = Number(progress[key] ?? 0);
        const need = Number(tg.normalized_quantity ?? tg.required_quantity ?? 1);
        return { kind: tg.target_kind ?? 'item', need, done, hint: TARGET_HINT[tg.target_kind] ?? '' };
      });
      return { name: t.name, status: STATUS_LABEL[t.status] ?? t.status, targets };
    });

  // 背包：只列非零数量可视物品名
  const entities = catalog.content_entities ?? [];
  const items = catalog.items ?? catalog.formal_items ?? [];
  const bag = Object.entries(inventory)
    .filter(([, q]) => Number(q) > 0)
    .slice(0, 12)
    .map(([id, q]) => {
      const item = items.find((x) => x.canonical_id === id) ?? entities.find((x) => x.canonical_id === id);
      return `${item?.display_name ?? id.slice(-8)}×${q}`;
    });

  return {
    角色等级: Number(player.level ?? 1),
    当前体力: `${Number(player.current_health ?? 0)}/${Number(player.max_health ?? 0)}`,
    铜贝: Number(player.money ?? 0),
    经验: Number(player.experience ?? 0),
    所在地: `${loc.display_name ?? ''}（${loc.city_canonical_id ?? ''}）`,
    当前篇章: activeSeries,
    近期任务: chain.slice(0, 8).map((t) => `${t.name}[${STATUS_LABEL[t.status] ?? t.status}]`),
    下一步: next ? `${next.name}[${STATUS_LABEL[next.status] ?? next.status}]` : '（暂无未完成任务，可自由探索/航海/贸易）',
    待办目标: remaining,
    背包: bag,
  };
}

/**
 * 生成老爷爷的口头建议。任何 ollama 失败都返回模板化保底文本，绝不让 AI 错误阻断玩家。
 * @param {object} ctx 由 buildGrandpaContext 生成的上下文对象（可先经 JSON.stringify 注入）
 * @param {string} [question] 玩家额外的问题
 */
async function aiGrandpaAdvice(ctx, question = '') {
  const prompt = `你是《纵横四海》里跟着玩家的慈祥「老爷爷」，见多识广、说话亲切又带点俏皮。
玩家向你请教接下来该做什么。请结合下面这份真实状态，用 120 字以内、口语化中文，说 1-3 条最具体可执行的行动建议
（哪里去、找谁、打什么/收集什么／练几级、有什么要注意），不要空话套话，不要罗列全部任务，只挑最该做的。
玩家额外的问题：${question || '（无，就按状态说）'}

当前状态：
${JSON.stringify(ctx, null, 1)}`;
  try {
    const raw = await ollamaGenerate(prompt, {
      system: '你是《纵横四海》游戏中慈祥可靠的老爷爷顾问，用亲切口语化的中文给出具体行动建议。',
      temperature: 0.7,
      maxTokens: 200,
      model: MODEL_LIGHT,
      think: false,
    });
    return { advice: String(raw || '').trim().slice(0, 200), source: 'ai', fallback: false };
  } catch {
    return { advice: defaultAdvice(ctx), source: 'fallback', fallback: true };
  }
}

/** 保底建议：完全由状态推导，不依赖 AI。 */
function defaultAdvice(ctx) {
  const next = ctx.下一步;
  const parts = [];
  if (next && !next.startsWith('（暂无')) {
    parts.push(`眼下最该做的是「${next.replace(/\[.*\]$/, '')}」。`);
  } else {
    parts.push('主线暂无待办，可以四处走走、跑跑贸易或攒点铜贝。');
  }
  if (Number(ctx.当前体力?.split('/')[0] ?? 0) < 40) parts.push('体力不高，先去城里的教堂或酒馆歇歇脚。');
  if (Number(ctx.铜贝 ?? 0) < 200) parts.push('铜贝不多，接个跑腿任务或打点低级怪攒点盘缠。');
  return parts.join(' ');
}

module.exports = { aiGrandpaAdvice, buildGrandpaContext, defaultAdvice };
