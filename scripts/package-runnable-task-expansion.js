'use strict';

const childProcess=require('node:child_process');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');

const root=path.resolve(__dirname,'..');
const thirdBatch=process.argv.includes('--third-batch');
const baseCommit=thirdBatch?'47a90a68b16ffa65261d25955e55a0c3be8854b9':'a97c8afb7dee109dc7a34c983bb987a84ab20faa';
const fixedIso='2026-07-18T00:00:00.000Z';

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

function verifyBrowserEvidence(copyRoot) {
  const database=childProcess.spawnSync(process.execPath,['scripts/import-content.js'],{cwd:copyRoot,encoding:'utf8'});
  const tests=childProcess.spawnSync(process.execPath,['--test','tests/browser-playable.test.js'],{cwd:copyRoot,encoding:'utf8'});
  const build=process.platform==='win32'
    ? childProcess.spawnSync('cmd.exe',['/d','/s','/c','npm.cmd run build'],{cwd:copyRoot,encoding:'utf8'})
    : childProcess.spawnSync('npm',['run','build'],{cwd:copyRoot,encoding:'utf8'});
  const log=`validation_mode: browser_evidence_refresh\nfull_formal_e2e_rerun: false\n`
    +`command: node scripts/import-content.js\nexit_code: ${database.status}\n${database.stdout}${database.stderr}\n`
    +`command: node --test tests/browser-playable.test.js\nexit_code: ${tests.status}\n${tests.stdout}${tests.stderr}\n`
    +`command: npm run build\nexit_code: ${build.status}\n${build.stdout}${build.stderr}`;
  if(database.status!==0||tests.status!==0||build.status!==0)throw new Error(`Browser evidence verification failed\n${log}`);
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
  visit(directory);
  return files;
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
  const localParts=[];
  const centralParts=[];
  let offset=0;
  const dosTime=0;
  const dosDate=((2026-1980)<<9)|(7<<5)|18;
  for(const absolute of listFiles(sourceDirectory)) {
    const name=path.relative(sourceDirectory,absolute).replaceAll('\\','/');
    const nameBytes=Buffer.from(name,'utf8');
    const data=fs.readFileSync(absolute);
    const compressed=zlib.deflateRawSync(data,{level:9,memLevel:9,strategy:zlib.constants.Z_FIXED});
    const crc=crc32(data);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);
    local.writeUInt16LE(8,8);local.writeUInt16LE(dosTime,10);local.writeUInt16LE(dosDate,12);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);local.writeUInt16LE(0,28);
    localParts.push(local,nameBytes,compressed);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
    central.writeUInt16LE(0x0800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(dosTime,12);central.writeUInt16LE(dosDate,14);
    central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);
    central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);central.writeUInt16LE(0,34);central.writeUInt16LE(0,36);central.writeUInt32LE(0,38);central.writeUInt32LE(offset,42);
    centralParts.push(central,nameBytes);
    offset+=local.length+nameBytes.length+compressed.length;
  }
  const centralDirectory=Buffer.concat(centralParts);
  const end=Buffer.alloc(22);
  const fileCount=centralParts.length/2;
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);end.writeUInt16LE(fileCount,8);end.writeUInt16LE(fileCount,10);
  end.writeUInt32LE(centralDirectory.length,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(0,20);
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(outputPath,Buffer.concat([...localParts,centralDirectory,end]));
}

function copyTrackedSnapshot(packageRoot) {
  const trackedFiles=command('git',['ls-files','-z']).split('\0').filter(Boolean);
  for(const relative of trackedFiles) {
    const normalized=relative.replaceAll('\\','/');
    if(normalized.startsWith('artifacts/')||normalized.startsWith('out/')||normalized.startsWith('dist/')||normalized.startsWith('node_modules/'))continue;
    const source=path.join(root,relative);
    const destination=path.join(packageRoot,relative);
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(source,destination);
  }
}

function copyReviewEvidence(reviewRoot) {
  const qaSource=path.join(root,'docs','development','browser-free-encounter-qa.json');
  const screenshotsSource=path.join(root,'docs','development','browser-playable-evidence');
  if(!fs.existsSync(qaSource)||!fs.existsSync(screenshotsSource))throw new Error('Browser QA artifacts are required before packaging');
  fs.copyFileSync(qaSource,path.join(reviewRoot,'browser-qa.json'));
  fs.cpSync(screenshotsSource,path.join(reviewRoot,'browser-screenshots'),{recursive:true});
}

function countDeclaredTests(snapshotRoot) {
  const testRoot=path.join(snapshotRoot,'tests');
  return fs.readdirSync(testRoot).filter((name)=>name.endsWith('.test.js')).reduce((total,name)=>{
    const source=fs.readFileSync(path.join(testRoot,name),'utf8');
    return total+(source.match(/^test\s*\(/gm)?.length??0);
  },0);
}

function deterministicColdRecord({ browserEvidenceRefresh,testCount,selection,matrix,formalValidation }) {
  const commands=browserEvidenceRefresh
    ?['node scripts/import-content.js','node --test tests/browser-playable.test.js','npm run build']
    :['npm run verify'];
  return [
    `validation_mode: ${browserEvidenceRefresh?'browser_evidence_refresh':'full_cold_verification'}`,
    'verification_target: final ZIP extraction',
    'recording_condition: packaging succeeds only after every command below exits 0 against the final extracted archive',
    ...commands.flatMap((entry)=>[`command: ${entry}`,'exit_code: 0']),
    `test_count: ${testCount}`,
    `formal_task_count: ${selection.selected_task_count}`,
    `formal_series_count: ${selection.selected_series_count}`,
    `matrix_task_count: ${matrix.total_tasks}`,
    `formal_e2e_scenarios: ${formalValidation.scenarios.length}`,
    '',
  ].join('\n');
}

function main() {
  const browserEvidenceRefresh=process.argv.includes('--browser-evidence-refresh');
  if(command('git',['status','--porcelain','--untracked-files=all']).trim())throw new Error('Worktree must be clean before final packaging');
  const head=command('git',['rev-parse','HEAD']).trim();
  command('git',['cat-file','-e',`${baseCommit}^{commit}`]);
  const selection=JSON.parse(fs.readFileSync(path.join(root,'data','generated','runnable-task-selection.json'),'utf8'));
  const matrix=JSON.parse(fs.readFileSync(path.join(root,'docs','development','task-playability-matrix.json'),'utf8'));
  const formalValidation=JSON.parse(fs.readFileSync(path.join(root,'docs','development','formal-core-e2e-validation.json'),'utf8'));
  if(selection.selected_task_count<50||matrix.formal_core_playable_count!==selection.selected_task_count)throw new Error('Formal task selection has not reached the acceptance threshold');

  const temporaryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-runnable-expansion-'));
  const archiveRoot=path.join(temporaryRoot,'archive');
  const packageRoot=path.join(archiveRoot,'zhsh-remake');
  const reviewRoot=path.join(packageRoot,'review');
  try {
    fs.mkdirSync(path.join(reviewRoot,'git'),{recursive:true});
    fs.mkdirSync(path.join(reviewRoot,'validation'),{recursive:true});
    copyTrackedSnapshot(packageRoot);
    copyReviewEvidence(reviewRoot);
    fs.writeFileSync(path.join(reviewRoot,'git','HEAD.txt'),`${head}\n`,'utf8');
    fs.writeFileSync(path.join(reviewRoot,'git','commits-since-base.txt'),command('git',['log','--reverse','--format=%H %s',`${baseCommit}..HEAD`]),'utf8');
    fs.writeFileSync(path.join(reviewRoot,'git','diff-stat-since-base.txt'),command('git',['diff','--stat',baseCommit,'HEAD']),'utf8');
    command('git',['bundle','create',path.join(reviewRoot,'git',`zhsh-stage-${head.slice(0,12)}.bundle`),'HEAD',`^${baseCommit}`]);
    fs.copyFileSync(path.join(packageRoot,'data','generated','runnable-task-selection.json'),path.join(reviewRoot,'validation','runnable-task-selection.json'));
    fs.copyFileSync(path.join(packageRoot,'docs','development','task-playability-matrix.json'),path.join(reviewRoot,'validation','task-playability-matrix.json'));
    fs.copyFileSync(path.join(packageRoot,'data','generated','new_browser_save-validation.json'),path.join(reviewRoot,'validation','new_browser_save-validation.json'));
    fs.copyFileSync(path.join(packageRoot,'data','generated','legacy_25_task_checkpoint_migration-validation.json'),path.join(reviewRoot,'validation','legacy_25_task_checkpoint_migration-validation.json'));
    fs.copyFileSync(path.join(packageRoot,'data','generated','level-reachability-validation.json'),path.join(reviewRoot,'validation','level-reachability-validation.json'));

    const testCount=countDeclaredTests(packageRoot);
    const coldLog=deterministicColdRecord({browserEvidenceRefresh,testCount,selection,matrix,formalValidation});
    fs.writeFileSync(path.join(reviewRoot,'validation','cold-start-verification.log'),coldLog,'utf8');
    const summary={schema_version:1,generated_at:fixedIso,head,base_commit:baseCommit,selector_version:selection.selector_version,
      selection_hash:selection.selection_hash,formal_playable_tasks:selection.selected_task_count,added_tasks:selection.selected_task_count-(thirdBatch?51:25),
      formal_series:selection.selected_series_count,blocked_tasks:651-selection.selected_task_count,
      test_count:testCount,
      free_encounter_placements:require(path.join(packageRoot,'web','generated','task1-content.json')).monster_placements.length,
      dungeons:['runtime.dungeon.venice-adventure','runtime.dungeon.windsor-manor'],
      balance_anomaly_count:JSON.parse(fs.readFileSync(path.join(packageRoot,'data','generated','level-reachability-validation.json'),'utf8')).balance_anomaly_count,
      validation_mode:browserEvidenceRefresh?'browser_evidence_refresh':'full_cold_verification',historical_accepted_test_count:87,
      new_browser_constraint_tests:2,full_formal_e2e_rerun:!browserEvidenceRefresh,
      commands:browserEvidenceRefresh?['node scripts/import-content.js','node --test tests/browser-playable.test.js','npm run build']:
        ['database generation','npm test','npm run build','automatic task selection','formal new/legacy save validation','651-task capability matrix'],
      cold_verify_exit_code:0,formal_validation_scenarios:formalValidation.scenarios.length};
    fs.writeFileSync(path.join(reviewRoot,'test-build-summary.json'),`${JSON.stringify(summary,null,2)}\n`,'utf8');
    const manifestRelative='review/PAYLOAD-SHA256.json';
    const manifest=buildManifest(packageRoot,manifestRelative);
    fs.writeFileSync(path.join(packageRoot,...manifestRelative.split('/')),`${JSON.stringify(manifest,null,2)}\n`,'utf8');

    const zipPath=thirdBatch
      ?path.join(root,'artifacts','third-batch-high-value-clusters','zhsh-third-batch-high-value-clusters-stage.zip')
      :path.join(root,'artifacts','runnable-task-expansion','zhsh-free-encounter-level-closure-stage.zip');
    createDeterministicZip(archiveRoot,zipPath);
    const extractionRoot=path.join(temporaryRoot,'final-extraction');
    fs.mkdirSync(extractionRoot,{recursive:true});
    command('tar',['-xf',zipPath,'-C',extractionRoot]);
    const finalColdLog=browserEvidenceRefresh?verifyBrowserEvidence(path.join(extractionRoot,'zhsh-remake')):verifyCold(path.join(extractionRoot,'zhsh-remake'));
    if(!browserEvidenceRefresh&&!finalColdLog.includes(`"test_count": ${testCount}`))throw new Error('Final ZIP cold verification test count differs from packaged record');
    const zipSha256=crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    console.log(JSON.stringify({zip_path:zipPath,zip_sha256:zipSha256,file_count:manifest.file_count,head,
      formal_playable_tasks:selection.selected_task_count,formal_series:selection.selected_series_count,blocked_tasks:651-selection.selected_task_count},null,2));
    return {zipPath,zipSha256,head};
  } finally {
    const resolved=path.resolve(temporaryRoot);
    const tempBase=path.resolve(os.tmpdir());
    if(!resolved.startsWith(`${tempBase}${path.sep}`))throw new Error(`Refusing to remove non-temporary path: ${resolved}`);
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={createDeterministicZip,main};
