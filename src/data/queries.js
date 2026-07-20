'use strict';

function allCities(db) {
  return db.prepare(`SELECT c.canonical_id,c.display_name,group_concat(r.display_name,', ') regions FROM cities c LEFT JOIN city_regions cr ON cr.city_id=c.id LEFT JOIN world_regions r ON r.id=cr.world_region_id GROUP BY c.id ORDER BY c.display_name,c.canonical_id`).all();
}

function cityLocations(db, city) {
  return db.prepare(`SELECT l.canonical_id,l.display_name,l.description,l.is_derived FROM locations l JOIN cities c ON c.id=l.city_id WHERE c.canonical_id=? OR c.display_name=? ORDER BY l.display_name,l.canonical_id`).all(city, city);
}

function adjacentLocations(db, location) {
  return db.prepare(`
    WITH selected_nodes AS (
      SELECT mn.id FROM map_nodes mn LEFT JOIN locations l ON l.id=mn.location_id LEFT JOIN cities c ON c.id=l.city_id
      WHERE l.canonical_id=? OR l.display_name=? OR mn.display_name=? OR c.display_name||l.display_name=? OR c.display_name||'-'||l.display_name=?
    )
    SELECT lc.canonical_id connection_canonical_id,lc.relation_type,lc.directed,lc.runtime_capability,
      CASE WHEN lc.from_node_id IN selected_nodes THEN target.node_kind ELSE source.node_kind END adjacent_kind,
      CASE WHEN lc.from_node_id IN selected_nodes THEN target.display_name ELSE source.display_name END adjacent_name,
      CASE WHEN lc.from_node_id IN selected_nodes THEN target.canonical_id ELSE source.canonical_id END adjacent_canonical_id
    FROM location_connections lc JOIN map_nodes source ON source.id=lc.from_node_id JOIN map_nodes target ON target.id=lc.to_node_id
    WHERE lc.from_node_id IN selected_nodes OR lc.to_node_id IN selected_nodes ORDER BY lc.canonical_id
  `).all(location, location, location, location, location);
}

function locationNpcs(db, location) {
  return db.prepare(`SELECT p.canonical_id placement_canonical_id,d.canonical_id npc_definition_canonical_id,d.display_name,d.level,d.npc_type,p.runtime_capability
    FROM npc_placements p JOIN npc_definitions d ON d.id=p.npc_definition_id JOIN locations l ON l.id=p.location_id JOIN cities c ON c.id=l.city_id
    WHERE l.canonical_id=? OR l.display_name=? OR c.display_name||l.display_name=? OR c.display_name||'-'||l.display_name=? ORDER BY d.display_name,p.canonical_id`).all(location, location, location, location);
}

function taskSeries(db, series='task.series.01') {
  return db.prepare(`SELECT t.canonical_id,t.sequence_position,t.display_name,t.task_type,t.runtime_capability,
    prerequisite.canonical_id predecessor_canonical_id,successor.canonical_id successor_canonical_id
    FROM task_definitions t JOIN task_series s ON s.id=t.task_series_id
    LEFT JOIN task_prerequisites p ON p.task_id=t.id LEFT JOIN task_definitions prerequisite ON prerequisite.id=p.prerequisite_task_id
    LEFT JOIN task_prerequisites sp ON sp.prerequisite_task_id=t.id LEFT JOIN task_definitions successor ON successor.id=sp.task_id
    WHERE s.canonical_id=? ORDER BY t.sequence_position`).all(series);
}

function taskDetails(db, task) {
  const definition=db.prepare(`SELECT t.canonical_id,t.display_name,t.task_type,t.description,t.level_requirement,
    coalesce(issuer.display_name,t.raw_issuer_npc) issuer_npc,coalesce(completion.display_name,t.raw_completion_npc) completion_npc,
    coalesce(receive.display_name,t.raw_receive_location) receive_location,coalesce(submit.display_name,t.raw_submit_location) submit_location,
    coalesce(target.display_name,t.raw_target_location) target_location,t.runtime_capability,t.unresolved_fields_json,t.source_canonical_id
    FROM task_definitions t LEFT JOIN npc_definitions issuer ON issuer.id=t.issuer_npc_definition_id
    LEFT JOIN npc_definitions completion ON completion.id=t.completion_npc_definition_id LEFT JOIN locations receive ON receive.id=t.receive_location_id
    LEFT JOIN locations submit ON submit.id=t.submit_location_id LEFT JOIN locations target ON target.id=t.target_location_id
    WHERE t.canonical_id=? OR t.display_name=? ORDER BY t.sequence_position LIMIT 1`).get(task,task);
  if(!definition)return null;const id=db.prepare('SELECT id FROM task_definitions WHERE canonical_id=?').get(definition.canonical_id).id;
  return {...definition,
    prerequisites:db.prepare(`SELECT p.canonical_id,p.display_name FROM task_prerequisites x JOIN task_definitions p ON p.id=x.prerequisite_task_id WHERE x.task_id=?`).all(id),
    steps:db.prepare('SELECT step_order,step_kind,original_text,normalized_text,runtime_capability FROM task_steps WHERE task_id=? ORDER BY step_order').all(id),
    targets:db.prepare(`SELECT x.target_order,x.target_kind,x.raw_name,x.raw_quantity,x.normalized_quantity,r.resolution_status,r.candidate_canonical_ids_json,
      ce.canonical_id content_canonical_id,m.canonical_id monster_canonical_id,n.canonical_id npc_canonical_id,l.canonical_id location_canonical_id
      FROM task_targets x JOIN dependency_references r ON r.id=x.dependency_reference_id
      LEFT JOIN content_entities ce ON ce.id=r.resolved_content_entity_id LEFT JOIN monster_definitions m ON m.id=r.resolved_monster_definition_id
      LEFT JOIN npc_definitions n ON n.id=r.resolved_npc_definition_id LEFT JOIN locations l ON l.id=r.resolved_location_id
      WHERE x.task_id=? ORDER BY x.target_order`).all(id),
    dialogues:db.prepare(`SELECT phase,line_order,original_text FROM task_dialogues WHERE task_id=? ORDER BY CASE phase WHEN 'receive' THEN 1 ELSE 2 END,line_order`).all(id),
    rewards:db.prepare(`SELECT x.reward_order,x.reward_kind,x.reward_name,x.raw_quantity,x.normalized_quantity,r.resolution_status,r.candidate_canonical_ids_json
      FROM task_rewards x JOIN dependency_references r ON r.id=x.dependency_reference_id WHERE x.task_id=? ORDER BY x.reward_order`).all(id),
  };
}

function provenance(db, canonicalId) {
  let record=db.prepare(`SELECT canonical_id,record_origin,entity_kind,display_name,restoration_status,confidence,originality_status,decision_reason,conflicts_json,runtime_selection,raw_value_json,normalized_value_json FROM restoration_records WHERE canonical_id=?`).get(canonicalId);
  if(!record){const source=db.prepare(`SELECT rr.canonical_id FROM restoration_records rr JOIN (
    SELECT source_record_id,canonical_id FROM world_regions UNION ALL SELECT source_record_id,canonical_id FROM cities UNION ALL
    SELECT source_record_id,canonical_id FROM locations UNION ALL SELECT source_record_id,canonical_id FROM location_connections UNION ALL
    SELECT source_record_id,canonical_id FROM npc_definitions UNION ALL SELECT source_record_id,canonical_id FROM npc_placements UNION ALL
    SELECT source_record_id,canonical_id FROM content_entities UNION ALL SELECT source_record_id,canonical_id FROM monster_definitions UNION ALL
    SELECT source_record_id,canonical_id FROM monster_placements UNION ALL SELECT source_record_id,canonical_id FROM drop_relations UNION ALL
    SELECT source_record_id,canonical_id FROM shop_definitions UNION ALL SELECT source_record_id,canonical_id FROM shop_entries UNION ALL
    SELECT source_record_id,canonical_id FROM city_price_ranges UNION ALL SELECT source_record_id,canonical_id FROM trial_definitions UNION ALL
    SELECT source_record_id,canonical_id FROM trial_stage_labels UNION ALL SELECT source_record_id,canonical_id FROM story_nodes UNION ALL
    SELECT source_record_id,canonical_id FROM system_rules UNION ALL SELECT source_record_id,canonical_id FROM task_series UNION ALL
    SELECT source_record_id,canonical_id FROM task_definitions UNION ALL SELECT source_record_id,canonical_id FROM task_steps UNION ALL
    SELECT source_record_id,canonical_id FROM task_targets UNION ALL SELECT source_record_id,canonical_id FROM task_rewards UNION ALL
    SELECT source_record_id,canonical_id FROM task_dialogues UNION ALL SELECT source_record_id,canonical_id FROM dependency_references
  ) x ON x.source_record_id=rr.id WHERE x.canonical_id=? LIMIT 1`).get(canonicalId);if(!source)return null;record=db.prepare(`SELECT canonical_id,record_origin,entity_kind,display_name,restoration_status,confidence,originality_status,decision_reason,conflicts_json,runtime_selection,raw_value_json,normalized_value_json FROM restoration_records WHERE canonical_id=?`).get(source.canonical_id);}
  const sources=db.prepare(`SELECT source_repository,source_path,source_locator,source_commit,original_value_summary FROM source_evidence e JOIN restoration_records r ON r.id=e.restoration_record_id WHERE r.canonical_id=? ORDER BY e.id`).all(record.canonical_id);
  const resolution=db.prepare(`SELECT x.resolution_id,x.action,x.runtime_policy,x.decision_reason,x.unresolved_fields_json,x.created_from_baseline_commit FROM restoration_resolutions x WHERE x.derived_canonical_id=?`).get(record.canonical_id)??null;
  const evidence=resolution?db.prepare(`SELECT re.evidence_canonical_id FROM resolution_evidence re JOIN restoration_resolutions rr ON rr.id=re.resolution_id WHERE rr.resolution_id=? ORDER BY re.evidence_canonical_id`).all(resolution.resolution_id).map(x=>x.evidence_canonical_id):[];
  return {...record,sources,resolution:resolution?{...resolution,evidence_canonical_ids:evidence}:null};
}

function staticCounts(db){return Object.fromEntries(['world_regions','cities','locations','location_connections','npc_placements','items','equipment','monster_placements','drop_relations','shop_definitions','city_price_ranges','ships','fish','pets','trial_definitions','story_nodes','system_rules','restoration_conflicts','task_definitions'].map(t=>[t,Number(db.prepare(`SELECT COUNT(*) count FROM ${t}`).get().count)]));}
function dependencySummary(db){return db.prepare(`SELECT resolution_status,COUNT(*) count FROM dependency_references GROUP BY resolution_status ORDER BY resolution_status`).all().map(r=>({...r,count:Number(r.count)}));}
function trialDetails(db, trial){const row=db.prepare(`SELECT * FROM trial_definitions WHERE canonical_id=? OR display_name=? LIMIT 1`).get(trial,trial);if(!row)return null;return{...row,stage_labels:db.prepare(`SELECT stage_role,raw_label,resolution_status,l.canonical_id location_canonical_id FROM trial_stage_labels s LEFT JOIN locations l ON l.id=s.location_id WHERE s.trial_definition_id=? ORDER BY s.id`).all(row.id)};}

module.exports={adjacentLocations,allCities,cityLocations,dependencySummary,locationNpcs,provenance,staticCounts,taskDetails,taskSeries,trialDetails};
