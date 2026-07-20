'use strict';

const childProcess=require('node:child_process');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createDeterministicZip}=require('./package-runnable-task-expansion');

const root=path.resolve(__dirname,'..');
const outputDirectory=path.join(root,'artifacts','series-05-fishing-diving-palace-stage','release');
const zipName='zhsh-series-05-fishing-diving-palace-stage.zip';

function command(executable,args,{cwd=root}={}) {
  const result=childProcess.spawnSync(executable,args,{cwd,encoding:'utf8'});
  if(result.status!==0)throw new Error(`${executable} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function copyTrackedSnapshot(destinationRoot) {
  for(const relative of command('git',['ls-files','-z']).split('\0').filter(Boolean)) {
    const source=path.join(root,relative);const destination=path.join(destinationRoot,relative);
    fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination);
  }
}

function listFiles(directory) {
  const result=[];const visit=(current)=>{for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    const absolute=path.join(current,entry.name);if(entry.isDirectory())visit(absolute);else if(entry.isFile())result.push(absolute);else throw new Error(`Unsupported package entry: ${absolute}`);}};
  visit(directory);return result;
}

function writeManifest(packageRoot) {
  const manifestPath=path.join(packageRoot,'review','PAYLOAD-SHA256.json');
  const files=listFiles(packageRoot).filter((file)=>file!==manifestPath).map((file)=>{const bytes=fs.readFileSync(file);return {
    path:path.relative(packageRoot,file).replaceAll('\\','/'),size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});
  fs.mkdirSync(path.dirname(manifestPath),{recursive:true});fs.writeFileSync(manifestPath,`${JSON.stringify({schema_version:1,
    generated_at:'2026-07-18T00:00:00.000Z',algorithm:'SHA-256',manifest_self_excluded:true,file_count:files.length,files},null,2)}\n`,'utf8');
  return files.length;
}

function runColdVerification(copyRoot) {
  const commands=process.platform==='win32'
    ?[['cmd.exe',['/d','/s','/c','npm.cmd run verify:core']],['cmd.exe',['/d','/s','/c','npm.cmd run test:browser-dom:incremental']]]
    :[['npm',['run','verify:core']],['npm',['run','test:browser-dom:incremental']]];
  const records=[];
  for(const [executable,args] of commands){const result=childProcess.spawnSync(executable,args,{cwd:copyRoot,encoding:'utf8'});
    records.push({command:[executable,...args].join(' '),exit_code:result.status,stdout:result.stdout,stderr:result.stderr});
    if(result.status!==0)throw new Error(`Cold ZIP verification failed\n${records.map((entry)=>`${entry.command}\n${entry.stdout}${entry.stderr}`).join('\n')}`);}
  return records;
}

function main() {
  const status=command('git',['status','--porcelain','--untracked-files=all']).trim().split(/\r?\n/).filter(Boolean);
  const unexpected=status.filter((line)=>!line.startsWith('?? artifacts/third-batch-browser-evidence-repair/'));
  if(unexpected.length)throw new Error(`Packaging requires a clean stage worktree; unexpected entries:\n${unexpected.join('\n')}`);
  const head=command('git',['rev-parse','HEAD']).trim();const branch=command('git',['branch','--show-current']).trim();
  if(branch!=='main')throw new Error(`Release bundle requires main, got ${branch}`);
  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-series-05-release-'));const archiveRoot=path.join(temporaryRoot,'archive');
  const packageRoot=path.join(archiveRoot,'zhsh-remake');const extractionRoot=path.join(temporaryRoot,'extracted');
  try {
    copyTrackedSnapshot(packageRoot);const reviewRoot=path.join(packageRoot,'review');fs.mkdirSync(path.join(reviewRoot,'git'),{recursive:true});
    fs.writeFileSync(path.join(reviewRoot,'git','HEAD.txt'),`${head}\n`,'utf8');
    fs.writeFileSync(path.join(reviewRoot,'git','commits-since-stage-start.txt'),command('git',['log','--reverse','--format=%H %s','c1fd6e57c62603a87c9291fc16ed4cc83d0aab16..main']),'utf8');
    command('git',['bundle','create',path.join(reviewRoot,'git','zhsh-series-05-main.bundle'),'main']);
    const selection=require(path.join(packageRoot,'data','generated','runnable-task-selection.json'));
    fs.writeFileSync(path.join(reviewRoot,'release-summary.json'),`${JSON.stringify({schema_version:1,head,branch,
      starting_head:'c1fd6e57c62603a87c9291fc16ed4cc83d0aab16',formal_tasks:selection.selected_task_count,
      formal_series:selection.selected_series_count,series_05_terminal:'task.series.05.035',cold_commands:['npm run verify:core','npm run test:browser-dom:incremental'],
      full_browser_dom_repeated_in_cold_verification:false},null,2)}\n`,'utf8');
    const fileCount=writeManifest(packageRoot);fs.mkdirSync(outputDirectory,{recursive:true});const zipPath=path.join(outputDirectory,zipName);
    createDeterministicZip(archiveRoot,zipPath);fs.mkdirSync(extractionRoot,{recursive:true});command('tar',['-xf',zipPath,'-C',extractionRoot]);
    const extractedProject=path.join(extractionRoot,'zhsh-remake');const records=runColdVerification(extractedProject);
    const coldLogPath=path.join(outputDirectory,'cold-verification.json');fs.writeFileSync(coldLogPath,`${JSON.stringify({schema_version:1,
      verified_zip:zipName,verified_head:head,full_browser_dom_repeated:false,records},null,2)}\n`,'utf8');
    const sha256=crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');const shaPath=path.join(outputDirectory,`${zipName}.sha256`);
    fs.writeFileSync(shaPath,`${sha256}  ${zipName}\n`,'utf8');process.stdout.write(`${JSON.stringify({zip_path:zipPath,sha256,head,file_count:fileCount,
      cold_verify_core_exit_code:0,cold_incremental_dom_exit_code:0,full_dom_repeated:false},null,2)}\n`);
    return {zipPath,sha256,head,coldLogPath};
  } finally {
    const resolved=path.resolve(temporaryRoot),temporaryBase=path.resolve(os.tmpdir());
    if(!resolved.startsWith(`${temporaryBase}${path.sep}`))throw new Error(`Refusing to remove non-temporary directory: ${resolved}`);
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
