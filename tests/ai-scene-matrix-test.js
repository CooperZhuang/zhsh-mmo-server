'use strict';
/**
 * AI 场景矩阵测试：为游戏的每一个 AI 调用场景测量速度与质量。
 * 设计严谨：
 *  - 枚举 6 个真实游戏场景（NPC台词/事件播报/市场综述/事件JSON/战斗叙述/AI玩家决策）
 *  - 每个场景用其真实 prompt（从对应 module 提取）
 *  - 串行跑 2b 与 4b，测稳态速度（keep_alive:-1 常驻，预热不计）
 *  - 输出：耗时(稳态) + 是否遵循指令 + 内容贴合度（人工判定用）
 * 仅用于模型选型对比，不进入生产。
 */
const http = require('node:http');
const path = require('node:path');

const MODELS = ['qwen3.8-2b-distill:latest', 'qwen3.8-4b-distill:latest'];
const BASE = { temperature: 0.7, numCtx: 4096 };

function gen(model, prompt, { maxTokens = 120, format = null, system = null, think = false } = {}) {
  const body = { model, prompt, stream: false, think, keep_alive: -1, options: { ...BASE, max_tokens: maxTokens } };
  if (system) body.system = system;
  if (format) body.format = format;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { const j = JSON.parse(d); resolve({ ms: Date.now() - t0, text: j.response ?? '', evalCount: j.eval_count ?? 0 }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// 6 个真实场景
const SCENES = [
  { name: 'NPC情境台词', prompt: '你是文字网游《纵横四海》里的一位NPC（杂货商人）。根据以下情境，说一句40字以内的中文台词，可以提及当前任务、天气、或这个世界正在发生的事。当前：正要处理「找福利官聊聊」，世界天气晴天，正在发生海盗来袭。只输出台词本身。', system: '你是沉浸的文字网游NPC，说一句贴合情境的中文台词。', maxTokens: 60 },
  { name: '事件播报叙述', prompt: '你是《纵横四海》文字网游的世界播报员。为下面的事件写一段80字以内的兴味播报，用中文口语化、略带紧张或喜庆的航海电台风格，开篇可用【海盗来袭】。事件:海盗来袭, 区域:北海, 影响:物价 影响特产, 强度:0.26, 补充:一片海域遭海盗封锁。只输出播报正文。', system: '你是航海世界电台播报员，用简洁生动的中文播报世界事件。', maxTokens: 160 },
  { name: '市场情报综述', prompt: '你是《纵横四海》文字网游的行商顾问。当前世界状态：{"区域天气":{"地中海":"晴天","北海":"风暴"},"区域供需":{"地中海":{"food":1.2,"specialty":0.85},"北海":{"food":0.8,"specialty":1.15}},"正在发生的事件":["海盗来袭（北海·影响特产）"]}。请为玩家写一段120字以内的市场/天气情报，指出套利机会、正在事件、天气建议。用中文口语化叙述，不要输出JSON。', system: '你是经验丰富的航海行商，用精炼中文给出实用情报。', maxTokens: 220 },
  { name: '经济事件JSON', prompt: '你是《纵横四海》文字网游的世界剧情与经济策划。当前世界状态：{"天气":{"地中海":"晴天"},"区域供需":{"地中海":{"food":1.0}},"正在发生":[],"区域列表":["地中海","北海"]}。请构思一件正在世界上发生的事件。只输出一个JSON对象，字段:{"id":"唯一英文id","name":"中文事件名(≤12字)","region":"影响区域(必须来自区域列表)","category":"economy/weather/encounter","effect_kind":"price/supply/weather/discovery","target_field":"food/specialty/material/luxury","strength":-0.3到0.35小数,"duration":2到8整数,"tip":"一句话剧情描述(≤40字)","tag":"事件/天气/遭遇"}。只输出JSON。', system: null, format: 'json', maxTokens: 160 },
  { name: '战斗叙述', prompt: '你是《纵横四海》文字网游的战斗旁白。为下列战斗写一句45字以内的中文叙述，表现凯旋的豪迈，略带航海武侠文风。结果:战斗胜利, 敌人:野狼, 我方等级:1, 剩余体力:80, 战斗回合:3。只输出叙述本身。', system: '你是文字网游战斗旁白，用精炼中文一句话描写战况。', maxTokens: 80 },
  { name: 'AI玩家决策', prompt: '你是《纵横四海》文字网游的一名AI航海家。你的性格：豪爽的远东航主。当前状态：位置酒馆, 等级1, 铜币100, 任务链1个。请给出你接下来的一个最合理行动，只输出一个动作关键字，从下面选择：talk/move/travel/combat/market/recovery/rest。只输出动作关键字。', system: null, maxTokens: 16 },
];

async function unload(model) { try { await gen(model, 'x', { maxTokens: 5 }); } catch {} }

(async () => {
  for (const scene of SCENES) {
    console.log(`\n=== ${scene.name} （maxTokens=${scene.maxTokens}） ===`);
    for (const m of MODELS) {
      try {
        await gen(m, scene.prompt, scene); // 预热
        const r1 = await gen(m, scene.prompt, scene);
        const r2 = await gen(m, scene.prompt, scene);
        const t = (Math.min(r1.ms, r2.ms) / 1000).toFixed(2);
        const out = r1.text.trim().replace(/\s+/g, ' ');
        // 指令遵循判定：是否明显输出思考/越界
        const thinks = /思考|逻辑|分析|推理|步骤|我需要|首先|用户|以下是我/.test(out);
        // JSON 场景判定合法性
        let jsonOk = null;
        if (scene.format === 'json') { try { JSON.parse(out); jsonOk = true; } catch { jsonOk = false; } }
        console.log(`  [${m.replace(':latest', '').padEnd(18)}] 稳态${t}s tokens=${r2.evalCount} ${thinks ? '[含思考]' : '[干净]'}${jsonOk !== null ? (jsonOk ? ' [JSON✓]' : ' [JSON✗]') : ''}`);
        console.log(`     → ${out.slice(0, 70)}`);
      } catch (e) { console.log(`  [${m}] ERR ${e.message}`); }
      await unload(m); // 16G 显存，测完卸载
      await new Promise((r) => setTimeout(r, 500));
    }
  }
})();
