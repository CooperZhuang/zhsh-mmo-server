'use strict';
/**
 * 纵横四海 · 网游服务器（权威）
 *
 * 客户端只发送指令，服务器引擎裁决一切并持久化到 sqlite。
 * 端点：
 *   POST /api/auth/register   {username,password} -> {token,player}
 *   POST /api/auth/login      {username,password} -> {token,player}
 *   GET  /api/game/state                          -> 当前玩家视图
 *   POST /api/game/action     {action,args,event_id} -> 游戏动作结果
 *
 * 静态托管 dist/（打包后的客户端），JWT 经 Authorization: Bearer 头。
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { openAuthority, openAccountStore } = require('./db');
const { verifyJwt, hashPassword, verifyPassword, issueToken } = require('./auth');
const { WorldStateRegistry } = require('./state');
const { attachWebSocket } = require('./ws');
const { AiPlayerSimulator } = require('./ai/ai-players');
const { WorldEconomy } = require('./eco/world-economy');
const { decideEvent } = require('./eco/ai-decision');
const { aiMarketReport } = require('./eco/ai-market-report');
const { aiMarketAdvice } = require('./eco/ai-market-advice');
const { aiEventNarrative } = require('./ai/ai-narrative');
const { aiNpcBanter } = require('./ai/ai-npc-banter');
const { aiCombatNarrative } = require('./ai/ai-combat-narrative');

const ROOT = path.resolve(__dirname, '..');
const DIST = process.env.ZHSH_DIST || path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};
const { catalog, storage, engine } = openAuthority();
const accounts = openAccountStore();
// 注入 NPC 动态对话内容（server/content/npc-dialogs.json）
engine.attachNpcDialogs(JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'content', 'npc-dialogs.json'), 'utf8')));

// ---- 鉴权 ----
function authenticate(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  const payload = verifyJwt(token);
  if (!payload || !payload.player) return null;
  const account = accounts.prepare('SELECT id, username, player_canonical_id FROM accounts WHERE id=?').get(payload.sub);
  if (!account) return null;
  return { accountId: payload.sub, username: account.username, playerCanonicalId: account.player_canonical_id };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    req.on('data', (c) => { bytes += c.length; if (bytes > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function eventId(prefix) { return `${prefix}.${cryptoRandomId()}`; }
function cryptoRandomId() {
  const { randomUUID } = require('node:crypto');
  return randomUUID();
}

// ---- 游戏动作分发器：把客户端动作映射到引擎 runtime ----
async function performAction(playerId, action, args, evId) {
  const a = args || {};
  switch (action) {
    // ---- 引擎核心事件 ----
    case 'talk_to_npc': {
      // a.npc_canonical_id, a.location_canonical_id
      return engine.processEvent(playerId, { event_id: evId, type: 'talk_to_npc', npc_canonical_id: a.npc_canonical_id, location_canonical_id: a.location_canonical_id });
    }
    case 'defeat_monster': {
      return engine.processEvent(playerId, { event_id: evId, type: 'defeat_monster', monster_canonical_id: a.monster_canonical_id, location_canonical_id: a.location_canonical_id, quantity: a.quantity ?? 1 });
    }
    case 'defeat_npc': {
      return engine.processEvent(playerId, { event_id: evId, type: 'defeat_npc', npc_canonical_id: a.npc_canonical_id, location_canonical_id: a.location_canonical_id, quantity: a.quantity ?? 1 });
    }
    case 'obtain_item': {
      return engine.processEvent(playerId, { event_id: evId, type: 'obtain_item', item_canonical_id: a.item_canonical_id, location_canonical_id: a.location_canonical_id, quantity: a.quantity ?? 1 });
    }
    case 'consume_item': {
      return engine.processEvent(playerId, { event_id: evId, type: 'consume_item', item_canonical_id: a.item_canonical_id, location_canonical_id: a.location_canonical_id, quantity: a.quantity ?? 1 });
    }
    case 'submit_to_npc': {
      return engine.processEvent(playerId, { event_id: evId, type: 'submit_to_npc', npc_canonical_id: a.npc_canonical_id, location_canonical_id: a.location_canonical_id });
    }
    case 'arrive_at_location': {
      // a.location_canonical_id（移动）
      const move = engine.move(playerId, a.map_node_canonical_id || (a.location_canonical_id ? require('node:crypto').randomUUID() : null), evId);
      return move;
    }
    case 'abandon_task': {
      return engine.processEvent(playerId, { event_id: evId, type: 'abandon_task', task_canonical_id: a.task_canonical_id });
    }
    // ---- 引擎视图/工具 ----
    case 'get_player_view': {
      return engine.getPlayerView(playerId);
    }
    case 'list_adjacent': {
      return engine.listAdjacentLocations(playerId);
    }
    case 'list_current_npcs': {
      return engine.listCurrentNpcs(playerId);
    }
    case 'move': {
      // a.map_node_canonical_id（城内点）
      return engine.move(playerId, a.map_node_canonical_id, evId);
    }
    case 'travel_to_city_port': {
      return engine.travelToCityPort(playerId, a.map_node_canonical_id, evId);
    }
    case 'fast_travel': {
      // a.location_canonical_id
      return engine.fastTravelToLocation(playerId, a.location_canonical_id, evId);
    }
    case 'select_series': {
      return engine.selectSeries(playerId, a.series_canonical_id, evId);
    }
    default: {
      return { applied: false, reason: `unsupported_action:${action}` };
    }
  }
}

// ---- 游戏 runtime（formal gameplay：combat/economy/ship/voyage 等） ----
function buildGameplayRuntimes() {
  const { CombatRuntime, DiscoverRuntime, RecruitRuntime, SkillRuntime, GuildRuntime, CityRuntime, NpcDuelRuntime, DivingRuntime, DropRuntime, DungeonRuntime, EconomyRuntime, EquipmentRuntime, EquipmentEnhanceRuntime,
    FishingRuntime, FormalGameplayCatalog, ItemRuntime, MarketRuntime, MaritimeRuntime, PetRuntime, RecoveryRuntime, ShipRuntime, VoyageRuntime } = require('../src/task-runtime/index.js');
  const gameplayCatalog = new FormalGameplayCatalog(loadContent());
  // 复用引擎作为 task engine
  const drops = new DropRuntime({ storage, catalog: gameplayCatalog, taskEngine: engine });
  return {
    combat: new CombatRuntime({ storage, catalog: gameplayCatalog, taskEngine: engine, dropRuntime: drops }),
    npcDuel: new NpcDuelRuntime({ storage, taskCatalog: engine, gameplayCatalog, taskEngine: engine }),
    dungeon: new DungeonRuntime({ storage, catalog: gameplayCatalog }),
    diving: new DivingRuntime({ storage, catalog: gameplayCatalog }),
    economy: new EconomyRuntime({ storage, catalog: gameplayCatalog, taskEngine: engine }),
    equipment: new EquipmentRuntime({ storage, catalog: gameplayCatalog }),
    enhance: new EquipmentEnhanceRuntime({ storage, catalog: gameplayCatalog }),
    fishing: new FishingRuntime({ storage, catalog: gameplayCatalog, taskEngine: engine }),
    items: new ItemRuntime({ storage, catalog: gameplayCatalog }),
    market: new MarketRuntime({ storage, catalog: gameplayCatalog, economy: getEconomy() }),
    maritime: new MaritimeRuntime({ storage, catalog: gameplayCatalog }),
    pets: new PetRuntime({ storage, catalog: gameplayCatalog }),
    discover: new DiscoverRuntime({ storage, catalog: gameplayCatalog }),
    recruit: new RecruitRuntime({ storage, catalog: gameplayCatalog }),
    skills: new SkillRuntime({ storage, catalog: gameplayCatalog }),
    guild: new GuildRuntime({ storage, catalog: gameplayCatalog }),
    city: new CityRuntime({ storage, catalog: gameplayCatalog }),
    recovery: new RecoveryRuntime({ storage, catalog: gameplayCatalog }),
    ships: new ShipRuntime({ storage, catalog: gameplayCatalog }),
    voyage: new VoyageRuntime({ storage, catalog: gameplayCatalog, taskEngine: engine, maritimeRuntime: new MaritimeRuntime({ storage, catalog: gameplayCatalog }) }),
    catalog: gameplayCatalog,
  };
}

let loadedContent = null;
function loadContent() {
  if (!loadedContent) {
    const contentPath = process.env.ZHSH_CONTENT || path.join(ROOT, 'web', 'generated', 'task1-content.json');
    loadedContent = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
    // 合并服务器内容数据（12区世界/市场/发现物/宠物/强化/道具/NPC/主线/角色/支线），缺失抛错
    const contentDir = path.join(ROOT, 'server', 'content');
    const contentFiles = {
      world_regions: 'world-regions.json',
      goods: 'goods.json',
      market_region: 'market_region.json',
      discoveries: 'discoveries.json',
      pets: 'pets.json',
      enhance_rules: 'enhance-rules.json',
      game_items: 'items.json',
      npc_dialogs: 'npc-dialogs.json',
      questline: 'questline.json',
      characters: 'characters.json',
      sidequests: 'sidequests.json',
      crew: 'crew.json',
      skills: 'skills.json',
      game_cities: 'cities.json',
    };
    for (const [key, file] of Object.entries(contentFiles)) {
      const filePath = path.join(contentDir, file);
      if (!fs.existsSync(filePath)) throw new Error(`missing content/${file}`);
      loadedContent[key] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }
  return loadedContent;
}

// runtime 会在请求时懒加载，避免阻塞启动
let runtime = null;
function getRuntime() {
  if (!runtime) runtime = buildGameplayRuntimes();
  return runtime;
}

// ---- 世界经济引擎（动态价格/天气/随机事件，AI 决策） ----
let economy = null;
let economyStarted = false;
const banterCache = new Map(); // npcName -> { line, at, source }（NPC 情境台词短时缓存）
const combatNarrCache = new Map(); // `${outcome}|${monster}` -> { line, at, source }（战斗叙述短时缓存）
function getEconomy() {
  if (!economy) {
    economy = new WorldEconomy({
      content: loadContent(),
      statePath: path.join(__dirname, 'data', 'economy.json'),
      tickMs: Number(process.env.ZHSH_ECO_TICK_MS || 60000),
      aiEnabled: process.env.ZHSH_ECO_AI !== '0',
      aiDecide: decideEvent,
      aiReport: aiMarketReport,
      onEvent: (event) => {
        // 先广播事件本体，再异步生成 AI 叙述播报补充（不阻塞事件触发）
        registry.broadcast({ type: 'world', kind: 'world_event', event });
        void aiEventNarrative(event).then((narr) => {
          registry.broadcast({ type: 'world', kind: 'world_event_narrative', narrative: narr });
        });
        console.log(`[ECO] 事件触发：${event.name}（${event.region} ${event.effect_kind}+${Number(event.strength).toFixed(2)}，${event.duration} tick）`);
      },
    });
  }
  return economy;
}
function startEconomy() {
  if (economyStarted) return;
  economyStarted = true;
  const eco = getEconomy();
  eco.start();
  console.log('[ZHSH] 世界经济引擎已启动（动态价格/天气/随机事件，AI 决策）');
}

// ---- 静态托管 ----
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'Method Not Allowed' }); return true; }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(DIST, relative);
  if (!filePath.startsWith(DIST + path.sep) && filePath !== path.join(DIST, 'index.html')) { sendJson(res, 403, { error: 'Forbidden' }); return true; }
  if (!fs.existsSync(filePath)) {
    // SPA fallback
    const index = path.join(DIST, 'index.html');
    if (fs.existsSync(index)) { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(fs.readFileSync(index)); return true; }
    sendJson(res, 404, { error: 'Not found' }); return true;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': stat.size });
  res.end(fs.readFileSync(filePath));
  return true;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { sendJson(res, 400, { error: 'Bad Request' }); return; }

  try {
    // 注册
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const { username, password } = JSON.parse(await readBody(req));
      if (!username || username.length < 2 || username.length > 12) return sendJson(res, 400, { error: '角色名需 2-12 个字符' });
      if (!password || password.length < 4) return sendJson(res, 400, { error: '密码至少 4 位' });
      const existing = accounts.prepare('SELECT 1 FROM accounts WHERE username=?').get(username);
      if (existing) return sendJson(res, 400, { error: '该角色名已被使用' });
      const { salt, hash } = hashPassword(password);
      const playerCanonicalId = `player.${username}`;
      const created = engine.createPlayer(playerCanonicalId, { reset: true });
      const playerId = created.player?.canonical_id || playerCanonicalId;
      const info = accounts.prepare('INSERT INTO accounts (username,password_hash,salt,player_canonical_id,created_at) VALUES (?,?,?,?,?)')
        .run(username, hash, salt, playerId, Date.now());
      const token = issueToken({ id: Number(info.lastInsertRowid), username, player_canonical_id: playerId });
      return sendJson(res, 200, { token, player: { id: Number(info.lastInsertRowid), username, player_canonical_id: playerId } });
    }

    // 登录
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const { username, password } = JSON.parse(await readBody(req));
      const account = accounts.prepare('SELECT * FROM accounts WHERE username=?').get(username);
      if (!account || !verifyPassword(password, account.salt, account.password_hash)) return sendJson(res, 401, { error: '角色名或密码错误' });
      const token = issueToken({ id: account.id, username: account.username, player_canonical_id: account.player_canonical_id });
      return sendJson(res, 200, { token, player: { id: account.id, username: account.username, player_canonical_id: account.player_canonical_id } });
    }

    // 鉴权后
    const auth = authenticate(req);
    if (pathname.startsWith('/api/game')) {
      if (!auth) return sendJson(res, 401, { error: '未登录或登录已过期' });
      if (pathname === '/api/game/state' && req.method === 'GET') {
        const view = engine.getPlayerView(auth.playerCanonicalId);
        return sendJson(res, 200, view);
      }
      if (pathname === '/api/game/action' && req.method === 'POST') {
        const { action, args, event_id } = JSON.parse(await readBody(req) || '{}');
        const evId = event_id || eventId(action);
        const result = await performAction(auth.playerCanonicalId, action, args, evId);
        return sendJson(res, 200, result);
      }
      if (pathname === '/api/game/runtime' && req.method === 'POST') {
        // formal gameplay runtime（combat/economy/ship/voyage/market/enhance/pet）统一入口
        const { gadget, method, args: gargs, event_id } = JSON.parse(await readBody(req) || '{}');
        const rt = getRuntime();
        const body = gargs || {};
        const evId = event_id || eventId(`${gadget}-${method}`);
        const fn = rt[gadget]?.[method];
        if (!fn) return sendJson(res, 404, { error: `No runtime ${gadget}.${method}` });
        // 统一签名 (playerId, ...args, eventId)
        const result = await fn.call(rt[gadget], auth.playerCanonicalId, ...[body._arg1, body._arg2, body._arg3].filter(v => v !== undefined), evId);
        return sendJson(res, 200, result);
      }
      if (pathname === '/api/game/players' && req.method === 'GET') {
        // 在线玩家列表（同场景可见 + 全局）
        registry.refresh(auth.playerCanonicalId);
        const list = registry.onlineList();
        const neighbors = list.filter((e) => e.snapshot?.map_node === engine.getCurrentLocation(auth.playerCanonicalId)?.map_node_canonical_id);
        return sendJson(res, 200, { online: registry.onlineCount(), players: list, neighbors });
      }
      if (pathname === '/api/game/world' && req.method === 'GET') {
        // 世界静态数据：12 区 / 发现物 / 商品 / 宠物 / 角色 / 支线 / 主线图鉴
        const content = loadContent();
        return sendJson(res, 200, {
          world_regions: content.world_regions,
          discoveries: content.discoveries,
          goods: content.goods,
          pets: content.pets,
          enhance_rules: content.enhance_rules,
          game_items: content.game_items,
          questline: content.questline,
          characters: content.characters,
          sidequests: content.sidequests,
          npc_dialogs: content.npc_dialogs,
          crew: content.crew,
          skills: content.skills,
          game_cities: content.game_cities,
          economy: getEconomy().snapshot(),
        });
      }
      if (pathname === '/api/game/intel' && req.method === 'GET') {
        // 世界经济情报：各区域天气/供需热度 + 套利机会提示（玩家据此决定何时何地买卖）
        const eco = getEconomy();
        const snap = eco.snapshot();
        const regions = loadContent().world_regions?.regions ?? {};
        const regionList = Object.entries(regions).map(([slug, r]) => ({
          slug, name: r.name,
          weather: snap.weather[r.name] ?? '晴天',
          supply: snap.regionSupply?.[r.name] ?? { food: 1, specialty: 1, material: 1, luxury: 1 },
        }));
        // 套利提示：某区域某类商品供给明显低于1（稀缺→本地贵，宜卖出）；高于1（富余→本地便宜，宜买入）
        const tips = [];
        for (const { name, supply } of regionList) {
          for (const cat of ['food','specialty','material','luxury']) {
            const s = supply[cat];
            if (s >= 1.12) tips.push({ region: name, category: cat, action: 'buy', note: `${name}${catLabel(cat)}富余，价格走低，宜买入屯货` });
            else if (s <= 0.88) tips.push({ region: name, category: cat, action: 'sell', note: `${name}${catLabel(cat)}紧缺，价格走高，宜卖出获利` });
          }
        }
        return sendJson(res, 200, {
          updated_at: snap.updated_at,
          tick_count: snap.tick_count,
          regions: regionList,
          activeEvents: snap.activeEvents.map((e) => ({ name: e.name, region: e.region, kind: e.effect_kind, field: e.target_field, strength: e.strength, tip: e.tip, remaining: e.remaining })),
          tips,
        });
      }
      if (pathname === '/api/game/npc_banter' && req.method === 'POST') {
        // AI 情境台词：由 NPC 身份/玩家任务/世界天气事件生成一句贴合语境台词（短时缓存复用）
        const { npc_name: npcName } = JSON.parse(await readBody(req) || '{}');
        const name = npcName || '某人';
        const cached = banterCache.get(name);
        if (cached && Date.now() - cached.at < 180000) return sendJson(res, 200, { line: cached.line, npc: name, source: cached.source });
        try {
          const view = engine.getPlayerView(auth.playerCanonicalId);
          const weatherSnapshot = getEconomy().snapshot();
          const banter = await aiNpcBanter({
            npcName: name,
            taskHint: view.task_chain?.find((t) => ['accepted','in_progress','completable'].includes(t.runtime?.status))?.definition?.display_name ?? null,
            playerTitle: view.player?.title,
            playerLevel: view.player?.level,
            weather: (Object.values(weatherSnapshot.weather ?? {}))[0] ?? null,
            activeEvents: (weatherSnapshot.activeEvents ?? []).map((e) => e.name),
          });
          banterCache.set(name, { line: banter.line, at: Date.now(), source: banter.source });
          return sendJson(res, 200, banter);
        } catch (err) {
          return sendJson(res, 200, { line: `${name}：${err.message}`, npc: name, source: 'fallback' });
        }
      }
      if (pathname === '/api/game/combat_narrative' && req.method === 'POST') {
        // AI 战斗叙述：战斗胜利/失败后一句凯旋/落败叙述（短时缓存复用）
        const { outcome, monster_name: monsterName, rounds } = JSON.parse(await readBody(req) || '{}');
        const key = `${outcome}|${monsterName}`;
        const cached = combatNarrCache.get(key);
        if (cached && Date.now() - cached.at < 60000) return sendJson(res, 200, { line: cached.line, source: cached.source });
        try {
          const view = engine.getPlayerView(auth.playerCanonicalId);
          const narr = await aiCombatNarrative({ outcome, monsterName, playerLevel: view.player?.level, playerHealth: view.player?.current_health, rounds });
          combatNarrCache.set(key, { line: narr.line, at: Date.now(), source: narr.source });
          return sendJson(res, 200, narr);
        } catch (err) {
          return sendJson(res, 200, { line: '一番恶战，尘埃落定。', outcome, source: 'fallback' });
        }
      }
      if (pathname === '/api/game/market_advice' && req.method === 'POST') {
        // AI 市场顾问：结合玩家所在区域供需/天气/事件/资金货舱，给出即时买卖建议
        try {
          const view = engine.getPlayerView(auth.playerCanonicalId);
          const snap = getEconomy().snapshot();
          const cityId = view.player?.current_city_canonical_id;
          const node = (loadContent()?.map_nodes ?? []).find((n) => n.map_node_canonical_id === view.player?.current_map_node_canonical_id);
          const regionSlug = (loadContent()?.market_region?.city_region ?? {})[cityId ?? node?.city_canonical_id];
          const regionName = (loadContent()?.world_regions?.regions ?? {})[regionSlug]?.name;
          const advice = await aiMarketAdvice({
            regionName: regionName ?? '当前区域',
            weather: snap.weather?.[regionName] ?? '晴天',
            supply: snap.regionSupply?.[regionName] ?? {},
            activeEvents: snap.activeEvents?.map((e) => e.name),
            money: view.player?.money,
            holds: Object.values(view.inventory ?? {}).reduce((s, n) => s + n, 0),
            capacity: view.inventory_capacity,
          });
          return sendJson(res, 200, advice);
        } catch (err) {
          return sendJson(res, 200, { advice: '行情瞬息万变，稳妥起见先观望。', region: '当前区域', source: 'fallback' });
        }
      }
    }

    // 静态
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    return serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

const registry = new WorldStateRegistry({ engine, storage });

// ---- AI 玩家（服务器 sidecar + ollama qwen） ----
let aiSimulator = null;
function startAiSimulator() {
  if (aiSimulator) return aiSimulator;
  const gameplay = getRuntime();
  aiSimulator = new AiPlayerSimulator({
    engine, storage,
    catalog: gameplay.catalog,
    runtime: { combat: gameplay.combat, recovery: gameplay.recovery, market: gameplay.market },
    createEventId: (prefix) => `ai.${prefix}.${require('node:crypto').randomUUID().slice(0, 8)}`,
  });
  // 注册固定 AI 船员（首个 tick 前创建其玩家存档，若不存在）
  const aiCrew = [
    { id: 'ai.captain_xu', personality: '豪爽的远东航主', goal: '通过贸易积累巨额财富并称雄各大港埠' },
    { id: 'ai.lady_song', personality: '谨慎的江南女商', goal: '囤积区域特产在跨城套利中获利' },
    { id: 'ai.pirate_black', personality: '狂放的海盗头子', goal: '挑战强敌夺取名声与战利品' },
  ];
  for (const crew of aiCrew) {
    try { engine.createPlayer(crew.id, { reset: false }); } catch { /* 已存在则忽略 */ }
    aiSimulator.registerAiPlayer(crew.id, { personality: crew.personality, goal: crew.goal });
    aiSimulator.players.get(crew.id).online = true;
    registry.registerVirtual(crew.id);
    registry.refresh(crew.id);
  }
  aiSimulator.startTick();
  console.log(`[ZHSH] AI 玩家启动：${aiCrew.map((c) => c.id).join(', ')}`);
  return aiSimulator;
}
attachWebSocket(server, {
  onOpen(conn, { token }) {
    const payload = verifyJwt(token || '');
    if (!payload?.player) { conn.close(); return; }
    conn.player = payload.player;
    registry.connect(payload.player, conn);
    conn.send(JSON.stringify({ type: 'auth_ok', player_canonical_id: payload.player }));
    conn.onmessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try { handleWsMessage(conn, msg); } catch (err) {
        try { conn.send(JSON.stringify({ type: 'error', error: err.message })); } catch {}
      }
    };
  },
  onClose(conn) {
    if (conn.player) {
      registry.disconnect(conn.player, conn);
      registry.broadcast({ type: 'world', kind: 'player_offline', player_canonical_id: conn.player });
    }
  },
});

function handleWsMessage(conn, msg) {
  if (!conn.player) return;
  switch (msg.type) {
    case 'ping':
      conn.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      break;
    case 'refresh':
      registry.refresh(conn.player);
      break;
    case 'world_snapshot':
      conn.send(JSON.stringify({ type: 'world_snapshot', list: registry.onlineList(), online: registry.onlineCount() }));
      break;
    default:
      break;
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[ZHSH] 权威服务器运行于 http://${HOST}:${PORT}`);
  startEconomy();
  startAiSimulator();
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
