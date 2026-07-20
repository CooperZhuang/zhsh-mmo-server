'use strict';

const crypto=require('node:crypto');
const {LEVEL_THRESHOLDS}=require('./gameplay-state');
const {applyLoadout,playerStatsAtLevel}=require('./equipment-acquisition');
const {damage,monsterStats}=require('./formal-gameplay');

const DEFAULT_SAMPLE_COUNT=256;

function monsterExperience(level,encounterType,rewardRules){
  const multiplier=Number(rewardRules.experience.encounter_multipliers[encounterType]??1);
  return Math.max(Number(rewardRules.experience.minimum),Math.round(Number(level)*Number(rewardRules.experience.base_experience_per_level)*multiplier));
}

function planTrainingPath(options){
  const currentLevel=Math.max(1,Number(options.currentLevel??1));
  const targetLevel=Math.max(currentLevel,Number(options.targetLevel??currentLevel));
  const rewardRules=options.rewardRules;
  const progressionRules=options.progressionRules;
  if(!rewardRules?.experience)throw new Error('Progression planner requires monster reward rules');
  if(!progressionRules?.canonical_rules)throw new Error('Progression planner requires canonical progression rules');
  const sampleCount=Number(options.sampleCount??DEFAULT_SAMPLE_COUNT);
  const actualEquipment=options.actualEquipment??[];
  const reachableLocations=new Set(options.reachableLocationIds??[]);
  const encounters=(options.encounters??[])
    .filter((entry)=>!reachableLocations.size||reachableLocations.has(entry.location_canonical_id))
    .filter((entry)=>entry.repeatable!==false)
    .map((entry)=>normalizeEncounter(entry,rewardRules));
  let level=currentLevel;
  let experience=Math.max(0,Number(options.currentExperience??0));
  const segments=[];
  while(level<targetLevel){
    level=advanceLevel(level,experience);
    if(level>=targetLevel)break;
    const threshold=Number(LEVEL_THRESHOLDS[level]);
    const candidates=encounters.filter((entry)=>entry.level<=level).map((entry)=>({
      ...entry,combat:sampleCombat(level,entry,actualEquipment,sampleCount),
    })).filter((entry)=>entry.combat.win_probability>0);
    if(!candidates.length){
      return result(false,currentLevel,targetLevel,experience,segments,[{code:'no_survivable_repeatable_encounter',player_level:level}],actualEquipment);
    }
    const segment=allocateSegment({level,experience,threshold,candidates,progressionRules});
    segments.push(segment);
    if(!segment.reasonable){
      return result(false,currentLevel,targetLevel,experience,segments,segment.blockers,actualEquipment);
    }
    experience=segment.resulting_experience;
    level=advanceLevel(level,experience);
  }
  return result(true,currentLevel,targetLevel,experience,segments,[],actualEquipment);
}

function allocateSegment({level,experience,threshold,candidates,progressionRules}){
  const repeat=progressionRules.canonical_rules.repeatable_training;
  const trainingRule=progressionRules.canonical_rules.reasonable_training;
  const limitMinutes=Number(trainingRule.maximum_minutes_per_session??trainingRule.maximum_minutes_per_level_segment);
  const continuationAllowed=trainingRule.session_continuation_allowed!==false;
  const capacity=Math.max(1,Number(repeat.minimum_instances_per_cache));
  const refreshSeconds=Math.max(0,Number(repeat.cache_refresh_seconds));
  const attackSeconds=Math.max(0.001,Number(repeat.automatic_attack_interval_seconds));
  const bestByLocation=[...group(candidates,(entry)=>entry.location_canonical_id).entries()].map(([locationId,values])=>
    values.sort((left,right)=>right.experience-left.experience||right.combat.win_probability-left.combat.win_probability
      ||left.combat.average_rounds-right.combat.average_rounds||left.monster_canonical_id.localeCompare(right.monster_canonical_id))[0])
    .sort((left,right)=>right.experience-left.experience||left.location_canonical_id.localeCompare(right.location_canonical_id));
  const wins=[];
  let simulatedExperience=experience;
  let wave=0;
  while(simulatedExperience<threshold){
    let added=false;
    for(const encounter of bestByLocation){
      for(let instance=0;instance<capacity&&simulatedExperience<threshold;instance+=1){
        wins.push({wave,encounter});simulatedExperience+=encounter.experience;added=true;
      }
    }
    if(!added)break;
    wave+=1;
  }
  const allocations=[...group(wins,(entry)=>`${entry.encounter.monster_canonical_id}|${entry.encounter.location_canonical_id}`).entries()].map(([,entries])=>{
    const encounter=entries[0].encounter;
    const expectedAttempts=entries.length/encounter.combat.win_probability;
    const conservativeProbability=Math.max(0.05,encounter.combat.win_probability-2*encounter.combat.standard_error);
    const reasonableWorstAttempts=Math.ceil(entries.length/conservativeProbability);
    return {monster_canonical_id:encounter.monster_canonical_id,monster_name:encounter.monster_name,monster_level:encounter.level,
      monster_type:encounter.monster_type,location_canonical_id:encounter.location_canonical_id,city_canonical_id:encounter.city_canonical_id,
      experience_per_victory:encounter.experience,planned_victories:entries.length,expected_attempts:round(expectedAttempts),
      reasonable_worst_attempts:reasonableWorstAttempts,win_probability:round(encounter.combat.win_probability),
      sampled_battles:encounter.combat.sample_count,average_rounds_per_attempt:encounter.combat.average_rounds,
      maximum_sampled_rounds:encounter.combat.maximum_rounds};
  }).sort((left,right)=>left.location_canonical_id.localeCompare(right.location_canonical_id)||left.monster_canonical_id.localeCompare(right.monster_canonical_id));
  const refreshWaits=Math.max(0,wave-1);
  const expectedAttempts=allocations.reduce((sum,entry)=>sum+entry.expected_attempts,0);
  const reasonableWorstAttempts=allocations.reduce((sum,entry)=>sum+entry.reasonable_worst_attempts,0);
  const combatSeconds=allocations.reduce((sum,entry)=>sum+entry.reasonable_worst_attempts*entry.maximum_sampled_rounds*attackSeconds,0);
  const reasonableWorstMinutes=round((combatSeconds+refreshWaits*refreshSeconds)/60);
  const trainingSessionCount=Math.max(1,Math.ceil(reasonableWorstMinutes/limitMinutes));
  const maximumSessionMinutes=round(Math.min(limitMinutes,reasonableWorstMinutes));
  const reasonable=simulatedExperience>=threshold&&(continuationAllowed||reasonableWorstMinutes<=limitMinutes);
  const blockers=[];
  if(simulatedExperience<threshold)blockers.push({code:'repeatable_encounter_capacity_not_closed'});
  if(!continuationAllowed&&reasonableWorstMinutes>limitMinutes)blockers.push({code:'training_duration_exceeds_source_session_scale',
    calculated_minutes:reasonableWorstMinutes,source_maximum_minutes:limitMinutes});
  return {from_level:level,from_experience:experience,target_experience:threshold,resulting_experience:simulatedExperience,
    reachable_training_locations:bestByLocation.map((entry)=>entry.location_canonical_id),encounter_allocations:allocations,
    planned_victories:wins.length,expected_attempts:round(expectedAttempts),reasonable_worst_attempts:reasonableWorstAttempts,
    cache_waves:wave,cache_refresh_waits:refreshWaits,reasonable_worst_minutes:reasonableWorstMinutes,
    source_session_limit_minutes:limitMinutes,training_session_count:trainingSessionCount,maximum_session_minutes:maximumSessionMinutes,
    session_continuation_required:trainingSessionCount>1,session_continuation_allowed:continuationAllowed,reasonable,blockers,
    recovery:{method:'church_priest_prayer',full_health:true,fee:0,loss_on_defeat:['market_goods'],money_closed:true},
    requirements:{unobtained_equipment:false,ship:false,party:false,crew:false}};
}

function sampleCombat(playerLevel,encounter,actualEquipment,sampleCount){
  const player=applyLoadout(playerStatsAtLevel(playerLevel),actualEquipment);
  const opponent=monsterStats(encounter);
  let wins=0,totalRounds=0,maximumRounds=0;
  for(let sample=0;sample<sampleCount;sample+=1){
    const random=seededRandom(`${playerLevel}|${encounter.monster_canonical_id}|${encounter.location_canonical_id}|${sample}`);
    let playerHealth=player.max_health;
    let monsterHealth=opponent.health;
    let rounds=0;
    while(playerHealth>0&&monsterHealth>0&&rounds<4096){
      rounds+=1;
      monsterHealth=Math.max(0,monsterHealth-damage(player.attack,player.max_attack,opponent.defense,player.agility,opponent.agility,random));
      if(monsterHealth===0){wins+=1;break;}
      playerHealth=Math.max(0,playerHealth-damage(opponent.attack,opponent.max_attack,player.defense,opponent.agility,player.agility,random));
    }
    totalRounds+=rounds;maximumRounds=Math.max(maximumRounds,rounds);
  }
  const probability=wins/sampleCount;
  return {sample_count:sampleCount,wins,win_probability:probability,standard_error:Math.sqrt(probability*(1-probability)/sampleCount),
    average_rounds:round(totalRounds/sampleCount),maximum_rounds:maximumRounds};
}

function normalizeEncounter(entry,rewardRules){
  const level=Math.max(1,Number(entry.level));
  const encounterType=entry.encounter_type??'wild';
  return {...entry,level,monster_type:Number(entry.monster_type??5),experience:monsterExperience(level,encounterType,rewardRules)};
}

function advanceLevel(level,experience){let result=level;while(result<LEVEL_THRESHOLDS.length&&experience>=Number(LEVEL_THRESHOLDS[result]))result+=1;return result;}
function result(closed,currentLevel,targetLevel,experience,segments,blockers,actualEquipment){return {planner_rule_id:'zhsh.progression-planner.v1',
  formally_executable:closed,current_level:currentLevel,target_level:targetLevel,resulting_experience:experience,level_segments:segments,
  total_planned_victories:segments.reduce((sum,entry)=>sum+entry.planned_victories,0),
  total_reasonable_worst_attempts:segments.reduce((sum,entry)=>sum+entry.reasonable_worst_attempts,0),
  recovery_and_funding_closed:segments.every((entry)=>entry.recovery.money_closed),requires_unobtained_equipment:false,
  actual_equipment_canonical_ids:actualEquipment.map((entry)=>entry.canonical_id),requires_ship:false,requires_party:false,requires_crew:false,blockers};}
function group(values,key){const result=new Map();for(const value of values){const id=key(value);const entries=result.get(id)??[];entries.push(value);result.set(id,entries);}return result;}
function seededRandom(seed){let state=crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};}
function round(value){return Math.round(Number(value)*1000)/1000;}

module.exports={DEFAULT_SAMPLE_COUNT,monsterExperience,planTrainingPath,sampleCombat};
