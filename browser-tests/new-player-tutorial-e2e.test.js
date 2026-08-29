'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {after,before,test}=require('node:test');
const {DomGameplayScenario}=require('./dom-gameplay-runner');
const {startStaticServer,stopStaticServer}=require('./edge-cdp');

const root=path.resolve(__dirname,'..');
const TUTORIAL_SERIES='task.series.01';
let server;

before(async()=>{server=await startStaticServer(root);});
after(async()=>{await stopStaticServer(server);});

/**
 * New-player tutorial regression run.
 *
 * Starts a *brand-new* save (no fixture), plays the 威尼斯新手成长 (Series 01) chain
 * entirely through visible browser actions, and asserts every tutorial task reaches
 * `completed` with a clean browser console/network. This is the reproducible
 * playthrough of the tutorial: it exercises the same NPS/quest/combat/shop/transport
 * UI a real new player uses, so any regression in the onboarding flow fails here.
 */
test('new-player tutorial: fresh save plays and completes the 威尼斯新手成长 chain',{timeout:20*60*1000},async()=>{
  const scenario=new DomGameplayScenario({root,url:server.url,scenario:'new-player-tutorial',combatRandomMode:'best-play',dropRandomValue:0.99});
  const started=Date.now();
  try{
    await scenario.openBrowser();
    await scenario.page.navigate(server.url);
    await scenario.page.waitFor(()=>document.querySelector('[data-action="new-game"]'),{label:'new game control'});
    await scenario.createNewSave();
    assert.equal(await scenario.page.pageName(),'location','a fresh new game must land on the game location view, not the admin console');

    const before=await scenario.exportSave('tutorial-before');
    assert.equal(before.state.player.level,1,'fresh tutorial player starts at level 1');
    assert.equal(before.state.player.money,0,'fresh tutorial player starts with no money');

    await scenario.completeSeriesOne();

    const after=await scenario.exportSave('tutorial-after');
    const tutorialTasks=scenario.content.tasks.filter((task)=>task.series_canonical_id===TUTORIAL_SERIES);
    for(const task of tutorialTasks){
      assert.equal(after.state.tasks[task.canonical_id]?.status,'completed',`tutorial task not completed: ${task.canonical_id}`);
    }
    assert.equal(after.state.combat,null,'tutorial must not leave an active combat');
    assert.equal(after.state.voyage,null,'tutorial must not leave an active voyage');
    assert.ok(after.state.player.level>=1,'tutorial progress must retain a player');
    assert.ok(after.state.player.money>0,'tutorial must award money (self-funding shop targets)');

    scenario.collectPageDiagnostics();
    assert.equal(scenario.consoleRecords.filter((entry)=>entry.level==='error').length,0,`browser console errors: ${JSON.stringify(scenario.consoleRecords)}`);
    assert.equal(scenario.consoleRecords.filter((entry)=>['warning','warn'].includes(entry.level)).length,0,`browser console warnings: ${JSON.stringify(scenario.consoleRecords)}`);
    assert.equal(scenario.networkRecords.length,0,`browser network errors: ${JSON.stringify(scenario.networkRecords)}`);

    const completedTutorial=tutorialTasks.filter((task)=>after.state.tasks[task.canonical_id]?.status==='completed').length;
    process.stdout.write(`ZHSH_TUTORIAL:${JSON.stringify({passed:true,duration_ms:Date.now()-started,tutorial_series:TUTORIAL_SERIES,tutorial_task_count:tutorialTasks.length,tutorial_completed:completedTutorial,total_completed:Object.values(after.state.tasks).filter((task)=>task.status==='completed').length,level:after.state.player.level,money:after.state.player.money,battle:scenario.battle,console_errors:scenario.consoleRecords.filter((entry)=>entry.level==='error').length})}\n`);
  }catch(error){
    process.stderr.write(`ZHSH_TUTORIAL_FAILURE:${JSON.stringify({message:error.message,stack:error.stack,stage:scenario.stage,console:scenario.consoleRecords,network:scenario.networkRecords,battle:scenario.battle})}\n`);
    throw error;
  }finally{
    if(scenario.page){await scenario.page.close().catch(()=>{});scenario.page=null;}
    const resolved=path.resolve(scenario.profileRoot),temporary=path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(`${temporary}${path.sep}`),`Refusing to remove non-temporary profile: ${resolved}`);
    await new Promise((resolve)=>setTimeout(resolve,500));try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
  }
});
