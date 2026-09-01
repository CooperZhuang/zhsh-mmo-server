'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {effectiveStats}=require('../src/task-runtime/formal-gameplay');

// mock catalog：只提供 getEquipment，返回带 set_id/set_bonuses 的装备
function catalogFor(equipmentMap){
  return { getEquipment:(id)=>equipmentMap.get(id)??null };
}
function equip(id,attrs={}){
  return { canonical_id:id,...attrs };
}
// state.equipment：部位键 → id，外加 accessories 数组
function state(equipped){
  const equipment={};
  const accessories=[];
  for(const [slot,id] of equipped){
    if(slot==='acc')accessories.push(id);
    else equipment[slot]=id;
  }
  equipment.accessories=accessories;
  return { player:{ base_attack:10,base_max_attack:10,base_defense:5,base_agility:3,max_health:100,morale:0 },equipment };
}

const COLUMBUS_BONUSES=[
  {pieces:2,stats:{attack:4,defense:3}},
  {pieces:4,stats:{attack:9,defense:7,max_health:20}},
  {pieces:6,stats:{attack:16,defense:13,max_health:40,morale:10}},
];

test('equipment set tiered bonus activates only at the highest met threshold',()=>{
  // 2 件 → 激活 2 件档
  const catalog=catalogFor(new Map([
    ['w',equip('w',{set_id:'set.columbus',set_bonuses:COLUMBUS_BONUSES})],
    ['b',equip('b',{set_id:'set.columbus',set_bonuses:COLUMBUS_BONUSES})],
  ]));
  const stats=effectiveStats(state([['weapon','w'],['boots','b']]),catalog);
  assert.equal(stats.attack,10+4); // 基础10 + 套装2档 attack4
  assert.equal(stats.defense,5+3); // 基础5 + 套装2档 defense3
  assert.equal(stats.max_health,100); // 2 档无生命加成
});

test('equipment set activates 6-piece tier when six pieces are worn',()=>{
  const ids=['w1','w2','w3','w4','w5','w6'];
  const catalog=catalogFor(new Map(ids.map((id)=>[id,equip(id,{set_id:'set.columbus',set_bonuses:COLUMBUS_BONUSES})])));
  const stats=effectiveStats(state(ids.map((id,i)=>[`slot${i}`,id])),catalog);
  assert.equal(stats.attack,10+16);       // 6 档 attack16
  assert.equal(stats.defense,5+13);       // 6 档 defense13
  assert.equal(stats.max_health,100+40);  // 6 档 max_health40
  assert.equal(stats.morale,0+10);        // 6 档 morale10
});

test('equipment set does not activate when below the minimum pieces threshold',()=>{
  const catalog=catalogFor(new Map([
    ['w',equip('w',{set_id:'set.columbus',set_bonuses:COLUMBUS_BONUSES})],
  ]));
  const stats=effectiveStats(state([['weapon','w']]),catalog);
  assert.equal(stats.attack,10);  // 1 件未达 2 件阈值，无加成
  assert.equal(stats.defense,5);
});

test('equipment set counting never accumulates a non-worn set',()=>{
  // 穿 2 件哥伦布 + 1 件海军（无套装），哥伦布应只计 2 件档；海军单件无加成
  const catalog=catalogFor(new Map([
    ['w',equip('w',{set_id:'set.columbus',set_bonuses:COLUMBUS_BONUSES})],
    ['b',equip('b',{set_id:'set.columbus',set_bonuses:COLUMBUS_BONUSES})],
    ['n',equip('n',{set_id:'set.navy',set_bonuses:[{pieces:2,stats:{attack:8}}]})],
  ]));
  const stats=effectiveStats(state([['weapon','w'],['boots','b'],['helmet','n']]),catalog);
  assert.equal(stats.attack,10+4); // 仅哥伦布 2 档 +4，海军单件不激活
  assert.equal(stats.defense,5+3);
});

test('equipment set bonus never applies when item has no set_id',()=>{
  const catalog=catalogFor(new Map([
    ['w',equip('w',{attack:5})], // 普通装备，无 set_id
  ]));
  const stats=effectiveStats(state([['weapon','w']]),catalog);
  // 无套装，无额外加成；单件基础 attack5 仍累计
  assert.equal(stats.attack,10+5);
});
