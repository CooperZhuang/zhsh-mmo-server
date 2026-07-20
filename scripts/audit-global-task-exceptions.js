'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {generationMetadata}=require('./generation-metadata');

const root=path.resolve(__dirname,'..');
const generated=path.join(root,'data','generated');
const outputPath=path.join(generated,'global-task-exception-evidence-review.json');

function main(){
  const graph=read(path.join(generated,'global-task-standard-graph.json'));
  const catalog=read(path.join(generated,'global-content-catalog.json'));
  const referenceState=read(path.join(generated,'reference-repository-readonly-state.json'));
  const tasksById=new Map(graph.tasks.map((task)=>[task.canonical_id,task]));
  const locations=catalog.configuration_collections.locations;
  const drops=catalog.configuration_collections.drops;
  const monsters=catalog.definitions.monsters;

  const task=(id)=>must(tasksById.get(id),`Task missing: ${id}`);
  const objective=(id,index=0)=>must(task(id).objectives[index],`Objective missing: ${id}#${index}`);
  const location=(city,name)=>must(locations.find((entry)=>entry.normalized_data.city===city&&entry.normalized_data.name===name),`Location missing: ${city}/${name}`);
  const drop=(monsterName,itemName)=>must(drops.find((entry)=>entry.normalized_data.monster===monsterName&&entry.normalized_data.dropped_name===itemName),`Drop missing: ${monsterName} -> ${itemName}`);
  const monster=(name,predicate=()=>true)=>must(monsters.find((entry)=>entry.display_name===name&&predicate(entry)),`Monster missing: ${name}`);
  const sourceRepos=(values)=>[...new Set(values.flatMap((entry)=>entry.sources??[]).map((source)=>source.repository))].sort();
  const runtimeItem=(name)=>`runtime.task_chain.item.${shortHash(name)}`;

  const hammerDrop=drop('沼泽鼠','锤子');
  const swampRat=monster('沼泽鼠');
  const swamp=location('威尼斯','沼泽');
  const bearDrop=drop('巨熊','熊皮');
  const giantBear=monster('巨熊');
  const mineZombie=monster('僵尸',(entry)=>entry.normalized_data.city==='威尼斯'&&entry.normalized_data.location==='矿洞'&&entry.level===113);
  const mountainTiger=monster('山地虎');
  const brokenTalismanDrop=drop('白骨骷髅','破碎的破界符');
  const whiteSkeleton=monster('白骨骷髅');
  const skeletonMountain=location('长安','骷髅山');
  const brushDrop=drop('邪恶花精','小良的毛笔');
  const pearlDrop=drop('黑蚌','千年黑珍珠');
  const blackClam=monster('黑蚌');
  const osakaDeepSea=location('大阪','深海');

  const reviews=[
    resolvedDropReview({
      task:task('task.series.15.264'),objective:objective('task.series.15.264'),itemName:'锤子',monsterName:'沼泽鼠',drop:hammerDrop,monster:swampRat,
      runtimeItemId:runtimeItem('锤子'),runtimeLocation:swamp,
      conclusion:'任务文字、monsterItems掉落表与同城唯一沼泽鼠定义相互吻合；任务字段“沼泽地”与正式怪物位置“沼泽”属于同城地点迁移/别名误挂。采用任务局部最小修正：目标改到威尼斯沼泽，不改全局地点或怪物。',
      rule:'task_drop_with_same_city_location_correction',taskScopedPlacement:false,
    }),
    holdReview({
      task:task('task.series.15.269'),kind:'data_conflict',
      evidence:[taskEvidence(task('task.series.15.269')),dropEvidence(bearDrop),monsterEvidence(giantBear)],
      conclusion:'“巨熊→熊皮”掉落关系存在，但唯一巨熊位于长安凤凰山（Lv111），任务要求威尼斯枯树林，且该处只有魅精。跨城市、跨等级段冲突无法由别名解释；保留data_conflict，不生成威尼斯巨熊。',
      unresolved:['monster_location_city_conflict','level_band_conflict'],
    }),
    resolvedMonsterReview({
      task:task('task.series.15.415'),objective:objective('task.series.15.415',0),monster:mineZombie,
      runtimeLocation:location('威尼斯','矿山'),
      conclusion:'原模型把“僵尸”误推导为物品，与明确的“消灭8只僵尸和8只山地虎”文字矛盾。三只同名僵尸中，威尼斯矿洞Lv113僵尸与矿山Lv113山地虎同城、同等级且同属北城门矿区，证据唯一最强。采用任务局部矿山遭遇，不改全局僵尸位置。',
      rule:'same_city_same_level_adjacent_mine_complex',taskScopedPlacement:true,
      corroborating:[monsterEvidence(mountainTiger)],
    }),
    resolvedChainReview({
      task:task('task.series.15.457'),objective:objective('task.series.15.457'),itemName:'黑珍珠',runtimeItemId:runtimeItem('黑珍珠'),
      sourceTask:task('task.series.15.456'),
      sourceDialogue:'大卫：谢谢你为我兄弟报仇，这枚黑珍珠就送给你了。',
      conclusion:'前一任务15.456提交对白明确把一枚黑珍珠交给玩家，15.457紧接着要求交付。结构化奖励字段漏记，但任务链文本闭合；由任务链物品账本补录奖励并在后续提交时消耗。',
      rule:'explicit_previous_submit_dialogue_reward',
    }),
    resolvedAcceptanceReview({
      task:task('task.series.15.463'),objective:objective('task.series.15.463'),itemName:'渔网',runtimeItemId:`runtime.task_acceptance.item.${shortHash('渔网')}`,
      sourceDialogue:'杂货商人：这渔网你拿去给码头的渔民吧，他们正需要。',
      conclusion:'接取对白明确由杂货商人把渔网交给玩家；缺失的是独立物品定义，不是来源证据。创建任务专用渔网实体，接取时入账、提交时消耗、放弃时回滚。',
      rule:'explicit_acceptance_dialogue_grant',
    }),
    resolvedDropReview({
      task:task('task.series.15.583'),objective:objective('task.series.15.583'),itemName:'破碎的破界符',monsterName:'白骨骷髅',drop:brokenTalismanDrop,monster:whiteSkeleton,
      runtimeItemId:runtimeItem('破碎的破界符'),runtimeLocation:skeletonMountain,
      conclusion:'任务写“望马坡北边的白骨骷”，正式怪物与掉落表唯一指向长安骷髅山的白骨骷髅。将“白骨骷”规范为“白骨骷髅”，目标地点落到骷髅山；这是任务局部实体/地点映射，不改源表。',
      rule:'task_text_alias_to_unique_monster_location',taskScopedPlacement:false,
    }),
    holdReview({
      task:task('task.series.15.601'),kind:'data_conflict',
      evidence:[taskEvidence(task('task.series.15.601')),dropEvidence(brushDrop)],
      conclusion:'monsterItems存在“邪恶花精→小良的毛笔”，但全局怪物定义与任何场景中都没有邪恶花精；杭州乌镇现有怪物是邪恶僵尸。缺少战斗属性与合法遭遇位置，不能仅凭掉落键凭空造怪，保留data_conflict。',
      unresolved:['monster_definition_missing','monster_placement_missing'],
    }),
    resolvedDropReview({
      task:task('task.series.15.728'),objective:objective('task.series.15.728'),itemName:'千年黑珍珠',monsterName:'黑蚌',drop:pearlDrop,monster:blackClam,
      runtimeItemId:runtimeItem('千年黑珍珠'),runtimeLocation:osakaDeepSea,
      conclusion:'结构化数量与接取对白均为5颗，说明中的“一颗干年黑珍珠”是单处错字/数量笔误；黑蚌定义和掉落关系唯一。按任务明确位置在大阪深海创建任务局部黑蚌遭遇，保留全局东城门配置不动。',
      rule:'majority_task_text_quantity_and_task_scoped_encounter',taskScopedPlacement:true,
      quantityAdjudication:{selected:5,rejected_text:'一颗干年黑珍珠',basis:['structured_target_quantity=5','receive_dialogue=5颗','submit_dialogue=收集齐了']},
    }),
  ];

  const statusCounts=countBy(reviews,'resulting_status');
  const result={
    schema_version:1,
    record_kind:'global-task-exception-evidence-review',
    ...generationMetadata('global-task-exception-audit/1.0.0'),
    reference_repositories:Object.entries(referenceState.reference_commits).map(([repository,commit])=>({repository,commit,read_only_verified:true})),
    evidence_policy:'Exact task text, adjacent task chain, formal entity definitions, monster placements and monsterItems drops are compared. Task-local overlays are allowed only when they preserve source data and avoid global mutation.',
    reviewed_task_count:reviews.length,
    resolved_task_count:reviews.filter((entry)=>entry.resulting_status==='runnable_pending_validation').length,
    remaining_hold_count:reviews.filter((entry)=>entry.resulting_status!=='runnable_pending_validation').length,
    status_counts:statusCounts,
    reviews,
  };
  result.audit_sha256=crypto.createHash('sha256').update(stableJson(result)).digest('hex');
  fs.writeFileSync(outputPath,`${JSON.stringify(result,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify({output:path.relative(root,outputPath),reviewed_task_count:result.reviewed_task_count,resolved_task_count:result.resolved_task_count,status_counts:result.status_counts,audit_sha256:result.audit_sha256},null,2)}\n`);
}

function resolvedDropReview({task,objective,itemName,monsterName,drop,monster,runtimeItemId,runtimeLocation,conclusion,rule,taskScopedPlacement,quantityAdjudication=null}){
  return {
    task_canonical_id:task.canonical_id,display_name:task.display_name,original_status:task.directory_status,
    resulting_status:'runnable_pending_validation',decision:'resolved_with_minimal_runtime_overlay',conclusion,
    evidence:[taskEvidence(task),dropEvidence(drop),monsterEvidence(monster),locationEvidence(runtimeLocation)],
    repositories_with_direct_evidence:[...new Set(['zhsh',...sourceRepositories(drop)])],
    unresolved_issues:[],
    runtime_resolutions:{
      item_targets:[{
        target_canonical_id:objective.canonical_id,runtime_entity_canonical_id:runtimeItemId,target_kind_override:'item',original_target_kind:objective.kind,
        resolution_rule:rule,target_location_canonical_id:runtimeLocation.canonical_id,
        task_item_policy:{acquisition_mode:'monster_drop',reservation:'required_until_submit',abandonment:'retain_obtained_item',consumption:'submit_only'},
        formal_source:{canonical_id:drop.canonical_id,source_canonical_id:drop.sources[0].relative_path,source_kind:'monster_drop',item_name:itemName,
          monster_name:monsterName,monster_canonical_id:monster.canonical_id,location_canonical_id:runtimeLocation.canonical_id,
          probability:drop.normalized_data.probability,quantity:drop.normalized_data.quantity,task_scoped_placement:Boolean(taskScopedPlacement),
          evidence_status:'SOURCE_EXPLICIT_AND_TASK_CONTEXT',evidence_locator:`${drop.sources[0].relative_path} ${drop.sources[0].locator}; ${task.source_evidence[0].path} ${task.source_evidence[0].locator}`},
      }],target_entities:[],reward_resolutions:[],task_location_override:runtimeLocation.canonical_id,
    },
    ...(quantityAdjudication?{quantity_adjudication:quantityAdjudication}:{}),
  };
}

function resolvedMonsterReview({task,objective,monster,runtimeLocation,conclusion,rule,taskScopedPlacement,corroborating=[]}){
  return {
    task_canonical_id:task.canonical_id,display_name:task.display_name,original_status:task.directory_status,
    resulting_status:'runnable_pending_validation',decision:'resolved_with_minimal_runtime_overlay',conclusion,
    evidence:[taskEvidence(task),monsterEvidence(monster),locationEvidence(runtimeLocation),...corroborating],repositories_with_direct_evidence:['zhsh'],unresolved_issues:[],
    runtime_resolutions:{item_targets:[],target_entities:[{
      target_canonical_id:objective.canonical_id,runtime_entity_canonical_id:monster.canonical_id,target_kind_override:'monster',original_target_kind:objective.kind,
      resolution_rule:rule,target_location_canonical_id:runtimeLocation.canonical_id,
      formal_source:{canonical_id:monster.source_canonical_id,source_canonical_id:monster.source_canonical_id,source_kind:'monster_identity',monster_name:monster.display_name,
        monster_canonical_id:monster.canonical_id,location_canonical_id:runtimeLocation.canonical_id,task_scoped_placement:Boolean(taskScopedPlacement),
        evidence_status:'SOURCE_DEFINITION_PLUS_TASK_CONTEXT',evidence_locator:`${task.source_evidence[0].path} ${task.source_evidence[0].locator}; config/monsters.json`},
    }],reward_resolutions:[],task_location_override:null},
  };
}

function resolvedChainReview({task,objective,itemName,runtimeItemId,sourceTask,sourceDialogue,conclusion,rule}){
  return {
    task_canonical_id:task.canonical_id,display_name:task.display_name,original_status:task.directory_status,
    resulting_status:'runnable_pending_validation',decision:'resolved_with_task_chain_ledger',conclusion,
    evidence:[taskEvidence(sourceTask),{kind:'submit_dialogue',task_canonical_id:sourceTask.canonical_id,text:sourceDialogue},taskEvidence(task)],repositories_with_direct_evidence:['zhsh'],unresolved_issues:[],
    runtime_resolutions:{item_targets:[{
      target_canonical_id:objective.canonical_id,runtime_entity_canonical_id:runtimeItemId,target_kind_override:'item',original_target_kind:objective.kind,resolution_rule:rule,
      task_item_policy:{acquisition_mode:'prerequisite_reward',reservation:'required_until_submit',source_task_canonical_id:sourceTask.canonical_id,abandonment:'retain_source_reward',consumption:'submit_only'},
      formal_source:{canonical_id:`runtime.task_chain.source.${shortHash(`${sourceTask.canonical_id}|${itemName}`)}`,source_canonical_id:sourceTask.canonical_id,source_kind:'task_chain_reward',item_name:itemName,
        source_task_canonical_id:sourceTask.canonical_id,evidence_status:'SOURCE_TEXT_AND_ADJACENT_CHAIN',evidence_locator:`${sourceTask.canonical_id} submit dialogue -> ${task.canonical_id}`},
    }],target_entities:[],reward_resolutions:[{source_task_canonical_id:sourceTask.canonical_id,reward_name:itemName,quantity:1,runtime_entity_canonical_id:runtimeItemId,resolution_rule:rule,source_target_canonical_id:objective.canonical_id}],task_location_override:null},
  };
}

function resolvedAcceptanceReview({task,objective,itemName,runtimeItemId,sourceDialogue,conclusion,rule}){
  return {
    task_canonical_id:task.canonical_id,display_name:task.display_name,original_status:task.directory_status,
    resulting_status:'runnable_pending_validation',decision:'resolved_with_acceptance_item_grant',conclusion,
    evidence:[taskEvidence(task),{kind:'receive_dialogue',task_canonical_id:task.canonical_id,text:sourceDialogue}],repositories_with_direct_evidence:['zhsh'],unresolved_issues:[],
    runtime_resolutions:{item_targets:[{
      target_canonical_id:objective.canonical_id,runtime_entity_canonical_id:runtimeItemId,target_kind_override:'item',original_target_kind:objective.kind,resolution_rule:rule,
      task_item_policy:{acquisition_mode:'grant_on_accept',reservation:'required_until_submit',abandonment:'rollback_acceptance_grant',consumption:'submit_only'},
      formal_source:{canonical_id:`runtime.task_acceptance.source.${shortHash(`${task.canonical_id}|${itemName}`)}`,source_canonical_id:task.canonical_id,source_kind:'task_acceptance_grant',item_name:itemName,
        source_task_canonical_id:task.canonical_id,evidence_status:'SOURCE_EXPLICIT_DIALOGUE',evidence_locator:`${task.canonical_id} receive dialogue`},
    }],target_entities:[],reward_resolutions:[],task_location_override:null},
  };
}

function holdReview({task,kind,evidence,conclusion,unresolved}){
  return {task_canonical_id:task.canonical_id,display_name:task.display_name,original_status:task.directory_status,resulting_status:kind,
    decision:'retain_evidence_hold',conclusion,evidence,repositories_with_direct_evidence:[...new Set(evidence.flatMap((entry)=>entry.repositories??['zhsh']))],unresolved_issues:unresolved,
    runtime_resolutions:{item_targets:[],target_entities:[],reward_resolutions:[],task_location_override:null}};
}

function taskEvidence(task){return {kind:'task_source',task_canonical_id:task.canonical_id,repository:task.source_evidence[0]?.repository,path:task.source_evidence[0]?.path,locator:task.source_evidence[0]?.locator,
  objective_text:task.steps.find((step)=>step.step_kind==='objective')?.original_text??null,receive_dialogue:task.dialogues.filter((line)=>line.phase==='receive').map((line)=>line.original_text),repositories:task.source_repositories};}
function dropEvidence(entry){return {kind:'monster_drop',canonical_id:entry.canonical_id,monster:entry.normalized_data.monster,item:entry.normalized_data.dropped_name,sources:entry.sources,repositories:sourceRepositories(entry)};}
function monsterEvidence(entry){return {kind:'monster_definition',canonical_id:entry.canonical_id,source_canonical_id:entry.source_canonical_id,name:entry.display_name,level:entry.level,city:entry.normalized_data.city,location:entry.normalized_data.location,repositories:['zhsh']};}
function locationEvidence(entry){return {kind:'location_definition',canonical_id:entry.canonical_id,city:entry.normalized_data.city,name:entry.normalized_data.name,sources:entry.sources,repositories:sourceRepositories(entry)};}
function sourceRepositories(entry){return [...new Set((entry.sources??[]).map((source)=>source.repository))];}
function countBy(values,key){return Object.fromEntries([...new Set(values.map((entry)=>entry[key]))].sort().map((value)=>[value,values.filter((entry)=>entry[key]===value).length]));}
function shortHash(value){return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,16);}
function stableJson(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function must(value,message){if(!value)throw new Error(message);return value;}

if(require.main===module)main();
module.exports={main};
