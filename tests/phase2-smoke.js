'use strict';
// 阶段2 冒烟验证：market/enhance/pet 三 Runtime
const path = require('node:path');
const fs = require('node:fs');
const { MemoryRuntimeStorage } = require('../src/task-runtime/memory-runtime-storage');
const { createGameplayState } = require('../src/task-runtime/gameplay-state');
const { FormalGameplayCatalog, MarketRuntime, EquipmentEnhanceRuntime, PetRuntime } = require('../src/task-runtime/index.js');

// 加载内容（合并 11 份）
const contentPath = path.join(__dirname, '..', 'web', 'generated', 'task1-content.json');
const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
const contentDir = path.join(__dirname, '..', 'server', 'content');
for (const key of ['world_regions','goods','market_region','discoveries','pets','enhance_rules','game_items','npc_dialogs','questline','characters','sidequests']) {
  const file = { world_regions:'world-regions.json',goods:'goods.json',market_region:'market_region.json',discoveries:'discoveries.json',pets:'pets.json',enhance_rules:'enhance-rules.json',game_items:'items.json',npc_dialogs:'npc-dialogs.json',questline:'questline.json',characters:'characters.json',sidequests:'sidequests.json' }[key];
  content[key] = JSON.parse(fs.readFileSync(path.join(contentDir, file), 'utf8'));
}

const catalog = new FormalGameplayCatalog(content);
const storage = new MemoryRuntimeStorage();
const playerId = 'player.test';
const state = createGameplayState({ canonical_id: playerId, current_city_canonical_id: Object.keys(content.market_region.city_region)[0], current_map_node_canonical_id: 'x', experience: 0, money: 100000 });
state.tasks = {}; state.progress = {}; state.inventory = {}; state.reward_grants = {}; state.flags = {}; state.processed_events = {}; state.unlocked_map_nodes = [];
state.player.canonical_id = playerId;
storage.createPlayer(state);

const market = new MarketRuntime({ storage, catalog });
const pets = new PetRuntime({ storage, catalog });
const enhance = new EquipmentEnhanceRuntime({ storage, catalog });

// --- market ---
const view = market.getMarketView(playerId, 'ev.view');
const cityRegion = view.city_region;
const localGood = view.offers.find((o) => o.is_local);
const remoteGood = view.offers.find((o) => !o.is_local);
console.log('[market] city_region:', cityRegion, '| local good:', localGood?.name, 'price', localGood?.local_price, 'base', localGood?.base_price);
console.log('[market] remote good:', remoteGood?.name, 'price', remoteGood?.local_price, 'base', remoteGood?.base_price);
// 校验 0.75 / 1.25
const expectLocal = Math.max(1, Math.round(localGood.base_price * 0.75));
const expectRemote = Math.max(1, Math.round(remoteGood.base_price * 1.25));
console.log('[market] local factor check:', localGood.local_price === expectLocal ? 'PASS' : 'FAIL');
console.log('[market] remote factor check:', remoteGood.local_price === expectRemote ? 'PASS' : 'FAIL');
// 跨区套利：先在产区城市用 0.75 买入本地特产，再到异区城市卖出（1.25）
const localBuyGood = view.offers.find((o) => o.is_local);
const remoteCityId = Object.keys(content.market_region.city_region).find((cid) => content.market_region.city_region[cid] !== cityRegion);
const buy2 = market.buy(playerId, localBuyGood.canonical_id, 10, 'ev.buy2');
console.log('[market] 产区买入 10x', localBuyGood.name, 'cost:', buy2.total, '(unit', buy2.unit_price + ')');
// 移动到异区城市卖出
const cur = storage.loadPlayer(playerId); cur.player.current_city_canonical_id = remoteCityId; storage.resetPlayer(playerId, cur);
const sell2 = market.sell(playerId, localBuyGood.canonical_id, 10, 'ev.sell2');
console.log('[market] 异区卖出 10x', localBuyGood.name, 'gain:', sell2.total, '(unit', sell2.unit_price + ')');
console.log('[market] 跨区套利利润:', sell2.total - buy2.total, sell2.total > buy2.total ? 'PASS' : 'FAIL');

// --- pet ---
const c1 = pets.capture(playerId, 'pet.月虎', 'ev.c1');
const c2 = pets.capture(playerId, 'pet.麒麟', 'ev.c2');
const c3 = pets.capture(playerId, 'pet.圣龙', 'ev.c3');
console.log('[pet] captured:', c1.owned, c2.owned, c3.owned);
try { pets.capture(playerId, 'pet.暗狼', 'ev.c4'); console.log('[pet] 4th capture: FAIL (应超上限报错)'); }
catch (e) { console.log('[pet] 4th capture limit: PASS ->', e.message); }
const st = storage.loadPlayer(playerId); st.inventory['item.口粮'] = 5; storage.resetPlayer(playerId, st);
const fed = pets.feed(playerId, c3.pet.instance_id, 'ev.feed');
console.log('[pet] feed satiety:', fed.satiety, '| health:', fed.pet.current_health);

// --- enhance ---
// 先装备一把武器
const equipItem = 'entity.equipment.test'; // 可能不存在，用已有 equipment
const eqIds = Object.keys(catalog.equipment) || [];
if (eqIds.length) {
  const eqId = eqIds[0];
  state.inventory = state.inventory || {}; state.inventory[eqId] = 1;
  state.player.money = 100000; state.inventory['item.龙泉水'] = 50;
  storage.resetPlayer(playerId, state);
  const equipRt = new (require('../src/task-runtime/index.js').EquipmentRuntime)({ storage, catalog });
  equipRt.equip(playerId, eqId, 'ev.eq');
  // 连续强化多次
  const results = [];
  for (let i = 0; i < 20; i++) {
    try { results.push(enhance.enhance(playerId, 'weapon', `ev.enh${i}`)); }
    catch (e) { results.push({ err: e.message }); break; }
  }
  const levels = results.filter((r) => r && r.current_level !== undefined).map((r) => r.current_level);
  console.log('[enhance] levels achieved:', levels.join(','));
  console.log('[enhance] max level capped:', Math.max(...levels) <= 15 ? 'PASS' : 'FAIL', 'final:', Math.max(...levels));
} else {
  console.log('[enhance] no equipment in catalog — skip (needs equip)');
}
console.log('\n=== phase 2 smoke done ===');
