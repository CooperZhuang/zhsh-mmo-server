'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {createDeterministicZip}=require('../scripts/package-runnable-task-expansion');
const {normalizeColdCommandOutput,readZip}=require('../scripts/package-global-recovery-stage');

test('Node ZIP reader validates deterministic archive bytes without system tar',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-zip-reader-test-'));
  try{
    const source=path.join(temporary,'source');fs.mkdirSync(path.join(source,'zhsh-remake','review'),{recursive:true});
    fs.writeFileSync(path.join(source,'zhsh-remake','review','probe.txt'),'stable\n','utf8');const zip=path.join(temporary,'probe.zip');
    createDeterministicZip(source,zip);const entries=readZip(zip);assert.equal(entries.get('zhsh-remake/review/probe.txt').toString('utf8'),'stable\n');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('packager declares ordinary main clone, branch clone and independent full-run verification',()=>{
  const packageSource=fs.readFileSync(path.resolve('scripts','package-global-recovery-stage.js'),'utf8');
  const runnerSource=fs.readFileSync(path.resolve('scripts','verify-reproducible-global-recovery-package.js'),'utf8');
  const equipmentRunnerSource=fs.readFileSync(path.resolve('scripts','verify-reproducible-equipment-combat-package.js'),'utf8');
  assert.match(packageSource,/pack\.threads=1','bundle','create',bundlePath,'HEAD','main/);
  assert.match(packageSource,/ordinary-clone/);assert.match(packageSource,/--branch','main','--single-branch/);
  assert.match(packageSource,/reference-golden-rules\.test\.js/);
  assert.doesNotMatch(packageSource,/commands=\[[\s\S]*progression-source-golden\.test\.js/);
  assert.doesNotMatch(packageSource,/run\(['"]tar|spawnSync\(['"]tar/);
  assert.match(packageSource,/packaging_node_version:process\.version/);
  assert.match(packageSource,/normalizeColdCommandOutput\(result\.stdout,\{temporaryRoot\}\)/);
  assert.match(packageSource,/normalizeColdCommandOutput\(result\.stderr,\{temporaryRoot\}\)/);
  assert.match(runnerSource,/\['run-a','run-b'\]\.map/);assert.match(runnerSource,/Independent ZIP hashes differ/);
  assert.match(equipmentRunnerSource,/packaging_node_version:process\.version/);
});

test('cold command hashes normalize process IDs, TAP timing and package temporary roots in stdout and stderr',()=>{
  const rootA='C:\\Users\\tester\\AppData\\Local\\Temp\\zhsh-progression-package-a1b2c3';
  const rootB='C:\\Users\\tester\\AppData\\Local\\Temp\\zhsh-progression-package-d4e5f6';
  const stdoutA=`# (node:3902) ExperimentalWarning: SQLite is an experimental feature\n✔ stable test (18.25ms)\nℹ duration_ms 42.75\nfile:///${rootA.replaceAll('\\','/')}/ordinary-clone/probe.js\n`;
  const stdoutB=`# (node:3915) ExperimentalWarning: SQLite is an experimental feature\n✔ stable test (91.5ms)\nℹ duration_ms 207.125\nfile:///${rootB.replaceAll('\\','/')}/ordinary-clone/probe.js\n`;
  const stderrA=`(node:3902) ExperimentalWarning: SQLite is an experimental feature\nduration_ms: 6.5\n${rootA}\\ordinary-clone\\probe.js\n`;
  const stderrB=`(node:3915) ExperimentalWarning: SQLite is an experimental feature\nduration_ms: 8.75\n${rootB}\\ordinary-clone\\probe.js\n`;
  const normalizedStdout=normalizeColdCommandOutput(stdoutA,{temporaryRoot:rootA});
  const normalizedStderr=normalizeColdCommandOutput(stderrA,{temporaryRoot:rootA});
  assert.equal(normalizedStdout,normalizeColdCommandOutput(stdoutB,{temporaryRoot:rootB}));
  assert.equal(normalizedStderr,normalizeColdCommandOutput(stderrB,{temporaryRoot:rootB}));
  assert.match(normalizedStdout,/\(node:<pid>\)/);assert.match(normalizedStdout,/<timing>/);assert.match(normalizedStdout,/<package-temp>/);
  assert.match(normalizedStderr,/ExperimentalWarning: SQLite is an experimental feature/);
  assert.doesNotMatch(`${normalizedStdout}${normalizedStderr}`,/3902|a1b2c3|18\.25|42\.75|6\.5/);
});
