'use strict';

const childProcess=require('node:child_process');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const DEFAULT_BUDGET_MS=20*60*1000;
const FORCE_KILL_GRACE_MS=1000;

function parsePositiveInteger(value,label){
  const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<=0)throw new Error(`${label} must be a positive integer, got ${value}`);
  return parsed;
}

function parseArguments(argv){
  let budgetMs=process.env.ZHSH_BROWSER_TEST_BUDGET_MS
    ?parsePositiveInteger(process.env.ZHSH_BROWSER_TEST_BUDGET_MS,'ZHSH_BROWSER_TEST_BUDGET_MS')
    :DEFAULT_BUDGET_MS;
  const nodeTestArguments=[];
  for(let index=0;index<argv.length;index+=1){
    const argument=argv[index];
    if(argument==='--budget-ms'){
      if(index+1>=argv.length)throw new Error('--budget-ms requires a value');
      budgetMs=parsePositiveInteger(argv[++index],'--budget-ms');
    }else if(argument.startsWith('--budget-ms='))budgetMs=parsePositiveInteger(argument.slice('--budget-ms='.length),'--budget-ms');
    else nodeTestArguments.push(argument);
  }
  if(nodeTestArguments.length===0)throw new Error('At least one browser test file or node:test argument is required');
  return {budgetMs,nodeTestArguments};
}

function linuxDescendantPids(rootPid){
  const result=childProcess.spawnSync('ps',['-eo','pid=,ppid='],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)return [];
  const children=new Map();
  for(const line of result.stdout.split(/\r?\n/)){
    const match=line.trim().match(/^(\d+)\s+(\d+)$/);if(!match)continue;
    const pid=Number(match[1]),parentPid=Number(match[2]);
    if(!children.has(parentPid))children.set(parentPid,[]);children.get(parentPid).push(pid);
  }
  const descendants=[];const visit=(pid)=>{for(const childPid of children.get(pid)??[]){visit(childPid);descendants.push(childPid);}};visit(rootPid);
  return descendants;
}

function collectProcessTree(rootPid){
  if(!Number.isInteger(rootPid)||rootPid<=0)return [];
  return process.platform==='win32'?[rootPid]:[...linuxDescendantPids(rootPid),rootPid];
}

function signalKnownProcesses(pids,signal){
  for(const pid of pids){try{process.kill(pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
}

function terminateProcessTree(rootPid,{force=false,knownPids=[]}={}){
  if(!Number.isInteger(rootPid)||rootPid<=0)return [];
  if(process.platform==='win32'){
    childProcess.spawnSync('taskkill',['/pid',String(rootPid),'/t','/f'],{stdio:'ignore',windowsHide:true,timeout:1500});
    return [rootPid];
  }
  const pids=[...new Set([...knownPids,...collectProcessTree(rootPid)])];
  signalKnownProcesses(pids,force?'SIGKILL':'SIGTERM');
  return pids;
}

function runBrowserTest({budgetMs,nodeTestArguments}){
  const command=[process.execPath,'--test',...nodeTestArguments];
  const childEnvironment={...process.env};delete childEnvironment.NODE_TEST_CONTEXT;
  const child=childProcess.spawn(process.execPath,['--test',...nodeTestArguments],{
    cwd:root,env:childEnvironment,stdio:'inherit',detached:process.platform!=='win32',windowsHide:true,
  });
  const startedAt=Date.now();let termination=null;let childOutcome=null;let forceTimer=null;
  process.stderr.write(`ZHSH_BROWSER_TEST_START:${JSON.stringify({budget_ms:budgetMs,command})}\n`);

  const finish=()=>{
    const elapsedMs=Date.now()-startedAt;
    const timedOut=termination?.reason==='budget';
    process.stderr.write(`ZHSH_BROWSER_TEST_END:${JSON.stringify({budget_ms:budgetMs,elapsed_ms:elapsedMs,exit_code:childOutcome?.code??null,signal:childOutcome?.signal??null,timed_out:timedOut,termination_reason:termination?.reason??null})}\n`);
    process.exitCode=termination?.exitCode??childOutcome?.code??(childOutcome?.signal?1:0);
  };

  const requestTermination=(reason,exitCode,signal='SIGTERM')=>{
    if(termination)return;
    termination={reason,exitCode,knownPids:collectProcessTree(child.pid)};
    const elapsedMs=Date.now()-startedAt;
    const marker=reason==='budget'?'ZHSH_BROWSER_TEST_BUDGET_EXCEEDED':'ZHSH_BROWSER_TEST_SIGNAL';
    process.stderr.write(`${marker}:${JSON.stringify({reason,signal,budget_ms:budgetMs,elapsed_ms:elapsedMs,child_pid:child.pid,tracked_pids:termination.knownPids,command})}\n`);
    termination.knownPids=terminateProcessTree(child.pid,{knownPids:termination.knownPids});
    forceTimer=setTimeout(()=>{
      termination.knownPids=terminateProcessTree(child.pid,{force:true,knownPids:termination.knownPids});
      finish();
      child.unref();
      setImmediate(()=>process.exit(termination.exitCode));
    },FORCE_KILL_GRACE_MS);
  };

  const budgetTimer=setTimeout(()=>requestTermination('budget',124),budgetMs);budgetTimer.unref();
  const onSigint=()=>requestTermination('SIGINT',130,'SIGINT');
  const onSigterm=()=>requestTermination('SIGTERM',143,'SIGTERM');
  process.once('SIGINT',onSigint);process.once('SIGTERM',onSigterm);

  child.once('error',(error)=>{
    clearTimeout(budgetTimer);if(forceTimer)clearTimeout(forceTimer);
    process.stderr.write(`Browser test process failed to start: ${error.stack??error.message}\n`);process.exitCode=1;
  });
  child.once('exit',(code,signal)=>{
    childOutcome={code,signal};clearTimeout(budgetTimer);
    process.removeListener('SIGINT',onSigint);process.removeListener('SIGTERM',onSigterm);
    if(!termination){if(forceTimer)clearTimeout(forceTimer);finish();}
  });
  return child;
}

function main(){runBrowserTest(parseArguments(process.argv.slice(2)));}
if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={DEFAULT_BUDGET_MS,collectProcessTree,parseArguments,runBrowserTest,terminateProcessTree};
