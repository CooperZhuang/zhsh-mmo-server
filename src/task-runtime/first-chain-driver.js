'use strict';

function runTaskSequence(engine, playerCanonicalId, tasks, eventPrefix = 'task-sequence') {
  let sequence = 0;
  const events = [];
  const nextId = (label) => `${eventPrefix}:${String(sequence += 1).padStart(3,'0')}:${label}`;
  const send = (event) => {
    const result = engine.processEvent(playerCanonicalId,event);
    events.push({ event,result });
    return result;
  };
  const arrive = (locationId,label) => send({
    event_id: nextId(`arrive:${label}`),
    type: 'arrive_at_location',
    location_canonical_id: locationId,
  });

  for (const task of tasks) {
    arrive(task.receive_location_canonical_id,`${task.canonical_id}:issuer`);
    send({
      event_id: nextId(`talk-issuer:${task.canonical_id}`),
      type: 'talk_to_npc',
      npc_canonical_id: task.issuer_npc_canonical_id,
      location_canonical_id: task.receive_location_canonical_id,
    });
    for (const target of task.targets) {
      if (target.target_kind === 'monster') {
        arrive(task.target_location_canonical_id,`${task.canonical_id}:target`);
        send({
          event_id: nextId(`defeat:${target.canonical_id}`),
          type: 'defeat_monster',
          monster_canonical_id: target.entity_canonical_id,
          location_canonical_id: task.target_location_canonical_id,
          quantity: target.required_quantity,
        });
      } else if (target.target_kind === 'item') {
        const held=engine.loadPlayer(playerCanonicalId).inventory[target.entity_canonical_id] ?? 0;
        if (held < target.required_quantity) send({
          event_id: nextId(`obtain:${target.canonical_id}`),type:'obtain_item',item_canonical_id:target.entity_canonical_id,
          quantity:target.required_quantity-held,location_canonical_id:task.receive_location_canonical_id,
        });
      } else if (target.target_kind === 'npc') {
        arrive(task.submit_location_canonical_id,`${task.canonical_id}:npc-target`);
        send({
          event_id: nextId(`talk-target:${target.canonical_id}`),
          type: 'talk_to_npc',
          npc_canonical_id: target.entity_canonical_id,
          location_canonical_id: task.submit_location_canonical_id,
        });
      } else if (target.target_kind === 'location') {
        arrive(target.entity_canonical_id,`${task.canonical_id}:location-target`);
      } else {
        throw new Error(`First-chain driver does not support target kind: ${target.target_kind}`);
      }
    }
    arrive(task.submit_location_canonical_id,`${task.canonical_id}:submit`);
    send({
      event_id: nextId(`submit:${task.canonical_id}`),
      type: 'submit_to_npc',
      npc_canonical_id: task.completion_npc_canonical_id,
      location_canonical_id: task.submit_location_canonical_id,
    });
  }
  const state = engine.loadPlayer(playerCanonicalId);
  return { tasks,events,state };
}

function runFirstTaskChain(engine, playerCanonicalId, eventPrefix = 'first-chain') {
  return runTaskSequence(engine,playerCanonicalId,engine.catalog.listSeriesTasks(engine.seriesCanonicalId),eventPrefix);
}

module.exports = { runFirstTaskChain, runTaskSequence };
