'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {evaluateAllTasks}=require('./select-runnable-tasks');
const {generationMetadata}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const read=(relative)=>JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));
const outputPath=path.join(root,'data','generated','global-task-model-validation.json');

function main(){
  const rules=read('data/runtime/task-golden-rules.json');
  const graph=read('data/generated/global-task-standard-graph.json');
  const fitting=read('data/generated/global-task-fitting-results.json');
  const exceptions=read('data/generated/global-task-exception-clusters.json');
  const directory=read('data/generated/unified-task-directory.json');
  const selection=read('data/generated/runnable-task-selection.json');
  const content=read('web/generated/task1-content.json');
  const evaluation=evaluateAllTasks();
  const checks=[];
  const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks.push({name,passed:true,actual,expected});};

  check('golden_rule_count',rules.rules.length,20);
  check('standard_graph_task_count',graph.tasks.length,651);
  check('standard_graph_unique_ids',new Set(graph.tasks.map((entry)=>entry.canonical_id)).size,651);
  check('remaining_fit_task_count',fitting.remaining_task_count,534);
  check('independent_direct_fit_count',evaluation.tasks.filter((entry)=>entry.direct_fit).length,640);
  check('independent_exception_count',evaluation.tasks.filter((entry)=>!entry.direct_fit).length,11);
  check('remaining_direct_fit_count',fitting.class_summary.filter((entry)=>entry.class_id<=4).reduce((sum,entry)=>sum+entry.count,0),523);
  check('legacy_audit_selector_count',selection.selected_task_count,117);
  check('validated_baseline_count',directory.status_counts.validated,78);
  check('directory_status_counts',directory.status_counts,{blocked_by_shared_system:3,data_conflict:6,evidence_missing:2,runnable_pending_validation:562,validated:78});
  check('exception_cluster_task_count',exceptions.exception_task_count,11);
  check('browser_regression_task_count',content.entity_counts.tasks,117);
  const waypoint=content.maritime.sailing.route_encounters.find((entry)=>entry.location==='蓬莱仙岛');
  check('route_waypoint_export_complete',Boolean(waypoint?.location_canonical_id&&waypoint?.map_node_canonical_id),true);
  check('contextual_npc_task_count',graph.tasks.filter((entry)=>entry.npcs.contextual_definitions.length>0).length,35);
  check('migrated_collection_target_count',evaluation.tasks.flatMap((entry)=>entry.runtime_item_resolutions)
    .filter((entry)=>entry.resolution_rule==='normalize_migrated_collection_target_to_item').length,2);
  check('task_described_drop_resolution_count',evaluation.tasks.flatMap((entry)=>entry.runtime_item_resolutions)
    .filter((entry)=>entry.resolution_rule==='source_explicit_task_described_encounter_drop').length,35);

  const result={schema_version:1,record_kind:'global-task-model-validation',...generationMetadata('global-task-model-validation/1.0.0'),
    scope:'data integrity + 651 independent fitting + 117 regression package + representative shared-system checks; no full DOM or cold ZIP',
    passed:true,check_count:checks.length,checks};
  fs.writeFileSync(outputPath,`${JSON.stringify(result,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify({passed:true,check_count:checks.length,output:path.relative(root,outputPath).replaceAll('\\','/')},null,2)}\n`);
  return result;
}

if(require.main===module)main();
module.exports={main};
