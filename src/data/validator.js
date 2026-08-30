'use strict';

const path = require('node:path');
const { hash } = require('./database');
const { readBaseline, readOverlay } = require('./importer');

const EXPECTED_COUNTS = {
  world_regions:6,cities:40,locations:642,location_connections:627,npc_placements:645,
  items:211,equipment:423,monster_placements:285,drop_relations:2777,shop_definitions:63,
  city_price_ranges:54,ships:14,fish:21,pets:8,trial_definitions:12,story_nodes:20,
  system_rules:26,task_definitions:651,restoration_conflicts:32,
};
const EXPECTED_SERIES={1:13,2:1,3:1,4:7,5:19,6:1,7:3,8:4,9:2,10:10,11:28,12:13,13:69,14:10,15:470};

function scalar(db,sql,...params){return Number(db.prepare(sql).get(...params).count);}

function validateDatabase(db,options={}){
  const baselinePath=path.resolve(options.baselinePath??'docs/reconstruction-baseline/multisource-baseline.json');
  const overlayPath=path.resolve(options.overlayPath??'docs/reconstruction-baseline/restoration-resolution-overlay.json');
  const {baseline,bytes:baselineBytes}=readBaseline(baselinePath);const {overlay,bytes:overlayBytes}=readOverlay(overlayPath);
  const counts=Object.fromEntries(Object.keys(EXPECTED_COUNTS).map(t=>[t,scalar(db,`SELECT COUNT(*) count FROM ${t}`)]));
  const checks=[];const check=(name,passed,details)=>checks.push({name,passed:Boolean(passed),details});
  for(const [table,expected] of Object.entries(EXPECTED_COUNTS))check(`count.${table}`,counts[table]===expected,{expected,actual:counts[table]});
  check('count.baseline_locations',scalar(db,"SELECT COUNT(*) count FROM locations WHERE is_derived=0")===641,{expected:641,actual:scalar(db,"SELECT COUNT(*) count FROM locations WHERE is_derived=0")});
  check('count.derived_locations',scalar(db,"SELECT COUNT(*) count FROM locations WHERE is_derived=1")===1,{expected:1,actual:scalar(db,"SELECT COUNT(*) count FROM locations WHERE is_derived=1")});
  const series=Object.fromEntries(db.prepare(`SELECT s.source_series,COUNT(t.id) count FROM task_series s LEFT JOIN task_definitions t ON t.task_series_id=s.id GROUP BY s.id ORDER BY s.source_series`).all().map(r=>[Number(r.source_series),Number(r.count)]));
  check('task_series_counts',JSON.stringify(series)===JSON.stringify(EXPECTED_SERIES),{expected:EXPECTED_SERIES,actual:series});
  check('foreign_keys',db.prepare('PRAGMA foreign_key_check').all().length===0,{violations:db.prepare('PRAGMA foreign_key_check').all()});
  const metadata=Object.fromEntries(db.prepare('SELECT key,value FROM schema_metadata').all().map(r=>[r.key,r.value]));
  check('baseline_bytes_unchanged',metadata.baseline_sha256===hash(baselineBytes),{expected:metadata.baseline_sha256,actual:hash(baselineBytes)});
  check('overlay_bytes_match',metadata.overlay_sha256===hash(overlayBytes),{expected:metadata.overlay_sha256,actual:hash(overlayBytes)});
  const overlayEvidence=scalar(db,`SELECT COUNT(*) count FROM resolution_evidence re JOIN restoration_resolutions rr ON rr.id=re.resolution_id WHERE rr.derived_canonical_id='derived.location.7a7f7b6127a89313'`);
  check('overlay_three_evidence_records',overlayEvidence===3,{expected:3,actual:overlayEvidence});
  const overlayIds=db.prepare(`SELECT re.evidence_canonical_id FROM resolution_evidence re JOIN restoration_resolutions rr ON rr.id=re.resolution_id WHERE rr.derived_canonical_id='derived.location.7a7f7b6127a89313' ORDER BY 1`).all().map(r=>r.evidence_canonical_id);
  const expectedOverlayIds=[...overlay.resolutions[0].evidence_canonical_ids].sort();check('overlay_evidence_exact',JSON.stringify(overlayIds)===JSON.stringify(expectedOverlayIds),{expected:expectedOverlayIds,actual:overlayIds});
  const connection=db.prepare(`SELECT runtime_capability FROM location_connections WHERE canonical_id='entity.location_connection.bcedd08f9944c48b'`).get();
  const placement=db.prepare(`SELECT runtime_capability,location_id FROM npc_placements WHERE canonical_id='entity.npc_placement.8b4f15b70705a612'`).get();
  check('niutoushan_connection_queryable',connection?.runtime_capability==='queryable',connection??null);
  check('niutoushan_npc_queryable',placement?.runtime_capability==='queryable'&&placement.location_id!==null,placement??null);
  check('no_unresolved_map_nodes',scalar(db,"SELECT COUNT(*) count FROM map_nodes WHERE node_kind NOT IN ('city','location')")===0,{actual:scalar(db,"SELECT COUNT(*) count FROM map_nodes WHERE node_kind NOT IN ('city','location')")});
  check('trial_floors_not_world_locations',scalar(db,"SELECT COUNT(*) count FROM locations WHERE display_name GLOB '牛头山第*层'")===0,{actual:scalar(db,"SELECT COUNT(*) count FROM locations WHERE display_name GLOB '牛头山第*层'")});
  const conflictSelections=scalar(db,"SELECT COUNT(*) count FROM restoration_conflicts WHERE runtime_policy<>'unresolved' OR selected_candidate_json IS NOT NULL");
  check('conflicts_unresolved',counts.restoration_conflicts===32&&conflictSelections===0,{total:counts.restoration_conflicts,selected:conflictSelections});
  const crossSeries=scalar(db,`SELECT COUNT(*) count FROM task_prerequisites p JOIN task_definitions t ON t.id=p.task_id JOIN task_definitions q ON q.id=p.prerequisite_task_id WHERE t.task_series_id<>q.task_series_id`);
  check('no_cross_series_prerequisites',crossSeries===0,{actual:crossSeries});
  const edges=db.prepare('SELECT task_id,prerequisite_task_id FROM task_prerequisites').all();const predecessor=new Map(edges.map(e=>[Number(e.task_id),Number(e.prerequisite_task_id)]));const cycles=[];for(const start of predecessor.keys()){const seen=new Set();let current=start;while(predecessor.has(current)){if(seen.has(current)){cycles.push(start);break;}seen.add(current);current=predecessor.get(current);}}
  check('task_prerequisite_acyclic',cycles.length===0,{cycle_start_ids:cycles});
  const baselineRecords=baseline.tasks.length+baseline.story.length+baseline.configs.records.length+Object.values(baseline.configs.entities).reduce((n,x)=>n+x.length,0)+baseline.systems.length+baseline.conflicts.length+baseline.implementation_backlog.length;
  check('source_layer_complete',scalar(db,"SELECT COUNT(*) count FROM restoration_records WHERE record_origin='baseline'")===baselineRecords,{expected:baselineRecords,actual:scalar(db,"SELECT COUNT(*) count FROM restoration_records WHERE record_origin='baseline'")});
  const missingProvenance=scalar(db,`SELECT COUNT(*) count FROM restoration_records r WHERE (r.record_origin='baseline' AND NOT EXISTS(SELECT 1 FROM source_evidence e WHERE e.restoration_record_id=r.id)) OR (r.record_origin='overlay' AND NOT EXISTS(SELECT 1 FROM restoration_resolutions x WHERE x.derived_record_id=r.id))`);
  check('complete_provenance',missingProvenance===0,{missing:missingProvenance});
  const fakeLabels=scalar(db,"SELECT COUNT(*) count FROM content_entities WHERE display_name='声望'")+scalar(db,"SELECT COUNT(*) count FROM monster_definitions WHERE display_name IN ('白云果','破碎的破界符')");
  check('unresolved_labels_not_fabricated',fakeLabels===0,{fabricated:fakeLabels});
  const resolutionCounts=Object.fromEntries(db.prepare('SELECT resolution_status,COUNT(*) count FROM dependency_references GROUP BY resolution_status').all().map(r=>[r.resolution_status,Number(r.count)]));
  const knownStatuses=['resolved','ambiguous','source_label_only','cross_type_suspected','blocked_missing_definition'];
  check('dependency_status.known_only',Object.keys(resolutionCounts).every((k)=>knownStatuses.includes(k)),{unknown:Object.keys(resolutionCounts).filter((k)=>!knownStatuses.includes(k))});
  const canonicalTables=['restoration_records','world_regions','cities','locations','location_connections','npc_definitions','npc_placements','content_entities','monster_definitions','monster_placements','drop_relations','shop_definitions','shop_entries','city_price_ranges','trial_definitions','trial_stage_labels','story_nodes','system_rules','task_series','task_definitions','task_steps','task_targets','task_rewards','task_dialogues','dependency_references'];
  const duplicates=Object.fromEntries(canonicalTables.map(t=>[t,scalar(db,`SELECT COUNT(*) count FROM (SELECT canonical_id FROM ${t} GROUP BY canonical_id HAVING COUNT(*)>1)`)]));check('canonical_id_uniqueness',Object.values(duplicates).every(n=>n===0),duplicates);
  return{validated_at:new Date().toISOString(),node_version:process.version,baseline_schema_version:baseline.meta.schema_version,overlay_schema_version:overlay.schema_version,baseline_sha256:hash(baselineBytes),overlay_sha256:hash(overlayBytes),counts,task_series_counts:series,dependency_resolution_counts:resolutionCounts,checks,passed:checks.every(x=>x.passed)};
}

module.exports={EXPECTED_COUNTS,EXPECTED_SERIES,validateDatabase};
