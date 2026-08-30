'use strict';

const childProcess=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {generationMetadata}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const outputPath=path.join(root,'data','generated','global-module-simulation-results.json');
const cases=[
  ['baseline_all_modules_disabled',{training_session_continuation:false,task_described_item_sources:false,projected_task_entry_combat_state:false}],
  ['training_session_continuation',{training_session_continuation:true,task_described_item_sources:false,projected_task_entry_combat_state:false}],
  ['task_described_item_sources',{training_session_continuation:false,task_described_item_sources:true,projected_task_entry_combat_state:false}],
  ['projected_task_entry_combat_state',{training_session_continuation:false,task_described_item_sources:false,projected_task_entry_combat_state:true}],
  ['combined',{training_session_continuation:true,task_described_item_sources:true,projected_task_entry_combat_state:true}],
];

async function main(){
  const caseName=argumentValue('--case');
  if(caseName)return runWorker(caseName,argumentValue('--output'));
  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-global-module-sim-'));
  try{
    const caseResults=await Promise.all(cases.map(async([name])=>{
      const caseOutput=path.join(temporaryRoot,`${name}.json`);await runCaseProcess(name,caseOutput);
      return [name,JSON.parse(fs.readFileSync(caseOutput,'utf8'))];
    }));
    const results=Object.fromEntries(caseResults);
    const accepted=readJson(path.join(root,'data','runtime','accepted-stage-start-78.json'));
    if(results.baseline_all_modules_disabled.selected_task_count<accepted.selected_task_count)
      throw new Error(`All-disabled simulation regressed below accepted baseline: ${results.baseline_all_modules_disabled.selected_task_count}/${accepted.selected_task_count}`);
    const current=readJson(path.join(root,'data','generated','runnable-task-selection.json'));
    if(results.combined.selected_task_count!==current.selected_task_count)
      throw new Error(`Combined simulation count differs from current selector: ${results.combined.selected_task_count}/${current.selected_task_count}`);
    const output={schema_version:1,record_kind:'global-module-simulation-results',...generationMetadata('global-module-simulator/1.0.0'),
      accepted_baseline_head:accepted.stage_start_head,total_catalog_task_count:651,simulation_order:cases.map(([name])=>name),cases:results};
    writeJson(outputPath,output);
    process.stdout.write(`${JSON.stringify({output:path.relative(root,outputPath).replaceAll('\\','/'),cases:Object.fromEntries(Object.entries(results).map(([name,value])=>[name,{selected_task_count:value.selected_task_count,remaining_task_count:value.remaining_task_count,duration_ms:value.duration_ms}]))},null,2)}\n`);
  }finally{fs.rmSync(temporaryRoot,{recursive:true,force:true});}
}

function runCaseProcess(name,caseOutput){
  return new Promise((resolve,reject)=>{
    const child=childProcess.spawn(process.execPath,[__filename,'--case',name,'--output',caseOutput],{cwd:root,stdio:['ignore','ignore','pipe']});
    const stderr=[];child.stderr.on('data',(bytes)=>stderr.push(bytes.toString('utf8')));
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(`Module simulation ${name} exceeded 240 seconds`));},4*60*1000);
    child.once('error',(error)=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`Module simulation ${name} failed (status=${code}, signal=${signal}):\n${stderr.join('')}`));});
  });
}

function runWorker(caseName,caseOutput){
  const definition=cases.find(([name])=>name===caseName);if(!definition)throw new Error(`Unknown simulation case: ${caseName}`);
  if(!caseOutput)throw new Error('Worker output path is required');
  const {selectRunnableTasks}=require('./select-runnable-tasks');
  const caseRoot=fs.mkdtempSync(path.join(os.tmpdir(),`zhsh-global-module-${caseName}-`));
  try{
    const started=Date.now();const moduleFlags=definition[1];
    const selection=selectRunnableTasks({moduleFlags,outputPath:path.join(caseRoot,'selection.json'),
      equipmentAnalysisPath:path.join(caseRoot,'equipment.json'),combatSurvivalAnalysisPath:path.join(caseRoot,'combat.json')});
    writeJson(caseOutput,{module_flags:moduleFlags,duration_ms:Date.now()-started,selected_task_count:selection.selected_task_count,
      selected_series_count:selection.selected_series_count,remaining_task_count:651-selection.selected_task_count,
      selection_hash:selection.selection_hash,selected_series:selection.selected_series,root_blockers:summarizeRoots(selection.unselected_tasks)});
  }finally{fs.rmSync(caseRoot,{recursive:true,force:true});}
}
function summarizeRoots(unselected){
  return unselected.filter((entry)=>!entry.blocking_reasons.some((reason)=>reason.code==='series_prefix_blocked')).map((entry)=>({
    series_canonical_id:entry.series_canonical_id,task_canonical_id:entry.canonical_id,sequence_position:Number(entry.sequence_position),
    reason_codes:entry.blocking_reasons.map((reason)=>reason.code),blocked_task_count:unselected.filter((candidate)=>candidate.series_canonical_id===entry.series_canonical_id&&Number(candidate.sequence_position)>=Number(entry.sequence_position)).length,
  })).sort((a,b)=>a.series_canonical_id.localeCompare(b.series_canonical_id));
}
function argumentValue(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`,'utf8');}
if(require.main===module)main().catch((error)=>{console.error(error);process.exitCode=1;});
module.exports={summarizeRoots};
