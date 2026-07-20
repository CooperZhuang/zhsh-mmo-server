'use strict';

const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {BrowserRuntimeStorage,checksum,makeEnvelope}=require('../src/task-runtime/browser-runtime-storage');

const root=path.resolve(__dirname,'..');
const fixturePath=path.join(root,'tests','fixtures','browser-save-v3-formal-71-of-71.json');

class FakeDurableStore{
  constructor(records=[]){this.records=new Map(records.map((record)=>[record.player_canonical_id,structuredClone(record)]));this.putCount=0;}
  async list(){return [...this.records.values()].map((record)=>structuredClone(record));}
  async put(record){this.putCount+=1;this.records.set(record.player_canonical_id,structuredClone(record));}
  close(){}
}

async function main(){
  const counts=parseCounts();const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  const state=compactReplayLedgers(fixture.state);const serializedState=JSON.stringify(state);const results=[];
  for(const revisions of counts){
    results.push(measureSync('structuredClone',revisions,()=>structuredClone(state)));
    results.push(measureSync('checksum',revisions,()=>checksum(serializedState)));
    results.push(await measureDurablePut(revisions,state));
    results.push(await measureCoalescedRevisions(revisions,state));
    results.push(await measureFlushEachRevision(revisions,state));
  }
  const output={schema_version:1,benchmark:'browser-runtime-storage-hotspots',node_version:process.version,node_executable:process.execPath,
    os:{platform:os.platform(),release:os.release(),arch:os.arch()},cpu:os.cpus()[0]?.model??'unknown',fixture:'tests/fixtures/browser-save-v3-formal-71-of-71.json',
    replay_window:128,state_bytes:Buffer.byteLength(serializedState),counts,results,resource_usage:process.resourceUsage()};
  process.stdout.write(`${JSON.stringify(output,null,2)}\n`);return output;
}

function measureSync(operation,revisions,callback){
  const before=process.memoryUsage();const start=process.hrtime.bigint();for(let index=0;index<revisions;index+=1)callback(index);
  return record(operation,revisions,start,before,{});
}

async function measureDurablePut(revisions,state){
  const store=new FakeDurableStore();const envelope=makeEnvelope(state,1);const before=process.memoryUsage();const start=process.hrtime.bigint();
  for(let index=0;index<revisions;index+=1)await store.put({...envelope,revision:index+1});
  return record('durable_put',revisions,start,before,{durable_put_count:store.putCount});
}

async function measureCoalescedRevisions(revisions,state){
  const id=state.player.canonical_id,store=new FakeDurableStore(),storage=new BrowserRuntimeStorage({durableStore:store});await storage.ready();storage.createPlayer(state);
  const baselinePuts=store.putCount;const before=process.memoryUsage();const start=process.hrtime.bigint();
  for(let index=0;index<revisions;index+=1)storage.transact(id,(draft)=>{draft.player.updated_at=`revision-${index}`;return null;});
  await storage.flush();return record('continuous_revision_coalesced_flush',revisions,start,before,{durable_put_count:store.putCount-baselinePuts,final_revision:storage.revisions.get(id)});
}

async function measureFlushEachRevision(revisions,state){
  const id=state.player.canonical_id,store=new FakeDurableStore(),storage=new BrowserRuntimeStorage({durableStore:store});await storage.ready();storage.createPlayer(state);await storage.flush();
  const baselinePuts=store.putCount;const before=process.memoryUsage();const start=process.hrtime.bigint();
  for(let index=0;index<revisions;index+=1){storage.transact(id,(draft)=>{draft.player.updated_at=`flush-${index}`;return null;});await storage.flush();}
  return record('flush_after_each_revision',revisions,start,before,{durable_put_count:store.putCount-baselinePuts,final_revision:storage.revisions.get(id)});
}

function record(operation,revisions,start,before,extra){
  const durationNs=process.hrtime.bigint()-start,after=process.memoryUsage();const durationMs=Number(durationNs)/1e6;
  return {operation,revisions,duration_ms:round(durationMs),operations_per_second:round(revisions/(durationMs/1000)),
    rss_before_bytes:before.rss,rss_after_bytes:after.rss,heap_used_before_bytes:before.heapUsed,heap_used_after_bytes:after.heapUsed,...extra};
}

function compactReplayLedgers(source){
  const state=structuredClone(source);for(const key of ['processed_events','gameplay_events'])trim(state[key],128);trim(state.drop_settlements,128);return state;
}
function trim(value,limit){const keys=Object.keys(value??{});for(const key of keys.slice(0,Math.max(0,keys.length-limit)))delete value[key];}
function parseCounts(){const index=process.argv.indexOf('--counts');return(index>=0?process.argv[index+1]:'100,1000,5000').split(',').map(Number);}
function round(value){return Math.round(value*1000)/1000;}

if(require.main===module)main().catch((error)=>{process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;});
module.exports={main};
