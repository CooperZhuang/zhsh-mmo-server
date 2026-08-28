import { BrowserRuntimeStorage,BrowserTaskCatalog,CombatRuntime,NpcDuelRuntime,DivingRuntime,DropRuntime,DungeonRuntime,EconomyRuntime,EquipmentRuntime,FishingRuntime,FormalGameplayCatalog,ItemRuntime,MaritimeRuntime,RecoveryRuntime,ShipRuntime,TaskRuntimeEngine,UiFeedback,VoyageRuntime,buildCityMapEntries,effectiveStats,applyExperienceProgression,LEVEL_THRESHOLDS } from './generated/task-runtime-browser.js';

const captureMode = new URLSearchParams(location.search).get('uat') === 'capture';
const PLAYER_ID = captureMode ? 'player.browser.task1.uat-capture' : 'player.browser.task1';
const app = document.querySelector('#app');
const saveStatus = document.querySelector('#save-status');
const importInput = document.querySelector('#save-import');
const debugEnabled = new URLSearchParams(location.search).get('dev') === '1';
const adminEnabled = new URLSearchParams(location.search).get('admin') === '1';
let content,visuals,catalog,storage,engine,gameplayCatalog,combat,npcDuel,diving,drops,dungeon,economy,equipment,fishing,items,maritime,recovery,ships,voyage;
let combatRandom=Math.random;
const feedback = new UiFeedback();
let gameEntered = false;
let page = { name:'start' };

app.addEventListener('click',(event) => {
  const button = event.target.closest?.('[data-page]');
  if (!button || !app.contains(button)) return;
  showPage(button.dataset.page,{
    ...(button.getAttribute('data-npc-id') ? { npcId:button.getAttribute('data-npc-id'),npcName:button.getAttribute('data-npc-name') } : {}),
    ...(button.getAttribute('data-task-id') ? { taskId:button.getAttribute('data-task-id') } : {}),
    ...(button.getAttribute('data-item-id') ? { itemId:button.getAttribute('data-item-id') } : {}),
  });
});

bootstrap().catch(showFatal);

async function bootstrap() {
  content = await fetch('./generated/task1-content.json',{ cache:'no-store' }).then((response) => {
    if (!response.ok) throw new Error(`内容包读取失败：${response.status}`);
    return response.json();
  });
  visuals = await fetch('./generated/authoritative-assets.json',{ cache:'no-store' }).then((response) => {
    if (!response.ok) throw new Error(`权威美术索引读取失败：${response.status}`);
    return response.json();
  });
  catalog = new BrowserTaskCatalog(content);
  storage = new BrowserRuntimeStorage();
  await storage.ready();
  engine = new TaskRuntimeEngine({ catalog,storage,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id) });
  if (storage.hasPlayer(PLAYER_ID)) engine.synchronizeDefinitions(PLAYER_ID);
  gameplayCatalog = new FormalGameplayCatalog(content);
  const uatDropRandom=globalThis.__ZHSH_UAT_DROP_RANDOM__;
  drops = new DropRuntime({ storage,catalog:gameplayCatalog,taskEngine:engine,...(typeof uatDropRandom==='function'?{random:uatDropRandom}:{}) });
  combat = new CombatRuntime({ storage,catalog:gameplayCatalog,taskEngine:engine,dropRuntime:drops,random:()=>combatRandom() });
  npcDuel = new NpcDuelRuntime({ storage,taskCatalog:catalog,gameplayCatalog,taskEngine:engine,random:()=>combatRandom() });
  dungeon = new DungeonRuntime({ storage,catalog:gameplayCatalog });
  const uatDivingRandom=globalThis.__ZHSH_UAT_DIVING_RANDOM__;
  diving = new DivingRuntime({ storage,catalog:gameplayCatalog,...(typeof uatDivingRandom==='function'?{random:uatDivingRandom}:{}) });
  economy = new EconomyRuntime({ storage,catalog:gameplayCatalog,taskEngine:engine });
  equipment = new EquipmentRuntime({ storage,catalog:gameplayCatalog });
  const uatFishingRandom=globalThis.__ZHSH_UAT_FISHING_RANDOM__;
  fishing = new FishingRuntime({ storage,catalog:gameplayCatalog,taskEngine:engine,...(typeof uatFishingRandom==='function'?{random:uatFishingRandom}:{}) });
  items = new ItemRuntime({ storage,catalog:gameplayCatalog });
  const uatMaritimeRandom=globalThis.__ZHSH_UAT_MARITIME_RANDOM__;
  maritime = new MaritimeRuntime({ storage,catalog:gameplayCatalog,...(typeof uatMaritimeRandom==='function'?{random:uatMaritimeRandom}:{}) });
  recovery = new RecoveryRuntime({ storage,catalog:gameplayCatalog });
  ships = new ShipRuntime({ storage,catalog:gameplayCatalog });
  voyage = new VoyageRuntime({ storage,catalog:gameplayCatalog,taskEngine:engine,maritimeRuntime:maritime });
  saveStatus.textContent = storage.corruptRecords.has(PLAYER_ID) ? '检测到损坏存档，可重置或导入备份' : '存档已读取';
  renderStart();
  if (debugEnabled) exposeDebugSurface();
}

function render() {
  if (!storage.hasPlayer(PLAYER_ID) || !gameEntered || page.name === 'start') { renderStart();return; }
  const renderers = {
    location:renderLocationPage,map:renderMapPage,world:renderWorldPage,npc:renderNpcPage,tasks:renderTaskListPage,task:renderTaskDetailPage,
    backpack:renderBackpackPage,item:renderItemDetailPage,encounter:renderFormalEncounterPage,shop:renderFormalShopPage,voyage:renderFormalVoyagePage,status:renderStatusPage,save:renderSavePage,compendium:renderCompendiumPage,admin:renderAdminPage,
  };
  try { (renderers[page.name] ?? renderLocationPage)(); }
  catch (error) { showFatal(error); }
}

function showPage(name,params = {}) {
  if(name==='compendium'&&!debugEnabled)name='location';
  if(name==='admin'&&!adminEnabled)name='location';
  page = { name,...params };
  render();
  window.scrollTo?.(0,0);
}

function renderStart() {
  page = { name:'start' };
  document.body.dataset.page = 'start';
  const corrupt = storage.corruptRecords.get(PLAYER_ID);
  const hasSave = storage.hasPlayer(PLAYER_ID);
  const { error:lastError } = feedback.snapshot();
  app.innerHTML = `<section class="wap-page start-page">
    <div class="start-visual" role="img" aria-label="威尼斯港口">
      ${renderNamedVisual('威尼斯港口','start-art')}
    </div>
    <h1 class="start-logo">纵横四海</h1>
    <p class="start-lead">梦想的驱动，财富的蛊惑，帮会的火拼，刻骨铭心的生存危机，一串串的曲折离奇，一场场的霸者之征……</p>
    ${corrupt ? `<p class="error">存档损坏：${escapeHtml(corrupt)}</p>` : ''}
    ${lastError ? `<p class="error">${escapeHtml(lastError)}</p>` : ''}
    <p>${hasSave ? '<button class="text-link" data-action="continue-game">继续冒险之旅</button>' : '<button class="text-link" data-action="new-game">启动冒险之旅</button>'}</p>
    ${hasSave ? '<p><button class="text-link" data-action="new-game">重新开始</button></p>' : ''}
    <p><button class="text-link" data-action="import-save">导入存档</button></p>
  </section>`;
  bindCommonActions();
}

function renderLocationPage() {
  document.body.dataset.page = 'location';
  const view = engine.getPlayerView(PLAYER_ID);
  const adjacent = engine.listAdjacentLocations(PLAYER_ID);
  const npcs = engine.listCurrentNpcs(PLAYER_ID);
  const encounterActions = listFormalEncounterActions(view);
  const journeys = listFormalVoyages(view);
  const recoveryServices = gameplayCatalog.listRecoveryServicesAt(view.player.current_map_node_canonical_id);
  const shopEntries = content.shop_entries.filter((entry)=>entry.map_node_canonical_id===view.player.current_map_node_canonical_id);
  const dungeonEntries=gameplayCatalog.listDungeonsAtMapNode(view.player.current_map_node_canonical_id);
  const locationName = view.current_location?.display_name ?? '未知地点';
  const cityName = cityDisplayName(view.current_location?.city_canonical_id);
  const locationVisual=visualForLocation(locationName,cityName);
  const unfinished = view.task_chain.filter((entry) => !['locked','completed'].includes(entry.runtime.status));
  const { message:lastMessage,error:lastError } = feedback.snapshot();
  app.innerHTML = `<section class="wap-page">
    <p><strong>${escapeHtml(cityName)} - <span class="current-location">${escapeHtml(locationName)}</span></strong>
      <button class="text-link" data-action="refresh">刷新</button>
      <button class="text-link" data-page="tasks">任务(${unfinished.length})</button></p>
    ${locationVisual?renderAsset(locationVisual,'scene-art'):''}
    ${renderFeedback()}
    <p>你看到：</p>
    ${npcs.length ? `<div class="line-list">${npcs.map((npc) => `<p class="asset-row">${renderCanonicalVisual(npc.npc_canonical_id,'item-icon')}<button class="text-link" data-page="npc" data-npc-id="${attr(npc.npc_canonical_id)}" data-npc-name="${attr(npc.display_name)}">${escapeHtml(npc.display_name)}</button></p>`).join('')}</div>` : '<p>这里没有与当前任务有关的人物。</p>'}
    <p>请选择出口：</p>
    ${adjacent.length ? `<div class="inline-links">${adjacent.map((node) => `<button class="text-link" data-move="${attr(node.map_node_canonical_id)}">${escapeHtml(node.display_name)}</button>`).join(' ')}</div>` : '<p>这里没有可用出口。</p>'}
    <p>【<button class="text-link" data-page="map">城内地图</button>】${locationName==='码头'?'　【<button class="text-link" data-page="world">世界地图</button>】':''}</p>
    <p>${escapeHtml(view.current_location?.description ?? '')}</p>
    ${encounterActions.length ? '<p>【<button class="text-link" data-page="encounter" data-encounter-kind="location">此处行动</button>】</p>' : ''}
    ${view.dungeon ? '<p>【<button class="text-link" data-page="encounter" data-encounter-kind="dungeon">副本内部</button>】</p>' : dungeonEntries.map((entry)=>`<p>【<button class="text-link" data-dungeon-enter="${attr(entry.canonical_id)}">进入${escapeHtml(entry.display_name)}</button>】（${entry.minimum_level}-${entry.maximum_level}级）</p>`).join('')}
    ${journeys.length ? '<p>【<button class="text-link" data-page="voyage">出航</button>】</p>' : ''}
    ${shopEntries.length ? '<p>【<button class="text-link" data-page="shop">商店</button>】</p>' : ''}
    ${recoveryServices.map((service)=>`<p>【<button class="text-link" data-recovery="${attr(service.canonical_id)}">向神父祈祷恢复体力</button>】</p>`).join('')}
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();bindFormalPageActions();
}

function renderMapPage() {
  document.body.dataset.page = 'map';
  const view = engine.getPlayerView(PLAYER_ID);
  const adjacent = engine.listAdjacentLocations(PLAYER_ID);
  const mapEntries = buildCityMapEntries(content,view.current_location,adjacent);
  const cityName = cityDisplayName(view.current_location?.city_canonical_id);
  app.innerHTML = `<section class="wap-page">
    <p><strong>${escapeHtml(cityName)}城内地图：</strong></p>
    ${renderFeedback()}
    <div class="map-overview">${mapEntries.map((entry) => entry.is_current
      ? `<p><strong>★ ${escapeHtml(entry.display_name)}（当前位置）</strong></p>`
      : entry.can_move
        ? `<p>→ <button class="text-link" data-move="${attr(entry.map_node_canonical_id)}">${escapeHtml(entry.display_name)}</button></p>`
        : `<p>· ${escapeHtml(entry.display_name)}</p>`).join('')}</div>
    <p>带箭头的地点可以直接前往。</p>
    <p><button class="text-link" data-page="location">返回</button></p>
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();
}

function renderWorldPage() {
  document.body.dataset.page='world';
  const view=engine.getPlayerView(PLAYER_ID);
  if(view.current_location?.display_name!=='码头'){showPage('location');return;}
  const ports=content.map_nodes.filter((entry)=>entry.location_canonical_id&&entry.display_name==='码头'&&entry.city_canonical_id!==view.current_location.city_canonical_id)
    .map((entry)=>({...entry,city_name:cityDisplayName(entry.city_canonical_id)})).sort((a,b)=>a.city_name.localeCompare(b.city_name,'zh-CN'));
  app.innerHTML=`<section class="wap-page">
    <p><strong>世界地图：</strong></p>
    ${renderFeedback()}
    <p>当前港口：${escapeHtml(cityDisplayName(view.current_location.city_canonical_id))}</p>
    <div class="line-list">${ports.map((entry)=>`<p>→ <button class="text-link" data-city-port="${attr(entry.map_node_canonical_id)}">${escapeHtml(entry.city_name)}码头</button></p>`).join('')}</div>
    <p>选择目的地后将从当前码头出发。</p>
    <p><button class="text-link" data-page="location">返回</button></p>
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();
}

function renderNpcPage() {
  document.body.dataset.page = 'npc';
  const view = engine.getPlayerView(PLAYER_ID);
  const npcCanonicalId = page.npcId;
  if (!npcCanonicalId) { showPage('location');return; }
  const npcDisplayName = page.npcName || '当前人物';
  const related = view.task_chain.filter((entry) => isNpcRelated(entry,npcCanonicalId,view.current_location?.location_canonical_id));
  const actionable = related.find((entry) => ['available','completable'].includes(entry.runtime.status))
    ?? related.find((entry) => ['accepted','in_progress'].includes(entry.runtime.status));
  const actionLabel = actionable?.runtime.status === 'available' ? '接受任务'
    : actionable?.runtime.status === 'completable' ? '提交任务' : '交谈';
  const { message:lastMessage,error:lastError } = feedback.snapshot();
  app.innerHTML = `<section class="wap-page">
    <p><strong>${escapeHtml(npcDisplayName)}${related.length ? '的任务' : ''}</strong></p>
    ${renderCanonicalVisual(npcCanonicalId,'portrait-art')}
    ${renderFeedback()}
    ${related.length ? related.map((entry) => renderNpcTask(entry)).join('') : '<p>对方现在没有任务要交给你。</p>'}
    <p><button class="text-link" data-npc-action="${attr(npcCanonicalId)}">${actionLabel}</button></p>
    <p><button class="text-link" data-page="location">返回</button></p>
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();
}

function renderNpcTask(entry) {
  const task = entry.definition;
  const phase = entry.runtime.status === 'completable' ? 'submit' : 'receive';
  const dialogue = task.dialogues.filter((line) => line.phase === phase).map((line) => line.original_text);
  return `<section class="task-flow"><p>【<button class="text-link" data-page="task" data-task-id="${attr(task.canonical_id)}">${escapeHtml(task.display_name)}</button>】</p>
    ${dialogue.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
    <p>任务：${escapeHtml(task.description)}</p>
    <p>任务奖励：${renderRewardsText(task)}</p>
    <p class="progress-text">当前进度：${renderProgressText(entry)}</p></section>`;
}

function renderTaskListPage() {
  document.body.dataset.page = 'tasks';
  const view = engine.getPlayerView(PLAYER_ID);
  const visible = view.task_chain.filter((entry) => entry.runtime.status !== 'locked');
  const activeSeries=content.series.find((entry)=>entry.canonical_id===view.active_series_canonical_id);
  app.innerHTML = `<section class="wap-page">
    <p><strong>${renderUiIcon('任务日志')}任务</strong></p>
    ${renderFeedback()}
    <p>当前系列：${escapeHtml(activeSeries?.display_name??view.active_series_canonical_id)}</p>
    <p>${view.task_series.map((series)=>`<button class="text-link" data-series-select="${attr(series.canonical_id)}">${escapeHtml(content.series.find((entry)=>entry.canonical_id===series.canonical_id)?.display_name??series.canonical_id)} ${series.completed}/${series.total}</button>`).join(' · ')}</p>
    ${visible.map((entry,index) => `<p class="asset-row">${renderTaskTargetVisual(entry.definition,'item-icon')}${index + 1}. <button class="text-link" data-page="task" data-task-id="${attr(entry.definition.canonical_id)}">${escapeHtml(entry.definition.display_name)}</button>　${statusLabel(entry.runtime.status)}</p>`).join('') || '<p>当前没有任务。</p>'}
    <p><button class="text-link" data-page="location">返回</button></p>
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();
}

function renderTaskDetailPage() {
  document.body.dataset.page = 'task';
  const view = engine.getPlayerView(PLAYER_ID);
  const entry = view.task_chain.find((item) => item.definition.canonical_id === page.taskId);
  if (!entry) { showPage('tasks');return; }
  const task = entry.definition;
  app.innerHTML = `<section class="wap-page">
    <p>【<strong>${escapeHtml(task.display_name)}</strong>】</p>
    ${renderTaskTargetVisual(task,'detail-art')}
    ${renderFeedback()}
    <p>${escapeHtml(task.description)}</p>
    <p>任务：${task.targets.map((target) => `${escapeHtml(target.raw_name)} ${target.required_quantity}个`).join('；') || escapeHtml(task.description)}</p>
    <p>任务奖励：${renderRewardsText(task)}</p>
    <p class="progress-text">当前进度：${renderProgressText(entry)}</p>
    <p>接取地点：${escapeHtml(locationDisplayName(task.receive_location_canonical_id))}</p>
    <p>目标地点：${escapeHtml(locationDisplayName(task.target_location_canonical_id) || '未单独指定')}</p>
    <p>提交地点：${escapeHtml(locationDisplayName(task.submit_location_canonical_id))}</p>
    <p>任务状态：${statusLabel(entry.runtime.status)}</p>
    <p><button class="text-link" data-page="tasks">返回</button></p>
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();
}

function renderBackpackPage() {
  document.body.dataset.page = 'backpack';
  const view = engine.getPlayerView(PLAYER_ID);
  const inventory = Object.entries(view.inventory);
  const equipmentIds = new Set(content.equipment.map((entry)=>entry.canonical_id));
  const groups = [
    ['装备',inventory.filter(([id])=>equipmentIds.has(id))],
    ['药品',inventory.filter(([id])=>!equipmentIds.has(id)&&Number(gameplayCatalog.getItem(id)?.normalized_data?.type)===4)],
    ['任务物品',inventory.filter(([id])=>!equipmentIds.has(id)&&Number(gameplayCatalog.getItem(id)?.normalized_data?.type)!==4)],
  ];
  app.innerHTML = `<section class="wap-page">
    <p><strong>${renderUiIcon('背包')}背包</strong></p>
    ${renderFeedback()}
    <p>铜贝：${view.player.money}</p>
    <p>经验：${view.player.experience}</p>
    <p>背包：${inventory.reduce((sum,[,quantity]) => sum + quantity,0)}/${view.inventory_capacity}</p>
    ${inventory.length ? groups.filter(([,entries])=>entries.length).map(([label,entries])=>`<p>【${label}】</p>${entries.map(([id,quantity],index)=>`<p class="asset-row">${renderCanonicalVisual(id,'item-icon')}${index+1}. <button class="text-link" data-page="item" data-item-id="${attr(id)}">${escapeHtml(entityName(id))}</button> *${quantity}</p>`).join('')}`).join('') : '<p>背包为空。</p>'}
    <p><button class="text-link" data-page="location">返回</button></p>
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();
}

function renderItemDetailPage() {
  document.body.dataset.page='item';const view=engine.getPlayerView(PLAYER_ID);const id=page.itemId;
  const item=gameplayCatalog.getItem(id);if(!item||!view.inventory[id]){showPage('backpack');return;}
  const data=item.normalized_data??item.attributes??{};const gear=content.equipment.find((entry)=>entry.canonical_id===id);
  const healing=Number(data.info?.heal??0);
  const stats=gear ? [['攻击',gear.attack],['攻击上限',gear.max_attack??gear.maxAttack],['防御',gear.defense],['敏捷',gear.agility],['体力',gear.health],['士气',gear.morale]].filter(([,value])=>Number(value)) : [];
  app.innerHTML=`<section class="wap-page"><p><strong>${escapeHtml(entityName(id))}</strong></p>${renderCanonicalVisual(id,'detail-art')}${renderFeedback()}
    <p>持有数量：${view.inventory[id]}</p><p>${escapeHtml(data.tip??item.tip??'资料未记录额外说明。')}</p>
    ${gear?`<p>装备等级：${gear.required_level??1}</p><p>${stats.map(([name,value])=>`${name}+${value}`).join('、')||'无附加属性'}</p>
      ${Number(gear.equipment_type)===6?'<p><button class="text-link" data-equip-item="'+attr(id)+'" data-accessory-index="0">装备至饰品槽1</button>　<button class="text-link" data-equip-item="'+attr(id)+'" data-accessory-index="1">槽2</button>　<button class="text-link" data-equip-item="'+attr(id)+'" data-accessory-index="2">槽3</button></p>':`<p><button class="text-link" data-equip-item="${attr(id)}">穿戴</button></p>`}`:''}
    ${healing>0?`<p>恢复体力：${healing}</p><p><button class="text-link" data-use-item="${attr(id)}">使用</button></p>`:''}
    <p><button class="text-link" data-page="backpack">返回背包</button></p>${renderPrimaryNav()}</section>`;
  bindPageActions();bindFormalPageActions();
}

function renderFormalEncounterPage() {
  document.body.dataset.page = 'encounter';
  const view=engine.getPlayerView(PLAYER_ID);const actions=listFormalEncounterActions(view);const active=view.combat;const activeDuel=view.npc_duel;
  const activeDungeon=view.dungeon?gameplayCatalog.getDungeon(view.dungeon.canonical_id):null;
  const dungeonStage=activeDungeon?.stages.find((entry)=>entry.canonical_id===view.dungeon.stage_canonical_id);
  const dungeonIndex=activeDungeon?.stages.findIndex((entry)=>entry.canonical_id===view.dungeon.stage_canonical_id)??-1;
  app.innerHTML=`<section class="wap-page"><p><strong>${renderUiIcon('战斗')}遭遇</strong></p>${renderFeedback()}
    ${activeDungeon?`<p>副本：${escapeHtml(activeDungeon.display_name)} · ${escapeHtml(dungeonStage.display_name)}</p>
      <p>${dungeonIndex>0?`<button class="text-link" data-dungeon-move="${attr(activeDungeon.stages[dungeonIndex-1].canonical_id)}">返回上一处</button>`:''}
      ${dungeonIndex<activeDungeon.stages.length-1?`<button class="text-link" data-dungeon-move="${attr(activeDungeon.stages[dungeonIndex+1].canonical_id)}">前往下一处</button>`:''}
      ${dungeonIndex===0?'<button class="text-link" data-dungeon-exit="1">退出副本</button>':''}</p>`:''}
    ${active ? `${renderCanonicalVisual(active.monster_canonical_id,'combat-art')}<p>敌人：${escapeHtml(entityName(active.monster_canonical_id))}</p><p>敌方体力：${active.monster_current_health}/${active.monster_stats.health}　回合：${active.round}</p>
      <p>你的体力：${view.player.current_health}/${effectiveStats(view,gameplayCatalog).max_health}</p><p><button class="text-link" data-combat-attack="1">攻击</button>　<button class="text-link" data-combat-retreat="1">撤退（500铜）</button></p>`
      : activeDuel ? `${renderCanonicalVisual(activeDuel.npc_canonical_id,'combat-art')}<p>切磋对象：${escapeHtml(entityName(activeDuel.npc_canonical_id))}</p><p>对方体力：${activeDuel.npc_current_health}/${activeDuel.npc_stats.health}　回合：${activeDuel.round}</p>
        <p>你的体力：${view.player.current_health}/${effectiveStats(view,gameplayCatalog).max_health}</p><p><button class="text-link" data-npc-duel-attack="1">切磋</button>　<button class="text-link" data-npc-duel-retreat="1">收手</button></p>`
      : actions.length ? actions.map((action)=>action.kind==='npc_duel'?`<section class="encounter-row">${renderCanonicalVisual(action.npc_canonical_id,'encounter-icon')}<p><strong>与${escapeHtml(action.display_name)}切磋</strong>（${action.level}级）</p>
        <p>任务进度：${renderProgressText(action.task)} · 非致命切磋 · 无普通怪掉落</p><p><button class="text-link" data-npc-duel-start="${attr(action.npc_canonical_id)}">开始切磋</button></p></section>`
        :`<section class="encounter-row">${renderCanonicalVisual(action.monster_canonical_id,'encounter-icon')}<p><strong>挑战${escapeHtml(action.display_name)}</strong>（${action.level}级）</p>
        <p>${action.task?`任务进度：${renderProgressText(action.task)}`:'自由遭遇，可重复挑战'} · 经验${action.experience} · 铜币${action.copper}</p>
        <p><button class="text-link" data-combat-start="${attr(action.monster_canonical_id)}">进入战斗</button></p></section>`).join('') : '<p>当前位置没有可执行的正式战斗目标。</p>'}
    <p><button class="text-link" data-page="location">返回</button></p>${renderPrimaryNav()}</section>`;
  bindPageActions();bindFormalPageActions();
}

function renderFormalShopPage() {
  document.body.dataset.page='shop';const view=engine.getPlayerView(PLAYER_ID);
  const entries=content.shop_entries.filter((entry)=>entry.map_node_canonical_id===view.player.current_map_node_canonical_id);
  app.innerHTML=`<section class="wap-page"><p><strong>${renderUiIcon('商店交易')}商店</strong></p>${renderFeedback()}<p>铜币：${view.player.money}</p>
    ${entries.length ? entries.map((entry)=>{const itemId=entry.task_item_canonical_id??entry.content_entity_canonical_id;const owned=view.inventory[itemId]??0;return `<p class="asset-row">${renderCanonicalVisual(itemId,'item-icon')}${escapeHtml(entry.display_name)}　${entry.price}铜　<button class="text-link" data-shop-buy="${attr(entry.canonical_id)}">购买</button>${owned?`　持有${owned}　<button class="text-link" data-shop-sell="${attr(entry.canonical_id)}">出售（${Math.max(1,Math.floor(entry.price*0.2))}铜）</button>`:''}</p>`;}).join('') : '<p>当前位置没有可购买商品。</p>'}
    <p>背包：${Object.values(view.inventory).reduce((sum,n)=>sum+n,0)}/${view.inventory_capacity}</p><p><button class="text-link" data-page="location">返回</button></p>${renderPrimaryNav()}</section>`;
  bindPageActions();bindFormalPageActions();
}

function renderFormalVoyagePage() {
  document.body.dataset.page='voyage';const view=engine.getPlayerView(PLAYER_ID);const routes=listFormalVoyages(view);
  const portShips=content.ships.filter((ship)=>ship.port_map_node_canonical_id===view.player.current_map_node_canonical_id);
  const ownedShips=content.ships.filter((ship)=>view.owned_ships[ship.canonical_id]);
  const rods=content.maritime.fishing.gear.filter((entry)=>Number(entry.type)===14&&(view.inventory[entry.canonical_id]??0)>0);
  const baits=content.maritime.fishing.gear.filter((entry)=>Number(entry.type)===8&&(view.inventory[entry.canonical_id]??0)>0);
  const activityLocked=Boolean(view.fishing||view.dungeon||view.maritime_encounter);
  const voyageVisual=view.maritime_encounter?visualForMaritimeEncounter(view.maritime_encounter.display_name):view.current_ship_canonical_id?visualForCanonical(view.current_ship_canonical_id):visualByName('夜航月夜海面');
  app.innerHTML=`<section class="wap-page"><p><strong>${renderUiIcon('航海')}航行</strong></p>${voyageVisual?renderAsset(voyageVisual,'scene-art'):''}${renderFeedback()}
    ${view.voyage ? `<p>航线：${escapeHtml(cityDisplayName(view.voyage.from_city_canonical_id))} → ${escapeHtml(cityDisplayName(view.voyage.to_city_canonical_id))}</p><p>剩余航程：${view.voyage.remaining_distance}/${view.voyage.total_distance}海里　航速：${view.voyage.speed}</p>
      ${view.dungeon?'<p>你正在海底地点中。<button class="text-link" data-page="encounter">返回海皇宫殿</button></p>':''}
      ${view.maritime_encounter?`<p>海上发现：${escapeHtml(view.maritime_encounter.display_name)}　${view.maritime_encounter.kind==='diving_dungeon'?'<button class="text-link" data-diving-enter="1">进入</button>　':''}<button class="text-link" data-maritime-dismiss="1">放弃并继续航行</button></p>`:''}
      ${view.fishing?renderFishingControls(view):rods.length&&baits.length&&!view.dungeon&&!view.maritime_encounter
        ?`<p>【航行中钓鱼】</p>${rods.flatMap((rod)=>baits.map((bait)=>`<p>${escapeHtml(rod.display_name)}＋${escapeHtml(bait.display_name)}　<button class="text-link" data-fishing-start="${attr(rod.canonical_id)}" data-bait-id="${attr(bait.canonical_id)}">开始钓鱼</button></p>`)).join('')}`
        :!view.dungeon&&!view.maritime_encounter?'<p>钓鱼需要持有鱼竿和鱼饵。</p>':''}
      ${!activityLocked?'<p><button class="text-link" data-diving-attempt="1">潜水</button></p>':''}
      ${!activityLocked?'<p><button class="text-link" data-voyage-advance="1">继续航行</button>　<button class="text-link" data-voyage-finish="1">持续航行至靠岸</button></p>':''}` : ''}
    ${!view.voyage ? routes.map((route)=>`<p>航线：${escapeHtml(cityDisplayName(route.from_city_canonical_id))} → ${escapeHtml(cityDisplayName(route.to_city_canonical_id))}，${route.distance}海里
      <button class="text-link" data-voyage-start="${attr(route.canonical_id)}">出航</button></p>`).join('') : ''}
    ${!view.voyage ? portShips.map((ship)=>view.owned_ships[ship.canonical_id] ? `<p class="asset-row">${renderCanonicalVisual(ship.canonical_id,'item-icon')}${escapeHtml(ship.display_name)}（已拥有${view.current_ship_canonical_id===ship.canonical_id?'，当前':''}）${view.current_ship_canonical_id!==ship.canonical_id?`　<button class="text-link" data-ship-select="${attr(ship.canonical_id)}">设为当前船只</button>`:''}</p>`
      : `<p class="asset-row">${renderCanonicalVisual(ship.canonical_id,'item-icon')}${escapeHtml(ship.display_name)}　${ship.price}铜　载重${ship.weight}　航速${ship.speed}　<button class="text-link" data-ship-buy="${attr(ship.canonical_id)}">购买</button></p>`).join('') : ''}
    ${ownedShips.length?`<p>【持有船只】</p>${ownedShips.map((ship)=>`<p>${escapeHtml(ship.display_name)}${view.current_ship_canonical_id===ship.canonical_id?'（当前）':`　<button class="text-link" data-ship-select="${attr(ship.canonical_id)}">选择</button>`}</p>`).join('')}`:''}
    ${!view.voyage&&!routes.length&&!portShips.length?'<p>请前往码头办理船只与航行事务。</p>':''}
    <p><button class="text-link" data-page="location">返回</button></p>${renderPrimaryNav()}</section>`;
  bindPageActions();bindFormalPageActions();
}

function renderFishingControls(view) {
  const session=view.fishing;const activeLine=session.phase!=='ready';
  return `<p>【航行中钓鱼】当前：${escapeHtml(entityName(session.rod_canonical_id))}＋${escapeHtml(entityName(session.bait_canonical_id))}</p>
    <p>${activeLine?`<button class="text-link" data-fishing-wait="1">等待</button>　<button class="text-link" data-fishing-reel="1">收线</button>${['hooked','pulling'].includes(session.phase)?'　<button class="text-link" data-fishing-let-out="1">放线</button>':''}`:'<button class="text-link" data-fishing-cast="1">抛竿</button>'}　<button class="text-link" data-fishing-stop="1">收起鱼竿</button></p>`;
}

function renderStatusPage() {
  document.body.dataset.page = 'status';
  const view = engine.getPlayerView(PLAYER_ID);
  const completed = view.all_task_chain.filter((entry) => entry.runtime.status === 'completed').length;
  const stats=effectiveStats(view,gameplayCatalog);
  const slots=[['weapon','武器'],['offhand','副手'],['headgear','头部'],['clothes','衣服'],['belt','腰带'],['shoes','鞋子']];
  const ownedShips=content.ships.filter((ship)=>view.owned_ships[ship.canonical_id]);
  app.innerHTML = `<section class="wap-page">
    <p><strong>${renderUiIcon('角色状态')}状态</strong></p>
    ${renderFeedback()}
    <p>当前位置：${escapeHtml(cityDisplayName(view.current_location?.city_canonical_id))} - ${escapeHtml(view.current_location?.display_name ?? '未知地点')}</p>
    <p>铜贝：${view.player.money}</p>
    <p>经验：${view.player.experience}</p>
    <p>等级：${view.player.level}</p>
    <p>体力：${view.player.current_health}/${stats.max_health}</p>
    <p>攻击：${stats.attack}-${stats.max_attack}　防御：${stats.defense}</p>
    <p>敏捷：${stats.agility}　士气：${stats.morale}</p>
    <p>已完成任务：${completed}/${view.all_task_chain.length}</p>
    <p>【当前装备】</p>
    ${slots.map(([slot,label])=>`<p class="asset-row">${view.equipment[slot]?renderCanonicalVisual(view.equipment[slot],'item-icon'):''}${label}：${view.equipment[slot]?`${escapeHtml(entityName(view.equipment[slot]))}　<button class="text-link" data-unequip-slot="${slot}">卸下</button>`:'无'}</p>`).join('')}
    ${view.equipment.accessories.map((id,index)=>`<p>饰品槽${index+1}：${id?`${escapeHtml(entityName(id))}　<button class="text-link" data-unequip-slot="accessories" data-accessory-index="${index}">卸下</button>`:'无'}</p>`).join('')}
    <p>【船只】</p>${ownedShips.length?ownedShips.map((ship)=>`<p>${escapeHtml(ship.display_name)}${view.current_ship_canonical_id===ship.canonical_id?'（当前）':''}</p>`).join(''):'<p>尚未持有船只。</p>'}
    <p><button class="text-link" data-page="location">返回</button></p>
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();
}

function renderSavePage() {
  document.body.dataset.page = 'save';
  app.innerHTML = `<section class="wap-page">
    <p><strong>存档</strong></p>
    ${renderFeedback()}
    <p><button class="text-link" data-action="export-save">导出存档</button></p>
    <p><button class="text-link" data-action="import-save">导入存档</button></p>
    <p><button class="text-link danger-link" data-action="reset-save">重置测试进度</button></p>
    <p>进度保存在当前浏览器 IndexedDB 中。</p>
    <p><button class="text-link" data-page="location">返回</button></p>
    ${renderPrimaryNav()}
  </section>`;
  bindPageActions();
  bindCommonActions();
}

function renderCompendiumPage() {
  if(!debugEnabled){showPage('location');return;}
  document.body.dataset.page='compendium';
  const groups=[...new Set(visuals.assets.map((entry)=>entry.category))];
  app.innerHTML=`<section class="wap-page"><p><strong>图像调试</strong></p>
    ${groups.map((category)=>`<details><summary>${escapeHtml(category)}（${visuals.assets.filter((entry)=>entry.category===category).length}）</summary><div class="asset-grid">
      ${visuals.assets.filter((entry)=>entry.category===category).map((entry)=>`<figure>${renderAsset(entry,'gallery-art')}<figcaption>${escapeHtml(entry.display_name)}</figcaption></figure>`).join('')}</div></details>`).join('')}
    <p><button class="text-link" data-page="location">返回</button></p>${renderPrimaryNav()}</section>`;
}

function renderAdminPage() {
  if(!adminEnabled||!storage.hasPlayer(PLAYER_ID)){showPage('location');return;}
  document.body.dataset.page='admin';
  const view=engine.getPlayerView(PLAYER_ID);
  const player=view.player;
  const inventory=Object.entries(view.inventory??{});
  const taskStates=Object.values(view.all_task_chain??[]);
  const equipmentRows=Object.entries(view.equipment??{});
  const itemChoices=[...(content.content_entities??[]),...(content.formal_items??[]),...(content.equipment??[]),...(content.items??[])]
    .filter((entry)=>entry?.canonical_id)
    .map((entry)=>({canonical_id:entry.canonical_id,display_name:entry.display_name??entry.canonical_id}));
  app.innerHTML=`<section class="wap-page"><p><strong>⛨ 超管控制台</strong></p>${renderFeedback()}
    <details open><summary>玩家概况</summary>
      <p>玩家：${escapeHtml(player.canonical_id)}</p>
      <p>等级 ${player.level}　经验 ${player.experience}　铜贝 ${player.money}</p>
      <p>体力 ${player.current_health}/${player.max_health}　攻击 ${player.base_attack}-${player.base_max_attack}　防御 ${player.base_defense}　敏捷 ${player.base_agility}</p>
      <p>背包 ${inventory.reduce((s,[,q])=>s+q,0)}/${view.inventory_capacity}　任务 ${taskStates.length}</p>
    </details>
    <details open><summary>等级 / 经验</summary>
      <p>设定等级：<input id="admin-level" type="number" min="1" max="${LEVEL_THRESHOLDS.length-1}" value="${player.level}">　
        <button class="text-link" data-admin-action="set-level">应用</button></p>
      <p>设定经验：<input id="admin-exp" type="number" min="0" value="${player.experience}">　
        <button class="text-link" data-admin-action="set-exp">应用</button></p>
    </details>
    <details open><summary>货币 / 体力</summary>
      <p>铜贝：<input id="admin-money" type="number" min="0" value="${player.money}">　
        <button class="text-link" data-admin-action="set-money">应用</button></p>
      <p>体力：<input id="admin-health" type="number" min="0" max="${player.max_health}" value="${player.current_health}">　
        <button class="text-link" data-admin-action="set-health">应用</button></p>
    </details>
    <details><summary>背包物品</summary>
      <p>物品：<select id="admin-item">${itemChoices.map((entry)=>`<option value="${attr(entry.canonical_id)}">${escapeHtml(entry.display_name)}</option>`).join('')}</select>
        数量：<input id="admin-qty" type="number" min="1" value="1"></p>
      <p><button class="text-link" data-admin-action="add-item">增加</button>　
        <button class="text-link" data-admin-action="remove-item">移除</button></p>
      <p>当前：${inventory.length?inventory.map(([id,q])=>`${escapeHtml(entityName(id))}×${q}`).join('、'):'空'}</p>
    </details>
    <details><summary>任务</summary>
      <p>未完成：<input id="admin-task-state" type="text" placeholder="可接取/已完成/进行中">　
        <button class="text-link" data-admin-action="unlock-tasks">全部解锁为可接取</button>　
        <button class="text-link" data-admin-action="complete-tasks">全部标记为已完成</button></p>
    </details>
    <details><summary>危险操作</summary>
      <p><button class="text-link danger-link" data-admin-action="reroll">重新初始化进度</button>　
        <button class="text-link danger-link" data-admin-action="wipe">清空存档</button></p>
    </details>
    <p><button class="text-link" data-page="location">返回</button></p>${renderPrimaryNav()}</section>`;
  bindAdminActions();
}

function renderPrimaryNav() {
  return `<nav class="primary-nav" aria-label="游戏功能">
    <button class="text-link nav-link" data-page="status">${renderUiIcon('角色状态')}状态</button> ·
    <button class="text-link nav-link" data-page="backpack">${renderUiIcon('背包')}物品</button> ·
    <button class="text-link nav-link" data-page="tasks">${renderUiIcon('任务日志')}任务</button> ·
    <button class="text-link nav-link" data-page="shop">${renderUiIcon('商店交易')}商店</button> ·
    <button class="text-link nav-link" data-page="voyage">${renderUiIcon('航海')}航行</button> ·
    ${debugEnabled?'<button class="text-link nav-link" data-page="compendium">图像调试</button> ·':''}
    ${adminEnabled?'<button class="text-link nav-link" data-page="admin">超管</button> ·':''}
    <button class="text-link" data-page="save">存档</button>
  </nav>`;
}

function renderFeedback() {
  const { message,error } = feedback.snapshot();
  return `${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}${message ? `<div class="message">${escapeHtml(message)}</div>` : ''}`;
}

function bindPageActions() {
  document.querySelectorAll('[data-npc-action]').forEach((button) => button.addEventListener('click',() => interactNpc(button.dataset.npcAction)));
  document.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click',() => perform(
    () => engine.move(PLAYER_ID,button.dataset.move,eventId('move')),'已到达新地点。','location')));
  document.querySelectorAll('[data-city-port]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>engine.travelToCityPort(PLAYER_ID,button.dataset.cityPort,eventId('city-port-travel')),'已抵达目标城市码头。','location')));
  document.querySelectorAll('[data-recovery]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>recovery.recover(PLAYER_ID,button.dataset.recovery,eventId('recovery')),'体力已经恢复。','location')));
  document.querySelectorAll('[data-series-select]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>engine.selectSeries(PLAYER_ID,button.dataset.seriesSelect,eventId('series-select')),'任务系列已经切换。','tasks')));
  document.querySelector('[data-action="refresh"]')?.addEventListener('click',() => { feedback.succeed('页面已刷新。');renderLocationPage(); });
}

function bindFormalPageActions() {
  document.querySelectorAll('[data-dungeon-enter]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>dungeon.enter(PLAYER_ID,button.dataset.dungeonEnter,eventId('dungeon-enter')),'已经进入副本。','encounter')));
  document.querySelectorAll('[data-dungeon-move]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>dungeon.move(PLAYER_ID,button.dataset.dungeonMove,eventId('dungeon-move')),'已经到达副本内的新地点。','encounter')));
  document.querySelectorAll('[data-dungeon-exit]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>dungeon.exit(PLAYER_ID,eventId('dungeon-exit')),'已经退出副本。',()=>engine.loadPlayer(PLAYER_ID).voyage?'voyage':'location')));
  document.querySelectorAll('[data-npc-duel-start]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>{const factory=globalThis.__ZHSH_UAT_COMBAT_RANDOM_FACTORY__;combatRandom=typeof factory==='function'?factory(button.dataset.npcDuelStart):Math.random;
      return npcDuel.start(PLAYER_ID,button.dataset.npcDuelStart,eventId('npc-duel-start'));},'切磋开始。','encounter')));
  document.querySelectorAll('[data-npc-duel-attack]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>npcDuel.attack(PLAYER_ID,eventId('npc-duel-attack'),{rounds:Number(globalThis.__ZHSH_UAT_COMBAT_BATCH_ROUNDS__??1)}),'切磋回合已结算。','encounter')));
  document.querySelectorAll('[data-npc-duel-retreat]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>npcDuel.retreat(PLAYER_ID,eventId('npc-duel-retreat')),'已经收手。','encounter')));
  document.querySelectorAll('[data-combat-start]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>{const factory=globalThis.__ZHSH_UAT_COMBAT_RANDOM_FACTORY__;combatRandom=typeof factory==='function'?factory(button.dataset.combatStart):Math.random;
      return combat.start(PLAYER_ID,button.dataset.combatStart,eventId('combat-start'));},'战斗开始。','encounter')));
  document.querySelectorAll('[data-combat-attack]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>combat.attack(PLAYER_ID,eventId('combat-attack'),{rounds:Number(globalThis.__ZHSH_UAT_COMBAT_BATCH_ROUNDS__??1)}),'战斗回合已结算。',(result)=>result.action==='combat_lost'?'location':'encounter')));
  document.querySelectorAll('[data-combat-retreat]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>combat.retreat(PLAYER_ID,eventId('combat-retreat')),'已撤退并支付500铜。',()=>engine.loadPlayer(PLAYER_ID).dungeon?'encounter':'location')));
  document.querySelectorAll('[data-shop-buy]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>economy.buy(PLAYER_ID,button.dataset.shopBuy,1,eventId('shop-buy')),'购买成功。','shop')));
  document.querySelectorAll('[data-shop-sell]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>economy.sell(PLAYER_ID,button.dataset.shopSell,1,eventId('shop-sell')),'出售成功。','shop')));
  document.querySelectorAll('[data-use-item]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>items.use(PLAYER_ID,button.dataset.useItem,eventId('item-use')),'物品已经使用。','backpack')));
  document.querySelectorAll('[data-equip-item]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>equipment.equip(PLAYER_ID,button.dataset.equipItem,eventId('equipment-equip'),button.hasAttribute('data-accessory-index')?Number(button.dataset.accessoryIndex):null),'装备已经穿戴。','status')));
  document.querySelectorAll('[data-unequip-slot]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>equipment.unequip(PLAYER_ID,button.dataset.unequipSlot,eventId('equipment-unequip'),button.hasAttribute('data-accessory-index')?Number(button.dataset.accessoryIndex):null),'装备已经卸下。','status')));
  document.querySelectorAll('[data-ship-buy]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>ships.purchase(PLAYER_ID,button.dataset.shipBuy,eventId('ship-buy')),'船只购买成功。','voyage')));
  document.querySelectorAll('[data-ship-select]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>ships.select(PLAYER_ID,button.dataset.shipSelect,eventId('ship-select')),'当前船只已经切换。','voyage')));
  document.querySelectorAll('[data-voyage-start]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>voyage.start(PLAYER_ID,button.dataset.voyageStart,eventId('voyage-start')),'已经出航。','voyage')));
  document.querySelectorAll('[data-voyage-advance]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>voyage.advance(PLAYER_ID,eventId('voyage-advance')),'航程已推进。','voyage')));
  document.querySelectorAll('[data-voyage-finish]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>finishVoyage(),'已经靠岸。','location')));
  document.querySelectorAll('[data-fishing-start]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>fishing.start(PLAYER_ID,button.dataset.fishingStart,button.dataset.baitId,eventId('fishing-start')),'已经准备好钓具。','voyage')));
  document.querySelectorAll('[data-fishing-cast]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>fishing.cast(PLAYER_ID,eventId('fishing-cast')),'已经抛竿。','voyage')));
  document.querySelectorAll('[data-fishing-wait]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>fishing.wait(PLAYER_ID,eventId('fishing-wait')),'继续等待鱼讯。','voyage')));
  document.querySelectorAll('[data-fishing-reel]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>fishing.reel(PLAYER_ID,eventId('fishing-reel')),'已经收线。','voyage')));
  document.querySelectorAll('[data-fishing-let-out]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>fishing.letOut(PLAYER_ID,eventId('fishing-let-out')),'已经放线。','voyage')));
  document.querySelectorAll('[data-fishing-stop]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>fishing.stop(PLAYER_ID,eventId('fishing-stop')),'已经收起鱼竿。','voyage')));
  document.querySelectorAll('[data-diving-attempt]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>diving.dive(PLAYER_ID,eventId('diving-attempt')),'潜水探查已经完成。','voyage')));
  document.querySelectorAll('[data-diving-enter]').forEach((button)=>button.addEventListener('click',()=>perform(
    ()=>diving.enter(PLAYER_ID,eventId('diving-enter')),'已经进入海底地点。','encounter')));
}

function bindAdminActions() {
  const readInt=(id,fallback)=>Number(document.querySelector(`#${id}`)?.value ?? fallback) || 0;
  const readQty=(id)=>Math.max(0,Number(document.querySelector(`#${id}`)?.value ?? 0) || 0);
  const applyMutation=(mutator,message)=>{
    try { storage.transact(PLAYER_ID,mutator); storage.flush(); feedback.succeed(message); saveStatus.textContent='超管操作已保存'; renderAdminPage(); }
    catch (error) { feedback.fail(`超管操作失败：${error.message}`); renderAdminPage(); }
  };
  document.querySelector('[data-admin-action="set-level"]')?.addEventListener('click',()=>applyMutation((state)=>{
    const target=Math.max(1,Math.min(readInt('admin-level',1),LEVEL_THRESHOLDS.length-1));
    state.player.experience=LEVEL_THRESHOLDS[target-1];
    applyExperienceProgression(state);
  },`等级已设为 ${LEVEL_THRESHOLDS.length?readInt('admin-level',1):1}。`));
  document.querySelector('[data-admin-action="set-exp"]')?.addEventListener('click',()=>applyMutation((state)=>{
    state.player.experience=readInt('admin-exp',0);
    applyExperienceProgression(state);
  },'经验已更新。'));
  document.querySelector('[data-admin-action="set-money"]')?.addEventListener('click',()=>applyMutation((state)=>{
    state.player.money=readInt('admin-money',0);
  },'铜贝已更新。'));
  document.querySelector('[data-admin-action="set-health"]')?.addEventListener('click',()=>applyMutation((state)=>{
    const max=Number(state.player.max_health)||1;
    state.player.current_health=Math.max(0,Math.min(readInt('admin-health',0),max));
  },'体力已更新。'));
  document.querySelector('[data-admin-action="add-item"]')?.addEventListener('click',()=>applyMutation((state)=>{
    const id=document.querySelector('#admin-item')?.value; if(!id)return;
    state.inventory[id]=(state.inventory[id]??0)+readQty('admin-qty');
  },'物品已增加。'));
  document.querySelector('[data-admin-action="remove-item"]')?.addEventListener('click',()=>applyMutation((state)=>{
    const id=document.querySelector('#admin-item')?.value; if(!id)return;
    state.inventory[id]=Math.max(0,(state.inventory[id]??0)-readQty('admin-qty'));
    if(!state.inventory[id])delete state.inventory[id];
  },'物品已移除。'));
  document.querySelector('[data-admin-action="unlock-tasks"]')?.addEventListener('click',()=>applyMutation((state)=>{
    for(const [id,task] of Object.entries(state.tasks??{})){ if(task.block_reasons?.length)continue;
      task.status='available';task.reward_status='not_granted';task.current_step=0; }
  },'任务已全部解锁为可接取。'));
  document.querySelector('[data-admin-action="complete-tasks"]')?.addEventListener('click',()=>applyMutation((state)=>{
    for(const task of Object.values(state.tasks??{})){ task.status='completed';task.reward_status='granted';task.current_step=task.current_step??0; }
  },'任务已全部标记为已完成。'));
  document.querySelector('[data-admin-action="reroll"]')?.addEventListener('click',async()=>{
    if(!confirm('重新初始化进度将覆盖当前浏览器存档，是否继续？'))return;
    try { engine.createPlayer(PLAYER_ID,{reset:true}); await storage.flush(); feedback.succeed('进度已重新初始化。'); saveStatus.textContent='进度已重置'; renderAdminPage(); }
    catch (error) { feedback.fail(`重置失败：${error.message}`); renderAdminPage(); }
  });
  document.querySelector('[data-admin-action="wipe"]')?.addEventListener('click',async()=>{
    if(!confirm('清空存档将永久删除当前浏览器存档，是否继续？'))return;
    try { await storage.deletePlayer(PLAYER_ID); await storage.flush(); gameEntered=false; feedback.succeed('存档已清空。'); showPage('start'); }
    catch (error) { feedback.fail(`清空失败：${error.message}`); renderAdminPage(); }
  });
}

function bindCommonActions() {
  document.querySelector('[data-action="continue-game"]')?.addEventListener('click',() => {
    gameEntered=true;feedback.succeed('已继续浏览器存档。');showPage('location');
  });
  document.querySelector('[data-action="new-game"]')?.addEventListener('click',async () => {
    try {
      const existing = storage.hasPlayer(PLAYER_ID);
      if (existing && !confirm('开始新游戏将覆盖当前 task1 浏览器存档，是否继续？')) return;
      engine.createPlayer(PLAYER_ID,{ reset:existing || storage.corruptRecords.has(PLAYER_ID) });
      await storage.flush();
      gameEntered=true;feedback.succeed('你在威尼斯酒馆醒来。');saveStatus.textContent='新游戏已保存';showPage('location');
    } catch (error) { showFatal(error); }
  });
  document.querySelectorAll('[data-action="import-save"]').forEach((button) => button.addEventListener('click',() => importInput.click()));
  document.querySelector('[data-action="export-save"]')?.addEventListener('click',exportSave);
  document.querySelector('[data-action="reset-save"]')?.addEventListener('click',async () => {
    if (!confirm('确定重置 task1 测试进度吗？当前浏览器存档将被覆盖。')) return;
    engine.createPlayer(PLAYER_ID,{ reset:true });
    await storage.flush();
    feedback.succeed('进度已重置。');saveStatus.textContent='重置结果已保存';showPage('location');
  });
}

async function interactNpc(npcCanonicalId) {
  const view = engine.getPlayerView(PLAYER_ID);
  const locationId = view.current_location?.location_canonical_id;
  if (!locationId) return;
  const completable = view.task_chain.find((entry) => entry.runtime.status === 'completable'
    && entry.definition.completion_npc_canonical_id === npcCanonicalId && entry.definition.submit_location_canonical_id === locationId);
  await perform(() => engine.processEvent(PLAYER_ID,{ event_id:eventId(completable ? 'submit':'talk'),type:completable ? 'submit_to_npc':'talk_to_npc',npc_canonical_id:npcCanonicalId,location_canonical_id:locationId }),
    completable ? '任务已经完成。' : '交谈结束。','npc',{ npcId:npcCanonicalId });
}

async function perform(operation,fallbackMessage,nextPage,nextParams = {}) {
  try {
    saveStatus.textContent = '正在保存……';
    const result = operation();
    await storage.flush();
    feedback.succeed(resultMessage(result) || fallbackMessage);
    saveStatus.textContent = `纵横报时（${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}）`;
    page = { name:typeof nextPage==='function'?nextPage(result):nextPage,...nextParams };
    render();
  } catch (error) {
    feedback.fail(error);
    saveStatus.textContent = '保存或操作失败';
    render();
  }
}

function resultMessage(result) {
  if(result.action==='fish_caught')return `钓获${result.display_name}。`;
  if(result.action==='fishing_waited')return ({nothing:'水面暂时没有动静。',bite:'有鱼咬钩了！',line_snapped:'鱼线绷断了。',bait_eaten:'鱼饵被吃掉了。'})[result.outcome]??'';
  if(result.action==='fishing_reeled')return ({fish_lost:'鱼脱钩了。',fish_tiring:'鱼的力气正在减弱。',pulling:'鱼仍在挣扎。'})[result.outcome]??'';
  if(result.action==='fishing_line_released')return ({big_fish:'鱼的力量很大。',fish_lost:'鱼脱钩了。',line_released:'已经顺势放线。'})[result.outcome]??'';
  if(result.action==='diving_discovery')return `发现${result.encounter.display_name}。`;
  if(result.action==='diving_unresolved_discovery')return `发现${result.display_name}，但该海底地点的完整资料尚未闭合。`;
  if(result.action==='diving_no_discovery')return '这次潜水没有发现特殊地点。';
  if(result.action==='sailing_special_event')return `${result.event_name}：${result.tip}`;
  if(result.action==='ship_dungeon_discovery'||result.action==='route_location_discovery')return `发现${result.encounter.display_name}。`;
  if(result.action==='npc_duel_won')return `切磋获胜，${entityName(result.npc_canonical_id)}已认输；不结算普通怪经验、铜币或掉落。${staminaResultText(result,{prefix:' '})}`;
  if(result.action==='npc_duel_lost')return `切磋落败，体力降至1，但位置和任务状态保留，可以恢复后重试。${staminaResultText(result,{prefix:' '})}`;
  if(result.action==='npc_duel_retreated')return '已经收手，本次切磋不结算。';
  if (result.action === 'combat_won') {
    const dropsText=result.drops?.granted?.map((entry)=>`${entityName(entry.content_entity_canonical_id)}*${entry.quantity}`).join('、')||'无掉落';
    const staminaText=staminaResultText(result,{prefix:' '});
    return `战斗胜利，经验+${result.experience}，铜币+${result.money}。掉落：${dropsText}${staminaText}`;
  }
  if (result.action === 'combat_lost') return `你被击败，体力降至1并返回威尼斯福利院。可前往教堂找神父祈祷恢复。${staminaResultText(result,{prefix:' '})}`;
  if(staminaResultText(result))return staminaResultText(result,{includeCurrent:true});
  if (result.action === 'combat_retreated') return `撤退成功，支付${result.fee}铜。`;
  if (result.action === 'health_recovered') return `体力恢复${result.recovered_health}，当前${result.current_health}/${result.max_health}。`;
  if (result.action === 'item_used') return `物品已使用，体力恢复${result.recovered_health}。`;
  if (result.action === 'completed') {
    const task = catalog.getTask(result.task_canonical_id);
    const lines = task.dialogues.filter((line) => result.dialogue_canonical_ids?.includes(line.canonical_id)).map((line) => line.original_text);
    const rewards = task.rewards.map((reward) => reward.reward_kind === 'item' && reward.resolution_status === 'source_label_only'
      ? `${reward.reward_name}+${reward.quantity}（原始奖励记录，运行语义待核实）`
      : `${reward.reward_name}+${reward.quantity}`);
    return [...lines,...rewards].join('\n');
  }
  if (result.action === 'accepted') {
    const task = catalog.getTask(result.task_canonical_id);
    return task.dialogues.filter((line) => result.dialogue_canonical_ids.includes(line.canonical_id)).map((line) => line.original_text).join('\n') || `接取任务：${task.display_name}`;
  }
  if (result.reason === 'no_task_action_for_npc') return '对方现在没有任务要交给你。';
  return '';
}


function staminaResultText(result,{prefix='',includeCurrent=false}={}){
  const uses=(Array.isArray(result?.stamina_items)?result.stamina_items:[result?.stamina_item]).filter((entry)=>entry?.applied);
  if(!uses.length)return '';
  const displayName=uses[0].display_name??'体力物品';const recovered=uses.reduce((sum,entry)=>sum+Number(entry.recovered_health??0),0);
  const countText=uses.length>1?`×${uses.length}`:'';const currentText=includeCurrent?`，当前体力${uses.at(-1).current_health}`:'';
  return `${prefix}${displayName}自动使用${countText}，恢复体力${recovered}${currentText}。`;
}

function isNpcRelated(entry,npcCanonicalId,locationId) {
  const task = entry.definition;
  if (entry.runtime.status === 'available') return task.issuer_npc_canonical_id === npcCanonicalId && task.receive_location_canonical_id === locationId;
  if (entry.runtime.status === 'completable') return task.completion_npc_canonical_id === npcCanonicalId && task.submit_location_canonical_id === locationId;
  return task.targets.some((target) => target.target_kind === 'npc' && target.entity_canonical_id === npcCanonicalId)
    || (['accepted','in_progress'].includes(entry.runtime.status) && (task.issuer_npc_canonical_id === npcCanonicalId || task.completion_npc_canonical_id === npcCanonicalId));
}

function renderRewardsText(task) {
  return task.rewards.map((reward) => `${escapeHtml(reward.reward_name)}+${reward.quantity}`).join('、') || '无';
}

function renderProgressText(entry) {
  if (!entry.progress.length) return statusLabel(entry.runtime.status);
  return entry.progress.map((progress,index) => `${escapeHtml(entry.definition.targets[index]?.raw_name ?? '目标')} ${progress.current_quantity}/${progress.required_quantity}`).join('；');
}

function cityDisplayName(canonicalId) {
  return content.cities.find((entry) => entry.canonical_id === canonicalId)?.display_name ?? '';
}

function locationDisplayName(canonicalId) {
  if (!canonicalId) return '';
  const location = content.locations.find((entry) => entry.canonical_id === canonicalId);
  return location ? `${location.city_display_name} ${location.display_name}` : canonicalId;
}

function entityName(canonicalId) {
  return [...content.content_entities,...(content.formal_items??[]),...content.monsters,...content.npcs,...content.equipment,...content.ships].find((entry) => entry.canonical_id === canonicalId)?.display_name ?? canonicalId;
}

function visualForCanonical(canonicalId) {
  const matches=visuals.assets.filter((entry)=>entry.canonical_id===canonicalId||entry.binding_ids?.includes(canonicalId));
  return matches.find((entry)=>entry.variant==='base')??matches[0]??null;
}

function visualByName(displayName) {
  const matches=visuals.assets.filter((entry)=>entry.display_name===displayName);
  return matches.find((entry)=>entry.variant==='base')??matches[0]??null;
}

function renderAsset(asset,className='entity-art') {
  if(!asset)return '';
  const eager=className==='start-art';
  return `<img class="${attr(className)}" src="${attr(asset.target_resource_path)}" alt="${attr(asset.display_name)}" loading="${eager?'eager':'lazy'}" decoding="async"${eager?' fetchpriority="high"':''}>`;
}

function renderCanonicalVisual(canonicalId,className='entity-art') {
  return renderAsset(visualForCanonical(canonicalId),className);
}

function renderNamedVisual(displayName,className='entity-art') {
  return renderAsset(visualByName(displayName),className);
}

function renderUiIcon(displayName) {
  return renderNamedVisual(displayName,'ui-icon');
}

function renderTaskTargetVisual(task,className='detail-art') {
  const target=task.targets.map((entry)=>visualForCanonical(entry.entity_canonical_id)??visualByReferenceName(entry.raw_name)).find(Boolean);
  const referenced=visuals.assets.find((entry)=>entry.task_reference_ids?.includes(task.canonical_id));
  return renderAsset(target??referenced,className);
}

function visualByReferenceName(name) {
  if(!name)return null;const normalized=String(name).replace(/\s+/g,'');
  return visuals.assets.find((entry)=>entry.variant==='base'&&entry.display_name.replace(/\s+/g,'')===normalized)
    ??visuals.assets.find((entry)=>entry.visual_reference_id&&entry.display_name.replace(/\s+/g,'')===normalized)??null;
}

function visualForMaritimeEncounter(displayName) {
  const aliases=[
    [/海盗/,'海盗船'],[/幽灵/,'幽灵船'],[/宝箱/,'百宝箱'],[/哥伦布/,'哥伦布之刃'],[/奔月|月宫/,'月宫仙子冠'],[/漩涡/,'漩涡怀表'],[/风暴/,'暴风海域'],
  ];
  return visualByName(displayName)??aliases.filter(([pattern])=>pattern.test(displayName)).map(([,name])=>visualByName(name)).find(Boolean)??null;
}

function visualForLocation(locationName,cityName) {
  const candidates=[];
  if(/赌场/.test(locationName))candidates.push('赌场');
  if(/酒馆/.test(locationName))candidates.push('酒馆');
  if(/船坞|造船/.test(locationName))candidates.push('船坞造船厂');
  if(/王宫|皇宫|宫殿|府邸/.test(locationName))candidates.push('王宫贵族府邸','欧洲王城广场');
  if(/码头|港口/.test(locationName))candidates.push(cityName==='威尼斯'?'威尼斯港口':/长安|杭州|泉州|北京/.test(cityName)?'中国海港':/亚丁|巴士拉|开罗/.test(cityName)?'阿拉伯港市':'渔村码头');
  if(/火山/.test(locationName))candidates.push('火山岛');
  if(/沼泽/.test(locationName))candidates.push('沼泽秘境');
  if(/道观|仙山/.test(locationName))candidates.push('道观仙山');
  if(/遗迹|藏宝洞/.test(locationName))candidates.push('古代遗迹地下藏宝洞');
  return candidates.map(visualByName).find(Boolean)??null;
}

function listFormalEncounterActions(view) {
  if(view.combat||view.npc_duel)return [{}];
  const monsters=gameplayCatalog.listMonstersAtMapNode(view.player.current_map_node_canonical_id,view).map((monster)=>{
    const task=view.all_task_chain.find((entry)=>['accepted','in_progress'].includes(entry.runtime.status)&&entry.definition.targets.some((target,index)=>
      target.target_kind==='monster'&&target.entity_canonical_id===monster.canonical_id&&entry.progress[index].current_quantity<entry.progress[index].required_quantity));
    if(monster.encounter_type==='task_exclusive'&&!task)return null;
    return {kind:'monster',monster_canonical_id:monster.canonical_id,display_name:monster.display_name,level:monster.level,
      experience:monster.rewards.experience,copper:monster.rewards.copper,encounter_type:monster.encounter_type,repeatable:monster.repeatable,task};
  }).filter(Boolean);
  const node=catalog.getMapNode(view.player.current_map_node_canonical_id);const placedNpcIds=new Set(catalog.listNpcsAtNode(view.player.current_map_node_canonical_id).map((entry)=>entry.npc_canonical_id));
  const duels=view.all_task_chain.flatMap((entry)=>{
    if(!['accepted','in_progress'].includes(entry.runtime.status)||entry.definition.target_location_canonical_id!==node?.location_canonical_id)return [];
    return entry.definition.targets.map((target,index)=>({target,index})).filter(({target,index})=>target.target_kind==='npc_duel'&&placedNpcIds.has(target.entity_canonical_id)
      &&entry.progress[index].current_quantity<entry.progress[index].required_quantity).map(({target})=>({kind:'npc_duel',npc_canonical_id:target.entity_canonical_id,
        display_name:entityName(target.entity_canonical_id),level:target.npc_duel?.level??entry.definition.level_requirement,task:entry}));
  });
  return [...duels,...monsters];
}

function listFormalVoyages(view) {
  if(view.voyage)return [];
  return content.voyage_routes.filter((route)=>route.from_port_map_node_canonical_id===view.player.current_map_node_canonical_id
    && (!route.required_task_canonical_id||route.allowed_task_statuses.includes(view.tasks[route.required_task_canonical_id]?.status)));
}

function finishVoyage() { let result;while(engine.loadPlayer(PLAYER_ID).voyage)result=voyage.advance(PLAYER_ID,eventId('voyage-advance'));return result; }

function eventId(prefix) { return `${prefix}.${crypto.randomUUID()}`; }
function statusLabel(status) { return ({available:'可接取',accepted:'已接取',in_progress:'进行中',completable:'可以提交',completed:'已完成',locked:'未解锁',blocked:'暂不可运行'})[status] ?? status; }
function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g,(char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function attr(value) { return escapeHtml(value); }

function exposeDebugSurface() {
  window.__zhshBrowserSlice = {
    getState:() => storage?.hasPlayer(PLAYER_ID) ? engine.getPlayerView(PLAYER_ID) : null,
    content:() => content,
    currentPage:() => ({ ...page }),
  };
}

function showFatal(error) {
  console.error(error);
  saveStatus.textContent='启动失败';
  app.innerHTML=`<section class="wap-page"><p><strong>无法启动</strong></p><p class="error">${escapeHtml(error.message)}</p></section>`;
}

importInput.addEventListener('change',async () => {
  const file = importInput.files?.[0];
  if (!file) return;
  try {
    await storage.importPlayer(await file.text(),{ expectedPlayerCanonicalId:PLAYER_ID });
    engine.synchronizeDefinitions(PLAYER_ID);
    await storage.flush();
    gameEntered=true;feedback.succeed('存档导入成功。');saveStatus.textContent='导入结果已保存';showPage('location');
  } catch (error) {
    feedback.fail(`无法导入存档：${error.message}`);saveStatus.textContent='存档导入失败';storage.hasPlayer(PLAYER_ID)?render():renderStart();
  } finally { importInput.value=''; }
});

function exportSave() {
  const blob = new Blob([storage.exportPlayer(PLAYER_ID)],{ type:'application/json' });
  const link = document.createElement('a');
  link.href=URL.createObjectURL(blob);link.download='zhsh-task1-save.json';link.click();URL.revokeObjectURL(link.href);
  saveStatus.textContent='存档 JSON 已导出';
}
