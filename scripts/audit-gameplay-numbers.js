'use strict';
/**
 * 纵横四海 · 游戏数值审计
 *
 * 独立于通关验证之外的动态校准器：对内容里所有数值系统做合理性/一致性检查，
 * 输出告警列表（anomalies），供持续修复。每类检查独立 try/catch，单点失败不影响其余。
 *
 * 覆盖：怪物奖励曲线、掉落概率、商店价格、装备属性阶梯、恢复费用、贸易价差、经验门槛曲线。
 */
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const content=JSON.parse(fs.readFileSync(path.join(root,'web','generated','task1-content.json'),'utf8'));

const findings=[];
function note(category,severity,msg){findings.push({category,severity,message:msg});}

// —— 1. 怪物奖励随等级单调/梯度合理 ——
function auditMonsterRewards(){
  const mons=content.monsters.filter((x)=>Number(x.level)>0&&Number(x.rewards?.experience)>0);
  const byLv=new Map();
  for(const m of mons){const lv=Number(m.level);if(!byLv.has(lv))byLv.set(lv,[]);byLv.get(lv).push(m);}
  const lvs=[...byLv.keys()].sort((a,b)=>a-b);
  const expFor=(lv)=>{const arr=byLv.get(lv);if(!arr||!arr.length)return null;return Math.min(...arr.map((m)=>Number(m.rewards.experience)));};
  // exp/等级 比例应大体稳定（约 40/级）
  for(const lv of lvs){
    const e=expFor(lv);if(e==null)continue;
    const ratio=e/lv;
    if(ratio<15||ratio>80)note('monster.rewards','warn',`lv${lv} exp=${e} 每级比 ${ratio.toFixed(1)} 偏${ratio<15?'低':'高'}`);
  }
  // 同等级多个怪的 exp 是否差异过大
  for(const lv of lvs){
    const arr=byLv.get(lv)||[];const exps=arr.map((m)=>Number(m.rewards.experience));
    if(exps.length>1){const spread=Math.max(...exps)-Math.min(...exps);if(spread>Math.max(20,0.5*Math.min(...exps)))note('monster.rewards','warn',`lv${lv} 同层怪 exp 差异 ${spread} (${Math.min(...exps)}~${Math.max(...exps)})`);}
  }
}

// —— 2. 掉落概率合理 ——
function auditDrops(){
  const drops=content.drop_relations||[];
  for(const d of drops){
    const p=Number(d.probability??0);const q=Number(d.quantity??1);
    if(!(p>=0&&p<=1))note('drops','error',`${d.canonical_id} 概率越界 ${p}`);
    if(p>0&&p<0.01)note('drops','warn',`${d.canonical_id} 概率过低 ${p}`);
    if(q<1)note('drops','warn',`${d.canonical_id} 数量<1 ${q}`);
    // 任务专属/必备掉落（guaranteed_for_active_task / drop_kind 为任务必得）概率 1.0 属正常
    const mandatory=d.guaranteed_for_active_task===true||/task-i?tem|required/i.test(d.drop_kind??'')||p===1;
    if(d.drop_kind==='item'&&p>0.6&&!mandatory)note('drops','warn',`${d.canonical_id} 普通物品掉落概率过高 ${p}`);
  }
}

// —— 3. 商店价格 vs 基础价值 ——
function auditShopPrices(){
  const shops=content.shop_entries||[];
  const itemById=new Map([...(content.formal_items??[]),...(content.content_entities??[])].map((x)=>[x.canonical_id,x]));
  for(const s of shops){
    const price=Number(s.price??0);
    if(price<=0){note('shop.price','warn',`${s.canonical_id} 价格<=0`);continue;}
    const item=itemById.get(s.content_entity_canonical_id);
    if(item&&Number(item.value??0)>0){const ratio=price/Number(item.value);if(ratio<0.5||ratio>8)note('shop.price','warn',`${s.canonical_id} 价格${price} vs 价值${item.value} 比 ${ratio.toFixed(1)}`);}
  }
}

// —— 4. 装备属性阶梯随 required_level ——
function auditEquipment(){
  const eqs=content.equipment||[];
  for(const e of eqs){
    const hasLv=Number(e.required_level)>0||Number(e.level)>0;
    // 缺 required_level 的高属性装备：数据完整性告警（可能为高等级装备漏填）
    if(!hasLv&&((Number(e.defense??0)+Number(e.attack??0)+Number(e.health??0)+Number(e.agility??0)+Number(e.morale??0))>=30))note('equipment','error',`${e.canonical_id} ${e.display_name} 缺 required_level 但属性总量>=30`);
    const lv=Number(e.required_level??e.level??1);
    const power=(Number(e.attack??0)+Number(e.defense??0)+Number(e.health??0)+Number(e.agility??0)+Number(e.morale??0));
    if(power<=0&&hasLv)note('equipment','warn',`${e.canonical_id} 属性总量为0`);
  }
}

// —— 5. 恢复费用 vs 体力上限 ——
function auditRecovery(){
  const rec=content.recovery_services||[];
  for(const r of rec){
    const fee=Number(r.fee??0);
    if(fee<0)note('recovery','warn',`${r.canonical_id} 费用<0`);
    if(r.recovery_kind==='full_health'&&fee>0&&fee>5000)note('recovery','warn',`${r.canonical_id} 全恢复费用 ${fee} 偏高`);
    if(r.recovery_kind!=='full_health'&&r.recovery_kind!=='amount'&&!['full_health','amount'].includes(r.recovery_kind))note('recovery','warn',`${r.canonical_id} 恢复类型未识别 ${r.recovery_kind}`);
  }
}

// —— 6. 贸易价差（产区×0.75 / 非产区×1.25 / sell×0.9）—— 
function auditTrade(){
  const goods=require(path.join(root,'server','content','goods.json'));
  const regions=goods.regions||{};
  const allGoods=Object.values(regions).flatMap((r)=>r.specialty||[]);
  let sorted=allGoods.map((g)=>({name:g.name,category:g.category,base:Number(g.base_price)}));
  // 每类基准价格分布是否合理
  for(const cat of ['food','specialty','material','luxury']){
    const catGoods=sorted.filter((g)=>g.category===cat);
    if(!catGoods.length)continue;
    const bases=catGoods.map((g)=>g.base);
    const min=Math.min(...bases),max=Math.max(...bases);
    if(max>min*20)note('trade','warn',`${cat} 类基准价差异过大 ${min}~${max}`);
  }
}

// —— 7. 经验门槛曲线是否平滑（不突跳） ——
function auditExpCurve(){
  const thr=require(path.join(root,'data','runtime','level-experience.json')).thresholds;
  let prev=null;
  for(let lv=1;lv<thr.length;lv++){
    const cur=Number(thr[lv]);if(!Number.isFinite(cur))continue;
    if(prev!=null){const delta=cur-prev;if(delta<=0)note('exp.curve','warn',`lv${lv} 门槛不增 ${cur}`);}
    prev=cur;
  }
}

for(const fn of [auditMonsterRewards,auditDrops,auditShopPrices,auditEquipment,auditRecovery,auditTrade,auditExpCurve]){
  try{fn();}catch(e){note('audit','error',`${fn.name} 执行失败: ${e.message}`);}
}

const byCat=new Map();
for(const f of findings){if(!byCat.has(f.category))byCat.set(f.category,[]);byCat.get(f.category).push(f);}
let errorCount=0,warnCount=0;
for(const f of findings){if(f.severity==='error')errorCount++;else warnCount++;}
console.log(`\n=== 游戏数值审计: ${findings.length} 条 (error ${errorCount} / warn ${warnCount}) ===`);
for(const [cat,items] of byCat){
  console.log(`\n[${cat}]`);
  for(const f of items)console.log(`  ${f.severity==='error'?'✗':'!'} ${f.message}`);
}
process.exit(errorCount?1:0);
