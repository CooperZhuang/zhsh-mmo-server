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
const { aiDiscoveryDescription } = require('./ai/ai-discovery-description');
const { memoryDigest, buildWorldContext } = require('./ai/ai-memory');
const { decideChainEvent } = require('./eco/ai-event-chain');
const { aiGenerateWorldSidequest } = require('./ai/ai-quest-gen');
const { aiCrewLine } = require('./ai/ai-crew');

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
    // ---- 世界支线（动态任务）入口 ----
    case 'accept_world_quest': {
      return engine.acceptWorldQuest(playerId, a.task_canonical_id, evId);
    }
    case 'submit_world_quest': {
      return engine.submitWorldQuest(playerId, a.task_canonical_id, evId);
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
const discDescCache = new Map(); // `${discovery}|${region}` -> { description, at, source }（发现物描述缓存）
const taskNarrCache = new Map(); // `${npc}|${task}|${phase}` -> { line, at, source }（任务叙述缓存）
function getEconomy() {
  if (!economy) {
    economy = new WorldEconomy({
      content: loadContent(),
      statePath: path.join(__dirname, 'data', 'economy.json'),
      tickMs: Number(process.env.ZHSH_ECO_TICK_MS || 60000),
      aiEnabled: process.env.ZHSH_ECO_AI !== '0',
      aiDecide: decideEvent,
      aiReport: aiMarketReport,
      aiChain: decideChainEvent,
      onEvent: (event) => {
        // 先广播事件本体，再异步生成 AI 叙述播报补充（不阻塞事件触发）
        registry.broadcast({ type: 'world', kind: 'world_event', event });
        void aiEventNarrative(event).then((narr) => {
          registry.broadcast({ type: 'world', kind: 'world_event_narrative', narrative: narr });
        });
        console.log(`[ECO] 事件触发：${event.name}（${event.region} ${event.effect_kind}+${Number(event.strength).toFixed(2)}，${event.duration} tick）`);
        // 世界驱动支线：事件触发出现在世界的变化，由此涌现一条因果相关的动态支线
        spawnWorldSidequest(event);
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
  // 定期清理已消退事件对应的世界驱动支线（生命周期随世界发展）
  setInterval(() => pruneWorldSidequests(), Math.max(30000, eco.tickMs * 2)).unref?.();
}

// ---- 世界驱动支线：事件 → 因果支线（随事件涌现、随事件消退清理） ----
const worldSidequestBindings = new Map(); // `${eventKey}` -> taskCanonicalId（用于避免重复生成与清理）
const spawnedEventKeys = new Set(); // 已生成过绑定支线的事件 key（每事件仅一次）

/** 依据触发的事件，生成一条因果绑定的动态支线并注册进任务链（async，AI 失败静默）。 */
async function spawnWorldSidequest(event) {
  if (!event?.name) return null;
  const regionSlug = event.region || 'region.mediterranean';
  const eventKey = `${event.name}|${regionSlug}`;
  if (spawnedEventKeys.has(eventKey)) return null; // 每个事件只衍生一条支线
  spawnedEventKeys.add(eventKey);
  try {
    const content = loadContent();
    const region = (content.world_regions?.regions ?? {})[regionSlug]?.name ?? event.region ?? '未知海域';
    const npcs = (Array.isArray(content.characters) ? content.characters : Object.values(content.characters ?? {}))
      .filter((c) => c.region === regionSlug).map((c) => c.name);
    // 世界近期大事（事件日志）作为 AI 上下文
    const worldLog = getEconomy().snapshot().activeEvents?.slice(0, 3).map((e) => `${e.name}(${e.region})`).join('、') || event.name;
    const task = await aiGenerateWorldSidequest(event, {
      region, regionId: regionSlug, npcs, memorySummary: `世界近期：${worldLog}`,
    });
    if (!task || !task.canonical_id) return null;
    // 回填 issuer/completion NPC 与地点（绑定到事件区域）
    task.issuer_npc_canonical_id = task.issuer_npc_canonical_id ?? null;
    task.completion_npc_canonical_id = task.completion_npc_canonical_id ?? null;
    task.receive_location_canonical_id = task.receive_location_canonical_id ?? null;
    task.submit_location_canonical_id = task.submit_location_canonical_id ?? null;
    task.target_location_canonical_id = task.receive_location_canonical_id;
    task.display_name ??= task.name ?? task.source_label ?? '世界支线';
    const registered = engine.registerDynamicTask(task);
    if (registered) worldSidequestBindings.set(eventKey, task.canonical_id);
    console.log(`[ZHSH] 世界支线涌现：${task.display_name}（${region}，事件「${event.name}」）${registered ? '' : '（已在册或无法注册）'}`);
    return task;
  } catch (err) {
    console.log(`[ZHSH] 世界支线生成失败（${event.name}）：${err.message}`);
    return null;
  }
}

/** 清理：从经济引擎 snapshot 判断哪些事件已消退，移除对应未接取支线。 */
function pruneWorldSidequests() {
  try {
    const snap = getEconomy().snapshot();
    const aliveKeys = new Set((snap.activeEvents ?? []).map((e) => `${e.name}|${e.region}`));
    for (const [eventKey, taskId] of worldSidequestBindings) {
      if (aliveKeys.has(eventKey)) continue;
      // 事件已消退：移除对应动态支线（若玩家未接取）。接取过的保留（task-engine 含生效状态）。
      if (engine?.unregisterDynamicTask) engine.unregisterDynamicTask(taskId);
      worldSidequestBindings.delete(eventKey);
    }
  } catch {}
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
    // ---- 超管测试控制台（本地开发/测试：改玩家 state + 手工触发世界动态） ----
    if (pathname.startsWith('/api/admin')) {
      if (!auth) return sendJson(res, 401, { error: '未登录或登录已过期' });
      const pid = auth.playerCanonicalId;
      const mut = async (mutator) => {
        if (!engine.storage?.transact) throw new Error('admin storage unavailable');
        return engine.storage.transact(pid, (state) => { const r = mutator(state); state.player.updated_at = new Date().toISOString(); return r; });
      };
      if (pathname === '/api/admin/set_level' && req.method === 'POST') {
        const { level } = JSON.parse(await readBody(req) || '{}');
        const thresholds = require(path.join(ROOT, 'data', 'runtime', 'level-experience.json')).thresholds;
        const target = Math.max(1, Math.min(Number(level) || 1, thresholds.length - 1));
        await mut((state) => { state.player.experience = Number(thresholds[target - 1]); });
        return sendJson(res, 200, { applied: true, level: target });
      }
      if (pathname === '/api/admin/set_exp' && req.method === 'POST') {
        const { exp } = JSON.parse(await readBody(req) || '{}');
        await mut((state) => { state.player.experience = Math.max(0, Number(exp) || 0); });
        return sendJson(res, 200, { applied: true });
      }
      if (pathname === '/api/admin/set_money' && req.method === 'POST') {
        const { money } = JSON.parse(await readBody(req) || '{}');
        await mut((state) => { state.player.money = Math.max(0, Number(money) || 0); });
        return sendJson(res, 200, { applied: true });
      }
      if (pathname === '/api/admin/set_health' && req.method === 'POST') {
        const { health } = JSON.parse(await readBody(req) || '{}');
        await mut((state) => { state.player.current_health = Math.max(0, Math.min(Number(health) || 0, Number(state.player.max_health) || 1)); });
        return sendJson(res, 200, { applied: true });
      }
      if (pathname === '/api/admin/add_item' && req.method === 'POST') {
        const { item_canonical_id, quantity } = JSON.parse(await readBody(req) || '{}');
        if (!item_canonical_id) return sendJson(res, 400, { error: 'item required' });
        await mut((state) => { state.inventory[item_canonical_id] = (state.inventory[item_canonical_id] ?? 0) + Math.max(1, Number(quantity) || 1); });
        return sendJson(res, 200, { applied: true });
      }
      if (pathname === '/api/admin/remove_item' && req.method === 'POST') {
        const { item_canonical_id, quantity } = JSON.parse(await readBody(req) || '{}');
        await mut((state) => { state.inventory[item_canonical_id] = Math.max(0, (state.inventory[item_canonical_id] ?? 0) - Math.max(1, Number(quantity) || 1)); if (!state.inventory[item_canonical_id]) delete state.inventory[item_canonical_id]; });
        return sendJson(res, 200, { applied: true });
      }
      if (pathname === '/api/admin/unlock_tasks' && req.method === 'POST') {
        await mut((state) => { for (const [id, task] of Object.entries(state.tasks ?? {})) { if (task.block_reasons?.length) continue; task.status = 'available'; task.reward_status = 'not_granted'; task.current_step = 0; } });
        return sendJson(res, 200, { applied: true });
      }
      if (pathname === '/api/admin/complete_tasks' && req.method === 'POST') {
        await mut((state) => { for (const task of Object.values(state.tasks ?? {})) { task.status = 'completed'; task.reward_status = 'granted'; task.current_step = task.current_step ?? 0; } });
        return sendJson(res, 200, { applied: true });
      }
      if (pathname === '/api/admin/reset_player' && req.method === 'POST') {
        // 重置当前玩家角色进度（服务器权威：createPlayer reset 重建 state）
        const created = engine.createPlayer(pid, { reset: true });
        return sendJson(res, 200, { applied: true, player: created.player?.canonical_id || pid });
      }
      if (pathname === '/api/admin/trigger_world_event' && req.method === 'POST') {
        // 手工触发世界经济事件 → 走 onEvent → 涌现世界驱动支线（超管测试）
        const body = JSON.parse(await readBody(req) || '{}');
        const event = await getEconomy().spawnEvent({ name: body.name || '风暴降临', region: body.region, effect_kind: body.effect_kind || 'supply', target_field: body.target_field || 'food', strength: Number(body.strength ?? 0.15), duration: Number(body.duration ?? 6), tip: body.tip || '' });
        return sendJson(res, 200, { applied: true, event: { name: event.name, region: event.region, effect_kind: event.effect_kind, duration: event.duration } });
      }
      if (pathname === '/api/admin/current_world' && req.method === 'GET') {
        const snap = getEconomy().snapshot();
        return sendJson(res, 200, {
          tick: snap.tick_count,
          activeEvents: (snap.activeEvents ?? []).map((e) => ({ name: e.name, region: e.region, remaining: e.remaining, duration: e.duration })),
          weather: snap.weather ?? {},
          regionSupply: snap.regionSupply ?? {},
          tradeCount: snap.tradeCount ?? 0,
          tradeLog: snap.tradeLog ?? [],
          diag: { marketEconomy: typeof getRuntime().market?.economy, economy: typeof getEconomy(), aiChain: typeof getEconomy().aiChain },
        });
      }
      return sendJson(res, 404, { error: `no admin endpoint ${pathname}` });
    }
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
      if (pathname === '/api/game/crew_line' && req.method === 'POST') {
        // AI 船员发言：贴合性格/忠诚度/世界动态（玩家侧感知船员人格）
        const { instance_id: instanceId } = JSON.parse(await readBody(req) || '{}');
        try {
          const state = engine.loadPlayer(auth.playerCanonicalId);
          const crew = (state.player?.crew ?? []).find((c) => c.instance_id === instanceId) || (state.player?.crew ?? [])[0];
          if (!crew) return sendJson(res, 200, { line: '（无船员随行）', crew: null, source: 'fallback' });
          const weatherSnapshot = getEconomy().snapshot();
          const world = buildWorldContext(weatherSnapshot);
          const line = await aiCrewLine({
            crewName: crew.name ?? '船员',
            personality: crew.personality ?? '忠诚的船员',
            loyalty: crew.loyalty ?? 60,
            mood: '正在海上航行',
            worldContext: `${world.事件}，${world.天气}`,
          });
          return sendJson(res, 200, line);
        } catch (err) {
          return sendJson(res, 200, { line: `船员：${err.message}`, crew: null, source: 'fallback' });
        }
      }
      if (pathname === '/api/game/world_quests' && req.method === 'GET') {
        // 只读：当前世界驱动生成的活跃支线（随世界事件涌现，事件消退后清理）
        const tasks = Array.isArray(engine.listTasks()) ? engine.listTasks().filter((t) => t.ai_generated) : [];
        const state = engine.loadPlayer(auth.playerCanonicalId);
        return sendJson(res, 200, {
          quests: tasks.map((t) => ({
            canonical_id: t.canonical_id, display_name: t.display_name,
            description: t.description, bound_event: t.bound_event, bound_region: t.bound_region,
            targets: (t.targets ?? []).map((tg) => ({ target_kind: tg.target_kind, required_quantity: tg.required_quantity ?? 1 })),
            runtime: engine.getTaskRuntime(state, t.canonical_id) ?? null,
          })),
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
          const state = engine.loadPlayer(auth.playerCanonicalId);
          const charInfo = (Array.isArray(loadContent().characters) ? loadContent().characters : Object.values(loadContent().characters || {})).find((c) => c.name === name);
          const banter = await aiNpcBanter({
            npcName: name,
            npcRole: charInfo?.role,
            personality: charInfo?.personality,
            dialogueHook: charInfo?.dialogue_hook,
            taskHint: view.task_chain?.find((t) => ['accepted','in_progress','completable'].includes(t.runtime?.status))?.definition?.display_name ?? null,
            playerTitle: view.player?.title,
            playerLevel: view.player?.level,
            weather: (Object.values(weatherSnapshot.weather ?? {}))[0] ?? null,
            activeEvents: (weatherSnapshot.activeEvents ?? []).map((e) => e.name),
            memorySummary: memoryDigest(state, { npcId: name, query: name }),
            worldContext: buildWorldContext(weatherSnapshot),
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
      if (pathname === '/api/game/discovery_description' && req.method === 'POST') {
        // AI 发现物叙事：玩家发现某发现物时生成探索描述（短时缓存）
        const { discovery_name: discoveryName, region } = JSON.parse(await readBody(req) || '{}');
        const key = `${discoveryName}|${region}`;
        const cached = discDescCache.get(key);
        if (cached && Date.now() - cached.at < 120000) return sendJson(res, 200, { description: cached.description, source: cached.source });
        try {
          const view = engine.getPlayerView(auth.playerCanonicalId);
          const desc = await aiDiscoveryDescription({
            discoveryName: discoveryName || '神秘之物', region: region || '未知海域',
            playerLevel: view.player?.level, playerTitle: view.player?.title,
            discoveredCount: Object.keys(view.discoveries_found ?? {}).length,
          });
          discDescCache.set(key, { description: desc.description, at: Date.now(), source: desc.source });
          return sendJson(res, 200, desc);
        } catch (err) {
          return sendJson(res, 200, { description: `迷雾深处，${discoveryName || '它'}静候有缘人。`, source: 'fallback' });
        }
      }
      if (pathname === '/api/game/task_narrative' && req.method === 'POST') {
        // AI 任务情境叙述：接取/提交任务时生成一句NPC鼓励/赞许
        const { npc_name: npcName, task_name: taskName, phase } = JSON.parse(await readBody(req) || '{}');
        const key = `${npcName}|${taskName}|${phase}`;
        const cached = taskNarrCache.get(key);
        if (cached && Date.now() - cached.at < 60000) return sendJson(res, 200, { line: cached.line, source: cached.source });
        try {
          const view = engine.getPlayerView(auth.playerCanonicalId);
          const narr = await aiTaskNarrative({ npcName: npcName || 'NPC', taskName: taskName || '一项委托', phase: phase === '接受' ? '接受' : '提交', playerTitle: view.player?.title, playerLevel: view.player?.level });
          taskNarrCache.set(key, { line: narr.line, at: Date.now(), source: narr.source });
          return sendJson(res, 200, narr);
        } catch (err) {
          return sendJson(res, 200, { line: `${npcName || 'NPC'}：这事就拜托你了。`, source: 'fallback' });
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
    { id: 'ai.lady_song', personality: '谨慎的江南女商', goal: '囤积区域特产在跨城套利中获利', role: 'merchant' },
    { id: 'ai.pirate_black', personality: '狂放的海盗头子', goal: '挑战强敌夺取名声与战利品' },
  ];
  for (const crew of aiCrew) {
    try { engine.createPlayer(crew.id, { reset: false }); } catch { /* 已存在则忽略 */ }
    // 商人启动资金：无本金无法交易 → 无法通过贸易影响世界。给商人 seed 资本。
    if (crew.role === 'merchant') {
      try {
        engine.storage.transact(crew.id, (state) => { if (Number(state.player.money ?? 0) < 1000) state.player.money = 5000; });
      } catch {}
    }
    aiSimulator.registerAiPlayer(crew.id, { personality: crew.personality, goal: crew.goal, role: crew.role ?? 'adventurer' });
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
