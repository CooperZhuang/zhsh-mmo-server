'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');

function main(){
  const label=argument('--label'),output=argument('--output'),mode=argument('--mode');
  if(!label||!output||!mode)throw new Error('Usage: node capture-performance-evidence.js --label <runtime> --mode <formal-core-new|formal-core-old|persistence-hotspots> --output <file>');
  const definition=commandFor(mode);const timeoutMs=Number(argument('--timeout-ms')??definition.timeout_ms);
  const head=git(['rev-parse','HEAD']),startedAt=new Date().toISOString(),started=process.hrtime.bigint();
  const run=spawnSync(process.execPath,definition.args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:128*1024*1024,timeout:timeoutMs,
    env:{...process.env,...definition.environment}});
  const ended=process.hrtime.bigint(),endedAt=new Date().toISOString(),stdout=run.stdout??'',stderr=run.stderr??'';
  const evidence={schema_version:2,label,mode,git_head:head,node_version:process.version,node_executable:process.execPath,
    os:{platform:os.platform(),release:os.release(),arch:os.arch()},cpu:os.cpus()[0]?.model??'unknown',
    command:`${JSON.stringify(process.execPath)} ${definition.args.map(shellDisplay).join(' ')}`,started_at:startedAt,ended_at:endedAt,
    duration_ms:Number((ended-started)/1000000n),timeout_ms:timeoutMs,timed_out:run.error?.code==='ETIMEDOUT',exit_code:run.status,signal:run.signal??null,
    test_count:mode.startsWith('formal-core')?parseSummaryTestCount(stdout):null,formal_result:parseFormalResult(stdout),process_metrics:parseMarker(stdout,'ZHSH_PROCESS_METRICS:'),
    hotspot_result:mode==='persistence-hotspots'?parseLastJson(stdout):null,stdout_sha256:sha256(stdout),stderr_sha256:sha256(stderr),raw_stdout:stdout,raw_stderr:stderr};
  const destination=path.resolve(root,output);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,`${JSON.stringify(evidence,null,2)}\n`,'utf8');
  if(run.error&&!evidence.timed_out)throw run.error;if(run.status!==0)throw new Error(`Performance command failed; raw evidence retained at ${destination}`);
  process.stdout.write(`${JSON.stringify({output:path.relative(root,destination).replaceAll('\\','/'),label,mode,node_version:process.version,
    exit_code:run.status,test_count:evidence.test_count,duration_ms:evidence.duration_ms,max_rss_kib:evidence.process_metrics?.resource_usage?.maxRSS??evidence.hotspot_result?.resource_usage?.maxRSS??null},null,2)}\n`);
  return evidence;
}

function commandFor(mode){
  if(mode==='formal-core-new')return {args:['--test','--test-name-pattern=new save','tests/formal-core-e2e.test.js'],timeout_ms:20*60*1000,
    environment:{ZHSH_CAPTURE_LEVEL_REACHABILITY:'1',ZHSH_E2E_METRICS:'1'}};
  if(mode==='formal-core-old')return {args:['--test','--test-name-pattern=migrates the real legacy save','tests/formal-core-e2e.test.js'],timeout_ms:20*60*1000,
    environment:{ZHSH_CAPTURE_LEVEL_REACHABILITY:'1',ZHSH_E2E_METRICS:'1'}};
  if(mode==='persistence-hotspots')return {args:['scripts/benchmark-persistence-hotspots.js','--counts','100,1000,5000'],timeout_ms:20*60*1000,environment:{}};
  throw new Error(`Unknown performance mode: ${mode}`);
}

function parseFormalResult(output){
  const prefix='ZHSH_LEVEL_REACHABILITY:';const line=String(output).split(/\r?\n/).find((entry)=>entry.includes(prefix));
  return line?JSON.parse(line.slice(line.indexOf(prefix)+prefix.length).trim()):null;
}
function parseMarker(output,prefix){const line=String(output).split(/\r?\n/).find((entry)=>entry.includes(prefix));return line?JSON.parse(line.slice(line.indexOf(prefix)+prefix.length).trim()):null;}
function parseLastJson(output){const start=String(output).indexOf('{');if(start<0)return null;return JSON.parse(String(output).slice(start));}
function parseSummaryTestCount(output){const match=String(output).match(/^[^\r\n]*\btests\s+(\d+)\s*$/m);return match?Number(match[1]):null;}
function git(args){const run=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});if(run.status!==0)throw new Error(run.stderr);return run.stdout.trim();}
function shellDisplay(value){return /\s/.test(value)?JSON.stringify(value):value;}
function argument(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
