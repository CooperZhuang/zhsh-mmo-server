'use strict';

const {damage,effectiveStats}=require('./formal-gameplay');
const {useActiveStaminaItem}=require('./stamina-item');

const ACTIVE_STATUSES=new Set(['accepted','in_progress','completable']);
const REPLAY_WINDOW=128;

class NpcDuelRuntime{
  constructor({storage,taskCatalog,gameplayCatalog,taskEngine,random=Math.random,clock=()=>new Date().toISOString()}){
    this.storage=storage;this.taskCatalog=taskCatalog;this.gameplayCatalog=gameplayCatalog;this.taskEngine=taskEngine;this.random=random;this.clock=clock;
  }
  start(playerId,npcCanonicalId,eventId){
    const result=transact(this.storage,playerId,eventId,'npc_duel_start',{npc_canonical_id:npcCanonicalId},this.clock,(state)=>{
      if(state.combat||state.npc_duel)throw new Error('另一场战斗或 NPC 决斗正在进行中。');
      const node=this.taskCatalog.getMapNode(state.player.current_map_node_canonical_id);if(!node?.location_canonical_id)throw new Error('NPC 决斗需要处于正式地点。');
      const placement=this.taskCatalog.listNpcsAtNode(node.map_node_canonical_id).find((entry)=>entry.npc_canonical_id===npcCanonicalId);
      if(!placement)throw new Error('NPC 决斗目标不在当前正式地点。');
      const match=findActiveDuelTask(state,this.taskCatalog,npcCanonicalId,node.location_canonical_id);
      if(!match)throw new Error('NPC 决斗需要匹配的进行中任务。');
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
      if(!state.npc_duel)throw new Error('当前没有进行中的 NPC 决斗。');
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
      if(!state.npc_duel)throw new Error('当前没有进行中的 NPC 决斗。');const canonicalId=state.npc_duel.canonical_id;state.npc_duel=null;
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
