'use strict';
/**
 * generate-task-story.js — 为任务补剧情化目标 story 层（幂等）
 *
 * 依据：docs/design/external-gameplay-targets-plan.md 叙事层方案（参考《潮汐纪事》STORY_CHAPTERS 文风）
 * 目标：给 task_definitions.normalized_value_json 写 story（一句剧情化目标），
 *       作为 exporter 导出时任务叙事层（区别于原版台词 dialogues）。
 *
 * story 生成规则（基于原版 receive 对话 + 章节 + 目标）：
 *  - 取第一条「非玩家('你：')」的 receive 对话，提取委托人 + 委托内容作上下文；
 *  - story = 「{章节}·{目标}：{委托者}的{display_name}」一类的剧情化目标；
 *  - 若无语境，回退为「{display_name}」的目标化叙述。
 */
const path = require('node:path');
const { PROJECT_ROOT, openDatabase, stableJson } = require('../src/data/database');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite');

const CHAPTER_BY_SERIES = {};
function storyFor(task, receiveLines, chapter) {
  // 取第一条非玩家委托对话
  const line = receiveLines.find((text) => !/^你[:：]/.test(text));
  const title = task.display_name ?? task.canonical_id;
  if (!line) return `${chapter}，${title}。`;
  // 去掉「委托人：」前缀，保留委托内容
  const content = line.replace(/^[^:：]{1,12}[:：]\s*/, '').replace(/[。！？!?]$/, '');
  // 剧情化：以委托内容为目标叙述（截断到合理长度）
  const goal = content.length > 26 ? content.slice(0, 26) + '…' : content;
  return `${chapter}，${goal}。`;
}

function main() {
  const db = openDatabase(DB_PATH);
  const stats = { inserted: 0, updated: 0, skipped: 0 };
  const seriesMap = db.prepare('SELECT id,canonical_id,display_name FROM task_series').all();
  const seriesById = new Map(seriesMap.map((s) => [s.id, s.display_name]));
  const tasks = db.prepare(`
    SELECT td.id, td.canonical_id, td.display_name, td.task_series_id, td.normalized_value_json
    FROM task_definitions td ORDER BY td.id`).all();
  const dialogueByTask = new Map();
  for (const line of db.prepare(`SELECT task_id, original_text FROM task_dialogues WHERE phase='receive' ORDER BY task_id, line_order`).all()) {
    if (!dialogueByTask.has(line.task_id)) dialogueByTask.set(line.task_id, []);
    dialogueByTask.get(line.task_id).push(line.original_text);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const task of tasks) {
      const chapter = seriesById.get(task.task_series_id) ?? '世界';
      const normalized = task.normalized_value_json ? JSON.parse(task.normalized_value_json) : {};
      if (typeof normalized !== 'object' || normalized === null) continue;
      const story = storyFor(task, dialogueByTask.get(task.id) ?? [], chapter);
      if ((normalized.story ?? '') === story) { stats.skipped += 1; continue; }
      normalized.story = story;
      db.prepare('UPDATE task_definitions SET normalized_value_json=? WHERE id=?').run(stableJson(normalized), task.id);
      stats.inserted += 1;
    }
    db.exec('COMMIT');
    process.stdout.write(`${JSON.stringify({ ok: true, stats }, null, 2)}\n`);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, stats }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    try { db.close(); } catch {}
  }
}

if (require.main === module) main();
module.exports = { main };
