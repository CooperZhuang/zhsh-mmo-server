'use strict';

const childProcess=require('node:child_process');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const baselineRelative='docs/reconstruction-baseline/multisource-baseline.json';
const expectedBaselineSha256='1f8d033e60895bccfd2a992cc34d1b6f51e191746fa4e02ec92b04579b4efbe5';
const rawRecords=[];

function run(label,args) {
  const startedAt=new Date().toISOString();const started=process.hrtime.bigint();
  const result=childProcess.spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});
  if(result.status!==0)throw new Error(`${label} failed\n${result.stdout}\n${result.stderr}`);
  rawRecords.push(commandRecord({label,command:[process.execPath,...args].join(' '),startedAt,started,result}));
  process.stdout.write(`[pass] ${label}\n`);
  return `${result.stdout}${result.stderr}`;
}

function runNpmTest() {
  const startedAt=new Date().toISOString();const started=process.hrtime.bigint();
  const result=process.platform==='win32'
    ? childProcess.spawnSync('cmd.exe',['/d','/s','/c','npm.cmd test'],{cwd:root,encoding:'utf8',env:{...process.env,ZHSH_CAPTURE_LEVEL_REACHABILITY:'1'}})
    : childProcess.spawnSync('npm',['test'],{cwd:root,encoding:'utf8',env:{...process.env,ZHSH_CAPTURE_LEVEL_REACHABILITY:'1'}});
  if(result.status!==0)throw new Error(`complete npm test failed\n${result.stdout}\n${result.stderr}`);
  rawRecords.push(commandRecord({label:'complete npm test',command:'npm test',startedAt,started,result}));
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);
  process.stdout.write('[pass] complete npm test\n');
  return `${result.stdout}${result.stderr}`;
}

function commandRecord({label,command,startedAt,started,result}){const stdout=result.stdout??'',stderr=result.stderr??'';return {
  label,git_head:gitHead(),node_version:process.version,command,started_at:startedAt,ended_at:new Date().toISOString(),
  duration_ms:Number((process.hrtime.bigint()-started)/1000000n),exit_code:result.status,signal:result.signal??null,
  test_count:parseTestCount(stdout),stdout_sha256:sha256(stdout),stderr_sha256:sha256(stderr),stdout,stderr};}
function parseTestCount(output){const matches=[...String(output).matchAll(/^[^\r\n]*\btests\s+(\d+)\s*$/gm)];return matches.length?Number(matches.at(-1)[1]):null;}
function gitHead(){const result=childProcess.spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});return result.status===0?result.stdout.trim():null;}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

function runDomBrowserTest() {
  const result=process.platform==='win32'
    ? childProcess.spawnSync('cmd.exe',['/d','/s','/c','npm.cmd run test:browser-dom'],{cwd:root,encoding:'utf8'})
    : childProcess.spawnSync('npm',['run','test:browser-dom'],{cwd:root,encoding:'utf8'});
  if(result.status!==0)throw new Error(`DOM browser E2E failed\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.stdout.write('[pass] DOM browser E2E\n');
  return `${result.stdout}${result.stderr}`;
}

function main() {
  const baselineBytes=fs.readFileSync(path.join(root,baselineRelative));
  const baselineSha256=crypto.createHash('sha256').update(baselineBytes).digest('hex');
  if(baselineSha256!==expectedBaselineSha256)throw new Error(`Baseline SHA-256 changed: ${baselineSha256}`);
  process.stdout.write('[pass] baseline byte hash\n');

  // 强制全新构建：内容库的历史 overlay 残留会使 upsert 式导入复活已裁决删除的行，破坏确定性
  const contentDb=path.join(root,'data','zhsh-content.sqlite');
  if(fs.existsSync(contentDb))fs.rmSync(contentDb,{force:true});
  run('full data generation',['scripts/import-content.js']);
  run('idle visual asset integration',['scripts/integrate-idle-assets.js']);
  run('blocked targets adjudication',['scripts/adjudicate-blocked-targets.js']);
  run('database validation',['scripts/validate-import.js']);
  run('browser build',['scripts/build-browser.js']);
  const testOutput=runNpmTest();
  require('./generate-formal-core-uat').writeValidationFromTestOutput(testOutput);
  process.stdout.write('[pass] new and legacy formal E2E validation artifacts\n');
  const matrixOutput=run('651-task playability matrix',['scripts/build-task-playability-matrix.js']);
  const testsMatch=testOutput.match(/\btests\s+(\d+)\s*(?:\r?\n|$)/);
  const existingTestCount=testsMatch?Number(testsMatch[1]):null;
  if(existingTestCount===null||existingTestCount<93)throw new Error(`Expected at least the preserved 93 tests, got ${existingTestCount??'unreported'}`);
  const matrix=JSON.parse(fs.readFileSync(path.join(root,'docs','development','task-playability-matrix.json'),'utf8'));
  const selection=JSON.parse(fs.readFileSync(path.join(root,'data','generated','runnable-task-selection.json'),'utf8'));
  if(matrix.total_tasks!==651||matrix.formal_core_playable_count!==selection.selected_task_count||selection.selected_task_count<50)throw new Error('Task matrix counts changed');
  if(!matrixOutput.includes('formal_core_playable'))throw new Error('Task matrix did not report formal status counts');
  const summary={ok:true,verification_scope:'core_without_long_browser_dom',node_version:process.version,test_count:existingTestCount,existing_test_count:existingTestCount,
    formal_core_playable:selection.selected_task_count,not_selected:651-selection.selected_task_count,
    total_tasks:651,baseline_sha256:baselineSha256,browser_content_sha256:require('../web/generated/task1-content.json').content_sha256};
  process.stdout.write(`${JSON.stringify(summary,null,2)}\n`);
  const evidenceDirectory=process.env.ZHSH_VERIFY_EVIDENCE_DIR??path.join(root,'artifacts','series-05-fishing-diving-palace-stage','raw');
  if(evidenceDirectory){fs.mkdirSync(evidenceDirectory,{recursive:true});fs.writeFileSync(path.join(evidenceDirectory,'verify-core-results.json'),
    `${JSON.stringify({schema_version:1,summary,commands:rawRecords},null,2)}\n`,'utf8');}
  return summary;
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
