'use strict';
/**
 * 纵横四海 · AI 玩家模拟器（服务器 sidecar）
 *
 * AiPlayerSimulator 为每个 AI 玩家提供"决策循环"：
 *   1) 读取其服务器视角（getPlayerView + list_current_npcs + market view）
 *   2) 用 ollama qwen3.5:9b 依据性格/目标生成下一个目标动作
 *   3) 经规则层校验，非法则降级为 rest（等待）
 *   4) 通过引擎执行动作，并落库
 * tick 间隔 45s；AI 玩家注册进 WorldStateRegistry，与真人共享世界快照。
 *
 * 依赖：http://127.0.0.1:11434（ollama），qwen3.5:9b。
 */
const { ollamaGenerate, MODEL_FAST } = require('./ai-decision-service');

const TICK_MS = Number(process.env.ZHSH_AI_TICK_MS || 45000);

// 统一走 ai-decision-service 的 ollama 调用（含降级/超时管理）
async function ollamaComplete(prompt, { maxTokens = 200 } = {}) {
  return ollamaGenerate(prompt, { temperature: 0.8, maxTokens, model: MODEL_FAST, think: false });
}

class AiPlayerSimulator {
  constructor({ engine, storage, catalog, runtime = {}, createEventId, personality = '冒险家' }) {
    this.engine = engine;
    this.storage = storage;
    this.catalog = catalog;
    this.runtime = runtime; // { combat, recovery, market } 等玩法 runtime
    this.createEventId = createEventId || (() => `ai.${Math.random().toString(36).slice(2, 10)}`);
    this.players = new Map(); // aiPlayerId -> { personality, goal, last_tick, online }
    this.personality = personality;
    this.tickTimer = null;
  }

  registerAiPlayer(playerId, { personality = '冒险家', goal = '执行任务与贸易赚钱', role = 'adventurer' } = {}) {
    this.players.set(playerId, { personality, goal, role, last_tick: 0, online: true });
    return playerId;
  }

  /** 商人决策：基于市场行情，AI 决定买入/卖出/观望 + 商品（囤货待涨/高价抛出）。
   *  商人买卖经 market runtime → 世界经济 applyTrade → 影响 regionSupply/价格，
   *  这就是"AI 作为影响世界发展"的核心通道。 */
  async decideMarket(view, record) {
    const instruction = `你是《纵横四海》的商人（${record.personality}）。目标：${record.goal}。
当前资金 ${view.player?.money ?? 0}，在市场城市。
请你做最合理的**一个**市场动作。只输出 JSON：
{"action":"buy|sell|hold","good":"商品名(从当地特产中选)","quantity":整数}
低价买入(囤货待涨)，高价抛出(已有库存则卖)。若无把握则 hold。`;
    const raw = await ollamaComplete(instruction, { maxTokens: 40 });
    try {
      const m = raw.match(/{[\s\S]*}/);
      const decision = m ? JSON.parse(m[0]) : null;
      if (decision && ['buy','sell','hold'].includes(decision.action)) return { action: 'market', trade: decision };
    } catch {}
    return { action: 'rest' };
  }

  unregisterAiPlayer(playerId) {
    this.players.delete(playerId);
  }

  startTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tickAll().catch((err) => console.error('[AI] tick error', err?.message));
    }, TICK_MS);
    console.log(`[AI] simulator started, tick=${TICK_MS}ms, model=${MODEL_FAST}`);
  }

  stopTick() {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  async tickAll() {
    for (const playerId of [...this.players.keys()]) {
      const record = this.players.get(playerId);
      if (!record.online) continue;
      try { await this.tick(playerId, record); }
      catch (err) { console.error(`[AI] tick player ${playerId}`, err?.message); }
    }
  }

  async tick(playerId, record) {
    const view = this.engine.getPlayerView(playerId);
    const decision = await this.decide(view, record);
    const executed = await this.execute(playerId, decision, view);
    record.last_tick = Date.now();
    return executed;
  }

  async decide(view, record) {
    // 商人人格：优先市场决策（其买卖经市场 runtime → 世界经济影响价格）
    if (record.role === 'merchant' && this.runtime.market) {
      try { const marketDecision = await this.decideMarket(view, record); if (marketDecision.action === 'market') return marketDecision; } catch {}
    }
    // 组装简报：当前地点、任务、可交互NPC、市场价
    const summary = {
      location: view.current_location?.display_name ?? '未知',
      city: view.current_location?.city_canonical_id ?? null,
      level: view.player?.level ?? 1,
      money: view.player?.money ?? 0,
      title: view.player?.title ?? '水手',
      active_series: view.active_series_canonical_id ?? null,
      task_chain_count: (view.task_chain ?? []).length,
      npcs: (view.current_npcs ?? []).map((n) => n.display_name).slice(0, 5),
    };
    const instruction = `你是《纵横四海》文字网游的一名AI航海家。
你的性格：${record.personality}。
你的长期目标：${record.goal}。
当前状态：${JSON.stringify(summary)}。
请给出你接下来的**一个**最合理行动，只输出一个动作关键字，从下面选择：
- talk       与当前场景NPC交谈/接任务
- move       移动到城内另一地点
- travel     坐船去另一个城市
- combat     与当前场景的怪战斗
- market     在商店买卖商品
- recovery   恢复体力
- rest       等待/无事可做
只输出动作关键字（小写英文），不要输出解释。`;
    const raw = await ollamaComplete(instruction, { maxTokens: 16 });
    const keyword = String(raw).trim().toLowerCase().split(/\s+/)[0] ?? 'rest';
    const allowed = ['talk','move','travel','combat','market','recovery','rest'];
    return { action: allowed.includes(keyword) ? keyword : 'rest' };
  }

  async execute(playerId, decision, view) {
    // 规则层：按决策执行引擎动作；非法/无前置则降级 rest
    const npcId = (view.current_npcs ?? [])[0]?.npc_canonical_id;
    const locationId = view.current_location?.location_canonical_id;
    const adjacent = this.engine.listAdjacentLocations(playerId);
    switch (decision.action) {
      case 'talk': {
        if (!npcId || !locationId) return this.rest(playerId, 'no npc');
        return this.engine.processEvent(playerId, { event_id: this.createEventId('ai-talk'), type: 'talk_to_npc', npc_canonical_id: npcId, location_canonical_id: locationId });
      }
      case 'move': {
        const target = (adjacent.length > 1 ? adjacent[Math.floor(Math.random() * adjacent.length)] : adjacent[0]);
        if (!target?.map_node_canonical_id) return this.rest(playerId, 'no move target');
        return this.engine.move(playerId, target.map_node_canonical_id, this.createEventId('ai-move'));
      }
      case 'travel': {
        // 跨城：从 city 找到新城市 route 太复杂，降级为城内移动（AI不需真实跨城才能模拟活跃）
        const target = adjacent[0];
        if (!target?.map_node_canonical_id) return this.rest(playerId, 'no travel target');
        return this.engine.move(playerId, target.map_node_canonical_id, this.createEventId('ai-travel'));
      }
      case 'combat': {
        const monsters = this.catalog?.listMonstersAtMapNode?.(view.player.current_map_node_canonical_id, view) ?? [];
        const monster = monsters[0];
        if (!monster?.canonical_id) return this.rest(playerId, 'no monster');
        const combatRt = this.runtime.combat;
        if (!combatRt) return this.rest(playerId, 'no combat runtime');
        return combatRt.start(playerId, monster.canonical_id, this.createEventId('ai-combat'));
      }
      case 'market': {
        const marketRt = this.runtime.market;
        if (!marketRt) return this.rest(playerId, 'no market runtime');
        const trade = decision.trade;
        if (!trade || !['buy','sell'].includes(trade.action)) return this.rest(playerId, 'market hold');
        // 解析商品 canonical_id（按名称匹配当地特产）
        const goodName = String(trade.good ?? '').trim();
        const marketView = marketRt.getMarketView(playerId, this.createEventId('ai-market-view'));
        const good = (marketView.offers ?? []).find((o) => o.name === goodName || o.canonical_id === goodName);
        if (!good) return this.rest(playerId, `market good not found: ${goodName}`);
        const quantity = Math.max(1, Math.min(20, Number(trade.quantity ?? 5)));
        try {
          if (trade.action === 'buy') return marketRt.buy(playerId, good.canonical_id, quantity, this.createEventId('ai-market-buy'));
          // sell：仅当货舱有库存
          const cargoCount = view.cargo?.[good.canonical_id] ?? 0;
          if (cargoCount <= 0) return this.rest(playerId, 'no cargo to sell');
          return marketRt.sell(playerId, good.canonical_id, Math.min(quantity, cargoCount), this.createEventId('ai-market-sell'));
        } catch (err) {
          return this.rest(playerId, `market exec: ${err.message}`);
        }
      }
      case 'recovery': {
        const recovery = (this.catalog?.listRecoveryServicesAt?.(view.player.current_map_node_canonical_id) ?? [])[0];
        if (!recovery) return this.rest(playerId, 'no recovery');
        const recoveryRt = this.runtime.recovery;
        if (!recoveryRt) return this.rest(playerId, 'no recovery runtime');
        return recoveryRt.recover(playerId, recovery.canonical_id, this.createEventId('ai-recovery'));
      }
      default:
        return this.rest(playerId, 'default rest');
    }
  }

  rest(playerId, reason) {
    return { applied: true, action: 'ai_rest', ai: true, reason, ts: Date.now() };
  }
}

module.exports = { AiPlayerSimulator, ollamaComplete, TICK_MS };
