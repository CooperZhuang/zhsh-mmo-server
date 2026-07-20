'use strict';

const assert=require('node:assert/strict');
const childProcess=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {parseArguments}=require('../scripts/run-browser-test');

const root=path.resolve(__dirname,'..');

function processExists(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
function sleep(milliseconds){return new Promise((resolve)=>setTimeout(resolve,milliseconds));}

test('browser-test runner parses explicit and environment budgets',()=>{
  const prior=process.env.ZHSH_BROWSER_TEST_BUDGET_MS;
  try{
    process.env.ZHSH_BROWSER_TEST_BUDGET_MS='9000';
    assert.deepEqual(parseArguments(['browser-tests/example.test.js']),{budgetMs:9000,nodeTestArguments:['browser-tests/example.test.js']});
    assert.deepEqual(parseArguments(['--budget-ms','1200','browser-tests/example.test.js']),{budgetMs:1200,nodeTestArguments:['browser-tests/example.test.js']});
  }finally{if(prior===undefined)delete process.env.ZHSH_BROWSER_TEST_BUDGET_MS;else process.env.ZHSH_BROWSER_TEST_BUDGET_MS=prior;}
});

test('browser-test runner enforces its own budget and kills descendant processes',{timeout:10_000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-browser-budget-'));
  const pidFile=path.join(directory,'descendant.pid');
  try{
    const started=Date.now();
    const result=childProcess.spawnSync(process.execPath,[
      'scripts/run-browser-test.js','--budget-ms','2000','tests/fixtures/browser-budget-hang.js',
    ],{cwd:root,encoding:'utf8',timeout:7000,env:{...process.env,ZHSH_BUDGET_FIXTURE_PID_FILE:pidFile}});
    const elapsed=Date.now()-started;
    assert.equal(result.error,undefined,`runner did not return within the test budget: ${result.error?.message}`);
    assert.equal(result.status,124,`${result.stdout}\n${result.stderr}`);
    assert.ok(elapsed<6500,`budget enforcement took ${elapsed}ms`);
    assert.match(result.stderr,/ZHSH_BROWSER_TEST_BUDGET_EXCEEDED/);
    assert.ok(fs.existsSync(pidFile),'hanging fixture did not report its descendant PID');
    const descendantPid=Number(fs.readFileSync(pidFile,'utf8'));
    for(let attempt=0;attempt<20&&processExists(descendantPid);attempt+=1)await sleep(50);
    assert.equal(processExists(descendantPid),false,`descendant process ${descendantPid} survived budget termination`);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
