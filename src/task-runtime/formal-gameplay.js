'use strict';
const { recordPlayerMemory } = require('../../server/ai/ai-memory');

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
    this.recipes = index(content.recipes);
    this.tradeGoods = index(content.trade_goods);
    this.tradeOrders = index(content.trade_orders);
    this.convoyItems = index(content.convoy_items);
  }
  getRecipe(id) { return required(this.recipes,id,'recipe'); }
  getTradeGood(id) { return required(this.tradeGoods,id,'trade good'); }
  getTradeOrder(id) { return required(this.tradeOrders,id,'trade order'); }
  getConvoyItem(id) { return required(this.convoyItems,id,'convoy item'); }
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
      if (!atPort(state,ship.city_canonical_id,ship.port_map_node_canonical_id)) throw new Error('购买船只需在对应港口码头。');
      const limit = Math.min(6,Math.floor(state.player.level / 10) + 1);
      if (Object.keys(state.owned_ships).length >= limit) throw new Error('船只数量已达上限。');
      if (state.player.money < ship.price) throw new Error('金币不足，无法购买此船。');
      state.player.money -= ship.price;
      state.owned_ships[shipId] = { purchased_at:this.clock(),source_canonical_id:ship.source_canonical_id ?? null };
      state.current_ship_canonical_id = shipId;
      return { applied:true,action:'ship_purchased',ship_canonical_id:shipId,price:ship.price,money:state.player.money };
    });
  }
  select(playerId,shipId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'ship_select',{ ship_canonical_id:shipId },this.clock,(state) => {
      if (!state.owned_ships[shipId]) throw new Error('未持有此船。');
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
      if (state.voyage) throw new Error('航海已在进行中。');
      if (!state.current_ship_canonical_id || !state.owned_ships[state.current_ship_canonical_id]) throw new Error('航海需要一艘已持有的当前船只。');
      if (!atPort(state,route.from_city_canonical_id,route.from_port_map_node_canonical_id)) throw new Error('航海须在正式出发港码头开始。');
      if (route.required_task_canonical_id && !route.allowed_task_statuses.includes(state.tasks[route.required_task_canonical_id]?.status)) {
        throw new Error('尚未满足此航线的任务条件。');
      }
      if (state.player.money < Number(route.fee ?? 0)) throw new Error('金币不足，无法支付航海费用。');
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
      if (!state.voyage) throw new Error('当前没有进行中的航海。');
      if (state.fishing || state.dungeon || state.maritime_encounter) throw new Error('请先处理当前的航海活动再继续前进。');
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
      if(!state.voyage||encounter?.kind!=='route_location')throw new Error('当前没有进行中的航线地点遭遇。');
      if(!encounter.map_node_canonical_id||!encounter.location_canonical_id)throw new Error('航线地点遭遇缺少正式地图目的地。');
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

class CookRuntime {
  constructor({ storage,catalog,taskEngine=null,clock=isoNow }) {
    this.storage=storage;this.catalog=catalog;this.taskEngine=taskEngine;this.clock=clock;
  }
  // 在当前城市港口按配方烹制餐食：扣素材 + 计费 + 产出餐食物品
  cook(playerId,recipeId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'recipe_cook',{ recipe_canonical_id:recipeId },this.clock,(state) => {
      const recipe=this.catalog.getRecipe(recipeId);
      const city=this.currentCityId(state);
      if(recipe.port_city_canonical_id!==city)throw new Error(`该配方须在对应港口烹制（${recipe.port_city_canonical_id}）。`);
      if(Number(state.player.money)<Number(recipe.silver_cost??0))throw new Error('银币不足，无法支付烹制费用。');
      for(const [ingredientId,quantity] of Object.entries(recipe.cargo??{})) {
        if(Number(state.inventory[ingredientId]??0)<Number(quantity))throw new Error('食材不足，无法烹制。');
      }
      state.player.money-=Number(recipe.silver_cost??0);
      for(const [ingredientId,quantity] of Object.entries(recipe.cargo??{}))setInventory(state,ingredientId,Number(state.inventory[ingredientId])-Number(quantity));
      const meal=this.catalog.getItem(recipe.result_item_canonical_id);
      const mealId=meal.canonical_id;
      state.inventory[mealId]=(state.inventory[mealId]??0)+1;
      const buff=meal.normalized_data?.buff??meal.buff??null;
      return {applied:true,action:'meal_cooked',recipe_canonical_id:recipeId,result_item_canonical_id:mealId,
        display_name:meal.display_name??mealId,buff,remaining_money:Number(state.player.money)};
    });
  }
  // 食用餐食：设置多场战斗 buff
  consumeMeal(playerId,mealId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'meal_consume',{ item_canonical_id:mealId },this.clock,(state) => {
      if(Number(state.inventory[mealId]??0)<1)throw new Error('背包中没有该餐食。');
      const meal=this.catalog.getItem(mealId);
      const buff=meal.normalized_data?.buff??meal.buff??null;
      if(!buff)throw new Error('该物品不是可食用餐食。');
      setInventory(state,mealId,Number(state.inventory[mealId])-1);
      state.player.meal_buff={ ...buff,remaining_battles:Number(buff.battles??3) };
      return {applied:true,action:'meal_consumed',item_canonical_id:mealId,display_name:meal.display_name??mealId,buff:{...state.player.meal_buff}};
    });
  }
  currentCityId(state) {
    const node=state.player.current_map_node_canonical_id;
    const mapNode=this.catalog.content?.map_nodes?.find((entry)=>entry.map_node_canonical_id===node);
    const loc=this.catalog.content?.locations?.find((entry)=>entry.canonical_id===mapNode?.location_canonical_id);
    return loc?.city_canonical_id??null;
  }
  cityIdFrom(state) { return this.currentCityId(state); }
}

// 港口订单：在指定港口交付商品，得银币 + 港口声望
class TradeOrderRuntime {
  constructor({ storage,catalog=null,clock=isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  currentCityId(state) {
    const mapNode=this.catalog.content?.map_nodes?.find((entry)=>entry.map_node_canonical_id===state.player.current_map_node_canonical_id);
    const loc=this.catalog.content?.locations?.find((entry)=>entry.canonical_id===mapNode?.location_canonical_id);
    return loc?.city_canonical_id??null;
  }
  acceptOrder(playerId,orderId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'trade_order_accept',{ order_canonical_id:orderId },this.clock,(state) => {
      const order=this.catalog.getTradeOrder(orderId);
      const active=state.trade_orders??(state.trade_orders={});
      if(active[orderId])throw new Error('该订单已在处理中。');
      active[orderId]={ accepted_at:this.clock(),count:0 };
      return {applied:true,action:'trade_order_accepted',order_canonical_id:orderId};
    });
  }
  deliverOrder(playerId,orderId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'trade_order_deliver',{ order_canonical_id:orderId },this.clock,(state) => {
      const order=this.catalog.getTradeOrder(orderId);
      const city=this.currentCityId(state);
      const goodId=order.good_canonical_id;
      const amount=Number(order.amount??1);
      if(city!==order.port_city_canonical_id)throw new Error('须在订单指定港口交付。');
      if(Number(state.inventory[goodId]??0)<amount)throw new Error(`商品不足，需 ${amount} 件。`);
      setInventory(state,goodId,Number(state.inventory[goodId])-amount);
      state.player.money+=Number(order.bonus??0);
      const rep=state.city_reputation??(state.city_reputation={});
      rep[order.port_city_canonical_id]=(Number(rep[order.port_city_canonical_id]??0)+Number(order.reputation??0));
      state.city_reputation=rep;
      const active=state.trade_orders??{};
      if(active[orderId])delete active[orderId];
      return {applied:true,action:'trade_order_delivered',order_canonical_id:orderId,bonus:Number(order.bonus??0),
        reputation:Number(order.reputation??0),money:state.player.money,city_reputation:state.city_reputation};
    });
  }
}

// 指定港卖出：在目标港口出售货物赚价差
class TradeSellRuntime {
  constructor({ storage,catalog=null,clock=isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  currentCityId(state) {
    const mapNode=this.catalog.content?.map_nodes?.find((entry)=>entry.map_node_canonical_id===state.player.current_map_node_canonical_id);
    const loc=this.catalog.content?.locations?.find((entry)=>entry.canonical_id===mapNode?.location_canonical_id);
    return loc?.city_canonical_id??null;
  }
  sell(playerId,goodId,quantity,eventId) {
    return transactEvent(this.storage,playerId,eventId,'trade_good_sell',{ good_canonical_id:goodId,quantity },this.clock,(state) => {
      const good=this.catalog.getTradeGood(goodId);
      const city=this.currentCityId(state);
      const price=Number(good.prices?.[city]??0);
      if(!price)throw new Error('该商品在当前港口无收购价。');
      const qty=Number(quantity??1);
      if(Number(state.inventory[goodId]??0)<qty)throw new Error('商品不足。');
      setInventory(state,goodId,Number(state.inventory[goodId])-qty);
      state.player.money+=price*qty;
      return {applied:true,action:'trade_good_sold',good_canonical_id:goodId,quantity:qty,unit_price:price,
        gained:price*qty,money:state.player.money};
    });
  }
}

// 护航物资：出航前购买，本航程降风险/抵风暴
class VoyagePrepRuntime {
  constructor({ storage,catalog=null,clock=isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  purchase(playerId,itemId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'convoy_purchase',{ convoy_item_canonical_id:itemId },this.clock,(state) => {
      const item=this.catalog.getConvoyItem(itemId);
      if(Number(state.player.money)<Number(item.price??0))throw new Error('银币不足。');
      state.player.money-=Number(item.price??0);
      const stock=state.convoy_bundles??(state.convoy_bundles={});
      stock[itemId]=(Number(stock[itemId]??0)+1);
      state.convoy_bundles=stock;
      return {applied:true,action:'convoy_purchased',convoy_item_canonical_id:itemId,bundle_count:state.convoy_bundles[itemId],
        money:state.player.money,effect:item.effect};
    });
  }
}

// 港口声望：查询某港累计声望
class TradeReputationRuntime {
  constructor({ storage,catalog=null,clock=isoNow }) { this.storage=storage;this.catalog=catalog;this.clock=clock; }
  view(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'city_reputation_view',{},this.clock,(state) => {
      return {applied:true,action:'city_reputation_viewed',city_reputation:state.city_reputation??{},
        total:Object.values(state.city_reputation??{}).reduce((sum,value)=>sum+Number(value),0)};
    });
  }
}

class FishingRuntime {
  constructor({ storage,catalog,taskEngine=null,random=Math.random,clock=isoNow }) {
    this.storage=storage;this.catalog=catalog;this.taskEngine=taskEngine;this.random=random;this.clock=clock;
  }
  start(playerId,rodId,baitId,eventId) {
    const rod=this.catalog.getFishingGear(rodId);const bait=this.catalog.getFishingGear(baitId);
    return transactEvent(this.storage,playerId,eventId,'fishing_start',{rod_canonical_id:rodId,bait_canonical_id:baitId},this.clock,(state)=>{
      if(!state.voyage||state.combat||state.dungeon)throw new Error('钓鱼需要处于空闲的进行中航海。');
      if(state.fishing)throw new Error('钓鱼已在进行中。');
      if(Number(rod.type)!==14||Number(bait.type)!==8)throw new Error('钓鱼需要鱼竿和鱼饵。');
      if((state.inventory[rodId]??0)<1||(state.inventory[baitId]??0)<1)throw new Error('钓鱼装备不在背包中。');
      state.fishing={rod_canonical_id:rodId,bait_canonical_id:baitId,from_city_canonical_id:state.voyage.from_city_canonical_id,
        to_city_canonical_id:state.voyage.to_city_canonical_id,phase:'ready',wait_count:0,reel_count:0,let_out_count:0,success_factor:1,started_at:this.clock()};
      return {applied:true,action:'fishing_started',fishing:{...state.fishing}};
    });
  }
  cast(playerId,eventId) {
    return transactEvent(this.storage,playerId,eventId,'fishing_cast',{},this.clock,(state)=>{
      if(!state.voyage||!state.fishing||state.fishing.phase!=='ready')throw new Error('抛竿需要处于待抛的钓鱼会话。');
      const baitId=state.fishing.bait_canonical_id;if((state.inventory[baitId]??0)<1)throw new Error('鱼饵已用完。');
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
      if ((state.inventory['item.口粮']??0)<1) throw new Error('口粮不足，无法喂食（需先获取宠物口粮）。');
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
    const { loyaltyFactor } = require('../../server/ai/ai-crew');
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
    if (typeof eventId === 'number') {
      rounds = eventId;
      eventId = typeof arguments[2] === 'string' ? arguments[2] : `combat-attack.${this.clock()}`;
    } else if (typeof eventId === 'object' && eventId !== null) {
      const opts = eventId;
      eventId = typeof arguments[2] === 'string' ? arguments[2] : `combat-attack.${this.clock()}`;
      rounds = opts.rounds ?? 1;
    }
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
          // 餐食 buff：每获胜一场递减剩余场次，归零自动清除
          const mealBuffAfter=consumeMealBattle(state);
          return { applied:true,action:'combat_won',combat_canonical_id:combatId,monster_canonical_id:monster.canonical_id,
            location_canonical_id:combat.location_canonical_id,player_damage:playerDamage,pet_damage:petDamage,experience,money,progression,
            stamina_item:appliedStaminaItems.at(-1)??null,stamina_items:[...appliedStaminaItems],batched_rounds:batchRound+1,meal_buff:mealBuffAfter };
        }
        const monsterDamage=damage(combat.monster_stats.attack,combat.monster_stats.max_attack,stats.defense,combat.monster_stats.agility,stats.agility,this.random);
        state.player.current_health=Math.max(0,state.player.current_health-monsterDamage);
        // 未知道具吸收：怪物状态效果（中毒/虚弱/诅咒/缓慢）+ 周期技能（伤害倍增）
        const monsterEffect=combat.monster_stats.effect;
        if (monsterEffect) {
          const effectRoll=this.random();
          if (effectRoll < Number(monsterEffect.chance ?? 0)) {
            const active=state.player.effects ?? (state.player.effects={});
            const existing=active[monsterEffect.name];
            active[monsterEffect.name]={ rounds: Math.max(existing?.rounds ?? 0, Number(monsterEffect.rounds ?? 1)), round: combat.round };
            combat.last_effects=combat.last_effects??[]; combat.last_effects.push(monsterEffect.name);
            if(monsterEffect.damage_multiplier) {
              state.player.current_health=Math.max(0,state.player.current_health-Math.round(monsterDamage*(Number(monsterEffect.damage_multiplier)-1)));
            }
          }
        }
        const monsterSpecial=combat.monster_stats.special;
        if (monsterSpecial && Number(monsterSpecial.every ?? 0) > 0 && combat.round % Number(monsterSpecial.every) === 0) {
          const specialDamage=Math.round(monsterDamage*Number(monsterSpecial.damage_multiplier ?? 1));
          state.player.current_health=Math.max(0,state.player.current_health-specialDamage);
          combat.last_special=monsterSpecial.name;
        }
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
  // 装备套装分段共鸣：按 set_id 分组件数，取该套已达最高档（2/4/6 件）的加成累计
  const setCounts=new Map();
  for (const id of equipped) { const item=catalog.getEquipment(id);const setId=item?.set_id;if(setId)setCounts.set(setId,(setCounts.get(setId)??0)+1); }
  for (const [setId,count] of setCounts) {
    const sample=catalog.getEquipment(equipped.find((id)=>catalog.getEquipment(id)?.set_id===setId));
    const bonuses=sample?.set_bonuses??[];
    let applied=null;
    for (const tier of bonuses) if (count>=Number(tier.pieces)) applied=tier;
    if (applied) { for (const [stat,value] of Object.entries(applied.stats??{})) { result[stat]=(result[stat]??0)+Number(value); } }
  }
  // 餐食 buff：食用后多场战斗获得攻击/防御/体力加成
  const mealBuff=state.player?.meal_buff;
  if(mealBuff&&Number(mealBuff.remaining_battles??0)>0){
    result.attack+=Number(mealBuff.attack??0);result.max_attack+=Number(mealBuff.attack??0);
    result.defense+=Number(mealBuff.defense??0);result.agility+=Number(mealBuff.agility??0);
    result.max_health+=Number(mealBuff.max_health??0);result.morale+=Number(mealBuff.morale??0);
  }
  return result;
}

// 每获胜一场递减餐食 buff 剩余场次，归零清除
function consumeMealBattle(state) {
  const buff=state.player?.meal_buff;
  if(!buff||Number(buff.remaining_battles??0)<=0){state.player.meal_buff=null;return null;}
  const next=Number(buff.remaining_battles)-1;
  if(next<=0){state.player.meal_buff=null;return null;}
  state.player.meal_buff={ ...buff,remaining_battles:next };
  return { ...state.player.meal_buff };
}

function monsterStats(monster) {
  const level=Math.max(1,Number(monster.level));
  const type=Number(monster.monster_type ?? 5);
  if (type === 3 || type === 4) return {
    health:Math.floor(200+300*(level-1)/209),attack:1,max_attack:1,defense:10000,agility:1,
    effect:monster.effect??null,special:monster.special??null,
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
    effect:monster.effect??null,special:monster.special??null,
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

module.exports = { CombatRuntime,CookRuntime,DiscoverRuntime,DivingRuntime,DropRuntime,DungeonRuntime,EconomyRuntime,EquipmentRuntime,EquipmentEnhanceRuntime,FishingRuntime,FormalGameplayCatalog,GuildRuntime,CityRuntime,ItemRuntime,MarketRuntime,MaritimeRuntime,PetRuntime,RecoveryRuntime,RecruitRuntime,SkillRuntime,ShipRuntime,TradeOrderRuntime,TradeReputationRuntime,TradeSellRuntime,VoyagePrepRuntime,VoyageRuntime,EQUIPMENT_SLOT_BY_TYPE,applyTitle,chooseFishingWaitOutcome,consumeMealBattle,damage,effectiveStats,fishingRarityWeights,monsterStats };
