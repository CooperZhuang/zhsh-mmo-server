'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const referenceRoot=process.env.ZHSH_REFERENCE_ROOT??path.resolve(root,'..','zhsh-references','zhsh');
const outputPath=path.join(root,'data','runtime','maritime-capabilities.json');
const sources={
  fish:'config/fish.json',shopItems:'config/shopItems.json',shipFb:'config/shipFb.json',shipNpc:'config/shipNpc.json',
  shipFbTips:'config/shipFbTips.json',monsterItems:'config/monsterItems.json',monsterDrops:'config/monsterDrops.json',
  monsters:'config/monsters.json',
  sailingEncounters:'config/sailingEncounters.json',sailingSpecialEvents:'config/sailingSpecialEvents.json',
};
const read=(relative)=>JSON.parse(fs.readFileSync(path.join(referenceRoot,relative),'utf8'));
const loaded=Object.fromEntries(Object.entries(sources).map(([key,relative])=>[key,read(relative)]));
const sourceEvidence=Object.fromEntries(Object.entries(sources).map(([key,relative])=>{
  const bytes=fs.readFileSync(path.join(referenceRoot,relative));
  return [key,{repository:'zhsh',relative_path:relative,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}];
}));
const palaceName='海皇宫殿';
const palaceStages=Object.entries(loaded.shipFb['潜水副本'][palaceName]).map(([displayName,monsterName],index)=>{
  const monster=loaded.shipNpc[palaceName]?.[displayName]?.find((entry)=>entry.name===monsterName);
  if(!monster)throw new Error(`Missing palace monster stats: ${displayName}/${monsterName}`);
  return {sequence:index+1,display_name:displayName,monster:{display_name:monster.name,level:Number(monster.level),monster_type:Number(monster.type),
    item_drops:loaded.monsterItems[monster.name]??[],equipment_drops:loaded.monsterDrops[monster.name]??[]}};
});
const coastalItemSources=[];
for(const [city,locations] of Object.entries(loaded.monsters))for(const [location,monsters] of Object.entries(locations)) {
  if(!location.includes('浅海')&&!location.includes('深海'))continue;
  for(const monster of monsters)for(const itemName of loaded.monsterItems[monster.name]??[])coastalItemSources.push({
    city,location,monster_name:monster.name,monster_level:Number(monster.level),monster_type:Number(monster.type),item_name:itemName,
  });
}
const payload={
  schema_version:1,
  evidence_status:'SINGLE_SOURCE_EXPLICIT_WITH_SAILING_CONFLICT_RECORDED',
  source_evidence:sourceEvidence,
  fishing:{
    gear:loaded.shopItems.filter((entry)=>[8,14].includes(Number(entry.type))&&entry.priceType!=='gold'),
    catches:loaded.fish,
    rarity_weights:{common:50,uncommon:30,rare:15,epic:5},
    rarity_weight_adjustments:{
      below_one:{common:20,uncommon:-10,rare:-5,epic:-2},
      above_one:{common:-10,uncommon:10,rare:5,epic:2},
    },
    wait_event_probability:{base:0.1,increment_per_wait:0.05,maximum:0.5},
    wait_event_candidates:['nothing','bite','line_snapped','bait_eaten'],
    wait_event_selection:'uniform_after_independent_trigger_roll',
    initial_catch_probability:0.1,
  },
  sailing:{
    special_event_trigger_probability:0.05,
    special_events:loaded.sailingSpecialEvents.events,
    ship_dungeon_encounter_probability:0.05,
    source_ship_dungeon_order:Object.keys(loaded.shipFb['船副本']),
    route_encounters:loaded.sailingEncounters.encounters,
    implementation_conflict:'zhsh uses step-based voyage events; astrbot uses real-time voyage and pirate encounters. This stage retains the already accepted formal step-based runtime and adds zhsh event data without claiming multi-source agreement.',
  },
  diving:{
    encounter_probability:0.05,
    availability:[{minimum_level:160,count:null},{minimum_level:140,count:16},{minimum_level:120,count:14},{minimum_level:100,count:12},{minimum_level:80,count:10},{minimum_level:60,count:8},{minimum_level:40,count:6},{minimum_level:20,count:4},{minimum_level:1,count:2}],
    source_dungeon_order:Object.keys(loaded.shipFb['潜水副本']),
    formal_dungeons:[{display_name:palaceName,tip:loaded.shipFbTips['潜水副本'][palaceName],stages:palaceStages}],
    equipment_requirement:null,
    route_requirement:null,
    coastal_item_sources:coastalItemSources,
  },
};

fs.mkdirSync(path.dirname(outputPath),{recursive:true});
fs.writeFileSync(outputPath,`${JSON.stringify(payload,null,2)}\n`,'utf8');
process.stdout.write(`${JSON.stringify({output:path.relative(root,outputPath),fish:payload.fishing.catches.length,gear:payload.fishing.gear.length,
  sailing_events:payload.sailing.special_events.length,route_encounters:payload.sailing.route_encounters.length,
  formal_diving_dungeons:payload.diving.formal_dungeons.length,known_diving_dungeons:payload.diving.source_dungeon_order.length},null,2)}\n`);
