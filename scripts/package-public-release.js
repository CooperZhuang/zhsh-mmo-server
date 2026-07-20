'use strict';

const childProcess=require('node:child_process');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const outputRoot=path.join(root,'artifacts','public-release-output');

function main(){
  const head=run('git',['rev-parse','HEAD']).trim();const branch=run('git',['branch','--show-current']).trim();
  if(branch!=='main')throw new Error(`Public release must be packaged from main, got ${branch}`);
  if(run('git',['status','--porcelain']).trim())throw new Error('Public release packaging requires a clean worktree');
  const dist=path.join(root,'dist');if(!fs.existsSync(path.join(dist,'index.html')))throw new Error('Browser build is missing; run the final build first');
  const registry=JSON.parse(fs.readFileSync(path.join(root,'web','generated','authoritative-assets.json'),'utf8'));
  const directory=JSON.parse(fs.readFileSync(path.join(root,'data','generated','unified-task-directory.json'),'utf8'));
  if(registry.authoritative_asset_count!==229||directory.total_task_count!==651)throw new Error('Release inputs are incomplete');
  assertWithinRoot(outputRoot);fs.mkdirSync(outputRoot,{recursive:true});
  const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-public-'));
  try{
    const playableRoot=path.join(tempRoot,'zhsh-remake');fs.cpSync(dist,playableRoot,{recursive:true,force:true});
    for(const required of ['index.html','game-server.js','启动游戏.cmd','START.txt'])if(!fs.existsSync(path.join(playableRoot,required)))throw new Error(`Playable launcher file missing: ${required}`);
    const playableZip=path.join(outputRoot,'zhsh-remake.zip');compress(playableRoot,playableZip);
    const coldRoot=path.join(tempRoot,'zhsh-cold-restore');fs.mkdirSync(coldRoot,{recursive:true});
    const snapshot=path.join(coldRoot,'zhsh-remake-snapshot.zip');run('git',['archive','--format=zip',`--output=${snapshot}`,head]);
    const bundle=path.join(coldRoot,'zhsh-remake.bundle');run('git',['bundle','create',bundle,'main']);run('git',['bundle','verify',bundle]);
    const coldClone=path.join(tempRoot,'cold-restore-check');run('git',['clone','--branch','main','--single-branch',bundle,coldClone]);
    const restoredHead=runAt(coldClone,'git',['rev-parse','HEAD']).trim();
    const restoredBranch=runAt(coldClone,'git',['branch','--show-current']).trim();
    const restoredStatus=runAt(coldClone,'git',['status','--porcelain']).trim();
    if(restoredHead!==head||restoredBranch!=='main'||restoredStatus)throw new Error('Cold restore verification did not reproduce a clean main checkout');
    fs.copyFileSync(playableZip,path.join(coldRoot,path.basename(playableZip)));
    const restore=`《纵横四海》完整备份\r\nHEAD: ${head}\r\n分支: main\r\n\r\n完整恢复：\r\ngit clone --branch main ${path.basename(bundle)} zhsh-remake\r\n\r\n仅查看源码：解压 ${path.basename(snapshot)}\r\n直接试玩：解压 ${path.basename(playableZip)} 后双击“启动游戏.cmd”。\r\n`;
    fs.writeFileSync(path.join(coldRoot,'RESTORE.txt'),restore,'utf8');
    const files=fs.readdirSync(coldRoot).filter((name)=>name!=='MANIFEST.json').map((name)=>({name,sha256:sha(path.join(coldRoot,name)),bytes:fs.statSync(path.join(coldRoot,name)).size}));
    fs.writeFileSync(path.join(coldRoot,'MANIFEST.json'),`${JSON.stringify({schema_version:1,head,branch,cold_restore_verified:true,task_status_counts:directory.status_counts,authoritative_assets:registry.authoritative_asset_count,files},null,2)}\n`,'utf8');
    const coldZip=path.join(outputRoot,'zhsh-remake-full-backup.zip');compress(coldRoot,coldZip);
    const result={head,branch,playable_zip:playableZip,playable_zip_sha256:sha(playableZip),cold_zip:coldZip,cold_zip_sha256:sha(coldZip)};
    fs.writeFileSync(path.join(outputRoot,'release-manifest.json'),`${JSON.stringify(result,null,2)}\n`,'utf8');
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);return result;
  } finally {fs.rmSync(tempRoot,{recursive:true,force:true});}
}
function compress(source,destination){const escaped=(value)=>value.replaceAll("'","''");const command=`Compress-Archive -LiteralPath '${escaped(source)}' -DestinationPath '${escaped(destination)}' -Force`;
  const result=childProcess.spawnSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||result.stdout||`Compress-Archive failed: ${result.status}`);}
function run(command,args){const result=childProcess.spawnSync(command,args,{cwd:root,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||result.stdout||`${command} failed: ${result.status}`);return result.stdout;}
function runAt(cwd,command,args){const result=childProcess.spawnSync(command,args,{cwd,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||result.stdout||`${command} failed: ${result.status}`);return result.stdout;}
function sha(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function assertWithinRoot(target){const resolved=path.resolve(target);if(!resolved.startsWith(`${root}${path.sep}`))throw new Error(`Unsafe output path: ${resolved}`);}
if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
