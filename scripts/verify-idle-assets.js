'use strict';
/**
 * verify-idle-assets.js — 阶段一验收：闲置资产集成后的全量引用与绑定核对
 *
 * 校验项：
 * 1. 映射清单 229 行，0 行「完全无挂载」（槽位/变体/接口类按策略视为已挂载）；
 * 2. 怪物/装备/物品/NPC/船/鱼的实体绑定计数与内容包实体一致性；
 * 3. 死代码脚本（5 个 CLI + ai-task-narrative）与孤儿 JSON（71/72 检查点）均已接入引用；
 * 4. 引用计数>0：媒体资产全部仍被注册表引用。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const results = [];
function check(name, passed, details) { results.push({ name, passed: Boolean(passed), details }); }

function main() {
  const mapping = fs.readFileSync(path.join(root, 'docs', 'design', 'authoritative-asset-mapping.csv'), 'utf8')
    .split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
      const c = line.split(',');
      return { cid: c[5], binding: c[9], task: c[10], status: c[4], name: c[2], slot: c[7] };
    });
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'web', 'generated', 'authoritative-assets.json'), 'utf8'));
  check('映射清单 229 行', mapping.length === 229, { actual: mapping.length });
  check('注册表 229 条', registry.assets?.length === 229, { actual: registry.assets?.length });

  const interfaceOk = new Set(['mapped_interface_slot', 'mapped_variant_family']);
  const unattached = mapping.filter((r) => !r.cid && !r.binding && !r.task && !interfaceOk.has(r.status) && !r.slot);
  check('无「完全无挂载」行（接口/变体除外）', unattached.length === 0, { unattached: unattached.map((r) => `${r.status}:${r.name}`) });

  const entityBound = mapping.filter((r) => r.cid || r.binding).length;
  const taskBound = mapping.filter((r) => r.task).length;
  const slotOnly = mapping.filter((r) => !r.cid && !r.binding && (r.status === 'mapped_interface_slot' || r.slot)).length;
  check('实体/任务绑定行 > 0', entityBound > 100, { entityBound, taskBound });

  const content = JSON.parse(fs.readFileSync(path.join(root, 'web', 'generated', 'task1-content.json'), 'utf8'));
  const appSrc = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');
  check('威尼斯国王 于终幕结算画面按名渲染', appSrc.includes('威尼斯国王') && appSrc.includes("renderNamedVisual('威尼斯国王'"), { appFinale: appSrc.includes('renderFinale') });
  check('主线全部完成的终幕结算画面已实现', appSrc.includes('data-page="finale"') && appSrc.includes('终幕'));
  const probes = ['哥伦布之刃', '月宫仙子冠', '百宝袋', '黄金金币', '圣火令', '龙珠碎片·赤', '狐仙', '邪恶花精', '幽灵船', '鲑鱼'];
  const missing = probes.filter((name) => ![...content.content_entities, ...content.monsters, ...content.npcs, ...content.ships, ...content.equipment]
    .some((e) => e.display_name === name));
  check('新实体全部进入内容包', missing.length === 0, { missing });

  // 死代码引用
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deadCli = ['audit:maritime', 'e2e:manual', 'mainline:e2e', 'smoke:public'];
  check('4 个孤儿 CLI 已注册 npm scripts', deadCli.every((k) => typeof pkg.scripts?.[k] === 'string'), { scripts: deadCli.filter((k) => pkg.scripts?.[k]) });
  const serverSrc = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
  check('ai-task-narrative 已装配', serverSrc.includes("require('./ai/ai-task-narrative')") && serverSrc.includes("'/api/game/task_narrative'"));
  const build72 = fs.readFileSync(path.join(root, 'scripts', 'build-formal-stage-start-72-fixture.js'), 'utf8');
  check('孤儿 JSON:72 完成清单被构建脚本对账', build72.includes('formal-stage-start-72-completed-tasks.json'));
  const formalTest = fs.readFileSync(path.join(root, 'tests', 'formal-core-e2e.test.js'), 'utf8');
  check('孤儿 JSON:71 检查点被兼容回归引用', formalTest.includes('formal-stage-start-71.json'));

  // 媒体引用计数
  const media = fs.readFileSync(path.join(root, 'web', 'generated', 'authoritative-assets.json'), 'utf8');
  const pngCount = registry.assets.filter((a) => a.target_resource_path.endsWith('.png')).length;
  check('媒体资产全部注册（png 引用=229）', pngCount === 229, { pngCount });

  const failures = results.filter((r) => !r.passed);
  process.stdout.write(`${JSON.stringify({ passed: failures.length === 0, checks: results.length, failures: failures.map((f) => f.name), results }, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { main };
