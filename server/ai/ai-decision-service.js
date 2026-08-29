'use strict';
/**
 * 纵横四海 · 统一 AI 决策服务
 *
 * 封装本地 ollama（qwen3.5:9b）的调用，供各系统决策层复用，把 AI 注入整个游戏：
 *   - 世界经济事件生成（ai-decision）
 *   - AI 玩家行为决策（ai-players）
 *   - 世界情报/市场分析摘要（经济系统向玩家提供的信息）
 *   - 战斗 NPC/世界播报叙述生成
 *
 * 核心约定：所有 aiDecide 均接受"当前状态上下文"，输出结构化对象；
 * 解析失败或超界由各调用方规则层保底（决不让 AI 失败导致系统不可用）。
 */
const http = require('node:http');

const OLLAMA_URL = process.env.ZHSH_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.ZHSH_AI_MODEL || 'qwen3.5:9b';

/** 唤起 ollama 生成，返回原始响应文本 */
function ollamaGenerate(prompt, { format = null, temperature = 0.8, maxTokens = 300, system = null } = {}) {
  const body = { model: MODEL, prompt, stream: false, options: { temperature, max_tokens: maxTokens, think: false } };
  if (system) body.system = system;
  if (format) body.format = format;
  return new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/generate', OLLAMA_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data).response ?? ''); } catch (err) { reject(new Error(`ollama parse: ${err.message}`)); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** 唤起 ollama 并解析 JSON 对象（剥离 markdown 代码块） */
async function ollamaJson(prompt, opts = {}) {
  const raw = await ollamaGenerate(prompt, { ...opts, format: 'json' });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('ollama did not return a JSON object');
  return JSON.parse(m[0]);
}

/** 当前模型是否可用 */
function ping() {
  return new Promise((resolve) => {
    const req = http.request(new URL('/api/tags', OLLAMA_URL), { method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d).models?.some((m) => m.name === MODEL)); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * 安全的 JSON 决策：调用 aiDecide（async 函数）并规范化；任何失败返回 fallback。
 * 供各系统保底使用，保证 AI 错误不破坏游戏。
 */
async function safeJsonDecide(aiDecide, context, fallback) {
  if (typeof aiDecide !== 'function') return fallback;
  try { const result = await aiDecide(context); return (result && typeof result === 'object') ? result : fallback; }
  catch { return fallback; }
}

module.exports = { ollamaGenerate, ollamaJson, safeJsonDecide, ping, MODEL, OLLAMA_URL };
