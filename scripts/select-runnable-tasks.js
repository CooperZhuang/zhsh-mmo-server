'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const { DatabaseSync }=require('node:sqlite');
const { SqliteTaskCatalog,monsterExperience,planEquipmentAcquisition,planTrainingPath,sampleCombatWithStamina,staminaItemSemantics }=require('../src/task-runtime');
const { LEVEL_THRESHOLDS }=require('../src/task-runtime/gameplay-state');
const {generationMetadata}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const defaults={
  databasePath:path.join(root,'data','zhsh-content.sqlite'),
  matrixPath:path.join(root,'data','generated','task-playability-matrix.json'),
  coordinatesPath:path.join(root,'data','runtime','city-coordinates.json'),
  exclusionsPath:path.join(root,'data','runtime','runnable-task-exclusions.json'),
  monsterItemSourcesPath:path.join(root,'data','runtime','monster-item-sources.json'),
  maritimeCapabilitiesPath:path.join(root,'data','runtime','maritime-capabilities.json'),
  rewardRulesPath:path.join(root,'data','runtime','monster-reward-rules.json'),
  progressionRulesPath:path.join(root,'data','runtime','progression-rules.json'),
  formalStageStartPath:path.join(root,'data','runtime','accepted-stage-start-78.json'),
  equipmentAnalysisPath:path.join(root,'data','generated','equipment-acquisition-analysis.json'),
  combatSurvivalAnalysisPath:path.join(root,'data','generated','combat-survival-analysis.json'),
  outputPath:path.join(root,'data','generated','runnable-task-selection.json'),
};
const selectorVersion='5.0.0';
const defaultModuleFlags=Object.freeze({training_session_continuation:true,task_described_item_sources:true,
  task_target_kind_normalization:true,route_waypoint_destinations:true,projected_task_entry_combat_state:true});
const supportedTargetKinds=new Set(['npc','monster','item','location']);
const taskGeneratedItemTypes=new Set(['送物品']);

function selectRunnableTasks(options={}) {
  const moduleFlags={...defaultModuleFlags,...(options.moduleFlags??{})};
  const paths={ ...defaults,...options };delete paths.moduleFlags;
  const db=new DatabaseSync(paths.databasePath,{ readOnly:true });
  try {
    const matrix=readJson(paths.matrixPath);
    const coordinates=readJson(paths.coordinatesPath);
    const exclusions=readJson(paths.exclusionsPath);
    const monsterItemSources=readJson(paths.monsterItemSourcesPath);
    const maritimeCapabilities=readJson(paths.maritimeCapabilitiesPath);
    const rewardRules=readJson(paths.rewardRulesPath);
    const progressionRules=applyModuleFlags(readJson(paths.progressionRulesPath),moduleFlags);
    const formalStageStart=loadFormalStageStart(paths.formalStageStartPath);
    validateInputs(matrix,coordinates,exclusions,monsterItemSources,rewardRules,maritimeCapabilities,progressionRules,formalStageStart);
    const analysis=analyze(db,{ matrix,coordinates:coordinates.coordinates,exclusions:exclusions.exclusions,monsterItemSourceData:monsterItemSources,rewardRules,maritimeCapabilities,progressionRules,formalStageStart,moduleFlags });
    const equipmentAnalysis={schema_version:1,record_kind:'equipment-acquisition-analysis',...generationMetadata('equipment-acquisition-planner/1.0.0'),
      stage_start_selected_task_count:formalStageStart.selected_task_count,plans:analysis.equipmentAcquisitionPlans};
    writeJsonIfChanged(paths.equipmentAnalysisPath,equipmentAnalysis);
    const combatSurvivalAnalysis={schema_version:1,record_kind:'combat-survival-analysis',...generationMetadata('combat-survival-planner/1.0.0'),
      stage_start_selected_task_count:formalStageStart.selected_task_count,...analysis.combatSurvivalAnalysis};
    writeJsonIfChanged(paths.combatSurvivalAnalysisPath,combatSurvivalAnalysis);
    const body={
      selector_version:selectorVersion,
      ...generationMetadata(`runnable-task-selector/${selectorVersion}`),
      input_evidence:{
        database:path.relative(root,paths.databasePath).replaceAll('\\','/'),
        capability_matrix:path.relative(root,paths.matrixPath).replaceAll('\\','/'),
        city_coordinates:path.relative(root,paths.coordinatesPath).replaceAll('\\','/'),
        runtime_modules:['TaskRuntimeEngine','CombatRuntime','EconomyRuntime','ShipRuntime','VoyageRuntime','MaritimeRuntime','FishingRuntime','DivingRuntime','RecoveryRuntime'],
        exclusions:path.relative(root,paths.exclusionsPath).replaceAll('\\','/'),
        monster_item_sources:path.relative(root,paths.monsterItemSourcesPath).replaceAll('\\','/'),
        maritime_capabilities:path.relative(root,paths.maritimeCapabilitiesPath).replaceAll('\\','/'),
        monster_reward_rules:path.relative(root,paths.rewardRulesPath).replaceAll('\\','/'),
        progression_rules:path.relative(root,paths.progressionRulesPath).replaceAll('\\','/'),
        formal_stage_start:path.relative(root,paths.formalStageStartPath).replaceAll('\\','/'),
        equipment_acquisition_analysis:path.relative(root,paths.equipmentAnalysisPath).replaceAll('\\','/'),
      },
      selection_policy:{
        deterministic_order:'task_series.source_series then task_definitions.sequence_position',
        series_rule:'complete series, otherwise maximal playable prefix from series start',
        combat_state_rule:'evaluate combat roots from the accepted 72-task terminal state; source-backed equipment must be acquired and finite stamina consumables are globally budgeted',
        task_or_count_identifiers_hardcoded:false,
        preview_providers_allowed:false,
        direct_progress_injection_allowed:false,
        active_global_modules:moduleFlags,
      },
      selected_task_count:analysis.selectedTasks.length,
      selected_series_count:analysis.selectedSeries.length,
      selected_series:analysis.selectedSeries,
      selected_tasks:analysis.selectedTasks,
      unselected_tasks:analysis.unselectedTasks,
      resources:analysis.resources,
      level_reachability:analysis.levelReachability,
      level_gate_requirements:analysis.levelGateRequirements,
      manual_exclusions:exclusions.exclusions,
      formal_stage_start:{selected_task_count:formalStageStart.selected_task_count,current_state_lower_bound:formalStageStart.current_state_lower_bound,
        experience_adjudication:formalStageStart.experience_adjudication},
      equipment_acquisition_plan_count:analysis.equipmentAcquisitionPlans.length,
      combat_survival_candidate_count:analysis.combatSurvivalAnalysis.candidates.length,
      combat_survival_chosen_allocation:analysis.combatSurvivalAnalysis.chosen_allocation,
    };
    const selectionHash=sha256(stableJson(selectionHashPayload(body)));
    const output={ ...body,selection_hash:selectionHash };
    const serialized=`${JSON.stringify(output,null,2)}\n`;
    fs.mkdirSync(path.dirname(paths.outputPath),{ recursive:true });
    if(!fs.existsSync(paths.outputPath)||fs.readFileSync(paths.outputPath,'utf8')!==serialized)fs.writeFileSync(paths.outputPath,serialized,'utf8');
    return output;
  } finally { db.close(); }
}

function evaluateAllTasks(options={}) {
  const moduleFlags={...defaultModuleFlags,...(options.moduleFlags??{})};
  const paths={...defaults,...options};delete paths.moduleFlags;
  const db=new DatabaseSync(paths.databasePath,{readOnly:true});
  try{
    const matrix=readJson(paths.matrixPath);
    const coordinates=readJson(paths.coordinatesPath);
    const exclusions=readJson(paths.exclusionsPath);
    const monsterItemSourceData=readJson(paths.monsterItemSourcesPath);
    const maritimeCapabilities=readJson(paths.maritimeCapabilitiesPath);
    const rewardRules=readJson(paths.rewardRulesPath);
    const progressionRules=applyModuleFlags(readJson(paths.progressionRulesPath),moduleFlags);
    const formalStageStart=loadFormalStageStart(paths.formalStageStartPath);
    validateInputs(matrix,coordinates,exclusions,monsterItemSourceData,rewardRules,maritimeCapabilities,progressionRules,formalStageStart);

    const catalog=new SqliteTaskCatalog(db);
    const matrixByTask=new Map(matrix.tasks.map((entry)=>[entry.task_canonical_id,entry]));
    const exclusionByTask=new Map(exclusions.exclusions.map((entry)=>[entry.canonical_id,entry]));
    const locations=loadLocations(db);
    const mapLocations=new Set(db.prepare(`SELECT l.canonical_id FROM map_nodes mn JOIN locations l ON l.id=mn.location_id WHERE mn.runtime_capability='queryable'`).all().map((row)=>row.canonical_id));
    const npcPlacements=new Set(db.prepare(`SELECT n.canonical_id npc,l.canonical_id location FROM npc_placements p JOIN npc_definitions n ON n.id=p.npc_definition_id JOIN locations l ON l.id=p.location_id WHERE p.runtime_capability='queryable'`).all().map((row)=>`${row.npc}|${row.location}`));
    const monsterPlacementRows=db.prepare(`SELECT m.canonical_id monster_canonical_id,m.display_name monster_name,m.monster_type,m.level,
      l.canonical_id location_canonical_id FROM monster_placements p JOIN monster_definitions m ON m.id=p.monster_definition_id
      JOIN locations l ON l.id=p.location_id WHERE p.runtime_capability='queryable' ORDER BY l.canonical_id,m.canonical_id`).all();
    const monsterPlacements=new Set(monsterPlacementRows.map((row)=>`${row.monster_canonical_id}|${row.location_canonical_id}`));
    const allMonsterEncountersByLocation=groupMap(monsterPlacementRows,'location_canonical_id');
    const monsterEncountersByLocation=moduleFlags.task_described_item_sources?allMonsterEncountersByLocation:new Map();
    const monsters=new Map(db.prepare('SELECT canonical_id,display_name,monster_type,level FROM monster_definitions').all().map((row)=>[row.canonical_id,row]));
    const ports=loadPorts(db,coordinates.coordinates);
    const itemSources=loadItemSources(db,locations);
    const marketSources=loadMarketSources(db,locations);
    const maritimeCoastalSources=maritimeCapabilities.diving.coastal_item_sources.map((entry)=>({monster_name:entry.monster_name,item_name:entry.item_name}));
    const monsterItemSources=loadMonsterItemSources(db,{...monsterItemSourceData,sources:[...monsterItemSourceData.sources,...maritimeCoastalSources]});
    const fishingItemSources=loadFishingItemSources(db,maritimeCapabilities,ports);
    const divingItemSources=loadDivingItemSources(db,maritimeCapabilities,ports);
    const routeWaypointDestinations=moduleFlags.route_waypoint_destinations?loadRouteWaypointDestinations(maritimeCapabilities):new Map();
    const unresolvedConflicts=loadUnresolvedConflicts(db);
    const seriesRows=db.prepare('SELECT canonical_id,display_name,source_series FROM task_series ORDER BY source_series').all();
    const tasks=[];
    for(const series of seriesRows){
      for(const task of catalog.listSeriesTasks(series.canonical_id)){
        if(!matrixByTask.has(task.canonical_id))throw new Error(`Capability matrix task missing: ${task.canonical_id}`);
        const closure=evaluateTask(task,{exclusion:exclusionByTask.get(task.canonical_id),locations,mapLocations,npcPlacements,
          monsterPlacements,monsterEncountersByLocation,monsters,ports,itemSources,marketSources,monsterItemSources,fishingItemSources,divingItemSources,
          routeWaypointDestinations,taskTargetKindNormalization:moduleFlags.task_target_kind_normalization,unresolvedConflicts});
        tasks.push({canonical_id:task.canonical_id,series_canonical_id:series.canonical_id,sequence_position:task.sequence_position,
          direct_fit:closure.blocking_reasons.length===0,blocking_reasons:closure.blocking_reasons,
          runtime_item_resolutions:closure.runtime_item_resolutions,evidence:closure.evidence});
      }
    }
    return {task_count:tasks.length,module_flags:moduleFlags,tasks};
  }finally{db.close();}
}

function analyze(db,{ matrix,coordinates,exclusions,monsterItemSourceData,rewardRules,maritimeCapabilities,progressionRules,formalStageStart,moduleFlags={} }) {
  moduleFlags={...defaultModuleFlags,...moduleFlags};
  const catalog=new SqliteTaskCatalog(db);
  const matrixByTask=new Map(matrix.tasks.map((entry)=>[entry.task_canonical_id,entry]));
  const exclusionByTask=new Map(exclusions.map((entry)=>[entry.canonical_id,entry]));
  const locations=loadLocations(db);
  const mapLocations=new Set(db.prepare(`SELECT l.canonical_id FROM map_nodes mn JOIN locations l ON l.id=mn.location_id WHERE mn.runtime_capability='queryable'`).all().map((row)=>row.canonical_id));
  const npcPlacements=new Set(db.prepare(`SELECT n.canonical_id npc,l.canonical_id location FROM npc_placements p JOIN npc_definitions n ON n.id=p.npc_definition_id JOIN locations l ON l.id=p.location_id WHERE p.runtime_capability='queryable'`).all().map((row)=>`${row.npc}|${row.location}`));
  const monsterPlacementRows=db.prepare(`SELECT m.canonical_id monster_canonical_id,m.display_name monster_name,m.monster_type,m.level,
    l.canonical_id location_canonical_id FROM monster_placements p JOIN monster_definitions m ON m.id=p.monster_definition_id
    JOIN locations l ON l.id=p.location_id WHERE p.runtime_capability='queryable' ORDER BY l.canonical_id,m.canonical_id`).all();
  const monsterPlacements=new Set(monsterPlacementRows.map((row)=>`${row.monster_canonical_id}|${row.location_canonical_id}`));
  const allMonsterEncountersByLocation=groupMap(monsterPlacementRows,'location_canonical_id');
  const monsterEncountersByLocation=moduleFlags.task_described_item_sources?allMonsterEncountersByLocation:new Map();
  const monsters=new Map(db.prepare('SELECT canonical_id,display_name,monster_type,level FROM monster_definitions').all().map((row)=>[row.canonical_id,row]));
  const ports=loadPorts(db,coordinates);
  const itemSources=loadItemSources(db,locations);
  const marketSources=loadMarketSources(db,locations);
  const maritimeCoastalSources=maritimeCapabilities.diving.coastal_item_sources.map((entry)=>({monster_name:entry.monster_name,item_name:entry.item_name}));
  const monsterItemSources=loadMonsterItemSources(db,{...monsterItemSourceData,sources:[...monsterItemSourceData.sources,...maritimeCoastalSources]});
  const fishingItemSources=loadFishingItemSources(db,maritimeCapabilities,ports);
  const divingItemSources=loadDivingItemSources(db,maritimeCapabilities,ports);
  const routeWaypointDestinations=moduleFlags.route_waypoint_destinations?loadRouteWaypointDestinations(maritimeCapabilities):new Map();
  const maritimeMonsters=new Map([...divingItemSources.values()].flat().map((entry)=>[entry.monster_canonical_id,entry.monster]));
  const unresolvedConflicts=loadUnresolvedConflicts(db);
  const equipmentAcquisitions=loadEquipmentAcquisitions(db);
  const seriesRows=db.prepare('SELECT canonical_id,display_name,source_series FROM task_series ORDER BY source_series').all();
  let selectedTasks=[];const unselectedTasks=[];const equipmentAcquisitionPlans=new Map();

  for(const series of seriesRows) {
    const tasks=catalog.listSeriesTasks(series.canonical_id);
    let prefixOpen=true;let firstBlocker=null;const selectedInSeries=[];
    for(const task of tasks) {
      const matrixEntry=matrixByTask.get(task.canonical_id);
      if(!matrixEntry)throw new Error(`Capability matrix task missing: ${task.canonical_id}`);
      const closure=evaluateTask(task,{ exclusion:exclusionByTask.get(task.canonical_id),locations,mapLocations,npcPlacements,
        monsterPlacements,monsterEncountersByLocation,monsters,ports,itemSources,marketSources,monsterItemSources,fishingItemSources,divingItemSources,
        routeWaypointDestinations,taskTargetKindNormalization:moduleFlags.task_target_kind_normalization,unresolvedConflicts });
      if(!prefixOpen)closure.blocking_reasons.unshift({ code:'series_prefix_blocked',blocked_by:firstBlocker });
      const prerequisiteGap=task.prerequisites.filter((id)=>!selectedInSeries.includes(id));
      if(prerequisiteGap.length)closure.blocking_reasons.unshift({ code:'prerequisite_not_selected',canonical_ids:prerequisiteGap });
      const selected=prefixOpen&&closure.blocking_reasons.length===0&&prerequisiteGap.length===0;
      if(selected) {
        selectedInSeries.push(task.canonical_id);
        selectedTasks.push({ canonical_id:task.canonical_id,series_canonical_id:series.canonical_id,sequence_position:task.sequence_position,
          selection_reason:tasks.length===1?'complete_independent_series':'maximal_continuous_series_prefix',
          evidence:closure.evidence,runtime_item_resolutions:closure.runtime_item_resolutions });
      } else {
        if(prefixOpen){prefixOpen=false;firstBlocker=task.canonical_id;}
        unselectedTasks.push({ canonical_id:task.canonical_id,series_canonical_id:series.canonical_id,sequence_position:task.sequence_position,
          blocking_reasons:closure.blocking_reasons,evidence:closure.evidence });
      }
    }
  }
  const stageTaskIds=new Set(formalStageStart.completed_task_canonical_ids);
  const stageSelectedTasks=selectedTasks.filter((entry)=>stageTaskIds.has(entry.canonical_id));
  if(stageSelectedTasks.length!==stageTaskIds.size)throw new Error(`Accepted stage start is not a subset of the source-closed selector candidates: ${stageSelectedTasks.length}/${stageTaskIds.size}`);
  const stageResources=collectSelectedResources(db,stageSelectedTasks,catalog,locations,ports,itemSources);
  const stageCityIds=new Set(stageResources.city_canonical_ids);
  const stageReachableLocationIds=[...locations.values()].filter((entry)=>stageCityIds.has(entry.city_canonical_id)&&mapLocations.has(entry.canonical_id))
    .map((entry)=>entry.canonical_id).sort();
  const stageCurrentState={...formalStageStart.current_state_lower_bound,completed_task_canonical_ids:formalStageStart.completed_task_canonical_ids};
  let resources;let levelReachability;let taskEntryLevels={};
  while(true) {
    resources=collectSelectedResources(db,selectedTasks,catalog,locations,ports,itemSources);
    const reachability=buildLevelReachability(db,selectedTasks,catalog,resources,rewardRules,progressionRules);
    if(!reachability.anomaly) {
      const itemCombatFailure=selectedTasks.map((entry)=>{
        if(stageTaskIds.has(entry.canonical_id))return null;
        const task=catalog.getTask(entry.canonical_id);
        const scheduledPlayerLevel=moduleFlags.projected_task_entry_combat_state
          ?Math.max(Number(stageCurrentState.level),Number(reachability.taskEntryLevels[entry.canonical_id]??stageCurrentState.level))
          :Number(stageCurrentState.level);
        const taskEntryState={...stageCurrentState,level:scheduledPlayerLevel};
        const itemRequirements=entry.runtime_item_resolutions.filter((resolution)=>['monster_drop','diving_dungeon_drop'].includes(resolution.formal_source.source_kind))
          .map((resolution)=>({origin:'item_source',target_canonical_id:resolution.target_canonical_id,
            monster_canonical_id:resolution.formal_source.monster_canonical_id,location_canonical_id:resolution.formal_source.location_canonical_id}));
        const bossRequirements=task.targets.filter((target)=>target.target_kind==='monster'&&[6,45,55].includes(Number(monsters.get(target.entity_canonical_id)?.monster_type)))
          .map((target)=>({origin:'task_target',target_canonical_id:target.canonical_id,monster_canonical_id:target.entity_canonical_id,
            location_canonical_id:task.target_location_canonical_id}));
        const acquisitionProofs=[...itemRequirements,...bossRequirements].map((requirement)=>{
            const resolvedMonster=monsters.get(requirement.monster_canonical_id)??maritimeMonsters.get(requirement.monster_canonical_id);
            const acquisitionPlan=planEquipmentAcquisition({current_state:taskEntryState,target_monster:resolvedMonster,
              equipment_candidates:equipmentAcquisitions,reachable_location_canonical_ids:stageReachableLocationIds,
              source_confidence:'SOURCE_EXPLICIT',compatibility_experience_dependency:true});
            const planId=`equipment.acquisition.${shortHash(`${entry.canonical_id}|${requirement.target_canonical_id}|${requirement.monster_canonical_id}`)}`;
            equipmentAcquisitionPlans.set(planId,{canonical_id:planId,task_canonical_id:entry.canonical_id,target_canonical_id:requirement.target_canonical_id,
              target_origin:requirement.origin,monster_canonical_id:requirement.monster_canonical_id,plan:acquisitionPlan});
            const proof={...acquisitionPlan.target_combat_proof,closed:acquisitionPlan.closed,acquisition_closed:acquisitionPlan.acquisition_closed,
              target_combat_closed:acquisitionPlan.target_combat_closed,acquisition_plan:summarizeAcquisitionPlan(planId,acquisitionPlan),
              reason:acquisitionPlan.closed?null:acquisitionPlan.unclosed_reasons[0]?.code??'equipment_acquisition_not_closed'};
            return {origin:requirement.origin,target_canonical_id:requirement.target_canonical_id,monster_canonical_id:requirement.monster_canonical_id,
              monster_level:Number(resolvedMonster?.level??Infinity),scheduled_player_level:scheduledPlayerLevel,
              location_canonical_id:requirement.location_canonical_id,combat_proof:proof};
          });
        if(acquisitionProofs.length)entry.evidence.equipment_acquisition_proofs=acquisitionProofs;
        const violations=acquisitionProofs.filter((violation)=>!violation.combat_proof.closed);
        return violations.length?{entry,violations}:null;
      }).filter(Boolean).sort((a,b)=>a.entry.series_canonical_id.localeCompare(b.entry.series_canonical_id)||a.entry.sequence_position-b.entry.sequence_position)[0];
      if(!itemCombatFailure) { levelReachability=reachability.gates;taskEntryLevels=reachability.taskEntryLevels;break; }
      replaceSeriesTailWithBlocker({catalog,selectedTasks,unselectedTasks,seriesId:itemCombatFailure.entry.series_canonical_id,
        rootSequencePosition:itemCombatFailure.entry.sequence_position,rootTaskCanonicalId:itemCombatFailure.entry.canonical_id,
        rootBlockingReason:{code:itemCombatFailure.violations.some((violation)=>violation.origin==='task_target')?'combat_loadout_not_closed':'item_source_combat_not_closed',
          requirements:itemCombatFailure.violations,
          evidence_rule:'source-backed equipment acquisition, formal source stats and damage formula must prove the scheduled player wins a deterministic best-play encounter before defeat'},
        rootEvidence:itemCombatFailure.entry.evidence,rootRuntimeItemResolutions:itemCombatFailure.entry.runtime_item_resolutions});
      continue;
    }
    const playableIds=new Set(reachability.processedTaskIds);
    const removed=selectedTasks.filter((entry)=>!playableIds.has(entry.canonical_id));
    if(!removed.length)throw new Error(`Level closure could not make progress: ${JSON.stringify(reachability.anomaly)}`);
    const firstRemovedBySeries=new Map();
    for(const entry of removed)if(!firstRemovedBySeries.has(entry.series_canonical_id))firstRemovedBySeries.set(entry.series_canonical_id,entry);
    for(const [seriesId,first] of firstRemovedBySeries)replaceSeriesTailWithBlocker({catalog,selectedTasks,unselectedTasks,seriesId,
      rootSequencePosition:first.sequence_position,rootTaskCanonicalId:first.canonical_id,
      rootBlockingReason:{code:'level_balance_anomaly',required_level:Number(catalog.getTask(first.canonical_id).level_requirement??1),details:reachability.anomaly},
      rootEvidence:first.evidence,rootRuntimeItemResolutions:first.runtime_item_resolutions});
  }
  const combatSurvivalAnalysis=applyStaminaCombatExtension({db,catalog,seriesRows,selectedTasks,unselectedTasks,formalStageStart,
    equipmentAcquisitions,equipmentAcquisitionPlans,stageCurrentState,stageReachableLocationIds,locations,mapLocations,npcPlacements,
    monsterPlacements,monsterEncountersByLocation,monsters,ports,itemSources,marketSources,monsterItemSources,fishingItemSources,divingItemSources,unresolvedConflicts,
    maritimeMonsters,taskEntryLevels,moduleFlags});
  resources=collectSelectedResources(db,selectedTasks,catalog,locations,ports,itemSources);
  const postExtensionReachability=buildLevelReachability(db,selectedTasks,catalog,resources,rewardRules,progressionRules);
  if(postExtensionReachability.anomaly)throw new Error(`Combat survival extension introduced an unsupported level anomaly: ${JSON.stringify(postExtensionReachability.anomaly)}`);
  levelReachability=postExtensionReachability.gates;
  const selectedSeries=seriesRows.map((series)=>{
    const seriesTasks=catalog.listSeriesTasks(series.canonical_id);const entries=selectedTasks.filter((entry)=>entry.series_canonical_id===series.canonical_id);
    return entries.length?{ canonical_id:series.canonical_id,display_name:series.display_name,selected_task_count:entries.length,total_task_count:seriesTasks.length,
      selection_kind:entries.length===seriesTasks.length?'complete_series':'maximal_continuous_prefix',terminal_task_canonical_id:entries.at(-1).canonical_id }:null;
  }).filter(Boolean);
  unselectedTasks.sort((a,b)=>seriesRows.findIndex((entry)=>entry.canonical_id===a.series_canonical_id)-seriesRows.findIndex((entry)=>entry.canonical_id===b.series_canonical_id)
    ||Number(a.sequence_position)-Number(b.sequence_position));
  const levelGateRequirements=unique(selectedTasks.map((entry)=>Number(catalog.getTask(entry.canonical_id).level_requirement??1))).sort((a,b)=>a-b).map((requiredLevel)=>({
    required_level:requiredLevel,closure_status:'closed',scheduled_repeatable_encounter_segment:levelReachability.find((entry)=>entry.required_level===requiredLevel)??null,
    reward_rule_id:rewardRules.rule_id,balance_anomaly:false,
  }));
  for(const selected of selectedTasks)selected.evidence.level_closure=levelGateRequirements.find((entry)=>entry.required_level===Number(catalog.getTask(selected.canonical_id).level_requirement??1));
  return { selectedTasks,unselectedTasks,selectedSeries,resources,levelReachability,levelGateRequirements,
    equipmentAcquisitionPlans:[...equipmentAcquisitionPlans.values()].sort((a,b)=>a.canonical_id.localeCompare(b.canonical_id)),combatSurvivalAnalysis };
}


function applyStaminaCombatExtension(context) {
  const {db,catalog,seriesRows,selectedTasks,unselectedTasks,formalStageStart,equipmentAcquisitions,equipmentAcquisitionPlans,stageCurrentState,
    stageReachableLocationIds,locations,mapLocations,npcPlacements,monsterPlacements,monsterEncountersByLocation,monsters,ports,itemSources,marketSources,monsterItemSources,
    fishingItemSources,divingItemSources,unresolvedConflicts,maritimeMonsters,taskEntryLevels,moduleFlags}=context;
  const acceptedMoney=Number(formalStageStart.current_state_lower_bound.money??0);
  const staminaSource=loadStaminaSource(db,stageReachableLocationIds,acceptedMoney);
  if(!staminaSource)return {planner_rule_id:'zhsh.combat-survival.stamina-allocation.v1',stamina_source:null,candidates:[],chosen_allocation:null,
    money_ledger:{starting_money:Number(formalStageStart.current_state_lower_bound.money??0),remaining_money:Number(formalStageStart.current_state_lower_bound.money??0)},
    unresolved_modules:combatSurvivalUnresolvedModules()};
  const baselineCount=selectedTasks.length;const selectedIds=new Set(selectedTasks.map((entry)=>entry.canonical_id));
  const firstUnselectedBySeries=new Map();
  for(const entry of [...unselectedTasks].sort((a,b)=>a.series_canonical_id.localeCompare(b.series_canonical_id)||a.sequence_position-b.sequence_position))
    if(!firstUnselectedBySeries.has(entry.series_canonical_id))firstUnselectedBySeries.set(entry.series_canonical_id,entry);
  const equipmentById=new Map(equipmentAcquisitions.map((entry)=>[entry.canonical_id,entry]));
  const candidates=[];
  for(const entry of firstUnselectedBySeries.values()){
    const combatReason=entry.blocking_reasons.find((reason)=>['combat_loadout_not_closed','item_source_combat_not_closed'].includes(reason.code));
    if(!combatReason)continue;
    const scheduledPlayerLevel=moduleFlags.projected_task_entry_combat_state
      ?Math.max(Number(stageCurrentState.level),Number(taskEntryLevels[entry.canonical_id]??stageCurrentState.level))
      :Number(stageCurrentState.level);
    const proofs=(combatReason.requirements??[]).map((requirement)=>{
      const monster=monsters.get(requirement.monster_canonical_id)??maritimeMonsters.get(requirement.monster_canonical_id);
      const loadout=(requirement.combat_proof?.acquisition_plan?.actual_loadout??[]).map((item)=>equipmentById.get(item.canonical_id)).filter(Boolean);
      return {target_canonical_id:requirement.target_canonical_id,origin:requirement.origin,monster_canonical_id:requirement.monster_canonical_id,
        scheduled_player_level:scheduledPlayerLevel,acquisition_closed:Boolean(requirement.combat_proof?.acquisition_closed),base_closed:Boolean(requirement.combat_proof?.closed),
        proof:sampleCombatWithStamina({player_level:scheduledPlayerLevel,monster,actual_loadout:loadout,stamina_item:staminaSource.item})};
    });
    const rootClosed=proofs.length>0&&proofs.every((entry)=>entry.base_closed||(entry.acquisition_closed&&entry.proof.closed));
    const simulation=rootClosed&&staminaSource.available_quantity>0?simulateStaminaSeriesExtension({...context,rootEntry:entry,staminaSource,equipmentById,selectedIds}):
      {newly_selected_tasks:[],selected_task_count:baselineCount,simulated_unlock_delta:0,terminal_task_canonical_id:null,next_blocker:entry.blocking_reasons[0]??null,
        earned_money_from_new_tasks:0,remaining_money:Number(formalStageStart.current_state_lower_bound.money??0)};
    candidates.push({task_canonical_id:entry.canonical_id,series_canonical_id:entry.series_canonical_id,sequence_position:entry.sequence_position,
      prerequisite_reachable:true,source_closed:staminaSource.location_reachable&&staminaSource.available_quantity>0,closes_all_requirements:rootClosed,
      consumables_required:rootClosed?1:0,proofs,simulated_selected_task_count:simulation.selected_task_count,
      simulated_unlock_delta:simulation.simulated_unlock_delta,newly_selected_task_ids:simulation.newly_selected_tasks.map((task)=>task.canonical_id),
      terminal_task_canonical_id:simulation.terminal_task_canonical_id,next_blocker:simulation.next_blocker,
      earned_money_from_new_tasks:simulation.earned_money_from_new_tasks,remaining_money:simulation.remaining_money,_simulation:simulation,_root_entry:entry});
  }
  candidates.sort((a,b)=>b.simulated_unlock_delta-a.simulated_unlock_delta||a.series_canonical_id.localeCompare(b.series_canonical_id)||a.sequence_position-b.sequence_position);
  for(const candidate of candidates.filter((entry)=>entry.closes_all_requirements&&staminaSource.location_reachable&&staminaSource.available_quantity===0)){
    const rootEntry=candidate._root_entry;
    replaceSeriesTailWithBlocker({catalog,selectedTasks,unselectedTasks,seriesId:rootEntry.series_canonical_id,
      rootSequencePosition:rootEntry.sequence_position,rootTaskCanonicalId:rootEntry.canonical_id,
      rootBlockingReason:{task_canonical_id:rootEntry.canonical_id,code:'combat_consumable_budget_exhausted',required_quantity:1,
        available_quantity:0,source_item_canonical_id:staminaSource.item.canonical_id,survival_proofs:candidate.proofs},
      rootEvidence:rootEntry.evidence,rootRuntimeItemResolutions:rootEntry.runtime_item_resolutions});
  }
  const chosen=candidates.find((entry)=>entry.simulated_unlock_delta>0)??null;
  if(chosen)applyChosenStaminaExtension({selectedTasks,unselectedTasks,catalog,chosen});
  const startMoney=Number(formalStageStart.current_state_lower_bound.money??0);const spent=chosen?Number(staminaSource.price):0;
  const earned=chosen?.earned_money_from_new_tasks??0;const remaining=startMoney-spent+earned;
  for(const candidate of candidates){delete candidate._simulation;delete candidate._root_entry;}
  return {planner_rule_id:'zhsh.combat-survival.stamina-allocation.v1',accepted_state:{level:Number(stageCurrentState.level),money:startMoney,
      completed_task_count:Number(formalStageStart.selected_task_count)},stamina_source:{item_canonical_id:staminaSource.item.canonical_id,
      display_name:staminaSource.item.display_name,shop_entry_canonical_id:staminaSource.shop_entry_canonical_id,price:Number(staminaSource.price),
      location_canonical_id:staminaSource.location_canonical_id,location_reachable:staminaSource.location_reachable,
      available_quantity:staminaSource.available_quantity,evidence_status:'SOURCE_EXPLICIT'},baseline_selected_task_count:baselineCount,candidates,
    chosen_allocation:chosen?{task_canonical_id:chosen.task_canonical_id,series_canonical_id:chosen.series_canonical_id,consumables_required:1,
      simulated_unlock_delta:chosen.simulated_unlock_delta,simulated_selected_task_count:chosen.simulated_selected_task_count,
      newly_selected_task_ids:chosen.newly_selected_task_ids}:null,
    money_ledger:{starting_money:startMoney,purchase_cost:spent,earned_money_from_new_tasks:earned,remaining_money:remaining,
      second_purchase_price:Number(staminaSource.price),second_purchase_affordable:remaining>=Number(staminaSource.price),
      remaining_affordable_quantity:Math.floor(Math.max(0,remaining)/Number(staminaSource.price)),next_root_task_canonical_id:chosen?.next_blocker?.task_canonical_id??null,
      rule_ids:['zhsh.shop.trade.v1','zhsh.monster.reward.copper.v1','zhsh.task.complete.v1']},unresolved_modules:combatSurvivalUnresolvedModules()};
}

function simulateStaminaSeriesExtension(context){
  const {catalog,rootEntry,staminaSource,equipmentAcquisitions,equipmentAcquisitionPlans,stageCurrentState,stageReachableLocationIds,
    selectedIds,locations,mapLocations,npcPlacements,monsterPlacements,monsters,ports,itemSources,marketSources,monsterItemSources,
    fishingItemSources,divingItemSources,unresolvedConflicts,maritimeMonsters,equipmentById,monsterEncountersByLocation,taskEntryLevels,moduleFlags}=context;
  const tasks=catalog.listSeriesTasks(rootEntry.series_canonical_id).filter((task)=>task.sequence_position>=rootEntry.sequence_position);
  const localSelected=new Set(selectedIds);let money=Number(stageCurrentState.money??0);let staminaQuantity=Math.floor(money/Number(staminaSource.price));
  const newly=[];let earned=0;let nextBlocker=null;
  for(const task of tasks){
    const structural=evaluateTask(task,{locations,mapLocations,npcPlacements,monsterPlacements,monsters,ports,itemSources,marketSources,
      monsterItemSources,fishingItemSources,divingItemSources,unresolvedConflicts,monsterEncountersByLocation});
    const prerequisiteGap=task.prerequisites.filter((id)=>!localSelected.has(id));
    const taskPlayerLevel=moduleFlags.projected_task_entry_combat_state
      ?Math.max(Number(stageCurrentState.level),Number(taskEntryLevels[task.canonical_id]??taskEntryLevels[rootEntry.canonical_id]??stageCurrentState.level))
      :Number(stageCurrentState.level);
    const taskEntryState={...stageCurrentState,level:taskPlayerLevel,money};
    if(structural.blocking_reasons.length||prerequisiteGap.length||Number(task.level_requirement??1)>taskPlayerLevel){
      nextBlocker={task_canonical_id:task.canonical_id,code:structural.blocking_reasons[0]?.code??(prerequisiteGap.length?'prerequisite_not_selected':'level_requirement_not_closed')};break;
    }
    const requirements=buildTaskCombatRequirements({task,runtimeItemResolutions:structural.runtime_item_resolutions,monsters,maritimeMonsters,
      stageCurrentState:taskEntryState,equipmentAcquisitions,stageReachableLocationIds,equipmentAcquisitionPlans});
    let consumes=0;let failed=null;const survivalProofs=[];
    for(const requirement of requirements){
      if(requirement.acquisitionPlan.closed)continue;
      const loadout=requirement.acquisitionPlan.actual_loadout.map((entry)=>equipmentById.get(entry.canonical_id)).filter(Boolean);
      const proof=sampleCombatWithStamina({player_level:taskPlayerLevel,monster:requirement.monster,actual_loadout:loadout,stamina_item:staminaSource.item});
      survivalProofs.push({target_canonical_id:requirement.target_canonical_id,monster_canonical_id:requirement.monster.canonical_id,proof});
      if(!requirement.acquisitionPlan.acquisition_closed||!proof.closed){failed={task_canonical_id:task.canonical_id,code:requirement.origin==='task_target'?'combat_loadout_not_closed':'item_source_combat_not_closed',proof};break;}
      consumes+=1;
    }
    if(failed){nextBlocker=failed;break;}
    if(consumes>staminaQuantity){nextBlocker={task_canonical_id:task.canonical_id,code:'combat_consumable_budget_exhausted',required_quantity:consumes,
      available_quantity:staminaQuantity,source_item_canonical_id:staminaSource.item.canonical_id,survival_proofs:survivalProofs};break;}
    if(consumes){money-=Number(staminaSource.price)*consumes;staminaQuantity-=consumes;}
    const taskMoneyReward=task.rewards.filter((reward)=>reward.reward_kind==='money').reduce((sum,reward)=>sum+Number(reward.quantity??0),0);
    const combatCopper=task.targets.filter((target)=>target.target_kind==='monster').reduce((sum,target)=>sum+Number(monsters.get(target.entity_canonical_id)?.level??0)*5*Number(target.required_quantity??1),0);
    const moneyReward=taskMoneyReward+combatCopper;
    money+=moneyReward;earned+=moneyReward;localSelected.add(task.canonical_id);
    newly.push({canonical_id:task.canonical_id,series_canonical_id:rootEntry.series_canonical_id,sequence_position:task.sequence_position,
      selection_reason:'source_stamina_combat_continuous_series_prefix',evidence:{...structural.evidence,combat_survival:{consumables_used:consumes,
        stamina_item_canonical_id:consumes?staminaSource.item.canonical_id:null,survival_proofs:survivalProofs}},runtime_item_resolutions:structural.runtime_item_resolutions});
  }
  return {newly_selected_tasks:newly,selected_task_count:selectedIds.size+newly.length,simulated_unlock_delta:newly.length,
    terminal_task_canonical_id:newly.at(-1)?.canonical_id??null,next_blocker:nextBlocker,earned_money_from_new_tasks:earned,remaining_money:money};
}

function buildTaskCombatRequirements({task,runtimeItemResolutions,monsters,maritimeMonsters,stageCurrentState,equipmentAcquisitions,
  stageReachableLocationIds,equipmentAcquisitionPlans}){
  const itemRequirements=runtimeItemResolutions.filter((resolution)=>['monster_drop','diving_dungeon_drop'].includes(resolution.formal_source.source_kind))
    .map((resolution)=>({origin:'item_source',target_canonical_id:resolution.target_canonical_id,monster_canonical_id:resolution.formal_source.monster_canonical_id}));
  const bossRequirements=task.targets.filter((target)=>target.target_kind==='monster'&&[6,45,55].includes(Number(monsters.get(target.entity_canonical_id)?.monster_type)))
    .map((target)=>({origin:'task_target',target_canonical_id:target.canonical_id,monster_canonical_id:target.entity_canonical_id}));
  return [...itemRequirements,...bossRequirements].map((requirement)=>{
    const monster=monsters.get(requirement.monster_canonical_id)??maritimeMonsters.get(requirement.monster_canonical_id);
    const acquisitionPlan=planEquipmentAcquisition({current_state:stageCurrentState,target_monster:monster,equipment_candidates:equipmentAcquisitions,
      reachable_location_canonical_ids:stageReachableLocationIds,source_confidence:'SOURCE_EXPLICIT',compatibility_experience_dependency:true});
    const planId=`equipment.acquisition.${shortHash(`${task.canonical_id}|${requirement.target_canonical_id}|${requirement.monster_canonical_id}`)}`;
    equipmentAcquisitionPlans.set(planId,{canonical_id:planId,task_canonical_id:task.canonical_id,target_canonical_id:requirement.target_canonical_id,
      target_origin:requirement.origin,monster_canonical_id:requirement.monster_canonical_id,plan:acquisitionPlan});
    return {...requirement,monster,acquisitionPlan,planId};
  });
}

function applyChosenStaminaExtension({selectedTasks,unselectedTasks,catalog,chosen}){
  const simulation=chosen._simulation;const newIds=new Set(simulation.newly_selected_tasks.map((entry)=>entry.canonical_id));
  selectedTasks.push(...simulation.newly_selected_tasks);
  for(let index=unselectedTasks.length-1;index>=0;index-=1)if(newIds.has(unselectedTasks[index].canonical_id)||unselectedTasks[index].series_canonical_id===chosen.series_canonical_id&&
    unselectedTasks[index].sequence_position>=chosen.sequence_position)unselectedTasks.splice(index,1);
  const tasks=catalog.listSeriesTasks(chosen.series_canonical_id);const blockerId=simulation.next_blocker?.task_canonical_id;
  if(blockerId){const blocker=tasks.find((task)=>task.canonical_id===blockerId);const blockerIndex=tasks.findIndex((task)=>task.canonical_id===blockerId);
    unselectedTasks.push({canonical_id:blocker.canonical_id,series_canonical_id:chosen.series_canonical_id,sequence_position:blocker.sequence_position,
      blocking_reasons:[simulation.next_blocker],evidence:{combat_survival:{stamina_budget_exhausted:simulation.next_blocker.code==='combat_consumable_budget_exhausted'}}});
    for(const task of tasks.slice(blockerIndex+1))unselectedTasks.push({canonical_id:task.canonical_id,series_canonical_id:chosen.series_canonical_id,
      sequence_position:task.sequence_position,blocking_reasons:[{code:'series_prefix_blocked',blocked_by:blockerId}],evidence:{}});
  }
  selectedTasks.sort((a,b)=>a.series_canonical_id.localeCompare(b.series_canonical_id)||a.sequence_position-b.sequence_position);
}

function loadStaminaSource(db,reachableLocationIds,acceptedMoney){
  const row=db.prepare(`SELECT se.canonical_id shop_entry_canonical_id,se.price,ce.canonical_id item_canonical_id,ce.source_canonical_id,
      ce.display_name,ce.entity_category,ce.normalized_data_json,sd.canonical_id shop_canonical_id,sd.display_name shop_display_name,
      l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id
    FROM shop_entries se JOIN shop_definitions sd ON sd.id=se.shop_definition_id JOIN dependency_references ref ON ref.id=se.content_reference_id
    JOIN content_entities ce ON ce.id=ref.resolved_content_entity_id JOIN locations l JOIN cities c ON c.id=l.city_id JOIN map_nodes mn ON mn.location_id=l.id
    WHERE ce.display_name='体力宝' AND sd.region_label='地中海' AND c.display_name='威尼斯' AND l.display_name='商店' ORDER BY se.canonical_id LIMIT 1`).get();
  if(!row)return null;const item={canonical_id:row.item_canonical_id,source_canonical_id:row.source_canonical_id,display_name:row.display_name,
    entity_category:row.entity_category,normalized_data:JSON.parse(row.normalized_data_json)};if(!staminaItemSemantics(item))return null;
  const price=Number(row.price);return {...row,item,price,location_reachable:reachableLocationIds.includes(row.location_canonical_id),available_quantity:Math.floor(Math.max(0,Number(acceptedMoney??0))/price)};
}
function combatSurvivalUnresolvedModules(){return {pet:{status:'BLOCKED_ORIGINAL_ENTRY_INCOMPLETE',reason:'source combat participation exists but hatch/activation entry is not formally reachable'},
  team_or_crew:{status:'NOT_A_COMBAT_MODIFIER',reason:'source team persistence is not called by Monster.assault'},
  strengthening:{status:'NO_FORMAL_EXECUTION_ENTRY_IN_CURRENT_CATALOG',reason:'do not invent strengthening as a survival modifier'}};}

function buildLevelReachability(db,selected,catalog,resources,rewardRules,progressionRules) {
  const tasks=selected.map((entry)=>({ ...catalog.getTask(entry.canonical_id),series_canonical_id:entry.series_canonical_id }));
  const monsterLevels=new Map(db.prepare('SELECT canonical_id,level FROM monster_definitions').all().map((entry)=>[entry.canonical_id,Number(entry.level)]));
  const placements=db.prepare(`SELECT m.canonical_id monster_canonical_id,m.display_name monster_name,m.level,m.monster_type,l.canonical_id location_canonical_id,
    c.canonical_id city_canonical_id,c.display_name city_name FROM monster_definitions m JOIN monster_placements p ON p.monster_definition_id=m.id
    JOIN locations l ON l.id=p.location_id JOIN cities c ON c.id=l.city_id
    WHERE p.runtime_capability='queryable' AND m.monster_type IN (3,4,5) ORDER BY m.level,m.canonical_id,l.canonical_id`).all()
    .filter((entry)=>resources.city_canonical_ids.includes(entry.city_canonical_id));
  const selectedById=new Map(selected.map((entry)=>[entry.canonical_id,entry]));
  const seriesIds=unique(tasks.map((task)=>task.series_canonical_id)).sort();
  const bySeries=new Map(seriesIds.map((id)=>[id,tasks.filter((task)=>task.series_canonical_id===id).sort((a,b)=>a.sequence_position-b.sequence_position)]));
  const positions=new Map(seriesIds.map((id)=>[id,0]));let level=1;let experience=0;const gates=[];const processedTaskIds=[];const taskEntryLevels={};
  const advance=()=>{while(level<LEVEL_THRESHOLDS.length&&experience>=LEVEL_THRESHOLDS[level])level+=1;};
  while([...positions].some(([id,position])=>position<bySeries.get(id).length)) {
    const heads=seriesIds.map((id)=>({id,task:bySeries.get(id)[positions.get(id)]})).filter((entry)=>entry.task);
    const available=heads.filter((entry)=>Number(entry.task.level_requirement??1)<=level)
      .sort((a,b)=>Number(a.task.level_requirement??1)-Number(b.task.level_requirement??1)||a.id.localeCompare(b.id));
    if(!available.length) {
      const requiredLevel=Math.min(...heads.map((entry)=>Number(entry.task.level_requirement??1)));
      const plan=planTrainingPath({currentLevel:level,currentExperience:experience,targetLevel:requiredLevel,
        encounters:placements,rewardRules,progressionRules,actualEquipment:[]});
      const allocations=plan.level_segments.flatMap((segment)=>segment.encounter_allocations);
      const representative=[...allocations].sort((a,b)=>b.experience_per_victory-a.experience_per_victory
        ||a.monster_canonical_id.localeCompare(b.monster_canonical_id))[0]??null;
      gates.push({from_level:level,from_experience:experience,required_level:requiredLevel,
        target_experience:Number(LEVEL_THRESHOLDS[Math.max(level,requiredLevel-1)]),
        reachable_training_locations:unique(plan.level_segments.flatMap((entry)=>entry.reachable_training_locations)),
        representative_monster:representative?{monster_canonical_id:representative.monster_canonical_id,monster_name:representative.monster_name,
          monster_level:representative.monster_level,location_canonical_id:representative.location_canonical_id,
          experience_per_fight:representative.experience_per_victory}:null,
        available_dungeon_or_trial_ids:requiredLevel>=20?['runtime.dungeon.windsor-manor']:requiredLevel>=5?['runtime.dungeon.venice-adventure']:[],
        estimated_fight_count:plan.total_planned_victories,reasonable_worst_attempts:plan.total_reasonable_worst_attempts,
        level_segments:plan.level_segments,balance_anomaly:!plan.formally_executable,
        closure_status:plan.formally_executable?'closed':'blocked',rule_id:plan.planner_rule_id,
        progression_plan:plan});
      if(!plan.formally_executable)return {gates,processedTaskIds,anomaly:gates.at(-1),blockedHeadIds:heads.map((entry)=>entry.task.canonical_id),taskEntryLevels};
      experience=plan.resulting_experience;advance();continue;
    }
    const {id,task}=available[0];
    experience+=task.rewards.filter((reward)=>String(reward.reward_name).includes('经验')).reduce((sum,reward)=>sum+Number(reward.quantity),0);
    for(const target of task.targets.filter((entry)=>entry.target_kind==='monster'))experience+=Number(target.required_quantity)*
      monsterExperience(Number(monsterLevels.get(target.entity_canonical_id)??1),'task_exclusive',rewardRules);
    for(const resolution of selectedById.get(task.canonical_id).runtime_item_resolutions.filter((entry)=>entry.formal_source.source_kind==='monster_drop')) {
      const target=task.targets.find((entry)=>entry.canonical_id===resolution.target_canonical_id);
      experience+=Number(target?.required_quantity??0)*monsterExperience(Number(monsterLevels.get(resolution.formal_source.monster_canonical_id)??1),'wild',rewardRules);
    }
    taskEntryLevels[task.canonical_id]=level;advance();positions.set(id,positions.get(id)+1);processedTaskIds.push(task.canonical_id);
  }
  return { gates,processedTaskIds,anomaly:null,blockedHeadIds:[],taskEntryLevels };
}

function evaluateTask(task,capabilities) {
  const blocking=[];const runtimeItemResolutions=[];
  const requiredLocations=unique([task.receive_location_canonical_id,task.submit_location_canonical_id,task.target_location_canonical_id,
    ...task.targets.filter((target)=>target.target_kind==='location').map((target)=>target.entity_canonical_id)].filter(Boolean));
  const missingDefinitions=[];
  for(const [field,value] of [['source_canonical_id',task.source_canonical_id],['display_name',task.display_name],['task_type',task.task_type],
    ['receive_location',task.receive_location_canonical_id],['submit_location',task.submit_location_canonical_id],
    ['issuer_npc',task.issuer_npc_canonical_id],['completion_npc',task.completion_npc_canonical_id]])if(!value)missingDefinitions.push(field);
  if(missingDefinitions.length)blocking.push({ code:'incomplete_task_definition',missing:missingDefinitions });
  for(const target of task.targets.filter((entry)=>entry.target_kind==='item')) {
    const resolution=resolveItemSource(task,target,capabilities.itemSources,capabilities.marketSources,capabilities.monsterItemSources,
      capabilities.fishingItemSources,capabilities.divingItemSources,capabilities.locations,capabilities.ports,capabilities.monsterEncountersByLocation);
    if(resolution)runtimeItemResolutions.push(resolution);
  }
  for(const target of task.targets.filter((entry)=>entry.target_kind==='monster')) {
    if(!capabilities.taskTargetKindNormalization)continue;
    const resolution=resolveMisclassifiedCollectionTarget(task,target,capabilities.monsterPlacements,capabilities.monsterEncountersByLocation);
    if(resolution)runtimeItemResolutions.push(resolution);
  }
  for(const locationId of runtimeItemResolutions.map((entry)=>entry.formal_source.location_canonical_id).filter(Boolean))if(!requiredLocations.includes(locationId))requiredLocations.push(locationId);
  const unresolved=task.blocking_reasons.filter((reason)=>reason.type!=='unresolved_target'||!runtimeItemResolutions.some((entry)=>entry.target_canonical_id===reason.target_canonical_id));
  if(unresolved.length)blocking.push({ code:'unresolved_dependency',details:unresolved });
  if(capabilities.exclusion)blocking.push({ code:'manual_exclusion',details:capabilities.exclusion });
  const conflicts=capabilities.unresolvedConflicts.get(task.source_canonical_id)??[];
  if(conflicts.length)blocking.push({ code:'restoration_conflict_unresolved',canonical_ids:conflicts });
  const missingLocations=requiredLocations.filter((id)=>!capabilities.locations.has(id)||!capabilities.mapLocations.has(id));
  if(missingLocations.length)blocking.push({ code:'location_unavailable',canonical_ids:missingLocations });
  const npcRequirements=uniquePairs([[task.issuer_npc_canonical_id,task.receive_location_canonical_id],[task.completion_npc_canonical_id,task.submit_location_canonical_id],
    ...task.targets.filter((target)=>target.target_kind==='npc').map((target)=>[target.entity_canonical_id,task.submit_location_canonical_id])].filter(([npc,location])=>npc&&location));
  const contextualNpcs=npcRequirements.filter(([npc,location])=>!capabilities.npcPlacements.has(`${npc}|${location}`))
    .map(([npc,location])=>({npc_canonical_id:npc,location_canonical_id:location,placement_scope:'task_context',
      task_canonical_id:task.canonical_id,appearance_statuses:npc===task.issuer_npc_canonical_id&&location===task.receive_location_canonical_id
        ?['available','accepted','in_progress','completable']:['accepted','in_progress','completable'],
      source_canonical_id:task.source_canonical_id,evidence_status:'SOURCE_EXPLICIT_TASK_LOCATION'}));
  const missingNpcs=npcRequirements.filter(([npc,location])=>!capabilities.npcPlacements.has(`${npc}|${location}`)
    &&!contextualNpcs.some((entry)=>entry.npc_canonical_id===npc&&entry.location_canonical_id===location));
  if(missingNpcs.length)blocking.push({ code:'npc_not_placed',requirements:missingNpcs.map(([npc,location])=>({npc_canonical_id:npc,location_canonical_id:location})) });
  const normalizedItemTargetIds=new Set(runtimeItemResolutions.filter((entry)=>entry.target_kind_override==='item').map((entry)=>entry.target_canonical_id));
  const monsterRequirements=task.targets.filter((target)=>target.target_kind==='monster'&&!normalizedItemTargetIds.has(target.canonical_id))
    .map((target)=>[target.entity_canonical_id,task.target_location_canonical_id]);
  const missingMonsters=monsterRequirements.filter(([monster,location])=>!monster||!location||!capabilities.monsterPlacements.has(`${monster}|${location}`));
  if(missingMonsters.length)blocking.push({ code:'monster_without_formal_encounter',requirements:missingMonsters.map(([monster,location])=>({monster_canonical_id:monster,location_canonical_id:location})) });
  const unsupported=unique(task.targets.map((target)=>target.target_kind).filter((kind)=>!supportedTargetKinds.has(kind)));
  if(unsupported.length)blocking.push({ code:'unsupported_target_kind',target_kinds:unsupported });
  for(const target of task.targets.filter((entry)=>entry.target_kind==='item')) {
    if(taskGeneratedItemTypes.has(task.task_type))continue;
    const resolution=runtimeItemResolutions.find((entry)=>entry.target_canonical_id===target.canonical_id);
    if(!resolution)blocking.push({ code:'item_without_formal_source',target_canonical_id:target.canonical_id,
      source_entity_canonical_id:target.entity_canonical_id,candidate_canonical_ids:target.candidate_canonical_ids });
  }
  const routeCityIds=runtimeItemResolutions.flatMap((entry)=>entry.formal_source.route_pairs??[]).flatMap((pair)=>[pair.from_city_canonical_id,pair.to_city_canonical_id]);
  const cities=unique(requiredLocations.map((id)=>capabilities.locations.get(id)?.city_display_name).filter(Boolean)
    .concat(capabilities.ports.rows.filter((port)=>routeCityIds.includes(port.city_canonical_id)).map((port)=>port.city_display_name)));
  const routeWaypointCities=cities.filter((name)=>capabilities.routeWaypointDestinations?.has(normalizeCityName(name)));
  const missingPorts=cities.filter((name)=>!capabilities.ports.byName.has(normalizeCityName(name))
    &&!capabilities.routeWaypointDestinations?.has(normalizeCityName(name)));
  if(cities.length>1&&missingPorts.length)blocking.push({ code:'voyage_port_or_coordinate_missing',cities:missingPorts });
  const level=Number(task.level_requirement??1);
  if(!Number.isFinite(level)||level<1||level>=LEVEL_THRESHOLDS.length)blocking.push({ code:'unsupported_level_requirement',level,supported_level_cap:LEVEL_THRESHOLDS.length-1 });
  return { blocking_reasons:blocking,runtime_item_resolutions:runtimeItemResolutions,evidence:{
    definition_complete:missingDefinitions.length===0,required_locations:requiredLocations,
    npc_requirements:npcRequirements.map(([npc,location])=>({npc_canonical_id:npc,location_canonical_id:location,
      placement_scope:capabilities.npcPlacements.has(`${npc}|${location}`)?'static':'task_context'})),contextual_npc_placements:contextualNpcs,
    monster_requirements:monsterRequirements.map(([monster,location])=>({monster_canonical_id:monster,location_canonical_id:location})),
    required_cities:cities,route_waypoint_destinations:routeWaypointCities.map((name)=>({city_display_name:name,
      encounters:capabilities.routeWaypointDestinations.get(normalizeCityName(name))})),
    target_kinds:unique(task.targets.map((target)=>normalizedItemTargetIds.has(target.canonical_id)?'item':target.target_kind)),level_requirement:level,
    formal_runtime_path:blocking.length===0?'npc_talk + local_move/voyage + formal combat/shop + npc_submit':null,
  } };
}

function resolveItemSource(task,target,itemSources,marketSources,monsterItemSources,fishingItemSources,divingItemSources,locations,ports,monsterEncountersByLocation) {
  const targetLocation=locations.get(task.target_location_canonical_id);
  const taskRoutePairs=extractTaskRoutePairs(task,ports);
  const fishingSource=(fishingItemSources.get(target.raw_name)??[])[0];
  if(fishingSource)return {target_canonical_id:target.canonical_id,source_entity_canonical_id:target.entity_canonical_id,
    runtime_entity_canonical_id:fishingSource.runtime_item_canonical_id,resolution_rule:'source_explicit_fishing_catch',
    formal_source:{...fishingSource,route_pairs:fishingSource.route_pairs.length?fishingSource.route_pairs:taskRoutePairs}};
  const divingSource=(divingItemSources.get(target.raw_name)??[])[0];
  if(divingSource)return {target_canonical_id:target.canonical_id,source_entity_canonical_id:target.entity_canonical_id,
    runtime_entity_canonical_id:divingSource.runtime_item_canonical_id,resolution_rule:'source_explicit_diving_dungeon_drop',
    formal_source:{...divingSource,route_pairs:taskRoutePairs}};
  const monsterCandidates=monsterItemSources.get(target.raw_name)??[];
  const monsterSource=monsterCandidates.find((entry)=>entry.location_canonical_id===task.target_location_canonical_id)
    ??monsterCandidates.map((entry)=>{const location=locations.get(entry.location_canonical_id);const description=String(task.description??'');return {entry,score:
      (description.includes(`${location?.city_display_name}${location?.display_name}`)?8:0)+(description.includes(location?.display_name??'__missing__')?2:0)};})
      .sort((a,b)=>b.score-a.score||a.entry.canonical_id.localeCompare(b.entry.canonical_id)).find((candidate)=>candidate.score>0)?.entry;
  if(monsterSource)return {target_canonical_id:target.canonical_id,source_entity_canonical_id:target.entity_canonical_id,
    runtime_entity_canonical_id:monsterSource.runtime_item_canonical_id,resolution_rule:'source_explicit_monster_item',formal_source:monsterSource};
  const describedSource=resolveTaskDescribedItemSource(task,target,monsterEncountersByLocation);
  if(describedSource)return {target_canonical_id:target.canonical_id,source_entity_canonical_id:target.entity_canonical_id,
    runtime_entity_canonical_id:describedSource.runtime_item_canonical_id,resolution_rule:'source_explicit_task_described_encounter_drop',formal_source:describedSource};
  const markets=(marketSources.get(target.raw_name)??[]).map((source)=>({source,score:
    (String(task.description??'').includes(source.city_display_name)?8:0)+
    ([task.receive_location_canonical_id,task.submit_location_canonical_id,task.target_location_canonical_id]
      .some((id)=>locations.get(id)?.city_canonical_id===source.city_canonical_id)?4:0)}))
    .sort((a,b)=>b.score-a.score||a.source.canonical_id.localeCompare(b.source.canonical_id));
  if(markets.length&&(markets.length===1||markets[0].score>markets[1].score)) {
    const source=markets[0].source;
    return {target_canonical_id:target.canonical_id,source_entity_canonical_id:target.entity_canonical_id,
      runtime_entity_canonical_id:source.runtime_item_canonical_id,resolution_rule:'source_explicit_market_price',formal_source:source};
  }
  const candidates=unique([target.entity_canonical_id,...target.candidate_canonical_ids].filter(Boolean));
  const ranked=[];
  for(const canonicalId of candidates)for(const source of itemSources.get(canonicalId)??[]) {
    let score=1;
    if(source.source_kind==='shop'&&targetLocation?.display_name==='商店')score+=2;
    if(source.source_kind==='shop'&&normalizeCityName(source.region_label)===normalizeCityName(targetLocation?.city_display_name))score+=4;
    if(source.source_kind==='drop'&&task.target_location_canonical_id===source.location_canonical_id)score+=4;
    ranked.push({ canonicalId,source,score });
  }
  ranked.sort((a,b)=>b.score-a.score||a.canonicalId.localeCompare(b.canonicalId)||a.source.canonical_id.localeCompare(b.source.canonical_id));
  const best=ranked[0];if(!best)return null;
  return { target_canonical_id:target.canonical_id,source_entity_canonical_id:target.entity_canonical_id,
    runtime_entity_canonical_id:best.canonicalId,resolution_rule:best.canonicalId===target.entity_canonical_id?'direct_formal_source':'candidate_with_formal_source',
    formal_source:best.source };
}


function resolveTaskDescribedItemSource(task,target,monsterEncountersByLocation) {
  if(!target.raw_name||!task.target_location_canonical_id)return null;
  const description=String(task.description??'');
  const encounters=monsterEncountersByLocation?.get(task.target_location_canonical_id)??[];
  const ranked=encounters.map((entry)=>{
    const exactTarget=entry.monster_name===target.raw_name;
    const mentionIndex=description.indexOf(entry.monster_name);
    const suffix=mentionIndex<0?'':description.slice(mentionIndex+entry.monster_name.length,mentionIndex+entry.monster_name.length+4);
    const promotedVariant=/^(王|头领|首领|统领|精英|Boss|BOSS)/.test(suffix);
    const explicitMention=mentionIndex>=0;
    const normalizedMonster=normalizeEncounterName(entry.monster_name);
    const normalizedMention=normalizedMonster.length>=2&&description.includes(normalizedMonster);
    const lexicalOverlap=longestCommonSubstring(String(target.raw_name),String(entry.monster_name));
    const score=exactTarget?120:explicitMention&&!promotedVariant?100:explicitMention&&promotedVariant?90:
      normalizedMention?75:lexicalOverlap.length>=2?50+lexicalOverlap.length*5:0;
    return {entry,score,exactTarget,explicitMention,promotedVariant,normalizedMention,lexicalOverlap};
  }).filter((candidate)=>candidate.score>0)
    .sort((left,right)=>right.score-left.score||left.entry.monster_canonical_id.localeCompare(right.entry.monster_canonical_id));
  if(!ranked.length||ranked.length>1&&ranked[0].score===ranked[1].score)return null;
  const chosen=ranked[0];
  return {canonical_id:`runtime.task-drop.${shortHash(`${task.canonical_id}|${target.canonical_id}|${chosen.entry.monster_canonical_id}`)}`,
    source_canonical_id:task.source_canonical_id,source_kind:'monster_drop',monster_canonical_id:chosen.entry.monster_canonical_id,
    location_canonical_id:task.target_location_canonical_id,runtime_item_canonical_id:`runtime.item.${shortHash(target.raw_name)}`,
    item_name:target.raw_name,monster_name:chosen.entry.monster_name,probability:1,route_pairs:[],
    evidence_status:'SOURCE_EXPLICIT_TASK_CONDITION',evidence_locator:`${task.source_canonical_id} description + target encounter placement`,
    probability_adjudication:'one required task item is settled per defeated or harvested source encounter because the task text gives an acquisition condition but no random drop rate',
    encounter_match:chosen.exactTarget?'target_name_equals_encounter':chosen.explicitMention&&chosen.promotedVariant?'task_description_names_promoted_variant':
      chosen.explicitMention?'task_description_names_encounter':chosen.normalizedMention?'normalized_task_description_names_encounter':'item_and_encounter_lexical_overlap',
    lexical_overlap:chosen.lexicalOverlap??'',has_active_conflict:true};
}

function resolveMisclassifiedCollectionTarget(task,target,monsterPlacements,monsterEncountersByLocation) {
  if(!target.raw_name||!task.target_location_canonical_id)return null;
  if(target.entity_canonical_id&&monsterPlacements.has(`${target.entity_canonical_id}|${task.target_location_canonical_id}`))return null;
  const description=String(task.description??'');
  if(!description.includes(target.raw_name)||!/(获得|获取|取得|收集|采集|拿到|得到|带回|找回|掉落)/.test(description))return null;
  const source=resolveTaskDescribedItemSource(task,target,monsterEncountersByLocation);
  if(!source||source.monster_name===target.raw_name)return null;
  return {target_canonical_id:target.canonical_id,source_entity_canonical_id:target.entity_canonical_id,
    runtime_entity_canonical_id:source.runtime_item_canonical_id,resolution_rule:'normalize_migrated_collection_target_to_item',
    original_target_kind:'monster',target_kind_override:'item',formal_source:{...source,
      evidence_status:'SOURCE_EXPLICIT_TASK_CONDITION_AND_PLACEMENT',target_kind_adjudication:'migration_damage_repaired_at_runtime'}};
}

function normalizeEncounterName(value) {
  return String(value??'').replace(/^(红|黑|白|黄|蓝|绿|紫|金|银|巨|大|小|邪恶)/,'').replace(/(王|头领|首领|统领|精英)$/,'');
}

function loadRouteWaypointDestinations(maritimeCapabilities) {
  const result=new Map();
  for(const entry of maritimeCapabilities.sailing?.route_encounters??[]){
    const key=normalizeCityName(entry.location);const values=result.get(key)??[];
    values.push({route:entry.route,probability:Number(entry.probability),location:entry.location,position:entry.position,
      evidence_status:'SOURCE_EXPLICIT',runtime_system:'MaritimeRuntime.route_location'});result.set(key,values);
  }
  return result;
}

function longestCommonSubstring(left,right) {
  const a=String(left??'');const b=String(right??'');let best='';
  for(let start=0;start<a.length;start++)for(let end=start+1;end<=a.length;end++){
    const candidate=a.slice(start,end);if(candidate.length>best.length&&b.includes(candidate))best=candidate;
  }
  return best;
}

function loadMarketSources(db,locations) {
  const result=new Map();
  for(const row of db.prepare(`SELECT cp.canonical_id,cp.source_canonical_id,cp.raw_item_name item_name,cp.raw_city_name city_display_name,
      cp.city_id,cp.minimum_price,cp.maximum_price,c.canonical_id city_canonical_id
    FROM city_price_ranges cp JOIN cities c ON c.id=cp.city_id
    WHERE cp.minimum_price IS NOT NULL AND cp.maximum_price IS NOT NULL ORDER BY cp.canonical_id`).all()) {
    const marketLocation=[...locations.values()].find((entry)=>entry.city_canonical_id===row.city_canonical_id&&entry.display_name==='市场');
    if(!marketLocation)continue;
    const values=result.get(row.item_name)??[];values.push({...row,source_kind:'market',location_canonical_id:marketLocation.canonical_id,
      price:Number(row.minimum_price),runtime_item_canonical_id:`runtime.market_item.${shortHash(row.item_name)}`,
      shop_canonical_id:`runtime.market.${row.city_canonical_id}`,
      evidence_status:'SOURCE_EXPLICIT',evidence_locator:'zhsh/config/marketItems.json'});result.set(row.item_name,values);
  }
  return result;
}

function loadMonsterItemSources(db,data) {
  const result=new Map();
  for(const source of data.sources)for(const row of db.prepare(`SELECT m.canonical_id monster_canonical_id,l.canonical_id location_canonical_id
    FROM monster_definitions m JOIN monster_placements p ON p.monster_definition_id=m.id JOIN locations l ON l.id=p.location_id
    WHERE m.display_name=? AND p.runtime_capability='queryable' ORDER BY m.canonical_id,l.canonical_id`).all(source.monster_name)) {
    const values=result.get(source.item_name)??[];values.push({canonical_id:`runtime.drop.${shortHash(`${row.monster_canonical_id}|${row.location_canonical_id}|${source.item_name}`)}`,
      source_canonical_id:'source.zhsh.config.monsterItems',source_kind:'monster_drop',monster_canonical_id:row.monster_canonical_id,
      location_canonical_id:row.location_canonical_id,runtime_item_canonical_id:`runtime.item.${shortHash(source.item_name)}`,
      item_name:source.item_name,monster_name:source.monster_name,probability:Number(data.source.drop_probability)});result.set(source.item_name,values);
  }
  return result;
}

function loadFishingItemSources(db,data,ports) {
  const entities=new Map(db.prepare(`SELECT canonical_id,display_name FROM content_entities WHERE entity_category='item'`).all().map((row)=>[row.display_name,row.canonical_id]));
  const result=new Map();
  for(const entry of data.fishing.catches) {
    const canonicalId=entities.get(entry.name);if(!canonicalId)continue;
    const routePairs=(entry.locations??[]).map(([from,to])=>routePairByNames(from,to,ports)).filter(Boolean);
    const values=result.get(entry.name)??[];values.push({canonical_id:`runtime.fishing.catch.${shortHash(entry.name)}`,
      source_canonical_id:'source.zhsh.config.fish',source_kind:'fishing',runtime_item_canonical_id:canonicalId,item_name:entry.name,
      bait_name:entry.bait,rarity:entry.rarity,route_pairs:routePairs,all_routes:!entry.locations?.length,
      evidence_status:'SOURCE_EXPLICIT',evidence_locator:'zhsh/config/fish.json'});result.set(entry.name,values);
  }
  return result;
}

function loadDivingItemSources(db,data,ports) {
  const entities=new Map(db.prepare(`SELECT canonical_id,display_name FROM content_entities WHERE entity_category='item'`).all().map((row)=>[row.display_name,row.canonical_id]));
  const result=new Map();
  for(const dungeon of data.diving.formal_dungeons)for(const stage of dungeon.stages)for(const itemName of stage.monster.item_drops) {
    const canonicalId=entities.get(itemName);if(!canonicalId)continue;
    const monsterId=`runtime.maritime.monster.${shortHash(`${dungeon.display_name}|${stage.display_name}|${stage.monster.display_name}`)}`;
    const values=result.get(itemName)??[];values.push({canonical_id:`runtime.diving.drop.${shortHash(`${monsterId}|${itemName}`)}`,
      source_canonical_id:'source.zhsh.config.monsterItems',source_kind:'diving_dungeon_drop',runtime_item_canonical_id:canonicalId,item_name:itemName,
      dungeon_canonical_id:`runtime.maritime.dungeon.${shortHash(dungeon.display_name)}`,monster_canonical_id:monsterId,probability:0.4,
      monster:{canonical_id:monsterId,display_name:stage.monster.display_name,level:stage.monster.level,monster_type:stage.monster.monster_type},
      route_pairs:[],evidence_status:'SOURCE_EXPLICIT',evidence_locator:'zhsh/config/monsterItems.json'});result.set(itemName,values);
  }
  return result;
}

function extractTaskRoutePairs(task,ports) {
  const text=String(task.description??'');const mentioned=[];
  for(const port of ports.rows)if(text.includes(normalizeCityName(port.city_display_name)))mentioned.push({port,index:text.indexOf(normalizeCityName(port.city_display_name))});
  mentioned.sort((a,b)=>a.index-b.index||a.port.city_canonical_id.localeCompare(b.port.city_canonical_id));
  const uniquePorts=[...new Map(mentioned.map((entry)=>[entry.port.city_canonical_id,entry.port])).values()];const result=[];
  for(let index=0;index+1<uniquePorts.length;index+=2)result.push({from_city_canonical_id:uniquePorts[index].city_canonical_id,
    to_city_canonical_id:uniquePorts[index+1].city_canonical_id,from_city_display_name:uniquePorts[index].city_display_name,
    to_city_display_name:uniquePorts[index+1].city_display_name});
  return result;
}

function routePairByNames(from,to,ports) {
  const left=ports.byName.get(normalizeCityName(from)),right=ports.byName.get(normalizeCityName(to));
  return left&&right?{from_city_canonical_id:left.city_canonical_id,to_city_canonical_id:right.city_canonical_id,
    from_city_display_name:left.city_display_name,to_city_display_name:right.city_display_name}:null;
}

function loadLocations(db) { return new Map(db.prepare(`SELECT l.canonical_id,l.display_name,c.canonical_id city_canonical_id,c.display_name city_display_name
    FROM locations l JOIN cities c ON c.id=l.city_id`).all().map((row)=>[row.canonical_id,row])); }

function loadPorts(db,coordinates) {
  const rows=db.prepare(`SELECT c.canonical_id city_canonical_id,c.display_name city_display_name,l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id
    FROM cities c JOIN locations l ON l.city_id=c.id JOIN map_nodes mn ON mn.location_id=l.id
    WHERE l.display_name='码头' AND mn.runtime_capability='queryable' ORDER BY c.canonical_id`).all();
  const available=rows.filter((entry)=>coordinates[normalizeCityName(entry.city_display_name)]).map((entry)=>({ ...entry,
    coordinate:coordinates[normalizeCityName(entry.city_display_name)],source_canonical_id:'source.zhsh.config.lngLat' }));
  return { rows:available,byName:new Map(available.map((entry)=>[normalizeCityName(entry.city_display_name),entry])) };
}

function loadItemSources(db,locations) {
  const result=new Map();const add=(id,entry)=>{if(!id)return;const values=result.get(id)??[];values.push(entry);result.set(id,values);};
  for(const row of db.prepare(`SELECT ce.canonical_id item,se.canonical_id,se.source_canonical_id,'shop' source_kind,se.price,se.runtime_capability,
      sd.canonical_id shop_canonical_id,sd.display_name shop_display_name,sd.region_label
    FROM shop_entries se JOIN shop_definitions sd ON sd.id=se.shop_definition_id JOIN dependency_references r ON r.id=se.content_reference_id
    JOIN content_entities ce ON ce.id=r.resolved_content_entity_id WHERE se.runtime_capability='queryable' ORDER BY se.canonical_id`).all())add(row.item,row);
  for(const row of db.prepare(`SELECT ce.canonical_id item,d.canonical_id,d.source_canonical_id,'drop' source_kind,d.probability,d.quantity,d.runtime_capability,
      m.canonical_id monster_canonical_id,l.canonical_id location_canonical_id
    FROM drop_relations d JOIN dependency_references tr ON tr.id=d.target_reference_id JOIN content_entities ce ON ce.id=tr.resolved_content_entity_id
    JOIN dependency_references sr ON sr.id=d.source_reference_id JOIN monster_definitions m ON m.id=sr.resolved_monster_definition_id
    JOIN monster_placements p ON p.monster_definition_id=m.id JOIN locations l ON l.id=p.location_id
    WHERE d.runtime_capability='queryable' AND p.runtime_capability='queryable' ORDER BY d.canonical_id,l.canonical_id`).all())add(row.item,row);
  return result;
}

function loadUnresolvedConflicts(db) {
  const result=new Map();
  for(const row of db.prepare(`SELECT conflict.canonical_id conflict_id,subject.canonical_id subject_source
    FROM restoration_conflicts rc JOIN restoration_records conflict ON conflict.id=rc.conflict_record_id
    JOIN restoration_records subject ON subject.id=rc.subject_record_id
    WHERE rc.runtime_policy='unresolved' AND rc.selected_candidate_json IS NULL`).all()) {
    const values=result.get(row.subject_source)??[];values.push(row.conflict_id);result.set(row.subject_source,values);
  }
  return result;
}

function loadEquipmentAcquisitions(db) {
  const byEquipment=new Map();
  const rows=db.prepare(`SELECT ce.canonical_id,ce.display_name,e.level required_level,e.equipment_type,ce.normalized_data_json,
      d.canonical_id source_canonical_id,m.canonical_id source_monster_canonical_id,m.display_name source_monster_name,
      m.level source_monster_level,m.monster_type source_monster_type,l.canonical_id source_location_canonical_id,
      c.canonical_id source_city_canonical_id,c.display_name source_city_name
    FROM equipment e JOIN content_entities ce ON ce.id=e.content_entity_id
    JOIN dependency_references tr ON tr.resolved_content_entity_id=ce.id JOIN drop_relations d ON d.target_reference_id=tr.id
    JOIN dependency_references sr ON sr.id=d.source_reference_id JOIN monster_definitions m ON m.id=sr.resolved_monster_definition_id
    JOIN monster_placements p ON p.monster_definition_id=m.id JOIN locations l ON l.id=p.location_id JOIN cities c ON c.id=l.city_id
    WHERE d.runtime_capability='queryable' AND p.runtime_capability='queryable'
    ORDER BY ce.canonical_id,d.canonical_id,l.canonical_id`).all();
  const pools=new Map();
  for(const row of rows){const values=pools.get(row.source_monster_canonical_id)??new Map();values.set(row.canonical_id,equipmentDropWeight(Number(row.required_level??1)));pools.set(row.source_monster_canonical_id,values);}
  for(const row of rows){let entry=byEquipment.get(row.canonical_id);if(!entry){entry={canonical_id:row.canonical_id,display_name:row.display_name,
    required_level:Number(row.required_level??1),equipment_type:Number(row.equipment_type),attributes:JSON.parse(row.normalized_data_json),acquisition_sources:[]};byEquipment.set(row.canonical_id,entry);}
    const pool=pools.get(row.source_monster_canonical_id);const weight=pool.get(row.canonical_id);const total=[...pool.values()].reduce((sum,value)=>sum+value,0);
    entry.acquisition_sources.push({canonical_id:row.source_canonical_id,source_kind:'monster_drop',monster_canonical_id:row.source_monster_canonical_id,
      monster_name:row.source_monster_name,source_monster_level:Number(row.source_monster_level),source_monster_type:Number(row.source_monster_type),
      monster:{canonical_id:row.source_monster_canonical_id,display_name:row.source_monster_name,level:Number(row.source_monster_level),monster_type:Number(row.source_monster_type)},
      location_canonical_id:row.source_location_canonical_id,city_canonical_id:row.source_city_canonical_id,city_name:row.source_city_name,
      arrival_path:[row.source_location_canonical_id],equipment_pool_size:pool.size,equipment_weight:weight,equipment_pool_weight:total,
      probability:0.2,effective_probability:0.2*weight/total,evidence_status:'SOURCE_EXPLICIT',evidence_locator:'zhsh/config/monsterDrops.json + src/monster.js'});}
  return [...byEquipment.values()];
}

function equipmentDropWeight(level){return level<=30?70:level<=100?Math.max(30,70-Math.floor((level-30)*(40/70))):29;}

function collectSelectedResources(db,selected,catalog,locations,ports,itemSources) {
  const tasks=selected.map((entry)=>catalog.getTask(entry.canonical_id));
  const itemResolutions=selected.flatMap((entry)=>entry.runtime_item_resolutions);
  const locationIds=unique(tasks.flatMap((task)=>[task.receive_location_canonical_id,task.submit_location_canonical_id,task.target_location_canonical_id,
    ...task.targets.filter((target)=>target.target_kind==='location').map((target)=>target.entity_canonical_id)]).filter(Boolean)
    .concat(itemResolutions.map((entry)=>entry.formal_source.location_canonical_id).filter(Boolean)));
  const routeCityIds=selected.flatMap((entry)=>entry.runtime_item_resolutions).flatMap((entry)=>entry.formal_source.route_pairs??[])
    .flatMap((pair)=>[pair.from_city_canonical_id,pair.to_city_canonical_id]);
  const cityIds=unique(locationIds.map((id)=>locations.get(id)?.city_canonical_id).filter(Boolean).concat(routeCityIds));
  const npcIds=unique(tasks.flatMap((task)=>[task.issuer_npc_canonical_id,task.completion_npc_canonical_id,...task.targets.filter((target)=>target.target_kind==='npc').map((target)=>target.entity_canonical_id)]).filter(Boolean));
  const monsterIds=unique(tasks.flatMap((task)=>task.targets.filter((target)=>target.target_kind==='monster').map((target)=>target.entity_canonical_id))
    .concat(itemResolutions.map((entry)=>entry.formal_source.monster_canonical_id).filter(Boolean)));
  const itemIds=unique(tasks.flatMap((task)=>[...task.targets.map((target)=>target.content_entity_canonical_id),...task.rewards.map((reward)=>reward.content_entity_canonical_id)].filter(Boolean))
    .concat(itemResolutions.map((entry)=>entry.runtime_entity_canonical_id)));
  const shops=unique(itemResolutions.filter((entry)=>['shop','market'].includes(entry.formal_source.source_kind)).map((entry)=>entry.formal_source.shop_canonical_id));
  const portRows=ports.rows.filter((entry)=>cityIds.includes(entry.city_canonical_id));
  const routePairs=[];for(const from of portRows)for(const to of portRows)if(from.city_canonical_id!==to.city_canonical_id)routePairs.push({from_city_canonical_id:from.city_canonical_id,to_city_canonical_id:to.city_canonical_id});
  const ships=db.prepare(`SELECT ce.canonical_id FROM ships s JOIN content_entities ce ON ce.id=s.content_entity_id ORDER BY ce.canonical_id`).all().map((row)=>row.canonical_id);
  return { task_canonical_ids:selected.map((entry)=>entry.canonical_id),location_canonical_ids:locationIds,city_canonical_ids:cityIds,
    npc_canonical_ids:npcIds,monster_canonical_ids:monsterIds,item_canonical_ids:itemIds,shop_canonical_ids:shops,
    ports:portRows,route_pairs:routePairs,ship_canonical_ids:ships };
}

function validateInputs(matrix,coordinates,exclusions,monsterItemSources,rewardRules,maritimeCapabilities,progressionRules,formalStageStart) {
  if(matrix.total_tasks!==651||matrix.tasks.length!==651)throw new Error('Selector requires the complete 651-task capability matrix');
  if(!coordinates.coordinates||!Object.keys(coordinates.coordinates).length)throw new Error('City coordinate evidence is empty');
  if(!Array.isArray(exclusions.exclusions))throw new Error('Manual exclusion table must contain exclusions[]');
  if(!Array.isArray(monsterItemSources.sources)||!monsterItemSources.sources.length)throw new Error('Monster item source evidence is empty');
  if(maritimeCapabilities.schema_version!==1||maritimeCapabilities.fishing?.catches?.length!==25||!maritimeCapabilities.diving?.formal_dungeons?.length)throw new Error('Maritime capability evidence is incomplete');
  if(rewardRules.experience?.evidence_status!=='PROVISIONAL_COMPATIBILITY'||!rewardRules.experience.base_experience_per_level)throw new Error('Monster reward compatibility evidence is incomplete');
  if(progressionRules.rule_id!=='zhsh.progression-planner.v1'||!progressionRules.canonical_rules?.repeatable_training)throw new Error('Progression planner evidence is incomplete');
  if(!Number.isSafeInteger(formalStageStart.selected_task_count)||!formalStageStart.selected_task_count||
    formalStageStart.completed_task_canonical_ids.length!==formalStageStart.selected_task_count)
    throw new Error('Formal stage start must retain its complete accepted terminal task set');
  if(formalStageStart.current_state_lower_bound.level!==45)throw new Error('Formal stage start terminal level evidence is incomplete');
  if(formalStageStart.experience_adjudication.runtime_adjudication_status!=='COMPATIBILITY_PLAYABLE_RETAINED'
    ||formalStageStart.experience_adjudication.new_higher_level_unlocks_allowed!==false)throw new Error('Compatibility experience adjudication must remain bounded');
  for(const entry of exclusions.exclusions)for(const field of ['canonical_id','reason','source_evidence','removal_condition'])if(!entry[field])throw new Error(`Manual exclusion missing ${field}`);
  for(const moduleName of ['TaskRuntimeEngine','CombatRuntime','EconomyRuntime','ShipRuntime','VoyageRuntime','MaritimeRuntime','FishingRuntime','DivingRuntime','RecoveryRuntime']) {
    if(typeof require('../src/task-runtime')[moduleName]!=='function')throw new Error(`Formal runtime support missing: ${moduleName}`);
  }
}


function applyModuleFlags(progressionRules,moduleFlags){
  const result=structuredClone(progressionRules);
  const training=result.canonical_rules?.reasonable_training;
  if(training&&!moduleFlags.training_session_continuation)training.session_continuation_allowed=false;
  return result;
}
function replaceSeriesTailWithBlocker({catalog,selectedTasks,unselectedTasks,seriesId,rootSequencePosition,rootTaskCanonicalId,
  rootBlockingReason,rootEvidence,rootRuntimeItemResolutions}){
  const priorEntries=new Map([...unselectedTasks,...selectedTasks]
    .filter((entry)=>entry.series_canonical_id===seriesId&&Number(entry.sequence_position)>=Number(rootSequencePosition))
    .map((entry)=>[entry.canonical_id,entry]));
  removeSeriesTail(selectedTasks,seriesId,rootSequencePosition);
  removeSeriesTail(unselectedTasks,seriesId,rootSequencePosition);
  const tasks=catalog.listSeriesTasks(seriesId).filter((task)=>Number(task.sequence_position)>=Number(rootSequencePosition));
  for(const task of tasks){
    const prior=priorEntries.get(task.canonical_id)??{};
    const isRoot=task.canonical_id===rootTaskCanonicalId;
    unselectedTasks.push({canonical_id:task.canonical_id,series_canonical_id:seriesId,sequence_position:task.sequence_position,
      blocking_reasons:[isRoot?rootBlockingReason:{code:'series_prefix_blocked',blocked_by:rootTaskCanonicalId}],
      evidence:isRoot?(rootEvidence??prior.evidence??{}):(prior.evidence??{}),
      runtime_item_resolutions:isRoot?(rootRuntimeItemResolutions??prior.runtime_item_resolutions??[]):(prior.runtime_item_resolutions??[])});
  }
}
function removeSeriesTail(entries,seriesId,sequencePosition){
  for(let index=entries.length-1;index>=0;index-=1)if(entries[index].series_canonical_id===seriesId
    &&Number(entries[index].sequence_position)>=Number(sequencePosition))entries.splice(index,1);
}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function writeJsonIfChanged(file,value){const serialized=`${JSON.stringify(value,null,2)}\n`;fs.mkdirSync(path.dirname(file),{recursive:true});
  if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==serialized)fs.writeFileSync(file,serialized,'utf8');}
function loadFormalStageStart(file){
  const value=readJson(file);const evidencePath=path.resolve(root,value.completed_task_evidence.path);
  if(!evidencePath.startsWith(`${root}${path.sep}`))throw new Error('Formal stage evidence path escapes the repository');
  const bytes=fs.readFileSync(evidencePath);const normalizedBytes=Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'));
  if(sha256(bytes)!==value.completed_task_evidence.sha256&&sha256(normalizedBytes)!==value.completed_task_evidence.sha256)
    throw new Error('Formal stage completed-task evidence hash changed');
  const evidence=JSON.parse(bytes);const completed=value.completed_task_evidence.json_pointer==='/state/tasks (status=completed)'
    ?Object.entries(evidence.state?.tasks??{}).filter(([,task])=>task.status==='completed').map(([id])=>id)
    :evidence.completed_task_canonical_ids;
  const finalCompleted=evidence.final_completed??completed?.length;
  if(!Array.isArray(completed)||completed.length!==value.selected_task_count||finalCompleted!==value.selected_task_count)
    throw new Error('Formal stage completed-task evidence is inconsistent');
  return {...value,completed_task_canonical_ids:[...completed].sort()};
}
function normalizeCityName(value){return String(value??'').replace('(PK)','');}
function summarizeAcquisitionPlan(planId,plan){return {canonical_id:planId,detail_file:'data/generated/equipment-acquisition-analysis.json',
  acquisition_closed:plan.acquisition_closed,target_combat_closed:plan.target_combat_closed,closed:plan.closed,
  actual_loadout:plan.actual_loadout,acquired_equipment_count:plan.acquired_equipment.length,cycle_dependencies:plan.cycle_dependencies,
  unclosed_reasons:plan.unclosed_reasons,source_confidence:plan.source_confidence,runtime_adjudication_status:plan.runtime_adjudication_status,
  has_active_conflict:plan.has_active_conflict,compatibility_experience_dependency:plan.compatibility_experience_dependency};}
function groupMap(values,key){const result=new Map();for(const value of values){const id=value[key];const entries=result.get(id)??[];entries.push(value);result.set(id,entries);}return result;}
function unique(values){return [...new Set(values)];}
function uniquePairs(values){return [...new Map(values.map((entry)=>[entry.join('|'),entry])).values()];}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}
function shortHash(value){return sha256(value).slice(0,16);}
function stableJson(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;}
function selectionHashPayload(body){const {stage_start_head,source_head,generated_from_head,reference_commits,generator_version,generated_at,...semantic}=body;return semantic;}

if(require.main===module){const output=selectRunnableTasks();console.log(JSON.stringify({output:path.relative(root,defaults.outputPath),selected_task_count:output.selected_task_count,
  selected_series_count:output.selected_series_count,selection_hash:output.selection_hash},null,2));}
module.exports={ analyze,defaults,evaluateAllTasks,evaluateTask,selectRunnableTasks,selectionHashPayload,selectorVersion,stableJson };
