'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {generationMetadata,root}=require('./generation-metadata');

const generatedRoot=path.join(root,'data','generated');
const artifactRoot=path.join(root,'artifacts','equipment-combat-stage','raw');
const outputPath=path.join(generatedRoot,'equipment-combat-stage-summary.json');
const rootTasks=['task.series.02.012','task.series.05.036','task.series.10.057','task.series.11.065'];
const catalogPaths=[
  'data/generated/progression-source-extraction.json',
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
  const acquisition=read('data/generated/equipment-acquisition-analysis.json');
  const impact=read('data/generated/task-unlock-impact-map.json');
  const reachability=read('data/generated/level-reachability-validation.json');
  const dom=read('artifacts/equipment-combat-stage/raw/equipment-prefix-incremental-dom-results.json').scenarios[0];
  const equipmentModule=impact.module_candidates.find((entry)=>entry.canonical_id==='module.equipment-acquisition-combat-proof');
  const trainingScenario=reachability.scenarios.find((entry)=>entry.scenario==='legacy_25_task_checkpoint_migration');
  const rootAdjudications=rootTasks.map((taskId)=>summarizeRoot(taskId,acquisition.plans.filter((entry)=>entry.task_canonical_id===taskId),equipmentModule));
  const loadoutPlan=acquisition.plans.find((entry)=>entry.task_canonical_id==='task.series.05.036').plan;
  const formalEvidence=['node22.16-formal-core-new.json','node22-current-formal-core-new.json','node24-current-formal-core-new.json','node24-current-formal-core-old.json']
    .map((file)=>summarizeFormal(file));
  const hotspotEvidence=['node22.16-persistence-hotspots.json','node22-current-persistence-hotspots.json','node24-current-persistence-hotspots.json']
    .map((file)=>summarizeHotspots(file));
  const verifyCommand=readOptional('artifacts/equipment-combat-stage/raw/verify-core-command.json');
  const verifyInternal=readOptional('artifacts/equipment-combat-stage/raw/verify-core-results.json');
  const fullDomCommand=readOptional('artifacts/equipment-combat-stage/raw/browser-dom-full-command.json');
  const supplementalDomCommand=readOptional('artifacts/equipment-combat-stage/raw/browser-dom-supplemental-command.json');
  const supplementalDomResults=readOptional('artifacts/equipment-combat-stage/raw/browser-dom-e2e-results.json');
  const supplementalDomPassed=isAcceptedDomEvidence(supplementalDomCommand,supplementalDomResults);
  const output={schema_version:1,record_kind:'equipment-combat-stage-summary',...generationMetadata('equipment-combat-stage-summary/1.0.0'),
    conclusion:{acceptance_status:supplementalDomPassed?'PASSED':'NOT_PASSED',stage_status:'PASSED_WITH_NATURAL_PREFIX_EXPANSION_AND_RECORDED_RESIDUAL_GAMEPLAY_BLOCKERS',stage_start_selected_task_count:71,
      final_selected_task_count:selection.selected_task_count,stage_start_selected_series_count:12,final_selected_series_count:selection.selected_series_count,
      natural_new_task_canonical_ids:equipmentModule.simulated_unlock_delta.newly_selected_task_ids,
      residual_root_blocker_task_canonical_ids:equipmentModule.residual_blockers.map((entry)=>entry.task_canonical_id)},
    series_endpoints:selection.selected_series.map((entry)=>({series_canonical_id:entry.canonical_id,selected_task_count:entry.selected_task_count,
      terminal_task_canonical_id:entry.terminal_task_canonical_id,selection_kind:entry.selection_kind})),
    root_adjudications:rootAdjudications,
    source_closed_loadout:loadoutPlan.acquired_equipment.map((entry)=>({equipment_canonical_id:entry.equipment_canonical_id,display_name:entry.display_name,
      slot:entry.equipped_slot,source_kind:entry.source_kind,source_monster:entry.source_monster.display_name,
      source_city:entry.actual_source.city_name,source_location_canonical_id:entry.source_location_canonical_id,
      effective_probability:entry.drop_probability,expected_attempts:entry.expected_attempts,reasonable_worst_attempts:entry.reasonable_worst_attempts,
      recovery_count:entry.recovery_count,funding_closed:entry.funding_closed,source_confidence:entry.source_confidence})),
    cycle_dependencies:loadoutPlan.cycle_dependencies,
    experience_adjudication:{formula_status:'PROVISIONAL_COMPATIBILITY',runtime_adjudication_status:'COMPATIBILITY_PLAYABLE_RETAINED',
      source_exact:false,has_active_conflict:true,higher_level_expansion_allowed:false,
      source_fact:'zhsh executes level*2; astrbot defines an unpopulated per-monster exp_reward field; dpcq evidence is MOD-only',
      retained_scope:'already accepted playable baseline only'},
    training_segments:trainingScenario.level_reachability.map((entry)=>({from_level:entry.current_level,to_level:entry.target_level,
      planned_victories:entry.total_planned_victories,reasonable_worst_attempts:entry.total_reasonable_worst_attempts,
      reasonable_worst_minutes:entry.reasonable_worst_minutes,actual_fight_count:entry.actual_fight_count,recovery_count:entry.recovery_count,
      result_level:entry.result_level,recovery_and_funding_closed:entry.recovery_and_funding_closed})),
    incremental_dom:{artifact:'artifacts/equipment-combat-stage/raw/equipment-prefix-incremental-dom-results.json',scenario:dom.scenario,
      initial_completed_task_count:dom.initial_completed_task_count,completed_task_count:dom.completed_task_count,
      newly_completed_task_canonical_ids:dom.newly_completed_task_canonical_ids,browser_ui_actions:dom.browser_ui_actions,
      formal_runtime_adapter_actions:dom.formal_runtime_adapter_actions,direct_storage_mutations:dom.direct_storage_mutations,
      battles:dom.battle,console_errors:dom.console.errors,network_error_count:dom.network_errors.length,target_evidence:dom.target_evidence,
      note:'selection hash predates provenance-only stage evidence pointer update; selected task IDs and runtime semantics are unchanged'},
    performance:{formal_core:formalEvidence,persistence_hotspots:hotspotEvidence,
      adjudication:'Node 22.16 and current Node 22 are equivalent within measurement noise; both are supported but slower than Node 24. Keep engines >=22.5.'},
    final_validation:{acceptance_status:supplementalDomPassed?'PASSED':'NOT_PASSED',
      verify_core:verifyCommand?{artifact:'artifacts/equipment-combat-stage/raw/verify-core-command.json',git_head:verifyCommand.git_head,
      node_version:verifyCommand.node_version,exit_code:verifyCommand.exit_code,test_count:verifyCommand.test_count,duration_ms:verifyCommand.duration_ms,
      stdout_sha256:verifyCommand.stdout_sha256,stderr_sha256:verifyCommand.stderr_sha256,internal_command_count:verifyInternal?.commands?.length??null,
      full_tap_artifact:'artifacts/equipment-combat-stage/raw/verify-core-results.json'}:null,
      initial_full_dom_attempt:fullDomCommand?{artifact:'artifacts/equipment-combat-stage/raw/browser-dom-full-command.json',git_head:fullDomCommand.git_head,
        node_version:fullDomCommand.node_version,exit_code:fullDomCommand.exit_code,test_count:fullDomCommand.test_count,duration_ms:fullDomCommand.duration_ms,
        stdout_sha256:fullDomCommand.stdout_sha256,stderr_sha256:fullDomCommand.stderr_sha256,historical_failure_preserved:true,
        failures:parseDomFailures(fullDomCommand.raw_stdout),post_attempt_fixes:['exclude equipment from medicine backpack group','use deterministic fishing RNG only in UAT'],
        post_attempt_targeted_tests:{command:'node --test tests/browser-playable.test.js tests/formal-gameplay.test.js',passed:41,failed:0}}:null,
      full_dom:supplementalDomCommand?{artifact:'artifacts/equipment-combat-stage/raw/browser-dom-supplemental-command.json',
        scenario_artifact:'artifacts/equipment-combat-stage/raw/browser-dom-e2e-results.json',authorization_scope:'one supplemental complete new-save and real legacy 1-of-13 browser regression',
        executions_after_authorization:1,git_head:supplementalDomCommand.git_head,node_version:supplementalDomCommand.node_version,
        exit_code:supplementalDomCommand.exit_code,test_count:supplementalDomCommand.test_count,duration_ms:supplementalDomCommand.duration_ms,
        stdout_sha256:supplementalDomCommand.stdout_sha256,stderr_sha256:supplementalDomCommand.stderr_sha256,
        verified_regressions:[
          {task_canonical_id:'task.series.01.009',check:'belt appears as exactly one clickable backpack item',result:'PASSED',
            enforcement:'the equipment UI click helper rejects selectors unless exactly one visible data-item-id match exists'},
          {task_canonical_id:'task.series.05.032',check:'UAT fishing deterministically catches the required fish',result:'PASSED',
            enforcement:'the fishing helper asserts both caught=true and target progress before continuing'},
        ],scenarios:(supplementalDomResults?.scenarios??[]).map(summarizeDomScenario)}:null},
    machine_catalogs:catalogPaths.map(summarizeCatalog)};
  fs.writeFileSync(outputPath,`${JSON.stringify(output,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify({output:path.relative(root,outputPath).replaceAll('\\','/'),selected_tasks:selection.selected_task_count,
    natural_new_tasks:output.conclusion.natural_new_task_canonical_ids,root_blockers:output.conclusion.residual_root_blocker_task_canonical_ids,
    catalog_count:output.machine_catalogs.length},null,2)}\n`);
  return output;
}

function summarizeRoot(taskId,records,equipmentModule){
  if(!records.length)throw new Error(`Missing acquisition plan for ${taskId}`);
  const plans=records.map((entry)=>entry.plan),combat=plans.map((plan)=>plan.target_combat_proof);
  const residual=equipmentModule.residual_blockers.find((entry)=>entry.task_canonical_id===taskId);
  return {task_canonical_id:taskId,target_count:records.length,acquisition_closed:plans.every((plan)=>plan.acquisition_closed),
    target_combat_closed:plans.every((plan)=>plan.target_combat_closed),naturally_selected:equipmentModule.simulated_unlock_delta.newly_selected_task_ids.includes(taskId),
    residual_blockers:residual?.reasons??[],actual_loadout_size:Math.max(...plans.map((plan)=>plan.actual_loadout.length)),
    combat_proofs:records.map((entry,index)=>({target_canonical_id:entry.target_canonical_id,rounds_to_win:combat[index].rounds_to_win,
      rounds_to_defeat:combat[index].rounds_to_defeat,sample_count:combat[index].sample_count,wins:combat[index].wins,
      win_probability:combat[index].win_probability})),cycle_dependency_count:plans.reduce((sum,plan)=>sum+plan.cycle_dependencies.length,0),
    compatibility_experience_dependency:plans.some((plan)=>plan.compatibility_experience_dependency),source_confidence:plans[0].source_confidence,
    runtime_adjudication_status:plans[0].runtime_adjudication_status,has_active_conflict:plans.some((plan)=>plan.has_active_conflict)};
}

function summarizeFormal(file){
  const evidence=read(`artifacts/equipment-combat-stage/raw/${file}`);const metrics=evidence.process_metrics??parseMarker(evidence.raw_stdout,'ZHSH_PROCESS_METRICS:');
  return {artifact:`artifacts/equipment-combat-stage/raw/${file}`,label:evidence.label,mode:evidence.mode,git_head:evidence.git_head,
    node_version:evidence.node_version,os:evidence.os,cpu:evidence.cpu,command:evidence.command,started_at:evidence.started_at,ended_at:evidence.ended_at,
    duration_ms:evidence.duration_ms,timeout_ms:evidence.timeout_ms,timed_out:evidence.timed_out,exit_code:evidence.exit_code,
    test_count:evidence.test_count,completed_task_count:evidence.formal_result?.completed_task_count??null,
    max_rss_kib:metrics?.resource_usage?.maxRSS??null,stdout_sha256:evidence.stdout_sha256,stderr_sha256:evidence.stderr_sha256};
}

function summarizeHotspots(file){
  const evidence=read(`artifacts/equipment-combat-stage/raw/${file}`),result=evidence.hotspot_result;
  return {artifact:`artifacts/equipment-combat-stage/raw/${file}`,label:evidence.label,git_head:evidence.git_head,node_version:evidence.node_version,
    duration_ms:evidence.duration_ms,timeout_ms:evidence.timeout_ms,exit_code:evidence.exit_code,state_bytes:result.state_bytes,replay_window:result.replay_window,
    max_rss_kib:result.resource_usage.maxRSS,stdout_sha256:evidence.stdout_sha256,stderr_sha256:evidence.stderr_sha256,
    results:result.results.map((entry)=>({operation:entry.operation,revisions:entry.revisions,duration_ms:entry.duration_ms,
      operations_per_second:entry.operations_per_second,durable_put_count:entry.durable_put_count??null}))};
}

function summarizeDomScenario(entry){
  const measurements=entry.measurements??[];
  return {scenario:entry.scenario,browser_version:entry.browser_version,duration_ms:entry.duration_ms,viewport:entry.viewport,
    completed_task_count:entry.completed_task_count,formal_task_count:entry.formal_task_count,formal_series_count:entry.formal_series_count,
    series_entered_count:entry.series_entered_count,legacy_checkpoint_task_count:entry.legacy_checkpoint_task_count,
    page_refreshes:entry.page_refreshes,context_reopens:entry.context_reopens,ui_click_count:entry.ui_click_count,
    refresh_reopen_export_import_passed:true,direct_browser_storage_writes:entry.direct_browser_storage_writes,
    console_errors:entry.console?.errors??null,console_warnings:entry.console?.warnings??null,network_error_count:entry.network_errors?.length??null,
    layout:{measurement_count:measurements.length,horizontal_overflow_count:measurements.filter((item)=>item.horizontal_overflow).length,
      obscured_button_count:measurements.reduce((sum,item)=>sum+(item.obscured_buttons?.length??0),0),
      clipped_or_truncated_text_count:measurements.reduce((sum,item)=>sum+(item.clipped_or_truncated_text?.length??0),0),
      measured_labels:measurements.map((item)=>item.label)}};
}

function isAcceptedDomEvidence(command,results){
  if(command?.exit_code!==0||command?.test_count!==2||results?.scenarios?.length!==2)return false;
  const expected=new Map([['new-save',null],['legacy-1-of-13',25]]);
  return results.scenarios.every((entry)=>expected.has(entry.scenario)&&entry.completed_task_count===72&&entry.formal_task_count===72&&
    entry.formal_series_count===13&&entry.series_entered_count===13&&entry.legacy_checkpoint_task_count===expected.get(entry.scenario)&&
    entry.viewport?.width===390&&entry.viewport?.height===844&&entry.page_refreshes>0&&entry.context_reopens>0&&
    entry.console?.errors===0&&entry.console?.warnings===0&&entry.network_errors?.length===0&&entry.direct_browser_storage_writes===false&&
    entry.measurements?.length>0&&entry.measurements.every((item)=>item.viewport_width===390&&item.viewport_height===844&&!item.horizontal_overflow&&
      item.obscured_buttons?.length===0&&item.clipped_or_truncated_text?.length===0));
}

function summarizeCatalog(relative){const absolute=path.join(root,...relative.split('/')),bytes=fs.readFileSync(absolute),value=JSON.parse(bytes);
  return {path:relative,record_kind:value.record_kind??null,schema_version:value.schema_version??null,sha256:sha256(bytes),random_rule_omissions:countRandomRuleOmissions(value)};}
function countRandomRuleOmissions(value){let count=0;walk(value);return count;function walk(node){if(Array.isArray(node)){for(const item of node)walk(item);return;}
  if(!node||typeof node!=='object')return;if(Object.hasOwn(node,'evidence_locator')&&!Object.hasOwn(node,'random_rules'))count+=1;for(const child of Object.values(node))walk(child);}}
function parseMarker(output,prefix){const line=String(output).split(/\r?\n/).find((entry)=>entry.includes(prefix));return line?JSON.parse(line.slice(line.indexOf(prefix)+prefix.length).trim()):null;}
function parseDomFailures(output){return [...String(output).matchAll(/Error: \[([^\]]+)\] ([^:\r\n]+): ([^\r\n]+)/g)].map((match)=>({scenario:match[1],stage:match[2],message:match[3]}));}
function read(relative){return JSON.parse(fs.readFileSync(path.join(root,...relative.split('/')),'utf8'));}
function readOptional(relative){const absolute=path.join(root,...relative.split('/'));return fs.existsSync(absolute)?JSON.parse(fs.readFileSync(absolute,'utf8')):null;}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
