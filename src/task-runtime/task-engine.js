'use strict';

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
const { assertRuntimeStorage,assertTaskCatalog } = require('./ports');
const { createGameplayState,applyExperienceProgression } = require('./gameplay-state');
const {abandonTaskItems,assertInventoryRemovalAllowed,consumeTaskItems,defaultPolicy,ensureTaskItemLedger,grantInventoryItem,reconcileTaskItemReservations}=require('./task-item-ledger');

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
    const tasks = this.listTasks();
    if (!tasks.length) throw new Error(`Task series is empty: ${this.seriesCanonicalIds.join(',')}`);
    const firstLocation = tasks[0].receive_location_canonical_id;
    const firstNode = this.catalog.getNodeForLocation(firstLocation);
    if (!firstNode) throw new Error(`Initial task location has no map node: ${firstLocation}`);
    const taskStates = {};
    const progress = {};
    for (const task of tasks) {
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
    ensureTaskItemLedger(state);
    return state;
  }

  listTasks() {
    return this.seriesCanonicalIds.flatMap((seriesId) => this.catalog.listSeriesTasks(seriesId));
  }

  synchronizeDefinitions(playerCanonicalId) {
    return this.storage.transact(playerCanonicalId,(state) => {
      const added=[];
      const defeatReturn=this.catalog.content?.gameplay_rules?.defeat_return;
      if(!state.player.defeat_return_map_node_canonical_id&&defeatReturn?.map_node_canonical_id)state.player.defeat_return_map_node_canonical_id=defeatReturn.map_node_canonical_id;
      for (const task of this.listTasks()) {
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
      runtime: state.tasks[task.canonical_id],
      progress: task.targets.map((target) => ({
        target_canonical_id: target.canonical_id,
        current_quantity: state.progress[progressKey(task.canonical_id,target.canonical_id)] ?? 0,
        required_quantity: target.required_quantity,
      })),
    });
    const allTasks=this.listTasks().map(project);
    const tasks=allTasks.filter((entry)=>seriesOf(entry.definition)===activeSeries);
    return { ...state,current_location:node,active_series_canonical_id:activeSeries,
      task_series:this.seriesCanonicalIds.map((id)=>({ canonical_id:id,total:this.catalog.listSeriesTasks(id).length,
        completed:this.catalog.listSeriesTasks(id).filter((task)=>state.tasks[task.canonical_id]?.status==='completed').length })),
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
      const status = state.tasks[task.canonical_id]?.status;
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
    return (placement.task_contexts??[]).some((context)=>context.appearance_statuses.includes(state.tasks[context.task_canonical_id]?.status));
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
      if (target) return this.advanceTarget(state,task,target,1,'talk_to_npc');
    }
    const available = this.listTasks().sort((a,b)=>Number(seriesOf(b)===state.active_series_canonical_id)-Number(seriesOf(a)===state.active_series_canonical_id)).find((task) => {
      const runtime = state.tasks[task.canonical_id];
      return runtime?.status === 'available' && task.issuer_npc_canonical_id === event.npc_canonical_id
        && task.receive_location_canonical_id === locationId;
    });
    if (!available) return { applied: false, reason: 'no_task_action_for_npc', npc_canonical_id: event.npc_canonical_id };
    state.tasks[available.canonical_id].status = 'accepted';
    state.tasks[available.canonical_id].current_step = 1;
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
      const runtime = state.tasks[entry.canonical_id];
      return runtime?.status === 'completable' && entry.completion_npc_canonical_id === event.npc_canonical_id
        && entry.submit_location_canonical_id === locationId;
    });
    if (!task) return { applied: false, reason: 'no_completable_task_for_npc', npc_canonical_id: event.npc_canonical_id };
    reconcileTaskItemReservations(state,this.activeTasks(state));
    const taskItemConsumption=consumeTaskItems(state,task,`submit:${event.event_id}:${task.canonical_id}`);
    this.injectFault('after_task_item_consumption',{ state,event,task,taskItemConsumption });
    let sourceLabelOnly = false;
    for (const reward of task.rewards) {
      if (state.reward_grants[reward.canonical_id]) continue;
      let effectStatus = 'applied';
      if (reward.reward_kind === 'experience') state.player.experience += reward.quantity;
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
      state.reward_grants[reward.canonical_id] = {
        task_canonical_id: task.canonical_id,
        quantity: reward.quantity,
        effect_status: effectStatus,
      };
    }
    this.injectFault('after_reward_grants',{ state,event,task });
    const runtime = state.tasks[task.canonical_id];
    runtime.status = 'completed';
    runtime.current_step = 3;
    runtime.reward_status = sourceLabelOnly ? 'granted_with_source_label_records' : 'granted';
    const progression = applyExperienceProgression(state);
    // 声望填实：完成任一任务 +5 声望，晋升爵位（水手/船长/提督/总督/公爵）
    state.player.reputation=(state.player.reputation??0)+5;
    state.player.title=applyReputationTitle(state.player.reputation);
    const levelUnlocked = this.refreshLevelAvailabilityState(state);
    state.flags[`task.completed.${task.canonical_id}`] = true;
    reconcileTaskItemReservations(state,this.activeTasks(state));
    const unlocked = [];
    for (const successorId of task.successors) {
      const successor = this.catalog.getTask(successorId);
      const successorRuntime = state.tasks[successorId];
      if (!successorRuntime || successorRuntime.status === 'blocked') continue;
      if (Number(state.player.level) < Number(successor.level_requirement ?? 1)) continue;
      if (this.prerequisitesSatisfied(state,successor)) {
        successorRuntime.status = 'available';
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
      progression,
      level_unlocked_task_canonical_ids:levelUnlocked,
    };
  }

  handleAbandon(state,event,outcome) {
    const task=this.catalog.getTask(event.task_canonical_id);const runtime=state.tasks[event.task_canonical_id];
    if(!task||!runtime)throw new Error(`Unknown task: ${event.task_canonical_id}`);
    if(!ACTIVE_STATUSES.has(runtime.status))return {applied:false,reason:'task_not_active',task_canonical_id:task.canonical_id,status:runtime.status};
    const itemResult=abandonTaskItems(state,task,`${outcome}:${event.event_id}:${task.canonical_id}`);
    for(const target of task.targets)state.progress[progressKey(task.canonical_id,target.canonical_id)]=0;
    runtime.status=this.prerequisitesSatisfied(state,task)&&Number(state.player.level)>=Number(task.level_requirement??1)?'available':'locked';
    runtime.current_step=0;runtime.reward_status='not_granted';
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
    const key = progressKey(task.canonical_id,target.canonical_id);
    const before = state.progress[key] ?? 0;
    const after = Math.min(target.required_quantity,before + quantity);
    state.progress[key] = after;
    this.refreshTaskProgressState(state,task);
    return {
      applied: after !== before,
      event_type: eventType,
      task_canonical_id: task.canonical_id,
      target_canonical_id: target.canonical_id,
      before,
      after,
      required: target.required_quantity,
      status: state.tasks[task.canonical_id].status,
    };
  }

  syncItemTargets(state,task,onlyItemId = null) {
    const changes = [];
    for (const target of task.targets.filter((entry) => entry.target_kind === 'item'
      && (!onlyItemId || entry.entity_canonical_id === onlyItemId))) {
      const key = progressKey(task.canonical_id,target.canonical_id);
      const before = state.progress[key] ?? 0;
      const after = Math.min(target.required_quantity,state.inventory[target.entity_canonical_id] ?? 0);
      state.progress[key] = after;
      if (after !== before) changes.push({ task_canonical_id: task.canonical_id,target_canonical_id: target.canonical_id,before,after,required: target.required_quantity });
    }
    this.refreshTaskProgressState(state,task);
    return changes;
  }

  refreshTaskProgressState(state,task) {
    const runtime = state.tasks[task.canonical_id];
    if (!ACTIVE_STATUSES.has(runtime.status)) return;
    const complete = task.targets.every((target) => (state.progress[progressKey(task.canonical_id,target.canonical_id)] ?? 0) >= target.required_quantity);
    runtime.status = complete ? 'completable' : 'in_progress';
    runtime.current_step = complete ? 3 : 2;
  }

  activeTasks(state) {
    return this.listTasks().filter((task) => ACTIVE_STATUSES.has(state.tasks[task.canonical_id]?.status));
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
    return this.effectivePrerequisiteIds(task).every((id)=>state.tasks[id]?.status==='completed');
  }

  refreshLevelAvailabilityState(state) {
    const unlocked=[];
    for (const task of this.listTasks()) {
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
