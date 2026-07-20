PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Restoration source layer. Baseline records and approved overlay records remain distinct.
CREATE TABLE IF NOT EXISTS restoration_records (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE,
  record_origin TEXT NOT NULL CHECK(record_origin IN ('baseline', 'overlay')),
  entity_kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  raw_value_json TEXT NOT NULL CHECK(json_valid(raw_value_json)),
  normalized_value_json TEXT NOT NULL CHECK(json_valid(normalized_value_json)),
  restoration_status TEXT NOT NULL,
  confidence TEXT,
  originality_status TEXT,
  decision_reason TEXT,
  conflicts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(conflicts_json)),
  runtime_selection TEXT NOT NULL CHECK(runtime_selection IN ('baseline_normalized', 'unresolved_conflict', 'approved_overlay')),
  content_hash TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS source_evidence (
  id INTEGER PRIMARY KEY,
  restoration_record_id INTEGER NOT NULL REFERENCES restoration_records(id) ON DELETE CASCADE,
  source_repository TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  source_commit TEXT NOT NULL CHECK(length(source_commit) = 40),
  original_value_summary TEXT,
  UNIQUE(restoration_record_id, source_repository, source_path, source_locator, source_commit)
) STRICT;

CREATE TABLE IF NOT EXISTS restoration_resolutions (
  id INTEGER PRIMARY KEY,
  resolution_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  derived_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id),
  derived_canonical_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  restoration_status TEXT NOT NULL,
  originality_status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  runtime_policy TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  unresolved_fields_json TEXT NOT NULL CHECK(json_valid(unresolved_fields_json)),
  created_from_baseline_commit TEXT NOT NULL CHECK(length(created_from_baseline_commit) = 40),
  content_hash TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS resolution_evidence (
  resolution_id INTEGER NOT NULL REFERENCES restoration_resolutions(id) ON DELETE CASCADE,
  evidence_record_id INTEGER NOT NULL REFERENCES restoration_records(id),
  evidence_canonical_id TEXT NOT NULL,
  PRIMARY KEY(resolution_id, evidence_record_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS restoration_conflicts (
  id INTEGER PRIMARY KEY,
  conflict_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id) ON DELETE CASCADE,
  subject_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id) ON DELETE CASCADE,
  candidate_values_json TEXT NOT NULL CHECK(json_valid(candidate_values_json)),
  runtime_policy TEXT NOT NULL CHECK(runtime_policy = 'unresolved'),
  selected_candidate_json TEXT CHECK(selected_candidate_json IS NULL OR json_valid(selected_candidate_json))
) STRICT;

-- World and map layer.
CREATE TABLE IF NOT EXISTS world_regions (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  display_name TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cities (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  display_name TEXT NOT NULL, grid_rows INTEGER NOT NULL, grid_columns_max INTEGER NOT NULL,
  grid_json TEXT NOT NULL CHECK(json_valid(grid_json))
) STRICT;

CREATE TABLE IF NOT EXISTS city_regions (
  city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  world_region_id INTEGER NOT NULL REFERENCES world_regions(id) ON DELETE CASCADE,
  PRIMARY KEY(city_id, world_region_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  city_id INTEGER REFERENCES cities(id), world_region_id INTEGER REFERENCES world_regions(id),
  display_name TEXT NOT NULL, description TEXT, is_derived INTEGER NOT NULL DEFAULT 0 CHECK(is_derived IN (0,1)),
  CHECK(city_id IS NOT NULL OR world_region_id IS NOT NULL)
) STRICT;

CREATE TABLE IF NOT EXISTS map_nodes (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  node_kind TEXT NOT NULL CHECK(node_kind IN ('city','location')),
  city_id INTEGER REFERENCES cities(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id),
  display_name TEXT NOT NULL, runtime_capability TEXT NOT NULL CHECK(runtime_capability='queryable'),
  CHECK((node_kind='city' AND city_id IS NOT NULL AND location_id IS NULL) OR
        (node_kind='location' AND city_id IS NULL AND location_id IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS location_connections (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  from_node_id INTEGER NOT NULL REFERENCES map_nodes(id), to_node_id INTEGER NOT NULL REFERENCES map_nodes(id),
  relation_type TEXT NOT NULL, directed INTEGER NOT NULL CHECK(directed IN (0,1)),
  runtime_capability TEXT NOT NULL CHECK(runtime_capability='queryable'), CHECK(from_node_id<>to_node_id)
) STRICT;

-- NPC definitions and placements.
CREATE TABLE IF NOT EXISTS npc_definitions (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  display_name TEXT NOT NULL, level INTEGER, npc_type INTEGER,
  identity_basis TEXT NOT NULL CHECK(identity_basis='exact_name_level_type_signature')
) STRICT;

CREATE TABLE IF NOT EXISTS npc_definition_sources (
  npc_definition_id INTEGER NOT NULL REFERENCES npc_definitions(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id) ON DELETE CASCADE,
  PRIMARY KEY(npc_definition_id, source_record_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS npc_placements (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  npc_definition_id INTEGER NOT NULL REFERENCES npc_definitions(id), map_node_id INTEGER NOT NULL REFERENCES map_nodes(id),
  location_id INTEGER NOT NULL REFERENCES locations(id), runtime_capability TEXT NOT NULL CHECK(runtime_capability='queryable')
) STRICT;

-- Unified content identity plus category-specific extensions.
CREATE TABLE IF NOT EXISTS content_entities (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  entity_category TEXT NOT NULL CHECK(entity_category IN ('item','equipment','ship','fish','pet')),
  display_name TEXT NOT NULL, raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json)),
  normalized_data_json TEXT NOT NULL CHECK(json_valid(normalized_data_json))
) STRICT;

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, content_entity_id INTEGER NOT NULL UNIQUE REFERENCES content_entities(id) ON DELETE CASCADE,
  catalog TEXT NOT NULL, price REAL
) STRICT;
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY, content_entity_id INTEGER NOT NULL UNIQUE REFERENCES content_entities(id) ON DELETE CASCADE,
  catalog_key TEXT NOT NULL, level INTEGER, equipment_type INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS ships (
  id INTEGER PRIMARY KEY, content_entity_id INTEGER NOT NULL UNIQUE REFERENCES content_entities(id) ON DELETE CASCADE,
  port TEXT, price REAL, weight REAL, speed REAL
) STRICT;
CREATE TABLE IF NOT EXISTS fish (
  id INTEGER PRIMARY KEY, content_entity_id INTEGER NOT NULL UNIQUE REFERENCES content_entities(id) ON DELETE CASCADE,
  rarity TEXT, price REAL, locations_json TEXT NOT NULL CHECK(json_valid(locations_json))
) STRICT;
CREATE TABLE IF NOT EXISTS pets (
  id INTEGER PRIMARY KEY, content_entity_id INTEGER NOT NULL UNIQUE REFERENCES content_entities(id) ON DELETE CASCADE,
  section TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json))
) STRICT;

-- Monster definitions are separate from baseline placements.
CREATE TABLE IF NOT EXISTS monster_definitions (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  display_name TEXT NOT NULL, level INTEGER, monster_type INTEGER,
  identity_signature_json TEXT NOT NULL CHECK(json_valid(identity_signature_json)),
  identity_basis TEXT NOT NULL CHECK(identity_basis='exact_name_level_type_and_available_attributes')
) STRICT;
CREATE TABLE IF NOT EXISTS monster_definition_sources (
  monster_definition_id INTEGER NOT NULL REFERENCES monster_definitions(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id) ON DELETE CASCADE,
  PRIMARY KEY(monster_definition_id, source_record_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS monster_placements (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  monster_definition_id INTEGER NOT NULL REFERENCES monster_definitions(id), location_id INTEGER REFERENCES locations(id),
  raw_city_name TEXT NOT NULL, raw_location_name TEXT NOT NULL,
  location_resolution_status TEXT NOT NULL CHECK(location_resolution_status IN ('resolved','source_label_only')),
  raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json)), normalized_data_json TEXT NOT NULL CHECK(json_valid(normalized_data_json)),
  runtime_capability TEXT NOT NULL CHECK(runtime_capability IN ('queryable','blocked'))
) STRICT;

-- Every potentially unresolved relation uses the same explicit resolution vocabulary.
CREATE TABLE IF NOT EXISTS dependency_references (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  reference_context TEXT NOT NULL, raw_name TEXT NOT NULL, raw_category TEXT NOT NULL, raw_quantity TEXT,
  resolution_status TEXT NOT NULL CHECK(resolution_status IN ('resolved','ambiguous','source_label_only','cross_type_suspected','blocked_missing_definition')),
  resolved_content_entity_id INTEGER REFERENCES content_entities(id),
  resolved_monster_definition_id INTEGER REFERENCES monster_definitions(id),
  resolved_npc_definition_id INTEGER REFERENCES npc_definitions(id),
  resolved_location_id INTEGER REFERENCES locations(id),
  candidate_canonical_ids_json TEXT NOT NULL CHECK(json_valid(candidate_canonical_ids_json)),
  runtime_capability TEXT NOT NULL CHECK(runtime_capability IN ('queryable','definition_only','blocked')),
  CHECK(resolution_status<>'resolved' OR
        ((resolved_content_entity_id IS NOT NULL)+(resolved_monster_definition_id IS NOT NULL)+
         (resolved_npc_definition_id IS NOT NULL)+(resolved_location_id IS NOT NULL)=1))
) STRICT;

CREATE TABLE IF NOT EXISTS drop_relations (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  source_reference_id INTEGER NOT NULL REFERENCES dependency_references(id),
  target_reference_id INTEGER NOT NULL REFERENCES dependency_references(id),
  probability REAL, quantity REAL, raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json)),
  runtime_capability TEXT NOT NULL CHECK(runtime_capability IN ('queryable','blocked'))
) STRICT;

CREATE TABLE IF NOT EXISTS shop_definitions (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  region_label TEXT NOT NULL, display_name TEXT NOT NULL, raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json))
) STRICT;
CREATE TABLE IF NOT EXISTS shop_entries (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  shop_definition_id INTEGER NOT NULL REFERENCES shop_definitions(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  content_reference_id INTEGER NOT NULL REFERENCES dependency_references(id), price REAL,
  raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json)), runtime_capability TEXT NOT NULL CHECK(runtime_capability IN ('queryable','blocked'))
) STRICT;
CREATE TABLE IF NOT EXISTS city_price_ranges (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  city_id INTEGER REFERENCES cities(id), raw_city_name TEXT NOT NULL, raw_item_name TEXT NOT NULL,
  content_reference_id INTEGER NOT NULL REFERENCES dependency_references(id), minimum_price REAL, maximum_price REAL,
  currency TEXT, raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json)), runtime_capability TEXT NOT NULL CHECK(runtime_capability IN ('queryable','blocked'))
) STRICT;

CREATE TABLE IF NOT EXISTS trial_definitions (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  display_name TEXT NOT NULL, source_index INTEGER, runtime_index INTEGER,
  raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json)), normalized_data_json TEXT NOT NULL CHECK(json_valid(normalized_data_json)),
  runtime_capability TEXT NOT NULL CHECK(runtime_capability='definition_query_only')
) STRICT;
CREATE TABLE IF NOT EXISTS trial_stage_labels (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  trial_definition_id INTEGER NOT NULL REFERENCES trial_definitions(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  stage_role TEXT NOT NULL CHECK(stage_role IN ('receive','submit','target')), raw_label TEXT NOT NULL,
  location_id INTEGER REFERENCES locations(id), resolution_status TEXT NOT NULL CHECK(resolution_status IN ('resolved','source_label_only'))
) STRICT;

CREATE TABLE IF NOT EXISTS story_nodes (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  display_name TEXT NOT NULL, raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json)), normalized_data_json TEXT NOT NULL CHECK(json_valid(normalized_data_json)),
  runtime_capability TEXT NOT NULL CHECK(runtime_capability='read_only_normalized')
) STRICT;
CREATE TABLE IF NOT EXISTS system_rules (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  display_name TEXT NOT NULL, raw_data_json TEXT NOT NULL CHECK(json_valid(raw_data_json)), normalized_data_json TEXT NOT NULL CHECK(json_valid(normalized_data_json)),
  runtime_capability TEXT NOT NULL CHECK(runtime_capability='read_only_normalized')
) STRICT;

-- All 15 regular task series; no cross-series prerequisite is inferred.
CREATE TABLE IF NOT EXISTS task_series (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  display_name TEXT NOT NULL, source_series INTEGER NOT NULL UNIQUE, runtime_capability TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS task_definitions (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  task_series_id INTEGER NOT NULL REFERENCES task_series(id), sequence_position INTEGER NOT NULL,
  display_name TEXT NOT NULL, task_type TEXT NOT NULL, description TEXT NOT NULL, level_requirement INTEGER,
  raw_issuer_npc TEXT NOT NULL, raw_completion_npc TEXT NOT NULL,
  issuer_npc_definition_id INTEGER REFERENCES npc_definitions(id), completion_npc_definition_id INTEGER REFERENCES npc_definitions(id),
  raw_receive_location TEXT NOT NULL, raw_submit_location TEXT NOT NULL, raw_target_location TEXT NOT NULL,
  receive_location_id INTEGER REFERENCES locations(id), submit_location_id INTEGER REFERENCES locations(id), target_location_id INTEGER REFERENCES locations(id),
  raw_value_json TEXT NOT NULL CHECK(json_valid(raw_value_json)), normalized_value_json TEXT NOT NULL CHECK(json_valid(normalized_value_json)),
  unresolved_fields_json TEXT NOT NULL CHECK(json_valid(unresolved_fields_json)), runtime_capability TEXT NOT NULL,
  UNIQUE(task_series_id, sequence_position)
) STRICT;
CREATE TABLE IF NOT EXISTS task_steps (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL REFERENCES task_definitions(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  step_order INTEGER NOT NULL, step_kind TEXT NOT NULL CHECK(step_kind IN ('accept','objective','submit')),
  npc_definition_id INTEGER REFERENCES npc_definitions(id), location_id INTEGER REFERENCES locations(id),
  original_text TEXT NOT NULL, normalized_text TEXT NOT NULL, runtime_capability TEXT NOT NULL,
  UNIQUE(task_id, step_order)
) STRICT;
CREATE TABLE IF NOT EXISTS task_prerequisites (
  task_id INTEGER NOT NULL REFERENCES task_definitions(id) ON DELETE CASCADE,
  prerequisite_task_id INTEGER NOT NULL REFERENCES task_definitions(id), relation_kind TEXT NOT NULL CHECK(relation_kind='explicit_predecessor'),
  PRIMARY KEY(task_id, prerequisite_task_id), CHECK(task_id<>prerequisite_task_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS task_targets (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL REFERENCES task_definitions(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  target_order INTEGER NOT NULL, target_kind TEXT NOT NULL, dependency_reference_id INTEGER NOT NULL REFERENCES dependency_references(id),
  raw_name TEXT NOT NULL, raw_quantity TEXT, normalized_quantity INTEGER, raw_value_json TEXT NOT NULL CHECK(json_valid(raw_value_json)),
  UNIQUE(task_id, target_order)
) STRICT;
CREATE TABLE IF NOT EXISTS task_rewards (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL REFERENCES task_definitions(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  reward_order INTEGER NOT NULL, reward_kind TEXT NOT NULL, reward_name TEXT NOT NULL,
  raw_quantity TEXT NOT NULL, normalized_quantity INTEGER, dependency_reference_id INTEGER NOT NULL REFERENCES dependency_references(id),
  raw_value_json TEXT NOT NULL CHECK(json_valid(raw_value_json)), UNIQUE(task_id, reward_order)
) STRICT;
CREATE TABLE IF NOT EXISTS task_dialogues (
  id INTEGER PRIMARY KEY, canonical_id TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL REFERENCES task_definitions(id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES restoration_records(id), source_canonical_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('receive','submit')), line_order INTEGER NOT NULL,
  original_text TEXT NOT NULL, normalized_text TEXT NOT NULL, UNIQUE(task_id, phase, line_order)
) STRICT;

-- Player runtime layer. Static definitions above remain immutable and are referenced by canonical id.
CREATE TABLE IF NOT EXISTS player_profiles (
  canonical_id TEXT PRIMARY KEY,
  current_map_node_canonical_id TEXT NOT NULL REFERENCES map_nodes(canonical_id),
  money INTEGER NOT NULL DEFAULT 0 CHECK(money >= 0),
  experience INTEGER NOT NULL DEFAULT 0 CHECK(experience >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS player_unlocked_map_nodes (
  player_canonical_id TEXT NOT NULL REFERENCES player_profiles(canonical_id) ON DELETE CASCADE,
  map_node_canonical_id TEXT NOT NULL REFERENCES map_nodes(canonical_id),
  PRIMARY KEY(player_canonical_id, map_node_canonical_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS player_tasks (
  player_canonical_id TEXT NOT NULL REFERENCES player_profiles(canonical_id) ON DELETE CASCADE,
  task_canonical_id TEXT NOT NULL REFERENCES task_definitions(canonical_id),
  status TEXT NOT NULL CHECK(status IN ('locked','available','accepted','in_progress','completable','completed','blocked')),
  current_step INTEGER NOT NULL DEFAULT 0 CHECK(current_step >= 0),
  reward_status TEXT NOT NULL DEFAULT 'not_granted' CHECK(reward_status IN ('not_granted','granted','granted_with_source_label_records')),
  block_reason_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(block_reason_json)),
  PRIMARY KEY(player_canonical_id, task_canonical_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS player_task_progress (
  player_canonical_id TEXT NOT NULL,
  task_canonical_id TEXT NOT NULL,
  target_canonical_id TEXT NOT NULL REFERENCES task_targets(canonical_id),
  current_quantity INTEGER NOT NULL DEFAULT 0 CHECK(current_quantity >= 0),
  PRIMARY KEY(player_canonical_id, task_canonical_id, target_canonical_id),
  FOREIGN KEY(player_canonical_id, task_canonical_id)
    REFERENCES player_tasks(player_canonical_id, task_canonical_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS player_inventory (
  player_canonical_id TEXT NOT NULL REFERENCES player_profiles(canonical_id) ON DELETE CASCADE,
  content_entity_canonical_id TEXT NOT NULL REFERENCES content_entities(canonical_id),
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  PRIMARY KEY(player_canonical_id, content_entity_canonical_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS player_reward_grants (
  player_canonical_id TEXT NOT NULL REFERENCES player_profiles(canonical_id) ON DELETE CASCADE,
  task_canonical_id TEXT NOT NULL REFERENCES task_definitions(canonical_id),
  reward_canonical_id TEXT NOT NULL REFERENCES task_rewards(canonical_id),
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  effect_status TEXT NOT NULL CHECK(effect_status IN ('applied','recorded_source_label_only')),
  PRIMARY KEY(player_canonical_id, reward_canonical_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS player_story_flags (
  player_canonical_id TEXT NOT NULL REFERENCES player_profiles(canonical_id) ON DELETE CASCADE,
  flag_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  PRIMARY KEY(player_canonical_id, flag_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS player_processed_events (
  player_canonical_id TEXT NOT NULL REFERENCES player_profiles(canonical_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('talk_to_npc','arrive_at_location','defeat_monster','obtain_item','consume_item','submit_to_npc')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  processed_at TEXT NOT NULL,
  PRIMARY KEY(player_canonical_id, event_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_locations_city ON locations(city_id);
CREATE INDEX IF NOT EXISTS idx_connections_from ON location_connections(from_node_id);
CREATE INDEX IF NOT EXISTS idx_connections_to ON location_connections(to_node_id);
CREATE INDEX IF NOT EXISTS idx_npc_placements_location ON npc_placements(location_id);
CREATE INDEX IF NOT EXISTS idx_monster_placements_location ON monster_placements(location_id);
CREATE INDEX IF NOT EXISTS idx_content_name ON content_entities(display_name, entity_category);
CREATE INDEX IF NOT EXISTS idx_monster_name ON monster_definitions(display_name);
CREATE INDEX IF NOT EXISTS idx_dependency_status ON dependency_references(resolution_status, reference_context);
CREATE INDEX IF NOT EXISTS idx_tasks_series ON task_definitions(task_series_id, sequence_position);
CREATE INDEX IF NOT EXISTS idx_evidence_record ON source_evidence(restoration_record_id);
CREATE INDEX IF NOT EXISTS idx_player_tasks_status ON player_tasks(player_canonical_id, status);
