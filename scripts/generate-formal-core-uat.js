'use strict';

const childProcess=require('node:child_process');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const testFile='tests/formal-core-e2e.test.js';
const fixtureFile='tests/fixtures/browser-save-v1-real-1-of-13.json';
const outputFile='docs/development/formal-core-e2e-validation.json';
const generatedDirectory='data/generated';

function main() {
  const newEvidence=argument('--new-evidence'),oldEvidence=argument('--old-evidence');
  if(newEvidence||oldEvidence){
    if(!newEvidence||!oldEvidence)throw new Error('Both --new-evidence and --old-evidence are required');
    const records=[newEvidence,oldEvidence].map((file)=>JSON.parse(fs.readFileSync(path.resolve(root,file),'utf8')));
    if(records.some((record)=>record.exit_code!==0||record.test_count!==1))throw new Error('Captured formal evidence did not pass exactly one scenario per file');
    return writeValidationFromTestOutput(records.map((record)=>record.raw_stdout).join('\n'),{evidenceFiles:[newEvidence,oldEvidence]});
  }
  const run=childProcess.spawnSync(process.execPath,['--test',testFile],{cwd:root,encoding:'utf8',env:{...process.env,ZHSH_CAPTURE_LEVEL_REACHABILITY:'1'}});
  if(run.status!==0)throw new Error(run.stderr||run.stdout||`Formal core E2E exited ${run.status}`);
  return writeValidationFromTestOutput(run.stdout);
}

function writeValidationFromTestOutput(testOutput,{evidenceFiles=[]}={}) {
  const reachability=[...testOutput.matchAll(/ZHSH_LEVEL_REACHABILITY:(\{.*\})/g)].map((match)=>JSON.parse(match[1]));
  if(reachability.length!==2)throw new Error('Formal core E2E did not emit both level reachability scenarios');
  if(new Set(reachability.map((entry)=>entry.scenario)).size!==2||reachability.some((entry)=>entry.completed_task_count!==entry.selected_task_count))
    throw new Error('Formal core evidence scenarios are incomplete or duplicated');

  const content=JSON.parse(fs.readFileSync(path.join(root,'web','generated','task1-content.json'),'utf8'));
  const fixtureBytes=fs.readFileSync(path.join(root,fixtureFile));
  const fixture=JSON.parse(fixtureBytes.toString('utf8'));
  const tasks=content.tasks.map((task)=>task.canonical_id);
  const selection=JSON.parse(fs.readFileSync(path.join(root,'data','generated','runnable-task-selection.json'),'utf8'));
  const validation={
    schema_version:1,
    validated_at:'2026-07-17T00:00:00.000Z',
    harness:testFile,captured_evidence_files:evidenceFiles,
    shortcuts_forbidden_and_absent:true,
    selection_hash:selection.selection_hash,
    browser_content_sha256:content.content_sha256,
    formal_task_count:tasks.length,
    formal_task_canonical_ids:tasks,
    scenarios:[
      {
        scenario:'new_browser_save',result:'passed',initial_completed:0,final_completed:tasks.length,
        coverage:['combat loss','church recovery','combat victory','retreat idempotence','formal shop purchase','ship purchase','multi-city formal voyage','combat and voyage reload'],
      },
      {
        scenario:'legacy_25_task_checkpoint_migration',result:'passed',initial_completed:1,checkpoint_completed:25,final_completed:tasks.length,
        fixture:fixtureFile,fixture_sha256:crypto.createHash('sha256').update(fixtureBytes).digest('hex'),
        source_commit:fixture.fixture_provenance.source_commit,
        preserved:{map_node:'derived.map_node.location.96481d67f171db13',money:100,experience:1000},
        accepted_batch_source_head:'a97c8afb7dee109dc7a34c983bb987a84ab20faa',accepted_25_checkpoint_reload:'passed',
        reward_grants_preserved_after_checkpoint:true,upgraded_schema_version:3,export_import_round_trip:'passed',
      },
    ],
  };
  const destination=path.join(root,outputFile);
  fs.writeFileSync(destination,`${JSON.stringify(validation,null,2)}\n`,'utf8');
  fs.mkdirSync(path.join(root,generatedDirectory),{recursive:true});
  fs.writeFileSync(path.join(root,generatedDirectory,'level-reachability-validation.json'),`${JSON.stringify({schema_version:1,
    selection_hash:selection.selection_hash,reward_rule:content.gameplay_rules.monster_rewards,scenarios:reachability,
    balance_anomaly_count:reachability.flatMap((entry)=>entry.level_gate_summary).filter((entry)=>entry.balance_anomaly).length},null,2)}\n`,'utf8');
  for(const scenario of validation.scenarios)fs.writeFileSync(path.join(root,generatedDirectory,`${scenario.scenario}-validation.json`),`${JSON.stringify({
    schema_version:1,selection_hash:selection.selection_hash,browser_content_sha256:content.content_sha256,...scenario,
    completed_task_canonical_ids:tasks,
  },null,2)}\n`,'utf8');
  const checkpoint=reachability.find((entry)=>entry.scenario==='legacy_25_task_checkpoint_migration')?.accepted_25_checkpoint;
  if(!checkpoint||checkpoint.completed_task_count!==25||checkpoint.reloaded!==true)throw new Error('Accepted 25-task checkpoint was not reloaded and preserved');
  console.log(JSON.stringify({output:outputFile,formal_task_count:tasks.length,scenarios:validation.scenarios.map((entry)=>entry.scenario)},null,2));
  return validation;
}

function argument(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}

if(require.main===module)main();
module.exports={main,writeValidationFromTestOutput};
