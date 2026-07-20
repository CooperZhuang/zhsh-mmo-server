const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const baselinePath = path.join(projectRoot, 'docs', 'reconstruction-baseline', 'multisource-baseline.json');
const summaryPath = path.join(projectRoot, 'docs', 'reconstruction-baseline', 'validation-summary.json');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function hasCompleteSource(record) {
  return Array.isArray(record.sources) && record.sources.length > 0 && record.sources.every((item) => (
    typeof item.repository === 'string' && item.repository.length > 0
    && typeof item.relative_path === 'string' && item.relative_path.length > 0
    && typeof item.locator === 'string' && item.locator.length > 0
    && typeof item.commit === 'string' && /^[0-9a-f]{40}$/.test(item.commit)
  ));
}

function main() {
  const bytes = fs.readFileSync(baselinePath);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  check(!hasBom, 'baseline JSON must not contain UTF-8 BOM');

  let baseline;
  try {
    baseline = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    failures.push(`native JSON.parse failed: ${error.message}`);
  }
  if (!baseline) throw new Error(failures.join('\n'));

  const entityCollections = baseline.configs?.entities || {};
  const entityRecords = Object.values(entityCollections).flat();
  const recordGroups = {
    tasks: baseline.tasks || [],
    story: baseline.story || [],
    config_summaries: baseline.configs?.records || [],
    config_entities: entityRecords,
    systems: baseline.systems || [],
    conflicts: baseline.conflicts || [],
    implementation_backlog: baseline.implementation_backlog || [],
  };
  const allRecords = Object.values(recordGroups).flat();

  const idOwners = new Map();
  for (const [group, records] of Object.entries(recordGroups)) {
    for (const record of records) {
      check(typeof record.canonical_id === 'string' && record.canonical_id.length > 0, `${group} record missing canonical_id`);
      if (idOwners.has(record.canonical_id)) failures.push(`duplicate canonical_id ${record.canonical_id} in ${idOwners.get(record.canonical_id)} and ${group}`);
      idOwners.set(record.canonical_id, group);
      check(hasCompleteSource(record), `${record.canonical_id || group} missing complete source provenance`);
    }
  }

  const taskMap = new Map((baseline.tasks || []).map((task) => [task.canonical_id, task]));
  for (const task of baseline.tasks || []) {
    const value = task.canonical_value || {};
    for (const field of ['predecessor_task', 'successor_task']) {
      check(value[field] === null || typeof value[field] === 'string', `${task.canonical_id}.${field} must be string|null`);
      if (typeof value[field] === 'string') check(taskMap.has(value[field]), `${task.canonical_id}.${field} references missing ${value[field]}`);
    }
    if (value.predecessor_task && taskMap.has(value.predecessor_task)) {
      check(taskMap.get(value.predecessor_task).canonical_value.successor_task === task.canonical_id, `${task.canonical_id} predecessor is not symmetric`);
    }
    if (value.successor_task && taskMap.has(value.successor_task)) {
      check(taskMap.get(value.successor_task).canonical_value.predecessor_task === task.canonical_id, `${task.canonical_id} successor is not symmetric`);
    }
  }

  const taskLikeRecords = [
    ...(baseline.tasks || []).map((record) => ({ id: record.canonical_id, value: record.canonical_value })),
    ...((entityCollections.trials || []).map((record) => ({ id: record.canonical_id, value: record.normalized_data }))),
  ];
  for (const { id, value } of taskLikeRecords) {
    for (const field of ['targets', 'required_quantities', 'required_items', 'kill_targets']) {
      check(Array.isArray(value?.[field]), `${id}.${field} must always be an array`);
    }
    if (Array.isArray(value?.required_quantities)) {
      check(value.required_quantities.every((quantity) => quantity === null || typeof quantity === 'number'), `${id}.required_quantities must contain only number|null`);
    }
    for (const field of ['required_items', 'kill_targets']) {
      if (Array.isArray(value?.[field])) {
        check(value[field].every((target) => target && typeof target.name === 'string' && (target.quantity === null || typeof target.quantity === 'number')), `${id}.${field} entries must be {name:string, quantity:number|null}`);
      }
    }
  }

  const task274 = (baseline.tasks || []).find((task) => task.canonical_value?.source_series === 15 && task.canonical_value?.raw_source_record?.index === 274);
  check(Boolean(task274), 'task15/index=274 missing');
  if (task274) {
    check(JSON.stringify(task274.canonical_value.required_quantities) === '[5,null,null]', 'task15/index=274 required_quantities must be [5,null,null]');
    check(task274.canonical_value.raw_quantity === '5', 'task15/index=274 raw_quantity must remain "5"');
    check(Array.isArray(task274.canonical_value.conflict_refs) && task274.canonical_value.conflict_refs.includes('conflict.system.task.progress'), 'task15/index=274 must reference task progress conflict');
  }

  const mapping = baseline.configs?.entity_summary_mapping || {};
  for (const [collection, summaryId] of Object.entries(mapping)) {
    const actual = Array.isArray(entityCollections[collection]) ? entityCollections[collection].length : -1;
    const summary = (baseline.configs.records || []).find((record) => record.canonical_id === summaryId);
    check(Boolean(summary), `missing summary ${summaryId}`);
    check(summary?.canonical_value?.primary_entity_count === actual, `${collection} count ${actual} does not match ${summaryId} primary_entity_count ${summary?.canonical_value?.primary_entity_count}`);
    check(baseline.configs.entity_statistics?.[collection] === actual, `${collection} count does not match configs.entity_statistics`);
  }

  const conflicts = baseline.conflicts || [];
  check(conflicts.length === 32, `expected 32 conflicts, found ${conflicts.length}`);
  const conflictSubjects = new Map();
  for (const conflict of conflicts) {
    const subjectId = conflict.canonical_value?.subject_id;
    check(typeof subjectId === 'string' && idOwners.has(subjectId), `${conflict.canonical_id} references missing subject ${subjectId}`);
    conflictSubjects.set(subjectId, (conflictSubjects.get(subjectId) || 0) + 1);
  }
  const conflictedSubjects = allRecords.filter((record) => record.status === 'CONFLICT' && !record.canonical_id.startsWith('conflict.'));
  check(conflictedSubjects.length === 32, `expected 32 CONFLICT subjects, found ${conflictedSubjects.length}`);
  for (const subject of conflictedSubjects) check(conflictSubjects.get(subject.canonical_id) === 1, `${subject.canonical_id} must map to exactly one conflict`);
  for (const [subjectId, count] of conflictSubjects) check(count === 1, `${subjectId} maps to ${count} conflict records`);

  const entityCounts = Object.fromEntries(Object.entries(entityCollections).map(([key, records]) => [key, records.length]));
  const validation = {
    validated_at: new Date().toISOString(),
    baseline_file: 'docs/reconstruction-baseline/multisource-baseline.json',
    checks: {
      utf8_without_bom: !hasBom,
      native_json_parse: true,
      canonical_id_global_uniqueness: !failures.some((item) => item.includes('canonical_id')),
      complete_source_provenance: !failures.some((item) => item.includes('source provenance')),
      task_chain_closed: !failures.some((item) => item.includes('predecessor') || item.includes('successor')),
      normalized_task_field_types: !failures.some((item) => item.includes('required_quantities') || item.includes('required_items') || item.includes('kill_targets') || item.includes('.targets')),
      entity_counts_match_summaries: !failures.some((item) => item.includes('count')),
      conflicts_one_to_one: conflicts.length === 32 && conflictedSubjects.length === 32 && !failures.some((item) => item.includes('conflict')),
    },
    record_counts: Object.fromEntries(Object.entries(recordGroups).map(([key, records]) => [key, records.length])),
    entity_counts: entityCounts,
    failures,
  };

  if (process.argv.includes('--write-summary')) fs.writeFileSync(summaryPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main();
