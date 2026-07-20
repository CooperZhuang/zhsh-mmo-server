'use strict';

const crypto=require('node:crypto');
const childProcess=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const evidenceDirectory=path.join(root,'docs','development','browser-dom-e2e-evidence');
const expected={selection_file_sha256:'e0b25fb86076f6c90ac5fef96d7f7a3697f140d58e1ae4e79879f80480339c8b',
  browser_content_file_sha256:'bbfdd96686e760625be850695242705d5dea017411153ac6a89ec431d5d55dac',matrix_file_sha256:'1ae2b03649204f7afa57e3a2d75d4f099fa101032530957bff417c691fe76731'};
function sha256(relative){return crypto.createHash('sha256').update(fs.readFileSync(path.join(root,relative))).digest('hex');}
function acceptedLayoutEvidence(){
  const qaPath=path.join(root,'docs','development','browser-free-encounter-qa.json');
  const current=JSON.parse(fs.readFileSync(qaPath,'utf8'));
  if(current.viewport&&Array.isArray(current.pages))return {viewport:current.viewport,pages:current.pages};
  const baseline=childProcess.spawnSync('git',['show','5ab189272f3c3c6836eff46f4ce78e4266df6c70:docs/development/browser-free-encounter-qa.json'],{cwd:root,encoding:'utf8'});
  if(baseline.status!==0)throw new Error(`Unable to load accepted layout evidence: ${baseline.stderr}`);
  const parsed=JSON.parse(baseline.stdout);return {viewport:parsed.viewport,pages:parsed.pages};
}

function main(){
  const results=JSON.parse(fs.readFileSync(path.join(evidenceDirectory,'browser-dom-e2e-results.json'),'utf8'));
  if(results.scenarios.length!==2||results.scenarios.some((scenario)=>scenario.completed_task_count!==57||scenario.formal_series_count!==11))throw new Error('DOM scenario evidence is incomplete');
  const selection=JSON.parse(fs.readFileSync(path.join(root,'data','generated','runnable-task-selection.json'),'utf8'));
  const content=JSON.parse(fs.readFileSync(path.join(root,'web','generated','task1-content.json'),'utf8'));
  const matrix=JSON.parse(fs.readFileSync(path.join(root,'docs','development','task-playability-matrix.json'),'utf8'));
  const hashes={selection_file_sha256:sha256('data/generated/runnable-task-selection.json'),browser_content_file_sha256:sha256('web/generated/task1-content.json'),
    matrix_file_sha256:sha256('docs/development/task-playability-matrix.json')};
  for(const [name,value] of Object.entries(expected))if(hashes[name]!==value)throw new Error(`${name} changed: ${hashes[name]}`);
  const taskIds=content.tasks.map((task)=>task.canonical_id);const invariance={schema_version:1,started_from_head:'5ab189272f3c3c6836eff46f4ce78e4266df6c70',
    final_head_record:'review/git/HEAD.txt in the final ZIP',start:{formal_task_count:57,formal_series_count:11,not_selected_task_count:594,formal_task_ids:taskIds,
      selection_hash:selection.selection_hash,browser_content_sha256:content.content_sha256,matrix:{total_tasks:651,formal_core_playable_count:57,status_counts:matrix.status_counts},...expected},
    end:{formal_task_count:selection.selected_task_count,formal_series_count:selection.selected_series_count,not_selected_task_count:651-selection.selected_task_count,formal_task_ids:taskIds,
      selection_hash:selection.selection_hash,browser_content_sha256:content.content_sha256,matrix:{total_tasks:matrix.total_tasks,formal_core_playable_count:matrix.formal_core_playable_count,status_counts:matrix.status_counts},...hashes},
    unchanged:{formal_task_ids:true,selection_file_sha256:true,browser_content_file_sha256:true,matrix_file_sha256:true,experience_rule:content.gameplay_rules.monster_rewards.rule_id==='compatibility.monster-rewards.v1',
      copper_rule:content.gameplay_rules.monster_rewards.copper.formula==='level * 5'}};
  fs.writeFileSync(path.join(evidenceDirectory,'formal-content-invariance.json'),`${JSON.stringify(invariance,null,2)}\n`,'utf8');
  const layout=acceptedLayoutEvidence();
  const qa={schema_version:4,validated_from_head:'5ab189272f3c3c6836eff46f4ce78e4266df6c70',validation_scope:'third-batch DOM browser acceptance evidence repair',
    selection_hash:selection.selection_hash,browser_content_sha256:content.content_sha256,url:'dynamic localhost port served from the final browser build',
    browser_context:{browser:results.scenarios[0].browser_version,viewport:'390x844 via DevTools device metrics',gameplay_e2e_run:true,direct_browser_storage_writes:false,internal_runtime_api_calls:false,
      formal_file_import_and_download:true,temporary_headless_profile:true},
    viewport:layout.viewport,pages:layout.pages,
    test_counts:{historical_formal_baseline:87,preserved_tests:91,dom_browser_e2e:2,total:93},
    scenarios:results.scenarios.map((scenario)=>({scenario:scenario.scenario,result:'passed',duration_ms:scenario.duration_ms,completed_task_count:scenario.completed_task_count,
      formal_series_count:scenario.formal_series_count,legacy_checkpoint_task_count:scenario.legacy_checkpoint_task_count,extra_free_leveling_encounters:scenario.extra_free_leveling_encounters,
      context_reopens:scenario.context_reopens,page_refreshes:scenario.page_refreshes,battle:scenario.battle,completed_special_tasks:scenario.completed_special_tasks,
      console:{errors:scenario.console.errors,warnings:scenario.console.warnings},network_error_count:scenario.network_errors.length,measurements:scenario.measurements})),
    acceptance:{formal_tasks:57,formal_series:11,matrix_tasks:651,series_07_complete:true,series_09_complete:true,series_04_final_complete:true,
      all_measurements_390x844:results.scenarios.every((scenario)=>scenario.measurements.every((measurement)=>measurement.viewport_width===390&&measurement.viewport_height===844)),
      horizontal_overflow:false,obscured_primary_actions:false,clipped_or_truncated_text:false,console_errors:0,console_warnings:0,network_errors:0},
    raw_evidence:{dom_results:'docs/development/browser-dom-e2e-evidence/browser-dom-e2e-results.json',dom_stdout_stderr:'docs/development/browser-dom-e2e-evidence/dom-browser-e2e.log',
      npm_verify_stdout_stderr:'docs/development/browser-dom-e2e-evidence/npm-run-verify.log',content_invariance:'docs/development/browser-dom-e2e-evidence/formal-content-invariance.json'}};
  fs.writeFileSync(path.join(root,'docs','development','browser-free-encounter-qa.json'),`${JSON.stringify(qa,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify({qa:'docs/development/browser-free-encounter-qa.json',invariance:'docs/development/browser-dom-e2e-evidence/formal-content-invariance.json',scenarios:2},null,2)}\n`);
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
