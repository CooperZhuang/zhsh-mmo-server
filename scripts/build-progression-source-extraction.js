'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {generationMetadata,referenceCommits,repositories,root}=require('./generation-metadata');

const extractionPath=path.join(root,'data','generated','progression-source-extraction.json');
const rulesPath=path.join(root,'data','runtime','progression-rules.json');
const rewardRulesPath=path.join(root,'data','runtime','monster-reward-rules.json');

function main(){
  const commits=referenceCommits();
  const records=[
    functionEvidence('progression.zhsh.add-exp','zhsh','src/play.js','addExp',{inputs:['experience amount'],outputs:['experience and possibly level'],state_changes:['play.exp','play.level'],entry:'combat/task/sailing rewards'}),
    functionEvidence('progression.zhsh.exp-threshold-lookup','zhsh','src/play.js','getExpToNextLevel',{inputs:['play.level'],outputs:['configured threshold'],state_changes:[],entry:'Play.addExp'}),
    functionEvidence('progression.zhsh.level-up-growth','zhsh','src/play.js','levelUp',{inputs:['current player state'],outputs:['incremented level and base attributes'],state_changes:['level','health','attack','defense','agility','morale'],entry:'Play.addExp'}),
    functionEvidence('progression.zhsh.copper-floor','zhsh','src/play.js','addCopper',{inputs:['signed copper delta'],outputs:['copper balance with zero lower bound'],random_rules:[],state_changes:['play.copper'],entry:'task/combat/sailing settlement'}),
    jsonEvidence('progression.zhsh.level-thresholds','zhsh','config/exp.json','/',{inputs:['level 1..210'],outputs:['experience threshold'],state_changes:[],entry:'Play.getExpToNextLevel'}),
    functionEvidence('progression.zhsh.monster-reward','zhsh','src/monster.js','assault',{inputs:['monster level','battle outcome','optional fighting pet; no team or ship parameter'],outputs:['level*2 experience','level*5 copper','optional pet damage'],random_rules:['equipment 0.2','ordinary item 0.4','pet damage/status when an active pet exists'],state_changes:['player experience','money','drops'],entry:'attack?type=monster.assault'}),
    functionEvidence('progression.zhsh.encounter-cache','zhsh','src/city.js','generateMonsterCache',{inputs:['city','position','player'],outputs:['3..5 monster instances'],random_rules:['1..3 monster types','level variation','3..5 instances'],state_changes:['five-minute location cache'],entry:'City.getMonsterCache'}),
    functionEvidence('progression.zhsh.encounter-defeat','zhsh','src/city.js','removeDefeatedMonster',{inputs:['monster instance id'],outputs:['remaining cache'],state_changes:['location monster cache'],entry:'Monster.assault victory'}),
    functionEvidence('progression.zhsh.free-recovery','zhsh','src/user.js','priest_pray',{inputs:['player health'],outputs:['full health'],state_changes:['currentHealth'],entry:'church priest action'}),
    functionEvidence('progression.zhsh.task-prize-settlement','zhsh','src/task.js','completeTask',{inputs:['task prize object'],outputs:['experience, money or item prize through Play.addPrize'],state_changes:['player reward state','completedTasks'],entry:'task submission'}),
    functionEvidence('progression.zhsh.team-social-state','zhsh','src/team.js','createTeam',{inputs:['leader','team name/type/target'],outputs:['team record'],random_rules:[],state_changes:['team membership persistence'],entry:'team UI; not called by Monster.assault'}),
    jsonEvidence('progression.zhsh.world-monster-distribution','zhsh','config/monsters.json','/',{inputs:['city and location'],outputs:['monster types and base levels'],random_rules:[],state_changes:[],entry:'City.generateMonsterCache'}),
    jsonEvidence('progression.zhsh.dungeon-monster-distribution','zhsh','config/fbNpc.json','/',{inputs:['dungeon and stage'],outputs:['dungeon monster types and levels'],random_rules:[],state_changes:[],entry:'City.generateMonsterCache'}),
    lineEvidence('progression.zhsh.auto-attack','zhsh','views/pages/attack.ejs',14,19,{inputs:['auto attack enabled'],outputs:['one assault request per second'],random_rules:[],state_changes:['battle rounds'],entry:'attack page'}),
    jsonEvidence('progression.zhsh.training-session-scale','zhsh','config/trial.json','/0',{inputs:['level 5..15','six players'],outputs:['40 kills within 50 minutes'],state_changes:['trial progress'],entry:'Venice dungeon'}),
    functionEvidence('progression.astrbot.battle-reward','astrbot','server/src/routes/battle.js','handleMonsterKill',{inputs:['monster.exp_reward','player state'],outputs:['experience, money, level'],state_changes:['user level/exp/stats','pet exp'],entry:'POST battle/action'}),
    functionEvidence('progression.astrbot.failure-recovery','astrbot','server/src/routes/battle.js','handlePlayerDeath',{inputs:['money','hp_max','current city'],outputs:['10% HP and tavern return'],state_changes:['hp','money -5%','place'],entry:'battle loss'}),
    lineEvidence('progression.astrbot.level-config','astrbot','server/src/config.js',42,49,{inputs:['level'],outputs:['linear exp_max and fixed stat gains'],random_rules:[],state_changes:[],entry:'handleMonsterKill'}),
    sqlEvidence('progression.dpcq.level-table','dpcq','dpcq.sql','dp_levels',{inputs:['cumulative MOD experience'],outputs:['MOD level mapping'],state_changes:[],entry:'IndexController attack settlement'}),
    functionEvidence('progression.dpcq.attack-settlement','dpcq','app/Http/Controllers/IndexController.php','attack',{inputs:['MOD target and drop table'],outputs:['drop-based experience and level'],random_rules:['drop_probability'],state_changes:['r_exp','r_level','attributes'],entry:'POST attack'}),
    ...Array.from({length:15},(_,index)=>jsonEvidence(`progression.zhsh.task-series-${index+1}-rewards`,'zhsh',`config/task/task${index+1}.json`,'/*/prize/经验',
      {inputs:['completed task'],outputs:['configured task experience prize'],random_rules:[],state_changes:['player experience'],entry:'Task.completeTask'})),
  ];
  for(const record of records){if(!Array.isArray(record.random_rules))record.random_rules=[];record.commit=commits[record.repository];record.evidence_level=record.repository==='zhsh'?'SOURCE_EXPLICIT':record.repository==='dpcq'?'MOD_AUXILIARY_ONLY':'CORROBORATION_ONLY';
    record.current_runtime_module=runtimeModule(record.canonical_id);record.golden_test='tests/progression-source-golden.test.js';
    record.has_conflict=['progression.zhsh.monster-reward','progression.astrbot.battle-reward','progression.dpcq.attack-settlement','progression.zhsh.level-up-growth'].includes(record.canonical_id);}
  const extraction={schema_version:1,record_kind:'progression-source-extraction',...generationMetadata('progression-source-extractor/1.0.0'),
    extraction_method:'static exact-locator extraction; summaries are separate from source bytes and do not claim automatic adjudication',records};
  const exp=JSON.parse(fs.readFileSync(path.join(repositories.zhsh,'config','exp.json'),'utf8'));
  const rewardRules=JSON.parse(fs.readFileSync(rewardRulesPath,'utf8'));
  const rules={schema_version:1,rule_id:'zhsh.progression-planner.v1',...generationMetadata('progression-rule-adjudicator/1.0.0'),
    source_extraction_file:'data/generated/progression-source-extraction.json',
    canonical_rules:{
      level_thresholds:{values:Object.fromEntries(Object.entries(exp).map(([level,value])=>[level,Number(value)])),semantics:'persistent experience compared to current level threshold',
        evidence_ids:['progression.zhsh.level-thresholds','progression.zhsh.add-exp','progression.zhsh.exp-threshold-lookup'],confidence:'high'},
      player_growth:{health:'10 + floor(newLevel / 5)',attack:'2 + floor(newLevel / 10)',max_attack:'same gain as attack (technical interval repair)',defense:'1 + floor(newLevel / 15)',agility:1,morale:5,
        evidence_ids:['progression.zhsh.level-up-growth'],confidence:'high'},
      encounter_rewards:{...rewardRules.experience,evidence_ids:['progression.zhsh.monster-reward','progression.astrbot.battle-reward','progression.dpcq.attack-settlement'],confidence:'conflict'},
      task_rewards:{semantics:'each task prize experience value is settled through Task.completeTask -> Play.addPrize',
        evidence_ids:['progression.zhsh.task-prize-settlement',...Array.from({length:15},(_,index)=>`progression.zhsh.task-series-${index+1}-rewards`)],confidence:'high'},
      encounter_distribution:{world:'config/monsters.json city/location placement',dungeon:'config/fbNpc.json dungeon/stage placement',
        evidence_ids:['progression.zhsh.world-monster-distribution','progression.zhsh.dungeon-monster-distribution'],confidence:'high'},
      repeatable_training:{cache_refresh_seconds:300,minimum_instances_per_cache:3,maximum_instances_per_cache:5,automatic_attack_interval_seconds:1,
        evidence_ids:['progression.zhsh.encounter-cache','progression.zhsh.encounter-defeat','progression.zhsh.auto-attack'],confidence:'high'},
      failure_recovery:{formal_rule:'zhsh defeat returns with 1 HP; church prayer restores full health for zero fee',market_goods_loss_on_defeat:true,money_loss:0,
        copper_lower_bound:0,evidence_ids:['progression.zhsh.monster-reward','progression.zhsh.free-recovery','progression.zhsh.copper-floor'],confidence:'high'},
      training_modifiers:{equipment:'directly changes player combat attributes',pet:'optional active pet adds damage and status effects',team:'social/persistence implementation; no Monster.assault integration found',
        ship:'sailing capability; no ordinary ground Monster.assault integration found',planner_policy:'close the current prefix without assuming an unobtained pet, team, crew or ship',
        evidence_ids:['progression.zhsh.monster-reward','progression.zhsh.team-social-state'],confidence:'high'},
      reasonable_training:{maximum_minutes_per_level_segment:50,derivation:'The earliest source dungeon requires 40 victories within a source-configured 50-minute session; planner uses combat rounds, deterministic win sampling, cache capacity and refresh delay instead of a fixed fight count.',
        evidence_ids:['progression.zhsh.training-session-scale','progression.zhsh.auto-attack','progression.zhsh.encounter-cache'],confidence:'high'},
    },
    adjudication_overlay:[
      {canonical_id:'adjudication.monster-experience',status:'CONFLICT',source_confidence:'CONFLICT',runtime_adjudication_status:'COMPATIBILITY_PLAYABLE_RETAINED',has_active_conflict:true,
        decision:'retain accepted level*40 compatibility gradient only for the already accepted playable baseline until authoritative populated original rewards are recovered; do not use it for higher-level expansion',
        source_fact:'zhsh executes level*2; astrbot expects per-monster exp_reward but its database is unpopulated; dpcq is MOD drop-table experience',technical_bug:false},
      {canonical_id:'adjudication.max-attack-growth',status:'TECHNICAL_REPAIR',decision:'increase max attack with base attack to prevent the attack interval from inverting after repeated level-ups',
        source_fact:'zhsh levelUp increments attack but omits maxAttack',technical_bug:true},
      {canonical_id:'adjudication.copper-floor',status:'TECHNICAL_REPAIR',decision:'apply the source Play.addCopper zero lower bound to formal sailing repair charges',
        source_fact:'zhsh Sailing shipDamage calls Play.addCopper(-repairCost), whose implementation clamps copper at zero',technical_bug:true},
      {canonical_id:'adjudication.training-repeat',status:'SOURCE_EXPLICIT',decision:'ordinary location encounters are renewable through the five-minute cache; formal runtime may expose immediate replay but planner budgets source cache capacity and refresh delay',technical_bug:false},
      {canonical_id:'adjudication.training-modifiers',status:'SOURCE_EXPLICIT',decision:'equipment and an active pet can widen survivable training, but current closure must not assume either unless actually obtained; team and ship do not enter ordinary assault settlement',technical_bug:false},
      {canonical_id:'adjudication.astrbot-training',status:'CORROBORATION_ONLY',decision:'record linear exp_max, per-monster exp_reward, pet assist and 5% death loss as an alternative implementation, not original numeric authority',technical_bug:false},
      {canonical_id:'adjudication.dpcq-progression',status:'MOD_AUXILIARY_ONLY',decision:'record dp_levels and drop-driven experience only as MOD auxiliary evidence',technical_bug:false},
    ]};
  write(extractionPath,extraction);write(rulesPath,rules);
  process.stdout.write(`${JSON.stringify({extraction:path.relative(root,extractionPath),rules:path.relative(root,rulesPath),records:records.length},null,2)}\n`);
  return {extraction,rules};
}

function functionEvidence(canonicalId,repository,relativePath,functionName,behavior){
  const file=fileRecord(repository,relativePath);const range=findFunctionRange(file.text,functionName);
  return {canonical_id:canonicalId,repository,relative_path:relativePath,locator_type:'function',locator:functionName,line_start:range.start,line_end:range.end,file_sha256:file.sha256,...behavior};
}
function lineEvidence(canonicalId,repository,relativePath,start,end,behavior){const file=fileRecord(repository,relativePath);return {canonical_id:canonicalId,repository,relative_path:relativePath,
  locator_type:'line_range',locator:`lines ${start}-${end}`,line_start:start,line_end:end,file_sha256:file.sha256,...behavior};}
function jsonEvidence(canonicalId,repository,relativePath,pointer,behavior){const file=fileRecord(repository,relativePath);return {canonical_id:canonicalId,repository,relative_path:relativePath,
  locator_type:'json_pointer',locator:pointer,file_sha256:file.sha256,...behavior};}
function sqlEvidence(canonicalId,repository,relativePath,table,behavior){const file=fileRecord(repository,relativePath);const lines=file.text.split(/\r?\n/);const index=lines.findIndex((line)=>new RegExp(`CREATE TABLE [\\x60]?${escapeRegex(table)}[\\x60]?`,'i').test(line));
  if(index<0)throw new Error(`SQL table ${table} not found in ${relativePath}`);
  return {canonical_id:canonicalId,repository,relative_path:relativePath,locator_type:'sql_table',locator:table,line_start:index+1,line_end:index+1,file_sha256:file.sha256,...behavior};}
function fileRecord(repository,relativePath){const absolute=path.join(repositories[repository],...relativePath.split('/'));const bytes=fs.readFileSync(absolute);return {text:bytes.toString('utf8'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
function findFunctionRange(text,name){const lines=text.split(/\r?\n/);const patterns=[new RegExp(`\\bfunction\\s+${escapeRegex(name)}\\s*\\(`),new RegExp(`^\\s*(?:async\\s+)?${escapeRegex(name)}\\s*\\(`)];
  const startIndex=lines.findIndex((line)=>patterns.some((pattern)=>pattern.test(line)));if(startIndex<0)throw new Error(`Function ${name} not found`);let depth=0,opened=false;
  for(let index=startIndex;index<lines.length;index+=1){for(const character of lines[index]){if(character==='{'){depth+=1;opened=true;}else if(character==='}')depth-=1;}if(opened&&depth===0)return {start:startIndex+1,end:index+1};}
  throw new Error(`Function ${name} range is incomplete`);}
function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function runtimeModule(id){if(id.includes('level-up')||id.includes('threshold')||id.includes('add-exp'))return 'gameplay-state.applyExperienceProgression';
  if(id.includes('copper-floor'))return 'formal-gameplay.MaritimeRuntime';
  if(id.includes('monster-reward')||id.includes('auto-attack'))return 'formal-gameplay.CombatRuntime';if(id.includes('recovery'))return 'formal-gameplay.RecoveryRuntime';
  if(id.includes('task-'))return 'task-engine.TaskRuntimeEngine';if(id.includes('distribution')||id.includes('encounter'))return 'progression-planner.planTrainingPath';
  return id.includes('astrbot')||id.includes('dpcq')?'evidence-only':'progression-planner.planTrainingPath';}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`,'utf8');}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
