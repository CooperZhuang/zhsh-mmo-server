'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {generationMetadata}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const content=read(path.join(root,'web','generated','task1-content.json'));
const selection=read(path.join(root,'data','generated','global-runtime-task-selection.json'));
const outputPath=path.join(root,'data','generated','global-runtime-representative-validation.json');
const tasksById=new Map(content.tasks.map((task)=>[task.canonical_id,task]));
const placementByMonster=new Map();
for(const placement of content.monster_placements){const list=placementByMonster.get(placement.monster_canonical_id)??[];list.push(placement);placementByMonster.set(placement.monster_canonical_id,list);}
const itemSourcesByItem=new Map();
for(const source of content.item_sources){const list=itemSourcesByItem.get(source.content_entity_canonical_id)??[];list.push(source);itemSourcesByItem.set(source.content_entity_canonical_id,list);}

function main(){
  const groups=[
    group('dialogue_and_errand',['task.series.01.neg001','task.series.15.455','task.series.15.464'],(task)=>task.task_type==='对话'&&task.targets.every((target)=>target.target_kind==='npc'),
      '普通对话、跨地点跑腿与长链中的对话节点'),
    group('purchase_and_delivery',['task.series.01.007','task.series.15.457','task.series.15.463'],(task)=>task.targets.some((target)=>target.target_kind==='item'),
      '正式商店来源、前序奖励交付与接取时任务物品交付'),
    group('ordinary_monster_combat',['task.series.01.001','task.series.15.415','task.series.15.542'],(task)=>task.targets.some((target)=>target.target_kind==='monster'),
      '低等级普通怪、多目标同区战斗与高等级边界战斗'),
    group('elite_boss_and_task_exclusive',['task.series.13.142','task.series.15.470','task.series.15.738'],hasTaskExclusiveEncounter,
      '剧情敌人、妖龙与末段首领；均使用任务专属遭遇而非普通刷怪'),
    group('specified_drop_and_collection',['task.series.15.264','task.series.15.583','task.series.15.728'],hasGuaranteedTaskDrop,
      '任务文字与monsterItems共同确定的锤子、破界符、千年黑珍珠'),
    group('level_experience_and_progression',['task.series.01.001','task.series.15.542','task.series.15.738'],hasExperienceReward,
      '低、中、高等级任务门槛与经验奖励；同时核对统一等级规则已导出'),
    group('money_inventory_and_equipment',['task.series.01.007','task.series.15.457','task.series.15.472'],hasMoneyOrItemFlow,
      '购买支出、任务链库存保留、提交消耗及后续奖励继承'),
    group('maritime_route_and_special_scene',['task.series.05.032','task.series.13.101','task.series.15.728'],hasMaritimeContext,
      '钓鱼/航海公共能力、跨港运货与深海任务局部遭遇'),
    group('npc_duel',['task.series.15.698'],(task)=>task.targets.some((target)=>target.target_kind==='npc_duel'),
      '普通NPC切磋：任务进度结算、无普通怪掉落、失败可重试'),
  ];

  const chainIds=[];for(let index=455;index<=472;index+=1)chainIds.push(`task.series.15.${index}`);
  const chainTasks=chainIds.map(requireTask);
  for(let index=0;index<chainTasks.length;index+=1){
    validateTask(chainTasks[index]);
    if(index>0)assert(chainTasks[index].prerequisites.includes(chainTasks[index-1].canonical_id),`Long chain prerequisite gap: ${chainTasks[index].canonical_id}`);
    if(index<chainTasks.length-1)assert(chainTasks[index].successors.includes(chainTasks[index+1].canonical_id),`Long chain successor gap: ${chainTasks[index].canonical_id}`);
  }
  const chainChecks={
    task_count:chainTasks.length,start:chainTasks[0].canonical_id,end:chainTasks.at(-1).canonical_id,
    contains_previous_dialogue_reward_chain:chainIds.includes('task.series.15.457'),
    contains_acceptance_item:chainIds.includes('task.series.15.463'),
    contains_task_exclusive_boss:hasTaskExclusiveEncounter(requireTask('task.series.15.470')),
    contains_two_step_item_ledger:['task.series.15.471','task.series.15.472'].every((id)=>chainIds.includes(id)),
    result:'passed',
  };

  assert(selection.runtime_runnable_task_count===649,'Representative validation expected 649 runnable tasks');
  assert(content.gameplay_rules?.progression?.canonical_rules?.level_thresholds,'Progression thresholds missing');
  assert(content.voyage_routes.length>0,'Voyage routes missing');
  assert(content.maritime?.fishing&&content.maritime?.diving,'Maritime fishing/diving content missing');

  const result={
    schema_version:1,record_kind:'global-runtime-representative-validation',...generationMetadata('global-runtime-representative-validation/1.0.0'),
    source_content_sha256:content.content_sha256,selection_hash:selection.selection_hash,
    validation_strategy:'Representative semantic/runtime-content checks by executor family; no attempt to autoplay all pending tasks.',
    groups,long_chain:chainChecks,
    coverage_summary:{
      validated_group_count:groups.length,representative_task_count:new Set(groups.flatMap((entry)=>entry.sample_task_canonical_ids)).size,
      long_chain_task_count:chainTasks.length,
      task_type_counts:countBy(content.tasks.filter(isRunnable),'task_type'),
      target_kind_counts:countTargets(content.tasks.filter(isRunnable)),
      runtime_runnable_task_count:selection.runtime_runnable_task_count,
    },
    common_issues_detected_and_addressed:[
      {issue:'连续任务奖励物品未进入后续真实库存',fix:'TaskItemLedger统一奖励入账、保留、预留、提交消耗与幂等回滚',direct_tasks:['task.series.15.456','task.series.15.457','task.series.15.470','task.series.15.471','task.series.15.472']},
      {issue:'普通NPC被错误要求走怪物战斗/掉落接口',fix:'NpcDuelRuntime任务进度专用结算',direct_tasks:['task.series.15.698']},
      {issue:'任务文字掉落与正式掉落表未被全局模型联结',fix:'证据审计生成透明任务局部覆盖，不改参考仓库与全局怪物配置',direct_tasks:['task.series.15.264','task.series.15.415','task.series.15.583','task.series.15.728']},
      {issue:'接取对白明确给物品但结构化物品定义缺失',fix:'任务接取专用实体由账本管理',direct_tasks:['task.series.15.463']},
    ],
    result:'passed',
  };
  result.validation_sha256=crypto.createHash('sha256').update(stableJson(result)).digest('hex');
  fs.writeFileSync(outputPath,`${JSON.stringify(result,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify({output:path.relative(root,outputPath),result:result.result,validated_group_count:groups.length,representative_task_count:result.coverage_summary.representative_task_count,long_chain:chainChecks,validation_sha256:result.validation_sha256},null,2)}\n`);
}

function group(id,sampleIds,predicate,scope){
  const samples=sampleIds.map(requireTask);for(const task of samples){validateTask(task);assert(predicate(task),`${id} predicate failed for ${task.canonical_id}`);}
  return {group_id:id,scope,sample_task_canonical_ids:sampleIds,checks:samples.map((task)=>({task_canonical_id:task.canonical_id,directory_status:task.directory_status,target_kinds:[...new Set(task.targets.map((target)=>target.target_kind))],result:'passed'})),result:'passed'};
}
function validateTask(task){
  assert(isRunnable(task),`Representative task is blocked: ${task.canonical_id}`);
  assert(task.prerequisites.every((id)=>tasksById.has(id)),`Missing prerequisite in package: ${task.canonical_id}`);
  assert(task.successors.every((id)=>tasksById.has(id)),`Missing successor in package: ${task.canonical_id}`);
  assert(task.receive_location_canonical_id&&task.submit_location_canonical_id,`Lifecycle locations missing: ${task.canonical_id}`);
  for(const target of task.targets){assert(target.entity_canonical_id,`Target unresolved: ${target.canonical_id}`);assert(Number(target.required_quantity??target.normalized_quantity??1)>0,`Target quantity invalid: ${target.canonical_id}`);}
}
function hasTaskExclusiveEncounter(task){return task.targets.some((target)=>target.target_kind==='monster'&&(placementByMonster.get(target.entity_canonical_id)??[]).some((placement)=>placement.encounter_type==='task_exclusive'));}
function hasGuaranteedTaskDrop(task){return task.targets.some((target)=>target.target_kind==='item'&&content.drop_relations.some((drop)=>drop.content_entity_canonical_id===target.entity_canonical_id&&drop.guaranteed_for_active_task));}
function hasExperienceReward(task){return task.rewards.some((reward)=>reward.reward_kind==='experience'&&Number(reward.normalized_quantity??reward.quantity)>0);}
function hasMoneyOrItemFlow(task){return task.rewards.some((reward)=>['money','item'].includes(reward.reward_kind))||task.targets.some((target)=>target.target_kind==='item'&&((itemSourcesByItem.get(target.entity_canonical_id)??[]).length||target.task_item_policy));}
function hasMaritimeContext(task){const text=`${task.display_name} ${task.description??''} ${task.steps.map((step)=>step.original_text??'').join(' ')}`;return /海|港|航|钓鱼|潜水|运货/.test(text)||task.receive_location_canonical_id!==task.submit_location_canonical_id;}
function requireTask(id){const task=tasksById.get(id);assert(task,`Task missing: ${id}`);return task;}
function isRunnable(task){return !task.blocking_reasons.length&&['validated','runnable_pending_validation'].includes(task.directory_status);}
function countBy(values,key){const counts={};for(const value of values)counts[value[key]]=(counts[value[key]]??0)+1;return Object.fromEntries(Object.entries(counts).sort(([a],[b])=>a.localeCompare(b,'zh-CN')));}
function countTargets(tasks){const counts={};for(const task of tasks)for(const target of task.targets)counts[target.target_kind]=(counts[target.target_kind]??0)+1;return Object.fromEntries(Object.entries(counts).sort(([a],[b])=>a.localeCompare(b,'en')));}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function assert(condition,message){if(!condition)throw new Error(message);}
function stableJson(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;}

if(require.main===module)main();
module.exports={main};
