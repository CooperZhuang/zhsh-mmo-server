'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchEdge } = require('../browser-tests/edge-cdp.js');

async function requireOk(url, expectedType) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} returned ${response.status}`);
  if (expectedType) assert.match(response.headers.get('content-type') || '', expectedType, `${url} content type`);
  return response;
}

async function main() {
  const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:8000/');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhsh-public-smoke-'));
  let page;
  try {
    await requireOk(baseUrl, /text\/html/);
    await requireOk(new URL('app.js', baseUrl), /javascript/);
    await requireOk(new URL('styles.css', baseUrl), /text\/css/);
    const registryResponse = await requireOk(new URL('generated/authoritative-assets.json', baseUrl), /json/);
    const registry = await registryResponse.json();
    assert.equal(registry.authoritative_asset_count, 229);
    assert.equal(registry.mapped_count, 229);
    assert.equal(registry.unmapped_count, 0);
    const requiredCategories = ['NPC', '怪物', 'quest_item', 'equipment', '船只', '宠物/鱼类'];
    for (const category of requiredCategories) assert.ok(registry.assets.some((asset) => asset.category === category), `missing ${category}`);
    const assetChecks = await Promise.all(registry.assets.map(async (asset) => {
      const response = await requireOk(new URL(asset.target_resource_path, baseUrl), /image\/png/);
      return response.arrayBuffer();
    }));
    assert.equal(assetChecks.length, 229);

    page = await launchEdge({
      profileDirectory: path.join(temporaryRoot, 'profile'),
      downloadRoot: path.join(temporaryRoot, 'downloads'),
    });
    await page.navigate(baseUrl.href);
    await page.waitFor(() => document.querySelector('[data-action="new-game"]'));
    assert.equal(await page.evaluate(`document.title`), '纵横四海');
    const startArt = await page.evaluate(`(()=>{const image=document.querySelector('.start-art');const style=getComputedStyle(image);return {loaded:image.complete&&image.naturalWidth===64&&image.naturalHeight===64,fit:style.objectFit,rendering:style.imageRendering};})()`);
    assert.equal(startArt.loaded, true);
    assert.equal(startArt.fit, 'contain');
    assert.match(startArt.rendering, /pixelated|crisp-edges/);
    await page.click('[data-action="new-game"]');
    await page.waitFor(() => document.body.dataset.page === 'location');
    assert.equal(await page.countVisible('[data-page="compendium"]'), 0);
    const publicText = await page.text('body');
    for (const forbidden of ['229', '权威美术图鉴', '经典手机版等价复原', '图像调试']) assert.equal(publicText.includes(forbidden), false, `public UI contains ${forbidden}`);

    await page.navigate(`${baseUrl.href}?dev=1`);
    await page.waitFor(() => document.querySelector('[data-action="continue-game"]'));
    await page.click('[data-action="continue-game"]');
    await page.waitFor(() => document.body.dataset.page === 'location');
    await page.click('[data-page="compendium"]');
    await page.waitFor(() => document.body.dataset.page === 'compendium');
    await page.evaluate(`document.querySelectorAll('details').forEach((entry)=>entry.open=true)`);
    const rendered = await page.waitFor(`document.querySelectorAll('.asset-grid img').length`, { label: '229 authoritative image elements' });
    assert.equal(rendered, 229);
    for (const category of requiredCategories) {
      const asset = registry.assets.find((entry) => entry.category === category);
      const source = asset.target_resource_path;
      await page.evaluate(`(()=>{const image=document.querySelector(${JSON.stringify(`.asset-grid img[src="${source}"]`)});image.scrollIntoView({block:'center'});return true;})()`);
      const display = await page.waitFor(`(()=>{const image=document.querySelector(${JSON.stringify(`.asset-grid img[src="${source}"]`)});if(!image?.complete||image.naturalWidth!==64||image.naturalHeight!==64)return false;const style=getComputedStyle(image);return {fit:style.objectFit,rendering:style.imageRendering};})()`, { label: `${category} image` });
      assert.equal(display.fit, 'contain');
      assert.match(display.rendering, /pixelated|crisp-edges/);
    }
    assert.deepEqual(page.console, []);
    assert.deepEqual(page.networkErrors, []);
    console.log(JSON.stringify({
      launcher_url: baseUrl.href,
      http_assets: assetChecks.length,
      browser_assets: rendered,
      public_debug_entry: false,
      pixel_scaling: 'contain + pixelated',
      console_errors: 0,
      network_errors: 0,
      result: 'passed',
    }, null, 2));
  } finally {
    if (page) await page.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
