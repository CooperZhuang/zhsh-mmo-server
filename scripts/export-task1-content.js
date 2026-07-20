'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SqliteTaskCatalog } = require('../src/task-runtime/sqlite-task-catalog');

const root = path.resolve(__dirname,'..');
const defaultDatabase = path.join(root,'data','zhsh-content.sqlite');
const defaultOutput = path.join(root,'web','generated','task1-content.json');
const defaultSelectionPath=path.join(root,'data','generated','global-runtime-task-selection.json');
const coordinatesPath=path.join(root,'data','runtime','city-coordinates.json');
const rewardRulesPath=path.join(root,'data','runtime','monster-reward-rules.json');
const progressionRulesPath=path.join(root,'data','runtime','progression-rules.json');
const dungeonEncountersPath=path.join(root,'data','runtime','formal-dungeon-encounters.json');
const maritimeCapabilitiesPath=path.join(root,'data','runtime','maritime-capabilities.json');

function exportTask1Content({ databasePath = defaultDatabase,outputPath = defaultOutput,selectionPath = defaultSelectionPath } = {}) {
  const db = new DatabaseSync(databasePath,{ readOnly:true });
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const catalog = new SqliteTaskCatalog(db);
    const selection=JSON.parse(fs.readFileSync(selectionPath,'utf8'));
    const maritimeCapabilities=JSON.parse(fs.readFileSync(maritimeCapabilitiesPath,'utf8'));
    const selectedById=new Map(selection.selected_tasks.map((entry)=>[entry.canonical_id,entry]));
    const selectedSeriesIds=selection.selected_series.map((entry)=>entry.canonical_id);
    const loadedTasks=selection.selected_tasks.map((selected)=>applyRuntimeResolutions(
      { ...enrichNestedSourceIds(db,catalog.getTask(selected.canonical_id)),series_canonical_id:selected.series_canonical_id },selected));
    const includedTaskIds=new Set(loadedTasks.map((task)=>task.canonical_id));
    const tasks=loadedTasks.map((task)=>({ ...task,source_prerequisites:task.prerequisites,source_successors:task.successors,
      prerequisites:task.prerequisites.filter((id)=>includedTaskIds.has(id)),successors:task.successors.filter((id)=>includedTaskIds.has(id)),
      browser_batch_terminal:task.successors.some((id)=>!includedTaskIds.has(id)) }));
    assert(tasks.length === selection.selected_task_count,`browser content and selector task counts differ: ${tasks.length} != ${selection.selected_task_count}`);
    assert(tasks.every((task) => task.source_canonical_id), 'Every exported task must have source_canonical_id');
    assert(tasks.every((task) => task.directory_status || task.blocking_reasons.length === 0), 'browser tasks must expose directory status when blocked');

    const runtimeItemResolutions=selection.selected_tasks.flatMap((entry)=>entry.runtime_item_resolutions);
    const runtimeTargetResolutions=selection.selected_tasks.flatMap((entry)=>(entry.runtime_target_resolutions??[]).map((resolution)=>({ ...resolution,task_canonical_id:entry.canonical_id })));
    const runtimeEncounterPlacements=selection.selected_tasks.flatMap((entry)=>[...(entry.runtime_item_resolutions??[]),...(entry.runtime_target_resolutions??[])]
      .filter((resolution)=>resolution.formal_source?.task_scoped_placement&&resolution.formal_source?.monster_canonical_id&&resolution.formal_source?.location_canonical_id)
      .map((resolution)=>({ ...resolution,task_canonical_id:entry.canonical_id })));
    const taskLocationIds = unique(tasks.flatMap((task) => [task.receive_location_canonical_id,task.submit_location_canonical_id,
      task.target_location_canonical_id,...task.targets.filter((target) => target.target_kind === 'location').map((target) => target.entity_canonical_id)]).filter(Boolean)
      .concat(runtimeItemResolutions.map((entry)=>entry.formal_source.location_canonical_id).filter(Boolean)));
    const taskLocations = selectIn(db,`
      SELECT l.canonical_id,l.source_canonical_id,l.display_name,l.description,l.is_derived,
        c.canonical_id city_canonical_id,c.display_name city_display_name
      FROM locations l JOIN cities c ON c.id=l.city_id WHERE l.canonical_id IN (__IN__) ORDER BY l.canonical_id`,taskLocationIds);
    assert(taskLocations.length === taskLocationIds.length,'Every task1 location must resolve');
    const evidenceCityNames=unique(selection.selected_tasks.flatMap((entry)=>entry.evidence.required_cities??[]));
    const evidenceCityIds=selectIn(db,'SELECT canonical_id FROM cities WHERE display_name IN (__IN__) ORDER BY canonical_id',evidenceCityNames).map((entry)=>entry.canonical_id);
    const cityIds = unique(taskLocations.map((entry) => entry.city_canonical_id).concat(evidenceCityIds));
    const cities = selectIn(db,'SELECT canonical_id,source_canonical_id,display_name FROM cities WHERE canonical_id IN (__IN__) ORDER BY canonical_id',cityIds);
    const locations = selectIn(db,`
      SELECT l.canonical_id,l.source_canonical_id,l.display_name,l.description,l.is_derived,
        c.canonical_id city_canonical_id,c.display_name city_display_name
      FROM locations l JOIN cities c ON c.id=l.city_id WHERE c.canonical_id IN (__IN__) ORDER BY l.canonical_id`,cityIds);
    const playableLocationIds = locations.map((entry) => entry.canonical_id);

    const locationNodes = selectIn(db,`
      SELECT mn.canonical_id map_node_canonical_id,mn.node_kind,mn.display_name,mn.runtime_capability,
        l.canonical_id location_canonical_id,c.canonical_id city_canonical_id,rr.canonical_id source_canonical_id
      FROM map_nodes mn JOIN locations l ON l.id=mn.location_id JOIN cities c ON c.id=l.city_id
      JOIN restoration_records rr ON rr.id=mn.source_record_id
      WHERE c.canonical_id IN (__IN__) ORDER BY mn.canonical_id`,cityIds);
    const cityNodes = selectIn(db,`
      SELECT mn.canonical_id map_node_canonical_id,mn.node_kind,mn.display_name,mn.runtime_capability,
        NULL location_canonical_id,c.canonical_id city_canonical_id,rr.canonical_id source_canonical_id
      FROM map_nodes mn JOIN cities c ON c.id=mn.city_id JOIN restoration_records rr ON rr.id=mn.source_record_id
      WHERE mn.node_kind='city' AND c.canonical_id IN (__IN__) ORDER BY mn.canonical_id`,cityIds);
    const mapNodes = [...cityNodes,...locationNodes].sort(byCanonical('map_node_canonical_id'));
    const mapNodeIds = mapNodes.map((entry) => entry.map_node_canonical_id);
    let connections = selectInTwice(db,`
      SELECT lc.canonical_id,lc.source_canonical_id,source.canonical_id from_map_node_canonical_id,
        target.canonical_id to_map_node_canonical_id,lc.relation_type,lc.directed,lc.runtime_capability
      FROM location_connections lc JOIN map_nodes source ON source.id=lc.from_node_id JOIN map_nodes target ON target.id=lc.to_node_id
      WHERE source.canonical_id IN (__IN1__) AND target.canonical_id IN (__IN2__) ORDER BY lc.canonical_id`,mapNodeIds,mapNodeIds);
    connections=ensureTaskLocationConnections(mapNodes,connections,taskLocationIds);
    validateLocalReachability(mapNodes,connections,taskLocationIds);

    const requiredNpcIds = unique(tasks.flatMap((task) => [task.issuer_npc_canonical_id,task.completion_npc_canonical_id,
      ...task.targets.filter((target) => ['npc','npc_duel'].includes(target.target_kind)).map((target) => target.entity_canonical_id)]).filter(Boolean));
    const databaseNpcs = selectIn(db,'SELECT canonical_id,source_canonical_id,display_name,level,npc_type FROM npc_definitions WHERE canonical_id IN (__IN__) ORDER BY canonical_id',requiredNpcIds);
    const contextualNpcDefinitions=tasks.flatMap((task)=>task.contextual_npc_definitions??[]).map((entry)=>({
      canonical_id:entry.canonical_id,source_canonical_id:entry.source_canonical_id,display_name:entry.display_name,
      level:entry.level,npc_type:entry.npc_type,evidence_status:entry.evidence_status,resolution_rule:entry.resolution_rule,
    }));
    const npcs=dedupeByCanonical([...databaseNpcs,...contextualNpcDefinitions]);
    const staticNpcPlacements = selectIn(db,`
      SELECT p.canonical_id,p.source_canonical_id,n.canonical_id npc_canonical_id,l.canonical_id location_canonical_id,p.runtime_capability
      FROM npc_placements p JOIN npc_definitions n ON n.id=p.npc_definition_id JOIN locations l ON l.id=p.location_id
      WHERE n.canonical_id IN (__IN__) ORDER BY p.canonical_id`,requiredNpcIds).filter((entry) => taskLocationIds.includes(entry.location_canonical_id));
    const contextualNpcPlacementGroups=new Map();
    for(const entry of selection.selected_tasks.flatMap((task)=>task.evidence.contextual_npc_placements??[])) {
      const key=`${entry.npc_canonical_id}|${entry.location_canonical_id}`;
      const current=contextualNpcPlacementGroups.get(key)??{ ...entry,source_canonical_ids:[],task_contexts:[] };
      current.source_canonical_ids.push(entry.source_canonical_id);
      current.task_contexts.push({task_canonical_id:entry.task_canonical_id,appearance_statuses:entry.appearance_statuses});
      contextualNpcPlacementGroups.set(key,current);
    }
    const contextualNpcPlacements=[...contextualNpcPlacementGroups.entries()].map(([key,entry])=>({
      canonical_id:`runtime.npc_placement.${shortHash(key)}`,...entry,
      source_canonical_ids:unique(entry.source_canonical_ids),
      task_contexts:[...new Map(entry.task_contexts.map((context)=>[context.task_canonical_id,context])).values()].sort(byCanonical('task_canonical_id')),
      runtime_capability:'queryable',
    }));
    const npcPlacements=dedupeByCanonical([...staticNpcPlacements,...contextualNpcPlacements]);

    const placedEncounterMonsterIds=selectIn(db,`
      SELECT DISTINCT m.canonical_id FROM monster_definitions m
      JOIN monster_placements p ON p.monster_definition_id=m.id JOIN locations l ON l.id=p.location_id
      WHERE l.city_id IN (SELECT id FROM cities WHERE canonical_id IN (__IN__))
        AND p.runtime_capability='queryable' AND m.monster_type IN (3,4,5)
      ORDER BY m.canonical_id`,cityIds).map((entry)=>entry.canonical_id);
    const requiredMonsterIds = unique(tasks.flatMap((task) => task.targets.filter((target) => target.target_kind === 'monster')
      .map((target) => target.entity_canonical_id)).concat(runtimeItemResolutions.map((entry)=>entry.formal_source.monster_canonical_id).filter(Boolean),
        runtimeTargetResolutions.map((entry)=>entry.formal_source?.monster_canonical_id).filter(Boolean),placedEncounterMonsterIds));
    const rewardRules=JSON.parse(fs.readFileSync(rewardRulesPath,'utf8'));
    const monsters = selectIn(db,`
      SELECT m.canonical_id,m.source_canonical_id,m.display_name,m.level,m.monster_type,m.identity_signature_json,'queryable' runtime_capability
      FROM monster_definitions m
      WHERE m.canonical_id IN (__IN__) ORDER BY m.canonical_id`,requiredMonsterIds)
      .map((entry) => {
        const encounter=classifyEncounter(entry.monster_type);
        return { ...entry,identity_signature:JSON.parse(entry.identity_signature_json),...encounter,
          rewards:calculateMonsterRewards(entry,rewardRules,encounter.encounter_type) };
      });
    for (const monster of monsters) delete monster.identity_signature_json;
    const databaseMonsterPlacements = selectIn(db,`
      SELECT p.canonical_id,p.source_canonical_id,m.canonical_id monster_canonical_id,l.canonical_id location_canonical_id,
        p.location_resolution_status,p.runtime_capability,p.normalized_data_json
      FROM monster_placements p JOIN monster_definitions m ON m.id=p.monster_definition_id JOIN locations l ON l.id=p.location_id
      WHERE m.canonical_id IN (__IN__) ORDER BY p.canonical_id`,requiredMonsterIds)
      .filter((entry) => playableLocationIds.includes(entry.location_canonical_id)).map(parseJsonField('normalized_data_json','normalized_data'))
      .map((entry)=>({ ...entry,...classifyEncounter(monsters.find((monster)=>monster.canonical_id===entry.monster_canonical_id)?.monster_type) }));
    const taskScopedMonsterPlacements=runtimeEncounterPlacements.map((resolution)=>({
      canonical_id:`runtime.monster_placement.${shortHash(`${resolution.task_canonical_id}|${resolution.target_canonical_id}|${resolution.formal_source.monster_canonical_id}|${resolution.formal_source.location_canonical_id}`)}`,
      source_canonical_id:resolution.formal_source.source_canonical_id,monster_canonical_id:resolution.formal_source.monster_canonical_id,
      location_canonical_id:resolution.formal_source.location_canonical_id,location_resolution_status:'task_scoped_evidence_overlay',runtime_capability:'queryable',
      normalized_data:{task_canonical_id:resolution.task_canonical_id,target_canonical_id:resolution.target_canonical_id,resolution_rule:resolution.resolution_rule},
      ...classifyEncounter(monsters.find((monster)=>monster.canonical_id===resolution.formal_source.monster_canonical_id)?.monster_type),
    }));
    const monsterPlacements=dedupeByCanonical([...databaseMonsterPlacements,...taskScopedMonsterPlacements]);

    const maritimeEntities=resolveMaritimeEntities(db,maritimeCapabilities);
    const requiredContentIds = unique(tasks.flatMap((task) => [...task.targets.map((target) => target.content_entity_canonical_id),
      ...task.rewards.map((reward) => reward.content_entity_canonical_id)].filter(Boolean)).concat(maritimeEntities.map((entry)=>entry.canonical_id)));
    const databaseContentEntities = selectIn(db,`
      SELECT canonical_id,source_canonical_id,entity_category,display_name,normalized_data_json
      FROM content_entities WHERE canonical_id IN (__IN__) ORDER BY canonical_id`,requiredContentIds)
      .map(parseJsonField('normalized_data_json','normalized_data'));
    const runtimeContentEntities=runtimeItemResolutions.filter((entry)=>['monster_drop','market','task_chain_reward','task_acceptance_grant'].includes(entry.formal_source.source_kind)).map((entry)=>({
      canonical_id:entry.runtime_entity_canonical_id,source_canonical_id:entry.formal_source.source_canonical_id,entity_category:'item',
      display_name:entry.formal_source.item_name,normalized_data:entry.formal_source.source_kind==='market'
        ?{catalog:'marketItems',type:11,inventory_weight_exempt:true,source_city:entry.formal_source.city_display_name,price:entry.formal_source.price}
        :entry.formal_source.source_kind==='task_chain_reward'
          ?{catalog:'taskChainItems',type:11,inventory_weight_exempt:true,source_task_canonical_id:entry.formal_source.source_task_canonical_id,task_item:true}
          :entry.formal_source.source_kind==='task_acceptance_grant'
            ?{catalog:'taskAcceptanceItems',type:11,inventory_weight_exempt:true,source_task_canonical_id:entry.formal_source.source_task_canonical_id,task_item:true}
          :{catalog:entry.resolution_rule==='source_explicit_task_described_encounter_drop'?'taskConditionItems':'monsterItems',
            monster_name:entry.formal_source.monster_name,probability:entry.formal_source.probability,
            encounter_match:entry.formal_source.encounter_match??null,probability_adjudication:entry.formal_source.probability_adjudication??null},
      provenance_status:entry.formal_source.evidence_status??'SOURCE_EXPLICIT',
      evidence_locator:entry.formal_source.evidence_locator??'zhsh/config/monsterItems.json' }));
    const contentEntities=dedupeByCanonical([...databaseContentEntities,...runtimeContentEntities]);
    const itemSources = collectItemSources(db,requiredContentIds);
    const gameplay = collectFormalGameplay(db,{ requiredMonsterIds,tasks,selection,cityIds,rewardRules,maritimeCapabilities,maritimeEntities });

    validateTaskRelations(tasks,{ taskLocationIds,requiredNpcIds,requiredMonsterIds,requiredContentIds,npcPlacements,monsterPlacements });
    const series = selectIn(db,'SELECT canonical_id,source_canonical_id,display_name,runtime_capability FROM task_series WHERE canonical_id IN (__IN__) ORDER BY canonical_id',selectedSeriesIds)
      .map((entry)=>({ ...entry,selected_task_count:selection.selected_series.find((selected)=>selected.canonical_id===entry.canonical_id).selected_task_count }));
    const packageBody = {
      package_id:'zhsh.browser-content',schema_version:4,series,capability_status:'global_runtime_content',
      runnable_task_selection:{ selector_version:selection.selector_version,selection_hash:selection.selection_hash,
        selected_task_count:selection.selected_task_count,selected_series_count:selection.selected_series_count,
        formal_stage_start_selected_task_count:selection.formal_stage_start?.selected_task_count??null,
        combat_survival_chosen_allocation:selection.combat_survival_chosen_allocation??null,status_counts:selection.status_counts??null,
        runtime_runnable_task_count:selection.runtime_runnable_task_count??selection.selected_task_count,implemented_shared_systems:selection.implemented_shared_systems??[] },
      tasks,cities,locations,map_nodes:mapNodes,location_connections:connections,npcs,npc_placements:npcPlacements,
      monsters,monster_placements:monsterPlacements,content_entities:contentEntities,item_sources:itemSources,
      ...gameplay,
      legacy_compatibility:{ preview_routes_supported:false,normal_runtime_reads_this_section:false },
    };
    const contentHash = crypto.createHash('sha256').update(stableJson(packageBody)).digest('hex');
    const output = { ...packageBody,content_sha256:contentHash,entity_counts:countEntities(packageBody) };
    fs.mkdirSync(path.dirname(outputPath),{ recursive:true });
    const serialized = `${JSON.stringify(output,null,2)}\n`;
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath,'utf8') !== serialized) fs.writeFileSync(outputPath,serialized,'utf8');
    return output;
  } finally { db.close(); }
}

function resolveMaritimeEntities(db,data) {
  const sourceItemNames=new Set(data.diving.formal_dungeons.flatMap((dungeon)=>dungeon.stages.flatMap((stage)=>stage.monster.item_drops)));
  const names=unique([
    ...data.fishing.gear.map((entry)=>entry.name),...data.fishing.catches.map((entry)=>entry.name),
    ...data.sailing.special_events.flatMap((entry)=>entry.effect.equipmentList??[]),
    ...data.diving.formal_dungeons.flatMap((dungeon)=>dungeon.stages.flatMap((stage)=>[
      ...stage.monster.item_drops,...stage.monster.equipment_drops])),
  ]);
  const rows=selectIn(db,`SELECT canonical_id,source_canonical_id,entity_category,display_name,normalized_data_json
    FROM content_entities WHERE display_name IN (__IN__) ORDER BY canonical_id`,names).map(parseJsonField('normalized_data_json','normalized_data'));
  const result=[];
  for(const name of names) {
    const candidates=rows.filter((entry)=>entry.display_name===name);
    const preferred=data.fishing.catches.some((entry)=>entry.name===name)
      ?candidates.find((entry)=>entry.normalized_data?.catalog==='fish')
      :data.fishing.gear.some((entry)=>entry.name===name)
        ?candidates.find((entry)=>entry.normalized_data?.catalog==='shopItems')
        :candidates.find((entry)=>entry.entity_category==='equipment')??candidates.find((entry)=>entry.normalized_data?.catalog==='shopItems')??candidates[0];
    if(preferred)result.push(preferred);
    else if(sourceItemNames.has(name))result.push({canonical_id:`runtime.maritime.item.${shortHash(name)}`,
      source_canonical_id:'source.zhsh.config.monsterItems',entity_category:'item',display_name:name,
      normalized_data:{catalog:'monsterItems',name},provenance_status:'SOURCE_EXPLICIT',evidence_locator:'zhsh/config/monsterItems.json'});
    else assert(false,`Maritime source entity is unresolved: ${name}`);
  }
  return dedupeByCanonical(result);
}

function collectFormalGameplay(db,{ requiredMonsterIds,tasks,selection,cityIds,rewardRules,maritimeCapabilities,maritimeEntities }) {
  const coordinates=JSON.parse(fs.readFileSync(coordinatesPath,'utf8')).coordinates;
  const progressionRules=JSON.parse(fs.readFileSync(progressionRulesPath,'utf8'));
  const ports=db.prepare(`
    SELECT c.canonical_id city_canonical_id,c.display_name city_display_name,l.canonical_id location_canonical_id,
      mn.canonical_id map_node_canonical_id FROM cities c JOIN locations l ON l.city_id=c.id
      JOIN map_nodes mn ON mn.location_id=l.id WHERE l.display_name='码头' AND mn.runtime_capability='queryable'
  `).all().map(normalizeNumbers).filter((entry)=>cityIds.includes(entry.city_canonical_id));
  const portByName=new Map(ports.map((entry)=>[entry.city_display_name,entry]));
  const ships=db.prepare(`
    SELECT ce.canonical_id,ce.source_canonical_id,ce.display_name,s.port city_display_name,s.price,s.weight,s.speed
    FROM ships s JOIN content_entities ce ON ce.id=s.content_entity_id ORDER BY s.id
  `).all().map(normalizeNumbers).map((entry)=>({ ...entry,city_canonical_id:portByName.get(entry.city_display_name)?.city_canonical_id ?? null,
    port_location_canonical_id:portByName.get(entry.city_display_name)?.location_canonical_id ?? null,
    port_map_node_canonical_id:portByName.get(entry.city_display_name)?.map_node_canonical_id ?? null }));
  const databaseDropRelations=selectIn(db,`
    SELECT d.canonical_id,d.source_canonical_id,m.canonical_id monster_canonical_id,ce.canonical_id content_entity_canonical_id,
      ce.entity_category drop_kind,d.probability,d.quantity,d.raw_data_json
    FROM drop_relations d JOIN dependency_references source ON source.id=d.source_reference_id
    JOIN monster_definitions m ON m.id=source.resolved_monster_definition_id
    JOIN dependency_references target ON target.id=d.target_reference_id
    JOIN content_entities ce ON ce.id=target.resolved_content_entity_id
    WHERE m.canonical_id IN (__IN__) ORDER BY d.canonical_id`,requiredMonsterIds);
  const runtimeDropRelations=selection.selected_tasks.flatMap((entry)=>entry.runtime_item_resolutions).filter((entry)=>entry.formal_source.source_kind==='monster_drop')
    .map((entry)=>({canonical_id:entry.formal_source.canonical_id,source_canonical_id:entry.formal_source.source_canonical_id,
      monster_canonical_id:entry.formal_source.monster_canonical_id,content_entity_canonical_id:entry.runtime_entity_canonical_id,
      location_canonical_id:entry.formal_source.location_canonical_id,drop_kind:'item',probability:entry.formal_source.probability,quantity:1,
      guaranteed_for_active_task:true,evidence_status:entry.formal_source.evidence_status??'SOURCE_EXPLICIT',
      evidence_locator:entry.formal_source.evidence_locator??'zhsh/config/monsterItems.json',
      raw_data_json:JSON.stringify({source:entry.resolution_rule==='source_explicit_task_described_encounter_drop'?'taskDescription':'monsterItems',
        item:entry.formal_source.item_name,encounter_match:entry.formal_source.encounter_match??null,
        probability_adjudication:entry.formal_source.probability_adjudication??null})}));
  const dropRelations=dedupeByCanonical([...databaseDropRelations,...runtimeDropRelations]);
  const equipmentIds=unique(dropRelations.filter((entry)=>entry.drop_kind==='equipment').map((entry)=>entry.content_entity_canonical_id));
  const equipment=selectIn(db,`
    SELECT ce.canonical_id,ce.source_canonical_id,ce.display_name,ce.normalized_data_json,e.level required_level,e.equipment_type
    FROM equipment e JOIN content_entities ce ON ce.id=e.content_entity_id
    WHERE ce.canonical_id IN (__IN__) ORDER BY ce.canonical_id`,equipmentIds)
    .map(parseJsonField('normalized_data_json','attributes')).map((entry)=>({ ...entry,...entry.attributes }));
  const selectedShopEntries=[];
  for(const selected of selection.selected_tasks)for(const resolution of selected.runtime_item_resolutions.filter((entry)=>entry.formal_source.source_kind==='shop')) {
    const task=tasks.find((entry)=>entry.canonical_id===selected.canonical_id);
    const targetLocation=db.prepare(`SELECT l.canonical_id location_canonical_id,l.display_name,c.display_name city_display_name,mn.canonical_id map_node_canonical_id
      FROM locations l JOIN cities c ON c.id=l.city_id JOIN map_nodes mn ON mn.location_id=l.id WHERE l.canonical_id=?`).get(task.target_location_canonical_id);
    const receiveCity=db.prepare(`SELECT c.display_name FROM locations l JOIN cities c ON c.id=l.city_id WHERE l.canonical_id=?`).get(task.receive_location_canonical_id)?.display_name;
    const sourceCity=ports.find((port)=>normalizeCityName(port.city_display_name)===normalizeCityName(resolution.formal_source.region_label))?.city_display_name;
    const location=targetLocation?.display_name==='商店'?targetLocation:db.prepare(`SELECT l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id
      FROM locations l JOIN cities c ON c.id=l.city_id JOIN map_nodes mn ON mn.location_id=l.id
      WHERE c.display_name=? AND l.display_name='商店'`).get(sourceCity??receiveCity);
    const entry=db.prepare(`SELECT se.canonical_id,se.source_canonical_id,se.price,ce.canonical_id content_entity_canonical_id,
      ce.display_name,sd.canonical_id shop_canonical_id,sd.source_canonical_id shop_source_canonical_id,sd.display_name shop_display_name,sd.region_label
      FROM shop_entries se JOIN shop_definitions sd ON sd.id=se.shop_definition_id
      JOIN dependency_references ref ON ref.id=se.content_reference_id JOIN content_entities ce ON ce.id=ref.resolved_content_entity_id
      WHERE se.canonical_id=?`).get(resolution.formal_source.canonical_id);
    assert(entry&&location,`Selected shop source cannot be exported: ${resolution.formal_source.canonical_id}`);
    selectedShopEntries.push({ ...normalizeNumbers(entry),...normalizeNumbers(location),task_canonical_id:task.canonical_id,
      task_target_canonical_id:resolution.target_canonical_id,task_item_canonical_id:resolution.runtime_entity_canonical_id });
  }
  for(const selected of selection.selected_tasks)for(const resolution of selected.runtime_item_resolutions.filter((entry)=>entry.formal_source.source_kind==='market')) {
    const source=resolution.formal_source;
    const location=db.prepare(`SELECT l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id
      FROM locations l JOIN map_nodes mn ON mn.location_id=l.id WHERE l.canonical_id=?`).get(source.location_canonical_id);
    assert(location,`Selected market source cannot be exported: ${source.canonical_id}`);
    selectedShopEntries.push({canonical_id:`runtime.market_entry.${shortHash(`${source.canonical_id}|${resolution.target_canonical_id}`)}`,
      source_canonical_id:source.source_canonical_id,price:Number(source.price),content_entity_canonical_id:resolution.runtime_entity_canonical_id,
      display_name:source.item_name,shop_canonical_id:source.shop_canonical_id,shop_source_canonical_id:source.source_canonical_id,
      shop_display_name:`${source.city_display_name}-市场`,region_label:source.city_display_name,...normalizeNumbers(location),
      task_canonical_id:selected.canonical_id,task_target_canonical_id:resolution.target_canonical_id,
      task_item_canonical_id:resolution.runtime_entity_canonical_id,inventory_weight_exempt:true,evidence_status:source.evidence_status});
  }
  const healingItem=db.prepare(`
    SELECT se.canonical_id,se.source_canonical_id,se.price,ce.canonical_id content_entity_canonical_id,
      ce.source_canonical_id item_source_canonical_id,ce.display_name,ce.entity_category,ce.normalized_data_json,
      sd.canonical_id shop_canonical_id,sd.display_name shop_display_name
    FROM shop_entries se JOIN shop_definitions sd ON sd.id=se.shop_definition_id
    JOIN dependency_references ref ON ref.id=se.content_reference_id JOIN content_entities ce ON ce.id=ref.resolved_content_entity_id
    WHERE ce.display_name='牛肉馅饼' AND sd.region_label='地中海' ORDER BY se.canonical_id LIMIT 1`).get();
  const staminaItem=db.prepare(`
    SELECT se.canonical_id,se.source_canonical_id,se.price,ce.canonical_id content_entity_canonical_id,
      ce.source_canonical_id item_source_canonical_id,ce.display_name,ce.entity_category,ce.normalized_data_json,
      sd.canonical_id shop_canonical_id,sd.display_name shop_display_name
    FROM shop_entries se JOIN shop_definitions sd ON sd.id=se.shop_definition_id
    JOIN dependency_references ref ON ref.id=se.content_reference_id JOIN content_entities ce ON ce.id=ref.resolved_content_entity_id
    WHERE ce.display_name='体力宝' AND sd.region_label='地中海' ORDER BY se.canonical_id LIMIT 1`).get();
  const veniceStore=db.prepare(`SELECT l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id
    FROM locations l JOIN cities c ON c.id=l.city_id JOIN map_nodes mn ON mn.location_id=l.id
    WHERE c.display_name='威尼斯' AND l.display_name='商店'`).get();
  assert(healingItem&&staminaItem&&veniceStore,'Formal Mediterranean healing and stamina shop entries must resolve');
  const shopEntries=dedupeByCanonical([...selectedShopEntries,{ ...normalizeNumbers(healingItem),...normalizeNumbers(veniceStore) },
    { ...normalizeNumbers(staminaItem),...normalizeNumbers(veniceStore),evidence_status:'SOURCE_EXPLICIT' }]);
  const shops=dedupeByCanonical(shopEntries.map((entry)=>({ canonical_id:entry.shop_canonical_id,source_canonical_id:entry.shop_source_canonical_id??entry.source_canonical_id,
    display_name:entry.shop_display_name,region_label:entry.region_label,location_canonical_id:entry.location_canonical_id,map_node_canonical_id:entry.map_node_canonical_id })));
  const formalItems=[{ canonical_id:healingItem.content_entity_canonical_id,source_canonical_id:healingItem.item_source_canonical_id,
    entity_category:healingItem.entity_category,display_name:healingItem.display_name,normalized_data:JSON.parse(healingItem.normalized_data_json),
    provenance_status:'SOURCE_EXPLICIT',evidence_locator:'zhsh/config/shopItems.json 牛肉馅饼; zhsh/src/play.js useItem type 4' },
    { canonical_id:staminaItem.content_entity_canonical_id,source_canonical_id:staminaItem.item_source_canonical_id,
      entity_category:staminaItem.entity_category,display_name:staminaItem.display_name,normalized_data:JSON.parse(staminaItem.normalized_data_json),
      provenance_status:'SOURCE_EXPLICIT',evidence_locator:'zhsh/config/shopItems.json 体力宝; zhsh/src/play.js updateStaminaBonus/useStaminaItem; zhsh/src/monster.js assault' }];
  for(const entry of shopEntries) { delete entry.item_source_canonical_id;delete entry.entity_category;delete entry.normalized_data_json; }
  const venice=portByName.get('威尼斯');
  const defeatReturn=db.prepare(`SELECT l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id
    FROM locations l JOIN cities c ON c.id=l.city_id JOIN map_nodes mn ON mn.location_id=l.id
    WHERE c.display_name='威尼斯' AND l.display_name='福利院'`).get();
  const churchRecovery=db.prepare(`SELECT l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id,
      n.canonical_id npc_canonical_id,n.source_canonical_id npc_source_canonical_id
    FROM locations l JOIN cities c ON c.id=l.city_id JOIN map_nodes mn ON mn.location_id=l.id
    JOIN npc_placements p ON p.location_id=l.id JOIN npc_definitions n ON n.id=p.npc_definition_id
    WHERE c.display_name='威尼斯' AND l.display_name='教堂' AND n.display_name='神父'`).get();
  assert(defeatReturn && churchRecovery,'Formal defeat return and church recovery evidence must resolve');
  const recoveryServices=[{ canonical_id:'recovery.venice.church.prayer',source_canonical_id:'source.zhsh.user.priest_pray',
    provenance_status:'SOURCE_EXPLICIT',location_canonical_id:churchRecovery.location_canonical_id,
    map_node_canonical_id:churchRecovery.map_node_canonical_id,npc_canonical_id:churchRecovery.npc_canonical_id,
    npc_source_canonical_id:churchRecovery.npc_source_canonical_id,recovery_kind:'full_health',fee:0,
    evidence_locator:'zhsh/src/user.js priest_pray',replacement_condition:'Replace only if stronger multi-source evidence contradicts priest_pray behavior.' }];
  const gameplayRules={ defeat_return:{ provenance_status:'SOURCE_EXPLICIT',source_canonical_id:'source.zhsh.monster.defeat-reset-city',
    location_canonical_id:defeatReturn.location_canonical_id,map_node_canonical_id:defeatReturn.map_node_canonical_id,
    current_health:1,evidence_locator:'zhsh/src/monster.js assault; zhsh/src/city.js resetCity' },
    monster_stats:{ provenance_status:'SOURCE_EXPLICIT',rule_id:'zhsh.monster.type-level.v1',evidence_locator:'zhsh/src/monster.js _setMonsterStats' },
    drops:{ provenance_status:'SOURCE_EXPLICIT',equipment_pool_probability:0.2,ordinary_item_probability:0.4,
      evidence_locator:'zhsh/src/monster.js assault victory settlement' },
    monster_rewards:rewardRules,progression:progressionRules,selected_training_plans:selection.level_reachability };
  const voyageRoutes=[];
  for(const from of ports)for(const to of ports)if(from.city_canonical_id!==to.city_canonical_id) {
    const fromCoordinate=coordinates[normalizeCityName(from.city_display_name)];const toCoordinate=coordinates[normalizeCityName(to.city_display_name)];
    if(!fromCoordinate||!toCoordinate)continue;
    voyageRoutes.push({ canonical_id:`route.${shortHash(`${from.city_canonical_id}|${to.city_canonical_id}`)}`,
      source_canonical_id:'source.zhsh.config.lngLat',from_city_canonical_id:from.city_canonical_id,to_city_canonical_id:to.city_canonical_id,
      from_port_location_canonical_id:from.location_canonical_id,from_port_map_node_canonical_id:from.map_node_canonical_id,
      to_port_location_canonical_id:to.location_canonical_id,to_port_map_node_canonical_id:to.map_node_canonical_id,
      distance:nauticalMiles(fromCoordinate,toCoordinate),fee:0,availability_rule:'owned_current_ship_at_departure_port' });
  }
  const baseDungeons=buildDungeonEncounters(db,JSON.parse(fs.readFileSync(dungeonEncountersPath,'utf8')),rewardRules,cityIds);
  const maritime=buildMaritimeGameplay(db,maritimeCapabilities,maritimeEntities,rewardRules,cityIds);
  return { ships,voyage_routes:voyageRoutes,shops:dedupeByCanonical([...shops,...maritime.shops]),
    shop_entries:dedupeByCanonical([...shopEntries,...maritime.shop_entries]),formal_items:formalItems,
    equipment:dedupeByCanonical([...equipment,...maritime.equipment]),drop_relations:dedupeByCanonical([...dropRelations,...maritime.drop_relations]),
    recovery_services:recoveryServices,gameplay_rules:gameplayRules,dungeons:[...baseDungeons,...maritime.dungeons],maritime:maritime.runtime };
}

function buildMaritimeGameplay(db,data,entities,rewardRules,cityIds) {
  const byName=new Map(entities.map((entry)=>[entry.display_name,entry]));
  const cityRows=db.prepare('SELECT canonical_id,display_name FROM cities ORDER BY canonical_id').all().map(normalizeNumbers);
  const cityByName=new Map(cityRows.map((entry)=>[entry.display_name,entry.canonical_id]));
  const gear=data.fishing.gear.map((entry)=>({ ...entry,canonical_id:byName.get(entry.name).canonical_id,
    source_canonical_id:byName.get(entry.name).source_canonical_id,display_name:entry.name }));
  const catches=data.fishing.catches.map((entry)=>({ display_name:entry.name,
    content_entity_canonical_id:byName.get(entry.name).canonical_id,bait_name:entry.bait,
    bait_content_entity_canonical_id:byName.get(entry.bait)?.canonical_id??null,bait_source_resolved:Boolean(byName.get(entry.bait)),
    rarity:entry.rarity,price:Number(entry.price),route_pairs:(entry.locations??[]).map(([from,to])=>({
      from_city_canonical_id:cityByName.get(from),to_city_canonical_id:cityByName.get(to),from_city_display_name:from,to_city_display_name:to,
    })) }));
  const dungeons=[];const dropRelations=[];const equipmentNames=new Set(data.sailing.special_events.flatMap((entry)=>entry.effect.equipmentList??[]));
  for(const definition of data.diving.formal_dungeons) {
    const dungeonId=`runtime.maritime.dungeon.${shortHash(definition.display_name)}`;
    const stages=definition.stages.map((stage,index)=>{
      const stageId=`${dungeonId}.stage.${String(index+1).padStart(2,'0')}`;
      const monsterId=`runtime.maritime.monster.${shortHash(`${definition.display_name}|${stage.display_name}|${stage.monster.display_name}`)}`;
      const encounter=classifyEncounter(stage.monster.monster_type,index===definition.stages.length-1?'boss':'dungeon_normal');
      for(const itemName of stage.monster.item_drops)dropRelations.push({canonical_id:`runtime.diving.drop.${shortHash(`${monsterId}|${itemName}`)}`,
        source_canonical_id:'source.zhsh.config.monsterItems',monster_canonical_id:monsterId,
        content_entity_canonical_id:byName.get(itemName).canonical_id,drop_kind:'item',probability:0.4,quantity:1,
        raw_data_json:JSON.stringify({source:'monsterItems',item:itemName})});
      for(const itemName of stage.monster.equipment_drops){equipmentNames.add(itemName);dropRelations.push({
        canonical_id:`runtime.diving.equipment_drop.${shortHash(`${monsterId}|${itemName}`)}`,source_canonical_id:'source.zhsh.config.monsterDrops',
        monster_canonical_id:monsterId,content_entity_canonical_id:byName.get(itemName).canonical_id,drop_kind:'equipment',probability:null,quantity:1,
        raw_data_json:JSON.stringify({source:'monsterDrops',item:itemName})});}
      return {canonical_id:stageId,map_node_canonical_id:`${stageId}.node`,display_name:stage.display_name,sequence:Number(stage.sequence),
        monster:{canonical_id:monsterId,display_name:stage.monster.display_name,level:Number(stage.monster.level),monster_type:Number(stage.monster.monster_type),
          ...encounter,rewards:calculateMonsterRewards({level:stage.monster.level},rewardRules,encounter.encounter_type)}};
    });
    dungeons.push({canonical_id:dungeonId,source_canonical_id:'source.zhsh.config.shipFb',display_name:definition.display_name,tip:definition.tip,
      entry_mode:'diving_encounter',minimum_level:1,maximum_level:999,stages,entry_stage_canonical_id:stages[0].canonical_id});
  }
  const equipmentRows=selectIn(db,`SELECT ce.canonical_id,ce.source_canonical_id,ce.display_name,ce.normalized_data_json,
    e.level required_level,e.equipment_type FROM equipment e JOIN content_entities ce ON ce.id=e.content_entity_id
    WHERE ce.display_name IN (__IN__) ORDER BY ce.canonical_id`,[...equipmentNames])
    .map(parseJsonField('normalized_data_json','attributes')).map((entry)=>({ ...entry,...entry.attributes }));
  const vendorLocations=selectIn(db,`SELECT DISTINCT l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id,
      c.canonical_id city_canonical_id,c.display_name city_display_name
    FROM npc_placements p JOIN npc_definitions n ON n.id=p.npc_definition_id JOIN locations l ON l.id=p.location_id
    JOIN cities c ON c.id=l.city_id JOIN map_nodes mn ON mn.location_id=l.id
    WHERE n.npc_type=1 AND c.canonical_id IN (__IN__) ORDER BY l.canonical_id`,cityIds);
  const shopEntries=[];const shops=[];
  for(const location of vendorLocations)for(const item of gear) {
    const shopId=`runtime.fishing.vendor.${shortHash(location.location_canonical_id)}`;
    shops.push({canonical_id:shopId,source_canonical_id:'source.zhsh.npc.type1-shop',display_name:`${location.city_display_name}杂货`,
      region_label:location.city_display_name,location_canonical_id:location.location_canonical_id,map_node_canonical_id:location.map_node_canonical_id});
    shopEntries.push({canonical_id:`runtime.fishing.vendor_entry.${shortHash(`${location.location_canonical_id}|${item.canonical_id}`)}`,
      source_canonical_id:item.source_canonical_id,price:Number(item.price),content_entity_canonical_id:item.canonical_id,display_name:item.display_name,
      shop_canonical_id:shopId,shop_source_canonical_id:'source.zhsh.npc.type1-shop',shop_display_name:`${location.city_display_name}杂货`,
      region_label:location.city_display_name,location_canonical_id:location.location_canonical_id,map_node_canonical_id:location.map_node_canonical_id});
  }
  const sailing={...data.sailing,route_encounters:data.sailing.route_encounters.map((entry)=>{
    const waypoint=db.prepare(`SELECT c.canonical_id city_canonical_id,l.canonical_id location_canonical_id,
      mn.canonical_id map_node_canonical_id FROM cities c JOIN locations l ON l.city_id=c.id
      JOIN map_nodes mn ON mn.location_id=l.id WHERE c.display_name=? AND l.display_name=? AND mn.runtime_capability='queryable'
      ORDER BY l.canonical_id LIMIT 1`).get(entry.location,entry.position);
    assert(waypoint,`Route waypoint location is unresolved: ${entry.location}${entry.position}`);
    return { ...entry,route_canonical_ids:[cityByName.get(entry.route[0]),cityByName.get(entry.route[1])],...waypoint,
      entry_action:'enter_route_location',return_action:'resume_voyage' };
  })};
  return {dungeons,drop_relations:dropRelations,equipment:equipmentRows,shops:dedupeByCanonical(shops),shop_entries:shopEntries,
    runtime:{schema_version:Number(data.schema_version),evidence_status:data.evidence_status,
      fishing:{gear,catches,rules:{rarity_weights:data.fishing.rarity_weights,rarity_weight_adjustments:data.fishing.rarity_weight_adjustments,
        wait_event_probability:data.fishing.wait_event_probability,wait_event_candidates:data.fishing.wait_event_candidates,
        wait_event_selection:data.fishing.wait_event_selection,initial_catch_probability:data.fishing.initial_catch_probability}},sailing,
      diving:{encounter_probability:Number(data.diving.encounter_probability),availability:data.diving.availability,
        source_dungeon_order:data.diving.source_dungeon_order,formal_dungeon_ids:dungeons.map((entry)=>entry.canonical_id),
        equipment_requirement:data.diving.equipment_requirement,route_requirement:data.diving.route_requirement}}};
}

function buildDungeonEncounters(db,data,rewardRules,cityIds) {
  const results=[];
  for(const definition of data.dungeons) {
    const entry=db.prepare(`SELECT c.canonical_id city_canonical_id,l.canonical_id location_canonical_id,mn.canonical_id map_node_canonical_id,
      n.canonical_id npc_canonical_id FROM cities c JOIN locations l ON l.city_id=c.id JOIN map_nodes mn ON mn.location_id=l.id
      JOIN npc_placements p ON p.location_id=l.id JOIN npc_definitions n ON n.id=p.npc_definition_id
      WHERE c.display_name=? AND l.display_name=? AND n.display_name=?`).get(definition.entry_city,definition.entry_location,definition.entry_npc);
    if(!entry||!cityIds.includes(entry.city_canonical_id))continue;
    const stages=definition.stages.map((stage,index)=>{
      const canonicalId=`${definition.canonical_id}.stage.${String(index+1).padStart(2,'0')}`;
      const encounter=stage.monster?classifyEncounter(stage.monster_type,stage.kind):null;
      return { ...stage,canonical_id:canonicalId,map_node_canonical_id:`${canonicalId}.node`,
        monster:stage.monster?{ canonical_id:`${canonicalId}.monster`,display_name:stage.monster,level:stage.monster_level,monster_type:stage.monster_type,
          ...encounter,rewards:calculateMonsterRewards({level:stage.monster_level},rewardRules,encounter.encounter_type) }:null };
    });
    results.push({ ...definition,...normalizeNumbers(entry),stages,entry_stage_canonical_id:stages[0].canonical_id });
  }
  return results;
}

function classifyEncounter(monsterType,override=null) {
  const type=Number(monsterType);
  const encounter_type=override??([6].includes(type)?'task_exclusive':[45,55].includes(type)?'boss':type===50?'dungeon_normal':'wild');
  const repeatable=['wild','dungeon_normal'].includes(encounter_type);
  return { encounter_type,repeatable,
    respawn_rule:encounter_type==='wild'?'source_location_cache_refresh_5_minutes':encounter_type==='dungeon_normal'?'source_instance_group_refresh':'not_repeatable_without_explicit_reset',
    evidence_status:'SOURCE_EXPLICIT' };
}

function calculateMonsterRewards(monster,rules,encounterType) {
  const level=Math.max(1,Number(monster.level));
  const multiplier=Number(rules.experience.encounter_multipliers[encounterType]??1);
  return { experience:Math.max(Number(rules.experience.minimum),Math.round(level*Number(rules.experience.base_experience_per_level)*multiplier)),
    copper:Math.max(Number(rules.copper.minimum),level*5),experience_rule_status:rules.experience.evidence_status,
    copper_rule_status:rules.copper.evidence_status,rule_id:rules.rule_id };
}

function collectItemSources(db,contentIds) {
  if (!contentIds.length) return [];
  const shops = selectIn(db,`
    SELECT se.canonical_id,se.source_canonical_id,'shop' source_kind,se.price,se.runtime_capability,
      ce.canonical_id content_entity_canonical_id,sd.canonical_id shop_canonical_id,sd.display_name shop_display_name,sd.region_label
    FROM shop_entries se JOIN dependency_references r ON r.id=se.content_reference_id
    JOIN content_entities ce ON ce.id=r.resolved_content_entity_id JOIN shop_definitions sd ON sd.id=se.shop_definition_id
    WHERE ce.canonical_id IN (__IN__) ORDER BY se.canonical_id`,contentIds);
  const drops = selectIn(db,`
    SELECT d.canonical_id,d.source_canonical_id,'drop' source_kind,d.probability,d.quantity,d.runtime_capability,
      ce.canonical_id content_entity_canonical_id,m.canonical_id monster_canonical_id,m.display_name monster_display_name
    FROM drop_relations d JOIN dependency_references target ON target.id=d.target_reference_id
    JOIN content_entities ce ON ce.id=target.resolved_content_entity_id
    JOIN dependency_references source ON source.id=d.source_reference_id JOIN monster_definitions m ON m.id=source.resolved_monster_definition_id
    WHERE ce.canonical_id IN (__IN__) ORDER BY d.canonical_id`,contentIds);
  return [...shops,...drops].sort(byCanonical('canonical_id'));
}

function enrichNestedSourceIds(db,task) {
  const load = (table) => new Map(db.prepare(`SELECT canonical_id,source_canonical_id FROM ${table} WHERE task_id=(SELECT id FROM task_definitions WHERE canonical_id=?)`)
    .all(task.canonical_id).map((row) => [row.canonical_id,row.source_canonical_id]));
  const steps = load('task_steps');
  const targets = load('task_targets');
  const rewards = load('task_rewards');
  const dialogues = load('task_dialogues');
  return { ...task,steps:task.steps.map((entry) => ({ ...entry,source_canonical_id:steps.get(entry.canonical_id) })),
    targets:task.targets.map((entry) => ({ ...entry,source_canonical_id:targets.get(entry.canonical_id) })),
    rewards:task.rewards.map((entry) => ({ ...entry,source_canonical_id:rewards.get(entry.canonical_id) })),
    dialogues:task.dialogues.map((entry) => ({ ...entry,source_canonical_id:dialogues.get(entry.canonical_id) })) };
}

function applyRuntimeResolutions(task,selected) {
  const resolutions=[...(selected.runtime_item_resolutions??[]),...(selected.runtime_target_resolutions??[])];
  const byTarget=new Map(resolutions.map((entry)=>[entry.target_canonical_id,entry]));
  const rewardResolutions=selected.runtime_reward_resolutions??[];
  const rewards=[...task.rewards];
  for(const resolution of rewardResolutions) {
    const existing=rewards.find((entry)=>entry.reward_name===resolution.reward_name);
    const patch={reward_kind:'item',reward_name:resolution.reward_name,quantity:Number(resolution.quantity??1),normalized_quantity:Number(resolution.quantity??1),
      content_entity_canonical_id:resolution.runtime_entity_canonical_id,resolution_status:'resolved',runtime_capability:'queryable',
      runtime_resolution:{rule:resolution.resolution_rule,source_task_canonical_id:resolution.source_task_canonical_id}};
    if(existing)Object.assign(existing,patch);
    else rewards.push({canonical_id:`${task.canonical_id}.reward.runtime.${String(rewards.length+1).padStart(2,'0')}`,
      source_canonical_id:resolution.source_task_canonical_id,reward_order:rewards.length+1,raw_quantity:String(patch.quantity),raw_value_json:JSON.stringify({[resolution.reward_name]:patch.quantity}),
      dependency_canonical_id:null,candidate_canonical_ids:[],candidate_canonical_ids_json:'[]',...patch});
  }
  const resolutionLocations=unique(resolutions.map((entry)=>entry.target_location_canonical_id).filter(Boolean));
  const targetLocationOverride=selected.task_location_override??(resolutionLocations.length===1?resolutionLocations[0]:null);
  return { ...task,target_location_canonical_id:targetLocationOverride??task.target_location_canonical_id,
    directory_status:selected.directory_status??(selected.blocking_reasons?.length?'blocked':'runnable_pending_validation'),
    blocking_reasons:selected.blocking_reasons??task.blocking_reasons,rewards,targets:task.targets.map((target)=>{
    const resolution=byTarget.get(target.canonical_id);if(!resolution)return target;
    const source=resolution.formal_source??{};
    const resolvedKind=resolution.target_kind_override??target.target_kind;
    return { ...target,target_kind:resolvedKind,
      original_target_kind:resolution.original_target_kind??target.original_target_kind??null,
      source_content_entity_canonical_id:target.content_entity_canonical_id,source_entity_canonical_id:target.entity_canonical_id,
      monster_canonical_id:resolvedKind==='item'?null:(resolvedKind==='monster'?resolution.runtime_entity_canonical_id:target.monster_canonical_id),
      npc_canonical_id:resolution.target_kind_override==='npc_duel'?resolution.runtime_entity_canonical_id:target.npc_canonical_id,
      content_entity_canonical_id:resolvedKind==='item'?resolution.runtime_entity_canonical_id:target.content_entity_canonical_id,
      entity_canonical_id:resolution.runtime_entity_canonical_id,resolution_status:'resolved',runtime_capability:'queryable',
      task_item_policy:resolution.task_item_policy??null,npc_duel:resolution.duel??null,
      runtime_resolution:{ rule:resolution.resolution_rule,formal_source_canonical_id:source.canonical_id??null,source_kind:source.source_kind??'npc_duel' } };
  }) };
}

function validateTaskRelations(tasks,sets) {
  const taskIds = new Set(tasks.map((task) => task.canonical_id));
  for (const task of tasks) {
    for (const id of [...task.prerequisites,...task.successors]) assert(taskIds.has(id),`Task relation leaves browser package: ${task.canonical_id} -> ${id}`);
    for (const id of [task.receive_location_canonical_id,task.submit_location_canonical_id,task.target_location_canonical_id].filter(Boolean)) assert(sets.taskLocationIds.includes(id),`Missing task location ${id}`);
    assert(sets.npcPlacements.some((entry) => entry.npc_canonical_id === task.issuer_npc_canonical_id && entry.location_canonical_id === task.receive_location_canonical_id),`Issuer placement missing: ${task.canonical_id}`);
    assert(sets.npcPlacements.some((entry) => entry.npc_canonical_id === task.completion_npc_canonical_id && entry.location_canonical_id === task.submit_location_canonical_id),`Completion placement missing: ${task.canonical_id}`);
    for (const target of task.targets) {
      assert(target.source_canonical_id,`Target source canonical id missing: ${target.canonical_id}`);
      if (task.blocking_reasons.length) continue;
      if (target.target_kind === 'monster') assert(sets.monsterPlacements.some((entry) => entry.monster_canonical_id === target.entity_canonical_id && entry.location_canonical_id === task.target_location_canonical_id),`Monster placement missing: ${target.canonical_id}`);
      if (target.target_kind === 'item') assert(sets.requiredContentIds.includes(target.entity_canonical_id),`Item definition missing: ${target.canonical_id}`);
      if (target.target_kind === 'npc_duel') assert(sets.requiredNpcIds.includes(target.entity_canonical_id),`NPC duel definition missing: ${target.canonical_id}`);
    }
  }
}


function ensureTaskLocationConnections(nodes,connections,requiredLocationIds) {
  const result=[...connections];
  const byCity=new Map();for(const node of nodes){const list=byCity.get(node.city_canonical_id)??[];list.push(node);byCity.set(node.city_canonical_id,list);}
  for(const [cityId,cityNodes] of byCity){
    const cityNode=cityNodes.find((entry)=>entry.node_kind==='city');if(!cityNode)continue;
    const adjacency=new Map(cityNodes.map((entry)=>[entry.map_node_canonical_id,[]]));
    for(const edge of result){if(adjacency.has(edge.from_map_node_canonical_id)&&adjacency.has(edge.to_map_node_canonical_id)){
      adjacency.get(edge.from_map_node_canonical_id).push(edge.to_map_node_canonical_id);adjacency.get(edge.to_map_node_canonical_id).push(edge.from_map_node_canonical_id);}}
    const visited=new Set([cityNode.map_node_canonical_id]);const queue=[cityNode.map_node_canonical_id];
    while(queue.length)for(const next of adjacency.get(queue.shift())??[])if(!visited.has(next)){visited.add(next);queue.push(next);}
    for(const node of cityNodes.filter((entry)=>entry.location_canonical_id&&requiredLocationIds.includes(entry.location_canonical_id)&&!visited.has(entry.map_node_canonical_id))){
      const key=`${cityNode.map_node_canonical_id}|${node.map_node_canonical_id}`;
      result.push({canonical_id:`runtime.location_connection.${shortHash(key)}`,source_canonical_id:'runtime.global-task-location-entrance',
        from_map_node_canonical_id:cityNode.map_node_canonical_id,to_map_node_canonical_id:node.map_node_canonical_id,relation_type:'contains',directed:0,
        runtime_capability:'queryable',resolution_rule:'minimal_city_entrance_for_source_task_location'});
      visited.add(node.map_node_canonical_id);
    }
  }
  return result.sort(byCanonical('canonical_id'));
}

function validateLocalReachability(nodes,connections,requiredLocationIds) {
  const nodeByLocation = new Map(nodes.filter((node) => node.location_canonical_id).map((node) => [node.location_canonical_id,node.map_node_canonical_id]));
  const adjacency = new Map(nodes.map((node) => [node.map_node_canonical_id,[]]));
  for (const edge of connections) {
    adjacency.get(edge.from_map_node_canonical_id)?.push(edge.to_map_node_canonical_id);
    adjacency.get(edge.to_map_node_canonical_id)?.push(edge.from_map_node_canonical_id);
  }
  for (const cityId of unique(nodes.map((node) => node.city_canonical_id))) {
    const cityNodes = nodes.filter((node) => node.city_canonical_id === cityId);
    const start = cityNodes[0]?.map_node_canonical_id;
    const visited = new Set(start ? [start] : []);
    const queue = start ? [start] : [];
    while (queue.length) for (const next of adjacency.get(queue.shift()) ?? []) if (!visited.has(next)) { visited.add(next);queue.push(next); }
    for (const locationId of requiredLocationIds) {
      const nodeId = nodeByLocation.get(locationId);
      const node = nodes.find((entry) => entry.map_node_canonical_id === nodeId);
      if (node?.city_canonical_id === cityId) assert(visited.has(nodeId),`Task location is disconnected inside city: ${locationId}`);
    }
  }
}

function countEntities(body) {
  return Object.fromEntries(['tasks','cities','locations','map_nodes','location_connections','npcs','npc_placements','monsters','monster_placements','content_entities','item_sources']
    .map((key) => [key,body[key].length]).concat([['ships',body.ships.length],['voyage_routes',body.voyage_routes.length],['shops',body.shops.length],
      ['shop_entries',body.shop_entries.length],['equipment',body.equipment.length],['drop_relations',body.drop_relations.length]]));
}

function selectIn(db,sql,values) {
  if (!values.length) return [];
  return db.prepare(sql.replace('__IN__',values.map(() => '?').join(','))).all(...values).map(normalizeNumbers);
}

function selectInTwice(db,sql,first,second) {
  return db.prepare(sql.replace('__IN1__',first.map(() => '?').join(',')).replace('__IN2__',second.map(() => '?').join(',')))
    .all(...first,...second).map(normalizeNumbers);
}

function normalizeNumbers(row) { return Object.fromEntries(Object.entries(row).map(([key,value]) => [key,typeof value === 'bigint' ? Number(value) : value])); }
function parseJsonField(source,target) { return (entry) => { const result={ ...entry,[target]:JSON.parse(entry[source]) };delete result[source];return result; }; }
function unique(values) { return [...new Set(values)]; }
function byCanonical(field) { return (a,b) => a[field].localeCompare(b[field]); }
function normalizeCityName(value) { return String(value??'').replace('(PK)',''); }
function shortHash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0,16); }
function dedupeByCanonical(values) { return [...new Map(values.map((entry)=>[entry.canonical_id,entry])).values()].sort(byCanonical('canonical_id')); }
function nauticalMiles(from,to) { const [fromLng,fromLat]=from.split(',').map(Number);const [toLng,toLat]=to.split(',').map(Number);
  const radians=(degrees)=>degrees*Math.PI/180;const latitude=radians(toLat-fromLat);const longitude=radians(toLng-fromLng);
  const a=Math.sin(latitude/2)**2+Math.cos(radians(fromLat))*Math.cos(radians(toLat))*Math.sin(longitude/2)**2;
  return Math.round((6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)))/1.852); }
function assert(condition,message) { if (!condition) throw new Error(message); }
function stableJson(value) { if (value===null||typeof value!=='object') return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; }

if (require.main === module) {
  const output = exportTask1Content({ databasePath:process.argv[2] ? path.resolve(process.argv[2]) : defaultDatabase });
  console.log(JSON.stringify({ output:path.relative(root,defaultOutput),content_sha256:output.content_sha256,entity_counts:output.entity_counts },null,2));
}

module.exports = { exportTask1Content };
