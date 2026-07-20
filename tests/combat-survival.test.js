'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const {minimumDeterministicStaminaQuantity,sampleCombatWithStamina,staminaItemSemantics}=require('../src/task-runtime');
const {acquireFormalLoadout}=require('../browser-tests/formal-equipment-acquisition-helper');

const root=path.resolve(__dirname,'..');
const content=read('web/generated/task1-content.json');
const selection=read('data/generated/runnable-task-selection.json');
const analysis=read('tests/fixtures/accepted-78-combat-survival-analysis.json');
const equipmentAnalysis=read('tests/fixtures/accepted-78-equipment-acquisition-analysis.json');
const baseline=read('tests/fixtures/browser-save-v4-formal-72-of-72.json');

test('accepted 78-task stamina allocation preserves the source Mediterranean shop semantics',()=>{
  const source=analysis.stamina_source;const item=content.formal_items.find((entry)=>entry.canonical_id===source.item_canonical_id);
  const shop=content.shop_entries.find((entry)=>entry.canonical_id===source.shop_entry_canonical_id);const semantics=staminaItemSemantics(item);
  assert.deepEqual({type:semantics.type,add_hp:semantics.add_hp,all_hp:semantics.all_hp},{type:45,add_hp:5000,all_hp:50000});
  assert.equal(shop.price,200000);assert.equal(shop.location_canonical_id,source.location_canonical_id);assert.equal(source.available_quantity,1);
});

test('accepted 78-task stamina simulation closes only the high-leverage series 11 root',()=>{
  const byId=new Map(analysis.candidates.map((entry)=>[entry.task_canonical_id,entry]));
  assert.equal(byId.get('task.series.11.065').proofs[0].proof.wins,256);
  assert.equal(byId.get('task.series.05.036').proofs[0].proof.wins,0);
  assert.equal(byId.get('task.series.10.057').proofs[0].proof.wins,0);
  assert.deepEqual(analysis.chosen_allocation.newly_selected_task_ids,
    ['task.series.11.065','task.series.11.066','task.series.11.067','task.series.11.068','task.series.11.069','task.series.11.070']);
  assert.equal(analysis.money_ledger.second_purchase_affordable,false);assert.equal(analysis.money_ledger.next_root_task_canonical_id,'task.series.11.071');
});

test('formal acquisition adapter obtains and equips all eight source-backed items without state injection',async()=>{
  const result=await acquireFormalLoadout({content,record:baseline,equipmentAnalysis});
  assert.equal(result.loadout.length,8);assert.equal(result.acquisitions.length,8);assert.equal(result.victories,8);assert.equal(result.direct_state_mutations,0);
  const equipped=[...Object.entries(result.record.state.equipment).filter(([key])=>key!=='accessories').map(([,id])=>id),...result.record.state.equipment.accessories].filter(Boolean);
  assert.deepEqual(new Set(equipped),new Set(result.loadout.map((entry)=>entry.canonical_id)));
  assert.ok(result.acquisitions.every((entry)=>entry.drop_control.includes('DropRuntime')));
});

test('combat sampler preserves finite consumable accounting',()=>{
  const candidate=analysis.candidates.find((entry)=>entry.task_canonical_id==='task.series.11.065');const proof=candidate.proofs[0].proof;
  assert.equal(proof.consumables_required,1);assert.equal(proof.average_stamina_uses,1);assert.equal(proof.closed,true);
  const item=content.formal_items.find((entry)=>entry.canonical_id===analysis.stamina_source.item_canonical_id);
  const sourceProof=sampleCombatWithStamina({player_level:45,monster:content.monsters.find((entry)=>entry.canonical_id===candidate.proofs[0].monster_canonical_id),
    actual_loadout:[],stamina_item:item,sample_count:8});
  assert.equal(sourceProof.stamina_item.item_canonical_id,item.canonical_id);assert.equal(sourceProof.sample_count,8);
});

test('finite stamina proof finds the exact two-item closure for the source George encounter',()=>{
  const monster=content.monsters.find((entry)=>entry.display_name==='乔治');const item=content.formal_items.find((entry)=>entry.canonical_id===analysis.stamina_source.item_canonical_id);
  const equipmentIds=['entity.equipment.c9913b879b85ee45','entity.equipment.0d3eeb9b40ed3b7e','entity.equipment.e156a287baf90005',
    'entity.equipment.a2e1b812d0cfd5b9','entity.equipment.22176e1ac0fa66e3','entity.equipment.1ef177807961d5b6',
    'entity.equipment.d319659d3957c117','entity.equipment.67dc4911873e9eed'];
  const proof=minimumDeterministicStaminaQuantity({player_level:200,monster,actual_loadout:content.equipment.filter((entry)=>equipmentIds.includes(entry.canonical_id)),stamina_item:item,max_quantity:4});
  assert.equal(proof.closed,true);assert.equal(proof.consumables_required,2);assert.equal(proof.deterministic_best_play.stamina_uses,2);
});

function read(relative){return JSON.parse(fs.readFileSync(path.join(root,...relative.split('/')),'utf8'));}
