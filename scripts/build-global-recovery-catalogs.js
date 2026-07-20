'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const { DatabaseSync }=require('node:sqlite');
const {generationMetadata,git,referenceCommits,stageStartHead}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const referenceRoot=path.resolve(root,'..','zhsh-references');
const outputRoot=path.join(root,'data','generated');
const baseline=readJson(path.join(root,'docs','reconstruction-baseline','multisource-baseline.json'));
const matrix=readJson(path.join(root,'docs','development','task-playability-matrix.json'));
const selection=readJson(path.join(outputRoot,'runnable-task-selection.json'));
const stageStartSelection=JSON.parse(git(['show',`${stageStartHead}:data/generated/runnable-task-selection.json`]));
const progressionExtraction=readJson(path.join(outputRoot,'progression-source-extraction.json'));
const progressionRules=readJson(path.join(root,'data','runtime','progression-rules.json'));
const combatSurvivalAnalysis=readJson(path.join(outputRoot,'combat-survival-analysis.json'));
const db=new DatabaseSync(path.join(root,'data','zhsh-content.sqlite'),{readOnly:true});

const commits=referenceCommits();

function main(){
  fs.mkdirSync(outputRoot,{recursive:true});
  const globalContent=buildGlobalContentCatalog();
  const rules=buildReferenceRuleCatalog(globalContent);
  const reachability=buildFeatureReachability(rules.records);
  const conflicts=buildConflictRegister();
  const incomplete=buildIncompleteRegister(rules.records);
  const gaps=buildRuntimeGapMatrix(rules.records);
  const impact=buildExecutableUnlockImpactMap();
  const outputs={
    'global-content-catalog.json':globalContent,
    'reference-rule-catalog.json':rules,
    'feature-reachability-matrix.json':reachability,
    'source-conflict-register.json':conflicts,
    'original-incomplete-feature-register.json':incomplete,
    'current-runtime-gap-matrix.json':gaps,
    'task-unlock-impact-map.json':impact,
  };
  for(const [name,payload] of Object.entries(outputs))writeJson(path.join(outputRoot,name),payload);
  process.stdout.write(`${JSON.stringify({output_root:path.relative(root,outputRoot).replaceAll('\\','/'),files:Object.keys(outputs),
    content_counts:globalContent.counts,reachability_counts:reachability.counts,conflicts:conflicts.count,
    incomplete:incomplete.count,runtime_gaps:gaps.counts,impact_modules:impact.module_candidates.length},null,2)}\n`);
}

function buildGlobalContentCatalog(){
  const entities=baseline.configs.entities;
  const taskRows=db.prepare(`SELECT t.canonical_id,t.display_name,t.task_type,t.level_requirement,s.canonical_id series_canonical_id,
    t.sequence_position,t.source_canonical_id FROM task_definitions t JOIN task_series s ON s.id=t.task_series_id ORDER BY s.source_series,t.sequence_position`).all();
  const targets=group(db.prepare(`SELECT t.canonical_id task_canonical_id,tt.canonical_id,tt.target_kind,tt.raw_name,tt.normalized_quantity required_quantity,
    ce.canonical_id content_entity_canonical_id,m.canonical_id monster_canonical_id,n.canonical_id npc_canonical_id,l.canonical_id location_canonical_id
    FROM task_targets tt JOIN task_definitions t ON t.id=tt.task_id LEFT JOIN dependency_references r ON r.id=tt.dependency_reference_id
    LEFT JOIN content_entities ce ON ce.id=r.resolved_content_entity_id LEFT JOIN monster_definitions m ON m.id=r.resolved_monster_definition_id
    LEFT JOIN npc_definitions n ON n.id=r.resolved_npc_definition_id LEFT JOIN locations l ON l.id=r.resolved_location_id
    ORDER BY t.canonical_id,tt.canonical_id`).all(),'task_canonical_id');
  const rewards=group(db.prepare(`SELECT t.canonical_id task_canonical_id,tr.canonical_id,tr.reward_name,tr.normalized_quantity quantity,ce.canonical_id content_entity_canonical_id
    FROM task_rewards tr JOIN task_definitions t ON t.id=tr.task_id LEFT JOIN dependency_references r ON r.id=tr.dependency_reference_id
    LEFT JOIN content_entities ce ON ce.id=r.resolved_content_entity_id ORDER BY t.canonical_id,tr.canonical_id`).all(),'task_canonical_id');
  const tasks=taskRows.map((task)=>({...task,targets:targets.get(task.canonical_id)??[],rewards:rewards.get(task.canonical_id)??[],
    formal_status:selection.resources.task_canonical_ids.includes(task.canonical_id)?'formal_runtime':'blocked'}));
  const definitions={
    npcs:db.prepare(`SELECT n.canonical_id,n.display_name,n.source_canonical_id,r.normalized_value_json normalized_data_json
      FROM npc_definitions n JOIN restoration_records r ON r.id=n.source_record_id ORDER BY n.canonical_id`).all().map(parseNormalized),
    monsters:db.prepare(`SELECT m.canonical_id,m.display_name,m.level,m.monster_type,m.source_canonical_id,r.normalized_value_json normalized_data_json
      FROM monster_definitions m JOIN restoration_records r ON r.id=m.source_record_id ORDER BY m.canonical_id`).all().map(parseNormalized),
    cities:db.prepare(`SELECT c.canonical_id,c.display_name,c.source_canonical_id,r.normalized_value_json normalized_data_json
      FROM cities c JOIN restoration_records r ON r.id=c.source_record_id ORDER BY c.canonical_id`).all().map(parseNormalized),
    locations:db.prepare(`SELECT l.canonical_id,l.display_name,l.is_derived,l.source_canonical_id,c.canonical_id city_canonical_id,r.normalized_value_json normalized_data_json
      FROM locations l JOIN cities c ON c.id=l.city_id JOIN restoration_records r ON r.id=l.source_record_id ORDER BY l.canonical_id`).all().map(parseNormalized),
    items:db.prepare(`SELECT canonical_id,display_name,entity_category,source_canonical_id,normalized_data_json FROM content_entities ORDER BY canonical_id`).all().map(parseNormalized),
  };
  const acquisition={
    drops:db.prepare(`SELECT d.canonical_id,d.source_canonical_id,d.probability,d.quantity,m.canonical_id monster_canonical_id,
      ce.canonical_id content_entity_canonical_id FROM drop_relations d JOIN dependency_references sr ON sr.id=d.source_reference_id
      LEFT JOIN monster_definitions m ON m.id=sr.resolved_monster_definition_id JOIN dependency_references tr ON tr.id=d.target_reference_id
      LEFT JOIN content_entities ce ON ce.id=tr.resolved_content_entity_id ORDER BY d.canonical_id`).all(),
    shops:db.prepare(`SELECT se.canonical_id,se.source_canonical_id,se.price,sd.canonical_id shop_canonical_id,ce.canonical_id content_entity_canonical_id
      FROM shop_entries se JOIN shop_definitions sd ON sd.id=se.shop_definition_id JOIN dependency_references r ON r.id=se.content_reference_id
      LEFT JOIN content_entities ce ON ce.id=r.resolved_content_entity_id ORDER BY se.canonical_id`).all(),
    markets:db.prepare(`SELECT cp.canonical_id,cp.source_canonical_id,cp.raw_city_name,cp.raw_item_name,cp.minimum_price,cp.maximum_price,
      c.canonical_id city_canonical_id FROM city_price_ranges cp JOIN cities c ON c.id=cp.city_id ORDER BY cp.canonical_id`).all(),
    task_rewards:[...rewards.values()].flat(),
  };
  const configurationCollections=Object.fromEntries(Object.entries(entities).map(([name,records])=>[name,records.map((record)=>({
    canonical_id:record.canonical_id,display_name:record.display_name,source_canonical_id:record.source_canonical_id,
    normalized_data:record.normalized_data,sources:record.sources,
  }))]));
  const counts={tasks:tasks.length,npcs:definitions.npcs.length,cities:definitions.cities.length,locations:definitions.locations.length,
    monsters:definitions.monsters.length,content_entities:definitions.items.length,...baseline.configs.entity_statistics,
    acquisition_relations:Object.values(acquisition).reduce((sum,records)=>sum+records.length,0)};
  return envelope('global-content-catalog',{
    evidence_policy:'zhsh primary; astrbot corroboration only; dpcq auxiliary MOD evidence; zonghengsihai non-game static shell',
    counts,tasks,definitions,configuration_collections:configurationCollections,acquisition,
  });
}

function buildReferenceRuleCatalog(globalContent){
  const runtimeMap={
    'system.map.movement':['TaskRuntimeEngine.move','FormalGameplayCatalog'],
    'system.npc.interaction':['TaskRuntimeEngine.interactNpc'],
    'system.task.accept':['TaskRuntimeEngine.acceptTask'],'system.task.progress':['TaskRuntimeEngine.processEvent'],
    'system.task.complete':['TaskRuntimeEngine.submitTask'],'system.combat.entry':['CombatRuntime.start'],
    'system.combat.turns':['CombatRuntime.attack'],'system.combat.damage':['damage'],
    'system.combat.outcome':['CombatRuntime.attack'],'system.combat.flee':['CombatRuntime.retreat'],
    'system.combat.death':['CombatRuntime.attack'],'system.progression.level':['applyExperienceProgression'],
    'system.item.acquire-consume':['ItemRuntime','DropRuntime'],'system.inventory':['gameplay-state.inventory'],
    'system.equipment':['EquipmentRuntime'],'system.shop.trade':['EconomyRuntime'],'system.money':['EconomyRuntime'],
    'system.state.persistence':['RuntimeStorage','BrowserRuntimeStorage'],'system.sailing':['VoyageRuntime','MaritimeRuntime'],
  };
  const records=baseline.systems.map((record)=>{
    const executionSources=record.sources.filter((source)=>/\.(js|php|vue)$/.test(source.relative_path)||source.relative_path.includes('routes'));
    const classification=record.status==='CONFLICT'?'D':record.canonical_id==='system.map.unlock'?'B':
      record.status==='INCOMPLETE'?'C':record.canonical_id==='system.external-api'?'E':'A';
    return {
      canonical_id:`rule.${record.canonical_id.slice('system.'.length)}`,system_canonical_id:record.canonical_id,display_name:record.display_name,
      evidence_status:record.status,confidence:record.confidence,classification,
      source_repositories:[...new Set(record.sources.map((source)=>source.repository))],sources:record.sources,
      configuration_data:record.sources.filter((source)=>/\.(json|sql)$/.test(source.relative_path)).map(sourcePointer),
      execution_functions:executionSources.map(sourcePointer),inputs:inferIO(record.canonical_id).inputs,outputs:inferIO(record.canonical_id).outputs,
      random_rules:inferIO(record.canonical_id).random,state_changes:inferIO(record.canonical_id).state,
      page_entries:inferEntries(record.canonical_id),reachable:classification==='A'||classification==='D',
      current_runtime_modules:runtimeMap[record.canonical_id]??[],baseline:record.canonical_value,
    };
  });
  records.push(...extraRules());
  records.sort((a,b)=>a.canonical_id.localeCompare(b.canonical_id));
  return envelope('reference-rule-catalog',{
    counts:{records:records.length,by_repository:repositoryRuleCounts(records)},
    repository_extraction_summary:buildRepositoryExtractionSummary(globalContent,records),
    source_extraction_layer:{artifact:'data/generated/progression-source-extraction.json',method:progressionExtraction.extraction_method,
      record_count:progressionExtraction.records.length,records:progressionExtraction.records},
    canonical_rule_layer:{artifact:'data/runtime/progression-rules.json',rules:progressionRules.canonical_rules},
    adjudication_overlay:progressionRules.adjudication_overlay,
    records,
  });
}

function buildRepositoryExtractionSummary(globalContent,records){
  const astrbotRoot=path.join(referenceRoot,'zhsh-game_astrbot');
  const astrbotSources=readTextFiles(astrbotRoot,new Set(['.js','.ts','.vue']));
  const astrbotText=astrbotSources.map((entry)=>entry.text).join('\n');
  const routeHandlers=[...astrbotText.matchAll(/\b(?:router|app)\.(?:get|post|put|delete|patch)\s*\(/g)].length;
  const referencedTables=new Set([...astrbotText.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+[`\"]?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match)=>match[1].toLowerCase()));

  const dpcqSqlPath=path.join(referenceRoot,'dpcq','dpcq.sql');
  const dpcqSql=fs.existsSync(dpcqSqlPath)?fs.readFileSync(dpcqSqlPath,'utf8'):'';
  const sqlTables=[...dpcqSql.matchAll(/CREATE\s+TABLE\s+[`\"]?([^`\"\s(]+)/gi)].map((match)=>match[1]);
  const sqlRows=countSqlInsertRows(dpcqSql);

  const shellRoot=path.join(referenceRoot,'zonghengsihai');
  const shellSources=readTextFiles(shellRoot,new Set(['.html','.js']));
  const shellText=shellSources.map((entry)=>entry.text).join('\n');
  const externalRequests=[...shellText.matchAll(/\b(?:fetch|XMLHttpRequest|axios\.(?:get|post))\b/g)].length;
  const byRepository=repositoryRuleCounts(records);
  const primaryConfigRecords=Object.values(baseline.configs.entities).reduce((sum,values)=>sum+values.length,0);

  return {
    zhsh:{authority:'PRIMARY_ORIGINAL_IMPLEMENTATION',populated_data_records:globalContent.counts.tasks+primaryConfigRecords,
      task_records:globalContent.counts.tasks,configuration_records:primaryConfigRecords,canonical_rule_records:byRepository.zhsh,
      decision:'正式复原主证据'},
    astrbot:{authority:'IMPLEMENTATION_CORROBORATION_ONLY',populated_game_data_records:0,route_handlers:routeHandlers,
      referenced_database_tables:referencedTables.size,canonical_rule_records:byRepository.astrbot,
      decision:'用于交叉验证执行结构；空库模型不得替代 zhsh 原始数据'},
    dpcq:{authority:'MOD_AUXILIARY_ONLY',sql_tables:sqlTables.length,sql_insert_rows:sqlRows,
      canonical_rule_records:byRepository.dpcq,decision:'只作 MOD 辅助证据，不认定为原作规则'},
    zonghengsihai:{authority:'NON_GAME_STATIC_SHELL',game_data_records:0,game_rule_records:0,
      external_request_call_sites:externalRequests,canonical_rule_records:byRepository.zonghengsihai,
      decision:'静态外部信息页，不作为游戏数据或玩法规则来源'},
  };
}

function readTextFiles(directory,extensions){
  if(!fs.existsSync(directory))return [];
  const result=[];
  const stack=[directory];
  while(stack.length){
    const current=stack.pop();
    for(const entry of fs.readdirSync(current,{withFileTypes:true})){
      if(entry.name==='.git'||entry.name==='node_modules')continue;
      const absolute=path.join(current,entry.name);
      if(entry.isDirectory())stack.push(absolute);
      else if(extensions.has(path.extname(entry.name).toLowerCase()))result.push({file:absolute,text:fs.readFileSync(absolute,'utf8')});
    }
  }
  return result.sort((a,b)=>a.file.localeCompare(b.file));
}

function countSqlInsertRows(sql){
  let total=0;
  for(const match of sql.matchAll(/INSERT\s+INTO\s+[\s\S]*?\bVALUES\s*([\s\S]*?);/gi)){
    let quoted=false;
    let escaped=false;
    let depth=0;
    for(const character of match[1]){
      if(quoted){
        if(escaped)escaped=false;
        else if(character==='\\')escaped=true;
        else if(character==="'")quoted=false;
      }else if(character==="'")quoted=true;
      else if(character==='('){if(depth===0)total+=1;depth+=1;}
      else if(character===')'&&depth>0)depth-=1;
    }
  }
  return total;
}

function extraRules(){
  const zhsh=(relative_path,locator)=>({repository:'zhsh',relative_path,locator,commit:commits.zhsh});
  return [
    extra('rule.fishing.wait','钓鱼等待事件','A',[zhsh('src/fish.js','wait lines 198-282'),zhsh('config/fish.json','21 catches')],
      ['fishing state','wait count'],['waiting/bite/line_snapped/bait_eaten'],['uniform event candidate; independent trigger probability min(0.1+wait*0.05,0.5)'],['wait count and successFactor']),
    extra('rule.fishing.catch','钓鱼稀有度与鱼获','A',[zhsh('src/fish.js','calculateCatch lines 492-556'),zhsh('config/fish.json','21 catches')],
      ['route','bait','successFactor'],['filtered weighted fish'],['base 50/30/15/5; low factor +20/-10/-5/-2; high factor -10/+10/+5/+2'],['inventory on catch']),
    extra('rule.monster.stats','怪物类型与等级倍率','A',[zhsh('src/monster.js','_setMonsterStats lines 401-496')],
      ['level','monster type'],['health/attack/defense/agility'],[],['combat monster snapshot']),
    extra('rule.monster.drops','怪物物品与装备掉落','A',[zhsh('src/monster.js','drop construction and _getWeightedEquipment'),zhsh('config/monsterDrops.json','all mappings'),zhsh('config/monsterItems.json','all mappings')],
      ['monster','active task','inventory capacity'],['equipment/item drops'],['equipment gate 0.2; item default 0.4; active task item guaranteed'],['inventory']),
    extra('rule.equipment.acquisition','装备取得链','A',[zhsh('config/equipment.json','423 definitions'),zhsh('config/monsterDrops.json','equipment sources'),zhsh('src/monster.js','_getWeightedEquipment lines 663-738')],
      ['monster drop pool','required level'],['source-backed equipment candidate'],['weighted by required level'],['inventory then equipment slots']),
    extra('rule.market.prices','市场货物价格区间','A',[zhsh('config/marketItems.json','54 city-goods ranges'),zhsh('src/npc.js','market buy/sell methods')],
      ['city','item','quantity','cargo weight'],['price and inventory/money changes'],['configured price interval'],['money','inventory']),
    extra('rule.pet.lifecycle','宠物孵化与成长','B',[zhsh('config/pet.json','pet systems'),zhsh('src/petManager.js','hatch/feed/clean/grow/fight')],
      ['pet egg/items'],['pet state'],['growth/talent randomization'],['pet persistence']),
    extra('rule.diving.entry','潜水入口与副本发现','A',[zhsh('src/sailing.js','diving/getAvailableDungeons/getEncounter'),zhsh('config/shipFb.json','diving dungeons')],
      ['voyage','level','random'],['discovery/no discovery'],['configured encounter gate'],['maritime encounter/dungeon']),
    extra('rule.gang.lifecycle','帮会生命周期','B',[zhsh('src/gang.js','create/join/leave/storage/donate'),zhsh('src/database.js','gang tables and methods')],
      ['player','gang','items/currency'],['membership/storage changes'],[],['gang database records']),
    extra('rule.combat.stamina-item','体力宝临时体力与战斗自动恢复','A',[
      {...zhsh('config/shopItems.json','JSON Pointer /8'),file_sha256:null},
      {...zhsh('src/play.js','updateStaminaBonus/useStaminaItem'),file_sha256:'9481a9ac30bcb103fc46f5fb41a0e208cdd359bafc6c8b15e455a344472ce009'},
      {...zhsh('src/monster.js','assault after monster attack'),file_sha256:'f8aa145b153069953dc5b2a2ac69d94c47d37df78df6bf616a564839d24361bd'}],
      ['inventory quantity','base maximum health','current health after monster attack'],
      ['temporary maximum health +5000','automatic recovery up to 50000','one item consumed below 50% active maximum'],[],
      ['inventory','current health','effective maximum health']),
    {
      canonical_id:'rule.dpcq.auxiliary-combat',system_canonical_id:'auxiliary.dpcq.combat',display_name:'dpcq MOD 战斗辅助证据',
      evidence_status:'MOD_AUXILIARY_ONLY',confidence:'high',classification:'E',source_repositories:['dpcq'],
      sources:[{repository:'dpcq',relative_path:'app/Http/Controllers/IndexController.php',locator:'attack/calculateDamage/calculateAttacks',commit:commits.dpcq}],
      configuration_data:[{repository:'dpcq',relative_path:'dpcq.sql',locator:'dp_attack_target/dp_attribute/dp_drop'}],
      execution_functions:[{repository:'dpcq',relative_path:'app/Http/Controllers/IndexController.php',locator:'attack/calculateDamage'}],
      inputs:['MOD角色与目标属性'],outputs:['MOD战斗结果'],random_rules:['MOD伤害随机'],state_changes:['MOD角色/背包表'],page_entries:['POST /attack'],reachable:true,
      current_runtime_modules:[],baseline:{policy:'不得认定为《纵横四海》原作规则'},
    },
  ];
}

function extra(id,name,classification,sources,inputs,outputs,random,state){
  const runtimeModules={
    'rule.fishing.wait':['FishingRuntime.wait','chooseFishingWaitOutcome'],
    'rule.fishing.catch':['FishingRuntime.reel','fishingRarityWeights'],
    'rule.monster.stats':['monsterStats'],'rule.monster.drops':['DropRuntime'],
    'rule.equipment.acquisition':['EquipmentRuntime','deterministicSourceBackedCombatProof'],
    'rule.combat.stamina-item':['staminaItemSemantics','useActiveStaminaItem','CombatRuntime.attack','EconomyRuntime.buy'],
    'rule.market.prices':['EconomyRuntime'],'rule.diving.entry':['DivingRuntime'],
  }[id]??[];
  return {canonical_id:id,system_canonical_id:id.replace('rule.','system.'),display_name:name,evidence_status:'SINGLE_SOURCE',confidence:'high',classification,
    source_repositories:[...new Set(sources.map((source)=>source.repository))],sources,configuration_data:sources.filter((source)=>/\.json$/.test(source.relative_path)).map(sourcePointer),
    execution_functions:sources.filter((source)=>/\.(js|php)$/.test(source.relative_path)).map(sourcePointer),inputs,outputs,random_rules:random,state_changes:state,
    page_entries:classification==='B'?[]:['formal runtime API'],reachable:classification==='A',current_runtime_modules:runtimeModules,baseline:{policy:'源码明确；不扩写未出现规则'}};
}

function buildFeatureReachability(records){
  const categories={A:[],B:[],C:[],D:[],E:[]};
  for(const record of records)categories[record.classification].push({canonical_id:record.canonical_id,display_name:record.display_name,
    has_configuration:record.configuration_data.length>0,has_execution_code:record.execution_functions.length>0,
    has_reachable_entry:record.reachable,source_repositories:record.source_repositories,evidence_status:record.evidence_status});
  return envelope('feature-reachability-matrix',{definitions:{A:'有配置、有执行代码、有可达入口',B:'有执行代码但入口断裂或尚未接线',
    C:'只有任务对白或配置，没有执行实现',D:'多仓实现冲突',E:'复刻作者、MOD、外部提示页或后期扩写'},
    counts:Object.fromEntries(Object.entries(categories).map(([key,values])=>[key,values.length])),categories});
}

function buildConflictRegister(){
  const records=baseline.conflicts.map((record)=>({canonical_id:record.canonical_id,subject_canonical_id:record.canonical_value.subject_id,
    status:record.status,variants:record.canonical_value.variants??record.conflicts??[],tentative_decision:record.canonical_value.tentative_decision??null,
    decision_reason:record.decision_reason,sources:record.sources,policy:'不静默选择；正式运行时仅采用 restoration-resolution-overlay 中有证据的裁决'}));
  return envelope('source-conflict-register',{count:records.length,records});
}

function buildIncompleteRegister(rules){
  const backlog=baseline.implementation_backlog.map((record)=>({canonical_id:record.canonical_id,kind:'baseline_backlog',display_name:record.display_name??record.canonical_id,
    required_action:record.canonical_value.required_action,status:record.status,sources:record.sources,blocks_formal_content:true}));
  const featureRecords=rules.filter((rule)=>['B','C'].includes(rule.classification)).map((rule)=>({canonical_id:`incomplete.${rule.canonical_id}`,
    kind:rule.classification==='B'?'broken_entry':'configuration_without_complete_runtime',display_name:rule.display_name,
    required_action:'保持现有证据并继续阻塞依赖任务；不得自行补完整系统。',status:'INCOMPLETE',sources:rule.sources,blocks_formal_content:true}));
  const records=[...backlog,...featureRecords].sort((a,b)=>a.canonical_id.localeCompare(b.canonical_id));
  return envelope('original-incomplete-feature-register',{count:records.length,records});
}

function buildRuntimeGapMatrix(rules){
  const records=rules.map((rule)=>{
    let status='not_integrated';
    if(rule.current_runtime_modules.length)status=rule.evidence_status==='CONFLICT'?'compatible_implementation':'accurately_integrated';
    if(rule.classification==='C'||rule.classification==='E')status='must_not_self_complete';
    return {canonical_id:`gap.${rule.canonical_id}`,rule_canonical_id:rule.canonical_id,display_name:rule.display_name,status,
      current_runtime_modules:rule.current_runtime_modules,source_status:rule.evidence_status,required_action:gapAction(status)};
  });
  return envelope('current-runtime-gap-matrix',{counts:countBy(records,'status'),records});
}

function buildUnlockImpactMap(){
  const directCodes=new Set(['unresolved_dependency','item_without_formal_source','combat_loadout_not_closed','incomplete_task_definition',
    'monster_without_formal_encounter','voyage_port_or_coordinate_missing','item_source_combat_not_closed','level_balance_anomaly']);
  const byTask=new Map(selection.unselected_tasks.map((task)=>[task.canonical_id,task]));
  const direct={};
  for(const task of selection.unselected_tasks)for(const reason of task.blocking_reasons??[])if(directCodes.has(reason.code)){
    const values=direct[reason.code]??[];values.push(task.canonical_id);direct[reason.code]=values;
  }
  const descendants={};
  for(const task of selection.unselected_tasks)for(const reason of task.blocking_reasons??[])if(reason.code==='series_prefix_blocked'){
    const values=descendants[reason.blocked_by]??[];values.push(task.canonical_id);descendants[reason.blocked_by]=values;
  }
  const modules=[
    moduleImpact('module.equipment-acquisition-combat-proof','装备取得链与通用战斗负载证明',['combat_loadout_not_closed','item_source_combat_not_closed'],direct,descendants,'high','medium'),
    moduleImpact('module.task-item-source-resolution','任务物品正式来源解析',['item_without_formal_source','unresolved_dependency'],direct,descendants,'medium','medium'),
    moduleImpact('module.encounter-placement','怪物遭遇、NPC 状态放置与地点接线',['monster_without_formal_encounter','voyage_port_or_coordinate_missing'],direct,descendants,'high','low'),
    moduleImpact('module.level-progression-evidence','等级成长与可重复训练证据',['level_balance_anomaly'],direct,descendants,'provisional','high'),
    moduleImpact('module.original-incomplete','原始残缺字段与对白占位',['incomplete_task_definition'],direct,descendants,'incomplete','prohibited'),
  ].sort((a,b)=>b.estimated_affected_tasks-a.estimated_affected_tasks||a.canonical_id.localeCompare(b.canonical_id));
  const blockerCounts=Object.fromEntries(Object.entries(direct).map(([code,ids])=>[code,ids.length]));
  return envelope('task-unlock-impact-map',{remaining_task_count:selection.unselected_tasks.length,direct_blocker_counts:blockerCounts,
    module_candidates:modules,selected_first_batch_modules:modules.filter((entry)=>['module.equipment-acquisition-combat-proof','module.task-item-source-resolution'].includes(entry.canonical_id)).map((entry)=>entry.canonical_id),
    first_batch_outcome:{formal_tasks_before:61,formal_tasks_after:selection.resources.task_canonical_ids.length,
      task_item_source_resolution:'global acquisition catalog and source-kind resolution integrated; unresolved original definitions remain blocked',
      equipment_acquisition_combat_proof:'source-backed loadout and deterministic survival proof integrated; acquisition execution closure remains blocked',
      policy_result:'no task was admitted through hypothetical equipment, injected items, injected combat outcomes, task-ID allowlists, lowered levels, or skipped prerequisites'},
    policy:'只解除有源码执行证据的根阻塞；不使用任务 ID allowlist，不跳过前置，不降低等级，不注入物品或战斗结果。'});
}

function moduleImpact(id,name,codes,direct,descendants,confidence,risk){
  const directIds=[...new Set(codes.flatMap((code)=>direct[code]??[]))];
  const affected=[...new Set(directIds.flatMap((taskId)=>[taskId,...(descendants[taskId]??[])]))];
  const series=[...new Set(affected.map((taskId)=>bySeries(taskId)))].sort();
  return {canonical_id:id,display_name:name,root_blocker_codes:codes,direct_blocked_tasks:directIds.length,
    estimated_affected_tasks:affected.length,affected_series:series,source_confidence:confidence,implementation_regression_risk:risk,
    eligible:risk!=='prohibited'};
}

function buildExecutableUnlockImpactMap(){
  const roots=currentRootBlockers();
  const beforeIds=new Set(stageStartSelection.selected_tasks.map((entry)=>entry.canonical_id));
  const newlySelected=selection.selected_tasks.map((entry)=>entry.canonical_id).filter((id)=>!beforeIds.has(id));
  const beforeEndpoints=new Map(stageStartSelection.selected_series.map((entry)=>[entry.canonical_id,entry.terminal_task_canonical_id]));
  const endpointChanges=selection.selected_series.filter((entry)=>beforeEndpoints.get(entry.canonical_id)!==entry.terminal_task_canonical_id)
    .map((entry)=>({series_canonical_id:entry.canonical_id,before:beforeEndpoints.get(entry.canonical_id)??null,after:entry.terminal_task_canonical_id}));
  const module=(canonicalId,name,codes,confidence,risk,delta=0,unlocked=[],changes=[],residual=[],runtimeStatus='NOT_EXECUTED',hasActiveConflict=false)=>{
    const relevant=roots.filter((root)=>root.blocking_reasons.some((reason)=>codes.includes(reason.code)));
    return {canonical_id:canonicalId,display_name:name,evaluated_root_blocker_tasks:relevant.map((root)=>root.canonical_id),
      simulated_unlock_delta:{formal_tasks:delta,continuous_prefixes:changes.length,series_endpoint_changes:changes,newly_selected_task_ids:unlocked},
      residual_blockers:residual,prerequisite_reachable:relevant.map((root)=>({task_canonical_id:root.canonical_id,reachable:root.prerequisite_reachable})),
      confidence_partition:{source_confidence:confidence,runtime_adjudication_status:runtimeStatus,has_active_conflict:hasActiveConflict,
        affected_task_canonical_ids:unlocked.length?unlocked:relevant.map((entry)=>entry.canonical_id)},
      source_confidence:confidence,implementation_regression_risk:risk,
      priority_score:risk==='prohibited'?0:Math.round(delta*(confidence==='high'?1:confidence==='medium'?0.7:0.5)*(risk==='low'?1:risk==='medium'?0.75:0.5)*100)/100,
      simulation_method:'rerun deterministic selector after only this stage module implementation; compare with stage_start_head selection'};
  };
  const progressionResidual=roots.filter((entry)=>entry.blocking_reasons.some((reason)=>reason.code==='level_balance_anomaly'))
    .map((entry)=>({task_canonical_id:entry.canonical_id,reasons:entry.blocking_reasons.map((reason)=>reason.code)}));
  const modules=[
    module('module.combat-stamina-item','体力宝有限消耗与战斗生存闭包',['combat_loadout_not_closed','item_source_combat_not_closed','combat_consumable_budget_exhausted'],'high','medium'),
    module('module.level-progression-evidence','等级成长与可重复训练证据',['level_balance_anomaly'],'high','medium',newlySelected.length,newlySelected,endpointChanges,progressionResidual),
    module('module.equipment-acquisition-combat-proof','装备取得链与通用战斗负载证明',['combat_loadout_not_closed','item_source_combat_not_closed'],'high','medium'),
    module('module.task-item-source-resolution','任务物品正式来源解析',['item_without_formal_source','unresolved_dependency'],'medium','medium'),
    module('module.encounter-placement','怪物遭遇、NPC 状态放置与地点接线',['monster_without_formal_encounter','voyage_port_or_coordinate_missing'],'high','low'),
    module('module.original-incomplete','原始残缺字段与对白占位',['incomplete_task_definition'],'incomplete','prohibited'),
  ].sort((a,b)=>b.priority_score-a.priority_score||a.canonical_id.localeCompare(b.canonical_id));
  const equipmentResidual=roots.filter((entry)=>entry.blocking_reasons.some((reason)=>['combat_loadout_not_closed','item_source_combat_not_closed'].includes(reason.code)))
    .map((entry)=>({task_canonical_id:entry.canonical_id,reasons:entry.blocking_reasons.map((reason)=>reason.code)}));
  const equipmentUnlocks=newlySelected.filter((id)=>selection.selected_tasks.find((entry)=>entry.canonical_id===id)?.evidence?.equipment_acquisition_proofs?.length);
  const equipmentEndpointChanges=endpointChanges.filter((entry)=>equipmentUnlocks.some((id)=>id.startsWith(`${entry.series_canonical_id}.`)));
  const progressionModule=modules.find((entry)=>entry.canonical_id==='module.level-progression-evidence');
  progressionModule.simulated_unlock_delta={formal_tasks:0,continuous_prefixes:0,series_endpoint_changes:[],newly_selected_task_ids:[]};
  progressionModule.residual_blockers=progressionResidual;progressionModule.source_confidence='conflict';progressionModule.priority_score=0;
  progressionModule.confidence_partition={source_confidence:'conflict',runtime_adjudication_status:'COMPATIBILITY_PLAYABLE_RETAINED',
    has_active_conflict:true,affected_task_canonical_ids:progressionResidual.map((entry)=>entry.task_canonical_id)};
  const equipmentModule=modules.find((entry)=>entry.canonical_id==='module.equipment-acquisition-combat-proof');
  equipmentModule.simulated_unlock_delta={formal_tasks:equipmentUnlocks.length,continuous_prefixes:equipmentEndpointChanges.length,
    series_endpoint_changes:equipmentEndpointChanges,newly_selected_task_ids:equipmentUnlocks};
  equipmentModule.residual_blockers=equipmentResidual;equipmentModule.priority_score=Math.round(equipmentUnlocks.length*0.75*100)/100;
  equipmentModule.confidence_partition={source_confidence:'high',runtime_adjudication_status:'FORMAL_EXECUTION_PROVEN',has_active_conflict:true,
    affected_task_canonical_ids:[...equipmentUnlocks,...equipmentResidual.map((entry)=>entry.task_canonical_id)]};
  const combatModule=modules.find((entry)=>entry.canonical_id==='module.combat-stamina-item');
  const combatUnlocks=[...combatSurvivalAnalysis.chosen_allocation.newly_selected_task_ids];
  const combatEndpointChanges=endpointChanges.filter((entry)=>combatUnlocks.some((id)=>id.startsWith(`${entry.series_canonical_id}.`)));
  const chosenCandidate=combatSurvivalAnalysis.candidates.find((entry)=>entry.task_canonical_id===combatSurvivalAnalysis.chosen_allocation.task_canonical_id);
  const combatResidual=[...combatSurvivalAnalysis.candidates.filter((entry)=>entry.task_canonical_id!==combatSurvivalAnalysis.chosen_allocation.task_canonical_id)
    .map((entry)=>({task_canonical_id:entry.task_canonical_id,reasons:[entry.next_blocker?.code??'combat_survival_not_closed']})),
    {task_canonical_id:chosenCandidate.next_blocker.task_canonical_id,reasons:[chosenCandidate.next_blocker.code]}];
  combatModule.simulated_unlock_delta={formal_tasks:combatUnlocks.length,continuous_prefixes:combatEndpointChanges.length,
    series_endpoint_changes:combatEndpointChanges,newly_selected_task_ids:combatUnlocks};
  combatModule.residual_blockers=combatResidual;combatModule.priority_score=Math.round(combatUnlocks.length*0.75*100)/100;
  combatModule.confidence_partition={source_confidence:'high',runtime_adjudication_status:'SOURCE_EXACT_FINITE_ALLOCATION',has_active_conflict:false,
    affected_task_canonical_ids:[...combatUnlocks,...combatResidual.map((entry)=>entry.task_canonical_id)]};
  modules.sort((a,b)=>b.priority_score-a.priority_score||a.canonical_id.localeCompare(b.canonical_id));
  return envelope('task-unlock-impact-map',{stage_start_selected_task_count:stageStartSelection.selected_task_count,
    current_selected_task_count:selection.selected_task_count,remaining_task_count:selection.unselected_tasks.length,root_blocker_tasks:roots,
    module_candidates:modules,priority_formula:'actual continuous-prefix unlock delta × evidence strength × inverse implementation risk',
    policy:'Only executable evidence may remove a root blocker. Original-incomplete tasks and non-reachable descendants have zero direct unlock yield.'});
}

function currentRootBlockers(){
  const groups=group(selection.unselected_tasks,'series_canonical_id');
  return [...groups.values()].map((entries)=>entries.sort((a,b)=>a.sequence_position-b.sequence_position)[0]).map((entry)=>({
    canonical_id:entry.canonical_id,series_canonical_id:entry.series_canonical_id,sequence_position:entry.sequence_position,
    blocking_reasons:entry.blocking_reasons.filter((reason)=>reason.code!=='series_prefix_blocked'),prerequisite_reachable:true,
    confidence:entry.blocking_reasons.some((reason)=>reason.code==='incomplete_task_definition')?'incomplete':
      entry.blocking_reasons.some((reason)=>reason.code==='restoration_conflict_unresolved')?'conflict':'high'}));
}

function inferIO(id){
  const domain=id.split('.')[1];
  const values={
    character:{inputs:['registration/character data'],outputs:['player state'],random:[],state:['player profile']},
    map:{inputs:['current location','direction/target'],outputs:['next location'],random:[],state:['current location']},
    npc:{inputs:['player location','task state'],outputs:['NPC actions/dialogue'],random:[],state:['task/NPC interaction state']},
    task:{inputs:['task definition','player event/state'],outputs:['task status/rewards'],random:[],state:['task progress','inventory','rewards']},
    combat:{inputs:['player/monster stats','action'],outputs:['damage/outcome'],random:['damage/critical/drop rolls'],state:['health','combat','inventory','experience','money']},
    progression:{inputs:['experience','level table'],outputs:['level and stat gains'],random:[],state:['player attributes']},
    item:{inputs:['inventory action'],outputs:['item grant/consume result'],random:['drop selection'],state:['inventory']},
    inventory:{inputs:['item/quantity'],outputs:['capacity and contents'],random:[],state:['inventory']},
    equipment:{inputs:['equipment item/slot'],outputs:['effective stats'],random:[],state:['equipment slots']},
    shop:{inputs:['shop/item/quantity'],outputs:['purchase/sale result'],random:['market interval where configured'],state:['money','inventory']},
    money:{inputs:['currency delta'],outputs:['balance'],random:[],state:['money']},
    skills:{inputs:['skill/status config'],outputs:['incomplete'],random:[],state:['not fully implemented']},
    state:{inputs:['runtime state'],outputs:['persisted state'],random:[],state:['save record']},
    account:{inputs:['credentials'],outputs:['session/token'],random:[],state:['account']},
    multiplayer:{inputs:['message/channel'],outputs:['chat events'],random:[],state:['chat history']},
    'external-api':{inputs:['remote response'],outputs:['notice list'],random:[],state:['DOM only']},
    sailing:{inputs:['ship','route','position'],outputs:['distance/time/events'],random:['encounter/special event'],state:['voyage']},
  }[domain]??{inputs:[],outputs:[],random:[],state:[]};
  return values;
}

function inferEntries(id){
  if(id==='system.map.unlock'||id==='system.skills')return [];
  if(id==='system.external-api')return ['zonghengsihai/index.html'];
  return ['reference web/API entry'];
}

function repositoryRuleCounts(records){
  const counts={zhsh:0,astrbot:0,dpcq:0,zonghengsihai:0};
  for(const record of records)for(const repository of new Set(record.source_repositories))if(repository in counts)counts[repository]+=1;
  return counts;
}

function sourcePointer(source){return {repository:source.repository,relative_path:source.relative_path,locator:source.locator};}
function parseNormalized(row){const normalized_data=row.normalized_data_json?JSON.parse(row.normalized_data_json):{};delete row.normalized_data_json;return {...row,normalized_data};}
function group(rows,key){const result=new Map();for(const row of rows){const value=row[key];const list=result.get(value)??[];list.push(row);result.set(value,list);}return result;}
function countBy(records,key){const result={};for(const record of records)result[record[key]]=(result[record[key]]??0)+1;return result;}
function bySeries(taskId){return taskId.split('.').slice(0,3).join('.');}
function gapAction(status){return ({accurately_integrated:'保持并由黄金测试锁定',compatible_implementation:'保留独立复原裁决覆盖层并记录差异',
  source_deviation_pending_stage_fix:'本阶段按主要源码修正并增加黄金测试',not_integrated:'只有执行源码明确时才接入现有运行时',
  must_not_self_complete:'继续登记和阻塞，不自行设计'}[status]);}
function envelope(kind,body){return {schema_version:2,catalog_kind:kind,...generationMetadata('global-recovery-catalogs/2.0.0'),...body};}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function writeJson(file,value){fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`,'utf8');}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

try{main();}finally{db.close();}
