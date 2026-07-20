'use strict';

const childProcess=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const evidenceDirectory=path.join(root,'docs','development','browser-dom-e2e-evidence');

function npmCommand(script,environment={}){
  const startedAt=new Date(),started=Date.now();const result=process.platform==='win32'
    ?childProcess.spawnSync('cmd.exe',['/d','/s','/c',`npm.cmd run ${script}`],{cwd:root,encoding:'utf8',env:{...process.env,...environment},maxBuffer:64*1024*1024})
    :childProcess.spawnSync('npm',['run',script],{cwd:root,encoding:'utf8',env:{...process.env,...environment},maxBuffer:64*1024*1024});
  const endedAt=new Date();const log=[`command: npm run ${script}`,`started_at: ${startedAt.toISOString()}`,`ended_at: ${endedAt.toISOString()}`,
    `duration_ms: ${Date.now()-started}`,`exit_code: ${result.status}`,'--- stdout ---',result.stdout,'--- stderr ---',result.stderr].join('\n');
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);return {status:result.status,log};
}

function main(){
  fs.mkdirSync(evidenceDirectory,{recursive:true});const dom=npmCommand('test:browser-dom',{ZHSH_BROWSER_E2E_EVIDENCE_DIR:evidenceDirectory});
  fs.writeFileSync(path.join(evidenceDirectory,'dom-browser-e2e.log'),dom.log,'utf8');if(dom.status!==0)throw new Error('DOM browser evidence run failed');
  const verify=npmCommand('verify');fs.writeFileSync(path.join(evidenceDirectory,'npm-run-verify.log'),verify.log,'utf8');if(verify.status!==0)throw new Error('npm run verify evidence run failed');
  process.stdout.write(`${JSON.stringify({evidence_directory:evidenceDirectory,dom_exit_code:dom.status,verify_exit_code:verify.status},null,2)}\n`);
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
