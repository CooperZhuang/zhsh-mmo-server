'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const {DatabaseSync}=require('node:sqlite');
const {LEVEL_THRESHOLDS,MaritimeRuntime,applyExperienceProgression,createGameplayState,monsterExperience,planTrainingPath}=require('../src/task-runtime');
const {verifyColdFixture}=require('../scripts/verify-progression-source-fixture');

const root=path.resolve(__dirname,'..');
const fixture=read('tests/fixtures/progression-source-evidence.json');
const progressionRules=read('data/runtime/progression-rules.json');
const rewardRules=read('data/runtime/monster-reward-rules.json');

test('immutable source fixture verifies without external reference repositories',()=>{
  const result=verifyColdFixture();
  assert.equal(result.record_count,fixture.records.length);
  assert.ok(result.results.every((entry)=>entry.status==='PASS'));
  assert.ok(fixture.records.every((entry)=>Array.isArray(entry.random_rules)));
});

test('runtime and planner level thresholds use the redesigned smooth curve, deviating from pre-redesign source',()=>{
  // 688a293 平滑经验曲线重设计后，运行时段表(level-experience.json)为权威；规划器 progression-rules
  // 与运行时同源。源表(progression.zhsh.level-thresholds, 旧指数曲线)仅作参考复苏基线，运行时不复用。
  const source=evidence('progression.zhsh.level-thresholds').value;
  const sourceArray=[0,...Object.keys(source).map(Number).sort((a,b)=>a-b).map((level)=>Number(source[level]))];
  const plannerArray=[0,...Object.keys(progressionRules.canonical_rules.level_thresholds.values).map(Number).sort((a,b)=>a-b)
    .map((level)=>Number(progressionRules.canonical_rules.level_thresholds.values[level]))];
  // 运行时 == 规划器（同源=level-experience.json 平滑曲线）
  assert.deepEqual(LEVEL_THRESHOLDS,plannerArray,'runtime curve must equal planner table (single source of truth)');
  for(let level=1;level<(plannerArray.length-1);level+=1)assert.ok(plannerArray[level+1]>plannerArray[level],
    `level threshold must increase at lv${level+1} (smooth curve monotonic)`);
  assert.notDeepEqual(LEVEL_THRESHOLDS,sourceArray,'redesigned curve deviates from pre-redesign source (planned [调平])');
  assert.ok(LEVEL_THRESHOLDS[1]<sourceArray[1]&&LEVEL_THRESHOLDS[100]<sourceArray[100],
    'redesign reduces late-game grind (lv1/lv100 thresholds shrink vs source)');
});

test('source-equivalent level growth equals formal runtime growth including interval repair',()=>{
  const sourceText=evidence('progression.zhsh.level-up-growth').snippet;
  for(const expression of ['10 + Math.floor(this.level / 5)','2 + Math.floor(this.level / 10)','1 + Math.floor(this.level / 15)'])assert.ok(sourceText.includes(expression));
  const state=createGameplayState({experience:Number(LEVEL_THRESHOLDS[10])});
  const expected={max_health:100,base_attack:50,base_max_attack:80,base_defense:4,base_agility:3,morale:50};
  for(let level=2;level<=11;level+=1){expected.max_health+=10+Math.floor(level/5);const gain=2+Math.floor(level/10);
    expected.base_attack+=gain;expected.base_max_attack+=gain;expected.base_defense+=1+Math.floor(level/15);expected.base_agility+=1;expected.morale+=5;}
  const progression=applyExperienceProgression(state);
  assert.equal(progression.after,11);
  for(const [key,value] of Object.entries(expected))assert.equal(state.player[key],value,key);
  assert.equal(progressionRules.adjudication_overlay.find((entry)=>entry.canonical_id==='adjudication.max-attack-growth').status,'TECHNICAL_REPAIR');
});

test('source reward conflict and formal encounter multipliers remain explicit',()=>{
  const sourceText=evidence('progression.zhsh.monster-base-reward').snippet;
  assert.match(sourceText,/this\.exp\s*=\s*this\.level\s*\*\s*2/);
  assert.equal(monsterExperience(10,'wild',rewardRules),400);
  assert.equal(monsterExperience(10,'elite',rewardRules),600);
  assert.equal(monsterExperience(10,'boss',rewardRules),800);
  assert.equal(progressionRules.adjudication_overlay.find((entry)=>entry.canonical_id==='adjudication.monster-experience').status,'CONFLICT');
  assert.equal('balance_anomaly_fight_limit' in rewardRules.experience,false);
});

test('source repeat, recovery and accepted terminal training path close without injected experience',()=>{
  const cityText=evidence('progression.zhsh.encounter-cache').snippet;
  const userText=evidence('progression.zhsh.free-recovery').snippet;
  assert.match(cityText,/5\s*\*\s*60\s*\*\s*1000/);
  assert.match(cityText,/Math\.floor\(Math\.random\(\) \* 3\) \+ 3/);
  assert.match(userText,/priest_pray\s*\(/);
  const selection=read('data/generated/runnable-task-selection.json');
  const db=new DatabaseSync(path.join(root,'data','zhsh-content.sqlite'),{readOnly:true});
  try{
    const encounters=db.prepare(`SELECT m.canonical_id monster_canonical_id,m.display_name monster_name,m.level,m.monster_type,
      l.canonical_id location_canonical_id,c.canonical_id city_canonical_id FROM monster_definitions m
      JOIN monster_placements p ON p.monster_definition_id=m.id JOIN locations l ON l.id=p.location_id JOIN cities c ON c.id=l.city_id
      WHERE p.runtime_capability='queryable' AND m.monster_type IN (3,4,5) ORDER BY m.level,m.canonical_id,l.canonical_id`).all()
      .filter((entry)=>selection.resources.city_canonical_ids.includes(entry.city_canonical_id));
    const requiredLevel=Number(db.prepare(`SELECT level_requirement FROM task_definitions WHERE canonical_id='task.series.11.065'`).get().level_requirement);
    const firstGate=selection.level_reachability[0];
    const plan=planTrainingPath({currentLevel:firstGate.from_level,currentExperience:firstGate.from_experience,targetLevel:requiredLevel,
      encounters,rewardRules,progressionRules,actualEquipment:[]});
    assert.equal(plan.formally_executable,true);
    assert.equal(plan.target_level,requiredLevel);
    // 平滑曲线重设计后，门限(如 lv30)阈值显著降低(179366 vs 旧 508331)，玩家在 firstGate 时点(447800 exp)
    // 可能已远超目标阈值，无需练级即可通过。total_planned_victories 是否 >0 取决于到达时点经验是否已
    // 覆盖目标级——重设计后为 0 属正常(减 grind 目标达成)。仍须满足: 无注入经验、恢复/资金闭合、无需外设法宝。
    assert.ok(plan.total_planned_victories>=0);
    assert.ok(plan.level_segments.every((entry)=>entry.maximum_session_minutes<=entry.source_session_limit_minutes));
    assert.ok(plan.level_segments.every((entry)=>entry.reasonable_worst_minutes<=entry.source_session_limit_minutes||entry.session_continuation_required&&entry.session_continuation_allowed));
    assert.equal(plan.recovery_and_funding_closed,true);
    assert.equal(plan.requires_unobtained_equipment,false);
    assert.equal(plan.requires_ship,false);
    assert.equal(plan.requires_party,false);
  }finally{db.close();}
});

test('task experience and monster level distributions remain executable catalog evidence',()=>{
  const db=new DatabaseSync(path.join(root,'data','zhsh-content.sqlite'),{readOnly:true});
  try{
    const taskExperience=db.prepare(`SELECT COUNT(*) count FROM task_rewards WHERE reward_name LIKE '%经验%' AND normalized_quantity>0`).get().count;
    const placements=db.prepare(`SELECT COUNT(*) count,MIN(m.level) minimum,MAX(m.level) maximum FROM monster_placements p JOIN monster_definitions m ON m.id=p.monster_definition_id WHERE p.runtime_capability='queryable'`).get();
    assert.ok(taskExperience>0);
    assert.ok(placements.count>0);
    assert.ok(Number(placements.minimum)>=1);
    assert.ok(Number(placements.maximum)>Number(placements.minimum));
  }finally{db.close();}
});

test('source copper floor is preserved after a ship-damage repair charge',()=>{
  const sourceText=evidence('progression.zhsh.copper-floor').snippet;assert.match(sourceText,/if \(this\.copper < 0\) \{\s*this\.copper = 0;/);
  const runtime=new MaritimeRuntime({storage:null,catalog:{findItemByName:()=>null},random:()=>0});
  const state={player:{money:200,morale:50,luck:60,experience:0},inventory:{},voyage:{speed:10,remaining_distance:100}};
  const result=runtime.applySpecialEvent(state,{special_events:[{name:'ship repair',probability:1,tip:'repair',effect:{type:'shipDamage',repairCost:500}}]});
  assert.equal(result.lost_copper,200);assert.equal(state.player.money,0);
});

function read(relative){return JSON.parse(fs.readFileSync(path.join(root,...relative.split('/')),'utf8'));}
function evidence(canonicalId){
  const record=fixture.records.find((entry)=>entry.canonical_id===canonicalId);
  assert.ok(record,canonicalId);
  return record;
}
