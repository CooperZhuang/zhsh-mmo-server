'use strict';

const fs=require('node:fs');
const path=require('node:path');
const { BrowserTaskCatalog,MemoryRuntimeStorage,TaskRuntimeEngine,checksum }=require('../src/task-runtime');

const root=path.resolve(__dirname,'..');
const content=require('../web/generated/task1-content.json');
const output=path.join(root,'tests','fixtures','browser-save-v1-real-1-of-13.json');
const playerId='player.browser.task1';
const clock=()=> '2026-07-17T00:00:00.000Z';

function capture() {
  const catalog=new BrowserTaskCatalog(content);const storage=new MemoryRuntimeStorage();
  const engine=new TaskRuntimeEngine({catalog,storage,clock});engine.createPlayer(playerId);
  const first=catalog.listSeriesTasks('task.series.01')[0];const second=catalog.listSeriesTasks('task.series.01')[1];let sequence=0;
  const next=(label)=>`legacy-capture.${String(++sequence).padStart(3,'0')}.${label}`;
  engine.processEvent(playerId,{event_id:next('accept'),type:'talk_to_npc',npc_canonical_id:first.issuer_npc_canonical_id,location_canonical_id:first.receive_location_canonical_id});
  reach(engine,catalog,playerId,first.submit_location_canonical_id,next);
  engine.processEvent(playerId,{event_id:next('target'),type:'talk_to_npc',npc_canonical_id:first.targets[0].entity_canonical_id,location_canonical_id:first.submit_location_canonical_id});
  engine.processEvent(playerId,{event_id:next('submit'),type:'submit_to_npc',npc_canonical_id:first.completion_npc_canonical_id,location_canonical_id:first.submit_location_canonical_id});
  engine.processEvent(playerId,{event_id:next('accept'),type:'talk_to_npc',npc_canonical_id:second.issuer_npc_canonical_id,location_canonical_id:second.receive_location_canonical_id});
  reach(engine,catalog,playerId,second.submit_location_canonical_id,next);
  engine.processEvent(playerId,{event_id:next('target'),type:'talk_to_npc',npc_canonical_id:second.targets[0].entity_canonical_id,location_canonical_id:second.submit_location_canonical_id});
  const current=engine.loadPlayer(playerId);
  const legacyState={
    player:{canonical_id:current.player.canonical_id,current_map_node_canonical_id:current.player.current_map_node_canonical_id,
      money:current.player.money,experience:current.player.experience,created_at:current.player.created_at,updated_at:current.player.updated_at},
    unlocked_map_nodes:current.unlocked_map_nodes,tasks:pickSeries(current.tasks,'task.series.01'),progress:pickSeries(current.progress,'task.series.01'),
    inventory:current.inventory,reward_grants:current.reward_grants,flags:current.flags,processed_events:current.processed_events,
  };
  const body={format:'zhsh.task1.browser-save',schema_version:1,player_canonical_id:playerId,revision:9,state:legacyState};
  const envelope={...body,checksum:checksum(stableJson(body)),fixture_provenance:{
    source_commit:'502abf70b1867fe33e02333553a7c8def9e35b20',source_schema_version:1,
    capture_method:'formal location_connections and NPC operations only',documented_state:'docs/development/browser-uat-issues.md:19',
  }};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(envelope,null,2)}\n`,'utf8');return envelope;
}

function reach(engine,catalog,id,locationId,next) {
  const from=engine.getCurrentLocation(id).map_node_canonical_id;const to=catalog.getNodeForLocation(locationId).map_node_canonical_id;
  const previous=new Map([[from,null]]);const queue=[from];
  while(queue.length&&!previous.has(to)){const current=queue.shift();for(const node of catalog.listAdjacentNodes(current)){if(previous.has(node.map_node_canonical_id))continue;previous.set(node.map_node_canonical_id,current);queue.push(node.map_node_canonical_id);}}
  if(!previous.has(to))throw new Error(`No formal path to legacy fixture location: ${locationId}`);
  const pathNodes=[];for(let cursor=to;cursor!==null;cursor=previous.get(cursor))pathNodes.push(cursor);
  for(const node of pathNodes.reverse().slice(1))engine.move(id,node,next('move'));
}
function pickSeries(value,prefix){return Object.fromEntries(Object.entries(value).filter(([key])=>key.startsWith(prefix)));}
function stableJson(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;}

if(require.main===module)console.log(JSON.stringify({output:path.relative(root,output),checksum:capture().checksum},null,2));
module.exports={capture};
