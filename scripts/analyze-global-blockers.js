'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {defaults}=require('./select-runnable-tasks');
const {git}=require('./generation-metadata');
const {generationMetadata,referenceCommits}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const outputPath=path.join(root,'data','generated','global-blocker-analysis.json');
const moduleNames=['training_session_continuation','task_described_item_sources','projected_task_entry_combat_state'];

function main(){
  const accepted=readJson(path.join(root,'data','runtime','accepted-stage-start-78.json'));
  const baseline=JSON.parse(git(['show',`${accepted.stage_start_head}:data/generated/runnable-task-selection.json`]));
  const combined=readJson(path.join(root,'data','generated','runnable-task-selection.json'));
  const simulations=readJson(path.join(root,'data','generated','global-module-simulation-results.json'));
  const cases={baseline:simulations.cases.baseline_all_modules_disabled,
    training_session_continuation:simulations.cases.training_session_continuation,
    task_described_item_sources:simulations.cases.task_described_item_sources,
    projected_task_entry_combat_state:simulations.cases.projected_task_entry_combat_state,
    combined:simulations.cases.combined};
  if(cases.baseline.selected_task_count!==baseline.selected_task_count)throw new Error('Simulated all-disabled baseline differs from accepted selection');
  if(cases.combined.selected_task_count!==combined.selected_task_count)throw new Error('Simulated combined count differs from current selection');
  const db=new DatabaseSync(defaults.databasePath,{readOnly:true});
  let reuseScopes;
  try{reuseScopes=buildReuseScopes(db);}finally{db.close();}
  const moduleCandidates=moduleNames.map((name)=>buildModuleCandidate(name,cases[name],cases.baseline,reuseScopes[name]));
  moduleCandidates.sort((a,b)=>b.priority_score-a.priority_score||b.actual_simulated_unlock_delta-a.actual_simulated_unlock_delta||a.module.localeCompare(b.module));
  const isolatedDeltaSum=moduleCandidates.reduce((sum,entry)=>sum+entry.actual_simulated_unlock_delta,0);
  const referenceSnapshot=readJson(path.join(root,'data','generated','reference-repository-readonly-state.json'));
  const output={
    schema_version:1,
    record_kind:'global-blocker-analysis',
    ...generationMetadata('global-blocker-analysis/1.1.0'),
    accepted_baseline:{head:accepted.stage_start_head,selected_task_count:cases.baseline.selected_task_count,
      formal_series_count:cases.baseline.selected_series_count,remaining_task_count:cases.baseline.remaining_task_count},
    current_result:{selected_task_count:combined.selected_task_count,formal_series_count:combined.selected_series_count,
      remaining_task_count:651-combined.selected_task_count,combined_simulated_unlock_delta:combined.selected_task_count-cases.baseline.selected_task_count,
      isolated_delta_sum:isolatedDeltaSum,combination_synergy_delta:combined.selected_task_count-cases.baseline.selected_task_count-isolatedDeltaSum,
      selection_hash:combined.selection_hash,selected_modules:[...moduleNames]},
    ranking_formula:'actual_simulated_unlock_delta*100 + cross_series_reuse_score*6 + source_evidence_strength_score*5 + downstream_exposure_score*5 - implementation_cost_score*4',
    simulation_evidence:{method:'five isolated deterministic 651-task selector runs recorded by scripts/simulate-global-modules.js',
      artifact:'data/generated/global-module-simulation-results.json',generator_version:simulations.generator_version,
      verified_results:Object.fromEntries(Object.entries(simulations.cases).map(([name,value])=>[name,value.selected_task_count])),
      consistency_checks:['all modules disabled equals the accepted 78-task baseline','combined simulation equals the current selector output','each module delta is derived from an actual isolated selector run']},
    baseline_root_blocker_clusters:cases.baseline.root_blockers,
    current_root_blocker_clusters:buildRootClusters(combined),
    module_candidates:moduleCandidates,
    combined_endpoint_changes:compareSeriesEndpoints(cases.baseline,combined),
    reference_repository_reuse:{
      verification_result:referenceSnapshot.verification_result,
      reference_repositories_modified:referenceSnapshot.reference_repositories_modified,
      reference_commits:referenceCommits(),
      policy:'Reuse the four pinned read-only repository snapshots already harvested into the accepted repository; do not substitute a fresh moving branch for accepted evidence.',
      reused_artifacts:[
        'docs/reconstruction-baseline/multisource-baseline.json',
        'data/generated/global-content-catalog.json',
        'data/generated/reference-rule-catalog.json',
        'data/generated/feature-reachability-matrix.json',
        'data/generated/source-conflict-register.json',
        'data/generated/current-runtime-gap-matrix.json'
      ]
    },
    simulation_cases:Object.fromEntries(Object.entries(cases).map(([name,value])=>[name,caseSummary(value)])),
  };
  writeJson(outputPath,output);
  process.stdout.write(`${JSON.stringify({output:path.relative(root,outputPath).replaceAll('\\','/'),baseline_selected_task_count:cases.baseline.selected_task_count,
    current_selected_task_count:combined.selected_task_count,remaining_task_count:651-combined.selected_task_count,
    combined_delta:output.current_result.combined_simulated_unlock_delta,synergy_delta:output.current_result.combination_synergy_delta,
    modules:moduleCandidates.map((entry)=>({module:entry.module,delta:entry.actual_simulated_unlock_delta,priority_score:entry.priority_score}))},null,2)}\n`);
}
function caseSummary(selection){return {selected_task_count:selection.selected_task_count,remaining_task_count:selection.remaining_task_count??651-selection.selected_task_count,
  selected_series_count:selection.selected_series_count,selection_hash:selection.selection_hash,active_global_modules:selection.module_flags??selection.selection_policy?.active_global_modules??{},
  root_blocker_task_ids:(selection.root_blockers??(selection.unselected_tasks?.length?buildRootClusters(selection):[])).map((entry)=>entry.task_canonical_id??entry.root_task_canonical_id),series_endpoints:seriesEndpoints(selection)};}
function buildRootClusters(selection){
  const roots=selection.unselected_tasks.filter((entry)=>!entry.blocking_reasons.some((reason)=>reason.code==='series_prefix_blocked'));
  return roots.map((rootEntry)=>{
    const tail=selection.unselected_tasks.filter((entry)=>entry.series_canonical_id===rootEntry.series_canonical_id&&Number(entry.sequence_position)>=Number(rootEntry.sequence_position));
    return {series_canonical_id:rootEntry.series_canonical_id,root_task_canonical_id:rootEntry.canonical_id,root_sequence_position:Number(rootEntry.sequence_position),
      root_reason_codes:rootEntry.blocking_reasons.map((reason)=>reason.code),blocked_task_count:tail.length,blocked_descendant_count:Math.max(0,tail.length-1)};
  }).sort((a,b)=>a.series_canonical_id.localeCompare(b.series_canonical_id));
}
function seriesEndpoints(selection){return Object.fromEntries(selection.selected_series.map((entry)=>[entry.canonical_id,{selected_task_count:entry.selected_task_count,
  terminal_task_canonical_id:entry.terminal_task_canonical_id,selection_kind:entry.selection_kind}]));}
function compareSeriesEndpoints(baseline,current){
  const left=seriesEndpoints(baseline),right=seriesEndpoints(current);const ids=[...new Set([...Object.keys(left),...Object.keys(right)])].sort();
  return ids.map((id)=>({series_canonical_id:id,baseline_selected_task_count:left[id]?.selected_task_count??0,current_selected_task_count:right[id]?.selected_task_count??0,
    simulated_unlock_delta:(right[id]?.selected_task_count??0)-(left[id]?.selected_task_count??0),baseline_terminal_task_canonical_id:left[id]?.terminal_task_canonical_id??null,
    current_terminal_task_canonical_id:right[id]?.terminal_task_canonical_id??null})).filter((entry)=>entry.simulated_unlock_delta!==0||entry.baseline_terminal_task_canonical_id!==entry.current_terminal_task_canonical_id);
}
function buildModuleCandidate(name,selection,baseline,reuseScope){
  const delta=selection.selected_task_count-baseline.selected_task_count;const changes=compareSeriesEndpoints(baseline,selection);
  const metadata={
    training_session_continuation:{display_name:'repeatable training session continuation',source_evidence_strength_score:5,implementation_cost_score:2,
      evidence_basis:['source encounter cache refresh','source automatic attack interval','source free church recovery','persistent save progression across sessions']},
    task_described_item_sources:{display_name:'task-described encounter item-source closure',source_evidence_strength_score:4,implementation_cost_score:3,
      evidence_basis:['task description names the encounter','target location contains a unique matching encounter','promoted suffixes are rejected rather than guessed']},
    projected_task_entry_combat_state:{display_name:'projected task-entry combat state',source_evidence_strength_score:5,implementation_cost_score:2,
      evidence_basis:['task rewards and formal training establish entry level','combat and stamina proofs must use scheduled task-entry level','accepted 78-task history is not re-proved']},
  }[name];
  const crossSeriesReuseScore=Math.max(1,Math.min(5,Math.ceil(reuseScope.series_count/3)));
  const downstreamExposureScore=delta>=20?5:delta>=5?4:delta>0?3:name==='projected_task_entry_combat_state'?5:2;
  const priority=delta*100+crossSeriesReuseScore*6+metadata.source_evidence_strength_score*5+downstreamExposureScore*5-metadata.implementation_cost_score*4;
  return {module:name,display_name:metadata.display_name,selected_for_stage:true,actual_simulated_unlock_delta:delta,
    actual_affected_series_count:changes.length,actual_endpoint_changes:changes,cross_series_reuse_scope:reuseScope,
    cross_series_reuse_score:crossSeriesReuseScore,source_evidence_strength_score:metadata.source_evidence_strength_score,
    downstream_exposure_score:downstreamExposureScore,implementation_cost_score:metadata.implementation_cost_score,
    priority_score:priority,evidence_basis:metadata.evidence_basis};
}
function buildReuseScopes(db){
  const training=db.prepare(`SELECT COUNT(DISTINCT s.canonical_id) series_count,COUNT(*) task_count FROM task_definitions t JOIN task_series s ON s.id=t.task_series_id WHERE t.level_requirement>1`).get();
  const taskItems=db.prepare(`SELECT COUNT(DISTINCT s.canonical_id) series_count,COUNT(DISTINCT t.canonical_id) task_count FROM task_targets tt
    JOIN task_definitions t ON t.id=tt.task_id JOIN task_series s ON s.id=t.task_series_id JOIN dependency_references r ON r.id=tt.dependency_reference_id
    WHERE tt.target_kind='item' AND r.resolution_status<>'resolved' AND LENGTH(TRIM(COALESCE(t.description,'')))>0`).get();
  const combat=db.prepare(`SELECT COUNT(DISTINCT s.canonical_id) series_count,COUNT(DISTINCT t.canonical_id) task_count FROM task_targets tt
    JOIN task_definitions t ON t.id=tt.task_id JOIN task_series s ON s.id=t.task_series_id WHERE tt.target_kind='monster'`).get();
  return {training_session_continuation:normalizeScope(training,'series with explicit level-gated tasks'),
    task_described_item_sources:normalizeScope(taskItems,'series with unresolved item targets and task-description evidence'),
    projected_task_entry_combat_state:normalizeScope(combat,'series with formal monster-target combat')};
}
function normalizeScope(row,basis){return {series_count:Number(row.series_count??0),task_count:Number(row.task_count??0),basis};}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`,'utf8');}

if(require.main===module)main();
module.exports={buildRootClusters,compareSeriesEndpoints};
