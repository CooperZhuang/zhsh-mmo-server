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
const content=JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'..','web','generated','task1-content.json'),'utf8'));
let steps=0;const MAX_STEPS=Number(process.env.ZHSH_MAINLINE_MAX_STEPS??4000);
(async()=>{
  const u='ml'+Date.now().toString(36).slice(-5);
  const reg=await api('/api/auth/register',{method:'POST',body:{username:u,password:'test1234'}});
  token=reg.token;
  console.log('注册:',u);
  let st=await state();
  let lastTask=null,lastTaskSteps=0;
  while(steps<MAX_STEPS){
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
        if(mp){const g=await goto(mp.location_canonical_id);console.log('  [goto]',g.action??g.error,g.current_map_node_canonical_id?.slice?.(-8)??'');}
        for(let k=0;k<40;k+=1){const stx=await state();if(stx.combat){const r=await rt('combat','attack',{rounds:300});if(r.action==='combat_won'){console.log('  [胜] drops=',JSON.stringify(r.drops?.granted??[]).slice(0,100));break;}continue;}
          const sc=await rt('combat','start',{monster_canonical_id:drop.monster_canonical_id});if(sc.error){console.log('  [start失败]',sc.error);await goto(mp?.location_canonical_id);break;}}
        continue;}
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
