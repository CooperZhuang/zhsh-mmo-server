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
const { ollamaGenerate, MODEL_LIGHT } = require('./ai-decision-service');

const TICK_MS = Number(process.env.ZHSH_AI_TICK_MS || 45000);

// 统一走 ai-decision-service 的 ollama 调用（含降级/超时管理）
async function ollamaComplete(prompt, { maxTokens = 200 } = {}) {
  return ollamaGenerate(prompt, { temperature: 0.8, maxTokens, model: MODEL_LIGHT, think: false });
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

  registerAiPlayer(playerId, { personality = '冒险家', goal = '执行任务与贸易赚钱' } = {}) {
    this.players.set(playerId, { personality, goal, last_tick: 0, online: true });
    return playerId;
  }

  unregisterAiPlayer(playerId) {
    this.players.delete(playerId);
  }

  startTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tickAll().catch((err) => console.error('[AI] tick error', err?.message));
    }, TICK_MS);
    console.log(`[AI] simulator started, tick=${TICK_MS}ms, model=${MODEL_LIGHT}`);
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
        return this.rest(playerId, 'market deferred to city');
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
