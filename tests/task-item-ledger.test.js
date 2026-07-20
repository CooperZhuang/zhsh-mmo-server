'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const {BrowserTaskCatalog,MemoryRuntimeStorage,TaskRuntimeEngine}=require('../src/task-runtime');
const {abandonTaskItems,assertInventoryRemovalAllowed,consumeTaskItems,grantInventoryItem,reconcileTaskItemReservations}=require('../src/task-runtime/task-item-ledger');

const content=JSON.parse(fs.readFileSync('web/generated/task1-content.json','utf8'));
const task=(id)=>content.tasks.find((entry)=>entry.canonical_id===id);

function stateFor(activeTask){return {inventory:{},tasks:{[activeTask.canonical_id]:{status:'accepted'}},task_item_ledger:null};}

test('prior-task reward is reserved for downstream submission and cannot be sold, equipped or consumed',()=>{
  const source=task('task.series.15.470');const delivery=task('task.series.15.471');const reward=source.rewards.find((entry)=>entry.reward_name==='龙鳞');
  const state=stateFor(delivery);
  grantInventoryItem(state,{itemCanonicalId:reward.content_entity_canonical_id,quantity:1,grantId:'reward:scale',sourceKind:'task_reward',sourceTaskCanonicalId:source.canonical_id});
  const reservations=reconcileTaskItemReservations(state,[delivery]);assert.equal(reservations[0].reserved_quantity,1);
  for(const reason of ['shop_sell','equipment_equip','item_use'])assert.throws(()=>assertInventoryRemovalAllowed(state,reward.content_entity_canonical_id,1,{reason}),/reserved/);
  const consumed=consumeTaskItems(state,delivery,'submit:delivery');assert.equal(consumed.items[0].quantity,1);assert.equal(state.inventory[reward.content_entity_canonical_id],undefined);
});

test('chain reward remains after abandonment while generated acceptance items are rolled back',()=>{
  const delivery=task('task.series.15.471');const itemId=delivery.targets[0].entity_canonical_id;const state=stateFor(delivery);
  grantInventoryItem(state,{itemCanonicalId:itemId,quantity:1,grantId:'reward:prior',sourceKind:'task_reward',sourceTaskCanonicalId:'task.prior'});
  reconcileTaskItemReservations(state,[delivery]);abandonTaskItems(state,delivery,'abandon:chain');assert.equal(state.inventory[itemId],1);

  const generatedTask={canonical_id:'task.synthetic.delivery',task_type:'送物品',targets:[{canonical_id:'task.synthetic.delivery.target.01',target_kind:'item',entity_canonical_id:'item.synthetic',required_quantity:1}]};
  state.tasks[generatedTask.canonical_id]={status:'accepted'};
  grantInventoryItem(state,{itemCanonicalId:'item.synthetic',quantity:1,grantId:'accept:synthetic',sourceKind:'task_acceptance',targetTaskCanonicalId:generatedTask.canonical_id,generatedOnAccept:true});
  abandonTaskItems(state,generatedTask,'abandon:synthetic');assert.equal(state.inventory['item.synthetic'],undefined);
});

test('the black pearl reward is immediately usable as the next task-chain reservation',()=>{
  const source=task('task.series.15.471');const next=task('task.series.15.472');const reward=source.rewards.find((entry)=>entry.reward_name==='黑珍珠');
  const state=stateFor(next);grantInventoryItem(state,{itemCanonicalId:reward.content_entity_canonical_id,quantity:1,grantId:'reward:pearl',sourceKind:'task_reward',sourceTaskCanonicalId:source.canonical_id});
  const reservations=reconcileTaskItemReservations(state,[next]);assert.equal(reservations[0].item_canonical_id,next.targets[0].entity_canonical_id);assert.equal(reservations[0].reserved_quantity,1);
});


test('15.459 receives magic powder on acceptance and consumes exactly one on formal submission',()=>{
  const catalog=new BrowserTaskCatalog(content);
  const storage=new MemoryRuntimeStorage();
  const engine=new TaskRuntimeEngine({catalog,storage,seriesCanonicalIds:content.series.map((entry)=>entry.canonical_id),clock:()=> '2026-07-20T00:00:00.000Z'});
  const player='player.magic-powder-handoff';
  engine.createPlayer(player);
  engine.synchronizeDefinitions(player);
  storage.transact(player,(state)=>{
    state.player.level=200;
    state.tasks['task.series.15.458'].status='completed';
    state.tasks['task.series.15.458'].reward_status='granted';
    return {applied:true};
  });
  engine.refreshAvailability(player);
  const delivery=task('task.series.15.459');
  assert.equal(engine.loadPlayer(player).tasks[delivery.canonical_id].status,'available');
  engine.processEvent(player,{event_id:'powder-arrive-receive',type:'arrive_at_location',location_canonical_id:delivery.receive_location_canonical_id});
  const accepted=engine.processEvent(player,{event_id:'powder-accept',type:'talk_to_npc',npc_canonical_id:delivery.issuer_npc_canonical_id,location_canonical_id:delivery.receive_location_canonical_id});
  const itemId=delivery.targets[0].entity_canonical_id;
  assert.deepEqual(accepted.generated_task_items,[{item_canonical_id:itemId,quantity:1}]);
  assert.equal(engine.loadPlayer(player).inventory[itemId],1);
  assert.equal(engine.loadPlayer(player).tasks[delivery.canonical_id].status,'completable');
  engine.processEvent(player,{event_id:'powder-arrive-submit',type:'arrive_at_location',location_canonical_id:delivery.submit_location_canonical_id});
  const completed=engine.processEvent(player,{event_id:'powder-submit',type:'submit_to_npc',npc_canonical_id:delivery.completion_npc_canonical_id,location_canonical_id:delivery.submit_location_canonical_id});
  assert.equal(completed.action,'completed');
  assert.equal(engine.loadPlayer(player).inventory[itemId],undefined);
  assert.equal(engine.processEvent(player,{event_id:'powder-submit',type:'submit_to_npc',npc_canonical_id:delivery.completion_npc_canonical_id,location_canonical_id:delivery.submit_location_canonical_id}).idempotent_replay,true);
});
