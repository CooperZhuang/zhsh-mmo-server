'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const contentPath=path.join(root,'web','generated','task1-content.json');
const directoryPath=path.join(root,'data','generated','unified-task-directory.json');
const baselinePath=path.join(root,'data','generated','accepted-stage-start-78-completed-tasks.json');
const outputPath=path.join(root,'data','generated','browser-acceptance-validation-matrix.json');
const longEvidencePath=path.join(root,'artifacts','browser-acceptance-stage','raw','series15-long-chain-dom-results.json');
const landEvidencePath=path.join(root,'artifacts','browser-acceptance-stage','raw','release-land-scenario-dom-results.json');
const representativeEvidence=[
  'artifacts/browser-acceptance-stage/raw/series15-long-chain-dom-results.json',
  'artifacts/browser-acceptance-stage/raw/release-land-scenario-dom-results.json',
  'artifacts/browser-acceptance-stage/raw/release-maritime-scenario-dom-results.json',
  'tests/reference-golden-rules.test.js','tests/global-runtime-content.test.js','tests/task-item-ledger.test.js','tests/npc-duel.test.js',
];
const coverageConditions=[
  '使用已经正式验证的公共执行器','数据字段结构与已验证样本一致','没有任务专属运行分支','没有缺失实体','没有资料冲突',
  '没有无法闭合的经济或战斗条件','前后置、奖励、消耗、存档与恢复均由现有公共系统覆盖',
];

function main(){
  const content=read(contentPath);const directory=read(directoryPath);const baseline=read(baselinePath);
  const contentById=new Map(content.tasks.map((entry)=>[entry.canonical_id,entry]));
  const baselineIds=new Set(baseline.completed_task_canonical_ids);
  const explicitExclusions=new Set(['task.series.15.706']);
  const conflicts=new Set(['task.series.15.269','task.series.15.601']);
  const eligible=directory.tasks.filter((entry)=>!baselineIds.has(entry.canonical_id)&&!explicitExclusions.has(entry.canonical_id)&&!conflicts.has(entry.canonical_id)
    &&entry.audit?.operational_fit===true&&(entry.blocking_reasons??[]).length===0&&entry.runtime_executors?.includes('TaskRuntimeEngine'));
  const promotedIds=eligible.map((entry)=>entry.canonical_id);
  const longEvidence=read(longEvidencePath).scenarios[0];const landEvidence=read(landEvidencePath).scenarios[0];
  const priorBrowserIds=new Set([...longEvidence.evidence_task_canonical_ids,...landEvidence.completed_evidence_task_canonical_ids]);
  const retainedPromotions=promotedIds.filter((id)=>priorBrowserIds.has(id));
  const newlyPromoted=promotedIds.filter((id)=>!priorBrowserIds.has(id));
  if(promotedIds.length!==570||newlyPromoted.length!==544||retainedPromotions.length!==26)throw new Error(`Unexpected convergence set: promoted=${promotedIds.length}, new=${newlyPromoted.length}, retained=${retainedPromotions.length}`);
  const buckets=new Map(groupDefinitions().map((entry)=>[entry.group_id,{...entry,included_task_canonical_ids:[]}]))
  for(const entry of eligible){const task=contentById.get(entry.canonical_id);if(!task)throw new Error(`Missing browser task ${entry.canonical_id}`);buckets.get(classify(task,entry)).included_task_canonical_ids.push(entry.canonical_id);}
  const groups=[...buckets.values()].filter((entry)=>entry.included_task_canonical_ids.length).map((entry)=>({
    ...entry,status:'validated_by_public_executor_consistency',public_executors:[...new Set(entry.included_task_canonical_ids.flatMap((id)=>directory.tasks.find((task)=>task.canonical_id===id).runtime_executors))],
    representative_evidence:representativeEvidence,coverage_conditions:coverageConditions,included_task_count:entry.included_task_canonical_ids.length,
    excluded_task_canonical_ids:['task.series.15.706','task.series.15.269','task.series.15.601'],
    exclusion_reasons:{'task.series.15.706':'正式目标一团黑气为176级/type6，而任务门槛为107级；有限正式装备与5个体力宝的一次浏览器尝试仍失败。公共公式与场景无异常，不做任务ID特判。','task.series.15.269':'data_conflict','task.series.15.601':'data_conflict'},
  }));
  const body={schema_version:2,record_kind:'release_candidate_public_executor_validation_matrix',generated_at:'2026-07-20T12:00:00.000Z',
    policy:{promotion_rule:'Promote tasks covered by already validated public executors when runtime fit, data shape, entities, prerequisites, rewards, consumption, economy, combat, save and restore all close without task-specific branches.',
      public_rule_consistency_is_primary:true,per_task_dom_recording_required:false,simulator_only_promotion:false,ambiguous_or_conflicting_data_promoted:false},
    source_evidence:representativeEvidence,coverage_conditions:coverageConditions,groups,
    baseline_validated_count:78,retained_prior_browser_promotion_count:retainedPromotions.length,newly_promoted_task_count:newlyPromoted.length,
    promoted_task_count:promotedIds.length,promoted_task_canonical_ids:promotedIds,
    excluded_task_canonical_ids:[...explicitExclusions],retained_data_conflict_task_canonical_ids:[...conflicts],
    resulting_status_counts:{validated:648,runnable_pending_validation:1,data_conflict:2}};
  body.matrix_sha256=sha(stable(body));fs.writeFileSync(outputPath,`${JSON.stringify(body,null,2)}\n`);
  process.stdout.write(`${JSON.stringify({output:rel(outputPath),promoted_task_count:body.promoted_task_count,newly_promoted_task_count:body.newly_promoted_task_count,
    resulting_status_counts:body.resulting_status_counts,excluded_task_canonical_ids:body.excluded_task_canonical_ids,matrix_sha256:body.matrix_sha256},null,2)}\n`);
}

function groupDefinitions(){return [
  {group_id:'dialogue_courier',display_name:'对话和跑腿'},
  {group_id:'purchase_delivery_money',display_name:'购买、交付与金钱消耗'},
  {group_id:'item_reward_submission',display_name:'物品奖励、提交与长链传递'},
  {group_id:'ordinary_combat_collection',display_name:'普通怪战斗、指定掉落与收集'},
  {group_id:'boss_elite_combat',display_name:'精英和Boss'},
  {group_id:'level_experience_training',display_name:'等级、经验和训练'},
  {group_id:'equipment_inventory',display_name:'装备和库存'},
  {group_id:'maritime_cross_city',display_name:'航海与跨城'},
  {group_id:'special_scene',display_name:'特殊场景'},
  {group_id:'continuous_chain',display_name:'连续任务链'},
  {group_id:'npc_duel',display_name:'NPC切磋'},
];}
function classify(task,directoryEntry){
  const targets=task.targets??[];const executors=directoryEntry.runtime_executors??[];
  if(executors.includes('NpcDuelRuntime')||targets.some((target)=>target.target_kind==='npc_duel'))return'npc_duel';
  if(task.series_canonical_id==='task.series.05')return'maritime_cross_city';
  if(executors.includes('CombatRuntime')||targets.some((target)=>target.target_kind==='monster'))return isBossTask(task)?'boss_elite_combat':'ordinary_combat_collection';
  if(executors.some((entry)=>/Item|Ledger/.test(entry))||targets.some((target)=>target.target_kind==='item'))return /购买|铜|金钱|运货/.test(`${task.task_type}|${task.description}`)?'purchase_delivery_money':'item_reward_submission';
  if(executors.some((entry)=>/Equipment|Inventory/.test(entry)))return'equipment_inventory';
  if(/训练|经验|等级/.test(`${task.display_name}|${task.description}`))return'level_experience_training';
  if(/副本|特殊|潜水|钓鱼/.test(`${task.task_type}|${task.description}`))return'special_scene';
  if(task.task_type==='对话'||targets.some((target)=>target.target_kind==='npc'))return'dialogue_courier';
  return'continuous_chain';
}
function isBossTask(task){const names=(task.targets??[]).map((target)=>target.raw_name).join('|');return /妖龙|大王乌贼|海怪|首领|Boss|王|皇|魔|黑气/.test(names)&&Number(task.targets?.[0]?.required_quantity??1)===1;}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}function rel(file){return path.relative(root,file).replaceAll('\\','/');}
function sha(value){return crypto.createHash('sha256').update(value).digest('hex');}
function stable(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;}
if(require.main===module)main();
