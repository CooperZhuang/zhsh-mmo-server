'use strict';
/**
 * 纵横四海 · 策划数值 Excel 导出
 *
 * 把内容里的数值实体（怪物/掉落/商店/物价/装备）从重建基线抽出，
 * 写成一份「策划友好」的 .xlsx：每数值域一张表，中文表头，normalized_data 字段平铺为列，
 * 行以 canonical_id 为键（「ID」列为内部键，供回灌定位；策划不用改它）。
 * 策划在这个 Excel 里改数值（如怪物等级/类型、掉落概率、商店价格、物价区间、装备属性），
 * 再由 scripts/import-numbers-xlsx.js 回灌进基线 → 重跑管道 → 游戏生效。
 *
 * 用法：node scripts/export-numbers-xlsx.js [--out design/numbers/gameplay-numbers.xlsx]
 * 依赖：npm i -D xlsx（已在 package.json devDependencies）。
 */
const fs=require('node:fs');
const path=require('node:path');
const XLSX=require('xlsx');
const root=path.resolve(__dirname,'..');

const baselinePath=path.join(root,'docs','reconstruction-baseline','multisource-baseline.json');
const defaultOut=path.join(root,'design','numbers','gameplay-numbers.xlsx');

// 数值域 → 表名 + 中文列(defs: {field: 内部键, label: 中文表头, kind: 'num'|'str'})
const DOMAINS=[
  {key:'monsters',sheet:'怪物',defs:[
    {field:'name',label:'名称'},
    {field:'level',label:'等级',kind:'num'},
    {field:'type',label:'类型',kind:'num'},
    {field:'city',label:'城市'},
    {field:'location',label:'地点'},
  ]},
  {key:'drops',sheet:'掉落',defs:[
    {field:'monster',label:'怪物'},
    {field:'dropped_name',label:'掉落物'},
    {field:'dropped_entity_type',label:'类型'},
    {field:'probability',label:'概率',kind:'num'},
    {field:'quantity',label:'数量',kind:'num'},
  ]},
  {key:'shops',sheet:'商店',defs:[
    {field:'region',label:'区域'},
    {field:'item_name',label:'商品名'},
    {field:'price',label:'价格',kind:'num'},
    {field:'item_details',label:'详情'},
  ]},
  {key:'city_price_ranges',sheet:'物价',defs:[
    {field:'city',label:'城市'},
    {field:'item_name',label:'物品'},
    {field:'minimum_price',label:'最低价',kind:'num'},
    {field:'maximum_price',label:'最高价',kind:'num'},
    {field:'currency',label:'货币'},
  ]},
  {key:'equipment',sheet:'装备',defs:[
    {field:'catalog_key',label:'目录键'},
    {field:'name',label:'名称'},
    {field:'level',label:'等级',kind:'num'},
    {field:'attack',label:'攻击',kind:'num'},
    {field:'maxAttack',label:'最大攻击',kind:'num'},
    {field:'lj',label:'耐久',kind:'num'},
    {field:'tx',label:'特性'},
    {field:'type',label:'类型',kind:'num'},
  ]},
];

function valueAfter(a,flag){const i=a.indexOf(flag);return i>=0?a[i+1]:undefined;}

function cellValue(src,d){
  const v=src[d.field];
  if(v==null)return '';
  if(typeof v==='object')return JSON.stringify(v);
  return v;
}

function main(){
  const argv=process.argv.slice(2);
  const out=valueAfter(argv,'--out')||defaultOut;
  const baseline=JSON.parse(fs.readFileSync(baselinePath,'utf8'));
  const entities=baseline.configs?.entities??{};
  const wb=XLSX.utils.book_new();
  for(const d of DOMAINS){
    const arr=entities[d.key]??[];
    const rows=arr.map((e)=>Object.fromEntries([['ID',e.canonical_id],...d.defs.map((x)=>[x.label,cellValue(e.normalized_data??{},x)])]));
    const ws=XLSX.utils.json_to_sheet(rows.length?rows:[{ID:'（无）'}]);
    ws['!cols']=[{wch:44},...d.defs.map(()=>({wch:20}))];
    XLSX.utils.book_append_sheet(wb,ws,d.sheet);
  }
  fs.mkdirSync(path.dirname(out),{recursive:true});
  XLSX.writeFile(wb,out);
  console.log(`已导出数值 Excel: ${out}`);
  console.log(`表: ${DOMAINS.map((x)=>`${x.sheet}(${entities[x.key]?.length??0}行)`).join(' / ')}`);
}
main();
