-- Rebuildable normalized/source tables from schema version 1.
-- The importer runs this only for an existing v1 runtime database, outside the content import transaction,
-- then recreates the v2 schema and imports the immutable baseline plus approved overlay.
DROP TABLE IF EXISTS player_story_flags;
DROP TABLE IF EXISTS player_inventory;
DROP TABLE IF EXISTS player_task_progress;
DROP TABLE IF EXISTS player_unlocked_locations;
DROP TABLE IF EXISTS player_unlocked_cities;
DROP TABLE IF EXISTS player_profiles;
DROP TABLE IF EXISTS task_dialogues;
DROP TABLE IF EXISTS task_rewards;
DROP TABLE IF EXISTS task_targets;
DROP TABLE IF EXISTS task_prerequisites;
DROP TABLE IF EXISTS task_steps;
DROP TABLE IF EXISTS task_definitions;
DROP TABLE IF EXISTS task_series;
DROP TABLE IF EXISTS monsters;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS npc_placements;
DROP TABLE IF EXISTS npc_definition_sources;
DROP TABLE IF EXISTS npc_definitions;
DROP TABLE IF EXISTS location_connections;
DROP TABLE IF EXISTS map_nodes;
DROP TABLE IF EXISTS locations;
DROP TABLE IF EXISTS city_regions;
DROP TABLE IF EXISTS cities;
DROP TABLE IF EXISTS world_regions;
DROP TABLE IF EXISTS restoration_conflicts;
DROP TABLE IF EXISTS source_evidence;
DROP TABLE IF EXISTS restoration_records;
DROP TABLE IF EXISTS schema_metadata;
