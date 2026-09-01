'use strict';
/**
 * generate-story-chapters.js — 生成本项目主线章卷组织（参考《潮汐纪事》STORY_CHAPTERS/VOLUMES）
 *
 * 输入：task_series + 各系列任务范围。
 * 输出：server/content/story-chapters.json（章列表 + 卷分组），供 export 时读入 content。
 * 章 = 叙事化标题（基于系列名 + 起止任务）；卷 = 系列聚类（每 3-4 系列一卷）。
 */
const path = require('node:path');
const fs = require('node:fs');
const { PROJECT_ROOT, openDatabase, stableJson } = require('../src/data/database');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite');
const OUT_PATH = path.join(PROJECT_ROOT, 'server', 'content', 'story-chapters.json');

// 系列 → 叙事章标题（参考原版主线剧情，可人工精修）
const CHAPTER_TITLE = {
  '威尼斯新手成长': '第一章 · 威尼斯新手成长',
  '威尼斯早期地区任务': '第二章 · 威尼斯早期地区',
  '海盗与港口事件': '第三章 · 海盗与港口事件',
  '北海及各地区任务': '第四章 · 北海与各地区',
  '东亚—印度洋地区任务': '第五章 · 东亚与印度洋',
  '通商—圣火令—亚丁—龙珠候选链': '第六章 · 通商与圣火令',
  '亚丁与龙珠后续地区任务': '第七章 · 亚丁与龙珠',
  '寻裔之路': '第八章 · 寻裔之路',
};
const VOLUME_TITLE = {
  '第一卷 · 沉浮与路': ['威尼斯新手成长', '威尼斯早期地区任务', '海盗与港口事件'],
  '第二卷 · 四海商路': ['北海及各地区任务', '东亚—印度洋地区任务'],
  '第三卷 · 圣火与龙珠': ['通商—圣火令—亚丁—龙珠候选链', '亚丁与龙珠后续地区任务'],
  '第四卷 · 寻裔之海': ['寻裔之路'],
};

function main() {
  const db = openDatabase(DB_PATH);
  const rows = db.prepare(`
    SELECT s.canonical_id,s.display_name,COUNT(t.id) count,MIN(t.sequence_position) first,MAX(t.sequence_position) last
    FROM task_series s LEFT JOIN task_definitions t ON t.task_series_id=s.id
    GROUP BY s.id ORDER BY s.canonical_id`).all();
  // 按章标题合并：同名系列的多个 series 归并为同一叙事章（累计任务数、展开系列列表）
  const byTitle = new Map();
  for (const row of rows) {
    const title = CHAPTER_TITLE[row.display_name] ?? row.display_name;
    if (!byTitle.has(title)) byTitle.set(title, { title, series_canonical_ids: [], series_display_names: [], task_count: 0, task_sequence_start: Number(row.first ?? 0), task_sequence_end: Number(row.last ?? 0) });
    const entry = byTitle.get(title);
    entry.series_canonical_ids.push(row.canonical_id);
    entry.series_display_names.push(row.display_name);
    entry.task_count += Number(row.count);
    entry.task_sequence_start = Math.min(entry.task_sequence_start, Number(row.first ?? 0));
    entry.task_sequence_end = Math.max(entry.task_sequence_end, Number(row.last ?? 0));
  }
  const chapters = [...byTitle.values()];
  const volumes = Object.entries(VOLUME_TITLE).map(([title, seriesNames]) => ({
    title,
    chapter_series: seriesNames.filter((name) => rows.some((row) => row.display_name === name)),
  }));
  const output = { version: 1, chapters, volumes };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${stableJson(output)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, chapters: chapters.length, volumes: volumes.length, out: OUT_PATH }, null, 2)}\n`);
  try { db.close(); } catch {}
}

if (require.main === module) main();
module.exports = { main };
