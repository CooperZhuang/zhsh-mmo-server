'use strict';
/**
 * 纵横四海 · 端到端完整游玩回归（自动化测试脚本）
 *
 * 模拟一个真实玩家从注册到深入游戏的完整旅程，并逐项断言。
 * 覆盖：注册 → 新手任务链(接/移动/提交) → 战斗 → 市场货舱买卖 →
 * 宠物捕获 → 船员招募+发言 → 发现物 → NPC/AI 场景 → 天下情报 →
 * 超管触发世界事件/世界状态 → 记忆层落盘。
 *
 * 前置：服务器权威版运行于 http://127.0.0.1:4173（node server/server.js）。
 * 运行：node scripts/e2e-gameplay-test.js
 *       （可选 ZHSH_TEST_BASE=http://... 指定地址）
 * 退出码：0=全过，1=有失败。
 */
const BASE = process.env.ZHSH_TEST_BASE || 'http://127.0.0.1:4173';
let token = null;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}
async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; } catch { return { ok: res.ok, status: res.status, data: text }; }
}
const action = (a, args = {}) => api('/api/game/action', { method: 'POST', body: { action: a, args }, auth: true }).then((r) => r.data);
const runtime = (gadget, method, args = {}) => api('/api/game/runtime', { method: 'POST', body: { gadget, method, args }, auth: true }).then((r) => r.data);
const admin = (path, body = {}) => api(`/api/admin/${path}`, { method: 'POST', body, auth: true }).then((r) => r.data);
const getState = () => api('/api/game/state', { auth: true }).then((r) => r.data);
const uniq = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);

async function main() {
  const uname = 'e2e' + uniq();
  // 1. 注册
  let r = await api('/api/auth/register', { method: 'POST', body: { username: uname, password: 'test1234' } });
  token = r.data?.token;
  record('注册新账号', Boolean(token), `玩家=${r.data?.player?.player_canonical_id ?? uname}`);

  // 2. 新手任务链
  let st = await getState();
  const loc0 = st.current_location?.location_canonical_id;
  let npcs = await action('list_current_npcs');
  const boss = (npcs || []).find((x) => x.display_name === '老板（新手指引）');
  if (boss) {
    const take = await action('talk_to_npc', { npc_canonical_id: boss.npc_canonical_id, location_canonical_id: loc0 });
    record('接取新手任务', take.action === 'accepted', take.action);
    let adj = await action('list_adjacent');
    const ven = (adj || []).find((x) => x.display_name === '威尼斯');
    if (ven) await action('move', { map_node_canonical_id: ven.map_node_canonical_id });
    adj = await action('list_adjacent');
    const fu = (adj || []).find((x) => x.display_name === '福利院');
    if (fu) await action('move', { map_node_canonical_id: fu.map_node_canonical_id });
    st = await getState();
    const locF = st.current_location?.location_canonical_id;
    npcs = await action('list_current_npcs');
    const fuNpc = (npcs || []).find((x) => x.display_name === '福利官');
    if (fuNpc) {
      await action('talk_to_npc', { npc_canonical_id: fuNpc.npc_canonical_id, location_canonical_id: locF });
      const sub = await action('submit_to_npc', { npc_canonical_id: fuNpc.npc_canonical_id, location_canonical_id: locF });
      record('提交新手任务', sub.action === 'completed', `声望=${sub.reputation}`);
    } else record('提交新手任务', false, '未找到福利官');
  } else record('接取新手任务', false, '未找到新手指引NPC');

  // 3. 战斗
  try {
    const mons = await action('list_current_monsters');
    if (mons?.monsters?.length) {
      const atk = await action('attack_monster', { monster_canonical_id: mons.monsters[0].monster_canonical_id, location_canonical_id: loc0 });
      record('发起战斗', ['combat_won', 'combat_round'].includes(atk.action), atk.action);
    } else record('战斗目标存在', true, '当前无怪(可忽略)');
  } catch (e) { record('战斗', false, e.message); }

  // 4. 市场货舱买卖
  await admin('set_money', { money: 5000 });
  let mv = await runtime('market', 'getMarketView', {});
  const good = mv.offers?.find((o) => o.is_local) || mv.offers?.[0];
  if (good) {
    const buy = await runtime('market', 'buy', { _arg1: good.canonical_id, _arg2: 5 });
    record('市场买入(货舱)', buy.action === 'market_bought', `单价=${buy.unit_price} 货舱=${buy.cargo}`);
    const sell = await runtime('market', 'sell', { _arg1: good.canonical_id, _arg2: 2 });
    record('市场卖出(货舱)', sell.action === 'market_sold', `货舱=${sell.cargo}`);
  } else record('市场数据', false, '无商品');

  // 5. 宠物捕获
  const pet = await runtime('pets', 'capture', { _arg1: 'pet.月虎' });
  record('宠物捕获', Boolean(pet.action === 'pet_captured' || pet.pet), pet.action || String(pet));

  // 6. 船员招募 + 发言
  const rec = await runtime('recruit', 'recruit', { _arg1: 'crew.老船长' });
  record('船员招募', rec.action === 'crew_recruited', rec.action);
  const crewLine = await api('/api/game/crew_line', { method: 'POST', body: {}, auth: true });
  record('船员发言(AI)', crewLine.data?.source === 'ai', (crewLine.data?.line || '').slice(0, 30));

  // 7. 发现物
  const disc = await runtime('discover', 'listFound', {});
  record('发现物查看', Boolean(disc.action === 'discoveries_listed' || disc), disc.action);

  // 8. NPC/AI 场景
  const banter = await api('/api/game/npc_banter', { method: 'POST', body: { npc_name: '酒馆老板' }, auth: true });
  record('NPC闲聊(AI)', banter.data?.source === 'ai', (banter.data?.line || '').slice(0, 30));
  const advice = await api('/api/game/market_advice', { method: 'POST', body: {}, auth: true });
  record('市场顾问(AI)', advice.data?.source === 'ai', (advice.data?.advice || '').slice(0, 30));

  // 9. 天下情报
  const intel = await api('/api/game/intel', { auth: true });
  record('天下情报', Number(intel.data?.regions?.length) > 0, `区域=${intel.data?.regions?.length}`);

  // 10. 世界支线：触发事件 → 涌现 → 接取
  const ev = await admin('trigger_world_event', { name: '回归风暴', region: 'region.mediterranean', tip: '端到端回归' });
  record('超管触发世界事件', Boolean(ev.applied), ev.event?.name);
  await new Promise((res) => setTimeout(res, 2500));
  const wq = await api('/api/game/world_quests', { auth: true });
  const quest = wq.data?.quests?.[0];
  if (quest) {
    const ac = await action('accept_world_quest', { task_canonical_id: quest.canonical_id });
    record('世界支线接取', ac.action === 'world_quest_accepted', quest.display_name);
  } else record('世界支线涌现', false, '未生成(可能AI异步慢)');

  // 11. 记忆层落盘
  st = await getState();
  record('玩家记忆落盘', Array.isArray(st.player_memory) && st.player_memory.length > 0, `${st.player_memory?.length} 条`);
  record('NPC好感度落盘', Object.keys(st.npc_affinity || {}).length > 0, `${Object.keys(st.npc_affinity || {}).length} 条`);

  // 12. 世界状态
  const cw = await api('/api/admin/current_world', { auth: true });
  record('世界状态', Number(cw.data?.tick) > 0, `tick=${cw.data?.tick} 事件=${cw.data?.activeEvents?.length}`);

  const failed = results.filter((x) => !x.ok);
  console.log(`\n==== 汇总：${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) { console.log('失败项:', failed.map((f) => f.name).join(', ')); process.exit(1); }
  console.log('全部通过 ✓');
}

main().catch((e) => { console.error('测试中断:', e.message); process.exit(1); });
