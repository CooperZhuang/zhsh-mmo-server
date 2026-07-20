'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.resolve(__dirname,'..');
const registry=JSON.parse(fs.readFileSync(path.join(root,'web','generated','authoritative-assets.json'),'utf8'));

test('all 229 authoritative single PNG assets are packaged without overview or deprecated files',()=>{
  assert.equal(registry.authoritative_asset_count,229);
  assert.equal(registry.assets.length,229);
  assert.equal(new Set(registry.assets.map((entry)=>entry.sha256)).size,229);
  assert.equal(registry.assets.some((entry)=>/overview|not_included/i.test(entry.source_file)),false);
  for(const entry of registry.assets){
    const file=path.join(root,'web',...entry.target_resource_path.split('/'));
    assert.equal(fs.existsSync(file),true,entry.target_resource_path);
    assert.equal(fs.statSync(file).size>0,true,entry.target_resource_path);
  }
});

test('all authoritative assets have a truthful entity, family, slot, variant, or task-reference mapping',()=>{
  const allowed=new Set(['mapped_explicit_canonical','mapped_name_family','mapped_interface_slot','mapped_type_slot','mapped_variant_family','mapped_task_reference']);
  assert.equal(registry.mapped_count,229);assert.equal(registry.unmapped_count,0);
  assert.equal(registry.runtime_mapped_count,229);assert.equal(registry.catalog_only_unmapped_count,0);
  assert.equal(registry.assets.every((entry)=>allowed.has(entry.mapping_status)),true);
  assert.equal(registry.assets.every((entry)=>entry.canonical_id||entry.family_id||entry.slot_id||entry.visual_reference_id),true);
  assert.equal(registry.assets.every((entry)=>entry.usage_interfaces&&entry.mapping_reason),true);
  assert.equal(new Set(registry.assets.map((entry)=>entry.target_resource_path)).size,229);
  assert.equal(registry.assets.filter((entry)=>entry.mapping_status==='mapped_interface_slot'&&entry.category==='UI功能图标').length,12);
  const rare=registry.assets.filter((entry)=>entry.mapping_status==='mapped_variant_family');
  assert.equal(rare.length,9);
  for(const entry of rare)assert.ok(registry.assets.some((candidate)=>candidate.family_id===entry.family_id&&candidate.variant==='base'),entry.display_name);
  const unmapped=fs.readFileSync(path.join(root,'docs','design','authoritative-asset-unmapped.csv'),'utf8').trim().split(/\r?\n/);
  assert.equal(unmapped.length,1,'unmapped CSV must contain only its header');
});

test('player UI resolves families and references without exposing mapping statistics',()=>{
  const app=fs.readFileSync(path.join(root,'web','app.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'web','index.html'),'utf8');
  const css=fs.readFileSync(path.join(root,'web','styles.css'),'utf8');
  assert.match(app,/authoritative-assets\.json/);
  for(const page of ['renderStart','renderLocationPage','renderNpcPage','renderTaskDetailPage','renderBackpackPage','renderFormalEncounterPage','renderFormalShopPage','renderFormalVoyagePage','renderCompendiumPage'])assert.match(app,new RegExp(page));
  assert.match(app,/binding_ids/);assert.match(app,/task_reference_ids/);assert.match(app,/visualForMaritimeEncounter/);
  for(const forbidden of ['已接入229','绑定118','未绑定111','权威美术图鉴','经典手机版等价复原','非像素级原版复刻','候选版素材展示'])assert.equal(app.includes(forbidden)||html.includes(forbidden),false,forbidden);
  assert.doesNotMatch(css,/object-fit:\s*cover/);assert.match(css,/object-fit:contain/);assert.match(css,/image-rendering:pixelated/);assert.match(css,/image-rendering:crisp-edges/);
  assert.match(app,/debugEnabled\?'<button class="text-link nav-link" data-page="compendium"/);
});
