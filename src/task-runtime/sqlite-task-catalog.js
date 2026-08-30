'use strict';

const crypto = require('node:crypto');

class SqliteTaskCatalog {
  constructor(db) {
    this.db = db;
    this.contextualNpcDefinitions = new Map();
    // key: `${npc}|${location}`；value: null（无任务上下文）或 { npc_canonical_id, location_canonical_id, task_contexts }
    this.contextualNpcPlacements = new Map();
  }

  /**
   * 注册任务上下文 NPC 放置（内存态）。
   * 浏览器导出层由选择文件的 evidence.contextual_npc_placements 生成 runtime.npc_placement.*，
   * 服务端引擎通过装配时灌入同一批数据，保证 SQLite 引擎校验（listNpcsAtNode / isNpcAtLocation）
   * 与导出内容语义一致：这些 NPC 仅在其任务上下文（appearance_statuses 匹配任务状态）时出现在该位置。
   */
  addContextualNpcPlacement(npcCanonicalId, locationCanonicalId, taskContext) {
    if (!npcCanonicalId || !locationCanonicalId) return;
    if (taskContext && taskContext.task_canonical_id) {
      const key = `${npcCanonicalId}|${locationCanonicalId}`;
      const existing = this.contextualNpcPlacements.get(key);
      this.contextualNpcPlacements.set(key, {
        npc_canonical_id: npcCanonicalId, location_canonical_id: locationCanonicalId,
        task_contexts: existing ? existing.task_contexts : [],
      });
      const contexts = this.contextualNpcPlacements.get(key).task_contexts;
      if (!contexts.some((c) => c.task_canonical_id === taskContext.task_canonical_id)) {
        contexts.push({ task_canonical_id: taskContext.task_canonical_id, appearance_statuses: taskContext.appearance_statuses ?? [] });
      }
    } else {
      this.contextualNpcPlacements.set(`${npcCanonicalId}|${locationCanonicalId}`, null);
    }
  }

  listSeriesTasks(seriesCanonicalId) {
    const rows = this.db.prepare(`
      SELECT t.canonical_id
      FROM task_definitions t
      JOIN task_series s ON s.id=t.task_series_id
      WHERE s.canonical_id=?
      ORDER BY t.sequence_position
    `).all(seriesCanonicalId);
    return rows.map((row) => this.getTask(row.canonical_id));
  }

  getTask(taskCanonicalId) {
    const row = this.db.prepare(`
      SELECT t.id,t.canonical_id,t.source_canonical_id,t.sequence_position,t.display_name,t.task_type,
        t.description,t.level_requirement,t.raw_issuer_npc,t.raw_completion_npc,
        t.raw_receive_location,t.raw_submit_location,t.raw_target_location,
        t.raw_value_json,t.normalized_value_json,t.unresolved_fields_json,t.runtime_capability,
        issuer.canonical_id issuer_npc_canonical_id,completion.canonical_id completion_npc_canonical_id,
        receive.canonical_id receive_location_canonical_id,submit.canonical_id submit_location_canonical_id,
        target_location.canonical_id target_location_canonical_id,
        rr.restoration_status,rr.confidence,rr.originality_status
      FROM task_definitions t
      JOIN restoration_records rr ON rr.id=t.source_record_id
      LEFT JOIN npc_definitions issuer ON issuer.id=t.issuer_npc_definition_id
      LEFT JOIN npc_definitions completion ON completion.id=t.completion_npc_definition_id
      LEFT JOIN locations receive ON receive.id=t.receive_location_id
      LEFT JOIN locations submit ON submit.id=t.submit_location_id
      LEFT JOIN locations target_location ON target_location.id=t.target_location_id
      WHERE t.canonical_id=?
    `).get(taskCanonicalId);
    if (!row) return null;

    const prerequisites = this.db.prepare(`
      SELECT prerequisite.canonical_id
      FROM task_prerequisites p
      JOIN task_definitions prerequisite ON prerequisite.id=p.prerequisite_task_id
      WHERE p.task_id=? ORDER BY prerequisite.sequence_position
    `).all(row.id).map((entry) => entry.canonical_id);
    const successors = this.db.prepare(`
      SELECT successor.canonical_id
      FROM task_prerequisites p
      JOIN task_definitions successor ON successor.id=p.task_id
      WHERE p.prerequisite_task_id=? ORDER BY successor.sequence_position
    `).all(row.id).map((entry) => entry.canonical_id);
    const steps = this.db.prepare(`
      SELECT x.canonical_id,x.step_order,x.step_kind,x.original_text,x.normalized_text,x.runtime_capability,
        n.canonical_id npc_canonical_id,l.canonical_id location_canonical_id
      FROM task_steps x
      LEFT JOIN npc_definitions n ON n.id=x.npc_definition_id
      LEFT JOIN locations l ON l.id=x.location_id
      WHERE x.task_id=? ORDER BY x.step_order
    `).all(row.id).map(normalizeRowNumbers);
    const contextualNpcDefinitions = [];
    const issuerResolution = this.resolveNpcReference({
      currentCanonicalId: row.issuer_npc_canonical_id,
      rawName: row.raw_issuer_npc,
      locationCanonicalId: row.receive_location_canonical_id,
      sourceCanonicalId: row.source_canonical_id,
      role: 'issuer',
    });
    const completionResolution = this.resolveNpcReference({
      currentCanonicalId: row.completion_npc_canonical_id,
      rawName: row.raw_completion_npc,
      locationCanonicalId: row.submit_location_canonical_id,
      sourceCanonicalId: row.source_canonical_id,
      role: 'completion',
    });
    row.issuer_npc_canonical_id = issuerResolution.canonical_id;
    row.completion_npc_canonical_id = completionResolution.canonical_id;
    for (const resolution of [issuerResolution,completionResolution]) {
      if (resolution.definition) contextualNpcDefinitions.push(resolution.definition);
    }

    const targets = this.db.prepare(`
      SELECT x.canonical_id,x.target_order,x.target_kind,x.raw_name,x.raw_quantity,x.normalized_quantity,
        x.raw_value_json,r.canonical_id dependency_canonical_id,r.resolution_status,r.runtime_capability,
        r.raw_category,r.candidate_canonical_ids_json,ce.canonical_id content_entity_canonical_id,
        m.canonical_id monster_canonical_id,n.canonical_id npc_canonical_id,l.canonical_id location_canonical_id
      FROM task_targets x
      JOIN dependency_references r ON r.id=x.dependency_reference_id
      LEFT JOIN content_entities ce ON ce.id=r.resolved_content_entity_id
      LEFT JOIN monster_definitions m ON m.id=r.resolved_monster_definition_id
      LEFT JOIN npc_definitions n ON n.id=r.resolved_npc_definition_id
      LEFT JOIN locations l ON l.id=r.resolved_location_id
      WHERE x.task_id=? ORDER BY x.target_order
    `).all(row.id).map((target) => {
      const normalized = normalizeRowNumbers(target);
      const candidateCanonicalIds = JSON.parse(target.candidate_canonical_ids_json);
      let entityCanonicalId = target.content_entity_canonical_id ?? target.monster_canonical_id
        ?? target.npc_canonical_id ?? target.location_canonical_id ?? null;
      let runtimeResolution = null;
      if (!entityCanonicalId && target.target_kind === 'npc') {
        const npcResolution = this.resolveNpcReference({
          currentCanonicalId: null,
          rawName: target.raw_name,
          locationCanonicalId: row.target_location_canonical_id ?? row.submit_location_canonical_id,
          sourceCanonicalId: row.source_canonical_id,
          role: 'target',
          candidateCanonicalIds,
        });
        entityCanonicalId = npcResolution.canonical_id;
        if (npcResolution.definition) contextualNpcDefinitions.push(npcResolution.definition);
        if (entityCanonicalId) runtimeResolution = npcResolution.runtime_resolution;
      }
      if (!entityCanonicalId && target.target_kind === 'monster') {
        const monsterResolution = this.resolveMonsterReference({
          rawName: target.raw_name,
          locationCanonicalId: row.target_location_canonical_id,
          candidateCanonicalIds,
        });
        entityCanonicalId = monsterResolution.canonical_id;
        if (entityCanonicalId) runtimeResolution = monsterResolution.runtime_resolution;
      }
      return {
        ...normalized,
        required_quantity: Number(target.normalized_quantity ?? 1),
        entity_canonical_id: entityCanonicalId,
        candidate_canonical_ids: candidateCanonicalIds,
        resolution_status: entityCanonicalId && target.resolution_status !== 'resolved' ? 'contextual_runtime_resolution' : target.resolution_status,
        runtime_resolution: runtimeResolution,
      };
    });
    const rewards = this.db.prepare(`
      SELECT x.canonical_id,x.reward_order,x.reward_kind,x.reward_name,x.raw_quantity,x.normalized_quantity,
        x.raw_value_json,r.canonical_id dependency_canonical_id,r.resolution_status,r.runtime_capability,
        r.candidate_canonical_ids_json,ce.canonical_id content_entity_canonical_id
      FROM task_rewards x
      JOIN dependency_references r ON r.id=x.dependency_reference_id
      LEFT JOIN content_entities ce ON ce.id=r.resolved_content_entity_id
      WHERE x.task_id=? ORDER BY x.reward_order
    `).all(row.id).map((reward) => {
      const candidateCanonicalIds = JSON.parse(reward.candidate_canonical_ids_json);
      let contentEntityCanonicalId = reward.content_entity_canonical_id;
      let resolutionStatus = reward.resolution_status;
      let runtimeResolution = null;
      if (!contentEntityCanonicalId && candidateCanonicalIds.length === 1 && this.hasContentEntity(candidateCanonicalIds[0])) {
        contentEntityCanonicalId = candidateCanonicalIds[0];
        resolutionStatus = 'single_candidate_runtime_mapping';
        runtimeResolution = { rule:'single_candidate_dependency_mapping',evidence_status:'SOURCE_CANDIDATE_UNAMBIGUOUS' };
      }
      return {
        ...normalizeRowNumbers(reward),
        content_entity_canonical_id: contentEntityCanonicalId,
        resolution_status: resolutionStatus,
        quantity: Number(reward.normalized_quantity ?? 0),
        candidate_canonical_ids: candidateCanonicalIds,
        runtime_resolution: runtimeResolution,
      };
    });
    const dialogues = this.db.prepare(`
      SELECT canonical_id,phase,line_order,original_text,normalized_text
      FROM task_dialogues WHERE task_id=?
      ORDER BY CASE phase WHEN 'receive' THEN 1 ELSE 2 END,line_order
    `).all(row.id).map(normalizeRowNumbers);

    const unresolvedFields = JSON.parse(row.unresolved_fields_json).filter((field) => {
      if (field === 'issuer_npc' && row.issuer_npc_canonical_id) return false;
      if (field === 'completion_npc' && row.completion_npc_canonical_id) return false;
      return true;
    });
    const blockingReasons = [];
    for (const field of unresolvedFields) blockingReasons.push({ type: 'unresolved_field', field });
    for (const target of targets) {
      if (!target.entity_canonical_id) {
        blockingReasons.push({
          type: 'unresolved_target',
          target_canonical_id: target.canonical_id,
          dependency_canonical_id: target.dependency_canonical_id,
          resolution_status: target.resolution_status,
          candidate_canonical_ids: target.candidate_canonical_ids,
        });
      }
    }
    for (const reward of rewards) {
      const intrinsic = reward.reward_kind === 'money' || reward.reward_kind === 'experience';
      const sourceLabelLedger = reward.resolution_status === 'source_label_only';
      if (!intrinsic && !sourceLabelLedger && !reward.content_entity_canonical_id) {
        blockingReasons.push({
          type: 'unresolved_reward',
          reward_canonical_id: reward.canonical_id,
          dependency_canonical_id: reward.dependency_canonical_id,
          resolution_status: reward.resolution_status,
          candidate_canonical_ids: reward.candidate_canonical_ids,
        });
      }
    }

    delete row.id;
    return {
      ...normalizeRowNumbers(row),
      raw_value: JSON.parse(row.raw_value_json),
      normalized_value: JSON.parse(row.normalized_value_json),
      unresolved_fields: unresolvedFields,
      prerequisites,
      successors,
      steps,
      targets,
      rewards,
      dialogues,
      contextual_npc_definitions: [...new Map(contextualNpcDefinitions.map((entry) => [entry.canonical_id,entry])).values()],
      blocking_reasons: blockingReasons,
    };
  }

  resolveNpcReference({ currentCanonicalId,rawName,locationCanonicalId,sourceCanonicalId,role,candidateCanonicalIds=[] }) {
    if (currentCanonicalId) return { canonical_id:currentCanonicalId,definition:null,runtime_resolution:null };
    if (!rawName || !locationCanonicalId) return { canonical_id:null,definition:null,runtime_resolution:null };
    const candidateSet = new Set(candidateCanonicalIds);
    const rows = this.db.prepare(`
      SELECT DISTINCT n.canonical_id,n.display_name
      FROM npc_definitions n
      JOIN npc_placements p ON p.npc_definition_id=n.id
      JOIN locations l ON l.id=p.location_id
      WHERE n.display_name=? AND l.canonical_id=? AND p.runtime_capability='queryable'
      ORDER BY n.canonical_id
    `).all(rawName,locationCanonicalId).filter((entry) => !candidateSet.size || candidateSet.has(entry.canonical_id));
    if (rows.length === 1) {
      return { canonical_id:rows[0].canonical_id,definition:null,runtime_resolution:{ rule:'npc_name_and_location',evidence_status:'SOURCE_EXPLICIT_CONTEXT' } };
    }
    const canonicalId = `runtime.contextual-npc.${shortHash(`${rawName}|${locationCanonicalId}`)}`;
    const definition = {
      canonical_id: canonicalId,
      source_canonical_id: sourceCanonicalId,
      display_name: rawName,
      level: null,
      npc_type: 'task_context',
      location_canonical_id: locationCanonicalId,
      evidence_status: 'SOURCE_EXPLICIT_TASK_CONTEXT',
      resolution_rule: rows.length > 1 ? 'ambiguous_global_npc_preserved_as_task_context' : 'missing_global_npc_preserved_as_task_context',
      roles: [role],
    };
    const existing = this.contextualNpcDefinitions.get(canonicalId);
    if (existing) existing.roles = [...new Set([...existing.roles,role])];
    else this.contextualNpcDefinitions.set(canonicalId,definition);
    this.contextualNpcPlacements.set(`${canonicalId}|${locationCanonicalId}`, null);
    return { canonical_id:canonicalId,definition:this.contextualNpcDefinitions.get(canonicalId),runtime_resolution:{ rule:definition.resolution_rule,evidence_status:definition.evidence_status } };
  }

  resolveMonsterReference({ rawName,locationCanonicalId,candidateCanonicalIds=[] }) {
    if (!rawName || !locationCanonicalId) return { canonical_id:null,runtime_resolution:null };
    const candidateSet = new Set(candidateCanonicalIds);
    const rows = this.db.prepare(`
      SELECT DISTINCT m.canonical_id
      FROM monster_definitions m
      JOIN monster_placements p ON p.monster_definition_id=m.id
      JOIN locations l ON l.id=p.location_id
      WHERE m.display_name=? AND l.canonical_id=? AND p.runtime_capability='queryable'
      ORDER BY m.canonical_id
    `).all(rawName,locationCanonicalId).filter((entry) => !candidateSet.size || candidateSet.has(entry.canonical_id));
    if (rows.length !== 1) return { canonical_id:null,runtime_resolution:null };
    return { canonical_id:rows[0].canonical_id,runtime_resolution:{ rule:'monster_name_and_location',evidence_status:'SOURCE_EXPLICIT_CONTEXT' } };
  }

  getMapNode(nodeOrLocationCanonicalId) {
    return this.db.prepare(`
      SELECT mn.canonical_id map_node_canonical_id,mn.node_kind,mn.display_name,
        l.canonical_id location_canonical_id,c.canonical_id city_canonical_id
      FROM map_nodes mn
      LEFT JOIN locations l ON l.id=mn.location_id
      LEFT JOIN cities c ON c.id=COALESCE(mn.city_id,l.city_id)
      WHERE mn.canonical_id=? OR l.canonical_id=?
      LIMIT 1
    `).get(nodeOrLocationCanonicalId, nodeOrLocationCanonicalId) ?? null;
  }

  getNodeForLocation(locationCanonicalId) {
    return this.getMapNode(locationCanonicalId);
  }

  listAdjacentNodes(nodeCanonicalId) {
    return this.db.prepare(`
      SELECT lc.canonical_id connection_canonical_id,lc.relation_type,lc.directed,
        CASE WHEN source.canonical_id=? THEN target.canonical_id ELSE source.canonical_id END map_node_canonical_id,
        CASE WHEN source.canonical_id=? THEN target.node_kind ELSE source.node_kind END node_kind,
        CASE WHEN source.canonical_id=? THEN target.display_name ELSE source.display_name END display_name,
        CASE WHEN source.canonical_id=? THEN target_location.canonical_id ELSE source_location.canonical_id END location_canonical_id
      FROM location_connections lc
      JOIN map_nodes source ON source.id=lc.from_node_id
      JOIN map_nodes target ON target.id=lc.to_node_id
      LEFT JOIN locations source_location ON source_location.id=source.location_id
      LEFT JOIN locations target_location ON target_location.id=target.location_id
      WHERE source.canonical_id=? OR target.canonical_id=?
      ORDER BY lc.canonical_id
    `).all(nodeCanonicalId,nodeCanonicalId,nodeCanonicalId,nodeCanonicalId,nodeCanonicalId,nodeCanonicalId)
      .map(normalizeRowNumbers);
  }

  listNpcsAtNode(nodeCanonicalId) {
    const rows = this.db.prepare(`
      SELECT p.canonical_id placement_canonical_id,n.canonical_id npc_canonical_id,n.display_name,
        l.canonical_id location_canonical_id
      FROM npc_placements p
      JOIN npc_definitions n ON n.id=p.npc_definition_id
      JOIN locations l ON l.id=p.location_id
      JOIN map_nodes mn ON mn.location_id=l.id
      WHERE mn.canonical_id=? AND p.runtime_capability='queryable'
      ORDER BY p.canonical_id
    `).all(nodeCanonicalId);
    if (!this.contextualNpcPlacements.size) return rows;
    // 内存注册的任务上下文放置：仅当其任务状态命中 appearance_statuses 时由
    // task-engine isNpcPlacementVisible 判断可见性（与浏览器 runtime.npc_placement.* 语义一致）
    const node = this.getNodeForLocation ? this.nodeFor(nodeCanonicalId) : null;
    const nodeLocationId = node?.location_canonical_id;
    if (!nodeLocationId) return rows;
    const names = this.db.prepare('SELECT canonical_id,display_name FROM npc_definitions').all();
    const nameBy = new Map(names.map((n) => [n.canonical_id, n.display_name]));
    for (const [key, entry] of this.contextualNpcPlacements) {
      if (!entry || entry.location_canonical_id !== nodeLocationId) continue;
      rows.push({
        placement_canonical_id: `runtime.npc_placement.${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
        npc_canonical_id: entry.npc_canonical_id,
        display_name: nameBy.get(entry.npc_canonical_id) ?? null,
        location_canonical_id: nodeLocationId,
        placement_scope: 'task_context',
        task_contexts: entry.task_contexts ?? [],
      });
    }
    return rows;
  }

  nodeFor(nodeCanonicalId) {
    return this.db.prepare(`
      SELECT mn.canonical_id map_node_canonical_id,mn.node_kind,mn.display_name,l.canonical_id location_canonical_id
      FROM map_nodes mn LEFT JOIN locations l ON l.id=mn.location_id WHERE mn.canonical_id=?
    `).get(nodeCanonicalId) ?? null;
  }

  isNpcAtLocation(npcCanonicalId, locationCanonicalId) {
    if (this.contextualNpcPlacements.has(`${npcCanonicalId}|${locationCanonicalId}`)) return true;
    return Boolean(this.db.prepare(`
      SELECT 1 present FROM npc_placements p
      JOIN npc_definitions n ON n.id=p.npc_definition_id
      JOIN locations l ON l.id=p.location_id
      WHERE n.canonical_id=? AND l.canonical_id=? AND p.runtime_capability='queryable' LIMIT 1
    `).get(npcCanonicalId, locationCanonicalId));
  }

  isMonsterAtLocation(monsterCanonicalId, locationCanonicalId) {
    return Boolean(this.db.prepare(`
      SELECT 1 present FROM monster_placements p
      JOIN monster_definitions m ON m.id=p.monster_definition_id
      JOIN locations l ON l.id=p.location_id
      WHERE m.canonical_id=? AND l.canonical_id=? AND p.runtime_capability='queryable' LIMIT 1
    `).get(monsterCanonicalId, locationCanonicalId));
  }

  hasContentEntity(contentCanonicalId) {
    return Boolean(this.db.prepare('SELECT 1 present FROM content_entities WHERE canonical_id=?').get(contentCanonicalId));
  }

  countCrossSeriesPrerequisites() {
    return Number(this.db.prepare(`
      SELECT COUNT(*) count FROM task_prerequisites p
      JOIN task_definitions task ON task.id=p.task_id
      JOIN task_definitions prerequisite ON prerequisite.id=p.prerequisite_task_id
      WHERE task.task_series_id<>prerequisite.task_series_id
    `).get().count);
  }

  countUnresolvedConflicts() {
    return Number(this.db.prepare(`
      SELECT COUNT(*) count FROM restoration_conflicts
      WHERE runtime_policy='unresolved' AND selected_candidate_json IS NULL
    `).get().count);
  }
}

function normalizeRowNumbers(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0,16);
}

module.exports = { SqliteTaskCatalog };
