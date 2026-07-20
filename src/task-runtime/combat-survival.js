'use strict';

const {applyLoadout,playerStatsAtLevel,selectActualLoadout}=require('./equipment-acquisition');
const {activeStaminaItem,staminaItemSemantics,useActiveStaminaItem}=require('./stamina-item');
const DEFAULT_SAMPLE_COUNT=256;

function sampleCombatWithStamina({player_level,monster,actual_loadout=[],stamina_item,sample_count=DEFAULT_SAMPLE_COUNT}){
  const {damage,monsterStats}=require('./formal-gameplay');
  const semantics=staminaItemSemantics(stamina_item);if(!semantics)return {closed:false,reason:'stamina_semantics_missing',sample_count:0,wins:0,win_probability:0};
  const loadout=selectActualLoadout(actual_loadout,player_level);const player=applyLoadout(playerStatsAtLevel(player_level),loadout);const opponent=monsterStats(monster);
  const best=simulateOne({player,opponent,semantics,damage,random:sequenceRandom([0.999999,0,0,0.999999]),staminaQuantity:1});
  let wins=0,totalRounds=0,uses=0;
  for(let sample=0;sample<sample_count;sample+=1){const result=simulateOne({player,opponent,semantics,damage,random:seededRandom(`${player_level}|${monster.canonical_id}|stamina|${sample}`),staminaQuantity:1});
    if(result.won)wins+=1;totalRounds+=result.rounds;uses+=result.stamina_uses;}
  return {closed:best.won&&wins>0,best_play_closed:best.won,player_level:Number(player_level),player_base_max_health:player.max_health,
    active_max_health:player.max_health+semantics.add_hp,monster_canonical_id:monster.canonical_id,stamina_item:semantics,
    deterministic_best_play:best,sample_count,wins,win_probability:round(wins/sample_count),average_rounds:round(totalRounds/sample_count),
    average_stamina_uses:round(uses/sample_count),consumables_required:1,rule_ids:['zhsh.monster.type-level.v1','formal.damage.v1','zhsh.play.stamina-item.v1']};
}

function deterministicCombatWithStaminaQuantity({player_level,monster,actual_loadout=[],stamina_item,quantity}){
  const {damage,monsterStats}=require('./formal-gameplay');const semantics=staminaItemSemantics(stamina_item);
  const normalizedQuantity=Number(quantity);if(!semantics||!Number.isInteger(normalizedQuantity)||normalizedQuantity<0)
    return {closed:false,reason:'invalid_stamina_quantity',consumables_required:normalizedQuantity};
  const loadout=selectActualLoadout(actual_loadout,player_level);const player=applyLoadout(playerStatsAtLevel(player_level),loadout);const opponent=monsterStats(monster);
  const result=simulateOne({player,opponent,semantics,damage,random:sequenceRandom([0.999999,0,0,0.999999]),staminaQuantity:normalizedQuantity});
  return {closed:result.won,player_level:Number(player_level),player_base_max_health:player.max_health,active_max_health:player.max_health+(normalizedQuantity?semantics.add_hp:0),
    monster_canonical_id:monster?.canonical_id??null,stamina_item:semantics,consumables_required:normalizedQuantity,deterministic_best_play:result,
    rule_ids:['zhsh.monster.type-level.v1','formal.damage.v1','zhsh.play.stamina-item.v1']};
}
function minimumDeterministicStaminaQuantity({player_level,monster,actual_loadout=[],stamina_item,max_quantity=4}){
  for(let quantity=0;quantity<=Number(max_quantity);quantity+=1){const proof=deterministicCombatWithStaminaQuantity({player_level,monster,actual_loadout,stamina_item,quantity});
    if(proof.closed)return proof;}
  return {...deterministicCombatWithStaminaQuantity({player_level,monster,actual_loadout,stamina_item,quantity:Number(max_quantity)}),closed:false,
    reason:'stamina_quantity_bound_exceeded',max_quantity:Number(max_quantity)};
}
function simulateOne({player,opponent,semantics,damage,random,staminaQuantity=1}){
  let remaining=Number(staminaQuantity),health=player.max_health+(remaining?semantics.add_hp:0),monsterHealth=opponent.health,rounds=0,staminaUses=0;
  while(health>0&&monsterHealth>0&&rounds<4096){rounds+=1;
    monsterHealth=Math.max(0,monsterHealth-damage(player.attack,player.max_attack,opponent.defense,player.agility,opponent.agility,random));
    if(monsterHealth===0)return {won:true,rounds,remaining_health:health,monster_remaining_health:0,stamina_uses:staminaUses,remaining_stamina_quantity:remaining};
    health=Math.max(0,health-damage(opponent.attack,opponent.max_attack,player.defense,opponent.agility,player.agility,random));
    const maximum=player.max_health+(remaining?semantics.add_hp:0);
    if(health>0&&remaining&&health/maximum<semantics.trigger_health_ratio){health+=Math.min(semantics.all_hp,maximum-health);remaining-=1;staminaUses+=1;}
  }
  return {won:false,rounds,remaining_health:health,monster_remaining_health:monsterHealth,stamina_uses:staminaUses,remaining_stamina_quantity:remaining};
}

function sequenceRandom(values){let index=0;return()=>values[index++%values.length];}
function seededRandom(seed){let state=2166136261;for(const character of String(seed)){state^=character.codePointAt(0);state=Math.imul(state,16777619)>>>0;}if(state===0)state=0x9e3779b9;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};}
function round(value){return Math.round(Number(value)*1000)/1000;}
module.exports={DEFAULT_SAMPLE_COUNT,activeStaminaItem,deterministicCombatWithStaminaQuantity,minimumDeterministicStaminaQuantity,sampleCombatWithStamina,staminaItemSemantics,useActiveStaminaItem};
