'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {SqliteTaskCatalog}=require('../src/task-runtime');
const {evaluateAllTasks}=require('./select-runnable-tasks');
const {generationMetadata}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const outputRoot=path.join(root,'data','generated');
const files={
  rules:path.join(root,'data','runtime','task-golden-rules.json'),
  selection:path.join(outputRoot,'runnable-task-selection.json'),
  conflicts:path.join(outputRoot,'source-conflict-register.json'),
  maritime:path.join(root,'data','runtime','maritime-capabilities.json'),
  coordinates:path.join(root,'data','runtime','city-coordinates.json'),
  graph:path.join(outputRoot,'global-task-standard-graph.json'),
  fitting:path.join(outputRoot,'global-task-fitting-results.json'),
  exceptions:path.join(outputRoot,'global-task-exception-clusters.json'),
  directory:path.join(outputRoot,'unified-task-directory.json'),
};
const fittingLabels={
  1:'existing_rules_direct',2:'automatic_field_or_name_mapping',3:'multi_repository_complement',4:'reliable_small_field_inference',
  5:'extend_existing_common_algorithm',6:'new_late_shared_system',7:'data_error_or_migration_damage',8:'substantive_repository_conflict',
  9:'true_one_off_special_script',10:'insufficient_evidence_hold',
};

function main(){
  const rules=readJson(files.rules);const selection=readJson(files.selection);const conflicts=readJson(files.conflicts);
  const maritime=readJson(files.maritime);const coordinates=readJson(files.coordinates).coordinates;
  const direct=evaluateAllTasks();
  const directById=new Map(direct.tasks.map((entry)=>[entry.canonical_id,entry]));
  const selectedIds=new Set(selection.selected_tasks.map((entry)=>entry.canonical_id));
  const selectedById=new Map(selection.selected_tasks.map((entry)=>[entry.canonical_id,entry]));
  const validatedIds=loadValidatedIds();
  const conflictBySubject=groupMap(conflicts.records,'subject_canonical_id');
  const db=new DatabaseSync(path.join(root,'data','zhsh-content.sqlite'),{readOnly:true});
  try{
    const catalog=new SqliteTaskCatalog(db);
    const series=db.prepare('SELECT canonical_id,display_name,source_series FROM task_series ORDER BY source_series').all();
    const seriesById=new Map(series.map((entry)=>[entry.canonical_id,entry]));
    const locationRows=db.prepare(`SELECT l.canonical_id,l.display_name,c.canonical_id city_canonical_id,c.display_name city_display_name,
      mn.canonical_id map_node_canonical_id,mn.node_kind FROM locations l JOIN cities c ON c.id=l.city_id
      LEFT JOIN map_nodes mn ON mn.location_id=l.id ORDER BY l.canonical_id`).all();
    const locations=new Map(locationRows.map((entry)=>[entry.canonical_id,entry]));
    const taskRows=db.prepare(`SELECT t.canonical_id,t.source_record_id,rr.confidence,rr.restoration_status,rr.originality_status,rr.decision_reason
      FROM task_definitions t JOIN restoration_records rr ON rr.id=t.source_record_id ORDER BY t.canonical_id`).all();
    const taskMeta=new Map(taskRows.map((entry)=>[entry.canonical_id,entry]));
    const sourceEvidenceByRecord=loadSourceEvidence(db);
    const graphTasks=[];const fittingTasks=[];const directoryTasks=[];
    for(const seriesEntry of series){
      for(const task of catalog.listSeriesTasks(seriesEntry.canonical_id)){
        const closure=directById.get(task.canonical_id);const selected=selectedById.get(task.canonical_id);
        const evidence=buildEvidence(task,taskMeta.get(task.canonical_id),sourceEvidenceByRecord,conflictBySubject);
        const fit=classifyTask({task,closure,selectedIds,validatedIds,evidence,maritime,db,catalog});
        const directoryStatus=directoryStatusFor(fit,validatedIds.has(task.canonical_id));
        const locationBundle=buildLocationBundle(task,locations,coordinates);
        const runtimeExecutors=executorsFor(task,closure);
        const graphEntry={
          canonical_id:task.canonical_id,display_name:task.display_name,series_canonical_id:seriesEntry.canonical_id,
          series_display_name:seriesEntry.display_name,source_series:Number(seriesEntry.source_series),sequence_position:Number(task.sequence_position),
          prerequisites:task.prerequisites,successors:task.successors,task_type:task.task_type,level_requirement:Number(task.level_requirement??1),
          lifecycle:{publish:'npc_available',accept:'npc_interaction',execute:runtimeExecutors,complete:'objectives_satisfied',submit:'completion_npc_interaction'},
          npcs:{issuer:entityRef(task.issuer_npc_canonical_id,task.raw_issuer_npc),targets:task.targets.filter((x)=>x.target_kind==='npc').map(targetRef),
            completion:entityRef(task.completion_npc_canonical_id,task.raw_completion_npc),contextual_definitions:task.contextual_npc_definitions},
          locations:locationBundle,
          conditions:{level:Number(task.level_requirement??1),profession:extractCondition(task,'profession'),equipment:extractCondition(task,'equipment'),
            items:task.targets.filter((x)=>x.target_kind==='item').map(targetRef),state_flags:extractCondition(task,'state')},
          objectives:task.targets.map(targetRef),steps:task.steps,dialogues:task.dialogues,
          rewards:task.rewards.map((reward)=>({canonical_id:reward.canonical_id,kind:reward.reward_kind,name:reward.reward_name,quantity:reward.quantity,
            content_entity_canonical_id:reward.content_entity_canonical_id,resolution_status:reward.resolution_status})),
          source_evidence:evidence.sources,source_repositories:evidence.repositories,confidence:evidence.confidence,
          conflict_records:evidence.conflicts,runtime_executors:runtimeExecutors,
          fitting:{class_id:fit.class_id,class_name:fittingLabels[fit.class_id],reason_codes:fit.reason_codes,derivations:fit.derivations},
          directory_status:directoryStatus,legacy_selector:{selected:selectedIds.has(task.canonical_id),selection_reason:selected?.selection_reason??null},
        };
        graphTasks.push(graphEntry);
        fittingTasks.push({canonical_id:task.canonical_id,series_canonical_id:seriesEntry.canonical_id,sequence_position:Number(task.sequence_position),
          in_remaining_534:!selectedIds.has(task.canonical_id),class_id:fit.class_id,class_name:fittingLabels[fit.class_id],direct_fit:closure.direct_fit,
          reason_codes:fit.reason_codes,derivations:fit.derivations,blocking_reasons:closure.blocking_reasons,affected_shared_systems:fit.shared_systems,
          evidence_repositories:evidence.repositories,directory_status:directoryStatus});
        directoryTasks.push({canonical_id:task.canonical_id,display_name:task.display_name,series_canonical_id:seriesEntry.canonical_id,
          sequence_position:Number(task.sequence_position),status:directoryStatus,fitting_class_id:fit.class_id,
          prerequisites:task.prerequisites,successors:task.successors,runtime_executors:runtimeExecutors,blocking_reasons:closure.blocking_reasons,
          audit:{legacy_selector_selected:selectedIds.has(task.canonical_id),validated:validatedIds.has(task.canonical_id),source_confidence:evidence.confidence}});
      }
    }
    const remaining=fittingTasks.filter((entry)=>entry.in_remaining_534);
    const classSummary=summarizeClasses(remaining,seriesById);
    const exceptionClusters=buildExceptionClusters(remaining,seriesById);
    const statusCounts=countBy(directoryTasks,'status');
    const ruleCoverage=buildRuleCoverage(rules,graphTasks,direct.tasks.length,validatedIds.size,selectedIds.size);
    const common={schema_version:1,...generationMetadata('global-task-model/1.0.0'),total_task_count:graphTasks.length,
      validated_baseline_count:validatedIds.size,development_sample_count:selectedIds.size};
    writeJson(files.graph,{...common,record_kind:'global-task-standard-graph',repository_roles:rules.repository_roles,
      source_priority:['zhsh_explicit','multi_source_agreement','exact_context','adjacent_chain','auxiliary_source','minimal_runtime_overlay'],
      rule_set_id:rules.rule_set_id,rule_coverage:ruleCoverage,series,task_count:graphTasks.length,tasks:graphTasks});
    writeJson(files.fitting,{...common,record_kind:'global-task-fitting-results',remaining_task_count:remaining.length,
      classification_labels:fittingLabels,class_summary:classSummary,tasks:fittingTasks});
    writeJson(files.exceptions,{...common,record_kind:'global-task-exception-clusters',exception_task_count:remaining.filter((x)=>x.class_id>=5).length,
      ranking_formula:'coverage*100 + cross_series_reuse*20 + architecture_consistency*15 + evidence_strength*10 - implementation_cost*10',clusters:exceptionClusters});
    writeJson(files.directory,{...common,record_kind:'unified-task-directory',policy:'all 651 tasks exist; status is metadata and never an import gate',
      allowed_statuses:rules.allowed_directory_statuses,status_counts:statusCounts,series_count:series.length,tasks:directoryTasks});
    process.stdout.write(`${JSON.stringify({outputs:Object.fromEntries(Object.entries(files).filter(([key])=>['graph','fitting','exceptions','directory'].includes(key))
      .map(([key,value])=>[key,path.relative(root,value).replaceAll('\\','/')])),task_count:graphTasks.length,remaining_task_count:remaining.length,
      direct_fit_count:direct.tasks.filter((entry)=>entry.direct_fit).length,class_summary:classSummary.map((entry)=>({class_id:entry.class_id,count:entry.count})),status_counts:statusCounts,
      exception_clusters:exceptionClusters.map((entry)=>({id:entry.cluster_id,count:entry.task_count,priority_score:entry.priority_score}))},null,2)}\n`);
  }finally{db.close();}
}

function classifyTask({task,closure,selectedIds,validatedIds,evidence,maritime,db,catalog}){
  const derivations=[];const reasonCodes=[];const sharedSystems=[];
  const contextual=task.contextual_npc_definitions??[];
  const mappedTargets=task.targets.filter((entry)=>entry.runtime_resolution);
  const mappedRewards=task.rewards.filter((entry)=>entry.runtime_resolution);
  if(closure.direct_fit){
    if(evidence.repositories.length>1){reasonCodes.push('multi_repository_evidence');return result(3);}
    if(contextual.length){reasonCodes.push('task_context_npc_identity');derivations.push(...contextual.map((entry)=>entry.resolution_rule));return result(4);}
    if(mappedTargets.length||mappedRewards.length||closure.runtime_item_resolutions.length){reasonCodes.push('automatic_runtime_mapping');
      derivations.push(...mappedTargets.map((x)=>x.runtime_resolution.rule),...mappedRewards.map((x)=>x.runtime_resolution.rule),...closure.runtime_item_resolutions.map((x)=>x.resolution_rule));return result(2);}
    reasonCodes.push(validatedIds.has(task.canonical_id)?'validated_rule_match':selectedIds.has(task.canonical_id)?'development_sample_rule_match':'independent_rule_match');return result(1);
  }
  const codes=new Set(closure.blocking_reasons.map((entry)=>entry.code));
  if(evidence.conflicts.some((entry)=>entry.status==='open'||entry.status==='unresolved')){reasonCodes.push('substantive_source_conflict');return result(8);}
  if(codes.has('voyage_port_or_coordinate_missing')&&routeWaypointEvidence(task,maritime)){reasonCodes.push('route_waypoint_destination_required');sharedSystems.push('maritime_route_waypoint_destination');return result(6);}
  const wrongKind=inferWrongTargetKind(task,db);
  if(wrongKind){reasonCodes.push('target_kind_migration_mismatch');derivations.push(wrongKind);return result(7);}
  const npcDuel=inferNpcDuel(task,db);
  if(npcDuel){reasonCodes.push('npc_duel_encounter_required');sharedSystems.push('npc_duel_encounter');derivations.push(npcDuel);return result(6);}
  const chainItem=inferChainItem(task,catalog);
  if(chainItem){reasonCodes.push('task_chain_item_ledger');sharedSystems.push('task_chain_item_ledger');derivations.push(chainItem);return result(5);}
  const describedDrop=inferDescribedDrop(task,db);
  if(describedDrop){reasonCodes.push('task_described_drop_extension');sharedSystems.push('task_described_drop_inference');derivations.push(describedDrop);return result(5);}
  if(codes.has('monster_without_formal_encounter')||codes.has('item_without_formal_source')){reasonCodes.push('source_data_and_placement_disagree');return result(7);}
  if(codes.has('unresolved_dependency')){reasonCodes.push('dependency_evidence_missing');return result(10);}
  reasonCodes.push('unclassified_special_case');return result(9);
  function result(classId){return {class_id:classId,reason_codes:reasonCodes,derivations,shared_systems:sharedSystems};}
}
function directoryStatusFor(fit,validated){if(validated)return'validated';if(fit.class_id<=4)return'runnable_pending_validation';if([5,6].includes(fit.class_id))return'blocked_by_shared_system';if([7,8].includes(fit.class_id))return'data_conflict';if(fit.class_id===10)return'evidence_missing';return'special_case_pending';}
function inferWrongTargetKind(task,db){for(const target of task.targets.filter((entry)=>entry.target_kind==='monster'&&!entry.entity_canonical_id)){
  if(!/(获取|收集|找到|弄到|颗|个|块|滴)/.test(task.description))continue;
  const encounters=encountersAt(db,task.target_location_canonical_id).filter((entry)=>task.description.includes(entry.display_name));
  if(encounters.length===1)return {target_canonical_id:target.canonical_id,from:'monster',to:'item',source_monster_canonical_id:encounters[0].canonical_id,evidence:'task acquisition verb + unique named encounter'};
}return null;}
function inferNpcDuel(task,db){for(const target of task.targets.filter((entry)=>entry.target_kind==='monster'&&!entry.entity_canonical_id)){
  if(!/(切磋|战胜|挑战|杀)/.test(task.description)||target.candidate_canonical_ids.length!==1)continue;
  const candidate=target.candidate_canonical_ids[0];if(db.prepare('SELECT 1 ok FROM npc_definitions WHERE canonical_id=?').get(candidate))return {target_canonical_id:target.canonical_id,npc_canonical_id:candidate,evidence:'combat verb + unique NPC candidate'};
}return null;}
function inferChainItem(task,catalog){for(const target of task.targets.filter((entry)=>entry.target_kind==='item'&&!entry.entity_canonical_id)){
  for(const prerequisiteId of task.prerequisites){const prerequisite=catalog.getTask(prerequisiteId);if(!prerequisite)continue;
    if(prerequisite.rewards.some((reward)=>reward.reward_name===target.raw_name)||String(prerequisite.description).includes(target.raw_name)||String(task.description).includes(`已经获得${target.raw_name}`))
      return {target_canonical_id:target.canonical_id,item_name:target.raw_name,source_task_canonical_id:prerequisiteId,evidence:'prerequisite reward or adjacent task text'};
  }
}return null;}
function inferDescribedDrop(task,db){for(const target of task.targets.filter((entry)=>entry.target_kind==='item'&&!entry.entity_canonical_id)){
  const encounters=encountersAt(db,task.target_location_canonical_id).map((entry)=>({...entry,score:descriptionMatchScore(task.description,target.raw_name,entry.display_name)}))
    .filter((entry)=>entry.score>0).sort((a,b)=>b.score-a.score||a.canonical_id.localeCompare(b.canonical_id));
  if(encounters.length&&(!encounters[1]||encounters[0].score>encounters[1].score))return {target_canonical_id:target.canonical_id,item_name:target.raw_name,
    monster_canonical_id:encounters[0].canonical_id,monster_name:encounters[0].display_name,evidence:'unique task text or lexical encounter match'};
}return null;}
function descriptionMatchScore(description,itemName,monsterName){let score=0;const normalized=String(monsterName).replace(/(王|头领|首领|统领|精英)$/,'');
  if(description.includes(monsterName))score+=100;if(normalized&&description.includes(normalized))score+=70;
  const common=longestCommonSubstring(String(itemName),String(monsterName));if(common.length>=2)score+=common.length*10;return score;}
function longestCommonSubstring(a,b){let best='';for(let i=0;i<a.length;i++)for(let j=i+1;j<=a.length;j++){const part=a.slice(i,j);if(part.length>best.length&&b.includes(part))best=part;}return best;}
function routeWaypointEvidence(task,maritime){const requiredCities=new Set([task.raw_receive_location,task.raw_submit_location,task.raw_target_location].filter(Boolean).map((x)=>String(x).replace(/(云霄阁|御剑阁|望尘居|何花亭|碧云轩|码头|黄龙山|凤凰居).*$/,'')));
  return maritime.sailing.route_encounters.some((entry)=>requiredCities.has(entry.location)||String(task.description).includes(entry.location));}
function encountersAt(db,locationId){if(!locationId)return[];return db.prepare(`SELECT m.canonical_id,m.display_name,m.level,m.monster_type FROM monster_placements p
  JOIN monster_definitions m ON m.id=p.monster_definition_id JOIN locations l ON l.id=p.location_id
  WHERE l.canonical_id=? AND p.runtime_capability='queryable' ORDER BY m.canonical_id`).all(locationId);}
function buildEvidence(task,meta,sourceEvidenceByRecord,conflictBySubject){const sources=sourceEvidenceByRecord.get(Number(meta.source_record_id))??[];
  return {sources,repositories:[...new Set(sources.map((entry)=>entry.repository))].sort(),confidence:meta.confidence??'unknown',
    conflicts:conflictBySubject.get(task.source_canonical_id)??[],restoration_status:meta.restoration_status,originality_status:meta.originality_status,decision_reason:meta.decision_reason};}
function loadSourceEvidence(db){const rows=db.prepare(`SELECT restoration_record_id,source_repository repository,source_path path,source_locator locator,source_commit source_commit,
  original_value_summary FROM source_evidence ORDER BY restoration_record_id,source_repository,source_path,source_locator`).all();return groupMap(rows,'restoration_record_id');}
function buildLocationBundle(task,locations,coordinates){const toRef=(id,role)=>{const row=locations.get(id);if(!row)return id?{role,canonical_id:id,missing:true}:null;
  return {role,canonical_id:id,display_name:row.display_name,city_canonical_id:row.city_canonical_id,city_display_name:row.city_display_name,
    coordinate:coordinates[String(row.city_display_name).replace('(PK)','')]??null,map_node_canonical_id:row.map_node_canonical_id,node_kind:row.node_kind};};
  return {receive:toRef(task.receive_location_canonical_id,'receive'),target:toRef(task.target_location_canonical_id,'target'),submit:toRef(task.submit_location_canonical_id,'submit'),
    entrances:task.steps.filter((entry)=>entry.location_canonical_id).map((entry)=>toRef(entry.location_canonical_id,'step')).filter(Boolean)};}
function executorsFor(task,closure){const result=['TaskRuntimeEngine'];const kinds=new Set(task.targets.map((entry)=>entry.target_kind));
  if(kinds.has('npc')||task.task_type==='对话')result.push('NpcInteractionExecutor');if(kinds.has('monster'))result.push('CombatRuntime');
  if(kinds.has('item'))result.push(task.task_type==='送物品'||task.task_type==='运货'?'DeliveryExecutor':'ItemAcquisitionExecutor');
  if(kinds.has('location'))result.push('MovementExecutor');if(closure.runtime_item_resolutions.some((x)=>['shop','market'].includes(x.formal_source.source_kind)))result.push('EconomyRuntime');
  if(closure.evidence.required_cities?.length>1)result.push('VoyageRuntime');return[...new Set(result)];}
function extractCondition(task,kind){const value=task.normalized_value??{};if(kind==='profession')return value.profession??value.job??null;if(kind==='equipment')return value.equipment??null;
  return value.state_flags??value.flags??null;}
function entityRef(canonicalId,rawName){return {canonical_id:canonicalId,raw_name:rawName};}
function targetRef(target){return {canonical_id:target.canonical_id,kind:target.target_kind,raw_name:target.raw_name,quantity:target.required_quantity,
  entity_canonical_id:target.entity_canonical_id,resolution_status:target.resolution_status,runtime_resolution:target.runtime_resolution??null};}
function summarizeClasses(tasks,seriesById){return Object.entries(fittingLabels).map(([id,name])=>{const entries=tasks.filter((entry)=>entry.class_id===Number(id));
  return {class_id:Number(id),class_name:name,count:entries.length,task_canonical_ids:entries.map((entry)=>entry.canonical_id),
    affected_series:[...new Set(entries.map((entry)=>entry.series_canonical_id))].sort().map((seriesId)=>({canonical_id:seriesId,display_name:seriesById.get(seriesId)?.display_name??seriesId,count:entries.filter((x)=>x.series_canonical_id===seriesId).length})),
    reason_codes:[...new Set(entries.flatMap((entry)=>entry.reason_codes))].sort()};});}
function buildExceptionClusters(remaining,seriesById){const groups=new Map();for(const task of remaining.filter((entry)=>entry.class_id>=5)){
  const key=task.affected_shared_systems[0]??task.reason_codes[0]??'unclassified';const entries=groups.get(key)??[];entries.push(task);groups.set(key,entries);}
  return [...groups.entries()].map(([key,entries])=>{const series=[...new Set(entries.map((x)=>x.series_canonical_id))].sort();const evidenceStrength=entries.every((x)=>x.evidence_repositories.length)?4:2;
    const implementationCost=key.includes('waypoint')?3:key.includes('duel')?3:key.includes('ledger')?2:key.includes('drop')?2:4;
    const architectureConsistency=key.includes('data_')?2:5;const score=entries.length*100+series.length*20+architectureConsistency*15+evidenceStrength*10-implementationCost*10;
    return {cluster_id:`exception.${key}`,display_name:key,task_count:entries.length,task_canonical_ids:entries.map((x)=>x.canonical_id),
      affected_series:series.map((id)=>({canonical_id:id,display_name:seriesById.get(id)?.display_name??id})),class_ids:[...new Set(entries.map((x)=>x.class_id))].sort(),
      reason_codes:[...new Set(entries.flatMap((x)=>x.reason_codes))].sort(),priority_inputs:{coverage:entries.length,cross_series_reuse:series.length,
        architecture_consistency:architectureConsistency,evidence_strength:evidenceStrength,implementation_cost:implementationCost},priority_score:score};
  }).sort((a,b)=>b.priority_score-a.priority_score||a.cluster_id.localeCompare(b.cluster_id));}
function buildRuleCoverage(rules,tasks,total,validated,development){return rules.rules.map((rule)=>({rule_id:rule.id,domain:rule.domain,
  observed_task_count:rule.id==='catalog.existence-separation'?total:rule.id==='structure.contextual-npc'?tasks.filter((x)=>x.npcs.contextual_definitions.length).length:
    rule.id==='structure.target-executors'?tasks.filter((x)=>x.objectives.length).length:rule.id.startsWith('state.')?development:rule.id.startsWith('combat.')?tasks.filter((x)=>x.runtime_executors.includes('CombatRuntime')).length:validated,
  sample_task_canonical_ids:tasks.filter((x)=>rule.id==='structure.contextual-npc'?x.npcs.contextual_definitions.length:true).slice(0,5).map((x)=>x.canonical_id)}));}
function loadValidatedIds(){const fixture=readJson(path.join(root,'data','runtime','accepted-stage-start-78.json'));const evidence=readJson(path.join(root,fixture.completed_task_evidence.path));
  if(Array.isArray(evidence.completed_task_canonical_ids))return new Set(evidence.completed_task_canonical_ids);
  return new Set(Object.entries(evidence.state?.tasks??{}).filter(([,value])=>value.status==='completed').map(([id])=>id));}
function countBy(values,key){return Object.fromEntries([...new Set(values.map((entry)=>entry[key]))].sort().map((value)=>[value,values.filter((entry)=>entry[key]===value).length]));}
function groupMap(values,key){const map=new Map();for(const value of values){const id=value[key];const entries=map.get(id)??[];entries.push(value);map.set(id,entries);}return map;}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`,'utf8');}

if(require.main===module)main();
module.exports={buildExceptionClusters,classifyTask,directoryStatusFor,fittingLabels};
