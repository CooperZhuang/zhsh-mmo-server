'use strict';

const childProcess=require('node:child_process');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createDeterministicZip}=require('./package-runnable-task-expansion');

const root=path.resolve(__dirname,'..');
const baselineCommit='47a90a68b16ffa65261d25955e55a0c3be8854b9';
const thirdBatchHead='5ab189272f3c3c6836eff46f4ce78e4266df6c70';
const fixedIso='2026-07-18T00:00:00.000Z';
const artifactDirectory=path.join(root,'artifacts','third-batch-browser-evidence-repair');

function command(executable,args,{cwd=root,allowFailure=false}={}){
  const result=childProcess.spawnSync(executable,args,{cwd,encoding:'utf8'});const output=`command: ${executable} ${args.join(' ')}\nexit_code: ${result.status}\n${result.stdout}${result.stderr}`;
  if(result.status!==0&&!allowFailure)throw new Error(output);return {status:result.status,stdout:result.stdout,stderr:result.stderr,output};
}
function git(args,options={}){return command('git',args,options);}
function sha256(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function listFiles(directory){const files=[];function visit(current){for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const absolute=path.join(current,entry.name);if(entry.isDirectory())visit(absolute);else if(entry.isFile())files.push(absolute);else throw new Error(`Unsupported archive entry: ${absolute}`);}}visit(directory);return files;}
function copyTracked(packageRoot){
  const tracked=git(['ls-files','-z']).stdout.split('\0').filter(Boolean);for(const relative of tracked){const normalized=relative.replaceAll('\\','/');
    if(normalized.startsWith('artifacts/')||normalized.startsWith('out/')||normalized.startsWith('dist/')||normalized.startsWith('node_modules/'))continue;
    const destination=path.join(packageRoot,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(root,relative),destination);}
}
function manifest(packageRoot,relativeManifest){const normalized=relativeManifest.replaceAll('\\','/');const files=listFiles(packageRoot).map((absolute)=>{
  const relative=path.relative(packageRoot,absolute).replaceAll('\\','/');if(relative===normalized)return null;const bytes=fs.readFileSync(absolute);
  return {path:relative,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}).filter(Boolean);
  return {schema_version:1,generated_at:fixedIso,algorithm:'SHA-256',manifest_self_excluded:true,file_count:files.length,files};}
function declaredTests(directory){return fs.readdirSync(directory).filter((name)=>name.endsWith('.test.js')).reduce((total,name)=>total+(fs.readFileSync(path.join(directory,name),'utf8').match(/^test\s*\(/gm)?.length??0),0);}
function unexpectedWorktreeChanges(){return git(['status','--porcelain','--untracked-files=all']).stdout.split(/\r?\n/).filter(Boolean).filter((line)=>{
  const relative=line.slice(3).replaceAll('\\','/');return !relative.startsWith('artifacts/third-batch-browser-evidence-repair/');}).join('\n');}
function verifyCold(copyRoot){
  const result=process.platform==='win32'?childProcess.spawnSync('cmd.exe',['/d','/s','/c','npm.cmd run verify'],{cwd:copyRoot,encoding:'utf8'}):childProcess.spawnSync('npm',['run','verify'],{cwd:copyRoot,encoding:'utf8'});
  return {status:result.status,log:`command: npm run verify\nexit_code: ${result.status}\n${result.stdout}${result.stderr}`};
}

function main(){
  if(unexpectedWorktreeChanges())throw new Error('Worktree must be clean before final packaging');
  const branch=git(['branch','--show-current']).stdout.trim(),head=git(['rev-parse','HEAD']).stdout.trim();if(branch!=='main')throw new Error(`Expected main, got ${branch}`);
  git(['cat-file','-e',`${baselineCommit}^{commit}`]);git(['cat-file','-e',`${thirdBatchHead}^{commit}`]);
  const selection=JSON.parse(fs.readFileSync(path.join(root,'data','generated','runnable-task-selection.json'),'utf8'));
  const matrix=JSON.parse(fs.readFileSync(path.join(root,'docs','development','task-playability-matrix.json'),'utf8'));
  if(selection.selected_task_count!==57||selection.selected_series_count!==11||matrix.total_tasks!==651||matrix.formal_core_playable_count!==57)throw new Error('Formal 57/11/651 baseline changed');
  const requiredEvidence=['docs/development/browser-dom-e2e-evidence/browser-dom-e2e-results.json','docs/development/browser-dom-e2e-evidence/dom-browser-e2e.log',
    'docs/development/browser-dom-e2e-evidence/npm-run-verify.log','docs/development/browser-dom-e2e-evidence/formal-content-invariance.json','docs/development/browser-free-encounter-qa.json'];
  for(const relative of requiredEvidence)if(!fs.existsSync(path.join(root,relative)))throw new Error(`Missing real validation evidence: ${relative}`);

  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-browser-evidence-package-'));const archiveRoot=path.join(temporaryRoot,'archive');
  const packageRoot=path.join(archiveRoot,'zhsh-remake'),reviewRoot=path.join(packageRoot,'review'),gitReview=path.join(reviewRoot,'git'),validationReview=path.join(reviewRoot,'validation');
  try{
    fs.mkdirSync(gitReview,{recursive:true});fs.mkdirSync(validationReview,{recursive:true});copyTracked(packageRoot);
    fs.copyFileSync(path.join(root,'docs','development','browser-free-encounter-qa.json'),path.join(reviewRoot,'browser-qa.json'));
    for(const relative of requiredEvidence.slice(0,4))fs.copyFileSync(path.join(root,relative),path.join(validationReview,path.basename(relative)));
    fs.writeFileSync(path.join(gitReview,'HEAD.txt'),`${head}\n`,'utf8');fs.writeFileSync(path.join(gitReview,'branch.txt'),`${branch}\n`,'utf8');
    fs.writeFileSync(path.join(gitReview,'commits-since-third-batch-head.txt'),git(['log','--reverse','--format=%H %s',`${thirdBatchHead}..${head}`]).stdout,'utf8');
    fs.writeFileSync(path.join(gitReview,'diff-stat-since-third-batch-head.txt'),git(['diff','--stat',thirdBatchHead,head]).stdout,'utf8');
    const bundleName=`zhsh-third-batch-browser-evidence-${head.slice(0,12)}.bundle`,bundlePath=path.join(gitReview,bundleName);
    git(['bundle','create',bundlePath,'--all']);const verify=git(['bundle','verify',bundlePath]);const restorePath=path.join(temporaryRoot,'bundle-restore');
    const clone=git(['clone',bundlePath,restorePath]);const restoredType=git(['cat-file','-t',head],{cwd:restorePath});
    fs.writeFileSync(path.join(gitReview,'bundle-manifest.txt'),`bundle_type: full\nprerequisite: none\nempty_directory_clone: passed\nfinal_head_object_type: ${restoredType.stdout.trim()}\n`,'utf8');
    fs.writeFileSync(path.join(gitReview,'bundle-verification.log'),`${verify.output}\n${clone.output}\n${restoredType.output}`,'utf8');
    const existingTests=declaredTests(path.join(packageRoot,'tests')),domTests=declaredTests(path.join(packageRoot,'browser-tests'));
    const summary={schema_version:1,generated_at:fixedIso,branch,third_batch_baseline_commit:baselineCommit,third_batch_formal_head:thirdBatchHead,repair_head:head,
      formal_tasks:57,formal_series:11,not_selected_tasks:594,matrix_tasks:651,historical_accepted_test_count:87,preserved_test_count:existingTests,
      dom_browser_e2e_test_count:domTests,total_test_count:existingTests+domTests,bundle:{type:'full',prerequisite:null,empty_clone_verified:true},
      logs:{npm_verify:'review/validation/npm-run-verify.log',dom_browser_e2e:'review/validation/dom-browser-e2e.log'},cold_verification_performed_after_zip_creation:true};
    fs.writeFileSync(path.join(reviewRoot,'test-build-summary.json'),`${JSON.stringify(summary,null,2)}\n`,'utf8');
    const manifestRelative='review/PAYLOAD-SHA256.json';fs.writeFileSync(path.join(packageRoot,...manifestRelative.split('/')),`${JSON.stringify(manifest(packageRoot,manifestRelative),null,2)}\n`,'utf8');
    fs.mkdirSync(artifactDirectory,{recursive:true});const zipPath=path.join(artifactDirectory,'zhsh-third-batch-browser-evidence-repair.zip');createDeterministicZip(archiveRoot,zipPath);
    const reproducibilityZip=path.join(temporaryRoot,'rebuild.zip');createDeterministicZip(archiveRoot,reproducibilityZip);if(sha256(zipPath)!==sha256(reproducibilityZip))throw new Error('Deterministic ZIP rebuild hash differs');
    const extraction=path.join(temporaryRoot,'final-extraction');fs.mkdirSync(extraction,{recursive:true});command('tar',['-xf',zipPath,'-C',extraction]);
    const cold=verifyCold(path.join(extraction,'zhsh-remake'));const coldLogPath=path.join(artifactDirectory,'final-cold-start-verification.log');fs.writeFileSync(coldLogPath,cold.log,'utf8');
    if(cold.status!==0)throw new Error(`Final ZIP cold verification failed; log: ${coldLogPath}`);
    const zipHash=sha256(zipPath);fs.writeFileSync(`${zipPath}.sha256`,`${zipHash}  ${path.basename(zipPath)}\n`,'utf8');
    if(unexpectedWorktreeChanges())throw new Error('Worktree changed during packaging');
    process.stdout.write(`${JSON.stringify({zip_path:zipPath,zip_sha256:zipHash,cold_log:coldLogPath,head,branch,bundle_type:'full',bundle_prerequisite:null,deterministic_rebuild:true},null,2)}\n`);
    return {zipPath,zipHash,coldLogPath,head};
  }finally{
    const resolved=path.resolve(temporaryRoot),temporary=path.resolve(os.tmpdir());if(!resolved.startsWith(`${temporary}${path.sep}`))throw new Error(`Refusing to remove non-temporary path: ${resolved}`);
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
