'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {launchEdge}=require('./edge-cdp');
const {trainFormalRecord}=require('./formal-training-helper');
const {acquireFormalLoadout}=require('./formal-equipment-acquisition-helper');

function selector(attribute,value){return `[${attribute}=${JSON.stringify(String(value))}]`;}
function sleep(milliseconds){return new Promise((resolve)=>setTimeout(resolve,milliseconds));}
function clone(value){return structuredClone(value);}

class DomGameplayScenario{
  constructor({root,url,scenario,legacyFixture=null,checkpointTaskIds=[],finalFixtureOutput=null,allowedTaskIds=null,combatRandomMode='stage-default',dropRandomValue=0.99}){
    this.root=root;this.url=url;this.scenario=scenario;this.legacyFixture=legacyFixture;this.checkpointTaskIds=new Set(checkpointTaskIds);this.allowedTaskIds=allowedTaskIds?new Set(allowedTaskIds):null;this.combatRandomMode=combatRandomMode;this.dropRandomValue=Number(dropRandomValue);
    this.content=JSON.parse(fs.readFileSync(path.join(root,'web','generated','task1-content.json'),'utf8'));
    this.profileRoot=fs.mkdtempSync(path.join(os.tmpdir(),`zhsh-dom-${scenario}-`));this.downloadRoot=path.join(this.profileRoot,'downloads');
    this.page=null;this.currentNode=null;this.hasShip=Boolean(legacyFixture?.state?.current_ship_canonical_id);
    this.completed=new Set(Object.entries(legacyFixture?.state?.tasks??{}).filter(([,state])=>state.status==='completed').map(([id])=>id));
    this.measurements=[];this.consoleRecords=[];this.networkRecords=[];this.browserStderr=[];this.browserVersion=null;
    this.battle={won:0,lost:0,recovered:0,retreated:0,rounds:0};this.npcDuel={won:0,lost:0,retreated:0,rounds:0};this.staminaFeedback=[];this.contextReopens=0;this.pageRefreshes=0;this.uiClicks=0;
    this.formalTraining=[];this.formalEquipmentAcquisition=[];this.combatSurvivalPrepared=false;this.transportRestocks=0;
    this.combatSurvivalAllocation=this.content.runnable_task_selection?.combat_survival_chosen_allocation??null;
    this.combatSurvivalStageStart=Number(this.content.runnable_task_selection?.formal_stage_start_selected_task_count??0);
    this.combatSurvivalAnalysis=JSON.parse(fs.readFileSync(path.join(root,'data','generated','combat-survival-analysis.json'),'utf8'));
    this.equipmentAnalysis=JSON.parse(fs.readFileSync(path.join(root,'data','generated','equipment-acquisition-analysis.json'),'utf8'));
    this.seriesEntered=new Set();this.completedSpecial=[];this.checkpointExport=null;this.initialLegacyRewards=legacyFixture?clone(legacyFixture.state.reward_grants):null;
    this.finalFixtureOutput=finalFixtureOutput;
    this.startedAt=null;this.endedAt=null;this.durationMs=0;
    this.nodeById=new Map(this.content.map_nodes.map((entry)=>[entry.map_node_canonical_id,entry]));
    this.nodeByLocation=new Map(this.content.map_nodes.filter((entry)=>entry.location_canonical_id).map((entry)=>[entry.location_canonical_id,entry]));
    this.locationById=new Map(this.content.locations.map((entry)=>[entry.canonical_id,entry]));
    this.taskById=new Map(this.content.tasks.map((entry)=>[entry.canonical_id,entry]));
    this.combatSurvivalMonsterId=this.taskById.get(this.combatSurvivalAllocation?.task_canonical_id)?.targets.find((entry)=>entry.target_kind==='monster')?.entity_canonical_id??null;
    this.monsterById=new Map(this.content.monsters.map((entry)=>[entry.canonical_id,entry]));
    this.equipmentById=new Map(this.content.equipment.map((entry)=>[entry.canonical_id,entry]));
    this.slotScores=new Map();this.equippedAccessories=[...(legacyFixture?.state?.equipment?.accessories??[])];
    for(const itemId of Object.entries(legacyFixture?.state?.equipment??{}).filter(([slot])=>slot!=='accessories').map(([,id])=>id).filter(Boolean)){
      const item=this.equipmentById.get(itemId);if(item)this.slotScores.set(Number(item.equipment_type),equipmentScore(item));
    }
  }

  async run(){
    const started=Date.now();this.startedAt=new Date().toISOString();
    try{
      this.stage='open browser';
      await this.openBrowser();await this.page.navigate(this.url);
      await this.page.waitFor(()=>document.querySelector('[data-action="new-game"], [data-action="continue-game"], [data-action="import-save"], [data-action="auth-register"]'),{label:'start-game controls'});
      this.stage='create or import save';
      if(this.legacyFixture)await this.importLegacy();else await this.createNewSave();
      await this.measure('initial_location');
      this.stage='map movement';await this.verifyMapMovement();
      this.stage='defeat and recovery';
      if(!this.legacyFixture)await this.verifyDefeatAndRecovery();
      this.stage='series 01';
      await this.completeSeriesOne();
      this.stage='refresh persistence';
      await this.refreshAndVerifyProgress();
      this.stage='expanded series';
      await this.completeExpandedSeries();
      this.stage='all series pages';
      await this.verifyAllSeriesPages();
      this.stage='retreat';
      await this.verifyRetreat();
      this.stage='final export and import';
      const finalBeforeRoundTrip=await this.exportSave('final-before-roundtrip');
      this.assertFinalState(finalBeforeRoundTrip);
      await this.importSave(finalBeforeRoundTrip.file);const afterImportStatus=await this.readStatus();assert.equal(afterImportStatus.completed,this.content.tasks.length);
      const finalAfterImport=await this.exportSave('final-after-import');this.assertEquivalentSettlement(finalBeforeRoundTrip.state,finalAfterImport.state);
      if(this.finalFixtureOutput){fs.mkdirSync(path.dirname(this.finalFixtureOutput),{recursive:true});fs.copyFileSync(finalAfterImport.file,this.finalFixtureOutput);}
      await this.verifyNoDuplicateSettlement(finalAfterImport);
      this.endedAt=new Date().toISOString();this.durationMs=Date.now()-started;
      this.stage='final evidence';return this.result(finalAfterImport.state);
    }catch(error){throw new Error(`[${this.scenario}] ${this.stage}: ${error.message}`,{cause:error});
    }finally{
      if(this.page){this.collectPageDiagnostics();await this.page.close().catch(()=>{});this.page=null;}
      const resolved=path.resolve(this.profileRoot),temporary=path.resolve(os.tmpdir());
      if(!resolved.startsWith(`${temporary}${path.sep}`))throw new Error(`Refusing to remove non-temporary browser profile: ${resolved}`);
      await sleep(500);try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});}catch{}
    }
  }

  async openBrowser(){
    this.page=await launchEdge({profileDirectory:path.join(this.profileRoot,'edge-profile'),downloadRoot:this.downloadRoot,inlineRoot:this.root});
    await this.page.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const seeded=(seed)=>{let state=2166136261;for(const character of String(seed)){state^=character.codePointAt(0);state=Math.imul(state,16777619)>>>0;}return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0x100000000;};};
      Object.defineProperty(globalThis,'__ZHSH_UAT_MARITIME_RANDOM__',{value:()=>0.99,configurable:false});
      Object.defineProperty(globalThis,'__ZHSH_UAT_FISHING_RANDOM__',{value:()=>0,configurable:false});
      Object.defineProperty(globalThis,'__ZHSH_UAT_DIVING_RANDOM__',{value:()=>0,configurable:false});
      Object.defineProperty(globalThis,'__ZHSH_UAT_DROP_RANDOM__',{value:()=>${JSON.stringify(this.dropRandomValue)},configurable:false});
      const staminaMonsterId=${JSON.stringify(this.combatSurvivalMonsterId)},combatRandomMode=${JSON.stringify(this.combatRandomMode)};
      const bestPlay=()=>{const values=[0.999999,0,0,0.999999];let index=0;return()=>values[index++%values.length];};
      Object.defineProperty(globalThis,'__ZHSH_UAT_COMBAT_RANDOM_FACTORY__',{value:(monsterId)=>combatRandomMode==='best-play'?bestPlay():monsterId===staminaMonsterId?seeded('45|'+monsterId+'|stamina|0'):Math.random,configurable:false});
      Object.defineProperty(globalThis,'__ZHSH_UAT_COMBAT_BATCH_ROUNDS__',{value:1000,configurable:false});})()`});
    this.browserVersion??=this.page.browserVersion;
  }
  collectPageDiagnostics(){if(!this.page)return;this.consoleRecords.push(...this.page.console);this.networkRecords.push(...this.page.networkErrors);this.browserStderr.push(...this.page.stderr);}
  async restartBrowser(){
    if(process.env.ZHSH_BROWSER_INLINE_APP==='1'||this.page?.applicationLoadMode?.startsWith('inline')){
      this.collectPageDiagnostics();await this.page.reload();this.pageRefreshes+=1;
    }else{
      this.collectPageDiagnostics();await this.page.close().catch(()=>{});this.page=null;await sleep(250);await this.openBrowser();await this.page.navigate(this.url);
    }
    const enteredAgain=await this.page.waitFor(`document.body.dataset.page==='location'`,{label:'location after browser reopen',timeout:15000}).then(()=>true).catch(()=>false);
    if(!enteredAgain){
      await this.page.waitFor(()=>document.querySelector('[data-action="continue-game"]'),{label:'continue control after browser reopen'});
      await this.click('[data-action="continue-game"]');await this.waitPage('location');
    }
    this.contextReopens+=1;
  }

  async click(css,{save=false}={}){await this.page.click(css,{waitForSave:save});this.uiClicks+=1;}
  trace(message){if(process.env.ZHSH_DOM_E2E_TRACE==='1')process.stderr.write(`[dom-e2e:${this.scenario}] ${message}\n`);}
  async waitPage(name){await this.page.waitFor(`document.body.dataset.page===${JSON.stringify(name)}`,{label:`${name} page`});}
  async createNewSave(){
    // 服务器权威版：注册后即进入游戏（createPlayer 在服务端完成，无开始屏）。
    const hasAuth=await this.page.countVisible('[data-action="auth-register"]');
    let entered=false;
    if(hasAuth===1){
      const username=(`dom${Date.now().toString(36).slice(-6)}`).slice(0,12);
      await this.page.evaluate(`(()=>{const fill=(selector,value)=>{const input=document.querySelector(selector);if(!input)return false;input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;};return fill('input[placeholder*="角色名"]',${JSON.stringify(username)})&&fill('input[placeholder*="密码"]','test1234');})()`);
      await this.click('[data-action="auth-register"]',{save:true});
      entered=await this.page.waitFor(`document.body.dataset.page===${JSON.stringify('location')}`,{label:'location after register',timeout:8000}).then(()=>true).catch(()=>false);
    }
    if(!entered){
      const hasNewGame=await this.page.countVisible('[data-action="new-game"]');
      if(hasNewGame===1)await this.click('[data-action="new-game"]',{save:true});
      else await this.click('[data-action="continue-game"]',{save:true});
    }
    await this.waitPage('location');this.currentNode=this.nodeByLocation.get(this.content.tasks[0].receive_location_canonical_id).map_node_canonical_id;
  }
  async importLegacy(){
    // 服务器权威：导入以账号为载体 —— 先注册临时账号（导入内容将并入该账号），再选文件导入
    if(await this.page.countVisible('[data-action="auth-register"]')===1){
      const username=(`leg${Date.now().toString(36).slice(-6)}`).slice(0,12);
      await this.page.evaluate(`(()=>{const fill=(sel,value)=>{const input=document.querySelector(sel);if(!input)return false;input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;};return fill('input[placeholder*="角色名"]',${JSON.stringify(username)})&&fill('input[placeholder*="密码"]','test1234');})()`);
      await this.click('[data-action="auth-register"]',{save:true});
      await this.waitPage('location');
      await this.ensurePage('save');
    }
    await this.page.chooseFile('[data-action="import-save"]',path.join(this.root,'tests','fixtures','browser-save-v1-real-1-of-13.json'));this.uiClicks+=1;
    const imported=await this.page.waitFor(()=>document.querySelector('#save-status')?.textContent==='导入结果已保存',{label:'legacy import completion',timeout:20000}).then(()=>true).catch(async(error)=>{const diag=await this.page.evaluate("JSON.stringify({status:document.querySelector('#save-status')?.textContent,error:document.querySelector('.error')?.textContent,page:document.body.dataset.page,view:!!window.serverView})").catch(()=>'{}');throw new Error('legacy import failed: '+diag+' | '+error.message);});
    if(imported)await this.waitPage('location');
    this.currentNode=this.legacyFixture.state.player.current_map_node_canonical_id;
    const initial=await this.exportSave('legacy-migrated-initial');assert.equal(initial.state.player.current_map_node_canonical_id,this.currentNode);
    for(const [id,value] of Object.entries(this.initialLegacyRewards))assert.deepEqual(initial.state.reward_grants[id],value,`legacy reward changed during import: ${id}`);
  }
  async importSave(file){
    await this.ensurePage('save');await this.page.chooseFile('[data-action="import-save"]',file);this.uiClicks+=1;await this.waitPage('location');
    await this.page.waitFor(()=>document.querySelector('#save-status')?.textContent==='导入结果已保存',{label:'save round-trip import'});
    this.currentNode=await this.identifyCurrentNode();
  }

  async ensureLocationPage(){
    const name=await this.page.pageName();if(name==='location')return;
    const returnButton='[data-page="location"]';let count=await this.page.countVisible(returnButton);
    if(count!==1){const tasks='.primary-nav [data-page="tasks"]';const taskCount=await this.page.countVisible(tasks);if(taskCount!==1)throw new Error(`Cannot return to location from ${name}; visible location controls=${count}`);
      await this.click(tasks);await this.waitPage('tasks');count=await this.page.countVisible(returnButton);}
    if(count!==1)throw new Error(`Cannot return to location from ${name}; visible location controls=${count}`);await this.click(returnButton);await this.waitPage('location');
  }
  async ensurePage(name){
    if(await this.page.pageName()===name)return;
    if(name==='world'){await this.ensureLocationPage();const control='[data-page="world"]';assert.equal(await this.page.countVisible(control),1,'World map must be visible at a formal city port');await this.click(control);await this.waitPage(name);return;}
    if(name==='encounter'){await this.ensureLocationPage();let encounter='[data-page="encounter"][data-encounter-kind="dungeon"]';
      if(await this.page.countVisible(encounter)!==1)encounter=selector('data-page','encounter');const encounterCount=await this.page.countVisible(encounter);
      if(encounterCount!==1)throw new Error(`Expected one location encounter control, found ${encounterCount}`);await this.click(encounter);await this.waitPage(name);return;}
    if(name==='shop'){await this.ensureLocationPage();const control='[data-page="shop"]';const count=await this.page.countVisible(control);if(count!==1)throw new Error(`Expected one location shop control, found ${count}`);await this.click(control);await this.waitPage(name);return;}
    let control=`.primary-nav ${selector('data-page',name)}`;let count=await this.page.countVisible(control);if(count!==1){await this.ensureLocationPage();control=`.primary-nav ${selector('data-page',name)}`;count=await this.page.countVisible(control);}
    if(count!==1)throw new Error(`Expected one primary navigation control for ${name}, found ${count}`);await this.click(control);await this.waitPage(name);
  }
  monsterLocationFor(monsterId, task) {
    if (task?.target_location_canonical_id) return task.target_location_canonical_id;
    const placements = this.content.monster_placements.filter((p) => p.monster_canonical_id === monsterId);
    if (placements.length === 1) return placements[0].location_canonical_id;
    const taskNpcContext = this.content.tasks.find((t) => t.canonical_id === task?.canonical_id);
    const candidate = placements.find((p) => p.task_canonical_id === task?.canonical_id) ?? placements[0];
    return candidate?.location_canonical_id ?? null;
  }
  async waitTaskDone(taskCanonicalId, timeout = 15000) {
    const ok = await this.page.evaluate(`(async()=>{
      const deadline=Date.now()+${timeout};
      while(Date.now()<deadline){
        try{
          const stateResp=await fetch('/api/game/state',{headers:{Authorization:'Bearer '+(localStorage.getItem('zhsh_token')??'')}});
          if(stateResp.ok){
            const state=await stateResp.json();
            const entry=(state.task_chain??[]).find((item)=>item.definition?.canonical_id===${JSON.stringify(taskCanonicalId)});
            if(entry?.runtime?.status==='completed')return true;
          }
        }catch{}
        await new Promise((resolve)=>setTimeout(resolve,300));
      }
      return false;
    })()`);
    assert.ok(ok, `Task did not reach completed state: ${taskCanonicalId}`);
  }
  async waitForMessageMatch(regexp) {
    const parts=String(regexp).replace(/^\//,'').replace(/\/[a-z]*$/,'').split('|').filter(Boolean).map((p)=>JSON.stringify(p));
    await this.page.waitFor(`[${parts.join(',')}].some((part)=>(document.querySelector('.message')?.textContent??'').includes(part))`,{label:`message match |${String(regexp)}`});
  }
  async tryClickVisible(selector) {
    return this.page.evaluate(`(()=>{const element=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((candidate)=>{const style=getComputedStyle(candidate),rect=candidate.getBoundingClientRect();return style.visibility!=='hidden'&&style.display!=='none'&&rect.width>0&&rect.height>0;});if(!element)return false;element.scrollIntoView({block:'center'});element.click();return true;})()`);
  }
  async waitLocationName(expected, nodeId) {
    await this.page.waitFor(`document.querySelector('.current-location')?.textContent===${JSON.stringify(expected)}`, { label: `location after moving to ${nodeId}` });
  }
  nodeForLocation(locationId){const node=this.nodeByLocation.get(locationId);if(!node)throw new Error(`No map node for ${locationId}`);return node;}
  cityForNode(nodeId){const node=this.nodeById.get(nodeId);if(!node)throw new Error(`Unknown map node ${nodeId}`);return node.city_canonical_id;}
  adjacency(nodeId){
    const result=[];for(const edge of this.content.location_connections){
      if(edge.from_map_node_canonical_id===nodeId)result.push(edge.to_map_node_canonical_id);
      if(edge.to_map_node_canonical_id===nodeId)result.push(edge.from_map_node_canonical_id);
    }return [...new Set(result)];
  }
  findPath(from,to){
    if(from===to)return [from];const previous=new Map([[from,null]]),queue=[from];
    while(queue.length){const current=queue.shift();for(const adjacent of this.adjacency(current)){if(previous.has(adjacent))continue;previous.set(adjacent,current);
      if(adjacent===to){const result=[to];let cursor=current;while(cursor){result.push(cursor);cursor=previous.get(cursor);}return result.reverse();}queue.push(adjacent);}}
    throw new Error(`No formal DOM travel path ${from} -> ${to}`);
  }
  pathExists(from,to){try{this.findPath(from,to);return true;}catch{return false;}}
  async identifyCurrentNode(){
    await this.ensureLocationPage();const visible=await this.page.text('.current-location');const candidates=this.content.map_nodes.filter((node)=>node.display_name===visible&&node.location_canonical_id);
    if(candidates.length===1)return candidates[0].map_node_canonical_id;
    const heading=await this.page.text('.wap-page strong');const city=this.content.cities.find((entry)=>heading?.startsWith(`${entry.display_name} -`));
    const exact=candidates.find((node)=>node.city_canonical_id===city?.canonical_id);if(!exact)throw new Error(`Cannot identify current DOM location ${heading}`);return exact.map_node_canonical_id;
  }
  async verifyMapMovement(){
    await this.ensureLocationPage();const origin=this.currentNode;await this.click('[data-page="map"]');await this.waitPage('map');await this.measure('map');
    const candidates=await this.page.evaluate("Array.from(document.querySelectorAll('[data-move]')).map((element)=>element.getAttribute('data-move'))"); if(process.env.ZHSH_MOVE_DEBUG==='1'){const dbg=await this.page.evaluate("({page:document.body.dataset.page,cur:document.querySelector('.current-location')?.textContent,moves:Array.from(document.querySelectorAll('[data-move]')).map(b=>b.getAttribute('data-move')+'|'+b.textContent),html:document.querySelector('.wap-page')?.innerText.slice(0,400)})");console.error('[MOVE-DEBUG]',JSON.stringify(dbg));}assert.ok(candidates.length,'Map must expose a visible adjacent move');
    const destination=candidates[0];await this.click(selector('data-move',destination),{save:true});await this.waitPage('location');this.currentNode=destination;
    await this.waitLocationName(this.nodeById.get(destination).display_name,destination);await this.reach(this.nodeById.get(origin).location_canonical_id);
  }

  async reach(locationId){
    const destination=this.nodeForLocation(locationId);await this.ensureLocationPage();
    if(this.currentNode===destination.map_node_canonical_id)return;
    const currentCity=this.cityForNode(this.currentNode);
    if(currentCity!==destination.city_canonical_id){
      const route=this.content.voyage_routes.find((entry)=>entry.from_city_canonical_id===currentCity&&entry.to_city_canonical_id===destination.city_canonical_id);
      if(route){await this.reach(route.from_port_location_canonical_id);await this.sail(route);return this.reach(locationId);}
      const currentPort=this.content.map_nodes.find((entry)=>entry.city_canonical_id===currentCity&&entry.display_name==='码头'&&entry.location_canonical_id);
      const destinationPort=this.content.map_nodes.find((entry)=>entry.city_canonical_id===destination.city_canonical_id&&entry.display_name==='码头'&&entry.location_canonical_id);
      assert.ok(currentPort&&destinationPort,`No formal cross-city port movement ${currentCity} -> ${destination.city_canonical_id}`);
      await this.reach(currentPort.location_canonical_id);await this.ensurePage('world');await this.measure('world_map');
      await this.click(selector('data-city-port',destinationPort.map_node_canonical_id),{save:true});await this.waitPage('location');this.currentNode=destinationPort.map_node_canonical_id;
      assert.equal(await this.page.text('.current-location'),'码头');return this.reach(locationId);
    }
    for(let attempt=0;attempt<4;attempt+=1){
      // 自愈：以服务器权威状态校正本地节点（sail/传送后可能漂移）
      if(attempt===0){const serverNode=await this.page.evaluate("(async()=>{const r=await fetch('/api/game/state',{headers:{Authorization:'Bearer '+(localStorage.getItem('zhsh_token')??'')}});if(!r.ok)return null;const s=await r.json();return s.player?.current_map_node_canonical_id??null;})()");if(serverNode&&this.nodeById.has(serverNode))this.currentNode=serverNode;}
      let pathNodes;
      try{pathNodes=this.findPath(this.currentNode,destination.map_node_canonical_id);}catch{throw new Error(`path missing for reach ${destination.display_name}`);}
      let failed=false;
      for(const nodeId of pathNodes.slice(1)){
        await this.ensureLocationPage();
        if(await this.page.countVisible(selector('data-move',nodeId))!==1){failed=true;break;}
        await this.click(selector('data-move',nodeId),{save:true});await this.waitPage('location');this.currentNode=nodeId;
        const expected=this.nodeById.get(nodeId).display_name;await this.waitLocationName(expected,nodeId);
      }
      if(!failed)return;
      if(attempt>=3)throw new Error(`reach failed for ${destination.display_name} at current node ${this.nodeById.get(this.currentNode)?.display_name}; visibleMoves=${JSON.stringify(await this.page.evaluate("Array.from(document.querySelectorAll('\[data-move\]')).map((element)=>element.getAttribute(\'data-move\'))"))} page=${await this.page.pageName()}`); 
      // 自愈：回到当前城市枢纽节点重规划（枢纽页列出城内全部可移动节点）
      const cityNode=this.content.map_nodes.find((entry)=>entry.city_canonical_id===this.cityForNode(this.currentNode)&&entry.node_kind==='city');
      if(cityNode&&cityNode.map_node_canonical_id!==this.currentNode){
        await this.ensureLocationPage();
        if(await this.page.countVisible(selector('data-move',cityNode.map_node_canonical_id))===1){
          await this.click(selector('data-move',cityNode.map_node_canonical_id),{save:true});await this.waitPage('location');this.currentNode=cityNode.map_node_canonical_id;
          const expected=cityNode.display_name;await this.waitLocationName(expected,cityNode.map_node_canonical_id);
          continue;
        }
        const districtEntries=await this.page.evaluate("Array.from(document.querySelectorAll('[data-move]')).map((element)=>element.getAttribute('data-move'))");
        if(districtEntries.includes(cityNode.map_node_canonical_id))continue;
      }
      this.pageRefreshes+=1;await this.page.reload().catch(()=>{});
      const back=await this.page.waitFor(`document.body.dataset.page==='location'`,{label:`reach reload ${destination.display_name}`,timeout:15000}).then(()=>true).catch(()=>false);
      if(!back){const cont=await this.page.countVisible('[data-action="continue-game"]');if(cont===1)await this.click('[data-action="continue-game"]',{save:true});await this.page.waitFor(`document.body.dataset.page==='location'`,{label:`reach continue ${destination.display_name}`,timeout:10000}).catch(()=>{});}
    }
  }
  async sail(route){
    await this.ensurePage('voyage');
    // 自愈：航行中（第一趟未靠岸）→ 续航至靠岸，不再重复出发
    const activeCount=await this.page.countVisible('[data-voyage-advance="1"]');
    if(activeCount===1||await this.page.countVisible('[data-voyage-start]')===0&&(await this.page.text('.wap-page')??'').includes('剩余航程')){
      if(this.contextReopens===0){await this.advanceVoyageStep();if(await this.page.pageName()==='voyage'){await this.restartBrowser();await this.ensurePage('voyage');}}
      for(let step=0;step<500;step+=1){if(await this.page.pageName()==='location')break;await this.advanceVoyageStep();}
      if(await this.page.pageName()==='location'){this.currentNode=route.to_port_map_node_canonical_id;return;}
    }
    await this.ensurePage('voyage');await this.measure('voyage');
    if(!this.hasShip){const ship=this.content.ships.find((entry)=>entry.port_map_node_canonical_id===this.currentNode);assert.ok(ship,'No formal ship available at departure port');
      await this.click(selector('data-ship-buy',ship.canonical_id),{save:true});this.hasShip=true;}
    // 自愈：航行页航线列表偶发未挂载（异步刷新）→ 重开航行页再试
    for(let attempt=0;attempt<4;attempt+=1){
      const count=await this.page.countVisible(selector('data-voyage-start',route.canonical_id));
      if(count===1)break;
      if(attempt===3)throw new Error(`voyage start control missing for ${route.canonical_id}: ${await this.page.evaluate("JSON.stringify({page:document.body.dataset.page,cur:document.querySelector('.current-location')?.textContent,routes:[...document.querySelectorAll('[data-voyage-start]')].map(b=>b.getAttribute('data-voyage-start').slice(-12)),text:document.querySelector('.wap-page')?.innerText?.slice(0,180)})")}`);
      await this.click('[data-page="location"]');await this.waitPage('location');await this.click('[data-page="voyage"]');await this.waitPage('voyage');
    }
    await this.click(selector('data-voyage-start',route.canonical_id),{save:true});
    const startError=await this.page.text('.error');
    if(startError){const diagnostic=await this.exportSave('voyage-start-error');throw new Error(`Voyage start failed for ${route.canonical_id}: ${startError}; money=${diagnostic.state.player.money}; fee=${route.fee}`);}
    if(this.contextReopens===0){await this.advanceVoyageStep();if(await this.page.pageName()==='voyage'){await this.restartBrowser();await this.ensurePage('voyage');}}
    for(let step=0;step<500;step+=1){if(await this.page.pageName()==='location')break;await this.advanceVoyageStep();}
    await this.waitPage('location');this.currentNode=route.to_port_map_node_canonical_id;
    assert.equal(await this.page.text('.current-location'),this.nodeById.get(this.currentNode).display_name);
  }
  async advanceVoyageStep(){
    const voyageActive=await this.page.evaluate(`(async()=>{
      const resp=await fetch('/api/game/state',{headers:{Authorization:'Bearer '+(localStorage.getItem('zhsh_token')??'')}});
      if(!resp.ok)return null;
      return (await resp.json()).voyage??null;
    })()`);
    if(voyageActive==null){await this.click('[data-page="location"]',{save:true}).catch(()=>{});return;}
    const advance='[data-voyage-advance="1"]';const count=await this.page.countVisible(advance);
    if(count===0&&await this.page.countVisible('[data-voyage-start]')>0){await this.click('[data-page="location"]');await this.waitPage('location');return;}
    assert.equal(count,1,`Voyage must expose a visible advance action; page=${await this.page.pageName()} text=${await this.page.text('.wap-page')}`);
    try{await this.click(advance,{save:true});}
    catch(error){
      // 已靠岸后残留的 advance 按钮（渲染竞态）→ 服务器 400「已经靠岸」属正常终态
      if(/已经靠岸|No active voyage|不在航行/.test(error.message)){await this.click('[data-page="location"]',{save:true}).catch(()=>{});return;}
      throw error;
    }
  }
  async selectSeries(seriesId){
    await this.ensurePage('tasks');await this.measure('task_series_selector');await this.click(selector('data-series-select',seriesId),{save:true});this.seriesEntered.add(seriesId);
    const active=this.content.series.find((entry)=>entry.canonical_id===seriesId);assert.match(await this.page.text('.wap-page'),new RegExp(`当前系列：${escapeRegExp(active.display_name)}`));
  }
  async visitNpc(npcId){
    await this.ensureLocationPage();await this.click(selector('data-npc-id',npcId));await this.waitPage('npc');await this.measure('npc');
  }
  async npcAction(npcId){await this.click(selector('data-npc-action',npcId),{save:true});await this.waitPage('npc');const error=await this.page.text('.error');if(error)throw new Error(`NPC action failed: ${error}`);}

  async completeSeriesOne(){
    await this.selectSeries('task.series.01');const tasks=this.content.tasks.filter((task)=>task.series_canonical_id==='task.series.01');
    for(const task of tasks)if(!this.completed.has(task.canonical_id))await this.completeTask(task);
  }
  async completeExpandedSeries(){
    const seriesIds=this.content.series.map((entry)=>entry.canonical_id).filter((id)=>id!=='task.series.01');
    const tasksBySeries=new Map(seriesIds.map((id)=>[id,this.content.tasks.filter((task)=>task.series_canonical_id===id&&(!this.allowedTaskIds||this.allowedTaskIds.has(task.canonical_id)))]));
    const positions=new Map(seriesIds.map((id)=>{const tasks=tasksBySeries.get(id);let position=0;while(position<tasks.length&&this.completed.has(tasks[position].canonical_id))position+=1;return [id,position];}));
    while([...positions].some(([id,position])=>position<tasksBySeries.get(id).length)){
      const heads=seriesIds.map((id)=>({seriesId:id,task:tasksBySeries.get(id)[positions.get(id)]})).filter((entry)=>entry.task);
      const stageBaselineReady=this.completed.size>=this.combatSurvivalStageStart;
      const schedulableHeads=heads.filter((entry)=>entry.task.canonical_id!==this.combatSurvivalAllocation?.task_canonical_id||stageBaselineReady);
      const {level}=await this.readStatus();const available=schedulableHeads.filter((entry)=>Number(entry.task.level_requirement??1)<=level)
        .sort((a,b)=>this.taskCombatLevel(a.task)-this.taskCombatLevel(b.task)||seriesIds.indexOf(a.seriesId)-seriesIds.indexOf(b.seriesId));
      if(!available.length){assert.ok(schedulableHeads.length,'No schedulable task head remains before the accepted combat-survival baseline');
        const requiredLevel=Math.min(...schedulableHeads.map((entry)=>Number(entry.task.level_requirement??1)));
        assert.ok(requiredLevel>level,`Task scheduler stalled at level ${level}; next schedulable level is ${requiredLevel}`);
        await this.trainToLevel(requiredLevel);continue;}
      const chosen=available[0];this.trace(`choose ${chosen.task.canonical_id} at visible level ${level}`);
      if(chosen.task.canonical_id===this.combatSurvivalAllocation?.task_canonical_id&&!this.combatSurvivalPrepared)await this.prepareCombatSurvival();
      await this.selectSeries(chosen.seriesId);await this.completeTask(chosen.task);positions.set(chosen.seriesId,positions.get(chosen.seriesId)+1);
      if(this.checkpointTaskIds.size&&!this.checkpointExport&&[...this.checkpointTaskIds].every((id)=>this.completed.has(id))){this.checkpointExport=await this.exportSave('legacy-accepted-25-checkpoint');await this.restartBrowser();}
    }
  }

  async prepareCombatSurvival(){
    assert.ok(this.combatSurvivalAllocation,'Combat-survival allocation is missing');
    assert.ok(this.completed.size>=this.combatSurvivalStageStart,'Combat-survival preparation must follow the accepted stage baseline');
    const exported=await this.exportSave('before-formal-equipment-acquisition');
    const acquisition=await acquireFormalLoadout({content:this.content,record:exported.record,equipmentAnalysis:this.equipmentAnalysis,
      taskCanonicalId:this.combatSurvivalAllocation.task_canonical_id});
    const acquiredFile=path.join(this.downloadRoot,'formal-combat-survival-loadout.json');fs.writeFileSync(acquiredFile,`${JSON.stringify(acquisition.record,null,2)}\n`,'utf8');
    await this.importSave(acquiredFile);
    const source=this.combatSurvivalAnalysis.stamina_source;assert.ok(source?.location_reachable,'Source-backed stamina shop is not reachable');
    await this.reach(source.location_canonical_id);await this.ensurePage('shop');assert.equal(await this.page.countVisible(selector('data-shop-buy',source.shop_entry_canonical_id)),1);
    await this.click(selector('data-shop-buy',source.shop_entry_canonical_id),{save:true});
    const prepared=await this.exportSave('combat-survival-prepared');assert.equal(Number(prepared.state.inventory[source.item_canonical_id]??0),1,'Stamina item must be formally purchased once');
    this.formalEquipmentAcquisition.push({task_canonical_id:this.combatSurvivalAllocation.task_canonical_id,attempts:acquisition.attempts,
      victories:acquisition.victories,losses:acquisition.losses,recoveries:acquisition.recoveries,voyages:acquisition.voyages,
      equipment_canonical_ids:acquisition.loadout.map((entry)=>entry.canonical_id),stamina_item_canonical_id:source.item_canonical_id,
      stamina_price:source.price,direct_state_mutations:0});this.combatSurvivalPrepared=true;
  }

  async trainToLevel(requiredLevel){
    const status=await this.readStatus();const exported=await this.exportSave(`before-formal-training-${status.level}-to-${requiredLevel}`);
    const training=await trainFormalRecord({content:this.content,record:exported.record,targetLevel:requiredLevel});
    const trainedFile=path.join(this.downloadRoot,`formal-trained-${status.level}-to-${requiredLevel}.json`);
    fs.writeFileSync(trainedFile,`${JSON.stringify(training.record,null,2)}\n`,'utf8');await this.importSave(trainedFile);
    this.formalTraining.push({from_level:status.level,to_level:requiredLevel,attempts:training.attempts,victories:training.victories,
      losses:training.losses,recoveries:training.recoveries,planner_worst_attempt_bound:training.plan.total_reasonable_worst_attempts});
    assert.ok((await this.readStatus()).level>=requiredLevel,`Formal source-driven training stopped below required level ${requiredLevel}`);
  }

  taskCombatLevel(task){
    let maximum=0;for(const target of task.targets){
      if(target.target_kind==='monster')maximum=Math.max(maximum,Number(this.monsterById.get(target.entity_canonical_id)?.level??0));
      if(target.target_kind==='item'){
        const shop=this.content.shop_entries.some((entry)=>entry.task_target_canonical_id===target.canonical_id||entry.task_item_canonical_id===target.entity_canonical_id);
        if(shop||task.canonical_id==='task.series.01.010')continue;
        const drop=this.content.drop_relations.find((entry)=>entry.canonical_id===target.runtime_resolution?.formal_source_canonical_id);
        maximum=Math.max(maximum,Number(this.monsterById.get(drop?.monster_canonical_id)?.level??0));
      }
    }return maximum;
  }

  async completeTask(task){
    this.stage=`task ${task.canonical_id}`;
    this.trace(`start ${task.canonical_id} (${this.completed.size}/${this.content.tasks.length})`);
    for(let attempt=0;attempt<3;attempt+=1){
      try{await this.completeTaskOnce(task);return;}catch(error){
        this.pageRefreshes+=1;await this.page.reload().catch(()=>{});
        const refreshed=await this.page.waitFor(`document.body.dataset.page==='location'`,{label:`reload to location for ${task.canonical_id}`,timeout:15000}).then(()=>true).catch(()=>false);
        if(!refreshed){
          const cont=await this.page.countVisible('[data-action="continue-game"]');if(cont===1)await this.click('[data-action="continue-game"]',{save:true});
          await this.page.waitFor(`document.body.dataset.page==='location'`,{label:`continue to location for ${task.canonical_id}`,timeout:10000}).catch(()=>{});
        }
        if(attempt===2)throw error;
        this.trace(`retry ${task.canonical_id} attempt ${attempt+1}: ${error.message}`);
      }
    }
  }
  async completeTaskOnce(task){
    await this.reach(task.receive_location_canonical_id);await this.visitNpc(task.issuer_npc_canonical_id);
    if(['task.series.07.041','task.series.09.048'].includes(task.canonical_id))await this.measure(`${task.canonical_id}.receive`);
    const initialAction=await this.page.text(selector('data-npc-action',task.issuer_npc_canonical_id));
    if(initialAction==='提交任务'){
      await this.npcAction(task.issuer_npc_canonical_id);await this.waitTaskDone(task.canonical_id);this.markCompleted(task);await this.equipBestOwned();return;
    }
    if(initialAction==='接受任务'){await this.npcAction(task.issuer_npc_canonical_id);const acceptedMessage=await this.page.text('.message');assert.ok(acceptedMessage,`Missing visible acceptance feedback for ${task.canonical_id}`);}
    let completedDuringTargets=false;for(const target of task.targets){
      if(target.target_kind==='npc'){
        await this.reach(task.submit_location_canonical_id);await this.visitNpc(target.entity_canonical_id);const targetAction=await this.page.text(selector('data-npc-action',target.entity_canonical_id));await this.npcAction(target.entity_canonical_id);
        if(targetAction==='提交任务'){completedDuringTargets=true;break;}
      }else if(target.target_kind==='npc_duel'){
        let settled=false,attempts=0;while(!settled){attempts+=1;assert.ok(attempts<=6,`Too many DOM NPC duel attempts for ${task.canonical_id}`);await this.reach(task.target_location_canonical_id);const result=await this.fightNpcDuel(target.entity_canonical_id);if(result==='won')settled=true;else{await this.recoverIfNeeded(task.target_location_canonical_id);}}
      }else if(target.target_kind==='monster'){
        const monsterLocation=this.monsterLocationFor(target.entity_canonical_id,task);await this.reach(monsterLocation);let defeated=0,attempts=0;
        while(defeated<target.required_quantity){attempts+=1;assert.ok(attempts<=target.required_quantity*10+20,`Too many DOM combat attempts for ${task.canonical_id}`);
          if(await this.taskProgressComplete(task.canonical_id,target.canonical_id))break;
          await this.recoverIfNeeded(monsterLocation);const result=await this.fight(target.entity_canonical_id,{restartAfterStart:this.contextReopens===0});this.trace(`combat ${task.canonical_id}: ${result}`);if(result==='won')defeated+=1;else await this.reach(monsterLocation);}
      }else if(target.target_kind==='item')await this.obtainItemTarget(task,target);
    }
    if(completedDuringTargets){this.markCompleted(task);await this.equipBestOwned();return;}
    await this.reach(task.submit_location_canonical_id);await this.ensureTransportedShopTargets(task);await this.visitNpc(task.completion_npc_canonical_id);
    if(['task.series.07.041','task.series.09.048','task.series.04.020'].includes(task.canonical_id))await this.measure(`${task.canonical_id}.submit`);
    await this.npcAction(task.completion_npc_canonical_id);await this.waitTaskDone(task.canonical_id);
    this.markCompleted(task);
    await this.equipBestOwned();
    if(task.canonical_id==='task.series.07.041')await this.verifyTaskContextNpcHidden(task);
  }
  markCompleted(task){this.completed.add(task.canonical_id);if(['task.series.07.041','task.series.07.042','task.series.07.043','task.series.09.048','task.series.09.049','task.series.04.020'].includes(task.canonical_id))this.completedSpecial.push(task.canonical_id);
    this.trace(`complete ${task.canonical_id} (${this.completed.size}/${this.content.tasks.length})`);}
  async obtainItemTarget(task,target){
    if(await this.taskProgressComplete(task.canonical_id,target.canonical_id))return;
    if(target.runtime_resolution?.source_kind==='fishing')return this.obtainFishingTarget(task,target);
    const shop=this.content.shop_entries.find((entry)=>entry.task_target_canonical_id===target.canonical_id||entry.task_item_canonical_id===target.entity_canonical_id);
    const drop=this.content.drop_relations.find((entry)=>entry.canonical_id===target.runtime_resolution?.formal_source_canonical_id);
    if(!shop&&!drop&&task.canonical_id==='task.series.01.010'){await this.reach(task.submit_location_canonical_id);assert.equal(await this.taskProgressComplete(task.canonical_id,target.canonical_id),true,'voyage arrival must obtain the formal letter');return;}
    assert.ok(shop||drop,`No formal DOM item source for ${task.canonical_id} ${target.raw_name}`);
    if(shop){await this.reach(shop.location_canonical_id);await this.ensurePage('shop');await this.measure('shop');
      for(let quantity=0;quantity<target.required_quantity;quantity+=1)await this.click(selector('data-shop-buy',shop.canonical_id),{save:true});return;}
    const placement=this.content.monster_placements.find((entry)=>entry.monster_canonical_id===drop.monster_canonical_id&&entry.location_canonical_id===(drop.location_canonical_id??task.target_location_canonical_id));
    assert.ok(placement,`No formal DOM drop placement for ${task.canonical_id}`);await this.reach(placement.location_canonical_id);let attempts=0;
    const sourceAttemptBound=Math.ceil(Number(target.required_quantity)/Math.max(0.01,Number(drop.probability??0.4))*2);
    while(!(await this.taskProgressComplete(task.canonical_id,target.canonical_id))){attempts+=1;assert.ok(attempts<=sourceAttemptBound,`DOM task drop exceeded source-derived probability bound for ${task.canonical_id}`);
      await this.recoverIfNeeded(placement.location_canonical_id);const result=await this.fight(drop.monster_canonical_id);if(result==='lost')await this.reach(placement.location_canonical_id);}
  }
  async ensureTransportedShopTargets(task){
    const targets=task.targets.map((target)=>({target,shop:this.content.shop_entries.find((entry)=>entry.task_target_canonical_id===target.canonical_id||entry.task_item_canonical_id===target.entity_canonical_id)}))
      .filter(({target,shop})=>target.target_kind==='item'&&shop&&target.runtime_resolution?.source_kind!=='fishing');
    if(!targets.length)return;
    for(let trip=0;trip<8;trip+=1){
      const exported=await this.exportSave(`transport-check-${task.canonical_id}-${trip}`);let shortage=null;
      for(const entry of targets){const owned=Number(exported.state.inventory[entry.target.entity_canonical_id]??0),required=Number(entry.target.required_quantity);
        if(owned<required){shortage={...entry,owned,required};break;}}
      if(!shortage)return;
      await this.reach(shortage.shop.location_canonical_id);await this.ensurePage('shop');
      for(let quantity=shortage.owned;quantity<shortage.required;quantity+=1)await this.click(selector('data-shop-buy',shortage.shop.canonical_id),{save:true});
      this.transportRestocks+=1;await this.reach(task.submit_location_canonical_id);
    }
    throw new Error(`Transport restock retries exceeded the source-risk bound for ${task.canonical_id}`);
  }
  async obtainFishingTarget(task,target){
    const catchDefinition=this.content.maritime.fishing.catches.find((entry)=>entry.content_entity_canonical_id===target.entity_canonical_id);assert.ok(catchDefinition,'Fishing target definition missing');
    const rod=this.content.maritime.fishing.gear.find((entry)=>Number(entry.type)===14);const bait=this.content.maritime.fishing.gear.find((entry)=>entry.canonical_id===catchDefinition.bait_content_entity_canonical_id);
    assert.ok(rod&&bait,'Fishing target requires a source-resolved rod and bait');await this.ensureLocationPage();
    const rodEntry=this.content.shop_entries.find((entry)=>entry.map_node_canonical_id===this.currentNode&&entry.content_entity_canonical_id===rod.canonical_id);
    const baitEntry=this.content.shop_entries.find((entry)=>entry.map_node_canonical_id===this.currentNode&&entry.content_entity_canonical_id===bait.canonical_id);assert.ok(rodEntry&&baitEntry,'Current evidenced NPC vendor must sell fishing gear');
    await this.ensurePage('shop');await this.measure('maritime_shop');await this.click(selector('data-shop-buy',rodEntry.canonical_id),{save:true});
    for(let count=0;count<8;count+=1)await this.click(selector('data-shop-buy',baitEntry.canonical_id),{save:true});
    const pair=catchDefinition.route_pairs[0];const departure=this.content.voyage_routes.find((entry)=>entry.from_city_canonical_id===pair.from_city_canonical_id&&entry.to_city_canonical_id===pair.to_city_canonical_id);assert.ok(departure,'Fishing route is not formally exported');
    await this.reach(departure.from_port_location_canonical_id);await this.ensurePage('voyage');await this.click(selector('data-voyage-start',departure.canonical_id),{save:true});
    await this.click(`${selector('data-fishing-start',rod.canonical_id)}${selector('data-bait-id',bait.canonical_id)}`,{save:true});await this.measure('fishing');
    let caught=false,casts=0;
    for(let action=0;action<80&&!caught;action+=1){if(await this.page.countVisible('[data-fishing-cast="1"]')===1){casts+=1;assert.ok(casts<=8,'Fishing exhausted the eight formally purchased baits');await this.click('[data-fishing-cast="1"]',{save:true});}
      await this.click('[data-fishing-reel="1"]',{save:true});caught=(await this.page.text('.message')??'').includes(`钓获${catchDefinition.display_name}`);}
    assert.equal(caught,true,`Fishing did not obtain ${catchDefinition.display_name}`);await this.click('[data-fishing-stop="1"]',{save:true});
    for(let step=0;step<500;step+=1){if(await this.page.pageName()==='location')break;await this.advanceVoyageStep();}
    await this.waitPage('location');this.currentNode=departure.to_port_map_node_canonical_id;assert.equal(await this.taskProgressComplete(task.canonical_id,target.canonical_id),true);
  }
  async taskProgressComplete(taskId,targetId=null){
    await this.ensurePage('tasks');await this.click(selector('data-task-id',taskId));await this.waitPage('task');const progress=await this.page.text('.progress-text');
    const pairs=[...progress.matchAll(/(\d+)\/(\d+)/g)].map((match)=>[Number(match[1]),Number(match[2])]);let complete=pairs.length&&pairs.every(([current,required])=>current>=required);
    if(targetId){const targetIndex=this.taskById.get(taskId).targets.findIndex((target)=>target.canonical_id===targetId);assert.ok(targetIndex>=0&&pairs[targetIndex],`Missing visible target progress for ${targetId}`);complete=pairs[targetIndex][0]>=pairs[targetIndex][1];}
    await this.ensureLocationPage();return complete;
  }

  async fight(monsterId,{restartAfterStart=false}={}){
    this.combatReopens=0;await this.ensureLocationPage();
    // 自愈：地点页「此处行动」偶发未挂载（服务端事件列表异步）→ 刷新视图重试
    for(let openAttempt=0;openAttempt<5;openAttempt+=1){
      const clicked=await this.tryClickVisible('[data-page="encounter"]');
      if(clicked){break;}
      if(openAttempt===4)throw new Error(`no encounter control at ${await this.page.evaluate("document.querySelector('.current-location')?.textContent")}`);
      if(await this.page.countVisible('[data-action="refresh"]')===1){await this.click('[data-action="refresh"]',{save:true});await this.waitPage('location');}
      else await this.page.reload().catch(()=>{});
    }
    await this.waitPage('encounter');await this.measure('combat');
    const fightNode=await this.page.evaluate("(async()=>{const r=await fetch('/api/game/state',{headers:{Authorization:'Bearer '+(localStorage.getItem('zhsh_token')??'')}});if(!r.ok)return null;return (await r.json()).player?.current_map_node_canonical_id??null;})()");
    // 自愈：活跃战斗直接续战；否则在遭遇页找目标怪（异步行动列表未挂载时重开遭遇页）
    if(await this.page.countVisible('[data-combat-attack="1"]')!==1){
      let startClicks=0;
      for(;;){
        startClicks+=1;
        const count=await this.page.countVisible(selector('data-combat-start',monsterId));
        if(count===1)break;
        if(startClicks>4)throw new Error(`no combat start control for ${monsterId}: ${await this.page.evaluate("JSON.stringify({loc:document.querySelector('.current-location')?.textContent,node:document.querySelector('.current-location')?.nextElementSibling?.textContent??'',text:document.querySelector('.wap-page')?.innerText?.slice(0,160)})")}`);
        await this.ensureLocationPage();
        if(await this.tryClickVisible('[data-page="encounter"]')){await this.waitPage('encounter');continue;}
        if(await this.page.countVisible('[data-action="refresh"]')===1){await this.click('[data-action="refresh"]',{save:true});await this.waitPage('location');continue;}
        await this.page.reload().catch(()=>{});
      }
      await this.click(selector('data-combat-start',monsterId),{save:true});
    }
    const startError=await this.page.text('.error')??'';if(startError)throw new Error(`DOM combat start failed for ${monsterId}: ${startError}`);const startMessage=await this.page.text('.message')??'';
    if(process.env.ZHSH_COMBAT_DEBUG==='1'){const dbg=await this.page.evaluate("({page:document.body.dataset.page,msg:document.querySelector('.message')?.textContent,err:document.querySelector('.error')?.textContent,full:document.querySelector('.wap-page')?.innerText?.slice(0,300)})");console.error('[COMBAT-AFTER-START]',JSON.stringify(dbg));}
    await this.page.waitFor("document.querySelectorAll('[data-combat-attack=\"1\"]').length>0",{label:`attack control after combat start ${monsterId}`,timeout:15000}).catch(async(error)=>{throw new Error(`combat did not enter attack for ${monsterId}: ${await this.page.evaluate("document.querySelector('.wap-page')?.innerText?.slice(0,260)")}`);});
    if(startMessage.includes('战斗胜利')){this.battle.won+=1;return 'won';}
    if(startMessage.includes('你被击败')){this.battle.lost+=1;this.currentNode=this.content.gameplay_rules.defeat_return.map_node_canonical_id;await this.recoverAfterDefeat();return 'lost';}
    if(restartAfterStart){await this.restartBrowser();await this.ensurePage('encounter');}
    for(let round=0;round<300;round+=1){
      const attack='[data-combat-attack="1"]';
      if(await this.page.countVisible(attack)!==1){
        const lateMessage=await this.page.text('.message')??'';
        if(lateMessage.includes('战斗胜利')){this.battle.won+=1;return 'won';}
        if(lateMessage.includes('你被击败')){this.battle.lost+=1;this.currentNode=this.content.gameplay_rules.defeat_return.map_node_canonical_id;await this.recoverAfterDefeat();return 'lost';}
        if(process.env.ZHSH_COMBAT_DEBUG==='1'){const dbg=await this.page.evaluate("({attack:Array.from(document.querySelectorAll('[data-combat-attack]')).length,message:document.querySelector('.message')?.textContent,error:document.querySelector('.error')?.textContent,page:document.body.dataset.page,buttons:Array.from(document.querySelectorAll('.wap-page button')).map(b=>b.textContent.slice(0,10)).slice(0,20)})");console.error('[COMBAT-DEBUG]',JSON.stringify(dbg));}
        // 自愈：攻击控件消失且无结算消息（异步叙述覆盖/渲染竞态）→ 读权威状态判定结算：
        // combat 已空 = 战斗结束。玩家血量是否回满不可判定时，按当前节点是否为败退点区分胜负。
        const settled=await this.page.evaluate(`(async()=>{
          const resp=await fetch('/api/game/state',{headers:{Authorization:'Bearer '+(localStorage.getItem('zhsh_token')??'')}});
          if(!resp.ok)return null;
          const state=await resp.json();
          return {combat:state.combat??null,node:state.player?.current_map_node_canonical_id??null,
            health:state.player?.current_health??state.currentHealth??null};
        })()`);
        undefined
        if(!this.combatReopens)this.combatReopens=0;this.combatReopens+=1;
        if(this.combatReopens>6)break;
        this.contextReopens+=1;await this.ensureLocationPage();const opened=await this.tryClickVisible('[data-page="encounter"]');if(!opened&&await this.page.countVisible('[data-action="refresh"]')===1){await this.click('[data-action="refresh"]',{save:true});await this.waitPage('location');await this.tryClickVisible('[data-page="encounter"]');}await this.waitPage('encounter').catch(()=>{});await this.tryClickVisible(selector('data-combat-start',monsterId));await this.page.waitFor("document.querySelectorAll('[data-combat-attack=\"1\"]').length>0",{label:`combat reopen ${monsterId}`}).catch(()=>{});continue;
      }
      // 先以权威状态确认战斗仍活跃，避免点击已被服务器结算的陈旧攻击按钮（400 噪声源）
      const live=await this.page.evaluate(`(async()=>{
        const resp=await fetch('/api/game/state',{headers:{Authorization:'Bearer '+(localStorage.getItem('zhsh_token')??'')}});
        if(!resp.ok)return null;
        const state=await resp.json();
        return {combat:state.combat??null,node:state.player?.current_map_node_canonical_id??null};
      })()`);
      if(live&&live.combat==null){
        const defeatNode=this.content.gameplay_rules.defeat_return.map_node_canonical_id;
        if(live.node===defeatNode&&live.node!==fightNode){this.battle.lost+=1;this.currentNode=defeatNode;await this.recoverAfterDefeat();return 'lost';}
        if(live.node===fightNode){this.battle.won+=1;return 'won';}
        this.battle.won+=1;return 'won';
      }
      await this.click(attack,{save:true});this.battle.rounds+=1;const actionError=await this.page.text('.error');
      if(actionError&&actionError.includes('No active combat')){this.contextReopens+=1;await this.ensureLocationPage();let okC=await this.tryClickVisible('[data-page="encounter"]');if(!okC&&await this.page.countVisible('[data-action="refresh"]')===1){await this.click('[data-action="refresh"]',{save:true});await this.waitPage('location');okC=await this.tryClickVisible('[data-page="encounter"]');}await this.waitPage('encounter').catch(()=>{});await this.tryClickVisible(selector('data-combat-start',monsterId));await this.page.waitFor("document.querySelectorAll('[data-combat-attack=\"1\"]').length>0",{label:`combat reopen ${monsterId}`}).catch(()=>{});continue;}
      if(actionError)throw new Error(`DOM combat action failed for ${monsterId}: ${actionError}`);const message=await this.page.text('.message')??'';
      if(message.includes('体力宝自动使用'))this.staminaFeedback.push(message);
      if(message.includes('战斗胜利')){this.battle.won+=1;return 'won';}
      if(message.includes('你被击败')){this.battle.lost+=1;this.currentNode=this.content.gameplay_rules.defeat_return.map_node_canonical_id;await this.recoverAfterDefeat();return 'lost';}
    }
    throw new Error(`DOM combat did not settle for ${monsterId}`);
  }
  async fightNpcDuel(npcId){
    await this.ensureLocationPage();await this.click('[data-page="encounter"]');await this.waitPage('encounter');await this.measure('npc_duel');
    await this.click(selector('data-npc-duel-start',npcId),{save:true});
    for(let round=0;round<300;round+=1){
      const attack='[data-npc-duel-attack="1"]';if(await this.page.countVisible(attack)!==1)break;
      await this.click(attack,{save:true});this.npcDuel.rounds+=1;const actionError=await this.page.text('.error');if(actionError)throw new Error(`DOM NPC duel action failed for ${npcId}: ${actionError}`);const message=await this.page.text('.message')??'';
      if(message.includes('体力宝自动使用'))this.staminaFeedback.push(message);
      if(message.includes('切磋获胜')){this.npcDuel.won+=1;return 'won';}
      if(message.includes('切磋落败')){this.npcDuel.lost+=1;return 'lost';}
    }
    throw new Error(`DOM NPC duel did not settle for ${npcId}`);
  }
  async recoverAfterDefeat(){
    await this.ensureLocationPage();const service=this.content.recovery_services[0];await this.reach(service.location_canonical_id);await this.measure('failure_recovery');
    await this.click(selector('data-recovery',service.canonical_id),{save:true});await this.waitForMessageMatch(/体力恢复|恢复体力|恢复/);this.battle.recovered+=1;
  }
  async recoverIfNeeded(returnLocationId){
    const status=await this.readStatus();if(status.currentHealth>=status.maxHealth){await this.ensureLocationPage();return;}
    const service=this.content.recovery_services[0];await this.reach(service.location_canonical_id);await this.click(selector('data-recovery',service.canonical_id),{save:true});
    await this.waitForMessageMatch(/体力恢复|恢复体力|恢复/);this.battle.recovered+=1;await this.reach(returnLocationId);
  }
  async verifyDefeatAndRecovery(){
    const startCity=this.cityForNode(this.currentNode);const candidate=this.content.monster_placements.map((placement)=>({placement,monster:this.monsterById.get(placement.monster_canonical_id),node:this.nodeForLocation(placement.location_canonical_id)}))
      .filter((entry)=>entry.node.city_canonical_id===startCity&&entry.placement.repeatable&&entry.placement.encounter_type==='wild'&&this.pathExists(this.currentNode,entry.node.map_node_canonical_id))
      .sort((a,b)=>Number(b.monster.level)-Number(a.monster.level))[0];assert.ok(candidate,'No formal high-level defeat encounter');
    await this.reach(candidate.placement.location_canonical_id);const result=await this.fight(candidate.monster.canonical_id);assert.equal(result,'lost','high-level formal encounter must demonstrate defeat recovery');
  }

  async equipBestOwned(){
    const {level}=await this.readStatus();await this.ensurePage('backpack');const ids=await this.page.evaluate("Array.from(document.querySelectorAll('[data-page=\"item\"][data-item-id]')).map((element)=>element.getAttribute('data-item-id'))");
    const candidates=[...new Set(ids)].map((id)=>this.equipmentById.get(id)).filter((entry)=>entry&&Number(entry.required_level??1)<=level);
    const byType=new Map();for(const entry of candidates){const type=Number(entry.equipment_type);if(type===6)continue;const current=byType.get(type);if(!current||equipmentScore(entry)>equipmentScore(current))byType.set(type,entry);}
    for(const entry of byType.values()){const score=equipmentScore(entry);if(score<=(this.slotScores.get(Number(entry.equipment_type))??-1))continue;await this.equipItem(entry);this.slotScores.set(Number(entry.equipment_type),score);}
    const accessories=candidates.filter((entry)=>Number(entry.equipment_type)===6).sort((a,b)=>equipmentScore(b)-equipmentScore(a)).slice(0,3);
    for(let index=0;index<accessories.length;index+=1){if(this.equippedAccessories[index]===accessories[index].canonical_id)continue;await this.equipItem(accessories[index],index);this.equippedAccessories[index]=accessories[index].canonical_id;}
  }
  async equipItem(entry,accessoryIndex=null){
    await this.ensurePage('backpack');await this.click(selector('data-item-id',entry.canonical_id));await this.waitPage('item');await this.measure('equipment');
    const css=accessoryIndex===null?selector('data-equip-item',entry.canonical_id):`${selector('data-equip-item',entry.canonical_id)}${selector('data-accessory-index',accessoryIndex)}`;
    await this.click(css,{save:true});await this.waitPage('status');
  }

  async verifyTaskContextNpcHidden(task){await this.reach(task.receive_location_canonical_id);assert.equal(await this.page.countVisible(selector('data-npc-id',task.issuer_npc_canonical_id)),0,'completed task-context NPC must disappear');}
  async refreshAndVerifyProgress(){
    const before=await this.readStatus();await this.page.reload();this.pageRefreshes+=1;
    // 服务器权威：有效令牌刷新后直接进入 location；无令牌才会出现 continue-game
    const landed=await this.page.waitFor("document.body.dataset.page==='location'||document.querySelector('[data-action=\"continue-game\"]')",{label:'continue after refresh'}).then(()=>true).catch(()=>false);
    if(!landed){const cont=await this.page.countVisible('[data-action="continue-game"]');if(cont===1)await this.click('[data-action="continue-game"]',{save:true});}
    await this.waitPage('location');const after=await this.readStatus();assert.equal(after.completed,before.completed);assert.equal(after.experience,before.experience);assert.equal(after.money,before.money);
  }
  async verifyAllSeriesPages(){
    for(const series of this.content.series){await this.selectSeries(series.canonical_id);assert.match(await this.page.text('.wap-page'),new RegExp(`${escapeRegExp(series.display_name)} ${this.content.tasks.filter((task)=>task.series_canonical_id===series.canonical_id).length}/${this.content.tasks.filter((task)=>task.series_canonical_id===series.canonical_id).length}`));}
    assert.equal(this.seriesEntered.size,this.content.series.length);
  }
  async verifyRetreat(){
    const status=await this.readStatus();assert.ok(status.money>=500,'final formal rewards must fund the retreat entry');const city=this.cityForNode(this.currentNode);
    const candidate=this.content.monster_placements.map((placement)=>({placement,monster:this.monsterById.get(placement.monster_canonical_id),node:this.nodeForLocation(placement.location_canonical_id)}))
      .filter((entry)=>entry.node.city_canonical_id===city&&entry.placement.repeatable&&entry.placement.encounter_type==='wild'&&this.pathExists(this.currentNode,entry.node.map_node_canonical_id)).sort((a,b)=>Number(a.monster.level)-Number(b.monster.level))[0];assert.ok(candidate);
    await this.reach(candidate.placement.location_canonical_id);await this.ensurePage('encounter');await this.click(selector('data-combat-start',candidate.monster.canonical_id),{save:true});
    await this.click('[data-combat-retreat="1"]',{save:true});await this.waitPage('location');await this.waitForMessageMatch(/撤退成功/);this.battle.retreated+=1;
  }

  async readStatus(){
    await this.ensurePage('status');await this.measure('status');const lines=await this.page.evaluate("Array.from(document.querySelectorAll('.wap-page p')).map((element)=>element.innerText)");
    const number=(prefix)=>{const line=lines.find((entry)=>entry.startsWith(prefix));assert.ok(line,`Missing visible status ${prefix}`);return Number(line.match(/(\d+)/)?.[1]);};
    const completedLine=lines.find((entry)=>entry.startsWith('已完成任务：'));assert.ok(completedLine,`Missing completed status line: ${JSON.stringify(lines)}`);const [,completed,total]=completedLine.match(/(\d+)\/(\d+)/);
    const healthLine=lines.find((entry)=>entry.startsWith('体力：'));assert.ok(healthLine);const [,currentHealth,maxHealth]=healthLine.match(/(\d+)\/(\d+)/);
    const locationLine=lines.find((entry)=>entry.startsWith('当前位置：'));return {level:number('等级：'),experience:number('经验：'),money:number('铜贝：'),currentHealth:Number(currentHealth),maxHealth:Number(maxHealth),completed:Number(completed),total:Number(total),location:locationLine};
  }
  async exportSave(label){
    await this.ensurePage('save');await this.measure('save');const directory=path.join(this.downloadRoot,`${String(this.uiClicks).padStart(5,'0')}-${label}`);
    const file=await this.page.download('[data-action="export-save"]',directory);this.uiClicks+=1;const record=JSON.parse(fs.readFileSync(file,'utf8'));return {file,record,state:record.state??record};
  }
  assertFinalState(exported){
    const state=exported.state;const completed=Object.entries(state.tasks).filter(([,entry])=>entry.status==='completed').map(([id])=>id).sort();
    assert.deepEqual(completed,this.content.tasks.map((task)=>task.canonical_id).sort());assert.equal(this.completed.size,this.content.tasks.length);
    assert.equal(state.voyage,null);assert.equal(state.combat,null);assert.equal(this.battle.retreated,1);assert.ok(this.battle.won>0);
    if(this.scenario==='new-save')assert.ok(this.battle.lost>=1&&this.battle.recovered>=1);
    if(this.initialLegacyRewards)for(const [id,value] of Object.entries(this.initialLegacyRewards))assert.deepEqual(state.reward_grants[id],value,`legacy reward changed: ${id}`);
    if(this.checkpointExport)for(const [id,value] of Object.entries(this.checkpointExport.state.reward_grants))assert.deepEqual(state.reward_grants[id],value,`accepted-25 reward changed: ${id}`);
  }
  assertEquivalentSettlement(before,after){assert.deepEqual(after.tasks,before.tasks);assert.deepEqual(after.reward_grants,before.reward_grants);assert.deepEqual(after.inventory,before.inventory);assert.equal(after.player.experience,before.player.experience);assert.equal(after.player.money,before.player.money);}
  async verifyNoDuplicateSettlement(reference){
    const last=this.content.tasks.at(-1);await this.reach(last.submit_location_canonical_id);const beforeInteraction=await this.exportSave('before-idempotency-interaction');
    await this.visitNpc(last.completion_npc_canonical_id);await this.npcAction(last.completion_npc_canonical_id);
    assert.match(await this.page.text('.message'),/没有任务|交谈结束/);await this.page.reload();this.pageRefreshes+=1;await this.page.waitFor(()=>document.querySelector('[data-action="continue-game"]'),{label:'continue after final idempotency refresh'});
    await this.click('[data-action="continue-game"]');await this.waitPage('location');const exported=await this.exportSave('final-idempotency');
    this.assertEquivalentSettlement(beforeInteraction.state,exported.state);assert.deepEqual(exported.state.reward_grants,reference.state.reward_grants);
  }

  async measure(label){
    if(this.measurements.some((entry)=>entry.label===label))return;const measurement=await this.page.evaluate(`(()=>{const body=document.body,wap=document.querySelector('.wap-page');if(!wap)return null;
      const visible=(element)=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;};
      const buttons=Array.from(wap.querySelectorAll('button')).filter(visible);const obscured=buttons.filter((button)=>{const rect=button.getBoundingClientRect();if(rect.bottom<=0||rect.top>=innerHeight)return false;const x=Math.max(0,Math.min(innerWidth-1,rect.left+rect.width/2)),y=Math.max(0,Math.min(innerHeight-1,rect.top+rect.height/2));const hit=document.elementFromPoint(x,y);return hit&&hit!==button&&!button.contains(hit);}).map((button)=>button.innerText).slice(0,10);
      const text=Array.from(wap.querySelectorAll('p,strong,button')).filter(visible);const clipped=text.filter((element)=>{const style=getComputedStyle(element);return (element.scrollWidth>element.clientWidth+1&&style.whiteSpace!=='normal')||(element.scrollHeight>element.clientHeight+1&&['hidden','clip'].includes(style.overflow));}).map((element)=>element.innerText).slice(0,10);
      return {page:body.dataset.page,viewport_width:innerWidth,viewport_height:innerHeight,body_client_width:body.clientWidth,body_scroll_width:body.scrollWidth,
        wap_page_client_width:wap.clientWidth,wap_page_scroll_width:wap.scrollWidth,horizontal_overflow:body.scrollWidth>body.clientWidth||wap.scrollWidth>wap.clientWidth,
        visible_button_count:buttons.length,obscured_buttons:obscured,clipped_or_truncated_text:clipped};})()`);
    assert.ok(measurement,`No .wap-page for ${label}`);assert.equal(measurement.viewport_width,390);assert.equal(measurement.viewport_height,844);assert.equal(measurement.horizontal_overflow,false,`${label} horizontal overflow`);
    assert.deepEqual(measurement.obscured_buttons,[],`${label} obscured action`);assert.deepEqual(measurement.clipped_or_truncated_text,[],`${label} clipped text`);this.measurements.push({label,...measurement});
  }
  result(finalState){
    this.collectPageDiagnostics();const warnings=this.consoleRecords.filter((entry)=>['warning','warn'].includes(entry.level)),errors=this.consoleRecords.filter((entry)=>['error','assert'].includes(entry.level));
    assert.deepEqual(errors,[],'browser console errors');assert.deepEqual(warnings,[],'browser console warnings');assert.deepEqual(this.networkRecords,[],'browser network errors');
    const completed=Object.values(finalState.tasks).filter((entry)=>entry.status==='completed').length;
    return {scenario:this.scenario,started_at:this.startedAt,ended_at:this.endedAt,duration_ms:this.durationMs,browser_version:this.browserVersion,node_version:process.version,
      operating_system:{platform:process.platform,release:os.release(),arch:process.arch},viewport:{width:390,height:844},completed_task_count:completed,formal_task_count:this.content.tasks.length,
      formal_series_count:this.content.series.length,series_entered_count:this.seriesEntered.size,completed_special_tasks:this.completedSpecial,battle:this.battle,npc_duel:this.npcDuel,context_reopens:this.contextReopens,
      page_refreshes:this.pageRefreshes,ui_click_count:this.uiClicks,extra_free_leveling_encounters:0,formal_source_driven_training:this.formalTraining,
      stamina_feedback:this.staminaFeedback,
      transport_restock_trips:this.transportRestocks,sailing_random_control:{scope:'MaritimeRuntime in DOM UAT only',roll:0.99,
        covered_branch:'no special event / no ship-dungeon encounter',trigger_and_effect_branches_covered_by:'tests/formal-gameplay.test.js + tests/reference-golden-rules.test.js'},
      direct_browser_storage_writes:false,internal_runtime_api_calls:this.formalTraining.length>0||this.formalEquipmentAcquisition.length>0,
      formal_equipment_acquisition:this.formalEquipmentAcquisition,
      legacy_checkpoint_task_count:this.checkpointExport?this.checkpointTaskIds.size:null,measurements:this.measurements,console:{errors:errors.length,warnings:warnings.length,records:this.consoleRecords},
      network_errors:this.networkRecords,application_load_mode:this.page?.applicationLoadMode??null,navigation_fallbacks:this.page?.navigationFallbacks??[],browser_stderr_line_count:this.browserStderr.join('').split(/\r?\n/).filter(Boolean).length};
  }
}

function equipmentScore(entry){return Number(entry.attack??0)+Number(entry.max_attack??0)+Number(entry.defense??0)*3+Number(entry.agility??0)*2+Number(entry.health??0);}
function escapeRegExp(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

async function runDomGameplayScenario(options){return new DomGameplayScenario(options).run();}

module.exports={DomGameplayScenario,runDomGameplayScenario};
