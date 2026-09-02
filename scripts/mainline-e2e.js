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
        let weak=content.monster_placements.filter(p=>cityLocs.includes(p.location_canonical_id))
          .map(p=>({p,mon:content.monsters.find(m=>m.canonical_id===p.monster_canonical_id)}))
          .filter(({mon})=>mon&&Number(mon.level)<=Math.max(4,curLevel))
          .sort((a,b)=>Number(b.mon.level)-Number(a.mon.level));
        let target=null;
        if(dropLv>curLevel+5){
          const safe=weak.find(({mon})=>Number(mon.level)<=curLevel-3)??weak[0];
          target=safe;
          if(target){
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
                // 已穿戴的不再重复 equip（economy：inventory 不含已装备件）
                if(!cur||score>cur.score)byType.set(type,{score,canonical_id:id});
              }
              for(const {score,canonical_id:id} of byType.values()){
                if(score<=(equipped.get([...equipped.keys()].find(k=>equipped.get(k).canonical_id===id))?.score??-1))continue;
                await rt('equipment','equip',{equipment_canonical_id:id});
                equipped.set(Number(content.equipment.find(x=>x.canonical_id===id).equipment_type),{score,canonical_id:id});
              }
            };
            console.log('  [练级] 当前 lv'+curLevel+' vs 目标怪 lv'+dropLv+' → 刷 '+target.mon.display_name+'(lv'+target.mon.level+') 到 lv'+(dropLv-2));
            targetLevel=Math.max(curLevel+1,dropLv-2);
            const recovery=content.recovery_services?.find(s=>{
              const loc=content.locations.find(l=>l.canonical_id===s.location_canonical_id);
              return loc&&loc.city_canonical_id===cityId;
            });
            while(curLevel<targetLevel&&gainStalled<30&&gainAttempts<600){
              gainAttempts+=1;
              let stx=await state();
              // 活跃战斗最优先：打完再谈回血/移动
              if(stx.combat){const r=await rt('combat','attack',{rounds:200});if(r.action==='combat_won'||r.action==='combat_lost'){await equipBest();continue;}continue;}
              // 血量极低 → 先恢复（教堂在城里；战败回城后必须回血再战）
              if(Number(stx.player?.current_health??1)<40&&recovery){
                await ensureNodeAt(recovery.location_canonical_id);
                await rt('recovery','recover',{recovery_service_canonical_id:recovery.canonical_id});
                stx=await state();
              }
              // 战败回城后节点漂移 → 无条件先回练级点（这是 start 失败的唯一根源）
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
                if(after>curLevel){curLevel=after;const stronger=weak.find(({mon})=>Number(mon.level)<=curLevel-3&&Number(mon.level)>Number(target.mon.level));if(stronger)target=stronger;}
              }else{// combat_lost
                gainStalled+=1;
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
            if(stx.combat){const r=await rt('combat','attack',{rounds:200});if(r.action==='combat_won'||r.action==='combat_lost'){await equipBest();continue;}continue;}
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
              if(after>curLevel){curLevel=after;const stronger=weak.find(({mon})=>Number(mon.level)<=curLevel-3&&Number(mon.level)>Number(target.mon.level));if(stronger)target=stronger;}
            }else{// combat_lost
              gainStalled+=1;
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
