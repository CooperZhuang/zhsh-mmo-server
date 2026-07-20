'use strict';

function staminaItemSemantics(item){
  const data=item?.normalized_data??item?.attributes??{};
  const type=Number(data.type??item?.item_type);
  const addHp=Number(data.info?.addHp??item?.add_hp??0);
  const allHp=Number(data.info?.allHp??item?.all_hp??0);
  if(type!==45||!(addHp>0)||!(allHp>0))return null;
  return {item_canonical_id:item.canonical_id,display_name:item.display_name,type,add_hp:addHp,all_hp:allHp,
    rule_id:'zhsh.play.stamina-item.v1',trigger_health_ratio:0.5,
    source_behavior:'active item adds temporary maximum health and is consumed automatically below 50% after all attacks'};
}

function activeStaminaItem(state,catalog){
  return Object.entries(state.inventory??{}).filter(([,quantity])=>Number(quantity)>0).map(([id])=>catalog.getItem(id)).filter(Boolean)
    .map((item)=>({item,semantics:staminaItemSemantics(item)})).filter((entry)=>entry.semantics)
    .sort((left,right)=>String(left.item.display_name??'').localeCompare(String(right.item.display_name??''),'zh-CN')
      ||left.item.canonical_id.localeCompare(right.item.canonical_id))[0]??null;
}

function useActiveStaminaItem(state,catalog,{automatic=false}={}){
  const active=activeStaminaItem(state,catalog);if(!active)return {applied:false,reason:'stamina_item_unavailable'};
  const {item,semantics}=active;const maximumBefore=baseMaximumHealth(state,catalog)+semantics.add_hp;
  if(automatic&&Number(state.player.current_health)/maximumBefore>=semantics.trigger_health_ratio)
    return {applied:false,reason:'automatic_threshold_not_met',item_canonical_id:item.canonical_id,current_health:Number(state.player.current_health),max_health:maximumBefore};
  const before=Number(state.player.current_health);const missing=Math.max(0,maximumBefore-before);
  if(missing<=0)return {applied:false,reason:'health_already_full',item_canonical_id:item.canonical_id,current_health:before,max_health:maximumBefore};
  const recovered=Math.min(semantics.all_hp,missing);
  setInventory(state,item.canonical_id,Number(state.inventory[item.canonical_id])-1);
  state.player.current_health=before+recovered;
  const next=activeStaminaItem(state,catalog);const maximumAfter=baseMaximumHealth(state,catalog)+Number(next?.semantics.add_hp??0);
  return {applied:true,action:automatic?'stamina_item_auto_used':'stamina_item_used',item_canonical_id:item.canonical_id,
    display_name:item.display_name,recovered_health:recovered,current_health:state.player.current_health,max_health_before:maximumBefore,
    max_health_after:maximumAfter,source_current_health_clamp:false,remaining_quantity:Number(state.inventory[item.canonical_id]??0),rule_id:semantics.rule_id};
}

function baseMaximumHealth(state,catalog){
  let maximum=Number(state.player.max_health);const equipped=[...Object.entries(state.equipment??{}).filter(([key])=>key!=='accessories').map(([,id])=>id),...(state.equipment?.accessories??[])].filter(Boolean);
  for(const id of equipped)maximum+=Number(catalog.getEquipment(id)?.health??0);return maximum;
}

function setInventory(state,itemId,quantity){if(quantity>0)state.inventory[itemId]=quantity;else delete state.inventory[itemId];}

module.exports={activeStaminaItem,baseMaximumHealth,staminaItemSemantics,useActiveStaminaItem};
