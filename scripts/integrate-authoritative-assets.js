'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const sourceArgument=process.argv.find((value)=>value.startsWith('--source='));
const sourceRoot=path.resolve(sourceArgument?.slice('--source='.length)??process.env.ZHSH_AUTHORITATIVE_ASSET_SOURCE??'');
const manifestPath=path.join(sourceRoot,'master_manifest.csv');
const registryPath=path.join(sourceRoot,'authoritative_asset_registry.json');
const contentPath=path.join(root,'web','generated','task1-content.json');
const targetRoot=path.join(root,'web','assets','authoritative');
const outputRegistry=path.join(root,'web','generated','authoritative-assets.json');
const mappingPath=path.join(root,'docs','design','authoritative-asset-mapping.csv');
const unmappedPath=path.join(root,'docs','design','authoritative-asset-unmapped.csv');

const UI_SLOTS=new Map([
  ['角色状态','visual.slot.ui.status'],['背包','visual.slot.ui.backpack'],['装备栏','visual.slot.ui.equipment'],['任务日志','visual.slot.ui.tasks'],
  ['城市地图','visual.slot.ui.map'],['航海','visual.slot.ui.voyage'],['战斗','visual.slot.ui.combat'],['商店交易','visual.slot.ui.shop'],
  ['仓库','visual.slot.ui.storage'],['宠物','visual.slot.ui.pet'],['钓鱼','visual.slot.ui.fishing'],['图鉴情报','visual.slot.ui.debug_compendium'],
]);
const FUNCTION_SLOTS=new Map([
  ['造船师船匠',{slot:'visual.slot.npc.shipwright',terms:['造船师','船匠']}],
  ['酒馆老板',{slot:'visual.slot.npc.tavern_keeper',terms:['酒馆老板','酒馆']}],
  ['商会管事贸易商',{slot:'visual.slot.npc.trade_officer',terms:['商会管事','贸易商','商会']}],
  ['港务官海关官员',{slot:'visual.slot.npc.port_officer',terms:['港务官','海关官员','海关']}],
  ['航海士大副',{slot:'visual.slot.npc.navigator',terms:['航海士','大副']}],
  ['治疗者药师修女',{slot:'visual.slot.npc.healer',terms:['治疗者','药师','修女']}],
]);
const SHIP_PATTERNS=new Map([
  ['小型单桅帆船',/轻木帆船|单栀帆船/],['双桅商船',/多栀小型帆船|佛兰德帆船/],['武装商船',/中型帆船|混合式快船/],
  ['卡拉维尔帆船',/轻型三角帆船/],['盖伦帆船',/西班牙大帆船|三栀帆船|三桅大型帆船/],['中国福船',/中国式帆船|明永乐大帆船/],
  ['阿拉伯三角帆船',/单栀三角帆船|三角帆船/],['远洋帆船',/佛兰德帆船|三桅大型帆船/],
]);
const TASK_REFERENCE_NAMES=new Set(['通商卷轴','通商文书','密封信函','圣火令','亚丁权杖','龙珠碎片·赤','龙珠碎片·蓝','龙珠碎片·绿','龙珠碎片·金','加封谕旨','古航海图','航海罗盘','黑铁钥匙','铜钥匙','银钥匙','金钥匙','骷髅钥匙','律法纹章','印蜡官印','蓝纹宝箱','圣杯','玉筒','水晶头骨','太阳徽章','月影水晶球','古护符','青龙玉佩','镇印石盒','漩涡怀表']);
const GENERIC_TYPE_NAMES=new Set(['大型鱼带泡船','百宝箱','百宝袋','哥伦布之刃','哥伦布防御服','哥伦布的铁盔','哥伦布皮长靴','桂魄银蟾','玉兔绒衣','月宫仙子冠','船锚','航海图卷','航海护符','航海勋章','航海腰带','海军匕首','海军外套','远洋帆船','红宝石戒指','黄金金币']);
const FISH_ALIASES=new Map([['剑鱼','旗鱼']]);

function main(){
  assertFile(manifestPath);assertFile(registryPath);assertFile(contentPath);
  const manifest=parseCsv(fs.readFileSync(manifestPath,'utf8'));
  const authoritative=JSON.parse(fs.readFileSync(registryPath,'utf8'));
  if(manifest.length!==229||authoritative.length!==229)throw new Error(`Expected 229 authoritative assets, got manifest=${manifest.length}, registry=${authoritative.length}`);
  const authoritativeBySha=new Map(authoritative.map((entry)=>[entry.sha256,entry]));
  const content=JSON.parse(fs.readFileSync(contentPath,'utf8'));
  const entities=dedupeEntities(['content_entities','formal_items','monsters','npcs','equipment','ships'].flatMap((key)=>(content[key]??[]).map((entry)=>({...entry,entity_kind:key}))));
  const records=[];
  fs.mkdirSync(targetRoot,{recursive:true});

  for(const [index,entry] of manifest.entries()){
    const registryEntry=authoritativeBySha.get(entry.sha256);
    if(!registryEntry||registryEntry.final_relpath!==entry.final_relpath)throw new Error(`Registry mismatch for ${entry.final_relpath}`);
    if(entry.final_relpath.includes('overview')||entry.final_relpath.includes('not_included'))throw new Error(`Non-authoritative asset reached manifest: ${entry.final_relpath}`);
    const source=path.join(sourceRoot,...entry.final_relpath.split('/'));assertFile(source);
    const targetRelative=`assets/authoritative/${entry.source_batch}/${entry.sha256.slice(0,16)}.png`;
    const target=path.join(root,'web',...targetRelative.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
    const mapping=resolveMapping(entry,index,content,entities);
    records.push({
      asset_canonical_id:`visual.asset.${entry.sha256.slice(0,16)}`,source_file:entry.final_relpath,source_batch:entry.source_batch,
      display_name:entry.display_name,category:entry.category||'未分类',mapping_status:mapping.mapping_status,
      canonical_id:mapping.canonical_id??null,family_id:mapping.family_id??null,slot_id:mapping.slot_id??null,
      visual_reference_id:mapping.visual_reference_id??null,binding_ids:mapping.binding_ids??[],task_reference_ids:mapping.task_reference_ids??[],
      target_resource_path:targetRelative,usage_interfaces:mapping.usage_interfaces,variant:mapping.variant??assetVariant(entry.filename),
      mapping_reason:mapping.mapping_reason,sha256:entry.sha256,
    });
  }
  const unmapped=records.filter((entry)=>entry.mapping_status==='unmapped_catalog_only');
  if(unmapped.length)throw new Error(`Full visual mapping failed for ${unmapped.length} assets: ${unmapped.map((entry)=>entry.display_name).join(', ')}`);
  const statusCounts=countBy(records,'mapping_status');
  const body={schema_version:2,record_kind:'authoritative_visual_asset_runtime_registry',source_files:['authoritative_asset_registry.json','master_manifest.csv'],
    policy:{overview_assets_allowed:false,deprecated_assets_allowed:false,visual_layer_ids_do_not_create_game_entities:true,name_family_one_asset_many_entities:true,player_compendium_visible:false},
    authoritative_asset_count:records.length,mapped_count:records.length,unmapped_count:0,runtime_mapped_count:records.length,catalog_only_unmapped_count:0,status_counts:statusCounts,assets:records};
  writeJson(outputRegistry,body);
  const headers=['source_file','asset_canonical_id','display_name','category','mapping_status','canonical_id','family_id','slot_id','visual_reference_id','binding_ids','task_reference_ids','target_resource_path','usage_interfaces','variant','mapping_reason','sha256'];
  writeCsv(mappingPath,records,headers);writeCsv(unmappedPath,[],headers);
  process.stdout.write(`${JSON.stringify({authoritative_asset_count:records.length,mapped_count:records.length,unmapped_count:0,status_counts:statusCounts,registry:path.relative(root,outputRegistry),mapping:path.relative(root,mappingPath),unmapped:path.relative(root,unmappedPath)},null,2)}\n`);
}

function resolveMapping(entry,index,content,entities){
  const explicit=parseExplicitCanonicalId(entry.filename);const baseName=entry.display_name.replace(/·稀有版$/,'');
  if(explicit)return mapped('mapped_explicit_canonical',{canonical_id:explicit,binding_ids:[explicit],usage_interfaces:usesFor(entry,'explicit'),mapping_reason:'源文件名包含明确 canonical_id，直接绑定正式实体。'});
  if(assetVariant(entry.filename)!=='base')return mapped('mapped_variant_family',{family_id:visualId('visual.family',baseName),usage_interfaces:usesFor(entry,'variant'),variant:assetVariant(entry.filename),mapping_reason:`作为“${baseName}”基础资产的视觉变体使用，不创建独立游戏实体。`});
  const uiSlot=UI_SLOTS.get(entry.display_name)??interfaceSceneSlot(entry,index);
  if(uiSlot)return mapped('mapped_interface_slot',{slot_id:uiSlot,usage_interfaces:usesFor(entry,'interface'),mapping_reason:'绑定已有界面或场景槽位。'});
  const functional=FUNCTION_SLOTS.get(entry.display_name);
  if(functional){const bindings=content.npcs.filter((npc)=>functional.terms.some((term)=>npc.display_name.includes(term))).map((npc)=>npc.canonical_id);
    return mapped('mapped_interface_slot',{slot_id:functional.slot,binding_ids:bindings,usage_interfaces:'NPC|对话|对应功能页',mapping_reason:'功能 NPC 使用功能槽位；同类 NPC 可共享该视觉，不伪造 NPC 实体。'});}
  if(entry.category==='怪物'){
    const bindings=content.monsters.filter((monster)=>monster.display_name===entry.display_name).map((monster)=>monster.canonical_id);
    if(bindings.length)return mapped('mapped_name_family',{family_id:visualId('visual.family.monster',entry.display_name),binding_ids:bindings,usage_interfaces:'战斗|任务|掉落提示',mapping_reason:'绑定全部同名怪物定义与放置实例。'});
    return taskReference(entry,content,'怪物名称仅在任务文字中出现；建立视觉任务引用，不补写属性、地点或掉率。');
  }
  if(entry.category==='NPC'){
    const aliases=entry.display_name==='威尼斯国王'?['威尼斯国王','威尼斯王','国王']:[entry.display_name];
    const bindings=content.npcs.filter((npc)=>aliases.includes(npc.display_name)).map((npc)=>npc.canonical_id);
    return mapped('mapped_name_family',{family_id:visualId('visual.family.npc',entry.display_name),binding_ids:bindings,usage_interfaces:'NPC|对话|任务',mapping_reason:`绑定同名 NPC 族${aliases.length>1?'及已确认别名':''}。`});
  }
  if(entry.category==='关键任务物/宝藏'||TASK_REFERENCE_NAMES.has(entry.display_name))return taskReference(entry,content,'用户确认的任务物视觉引用；仅参与任务、背包、奖励或特殊场景显示，不创建事实实体。');
  if(entry.category==='宠物/鱼类'){
    const type=FISH_ALIASES.has(entry.display_name)||/[鱼蟹章]/.test(entry.display_name)?'fish':'pet';const alias=FISH_ALIASES.get(entry.display_name)??entry.display_name;
    const bindings=(content.maritime?.fishing?.catches??[]).filter((catchEntry)=>catchEntry.display_name===alias).map((catchEntry)=>catchEntry.content_entity_canonical_id);
    return mapped('mapped_type_slot',{slot_id:visualId(`visual.${type}_type`,entry.display_name),binding_ids:bindings,usage_interfaces:type==='fish'?'钓鱼|航海|背包':'宠物|任务|状态',mapping_reason:`绑定${type==='fish'?'鱼类':'宠物'}视觉类型槽位；不创建宠物或物品事实。`});
  }
  if(['船只','船只/地点事件'].includes(entry.category)||/帆船|商船|海盗船|幽灵船|泡船/.test(entry.display_name)){
    const pattern=SHIP_PATTERNS.get(entry.display_name);const bindings=pattern?content.ships.filter((ship)=>pattern.test(ship.display_name)).map((ship)=>ship.canonical_id):[];
    return mapped('mapped_type_slot',{slot_id:visualId('visual.ship_type',entry.display_name),binding_ids:bindings,usage_interfaces:'航海|船只|海上事件',mapping_reason:'绑定船型或海上事件视觉槽位；同一船型可服务多个正式船只。'});
  }
  const typedMatches=typedEntityMatches(entry,entities);
  if(typedMatches.length)return mapped('mapped_name_family',{canonical_id:typedMatches.length===1?typedMatches[0]:null,family_id:visualId('visual.family',entry.display_name),binding_ids:typedMatches,usage_interfaces:usesFor(entry,'family'),mapping_reason:'按名称与类型绑定全部一致实体。'});
  if(GENERIC_TYPE_NAMES.has(entry.display_name))return mapped('mapped_type_slot',{slot_id:visualId('visual.slot.gameplay',entry.display_name),family_id:visualId('visual.family',entry.display_name),usage_interfaces:genericUses(entry.display_name),mapping_reason:'绑定已确认的装备、航海或宝藏视觉类型槽位，不创建缺失实体。'});
  return mapped('mapped_type_slot',{slot_id:visualId('visual.slot.gameplay',entry.display_name),usage_interfaces:usesFor(entry,'type'),mapping_reason:'绑定现有玩法类别的视觉槽位，不创建游戏事实实体。'});
}

function taskReference(entry,content,reason){const base=entry.display_name.replace(/·[^·]+$/,'');const refs=content.tasks.filter((task)=>JSON.stringify(task).includes(base)).map((task)=>task.canonical_id);
  return mapped('mapped_task_reference',{visual_reference_id:visualId('visual.task_item',entry.display_name),task_reference_ids:refs,usage_interfaces:'任务|背包|奖励|特殊场景',mapping_reason:reason});}
function typedEntityMatches(entry,entities){const expected=entry.category==='equipment'?'equipment':entry.category==='item'?'content_entities':null;
  return entities.filter((entity)=>entity.display_name===entry.display_name&&(!expected||entity.entity_kind===expected)).map((entity)=>entity.canonical_id);}
function mapped(mapping_status,value){return {mapping_status,...value};}
function genericUses(name){if(/帆船|船锚|航海|海军/.test(name))return '航海|船只|背包';if(/箱|袋|金币/.test(name))return '奖励|背包|商店';return '装备|背包|战斗|奖励';}
function usesFor(entry,kind){const uses=[];if(['quest_item','item','treasure','关键任务物/宝藏'].includes(entry.category))uses.push('任务','背包','奖励');
  if(entry.category==='equipment'||/装备|衣|冠|盔|靴|刃|匕首|腰带|戒指/.test(entry.display_name))uses.push('装备','背包','战斗');
  if(entry.category==='怪物')uses.push('战斗','任务');if(['NPC','功能NPC'].includes(entry.category))uses.push('NPC','对话');
  if(['船只','船只/地点事件','航海事件图'].includes(entry.category))uses.push('航海','船只');if(entry.category==='地点插图')uses.push('地点','地图');
  if(entry.category==='UI功能图标'||kind==='interface')uses.push('对应功能页');return [...new Set(uses.length?uses:['背包','奖励'])].join('|');}
function visualId(prefix,name){return `${prefix}.${crypto.createHash('sha256').update(String(name)).digest('hex').slice(0,16)}`;}
function parseExplicitCanonicalId(filename){return filename.match(/__(entity\.[A-Za-z0-9_.-]+?)(?:__(?:rare_glow|drop_flash))?__v\d+\.png$/)?.[1]??null;}
function interfaceSceneSlot(entry,index){if(entry.category==='航海事件图')return `visual.slot.maritime_event.${String(index+1).padStart(3,'0')}`;
  if(entry.category==='地点插图')return `visual.slot.location_scene.${String(index+1).padStart(3,'0')}`;
  if(entry.source_batch==='batch07'&&['威尼斯港口','阿拉伯港市','中国海港','暴风海域','宝藏岛','远洋灯塔'].includes(entry.display_name))return `visual.slot.world_scene.${String(index+1).padStart(3,'0')}`;return null;}
function assetVariant(filename){return filename.includes('__rare_glow__')||filename.includes('稀有版')?'rare_glow':filename.includes('__drop_flash__')?'drop_flash':'base';}
function dedupeEntities(values){return [...new Map(values.filter((entry)=>entry?.canonical_id&&entry?.display_name).map((entry)=>[entry.canonical_id,entry])).values()];}
function countBy(values,key){return Object.fromEntries([...new Set(values.map((entry)=>entry[key]))].sort().map((value)=>[value,values.filter((entry)=>entry[key]===value).length]));}
function assertFile(file){if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw new Error(`Required file missing: ${file}`);}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`,'utf8');}
function writeCsv(file,values,headers){fs.mkdirSync(path.dirname(file),{recursive:true});const rows=[headers.join(','),...values.map((value)=>headers.map((header)=>csvCell(value[header]??'')).join(','))];fs.writeFileSync(file,`${rows.join('\n')}\n`,'utf8');}
function csvCell(value){const text=Array.isArray(value)?value.join('|'):String(value);return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}
function parseCsv(text){const rows=[];let row=[];let cell='';let quoted=false;for(let index=0;index<text.length;index+=1){const char=text[index];if(quoted){if(char==='"'&&text[index+1]==='"'){cell+='"';index+=1;}else if(char==='"')quoted=false;else cell+=char;}else if(char==='"')quoted=true;else if(char===','){row.push(cell);cell='';}else if(char==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=char;}if(cell||row.length){row.push(cell);rows.push(row);}const headers=rows.shift().map((value)=>value.replace(/^\uFEFF/,''));return rows.filter((values)=>values.some(Boolean)).map((values)=>Object.fromEntries(headers.map((header,index)=>[header,values[index]??''])));}

if(require.main===module)main();
module.exports={main,parseExplicitCanonicalId,parseCsv,resolveMapping};
