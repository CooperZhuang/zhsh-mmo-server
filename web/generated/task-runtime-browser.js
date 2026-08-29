// Generated from the shared CommonJS task runtime. Do not edit by hand.
const __modules={
"src/task-runtime/browser-entry.js": function(module,exports,require){
'use strict';

const { TaskRuntimeEngine } = require("src/task-runtime/task-engine.js");
const { BrowserTaskCatalog } = require("src/task-runtime/browser-task-catalog.js");
const { BrowserRuntimeStorage,IndexedDbDurableStore,RemoteDurableStore,RemoteCharacterRegistry } = require("src/task-runtime/browser-runtime-storage.js");
const { UiFeedback,buildCityMapEntries } = require("src/task-runtime/classic-ui-model.js");
const { NpcDuelRuntime } = require("src/task-runtime/npc-duel.js");
const { CombatRuntime,DivingRuntime,DropRuntime,DungeonRuntime,EconomyRuntime,EquipmentRuntime,FishingRuntime,FormalGameplayCatalog,ItemRuntime,MaritimeRuntime,RecoveryRuntime,ShipRuntime,VoyageRuntime,effectiveStats } = require("src/task-runtime/formal-gameplay.js");
const { applyExperienceProgression,LEVEL_THRESHOLDS } = require("src/task-runtime/gameplay-state.js");

module.exports = { BrowserRuntimeStorage,BrowserTaskCatalog,CombatRuntime,DivingRuntime,DropRuntime,DungeonRuntime,EconomyRuntime,EquipmentRuntime,FishingRuntime,
    FormalGameplayCatalog,IndexedDbDurableStore,RemoteDurableStore,RemoteCharacterRegistry,NpcDuelRuntime,ItemRuntime,MaritimeRuntime,RecoveryRuntime,ShipRuntime,
  TaskRuntimeEngine,UiFeedback,VoyageRuntime,buildCityMapEntries,effectiveStats,applyExperienceProgression,LEVEL_THRESHOLDS };

},
"src/task-runtime/task-engine.js": function(module,exports,require){
'use strict';
const { recordPlayerMemory, adjustNpcAffinity } = require("server/ai/ai-memory.js");

const EVENT_TYPES = Object.freeze([
  'talk_to_npc',
  'arrive_at_location',
  'defeat_monster',
  'defeat_npc',
  'obtain_item',
  'consume_item',
  'submit_to_npc',
  'abandon_task',
  'fail_task',
]);
const ACTIVE_STATUSES = new Set(['accepted','in_progress','completable']);
const TASK_EVENT_REPLAY_WINDOW=128;
const { assertRuntimeStorage,assertTaskCatalog } = require("src/task-runtime/ports.js");
const { createGameplayState,applyExperienceProgression } = require("src/task-runtime/gameplay-state.js");
const {abandonTaskItems,assertInventoryRemovalAllowed,consumeTaskItems,defaultPolicy,ensureTaskItemLedger,grantInventoryItem,reconcileTaskItemReservations}=require("src/task-runtime/task-item-ledger.js");

class TaskRuntimeEngine {
  constructor({ catalog, storage, seriesCanonicalId = 'task.series.01', seriesCanonicalIds = null, clock = () => new Date().toISOString(), faultInjector = null }) {
    this.catalog = assertTaskCatalog(catalog);
    this.storage = assertRuntimeStorage(storage);
    this.seriesCanonicalIds = [...new Set(seriesCanonicalIds ?? [seriesCanonicalId])];
    this.seriesCanonicalId = this.seriesCanonicalIds[0];
    this.clock = clock;
    this.faultInjector = faultInjector;
  }

  createPlayer(playerCanonicalId, { reset = false } = {}) {
    assertCanonicalId(playerCanonicalId, 'player_canonical_id');
    const state = this.buildInitialState(playerCanonicalId);
    return reset ? this.storage.resetPlayer(playerCanonicalId, state) : this.storage.createPlayer(state);
  }

  buildInitialState(playerCanonicalId) {
    // 静态任务（sqlite task_definitions）进入持久化 state.tasks/state.progress；
    // 动态任务（AI 世界支线）为运行时态，经统一访问方法写入 state.runtime_tasks /
    // state.runtime_progress（JSON 落盘、无 FK 约束），保证完整可玩且不破坏外键。
    const tasks = this.listTasks();
    if (!tasks.length) throw new Error(`Task series is empty: ${this.seriesCanonicalIds.join(',')}`);
    const staticTasks = tasks.filter((task) => !this.isDynamicTask(task.canonical_id));
    const firstLocation = staticTasks[0]?.receive_location_canonical_id;
    const firstNode = this.catalog.getNodeForLocation(firstLocation);
    if (!firstNode) throw new Error(`Initial task location has no map node: ${firstLocation}`);
    const taskStates = {};
    const progress = {};
    for (const task of tasks) {
      if (this.isDynamicTask(task.canonical_id)) continue; // 动态任务在下方单独初始化 runtime_tasks
      const blocked = task.blocking_reasons.length > 0;
      taskStates[task.canonical_id] = {
        status: blocked ? 'blocked' : this.effectivePrerequisiteIds(task).length || Number(task.level_requirement ?? 1) > 1 ? 'locked' : 'available',
        current_step: 0,
        reward_status: 'not_granted',
        block_reasons: task.blocking_reasons,
      };
      for (const target of task.targets) progress[progressKey(task.canonical_id,target.canonical_id)] = 0;
    }
    const now = this.clock();
    const defeatReturn = this.catalog.content?.gameplay_rules?.defeat_return ?? null;
    const state={
      ...createGameplayState({
        canonical_id: playerCanonicalId,
        current_map_node_canonical_id: firstNode.map_node_canonical_id,
        defeat_return_map_node_canonical_id: defeatReturn?.map_node_canonical_id ?? firstNode.map_node_canonical_id,
        money: 0,
        experience: 0,
        created_at: now,
        updated_at: now,
      }),
      unlocked_map_nodes: [firstNode.map_node_canonical_id],
      tasks: taskStates,
      progress,
      inventory: {},
      reward_grants: {},
      flags: {},
      processed_events: {},
      active_series_canonical_id:this.seriesCanonicalId,
    };
    // 动态任务（AI 世界支线）运行时态落 state.runtime_tasks / state.runtime_progress
    const runtimeTasks = {};
    const runtimeProgress = {};
    for (const task of tasks) {
      if (!this.isDynamicTask(task.canonical_id)) continue;
      const blocked = task.blocking_reasons.length > 0;
      runtimeTasks[task.canonical_id] = { status: blocked ? 'blocked' : Number(task.level_requirement ?? 1) > 1 ? 'locked' : 'available',
        current_step: 0, reward_status: 'not_granted', block_reasons: task.blocking_reasons };
      for (const target of task.targets) runtimeProgress[progressKey(task.canonical_id,target.canonical_id)] = 0;
    }
    state.runtime_tasks = runtimeTasks;
    state.runtime_progress = runtimeProgress;
    ensureTaskItemLedger(state);
    return state;
  }

  listTasks() {
    const base = this.seriesCanonicalIds.flatMap((seriesId) => this.catalog.listSeriesTasks(seriesId));
    if (!this.runtimeTasks || this.runtimeTasks.size === 0) return base;
    return [...base, ...this.runtimeTasks.values()].filter((task) => task && task.canonical_id);
  }

  /** 注册一条运行时动态支线（由 AI 生成，符合 getTask 返回形状）。
   *  返回是否注册成功（重复 canonical_id 忽略）。 */
  registerDynamicTask(task) {
    if (!task || !task.canonical_id) return false;
    if (!this.runtimeTasks) this.runtimeTasks = new Map();
    if (this.runtimeTasks.has(task.canonical_id)) return false;
    this.runtimeTasks.set(task.canonical_id, task);
    return true;
  }

  /** 移除一条运行时动态支线（事件消退时清理未接取支线）。返回是否成功移除。 */
  unregisterDynamicTask(taskCanonicalId) {
    if (!this.runtimeTasks) return false;
    return this.runtimeTasks.delete(taskCanonicalId);
  }

  // ---- 统一任务运行时状态访问 ----
  // 静态任务（sqlite task_definitions）运行时态存 state.tasks/state.progress（外键约束）；
  // 动态任务（AI 世界支线）为运行时态、无 sqlite 定义，存 state.runtime_tasks/runtime_progress
  // （JSON 落盘、无 FK）。所有任务逻辑统一走本组方法，动态任务因此完整可接取/推进/完成/持久化。
  isDynamicTask(taskCanonicalId) { return Boolean(this.runtimeTasks?.has(taskCanonicalId)); }
  getTaskRuntime(state, taskCanonicalId) {
    return this.isDynamicTask(taskCanonicalId) ? state.runtime_tasks?.[taskCanonicalId] : state.tasks?.[taskCanonicalId];
  }
  setTaskRuntime(state, taskCanonicalId, value) {
    if (this.isDynamicTask(taskCanonicalId)) { if (!state.runtime_tasks) state.runtime_tasks = {}; state.runtime_tasks[taskCanonicalId] = value; }
    else state.tasks[taskCanonicalId] = value;
  }
  getTaskProgress(state, taskCanonicalId, targetCanonicalId) {
    const key = progressKey(taskCanonicalId, targetCanonicalId);
    return this.isDynamicTask(taskCanonicalId) ? (state.runtime_progress?.[key] ?? 0) : (state.progress?.[key] ?? 0);
  }
  setTaskProgress(state, taskCanonicalId, targetCanonicalId, quantity) {
    const key = progressKey(taskCanonicalId, targetCanonicalId);
    if (this.isDynamicTask(taskCanonicalId)) { if (!state.runtime_progress) state.runtime_progress = {}; state.runtime_progress[key] = quantity; }
    else state.progress[key] = quantity;
  }

  /** 接受一条世界支线（动态任务）：面板入口。返回是否成功接受。 */
  acceptWorldQuest(playerCanonicalId, taskCanonicalId) {
    return this.storage.transact(playerCanonicalId, (state) => {
      const task = this.runtimeTasks?.get(taskCanonicalId);
      if (!task) throw new Error(`Unknown world quest: ${taskCanonicalId}`);
      // 动态任务可能在玩家建档后涌现，接受时懒初始化 runtime 态（保证可接取/推进/持久化）
      let runtime = this.getTaskRuntime(state, taskCanonicalId);
      if (!runtime || !runtime.status) {
        runtime = { status: 'available', current_step: 0, reward_status: 'not_granted', block_reasons: task.blocking_reasons ?? [] };
        this.setTaskRuntime(state, taskCanonicalId, runtime);
        if (!state.runtime_progress) state.runtime_progress = {};
      }
      if (runtime.status !== 'available') return { applied: false, reason: `not_available_${runtime.status}`, task_canonical_id: taskCanonicalId };
      runtime.status = 'accepted';
      runtime.current_step = 1;
      runtime.reward_status = 'not_granted';
      this.setTaskRuntime(state, taskCanonicalId, runtime);
      for (const target of task.targets ?? []) if (target.canonical_id && this.getTaskProgress(state, taskCanonicalId, target.canonical_id) === 0) this.setTaskProgress(state, taskCanonicalId, target.canonical_id, 0);
      return { applied: true, action: 'world_quest_accepted', task_canonical_id: taskCanonicalId };
    });
  }

  /** 提交一条已完成的世界支线（动态任务）：面板入口。返回是否成功提交。 */
  submitWorldQuest(playerCanonicalId, taskCanonicalId) {
    return this.storage.transact(playerCanonicalId, (state) => {
      const task = this.runtimeTasks?.get(taskCanonicalId);
      if (!task) throw new Error(`Unknown world quest: ${taskCanonicalId}`);
      const runtime = this.getTaskRuntime(state, taskCanonicalId);
      if (!runtime) { throw new Error(`World quest not initialized: ${taskCanonicalId}`); }
      if (runtime.status !== 'completable' && runtime.status !== 'accepted' && runtime.status !== 'in_progress') {
        return { applied: false, reason: `not_completable_${runtime.status}`, task_canonical_id: taskCanonicalId };
      }
      if (runtime.status !== 'completable') {
        const done = task.targets.every((target) => this.getTaskProgress(state, taskCanonicalId, target.canonical_id) >= (target.required_quantity ?? 1));
        if (!done) return { applied: false, reason: 'targets_not_done', task_canonical_id: taskCanonicalId };
      }
      // 奖励发放：动态任务不写 state.reward_grants（其 reward 无 sqlite task_rewards 行，避免外键崩）
      for (const reward of task.rewards ?? []) {
        const qty = Number(reward.quantity ?? 0);
        if (reward.reward_kind === 'experience') state.player.experience += qty;
        else if (reward.reward_kind === 'money') state.player.money += qty;
      }
      applyExperienceProgression(state);
      runtime.status = 'completed';
      runtime.current_step = 3;
      runtime.reward_status = 'granted';
      this.setTaskRuntime(state, taskCanonicalId, runtime);
      recordPlayerMemory(state, { type: 'worldquest', text: `完成了世界支线「${task.display_name ?? taskCanonicalId}」`, importance: 2 });
      return { applied: true, action: 'world_quest_submitted', task_canonical_id: taskCanonicalId, rewards: task.rewards?.map((r) => r.reward_name ?? r.reward_kind) };
    });
  }

  synchronizeDefinitions(playerCanonicalId) {
    return this.storage.transact(playerCanonicalId,(state) => {
      const added=[];
      const defeatReturn=this.catalog.content?.gameplay_rules?.defeat_return;
      if(!state.player.defeat_return_map_node_canonical_id&&defeatReturn?.map_node_canonical_id)state.player.defeat_return_map_node_canonical_id=defeatReturn.map_node_canonical_id;
      for (const task of this.listTasks()) {
        if (this.isDynamicTask(task.canonical_id)) {
          // 动态任务：运行时态写 state.runtime_tasks / runtime_progress（JSON，无 FK）
          if (!this.getTaskRuntime(state, task.canonical_id)) {
            const blocked=task.blocking_reasons.length>0;
            this.setTaskRuntime(state, task.canonical_id, { status:blocked?'blocked':Number(task.level_requirement??1)>Number(state.player.level)?'locked':'available',
              current_step:0,reward_status:'not_granted',block_reasons:task.blocking_reasons });
          }
          for (const target of task.targets) if (!Object.hasOwn(state.runtime_progress??{}, progressKey(task.canonical_id,target.canonical_id))) this.setTaskProgress(state, task.canonical_id, target.canonical_id, 0);
          continue;
        }
        if (!state.tasks[task.canonical_id]) {
          const blocked=task.blocking_reasons.length>0;
          state.tasks[task.canonical_id]={ status:blocked?'blocked':this.effectivePrerequisiteIds(task).length||Number(task.level_requirement??1)>Number(state.player.level)?'locked':'available',
            current_step:0,reward_status:'not_granted',block_reasons:task.blocking_reasons };
          added.push(task.canonical_id);
        }
        for (const target of task.targets) {
          const key=progressKey(task.canonical_id,target.canonical_id);
          if (!Object.hasOwn(state.progress,key)) state.progress[key]=0;
        }
      }
      if (!this.seriesCanonicalIds.includes(state.active_series_canonical_id)) state.active_series_canonical_id=this.seriesCanonicalId;
      this.refreshLevelAvailabilityState(state);
      return { applied:added.length>0,action:'definitions_synchronized',added_task_canonical_ids:added };
    });
  }

  selectSeries(playerCanonicalId,seriesCanonicalId,eventId) {
    if (!this.seriesCanonicalIds.includes(seriesCanonicalId)) throw new Error(`Series is not included in this runtime: ${seriesCanonicalId}`);
    return transactSelection(this.storage,playerCanonicalId,eventId,seriesCanonicalId,this.clock);
  }

  loadPlayer(playerCanonicalId) {
    return this.storage.loadPlayer(playerCanonicalId);
  }

  getPlayerView(playerCanonicalId,seriesCanonicalId = null) {
    const state = this.loadPlayer(playerCanonicalId);
    const node = this.catalog.getMapNode(state.player.current_map_node_canonical_id);
    const activeSeries=seriesCanonicalId ?? state.active_series_canonical_id ?? this.seriesCanonicalId;
    const project=(task) => ({
      definition: task,
      runtime: this.getTaskRuntime(state, task.canonical_id),
      progress: task.targets.map((target) => ({
        target_canonical_id: target.canonical_id,
        current_quantity: this.getTaskProgress(state, task.canonical_id, target.canonical_id),
        required_quantity: target.required_quantity,
      })),
    });
    const allTasks=this.listTasks().filter((task)=>!this.isDynamicTask(task.canonical_id)).map(project);
    const tasks=allTasks.filter((entry)=>seriesOf(entry.definition)===activeSeries);
    return { ...state,current_location:node,active_series_canonical_id:activeSeries,
      task_series:this.seriesCanonicalIds.map((id)=>({ canonical_id:id,total:this.catalog.listSeriesTasks(id).length,
        completed:this.catalog.listSeriesTasks(id).filter((task)=>this.getTaskRuntime(state,task.canonical_id)?.status==='completed').length })),
      all_task_chain:allTasks,task_chain:tasks };
  }

  getCurrentLocation(playerCanonicalId) {
    const state = this.loadPlayer(playerCanonicalId);
    return this.catalog.getMapNode(state.player.current_map_node_canonical_id);
  }

  listAdjacentLocations(playerCanonicalId) {
    const state = this.loadPlayer(playerCanonicalId);
    return this.catalog.listAdjacentNodes(state.player.current_map_node_canonical_id);
  }

  listCurrentNpcs(playerCanonicalId) {
    const state = this.loadPlayer(playerCanonicalId);
    return this.catalog.listNpcsAtNode(state.player.current_map_node_canonical_id).filter((placement)=>this.isNpcPlacementVisible(state,placement))
      .map((placement)=>({ ...placement,npc_dialogue:this.renderNpcDialogue(state,placement.npc_canonical_id,placement.display_name) }));
  }

  /** 注入 npc_dialogs 内容（来自 server/content/npc-dialogs.json） */
  attachNpcDialogs(npcDialogs = {}) { this.npcDialogs = npcDialogs; return this; }

  /**
   * 判定该 NPC 的对话触发档：quest_ready > quest_active > all_done > idle。
   * 依据：NPC 作为任务的 issuer/completion，关联任务状态。
   */
  renderNpcDialogue(state,npcCanonicalId,npcName = null) {
    const dialogs = this.npcDialogs?.dialogs ?? {};
    const entry = dialogs[npcName] ?? dialogs[`npc.${npcCanonicalId.split('.').at(-1)}`] ?? dialogs[npcCanonicalId] ?? null;
    if (!entry) return null;
    const tasks = this.listTasks();
    let hasActive = false, hasReady = false, hasAny = false;
    for (const task of tasks) {
      const issuer = task.issuer_npc_canonical_id, completion = task.completion_npc_canonical_id;
      const roleNpc = issuer === npcCanonicalId || completion === npcCanonicalId;
      if (!roleNpc && !task.issuer_npc_canonical_id?.endsWith(npcCanonicalId.split('.').at(-1))) continue;
      const status = this.getTaskRuntime(state, task.canonical_id)?.status;
      if (['accepted','in_progress'].includes(status)) hasActive = true;
      if (status === 'completable') hasReady = true;
      if (['accepted','in_progress','completable','completed'].includes(status)) hasAny = true;
      if (issuer === npcCanonicalId && status === 'completed') hasAny = true;
    }
    if (hasReady) return { trigger_type:'quest_ready',text:entry.quest_ready };
    if (hasActive) return { trigger_type:'quest_active',text:entry.quest_active };
    if (hasAny) return { trigger_type:'all_done',text:entry.all_done };
    return { trigger_type:'idle',text:entry.idle };
  }

  isNpcPlacementVisible(state,placement) {
    if(placement.placement_scope!=='task_context')return true;
    return (placement.task_contexts??[]).some((context)=>context.appearance_statuses.includes(this.getTaskRuntime(state,context.task_canonical_id)?.status));
  }

  isNpcAvailableAtLocation(state,npcCanonicalId,locationCanonicalId) {
    const node=this.catalog.getNodeForLocation(locationCanonicalId);
    return node&&this.catalog.listNpcsAtNode(node.map_node_canonical_id)
      .some((placement)=>placement.npc_canonical_id===npcCanonicalId&&this.isNpcPlacementVisible(state,placement));
  }

  synchronizeInventory(playerCanonicalId) {
    return this.storage.transact(playerCanonicalId,(state) => {
      const changes=[];
      reconcileTaskItemReservations(state,this.activeTasks(state));
      for (const task of this.activeTasks(state)) changes.push(...this.syncItemTargets(state,task));
      return { applied:changes.length>0,action:'inventory_synchronized',changes };
    });
  }

  refreshAvailability(playerCanonicalId) {
    return this.storage.transact(playerCanonicalId,(state) => ({ action:'availability_refreshed',unlocked:this.refreshLevelAvailabilityState(state) }));
  }

  move(playerCanonicalId, destinationCanonicalId, eventId) {
    assertCanonicalId(destinationCanonicalId, 'destination_canonical_id');
    return this.storage.transact(playerCanonicalId, (state) => {
      const event = { event_id: eventId, type: 'arrive_at_location', destination_canonical_id: destinationCanonicalId };
      const repeated = this.getRepeatedEvent(state,event);
      if (repeated) return repeated;
      const neighbors = this.catalog.listAdjacentNodes(state.player.current_map_node_canonical_id);
      const destination = neighbors.find((node) => node.map_node_canonical_id === destinationCanonicalId
        || node.location_canonical_id === destinationCanonicalId);
      if (!destination) throw new Error(`Destination is not connected to current map node: ${destinationCanonicalId}`);
      state.player.current_map_node_canonical_id = destination.map_node_canonical_id;
      unlockNode(state,destination.map_node_canonical_id);
      const result = this.advanceLocationTargets(state,destination.location_canonical_id);
      result.movement_connection_canonical_id = destination.connection_canonical_id;
      result.current_map_node_canonical_id = destination.map_node_canonical_id;
      this.finishEvent(state,event,result);
      return result;
    });
  }

  travelToCityPort(playerCanonicalId,destinationCanonicalId,eventId) {
    assertCanonicalId(destinationCanonicalId,'destination_canonical_id');
    return this.storage.transact(playerCanonicalId,(state)=>{
      const event={ event_id:eventId,type:'arrive_at_location',destination_canonical_id:destinationCanonicalId,movement_mode:'cross_city_port' };
      const repeated=this.getRepeatedEvent(state,event);if(repeated)return repeated;
      if(state.combat||state.npc_duel||state.voyage||state.fishing||state.dungeon||state.maritime_encounter)throw new Error('Cross-city movement requires an idle world state');
      const current=this.catalog.getMapNode(state.player.current_map_node_canonical_id);
      const destination=this.catalog.getMapNode(destinationCanonicalId);
      if(!current||current.display_name!=='码头')throw new Error('Cross-city movement must start at the current city port');
      if(!destination||destination.display_name!=='码头'||!destination.location_canonical_id)throw new Error('Cross-city destination must be a formal city port');
      if(current.city_canonical_id===destination.city_canonical_id)throw new Error('Cross-city destination must be another city');
      state.player.current_map_node_canonical_id=destination.map_node_canonical_id;unlockNode(state,destination.map_node_canonical_id);
      const result=this.advanceLocationTargets(state,destination.location_canonical_id);
      result.movement_mode='cross_city_port';result.source_city_canonical_id=current.city_canonical_id;result.destination_city_canonical_id=destination.city_canonical_id;
      result.current_map_node_canonical_id=destination.map_node_canonical_id;this.finishEvent(state,event,result);return result;
    });
  }

  fastTravelToLocation(playerCanonicalId,locationCanonicalId,eventId) {
    assertCanonicalId(locationCanonicalId,'location_canonical_id');
    return this.storage.transact(playerCanonicalId,(state)=>{
      const event={ event_id:eventId,type:'arrive_at_location',location_canonical_id:locationCanonicalId,movement_mode:'fast_travel' };
      const repeated=this.getRepeatedEvent(state,event);if(repeated)return repeated;
      if(state.combat||state.npc_duel||state.voyage||state.fishing||state.dungeon||state.maritime_encounter)throw new Error('Fast travel requires an idle world state');
      const current=this.catalog.getMapNode(state.player.current_map_node_canonical_id);
      const destination=this.catalog.getNodeForLocation(locationCanonicalId);
      if(!destination||!destination.map_node_canonical_id)throw new Error(`Fast travel destination has no map node: ${locationCanonicalId}`);
      if(!destination.location_canonical_id)throw new Error('Fast travel destination must be a formal location');
      if(current?.city_canonical_id!==destination.city_canonical_id)throw new Error('Fast travel must stay within the current city');
      state.player.current_map_node_canonical_id=destination.map_node_canonical_id;unlockNode(state,destination.map_node_canonical_id);
      const result=this.advanceLocationTargets(state,destination.location_canonical_id);
      result.movement_mode='fast_travel';result.source_map_node_canonical_id=current?.map_node_canonical_id??null;result.destination_city_canonical_id=destination.city_canonical_id;
      result.current_map_node_canonical_id=destination.map_node_canonical_id;this.finishEvent(state,event,result);return result;
    });
  }

  processEvent(playerCanonicalId, event) {
    validateEvent(event);
    return this.storage.transact(playerCanonicalId, (state) => {
      const repeated = this.getRepeatedEvent(state,event);
      if (repeated) return repeated;
      let result;
      switch (event.type) {
        case 'talk_to_npc': result = this.handleTalk(state,event); break;
        case 'arrive_at_location': result = this.handleExternalArrival(state,event); break;
        case 'defeat_monster': result = this.handleDefeat(state,event); break;
        case 'defeat_npc': result = this.handleNpcDefeat(state,event); break;
        case 'obtain_item': result = this.handleObtain(state,event); break;
        case 'consume_item': result = this.handleConsume(state,event); break;
        case 'submit_to_npc': result = this.handleSubmit(state,event); break;
        case 'abandon_task': result = this.handleAbandon(state,event,'abandoned'); break;
        case 'fail_task': result = this.handleAbandon(state,event,'failed'); break;
        default: throw new Error(`Unsupported event type: ${event.type}`);
      }
      this.injectFault('before_event_commit',{ state,event,result });
      this.finishEvent(state,event,result);
      return result;
    });
  }

  getRepeatedEvent(state,event) {
    const stored = state.processed_events[event.event_id];
    if (!stored) return null;
    if (stored.event_type !== event.type || stableJson(stored.payload) !== stableJson(event)) {
      throw new Error(`Event id collision with different payload: ${event.event_id}`);
    }
    return { ...stored.result, idempotent_replay: true };
  }

  finishEvent(state,event,result) {
    const now = this.clock();
    state.player.updated_at = now;
    state.processed_events[event.event_id] = {
      event_type: event.type,
      payload: event,
      result,
      processed_at: now,
    };
    const processedEventIds=Object.keys(state.processed_events);
    for(const eventId of processedEventIds.slice(0,Math.max(0,processedEventIds.length-TASK_EVENT_REPLAY_WINDOW)))delete state.processed_events[eventId];
  }

  handleExternalArrival(state,event) {
    const node = this.catalog.getNodeForLocation(event.location_canonical_id);
    if (!node) throw new Error(`Unknown formal location: ${event.location_canonical_id}`);
    state.player.current_map_node_canonical_id = node.map_node_canonical_id;
    unlockNode(state,node.map_node_canonical_id);
    return {
      ...this.advanceLocationTargets(state,event.location_canonical_id),
      current_map_node_canonical_id: node.map_node_canonical_id,
      external_arrival: true,
    };
  }

  handleTalk(state,event) {
    const locationId = this.assertEventAtCurrentLocation(state,event.location_canonical_id);
    if (!this.isNpcAvailableAtLocation(state,event.npc_canonical_id,locationId)) {
      throw new Error(`NPC is not at the current formal location: ${event.npc_canonical_id}`);
    }
    const active = this.activeTasks(state);
    for (const task of active) {
      const target = task.targets.find((entry) => entry.target_kind === 'npc' && entry.entity_canonical_id === event.npc_canonical_id);
      if (target) {
        adjustNpcAffinity(state, event.npc_canonical_id, 1, `与任务NPC交谈`);
        return this.advanceTarget(state,task,target,1,'talk_to_npc');
      }
    }
    const available = this.listTasks().sort((a,b)=>Number(seriesOf(b)===state.active_series_canonical_id)-Number(seriesOf(a)===state.active_series_canonical_id)).find((task) => {
      const runtime = this.getTaskRuntime(state, task.canonical_id);
      return runtime?.status === 'available' && task.issuer_npc_canonical_id === event.npc_canonical_id
        && task.receive_location_canonical_id === locationId;
    });
    if (!available) return { applied: false, reason: 'no_task_action_for_npc', npc_canonical_id: event.npc_canonical_id };
    const acceptRuntime = this.getTaskRuntime(state, available.canonical_id);
    acceptRuntime.status = 'accepted';
    acceptRuntime.current_step = 1;
    this.setTaskRuntime(state, available.canonical_id, acceptRuntime);
    adjustNpcAffinity(state, event.npc_canonical_id, 2, `接受了任务「${available.display_name??available.canonical_id}」`);
    const generatedItems = [];
    for (const target of available.targets.filter((entry) => entry.target_kind === 'item')) {
      const policy=target.task_item_policy??defaultPolicy(available);
      if(policy.acquisition_mode==='grant_on_accept'){
        const grant=grantInventoryItem(state,{itemCanonicalId:target.entity_canonical_id,quantity:target.required_quantity,
          grantId:`accept:${available.canonical_id}:${target.canonical_id}`,sourceKind:'task_acceptance',targetTaskCanonicalId:available.canonical_id,generatedOnAccept:true});
        generatedItems.push({item_canonical_id:grant.item_canonical_id,quantity:grant.quantity});
      }
    }
    reconcileTaskItemReservations(state,this.activeTasks(state));
    if (available.targets.some((target) => target.target_kind === 'item')) this.syncItemTargets(state,available);
    return {
      applied: true,
      action: 'accepted',
      task_canonical_id: available.canonical_id,
      dialogue_canonical_ids: available.dialogues.filter((line) => line.phase === 'receive').map((line) => line.canonical_id),
      generated_task_items: generatedItems,
    };
  }

  handleDefeat(state,event) {
    const locationId = this.assertEventAtCurrentLocation(state,event.location_canonical_id);
    const quantity = positiveInteger(event.quantity ?? 1,'quantity');
    if (!this.catalog.isMonsterAtLocation(event.monster_canonical_id,locationId)) {
      throw new Error(`Monster is not defined at the current formal location: ${event.monster_canonical_id}`);
    }
    const changes = [];
    for (const task of this.activeTasks(state)) {
      if (task.target_location_canonical_id && task.target_location_canonical_id !== locationId) continue;
      for (const target of task.targets.filter((entry) => entry.target_kind === 'monster'
        && entry.entity_canonical_id === event.monster_canonical_id)) {
        changes.push(this.advanceTarget(state,task,target,quantity,'defeat_monster'));
      }
    }
    return { applied: changes.length > 0, action: 'progress', changes };
  }

  handleNpcDefeat(state,event) {
    const locationId=this.assertEventAtCurrentLocation(state,event.location_canonical_id);
    const quantity=positiveInteger(event.quantity??1,'quantity');
    if(!this.isNpcAvailableAtLocation(state,event.npc_canonical_id,locationId))throw new Error(`NPC duel target is not at the current formal location: ${event.npc_canonical_id}`);
    const changes=[];
    for(const task of this.activeTasks(state)){
      if(task.target_location_canonical_id&&task.target_location_canonical_id!==locationId)continue;
      for(const target of task.targets.filter((entry)=>entry.target_kind==='npc_duel'&&entry.entity_canonical_id===event.npc_canonical_id))
        changes.push(this.advanceTarget(state,task,target,quantity,'defeat_npc'));
    }
    return {applied:changes.length>0,action:'npc_duel_progress',changes};
  }

  handleObtain(state,event) {
    const quantity = positiveInteger(event.quantity ?? 1,'quantity');
    assertCanonicalId(event.item_canonical_id,'item_canonical_id');
    if (!this.catalog.hasContentEntity(event.item_canonical_id)) throw new Error(`Unknown formal item: ${event.item_canonical_id}`);
    if (event.location_canonical_id) this.assertEventAtCurrentLocation(state,event.location_canonical_id);
    grantInventoryItem(state,{itemCanonicalId:event.item_canonical_id,quantity,grantId:`obtain:${event.event_id}`,sourceKind:'gameplay_obtain'});
    const changes = [];
    for (const task of this.activeTasks(state)) changes.push(...this.syncItemTargets(state,task,event.item_canonical_id));
    return { applied: true, action: 'inventory_obtained', item_canonical_id: event.item_canonical_id, quantity, changes };
  }

  handleConsume(state,event) {
    const quantity = positiveInteger(event.quantity ?? 1,'quantity');
    assertCanonicalId(event.item_canonical_id,'item_canonical_id');
    if (event.location_canonical_id) this.assertEventAtCurrentLocation(state,event.location_canonical_id);
    const existing = state.inventory[event.item_canonical_id] ?? 0;
    if (existing < quantity) throw new Error(`Insufficient item quantity: ${event.item_canonical_id}`);
    assertInventoryRemovalAllowed(state,event.item_canonical_id,quantity,{reason:'task_consume_event'});
    setInventory(state,event.item_canonical_id,existing - quantity);
    const changes = [];
    for (const task of this.activeTasks(state)) changes.push(...this.syncItemTargets(state,task,event.item_canonical_id));
    return { applied: true, action: 'inventory_consumed', item_canonical_id: event.item_canonical_id, quantity, changes };
  }

  handleSubmit(state,event) {
    const locationId = this.assertEventAtCurrentLocation(state,event.location_canonical_id);
    if (!this.isNpcAvailableAtLocation(state,event.npc_canonical_id,locationId)) {
      throw new Error(`Submission NPC is not at the current formal location: ${event.npc_canonical_id}`);
    }
    const task = this.listTasks().sort((a,b)=>Number(seriesOf(b)===state.active_series_canonical_id)-Number(seriesOf(a)===state.active_series_canonical_id)).find((entry) => {
      const runtime = this.getTaskRuntime(state, entry.canonical_id);
      return runtime?.status === 'completable' && entry.completion_npc_canonical_id === event.npc_canonical_id
        && entry.submit_location_canonical_id === locationId;
    });
    if (!task) return { applied: false, reason: 'no_completable_task_for_npc', npc_canonical_id: event.npc_canonical_id };
    reconcileTaskItemReservations(state,this.activeTasks(state));
    const taskItemConsumption=consumeTaskItems(state,task,`submit:${event.event_id}:${task.canonical_id}`);
    this.injectFault('after_task_item_consumption',{ state,event,task,taskItemConsumption });
    const isDynamic = this.isDynamicTask(task.canonical_id);
    let sourceLabelOnly = false;
    for (const reward of task.rewards) {
      // 动态任务奖励不写 state.reward_grants（其 reward 无 sqlite task_rewards 行，写库会外键崩）
      if (!isDynamic && state.reward_grants[reward.canonical_id]) continue;
      let effectStatus = 'applied';
      const reputationValue = reward.reward_name === '声望' || /\b声望\b/.test(reward.raw_value_json ?? '');
      if (reputationValue) {
        // 声望奖励：计入玩家声誉并晋升爵位
        state.player.reputation = (state.player.reputation ?? 0) + Number(reward.quantity ?? 0);
        state.player.title = applyReputationTitle(state.player.reputation);
        effectStatus = 'applied';
      } else if (reward.reward_kind === 'experience') state.player.experience += reward.quantity;
      else if (reward.reward_kind === 'money') state.player.money += reward.quantity;
      else if (reward.content_entity_canonical_id && reward.resolution_status === 'resolved') {
        grantInventoryItem(state,{itemCanonicalId:reward.content_entity_canonical_id,quantity:reward.quantity,grantId:`reward:${reward.canonical_id}`,
          sourceKind:'task_reward',sourceTaskCanonicalId:task.canonical_id});
      } else if (reward.resolution_status === 'source_label_only') {
        effectStatus = 'recorded_source_label_only';
        sourceLabelOnly = true;
      } else {
        throw new Error(`Unresolved reward cannot be granted: ${reward.canonical_id} (${reward.resolution_status})`);
      }
      if (!isDynamic) {
        state.reward_grants[reward.canonical_id] = {
          task_canonical_id: task.canonical_id,
          quantity: reward.quantity,
          effect_status: effectStatus,
        };
      }
    }
    this.injectFault('after_reward_grants',{ state,event,task });
    const runtime = this.getTaskRuntime(state, task.canonical_id);
    runtime.status = 'completed';
    runtime.current_step = 3;
    runtime.reward_status = sourceLabelOnly ? 'granted_with_source_label_records' : 'granted';
    this.setTaskRuntime(state, task.canonical_id, runtime);
    const progression = applyExperienceProgression(state);
    // 声望填实：完成任一任务 +5 声望，晋升爵位（水手/船长/提督/总督/公爵）
    const levelUnlocked = this.refreshLevelAvailabilityState(state);
    state.flags[`task.completed.${task.canonical_id}`] = true;
    recordPlayerMemory(state,{type:'task',text:`完成了「${task.display_name??task.canonical_id}」`,importance:2});
    if (this.catalog.getTask(task.canonical_id)?.is_mainline) recordPlayerMemory(state,{type:'mainline',text:`推进主线：${task.display_name??task.canonical_id}`,importance:3});
    reconcileTaskItemReservations(state,this.activeTasks(state));
    const unlocked = [];
    for (const successorId of task.successors) {
      const successor = this.catalog.getTask(successorId);
      const successorRuntime = this.getTaskRuntime(state, successorId);
      if (!successorRuntime || successorRuntime.status === 'blocked') continue;
      if (Number(state.player.level) < Number(successor.level_requirement ?? 1)) continue;
      if (this.prerequisitesSatisfied(state,successor)) {
        successorRuntime.status = 'available';
        this.setTaskRuntime(state, successorId, successorRuntime);
        unlocked.push(successorId);
      }
    }
    return {
      applied: true,
      action: 'completed',
      task_canonical_id: task.canonical_id,
      unlocked_task_canonical_ids: unlocked,
      dialogue_canonical_ids: task.dialogues.filter((line) => line.phase === 'submit').map((line) => line.canonical_id),
      reward_status: runtime.reward_status,
      rewards: task.rewards.map((r) => ({
        reward_name: r.reward_name, reward_kind: r.reward_kind, quantity: r.quantity,
        effect_status: state.reward_grants[r.canonical_id]?.effect_status ?? 'applied',
      })),
      reputation: state.player.reputation,
      progression,
      level_unlocked_task_canonical_ids:levelUnlocked,
    };
  }

  handleAbandon(state,event,outcome) {
    const task=this.catalog.getTask(event.task_canonical_id);const runtime=this.getTaskRuntime(state,event.task_canonical_id);
    if(!task||!runtime)throw new Error(`Unknown task: ${event.task_canonical_id}`);
    if(!ACTIVE_STATUSES.has(runtime.status))return {applied:false,reason:'task_not_active',task_canonical_id:task.canonical_id,status:runtime.status};
    const itemResult=abandonTaskItems(state,task,`${outcome}:${event.event_id}:${task.canonical_id}`);
    for(const target of task.targets)this.setTaskProgress(state,task.canonical_id,target.canonical_id,0);
    runtime.status=this.prerequisitesSatisfied(state,task)&&Number(state.player.level)>=Number(task.level_requirement??1)?'available':'locked';
    runtime.current_step=0;runtime.reward_status='not_granted';
    this.setTaskRuntime(state,task.canonical_id,runtime);
    reconcileTaskItemReservations(state,this.activeTasks(state));
    return {applied:true,action:`task_${outcome}`,task_canonical_id:task.canonical_id,item_ledger:itemResult,next_status:runtime.status};
  }

  advanceLocationTargets(state,locationCanonicalId) {
    const changes = [];
    if (locationCanonicalId) {
      for (const task of this.activeTasks(state)) {
        for (const target of task.targets.filter((entry) => entry.target_kind === 'location'
          && entry.entity_canonical_id === locationCanonicalId)) {
          changes.push(this.advanceTarget(state,task,target,1,'arrive_at_location'));
        }
      }
    }
    return { applied: changes.length > 0, action: 'arrived', location_canonical_id: locationCanonicalId, changes };
  }

  advanceTarget(state,task,target,quantity,eventType) {
    const before = this.getTaskProgress(state,task.canonical_id,target.canonical_id);
    const after = Math.min(target.required_quantity,before + quantity);
    this.setTaskProgress(state,task.canonical_id,target.canonical_id,after);
    this.refreshTaskProgressState(state,task);
    return {
      applied: after !== before,
      event_type: eventType,
      task_canonical_id: task.canonical_id,
      target_canonical_id: target.canonical_id,
      before,
      after,
      required: target.required_quantity,
      status: this.getTaskRuntime(state,task.canonical_id)?.status,
    };
  }

  /** 统计任务物品目标在背包中的数量。同一实物可能被内容库解析为多个实体副本
   *  (candidate_canonical_ids 与 entity_canonical_id 不同)，进度应累计候选集总量，
   *  否则玩家买到正确的物品(任一候选实体)却因 id 不同而永不达标。 */
  itemTargetQuantity(state, target) {
    const candidates = new Set([target.entity_canonical_id, ...(target.candidate_canonical_ids ?? [])].filter(Boolean));
    let total = 0;
    for (const id of candidates) total += Number(state.inventory?.[id] ?? 0);
    return total;
  }

  syncItemTargets(state,task,onlyItemId = null) {
    const changes = [];
    for (const target of task.targets.filter((entry) => entry.target_kind === 'item'
      && (!onlyItemId || entry.entity_canonical_id === onlyItemId || (target.candidate_canonical_ids ?? []).includes(onlyItemId)))) {
      const before = this.getTaskProgress(state,task.canonical_id,target.canonical_id);
      const after = Math.min(target.required_quantity,this.itemTargetQuantity(state,target));
      this.setTaskProgress(state,task.canonical_id,target.canonical_id,after);
      if (after !== before) changes.push({ task_canonical_id: task.canonical_id,target_canonical_id: target.canonical_id,before,after,required: target.required_quantity });
    }
    this.refreshTaskProgressState(state,task);
    return changes;
  }

  refreshTaskProgressState(state,task) {
    const runtime = this.getTaskRuntime(state,task.canonical_id);
    if (!runtime || !ACTIVE_STATUSES.has(runtime.status)) return;
    const complete = task.targets.every((target) => this.getTaskProgress(state,task.canonical_id,target.canonical_id) >= target.required_quantity);
    runtime.status = complete ? 'completable' : 'in_progress';
    runtime.current_step = complete ? 3 : 2;
    this.setTaskRuntime(state,task.canonical_id,runtime);
  }

  activeTasks(state) {
    return this.listTasks().filter((task) => ACTIVE_STATUSES.has(this.getTaskRuntime(state,task.canonical_id)?.status));
  }

  effectivePrerequisiteIds(task,seen=new Set()) {
    const result=[];
    for(const prerequisiteId of task.prerequisites??[]){
      if(seen.has(prerequisiteId))throw new Error(`Task prerequisite cycle detected at ${prerequisiteId}`);
      const prerequisite=this.catalog.getTask(prerequisiteId);
      if(prerequisite?.directory_status==='data_conflict'){
        const branchSeen=new Set(seen);branchSeen.add(prerequisiteId);
        result.push(...this.effectivePrerequisiteIds(prerequisite,branchSeen));
      }else result.push(prerequisiteId);
    }
    return [...new Set(result)];
  }

  prerequisitesSatisfied(state,task) {
    return this.effectivePrerequisiteIds(task).every((id)=>this.getTaskRuntime(state,id)?.status==='completed');
  }

  refreshLevelAvailabilityState(state) {
    const unlocked=[];
    for (const task of this.listTasks()) {
      if (this.isDynamicTask(task.canonical_id)) continue; // 动态任务无等级槽位，不应因升级刷新
      const runtime=state.tasks[task.canonical_id];
      if (runtime?.status!=='locked' || Number(state.player.level)<Number(task.level_requirement ?? 1)) continue;
      if (!this.prerequisitesSatisfied(state,task)) continue;
      runtime.status='available';unlocked.push(task.canonical_id);
    }
    return unlocked;
  }

  assertEventAtCurrentLocation(state,locationCanonicalId) {
    assertCanonicalId(locationCanonicalId,'location_canonical_id');
    const current = this.catalog.getMapNode(state.player.current_map_node_canonical_id);
    if (!current?.location_canonical_id || current.location_canonical_id !== locationCanonicalId) {
      throw new Error(`Event location does not match current formal location: ${locationCanonicalId}`);
    }
    return locationCanonicalId;
  }

  injectFault(stage,context) {
    if (this.faultInjector) this.faultInjector(stage,context);
  }
}

function validateEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('Event object is required');
  if (!EVENT_TYPES.includes(event.type)) throw new Error(`Unsupported event type: ${event.type}`);
  if (!event.event_id || typeof event.event_id !== 'string') throw new Error('Event requires event_id');
  const canonicalField = {
    talk_to_npc: 'npc_canonical_id',
    arrive_at_location: 'location_canonical_id',
    defeat_monster: 'monster_canonical_id',
    defeat_npc: 'npc_canonical_id',
    obtain_item: 'item_canonical_id',
    consume_item: 'item_canonical_id',
    submit_to_npc: 'npc_canonical_id',
    abandon_task: 'task_canonical_id',
    fail_task: 'task_canonical_id',
  }[event.type];
  assertCanonicalId(event[canonicalField],canonicalField);
}

function assertCanonicalId(value,field) {
  if (typeof value !== 'string' || !value.includes('.')) throw new Error(`${field} must be a canonical_id`);
}

function positiveInteger(value,field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${field} must be a positive integer`);
  return number;
}

function applyReputationTitle(reputation) {
  const rep=Number(reputation??0);
  if (rep>=50000) return '公爵';
  if (rep>=20000) return '总督';
  if (rep>=5000) return '提督';
  if (rep>=1000) return '船长';
  return '水手';
}
function progressKey(taskId,targetId) {
  return `${taskId}|${targetId}`;
}

function seriesOf(task) {
  return task.series_canonical_id ?? task.canonical_id.match(/^task\.series\.\d+/)?.[0] ?? null;
}

function transactSelection(storage,playerId,eventId,seriesCanonicalId,clock) {
  if (!eventId || typeof eventId!=='string') throw new Error('Series selection requires event_id');
  return storage.transact(playerId,(state)=>{
    const prior=state.gameplay_events[eventId];const payload={ series_canonical_id:seriesCanonicalId };
    if(prior){if(prior.event_type!=='series_select'||stableJson(prior.payload)!==stableJson(payload))throw new Error(`Gameplay event id collision: ${eventId}`);return{...prior.result,idempotent_replay:true};}
    state.active_series_canonical_id=seriesCanonicalId;
    const result={ applied:true,action:'series_selected',series_canonical_id:seriesCanonicalId };
    state.gameplay_events[eventId]={event_type:'series_select',payload,result,processed_at:clock()};
    const gameplayEventIds=Object.keys(state.gameplay_events);let excess=Math.max(0,gameplayEventIds.length-TASK_EVENT_REPLAY_WINDOW);
    for(const id of gameplayEventIds){if(excess<=0)break;const event=state.gameplay_events[id];if((Array.isArray(event?.result?.stamina_items)?event.result.stamina_items:[event?.result?.stamina_item]).some((entry)=>entry?.applied)||event?.result?.action==='stamina_item_auto_used')continue;delete state.gameplay_events[id];excess-=1;}
    return result;
  });
}

function setInventory(state,itemId,quantity) {
  if (quantity === 0) delete state.inventory[itemId];
  else state.inventory[itemId] = quantity;
}

function unlockNode(state,nodeId) {
  if (!state.unlocked_map_nodes.includes(nodeId)) state.unlocked_map_nodes.push(nodeId);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

module.exports = { EVENT_TYPES, TaskRuntimeEngine, validateEvent };

},
"server/ai/ai-memory.js": function(module,exports,require){
'use strict';
/**
 * 纵横四海 · 世界记忆层
 *
 * 让 AI 从"无状态单点生成"升级为"有记忆生成"。提供三类记忆：
 *   - player_memory：玩家的关键事迹（击败的BOSS、帮助的NPC、达成的重要事件）
 *   - npc_affinity：玩家对 NPC 的好感度（驱动 NPC 台词/态度的变化）
 *   - world_event_log：世界事件日志（经济引擎已有 eventLog，供世界上下文注入）
 *
 * 所有记忆写入都是"记录"（去重、封顶），供各 AI 场景在生成时注入。
 * AI 失败不影响游戏（记忆仅增强上下文，不承担正确性）。
 */
const { upgradeGameplayState } = require("src/task-runtime/gameplay-state.js");

const MEMORY_CAP = 40; // 玩家事迹封顶，超出滚动丢弃最旧
const AFFINITY_MIN = -50;
const AFFINITY_MAX = 50;

/** 规范化记忆项（若记忆数组是旧结构/被破坏则不 panic） */
function _normMemory(memory) {
  if (!Array.isArray(memory)) return [];
  return memory.filter((m) => m && typeof m.text === 'string' && m.text.length > 0);
}

/**
 * 记录一条玩家事迹。gameplay state 由调用方传入（含 player_memory），
 * 返回规范化后的记忆数组（调用方负责回写 state.player_memory）。
 * 去重：若已有相同 type+text 则仅刷新时间戳，不重复追加。
 */
function recordPlayerMemory(state, { type, text, importance = 1 }) {
  if (!state || !text) return state;
  if (!Array.isArray(state.player_memory)) state.player_memory = [];
  const normalized = _normMemory(state.player_memory);
  const existing = normalized.find((m) => m.type === type && m.text === text);
  if (existing) {
    existing.timestamp = Date.now();
    existing.importance = Math.max(existing.importance ?? 1, importance);
    state.player_memory = normalized;
    return state;
  }
  normalized.push({ id: `${type}:${Date.now().toString(36)}`, type, text, importance, timestamp: Date.now() });
  if (normalized.length > MEMORY_CAP) normalized.splice(0, normalized.length - MEMORY_CAP);
  state.player_memory = normalized;
  return state;
}

/**
 * 调整对某 NPC 的好感度。npc_affinity = { [npcId]: { value, memo, updated_at } }。
 * 返回新的 npc_affinity 对象。
 */
function adjustNpcAffinity(state, npcId, delta, memo) {
  if (!state || !npcId) return state;
  if (!state.npc_affinity || typeof state.npc_affinity !== 'object' || Array.isArray(state.npc_affinity)) state.npc_affinity = {};
  const cur = state.npc_affinity[npcId] ?? { value: 0, memo: '', updated_at: Date.now() };
  cur.value = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, (cur.value ?? 0) + delta));
  cur.updated_at = Date.now();
  if (memo) cur.memo = memo;
  state.npc_affinity[npcId] = cur;
  return state;
}

/**
 * 从玩家记忆中"回忆"与 query 最相关的片段（供 AI 注入）。
 * 简单优先级：文本含 query 关键词优先，其次按 importance 取最近。返回字符串数组。
 */
function recallPlayerMemory(state, { query = '', limit = 4 } = {}) {
  const memory = _normMemory(state?.player_memory);
  if (memory.length === 0) return [];
  const tokens = (query || '').split(/[\s,，、]+/).filter(Boolean);
  const scored = memory.map((m) => {
    let score = (m.importance ?? 1);
    if (tokens.length) {
      const matched = tokens.filter((t) => m.text.includes(t)).length;
      if (matched) score += matched * 5;
    }
    return { m, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || (b.m.timestamp ?? 0) - (a.m.timestamp ?? 0))
    .slice(0, limit)
    .map(({ m }) => m.text);
}

/** 从记忆里取对新 NPC 的好感度（无记录返回 0） */
function getNpcAffinity(state, npcId) {
  if (!state?.npc_affinity) return 0;
  return state.npc_affinity[npcId]?.value ?? 0;
}

/**
 * 组装世界上下文对象（供 AI 场景注入）。从经济引擎 snapshot 提取事件 + 天气。
 * 返回一个可 JSON 序列化、紧凑的上下文片段。
 */
function buildWorldContext(snapshot) {
  if (!snapshot) return { 事件: '无', 天气: '未知' };
  const events = (snapshot.activeEvents ?? []).slice(0, 3)
    .map((e) => `${e.name}（${e.region ?? '全域'}）`)
    .join('、') || '无';
  const weather = Object.entries(snapshot.weather ?? {}).slice(0, 3)
    .map(([r, w]) => `${r}:${w}`)
    .join('、') || '未知';
  return { 事件: events, 天气: weather, 经济_tick: snapshot.tick_count ?? 0 };
}

/**
 * 将记忆注入到 AI 生成上下文。返回一个紧凑中文记忆摘要字符串，
 * 供调用方拼进 prompt（若无记忆返回''，不打扰生成）。
 */
function memoryDigest(state, { npcId = null, query = '' } = {}) {
  const parts = [];
  const memories = recallPlayerMemory(state, { query, limit: 3 });
  if (memories.length) parts.push(`玩家过往事迹：${memories.join('；')}`);
  if (npcId) {
    const aff = getNpcAffinity(state, npcId);
    if (aff !== 0) parts.push(`与${npcId}的好感度：${aff > 0 ? '+爱戴' : '-疏远'}(${aff})`);
  }
  return parts.join('。');
}

module.exports = {
  MEMORY_CAP, AFFINITY_MIN, AFFINITY_MAX,
  recordPlayerMemory, adjustNpcAffinity, recallPlayerMemory,
  getNpcAffinity, buildWorldContext, memoryDigest,
};

},
"src/task-runtime/gameplay-state.js": function(module,exports,require){
'use strict';

const GAMEPLAY_SCHEMA_VERSION = 6;
const INVENTORY_CAPACITY = 200;

const LEVEL_THRESHOLDS = Object.freeze(require("data/runtime/level-experience.json").thresholds);

function createGameplayState(player = {}) {
  return {
    schema_version: GAMEPLAY_SCHEMA_VERSION,
    player: {
      level: 1,
      max_health: 100,
      current_health: 100,
      base_attack: 50,
      base_max_attack: 80,
      base_defense: 4,
      base_agility: 3,
      morale: 50,
      luck: 60,
      pets: [],
      crew: [],
      skills: {},
      skill_points: 0,
      reputation: 0,
      title: '水手',
      ...player,
    },
    inventory_capacity: INVENTORY_CAPACITY,
    owned_ships: {},
    current_ship_canonical_id: null,
    voyage: null,
    fishing: null,
    maritime_encounter: null,
    combat: null,
    dungeon: null,
    equipment: {
      weapon: null,offhand: null,headgear: null,clothes: null,belt: null,shoes: null,
      accessories: [null,null,null],
    },
    equipment_instances: {},
    shop_transactions: {},
    drop_settlements: {},
    encounter_defeats: {},
    gameplay_events: {},
    task_item_ledger: { schema_version:1,reservations:{},grants:{},consumptions:{},abandonments:{} },
    npc_duel: null,
    guild: null,
    city_influence: {},
    occupied_cities: [],
    // 世界记忆层：玩家个人事迹（AI 场景注入上下文）与 NPC 好感度
    player_memory: [],
    npc_affinity: {},
    // 动态任务（AI 世界支线）：运行时态用独立 JSON 容器（无 sqlite FK 约束），与
    // 静态任务的 state.tasks/state.progress（sqlite 持久化）区分，保证动态任务完整可玩。
    runtime_tasks: {},
    runtime_progress: {},
    // 市场货物栏（cargo）：goods 商品（货物）与 player_inventory 的随身物品/装备
    // (FK content_entities) 语义不同，用独立 JSON 容器持久化，避免外键阻断且贴合
    // 航海贸易『货舱』语义。
    cargo: {},
    cargo_capacity: 100,
  };
}

function upgradeGameplayState(state) {
  const defaults = createGameplayState(state?.player ?? {});
  const upgraded = { ...defaults,...state,player:{ ...defaults.player,...state.player } };
  upgraded.schema_version = GAMEPLAY_SCHEMA_VERSION;
  upgraded.equipment = { ...defaults.equipment,...state.equipment };
  upgraded.equipment.accessories = [...(state.equipment?.accessories ?? defaults.equipment.accessories)].slice(0,3);
  while (upgraded.equipment.accessories.length < 3) upgraded.equipment.accessories.push(null);
  for (const key of ['owned_ships','shop_transactions','drop_settlements','encounter_defeats','gameplay_events','equipment_instances','city_influence']) {
    if (!upgraded[key] || typeof upgraded[key] !== 'object' || Array.isArray(upgraded[key])) upgraded[key] = {};
  }
  if (upgraded.guild === undefined) upgraded.guild = null;
  if (!Array.isArray(upgraded.occupied_cities)) upgraded.occupied_cities = [];
  if (!Array.isArray(upgraded.player.pets)) upgraded.player.pets = [];
  if (!Array.isArray(upgraded.player.crew)) upgraded.player.crew = [];
  if (!upgraded.player.skills || typeof upgraded.player.skills !== 'object') upgraded.player.skills = {};
  if (upgraded.player.skill_points === undefined) upgraded.player.skill_points = 0;
  if (upgraded.player.reputation === undefined) upgraded.player.reputation = 0;
  if (!upgraded.player.title) upgraded.player.title = '水手';
  if (!Array.isArray(upgraded.player_memory)) upgraded.player_memory = [];
  if (!upgraded.npc_affinity || typeof upgraded.npc_affinity !== 'object' || Array.isArray(upgraded.npc_affinity)) upgraded.npc_affinity = {};
  if (!upgraded.runtime_tasks || typeof upgraded.runtime_tasks !== 'object' || Array.isArray(upgraded.runtime_tasks)) upgraded.runtime_tasks = {};
  if (!upgraded.runtime_progress || typeof upgraded.runtime_progress !== 'object' || Array.isArray(upgraded.runtime_progress)) upgraded.runtime_progress = {};
  if (!upgraded.cargo || typeof upgraded.cargo !== 'object' || Array.isArray(upgraded.cargo)) upgraded.cargo = {};
  if (upgraded.cargo_capacity === undefined) upgraded.cargo_capacity = 100;
  const {ensureTaskItemLedger}=require("src/task-runtime/task-item-ledger.js");ensureTaskItemLedger(upgraded);
  if(upgraded.npc_duel===undefined)upgraded.npc_duel=null;
  applyExperienceProgression(upgraded);
  return upgraded;
}

function applyExperienceProgression(state) {
  const player = state.player;
  const before = Number(player.level ?? 1);
  let level = Math.max(1,before);
  while (level < LEVEL_THRESHOLDS.length && Number(player.experience ?? 0) >= LEVEL_THRESHOLDS[level]) level += 1;
  for (let next = before + 1;next <= level;next += 1) {
    const healthGain = 10 + Math.floor(next / 5);
    player.max_health += healthGain;
    player.current_health = Math.min(player.max_health,player.current_health + healthGain);
    player.base_attack += 2 + Math.floor(next / 10);
    player.base_max_attack += 2 + Math.floor(next / 10);
    player.base_defense += 1 + Math.floor(next / 15);
    player.base_agility += 1;
    player.morale += 5;
    player.skill_points = (player.skill_points ?? 0) + 1;
  }
  player.level = level;
  return { before,after:level,levels_gained:level-before };
}

function inventoryUsed(state) {
  return Object.values(state.inventory ?? {}).reduce((sum,value) => sum + Number(value),0);
}

module.exports = { GAMEPLAY_SCHEMA_VERSION,INVENTORY_CAPACITY,LEVEL_THRESHOLDS,createGameplayState,upgradeGameplayState,applyExperienceProgression,inventoryUsed };

},
"data/runtime/level-experience.json": function(module,exports,require){
module.exports={
  "schema_version": 1,
  "source": {
    "classification": "源码明确",
    "repository": "zhsh-references/zhsh",
    "path": "config/exp.json",
    "runtime_evidence": "src/play.js getExpToNextLevel"
  },
  "supported_level_cap": 210,
  "thresholds": [
    0,
    1500,
    3500,
    5920,
    8897,
    12618,
    17344,
    23441,
    31428,
    42051,
    52781,
    63619,
    74566,
    57649,
    74361,
    94416,
    117813,
    141445,
    165314,
    189423,
    194288,
    232526,
    271147,
    310155,
    349554,
    389348,
    429541,
    470137,
    404138,
    453170,
    508331,
    569620, 637039, 710587, 790264, 876070, 962735, 1022281, 1168491, 1316164, 1465315,
    1545164, 1735384, 1927507, 2121552, 2317538, 2515485, 2715412, 2436322, 2690939, 2977382,
    3295653, 3645751, 4027676, 4441428, 4887007, 5337043, 5791580, 6250663, 6714338, 7182651,
    7655648, 8133376, 7058034, 7600790, 8203853, 8867222, 9590898, 10374880, 11219168, 12123762,
    13088663, 14113870, 15149330, 16195146, 17251421, 18318260, 19395768, 20484052, 21583220, 22693381,
    23814645, 24947123, 26090927, 27246170, 28412966, 29591431, 30781682, 31983837, 33198015, 34424336,
    35662921, 36913893, 38177376, 39453495, 40742376, 42044147, 43358937, 44686876, 46028095, 47382727,
    34492344, 35897756, 37350015, 38849121, 40395074, 41987874, 43627521, 45314016, 47047357, 48827546,
    50654581, 52528464, 54449194, 56416770, 58431194, 60492465, 62600583, 64755548, 66957360, 69206019,
    71501526, 73843879, 76233079, 78669127, 81152021, 83681763, 86258351, 88881787, 91531458, 94207627,
    96910559, 99640521, 102397784, 105182621, 107995307, 110836121, 113705344, 116603260, 119530156, 122486322,
    125472051, 128487638, 131533382, 134609584, 137716549, 140854585, 144024002, 147225114, 150458238, 153723694,
    157021806, 130523385, 133993518, 137602456, 141350200, 145236749, 149262104, 153426263, 157729229, 162170999,
    166657188, 171188240, 175764604, 180386733, 185055084, 189770120, 194532307, 199342117, 204200026, 209106515,
    214062070, 219067182, 224122346, 229228063, 234384838, 239593182, 244853610, 250166643, 255532807, 219264852,
    224761953, 230314026, 235921621, 241585293, 247305603, 253083117, 258918407, 264812051, 270764632, 276776740,
    282848970, 288981923, 295176207, 301432435, 307751226, 314133206, 320579007, 327089267, 333664631, 340305750,
    296872833, 315691876, 343920440, 403065995, 521357106, 698793772, 935375994, 1231103771, 1585977103, 1999995991
  ]
};
},
"src/task-runtime/task-item-ledger.js": function(module,exports,require){
'use strict';

const LEDGER_SCHEMA_VERSION=1;
const ACTIVE_STATUSES=new Set(['accepted','in_progress','completable']);

function ensureTaskItemLedger(state){
  if(!state.task_item_ledger||typeof state.task_item_ledger!=='object')state.task_item_ledger={};
  const ledger=state.task_item_ledger;ledger.schema_version=LEDGER_SCHEMA_VERSION;
  for(const key of ['reservations','grants','consumptions','abandonments'])if(!ledger[key]||typeof ledger[key]!=='object'||Array.isArray(ledger[key]))ledger[key]={};
  return ledger;
}

function grantInventoryItem(state,{itemCanonicalId,quantity,grantId=null,sourceKind='gameplay',sourceTaskCanonicalId=null,targetTaskCanonicalId=null,generatedOnAccept=false}){
  quantity=positive(quantity);const ledger=ensureTaskItemLedger(state);
  if(grantId&&ledger.grants[grantId])return {...ledger.grants[grantId],idempotent_replay:true};
  state.inventory[itemCanonicalId]=(state.inventory[itemCanonicalId]??0)+quantity;
  const record={item_canonical_id:itemCanonicalId,quantity,source_kind:sourceKind,source_task_canonical_id:sourceTaskCanonicalId,
    target_task_canonical_id:targetTaskCanonicalId,generated_on_accept:Boolean(generatedOnAccept)};
  if(grantId)ledger.grants[grantId]=record;
  return record;
}

function reconcileTaskItemReservations(state,tasks){
  const ledger=ensureTaskItemLedger(state);const activeTasks=tasks.filter((task)=>ACTIVE_STATUSES.has(state.tasks?.[task.canonical_id]?.status));
  const activeKeys=new Set();const allocated=new Map();
  for(const task of activeTasks){
    for(const target of task.targets.filter((entry)=>entry.target_kind==='item'&&entry.entity_canonical_id)){
      const key=reservationKey(task.canonical_id,target.canonical_id);activeKeys.add(key);
      const total=Number(state.inventory?.[target.entity_canonical_id]??0);const used=allocated.get(target.entity_canonical_id)??0;
      const reserved=Math.max(0,Math.min(Number(target.required_quantity),total-used));allocated.set(target.entity_canonical_id,used+reserved);
      ledger.reservations[key]={task_canonical_id:task.canonical_id,target_canonical_id:target.canonical_id,item_canonical_id:target.entity_canonical_id,
        required_quantity:Number(target.required_quantity),reserved_quantity:reserved,policy:target.task_item_policy??defaultPolicy(task)};
    }
  }
  for(const key of Object.keys(ledger.reservations))if(!activeKeys.has(key))delete ledger.reservations[key];
  return Object.values(ledger.reservations);
}

function assertInventoryRemovalAllowed(state,itemCanonicalId,quantity,{reason='inventory_removal',excludingTaskCanonicalId=null}={}){
  quantity=positive(quantity);const inventory=Number(state.inventory?.[itemCanonicalId]??0);
  const reserved=reservedQuantity(state,itemCanonicalId,{excludingTaskCanonicalId});
  if(inventory-quantity<reserved)throw new Error(`Task item is reserved and cannot be removed by ${reason}: ${itemCanonicalId}`);
  return {inventory_quantity:inventory,reserved_quantity:reserved,removable_quantity:inventory-reserved};
}

function consumeTaskItems(state,task,consumptionId){
  const ledger=ensureTaskItemLedger(state);if(consumptionId&&ledger.consumptions[consumptionId])return {...ledger.consumptions[consumptionId],idempotent_replay:true};
  const consumed=[];
  for(const target of task.targets.filter((entry)=>entry.target_kind==='item')){
    const existing=Number(state.inventory?.[target.entity_canonical_id]??0);const required=Number(target.required_quantity);
    if(existing<required)throw new Error(`Required task item is missing: ${target.entity_canonical_id}`);
    setInventory(state,target.entity_canonical_id,existing-required);consumed.push({item_canonical_id:target.entity_canonical_id,quantity:required,target_canonical_id:target.canonical_id});
    delete ledger.reservations[reservationKey(task.canonical_id,target.canonical_id)];
  }
  const record={task_canonical_id:task.canonical_id,items:consumed};if(consumptionId)ledger.consumptions[consumptionId]=record;return record;
}

function abandonTaskItems(state,task,abandonmentId){
  const ledger=ensureTaskItemLedger(state);if(abandonmentId&&ledger.abandonments[abandonmentId])return {...ledger.abandonments[abandonmentId],idempotent_replay:true};
  const removed=[];
  for(const [grantId,grant] of Object.entries(ledger.grants)){
    if(grant.target_task_canonical_id!==task.canonical_id||!grant.generated_on_accept||grant.rolled_back)continue;
    const existing=Number(state.inventory?.[grant.item_canonical_id]??0);const quantity=Math.min(existing,Number(grant.quantity));
    if(quantity>0){setInventory(state,grant.item_canonical_id,existing-quantity);removed.push({item_canonical_id:grant.item_canonical_id,quantity});}
    ledger.grants[grantId]={...grant,rolled_back:true,rolled_back_quantity:quantity};
  }
  for(const target of task.targets.filter((entry)=>entry.target_kind==='item'))delete ledger.reservations[reservationKey(task.canonical_id,target.canonical_id)];
  const record={task_canonical_id:task.canonical_id,rolled_back_acceptance_items:removed};if(abandonmentId)ledger.abandonments[abandonmentId]=record;return record;
}

function reservedQuantity(state,itemCanonicalId,{excludingTaskCanonicalId=null}={}){
  const ledger=ensureTaskItemLedger(state);return Object.values(ledger.reservations).filter((entry)=>entry.item_canonical_id===itemCanonicalId
    &&entry.task_canonical_id!==excludingTaskCanonicalId).reduce((sum,entry)=>sum+Number(entry.reserved_quantity??0),0);
}

function defaultPolicy(task){return {acquisition_mode:task.task_type==='送物品'?'grant_on_accept':'world_acquisition',reservation:'required_until_submit',
  abandonment:task.task_type==='送物品'?'rollback_acceptance_grant':'retain_inventory',consumption:'submit_only'};}
function reservationKey(taskId,targetId){return `${taskId}|${targetId}`;}
function setInventory(state,id,quantity){if(quantity<=0)delete state.inventory[id];else state.inventory[id]=quantity;}
function positive(value){const number=Number(value);if(!Number.isInteger(number)||number<=0)throw new Error('Quantity must be a positive integer');return number;}

module.exports={LEDGER_SCHEMA_VERSION,abandonTaskItems,assertInventoryRemovalAllowed,consumeTaskItems,defaultPolicy,ensureTaskItemLedger,
  grantInventoryItem,reconcileTaskItemReservations,reservedQuantity};

},
"src/task-runtime/ports.js": function(module,exports,require){
'use strict';

const TASK_CATALOG_METHODS = Object.freeze([
  'listSeriesTasks',
  'getTask',
  'getMapNode',
  'getNodeForLocation',
  'listAdjacentNodes',
  'listNpcsAtNode',
  'isNpcAtLocation',
  'isMonsterAtLocation',
  'hasContentEntity',
]);
const RUNTIME_STORAGE_METHODS = Object.freeze([
  'hasPlayer',
  'createPlayer',
  'loadPlayer',
  'resetPlayer',
  'transact',
]);

function assertPort(adapter,name,methods) {
  if (!adapter) throw new Error(`${name} adapter is required`);
  const missing = methods.filter((method) => typeof adapter[method] !== 'function');
  if (missing.length) throw new Error(`${name} adapter is missing methods: ${missing.join(', ')}`);
  return adapter;
}

function assertTaskCatalog(adapter) {
  return assertPort(adapter,'TaskCatalog',TASK_CATALOG_METHODS);
}

function assertRuntimeStorage(adapter) {
  return assertPort(adapter,'RuntimeStorage',RUNTIME_STORAGE_METHODS);
}

module.exports = { RUNTIME_STORAGE_METHODS,TASK_CATALOG_METHODS,assertRuntimeStorage,assertTaskCatalog };

},
"src/task-runtime/browser-task-catalog.js": function(module,exports,require){
'use strict';

class BrowserTaskCatalog {
  constructor(contentPackage) {
    if (!['zhsh.task1.browser-content','zhsh.browser-content'].includes(contentPackage?.package_id)) throw new Error('Invalid browser content package');
    this.content = contentPackage;
    this.series = Array.isArray(contentPackage.series) ? contentPackage.series : [contentPackage.series];
    this.tasks = new Map(contentPackage.tasks.map((task) => [task.canonical_id,task]));
    this.nodes = new Map(contentPackage.map_nodes.map((node) => [node.map_node_canonical_id,node]));
    this.locationNodes = new Map(contentPackage.map_nodes.filter((node) => node.location_canonical_id)
      .map((node) => [node.location_canonical_id,node]));
    this.entities = new Set(contentPackage.content_entities.map((entity) => entity.canonical_id));
  }

  listSeriesTasks(seriesCanonicalId) {
    if (!this.series.some((entry)=>entry.canonical_id===seriesCanonicalId)) return [];
    return [...this.tasks.values()].filter((task)=>(task.series_canonical_id??task.canonical_id.match(/^task\.series\.\d+/)?.[0])===seriesCanonicalId)
      .sort((a,b) => a.sequence_position - b.sequence_position);
  }

  getTask(taskCanonicalId) {
    return this.tasks.get(taskCanonicalId) ?? null;
  }

  getMapNode(nodeOrLocationCanonicalId) {
    return this.nodes.get(nodeOrLocationCanonicalId) ?? this.locationNodes.get(nodeOrLocationCanonicalId) ?? null;
  }

  getNodeForLocation(locationCanonicalId) {
    return this.locationNodes.get(locationCanonicalId) ?? null;
  }

  listAdjacentNodes(nodeCanonicalId) {
    const result = [];
    for (const connection of this.content.location_connections) {
      let destinationId = null;
      if (connection.from_map_node_canonical_id === nodeCanonicalId) destinationId = connection.to_map_node_canonical_id;
      else if (connection.to_map_node_canonical_id === nodeCanonicalId) destinationId = connection.from_map_node_canonical_id;
      if (!destinationId) continue;
      const node = this.nodes.get(destinationId);
      if (node) result.push({ ...node,connection_canonical_id: connection.canonical_id,
        relation_type: connection.relation_type,directed: connection.directed });
    }
    return result.sort((a,b) => a.connection_canonical_id.localeCompare(b.connection_canonical_id));
  }

  listNpcsAtNode(nodeCanonicalId) {
    const node = this.nodes.get(nodeCanonicalId);
    if (!node?.location_canonical_id) return [];
    return this.content.npc_placements.filter((entry) => entry.location_canonical_id === node.location_canonical_id)
      .map((entry) => ({ ...entry,display_name: this.content.npcs.find((npc) => npc.canonical_id === entry.npc_canonical_id)?.display_name ?? entry.npc_canonical_id }));
  }

  isNpcAtLocation(npcCanonicalId,locationCanonicalId) {
    return this.content.npc_placements.some((entry) => entry.npc_canonical_id === npcCanonicalId
      && entry.location_canonical_id === locationCanonicalId && entry.runtime_capability === 'queryable');
  }

  isMonsterAtLocation(monsterCanonicalId,locationCanonicalId) {
    return this.content.monster_placements.some((entry) => entry.monster_canonical_id === monsterCanonicalId
      && entry.location_canonical_id === locationCanonicalId && entry.runtime_capability === 'queryable');
  }

  hasContentEntity(contentCanonicalId) {
    return this.entities.has(contentCanonicalId);
  }
}

module.exports = { BrowserTaskCatalog };

},
"src/task-runtime/browser-runtime-storage.js": function(module,exports,require){
'use strict';

const { assertPlayerState,cloneState } = require("src/task-runtime/runtime-storage.js");
const { upgradeGameplayState } = require("src/task-runtime/gameplay-state.js");

const SAVE_SCHEMA_VERSION = 2;
const SAVE_FORMAT = 'zhsh.task1.browser-save';

class IndexedDbDurableStore {
  constructor({ databaseName = 'zhsh-task1-runtime',storeName = 'player-saves' } = {}) {
    this.databaseName = databaseName;
    this.storeName = storeName;
    this.db = null;
  }

  async open() {
    if (this.db) return this;
    this.db = await new Promise((resolve,reject) => {
      const request = indexedDB.open(this.databaseName,1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName,{ keyPath:'player_canonical_id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return this;
  }

  async list() {
    await this.open();
    return requestResult(this.db.transaction(this.storeName,'readonly').objectStore(this.storeName).getAll());
  }

  async put(record) {
    await this.open();
    const transaction = this.db.transaction(this.storeName,'readwrite');
    transaction.objectStore(this.storeName).put(record);
    await transactionDone(transaction);
  }

  async delete(playerCanonicalId) {
    await this.open();
    const transaction = this.db.transaction(this.storeName,'readwrite');
    transaction.objectStore(this.storeName).delete(playerCanonicalId);
    await transactionDone(transaction);
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

class BrowserRuntimeStorage {
  constructor({ durableStore = new IndexedDbDurableStore() } = {}) {
    this.durableStore = durableStore;
    this.players = new Map();
    this.revisions = new Map();
    this.corruptRecords = new Map();
    this.pending = Promise.resolve();
    this.pendingRecords = new Map();
    this.persistDrain = null;
    this.initialized = false;
  }

  async ready() {
    if (this.initialized) return this;
    const records = await this.durableStore.list();
    for (const record of records) {
      try {
        const envelope = validateAndUpgradeEnvelope(record);
        this.players.set(envelope.player_canonical_id,cloneState(envelope.state));
        this.revisions.set(envelope.player_canonical_id,envelope.revision);
        if (envelope !== record) await this.durableStore.put(envelope);
      } catch (error) {
        this.corruptRecords.set(record?.player_canonical_id ?? 'unknown',error.message);
      }
    }
    this.initialized = true;
    return this;
  }

  assertReady() {
    if (!this.initialized) throw new Error('BrowserRuntimeStorage.ready() must complete before use');
  }

  hasPlayer(playerCanonicalId) {
    this.assertReady();
    return this.players.has(playerCanonicalId);
  }

  createPlayer(state) {
    this.assertReady();
    assertPlayerState(state);
    const id = state.player.canonical_id;
    if (this.players.has(id)) throw new Error(`Player already exists: ${id}`);
    return this.commit(id,state);
  }

  loadPlayer(playerCanonicalId) {
    this.assertReady();
    const state = this.players.get(playerCanonicalId);
    if (!state) {
      const corrupt = this.corruptRecords.get(playerCanonicalId);
      if (corrupt) throw new Error(`Player save is corrupt: ${corrupt}`);
      throw new Error(`Player does not exist: ${playerCanonicalId}`);
    }
    return cloneState(state);
  }

  resetPlayer(playerCanonicalId,state) {
    this.assertReady();
    assertPlayerState(state);
    if (state.player.canonical_id !== playerCanonicalId) throw new Error('Reset player id mismatch');
    this.corruptRecords.delete(playerCanonicalId);
    return this.commit(playerCanonicalId,state);
  }

  async deletePlayer(playerCanonicalId) {
    this.assertReady();
    const removed = this.players.delete(playerCanonicalId);
    this.revisions.delete(playerCanonicalId);
    this.corruptRecords.delete(playerCanonicalId);
    this.pendingRecords.delete(playerCanonicalId);
    await this.durableStore.delete(playerCanonicalId);
    return removed;
  }

  transact(playerCanonicalId,operation) {
    const working = this.loadPlayer(playerCanonicalId);
    const result = operation(working);
    assertPlayerState(working);
    this.commit(playerCanonicalId,working,{takeOwnership:true,returnState:false});
    return cloneState(result);
  }

  commit(playerCanonicalId,state,{takeOwnership=false,returnState=true}={}) {
    const copy = takeOwnership?state:cloneState(state);
    const revision = (this.revisions.get(playerCanonicalId) ?? 0) + 1;
    this.players.set(playerCanonicalId,copy);
    this.revisions.set(playerCanonicalId,revision);
    this.schedulePersist({player_canonical_id:playerCanonicalId,revision,state:copy});
    return returnState?cloneState(copy):undefined;
  }

  /**
   * Re-fetches a single player's newest envelope from the durable store and
   * replaces the in-memory state. Used when character switching must resume
   * progress written by another device. Returns the fresh state (or null when
   * the player no longer exists), and clears any corrupt marker.
   */
  async reloadPlayer(playerCanonicalId) {
    this.assertReady();
    const record = await this.durableStore.get(playerCanonicalId);
    if (!record) {
      this.players.delete(playerCanonicalId);
      this.revisions.delete(playerCanonicalId);
      this.corruptRecords.delete(playerCanonicalId);
      return null;
    }
    try {
      const envelope = validateAndUpgradeEnvelope(record);
      this.players.set(envelope.player_canonical_id,cloneState(envelope.state));
      this.revisions.set(envelope.player_canonical_id,envelope.revision);
      this.corruptRecords.delete(envelope.player_canonical_id);
      if (envelope !== record) await this.durableStore.put(envelope);
      return cloneState(envelope.state);
    } catch (error) {
      this.corruptRecords.set(record?.player_canonical_id ?? 'unknown',error.message);
      return null;
    }
  }

  async flush() {
    while(this.persistDrain||this.pendingRecords.size){
      if(!this.persistDrain)this.startPersistDrain();
      await this.persistDrain;
    }
  }

  schedulePersist(envelope) {
    this.pendingRecords.set(envelope.player_canonical_id,envelope);
    if(!this.persistDrain)this.startPersistDrain();
  }

  startPersistDrain() {
    this.persistDrain=this.pending.then(async()=>{
      while(this.pendingRecords.size){
        const records=[...this.pendingRecords.values()];this.pendingRecords.clear();
        for(const record of records)await this.durableStore.put(record.checksum?record:makeEnvelope(record.state,record.revision));
      }
    }).finally(()=>{this.persistDrain=null;});
    this.pending=this.persistDrain;
  }

  exportPlayer(playerCanonicalId) {
    const state = this.loadPlayer(playerCanonicalId);
    return JSON.stringify(makeEnvelope(state,this.revisions.get(playerCanonicalId) ?? 1),null,2);
  }

  async importPlayer(serialized,{ expectedPlayerCanonicalId = null } = {}) {
    let parsed;
    try { parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized; }
    catch { throw new Error('Save import is not valid JSON'); }
    const envelope = validateAndUpgradeEnvelope(parsed);
    if (expectedPlayerCanonicalId && envelope.player_canonical_id !== expectedPlayerCanonicalId) throw new Error('Imported player id does not match this playable slice');
    this.players.set(envelope.player_canonical_id,cloneState(envelope.state));
    this.revisions.set(envelope.player_canonical_id,envelope.revision);
    this.corruptRecords.delete(envelope.player_canonical_id);
    this.schedulePersist(envelope);
    await this.flush();
    return this.loadPlayer(envelope.player_canonical_id);
  }

  close() {
    this.durableStore.close?.();
  }
}

function makeEnvelope(state,revision) {
  const body = { format:SAVE_FORMAT,schema_version:SAVE_SCHEMA_VERSION,player_canonical_id:state.player.canonical_id,revision,state:cloneState(state) };
  return { ...body,checksum:checksum(stableJson(body)) };
}

function validateAndUpgradeEnvelope(value) {
  let envelope = value;
  if (value?.schema_version === 0 && value.state) envelope = legacyEnvelope(value.state,Number(value.revision ?? 1));
  if (!envelope || envelope.format !== SAVE_FORMAT) throw new Error('Unsupported save format');
  const body = { format:envelope.format,schema_version:envelope.schema_version,player_canonical_id:envelope.player_canonical_id,
    revision:Number(envelope.revision),state:envelope.state };
  if (checksum(stableJson(body)) !== envelope.checksum) throw new Error('Save checksum mismatch');
  if (body.state.player.canonical_id !== body.player_canonical_id) throw new Error('Save player id mismatch');
  if (!Number.isInteger(body.revision) || body.revision < 1) throw new Error('Save revision is invalid');
  if (body.schema_version === 1 || body.schema_version === 0) return makeEnvelope(upgradeGameplayState(body.state),body.revision);
  if (body.schema_version !== SAVE_SCHEMA_VERSION) throw new Error(`Unsupported save schema version: ${body.schema_version}`);
  body.state = upgradeGameplayState(body.state);
  assertPlayerState(body.state);
  return { ...body,checksum:envelope.checksum };
}

function legacyEnvelope(state,revision) {
  const body = { format:SAVE_FORMAT,schema_version:0,player_canonical_id:state.player.canonical_id,revision,state:cloneState(state) };
  return { ...body,checksum:checksum(stableJson(body)) };
}

function checksum(text) {
  let hash = 0x811c9dc5;
  for (let index=0;index<text.length;index+=1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash,0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8,'0')}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function requestResult(request) {
  return new Promise((resolve,reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve,reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Durable store backed by the same-origin game server /api/saves endpoints.
 * Implements the same surface as IndexedDbDurableStore (open/list/put/delete),
 * so BrowserRuntimeStorage swaps its persistence sink without any other change.
 *
 * Writes are persisted server-side (SQLite keyed by player_canonical_id), so any
 * device hitting the same server shares every character and, by default, resumes
 * the most-recently-used one.
 */
class RemoteDurableStore {
  constructor({ baseUrl = '' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.opened = false;
  }

  async open() {
    this.opened = true;
    return this;
  }

  async list() {
    await this.open();
    const response = await fetch(`${this.baseUrl}/api/saves`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`存档列表读取失败：${response.status}`);
    const data = await response.json();
    return Array.isArray(data.saves) ? data.saves : [];
  }
   
   async put(record) {
     await this.open();
     const response = await fetch(`${this.baseUrl}/api/saves/${encodeURIComponent(record.player_canonical_id)}`, {
       method: 'PUT',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(record),
     });
     if (!response.ok) throw new Error(`存档写入失败：${response.status}`);
   }

   async get(playerCanonicalId) {
     await this.open();
     const response = await fetch(`${this.baseUrl}/api/saves/${encodeURIComponent(playerCanonicalId)}`, { cache: 'no-store' });
     if (response.status === 404) return null;
     if (!response.ok) throw new Error(`存档读取失败：${response.status}`);
     return response.json();
   }

   async delete(playerCanonicalId) {
     await this.open();
     const response = await fetch(`${this.baseUrl}/api/saves/${encodeURIComponent(playerCanonicalId)}`, { method: 'DELETE' });
     if (!response.ok && response.status !== 404) throw new Error(`存档删除失败：${response.status}`);
   }

   close() {
     this.opened = false;
   }
}

/** Registry used by RemoteDurableStore clients to track the last-used character. */
class RemoteCharacterRegistry {
  constructor({ baseUrl = '' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getActive() {
    const response = await fetch(`${this.baseUrl}/api/active`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`激活角色读取失败：${response.status}`);
    const data = await response.json();
    return data.player_canonical_id;
  }

  async setActive(playerCanonicalId) {
    const response = await fetch(`${this.baseUrl}/api/active`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_canonical_id: playerCanonicalId ?? null }),
    });
    if (!response.ok) throw new Error(`激活角色写入失败：${response.status}`);
  }
}

module.exports = { BrowserRuntimeStorage,IndexedDbDurableStore,RemoteDurableStore,RemoteCharacterRegistry,SAVE_FORMAT,SAVE_SCHEMA_VERSION,checksum,makeEnvelope,validateAndUpgradeEnvelope };

},
"src/task-runtime/runtime-storage.js": function(module,exports,require){
'use strict';

const { GAMEPLAY_SCHEMA_VERSION }=require("src/task-runtime/gameplay-state.js");

function cloneState(state) {
  return structuredClone(state);
}

function assertPlayerState(state) {
  if (!state?.player?.canonical_id) throw new Error('Player state requires player.canonical_id');
  for (const key of ['tasks','progress','inventory','reward_grants','flags','processed_events']) {
    if (!state[key] || typeof state[key] !== 'object') throw new Error(`Player state requires ${key}`);
  }
  if (!Array.isArray(state.unlocked_map_nodes)) throw new Error('Player state requires unlocked_map_nodes');
  for (const key of ['owned_ships','equipment','shop_transactions','drop_settlements','encounter_defeats','gameplay_events']) {
    if (!state[key] || typeof state[key] !== 'object') throw new Error(`Player state requires ${key}`);
  }
  if (state.schema_version !== GAMEPLAY_SCHEMA_VERSION) throw new Error(`Player state requires schema_version ${GAMEPLAY_SCHEMA_VERSION}`);
  return state;
}

module.exports = { assertPlayerState, cloneState };

},
"src/task-runtime/classic-ui-model.js": function(module,exports,require){
'use strict';

class UiFeedback {
  constructor() {
    this.message = '';
    this.error = '';
  }

  succeed(message = '') {
    this.message = String(message);
    this.error = '';
    return this.snapshot();
  }

  fail(error) {
    this.message = '';
    this.error = error instanceof Error ? error.message : String(error);
    return this.snapshot();
  }

  snapshot() {
    return { message:this.message,error:this.error };
  }
}

function buildCityMapEntries(content,currentLocation,adjacentLocations) {
  if (!currentLocation?.city_canonical_id) return [];
  const currentNodeId = currentLocation.map_node_canonical_id;
  const adjacentNodeIds = new Set(adjacentLocations.map((entry) => entry.map_node_canonical_id));
  const locationsById = new Map(content.locations
    .filter((entry) => entry.city_canonical_id === currentLocation.city_canonical_id)
    .map((entry) => [entry.canonical_id,entry]));
  return content.map_nodes
    .filter((node) => node.city_canonical_id === currentLocation.city_canonical_id
      && (!node.location_canonical_id || locationsById.has(node.location_canonical_id)))
    .map((node) => {
      const location = locationsById.get(node.location_canonical_id);
      return {
        map_node_canonical_id:node.map_node_canonical_id,
        location_canonical_id:node.location_canonical_id ?? null,
        display_name:location?.display_name || node.display_name,
        is_current:node.map_node_canonical_id === currentNodeId,
        can_move:adjacentNodeIds.has(node.map_node_canonical_id),
      };
    })
    .sort((left,right) => Number(right.is_current) - Number(left.is_current) || left.display_name.localeCompare(right.display_name,'zh-CN'));
}

module.exports = { UiFeedback,buildCityMapEntries };

},
"src/task-runtime/npc-duel.js": function(module,exports,require){
'use strict';

const {damage,effectiveStats}=require("src/task-runtime/formal-gameplay.js");
const {useActiveStaminaItem}=require("src/task-runtime/stamina-item.js");

const ACTIVE_STATUSES=new Set(['accepted','in_progress','completable']);
const REPLAY_WINDOW=128;

class NpcDuelRuntime{
  constructor({storage,taskCatalog,gameplayCatalog,taskEngine,random=Math.random,clock=()=>new Date().toISOString()}){
    this.storage=storage;this.taskCatalog=taskCatalog;this.gameplayCatalog=gameplayCatalog;this.taskEngine=taskEngine;this.random=random;this.clock=clock;
  }
  start(playerId,npcCanonicalId,eventId){
    const result=transact(this.storage,playerId,eventId,'npc_duel_start',{npc_canonical_id:npcCanonicalId},this.clock,(state)=>{
      if(state.combat||state.npc_duel)throw new Error('Another combat or NPC duel is already active');
      const node=this.taskCatalog.getMapNode(state.player.current_map_node_canonical_id);if(!node?.location_canonical_id)throw new Error('NPC duel requires a formal location');
      const placement=this.taskCatalog.listNpcsAtNode(node.map_node_canonical_id).find((entry)=>entry.npc_canonical_id===npcCanonicalId);
      if(!placement)throw new Error('NPC duel target is not at the current formal location');
      const match=findActiveDuelTask(state,this.taskCatalog,npcCanonicalId,node.location_canonical_id);
      if(!match)throw new Error('NPC duel requires an active matching task');
      const npc=this.taskCatalog.content?.npcs?.find((entry)=>entry.canonical_id===npcCanonicalId)??{canonical_id:npcCanonicalId,level:1};
      const stats=npcDuelStats(npc,match.task,match.target);
      state.npc_duel={canonical_id:`npc-duel.${eventId}`,task_canonical_id:match.task.canonical_id,target_canonical_id:match.target.canonical_id,
        npc_canonical_id:npcCanonicalId,location_canonical_id:node.location_canonical_id,npc_current_health:stats.health,npc_stats:stats,round:0,started_at:this.clock()};
      return {applied:true,action:'npc_duel_started',duel:{...state.npc_duel}};
    });
    return result;
  }
  attack(playerId,eventId,{rounds=1}={}){
    rounds=positive(rounds);
    const result=transact(this.storage,playerId,eventId,'npc_duel_attack',{rounds},this.clock,(state)=>{
      if(!state.npc_duel)throw new Error('No active NPC duel');
      let response;const appliedStaminaItems=[];
      for(let index=0;index<rounds;index+=1){
        const duel=state.npc_duel;const player=effectiveStats(state,this.gameplayCatalog);duel.round+=1;
        const playerDamage=damage(player.attack,player.max_attack,duel.npc_stats.defense,player.agility,duel.npc_stats.agility,this.random);
        duel.npc_current_health=Math.max(0,duel.npc_current_health-playerDamage);
        if(duel.npc_current_health===0){const settled={...duel};state.npc_duel=null;return {applied:true,action:'npc_duel_won',duel_canonical_id:settled.canonical_id,
          task_canonical_id:settled.task_canonical_id,npc_canonical_id:settled.npc_canonical_id,location_canonical_id:settled.location_canonical_id,
          player_damage:playerDamage,experience:0,money:0,drops:[],settlement:'task_progress_only',
          stamina_item:appliedStaminaItems.at(-1)??null,stamina_items:[...appliedStaminaItems],batched_rounds:index+1};}
        const npcDamage=damage(duel.npc_stats.attack,duel.npc_stats.max_attack,player.defense,duel.npc_stats.agility,player.agility,this.random);
        state.player.current_health=Math.max(0,state.player.current_health-npcDamage);
        const stamina=state.player.current_health>0?useActiveStaminaItem(state,this.gameplayCatalog,{automatic:true}):{applied:false,reason:'player_defeated'};
        if(stamina.applied)appliedStaminaItems.push(stamina);
        if(state.player.current_health===0){const settled={...duel};state.player.current_health=1;state.npc_duel=null;
          return {applied:true,action:'npc_duel_lost',duel_canonical_id:settled.canonical_id,task_canonical_id:settled.task_canonical_id,
            npc_canonical_id:settled.npc_canonical_id,location_canonical_id:settled.location_canonical_id,current_health:1,
            retry_available:true,world_position_preserved:true,stamina_item:appliedStaminaItems.at(-1)??stamina,stamina_items:[...appliedStaminaItems],batched_rounds:index+1};}
        response={applied:true,action:'npc_duel_round',player_damage:playerDamage,npc_damage:npcDamage,player_health:state.player.current_health,
          stamina_item:appliedStaminaItems.at(-1)??stamina,stamina_items:[...appliedStaminaItems],duel:{...duel},batched_rounds:index+1};
      }
      return response;
    });
    if(result.action==='npc_duel_won')this.taskEngine.processEvent(playerId,{event_id:`${eventId}.task`,type:'defeat_npc',npc_canonical_id:result.npc_canonical_id,
      location_canonical_id:result.location_canonical_id});
    return result;
  }
  retreat(playerId,eventId){
    return transact(this.storage,playerId,eventId,'npc_duel_retreat',{},this.clock,(state)=>{
      if(!state.npc_duel)throw new Error('No active NPC duel');const canonicalId=state.npc_duel.canonical_id;state.npc_duel=null;
      return {applied:true,action:'npc_duel_retreated',duel_canonical_id:canonicalId,fee:0,retry_available:true};
    });
  }
}

function findActiveDuelTask(state,catalog,npcId,locationId){
  for(const [taskId,runtime] of Object.entries(state.tasks??{})){
    if(!ACTIVE_STATUSES.has(runtime.status))continue;const task=catalog.getTask(taskId);if(!task)continue;
    if(task.target_location_canonical_id&&task.target_location_canonical_id!==locationId)continue;
    const target=task.targets.find((entry)=>entry.target_kind==='npc_duel'&&entry.entity_canonical_id===npcId
      &&Number(state.progress?.[`${taskId}|${entry.canonical_id}`]??0)<Number(entry.required_quantity));
    if(target)return {task,target};
  }
  return null;
}
function npcDuelStats(npc,task,target){
  const level=Math.max(1,Number(target?.npc_duel?.level??task?.level_requirement??npc?.level??1));
  return {level,health:Math.floor((50+20*(level-1))*1.5),attack:Math.floor((8+4*(level-1))*1.15),
    max_attack:Math.floor((12+6*(level-1))*1.15),defense:Math.floor((8+3*(level-1))*1.15),agility:Math.floor((5+2*(level-1))*1.15),
    rule_status:'RELIABLE_RUNTIME_INFERENCE',rule_id:'zhsh.npc-duel.task-level.v1',source_npc_level:Number(npc?.level??1),source_task_level:Number(task?.level_requirement??1)};
}
function transact(storage,playerId,eventId,type,payload,clock,operation){
  if(!eventId||typeof eventId!=='string')throw new Error('NPC duel event requires event_id');
  return storage.transact(playerId,(state)=>{const prior=state.gameplay_events[eventId];if(prior){if(prior.event_type!==type||stableJson(prior.payload)!==stableJson(payload))throw new Error(`Gameplay event id collision: ${eventId}`);return{...prior.result,idempotent_replay:true};}
    const result=operation(state);state.player.updated_at=clock();state.gameplay_events[eventId]={event_type:type,payload,result,processed_at:clock()};
    const ids=Object.keys(state.gameplay_events);for(const id of ids.slice(0,Math.max(0,ids.length-REPLAY_WINDOW)))delete state.gameplay_events[id];return result;});
}
function positive(value){const number=Number(value);if(!Number.isInteger(number)||number<=0)throw new Error('Rounds must be a positive integer');return number;}
function stableJson(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;}

module.exports={NpcDuelRuntime,findActiveDuelTask,npcDuelStats};

},
"src/task-runtime/formal-gameplay.js": function(module,exports,require){
'use strict';
const { recordPlayerMemory } = require("server/ai/ai-memory.js");

const { applyExperienceProgression } = require("src/task-runtime/gameplay-state.js");
const { activeStaminaItem,useActiveStaminaItem } = require("src/task-runtime/stamina-item.js");
const {assertInventoryRemovalAllowed}=require("src/task-runtime/task-item-ledger.js");

const GAMEPLAY_EVENT_REPLAY_WINDOW=128;
const DROP_SETTLEMENT_REPLAY_WINDOW=128;

const EQUIPMENT_SLOT_BY_TYPE = Object.freeze({
  1:'weapon',2:'headgear',3:'clothes',4:'belt',5:'shoes',6:'accessories',7:'offhand',
});

class FormalGameplayCatalog {
  constructor(content = {}) {
    this.content = content;
    this.ships = index(content.ships);
    this.routes = index(content.voyage_routes);
    const mapNodeByLocation=new Map((content.map_nodes ?? []).filter((entry)=>entry.location_canonical_id).map((entry)=>[entry.location_canonical_id,entry.map_node_canonical_id]));
    this.monsterPlacements=(content.monster_placements ?? []).map((entry)=>({ ...entry,map_node_canonical_id:mapNodeByLocation.get(entry.location_canonical_id) }));
    this.placementsByMonster=group(this.monsterPlacements,'monster_canonical_id');
    this.dungeons=index(content.dungeons);
    const dungeonMonsters=(content.dungeons ?? []).flatMap((dungeon)=>dungeon.stages.filter((stage)=>stage.monster).map((stage)=>({
      ...stage.monster,dungeon_canonical_id:dungeon.canonical_id,dungeon_stage_canonical_id:stage.canonical_id,
      location_canonical_id:stage.canonical_id,map_node_canonical_id:stage.map_node_canonical_id,
    })));
    this.monsters = index([...(content.monsters ?? []),...dungeonMonsters]);
    this.items = index([...(content.items ?? []),...(content.content_entities ?? []),...(content.formal_items ?? [])]);
    this.equipment = index(content.equipment);
    this.shopEntries = index(content.shop_entries);
    this.dropsByMonster = group(content.drop_relations,'monster_canonical_id');
    this.recoveryServices = index(content.recovery_services);
    this.maritime = content.maritime ?? {};
    this.fishingGear = index(this.maritime.fishing?.gear);
    this.fishingCatches = index((this.maritime.fishing?.catches ?? []).map((entry)=>({ ...entry,canonical_id:entry.content_entity_canonical_id })));
  }
  getShip(id) { return required(this.ships,id,'ship'); }
  listShipsAtPort(cityId) { return [...this.ships.values()].filter((entry) => entry.city_canonical_id === cityId); }
  getRoute(id) { return required(this.routes,id,'voyage route'); }
  listRoutesFrom(cityId) { return [...this.routes.values()].filter((entry) => entry.from_city_canonical_id === cityId); }
  getMonster(id) { return required(this.monsters,id,'monster'); }
  listMonsterPlacements(monsterId) { return this.placementsByMonster.get(monsterId) ?? []; }
  listMonstersAtMapNode(mapNodeId,state=null) {
    if(state?.dungeon) {
      const dungeon=this.getDungeon(state.dungeon.canonical_id);
      const stage=dungeon.stages.find((entry)=>entry.canonical_id===state.dungeon.stage_canonical_id);
      return stage?.monster?[this.getMonster(stage.monster.canonical_id)]:[];
    }
    return this.monsterPlacements.filter((entry)=>entry.map_node_canonical_id===mapNodeId)
      .map((entry)=>({ ...this.getMonster(entry.monster_canonical_id),placement:entry }));
  }
  getDungeon(id) { return required(this.dungeons,id,'dungeon'); }
  listDungeonsAtMapNode(mapNodeId) { return [...this.dungeons.values()].filter((entry)=>entry.map_node_canonical_id===mapNodeId); }
  getItem(id) { return this.items.get(id) ?? this.equipment.get(id) ?? null; }
  findItemByName(name) { return [...this.items.values(),...this.equipment.values()].find((entry)=>entry.display_name===name)??null; }
  getEquipment(id) { return required(this.equipment,id,'equipment'); }
  getShopEntry(id) { return required(this.shopEntries,id,'shop entry'); }
  listDrops(monsterId) { return this.dropsByMonster.get(monsterId) ?? []; }
  getRecoveryService(id) { return required(this.recoveryServices,id,'recovery service'); }
  listRecoveryServices() { return [...this.recoveryServices.values()]; }
  listRecoveryServicesAt(mapNodeId) { return this.listRecoveryServices().filter((entry) => entry.map_node_canonical_id === mapNodeId); }
  getFishingGear(id) { return required(this.fishingGear,id,'fishing gear'); }
  listFishingCatches() { return [...this.fishingCatches.values()]; }
}

class ShipRuntime {
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  purchase(playerId,shipId,eventId) {
    const ship = this.catalog.getShip(shipId);
    return transactEvent(this.storage,playerId,eventId,'ship_purchase',{ ship_canonical_id:shipId },this.clock,(state) => {
      if (state.owned_ships[shipId]) return { applied:false,reason:'already_owned',ship_canonical_id:shipId };
      if (!atPort(state,ship.city_canonical_id,ship.port_map_node_canonical_id)) throw new Error('Ship purchase requires its formal port location');
      const limit = Math.min(6,Math.floor(state.player.level / 10) + 1);
      if (Object.keys(state.owned_ships).length >= limit) throw new Error('Owned ship limit reached');
      if (state.player.money < ship.price) throw new Error('Insufficient money for ship');
      state.player.money -= ship.price;
      state.owned_ships[shipId] = { purchased_at:this.clock(),source_canonical_id:ship.source_canonical_id ?? null };
      state.current_ship_canonical_id = shipId;
      return { applied:true,action:'ship_purchased',ship_canonical_id:shipId,price:ship.price,money:state.player.money };
    });
  }
  select(playerId,shipId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'ship_select',{ ship_canonical_id:shipId },this.clock,(state) => {
      if (!state.owned_ships[shipId]) throw new Error('Ship is not owned');
      state.current_ship_canonical_id = shipId;
      return { applied:true,action:'ship_selected',ship_canonical_id:shipId };
    });
  }
}

class VoyageRuntime {
  constructor({ storage,catalog,taskEngine = null,taskCatalog = null,maritimeRuntime=null,clock = isoNow }) {
    this.storage=storage;this.catalog=catalog;this.taskEngine=taskEngine;this.taskCatalog=taskCatalog;this.maritimeRuntime=maritimeRuntime;this.clock=clock;
  }
  start(playerId,routeId,eventId) {
    const route = this.catalog.getRoute(routeId);
    return transactEvent(this.storage,playerId,eventId,'voyage_start',{ route_canonical_id:routeId },this.clock,(state) => {
      if (state.voyage) throw new Error('A voyage is already active');
      if (!state.current_ship_canonical_id || !state.owned_ships[state.current_ship_canonical_id]) throw new Error('Voyage requires an owned current ship');
      if (!atPort(state,route.from_city_canonical_id,route.from_port_map_node_canonical_id)) throw new Error('Voyage must start at the formal departure port');
      if (route.required_task_canonical_id && !route.allowed_task_statuses.includes(state.tasks[route.required_task_canonical_id]?.status)) {
        throw new Error('Voyage task condition is not satisfied');
      }
      if (state.player.money < Number(route.fee ?? 0)) throw new Error('Insufficient money for voyage fee');
      state.player.money -= Number(route.fee ?? 0);
      const ship = this.catalog.getShip(state.current_ship_canonical_id);
      state.voyage = {
        canonical_id:`voyage.${eventId}`,route_canonical_id:routeId,from_city_canonical_id:route.from_city_canonical_id,
        to_city_canonical_id:route.to_city_canonical_id,ship_canonical_id:ship.canonical_id,
        total_distance:Number(route.distance),remaining_distance:Number(route.distance),speed:Number(ship.speed),
        started_at:this.clock(),last_advanced_at:null,
      };
      return { applied:true,action:'voyage_started',voyage:{ ...state.voyage },fee:Number(route.fee ?? 0) };
    });
  }
  advance(playerId,eventId,{ ticks=1 }={}) {
    ticks=positive(ticks);
    const result=transactEvent(this.storage,playerId,eventId,'voyage_advance',{ ticks },this.clock,(state) => {
      if (!state.voyage) throw new Error('No active voyage');
      if (state.fishing || state.dungeon || state.maritime_encounter) throw new Error('Resolve the active maritime activity before advancing');
      const maritimeResult=this.maritimeRuntime?.step(state);
      if(maritimeResult)return {applied:true,...maritimeResult};
      if (state.voyage.last_advance_event_id) delete state.gameplay_events[state.voyage.last_advance_event_id];
      state.voyage.last_advance_event_id=eventId;
      state.voyage.remaining_distance = Math.max(0,state.voyage.remaining_distance - state.voyage.speed*ticks);
      state.voyage.last_advanced_at = this.clock();
      const route = this.catalog.getRoute(state.voyage.route_canonical_id);
      if (state.voyage.remaining_distance > 0) {
        const encounter=this.maritimeRuntime?.checkRouteEncounter(state,route);
        if(encounter)return {applied:true,...encounter,remaining_distance:state.voyage.remaining_distance};
        return { applied:true,action:'voyage_advanced',remaining_distance:state.voyage.remaining_distance };
      }
      state.player.current_map_node_canonical_id = route.to_port_map_node_canonical_id;
      if (!state.unlocked_map_nodes.includes(route.to_port_map_node_canonical_id)) state.unlocked_map_nodes.push(route.to_port_map_node_canonical_id);
      const completed = state.voyage;
      state.voyage = null;
      return { applied:true,action:'voyage_arrived',route_canonical_id:route.canonical_id,
        location_canonical_id:route.to_port_location_canonical_id,completed_voyage:completed };
    });
    if (result.action === 'voyage_arrived' && this.taskEngine) {
      result.task_event=this.taskEngine.processEvent(playerId,{ event_id:`${eventId}.arrival`,type:'arrive_at_location',
        location_canonical_id:result.location_canonical_id,arrival_source:'voyage',route_canonical_id:result.route_canonical_id });
    }
    return result;
  }
}

class MaritimeRuntime {
  constructor({storage,catalog,random=Math.random,clock=isoNow}) {this.storage=storage;this.catalog=catalog;this.random=random;this.clock=clock;}
  step(state) {
    const rules=this.catalog.maritime.sailing;if(!rules)return null;
    if(this.random()<Number(rules.special_event_trigger_probability))return this.applySpecialEvent(state,rules);
    if(this.random()<Number(rules.ship_dungeon_encounter_probability??0)) {
      const names=rules.source_ship_dungeon_order??[];const name=names[Math.min(names.length-1,Math.floor(this.random()*names.length))];
      if(name){state.maritime_encounter={kind:'ship_dungeon',display_name:name,discovered_at:this.clock()};
        return {action:'ship_dungeon_discovery',encounter:{...state.maritime_encounter}};}
    }
    return null;
  }
  checkRouteEncounter(state,route) {
    const candidates=(this.catalog.maritime.sailing?.route_encounters??[]).filter((entry)=>{
      const [from,to]=entry.route_canonical_ids??[];return from===route.from_city_canonical_id&&to===route.to_city_canonical_id;
    });
    for(const entry of candidates)if(this.random()<Number(entry.probability)) {
      state.maritime_encounter={kind:'route_location',display_name:entry.location,position:entry.position,
        city_canonical_id:entry.city_canonical_id,location_canonical_id:entry.location_canonical_id,
        map_node_canonical_id:entry.map_node_canonical_id,discovered_at:this.clock()};
      return {action:'route_location_discovery',encounter:{...state.maritime_encounter}};
    }
    return null;
  }
  enterRouteLocation(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'maritime_route_location_enter',{},this.clock,(state)=>{
      const encounter=state.maritime_encounter;
      if(!state.voyage||encounter?.kind!=='route_location')throw new Error('No route location encounter is active');
      if(!encounter.map_node_canonical_id||!encounter.location_canonical_id)throw new Error('Route location encounter lacks a formal map destination');
      state.player.current_map_node_canonical_id=encounter.map_node_canonical_id;
      if(!state.unlocked_map_nodes.includes(encounter.map_node_canonical_id))state.unlocked_map_nodes.push(encounter.map_node_canonical_id);
      state.voyage.route_location_context={city_canonical_id:encounter.city_canonical_id,location_canonical_id:encounter.location_canonical_id,
        map_node_canonical_id:encounter.map_node_canonical_id,entered_at:this.clock()};
      state.maritime_encounter=null;
      return {applied:true,action:'route_location_entered',city_canonical_id:encounter.city_canonical_id,
        location_canonical_id:encounter.location_canonical_id,map_node_canonical_id:encounter.map_node_canonical_id,voyage_preserved:true};
    });
  }
  dismiss(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'maritime_encounter_dismiss',{},this.clock,(state)=>{
      if(!state.voyage||!state.maritime_encounter)throw new Error('No maritime encounter is active');
      const encounter=state.maritime_encounter;state.maritime_encounter=null;
      return {applied:true,action:'maritime_encounter_dismissed',encounter};
    });
  }
  applySpecialEvent(state,rules) {
    const marketIds=Object.keys(state.inventory).filter((id)=>Number(this.catalog.getItem(id)?.normalized_data?.type??this.catalog.getItem(id)?.type)===11);
    const marketCount=marketIds.reduce((sum,id)=>sum+Number(state.inventory[id]),0);const luck=Number(state.player.luck??60);
    const weighted=(rules.special_events??[]).filter((entry)=>entry.effect.type!=='equipmentReward'||marketCount>99)
      .map((entry)=>{let weight=Number(entry.probability);if(luck<60)weight*=entry.luckFactor<0?1.5:entry.luckFactor>0?0.5:1;
        else if(luck>=80)weight*=entry.luckFactor<0?0.5:entry.luckFactor>0?1.5:1;return {entry,weight};});
    const total=weighted.reduce((sum,item)=>sum+item.weight,0);let roll=this.random()*total;let event=weighted.at(-1)?.entry;
    for(const item of weighted){roll-=item.weight;if(roll<=0){event=item.entry;break;}}
    if(!event)return null;const effect=event.effect;const result={action:'sailing_special_event',event_name:event.name,event_type:effect.type,tip:event.tip};
    if(effect.type==='morale')state.player.morale=Math.min(100,Number(state.player.morale)+Number(effect.value));
    else if(effect.type==='moraleLoss')state.player.morale=Math.max(0,Number(state.player.morale)-Number(effect.value));
    else if(effect.type==='luckBoost')state.player.luck=Math.min(100,luck+Number(effect.value));
    else if(effect.type==='speedBoost')state.voyage.speed+=Number(effect.value);
    else if(effect.type==='timeLoss')state.voyage.speed=Math.max(1,state.voyage.speed-Number(effect.value));
    else if(effect.type==='distanceBoost')state.voyage.remaining_distance=Math.max(0,state.voyage.remaining_distance-Math.floor(state.voyage.remaining_distance*Number(effect.value)));
    else if(effect.type==='shipDamage'){const repairCost=Number(effect.repairCost);result.lost_copper=Math.min(Number(state.player.money),repairCost);
      state.player.money=Math.max(0,Number(state.player.money)-repairCost);}
    else if(effect.type==='expGain'){state.player.experience+=Number(effect.value);result.experience=Number(effect.value);result.progression=applyExperienceProgression(state);}
    else if(effect.type==='treasure'){let totalCopper=0;for(const item of effect.items??[])if(item.name==='铜贝')totalCopper+=randomInteger(item.min,item.max,this.random);
      state.player.money+=totalCopper;result.copper=totalCopper;}
    else if(effect.type==='marketLoss')result.lost_supplies=applyMarketLoss(state,this.catalog,marketIds,effect,this.random);
    else if(effect.type==='pirateAttack'){result.lost_copper=Math.floor(state.player.money*Number(effect.lossPercent));state.player.money-=result.lost_copper;
      const id=marketIds[Math.min(marketIds.length-1,Math.floor(this.random()*marketIds.length))];result.lost_supplies=id?Math.floor(state.inventory[id]*Number(effect.lossPercent)):0;
      if(id&&result.lost_supplies)setInventory(state,id,state.inventory[id]-result.lost_supplies);}
    else if(effect.type==='equipmentReward'){const name=effect.equipmentList[Math.min(effect.equipmentList.length-1,Math.floor(this.random()*effect.equipmentList.length))];
      const item=this.catalog.findItemByName(name);if(item){state.inventory[item.canonical_id]=(state.inventory[item.canonical_id]??0)+1;result.content_entity_canonical_id=item.canonical_id;}}
    return result;
  }
}

class FishingRuntime {
  constructor({ storage,catalog,taskEngine=null,random=Math.random,clock=isoNow }) {
    this.storage=storage;this.catalog=catalog;this.taskEngine=taskEngine;this.random=random;this.clock=clock;
  }
  start(playerId,rodId,baitId,eventId) {
    const rod=this.catalog.getFishingGear(rodId);const bait=this.catalog.getFishingGear(baitId);
    return transactEvent(this.storage,playerId,eventId,'fishing_start',{rod_canonical_id:rodId,bait_canonical_id:baitId},this.clock,(state)=>{
      if(!state.voyage||state.combat||state.dungeon)throw new Error('Fishing requires an active idle voyage');
      if(state.fishing)throw new Error('Fishing is already active');
      if(Number(rod.type)!==14||Number(bait.type)!==8)throw new Error('Fishing requires a rod and bait');
      if((state.inventory[rodId]??0)<1||(state.inventory[baitId]??0)<1)throw new Error('Fishing gear is not in inventory');
      state.fishing={rod_canonical_id:rodId,bait_canonical_id:baitId,from_city_canonical_id:state.voyage.from_city_canonical_id,
        to_city_canonical_id:state.voyage.to_city_canonical_id,phase:'ready',wait_count:0,reel_count:0,let_out_count:0,success_factor:1,started_at:this.clock()};
      return {applied:true,action:'fishing_started',fishing:{...state.fishing}};
    });
  }
  cast(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'fishing_cast',{},this.clock,(state)=>{
      if(!state.voyage||!state.fishing||state.fishing.phase!=='ready')throw new Error('Fishing cast requires a ready active fishing session');
      const baitId=state.fishing.bait_canonical_id;if((state.inventory[baitId]??0)<1)throw new Error('Fishing bait is exhausted');
      setInventory(state,baitId,state.inventory[baitId]-1);state.fishing.phase='waiting';state.fishing.wait_count=0;state.fishing.reel_count=0;
      state.fishing.let_out_count=0;state.fishing.success_factor=1;
      return {applied:true,action:'fishing_cast',bait_canonical_id:baitId,remaining_bait:state.inventory[baitId]??0};
    });
  }
  wait(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'fishing_wait',{},this.clock,(state)=>{
      if(!state.fishing||!['waiting','hooked'].includes(state.fishing.phase))throw new Error('Fishing wait requires a cast line');
      const session=state.fishing;session.wait_count+=1;session.success_factor=Math.max(0.1,session.success_factor+(session.wait_count<=3?0.1:-0.05));
      const trigger=Math.min(0.1+session.wait_count*0.05,0.5);let outcome='nothing';let eventTriggered=false;
      if(this.random()<trigger){eventTriggered=true;outcome=chooseFishingWaitOutcome(this.random);}
      if(outcome==='bite')session.phase='hooked';
      if(outcome==='line_snapped'||outcome==='bait_eaten'){
        session.phase='ready';session.wait_count=0;session.reel_count=0;session.let_out_count=0;
      }
      return {applied:true,action:'fishing_waited',outcome,event_triggered:eventTriggered,trigger_probability:trigger,fishing:{...session}};
    });
  }
  reel(playerId,eventId) {
    const result=transactEvent(this.storage,playerId,eventId,'fishing_reel',{},this.clock,(state)=>{
      if(!state.fishing||!['waiting','hooked','pulling'].includes(state.fishing.phase))throw new Error('Fishing reel requires a cast line');
      const session=state.fishing;session.reel_count+=1;session.success_factor=Math.max(0.1,session.success_factor+(session.reel_count<=2?0.15:-0.1));
      const catchProbability=(session.reel_count>=3?Math.min(0.1+session.reel_count*0.1,0.8):0.1)*session.success_factor;
      const roll=this.random();
      if(roll<catchProbability){const caught=chooseFishingCatch(this.catalog,session,this.random);session.phase='ready';
        if(!caught)return {applied:true,action:'fishing_empty',reason:'no_route_bait_match',catch_probability:catchProbability};
        state.inventory[caught.content_entity_canonical_id]=(state.inventory[caught.content_entity_canonical_id]??0)+1;
        return {applied:true,action:'fish_caught',content_entity_canonical_id:caught.content_entity_canonical_id,display_name:caught.display_name,
          rarity:caught.rarity,quantity:1,catch_probability:catchProbability};}
      const outcome=roll<catchProbability+0.2?'fish_lost':roll<catchProbability+0.4?'fish_tiring':'pulling';
      if(outcome==='fish_lost')session.phase='ready';else session.phase='pulling';
      return {applied:true,action:'fishing_reeled',outcome,catch_probability:catchProbability,fishing:{...session}};
    });
    if(result.action==='fish_caught'&&this.taskEngine)this.taskEngine.synchronizeInventory(playerId);
    return result;
  }
  letOut(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'fishing_let_out',{},this.clock,(state)=>{
      if(!state.fishing||!['hooked','pulling'].includes(state.fishing.phase))throw new Error('Letting out line requires a hooked fish');
      const session=state.fishing;session.let_out_count+=1;session.success_factor=Math.max(0.1,session.success_factor+(session.let_out_count<=2?0.1:-0.05));
      const bigFishProbability=Math.min(0.1+session.let_out_count*0.05,0.5);const roll=this.random();
      const outcome=roll<bigFishProbability?'big_fish':roll<bigFishProbability+0.1?'fish_lost':'line_released';
      session.phase=outcome==='fish_lost'?'ready':'pulling';
      return {applied:true,action:'fishing_line_released',outcome,big_fish_probability:bigFishProbability,fishing:{...session}};
    });
  }
  stop(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'fishing_stop',{},this.clock,(state)=>{
      if(!state.fishing)throw new Error('Fishing is not active');state.fishing=null;return {applied:true,action:'fishing_stopped'};
    });
  }
}

class DivingRuntime {
  constructor({storage,catalog,random=Math.random,clock=isoNow}) {this.storage=storage;this.catalog=catalog;this.random=random;this.clock=clock;}
  dive(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'diving_attempt',{},this.clock,(state)=>{
      if(!state.voyage||state.combat||state.dungeon||state.fishing)throw new Error('Diving requires an active idle voyage');
      const rules=this.catalog.maritime.diving;if(!rules)throw new Error('Formal diving rules are unavailable');
      state.maritime_encounter=null;
      if(this.random()>=Number(rules.encounter_probability))return {applied:true,action:'diving_no_discovery'};
      const availability=[...(rules.availability??[])].sort((a,b)=>Number(b.minimum_level)-Number(a.minimum_level));
      const count=availability.find((entry)=>state.player.level>=Number(entry.minimum_level))?.count;
      const available=rules.source_dungeon_order.slice(0,count===null||count===undefined?rules.source_dungeon_order.length:Number(count));
      const displayName=available[Math.min(available.length-1,Math.floor(this.random()*available.length))];
      const dungeon=[...this.catalog.dungeons.values()].find((entry)=>entry.display_name===displayName&&entry.entry_mode==='diving_encounter');
      if(!dungeon)return {applied:true,action:'diving_unresolved_discovery',display_name:displayName};
      state.maritime_encounter={kind:'diving_dungeon',dungeon_canonical_id:dungeon.canonical_id,display_name:dungeon.display_name,discovered_at:this.clock()};
      return {applied:true,action:'diving_discovery',encounter:{...state.maritime_encounter}};
    });
  }
  enter(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'diving_enter',{},this.clock,(state)=>{
      if(!state.voyage||state.combat||state.dungeon||state.fishing||state.maritime_encounter?.kind!=='diving_dungeon')throw new Error('No enterable diving discovery is active');
      const dungeon=this.catalog.getDungeon(state.maritime_encounter.dungeon_canonical_id);
      state.dungeon={canonical_id:dungeon.canonical_id,stage_canonical_id:dungeon.entry_stage_canonical_id,entered_at:this.clock(),
        completion_rewards_enabled:false,entry_mode:'diving_encounter',return_context:'voyage'};state.maritime_encounter=null;
      return {applied:true,action:'diving_dungeon_entered',dungeon:{...state.dungeon}};
    });
  }
}

class EconomyRuntime {
  constructor({ storage,catalog,taskEngine = null,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.taskEngine=taskEngine;this.clock=clock; }
  buy(playerId,entryId,quantity,eventId) {
    const entry = this.catalog.getShopEntry(entryId);
    quantity = positive(quantity);
    const result=transactEvent(this.storage,playerId,eventId,'shop_buy',{ shop_entry_canonical_id:entryId,quantity },this.clock,(state) => {
      if (entry.location_canonical_id && state.player.current_map_node_canonical_id !== entry.map_node_canonical_id) throw new Error('Shop is not at the current formal location');
      const total = Number(entry.price) * quantity;
      if (state.player.money < total) throw new Error('Insufficient money');
      if (!entry.inventory_weight_exempt && formalInventoryUsed(state,this.catalog) + quantity > state.inventory_capacity) throw new Error('Inventory capacity exceeded');
      const itemId = entry.task_item_canonical_id ?? entry.content_entity_canonical_id;
      state.player.money -= total;
      state.inventory[itemId] = (state.inventory[itemId] ?? 0) + quantity;
      state.shop_transactions[eventId] = { action:'buy',entry_canonical_id:entryId,source_item_canonical_id:entry.content_entity_canonical_id,
        granted_item_canonical_id:itemId,quantity,total,processed_at:this.clock() };
      return { applied:true,action:'shop_bought',item_canonical_id:itemId,quantity,total,money:state.player.money };
    });
    if (this.taskEngine) this.taskEngine.synchronizeInventory(playerId);
    return result;
  }
  sell(playerId,entryId,quantity,eventId) {
    const entry = this.catalog.getShopEntry(entryId);
    quantity = positive(quantity);
    const result=transactEvent(this.storage,playerId,eventId,'shop_sell',{ shop_entry_canonical_id:entryId,quantity },this.clock,(state) => {
      if (entry.location_canonical_id && state.player.current_map_node_canonical_id !== entry.map_node_canonical_id) throw new Error('Shop is not at the current formal location');
      const itemId = entry.task_item_canonical_id ?? entry.content_entity_canonical_id;
      if ((state.inventory[itemId] ?? 0) < quantity) throw new Error('Insufficient item quantity');
      assertInventoryRemovalAllowed(state,itemId,quantity,{reason:'shop_sell'});
      const total = Math.max(1,Math.floor(Number(entry.price) * 0.2)) * quantity;
      setInventory(state,itemId,state.inventory[itemId]-quantity);
      state.player.money += total;
      state.shop_transactions[eventId] = { action:'sell',entry_canonical_id:entryId,item_canonical_id:itemId,quantity,total,processed_at:this.clock() };
      return { applied:true,action:'shop_sold',item_canonical_id:itemId,quantity,total,money:state.player.money };
    });
    if (this.taskEngine) this.taskEngine.synchronizeInventory(playerId);
    return result;
  }
}

class RecoveryRuntime {
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  recover(playerId,serviceId,eventId) {
    const service=this.catalog.getRecoveryService(serviceId);
    return transactEvent(this.storage,playerId,eventId,'health_recovery',{ recovery_service_canonical_id:serviceId },this.clock,(state) => {
      if (state.combat) throw new Error('Recovery is not available during combat');
      if (state.player.current_map_node_canonical_id !== service.map_node_canonical_id) throw new Error('Recovery service is not at the current formal location');
      const fee=Number(service.fee ?? 0);
      if (state.player.money < fee) throw new Error('Insufficient money for recovery');
      const before=Number(state.player.current_health);
      const maximum=effectiveStats(state,this.catalog).max_health;
      const amount=service.recovery_kind === 'full_health' ? maximum-before : Math.min(Number(service.amount ?? 0),maximum-before);
      if (amount <= 0) return { applied:false,reason:'health_already_full',service_canonical_id:serviceId,current_health:before,max_health:maximum };
      state.player.money-=fee;
      state.player.current_health=before+amount;
      return { applied:true,action:'health_recovered',service_canonical_id:serviceId,recovered_health:amount,
        current_health:state.player.current_health,max_health:maximum,fee,money:state.player.money };
    });
  }
}

class ItemRuntime {
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  use(playerId,itemId,eventId) {
    const item=this.catalog.getItem(itemId);
    if (!item) throw new Error(`Unknown formal item: ${itemId}`);
    const data=item.normalized_data ?? item.attributes ?? {};
    const healing=Number(data.info?.heal ?? item.heal ?? 0);
    if (Number(data.type ?? item.item_type) !== 4 || healing <= 0) throw new Error('Item has no supported runtime use semantics');
    return transactEvent(this.storage,playerId,eventId,'item_use',{ item_canonical_id:itemId },this.clock,(state) => {
      if ((state.inventory[itemId] ?? 0) < 1) throw new Error('Item is not in inventory');
      const maximum=effectiveStats(state,this.catalog).max_health;
      if (state.player.current_health >= maximum) return { applied:false,reason:'health_already_full',item_canonical_id:itemId,current_health:state.player.current_health,max_health:maximum };
      const before=state.player.current_health;
      assertInventoryRemovalAllowed(state,itemId,1,{reason:'item_use'});
      setInventory(state,itemId,state.inventory[itemId]-1);
      state.player.current_health=Math.min(maximum,before+healing);
      return { applied:true,action:'item_used',item_canonical_id:itemId,recovered_health:state.player.current_health-before,
        current_health:state.player.current_health,max_health:maximum };
    });
  }
}

class EquipmentRuntime {
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  equip(playerId,equipmentId,eventId,accessoryIndex = null) {
    const item = this.catalog.getEquipment(equipmentId);
    return transactEvent(this.storage,playerId,eventId,'equipment_equip',{ equipment_canonical_id:equipmentId,accessory_index:accessoryIndex },this.clock,(state) => {
      if ((state.inventory[equipmentId] ?? 0) < 1) throw new Error('Equipment is not in inventory');
      if (state.player.level < Number(item.required_level ?? item.level ?? 1)) throw new Error('Equipment level requirement is not met');
      const slot = item.slot ?? EQUIPMENT_SLOT_BY_TYPE[item.equipment_type ?? item.type];
      if (!slot) throw new Error('Equipment slot is unresolved');
      assertInventoryRemovalAllowed(state,equipmentId,1,{reason:'equipment_equip'});
      let replaced = null;
      if (slot === 'accessories') {
        const index = accessoryIndex === null ? state.equipment.accessories.findIndex((entry) => !entry) : Number(accessoryIndex);
        if (!Number.isInteger(index) || index < 0 || index > 2) throw new Error('Accessory slot must be 0..2');
        replaced = state.equipment.accessories[index];
        state.equipment.accessories[index] = equipmentId;
      } else { replaced=state.equipment[slot];state.equipment[slot]=equipmentId; }
      setInventory(state,equipmentId,state.inventory[equipmentId]-1);
      if (replaced) state.inventory[replaced]=(state.inventory[replaced] ?? 0)+1;
      return { applied:true,action:'equipped',equipment_canonical_id:equipmentId,slot,replaced_equipment_canonical_id:replaced,stats:effectiveStats(state,this.catalog) };
    });
  }
  unequip(playerId,slot,eventId,accessoryIndex = null) {
    return transactEvent(this.storage,playerId,eventId,'equipment_unequip',{ slot,accessory_index:accessoryIndex },this.clock,(state) => {
      const index = slot === 'accessories' ? Number(accessoryIndex) : null;
      const itemId = slot === 'accessories' ? state.equipment.accessories[index] : state.equipment[slot];
      if (!itemId) throw new Error('Equipment slot is empty');
      if (formalInventoryUsed(state,this.catalog) >= state.inventory_capacity) throw new Error('Inventory capacity exceeded');
      if (slot === 'accessories') state.equipment.accessories[index]=null; else state.equipment[slot]=null;
      state.inventory[itemId]=(state.inventory[itemId] ?? 0)+1;
      return { applied:true,action:'unequipped',equipment_canonical_id:itemId,slot,stats:effectiveStats(state,this.catalog) };
    });
  }
}

class MarketRuntime {
  /**
   * 区域特产套利市场。当前城市所在区域特产价 = base_price × 0.75（产区便宜），
   * 非产区商品 = base_price × 1.25（异区贵）。以 market_region.city_region 映射判定玩家所在区域。
   * 若注入了 WorldEconomy（server/eco），则价格进一步叠加 动态供需 + 天气 + 随机波动 影响。
   */
  constructor({ storage,catalog,clock = isoNow,economy = null }) { this.storage=storage;this.catalog=catalog;this.clock=clock;this.economy=economy; }
  marketRegionForCity(state) {
    const marketRegion=this.catalog.content?.market_region?.city_region ?? {};
    let cityId=state.player.current_city_canonical_id;
    // 若玩家未显式记录城市，则从当前 map_node 的城市 canonical_id 派生（地图节点自带城市）
    if (!cityId) {
      const nodeId=state.player.current_map_node_canonical_id;
      const node=(this.catalog.content?.map_nodes??[]).find((n)=>n.map_node_canonical_id===nodeId);
      cityId=node?.city_canonical_id;
    }
    return cityId ? marketRegion[cityId] ?? null : null;
  }
  /** 区域 slug（region.mediterranean）→ 区域中文名（地中海），供世界经济引擎 */
  regionNameForSlug(slug) {
    if (!slug) return null;
    return this.catalog.content?.world_regions?.regions?.[slug]?.name ?? null;
  }
  priceFor(state,good) {
    const cityRegion=this.marketRegionForCity(state);
    const regionFactor=(cityRegion && good.region===cityRegion)?0.75:1.25;
    if (this.economy) {
      // 动态经济：区域基准系数 + 供需/天气/抖动的小幅扰动
      const regionName=this.regionNameForSlug(cityRegion);
      if (regionName) return this.economy.getPrice(good,regionName,regionFactor);
    }
    // 静态回退
    return Math.max(1,Math.round(Number(good.base_price)*regionFactor));
  }
  getMarketView(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId||`market.view.${Date.now()}`,'market_view',{},this.clock,(state) => {
      const cityRegion=this.marketRegionForCity(state);
      const regions=this.catalog.content?.goods?.regions ?? {};
      const allGoods=Object.values(regions).flatMap((entry)=>entry.specialty??[]);
      const offers=allGoods.map((good)=>({ ...good,region_name:regions[good.region]?.name??good.region,
        local_price:this.priceFor(state,good),is_local:cityRegion!=null&&good.region===cityRegion }));
      return { applied:true,action:'market_view_loaded',city_canonical_id:state.player.current_city_canonical_id,
        city_region:cityRegion,city_region_name:this.regionNameForSlug(cityRegion),money:state.player.money,holds:formalInventoryUsed(state,this.catalog),capacity:state.inventory_capacity,cargo_holds:cargoUsed(state),cargo_capacity:cargoCapacity(state),offers };
    });
  }
  buy(playerId,goodId,quantity,eventId) {
    const good=this.findGood(goodId);
    quantity=positive(quantity);
    return transactEvent(this.storage,playerId,eventId,'market_buy',{ good_canonical_id:goodId,quantity },this.clock,(state) => {
      if (!this.marketRegionForCity(state)) throw new Error('Market requires being in a city');
      const price=this.priceFor(state,good);
      const total=price*quantity;
      if (state.player.money<total) throw new Error('Insufficient money');
      // 货物入 cargo 栏（goods 与随身物品不同，独立持久化避开 player_inventory 外键）
      if (cargoUsed(state)+quantity>cargoCapacity(state)) throw new Error('Cargo capacity exceeded');
      state.player.money-=total;
      state.cargo[goodId]=(state.cargo[goodId]??0)+quantity;
      // 交易反馈到世界经济（买走商品 → 该区供给收紧 → 价格抬升），AI 商人博弈核心
      if (this.economy) {
        const regionName = this.regionNameForSlug(this.marketRegionForCity(state));
        if (regionName) this.economy.applyTrade(regionName, good.category ?? 'specialty', -Math.min(0.05, quantity * 0.001));
      }
      return { applied:true,action:'market_bought',good_canonical_id:goodId,quantity,unit_price:price,total,money:state.player.money,cargo:cargoUsed(state) };
    });
  }
  sell(playerId,goodId,quantity,eventId) {
    const good=this.findGood(goodId);
    quantity=positive(quantity);
    return transactEvent(this.storage,playerId,eventId,'market_sell',{ good_canonical_id:goodId,quantity },this.clock,(state) => {
      if (!this.marketRegionForCity(state)) throw new Error('Market requires being in a city');
      if ((state.cargo[goodId]??0)<quantity) throw new Error('Insufficient cargo quantity');
      const price=this.priceFor(state,good);
      const unit=Math.max(1,Math.floor(price*0.9));
      const total=unit*quantity;
      state.cargo[goodId]-=quantity;
      if (state.cargo[goodId]<=0) delete state.cargo[goodId];
      state.player.money+=total;
      // 交易反馈到世界经济（抛售 → 该区供给增 → 价格走低）
      if (this.economy) {
        const regionName = this.regionNameForSlug(this.marketRegionForCity(state));
        if (regionName) this.economy.applyTrade(regionName, good.category ?? 'specialty', Math.min(0.05, quantity * 0.001));
      }
      return { applied:true,action:'market_sold',good_canonical_id:goodId,quantity,unit_price:unit,total,money:state.player.money,cargo:cargoUsed(state) };
    });
  }
  findGood(goodId) {
    const regions=this.catalog.content?.goods?.regions ?? {};
    for (const entry of Object.values(regions)) {
      const good=(entry.specialty??[]).find((x)=>x.canonical_id===goodId||x.name===goodId);
      if (good) return good;
    }
    throw new Error(`Unknown market good: ${goodId}`);
  }
}

class EquipmentEnhanceRuntime {
  /** 装备强化（原版15级失败不降级）。规则在 content.enhance_rules。 */
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  enhance(playerId,equipmentSlot,eventId) {
    const rules=this.catalog.content?.enhance_rules ?? {};
    return transactEvent(this.storage,playerId,eventId,'equipment_enhance',{ equipment_slot:equipmentSlot },this.clock,(state) => {
      const itemId=state.equipment?.[equipmentSlot];
      if (!itemId) throw new Error('Equipment slot is empty');
      const instance=state.equipment_instances?.[itemId] ?? {};
      const level=Number(instance.level??0);
      if (level>=Number(rules.max_level??15)) throw new Error('Equipment already at max enhancement level');
      const cost=Number(rules.cost_base??200)+level*Number(rules.cost_growth??150);
      const materialId=rules.material?.canonical_id;
      const materialQty=Number(rules.material?.per_level??1);
      if (state.player.money<cost) throw new Error('Insufficient money for enhancement');
      if (materialId&&(state.inventory[materialId]??0)<materialQty) throw new Error('Insufficient enhancement material');
      const success=Math.random()<(Number(rules.success_rate??0.8));
      state.player.money-=cost;
      if (materialId) state.inventory[materialId]=Math.max(0,(state.inventory[materialId]??0)-materialQty);
      const previousLevel=level;
      if (success) {
        instance.level=level+1;
        state.equipment_instances[itemId]=instance;
      }
      const stats=effectiveStats(state,this.catalog);
      return { applied:true,action:'equipment_enhanced',equipment_canonical_id:itemId,slot:equipmentSlot,
        previous_level:previousLevel,current_level:instance.level,succeeded:success,cost,stats };
    });
  }
}

class PetRuntime {
  /** 宠物（上限3），capture/feed/setActive/release/rename。 */
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  capture(playerId,petId,eventId) {
    const pet=this.findPet(petId);
    return transactEvent(this.storage,playerId,eventId,'pet_capture',{ pet_canonical_id:petId },this.clock,(state) => {
      const max=Number(this.catalog.content?.pets?.max_pets??3);
      const list=state.player.pets??[];
      if (list.length>=max) throw new Error('Pet limit reached');
      if (list.some((p)=>p.pet_canonical_id===pet.canonical_id)) throw new Error('Pet already owned');
      const entry={ instance_id:`pet.${pet.canonical_id}.${eventId}`,pet_canonical_id:pet.canonical_id,name:pet.name,level:1,experience:0,
        current_health:pet.max_health,max_health:pet.max_health,satiety:80,active:list.length===0,captured_at:this.clock() };
      state.player.pets=[...list,entry];
      return { applied:true,action:'pet_captured',pet:entry,owned:state.player.pets.length };
    });
  }
  feed(playerId,petInstanceId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'pet_feed',{ pet_instance_id:petInstanceId },this.clock,(state) => {
      const pet=(state.player.pets??[]).find((p)=>p.instance_id===petInstanceId);
      if (!pet) throw new Error('Pet not found');
      if ((state.inventory['item.口粮']??0)<1) throw new Error('Pet food is insufficient (需口粮)');
      state.inventory['item.口粮']-=1;
      pet.satiety=Math.min(100,Number(pet.satiety??0)+40);
      pet.current_health=Math.min(pet.max_health,Number(pet.current_health??0)+Math.floor(Number(pet.max_health)*0.2));
      return { applied:true,action:'pet_fed',pet:pet,satiety:pet.satiety };
    });
  }
  setActive(playerId,petInstanceId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'pet_set_active',{ pet_instance_id:petInstanceId },this.clock,(state) => {
      const list=state.player.pets??[];
      const pet=list.find((p)=>p.instance_id===petInstanceId);
      if (!pet) throw new Error('Pet not found');
      for (const p of list) p.active=false;
      pet.active=true;
      return { applied:true,action:'pet_active',pet_instance_id:petInstanceId };
    });
  }
  release(playerId,petInstanceId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'pet_release',{ pet_instance_id:petInstanceId },this.clock,(state) => {
      const list=state.player.pets??[];
      const pet=list.find((p)=>p.instance_id===petInstanceId);
      if (!pet) throw new Error('Pet not found');
      const next=list.filter((p)=>p.instance_id!==petInstanceId);
      state.player.pets=next;
      return { applied:true,action:'pet_released',pet_instance_id:petInstanceId,owned:next.length };
    });
  }
  rename(playerId,petInstanceId,newName,eventId) {
    return transactEvent(this.storage,playerId,eventId,'pet_rename',{ pet_instance_id:petInstanceId,new_name:newName },this.clock,(state) => {
      const pet=(state.player.pets??[]).find((p)=>p.instance_id===petInstanceId);
      if (!pet) throw new Error('Pet not found');
      if (!newName||!String(newName).trim()) throw new Error('Pet name cannot be empty');
      pet.name=String(newName).trim().slice(0,12);
      return { applied:true,action:'pet_renamed',pet:pet };
    });
  }
  findPet(petId) {
    const pets=this.catalog.content?.pets?.pets??[];
    const pet=pets.find((p)=>p.canonical_id===petId||p.name===petId);
    if (!pet) throw new Error(`Unknown pet: ${petId}`);
    return pet;
  }
}

class DiscoverRuntime {
  /** 大航海·探索发现：玩家到达发现物所在地点即触发，奖励金钱/经验/声望。 */
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  visit(playerId,discoveryId,eventId) {
    const discovery=this.findDiscovery(discoveryId);
    return transactEvent(this.storage,playerId,eventId,'discovery_visit',{ discovery_canonical_id:discovery.canonical_id },this.clock,(state) => {
      const found=state.discoveries_found??{};
      if (found[discovery.canonical_id]) return { applied:false,reason:'discovery_already_found',discovery_canonical_id:discovery.canonical_id };
      const node=this.catalog.getNodeForLocation?.(discovery.location_canonical_id);
      if (node && state.player.current_map_node_canonical_id!==node.map_node_canonical_id) throw new Error('Discovery is not at the current location');
      found[discovery.canonical_id]={ found_at:this.clock(),name:discovery.name,reward:discovery.reward };
      state.discoveries_found=found;
      const reward=discovery.reward??{};
      if (reward.money) state.player.money+=Number(reward.money);
      if (reward.experience) { state.player.experience+=Number(reward.experience); applyExperienceProgression(state); }
      if (reward.reputation) state.player.reputation=Number(state.player.reputation??0)+Number(reward.reputation);
      state.player.title=applyTitle(state.player.reputation??0);
      return { applied:true,action:'discovery_found',discovery_canonical_id:discovery.canonical_id,name:discovery.name,
        reward:reward,reputation:state.player.reputation,title:state.player.title,money:state.player.money,experience:state.player.experience };
    });
  }
  listFound(playerId) {
    const state=this.storage.loadPlayer(playerId);
    return { applied:true,action:'discoveries_listed',found:state.discoveries_found??{} };
  }
  findDiscovery(discoveryId) {
    const list=this.catalog.content?.discoveries?.discoveries??[];
    const d=list.find((x)=>x.canonical_id===discoveryId||x.name===discoveryId);
    if (!d) throw new Error(`Unknown discovery: ${discoveryId}`);
    return d;
  }
}

class RecruitRuntime {
  /** 大航海·船员随从：招募上限 max_crew(5)，对玩家属性加成（attack/defense/agility/max_health）。 */
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  recruit(playerId,crewId,eventId) {
    const crew=this.findCrew(crewId);
    return transactEvent(this.storage,playerId,eventId,'crew_recruit',{ crew_canonical_id:crew.canonical_id },this.clock,(state) => {
      const max=Number(this.catalog.content?.crew?.max_crew??5);
      const list=state.player.crew??[];
      if (list.length>=max) throw new Error('Crew limit reached');
      if (list.some((c)=>c.crew_canonical_id===crew.canonical_id)) throw new Error('Crew member already recruited');
      if (state.player.money<Number(crew.recruit_cost??0)) throw new Error('Insufficient money to recruit');
      state.player.money-=Number(crew.recruit_cost??0);
      list.push({ instance_id:`crew.${crew.canonical_id}.${eventId}`,crew_canonical_id:crew.canonical_id,name:crew.name,role:crew.role,
        personality:crew.personality ?? '忠诚的船员',loyalty:60,recruited_at:this.clock() });
      state.player.crew=list;
      return { applied:true,action:'crew_recruited',crew:crew.canonical_id,money:state.player.money,crew_count:list.length };
    });
  }
  dismiss(playerId,crewInstanceId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'crew_dismiss',{ crew_instance_id:crewInstanceId },this.clock,(state) => {
      const list=state.player.crew??[];
      const crew=list.find((c)=>c.instance_id===crewInstanceId);
      if (!crew) throw new Error('Crew member not found');
      state.player.crew=list.filter((c)=>c.instance_id!==crewInstanceId);
      return { applied:true,action:'crew_dismissed',crew_count:state.player.crew.length };
    });
  }
  crewBonuses(state) {
    const { loyaltyFactor } = require("server/ai/ai-crew.js");
    const bonuses={ attack:0,defense:0,agility:0,max_health:0 };
    for (const c of state.player.crew??[]) {
      const def=this.catalog.content?.crew?.crew?.find((x)=>x.canonical_id===c.crew_canonical_id);
      if (!def) continue;
      const factor = loyaltyFactor(c.loyalty ?? 60); // 忠诚度折算加成
      bonuses.attack+=Math.round(Number(def.attack_bonus??0)*factor);
      bonuses.defense+=Math.round(Number(def.defense_bonus??0)*factor);
      bonuses.agility+=Math.round(Number(def.agility_bonus??0)*factor);
      bonuses.max_health+=Math.round(Number(def.health_bonus??0)*factor);
    }
    return bonuses;
  }
  findCrew(crewId) {
    const list=this.catalog.content?.crew?.crew??[];
    const c=list.find((x)=>x.canonical_id===crewId||x.name===crewId);
    if (!c) throw new Error(`Unknown crew: ${crewId}`);
    return c;
  }
}

class SkillRuntime {
  /** 大航海·技能职业：skill_points 学习技能树，被动/主动加成战斗/航海/贸易/探索。 */
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  learn(playerId,skillId,eventId) {
    const skill=this.findSkill(skillId);
    return transactEvent(this.storage,playerId,eventId,'skill_learn',{ skill_canonical_id:skill.canonical_id },this.clock,(state) => {
      const learned=state.player.skills??{};
      const level=Number(learned[skill.canonical_id]?.level??0);
      if (level>=Number(skill.max_level??5)) throw new Error('Skill already at max level');
      const points=Number(state.player.skill_points??0);
      const cost=Number(skill.points_per_level??1);
      if (points<cost) throw new Error('Insufficient skill points');
      state.player.skill_points=points-cost;
      learned[skill.canonical_id]={ level:level+1,learned_at:this.clock() };
      state.player.skills=learned;
      return { applied:true,action:'skill_learned',skill:skill.canonical_id,level:learned[skill.canonical_id].level,skill_points:state.player.skill_points };
    });
  }
  listLearned(playerId) {
    const state=this.storage.loadPlayer(playerId);
    const learned=state.player.skills??{};
    return { applied:true,action:'skills_listed',skill_points:state.player.skill_points,learned };
  }
  findSkill(skillId) {
    const list=this.catalog.content?.skills?.skills??[];
    const s=list.find((x)=>x.canonical_id===skillId||x.name===skillId);
    if (!s) throw new Error(`Unknown skill: ${skillId}`);
    return s;
  }
}

class GuildRuntime {
  /** 大航海·商会：成立商会/置办产业（占用资金），商会城市信息存 state.guild。 */
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  establish(playerId,name,eventId) {
    return transactEvent(this.storage,playerId,eventId,'guild_establish',{ name },this.clock,(state) => {
      if (state.guild) throw new Error('A guild already exists');
      const finalName=String(name||'').trim();
      if (!finalName) throw new Error('Guild name cannot be empty');
      const cost=Number(this.catalog.content?.cities?.guild_found_cost??10000);
      if (state.player.money<cost) throw new Error('Insufficient money to found a guild');
      state.player.money-=cost;
      state.guild={ name:finalName,founded_at:this.clock(),city_canonical_id:state.player.current_city_canonical_id,treasury:0 };
      return { applied:true,action:'guild_established',guild:state.guild,money:state.player.money };
    });
  }
  deposit(playerId,amount,eventId) {
    amount=positive(amount);
    return transactEvent(this.storage,playerId,eventId,'guild_deposit',{ amount },this.clock,(state) => {
      if (!state.guild) throw new Error('No guild exists');
      if (state.player.money<amount) throw new Error('Insufficient money');
      state.player.money-=amount;
      state.guild.treasury=Number(state.guild.treasury??0)+amount;
      return { applied:true,action:'guild_deposited',treasury:state.guild.treasury,money:state.player.money };
    });
  }
  listState(playerId) {
    const state=this.storage.loadPlayer(playerId);
    return { applied:true,action:'guild_listed',guild:state.guild??null,city_influence:state.city_influence??{},occupied_cities:state.occupied_cities??[] };
  }
}

class CityRuntime {
  /** 大航海·城市占领/税收：invest 增影响力，占领高影响力城市（占领区免税+收日税）。 */
  constructor({ storage,catalog,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  invest(playerId,cityId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'city_invest',{ city_canonical_id:cityId },this.clock,(state) => {
      const city=this.findCity(cityId);
      if (!state.guild) throw new Error('A guild is required to invest in cities');
      const influence=state.city_influence??{};
      const cost=Number(city.influence_cost??500);
      if (state.player.money<cost) throw new Error('Insufficient money to invest');
      state.player.money-=cost;
      influence[cityId]=(Number(influence[cityId]??0)+1);
      state.city_influence=influence;
      return { applied:true,action:'city_invested',city:cityId,influence:influence[cityId],money:state.player.money };
    });
  }
  declareOccupy(playerId,cityId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'city_occupy',{ city_canonical_id:cityId },this.clock,(state) => {
      const city=this.findCity(cityId);
      const influence=state.city_influence??{};
      const threshold=Number(city.occupy_level??1)*10;
      if (Number(influence[cityId]??0)<threshold) throw new Error('City influence is below the occupation threshold');
      const occupied=state.occupied_cities??[];
      if (occupied.includes(cityId)) throw new Error('City is already occupied');
      occupied.push(cityId);
      state.occupied_cities=occupied;
      return { applied:true,action:'city_occupied',city:cityId,influence:influence[cityId],occupied_cities:occupied };
    });
  }
  collectDailyTax(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'city_tax_collect',{},this.clock,(state) => {
      const occupied=state.occupied_cities??[];
      if (!occupied.length) return { applied:false,reason:'no_occupied_cities' };
      let total=0;
      for (const cityId of occupied) {
        const city=this.findCity(cityId);
        total+=Number(city.daily_tax??0);
      }
      state.player.money+=total;
      state.last_tax_collected_at=this.clock();
      return { applied:true,action:'city_tax_collected',tax_total:total,cities:occupied.length,money:state.player.money };
    });
  }
  listState(playerId) {
    const state=this.storage.loadPlayer(playerId);
    return { applied:true,action:'city_state',city_influence:state.city_influence??{},occupied_cities:state.occupied_cities??[] };
  }
  findCity(cityId) {
    const list=this.catalog.content?.game_cities?.cities??this.catalog.content?.cities?.cities??[];
    const c=list.find((x)=>x.canonical_id===cityId||x.name===cityId);
    if (!c) throw new Error(`Unknown city: ${cityId}`);
    return c;
  }
}

class DropRuntime {
  constructor({ storage,catalog,taskEngine = null,random = Math.random,clock = isoNow }) { this.storage=storage;this.catalog=catalog;this.taskEngine=taskEngine;this.random=random;this.clock=clock; }
  settle(playerId,monsterId,combatId,eventId) {
    const result=transactEvent(this.storage,playerId,eventId,'drop_settlement',{ monster_canonical_id:monsterId,combat_canonical_id:combatId },this.clock,(state) => {
      if (state.drop_settlements[combatId]) return { ...state.drop_settlements[combatId],idempotent_replay:true };
      const activeRequiredItems=this.taskEngine?activeItemTargetIds(state,this.taskEngine.catalog):new Set();
      const granted=applyDrops(state,this.catalog,monsterId,this.random,null,activeRequiredItems);
      const settlement={ applied:true,action:'drops_settled',combat_canonical_id:combatId,monster_canonical_id:monsterId,granted,processed_at:this.clock() };
      state.drop_settlements[combatId]=settlement;
      trimObject(state.drop_settlements,DROP_SETTLEMENT_REPLAY_WINDOW);
      return settlement;
    });
    if (this.taskEngine) this.taskEngine.synchronizeInventory(playerId);
    return result;
  }
}

class CombatRuntime {
  constructor({ storage,catalog,taskEngine = null,dropRuntime = null,random = Math.random,clock = isoNow }) {
    this.storage=storage;this.catalog=catalog;this.taskEngine=taskEngine;this.dropRuntime=dropRuntime;this.random=random;this.clock=clock;
  }
  start(playerId,monsterId,eventId) {
    const monster=this.catalog.getMonster(monsterId);
    return transactEvent(this.storage,playerId,eventId,'combat_start',{ monster_canonical_id:monsterId },this.clock,(state) => {
      if (state.combat) throw new Error('Combat is already active');
      const dungeonPlacement=state.dungeon&&monster.dungeon_canonical_id===state.dungeon.canonical_id&&monster.dungeon_stage_canonical_id===state.dungeon.stage_canonical_id;
      const placement=dungeonPlacement?{ canonical_id:monster.dungeon_stage_canonical_id,location_canonical_id:monster.location_canonical_id,
        encounter_type:monster.encounter_type,repeatable:monster.repeatable }:
        this.catalog.listMonsterPlacements(monsterId).find((entry)=>entry.map_node_canonical_id===state.player.current_map_node_canonical_id);
      if(!placement)throw new Error('Monster is not at the current formal location');
      const activeTaskIds=activeMonsterTargetTaskIds(state,monsterId,this.taskEngine?.catalog);
      if(placement.encounter_type==='task_exclusive'&&!activeTaskIds.length)throw new Error('Task-exclusive monster requires an active matching task');
      const taskContextCanonicalId=placement.encounter_type==='task_exclusive'?activeTaskIds[0]:null;
      const defeatKey=encounterDefeatKey(placement,taskContextCanonicalId);
      if(placement.repeatable===false&&state.encounter_defeats?.[defeatKey])throw new Error('Non-repeatable encounter is already defeated');
      const stats=monsterStats(monster);
      state.combat={ canonical_id:`combat.${eventId}`,monster_canonical_id:monsterId,placement_canonical_id:placement.canonical_id,location_canonical_id:placement.location_canonical_id,
        task_context_canonical_id:taskContextCanonicalId,encounter_defeat_key:defeatKey,monster_current_health:stats.health,monster_stats:stats,round:0,started_at:this.clock() };
      return { applied:true,action:'combat_started',combat:{ ...state.combat } };
    });
  }
  attack(playerId,eventId,{ rounds=1 }={}) {
    rounds=positive(rounds);
    const result=transactEvent(this.storage,playerId,eventId,'combat_attack',{ rounds },this.clock,(state) => {
      if (!state.combat) throw new Error('No active combat');
      if (state.combat.last_attack_event_id) {
        const previous=state.gameplay_events[state.combat.last_attack_event_id];
        if(!hasAppliedStamina(previous?.result))delete state.gameplay_events[state.combat.last_attack_event_id];
      }
      state.combat.last_attack_event_id=eventId;
      let result;const appliedStaminaItems=[];
      for(let batchRound=0;batchRound<rounds;batchRound+=1) {
        const stats=effectiveStats(state,this.catalog);const combat=state.combat;
        combat.round+=1;
        const playerDamage=damage(stats.attack,stats.max_attack,combat.monster_stats.defense,stats.agility,combat.monster_stats.agility,this.random);
        const activePet=(state.player.pets??[]).find((p)=>p.active);
        const petDamage=activePet?damage(activePet.attack??0,(activePet.attack??0)+Math.floor((activePet.attack??0)*0.6),combat.monster_stats.defense,activePet.speed??0,combat.monster_stats.agility,this.random):0;
        combat.monster_current_health=Math.max(0,combat.monster_current_health-playerDamage-petDamage);
        if (combat.monster_current_health===0) {
          const monster=this.catalog.getMonster(combat.monster_canonical_id);const combatId=combat.canonical_id;
          const experience=Number(monster.rewards?.experience);const money=Number(monster.rewards?.copper);
          if(!Number.isFinite(experience)||!Number.isFinite(money))throw new Error(`Monster reward rule missing: ${monster.canonical_id}`);
          state.player.experience+=experience;state.player.money+=money;const progression=applyExperienceProgression(state);state.combat=null;
          if(activePet){activePet.experience=(activePet.experience??0)+Math.floor(experience*0.5);}
          if(monster.repeatable===false)state.encounter_defeats[combat.encounter_defeat_key??combat.placement_canonical_id]={defeated_at:this.clock(),monster_canonical_id:monster.canonical_id,task_context_canonical_id:combat.task_context_canonical_id??null};
          recordPlayerMemory(state,{type:'combat',text:`击败了${monster.display_name??monster.canonical_id}${monster.repeatable===false?'（强敌）':''}`,importance:monster.repeatable===false?3:1});
          adjustCrewLoyalty(state, +2); // 并肩取胜 → 船员忠诚提升
          return { applied:true,action:'combat_won',combat_canonical_id:combatId,monster_canonical_id:monster.canonical_id,
            location_canonical_id:combat.location_canonical_id,player_damage:playerDamage,pet_damage:petDamage,experience,money,progression,
            stamina_item:appliedStaminaItems.at(-1)??null,stamina_items:[...appliedStaminaItems],batched_rounds:batchRound+1 };
        }
        const monsterDamage=damage(combat.monster_stats.attack,combat.monster_stats.max_attack,stats.defense,combat.monster_stats.agility,stats.agility,this.random);
        state.player.current_health=Math.max(0,state.player.current_health-monsterDamage);
        const staminaItem=state.player.current_health>0?useActiveStaminaItem(state,this.catalog,{automatic:true}):{applied:false,reason:'player_defeated'};
        if(staminaItem.applied)appliedStaminaItems.push(staminaItem);
        if (state.player.current_health===0) {
          const defeatedAt=state.player.current_map_node_canonical_id;
          state.player.current_health=1;
          state.player.current_map_node_canonical_id=state.player.defeat_return_map_node_canonical_id ?? state.player.current_map_node_canonical_id;
          if (!state.unlocked_map_nodes.includes(state.player.current_map_node_canonical_id)) state.unlocked_map_nodes.push(state.player.current_map_node_canonical_id);
          state.combat=null;state.dungeon=null;state.voyage=null;state.fishing=null;state.maritime_encounter=null;
          adjustCrewLoyalty(state, -5); // 落败 → 船员忠诚受挫
          return { applied:true,action:'combat_lost',player_damage:playerDamage,monster_damage:monsterDamage,
            stamina_item:appliedStaminaItems.at(-1)??staminaItem,stamina_items:[...appliedStaminaItems],
            defeated_at_map_node_canonical_id:defeatedAt,return_map_node_canonical_id:state.player.current_map_node_canonical_id,current_health:1,batched_rounds:batchRound+1 };
        }
        result={ applied:true,action:'combat_round',player_damage:playerDamage,monster_damage:monsterDamage,pet_damage:petDamage,
          stamina_item:appliedStaminaItems.at(-1)??staminaItem,stamina_items:[...appliedStaminaItems],combat:{ ...combat },player_health:state.player.current_health,batched_rounds:batchRound+1 };
      }
      return result;
    });
    if (result.action==='combat_won') {
      if (this.taskEngine&&isActiveMonsterTarget(this.storage.loadPlayer(playerId),result.monster_canonical_id,this.taskEngine.catalog)) this.taskEngine.processEvent(playerId,{ event_id:`${eventId}.task`,type:'defeat_monster',monster_canonical_id:result.monster_canonical_id,location_canonical_id:result.location_canonical_id });
      if (this.dropRuntime) result.drops=this.dropRuntime.settle(playerId,result.monster_canonical_id,result.combat_canonical_id,`${eventId}.drops`);
      if(this.taskEngine&&Number(result.progression?.levels_gained??0)>0)result.unlocked_task_canonical_ids=this.taskEngine.refreshAvailability(playerId).unlocked;
    }
    return result;
  }
  retreat(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'combat_retreat',{},this.clock,(state) => {
      if (!state.combat) throw new Error('No active combat');
      if (state.player.money < 500) throw new Error('Insufficient money for retreat');
      state.player.money-=500;const combatId=state.combat.canonical_id;state.combat=null;
      return { applied:true,action:'combat_retreated',combat_canonical_id:combatId,fee:500,money:state.player.money };
    });
  }
}

class DungeonRuntime {
  constructor({storage,catalog,clock=isoNow}) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  enter(playerId,dungeonId,eventId) {
    const dungeon=this.catalog.getDungeon(dungeonId);
    return transactEvent(this.storage,playerId,eventId,'dungeon_enter',{dungeon_canonical_id:dungeonId},this.clock,(state)=>{
      if(state.dungeon||state.combat||state.voyage)throw new Error('Dungeon entry requires an idle world state');
      if(state.player.current_map_node_canonical_id!==dungeon.map_node_canonical_id)throw new Error('Dungeon entrance is not at the current formal location');
      if(state.player.level<dungeon.minimum_level||state.player.level>dungeon.maximum_level)
        throw new Error(`等级不足，无法进入此探险（需 ${dungeon.minimum_level}-${dungeon.maximum_level} 级）。`);
      state.dungeon={canonical_id:dungeonId,stage_canonical_id:dungeon.entry_stage_canonical_id,entered_at:this.clock(),completion_rewards_enabled:false};
      return {applied:true,action:'dungeon_entered',dungeon:{...state.dungeon}};
    });
  }
  move(playerId,stageId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'dungeon_move',{stage_canonical_id:stageId},this.clock,(state)=>{
      if(!state.dungeon||state.combat)throw new Error('Dungeon movement requires an active idle dungeon');
      const dungeon=this.catalog.getDungeon(state.dungeon.canonical_id);const current=dungeon.stages.findIndex((entry)=>entry.canonical_id===state.dungeon.stage_canonical_id);
      const target=dungeon.stages.findIndex((entry)=>entry.canonical_id===stageId);
      if(target<0||Math.abs(target-current)!==1)throw new Error('Dungeon stage is not adjacent');
      state.dungeon.stage_canonical_id=stageId;
      return {applied:true,action:'dungeon_moved',dungeon:{...state.dungeon}};
    });
  }
  exit(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'dungeon_exit',{},this.clock,(state)=>{
      if(!state.dungeon||state.combat)throw new Error('Dungeon exit requires an active idle dungeon');
      const dungeon=this.catalog.getDungeon(state.dungeon.canonical_id);
      if(state.dungeon.stage_canonical_id!==dungeon.entry_stage_canonical_id)throw new Error('Dungeon exit is available only at the entrance stage');
      const dungeonId=state.dungeon.canonical_id;const returnContext=state.dungeon.return_context??'world';state.dungeon=null;
      return {applied:true,action:'dungeon_exited',dungeon_canonical_id:dungeonId,return_context:returnContext,
        map_node_canonical_id:returnContext==='voyage'?null:dungeon.map_node_canonical_id};
    });
  }
}

function effectiveStats(state,catalog) {
  const stamina=activeStaminaItem(state,catalog);
  const result={ attack:Number(state.player.base_attack),max_attack:Number(state.player.base_max_attack),defense:Number(state.player.base_defense),agility:Number(state.player.base_agility),max_health:Number(state.player.max_health)+Number(stamina?.semantics.add_hp??0),morale:Number(state.player.morale) };
  const equipped=[...Object.entries(state.equipment).filter(([key])=>key!=='accessories').map(([,id])=>id),...state.equipment.accessories].filter(Boolean);
  for (const id of equipped) { const item=catalog.getEquipment(id);result.attack+=Number(item.attack??0);result.max_attack+=Number(item.max_attack??item.maxAttack??0);result.defense+=Number(item.defense??0);result.agility+=Number(item.agility??0);result.max_health+=Number(item.health??0);result.morale+=Number(item.morale??0); }
  return result;
}

function monsterStats(monster) {
  const level=Math.max(1,Number(monster.level));
  const type=Number(monster.monster_type ?? 5);
  if (type === 3 || type === 4) return {
    health:Math.floor(200+300*(level-1)/209),attack:1,max_attack:1,defense:10000,agility:1,
    rule_status:'SOURCE_EXPLICIT',rule_id:'zhsh.monster.plant-mineral.v1',
  };
  const multiplier=({ 40:1.5,50:2,45:2.5,6:3,55:3.5 })[type] ?? 1;
  const healthMultiplier=[45,6,55].includes(type) ? multiplier*10 : multiplier;
  return {
    health:Math.floor((50+20*(level-1))*healthMultiplier),
    attack:Math.floor((8+4*(level-1))*multiplier),
    max_attack:Math.floor((12+6*(level-1))*multiplier),
    defense:Math.floor((8+3*(level-1))*multiplier),
    agility:Math.floor((5+2*(level-1))*multiplier),
    rule_status:'SOURCE_EXPLICIT',rule_id:'zhsh.monster.type-level.v1',
  };
}

function weightedEquipment(pool,catalog,random) {
  const weighted=pool.map((drop) => {
    const item=catalog.getItem(drop.content_entity_canonical_id);
    const level=Number(item?.required_level ?? item?.level ?? 1);
    const weight=level <= 30 ? 70 : level <= 100 ? Math.max(30,70-Math.floor((level-30)*(40/70))) : 29;
    return { drop,weight };
  });
  const total=weighted.reduce((sum,entry)=>sum+entry.weight,0);
  let roll=random()*total;
  for (const entry of weighted) { roll-=entry.weight;if (roll <= 0) return entry.drop; }
  return weighted.at(-1)?.drop ?? null;
}

function chooseFishingWaitOutcome(random) {
  const events=['nothing','bite','line_snapped','bait_eaten'];
  return events[Math.min(events.length-1,Math.floor(random()*events.length))];
}

function fishingRarityWeights(rules,successFactor) {
  const base=rules?.rarity_weights??{common:50,uncommon:30,rare:15,epic:5};
  const defaults={below_one:{common:20,uncommon:-10,rare:-5,epic:-2},above_one:{common:-10,uncommon:10,rare:5,epic:2}};
  const adjustments=rules?.rarity_weight_adjustments??defaults;
  const selected=Number(successFactor)<1?adjustments.below_one:Number(successFactor)>1?adjustments.above_one:null;
  return Object.fromEntries(Object.entries(base).map(([rarity,weight])=>[rarity,Number(weight)+Number(selected?.[rarity]??0)]));
}

function chooseFishingCatch(catalog,session,random) {
  const matches=catalog.listFishingCatches().filter((entry)=>entry.bait_content_entity_canonical_id===session.bait_canonical_id
    &&(!(entry.route_pairs?.length)||entry.route_pairs.some((pair)=>(pair.from_city_canonical_id===session.from_city_canonical_id&&pair.to_city_canonical_id===session.to_city_canonical_id)
      ||(pair.to_city_canonical_id===session.from_city_canonical_id&&pair.from_city_canonical_id===session.to_city_canonical_id))));
  const rarityWeights=fishingRarityWeights(catalog.maritime.fishing?.rules,session.success_factor);
  const total=matches.reduce((sum,entry)=>sum+Number(rarityWeights[entry.rarity]??1),0);let roll=random()*total;
  for(const entry of matches){roll-=Number(rarityWeights[entry.rarity]??1);if(roll<=0)return entry;}
  return matches.at(-1)??null;
}

function applyMarketLoss(state,catalog,marketIds,effect,random) {
  let reduction=0;const cat=catalog.findItemByName('猫');const poison=catalog.findItemByName('老鼠药');
  if(cat&&(state.inventory[cat.canonical_id]??0)>0)reduction+=0.4;
  if(poison&&(state.inventory[poison.canonical_id]??0)>0){reduction+=0.2;setInventory(state,poison.canonical_id,state.inventory[poison.canonical_id]-1);}
  const lossRate=(Number(effect.minLoss)+random()*(Number(effect.maxLoss)-Number(effect.minLoss)))*(1-reduction);let lost=0;
  for(const id of marketIds){const quantity=Math.floor(Number(state.inventory[id])*lossRate);if(quantity>0){lost+=quantity;setInventory(state,id,state.inventory[id]-quantity);}}
  return lost;
}
function randomInteger(min,max,random) {return Math.floor(random()*(Number(max)-Number(min)+1))+Number(min);}

function applyDrops(state,catalog,monsterId,random,inventoryTracker=null,activeRequiredItems=new Set()) {
  const granted=[];const drops=catalog.listDrops(monsterId);const equipmentPool=drops.filter((drop)=>drop.drop_kind==='equipment');
  if(inventoryTracker?.used>=state.inventory_capacity) {
    if(equipmentPool.length&&random()<0.2)random();
    for(const drop of drops.filter((entry)=>entry.drop_kind!=='equipment'))random();
    return granted;
  }
  const selected=[];if(equipmentPool.length&&random()<0.2)selected.push(weightedEquipment(equipmentPool,catalog,random));
  for(const drop of drops.filter((entry)=>entry.drop_kind!=='equipment')) {
    const guaranteed=drop.guaranteed_for_active_task&&activeRequiredItems.has(drop.content_entity_canonical_id);
    if(random()<(guaranteed?1:Number(drop.probability??0.4)))selected.push(drop);
  }
  let used=inventoryTracker?.used??formalInventoryUsed(state,catalog);
  for(const drop of selected.filter(Boolean)) {const quantity=Number(drop.quantity??1);if(used+quantity>state.inventory_capacity)continue;
    state.inventory[drop.content_entity_canonical_id]=(state.inventory[drop.content_entity_canonical_id]??0)+quantity;
    used+=quantity;granted.push({content_entity_canonical_id:drop.content_entity_canonical_id,quantity,drop_canonical_id:drop.canonical_id});}
  if(inventoryTracker)inventoryTracker.used=used;
  return granted;
}

function damage(minAttack,maxAttack,defense,attackerAgility,defenderAgility,random) {
  const roll=Number(minAttack)+Math.floor(random()*(Number(maxAttack)-Number(minAttack)+1));
  const reduction=Math.min(0.99,Number(defense)/(Number(defense)+300));
  const agilityBonus=Math.max(-0.3,Math.min(0.3,(Number(attackerAgility)-Number(defenderAgility))/1000));
  const critical=random() < 0.15+Math.max(0,Number(attackerAgility)-Number(defenderAgility))/5000 ? 2 : 1;
  return Math.max(1,Math.round(roll*(1-reduction)*(1+agilityBonus)*critical));
}

function transactEvent(storage,playerId,eventId,type,payload,clock,operation) {
  if (!eventId || typeof eventId!=='string') throw new Error('Gameplay event requires event_id');
  return storage.transact(playerId,(state) => {
    const prior=state.gameplay_events[eventId];
    if (prior) { if (prior.event_type!==type || stableJson(prior.payload)!==stableJson(payload)) throw new Error(`Gameplay event id collision: ${eventId}`);return { ...prior.result,idempotent_replay:true }; }
    const result=operation(state);state.player.updated_at=clock();state.gameplay_events[eventId]={ event_type:type,payload,result,processed_at:clock() };
    trimGameplayEvents(state.gameplay_events,GAMEPLAY_EVENT_REPLAY_WINDOW);return result;
  });
}
function trimObject(value,limit) { const keys=Object.keys(value);for(const key of keys.slice(0,Math.max(0,keys.length-limit)))delete value[key]; }
function trimGameplayEvents(value,limit){const keys=Object.keys(value);let excess=Math.max(0,keys.length-limit);for(const key of keys){if(excess<=0)break;const event=value[key];if(hasAppliedStamina(event?.result)||event?.result?.action==='stamina_item_auto_used')continue;delete value[key];excess-=1;}}
function hasAppliedStamina(result){return (Array.isArray(result?.stamina_items)?result.stamina_items:[result?.stamina_item]).some((entry)=>entry?.applied);}
function activeMonsterTargetTaskIds(state,monsterId,taskCatalog) { if(!taskCatalog)return [];
  return Object.entries(state.tasks??{}).filter(([taskId,task])=>{
    if(!['accepted','in_progress','completable'].includes(task.status))return false;
    return taskCatalog.getTask(taskId)?.targets?.some((target)=>target.target_kind==='monster'&&target.entity_canonical_id===monsterId
      &&Number(state.progress?.[`${taskId}|${target.canonical_id}`]??0)<Number(target.required_quantity));
  }).map(([taskId])=>taskId).sort(); }
function isActiveMonsterTarget(state,monsterId,taskCatalog) { return activeMonsterTargetTaskIds(state,monsterId,taskCatalog).length>0; }
function encounterDefeatKey(placement,taskContextCanonicalId) { return placement.encounter_type==='task_exclusive'&&taskContextCanonicalId
  ?`${placement.canonical_id}|${taskContextCanonicalId}`:placement.canonical_id; }
function activeItemTargetIds(state,taskCatalog) {
  const result=new Set();
  for(const [taskId,runtime] of Object.entries(state.tasks??{})) {
    if(!['accepted','in_progress','completable'].includes(runtime.status))continue;
    for(const target of taskCatalog.getTask(taskId)?.targets??[])if(target.target_kind==='item'
      &&Number(state.progress?.[`${taskId}|${target.canonical_id}`]??0)<Number(target.required_quantity))result.add(target.entity_canonical_id);
  }
  return result;
}
function atPort(state,cityId,mapNodeId) { return state.player.current_city_canonical_id ? state.player.current_city_canonical_id===cityId && state.player.current_map_node_canonical_id===mapNodeId : state.player.current_map_node_canonical_id===mapNodeId; }
function setInventory(state,id,quantity) { if(quantity<=0)delete state.inventory[id];else state.inventory[id]=quantity; }
function cargoUsed(state) {
  return Object.values(state.cargo??{}).reduce((sum,q)=>sum+Number(q),0);
}
function adjustCrewLoyalty(state, delta) {
  const crew = state.player?.crew ?? [];
  let changed = false;
  for (const c of crew) {
    const cur = Number(c.loyalty ?? 60);
    const next = Math.max(0, Math.min(100, cur + delta));
    if (next !== cur) { c.loyalty = next; changed = true; }
  }
  return changed;
}
function cargoCapacity(state) {
  return Number(state.cargo_capacity ?? 0) || 100;
}
function formalInventoryUsed(state,catalog) {
  return Object.entries(state.inventory??{}).reduce((sum,[id,quantity])=>{
    const item=catalog?.getItem(id);const exempt=item?.inventory_weight_exempt||item?.normalized_data?.inventory_weight_exempt;
    return sum+(exempt?0:Number(quantity));
  },0);
}
function applyTitle(reputation) {
  const rep=Number(reputation??0);
  if (rep>=50000) return '公爵';
  if (rep>=20000) return '总督';
  if (rep>=5000) return '提督';
  if (rep>=1000) return '船长';
  return '水手';
}
function positive(value) { const n=Number(value);if(!Number.isInteger(n)||n<=0)throw new Error('Quantity must be a positive integer');return n; }
function index(values=[]) { return new Map(values.map((entry)=>[entry.canonical_id,entry])); }
function group(values=[],key) { const map=new Map();for(const entry of values){const list=map.get(entry[key])??[];list.push(entry);map.set(entry[key],list);}return map; }
function required(map,id,label) { const value=map.get(id);if(!value)throw new Error(`Unknown formal ${label}: ${id}`);return value; }
function stableJson(value) { if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; }
function isoNow() { return new Date().toISOString(); }

module.exports = { CombatRuntime,DiscoverRuntime,DivingRuntime,DropRuntime,DungeonRuntime,EconomyRuntime,EquipmentRuntime,EquipmentEnhanceRuntime,FishingRuntime,FormalGameplayCatalog,GuildRuntime,CityRuntime,ItemRuntime,MarketRuntime,MaritimeRuntime,PetRuntime,RecoveryRuntime,RecruitRuntime,SkillRuntime,ShipRuntime,VoyageRuntime,EQUIPMENT_SLOT_BY_TYPE,applyTitle,chooseFishingWaitOutcome,damage,effectiveStats,fishingRarityWeights,monsterStats };

},
"src/task-runtime/stamina-item.js": function(module,exports,require){
'use strict';

function staminaItemSemantics(item){
  const data=item?.normalized_data??item?.attributes??{};
  const type=Number(data.type??item?.item_type);
  const addHp=Number(data.info?.addHp??item?.add_hp??0);
  const allHp=Number(data.info?.allHp??item?.all_hp??0);
  if(type!==45||!(addHp>0)||!(allHp>0))return null;
  return {item_canonical_id:item.canonical_id,display_name:item.display_name,type,add_hp:addHp,all_hp:allHp,
    rule_id:'zhsh.play.stamina-item.v1',trigger_health_ratio:0.5,
    source_behavior:'active item adds temporary maximum health and is consumed automatically below 50% after all attacks'};
}

function activeStaminaItem(state,catalog){
  return Object.entries(state.inventory??{}).filter(([,quantity])=>Number(quantity)>0).map(([id])=>catalog.getItem(id)).filter(Boolean)
    .map((item)=>({item,semantics:staminaItemSemantics(item)})).filter((entry)=>entry.semantics)
    .sort((left,right)=>String(left.item.display_name??'').localeCompare(String(right.item.display_name??''),'zh-CN')
      ||left.item.canonical_id.localeCompare(right.item.canonical_id))[0]??null;
}

function useActiveStaminaItem(state,catalog,{automatic=false}={}){
  const active=activeStaminaItem(state,catalog);if(!active)return {applied:false,reason:'stamina_item_unavailable'};
  const {item,semantics}=active;const maximumBefore=baseMaximumHealth(state,catalog)+semantics.add_hp;
  if(automatic&&Number(state.player.current_health)/maximumBefore>=semantics.trigger_health_ratio)
    return {applied:false,reason:'automatic_threshold_not_met',item_canonical_id:item.canonical_id,current_health:Number(state.player.current_health),max_health:maximumBefore};
  const before=Number(state.player.current_health);const missing=Math.max(0,maximumBefore-before);
  if(missing<=0)return {applied:false,reason:'health_already_full',item_canonical_id:item.canonical_id,current_health:before,max_health:maximumBefore};
  const recovered=Math.min(semantics.all_hp,missing);
  setInventory(state,item.canonical_id,Number(state.inventory[item.canonical_id])-1);
  state.player.current_health=before+recovered;
  const next=activeStaminaItem(state,catalog);const maximumAfter=baseMaximumHealth(state,catalog)+Number(next?.semantics.add_hp??0);
  return {applied:true,action:automatic?'stamina_item_auto_used':'stamina_item_used',item_canonical_id:item.canonical_id,
    display_name:item.display_name,recovered_health:recovered,current_health:state.player.current_health,max_health_before:maximumBefore,
    max_health_after:maximumAfter,source_current_health_clamp:false,remaining_quantity:Number(state.inventory[item.canonical_id]??0),rule_id:semantics.rule_id};
}

function baseMaximumHealth(state,catalog){
  let maximum=Number(state.player.max_health);const equipped=[...Object.entries(state.equipment??{}).filter(([key])=>key!=='accessories').map(([,id])=>id),...(state.equipment?.accessories??[])].filter(Boolean);
  for(const id of equipped)maximum+=Number(catalog.getEquipment(id)?.health??0);return maximum;
}

function setInventory(state,itemId,quantity){if(quantity>0)state.inventory[itemId]=quantity;else delete state.inventory[itemId];}

module.exports={activeStaminaItem,baseMaximumHealth,staminaItemSemantics,useActiveStaminaItem};

},
"server/ai/ai-crew.js": function(module,exports,require){
'use strict';
/**
 * 纵横四海 · AI 船员（同伴人格 + 忠诚）
 *
 * 船员随从不只是数值加成：他们有自己的性格，会说话、记得与玩家的共事，
 * 忠诚度随并肩作战涨跌。为战斗/事件生成一句贴合人格/忠诚度的发言。
 *
 * 依赖：server/ai/ai-decision-service.js。
 */
const { ollamaGenerate, MODEL_LIGHT } = require("server/ai/ai-decision-service.js");

/** 生成某船员在战斗/事件后的一句发言（贴合性格与忠诚度，async，规则保底）。 */
async function aiCrewLine({ crewName, personality, loyalty, mood, worldContext }) {
  const loyaltyTone = Number(loyalty ?? 60) >= 70 ? '极其信任你'
    : Number(loyalty ?? 60) >= 45 ? '愿意追随你'
    : Number(loyalty ?? 60) >= 30 ? '有些动摇'
    : '心生离意';
  const prompt = `你是《纵横四海》的船员（${crewName}，性格${personality}）。当前忠诚：${loyaltyTone}，${mood ?? '正在出海'}。
说一句 30 字内的中文台词，贴合你的性格与对船长的态度${worldContext ? `，可提及世界动态：${worldContext}` : ''}。只输出台词本身，不要前缀。`;
  try {
    const raw = await ollamaGenerate(prompt, { system: '你是文字网游里性格鲜明的船员，说一句贴合人格的中文台词。', temperature: 0.9, maxTokens: 50, model: MODEL_LIGHT, think: false });
    const line = String(raw || '').trim().split('\n')[0].slice(0, 40);
    if (line) return { line, crew: crewName, source: 'ai' };
  } catch {}
  // 保底台词（贴合忠诚度）
  const fallback = loyaltyTone === '极其信任你' ? '船长，我这条命就交给你了。'
    : loyaltyTone === '愿意追随你' ? '船长，风浪再大我也跟着你。'
    : loyaltyTone === '有些动摇' ? '船长，这趟买卖……当真值得吗？'
    : '船长，我得为自己想想了。';
  return { line: `${crewName}：${fallback}`, crew: crewName, source: 'fallback' };
}

/** 根据忠诚度折算船员对玩家属性加成的乘数（高忠诚加成放大，低忠诚削弱/离队）。 */
function loyaltyFactor(loyalty) {
  const l = Number(loyalty ?? 60);
  if (l >= 80) return 1.2;
  if (l >= 60) return 1.0;
  if (l >= 40) return 0.8;
  if (l >= 25) return 0.5;
  return 0; // 极低忠诚：不再提供加成
}

module.exports = { aiCrewLine, loyaltyFactor };

},
"server/ai/ai-decision-service.js": function(module,exports,require){
'use strict';
/**
 * 纵横四海 · 统一 AI 决策服务
 *
 * 封装本地 ollama（qwen3.5:9b）的调用，供各系统决策层复用，把 AI 注入整个游戏：
 *   - 世界经济事件生成（ai-decision）
 *   - AI 玩家行为决策（ai-players）
 *   - 世界情报/市场分析摘要（经济系统向玩家提供的信息）
 *   - 战斗 NPC/世界播报叙述生成
 *
 * 核心约定：所有 aiDecide 均接受"当前状态上下文"，输出结构化对象；
 * 解析失败或超界由各调用方规则层保底（决不让 AI 失败导致系统不可用）。
 */
const http = require('node:http');

const OLLAMA_URL = process.env.ZHSH_OLLAMA_URL || 'http://127.0.0.1:11434';

/** ---- 全局 AI 并发信号量 ----
 *  本地 ollama 单进程的并发承载有限（取决于 GPU），多个 AI 场景（banter/事件/叙述/
 *  AI玩家决策/世界支线）可能同时打 ollama。用一个简单信号量限制同时进行的
 *  generate 请求数（默认 2，可用 ZHSH_AI_CONCURRENCY 调），超出排队等前一个完成。
 *  这是让 AI 深度介入不压垮本地模型的关键基础设施（与语言无关，任何后端都需要）。 */
const AI_CONCURRENCY = Math.max(1, Number(process.env.ZHSH_AI_CONCURRENCY || 2));
let activeGenerate = 0;
const waitQueue = [];
function acquireGenerate() {
  return new Promise((resolve) => {
    if (activeGenerate < AI_CONCURRENCY) { activeGenerate += 1; return resolve(); }
    waitQueue.push(resolve);
  });
}
function releaseGenerate() {
  const next = waitQueue.shift();
  if (next) { /* 保持 activeGenerate 不变，直接移交许可 */ next(); }
  else activeGenerate -= 1;
}

/** 当前默认模型（环境变量可覆盖）。分层：MODEL_LIGHT=内容生成主力(4b，质量速度均衡)，
 *  MODEL_FAST=极高频短任务(2b)。实测 4b 在台词/播报/叙述质量更佳且全程≤0.63s。 */
const MODEL = process.env.ZHSH_AI_MODEL || 'qwen3.5:9b';
const MODEL_LIGHT = process.env.ZHSH_AI_MODEL_LIGHT || 'qwen3.8-4b-distill:latest';
const MODEL_FAST = process.env.ZHSH_AI_MODEL_FAST || 'qwen3.8-2b-distill:latest';

/** 唤起 ollama 生成，返回原始响应文本。
 *  注意：qwen 系列思考开关必须放请求体顶层 `think: false`（否则模型输出完整推理链，
 *  拖慢且污染结果）；options.think 无效。可按调用传入 model 选择分层模型。
 *  keepAlive=-1 让模型常驻内存，消除每次请求的加载/卸载开销（预热的真实推理速度）。 */
async function ollamaGenerate(prompt, { format = null, temperature = 0.8, maxTokens = 300, system = null, model = null, think = true, keepAlive = -1, numCtx = 4096 } = {}) {
  await acquireGenerate();
  const body = {
    model: model || MODEL,
    prompt,
    stream: false,
    think,
    keep_alive: keepAlive, // 负值=常驻；0=立即卸载；正值=驻留秒数
    options: { temperature, max_tokens: maxTokens, num_ctx: numCtx },
  };
  if (system) body.system = system;
  if (format) body.format = format;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(new URL('/api/generate', OLLAMA_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data).response ?? ''); } catch (err) { reject(new Error(`ollama parse: ${err.message}`)); } });
      });
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  } finally {
    releaseGenerate();
  }
}

/** 唤起 ollama 并解析 JSON 对象（剥离 markdown 代码块） */
async function ollamaJson(prompt, opts = {}) {
  const raw = await ollamaGenerate(prompt, { ...opts, format: 'json' });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('ollama did not return a JSON object');
  return JSON.parse(m[0]);
}

/** 当前模型是否可用 */
function ping() {
  return new Promise((resolve) => {
    const req = http.request(new URL('/api/tags', OLLAMA_URL), { method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d).models?.some((m) => m.name === MODEL)); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * 安全的 JSON 决策：调用 aiDecide（async 函数）并规范化；任何失败返回 fallback。
 * 供各系统保底使用，保证 AI 错误不破坏游戏。
 */
async function safeJsonDecide(aiDecide, context, fallback) {
  if (typeof aiDecide !== 'function') return fallback;
  try { const result = await aiDecide(context); return (result && typeof result === 'object') ? result : fallback; }
  catch { return fallback; }
}

module.exports = { ollamaGenerate, ollamaJson, safeJsonDecide, ping, MODEL, MODEL_LIGHT, MODEL_FAST, OLLAMA_URL };

}
};
const __cache={};
function __require(id){if(__cache[id])return __cache[id].exports;const module={exports:{}};__cache[id]=module;__modules[id](module,module.exports,__require);return module.exports;}
const __entry=__require("src/task-runtime/browser-entry.js");
export const BrowserRuntimeStorage=__entry.BrowserRuntimeStorage;
export const BrowserTaskCatalog=__entry.BrowserTaskCatalog;
export const IndexedDbDurableStore=__entry.IndexedDbDurableStore;
export const RemoteDurableStore=__entry.RemoteDurableStore;
export const RemoteCharacterRegistry=__entry.RemoteCharacterRegistry;
export const TaskRuntimeEngine=__entry.TaskRuntimeEngine;
export const UiFeedback=__entry.UiFeedback;
export const buildCityMapEntries=__entry.buildCityMapEntries;

export const CombatRuntime=__entry.CombatRuntime;
export const NpcDuelRuntime=__entry.NpcDuelRuntime;
export const DivingRuntime=__entry.DivingRuntime;
export const DropRuntime=__entry.DropRuntime;
export const DungeonRuntime=__entry.DungeonRuntime;
export const EconomyRuntime=__entry.EconomyRuntime;
export const EquipmentRuntime=__entry.EquipmentRuntime;
export const FishingRuntime=__entry.FishingRuntime;
export const FormalGameplayCatalog=__entry.FormalGameplayCatalog;
export const ItemRuntime=__entry.ItemRuntime;
export const MaritimeRuntime=__entry.MaritimeRuntime;
export const RecoveryRuntime=__entry.RecoveryRuntime;
export const ShipRuntime=__entry.ShipRuntime;
export const VoyageRuntime=__entry.VoyageRuntime;
export const effectiveStats=__entry.effectiveStats;
export const applyExperienceProgression=__entry.applyExperienceProgression;
export const LEVEL_THRESHOLDS=__entry.LEVEL_THRESHOLDS;
