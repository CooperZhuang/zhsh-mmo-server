'use strict';
/**
 * rebind-authoritative-assets.js — 离线重绑定（幂等）
 *
 * integrate-authoritative-assets.js 的 `resolveMapping` 已把绑定规则固化（名称族/
 * 任务文本/渔获/船型/功能槽位）；上游打包目录（master_manifest.csv +
 * authoritative_asset_registry.json + merged_final_assets）不在本机时，
 * 以 docs/design/authoritative-asset-mapping.csv（含全部 manifest 字段）为 manifest
 * 输入，用同一 resolveMapping 对当前 web/generated/task1-content.json 重算绑定，
 * 写回运行时注册表与映射 CSV（与生成器输出 schema 完全一致）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveMapping, parseCsv } = require('./integrate-authoritative-assets');

const root = path.resolve(__dirname, '..');
const mappingPath = path.join(root, 'docs', 'design', 'authoritative-asset-mapping.csv');
const registryPath = path.join(root, 'web', 'generated', 'authoritative-assets.json');
const contentPath = path.join(root, 'web', 'generated', 'task1-content.json');
const unmappedPath = path.join(root, 'docs', 'design', 'authoritative-asset-unmapped.csv');

function assetVariant(filename) {
  return filename.includes('__rare_glow__') || filename.includes('稀有版') ? 'rare_glow'
    : filename.includes('__drop_flash__') ? 'drop_flash' : 'base';
}
function countBy(values, key) {
  return Object.fromEntries([...new Set(values.map((entry) => entry[key]))].sort().map((value) => [value, values.filter((entry) => entry[key] === value).length]));
}
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function csvCell(value) { const text = Array.isArray(value) ? value.join('|') : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function writeCsv(file, values, headers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [headers.join(','), ...values.map((value) => headers.map((header) => csvCell(value[header] ?? '')).join(','))];
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf8');
}
function main() {
  const manifest = parseCsv(fs.readFileSync(mappingPath, 'utf8'));
  const authoritative = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (manifest.length !== 229 || (authoritative.assets?.length ?? authoritative.length) !== 229) throw new Error(`Expected 229 authoritative assets, got manifest=${manifest.length}, registry=${authoritative.assets?.length ?? authoritative.length}`);
  const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  const entities = [...new Map([
    'content_entities', 'formal_items', 'monsters', 'npcs', 'equipment', 'ships',
  ].flatMap((key) => (content[key] ?? []).map((entry) => ({ ...entry, entity_kind: key })))
    .filter((entry) => entry?.canonical_id && entry?.display_name)
    .map((entry) => [entry.canonical_id, entry])).values()];
  const records = [];
  for (const [index, row] of manifest.entries()) {
    const entry = {
      filename: path.basename(row.source_file),
      display_name: row.display_name,
      category: row.category,
      final_relpath: row.source_file,
      source_batch: row.target_resource_path.match(/batch(\d\d)/)?.[1] ?? '01',
      sha256: row.sha256,
    };
    const mapping = resolveMapping(entry, index, content, entities);
    records.push({
      asset_canonical_id: `visual.asset.${row.sha256.slice(0, 16)}`, source_file: row.source_file,
      source_batch: entry.source_batch, display_name: row.display_name, category: row.category,
      mapping_status: mapping.mapping_status, canonical_id: mapping.canonical_id ?? null,
      family_id: mapping.family_id ?? null, slot_id: mapping.slot_id ?? null,
      visual_reference_id: mapping.visual_reference_id ?? null,
      binding_ids: mapping.binding_ids ?? [], task_reference_ids: mapping.task_reference_ids ?? [],
      target_resource_path: row.target_resource_path, usage_interfaces: mapping.usage_interfaces,
      variant: mapping.variant ?? assetVariant(entry.filename), mapping_reason: mapping.mapping_reason, sha256: row.sha256,
    });
  }
  const unmapped = records.filter((entry) => entry.mapping_status === 'unmapped_catalog_only');
  if (unmapped.length) throw new Error(`Full visual mapping failed for ${unmapped.length} assets: ${unmapped.map((entry) => entry.display_name).join(', ')}`);
  const statusCounts = countBy(records, 'mapping_status');
  const body = {
    schema_version: 2, record_kind: 'authoritative_visual_asset_runtime_registry',
    source_files: ['authoritative_asset_registry.json', 'master_manifest.csv'],
    policy: { overview_assets_allowed: false, deprecated_assets_allowed: false, visual_layer_ids_do_not_create_game_entities: true, name_family_one_asset_many_entities: true, player_compendium_visible: false },
    authoritative_asset_count: records.length, mapped_count: records.length, unmapped_count: 0,
    runtime_mapped_count: records.length, catalog_only_unmapped_count: 0, status_counts: statusCounts, assets: records,
  };
  writeJson(registryPath, body);
  const headers = ['source_file', 'asset_canonical_id', 'display_name', 'category', 'mapping_status', 'canonical_id', 'family_id', 'slot_id', 'visual_reference_id', 'binding_ids', 'task_reference_ids', 'target_resource_path', 'usage_interfaces', 'variant', 'mapping_reason', 'sha256'];
  writeCsv(mappingPath, records, headers);
  writeCsv(unmappedPath, [], headers);
  const bound = records.filter((r) => (r.binding_ids?.length ?? 0) > 0 || (r.task_reference_ids?.length ?? 0) > 0 || r.canonical_id);
  const slotOnly = records.filter((r) => !(r.binding_ids?.length ?? 0) && !(r.task_reference_ids?.length ?? 0) && !r.canonical_id);
  process.stdout.write(`${JSON.stringify({ authoritative_asset_count: records.length, mapped_count: records.length, entity_bound_count: bound.length, slot_only_count: slotOnly.length, status_counts: statusCounts, binding_reference_count: records.reduce((sum, r) => sum + (r.binding_ids?.length ?? 0) + (r.task_reference_ids?.length ?? 0), 0) }, null, 2)}\n`);
}
if (require.main === module) main();
module.exports = { main };
