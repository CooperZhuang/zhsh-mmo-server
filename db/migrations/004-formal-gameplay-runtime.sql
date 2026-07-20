PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS player_gameplay_state (
  player_canonical_id TEXT PRIMARY KEY REFERENCES player_profiles(canonical_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
) STRICT;

INSERT INTO schema_metadata(key, value) VALUES ('formal_gameplay_runtime_schema_version', '2')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
