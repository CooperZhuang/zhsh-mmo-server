'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {generationMetadata,root}=require('./generation-metadata');

const outputPath=path.join(root,'data','generated','combat-survival-stage-summary.json');
const rawRoot=path.join(root,'artifacts','combat-survival-stage','raw');
const catalogPaths=[
  'data/generated/global-content-catalog.json',
  'data/generated/reference-rule-catalog.json',
  'data/generated/source-conflict-register.json',
  'data/generated/original-incomplete-feature-register.json',
  'data/generated/current-runtime-gap-matrix.json',
  'data/generated/feature-reachability-matrix.json',
  'data/generated/task-unlock-impact-map.json',
];

function main(){
  const selection=read('data/generated/runnable-task-selection.json');
  const analysis=read('data/generated/combat-survival-analysis.json');
  const incremental=readOptional('artifacts/combat-survival-stage/raw/combat-survival-incremental-dom-results.json');
  const fullDom=readOptional('artifacts/combat-survival-stage/raw/browser-dom-e2e-results.json');
  const verifyCommand=readOptional('artifacts/combat-survival-stage/raw/verify-core-command.json');
  const verifyResults=readOptional('artifacts/combat-survival-stage/raw/verify-core-results.json');
  const testCommand=readOptional('artifacts/combat-survival-stage/raw/all-tests-command.json');
  const chosen=analysis.candidates.find((entry)=>entry.task_canonical_id===analysis.chosen_allocation?.task_canonical_id);
  const newIds=analysis.chosen_allocation?.newly_selected_task_ids??[];
  const passed=selection.selected_task_count===78&&selection.selected_series_count===13&&newIds.length===6&&
    fullDom?.scenarios?.length===2&&fullDom.scenarios.every(acceptedDomScenario);
  const output={
    schema_version:1,
    record_kind:'combat-survival-stage-summary',
    ...generationMetadata('combat-survival-stage-summary/1.0.0'),
    conclusion:{
      acceptance_status:passed?'PASSED':'NOT_PASSED',
      stage_start_selected_task_count:72,
      final_selected_task_count:selection.selected_task_count,
      stage_start_selected_series_count:13,
      final_selected_series_count:selection.selected_series_count,
      natural_new_task_canonical_ids:newIds,
      selected_series_11_terminal_task_canonical_id:selection.selected_series.find((entry)=>entry.canonical_id==='task.series.11')?.terminal_task_canonical_id??null,
      remaining_task_count:selection.unselected_tasks.length,
    },
    source_stamina_item:analysis.stamina_source,
    allocation:{
      planner_rule_id:analysis.planner_rule_id,
      accepted_state:analysis.accepted_state,
      chosen_allocation:analysis.chosen_allocation,
      money_ledger:analysis.money_ledger,
      chosen_candidate:chosen?candidateSummary(chosen):null,
      residual_candidates:analysis.candidates.filter((entry)=>entry!==chosen).map(candidateSummary),
      unresolved_modules:analysis.unresolved_modules,
    },
    series_endpoints:selection.selected_series.map((entry)=>({
      series_canonical_id:entry.canonical_id,
      selected_task_count:entry.selected_task_count,
      terminal_task_canonical_id:entry.terminal_task_canonical_id,
      selection_kind:entry.selection_kind,
    })),
    validation:{
      all_tests:testCommand?commandSummary(testCommand):null,
      verify_core:verifyCommand?{...commandSummary(verifyCommand),internal_command_count:verifyResults?.commands?.length??null,
        formal_core_playable:verifyResults?.summary?.formal_core_playable??null}:null,
      incremental_dom:incremental?.scenarios?.map(domSummary)??[],
      full_dom:fullDom?.scenarios?.map(domSummary)??[],
    },
    machine_catalogs:catalogPaths.map(catalogSummary),
  };
  fs.writeFileSync(outputPath,`${JSON.stringify(output,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify({output:path.relative(root,outputPath).replaceAll('\\','/'),acceptance_status:output.conclusion.acceptance_status,
    selected_tasks:selection.selected_task_count,new_tasks:newIds,full_dom_scenarios:output.validation.full_dom.length},null,2)}\n`);
  return output;
}

function candidateSummary(entry){return {
  task_canonical_id:entry.task_canonical_id,
  series_canonical_id:entry.series_canonical_id,
  source_closed:entry.source_closed,
  closes_all_requirements:entry.closes_all_requirements,
  simulated_unlock_delta:entry.simulated_unlock_delta,
  newly_selected_task_ids:entry.newly_selected_task_ids,
  terminal_task_canonical_id:entry.terminal_task_canonical_id,
  next_blocker:entry.next_blocker,
  proofs:(entry.proofs??[]).map((proof)=>({target_canonical_id:proof.target_canonical_id,origin:proof.origin,
    monster_canonical_id:proof.monster_canonical_id,acquisition_closed:proof.acquisition_closed,base_closed:proof.base_closed,
    stamina_closed:proof.proof?.closed??null,sample_count:proof.proof?.sample_count??null,wins:proof.proof?.wins??null,
    win_probability:proof.proof?.win_probability??null,average_stamina_uses:proof.proof?.average_stamina_uses??null})),
};}
function acceptedDomScenario(entry){return entry.completed_task_count===78&&entry.formal_task_count===78&&entry.formal_series_count===13&&
  entry.viewport?.width===390&&entry.viewport?.height===844&&entry.console?.errors===0&&entry.console?.warnings===0&&
  (entry.network_errors?.length??0)===0&&entry.direct_browser_storage_writes===false&&
  (entry.measurements?.length??0)>0&&entry.measurements.every((item)=>!item.horizontal_overflow&&
    (item.obscured_buttons?.length??0)===0&&(item.clipped_or_truncated_text?.length??0)===0)&&
  (entry.scenario!=='legacy-1-of-13'||entry.legacy_checkpoint_task_count===25);
}
function domSummary(entry){return {
  scenario:entry.scenario,browser_version:entry.browser_version,duration_ms:entry.duration_ms,viewport:entry.viewport,
  completed_task_count:entry.completed_task_count,formal_task_count:entry.formal_task_count,formal_series_count:entry.formal_series_count,
  series_entered_count:entry.series_entered_count,legacy_checkpoint_task_count:entry.legacy_checkpoint_task_count,
  page_refreshes:entry.page_refreshes,context_reopens:entry.context_reopens,ui_click_count:entry.ui_click_count,
  direct_browser_storage_writes:entry.direct_browser_storage_writes,console_errors:entry.console?.errors??null,
  console_warnings:entry.console?.warnings??null,network_error_count:entry.network_errors?.length??null,
  stamina_feedback:entry.stamina_feedback??[],formal_equipment_acquisition:entry.formal_equipment_acquisition??[],
  measurement_count:entry.measurements?.length??0,horizontal_overflow_count:(entry.measurements??[]).filter((item)=>item.horizontal_overflow).length,
  obscured_button_count:(entry.measurements??[]).reduce((sum,item)=>sum+(item.obscured_buttons?.length??0),0),
  clipped_or_truncated_text_count:(entry.measurements??[]).reduce((sum,item)=>sum+(item.clipped_or_truncated_text?.length??0),0),
};}
function commandSummary(entry){return {artifact:entry.artifact??entry.output??null,label:entry.label,git_head:entry.git_head,node_version:entry.node_version,
  command:entry.command,started_at:entry.started_at,ended_at:entry.ended_at,duration_ms:entry.duration_ms,exit_code:entry.exit_code,
  test_count:entry.test_count,stdout_sha256:entry.stdout_sha256,stderr_sha256:entry.stderr_sha256};}
function catalogSummary(relative){const bytes=fs.readFileSync(path.join(root,...relative.split('/'))),value=JSON.parse(bytes);
  return {path:relative,record_kind:value.record_kind??null,schema_version:value.schema_version??null,source_head:value.source_head??null,
    generated_from_head:value.generated_from_head??null,sha256:sha256(bytes),random_rule_omissions:countRandomRuleOmissions(value)};}
function countRandomRuleOmissions(value){let count=0;walk(value);return count;function walk(node){if(Array.isArray(node)){for(const item of node)walk(item);return;}
  if(!node||typeof node!=='object')return;if(Object.hasOwn(node,'evidence_locator')&&!Object.hasOwn(node,'random_rules'))count+=1;for(const child of Object.values(node))walk(child);}}
function read(relative){return JSON.parse(fs.readFileSync(path.join(root,...relative.split('/')),'utf8'));}
function readOptional(relative){const absolute=path.join(root,...relative.split('/'));return fs.existsSync(absolute)?JSON.parse(fs.readFileSync(absolute,'utf8')):null;}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
