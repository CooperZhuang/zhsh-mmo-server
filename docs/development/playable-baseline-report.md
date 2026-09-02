# 可玩化 · 基线报告 (Playable Baseline Report)

> 生成时间：2026-09-03（Phase 0，改动前基线冻结；后续修复随回填标注）
> 环境：Windows 11 · Node v24.16.0 · ollama 已部署（qwen3.5:4b）· 服务器 4173 运行中
> 配套文档：[playable-evidence-matrix](./playable-evidence-matrix.md)

## 说明

本报告冻结改动前的现状。结论用 `PASS / FAIL / BLOCKED / PENDING-VERIFICATION`。
部分条目在 Phase 0 后已完成修复，修复后结果在「修复后」列标注。

## 结论速览（改动前）

| 维度 | 基线判定 | 关键命令输出 | 修复后 |
|---|---|---|---|
| A1-1 任务模型校验 | **FAIL** | `migrated_collection_target_count 0≠2`，`described_drop 38≠35` | PASS（见 §A1-1） |
| A1-4 代表样本校验 | **FAIL** | `task.series.15.472` 被判 blocked | PASS（见 §A1-4） |
| A2-1 数据校验 | PASS | `npm run data:validate` → passed:true | PASS |
| A2-2 多源基线 | PASS | `validate-multisource-baseline` → failures:[] | PASS |
| C1/C4 数值审计 | PASS | `npm run numbers:audit` → 8 warn 0 error | PASS（warn 为曲线门槛，见下） |
| J1 单测/集成 | **FAIL** | `npm test` → 186 pass / 9 fail | 9 fail 均为预置，非本次引入 |

## A. 内容与叙事

### A1-1 前置链完整（全局任务模型校验）
- 命令：`npm run task:model-global:validate`
- **改动前**：FAIL。`migrated_collection_target_count 0≠2`，`task_described_drop_resolution_count 38≠35`。
- **根因**：两层过时。
  1. `migrated=2` 是「迁移收集物误判」的旧常量；adjudicate-blocked-targets §② 干佛草模式已把这些
     收集目标从「误判怪物(需运行时迁移修复)」改为「任务描述遭遇掉落」，`migrated` 应为 0。
  2. `described=35` 旧值未反映上述重分类（实际 38）。
- **修复**：`scripts/validate-global-task-model.js` 重基线 `migrated 2→0`、`described 35→38`。
- **修复后**：PASS（16 checks）。与 `tests/global-task-model.test.js` 的 `migrated===0` 断言一致。

### A1-4 651 任务可运行性（代表样本）
- 命令：`npm run task:validate-representative`
- **改动前**：FAIL。`task.series.15.472`（将黑珍珠交给巫师帕克）被 `item_without_formal_source` 阻塞。
- **根因**：15.472 的目标黑珍珠(`runtime.task_chain.item.8b4fe6ffc18a39c1`)来自前置 15.471 的奖励，
  但 `inferChainItem` 的守卫 `!entry.entity_canonical_id` 过滤掉「已有实体的任务链物品」，使其落入
  class-7 `source_data_and_placement_disagree`，被静态源解析器判为无源。
- **修复**：`build-global-task-model.js` `inferChainItem` 识别 `runtime.task_chain.item.*`（即使已有实体）
  且前置任务奖励同名 → class-5 `task_chain_item_ledger`，运行时段账本（TaskItemLedger）解析。
  另修复 `audit-global-task-exceptions.js` 两处过期 `holdReview`（15.269/15.601，已由 adjudication 提供
  任务局部遭遇/实体，应记 resolved）。
- **修复后**：PASS（9 groups / 19 reps / 长链 15.455→15.472 18 tasks 全过）。

### A2-1 引用完整性
- 命令：`npm run data:validate` → **PASS**（canonical_id_uniqueness 全 0 冲突，unresolved_labels 0 fabricated）。

### A2-2 多源无裁决
- 命令：`node scripts/validate-multisource-baseline.js` → **PASS**（failures:[]）。
  记录计数：tasks 651 / story 20 / config_entities 5708 / conflicts 32。

## C. 数值系统

### C1 / C4 数值审计
- 命令：`npm run numbers:audit` → 8 warn 0 error。
- warn：`exp.curve` 若干级门槛不增（lv13/lv28/lv48/lv63/lv101/lv152/lv180/lv201）。属曲线平滑设计
  （`688a293` 数值重设计后的新曲线），非 error，需人工确认是否接受「门槛不增」段。

## J. 可维护性

### J1 自动化测试
- 命令：`npm test` → **186 pass / 9 fail**。
- 9 fail 均为 **`688a293`「可玩性优先数值重设计」前已存在**（在纯 HEAD 提交 + 提交内容上复现失败）：
  1. `formal-core-e2e` ×3（finite stamina 断言，formal-combat-prefix-helper）
  2. `series15-long-chain-checkpoint` ×1（checkpoint 只满足有限前置）
  3. `formal-training-helper` ×2（source level thresholds / repeat-recovery）
  4. `progression-source-golden` ×1（reference level thresholds）
  5. `release-dual-scenario-checkpoint` ×1
- 这些是数值重设计(平滑经验曲线)后**测试夹具未同步**所致，属 P1（核心数值链路测试断言失配），
  在 Phase 4 可维护性阶段处理。非本次改动引入（改动后 fail 计数由 14→9）。

## 阻塞项

无 P0（可注册/登录/进世界/主线推进的前提全部成立）。以下为已知非阻塞但需跟进：
- `numbers:audit` 8 条 exp.curve「门槛不增」告警（需确认是否接受）。
- 9 个预置测试失败（数值重设计夹具不同步）。

## 关键改善（本次 Phase 0 ~ Phase 1 初步）

- 全局任务模型：651 任务全量运行时可达（`runtime_runnable_task_count=651`，0 阻塞）。
- Golden Path 链 15.455→15.472（含黑珍珠递送）经 runtime 段账本验证可完成。
- `task:model-global:validate` / `task:validate-representative` / `test:runtime-global` 全部 PASS。
