'use strict';

const { applyExperienceProgression } = require('./gameplay-state');
const { activeStaminaItem,useActiveStaminaItem } = require('./stamina-item');
const {assertInventoryRemovalAllowed}=require('./task-item-ledger');

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
        combat.monster_current_health=Math.max(0,combat.monster_current_health-playerDamage);
        if (combat.monster_current_health===0) {
          const monster=this.catalog.getMonster(combat.monster_canonical_id);const combatId=combat.canonical_id;
          const experience=Number(monster.rewards?.experience);const money=Number(monster.rewards?.copper);
          if(!Number.isFinite(experience)||!Number.isFinite(money))throw new Error(`Monster reward rule missing: ${monster.canonical_id}`);
          state.player.experience+=experience;state.player.money+=money;const progression=applyExperienceProgression(state);state.combat=null;
          if(monster.repeatable===false)state.encounter_defeats[combat.encounter_defeat_key??combat.placement_canonical_id]={defeated_at:this.clock(),monster_canonical_id:monster.canonical_id,task_context_canonical_id:combat.task_context_canonical_id??null};
          return { applied:true,action:'combat_won',combat_canonical_id:combatId,monster_canonical_id:monster.canonical_id,
            location_canonical_id:combat.location_canonical_id,player_damage:playerDamage,experience,money,progression,
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
          return { applied:true,action:'combat_lost',player_damage:playerDamage,monster_damage:monsterDamage,
            stamina_item:appliedStaminaItems.at(-1)??staminaItem,stamina_items:[...appliedStaminaItems],
            defeated_at_map_node_canonical_id:defeatedAt,return_map_node_canonical_id:state.player.current_map_node_canonical_id,current_health:1,batched_rounds:batchRound+1 };
        }
        result={ applied:true,action:'combat_round',player_damage:playerDamage,monster_damage:monsterDamage,
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
      if(state.player.level<dungeon.minimum_level||state.player.level>dungeon.maximum_level)throw new Error('Dungeon level requirement is not met');
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
function formalInventoryUsed(state,catalog) {
  return Object.entries(state.inventory??{}).reduce((sum,[id,quantity])=>{
    const item=catalog?.getItem(id);const exempt=item?.inventory_weight_exempt||item?.normalized_data?.inventory_weight_exempt;
    return sum+(exempt?0:Number(quantity));
  },0);
}
function positive(value) { const n=Number(value);if(!Number.isInteger(n)||n<=0)throw new Error('Quantity must be a positive integer');return n; }
function index(values=[]) { return new Map(values.map((entry)=>[entry.canonical_id,entry])); }
function group(values=[],key) { const map=new Map();for(const entry of values){const list=map.get(entry[key])??[];list.push(entry);map.set(entry[key],list);}return map; }
function required(map,id,label) { const value=map.get(id);if(!value)throw new Error(`Unknown formal ${label}: ${id}`);return value; }
function stableJson(value) { if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; }
function isoNow() { return new Date().toISOString(); }

module.exports = { CombatRuntime,DivingRuntime,DropRuntime,DungeonRuntime,EconomyRuntime,EquipmentRuntime,FishingRuntime,FormalGameplayCatalog,ItemRuntime,MaritimeRuntime,RecoveryRuntime,ShipRuntime,VoyageRuntime,EQUIPMENT_SLOT_BY_TYPE,chooseFishingWaitOutcome,damage,effectiveStats,fishingRarityWeights,monsterStats };
