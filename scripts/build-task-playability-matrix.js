'use strict';

const fs=require('node:fs');
const path=require('node:path');
const { DatabaseSync }=require('node:sqlite');
const { SqliteTaskCatalog }=require('../src/task-runtime');
const {generationMetadata}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const defaultDatabase=path.join(root,'data','zhsh-content.sqlite');
const defaultOutput=path.join(root,'docs','development','task-playability-matrix.json');
const selectionPath=path.join(root,'data','generated','runnable-task-selection.json');
const browserContentPath=path.join(root,'web','generated','task1-content.json');
const validationPath=path.join(root,'docs','development','formal-core-e2e-validation.json');
const formalE2ePath=path.join(root,'tests','formal-core-e2e.test.js');

function buildTaskPlayabilityMatrix({databasePath=defaultDatabase,outputPath=defaultOutput,validationMode='formal'}={}) {
  const db=new DatabaseSync(databasePath,{readOnly:true});
  try {
    if(!['formal','development'].includes(validationMode))throw new Error(`Unsupported matrix validation mode: ${validationMode}`);
    const catalog=new SqliteTaskCatalog(db);
    const selection=readJson(selectionPath);const browser=readJson(browserContentPath);const validation=readJson(validationPath);
    assertFormalE2eHarness();
    const selectedById=new Map(selection.selected_tasks.map((entry)=>[entry.canonical_id,entry]));
    const unselectedById=new Map(selection.unselected_tasks.map((entry)=>[entry.canonical_id,entry]));
    const browserTaskIds=new Set(browser.tasks.map((entry)=>entry.canonical_id));
    const validationPassed=validation.selection_hash===selection.selection_hash&&validation.formal_task_count===selection.selected_task_count
      &&validation.scenarios.every((entry)=>entry.result==='passed'&&entry.final_completed===selection.selected_task_count);
    const series=db.prepare('SELECT canonical_id,display_name FROM task_series ORDER BY source_series').all();const rows=[];
    for(const group of series)for(const task of catalog.listSeriesTasks(group.canonical_id)) {
      const selected=selectedById.get(task.canonical_id);const rejected=unselectedById.get(task.canonical_id);
      if(!selected&&!rejected)throw new Error(`Selector result missing task: ${task.canonical_id}`);
      const rawEvidence=(selected??rejected).evidence??{};const evidence={definition_complete:Boolean(rawEvidence.definition_complete),
        required_locations:rawEvidence.required_locations??[],npc_requirements:rawEvidence.npc_requirements??[],monster_requirements:rawEvidence.monster_requirements??[],
        required_cities:rawEvidence.required_cities??[],target_kinds:rawEvidence.target_kinds??[],level_requirement:rawEvidence.level_requirement??Number(task.level_requirement??1),
        level_closure:rawEvidence.level_closure??null};
      const blocking=selected?(validationPassed||validationMode==='development'?[]:[{code:'formal_e2e_not_covered'}]):rejected.blocking_reasons;
      const itemTargets=task.targets.filter((target)=>target.target_kind==='item');
      const resolvedItems=itemTargets.map((target)=>{
        const resolution=selected?.runtime_item_resolutions.find((entry)=>entry.target_canonical_id===target.canonical_id);
        const generated=task.task_type==='送物品';
        return { item_canonical_id:resolution?.runtime_entity_canonical_id??target.entity_canonical_id,
          source:generated?'task_generation':resolution?.formal_source??null,closed:generated||Boolean(resolution) };
      });
      const formal=Boolean(selected)&&browserTaskIds.has(task.canonical_id)&&validationPassed&&blocking.length===0;
      rows.push({
        task_canonical_id:task.canonical_id,series:group.canonical_id,sequence_position:task.sequence_position,
        selector_status:selected?'selected':'not_selected',selection_reason:selected?.selection_reason??null,
        definition_closure:{closed:evidence.definition_complete},
        prerequisite_closure:{closed:!blocking.some((reason)=>['prerequisite_not_selected','series_prefix_blocked'].includes(reason.code)),required:task.prerequisites},
        location_closure:{closed:!blocking.some((reason)=>reason.code==='location_unavailable'),required:evidence.required_locations},
        npc_closure:{closed:!blocking.some((reason)=>reason.code==='npc_not_placed'),required:evidence.npc_requirements},
        monster_closure:{closed:!blocking.some((reason)=>reason.code==='monster_without_formal_encounter'),required:evidence.monster_requirements},
        combat_supported:evidence.monster_requirements.length===0||!blocking.some((reason)=>reason.code==='monster_without_formal_encounter'),
        item_source_closure:{closed:itemTargets.length===0||resolvedItems.every((entry)=>entry.closed),resolved:resolvedItems},
        shop_closure:{closed:!blocking.some((reason)=>reason.code==='item_without_formal_source'),required:itemTargets.length>0,resolved_item_sources:resolvedItems},
        voyage_required:evidence.required_cities.length>1,
        voyage_closure:{closed:!blocking.some((reason)=>reason.code==='voyage_port_or_coordinate_missing'),required_cities:evidence.required_cities},
        equipment_or_level_requirement:{level:evidence.level_requirement,equipment_requirement:null,
          supported:!blocking.some((reason)=>reason.code==='unsupported_level_requirement')},
        level_reachability_closure:evidence.level_closure,
        target_kinds_supported:Object.fromEntries(evidence.target_kinds.map((kind)=>[kind,!blocking.some((reason)=>reason.code==='unsupported_target_kind')])),
        unresolved_dependencies:task.blocking_reasons,
        restoration_conflicts:blocking.filter((reason)=>reason.code==='restoration_conflict_unresolved'),
        browser_content_included:browserTaskIds.has(task.canonical_id),
        automated_e2e_covered:formal?{covered:true,test_file:'tests/formal-core-e2e.test.js',validation_file:'docs/development/formal-core-e2e-validation.json',
          scenarios:['new_browser_save','legacy_25_task_checkpoint_migration'],selection_hash:selection.selection_hash}:{covered:false},
        final_playability_status:formal?'formal_core_playable':selected?'selected_pending_validation':'not_selected_blocked',blocking_reasons:blocking,
      });
    }
    if(rows.length!==651)throw new Error(`Expected 651 tasks, found ${rows.length}`);
    const statusCounts=countBy(rows.map((row)=>row.final_playability_status));
    if(validationMode==='formal'&&((statusCounts.formal_core_playable??0)!==selection.selected_task_count||selection.selected_task_count<50))
      throw new Error(`Formal matrix count mismatch: ${statusCounts.formal_core_playable??0}/${selection.selected_task_count}`);
    if(validationMode==='development'&&(statusCounts.selected_pending_validation??0)!==selection.selected_task_count)
      throw new Error(`Development matrix count mismatch: ${statusCounts.selected_pending_validation??0}/${selection.selected_task_count}`);
    const output={schema_version:4,...generationMetadata('task-playability-matrix/4.1.0'),
      validation_mode:validationMode,formal_validation_current:validationPassed,
      generation_method:validationMode==='formal'?'deterministic selector closure plus matching new-save and migrated-save formal Runtime validation':
        'deterministic 651-task selector closure with selected tasks retained as development candidates pending the next complete formal DOM acceptance',
      selector_version:selection.selector_version,selection_hash:selection.selection_hash,total_tasks:rows.length,total_series:series.length,
      status_counts:statusCounts,formal_core_playable_count:statusCounts.formal_core_playable??0,
      development_selected_count:validationMode==='development'?statusCounts.selected_pending_validation??0:0,tasks:rows};
    fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,`${JSON.stringify(output,null,2)}\n`,'utf8');return output;
  } finally {db.close();}
}

function assertFormalE2eHarness(){const source=fs.readFileSync(formalE2ePath,'utf8');
  for(const required of ['CombatRuntime','VoyageRuntime','RecoveryRuntime','completes every selected browser task','browser-save-v1-real-1-of-13.json'])if(!source.includes(required))throw new Error(`Formal E2E harness marker missing: ${required}`);
  for(const forbidden of ['PreviewEncounterProvider','PreviewTravelProvider','runTaskSequence',"type:'defeat_monster'","type:'obtain_item'","type:'arrive_at_location'"])if(source.includes(forbidden))throw new Error(`Formal E2E harness contains forbidden shortcut: ${forbidden}`);
}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function unique(values){return [...new Set(values)];}
function countBy(values){return Object.fromEntries(unique(values).sort().map((value)=>[value,values.filter((entry)=>entry===value).length]));}

if(require.main===module){const validationMode=process.argv.includes('--development')?'development':'formal';const result=buildTaskPlayabilityMatrix({validationMode});
  console.log(JSON.stringify({output:path.relative(root,defaultOutput),validation_mode:result.validation_mode,total_tasks:result.total_tasks,status_counts:result.status_counts},null,2));}
module.exports={buildTaskPlayabilityMatrix};
