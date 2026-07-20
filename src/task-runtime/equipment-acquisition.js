'use strict';

const crypto=require('node:crypto');

const SLOT_BY_TYPE=Object.freeze({1:'weapon',2:'headgear',3:'clothes',4:'belt',5:'shoes',6:'accessories',7:'offhand'});
const DEFAULT_ACQUISITION_CONFIDENCE=0.99;
const DEFAULT_COMBAT_SAMPLE_COUNT=256;

function playerStatsAtLevel(playerLevel){
  const stats={level:1,max_health:100,attack:50,max_attack:80,defense:4,agility:3,morale:50};
  for(let level=2;level<=Number(playerLevel);level+=1){
    stats.max_health+=10+Math.floor(level/5);const attackGain=2+Math.floor(level/10);
    stats.attack+=attackGain;stats.max_attack+=attackGain;stats.defense+=1+Math.floor(level/15);stats.agility+=1;stats.morale+=5;
  }
  stats.level=Number(playerLevel);return stats;
}

function selectSourceBackedLoadout(candidates,playerLevel){
  const eligible=candidates.filter((entry)=>Number(entry.required_level??1)<=Number(playerLevel)
    &&(entry.acquisition_sources??[]).some((source)=>source.source_kind==='shop'||Number(source.source_monster_level??Infinity)<=Number(playerLevel)));
  return selectActualLoadout(eligible,playerLevel);
}

function selectActualLoadout(candidates,playerLevel){
  const eligible=candidates.filter((entry)=>Number(entry.required_level??1)<=Number(playerLevel));
  const bySlot=new Map();
  for(const entry of eligible){const slot=SLOT_BY_TYPE[Number(entry.equipment_type)];if(!slot)continue;const values=bySlot.get(slot)??[];values.push(entry);bySlot.set(slot,values);}
  const sort=(left,right)=>loadoutScore(right)-loadoutScore(left)||left.canonical_id.localeCompare(right.canonical_id);
  const selected=[];
  for(const [slot,values] of bySlot){values.sort(sort);selected.push(...values.slice(0,slot==='accessories'?3:1));}
  return selected.sort((a,b)=>Number(a.equipment_type)-Number(b.equipment_type)||a.canonical_id.localeCompare(b.canonical_id));
}

function applyLoadout(stats,loadout){
  const result={...stats};
  for(const item of loadout){const value=item.attributes??{};
    result.attack+=Number(value.attack??0);result.max_attack+=Number(value.maxAttack??value.max_attack??0);
    result.defense+=Number(value.defense??0);result.agility+=Number(value.agility??0);
    result.max_health+=Number(value.health??value.max_health??0);result.morale+=Number(value.morale??0);
  }
  return result;
}

function deterministicCombatProof(playerLevel,monster,actualLoadout=[]){
  const {damage,monsterStats}=require('./formal-gameplay');
  if(!monster)return {closed:false,reason:'monster_definition_missing'};
  const loadout=selectActualLoadout(actualLoadout,playerLevel);
  const player=applyLoadout(playerStatsAtLevel(playerLevel),loadout);const opponent=monsterStats(monster);
  const playerRoll=[0.999999,0];const monsterRoll=[0,0.999999];
  const playerDamage=damage(player.attack,player.max_attack,opponent.defense,player.agility,opponent.agility,()=>playerRoll.shift());
  const monsterDamage=damage(opponent.attack,opponent.max_attack,player.defense,opponent.agility,player.agility,()=>monsterRoll.shift());
  const roundsToWin=Math.ceil(opponent.health/playerDamage);const roundsToDefeat=Math.ceil(player.max_health/monsterDamage);
  return {closed:roundsToWin<=roundsToDefeat,player_level:Number(playerLevel),player_max_health:player.max_health,
    player_damage_per_round:playerDamage,monster_damage_per_round:monsterDamage,rounds_to_win:roundsToWin,rounds_to_defeat:roundsToDefeat,
    loadout:loadout.map(loadoutRecord),rule_ids:['zhsh.monster.type-level.v1','formal.damage.v1','zhsh.equipment.actual-loadout.v1']};
}

function deterministicSourceBackedCombatProof(playerLevel,monster,equipmentCandidates=[]){
  const loadout=selectSourceBackedLoadout(equipmentCandidates,playerLevel);
  return {...deterministicCombatProof(playerLevel,monster,loadout),rule_ids:['zhsh.monster.type-level.v1','formal.damage.v1','zhsh.equipment.source-backed-loadout.v1']};
}

function planEquipmentAcquisition(options={}){
  const state=normalizeState(options.current_state??options.currentState??{});
  const playerLevel=state.level;
  const completedTasks=new Set(state.completed_task_canonical_ids);
  const reachableLocations=new Set(options.reachable_location_canonical_ids??options.reachableLocationIds??[]);
  const candidates=(options.equipment_candidates??options.equipmentCandidates??[]).map(normalizeCandidate)
    .filter((entry)=>entry.canonical_id&&SLOT_BY_TYPE[entry.equipment_type]);
  const byId=new Map(candidates.map((entry)=>[entry.canonical_id,entry]));
  const owned=new Map();const provenance=new Map();
  for(const id of [...state.inventory_equipment_canonical_ids,...state.equipped_equipment_canonical_ids])if(byId.has(id)){
    owned.set(id,byId.get(id));provenance.set(id,{wave:-1,source_kind:'existing_owned',actual_source:{source_kind:'existing_owned'},
      source_proof_loadout_ids:[],expected_attempts:0,reasonable_worst_attempts:0,recovery_count:0,funding_closed:true});
  }
  const rejectedSources=[];let wave=0;
  while(wave<=candidates.length){
    const availableLoadout=selectActualLoadout([...owned.values()],playerLevel);const additions=[];
    const currentTarget=options.target_monster??options.targetMonster??null;
    if(currentTarget&&deterministicCombatProof(playerLevel,currentTarget,availableLoadout).closed)break;
    for(const candidate of candidates){
      if(owned.has(candidate.canonical_id)||candidate.required_level>playerLevel)continue;
      const evaluations=candidate.acquisition_sources.map((source)=>evaluateSource({source,candidate,state,completedTasks,reachableLocations,
        availableLoadout,confidence:Number(options.acquisition_confidence??DEFAULT_ACQUISITION_CONFIDENCE),
        sampleCount:Number(options.combat_sample_count??DEFAULT_COMBAT_SAMPLE_COUNT)}));
      const closed=evaluations.filter((entry)=>entry.closed).sort(sourceOrder)[0];
      if(closed)additions.push({candidate,source:closed});
      else rejectedSources.push(...evaluations.map((entry)=>({equipment_canonical_id:candidate.canonical_id,wave,...entry})));
    }
    if(!additions.length)break;
    additions.sort((a,b)=>a.candidate.canonical_id.localeCompare(b.candidate.canonical_id));
    for(const addition of additions){owned.set(addition.candidate.canonical_id,addition.candidate);provenance.set(addition.candidate.canonical_id,{wave,...addition.source});}
    wave+=1;
  }
  const actualLoadout=selectActualLoadout([...owned.values()],playerLevel);
  const requiredIds=traceRequiredEquipment(actualLoadout.map((entry)=>entry.canonical_id),provenance);
  const acquisitions=[...requiredIds].filter((id)=>provenance.get(id)?.source_kind!=='existing_owned').map((id)=>{
    const item=byId.get(id);const source=provenance.get(id);return acquisitionRecord(item,source);
  }).sort((a,b)=>a.acquisition_wave-b.acquisition_wave||a.equipment_canonical_id.localeCompare(b.equipment_canonical_id));
  const targetMonster=options.target_monster??options.targetMonster??null;
  const targetProof=targetMonster?withCombatSample(deterministicCombatProof(playerLevel,targetMonster,actualLoadout),playerLevel,targetMonster,actualLoadout,
    Number(options.combat_sample_count??DEFAULT_COMBAT_SAMPLE_COUNT)):null;
  const cycles=targetProof?.closed?[]:detectCycles({candidates,owned,provenance,playerLevel,reachableLocations,completedTasks});
  const unclosedReasons=[];
  if(!targetMonster)unclosedReasons.push({code:'target_monster_missing'});
  else if(!targetProof.closed)unclosedReasons.push({code:'target_combat_not_closed',monster_canonical_id:targetMonster.canonical_id,
    deterministic_best_play:targetProof.closed,win_probability:targetProof.win_probability,rounds_to_win:targetProof.rounds_to_win,rounds_to_defeat:targetProof.rounds_to_defeat});
  if(cycles.length)unclosedReasons.push({code:'equipment_acquisition_cycle',cycles});
  const baseStats=playerStatsAtLevel(playerLevel);const equippedStats=applyLoadout(baseStats,actualLoadout);
  const acquisitionClosed=cycles.length===0&&acquisitions.every((entry)=>entry.acquisition_closed)
    &&(actualLoadout.length>0||Boolean(targetProof?.closed)||candidates.length===0);
  return {planner_rule_id:'zhsh.equipment-acquisition-planner.v1',acquisition_closed:acquisitionClosed,
    target_combat_closed:Boolean(targetProof?.closed),closed:Boolean(targetProof?.closed)&&acquisitionClosed,
    current_state:state,reachable_location_count:reachableLocations.size,actual_loadout:actualLoadout.map((entry)=>({
      ...loadoutRecord(entry),slot:SLOT_BY_TYPE[entry.equipment_type],acquisition_wave:provenance.get(entry.canonical_id)?.wave??null})),
    acquired_equipment:acquisitions,attribute_change:attributeChange(baseStats,equippedStats),target_combat_proof:targetProof,
    cycle_dependencies:cycles,unclosed_reasons:unclosedReasons,rejected_source_count:rejectedSources.length,
    rejected_sources:acquisitionClosed?[]:summarizeRejected(rejectedSources),source_confidence:options.source_confidence??'SOURCE_EXPLICIT',
    runtime_adjudication_status:targetProof?.closed?(acquisitions.length?'CLOSED_WITH_ACTUAL_ACQUISITION':'CLOSED_WITH_ACCEPTED_STATE_NO_EQUIPMENT'):'BLOCKED_BY_FORMAL_COMBAT',
    has_active_conflict:Boolean(options.compatibility_experience_dependency),
    compatibility_experience_dependency:Boolean(options.compatibility_experience_dependency)};
}

function evaluateSource({source,candidate,state,completedTasks,reachableLocations,availableLoadout,confidence,sampleCount}){
  const kind=source.source_kind;
  if(kind==='task_reward'){
    if(!source.task_canonical_id||!completedTasks.has(source.task_canonical_id))return {closed:false,source_kind:kind,actual_source:source,reason:'future_task_reward_not_allowed'};
    if(!state.inventory_equipment_canonical_ids.includes(candidate.canonical_id)&&!state.equipped_equipment_canonical_ids.includes(candidate.canonical_id))
      return {closed:false,source_kind:kind,actual_source:source,reason:'completed_reward_not_present_in_actual_inventory'};
  }
  if(source.location_canonical_id&&reachableLocations.size&&!reachableLocations.has(source.location_canonical_id))
    return {closed:false,source_kind:kind,actual_source:source,reason:'source_location_not_reachable'};
  if(kind==='shop'){
    const price=Number(source.price??Infinity);if(!Number.isFinite(price))return {closed:false,source_kind:kind,actual_source:source,reason:'shop_price_missing'};
    if(price>state.money)return {closed:false,source_kind:kind,actual_source:source,reason:'insufficient_actual_money',required_money:price,actual_money:state.money};
    return {closed:true,source_kind:kind,actual_source:source,source_proof_loadout_ids:[],expected_attempts:1,reasonable_worst_attempts:1,
      recovery_count:0,funding_closed:true,source_monster_combat:null};
  }
  if(kind!=='monster_drop')return {closed:false,source_kind:kind,actual_source:source,reason:'unsupported_source_kind'};
  if(!source.monster)return {closed:false,source_kind:kind,actual_source:source,reason:'source_monster_missing'};
  const bestPlay=deterministicCombatProof(state.level,source.monster,availableLoadout);
  const sampled=withCombatSample(bestPlay,state.level,source.monster,availableLoadout,sampleCount);
  if(!bestPlay.closed||sampled.win_probability<=0)return {closed:false,source_kind:kind,actual_source:source,
    reason:'source_monster_not_survivable_before_acquisition',source_monster_combat:sampled,source_proof_loadout_ids:bestPlay.loadout.map((entry)=>entry.canonical_id)};
  const dropProbability=Number(source.effective_probability??source.probability??0);
  if(!(dropProbability>0&&dropProbability<=1))return {closed:false,source_kind:kind,actual_source:source,reason:'drop_probability_missing_or_invalid'};
  const successPerAttempt=dropProbability*sampled.win_probability;
  const expectedAttempts=round(1/successPerAttempt);const worst=attemptsForConfidence(successPerAttempt,confidence);
  return {closed:true,source_kind:kind,actual_source:source,source_proof_loadout_ids:bestPlay.loadout.map((entry)=>entry.canonical_id),
    expected_attempts:expectedAttempts,reasonable_worst_attempts:worst,recovery_count:Math.ceil(worst*(1-sampled.win_probability)),
    funding_closed:true,source_monster_combat:sampled,drop_probability:dropProbability,acquisition_confidence:confidence};
}

function detectCycles({candidates,owned,playerLevel,reachableLocations,completedTasks}){
  const edges=new Map();
  for(const candidate of candidates){if(owned.has(candidate.canonical_id)||candidate.required_level>playerLevel)continue;
    for(const source of candidate.acquisition_sources){
      if(source.source_kind==='task_reward'&&!completedTasks.has(source.task_canonical_id))continue;
      if(source.location_canonical_id&&reachableLocations.size&&!reachableLocations.has(source.location_canonical_id))continue;
      if(source.source_kind!=='monster_drop'||!source.monster)continue;
      const without=deterministicCombatProof(playerLevel,source.monster,[...owned.values()]);
      if(without.closed)continue;
      const withSelf=deterministicCombatProof(playerLevel,source.monster,[...owned.values(),candidate]);
      if(withSelf.closed)addEdge(edges,candidate.canonical_id,candidate.canonical_id);
      for(const dependency of candidates){if(owned.has(dependency.canonical_id)||dependency.canonical_id===candidate.canonical_id)continue;
        if(deterministicCombatProof(playerLevel,source.monster,[...owned.values(),dependency]).closed)addEdge(edges,candidate.canonical_id,dependency.canonical_id);}
    }
  }
  return graphCycles(edges);
}

function sampleCombat(playerLevel,monster,actualLoadout,sampleCount){
  const {damage,monsterStats}=require('./formal-gameplay');const player=applyLoadout(playerStatsAtLevel(playerLevel),selectActualLoadout(actualLoadout,playerLevel));const opponent=monsterStats(monster);
  let wins=0,totalRounds=0,maximumRounds=0;
  for(let sample=0;sample<sampleCount;sample+=1){const random=seededRandom(`${playerLevel}|${monster.canonical_id}|equipment|${sample}`);
    let health=player.max_health,monsterHealth=opponent.health,rounds=0;
    while(health>0&&monsterHealth>0&&rounds<4096){rounds+=1;monsterHealth=Math.max(0,monsterHealth-damage(player.attack,player.max_attack,opponent.defense,player.agility,opponent.agility,random));
      if(monsterHealth===0){wins+=1;break;}health=Math.max(0,health-damage(opponent.attack,opponent.max_attack,player.defense,opponent.agility,player.agility,random));}
    totalRounds+=rounds;maximumRounds=Math.max(maximumRounds,rounds);
  }
  return {sample_count:sampleCount,wins,win_probability:round(wins/sampleCount),average_rounds:round(totalRounds/sampleCount),maximum_rounds:maximumRounds};
}

function withCombatSample(proof,level,monster,loadout,sampleCount){return {...proof,...sampleCombat(level,monster,loadout,sampleCount)};}
function normalizeCandidate(entry){return {...entry,required_level:Number(entry.required_level??entry.level??1),equipment_type:Number(entry.equipment_type??entry.type),
  attributes:entry.attributes??entry.normalized_data??{},acquisition_sources:(entry.acquisition_sources??[]).map((source)=>({...source}))};}
function normalizeState(state){return {completed_task_canonical_ids:[...new Set(state.completed_task_canonical_ids??[])].sort(),level:Number(state.level??1),
  experience:Number(state.experience??0),money:Number(state.money??0),location_canonical_id:state.location_canonical_id??null,
  ship_canonical_ids:[...new Set(state.ship_canonical_ids??[])].sort(),inventory_equipment_canonical_ids:[...new Set(state.inventory_equipment_canonical_ids??[])].sort(),
  equipped_equipment_canonical_ids:[...new Set(state.equipped_equipment_canonical_ids??[])].sort()};}
function acquisitionRecord(item,source){return {equipment_canonical_id:item.canonical_id,display_name:item.display_name,acquisition_closed:source.closed,
  acquisition_wave:source.wave,actual_source:source.actual_source,source_kind:source.source_kind,prerequisites:source.source_proof_loadout_ids,
  source_location_canonical_id:source.actual_source.location_canonical_id??null,arrival_path:source.actual_source.arrival_path??[],
  source_monster:source.actual_source.monster?{canonical_id:source.actual_source.monster.canonical_id,display_name:source.actual_source.monster.display_name,
    level:Number(source.actual_source.monster.level),monster_type:Number(source.actual_source.monster.monster_type)}:null,
  source_monster_combat:source.source_monster_combat??null,drop_probability:source.drop_probability??null,expected_attempts:source.expected_attempts,
  reasonable_worst_attempts:source.reasonable_worst_attempts,recovery_count:source.recovery_count,funding_closed:source.funding_closed,
  equipped_slot:SLOT_BY_TYPE[item.equipment_type],attributes:item.attributes,source_confidence:source.actual_source.evidence_status??'SOURCE_EXPLICIT'};}
function traceRequiredEquipment(initial,provenance){const required=new Set();const visit=(id)=>{if(required.has(id))return;required.add(id);for(const dependency of provenance.get(id)?.source_proof_loadout_ids??[])visit(dependency);};for(const id of initial)visit(id);return required;}
function summarizeRejected(values){const unique=new Map();for(const value of values){const key=`${value.equipment_canonical_id}|${value.actual_source?.canonical_id??value.source_kind}|${value.reason}`;if(!unique.has(key))unique.set(key,{equipment_canonical_id:value.equipment_canonical_id,
  source_canonical_id:value.actual_source?.canonical_id??null,source_kind:value.source_kind,reason:value.reason});}return [...unique.values()].sort((a,b)=>a.equipment_canonical_id.localeCompare(b.equipment_canonical_id)||String(a.source_canonical_id).localeCompare(String(b.source_canonical_id)));}
function attemptsForConfidence(probability,confidence){if(probability>=1)return 1;return Math.ceil(Math.log(1-confidence)/Math.log(1-probability));}
function sourceOrder(left,right){return Number(left.reasonable_worst_attempts??Infinity)-Number(right.reasonable_worst_attempts??Infinity)
  ||String(left.actual_source?.canonical_id??'').localeCompare(String(right.actual_source?.canonical_id??''));}
function attributeChange(before,after){return Object.fromEntries(['max_health','attack','max_attack','defense','agility','morale'].map((key)=>[key,{before:before[key],after:after[key],delta:after[key]-before[key]}]));}
function loadoutRecord(entry){return {canonical_id:entry.canonical_id,display_name:entry.display_name,required_level:Number(entry.required_level??1),equipment_type:Number(entry.equipment_type)};}
function addEdge(edges,from,to){const values=edges.get(from)??new Set();values.add(to);edges.set(from,values);}
function graphCycles(edges){const result=[];const seen=new Set();const stack=[];const active=new Set();const visit=(node)=>{if(active.has(node)){const index=stack.indexOf(node);result.push([...stack.slice(index),node]);return;}if(seen.has(node))return;seen.add(node);active.add(node);stack.push(node);for(const next of edges.get(node)??[])visit(next);stack.pop();active.delete(node);};for(const node of [...edges.keys()].sort())visit(node);return [...new Map(result.map((cycle)=>[cycle.join('|'),cycle])).values()];}
function seededRandom(seed){let state=crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};}
function loadoutScore(entry){const value=entry.attributes??{};return Number(value.attack??0)+Number(value.maxAttack??value.max_attack??0)
  +Number(value.defense??0)*3+Number(value.agility??0)*2+Number(value.health??value.max_health??0)/5+Number(value.morale??0)/2;}
function round(value){return Math.round(Number(value)*1000)/1000;}

module.exports={DEFAULT_ACQUISITION_CONFIDENCE,DEFAULT_COMBAT_SAMPLE_COUNT,SLOT_BY_TYPE,applyLoadout,deterministicCombatProof,
  deterministicSourceBackedCombatProof,planEquipmentAcquisition,playerStatsAtLevel,selectActualLoadout,selectSourceBackedLoadout};
