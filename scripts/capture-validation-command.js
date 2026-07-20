'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');

function main(){
  const label=argument('--label'),output=argument('--output'),separator=process.argv.indexOf('--');
  if(!label||!output||separator<0||separator===process.argv.length-1)throw new Error('Usage: node capture-validation-command.js --label <label> --output <file> -- <command> [args]');
  const inputCommand=process.argv[separator+1],args=process.argv.slice(separator+2),resolved=resolveCommand(inputCommand,args);
  const startedAt=new Date().toISOString(),started=process.hrtime.bigint(),head=gitHead();
  const run=spawnSync(resolved.command,resolved.args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:256*1024*1024,env:process.env});
  const stdout=run.stdout??'',stderr=run.stderr??'',endedAt=new Date().toISOString();
  const evidence={schema_version:1,label,git_head:head,node_version:process.version,node_executable:process.execPath,
    os:{platform:os.platform(),release:os.release(),arch:os.arch()},cpu:os.cpus()[0]?.model??'unknown',
    command:[inputCommand,...args].map(display).join(' '),started_at:startedAt,ended_at:endedAt,
    duration_ms:Number((process.hrtime.bigint()-started)/1000000n),exit_code:run.status,signal:run.signal??null,
    test_count:parseTestCount(stdout),stdout_sha256:sha256(stdout),stderr_sha256:sha256(stderr),raw_stdout:stdout,raw_stderr:stderr};
  const destination=path.resolve(root,output);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,`${JSON.stringify(evidence,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify({output:path.relative(root,destination).replaceAll('\\','/'),label,git_head:head,node_version:process.version,
    exit_code:run.status,test_count:evidence.test_count,duration_ms:evidence.duration_ms,stdout_sha256:evidence.stdout_sha256,stderr_sha256:evidence.stderr_sha256},null,2)}\n`);
  if(run.error)throw run.error;if(run.status!==0){process.stderr.write(stderr);process.exitCode=run.status??1;}return evidence;
}

function resolveCommand(command,args){return process.platform==='win32'&&command.toLowerCase()==='npm'
  ?{command:'cmd.exe',args:['/d','/s','/c','npm.cmd',...args]}:{command,args};}
function argument(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
function parseTestCount(output){const matches=[...String(output).matchAll(/^[^\r\n]*\btests\s+(\d+)\s*$/gm)];return matches.length?Number(matches.at(-1)[1]):null;}
function gitHead(){const run=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});return run.status===0?run.stdout.trim():null;}
function display(value){return /\s/.test(value)?JSON.stringify(value):value;}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
