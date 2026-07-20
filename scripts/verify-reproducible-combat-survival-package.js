'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');

function main(){
  const status=run(process.execPath,['-e',"const{spawnSync}=require('node:child_process');const r=spawnSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8'});process.stdout.write(r.stdout);process.exitCode=r.status"],root).trim();
  if(status)throw new Error(`Worktree must be clean before independent packaging runs:\n${status}`);
  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-combat-survival-two-package-runs-'));
  try{
    const results=['run-a','run-b'].map((name)=>packageOnce(path.join(temporaryRoot,name)));
    if(results[0].sha256!==results[1].sha256)throw new Error(`Independent ZIP hashes differ: ${results[0].sha256} != ${results[1].sha256}`);
    const finalRoot=path.join(root,'out','combat-survival-stage');
    fs.rmSync(finalRoot,{recursive:true,force:true});fs.mkdirSync(finalRoot,{recursive:true});
    const finalZip=path.join(finalRoot,path.basename(results[0].zipPath));fs.copyFileSync(results[0].zipPath,finalZip);
    fs.writeFileSync(`${finalZip}.sha256`,`${results[0].sha256}  ${path.basename(finalZip)}\n`,'utf8');
    const evidence={schema_version:1,result:'passed',packaging_node_version:process.version,independent_full_runs:2,same_clean_commit:true,
      zip_sha256:results[0].sha256,run_a:{sha256:results[0].sha256},run_b:{sha256:results[1].sha256},
      final_zip:path.relative(root,finalZip).replaceAll('\\','/')};
    fs.writeFileSync(path.join(finalRoot,'two-run-reproducibility.json'),`${JSON.stringify(evidence,null,2)}\n`,'utf8');
    process.stdout.write(`${JSON.stringify({...evidence,final_zip:path.resolve(finalZip)},null,2)}\n`);return evidence;
  }finally{safeRemove(temporaryRoot);}
}

function packageOnce(outputRoot){
  const result=spawnSync(process.execPath,['scripts/package-combat-survival-stage.js','--output-root',outputRoot],
    {cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:128*1024*1024});
  if(result.status!==0)throw new Error(`Independent package run failed:\n${result.stdout??''}${result.stderr??''}`);
  const payload=JSON.parse(result.stdout),sha256=hash(fs.readFileSync(payload.zip_path));
  if(sha256!==payload.zip_sha256)throw new Error('Packager-reported ZIP hash mismatch');
  return {zipPath:payload.zip_path,sha256};
}
function run(command,args,cwd){const result=spawnSync(command,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});if(result.status!==0)throw new Error(result.stderr||result.stdout);return result.stdout;}
function hash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function safeRemove(directory){const resolved=path.resolve(directory),base=path.resolve(os.tmpdir());if(!resolved.startsWith(`${base}${path.sep}`))throw new Error(`Unsafe cleanup path: ${resolved}`);fs.rmSync(resolved,{recursive:true,force:true});}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
