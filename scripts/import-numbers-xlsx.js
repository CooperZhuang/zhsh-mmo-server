'use strict';
/**
 * 纵横四海 · 策划数值 Excel → 修正层(patch)生成
 *
 * 读取策划改好的 gameplay-numbers.xlsx（中文表头），对比源证据基线(multisource-baseline.json)，
 * 把「与基线不同的数值」写入 data/runtime/values-patch.json。**不改动 baseline**——
 * baseline 是 sha 锚定的源证据快照，策划数值改动一律落在 patch 层；export-task1-content 合并 patch 生效。
 *
 * 用法：
 *   node scripts/import-numbers-xlsx.js [--src design/numbers/gameplay-numbers.xlsx] [--dry-run]
 * 说明：--dry-run 只打印将生成哪些 patch，不落盘。
 *   patch 集合映射：
 *     monsters(名称/等级/类型) → entity_value_patches.monster_definitions {display_name, level, monster_type}
 *     drops(概率/数量)          → entity_value_patches.drop_relations {probability, quantity}
 *     shops(价格)               → entity_value_patches.shop_entries {price}
 *     物价(价格区间)            → entity_value_patches.city_price_ranges {minimum_price, maximum_price}
 *     装备(等级/属性)           → entity_value_patches.equipment {level, attack, ...}
 */
const fs=require('node:fs');
const path=require('node:path');
const XLSX=require('xlsx');
const root=path.resolve(__dirname,'..');
const baselinePath=path.join(root,'docs','reconstruction-baseline','multisource-baseline.json');
const patchPath=path.join(root,'data','runtime','values-patch.json');
const defaultSrc=path.join(root,'design','numbers','gameplay-numbers.xlsx');

// 数值域 → 表名 + 中文列 + baseline 实体键 与 patch 集合映射
const DOMAINS=[
  {key:'monsters',sheet:'怪物',patchCollection:'monster_definitions',defs:[
    {field:'name',label:'名称',patchField:'display_name'},{field:'level',label:'等级',kind:'num'},{field:'type',label:'类型',kind:'num',patchField:'monster_type'},
  ]},
  {key:'drops',sheet:'掉落',patchCollection:'drop_relations',defs:[
    {field:'probability',label:'概率',kind:'num'},{field:'quantity',label:'数量',kind:'num'},
  ]},
  {key:'shops',sheet:'商店',patchCollection:'shop_entries',defs:[
    {field:'price',label:'价格',kind:'num'},
  ]},
  {key:'city_price_ranges',sheet:'物价',patchCollection:'city_price_ranges',defs:[
    {field:'minimum_price',label:'最低价',kind:'num'},{field:'maximum_price',label:'最高价',kind:'num'},
  ]},
  {key:'equipment',sheet:'装备',patchCollection:'equipment',defs:[
    {field:'level',label:'等级',kind:'num'},{field:'attack',label:'攻击',kind:'num'},{field:'maxAttack',label:'最大攻击',kind:'num'},{field:'defense',label:'防御',kind:'num'},{field:'lj',label:'耐久',kind:'num'},
  ]},
];

function valueAfter(a,flag){const i=a.indexOf(flag);return i>=0?a[i+1]:undefined;}
function toNum(v){if(v===''||v==null)return null;const n=Number(v);return Number.isFinite(n)?n:null;}

function main(){
  const argv=process.argv.slice(2);
  const dry=argv.includes('--dry-run');
  const src=valueAfter(argv,'--src')||defaultSrc;
  if(!fs.existsSync(src))throw new Error(`找不到 Excel: ${src}`);
  const baseline=JSON.parse(fs.readFileSync(baselinePath,'utf8'));
  const entities=baseline.configs?.entities??{};
  const wb=XLSX.readFile(src);
  const patch={schema_version:1,description:'策划数值修正层(import-numbers-xlsx 生成; 只叠加不改源证据baseline)',generated_at:new Date().toISOString(),entity_value_patches:{}};
  let changes=[];
  for(const d of DOMAINS){
    if(!wb.Sheets[d.sheet])continue;
    const byId=new Map((entities[d.key]??[]).map((e)=>[e.canonical_id,e]));
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[d.sheet],{defval:''});
    const collection=(patch.entity_value_patches[d.patchCollection]??={});
    for(const row of rows){
      const id=row.ID;if(!id)continue;
      const e=byId.get(id);if(!e)continue;
      const base=e.normalized_data??{};
      const delta={};
      for(const def of d.defs){
        const cell=row[def.label];
        const patchField=def.patchField??def.field;
        if(def.kind==='num'){
          const nv=toNum(cell);
          if(nv!=null&&Number(base[def.field])!==nv)delta[patchField]=nv;
        }else if(typeof base[def.field]==='string'&&String(cell??'')&&base[def.field]!==String(cell)){
          delta[patchField]=String(cell);
        }
      }
      if(Object.keys(delta).length){collection[id]=delta;changes.push(`${d.sheet}:${id} → ${JSON.stringify(delta).slice(0,80)}`);}
    }
  }
  if(!Object.keys(patch.entity_value_patches).length){console.log('[无差异] Excel 与基线一致，无 patch 生成。');return;}
  if(dry){console.log(`[dry-run] 将生成 ${changes.length} 处 patch:`);for(const c of changes.slice(0,40))console.log('  ',c);return;}
  fs.writeFileSync(patchPath,JSON.stringify(patch,null,2)+'\n');
  console.log(`已生成修正层 ${patchPath}（${changes.length} 处）`);
  for(const c of changes.slice(0,20))console.log('  ',c);
  console.log(`\n下一步：node scripts/export-task1-content.js 导出游戏内容（自动合并 patch）`);
}
main();
