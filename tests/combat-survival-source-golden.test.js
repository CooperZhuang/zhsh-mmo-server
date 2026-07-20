'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {staminaItemSemantics}=require('../src/task-runtime');

const fixture=JSON.parse(fs.readFileSync(path.resolve('tests','fixtures','combat-survival-source-evidence.json'),'utf8'));
const content=JSON.parse(fs.readFileSync(path.resolve('web','generated','task1-content.json'),'utf8'));
const analysis=JSON.parse(fs.readFileSync(path.resolve('data','generated','combat-survival-analysis.json'),'utf8'));

test('combat-survival source fixture is immutable, explicit and complete',()=>{
  assert.equal(fixture.reference_commit,'b841e0e7f6dfcc5ef5dccd22c42989b12847816e');
  assert.equal(fixture.records.length,4);
  for(const record of fixture.records){
    assert.equal(record.repository,'zhsh');
    assert.equal(record.evidence_level,'SOURCE_EXPLICIT');
    assert.ok(record.relative_path);
    assert.ok(record.locator);
    assert.deepEqual(record.random_rules,[]);
  }
});

test('formal stamina item and shop entry preserve the source values',()=>{
  const expectedItem=fixture.records.find((entry)=>entry.canonical_id==='zhsh.config.stamina-item').expected;
  const item=content.formal_items.find((entry)=>entry.canonical_id===expectedItem.canonical_id);
  assert.ok(item);
  assert.equal(item.display_name,expectedItem.name);
  assert.equal(Number(item.normalized_data.price),expectedItem.price);
  const semantics=staminaItemSemantics(item);
  assert.equal(semantics.type,expectedItem.type);
  assert.equal(semantics.add_hp,expectedItem.addHp);
  assert.equal(semantics.all_hp,expectedItem.allHp);
  assert.equal(semantics.trigger_health_ratio,0.5);

  const expectedShop=fixture.records.find((entry)=>entry.canonical_id==='zhsh.shop.stamina-item').expected;
  const shop=content.shop_entries.find((entry)=>entry.canonical_id===expectedShop.shop_entry_canonical_id);
  assert.ok(shop);
  assert.equal(shop.location_canonical_id,expectedShop.location_canonical_id);
  assert.equal(Number(shop.price),expectedShop.price);
  assert.equal(shop.content_entity_canonical_id,expectedItem.canonical_id);
});

test('accepted combat-survival allocation is retained and no second unsupported purchase is invented',()=>{
  assert.equal(analysis.stage_start_selected_task_count,78);
  assert.equal(analysis.stamina_source.evidence_status,'SOURCE_EXPLICIT');
  assert.equal(analysis.stamina_source.available_quantity,0);
  assert.equal(analysis.chosen_allocation,null);
  assert.equal(analysis.accepted_state.completed_task_count,78);
  assert.equal(analysis.money_ledger.starting_money,18065);
  assert.equal(analysis.money_ledger.second_purchase_affordable,false);
  for(const id of ['task.series.05.036','task.series.10.057','task.series.13.142']){
    const candidate=analysis.candidates.find((entry)=>entry.task_canonical_id===id);
    assert.ok(candidate);
    assert.equal(candidate.simulated_unlock_delta,0);
    assert.equal(candidate.closes_all_requirements,false);
  }
  const exhausted=analysis.candidates.find((entry)=>entry.task_canonical_id==='task.series.11.071');
  assert.ok(exhausted);assert.equal(exhausted.closes_all_requirements,true);assert.equal(exhausted.source_closed,false);
});
