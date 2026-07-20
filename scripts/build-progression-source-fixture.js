'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const defaultReferenceRoot=path.resolve(root,'..','zhsh-references');
const defaultOutput=path.join(root,'tests','fixtures','progression-source-evidence.json');
const extraction=JSON.parse(fs.readFileSync(path.join(root,'data','generated','progression-source-extraction.json'),'utf8'));

const specifications=[
  {canonical_id:'progression.zhsh.level-thresholds',repository:'zhsh',relative_path:'config/exp.json',kind:'json_pointer',json_pointer:'/',random_rules:[]},
  {canonical_id:'progression.zhsh.level-up-growth',repository:'zhsh',relative_path:'src/play.js',kind:'line_range',line_start:579,line_end:586,random_rules:[]},
  {canonical_id:'progression.zhsh.copper-floor',repository:'zhsh',relative_path:'src/play.js',kind:'line_range',line_start:537,line_end:542,random_rules:[]},
  {canonical_id:'progression.zhsh.monster-base-reward',repository:'zhsh',relative_path:'src/monster.js',kind:'line_range',line_start:114,line_end:121,random_rules:[]},
  {canonical_id:'progression.zhsh.monster-settlement-and-drop',repository:'zhsh',relative_path:'src/monster.js',kind:'line_range',line_start:308,line_end:338,
    random_rules:['equipment candidate: 0.2','each ordinary item: 0.4']},
  {canonical_id:'progression.zhsh.encounter-cache',repository:'zhsh',relative_path:'src/city.js',kind:'line_range',line_start:277,line_end:304,
    random_rules:['monster types: 1..3','monster instances: 3..5','cache duration: five minutes']},
  {canonical_id:'progression.zhsh.free-recovery',repository:'zhsh',relative_path:'src/user.js',kind:'line_range',line_start:990,line_end:1003,random_rules:[]},
  {canonical_id:'progression.astrbot.pirate-fallback-exp',repository:'astrbot',relative_path:'server/src/routes/battle.js',kind:'line_range',line_start:40,line_end:49,random_rules:[]},
  {canonical_id:'progression.astrbot.monster-exp-field',repository:'astrbot',relative_path:'server/src/routes/battle.js',kind:'line_range',line_start:119,line_end:124,random_rules:[]},
  {canonical_id:'progression.astrbot.exp-settlement',repository:'astrbot',relative_path:'server/src/routes/battle.js',kind:'line_range',line_start:325,line_end:330,random_rules:[]},
  {canonical_id:'progression.dpcq.level-table',repository:'dpcq',relative_path:'dpcq.sql',kind:'line_range',line_start:289,line_end:322,random_rules:[]},
];

function buildFixture({referenceRoot=defaultReferenceRoot,outputPath=defaultOutput}={}){
  const records=specifications.map((specification)=>buildRecord(specification,referenceRoot));
  const fixture={
    schema_version:1,
    record_kind:'immutable-progression-source-evidence',
    normalization:'line-range snippets use LF line endings and exclude the trailing line terminator; file_sha256 covers original bytes',
    reference_commits:extraction.reference_commits,
    source_extraction:'data/generated/progression-source-extraction.json',
    records,
  };
  const serialized=`${JSON.stringify(fixture,null,2)}\n`;
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(outputPath,serialized,'utf8');
  return fixture;
}

function buildRecord(specification,referenceRoot){
  const repositoryDirectory=specification.repository==='astrbot'?'zhsh-game_astrbot':specification.repository;
  const sourcePath=path.join(referenceRoot,repositoryDirectory,...specification.relative_path.split('/'));
  const bytes=fs.readFileSync(sourcePath);
  const common={
    canonical_id:specification.canonical_id,
    repository:specification.repository,
    relative_path:specification.relative_path,
    commit:extraction.reference_commits[specification.repository],
    file_sha256:sha256(bytes),
    evidence_kind:specification.kind,
    random_rules:specification.random_rules,
  };
  if(specification.kind==='json_pointer'){
    const value=JSON.parse(bytes.toString('utf8'));
    return {...common,json_pointer:specification.json_pointer,value,value_sha256:sha256(stableJson(value))};
  }
  const lines=bytes.toString('utf8').replaceAll('\r\n','\n').split('\n');
  const snippet=lines.slice(specification.line_start-1,specification.line_end).join('\n');
  return {...common,line_start:specification.line_start,line_end:specification.line_end,snippet,snippet_sha256:sha256(snippet)};
}

function stableJson(value){
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

if(require.main===module){
  const referenceIndex=process.argv.indexOf('--reference-root');
  const outputIndex=process.argv.indexOf('--output');
  const fixture=buildFixture({
    referenceRoot:referenceIndex>=0?path.resolve(process.argv[referenceIndex+1]):defaultReferenceRoot,
    outputPath:outputIndex>=0?path.resolve(process.argv[outputIndex+1]):defaultOutput,
  });
  process.stdout.write(`${JSON.stringify({output:path.relative(root,outputIndex>=0?path.resolve(process.argv[outputIndex+1]):defaultOutput).replaceAll('\\','/'),records:fixture.records.length},null,2)}\n`);
}

module.exports={buildFixture,stableJson};
