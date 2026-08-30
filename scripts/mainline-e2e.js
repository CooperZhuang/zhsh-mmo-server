'use strict';
const B='http://127.0.0.1:4173';
let token=null;
async function api(p,{method='GET',body,auth=false}={}){const h={'Content-Type':'application/json'};if(auth&&token)h.Authorization='Bearer '+token;const r=await fetch(B+p,{method,headers:h,body:body?JSON.stringify(body):undefined});return r.json();}
async function act(a,args={}){return api('/api/game/action',{method:'POST',body:{action:a,args},auth:true});}
async function rt(g,m,args={}){return api('/api/game/runtime',{method:'POST',body:{gadget:g,method:m,args},auth:true});}
async function state(){return api('/api/game/state',{auth:true});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
  const u='fin'+Date.now().toString(36).slice(-4);
  const reg=await api('/api/auth/register',{method:'POST',body:{username:u,password:'test1234'}});
  token=reg.token;
  console.log('注册:',u);
  let st=await state();
  let steps=0;
  while(steps<20){
    const chain=st.task_chain||[];
    // 找可接取/进行中/可提交的任务
    const active=chain.find(x=>['accepted','in_progress','completable'].includes(x.runtime?.status));
    const avail=chain.find(x=>x.runtime?.status==='available');
    const task=active||avail;
    if(!task){ console.log('无任务可推进, 主线:',st.task_series?.map(s=>s.completed+'/'+s.total).join(',')); break; }
    const d=task.definition;
    const status=task.runtime?.status;
    const name=d.display_name;
    // 可提交 → 去 completion NPC 提交
    if(status==='completable'||(active&&name!=='接取')){
      const comp=d.completion_npc_canonical_id;
      const loc=d.submit_location_canonical_id;
      if(comp&&loc){
        await act('fast_travel',{location_canonical_id:loc}).catch(()=>{});
        const sub=await act('submit_to_npc',{npc_canonical_id:comp,location_canonical_id:loc}).catch(e=>({}));
        if(sub.action==='completed'){ console.log(`  [提交] ${name}`); steps++; st=await state(); continue; }
      }
    }
    // 接任务: issuer 处在 receive location 交谈接受
    if(status==='available'||status===undefined){
      const iss=d.issuer_npc_canonical_id, loc=d.receive_location_canonical_id;
      if(iss&&loc){
        await act('fast_travel',{location_canonical_id:loc}).catch(()=>{});
        const take=await act('talk_to_npc',{npc_canonical_id:iss,location_canonical_id:loc}).catch(()=>({}));
        if(take.action==='accepted'){ console.log(`  [接受] ${name}`); st=await state(); continue; }
      }
    }
    // 进行中: 打目标怪
    if(status==='accepted'||status==='in_progress'){
      const tgt=d.targets?.[0];
      if(tgt?.target_kind==='monster'){
        const mon=tgt.monster_canonical_id, mlock=tgt.location_canonical_id||d.target_location_canonical_id;
        if(mlock){ await act('fast_travel',{location_canonical_id:mlock}).catch(()=>{}); }
        const atk=await act('attack_monster',{monster_canonical_id:mon,location_canonical_id:mlock}).catch(e=>({}));
        if(atk.action){ console.log(`  [战斗] ${name} ${atk.action}`); }
        st=await state(); continue;
      }
      if(tgt?.target_kind==='npc'){
        const nloc=d.target_location_canonical_id||d.submit_location_canonical_id;
        await act('fast_travel',{location_canonical_id:nloc}).catch(()=>{});
        const tk=await act('talk_to_npc',{npc_canonical_id:tgt.npc_canonical_id,location_canonical_id:nloc}).catch(e=>({}));
        if(tk.action){ console.log(`  [交谈] ${name} ${tk.action}`); }
        st=await state(); continue;
      }
      if(tgt?.target_kind==='item'){
        // item 目标需购买/获取, 简单跳过打印
        console.log(`  [物品目标] ${name} 需获取 ${tgt.raw_name}`); steps++; st=await state(); continue;
      }
    }
    console.log('未处理状态:',name,status,'target:',JSON.stringify(d.targets?.[0]).slice(0,80));
    steps++; st=await state();
  }
  const final=await state();
  console.log('主线进度:',final.task_series?.map(s=>s.completed+'/'+s.total).join(','));
})().catch(e=>console.error('FAIL',e.message));
