'use strict';

class BrowserTaskCatalog {
  constructor(contentPackage) {
    if (!['zhsh.task1.browser-content','zhsh.browser-content'].includes(contentPackage?.package_id)) throw new Error('Invalid browser content package');
    this.content = contentPackage;
    this.series = Array.isArray(contentPackage.series) ? contentPackage.series : [contentPackage.series];
    this.tasks = new Map(contentPackage.tasks.map((task) => [task.canonical_id,task]));
    this.nodes = new Map(contentPackage.map_nodes.map((node) => [node.map_node_canonical_id,node]));
    this.locationNodes = new Map(contentPackage.map_nodes.filter((node) => node.location_canonical_id)
      .map((node) => [node.location_canonical_id,node]));
    this.entities = new Set(contentPackage.content_entities.map((entity) => entity.canonical_id));
  }

  listSeriesTasks(seriesCanonicalId) {
    if (!this.series.some((entry)=>entry.canonical_id===seriesCanonicalId)) return [];
    return [...this.tasks.values()].filter((task)=>(task.series_canonical_id??task.canonical_id.match(/^task\.series\.\d+/)?.[0])===seriesCanonicalId)
      .sort((a,b) => a.sequence_position - b.sequence_position);
  }

  getTask(taskCanonicalId) {
    return this.tasks.get(taskCanonicalId) ?? null;
  }

  getMapNode(nodeOrLocationCanonicalId) {
    return this.nodes.get(nodeOrLocationCanonicalId) ?? this.locationNodes.get(nodeOrLocationCanonicalId) ?? null;
  }

  getNodeForLocation(locationCanonicalId) {
    return this.locationNodes.get(locationCanonicalId) ?? null;
  }

  listAdjacentNodes(nodeCanonicalId) {
    const result = [];
    for (const connection of this.content.location_connections) {
      let destinationId = null;
      if (connection.from_map_node_canonical_id === nodeCanonicalId) destinationId = connection.to_map_node_canonical_id;
      else if (connection.to_map_node_canonical_id === nodeCanonicalId) destinationId = connection.from_map_node_canonical_id;
      if (!destinationId) continue;
      const node = this.nodes.get(destinationId);
      if (node) result.push({ ...node,connection_canonical_id: connection.canonical_id,
        relation_type: connection.relation_type,directed: connection.directed });
    }
    return result.sort((a,b) => a.connection_canonical_id.localeCompare(b.connection_canonical_id));
  }

  listNpcsAtNode(nodeCanonicalId) {
    const node = this.nodes.get(nodeCanonicalId);
    if (!node?.location_canonical_id) return [];
    return this.content.npc_placements.filter((entry) => entry.location_canonical_id === node.location_canonical_id)
      .map((entry) => ({ ...entry,display_name: this.content.npcs.find((npc) => npc.canonical_id === entry.npc_canonical_id)?.display_name ?? entry.npc_canonical_id }));
  }

  isNpcAtLocation(npcCanonicalId,locationCanonicalId) {
    return this.content.npc_placements.some((entry) => entry.npc_canonical_id === npcCanonicalId
      && entry.location_canonical_id === locationCanonicalId && entry.runtime_capability === 'queryable');
  }

  isMonsterAtLocation(monsterCanonicalId,locationCanonicalId) {
    return this.content.monster_placements.some((entry) => entry.monster_canonical_id === monsterCanonicalId
      && entry.location_canonical_id === locationCanonicalId && entry.runtime_capability === 'queryable');
  }

  hasContentEntity(contentCanonicalId) {
    return this.entities.has(contentCanonicalId);
  }
}

module.exports = { BrowserTaskCatalog };
