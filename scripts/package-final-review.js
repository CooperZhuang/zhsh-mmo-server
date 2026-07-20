'use strict';

const childProcess=require('node:child_process');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const baseCommit='a841ac9';
const fixedIso='2026-07-17T00:00:00.000Z';

function command(executable,args,{cwd=root}={}) {
  const result=childProcess.spawnSync(executable,args,{cwd,encoding:'utf8'});
  if(result.status!==0)throw new Error(`${executable} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function verifyCold(copyRoot) {
  const result=process.platform==='win32'
    ? childProcess.spawnSync('cmd.exe',['/d','/s','/c','npm.cmd run verify'],{cwd:copyRoot,encoding:'utf8'})
    : childProcess.spawnSync('npm',['run','verify'],{cwd:copyRoot,encoding:'utf8'});
  const log=`command: npm run verify\nexit_code: ${result.status}\n${result.stdout}${result.stderr}`;
  if(result.status!==0)throw new Error(`Cold verification failed\n${log}`);
  return log;
}

function listFiles(directory) {
  const files=[];
  function visit(current) {
    for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const absolute=path.join(current,entry.name);
      if(entry.isDirectory())visit(absolute);
      else if(entry.isFile())files.push(absolute);
      else throw new Error(`Unsupported archive entry: ${absolute}`);
    }
  }
  visit(directory);return files;
}

function buildManifest(packageRoot,manifestRelative) {
  const normalizedManifest=manifestRelative.replaceAll('\\','/');
  const files=listFiles(packageRoot).map((absolute)=>{
    const relative=path.relative(packageRoot,absolute).replaceAll('\\','/');
    if(relative===normalizedManifest)return null;
    const bytes=fs.readFileSync(absolute);
    return {path:relative,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  }).filter(Boolean);
  return {schema_version:1,generated_at:fixedIso,algorithm:'SHA-256',manifest_self_excluded:true,file_count:files.length,files};
}

function crc32(bytes) {
  let crc=0xffffffff;
  for(const value of bytes){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}

function createDeterministicZip(sourceDirectory,outputPath) {
  const localParts=[];const centralParts=[];let offset=0;const dosTime=0;const dosDate=((2026-1980)<<9)|(7<<5)|17;
  for(const absolute of listFiles(sourceDirectory)) {
    const name=path.relative(sourceDirectory,absolute).replaceAll('\\','/');
    const nameBytes=Buffer.from(name,'utf8');const data=fs.readFileSync(absolute);const crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);
    local.writeUInt16LE(0,8);local.writeUInt16LE(dosTime,10);local.writeUInt16LE(dosDate,12);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);local.writeUInt16LE(0,28);
    localParts.push(local,nameBytes,data);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
    central.writeUInt16LE(0x0800,8);central.writeUInt16LE(0,10);central.writeUInt16LE(dosTime,12);central.writeUInt16LE(dosDate,14);
    central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);
    central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);central.writeUInt32LE(0,38);central.writeUInt32LE(offset,42);
    centralParts.push(central,nameBytes);offset+=local.length+nameBytes.length+data.length;
  }
  const centralDirectory=Buffer.concat(centralParts);const end=Buffer.alloc(22);const fileCount=centralParts.length/2;
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);end.writeUInt16LE(fileCount,8);end.writeUInt16LE(fileCount,10);
  end.writeUInt32LE(centralDirectory.length,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(0,20);
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,Buffer.concat([...localParts,centralDirectory,end]));
}

function main() {
  if(command('git',['status','--porcelain','--untracked-files=all']).trim())throw new Error('Worktree must be clean before final packaging');
  const head=command('git',['rev-parse','HEAD']).trim();const shortHead=head.slice(0,12);
  command('git',['cat-file','-e',`${baseCommit}^{commit}`]);
  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-final-review-'));
  const archiveRoot=path.join(temporaryRoot,'archive');const packageRoot=path.join(archiveRoot,'zhsh-remake');const reviewRoot=path.join(packageRoot,'review');
  try {
    fs.mkdirSync(packageRoot,{recursive:true});
    const trackedFiles=command('git',['ls-files','-z']).split('\0').filter(Boolean);
    for(const relative of trackedFiles){const source=path.join(root,relative);const destination=path.join(packageRoot,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination);}
    fs.mkdirSync(path.join(reviewRoot,'git'),{recursive:true});fs.mkdirSync(path.join(reviewRoot,'validation'),{recursive:true});
    fs.writeFileSync(path.join(reviewRoot,'git','commits-since-a841.txt'),command('git',['log','--reverse','--format=%H %s',`${baseCommit}..HEAD`]),'utf8');
    fs.writeFileSync(path.join(reviewRoot,'git','diff-stat-since-a841.txt'),command('git',['diff','--stat',baseCommit,'HEAD']),'utf8');
    command('git',['bundle','create',path.join(reviewRoot,'git',`zhsh-remake-${baseCommit}-to-${shortHead}.bundle`),'HEAD',`^${baseCommit}`]);
    const metadata={schema_version:1,generated_at:fixedIso,head,base_commit:command('git',['rev-parse',baseCommit]).trim(),
      baseline_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(packageRoot,'docs','reconstruction-baseline','multisource-baseline.json'))).digest('hex'),
      formal_playable_tasks:25,previous_playable_tasks:14,total_tasks:651,browser_series:['task.series.01','task.series.03','task.series.04','task.series.05','task.series.06','task.series.08','task.series.10']};
    fs.writeFileSync(path.join(reviewRoot,'review-metadata.json'),`${JSON.stringify(metadata,null,2)}\n`,'utf8');

    const validationRoot=path.join(temporaryRoot,'cold-validation');fs.cpSync(packageRoot,validationRoot,{recursive:true});
    const coldLog=verifyCold(validationRoot);fs.writeFileSync(path.join(reviewRoot,'validation','cold-verify.log'),coldLog,'utf8');
    const manifestRelative='review/PAYLOAD-SHA256.json';const manifest=buildManifest(packageRoot,manifestRelative);
    fs.writeFileSync(path.join(packageRoot,...manifestRelative.split('/')),`${JSON.stringify(manifest,null,2)}\n`,'utf8');

    const outputDirectory=path.join(root,'out');const zipPath=path.join(outputDirectory,`zhsh-formal-restoration-${shortHead}.zip`);
    createDeterministicZip(archiveRoot,zipPath);
    const extractionRoot=path.join(temporaryRoot,'final-extraction');fs.mkdirSync(extractionRoot,{recursive:true});command('tar',['-xf',zipPath,'-C',extractionRoot]);
    const finalColdLog=verifyCold(path.join(extractionRoot,'zhsh-remake'));
    if(finalColdLog!==coldLog)throw new Error('Final ZIP cold verification output differs from packaged verification log');
    const zipBytes=fs.readFileSync(zipPath);const zipSha256=crypto.createHash('sha256').update(zipBytes).digest('hex');
    const hashPath=`${zipPath}.sha256`;const logPath=path.join(outputDirectory,`zhsh-formal-restoration-${shortHead}-cold-verify.log`);
    fs.writeFileSync(hashPath,`${zipSha256}  ${path.basename(zipPath)}\n`,'utf8');fs.writeFileSync(logPath,finalColdLog,'utf8');
    console.log(JSON.stringify({zip_path:zipPath,zip_sha256:zipSha256,cold_verify_log:logPath,file_count:manifest.file_count,head},null,2));
    return {zipPath,zipSha256,logPath,head};
  } finally {
    const resolved=path.resolve(temporaryRoot);const tempBase=path.resolve(os.tmpdir());
    if(!resolved.startsWith(`${tempBase}${path.sep}`))throw new Error(`Refusing to remove non-temporary path: ${resolved}`);
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={createDeterministicZip,main};
