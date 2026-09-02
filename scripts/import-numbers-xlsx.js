'use strict';
/**
 * 纵横四海 · 策划数值 Excel 回灌
 *
 * 读取策划改好的 gameplay-numbers.xlsx（中文表头），把各数值域 normalize_data 的
 * 数值回写进内容基线，改完后重跑管道（import-content → export-task1-content）游戏即生效。
 *
 * 用法：
 *   node scripts/import-numbers-xlsx.js [--src design/numbers/gameplay-numbers.xlsx] [--dry-run]
 * 说明：默认原地更新基线（git 可追踪 diff）；--dry-run 只打印将改哪几处，不落盘。
 *       仅部分列会回写：kind:'num' 数字列 + 原本就是字符串的列；对象列(如详情)不覆盖。
 */
const fs=require('node:fs');
const path=require('node:path');
const XLSX=require('xlsx');
const root=path.resolve(__dirname,'..');
const baselinePath=path.join(root,'docs','reconstruction-baseline','multisource-baseline.json');
const defaultSrc=path.join(root,'design','numbers','gameplay-numbers.xlsx');

// 与 export-numbers-xlsx.js 保持一致：field=内部键，label=中文表头，kind=列类型
const DOMAINS=[
  {key:'monsters',sheet:'怪物',defs:[
    {field:'name',label:'名称'},{field:'level',label:'等级',kind:'num'},{field:'type',label:'类型',kind:'num'},{field:'city',label:'城市'},{field:'location',label:'地点'},
  ]},
  {key:'drops',sheet:'掉落',defs:[
    {field:'monster',label:'怪物'},{field:'dropped_name',label:'掉落物'},{field:'dropped_entity_type',label:'类型'},{field:'probability',label:'概率',kind:'num'},{field:'quantity',label:'数量',kind:'num'},
  ]},
  {key:'shops',sheet:'商店',defs:[
    {field:'region',label:'区域'},{field:'item_name',label:'商品名'},{field:'price',label:'价格',kind:'num'},{field:'item_details',label:'详情'},
  ]},
  {key:'city_price_ranges',sheet:'物价',defs:[
    {field:'city',label:'城市'},{field:'item_name',label:'物品'},{field:'minimum_price',label:'最低价',kind:'num'},{field:'maximum_price',label:'最高价',kind:'num'},{field:'currency',label:'货币'},
  ]},
  {key:'equipment',sheet:'装备',defs:[
    {field:'catalog_key',label:'目录键'},{field:'name',label:'名称'},{field:'level',label:'等级',kind:'num'},
    {field:'attack',label:'攻击',kind:'num'},{field:'maxAttack',label:'最大攻击',kind:'num'},{field:'lj',label:'耐久',kind:'num'},
    {field:'tx',label:'特性'},{field:'type',label:'类型',kind:'num'},
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
  let changed=0,changes=[];
  for(const d of DOMAINS){
    if(!wb.Sheets[d.sheet])continue;
    const byId=new Map((entities[d.key]??[]).map((e)=>[e.canonical_id,e]));
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[d.sheet],{defval:''});
    for(const row of rows){
      const id=row.ID;if(!id)continue;
      const e=byId.get(id);if(!e)continue;
      const nd={...(e.normalized_data??{})};
      let changedHere=false;
      for(const def of d.defs){
        const cell=row[def.label];
        if(def.kind==='num'){const nv=toNum(cell);if(nv!=null&&Number(nd[def.field])!==nv){nd[def.field]=nv;changedHere=true;}}
        else if(typeof nd[def.field]==='string'&&String(cell??'')&&nd[def.field]!==cell){nd[def.field]=String(cell);changedHere=true;}
      }
      if(changedHere){e.normalized_data=nd;changed++;changes.push(`${d.sheet}:${id} → ${d.defs.filter((x)=>x.kind==='num').map((x)=>x.label+'='+nd[x.field]).join(',')}`);}
    }
  }
  if(dry){console.log(`[dry-run] 将更新 ${changed} 处数值：`);for(const c of changes.slice(0,40))console.log('  ',c);return;}
  fs.writeFileSync(baselinePath,JSON.stringify(baseline,null,2)+'\n');
  console.log(`已回灌 ${changed} 处数值到基线。`);
  for(const c of changes.slice(0,20))console.log('  ',c);
  console.log(`\n下一步：node scripts/import-content.js 重建内容库 → node scripts/export-task1-content.js 导出游戏内容`);
}
main();
