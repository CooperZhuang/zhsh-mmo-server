PRAGMA foreign_keys = ON;

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
CREATE INDEX IF NOT EXISTS idx_player_tasks_status ON player_tasks(player_canonical_id, status);
INSERT INTO schema_metadata(key, value) VALUES ('task_runtime_schema_version', '1')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
