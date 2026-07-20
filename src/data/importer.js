'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  PROJECT_ROOT, createStats, getId, hash, initializeSchema, openDatabase, stableJson,
  upsertCanonical, upsertComposite,
} = require('./database');

const SUPPORTED_BASELINE_SCHEMA = '2.0.0';
const SUPPORTED_OVERLAY_SCHEMA = '1.0.0';
const DEFAULT_BASELINE_PATH = path.join(PROJECT_ROOT, 'docs', 'reconstruction-baseline', 'multisource-baseline.json');
const DEFAULT_OVERLAY_PATH = path.join(PROJECT_ROOT, 'docs', 'reconstruction-baseline', 'restoration-resolution-overlay.json');
const DEFAULT_DATABASE_PATH = path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite');
const REQUIRED_OVERLAY_FIELDS = [
  'resolution_id', 'action', 'entity_kind', 'derived_canonical_id', 'display_name', 'restoration_status',
  'originality_status', 'confidence', 'runtime_policy', 'evidence_canonical_ids', 'decision_reason',
  'unresolved_fields', 'created_from_baseline_commit',
];

function readJsonFile(filename, label) {
  const bytes = fs.readFileSync(filename);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${label} JSON must be UTF-8 without BOM`);
  }
  try { return { value: JSON.parse(bytes.toString('utf8')), bytes }; }
  catch (error) { throw new Error(`${label} JSON parse failed: ${error.message}`); }
}

function validateBaselineShape(baseline) {
  if (baseline?.meta?.schema_version !== SUPPORTED_BASELINE_SCHEMA) {
    throw new Error(`Unsupported baseline schema/version: expected ${SUPPORTED_BASELINE_SCHEMA}, got ${baseline?.meta?.schema_version ?? 'missing'}`);
  }
  for (const key of ['tasks', 'story', 'systems', 'conflicts', 'implementation_backlog']) {
    if (!Array.isArray(baseline[key])) throw new Error(`Baseline schema validation failed: ${key} must be an array`);
  }
  if (!Array.isArray(baseline.configs?.records) || !baseline.configs?.entities || !baseline.configs?.entity_statistics) {
    throw new Error('Baseline schema validation failed: configs records/entities/statistics are required');
  }
  if (baseline.tasks.length !== baseline.meta.statistics.tasks || baseline.conflicts.length !== baseline.meta.statistics.conflicts) {
    throw new Error('Baseline schema validation failed: top-level statistics do not match arrays');
  }
  for (const [collection, expected] of Object.entries(baseline.configs.entity_statistics)) {
    if (!Array.isArray(baseline.configs.entities[collection]) || baseline.configs.entities[collection].length !== expected) {
      throw new Error(`Baseline schema validation failed: configs.entities.${collection} expected ${expected}`);
    }
  }
}

function readBaseline(baselinePath) {
  const { value: baseline, bytes } = readJsonFile(baselinePath, 'Baseline');
  validateBaselineShape(baseline);
  return { baseline, bytes };
}

function readOverlay(overlayPath) {
  const { value: overlay, bytes } = readJsonFile(overlayPath, 'Overlay');
  if (overlay?.schema_version !== SUPPORTED_OVERLAY_SCHEMA || !Array.isArray(overlay.resolutions)) {
    throw new Error(`Overlay schema validation failed: expected schema_version=${SUPPORTED_OVERLAY_SCHEMA} and resolutions[]`);
  }
  const ids = new Set();
  for (const [index, resolution] of overlay.resolutions.entries()) {
    for (const field of REQUIRED_OVERLAY_FIELDS) {
      if (!Object.hasOwn(resolution, field)) throw new Error(`Overlay schema validation failed: resolutions[${index}].${field} is required`);
    }
    if (!Array.isArray(resolution.evidence_canonical_ids) || resolution.evidence_canonical_ids.length === 0) {
      throw new Error(`Overlay schema validation failed: ${resolution.resolution_id} requires evidence_canonical_ids`);
    }
    if (!Array.isArray(resolution.unresolved_fields) || !/^[0-9a-f]{40}$/.test(resolution.created_from_baseline_commit)) {
      throw new Error(`Overlay schema validation failed: ${resolution.resolution_id} has invalid unresolved_fields or commit`);
    }
    if (ids.has(resolution.resolution_id)) throw new Error(`Overlay schema validation failed: duplicate ${resolution.resolution_id}`);
    ids.add(resolution.resolution_id);
  }
  return { overlay, bytes };
}

function allBaselineRecords(baseline) {
  return [
    ...baseline.tasks, ...baseline.story, ...baseline.configs.records,
    ...Object.values(baseline.configs.entities).flat(), ...baseline.systems,
    ...baseline.conflicts, ...baseline.implementation_backlog,
  ];
}

function recordKind(record) {
  if (record.entity_type) return record.entity_type;
  if (record.canonical_id?.startsWith('task.')) return 'task';
  if (record.canonical_id?.startsWith('conflict.')) return 'conflict';
  return record.canonical_id?.split('.')[0] ?? 'unknown';
}

function sourceRecordValues(record, origin = 'baseline') {
  const normalized = record.normalized_data ?? record.canonical_value ?? null;
  const raw = Object.hasOwn(record, 'raw_data') ? record.raw_data : (normalized?.raw_source_record ?? normalized);
  const status = record.status ?? record.evidence_classification ?? 'UNKNOWN';
  return {
    canonical_id: record.canonical_id,
    record_origin: origin,
    entity_kind: recordKind(record),
    display_name: record.display_name ?? record.original_display_name ?? record.canonical_id,
    raw_value_json: stableJson(raw), normalized_value_json: stableJson(normalized), restoration_status: status,
    confidence: record.confidence ?? null, originality_status: record.originality_status ?? normalized?.originality_status ?? null,
    decision_reason: record.decision_reason ?? null, conflicts_json: stableJson(record.conflicts ?? normalized?.conflict_refs ?? []),
    runtime_selection: status === 'CONFLICT' ? 'unresolved_conflict' : (origin === 'overlay' ? 'approved_overlay' : 'baseline_normalized'),
    content_hash: hash(record),
  };
}

function importSourceRecord(db, record, stats) {
  const row = upsertCanonical(db, 'restoration_records', sourceRecordValues(record), stats);
  for (const source of record.sources ?? []) {
    upsertComposite(db, 'source_evidence', {
      restoration_record_id: Number(row.id), source_repository: source.repository,
      source_path: source.relative_path, source_locator: source.locator, source_commit: source.commit,
    }, { original_value_summary: source.original_value_summary ?? null }, stats);
  }
  return Number(row.id);
}

function signatureCanonical(prefix, value) { return `${prefix}.${hash(value, 16)}`; }
function locationKey(city, name) { return `${city}\u0000${name}`; }
function setMetadata(db, key, value, stats) { upsertComposite(db, 'schema_metadata', { key }, { value: String(value) }, stats); }

function importOverlay(db, overlay, recordIndex, stats) {
  const imported = [];
  for (const resolution of overlay.resolutions) {
    const missing = resolution.evidence_canonical_ids.filter((id) => !recordIndex.has(id));
    if (missing.length) throw new Error(`Missing overlay evidence: ${missing.join(', ')}`);
    const overlayRecord = {
      canonical_id: resolution.derived_canonical_id,
      entity_type: resolution.entity_kind,
      original_display_name: resolution.display_name,
      raw_data: null,
      normalized_data: resolution.canonical_value ?? null,
      evidence_classification: resolution.restoration_status,
      originality_status: resolution.originality_status,
      confidence: resolution.confidence,
      decision_reason: resolution.decision_reason,
    };
    const sourceRow = upsertCanonical(db, 'restoration_records', sourceRecordValues(overlayRecord, 'overlay'), stats);
    upsertComposite(db, 'restoration_resolutions', { resolution_id: resolution.resolution_id }, {
      action: resolution.action, entity_kind: resolution.entity_kind, derived_record_id: Number(sourceRow.id),
      derived_canonical_id: resolution.derived_canonical_id, display_name: resolution.display_name,
      restoration_status: resolution.restoration_status, originality_status: resolution.originality_status,
      confidence: resolution.confidence, runtime_policy: resolution.runtime_policy,
      decision_reason: resolution.decision_reason, unresolved_fields_json: stableJson(resolution.unresolved_fields),
      created_from_baseline_commit: resolution.created_from_baseline_commit, content_hash: hash(resolution),
    }, stats);
    const stored = db.prepare('SELECT id FROM restoration_resolutions WHERE resolution_id=?').get(resolution.resolution_id);
    for (const evidenceId of resolution.evidence_canonical_ids) {
      upsertComposite(db, 'resolution_evidence', {
        resolution_id: Number(stored.id), evidence_record_id: getId(db, 'restoration_records', evidenceId),
      }, { evidence_canonical_id: evidenceId }, stats);
    }
    imported.push({ resolution, sourceRecordId: Number(sourceRow.id) });
  }
  return imported;
}

function addContentEntity(db, record, category, sourceId, stats) {
  const value = record.normalized_data;
  const row = upsertCanonical(db, 'content_entities', {
    canonical_id: record.canonical_id, source_record_id: sourceId(record.canonical_id), source_canonical_id: record.canonical_id,
    entity_category: category, display_name: value.name ?? record.original_display_name,
    raw_data_json: stableJson(record.raw_data), normalized_data_json: stableJson(value),
  }, stats);
  return Number(row.id);
}

function importStaticContent(db, baseline, overlayRows, sourceId, stats) {
  const e = baseline.configs.entities;
  const regionByName = new Map();
  const cityByName = new Map();
  const locationByKey = new Map();
  const locationByConcatenated = new Map();

  for (const record of e.world_regions) {
    upsertCanonical(db, 'world_regions', { canonical_id: record.canonical_id, source_record_id: sourceId(record.canonical_id), source_canonical_id: record.canonical_id, display_name: record.normalized_data.name }, stats);
    regionByName.set(record.normalized_data.name, record.canonical_id);
  }
  for (const record of e.cities) {
    const v = record.normalized_data;
    upsertCanonical(db, 'cities', { canonical_id: record.canonical_id, source_record_id: sourceId(record.canonical_id), source_canonical_id: record.canonical_id, display_name: v.name, grid_rows: v.grid_rows, grid_columns_max: v.grid_columns_max, grid_json: stableJson(v.grid) }, stats);
    cityByName.set(v.name, record.canonical_id);
  }
  for (const record of e.cities) {
    for (const region of record.normalized_data.regions) {
      const regionCanonical = regionByName.get(region);
      if (!regionCanonical) throw new Error(`Missing dependency: world region ${region}`);
      upsertComposite(db, 'city_regions', { city_id: getId(db, 'cities', record.canonical_id), world_region_id: getId(db, 'world_regions', regionCanonical) }, {}, stats);
    }
  }
  const registerLocation = (city, name, canonical) => {
    locationByKey.set(locationKey(city, name), canonical);
    for (const label of [`${city}${name}`, `${city}-${name}`]) {
      if (locationByConcatenated.has(label) && locationByConcatenated.get(label) !== canonical) throw new Error(`Ambiguous normalized location: ${label}`);
      locationByConcatenated.set(label, canonical);
    }
  };
  for (const record of e.locations) {
    const v = record.normalized_data; const cityCanonical = cityByName.get(v.city);
    if (!cityCanonical) throw new Error(`Missing dependency: city ${v.city} for ${record.canonical_id}`);
    upsertCanonical(db, 'locations', { canonical_id: record.canonical_id, source_record_id: sourceId(record.canonical_id), source_canonical_id: record.canonical_id, city_id: getId(db, 'cities', cityCanonical), world_region_id: null, display_name: v.name, description: v.description ?? '', is_derived: 0 }, stats);
    registerLocation(v.city, v.name, record.canonical_id);
  }
  for (const { resolution, sourceRecordId } of overlayRows) {
    if (resolution.entity_kind !== 'location') continue;
    const v = resolution.canonical_value; const cityCanonical = v.city_canonical_id;
    if (!cityByName.has(v.city_name) || cityByName.get(v.city_name) !== cityCanonical) throw new Error(`Missing dependency: overlay city ${v.city_name}`);
    upsertCanonical(db, 'locations', { canonical_id: resolution.derived_canonical_id, source_record_id: sourceRecordId, source_canonical_id: resolution.derived_canonical_id, city_id: getId(db, 'cities', cityCanonical), world_region_id: null, display_name: v.location_name, description: v.description, is_derived: 1 }, stats);
    registerLocation(v.city_name, v.location_name, resolution.derived_canonical_id);
  }
  for (const record of e.cities) upsertCanonical(db, 'map_nodes', { canonical_id: signatureCanonical('derived.map_node.city', record.canonical_id), node_kind: 'city', city_id: getId(db, 'cities', record.canonical_id), location_id: null, source_record_id: sourceId(record.canonical_id), display_name: record.normalized_data.name, runtime_capability: 'queryable' }, stats);
  for (const row of db.prepare('SELECT canonical_id,source_record_id,display_name FROM locations').all()) upsertCanonical(db, 'map_nodes', { canonical_id: signatureCanonical('derived.map_node.location', row.canonical_id), node_kind: 'location', city_id: null, location_id: getId(db, 'locations', row.canonical_id), source_record_id: Number(row.source_record_id), display_name: row.display_name, runtime_capability: 'queryable' }, stats);
  const cityNode = (id) => getId(db, 'map_nodes', signatureCanonical('derived.map_node.city', id));
  const locationNode = (id) => getId(db, 'map_nodes', signatureCanonical('derived.map_node.location', id));
  for (const record of e.location_connections) {
    const v = record.normalized_data; const cityCanonical = cityByName.get(v.city);
    let from; let to;
    if (v.relation_type === 'interior_location') { from = cityNode(cityCanonical); to = locationNode(locationByKey.get(locationKey(v.city, v.location))); }
    else if (v.relation_type === 'wild_to_entrance') { from = locationNode(locationByKey.get(locationKey(v.city, v.location))); to = locationNode(locationByKey.get(locationKey(v.city, v.entrance))); }
    else throw new Error(`Unsupported connection relation_type ${v.relation_type}`);
    if (!from || !to) throw new Error(`Missing dependency: connection endpoint for ${record.canonical_id}`);
    upsertCanonical(db, 'location_connections', { canonical_id: record.canonical_id, source_record_id: sourceId(record.canonical_id), source_canonical_id: record.canonical_id, from_node_id: from, to_node_id: to, relation_type: v.relation_type, directed: v.relation_type === 'wild_to_entrance' ? 1 : 0, runtime_capability: 'queryable' }, stats);
  }

  const npcGroups = new Map();
  for (const p of e.npc_placements) { const v=p.normalized_data; const sig=stableJson([v.name,v.level??null,v.type??null]); npcGroups.set(sig,[...(npcGroups.get(sig)??[]),p]); }
  const npcDefinitionByPlacement = new Map();
  const npcDefinitionsByName = new Map();
  for (const [sig, placements] of [...npcGroups.entries()].sort()) {
    placements.sort((a,b)=>a.canonical_id.localeCompare(b.canonical_id)); const rep=placements[0]; const v=rep.normalized_data;
    const canonical=signatureCanonical('derived.npc_definition',sig);
    upsertCanonical(db,'npc_definitions',{canonical_id:canonical,source_record_id:sourceId(rep.canonical_id),source_canonical_id:rep.canonical_id,display_name:v.name,level:v.level??null,npc_type:v.type??null,identity_basis:'exact_name_level_type_signature'},stats);
    npcDefinitionsByName.set(v.name,[...(npcDefinitionsByName.get(v.name)??[]),canonical]);
    for(const p of placements){npcDefinitionByPlacement.set(p.canonical_id,canonical);upsertComposite(db,'npc_definition_sources',{npc_definition_id:getId(db,'npc_definitions',canonical),source_record_id:sourceId(p.canonical_id)},{},stats);}
  }
  const npcPlacementsAt = new Map();
  for(const record of e.npc_placements){const v=record.normalized_data;const loc=locationByKey.get(locationKey(v.city,v.location));if(!loc)throw new Error(`Missing dependency: NPC location ${v.city}-${v.location}`);const def=npcDefinitionByPlacement.get(record.canonical_id);upsertCanonical(db,'npc_placements',{canonical_id:record.canonical_id,source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,npc_definition_id:getId(db,'npc_definitions',def),map_node_id:locationNode(loc),location_id:getId(db,'locations',loc),runtime_capability:'queryable'},stats);npcPlacementsAt.set(`${loc}\u0000${v.name}`,[...(npcPlacementsAt.get(`${loc}\u0000${v.name}`)??[]),def]);}

  const contentByCategoryName = new Map();
  const allContentByName = new Map();
  const addIndex=(cat,name,record)=>{contentByCategoryName.set(`${cat}\u0000${name}`,[...(contentByCategoryName.get(`${cat}\u0000${name}`)??[]),record]);allContentByName.set(name,[...(allContentByName.get(name)??[]),record]);};
  for(const [collection,category] of [['items','item'],['equipment','equipment'],['ships','ship'],['fish','fish'],['pets','pet']]){
    for(const record of e[collection]){const v=record.normalized_data;const contentId=addContentEntity(db,record,category,sourceId,stats);addIndex(category,v.name??record.original_display_name,record);
      if(category==='item')upsertComposite(db,'items',{content_entity_id:contentId},{catalog:v.catalog,price:v.price??null},stats);
      if(category==='equipment')upsertComposite(db,'equipment',{content_entity_id:contentId},{catalog_key:v.catalog_key,level:v.level??null,equipment_type:v.type??null},stats);
      if(category==='ship')upsertComposite(db,'ships',{content_entity_id:contentId},{port:v.port??null,price:v.price??null,weight:v.weight??null,speed:v.speed??null},stats);
      if(category==='fish')upsertComposite(db,'fish',{content_entity_id:contentId},{rarity:v.rarity??null,price:v.price??null,locations_json:stableJson(v.locations??[])},stats);
      if(category==='pet')upsertComposite(db,'pets',{content_entity_id:contentId},{section:v.section,value_json:stableJson(v.value)},stats);
    }
  }

  const monsterGroups=new Map();
  for(const p of e.monsters){const v=p.normalized_data;const sig=stableJson([v.name,v.level??null,v.type??null]);monsterGroups.set(sig,[...(monsterGroups.get(sig)??[]),p]);}
  const monsterDefByPlacement=new Map(); const monsterDefsByName=new Map(); const monsterDefsAt=new Map();
  for(const [sig,placements] of [...monsterGroups.entries()].sort()){placements.sort((a,b)=>a.canonical_id.localeCompare(b.canonical_id));const rep=placements[0],v=rep.normalized_data,canonical=signatureCanonical('derived.monster_definition',sig);upsertCanonical(db,'monster_definitions',{canonical_id:canonical,source_record_id:sourceId(rep.canonical_id),source_canonical_id:rep.canonical_id,display_name:v.name,level:v.level??null,monster_type:v.type??null,identity_signature_json:sig,identity_basis:'exact_name_level_type_and_available_attributes'},stats);monsterDefsByName.set(v.name,[...(monsterDefsByName.get(v.name)??[]),canonical]);for(const p of placements){monsterDefByPlacement.set(p.canonical_id,canonical);upsertComposite(db,'monster_definition_sources',{monster_definition_id:getId(db,'monster_definitions',canonical),source_record_id:sourceId(p.canonical_id)},{},stats);}}
  for(const record of e.monsters){const v=record.normalized_data,loc=locationByKey.get(locationKey(v.city,v.location))??null;const def=monsterDefByPlacement.get(record.canonical_id);upsertCanonical(db,'monster_placements',{canonical_id:record.canonical_id,source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,monster_definition_id:getId(db,'monster_definitions',def),location_id:loc?getId(db,'locations',loc):null,raw_city_name:v.city,raw_location_name:v.location,location_resolution_status:loc?'resolved':'source_label_only',raw_data_json:stableJson(record.raw_data),normalized_data_json:stableJson(v),runtime_capability:loc?'queryable':'blocked'},stats);if(loc)monsterDefsAt.set(`${loc}\u0000${v.name}`,[...(monsterDefsAt.get(`${loc}\u0000${v.name}`)??[]),def]);}

  const contentRank=(record,context)=>{const cat=record.normalized_data.catalog;if(context==='shop')return({shopItems:0,allItems:1,taskItems:2}[cat]??9);return({taskItems:0,allItems:1,shopItems:2}[cat]??9);};
  const createReference=(canonicalId,sourceCanonical,context,rawName,rawCategory,rawQuantity,desired,extra={})=>{
    let candidates=[];let chosen=null;let status;let resolved={};
    if(desired==='label'){status='source_label_only';}
    else if(desired==='monster'){
      const preferred=extra.locationCanonical?monsterDefsAt.get(`${extra.locationCanonical}\u0000${rawName}`)??[]:[];
      candidates=[...new Set(preferred.length?preferred:(monsterDefsByName.get(rawName)??[]))].map(id=>({canonical_id:id,id:getId(db,'monster_definitions',id)}));
      if(candidates.length===1){status='resolved';chosen=candidates[0];resolved.resolved_monster_definition_id=chosen.id;}
    }else if(desired==='npc'){
      const preferred=extra.locationCanonical?npcPlacementsAt.get(`${extra.locationCanonical}\u0000${rawName}`)??[]:[];
      candidates=[...new Set(preferred.length?preferred:(npcDefinitionsByName.get(rawName)??[]))].map(id=>({canonical_id:id,id:getId(db,'npc_definitions',id)}));
      if(candidates.length===1){status='resolved';chosen=candidates[0];resolved.resolved_npc_definition_id=chosen.id;}
    }else if(desired==='location'){
      const id=locationByConcatenated.get(rawName)??null;candidates=id?[{canonical_id:id,id:getId(db,'locations',id)}]:[];
      if(id){status='resolved';chosen=candidates[0];resolved.resolved_location_id=chosen.id;}
    }else{
      const category=desired.replace('content:','');const records=[...(contentByCategoryName.get(`${category}\u0000${rawName}`)??[])];
      candidates=records.map(r=>({canonical_id:r.canonical_id,id:getId(db,'content_entities',r.canonical_id)}));
      if(category==='item'&&candidates.length>1){records.sort((a,b)=>contentRank(a,extra.context)-contentRank(b,extra.context)||a.canonical_id.localeCompare(b.canonical_id));chosen={canonical_id:records[0].canonical_id,id:getId(db,'content_entities',records[0].canonical_id)};status='resolved';resolved.resolved_content_entity_id=chosen.id;}
      else if(candidates.length===1){chosen=candidates[0];status='resolved';resolved.resolved_content_entity_id=chosen.id;}
    }
    if(!status){if(candidates.length>1)status='ambiguous';else {const other=(allContentByName.get(rawName)??[]).map(r=>r.canonical_id);const monster=monsterDefsByName.get(rawName)??[];const npc=npcDefinitionsByName.get(rawName)??[];const cross=[...new Set([...other,...monster,...npc])];if(cross.length){status='cross_type_suspected';candidates=cross.map(canonical_id=>({canonical_id}));}else status=extra.missingStatus??'blocked_missing_definition';}}
    const row=upsertCanonical(db,'dependency_references',{canonical_id:canonicalId,source_record_id:sourceId(sourceCanonical),source_canonical_id:sourceCanonical,reference_context:context,raw_name:rawName,raw_category:rawCategory,raw_quantity:rawQuantity==null?null:String(rawQuantity),resolution_status:status,resolved_content_entity_id:resolved.resolved_content_entity_id??null,resolved_monster_definition_id:resolved.resolved_monster_definition_id??null,resolved_npc_definition_id:resolved.resolved_npc_definition_id??null,resolved_location_id:resolved.resolved_location_id??null,candidate_canonical_ids_json:stableJson(candidates.map(c=>c.canonical_id)),runtime_capability:status==='resolved'?'queryable':(status==='source_label_only'?'definition_only':'blocked')},stats);
    return {id:Number(row.id),status,candidates:candidates.map(c=>c.canonical_id),chosen:chosen?.canonical_id??null};
  };

  for(const record of e.drops){const v=record.normalized_data;const source=createReference(`${record.canonical_id}.source`,record.canonical_id,'drop_source',v.monster,'monster',null,'monster',{missingStatus:'source_label_only'});const desired=`content:${v.dropped_entity_type==='equipment'?'equipment':'item'}`;const target=createReference(`${record.canonical_id}.target`,record.canonical_id,'drop_target',v.dropped_name,v.dropped_entity_type,v.quantity,desired,{missingStatus:'source_label_only'});upsertCanonical(db,'drop_relations',{canonical_id:record.canonical_id,source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,source_reference_id:source.id,target_reference_id:target.id,probability:v.probability??null,quantity:v.quantity??null,raw_data_json:stableJson(record.raw_data),runtime_capability:source.status==='resolved'&&target.status==='resolved'?'queryable':'blocked'},stats);}
  for(const record of e.shops){const v=record.normalized_data;upsertCanonical(db,'shop_definitions',{canonical_id:record.canonical_id,source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,region_label:v.region,display_name:`${v.region}-${v.item_name}`,raw_data_json:stableJson(record.raw_data)},stats);const ref=createReference(`${record.canonical_id}.entry.reference`,record.canonical_id,'shop_entry',v.item_name,'item',1,'content:item',{context:'shop',missingStatus:'source_label_only'});upsertCanonical(db,'shop_entries',{canonical_id:`${record.canonical_id}.entry`,shop_definition_id:getId(db,'shop_definitions',record.canonical_id),source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,content_reference_id:ref.id,price:v.price??null,raw_data_json:stableJson(record.raw_data),runtime_capability:ref.status==='resolved'?'queryable':'blocked'},stats);}
  for(const record of e.city_price_ranges){const v=record.normalized_data;const ref=createReference(`${record.canonical_id}.reference`,record.canonical_id,'city_price_range',v.item_name,'item',null,'content:item',{context:'shop',missingStatus:'source_label_only'});upsertCanonical(db,'city_price_ranges',{canonical_id:record.canonical_id,source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,city_id:cityByName.has(v.city)?getId(db,'cities',cityByName.get(v.city)):null,raw_city_name:v.city,raw_item_name:v.item_name,content_reference_id:ref.id,minimum_price:v.minimum_price??null,maximum_price:v.maximum_price??null,currency:v.currency??null,raw_data_json:stableJson(record.raw_data),runtime_capability:ref.status==='resolved'&&cityByName.has(v.city)?'queryable':'blocked'},stats);}
  for(const record of e.trials){const v=record.normalized_data;upsertCanonical(db,'trial_definitions',{canonical_id:record.canonical_id,source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,display_name:v.name,source_index:v.source_index??null,runtime_index:v.runtime_index??null,raw_data_json:stableJson(record.raw_data),normalized_data_json:stableJson(v),runtime_capability:'definition_query_only'},stats);for(const [role,label] of [['receive',v.receive_location],['submit',v.submit_location],['target',v.target_location]]){if(!label)continue;const loc=locationByConcatenated.get(label)??null;upsertCanonical(db,'trial_stage_labels',{canonical_id:`${record.canonical_id}.stage.${role}`,trial_definition_id:getId(db,'trial_definitions',record.canonical_id),source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,stage_role:role,raw_label:label,location_id:loc?getId(db,'locations',loc):null,resolution_status:loc?'resolved':'source_label_only'},stats);}}
  for(const record of baseline.story)upsertCanonical(db,'story_nodes',{canonical_id:record.canonical_id,source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,display_name:record.display_name,raw_data_json:stableJson(record.canonical_value?.raw_source_record??record.canonical_value),normalized_data_json:stableJson(record.canonical_value),runtime_capability:'read_only_normalized'},stats);
  for(const record of baseline.systems)upsertCanonical(db,'system_rules',{canonical_id:record.canonical_id,source_record_id:sourceId(record.canonical_id),source_canonical_id:record.canonical_id,display_name:record.display_name,raw_data_json:stableJson(record.canonical_value?.raw_source_record??record.canonical_value),normalized_data_json:stableJson(record.canonical_value),runtime_capability:'read_only_normalized'},stats);

  return { cityByName, locationByConcatenated, locationByKey, npcDefinitionsByName, npcPlacementsAt, createReference };
}

function importTasks(db, baseline, selectedSeries, context, sourceId, stats) {
  const tasks=baseline.tasks.filter(t=>selectedSeries.includes(t.canonical_value.source_series));
  for(const series of selectedSeries){const rows=tasks.filter(t=>t.canonical_value.source_series===series).sort((a,b)=>a.canonical_value.source_array_position-b.canonical_value.source_array_position);if(!rows.length)throw new Error(`Missing dependency: task series ${series}`);upsertCanonical(db,'task_series',{canonical_id:`task.series.${String(series).padStart(2,'0')}`,source_record_id:sourceId(rows[0].canonical_id),source_canonical_id:rows[0].canonical_id,display_name:rows[0].canonical_value.chapter_or_stage??`任务系列 ${series}`,source_series:series,runtime_capability:'definition_query_only_partial_gameplay_systems'},stats);}
  const resolveLocation=(label)=>label?(context.locationByConcatenated.get(label)??null):null;
  const resolveNpc=(name,loc)=>{const preferred=loc?context.npcPlacementsAt.get(`${loc}\u0000${name}`)??[]:[];const candidates=[...new Set(preferred.length?preferred:(context.npcDefinitionsByName.get(name)??[]))];return candidates.length===1?candidates[0]:null;};
  for(const task of tasks){const v=task.canonical_value;const receive=resolveLocation(v.receive_location),submit=resolveLocation(v.submit_location),target=resolveLocation(v.target_location);const issuer=resolveNpc(v.issuer_npc,receive),completion=resolveNpc(v.completion_npc,submit);const unresolved=[];if(!receive)unresolved.push('receive_location');if(!submit)unresolved.push('submit_location');if(v.target_location&&!target)unresolved.push('target_location');if(!issuer)unresolved.push('issuer_npc');if(!completion)unresolved.push('completion_npc');upsertCanonical(db,'task_definitions',{canonical_id:task.canonical_id,source_record_id:sourceId(task.canonical_id),source_canonical_id:task.canonical_id,task_series_id:getId(db,'task_series',`task.series.${String(v.source_series).padStart(2,'0')}`),sequence_position:v.source_array_position,display_name:v.task_name,task_type:v.task_type,description:v.description??'',level_requirement:Number.isInteger(v.level_requirement)?v.level_requirement:null,raw_issuer_npc:v.issuer_npc,raw_completion_npc:v.completion_npc,issuer_npc_definition_id:issuer?getId(db,'npc_definitions',issuer):null,completion_npc_definition_id:completion?getId(db,'npc_definitions',completion):null,raw_receive_location:v.receive_location??'',raw_submit_location:v.submit_location??'',raw_target_location:v.target_location??'',receive_location_id:receive?getId(db,'locations',receive):null,submit_location_id:submit?getId(db,'locations',submit):null,target_location_id:target?getId(db,'locations',target):null,raw_value_json:stableJson(v.raw_source_record),normalized_value_json:stableJson(v),unresolved_fields_json:stableJson(unresolved),runtime_capability:unresolved.length?'definition_only_unresolved_dependencies':'definition_queryable_gameplay_not_implemented'},stats);}
  for(const task of tasks){const v=task.canonical_value,taskId=getId(db,'task_definitions',task.canonical_id),sourceRecordId=sourceId(task.canonical_id);const receive=resolveLocation(v.receive_location),submit=resolveLocation(v.submit_location),target=resolveLocation(v.target_location);const issuer=resolveNpc(v.issuer_npc,receive),completion=resolveNpc(v.completion_npc,submit);const steps=[['accept',issuer,receive,(v.dialogue.receive??[]).join('\n')],['objective',null,target,v.description??''],['submit',completion,submit,(v.dialogue.submit??[]).join('\n')]];for(const [i,[kind,npc,loc,text]] of steps.entries())upsertCanonical(db,'task_steps',{canonical_id:`${task.canonical_id}.step.${kind}`,task_id:taskId,source_record_id:sourceRecordId,source_canonical_id:task.canonical_id,step_order:i+1,step_kind:kind,npc_definition_id:npc?getId(db,'npc_definitions',npc):null,location_id:loc?getId(db,'locations',loc):null,original_text:text,normalized_text:text,runtime_capability:(npc||loc||kind==='objective')?'definition_only':'blocked'},stats);
    const targets=[];for(const x of v.required_items??[])targets.push({kind:'item',desired:'content:item',...x});for(const x of v.kill_targets??[])targets.push({kind:'monster',desired:'monster',...x});if(!targets.length)targets.push({kind:'npc',desired:'npc',name:v.completion_npc,quantity:null});for(const [i,x] of targets.entries()){const ref=context.createReference(`${task.canonical_id}.target.${String(i+1).padStart(2,'0')}.reference`,task.canonical_id,'task_target',x.name,x.kind,v.raw_quantity,x.desired,{locationCanonical:x.kind==='monster'?target:(x.kind==='npc'?submit:null),missingStatus:'blocked_missing_definition'});upsertCanonical(db,'task_targets',{canonical_id:`${task.canonical_id}.target.${String(i+1).padStart(2,'0')}`,task_id:taskId,source_record_id:sourceRecordId,source_canonical_id:task.canonical_id,target_order:i+1,target_kind:x.kind,dependency_reference_id:ref.id,raw_name:x.name,raw_quantity:v.raw_quantity==null?null:String(v.raw_quantity),normalized_quantity:x.quantity??null,raw_value_json:stableJson(x)},stats);}
    const rewards=[];if(v.rewards?.experience!==undefined)rewards.push({kind:'experience',name:'经验',quantity:v.rewards.experience,desired:'label'});for(const [name,quantity] of Object.entries(v.rewards?.money??{}))rewards.push({kind:'money',name,quantity,desired:'label'});for(const [name,quantity] of Object.entries(v.rewards?.items??{}))rewards.push({kind:'item',name,quantity,desired:'content:item'});for(const [i,x] of rewards.entries()){const ref=context.createReference(`${task.canonical_id}.reward.${String(i+1).padStart(2,'0')}.reference`,task.canonical_id,'task_reward',x.name,x.kind,x.quantity,x.desired,{missingStatus:'source_label_only'});upsertCanonical(db,'task_rewards',{canonical_id:`${task.canonical_id}.reward.${String(i+1).padStart(2,'0')}`,task_id:taskId,source_record_id:sourceRecordId,source_canonical_id:task.canonical_id,reward_order:i+1,reward_kind:x.kind,reward_name:x.name,raw_quantity:String(v.rewards.raw?.[x.name]??x.quantity),normalized_quantity:Number.isFinite(Number(x.quantity))?Number(x.quantity):null,dependency_reference_id:ref.id,raw_value_json:stableJson({[x.name]:v.rewards.raw?.[x.name]??x.quantity})},stats);}
    for(const phase of ['receive','submit'])for(const [i,line] of (v.dialogue[phase]??[]).entries())upsertCanonical(db,'task_dialogues',{canonical_id:`${task.canonical_id}.dialogue.${phase}.${String(i+1).padStart(2,'0')}`,task_id:taskId,source_record_id:sourceRecordId,source_canonical_id:task.canonical_id,phase,line_order:i+1,original_text:line,normalized_text:line},stats);
  }
  const selectedIds=new Set(tasks.map(t=>t.canonical_id));
  for(const task of tasks){const pred=task.canonical_value.predecessor_task;if(!pred)continue;if(!selectedIds.has(pred))throw new Error(`Cross-series or missing predecessor ${pred} for ${task.canonical_id}`);upsertComposite(db,'task_prerequisites',{task_id:getId(db,'task_definitions',task.canonical_id),prerequisite_task_id:getId(db,'task_definitions',pred)},{relation_kind:'explicit_predecessor'},stats);}
}

function countRows(db,table){return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);}
function buildCounts(db){const tables=['restoration_records','source_evidence','restoration_resolutions','world_regions','cities','locations','location_connections','npc_definitions','npc_placements','content_entities','items','equipment','ships','fish','pets','monster_definitions','monster_placements','drop_relations','shop_definitions','shop_entries','city_price_ranges','trial_definitions','trial_stage_labels','story_nodes','system_rules','task_series','task_definitions','task_steps','task_prerequisites','task_targets','task_rewards','task_dialogues','dependency_references','restoration_conflicts'];return Object.fromEntries(tables.map(t=>[t,countRows(db,t)]));}
function resolutionCounts(db){return Object.fromEntries(db.prepare('SELECT resolution_status,COUNT(*) count FROM dependency_references GROUP BY resolution_status').all().map(r=>[r.resolution_status,Number(r.count)]));}

function importContent(db,baseline,baselineBytes,overlay,overlayBytes,options,stats){
  const records=allBaselineRecords(baseline);const recordIndex=new Map(records.map(r=>[r.canonical_id,r]));
  for(const record of [...records].sort((a,b)=>a.canonical_id.localeCompare(b.canonical_id)))importSourceRecord(db,record,stats);
  const overlayRows=importOverlay(db,overlay,recordIndex,stats);
  const sourceId=id=>getId(db,'restoration_records',id);
  setMetadata(db,'schema_version','2',stats);setMetadata(db,'baseline_schema_version',baseline.meta.schema_version,stats);setMetadata(db,'baseline_sha256',hash(baselineBytes),stats);setMetadata(db,'overlay_schema_version',overlay.schema_version,stats);setMetadata(db,'overlay_sha256',hash(overlayBytes),stats);setMetadata(db,'baseline_project_commit',baseline.meta.project_baseline_commit,stats);
  const context=importStaticContent(db,baseline,overlayRows,sourceId,stats);
  const series=options.scope==='static'?[]:(options.taskSeries?[Number(options.taskSeries)]:[...new Set(baseline.tasks.map(t=>t.canonical_value.source_series))].sort((a,b)=>a-b));
  if(series.some(n=>!Number.isInteger(n)||n<1||n>15))throw new Error(`Invalid task series: ${options.taskSeries}`);
  importTasks(db,baseline,series,context,sourceId,stats);
  for(const conflict of baseline.conflicts){const subject=conflict.canonical_value.subject_id;if(!recordIndex.has(subject))throw new Error(`Missing dependency: conflict subject ${subject}`);upsertComposite(db,'restoration_conflicts',{conflict_record_id:sourceId(conflict.canonical_id)},{subject_record_id:sourceId(subject),candidate_values_json:stableJson(conflict.canonical_value),runtime_policy:'unresolved',selected_candidate_json:null},stats);}stats.conflicts=baseline.conflicts.length;
  setMetadata(db,'import_scope',options.scope==='static'?'static':(options.taskSeries?`static+task_series_${options.taskSeries}`:'static+all_task_series'),stats);
}

function runImport(options={}){
  if (options.scope !== undefined && options.scope !== 'static') throw new Error(`Unsupported import scope: ${options.scope}`);
  if (options.scope === 'static' && options.taskSeries !== undefined) throw new Error('--scope static cannot be combined with --task-series');
  const baselinePath=path.resolve(options.baselinePath??DEFAULT_BASELINE_PATH),overlayPath=path.resolve(options.overlayPath??DEFAULT_OVERLAY_PATH),databasePath=path.resolve(options.databasePath??DEFAULT_DATABASE_PATH),dryRun=Boolean(options.dryRun);
  const {baseline,bytes:baselineBytes}=readBaseline(baselinePath);const {overlay,bytes:overlayBytes}=readOverlay(overlayPath);const db=openDatabase(dryRun?':memory:':databasePath),stats=createStats();
  try{initializeSchema(db);db.exec('BEGIN IMMEDIATE');importContent(db,baseline,baselineBytes,overlay,overlayBytes,options,stats);const counts=buildCounts(db),resolutions=resolutionCounts(db),integrity=db.prepare('PRAGMA foreign_key_check').all();if(integrity.length)throw new Error(`Foreign key validation failed: ${stableJson(integrity)}`);if(dryRun)db.exec('ROLLBACK');else db.exec('COMMIT');return{ok:true,dry_run:dryRun,scope:options.scope??'all',task_series:options.taskSeries?Number(options.taskSeries):null,baseline_file:path.relative(PROJECT_ROOT,baselinePath).replaceAll('\\','/'),overlay_file:path.relative(PROJECT_ROOT,overlayPath).replaceAll('\\','/'),database_file:dryRun?null:path.relative(PROJECT_ROOT,databasePath).replaceAll('\\','/'),baseline_schema_version:baseline.meta.schema_version,overlay_schema_version:overlay.schema_version,node_version:process.version,operations:stats,baseline_entity_counts:baseline.configs.entity_statistics,derived_entity_counts:{locations:overlay.resolutions.filter(r=>r.entity_kind==='location').length},entity_counts:counts,dependency_resolution_counts:resolutions,foreign_key_violations:integrity.length};}
  catch(error){stats.failures+=1;try{db.exec('ROLLBACK');}catch{}error.importStats=stats;throw error;}finally{db.close();}
}

module.exports={DEFAULT_BASELINE_PATH,DEFAULT_OVERLAY_PATH,DEFAULT_DATABASE_PATH,SUPPORTED_BASELINE_SCHEMA,SUPPORTED_OVERLAY_SCHEMA,readBaseline,readOverlay,runImport};
