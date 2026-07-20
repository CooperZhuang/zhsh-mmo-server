'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');
const {spawnSync}=require('node:child_process');
const {createDeterministicZip}=require('./package-runnable-task-expansion');

const root=path.resolve(__dirname,'..');
const fixedIso='2026-07-18T00:00:00.000Z';

function main(options={}){
  const stageId=options.stageId??'progression-stage',artifactPrefix=options.artifactPrefix??'artifacts/progression-stage/';
  const outputRoot=path.resolve(options.outputRoot??argument('--output-root')??path.join(root,'out',stageId));
  const status=run('git',['status','--porcelain','--untracked-files=all'],root).stdout.trim();
  if(status)throw new Error(`Worktree must be clean before packaging:\n${status}`);
  const branch=run('git',['branch','--show-current'],root).stdout.trim();
  if(branch!=='main')throw new Error(`Expected main branch, received ${branch||'(detached)'}`);
  const head=run('git',['rev-parse','HEAD'],root).stdout.trim();
  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-progression-package-'));
  const archiveRoot=path.join(temporaryRoot,'archive');const packageRoot=path.join(archiveRoot,'zhsh-remake');
  const reviewRoot=path.join(packageRoot,'review');const bundleRelative=`review/git/zhsh-main-${head.slice(0,12)}.bundle`;
  try{
    copyTrackedSnapshot(packageRoot,artifactPrefix);fs.mkdirSync(path.join(reviewRoot,'git'),{recursive:true});fs.mkdirSync(path.join(reviewRoot,'validation'),{recursive:true});
    const bundlePath=path.join(packageRoot,...bundleRelative.split('/'));
    run('git',['-c','pack.threads=1','bundle','create',bundlePath,'HEAD','main'],root);
    const bundleRefs=parseBundleRefs(run('git',['bundle','list-heads',bundlePath],root).stdout);
    assertBundleRefs(bundleRefs,head);
    run('git',['bundle','verify',bundlePath],root);
    fs.writeFileSync(path.join(reviewRoot,'git','HEAD.txt'),`${head}\n`,'utf8');
    fs.writeFileSync(path.join(reviewRoot,'git','bundle-verification.json'),`${JSON.stringify({schema_version:1,verified_at:fixedIso,
      expected_head:head,refs:bundleRefs,ordinary_clone_default_branch:'main',branch_clone_command:'git clone --branch main --single-branch <bundle> <destination>'},null,2)}\n`,'utf8');
    const cold=verifyColdBundle(bundlePath,temporaryRoot,head,options.coldCommands,options.generationHead);
    fs.writeFileSync(path.join(reviewRoot,'validation','cold-verification.json'),`${JSON.stringify(cold,null,2)}\n`,'utf8');
    const manifestRelative='review/PAYLOAD-SHA256.json';const manifest=buildManifest(packageRoot,manifestRelative);
    fs.writeFileSync(path.join(packageRoot,...manifestRelative.split('/')),`${JSON.stringify(manifest,null,2)}\n`,'utf8');
    fs.mkdirSync(outputRoot,{recursive:true});const zipPath=path.join(outputRoot,`zhsh-${stageId}-${head.slice(0,12)}.zip`);
    createDeterministicZip(archiveRoot,zipPath);const validation=verifyZipPayload(zipPath);
    const zipSha256=sha256File(zipPath);
    process.stdout.write(`${JSON.stringify({zip_path:zipPath,zip_sha256:zipSha256,head,branch,packaging_node_version:process.version,bundle_refs:bundleRefs,
      ordinary_clone: cold.ordinary_clone,branch_clone:cold.branch_clone,manifest_file_count:manifest.file_count,
      internal_zip_validation:validation.result,path_safety:validation.path_safety},null,2)}\n`);
    return {zipPath,zipSha256,head,manifestFileCount:manifest.file_count};
  }finally{safeRemoveTemporary(temporaryRoot);}
}

function copyTrackedSnapshot(destinationRoot,artifactPrefix){
  const tracked=run('git',['ls-files','-z'],root).stdout.split('\0').filter(Boolean);
  for(const relative of tracked){const normalized=relative.replaceAll('\\','/');
    if(normalized.startsWith('artifacts/')&&!normalized.startsWith(artifactPrefix))continue;
    if(normalized.startsWith('out/')||normalized.startsWith('node_modules/')||normalized.startsWith('dist/'))continue;
    const source=path.join(root,relative);const destination=path.join(destinationRoot,relative);
    fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination);
  }
}

function verifyColdBundle(bundlePath,temporaryRoot,expectedHead,coldCommands,generationHeadOverride){
  const ordinaryRoot=path.join(temporaryRoot,'ordinary-clone');run('git',['-c','core.autocrlf=false','clone',bundlePath,ordinaryRoot],temporaryRoot);
  const ordinary=verifyClone(ordinaryRoot,expectedHead);
  const branchRoot=path.join(temporaryRoot,'branch-clone');run('git',['-c','core.autocrlf=false','clone','--branch','main','--single-branch',bundlePath,branchRoot],temporaryRoot);
  const branch=verifyClone(branchRoot,expectedHead);
  const generationHead=generationHeadOverride??JSON.parse(fs.readFileSync(path.join(ordinaryRoot,'data','generated','runnable-task-selection.json'),'utf8')).generated_from_head;
  const priorGenerationHead=process.env.ZHSH_GENERATED_FROM_HEAD;let commands;
  process.env.ZHSH_GENERATED_FROM_HEAD=generationHead;
  try{commands=(coldCommands??[
      {label:'node scripts/import-content.js',args:['scripts/import-content.js']},
      {label:'node --test tests/reference-golden-rules.test.js',args:['--test','tests/reference-golden-rules.test.js']},
      {label:'node --test tests/browser-playable.test.js',args:['--test','tests/browser-playable.test.js']},
      {label:'node scripts/build-browser.js',args:['scripts/build-browser.js']},
    ]).map((entry)=>{const result=run(process.execPath,entry.args,ordinaryRoot);return {command:entry.label,exit_code:0,
      reported_test_count:entry.tests??parseTestCount(result.stdout),stdout_sha256:sha256(normalizeColdCommandOutput(result.stdout,{temporaryRoot})),
      stderr_sha256:sha256(normalizeColdCommandOutput(result.stderr,{temporaryRoot})),
      hash_normalization:'Node process IDs, TAP timings, duration_ms and package temporary roots'};});
  }finally{if(priorGenerationHead===undefined)delete process.env.ZHSH_GENERATED_FROM_HEAD;else process.env.ZHSH_GENERATED_FROM_HEAD=priorGenerationHead;}
  const finalStatus=run('git',['status','--porcelain','--untracked-files=all'],ordinaryRoot).stdout.trim();
  if(finalStatus)throw new Error(`Cold verification changed the packaged source:\n${finalStatus}`);
  return {schema_version:3,verified_at:fixedIso,result:'passed',packaging_node_version:process.version,expected_head:expectedHead,generation_head:generationHead,ordinary_clone:ordinary,branch_clone:branch,
    independent_clones:true,commands,worktree_clean_after_verification:true};
}

function verifyClone(directory,expectedHead){
  const head=run('git',['rev-parse','HEAD'],directory).stdout.trim();const branch=run('git',['branch','--show-current'],directory).stdout.trim();
  const status=run('git',['status','--porcelain','--untracked-files=all'],directory).stdout.trim();
  if(head!==expectedHead||branch!=='main'||status)throw new Error(`Bundle clone mismatch: ${head}/${branch}/${JSON.stringify(status)}`);
  return {result:'passed',head,branch,worktree_clean:true};
}

function parseBundleRefs(output){return output.trim().split(/\r?\n/).filter(Boolean).map((line)=>{const match=line.match(/^([0-9a-f]{40})\s+(.+)$/);
  if(!match)throw new Error(`Unexpected bundle ref: ${line}`);return {object_id:match[1],ref:match[2]};}).sort((a,b)=>a.ref.localeCompare(b.ref,'en'));}
function assertBundleRefs(refs,head){for(const ref of ['HEAD','refs/heads/main'])if(!refs.some((entry)=>entry.ref===ref&&entry.object_id===head))throw new Error(`Bundle missing ${ref} at ${head}`);}

function buildManifest(packageRoot,manifestRelative){const excluded=manifestRelative.replaceAll('\\','/');const files=listFiles(packageRoot).map((absolute)=>{
  const relative=path.relative(packageRoot,absolute).replaceAll('\\','/');if(relative===excluded)return null;const bytes=fs.readFileSync(absolute);
  return {path:relative,size:bytes.length,sha256:sha256(bytes)};}).filter(Boolean);
  return {schema_version:1,generated_at:fixedIso,algorithm:'SHA-256',manifest_self_excluded:true,file_count:files.length,files};}

function verifyZipPayload(zipPath){const entries=readZip(zipPath);const manifestName='zhsh-remake/review/PAYLOAD-SHA256.json';
  if(!entries.has(manifestName))throw new Error('ZIP manifest missing');const manifest=JSON.parse(entries.get(manifestName).toString('utf8'));
  for(const entry of manifest.files){const name=`zhsh-remake/${entry.path}`;const bytes=entries.get(name);if(!bytes)throw new Error(`Manifest ZIP entry missing: ${name}`);
    if(bytes.length!==entry.size||sha256(bytes)!==entry.sha256)throw new Error(`Manifest ZIP mismatch: ${name}`);}
  return {result:'passed',path_safety:'passed',entries:entries.size,manifest_files:manifest.file_count};}

function readZip(zipPath){const bytes=fs.readFileSync(zipPath);const entries=new Map();let offset=0;
  while(offset+4<=bytes.length){const signature=bytes.readUInt32LE(offset);if(signature===0x02014b50||signature===0x06054b50)break;
    if(signature!==0x04034b50)throw new Error(`Unexpected ZIP signature at ${offset}`);if(offset+30>bytes.length)throw new Error('Truncated ZIP local header');
    const flags=bytes.readUInt16LE(offset+6),method=bytes.readUInt16LE(offset+8),expectedCrc=bytes.readUInt32LE(offset+14);
    const compressedSize=bytes.readUInt32LE(offset+18),size=bytes.readUInt32LE(offset+22),nameLength=bytes.readUInt16LE(offset+26),extraLength=bytes.readUInt16LE(offset+28);
    if(flags&0x0008)throw new Error('ZIP data descriptors are not supported');const nameStart=offset+30,nameEnd=nameStart+nameLength,dataStart=nameEnd+extraLength,dataEnd=dataStart+compressedSize;
    if(dataEnd>bytes.length)throw new Error('Truncated ZIP entry');const name=bytes.subarray(nameStart,nameEnd).toString('utf8');assertSafeArchivePath(name);
    if(entries.has(name))throw new Error(`Duplicate ZIP path: ${name}`);const compressed=bytes.subarray(dataStart,dataEnd);
    const data=method===0?Buffer.from(compressed):method===8?zlib.inflateRawSync(compressed):null;if(!data)throw new Error(`Unsupported ZIP method ${method}`);
    if(data.length!==size||crc32(data)!==expectedCrc)throw new Error(`ZIP size/CRC mismatch: ${name}`);entries.set(name,data);offset=dataEnd;
  }
  if(!entries.size)throw new Error('ZIP has no entries');return entries;}

function assertSafeArchivePath(name){if(!name||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').some((part)=>part===''||part==='.'||part==='..'))
  throw new Error(`Unsafe ZIP path: ${name}`);}
function crc32(bytes){let crc=0xffffffff;for(const value of bytes){crc^=value;for(let bit=0;bit<8;bit+=1)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function listFiles(directory){const result=[];const stack=[directory];while(stack.length){const current=stack.pop();for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>b.name.localeCompare(a.name,'en'))){
  const absolute=path.join(current,entry.name);if(entry.isDirectory())stack.push(absolute);else if(entry.isFile())result.push(absolute);else throw new Error(`Unsupported file type: ${absolute}`);}}
  return result.sort((a,b)=>path.relative(directory,a).localeCompare(path.relative(directory,b),'en'));}
function run(command,args,cwd,env=process.env){const result=spawnSync(command,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024,env});
  if(result.error)throw result.error;if(result.status!==0)throw new Error(`${commandLabel(command,args)} failed (${result.status})\n${result.stdout??''}${result.stderr??''}`);
  return {stdout:result.stdout??'',stderr:result.stderr??''};}
function commandLabel(command,args){return [path.basename(command),...args].join(' ');}
function parseTestCount(output){const match=String(output).match(/[ℹ#]\s*tests\s+(\d+)/);return match?Number(match[1]):null;}
function normalizeColdCommandOutput(output,options={}){
  let normalized=String(output).replace(/\(node:\d+\)/g,'(node:<pid>)')
    .replace(/\([0-9.]+ms\)/g,'(<timing>ms)')
    .replace(/\bduration_ms(\s*[:=]?\s*)[0-9.]+/g,'duration_ms$1<timing>');
  if(options.temporaryRoot){const variants=new Set([String(options.temporaryRoot),path.resolve(options.temporaryRoot)]);for(const value of [...variants]){
      variants.add(value.replaceAll('\\','/'));variants.add(value.replaceAll('\\','\\\\'));
    }
    for(const value of variants)normalized=normalized.replace(new RegExp(escapeRegExp(value),'gi'),'<package-temp>');
  }
  return normalized;
}
function escapeRegExp(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function argument(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
function safeRemoveTemporary(directory){const resolved=path.resolve(directory),base=path.resolve(os.tmpdir());if(!resolved.startsWith(`${base}${path.sep}`))throw new Error(`Refusing to clean non-temporary path: ${resolved}`);fs.rmSync(resolved,{recursive:true,force:true});}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}
function sha256File(file){return sha256(fs.readFileSync(file));}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={buildManifest,main,normalizeColdCommandOutput,readZip,verifyZipPayload};
