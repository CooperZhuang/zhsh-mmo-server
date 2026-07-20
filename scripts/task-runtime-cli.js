'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { openSqliteRuntime } = require('../src/task-runtime');
const { runFirstTaskChain } = require('../src/task-runtime/first-chain-driver');

const PROJECT_ROOT = path.resolve(__dirname,'..');

function takeFlag(args,name,fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index,2);
  return value;
}

function usage() {
  return [
    'Usage: node scripts/task-runtime-cli.js [--database path] [--player canonical_id] <command> [canonical_id] [quantity]',
    'Commands: create, reset, state, progress, location, neighbors, move, npcs, talk, arrive, defeat, obtain, consume, submit, reload, run-first-chain',
    'All entity arguments must be canonical_id values; optional --event-id makes event replay deterministic.',
  ].join('\n');
}

function currentLocation(engine,playerId) {
  const location = engine.getCurrentLocation(playerId);
  if (!location?.location_canonical_id) throw new Error('Current map node is not a formal location');
  return location.location_canonical_id;
}

function compactProgress(view) {
  return {
    player: view.player,
    current_location: view.current_location,
    inventory: view.inventory,
    reward_grants: view.reward_grants,
    tasks: view.task_chain.map(({ definition,runtime,progress }) => ({
      canonical_id: definition.canonical_id,
      display_name: definition.display_name,
      status: runtime.status,
      current_step: runtime.current_step,
      reward_status: runtime.reward_status,
      block_reasons: runtime.block_reasons,
      progress,
    })),
  };
}

let runtime;
try {
  const args = process.argv.slice(2);
  const databasePath = path.resolve(takeFlag(args,'--database',path.join(PROJECT_ROOT,'data','zhsh-content.sqlite')));
  const playerId = takeFlag(args,'--player','player.task1.dev');
  const eventId = takeFlag(args,'--event-id',crypto.randomUUID());
  const [command,canonicalId,quantityText] = args;
  if (!command) throw new Error(usage());
  runtime = openSqliteRuntime(databasePath);
  const { engine } = runtime;
  let output;
  switch (command) {
    case 'create': output = engine.createPlayer(playerId); break;
    case 'reset': output = engine.createPlayer(playerId,{ reset: true }); break;
    case 'state': output = engine.getPlayerView(playerId); break;
    case 'progress': output = compactProgress(engine.getPlayerView(playerId)); break;
    case 'location': output = engine.getCurrentLocation(playerId); break;
    case 'neighbors': output = engine.listAdjacentLocations(playerId); break;
    case 'npcs': output = engine.listCurrentNpcs(playerId); break;
    case 'move': output = engine.move(playerId,canonicalId,eventId); break;
    case 'talk': output = engine.processEvent(playerId,{ event_id:eventId,type:'talk_to_npc',npc_canonical_id:canonicalId,location_canonical_id:currentLocation(engine,playerId) }); break;
    case 'arrive': output = engine.processEvent(playerId,{ event_id:eventId,type:'arrive_at_location',location_canonical_id:canonicalId }); break;
    case 'defeat': output = engine.processEvent(playerId,{ event_id:eventId,type:'defeat_monster',monster_canonical_id:canonicalId,location_canonical_id:currentLocation(engine,playerId),quantity:Number(quantityText ?? 1) }); break;
    case 'obtain': output = engine.processEvent(playerId,{ event_id:eventId,type:'obtain_item',item_canonical_id:canonicalId,location_canonical_id:currentLocation(engine,playerId),quantity:Number(quantityText ?? 1) }); break;
    case 'consume': output = engine.processEvent(playerId,{ event_id:eventId,type:'consume_item',item_canonical_id:canonicalId,location_canonical_id:currentLocation(engine,playerId),quantity:Number(quantityText ?? 1) }); break;
    case 'submit': output = engine.processEvent(playerId,{ event_id:eventId,type:'submit_to_npc',npc_canonical_id:canonicalId,location_canonical_id:currentLocation(engine,playerId) }); break;
    case 'reload': output = compactProgress(engine.getPlayerView(playerId)); break;
    case 'run-first-chain':
      if (!runtime.storage.hasPlayer(playerId)) engine.createPlayer(playerId);
      runFirstTaskChain(engine,playerId,`cli:${eventId}`);
      output = compactProgress(engine.getPlayerView(playerId));
      break;
    default: throw new Error(usage());
  }
  process.stdout.write(`${JSON.stringify(output,null,2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  runtime?.close();
}
