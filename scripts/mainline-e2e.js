'use strict';
const B=process.env.ZHSH_API_BASE??'http://127.0.0.1:20180';
let token=null;
async function api(p,{method='GET',body,auth=false}={}){const h={'Content-Type':'application/json'};if(auth&&token)h.Authorization='Bearer '+token;const r=await fetch(B+p,{method,headers:h,body:body?JSON.stringify(body):undefined});return r.json();}
async function act(a,args={}){return api('/api/game/action',{method:'POST',body:{action:a,args},auth:true});}
async function rt(g,m,args={}){const wire={};let i=1;for(const v of Object.values(args))wire['_arg'+(i++)]=v;return api('/api/game/runtime',{method:'POST',body:{gadget:g,method:m,args:wire},auth:true});}
async function state(){return api('/api/game/state',{auth:true});}
async function goto(locationId){
  const st=await state();
  const dest=content.locations.find(l=>l.canonical_id===locationId);
  if(!dest)return act('fast_travel',{location_canonical_id:locationId});
  const curCity=st.current_location?.city_canonical_id;
  if(curCity===dest.city_canonical_id)return act('fast_travel',{location_canonical_id:locationId});
  const dock=content.map_nodes.find(n=>n.city_canonical_id===curCity&&n.display_name==='码头'&&n.location_canonical_id);
  if(dock)await act('fast_travel',{location_canonical_id:dock.location_canonical_id});
  const destDock=content.map_nodes.find(n=>n.city_canonical_id===dest.city_canonical_id&&n.display_name==='码头'&&n.location_canonical_id);
  const tp=await act('travel_to_city_port',{map_node_canonical_id:destDock?.map_node_canonical_id});
  return act('fast_travel',{location_canonical_id:locationId});
}
async function ensureNodeAt(locationId){
  // 确保玩家位于指定 location 的 map_node（自愈：fast_travel 事务提交后 state 可能短暂返回旧节点）
  const dest=content.locations.find(l=>l.canonical_id===locationId);
  if(!dest)return;
  const expectedNode=content.map_nodes.find(n=>n.location_canonical_id===locationId)?.map_node_canonical_id;
  for(let retry=0;retry<8;retry+=1){
    const st=await state();
    // 活跃战斗先打完（否则 fast_travel 一直报 idle 错误）
    if(st.combat){await rt('combat','attack',{rounds:300});continue;}
    if(st.player?.current_map_node_canonical_id===expectedNode)return;
    const curCity=st.current_location?.city_canonical_id;
    if(curCity===dest.city_canonical_id){
      const ft=await act('fast_travel',{location_canonical_id:locationId});
      if(ft.error)console.log('  [ensureNode] ft error:',ft.error);
    }else{
      const dock=content.map_nodes.find(n=>n.city_canonical_id===curCity&&n.display_name==='码头'&&n.location_canonical_id);
      if(dock)await act('fast_travel',{location_canonical_id:dock.location_canonical_id});
      const destDock=content.map_nodes.find(n=>n.city_canonical_id===dest.city_canonical_id&&n.display_name==='码头'&&n.location_canonical_id);
      if(destDock)await act('travel_to_city_port',{map_node_canonical_id:destDock.map_node_canonical_id});
      await act('fast_travel',{location_canonical_id:locationId});
    }
    await new Promise(r=>setTimeout(r,80));
  }
}
const content=JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'..','web','generated','task1-content.json'),'utf8'));
let steps=0;const MAX_STEPS=Number(process.env.ZHSH_MAINLINE_MAX_STEPS??4000);

// —— 战斗预估：与 src/task-runtime/formal-gameplay.js 的 damage()/monsterStats() 完全一致 ——
function expectedDamage(minAttack,maxAttack,defense,atkAgi,defAgi){
  const roll=(Number(minAttack)+Number(maxAttack))/2;
  const reduction=Math.min(0.99,Number(defense)/(Number(defense)+300));
  const agilityBonus=Math.max(-0.3,Math.min(0.3,(Number(atkAgi)-Number(defAgi))/1000));
  const crit=1+0.15+Math.max(0,Number(atkAgi)-Number(defAgi))/5000; // 期望暴击修正≈avg
  return Math.max(1,Math.round(roll*(1-reduction)*(1+agilityBonus)*crit));
}
function monsterStats(m){
  const lv=Math.max(1,Number(m.level));
  const type=Number(m.monster_type??5);
  if(type===3||type===4)return{health:Math.floor(200+300*(lv-1)/209),attack:1,max_attack:1,defense:10000,agility:1};
  const mult=({40:1.5,50:2,45:2.5,6:3,55:3.5}[type])??1;
  const hm=[45,6,55].includes(type)?mult*10:mult;
  return{health:Math.floor((50+20*(lv-1))*hm),attack:Math.floor((8+4*(lv-1))*mult),
    max_attack:Math.floor((12+6*(lv-1))*mult),defense:Math.floor((8+3*(lv-1))*mult),agility:Math.floor((5+2*(lv-1))*mult)};
}
// 玩家有效战力 → 对某怪能否战胜（期望击杀轮 <= 期望存活轮）
function canWin(stats,m){
  const ms=monsterStats(m);
  const playerDps=Math.max(1,expectedDamage(stats.attack,stats.max_attack,ms.defense,stats.agility,ms.agility));
  const monsterDps=Math.max(1,expectedDamage(ms.attack,ms.max_attack,stats.defense,ms.agility,stats.agility));
  const roundsToKill=Math.ceil(ms.health/playerDps);
  const roundsToLive=Math.ceil(stats.max_health/monsterDps);
  return roundsToKill<=roundsToLive;
}
// 从 state() 还原玩家有效攻击/防御/体力（含已装备）
function playerStats(st){
  const lv=Number(st.player?.level??1);
  const s={attack:Number(st.player?.base_attack??0),max_attack:Number(st.player?.base_max_attack??0),
    defense:Number(st.player?.base_defense??0),agility:Number(st.player?.base_agility??0),
    max_health:Number(st.player?.max_health??100),morale:Number(st.player?.morale??0)};
  const eq=st.equipment??{};
  const slots=[eq.weapon,eq.offhand,eq.headgear,eq.clothes,eq.belt,eq.shoes,...(eq.accessories??[])].filter(Boolean);
  for(const id of slots){const item=content.equipment.find(x=>x.canonical_id===id);if(!item)continue;
    s.attack+=Number(item.attack??0);s.max_attack+=Number(item.max_attack??item.maxAttack??0);
    s.defense+=Number(item.defense??0);s.agility+=Number(item.agility??0);s.max_health+=Number(item.health??0);s.morale+=Number(item.morale??0);}
  return s;
}
(async()=>{
  const u='ml'+Date.now().toString(36).slice(-5);
  const reg=await api('/api/auth/register',{method:'POST',body:{username:u,password:'test1234'}});
  token=reg.token;
  console.log('注册:',u);
  let st=await state();
  let lastTask=null,lastTaskSteps=0;let mainlineBlocked=null;
  while(steps<MAX_STEPS){
    if(mainlineBlocked){console.log('主线受阻(等级/装备墙):',mainlineBlocked);break;}
    steps++;
    st=await state();
    const chain=st.all_task_chain??[];
    const active=chain.find(x=>['available','accepted','in_progress','completable'].includes(x.runtime?.status));
    if(!active){console.log('无可推进任务（可能全部完成或被锁），主线:',(st.task_series??[]).map(s=>s.completed+'/'+s.total).join(','));break;}
    const d=active.definition;const status=active.runtime?.status;const name=d.display_name;
    if(name!==lastTask){lastTask=name;lastTaskSteps=0;}
    lastTaskSteps++;
    if(lastTaskSteps>120){console.log('任务步数超限:',name);break;}
    // completable → submit
    if(status==='completable'){
      const comp=d.completion_npc_canonical_id,loc=d.submit_location_canonical_id;
      if(comp&&loc){await goto(loc);const sub=await act('submit_to_npc',{npc_canonical_id:comp,location_canonical_id:loc});
        if(sub.action==='completed'||sub.applied){console.log('  [提交]',name);continue;}}
    }
    // available → accept
    if(status==='available'){
      const iss=d.issuer_npc_canonical_id,loc=d.receive_location_canonical_id;
      if(iss&&loc){await goto(loc);const take=await act('talk_to_npc',{npc_canonical_id:iss,location_canonical_id:loc});
        if(take.action==='accepted'){console.log('  [接受]',name);continue;}}
    }
    // targets
    const tgt=(d.targets??[]).find(t=>t.target_kind==='monster');
    if(tgt){
      const mlock=tgt.location_canonical_id??d.target_location_canonical_id;
      if(mlock)await goto(mlock);
      const st2=await state();
      if(st2.combat){const r=await rt('combat','attack',{rounds:300});if(r.action==='combat_lost'||r.action==='combat_won')continue;continue;}
      const startC=await rt('combat','start',{monster_canonical_id:tgt.entity_canonical_id});
      if(startC.error){console.log('  [战斗受阻]',name,startC.error);}
      continue;
    }
    const itemTgt=(d.targets??[]).find(t=>t.target_kind==='item');
    if(itemTgt){
      // 授予型物品（task_chain_reward / task_acceptance_grant）：接取/前序奖励时服务器已给，
      // 无需世界获取；只需在背包确认。若后续提交时校验不足，说明授予链路异常，停下上报。
      const grantType=itemTgt.task_item_policy?.acquisition_mode==='grant_on_accept'||['task_chain_reward','task_acceptance_grant'].includes(itemTgt.runtime_resolution?.source_kind);
      if(grantType){
        const hold=await state();const held=Number(hold.inventory?.[itemTgt.entity_canonical_id]??0);
        if(held<Number(itemTgt.required_quantity??1)){console.log('  [授予不足]',name,itemTgt.raw_name,'held',held,'required',itemTgt.required_quantity,', 尝试重新接受绑定');}
        else console.log('  [授予已持]',name,itemTgt.raw_name,'×'+held);
        continue;
      }
      const shop=content.shop_entries.find(e=>e.task_target_canonical_id===itemTgt.canonical_id||e.task_item_canonical_id===itemTgt.entity_canonical_id||e.content_entity_canonical_id===itemTgt.entity_canonical_id);
      if(shop){await goto(shop.location_canonical_id);
        for(let q=0;q<Number(itemTgt.required_quantity??1);q+=1)await rt('economy','buy',{shop_entry_canonical_id:shop.canonical_id,quantity:1});
        continue;}
      const drop=content.drop_relations.filter(e=>e.canonical_id===itemTgt.runtime_resolution?.formal_source_canonical_id||(e.item_canonical_id??e.content_entity_canonical_id)===itemTgt.entity_canonical_id).sort((a,b)=>Number(b.probability??0)-Number(a.probability??0))[0];
      if(drop&&drop.monster_canonical_id){console.log('  [掉落击杀]',name,itemTgt.raw_name,'←',drop.monster_canonical_id.slice(-8));
        const mp=content.monster_placements.find(p=>p.monster_canonical_id===drop.monster_canonical_id&&p.repeatable);
        // 升级自愈：掉落怪等级远超当前等级 → 刷同城低级怪练级
        const dropMon=content.monsters.find(m=>m.canonical_id===drop.monster_canonical_id);
        const dropLv=Number(dropMon?.level??1);
        let curLevel=(await state()).player?.level??1;
        let targetLevel=0;
        let gainStalled=0;let gainAttempts=0;let lastExperience=0;
        const cityId=content.locations.find(l2=>l2.canonical_id===mp.location_canonical_id)?.city_canonical_id;
        const cityLocs=content.locations.filter(l=>l.city_canonical_id===cityId).map(l=>l.canonical_id);
        // 全部可重复怪(城市内)，按等级升序。练级目标在当前曲线下实时重算，绝不冻结。
        const cityMons=content.monster_placements.filter(p=>cityLocs.includes(p.location_canonical_id)&&p.repeatable)
          .map(p=>({p,mon:content.monsters.find(m=>m.canonical_id===p.monster_canonical_id)}))
          .filter(({mon})=>mon&&Number(mon.rewards?.experience>0))
          .sort((a,b)=>Number(a.mon.level)-Number(b.mon.level));
        let target=null;
        const equipped=new Map(); // slot(type) -> {score,canonical_id}
        const equipBest=async()=>{
          const st=await state();
          const level=Number(st.player?.level??1);
          const ids=Object.keys(st.inventory??{});
          const byType=new Map();
          for(const id of ids){
            const eq=content.equipment.find(x=>x.canonical_id===id);
            if(!eq||Number(eq.required_level??1)>level)continue;
            const type=Number(eq.equipment_type);
            if(type===6)continue;
            const score=Number(eq.attack??0)*2+Number(eq.defense??0)*2+Number(eq.max_attack??eq.maxAttack??0)+Number(eq.health??0)+Number(eq.agility??0)+Number(eq.morale??0);
            const cur=equipped.get(type);
            if(!cur||score>cur.score)byType.set(type,{score,canonical_id:id});
          }
          for(const {score,canonical_id:id} of byType.values()){
            if(score<=(equipped.get([...equipped.keys()].find(k=>equipped.get(k).canonical_id===id))?.score??-1))continue;
            await rt('equipment','equip',{equipment_canonical_id:id});
            equipped.set(Number(content.equipment.find(x=>x.canonical_id===id).equipment_type),{score,canonical_id:id});
          }
        };
        // 用战力预估选出「当前最强且能打赢」的怪（基于真实有效攻击/防御/体力，
        // 不再靠每次探测碰运气）。等级/装备变化后每次战斗都会重新评估。
        const pickBest=(st)=>{
          const stats=playerStats(st);
          const pool=cityMons.filter(({mon})=>Number(mon.level)<Number(dropLv)-2);
          let best=null;
          for(const cand of pool){if(canWin(stats,cand.mon)){if(!best||Number(cand.mon.level)>Number(best.mon.level))best=cand;}}
          return best??null;
        };
        if(dropLv>curLevel+5){
          target=null;
          const setUpTarget=async(st)=>{
            const best=pickBest(st);
            if(best&&(!target||best.mon.canonical_id!==target.mon.canonical_id)){
              target=best;
              console.log('  [练级] lv'+Number(st.player?.level??curLevel)+' 选怪 → '+best.mon.display_name+'(lv'+best.mon.level+')');
            }else if(!best){target=null;}
            return target;
          };
          const recovery=content.recovery_services?.find(s=>{
            const loc=content.locations.find(l=>l.canonical_id===s.location_canonical_id);
            return loc&&loc.city_canonical_id===cityId;
          });
          let st0=await state();
          target=await setUpTarget(st0);
          if(target){
            // 练到 dropLv-4 就尝试击杀(省下练满 dropLv-2 的时间); 败则 kill-drop 循环进重试练级再试。
            targetLevel=Math.max(curLevel+1,dropLv-4);
            while(curLevel<targetLevel&&gainStalled<30&&gainAttempts<600){
              gainAttempts+=1;
              let stx=await state();
              // 活跃战斗最优先：打完再谈回血/移动
              if(stx.combat){const r=await rt('combat','attack',{rounds:200});if(r.action==='combat_won'||r.action==='combat_lost'){await equipBest();stx=await state();continue;}continue;}
              // 每次战斗后（含升级/换装）重新评估最强可胜怪，升级或改善装备时主动挑战更强目标
              target=await setUpTarget(stx);
              if(!target){break;}
              // 血量极低 → 先恢复（教堂在城里；战败回城后必须回血再战）
              if(Number(stx.player?.current_health??1)<40&&recovery){
                await ensureNodeAt(recovery.location_canonical_id);
                await rt('recovery','recover',{recovery_service_canonical_id:recovery.canonical_id});
                stx=await state();
              }
              // 站位：只在目标节点与当前不符时移动（练级怪可能随 re-evaluate 更换）
              const expNode=target.p.location_canonical_id;
              const expNode2=content.map_nodes.find(n=>n.location_canonical_id===expNode)?.map_node_canonical_id;
              if(expNode2&&stx.player?.current_map_node_canonical_id!==expNode2){
                const ft=await act('fast_travel',{location_canonical_id:expNode});
                if(ft.error){gainStalled+=1;continue;}
              }
              // 一键战斗：校验站位后整场一次结算，返回胜/负+经验+等级
              const br=await rt('combat','autoResolve',{_arg1:target.mon.canonical_id});
              if(br.error){gainStalled+=1;continue;}
              if(br.action==='combat_won'){
                gainStalled=0;lastExperience=Number((await state()).player?.experience??0);
                await equipBest();
                const after=Number(br.progression?.after??curLevel);
                if(after>curLevel)curLevel=after;
              }else{// combat_lost
                gainStalled+=1;
                // 战败说明预估过于乐观：把目标降一级（下一轮 setUpTarget 会自动下移）
                const lowered=cityMons.filter(({mon})=>Number(mon.level)<Number(target.mon.level)).sort((a,b)=>Number(b.mon.level)-Number(a.mon.level));
                if(lowered.length){target=lowered[0];}
              }
            }
            curLevel=(await state()).player?.level??curLevel;
            console.log('  [练级] 完成 → 当前 lv'+curLevel+' (目标 lv'+targetLevel+', 尝试'+gainAttempts+')');
          }
        }
        if(mp){
          await ensureNodeAt(mp.location_canonical_id);
        }
        // 击杀掉落怪：胜→收工；败→回练级循环(练到再高2级)再试，最多 4 轮
        let killed=false;
        for(let round=0;round<4&&!killed;round+=1){
          for(let k=0;k<40;k+=1){
            const stx=await state();
            const expectedNode=mp?content.map_nodes.find(n=>n.location_canonical_id===mp.location_canonical_id)?.map_node_canonical_id:null;
            if(expectedNode && stx.player?.current_map_node_canonical_id!==expectedNode){
              await ensureNodeAt(mp.location_canonical_id);
              continue;
            }
            if(stx.combat){const r=await rt('combat','attack',{rounds:300});if(r.action==='combat_won'){console.log('  [胜] drops=',JSON.stringify(r.drops?.granted??[]).slice(0,100));killed=true;break;}if(r.action==='combat_lost')break;continue;}
            // 一键战斗：对掉落怪整场一次结算（胜→收工，负→break 进练级重试轮）
            const br=await rt('combat','autoResolve',{_arg1:drop.monster_canonical_id});
            if(br.error){break;}
            if(br.action==='combat_won'){console.log('  [胜] drops=',JSON.stringify(br.drops?.granted??[]).slice(0,100));killed=true;break;}
            break; // combat_lost → 退出本轮，进重试练级
          }
          if(killed||!mp)break;
          // 败了 → 继续练 300 场（targetLevel 提高 2）再试
          curLevel=(await state()).player?.level??curLevel;
          targetLevel=Math.max(targetLevel,curLevel)+2;
          gainStalled=0;gainAttempts=0;
          const recovery2=content.recovery_services?.find(s=>{
            const loc=content.locations.find(l=>l.canonical_id===s.location_canonical_id);
            return loc&&loc.city_canonical_id===cityId;
          });
          let retried=0;
          while(curLevel<targetLevel&&gainStalled<30&&retried<400){
            retried+=1;
            let stx=await state();
            if(stx.combat){const r=await rt('combat','attack',{rounds:200});if(r.action==='combat_won'||r.action==='combat_lost'){await equipBest();stx=await state();continue;}continue;}
            // 每次战斗后重新选出当前最强可胜怪（升级/换装自动挑战更强目标）
            const next=pickBest(stx);
            if(next)target=next;
            if(!target){break;}
            if(Number(stx.player?.current_health??1)<40&&recovery2){
              await ensureNodeAt(recovery2.location_canonical_id);
              await rt('recovery','recover',{recovery_service_canonical_id:recovery2.canonical_id});
              stx=await state();
            }
            const expNode=target.p.location_canonical_id;
            const expNode2=content.map_nodes.find(n=>n.location_canonical_id===expNode)?.map_node_canonical_id;
            if(expNode2&&stx.player?.current_map_node_canonical_id!==expNode2){
              const ft=await act('fast_travel',{location_canonical_id:expNode});
              if(ft.error){gainStalled+=1;continue;}
            }
            const br=await rt('combat','autoResolve',{_arg1:target.mon.canonical_id});
            if(br.error){gainStalled+=1;continue;}
            if(br.action==='combat_won'){
              gainStalled=0;lastExperience=Number((await state()).player?.experience??0);
              await equipBest();
              const after=Number(br.progression?.after??curLevel);
              if(after>curLevel)curLevel=after;
            }else{// combat_lost
              gainStalled+=1;
              const lowered=cityMons.filter(({mon})=>Number(mon.level)<Number(target.mon.level)).sort((a,b)=>Number(b.mon.level)-Number(a.mon.level));
              if(lowered.length)target=lowered[0];
            }
          }
          curLevel=(await state()).player?.level??curLevel;
          console.log('  [重试'+(round+1)+'] 练到 lv'+curLevel+' 再战山猪');
        }
        if(!killed){mainlineBlocked=`${name}：${itemTgt.raw_name} 的掉落怪 4 轮仍无法击杀(等级/装备墙)`;continue;}
      }
      console.log('  [物品目标无商店→航海]',name,itemTgt.raw_name);
      // 航海取得：从当前城市出发找 route，买船（若无），起航并推进到港
      // 先推进任何进行中的航程至靠岸
      for(let d=0;d<120;d+=1){const stv=await state();if(!stv.voyage)break;if(stv.maritime_encounter){const dm=await rt('maritime','dismiss',{});if(dm.applied)continue;const en=await rt('maritime','enterRouteLocation',{});if(en.applied)continue;const dg=await rt('dungeon','enter',{});if(dg.applied){await rt('dungeon','exit',{});continue;}console.log('  [drain stuck]',JSON.stringify({enc:stv.maritime_encounter,dg:dg.error??dg.action,dm:dm.error??dm.action}).slice(0,180));break;}
      if(stv.dungeon){await rt('dungeon','exit',{});continue;}
      if(stv.fishing){await rt('fishing','stop',{});continue;}const adv=await rt('voyage','advance',{});if(adv.error&&/活动/.test(adv.error)){const dm=await rt('maritime','dismiss',{});if(!dm.applied){console.log('  [drain dismiss fail]',JSON.stringify(dm).slice(0,120));break;}continue;}if(!adv.applied){console.log('  [drain stop]',JSON.stringify(adv).slice(0,120));break;}}
      const st3=await state();
      const curCity=st3.current_location?.city_canonical_id;
      const destCity=content.locations.find(l=>l.canonical_id===d.submit_location_canonical_id)?.city_canonical_id;
      const route=content.voyage_routes.find(r=>r.from_city_canonical_id===curCity&&r.to_city_canonical_id===destCity)??content.voyage_routes.find(r=>r.from_city_canonical_id===curCity);
      if(!route){console.log('  [无航线从]',curCity);continue;}
      const port=content.map_nodes.find(n=>n.map_node_canonical_id===route.from_port_map_node_canonical_id);
      await act('fast_travel',{location_canonical_id:route.from_port_location_canonical_id});
      const owned=Object.keys((await state()).owned_ships??{});
      if(!owned.length){const ship=content.ships.find(s2=>s2.port_map_node_canonical_id===route.from_port_map_node_canonical_id);
        if(ship)await rt('ships','purchase',{ship_canonical_id:ship.canonical_id});}
      const vs=await rt('voyage','start',{route_canonical_id:route.canonical_id});
      if(vs.error){console.log('  [起航失败]',vs.error);continue;}
      for(let n=0;n<60;n+=1){const adv=await rt('voyage','advance',{});if(!adv.applied||adv.remaining_distance===0)break;}
      continue;
    }
    const npcTgt=(d.targets??[]).find(t=>t.target_kind==='npc');
    if(npcTgt){
      const loc=d.submit_location_canonical_id??d.target_location_canonical_id;
      if(loc)await goto(loc);
      await act('talk_to_npc',{npc_canonical_id:npcTgt.entity_canonical_id,location_canonical_id:loc});
      continue;
    }
    console.log('  [未处理]',name,status,JSON.stringify((d.targets??[])[0]).slice(0,80));
    await act('fast_travel',{location_canonical_id:d.submit_location_canonical_id});
  }
  const fin=await state();
  console.log('主线进度:',(fin.task_series??[]).map(s=>s.completed+'/'+s.total).join(','));
  console.log('已完成:',Object.values(fin.tasks??{}).filter(t=>t.status==='completed').length,'/ 651');
  if(steps>=MAX_STEPS)process.exit(2);
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
