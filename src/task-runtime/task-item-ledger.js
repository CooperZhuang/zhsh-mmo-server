'use strict';

const LEDGER_SCHEMA_VERSION=1;
const ACTIVE_STATUSES=new Set(['accepted','in_progress','completable']);

function ensureTaskItemLedger(state){
  if(!state.task_item_ledger||typeof state.task_item_ledger!=='object')state.task_item_ledger={};
  const ledger=state.task_item_ledger;ledger.schema_version=LEDGER_SCHEMA_VERSION;
  for(const key of ['reservations','grants','consumptions','abandonments'])if(!ledger[key]||typeof ledger[key]!=='object'||Array.isArray(ledger[key]))ledger[key]={};
  return ledger;
}

function grantInventoryItem(state,{itemCanonicalId,quantity,grantId=null,sourceKind='gameplay',sourceTaskCanonicalId=null,targetTaskCanonicalId=null,generatedOnAccept=false}){
  quantity=positive(quantity);const ledger=ensureTaskItemLedger(state);
  if(grantId&&ledger.grants[grantId])return {...ledger.grants[grantId],idempotent_replay:true};
  state.inventory[itemCanonicalId]=(state.inventory[itemCanonicalId]??0)+quantity;
  const record={item_canonical_id:itemCanonicalId,quantity,source_kind:sourceKind,source_task_canonical_id:sourceTaskCanonicalId,
    target_task_canonical_id:targetTaskCanonicalId,generated_on_accept:Boolean(generatedOnAccept)};
  if(grantId)ledger.grants[grantId]=record;
  return record;
}

function reconcileTaskItemReservations(state,tasks){
  const ledger=ensureTaskItemLedger(state);const activeTasks=tasks.filter((task)=>ACTIVE_STATUSES.has(state.tasks?.[task.canonical_id]?.status));
  const activeKeys=new Set();const allocated=new Map();
  for(const task of activeTasks){
    for(const target of task.targets.filter((entry)=>entry.target_kind==='item'&&entry.entity_canonical_id)){
      const key=reservationKey(task.canonical_id,target.canonical_id);activeKeys.add(key);
      const total=Number(state.inventory?.[target.entity_canonical_id]??0);const used=allocated.get(target.entity_canonical_id)??0;
      const reserved=Math.max(0,Math.min(Number(target.required_quantity),total-used));allocated.set(target.entity_canonical_id,used+reserved);
      ledger.reservations[key]={task_canonical_id:task.canonical_id,target_canonical_id:target.canonical_id,item_canonical_id:target.entity_canonical_id,
        required_quantity:Number(target.required_quantity),reserved_quantity:reserved,policy:target.task_item_policy??defaultPolicy(task)};
    }
  }
  for(const key of Object.keys(ledger.reservations))if(!activeKeys.has(key))delete ledger.reservations[key];
  return Object.values(ledger.reservations);
}

function assertInventoryRemovalAllowed(state,itemCanonicalId,quantity,{reason='inventory_removal',excludingTaskCanonicalId=null}={}){
  quantity=positive(quantity);const inventory=Number(state.inventory?.[itemCanonicalId]??0);
  const reserved=reservedQuantity(state,itemCanonicalId,{excludingTaskCanonicalId});
  if(inventory-quantity<reserved)throw new Error(`Task item is reserved and cannot be removed by ${reason}: ${itemCanonicalId}`);
  return {inventory_quantity:inventory,reserved_quantity:reserved,removable_quantity:inventory-reserved};
}

function consumeTaskItems(state,task,consumptionId){
  const ledger=ensureTaskItemLedger(state);if(consumptionId&&ledger.consumptions[consumptionId])return {...ledger.consumptions[consumptionId],idempotent_replay:true};
  const consumed=[];
  for(const target of task.targets.filter((entry)=>entry.target_kind==='item')){
    const existing=Number(state.inventory?.[target.entity_canonical_id]??0);const required=Number(target.required_quantity);
    if(existing<required)throw new Error(`Required task item is missing: ${target.entity_canonical_id}`);
    setInventory(state,target.entity_canonical_id,existing-required);consumed.push({item_canonical_id:target.entity_canonical_id,quantity:required,target_canonical_id:target.canonical_id});
    delete ledger.reservations[reservationKey(task.canonical_id,target.canonical_id)];
  }
  const record={task_canonical_id:task.canonical_id,items:consumed};if(consumptionId)ledger.consumptions[consumptionId]=record;return record;
}

function abandonTaskItems(state,task,abandonmentId){
  const ledger=ensureTaskItemLedger(state);if(abandonmentId&&ledger.abandonments[abandonmentId])return {...ledger.abandonments[abandonmentId],idempotent_replay:true};
  const removed=[];
  for(const [grantId,grant] of Object.entries(ledger.grants)){
    if(grant.target_task_canonical_id!==task.canonical_id||!grant.generated_on_accept||grant.rolled_back)continue;
    const existing=Number(state.inventory?.[grant.item_canonical_id]??0);const quantity=Math.min(existing,Number(grant.quantity));
    if(quantity>0){setInventory(state,grant.item_canonical_id,existing-quantity);removed.push({item_canonical_id:grant.item_canonical_id,quantity});}
    ledger.grants[grantId]={...grant,rolled_back:true,rolled_back_quantity:quantity};
  }
  for(const target of task.targets.filter((entry)=>entry.target_kind==='item'))delete ledger.reservations[reservationKey(task.canonical_id,target.canonical_id)];
  const record={task_canonical_id:task.canonical_id,rolled_back_acceptance_items:removed};if(abandonmentId)ledger.abandonments[abandonmentId]=record;return record;
}

function reservedQuantity(state,itemCanonicalId,{excludingTaskCanonicalId=null}={}){
  const ledger=ensureTaskItemLedger(state);return Object.values(ledger.reservations).filter((entry)=>entry.item_canonical_id===itemCanonicalId
    &&entry.task_canonical_id!==excludingTaskCanonicalId).reduce((sum,entry)=>sum+Number(entry.reserved_quantity??0),0);
}

function defaultPolicy(task){return {acquisition_mode:task.task_type==='送物品'?'grant_on_accept':'world_acquisition',reservation:'required_until_submit',
  abandonment:task.task_type==='送物品'?'rollback_acceptance_grant':'retain_inventory',consumption:'submit_only'};}
function reservationKey(taskId,targetId){return `${taskId}|${targetId}`;}
function setInventory(state,id,quantity){if(quantity<=0)delete state.inventory[id];else state.inventory[id]=quantity;}
function positive(value){const number=Number(value);if(!Number.isInteger(number)||number<=0)throw new Error('Quantity must be a positive integer');return number;}

module.exports={LEDGER_SCHEMA_VERSION,abandonTaskItems,assertInventoryRemovalAllowed,consumeTaskItems,defaultPolicy,ensureTaskItemLedger,
  grantInventoryItem,reconcileTaskItemReservations,reservedQuantity};
