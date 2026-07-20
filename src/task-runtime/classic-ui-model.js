'use strict';

class UiFeedback {
  constructor() {
    this.message = '';
    this.error = '';
  }

  succeed(message = '') {
    this.message = String(message);
    this.error = '';
    return this.snapshot();
  }

  fail(error) {
    this.message = '';
    this.error = error instanceof Error ? error.message : String(error);
    return this.snapshot();
  }

  snapshot() {
    return { message:this.message,error:this.error };
  }
}

function buildCityMapEntries(content,currentLocation,adjacentLocations) {
  if (!currentLocation?.city_canonical_id) return [];
  const currentNodeId = currentLocation.map_node_canonical_id;
  const adjacentNodeIds = new Set(adjacentLocations.map((entry) => entry.map_node_canonical_id));
  const locationsById = new Map(content.locations
    .filter((entry) => entry.city_canonical_id === currentLocation.city_canonical_id)
    .map((entry) => [entry.canonical_id,entry]));
  return content.map_nodes
    .filter((node) => node.city_canonical_id === currentLocation.city_canonical_id
      && (!node.location_canonical_id || locationsById.has(node.location_canonical_id)))
    .map((node) => {
      const location = locationsById.get(node.location_canonical_id);
      return {
        map_node_canonical_id:node.map_node_canonical_id,
        location_canonical_id:node.location_canonical_id ?? null,
        display_name:location?.display_name || node.display_name,
        is_current:node.map_node_canonical_id === currentNodeId,
        can_move:adjacentNodeIds.has(node.map_node_canonical_id),
      };
    })
    .sort((left,right) => Number(right.is_current) - Number(left.is_current) || left.display_name.localeCompare(right.display_name,'zh-CN'));
}

module.exports = { UiFeedback,buildCityMapEntries };
