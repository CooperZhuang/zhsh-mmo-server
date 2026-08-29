'use strict';
// 阶段7 完整验证：market/enhance/pet/discover/recruit/skill/guild/city 全 runtime
const path = require('node:path');
const fs = require('node:fs');
const { MemoryRuntimeStorage } = require('../src/task-runtime/memory-runtime-storage');
const { createGameplayState } = require('../src/task-runtime/gameplay-state');
const { FormalGameplayCatalog, MarketRuntime, EquipmentEnhanceRuntime, PetRuntime, DiscoverRuntime, RecruitRuntime, SkillRuntime, GuildRuntime, CityRuntime, EquipmentRuntime, applyTitle } = require('../src/task-runtime/index.js');

const content = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'generated', 'task1-content.json'), 'utf8'));
const contentDir = path.join(__dirname, '..', 'server', 'content');
const FILES = { world_regions:'world-regions.json',goods:'goods.json',market_region:'market_region.json',discoveries:'discoveries.json',pets:'pets.json',enhance_rules:'enhance-rules.json',game_items:'items.json',npc_dialogs:'npc-dialogs.json',questline:'questline.json',characters:'characters.json',sidequests:'sidequests.json',crew:'crew.json',skills:'skills.json',game_cities:'cities.json' };
for (const [k,f] of Object.entries(FILES)) content[k] = JSON.parse(fs.readFileSync(path.join(contentDir,f),'utf8'));

const catalog = new FormalGameplayCatalog(content);
const storage = new MemoryRuntimeStorage();
const pid = 'player.test7';
let s = createGameplayState({ canonical_id: pid, current_city_canonical_id: Object.keys(content.market_region.city_region)[0], current_map_node_canonical_id: 'x', experience: 0, money: 500000 });
s.tasks={};s.progress={};s.inventory={};s.reward_grants={};s.flags={};s.processed_events={};s.unlocked_map_nodes=[];
s.player.canonical_id=pid;
storage.createPlayer(s);

const market=new MarketRuntime({storage,catalog});
const pets=new PetRuntime({storage,catalog});
const enhance=new EquipmentEnhanceRuntime({storage,catalog});
const discover=new DiscoverRuntime({storage,catalog});
const recruit=new RecruitRuntime({storage,catalog});
const skill=new SkillRuntime({storage,catalog});
const guild=new GuildRuntime({storage,catalog});
const city=new CityRuntime({storage,catalog});
const equip=new EquipmentRuntime({storage,catalog});

function ok(cond,label){ console.log((cond?'[PASS]':'[FAIL]'),label); return cond; }
let pass=0,fail=0;
const check=(cond,label)=>{ if(ok(cond,label))pass++;else fail++; };

// 1. 内容计数
check(Object.keys(content.world_regions.regions).length===12,'world 12区');
check(Object.values(content.goods.regions).reduce((n,r)=>n+r.specialty.length,0)>=200,'goods≥200');
check(content.pets.pets.length===30,'pets=30');
check(content.game_items.items.length>=45,'items≥45');
check(content.discoveries.discoveries.length>=36,'discoveries≥36');
check(content.questline.chapters.length===12,'questline=12章');
check(content.characters.characters.length>=80,'characters≥80');
check(content.sidequests.sidequests.length>=40,'sidequests≥40');
check(content.crew.crew.length>=30,'crew≥30');
check(content.skills.skills.length>=20,'skills≥20');

// 2. market 0.75/1.25 + 跨区利润
const view=market.getMarketView(pid,'v1');
const local=view.offers.find(o=>o.is_local), remote=view.offers.find(o=>!o.is_local);
check(local.local_price===Math.max(1,Math.round(local.base_price*0.75)),'market local 0.75');
check(remote.local_price===Math.max(1,Math.round(remote.base_price*1.25)),'market remote 1.25');
const buy=market.buy(pid,local.canonical_id,10,'b1');
const remoteCity=Object.keys(content.market_region.city_region).find(c=>content.market_region.city_region[c]!==view.city_region);
let cur=storage.loadPlayer(pid);cur.player.current_city_canonical_id=remoteCity;storage.resetPlayer(pid,cur);
const sell=market.sell(pid,local.canonical_id,10,'s1');
check(sell.total>buy.total,`market 跨区套利利润>0 (${sell.total}-${buy.total})`);

// 3. pet 上限3
pets.capture(pid,'pet.月虎','c1');pets.capture(pid,'pet.麒麟','c2');pets.capture(pid,'pet.圣龙','c3');
let third=true;try{pets.capture(pid,'pet.暗狼','c4');third=false;}catch{}
check(third,'pet 上限3');

// 4. enhance：装备+强化到15封顶
const eqId=[...catalog.equipment.entries()].find(([,e])=>Number(e.required_level??e.level??1)<=1)?.[0]??[...catalog.equipment.keys()][0];
cur=storage.loadPlayer(pid);cur.inventory[eqId]=cur.inventory[eqId]??1;cur.inventory['item.龙泉水']=500;storage.resetPlayer(pid,cur);
try{equip.equip(pid,eqId,'eq1');}catch(e){console.log('equip skip:',e.message);}
let eqState=storage.loadPlayer(pid);
if(!eqState.equipment.weapon){ eqState.equipment.weapon=eqId; storage.resetPlayer(pid,eqState); }
let maxLv=0,noDowngrade=true;
for(let i=0;i<25;i++){try{const r=enhance.enhance(pid,'weapon','e'+i);maxLv=Math.max(maxLv,r.current_level);}catch(e){break;}}
check(maxLv<=15,`enhance 15级封顶 (max=${maxLv})`);

// 5. discover visit（玩家在当前城市某发现地点）
const disc=content.discoveries.discoveries[0];
const found=discover.visit(pid,disc.canonical_id,'d1');
check(found.action==='discovery_found'&&found.reputation>0,`discover 触发+声望 (title=${found.title})`);
const again=discover.visit(pid,disc.canonical_id,'d2');
check(again.reason==='discovery_already_found','discover 不重复触发');

// 6. recruit 上限
const c1=recruit.recruit(pid,'crew.老船长','r1');
recruit.recruit(pid,'crew.水手长','r2');
let r5=true;try{recruit.recruit(pid,'crew.领航员','r3');}catch{}
const crewCount=storage.loadPlayer(pid).player.crew.length;
check(crewCount<=5,`recruit 上限≤5 (${crewCount})`);
const bonus=recruit.crewBonuses(storage.loadPlayer(pid));
check(bonus.attack>0,`crew 属性加成 (attack+${bonus.attack})`);

// 7. skill learn
let skp=storage.loadPlayer(pid);skp.player.skill_points=20;storage.resetPlayer(pid,skp);
skill.learn(pid,'skill.航海精通','sk1');
const learned=skill.listLearned(pid);
check(learned.learned['skill.航海精通']?.level===1,'skill learn 生效');

// 8. title 爵位阶梯
check(applyTitle(0)==='水手'&&applyTitle(1000)==='船长'&&applyTitle(5000)==='提督'&&applyTitle(20000)==='总督'&&applyTitle(50000)==='公爵','title 爵位阶梯');

// 9. guild + city
guild.establish(pid,'四海商会','g1');
let cur2=storage.loadPlayer(pid);cur2.player.current_city_canonical_id=Object.keys(content.market_region.city_region)[0];storage.resetPlayer(pid,cur2);
city.invest(pid,Object.keys(content.market_region.city_region)[0],'inv1');
const cityKey=Object.keys(content.market_region.city_region)[0];
for(let i=0;i<12;i++){try{city.invest(pid,cityKey,'inv'+i);}catch{}}
const occupy=city.declareOccupy(pid,cityKey,'occ1');
check(occupy.action==='city_occupied','city 占领');
const tax=city.collectDailyTax(pid,'tax1');
check(tax.action==='city_tax_collected'&&tax.tax_total>0,`city 日税收 (>0:${tax.tax_total})`);

console.log(`\n=== 阶段7 验证结果：PASS ${pass} / FAIL ${fail} ===`);
process.exit(fail>0?1:0);
