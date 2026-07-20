'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {DatabaseSync}=require('node:sqlite');
const {EQUIPMENT_SLOT_BY_TYPE,chooseFishingWaitOutcome,damage,fishingRarityWeights,monsterStats}=require('../src/task-runtime');

const root=path.resolve(__dirname,'..');
const cases=JSON.parse(fs.readFileSync(path.join(root,'data','runtime','reference-golden-cases.json'),'utf8')).cases;
const byId=new Map(cases.map((entry)=>[entry.canonical_id,entry]));

test('reference level thresholds equal the current canonical table',()=>{
  const value=byId.get('golden.level.thresholds');const thresholds=require('../data/runtime/level-experience.json').thresholds;
  assert.deepEqual(value.input.levels.map((level)=>thresholds[level]),value.reference_output.thresholds);
});

test('reference monster and boss type multipliers match deterministic runtime stats',()=>{
  for(const id of ['golden.monster.normal-level-10','golden.monster.task-boss-level-10']){
    const value=byId.get(id);const output=monsterStats(value.input);
    assert.deepEqual(Object.fromEntries(Object.keys(value.reference_output).map((key)=>[key,output[key]])),value.reference_output);
  }
});

test('reference damage formula uses round at the fixed non-critical boundary',()=>{
  const value=byId.get('golden.combat.damage-rounding');const input=value.input;let index=0;
  assert.equal(damage(input.min_attack,input.max_attack,input.defense,input.attacker_agility,input.defender_agility,()=>input.random_values[index++]),value.reference_output.damage);
});

test('reference drop constants and equipment slots remain exported',()=>{
  const drops=byId.get('golden.drop.probabilities').reference_output;
  const content=JSON.parse(fs.readFileSync(path.join(root,'web','generated','task1-content.json'),'utf8'));
  assert.equal(content.gameplay_rules.drops.equipment_pool_probability,drops.equipment_pool_probability);
  assert.equal(content.gameplay_rules.drops.ordinary_item_probability,drops.ordinary_item_probability);
  const slots=byId.get('golden.equipment.slots');assert.deepEqual(slots.input.equipment_types.map((type)=>EQUIPMENT_SLOT_BY_TYPE[type]),slots.reference_output.slots);
});

test('reference fishing event candidates are uniform and rarity weights react to successFactor',()=>{
  const wait=byId.get('golden.fishing.wait-events');assert.deepEqual(wait.input.event_rolls.map((roll)=>chooseFishingWaitOutcome(()=>roll)),wait.reference_output.events);
  const rarity=byId.get('golden.fishing.rarity-weights');assert.deepEqual(rarity.input.success_factors.map((factor)=>fishingRarityWeights(null,factor)),rarity.reference_output.weights);
});

test('reference sailing trigger, market ranges and NPC state lifecycle remain catalogued',()=>{
  const sailing=byId.get('golden.sailing.event-trigger');assert.deepEqual(sailing.input.rolls.map((roll)=>roll<sailing.reference_output.probability),sailing.reference_output.triggered);
  const global=JSON.parse(fs.readFileSync(path.join(root,'data','generated','global-content-catalog.json'),'utf8'));
  assert.equal(global.counts.city_price_ranges,byId.get('golden.market.price-ranges').reference_output.city_good_ranges);
  const marketCase=byId.get('golden.market.price-ranges');
  assert.equal(global.acquisition.markets.length,marketCase.current_runtime_output.queryable_city_good_ranges);
  assert.equal(global.acquisition.markets.flatMap((entry)=>[entry.minimum_price,entry.maximum_price]).filter((value)=>value!==null).length,marketCase.current_runtime_output.numeric_boundary_values);
  const rules=JSON.parse(fs.readFileSync(path.join(root,'data','generated','reference-rule-catalog.json'),'utf8'));
  assert.ok(rules.records.find((entry)=>entry.canonical_id==='rule.npc.interaction'&&entry.current_runtime_modules.includes('TaskRuntimeEngine.interactNpc')));
});

test('reference first-task rewards equal imported runtime rewards',()=>{
  const value=byId.get('golden.task.reward-first');const db=new DatabaseSync(path.join(root,'data','zhsh-content.sqlite'),{readOnly:true});
  try{const rows=db.prepare(`SELECT tr.reward_name,tr.normalized_quantity FROM task_rewards tr JOIN task_definitions t ON t.id=tr.task_id
    WHERE t.canonical_id=? ORDER BY tr.reward_order`).all(value.input.task_canonical_id);
    assert.deepEqual(Object.fromEntries(rows.map((row)=>[row.reward_name,Number(row.normalized_quantity)])),value.reference_output.rewards);
  }finally{db.close();}
});

test('golden suite covers the required rule families with explicit source locators',()=>{
  const systems=new Set(cases.map((entry)=>entry.system));for(const system of ['level_experience','monster_stats','boss_multiplier','damage','drops','equipment','sailing_events','market','fishing_wait','fishing_rarity','npc_state','task_rewards'])assert.ok(systems.has(system),system);
  assert.ok(cases.every((entry)=>entry.source&&entry.input&&entry.reference_output));
});
