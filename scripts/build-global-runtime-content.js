'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {evaluateAllTasks}=require('./select-runnable-tasks');
const {generationMetadata}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const generated=path.join(root,'data','generated');
const paths={
  graph:path.join(generated,'global-task-standard-graph.json'),
  fitting:path.join(generated,'global-task-fitting-results.json'),
  directory:path.join(generated,'unified-task-directory.json'),
  selection:path.join(generated,'global-runtime-task-selection.json'),
  validation:path.join(generated,'global-runtime-validation.json'),
  exceptionReview:path.join(generated,'global-task-exception-evidence-review.json'),
  browserAcceptance:path.join(generated,'browser-acceptance-validation-matrix.json'),
};
const IMPLEMENTED_SHARED_SYSTEMS=new Set(['task_acceptance_handoff','task_chain_item_ledger','npc_duel_encounter']);

function main(){
  const graph=read(paths.graph);const fitting=read(paths.fitting);const directory=read(paths.directory);
  const exceptionReview=read(paths.exceptionReview);
  const browserAcceptance=fs.existsSync(paths.browserAcceptance)?read(paths.browserAcceptance):{promoted_task_canonical_ids:[]};
  const browserValidatedIds=new Set(browserAcceptance.promoted_task_canonical_ids??[]);
  const exceptionByTask=new Map(exceptionReview.reviews.map((entry)=>[entry.task_canonical_id,entry]));
  const direct=evaluateAllTasks();const directById=new Map(direct.tasks.map((entry)=>[entry.canonical_id,entry]));
  const fitById=new Map(fitting.tasks.map((entry)=>[entry.canonical_id,entry]));
  const directoryById=new Map(directory.tasks.map((entry)=>[entry.canonical_id,entry]));
  const graphById=new Map(graph.tasks.map((entry)=>[entry.canonical_id,entry]));
  const selectedTasks=[];
  const rewardResolutionsByTask=new Map();

  for(const fit of fitting.tasks){
    for(const derivation of fit.derivations??[]){
      if(!fit.reason_codes.includes('task_chain_item_ledger'))continue;
      const entityId=runtimeItemId(derivation.item_name);
      const list=rewardResolutionsByTask.get(derivation.source_task_canonical_id)??[];
      list.push({source_task_canonical_id:derivation.source_task_canonical_id,reward_name:derivation.item_name,quantity:1,
        runtime_entity_canonical_id:entityId,resolution_rule:'task_chain_reward_ledger',source_target_canonical_id:derivation.target_canonical_id});
      rewardResolutionsByTask.set(derivation.source_task_canonical_id,list);
    }
  }
  for(const review of exceptionReview.reviews){
    for(const resolution of review.runtime_resolutions?.reward_resolutions??[]){
      const list=rewardResolutionsByTask.get(resolution.source_task_canonical_id)??[];
      list.push(resolution);rewardResolutionsByTask.set(resolution.source_task_canonical_id,list);
    }
  }

  for(const graphTask of graph.tasks){
    const closure=directById.get(graphTask.canonical_id);const fit=fitById.get(graphTask.canonical_id);const entry=directoryById.get(graphTask.canonical_id);
    if(!closure||!fit||!entry)throw new Error(`Global runtime input missing: ${graphTask.canonical_id}`);
    const implemented=fit.affected_shared_systems?.length>0&&fit.affected_shared_systems.every((id)=>IMPLEMENTED_SHARED_SYSTEMS.has(id));
    const runtimeItemResolutions=[...(closure.runtime_item_resolutions??[])];
    const acceptanceGrantResolutions=deriveAcceptanceGrantResolutions(graphTask,graphById,runtimeItemResolutions);
    runtimeItemResolutions.push(...acceptanceGrantResolutions);
    const runtimeTargetResolutions=[];
    if(fit.reason_codes.includes('task_chain_item_ledger')){
      for(const derivation of fit.derivations){
        runtimeItemResolutions.push({target_canonical_id:derivation.target_canonical_id,runtime_entity_canonical_id:runtimeItemId(derivation.item_name),
          resolution_rule:'task_chain_reward_ledger',target_kind_override:'item',original_target_kind:'item',
          task_item_policy:{acquisition_mode:'prerequisite_reward',reservation:'required_until_submit',source_task_canonical_id:derivation.source_task_canonical_id,
            abandonment:'retain_source_reward',consumption:'submit_only'},
          formal_source:{canonical_id:`runtime.task_chain.source.${shortHash(`${derivation.source_task_canonical_id}|${derivation.item_name}`)}`,
            source_canonical_id:derivation.source_task_canonical_id,source_kind:'task_chain_reward',item_name:derivation.item_name,
            source_task_canonical_id:derivation.source_task_canonical_id,evidence_status:'SOURCE_TEXT_AND_ADJACENT_CHAIN',
            evidence_locator:`${derivation.source_task_canonical_id} -> ${graphTask.canonical_id}`}});
      }
    }
    if(fit.reason_codes.includes('npc_duel_encounter_required')){
      for(const derivation of fit.derivations)runtimeTargetResolutions.push({target_canonical_id:derivation.target_canonical_id,
        runtime_entity_canonical_id:derivation.npc_canonical_id,target_kind_override:'npc_duel',original_target_kind:'monster',
        resolution_rule:'npc_duel_from_unique_npc_candidate',duel:{npc_canonical_id:derivation.npc_canonical_id,
          level:Math.max(1,Number(graphTask.level_requirement??1)),settlement:'task_progress_only',drop_policy:'none',defeat_policy:'nonlethal_retry'}});
    }
    const review=exceptionByTask.get(graphTask.canonical_id);
    runtimeItemResolutions.push(...(review?.runtime_resolutions?.item_targets??[]));
    runtimeTargetResolutions.push(...(review?.runtime_resolutions?.target_entities??[]));
    const exceptionResolved=review?.resulting_status==='runnable_pending_validation';
    const preAcceptanceStatus=(implemented||exceptionResolved)?'runnable_pending_validation':(review?.resulting_status??entry.status);
    const operationalStatus=browserValidatedIds.has(graphTask.canonical_id)?'validated':preAcceptanceStatus;
    const operationalBlockers=(implemented||exceptionResolved)?[]:closure.blocking_reasons;
    const implementedSystems=(fit.affected_shared_systems??[]).filter((id)=>IMPLEMENTED_SHARED_SYSTEMS.has(id));
    if(acceptanceGrantResolutions.length)implementedSystems.push('task_acceptance_handoff');
    selectedTasks.push({canonical_id:graphTask.canonical_id,series_canonical_id:graphTask.series_canonical_id,sequence_position:graphTask.sequence_position,
      directory_status:operationalStatus,blocking_reasons:operationalBlockers,evidence:closure.evidence,
      runtime_item_resolutions:dedupe(runtimeItemResolutions,'target_canonical_id'),runtime_target_resolutions:dedupe(runtimeTargetResolutions,'target_canonical_id'),
      runtime_reward_resolutions:dedupe(rewardResolutionsByTask.get(graphTask.canonical_id)??[],'reward_name'),
      task_location_override:review?.runtime_resolutions?.task_location_override??null,
      evidence_exception_resolution:review?{decision:review.decision,conclusion:review.conclusion,resulting_status:review.resulting_status}:null,
      operational_fit:operationalBlockers.length===0,implemented_shared_systems:implementedSystems});
  }

  const statusCounts=countBy(selectedTasks,'directory_status');
  const selectedSeries=graph.series.map((series)=>({canonical_id:series.canonical_id,display_name:series.display_name,
    selected_task_count:selectedTasks.filter((entry)=>entry.series_canonical_id===series.canonical_id).length}));
  const body={selector_version:'global-runtime-directory/1.0.0',...generationMetadata('global-runtime-content/1.0.0'),
    input_evidence:['data/generated/global-task-standard-graph.json','data/generated/global-task-fitting-results.json','data/generated/unified-task-directory.json','data/generated/global-task-exception-evidence-review.json','data/generated/browser-acceptance-validation-matrix.json'],
    selection_policy:'all 651 tasks are exported; directory status remains runtime metadata and only unresolved evidence/conflict tasks stay blocked',
    selected_task_count:selectedTasks.length,selected_series_count:selectedSeries.length,selected_series:selectedSeries,selected_tasks:selectedTasks,
    status_counts:statusCounts,runtime_runnable_task_count:selectedTasks.filter((entry)=>entry.operational_fit).length,
    implemented_shared_systems:[...IMPLEMENTED_SHARED_SYSTEMS],browser_acceptance:{matrix_file:'data/generated/browser-acceptance-validation-matrix.json',promoted_task_count:browserValidatedIds.size},exception_reassessment:{reviewed_task_count:exceptionReview.reviewed_task_count,resolved_task_count:exceptionReview.resolved_task_count,remaining_hold_count:exceptionReview.remaining_hold_count},formal_stage_start:{selected_task_count:78}};
  body.selection_hash=crypto.createHash('sha256').update(stableJson(body)).digest('hex');
  write(paths.selection,body);

  for(const task of directory.tasks){const selected=selectedTasks.find((entry)=>entry.canonical_id===task.canonical_id);
    task.status=selected.directory_status;task.blocking_reasons=selected.blocking_reasons;
    if(selected.implemented_shared_systems.some((id)=>['task_acceptance_handoff','task_chain_item_ledger'].includes(id))&&!task.runtime_executors.includes('TaskItemLedger'))task.runtime_executors.push('TaskItemLedger');
    if(selected.implemented_shared_systems.includes('npc_duel_encounter'))task.runtime_executors=[...new Set(task.runtime_executors.filter((id)=>id!=='CombatRuntime').concat('NpcDuelRuntime'))];
    task.audit={...task.audit,operational_fit:selected.operational_fit,implemented_shared_systems:selected.implemented_shared_systems,evidence_exception_resolution:selected.evidence_exception_resolution};
  }
  directory.status_counts=countBy(directory.tasks,'status');directory.runtime_landing={...generationMetadata('global-runtime-content/1.0.0'),
    runtime_runnable_task_count:body.runtime_runnable_task_count,selection_file:'data/generated/global-runtime-task-selection.json'};
  write(paths.directory,directory);

  for(const task of fitting.tasks){const selected=selectedTasks.find((entry)=>entry.canonical_id===task.canonical_id);
    task.runtime_fit=selected.operational_fit;task.runtime_blocking_reasons=selected.blocking_reasons;task.directory_status=selected.directory_status;
    task.implementation_status=selected.implemented_shared_systems.length?'shared_system_implemented':selected.evidence_exception_resolution?.resulting_status==='runnable_pending_validation'?'evidence_exception_resolved':task.runtime_fit?'fitted_existing_runtime':'evidence_or_data_hold';
  }
  fitting.runtime_fit_summary={...countBy(fitting.tasks,'directory_status'),runtime_fit_count:fitting.tasks.filter((entry)=>entry.runtime_fit).length,
    implemented_shared_systems:[...IMPLEMENTED_SHARED_SYSTEMS]};
  write(paths.fitting,fitting);

  for(const task of graph.tasks){const selected=selectedTasks.find((entry)=>entry.canonical_id===task.canonical_id);
    task.directory_status=selected.directory_status;task.runtime_overlay={operational_fit:selected.operational_fit,blocking_reasons:selected.blocking_reasons,
      target_resolutions:[...selected.runtime_item_resolutions,...selected.runtime_target_resolutions],reward_resolutions:selected.runtime_reward_resolutions,
      implemented_shared_systems:selected.implemented_shared_systems,task_location_override:selected.task_location_override,evidence_exception_resolution:selected.evidence_exception_resolution};
  }
  graph.runtime_landing={...generationMetadata('global-runtime-content/1.0.0'),selection_file:'data/generated/global-runtime-task-selection.json'};
  write(paths.graph,graph);

  const validation={schema_version:1,...generationMetadata('global-runtime-validation/1.0.0'),record_kind:'global-runtime-validation',
    total_task_count:selectedTasks.length,runtime_runnable_task_count:body.runtime_runnable_task_count,status_counts:statusCounts,
    shared_system_reassessment:{before:{blocked_by_shared_system:3,runnable_pending_validation:562},after:{blocked_by_shared_system:statusCounts.blocked_by_shared_system??0,
      runnable_pending_validation:statusCounts.runnable_pending_validation??0},affected_task_canonical_ids:['task.series.15.471','task.series.15.472','task.series.15.698']},
    exception_reassessment:{before:{data_conflict:6,evidence_missing:2},after:{data_conflict:statusCounts.data_conflict??0,evidence_missing:statusCounts.evidence_missing??0},
      resolved_task_canonical_ids:exceptionReview.reviews.filter((entry)=>entry.resulting_status==='runnable_pending_validation').map((entry)=>entry.task_canonical_id),
      remaining_hold_task_canonical_ids:exceptionReview.reviews.filter((entry)=>entry.resulting_status!=='runnable_pending_validation').map((entry)=>entry.task_canonical_id)},
    browser_acceptance:{promoted_task_count:browserValidatedIds.size,promoted_task_canonical_ids:[...browserValidatedIds]},
    invariants:{all_tasks_exported:selectedTasks.length===651,validated_preserved:(statusCounts.validated??0)===78+browserValidatedIds.size,
      evidence_review_applied:(statusCounts.data_conflict??0)===(exceptionReview.status_counts.data_conflict??0)&&(statusCounts.evidence_missing??0)===(exceptionReview.status_counts.evidence_missing??0),
      shared_system_blockers_cleared:(statusCounts.blocked_by_shared_system??0)===0,
      runnable_count_balanced:(statusCounts.data_conflict??0)===0&&(statusCounts.evidence_missing??0)===0},
    operational_fit_count:fitting.tasks.filter((entry)=>entry.runtime_fit).length,
    result:'passed'};
  if(Object.values(validation.invariants).some((value)=>value!==true))throw new Error(`Global runtime invariants failed: ${JSON.stringify(validation.invariants)}`);
  write(paths.validation,validation);
  process.stdout.write(`${JSON.stringify({selection:path.relative(root,paths.selection),validation:path.relative(root,paths.validation),status_counts:statusCounts,
    runtime_runnable_task_count:body.runtime_runnable_task_count,selection_hash:body.selection_hash},null,2)}\n`);
}


function deriveAcceptanceGrantResolutions(task,graphById,existingResolutions){
  if(task.task_type!=='送物品')return [];
  const predecessorTasks=(task.prerequisites??[]).map((id)=>graphById.get(id)).filter(Boolean);
  const receiveText=(task.dialogues??[]).filter((entry)=>entry.phase==='receive').map((entry)=>entry.normalized_text??entry.original_text??'').join('\n');
  const transferCue=/(?:这是|制作完成|已经(?:做好|准备好)|拿去|带给|交给|送给|送[封份个]|给你|你把|你将|帮.*?送|托你送)/;
  const existingTargets=new Set(existingResolutions.map((entry)=>entry.target_canonical_id));const results=[];
  for(const objective of task.objectives??[]){
    if(objective.kind!=='item'||existingTargets.has(objective.canonical_id))continue;const itemName=String(objective.raw_name??'').trim();if(!itemName||!receiveText.includes(itemName)||!transferCue.test(receiveText))continue;
    const suppliedByPredecessor=predecessorTasks.some((predecessor)=>[...(predecessor.objectives??[]),...(predecessor.rewards??[])]
      .some((entry)=>entry.kind==='item'&&(entry.content_entity_canonical_id&&entry.content_entity_canonical_id===objective.entity_canonical_id||String(entry.raw_name??entry.name??'').trim()===itemName)));
    if(suppliedByPredecessor)continue;const runtimeEntityId=objective.entity_canonical_id??`runtime.task_acceptance.item.${shortHash(itemName)}`;
    results.push({target_canonical_id:objective.canonical_id,runtime_entity_canonical_id:runtimeEntityId,resolution_rule:'explicit_receive_dialogue_item_handoff',
      target_kind_override:'item',original_target_kind:'item',task_item_policy:{acquisition_mode:'grant_on_accept',reservation:'required_until_submit',
        abandonment:'rollback_acceptance_grant',consumption:'submit_only'},formal_source:{canonical_id:`runtime.task_acceptance.source.${shortHash(`${task.canonical_id}|${itemName}`)}`,
        source_canonical_id:task.canonical_id,source_kind:'task_acceptance_grant',item_name:itemName,source_task_canonical_id:task.canonical_id,
        evidence_status:'SOURCE_EXPLICIT_RECEIVE_DIALOGUE',evidence_locator:`${task.canonical_id} receive dialogue: ${receiveText}`}});
  }
  return results;
}

function runtimeItemId(name){return `runtime.task_chain.item.${shortHash(name)}`;}
function shortHash(value){return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,16);}
function countBy(values,key){return Object.fromEntries([...new Set(values.map((entry)=>entry[key]))].sort().map((value)=>[value,values.filter((entry)=>entry[key]===value).length]));}
function dedupe(values,key){return [...new Map(values.map((entry)=>[entry[key],entry])).values()];}
function stableJson(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function write(file,value){fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`,'utf8');}

if(require.main===module)main();
module.exports={main,runtimeItemId};
