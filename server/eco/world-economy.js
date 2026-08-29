'use strict';
/**
 * 纵横四海 · 动态世界经济引擎
 *
 * 系统目标：
 *   1) 世界商品价格动态变化（基于区域供需周期 + 当前城市区域 + 气候/事件修正）；
 *   2) 世界随机事件持续发生（海盗、丰收、风暴、瘟疫、商集、珍稀发现……），
 *      产生新的事件与遭遇，并影响世界——包括商品价格、天气；
 *   3) 事件影响对外可查（价格矩阵、天气、活跃事件），供市场/天下页展示。
 *
 * 价格模型：
 *   price(good, cityRegion) = 基准价 × 区域系数(产区0.75/异区1.25)
 *                             × 区域供需系数(regionSupply[region][category])
 *                             × 气候修正(weatherEffect[region][category])
 *                             × (1 + 随机波动±0.15)
 *
 * 供需模型：regionSupply[region][category] 随 tick 缓慢回归 1（均值回归），
 *   周期性在 0.8~1.3 之间震荡；事件会瞬时扰动并进入回归。
 *
 * 天气模型：weather[region] 在 {晴天,多云,小雨,暴雨,风暴,酷热,寒潮} 间转移，
 *   影响 粮食/特产 价格。
 *
 * 事件模型：每 tick 以概率触发 WorldEvent；事件带 duration（tick 数）、
 *   影响对象、强度（price delta / weather 迁移 / 遭遇生成）。
 */
const fs = require('node:fs');
const path = require('node:path');

const WEATHER = Object.freeze({ SUNNY:'晴天', CLOUDY:'多云', LIGHT_RAIN:'小雨', STORM:'暴雨', GALE:'风暴', HEAT:'酷热', COLD:'寒潮' });
const CATEGORY_WEATHER_EFFECT = Object.freeze({
  food: { STORM: 1.25, GALE: 1.18, HEAT: 0.95, COLD: 1.08, LIGHT_RAIN: 1.05 },
  specialty: { STORM: 1.12, GALE: 1.08, HEAT: 0.98, COLD: 1.05 },
});
const CATEGORY_BASE_EFFECT = Object.freeze({ food: 1, specialty: 1, material: 1, luxury: 1 });

const REGION_SUPPLY_RANGE = Object.freeze({ min: 0.78, max: 1.32 });
const PRICE_JITTER = 0.15;
const REGION_REGRESSION = 0.06; // 每次 tick 供需向 1 回归的比例

// 事件影响曲线示例（food 类在风暴时会涨价）
const EVENT_TEMPLATES = [
  { id:'pirate', name:'海盗来袭', tag:'遭遇', category:'encounter', min_duration:3, max_duration:6, effect_kind:'price', target_field:'specialty', strength:0.22, tip:'一片海域遭海盗封锁，航线受阻，异区特产价格攀升' },
  { id:'harvest', name:'大丰收', tag:'事件', category:'economy', min_duration:2, max_duration:5, effect_kind:'supply', target_field:'food', strength:-0.18, tip:'某区域粮食大丰收，粮价走低' },
  { id:'drought', name:'旱灾', tag:'事件', category:'economy', min_duration:2, max_duration:6, effect_kind:'supply', target_field:'food', strength:0.2, tip:'某区域遭遇旱灾，粮食歉收，粮价上涨' },
  { id:'storm', name:'风暴降临', tag:'天气', category:'weather', min_duration:3, max_duration:6, effect_kind:'weather', target_field:'food', strength:1.25, tip:'一场风暴横扫海域，粮价与特产价格波动，航行危险' },
  { id:'plague', name:'瘟疫蔓延', tag:'事件', category:'economy', min_duration:3, max_duration:7, effect_kind:'supply', target_field:'material', strength:0.18, tip:'某城爆发瘟疫，药材等物资短缺而涨价' },
  { id:'market_fair', name:'商人集会', tag:'事件', category:'economy', min_duration:2, max_duration:4, effect_kind:'price', target_field:'specialty', strength:-0.15, tip:'某地举办商人集会，异区特产小幅跌价促销' },
  { id:'treasure_sighting', name:'珍稀发现', tag:'遭遇', category:'encounter', min_duration:2, max_duration:5, effect_kind:'discovery', target_field:'luxury', strength:0.1, tip:'有传言在某一海域发现了珍稀宝物，吸引无数探险家' },
  { id:'sunny_ride', name:'风和日丽', tag:'天气', category:'weather', min_duration:2, max_duration:4, effect_kind:'weather', target_field:'food', strength:0.92, tip:'连续晴好天气，谷物丰收，粮价回落' },
];

class WorldEconomy {
  /**
   * @param {object} options
   * @param {object} options.content  服务器内容（goods / market_region / world_regions）
   * @param {string} options.statePath 经济状态落盘文件（json）
   * @param {number} options.tickMs  经济刷新间隔
    *   @param {(event:object)=>void} options.onEvent  事件触发回调（广播/日志）
 *   @param {async (parentEvent, state)=>object|null} options.aiChain  连环事件生成（因果链）
 */
  constructor({ content, statePath, tickMs = 60000, onEvent = null, aiEnabled = true, aiDecide = null, aiReport = null, aiChain = null, random = Math.random }) {
    this.content = content;
    this.aiChain = aiChain;
    this.statePath = statePath || path.join(__dirname, '..', 'data', 'economy.json');
    this.tickMs = tickMs;
    this.onEvent = onEvent;
    this.random = random;
    // AI 决策层：aiDecide 为注入的 async 函数（llm 调用），akEnabled=true 且 aiDecide 存在时用于生成事件
    this.aiEnabled = aiEnabled && typeof aiDecide === 'function';
    this.aiDecide = aiDecide;
    // AI 情报综述：aiReport 为 async 函数，tick 时生成市场/天气综述，供玩家查看
    this.aiReport = typeof aiReport === 'function' ? aiReport : null;
    this.lastReportAt = 0;
    this.regions = Object.values(content.world_regions?.regions ?? {}).map((r) => r.name);
    this.categoryByGood = this.buildCategoryMap();
    this.economy = null;
    this.timer = null;
    this.load();
  }

  buildCategoryMap() {
    const m = new Map();
    const regions = this.content.goods?.regions ?? {};
    for (const entry of Object.values(regions)) {
      for (const good of (entry.specialty ?? [])) m.set(good.canonical_id, good.category ?? 'specialty');
    }
    return m;
  }

  /** 构造初始经济状态 */
  buildInitialEconomy() {
    return {
      version: 1,
      weather: Object.fromEntries(this.regions.map((r) => [r, WEATHER.SUNNY])),
      regionSupply: Object.fromEntries(this.regions.map((r) => [r, { food: 1, specialty: 1, material: 1, luxury: 1 }])),
      activeEvents: [],
      eventLog: [],
      updated_at: new Date().toISOString(),
      tick_count: 0,
    };
  }

  load() {
    if (this.statePath && fs.existsSync(this.statePath)) {
      try { this.economy = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); return; } catch {}
    }
    this.economy = this.buildInitialEconomy();
    this.persist();
  }

  persist() {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.economy, null, 2), 'utf8');
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => console.error('[ECO] tick error', e?.message)), this.tickMs);
    console.log(`[ECO] 世界经济引擎启动，tick=${this.tickMs}ms`);
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** 每周经济 tick：供需回归 + 随机事件 + 天气转移 */
  async tick() {
    const eco = this.economy;
    eco.tick_count += 1;
    if (!this.tickLock) this.tickLock = (async () => {
      // 1) 事件倒计时，过期移除
      eco.activeEvents = eco.activeEvents.filter((e) => { e.remaining = (e.remaining ?? 1) - 1; return e.remaining > 0; });
      // 2) 供需均值回归
      for (const region of this.regions) {
        const sup = eco.regionSupply[region];
        for (const cat of ['food','specialty','material','luxury']) { sup[cat] = this.meanRegression(sup[cat]); }
      }
      // 3) 天气迁移
      this.transitionWeather(eco);
      // 4) 概率触发事件（AI 决策优先，规则保底）
      const event = await this.rollEvent(eco);
      if (event) {
        eco.activeEvents.push(event); eco.eventLog.push({ ...event, occurred_at: new Date().toISOString() });
        if (this.onEvent) this.onEvent(event);
        // 连环世界事件：AI 依当前事件生成因果关联的后续事件（有概率、不泛滥）
        if (this.aiChain && this.aiEnabled && this.random() < 0.4) {
          try {
            const chainEvent = await this.aiChain(event, this.snapshot());
            if (chainEvent && chainEvent.name && !eco.activeEvents.some((e) => e.name === chainEvent.name)) {
              chainEvent.parent_event = event.id || event.name;
              chainEvent.chain_id = (event.chain_id || event.id || event.name) + '>' + (chainEvent.id || chainEvent.name);
              eco.activeEvents.push(chainEvent);
              eco.eventLog.push({ ...chainEvent, occurred_at: new Date().toISOString() });
              if (this.onEvent) this.onEvent(chainEvent);
            }
          } catch {}
        }
      }
      // 5) 应用事件影响（价格/天气/遭遇）
      this.applyEvents(eco);
      // 6) AI 生成市场/天气综述（玩家查看的"情报"；AI 失败用规则摘要保底）
      if (this.aiReport) {
        const now = Date.now();
        if (now - this.lastReportAt > this.tickMs - 5000) {
          this.lastReportAt = now;
          try { eco.marketReport = await this.aiReport(this.snapshot()); }
          catch { eco.marketReport = this.ruleReport(); }
        }
      }
      eco.updated_at = new Date().toISOString();
      this.persist();
      this.tickLock = null;
      return { tick_count: eco.tick_count, activeEvents: eco.activeEvents.length };
    })();
    return this.tickLock;
  }

  meanRegression(value) {
    const next = Number(value ?? 1) + (1 - Number(value ?? 1)) * REGION_REGRESSION;
    return Math.max(REGION_SUPPLY_RANGE.min, Math.min(REGION_SUPPLY_RANGE.max, next));
  }

  transitionWeather(eco) {
    for (const region of this.regions) {
      const roll = this.random();
      if (roll < 0.04) eco.weather[region] = WEATHER.STORM;
      else if (roll < 0.07) eco.weather[region] = WEATHER.HEAT;
      else if (roll < 0.10) eco.weather[region] = WEATHER.COLD;
      else if (roll < 0.15) eco.weather[region] = WEATHER.LIGHT_RAIN;
      else if (roll < 0.16) eco.weather[region] = WEATHER.GALE;
      else if (roll < 0.30) eco.weather[region] = WEATHER.CLOUDY;
      else eco.weather[region] = WEATHER.SUNNY;
    }
  }

  async rollEvent(eco) {
    if (this.random() > 0.35) return null; // 65% tick 无事件，保持世界稳定
    // AI 决策层：给定当前世界状态，让 llm 决定最有故事性/影响的一次事件
    if (this.aiEnabled) {
      try {
        const ai = await this.aiDecide({
          weather: eco.weather, regionSupply: eco.regionSupply, activeEvents: eco.activeEvents.map((e) => e.name), regions: this.regions,
        });
        if (ai && ai.name && this.regions.includes(ai.region) && (ai.effect_kind || ai.category)) {
          const duration = Math.max(1, Math.min(8, Number(ai.duration ?? 4)));
          return {
            id: ai.id ?? `ai_event_${Date.now()}`, name: String(ai.name).slice(0, 20),
            tag: ai.tag ?? '事件', category: ai.category ?? 'economy', region: ai.region,
            effect_kind: ai.effect_kind ?? 'supply', target_field: ai.target_field ?? 'food',
            strength: Math.max(-0.3, Math.min(0.35, Number(ai.strength ?? 0.15))),
            duration, remaining: duration, tip: String(ai.tip ?? '').slice(0, 80), ai_generated: true,
          };
        }
      } catch { /* AI 失败降级为规则 */ }
    }
    // 规则保底
    const base = EVENT_TEMPLATES[Math.floor(this.random() * EVENT_TEMPLATES.length)];
    const region = this.regions[Math.floor(this.random() * this.regions.length)];
    const duration = Math.floor(base.min_duration + this.random() * (base.max_duration - base.min_duration + 1));
    return { ...base, region, duration, remaining: duration, strength: (base.strength ?? 0.15) * (0.7 + this.random() * 0.6) };
  }

  /** 手动触发一个事件（超管测试用）：立即注册进 activeEvents/eventLog 并走 onEvent。
   *  event: { name, region, effect_kind?, target_field?, strength?, duration?, tip? }（region 缺省随机） */
  async spawnEvent(event) {
    if (!event || !event.name) throw new Error('spawnEvent requires name');
    const eco = this.economy;
    const region = (event.region && this.regions.includes(event.region)) ? event.region : this.regions[Math.floor(this.random() * this.regions.length)];
    const duration = Math.max(1, Math.min(12, Number(event.duration ?? 5)));
    const spawned = {
      id: event.id ?? `admin_event_${Date.now()}`, name: String(event.name).slice(0, 20),
      tag: event.tag ?? '事件', category: event.category ?? 'economy', region,
      effect_kind: event.effect_kind ?? 'supply', target_field: event.target_field ?? 'food',
      strength: Math.max(-0.3, Math.min(0.35, Number(event.strength ?? 0.15))),
      duration, remaining: duration, tip: String(event.tip ?? '').slice(0, 120), ai_generated: false, admin_spawned: true,
    };
    eco.activeEvents.push(spawned);
    eco.eventLog.push({ ...spawned, occurred_at: new Date().toISOString() });
    this.applyEvents(eco);
    this.persist();
    if (this.onEvent) this.onEvent(spawned);
    return spawned;
  }

  applyEvents(eco) {
    for (const e of eco.activeEvents) {
      if (e.effect_kind === 'weather') {
        eco.weather[e.region] = e.target_field === 'food' && e.strength > 1 ? WEATHER.STORM : e.strength < 1 ? WEATHER.SUNNY : eco.weather[e.region];
      } else if (e.effect_kind === 'supply') {
        const sup = eco.regionSupply[e.region];
        if (sup) sup[e.target_field] = this.clampSupply((sup[e.target_field] ?? 1) * (1 + e.strength));
      }
      // price / discovery / encounter 影响通过 regionSupply 或天气已体现；price 类通过让该区 specialty 供给波动模拟
      else if (e.effect_kind === 'price') {
        const sup = eco.regionSupply[e.region];
        if (sup) sup[e.target_field] = this.clampSupply((sup[e.target_field] ?? 1) * (1 - e.strength)); // 促销/封锁：价格反向
      }
    }
  }

  clampSupply(value) { return Math.max(REGION_SUPPLY_RANGE.min, Math.min(REGION_SUPPLY_RANGE.max, value)); }

  /** 玩家/AI 商人交易对区域供需的反馈（AI 商人博弈的核心联动）。
   *  buy：商品被买走 → 该区供给收紧 → 价格抬升；sell：抛售 → 供给增 → 价格走低。
   *  delta 约定：buy 为负（吸走供给）、sell 为正（灌入供给），量级按交易量折算。 */
  applyTrade(region, category, delta) {
    const eco = this.economy;
    const sup = eco.regionSupply?.[region];
    if (!sup) return null;
    const before = Number(sup[category] ?? 1);
    sup[category] = this.clampSupply(before + Number(delta ?? 0));
    eco.tradeCount = (eco.tradeCount ?? 0) + 1;
    eco.tradeLog = eco.tradeLog ?? [];
    eco.tradeLog.push({ region, category, delta, before, after: sup[category], at: new Date().toISOString() });
    if (eco.tradeLog.length > 200) eco.tradeLog.shift();
    return { region, category, before, after: sup[category] };
  }

  /**
   * 供 MarketRuntime 调用的最终价格。
   * @param {object} good 商品 { base_price, category, region }
   * @param {string} cityRegionName 当前城市所在区域名（如"地中海"）
   * @param {number} regionFactor  产区 0.75 / 异区 1.25 的区域基准系数
   * 价格 = base_price × regionFactor × 经济修正（供需+天气+抖动，均收敛在小幅 0.85~1.15）
   * 使动态波动作为对区域价差的"小幅扰动"，不破坏跨区套利模型。
   */
  getPrice(good, cityRegionName, regionFactor = 1) {
    const category = good.category ?? 'specialty';
    const supply = this.economy.regionSupply[cityRegionName]?.[category] ?? 1;
    const weather = this.economy.weather[cityRegionName] ?? WEATHER.SUNNY;
    const weatherEffect = CATEGORY_WEATHER_EFFECT[category]?.[weather] ?? CATEGORY_BASE_EFFECT[category] ?? 1;
    const jitter = 1 + (this.random() - 0.5) * PRICE_JITTER;
    // 收敛经济修正到小幅区间：supply 已在 0.78~1.32，转换为 0.9~1.1 的扰动系数
    const econFactor = 0.85 + Math.min(0.15, Math.max(-0.15, (supply - 1) * 0.5 + (weatherEffect - 1) * 0.5 + (jitter - 1) * 0.3));
    const price = Number(good.base_price) * Number(regionFactor) * econFactor;
    return Math.max(1, Math.round(price));
  }

  /** 规则保底的市场综述（AI 失败时用） */
  ruleReport() {
    const eco = this.economy;
    const hot = [];
    for (const r of this.regions) {
      const sup = eco.regionSupply[r];
      for (const cat of ['food','specialty','material','luxury']) {
        const s = sup[cat];
        if (s >= 1.1) hot.push(`${r}${cat}富余`);
        else if (s <= 0.9) hot.push(`${r}${cat}紧缺`);
      }
    }
    return { summary: hot.length ? `${hot.slice(0,3).join('、')}，随行情波动。` : '各区域供需基本平衡，天下太平。', generated_at: new Date().toISOString(), fallback: true };
  }

  /** 世界状态快照（供 /api/game/world 与前端展示） */
  snapshot() {
    // regionNames：slug→中文（供 AI 连环事件把 AI 输出的中文区域名映射回 slug）
    const regionNames = Object.fromEntries(Object.entries(this.content?.world_regions?.regions ?? {}).map(([slug, r]) => [slug, r.name]));
    return { weather: this.economy.weather, activeEvents: this.economy.activeEvents, eventLog: this.economy.eventLog.slice(-20),
      tick_count: this.economy.tick_count, updated_at: this.economy.updated_at, marketReport: this.economy.marketReport ?? null,
      regionSupply: this.economy.regionSupply, tradeCount: this.economy.tradeCount ?? 0, tradeLog: (this.economy.tradeLog ?? []).slice(-10),
      regions: this.regions, regionNames };
  }
}

module.exports = { WorldEconomy, WEATHER, EVENT_TEMPLATES, CATEGORY_WEATHER_EFFECT };
