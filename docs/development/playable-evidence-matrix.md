# 真正可玩化 · 证据矩阵（Evidence Matrix）

> 配套文档：[playable-goal-and-acceptance](./playable-goal-and-acceptance.md)
> 本文档是 A–L 各维度的**验收证据采集表**，初始状态一律 `PENDING-VERIFICATION`，
> 由执行者逐项判定并回填 `PASS / FAIL / BLOCKED`。

## 0. 执行协议（执行者 = AI）

1. **执行主体是 AI**：用户只做方向裁决与最终否定；所有证据采集、命令运行、缺省项填补、根因分析均由 AI 完成。
2. **Phase 0 起点**：任何维度修改前，先运行全部基线命令生成 `docs/development/playable-baseline-report.md`，冻结现状。
3. **状态枚举**：仅 `PASS / FAIL / BLOCKED / PENDING-VERIFICATION`。禁止「基本完成 / 大概可以 / 理论支持」等模糊词。
4. **判定规则**：每个条目至少满足「**自动证据**（命令可复现）」或「**真实游玩证据**（可复现操作路径）」其一，核心条目（主线/战斗/数值/经济）须**同时**具备（双轨标准）。
5. **失败处理**：`FAIL` 须给出根因与修复动作；`BLOCKED` 须写明阻塞对象；`PENDING-VERIFICATION` 必须关联裁决文档
   （`docs/design/blocked-targets-adjudication.md`），不得作为静默绕过。
6. **证据产物**：每个 PASS 附录以下可追溯物之一：测试输出、审计输出、e2e 存档、日志摘录、通关记录。
7. **输出节奏**：A–L 每维度可独立推进；完成后在 §最终汇总 记录 PASS/FAIL/Skipped/已知问题。

---

## A. 内容与叙事

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| A1-1 task.series.01–15 前置链完整 | 全局任务模型校验，检查前置合法、无循环、图可达 | `npm run task:model-global:validate` | 校验输出 | PENDING-VERIFICATION |
| A1-2 任务图可达（每条任务有获取路径） | 运行全局阻塞分析，列出不可达/悬挂节点 | `npm run task:analyze-blockers` | 阻塞清单 | PENDING-VERIFICATION |
| A1-3 主线可执行性 | 主线级 e2e / 求解器跑通 | `npm run mainline:e2e` | 运行输出 | PENDING-VERIFICATION |
| A1-4 651 条常规任务运行性 | 任务矩阵生成 + 代表样本校验 | `npm run task:matrix`（及 `task:matrix:development`）、`npm run task:validate-representative` | playability matrix | PENDING-VERIFICATION |
| A2-1 引用完整性（ID 均存在） | 数据校验（内容库） | `npm run data:validate` | 校验输出 | PENDING-VERIFICATION |
| A2-2 无字段错位 / 同内容多来源无裁决 | 多源基线校验 | `node scripts/validate-multisource-baseline.js` | 校验输出 | PENDING-VERIFICATION |
| A5-1 内容保真回归（原作数值不受改） | 原作快照 vs 当前内容 diff，差异必须分类 | 内容完整性审计（在 `data:validate` 基础上扩展 + Fidelity diff） | fidelity diff | PENDING-VERIFICATION |

## B. 核心玩法闭环（真实触发）

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| B1 战斗（含状态/套装/宠物/掉落） | 战斗包 e2e + 存活递增 e2e + 数值审计 | `npm run package:combat-survival`、`npm run test:browser-dom:combat-survival-incremental`、`npm run evidence:combat-survival-summary` | e2e + 汇总 | PENDING-VERIFICATION |
| B2 航海 / 船只 / 港口 / 货物 | 航海能力审计 + 海事 e2e | `npm run audit:maritime`、`npm run test:browser-dom:maritime-incremental` | 审计 + e2e | PENDING-VERIFICATION |
| B3 市场贸易（买入→装载→航海→卖→利润） | 贸易运行时测试 + 市场价差审计 | `npm run test`（含 `tests/trade-runtime.test.js`）、`npm run numbers:audit` | 测试输出 + 审计 | PENDING-VERIFICATION |
| B4 探索 / 发现物 / 声望 / 爵位 | 发现物 e2e + 声望进度审计 | `npm run test:browser-dom`（探索阶段） | e2e 日志 | PENDING-VERIFICATION |
| B5 成长（装备/强化/技能/宠物/船员/船只） | 装备战斗包 + 前缀递增 e2e | `npm run package:equipment-combat`、`npm run test:browser-dom:equipment-incremental`、`npm run evidence:equipment-combat-summary` | 包 + e2e + 汇总 | PENDING-VERIFICATION |
| B6 商会 / 占城 / 钓鱼 / 潜水 / 地牢 | 逐个真实触发（browser e2e 或手动存档路径），确认非仅"代码存在" | browser e2e（钓鱼/潜水/地牢/商会阶段）+ 服务端 API 通关 | e2e 存档 | PENDING-VERIFICATION |

## C. 数值系统

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| C0 数值基线单一事实源 | 把代码/Excel/文档/测试锚点集中到 `design/numbers/gameplay-numbers.xlsx`；新增数值必须引用 | `npm run numbers:import:dry`（校验可导入）、`npm run numbers:export` | xlsx + 校验输出 | PENDING-VERIFICATION |
| C1 成长曲线健康 | 数值审计（怪物奖励/装备阶梯/exp 曲线/required_level） | `npm run numbers:audit` | 审计输出 | PENDING-VERIFICATION |
| C2 战斗数值自洽 | 战斗求解 + 存活 e2e 验证"正常发育能击败目标" | `npm run package:combat-survival`、`npm run numbers:audit` | 求解 + 审计 | PENDING-VERIFICATION |
| C3 数值锚定纪律 | 新增/吸收内容核对绝对值服从本地基准、比例沿用来源 | 吸收校验（`node scripts/verify-idle-assets.js`、吸收文档）+ `numbers:audit` | 校验输出 | PENDING-VERIFICATION |
| C4 数值验证自动化扩展 | 把 C1/C2/C3 检查并入 `audit-gameplay-numbers.js` 并纳入测试 | `npm run numbers:audit`（扩展后） | 审计输出 | PENDING-VERIFICATION |
| C5 平衡方法论 | 内存级全主线求解器 + 服务端 API 通关 + 真实浏览器游玩三层验证 | 求解器脚本 + `npm run test` + browser e2e | 三层输出 | PENDING-VERIFICATION |
| C6 成长可达性 | 主线关键节点 Player Power Snapshot，要求 Normal Progression → Expected Power ≥ Required Power | 求解器 / progression 源核对（`node scripts/verify-progression-source-fixture.js`） | Progression Snapshot | PENDING-VERIFICATION |

## D. 经济平衡

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| D1 市场动力学（价格/供需/事件/AI/税） | 经济运行时测试 + 审计 | `npm run test`（`tests/trade-runtime.test.js`、formal 相关） | 测试输出 | PENDING-VERIFICATION |
| D2 主线贸易节奏（垫资→交付→复命） | 主线 e2e 抽 13/101 等样本核对收支 | `npm run mainline:e2e` + 日志 | e2e + 日志 | PENDING-VERIFICATION |
| D3 财富轨迹（关键节点金币/资产） | 通关记录推导,拆解收入/支出 | 通关存档（`web/.zhsh-player-saves.sqlite` / server data） | 财富轨迹表 | PENDING-VERIFICATION |
| D4 三类风险检测（破产/爆炸/无意义经济） | 财富轨迹分析判断是否存在 | 系统审计 + 数值审计 | 风险判定 | PENDING-VERIFICATION |

## E. 系统间一致性

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| E1 同一属性/价格/ID/等级单一语义 | 跨系统字段核对（战斗/市场/任务/装备/宠物/船员/商会/掉落） | `data:validate` + 运行时一致性测试（`npm run test`） | 一致性报告 | PENDING-VERIFICATION |
| E2 无两套公式 / 双权威源 | 数值基线 C0 落地后跑冲突核对 | `npm run numbers:audit` | 审计输出 | PENDING-VERIFICATION |

## F. 多人在线（本阶段 S0–S2）

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| F0 启动 + 注册 + 登录 + 进世界 | 干净环境启动服务端,注册真实账号 | `node server/server.js`（端口 4173）→ 客户端注册 | 存档 + 登录日志 | PENDING-VERIFICATION |
| F1-1 自动/手动存档 + 断线重连 | 登录→操作→重连核对状态保留 | server WS + `.zhsh-player-saves.sqlite` | 存档前后对比 | PENDING-VERIFICATION |
| F1-2 WS 广播 + 同城可见 | 双账号同城,验证状态同步 | server WS 日志 + 双客户端 | 广播日志 | PENDING-VERIFICATION |
| F1-3 双玩家同时交易/任务推进不冲突 | 两账号并行操作,核对无丢档/错乱 | 并发手动路径 | 日志 | PENDING-VERIFICATION |
| F1-4 第二玩家验证（Player A 通关后 Player B 正常推进） | 不重置服务器,B 新注册正常开始 | 双账号流程 | B 的进度日志 | PENDING-VERIFICATION |

> S3–S5（50/100/200+）为后续增强目标,本阶段暂不验收（见总目标 §0.0 注记 9）。

## G. AI 系统（本地模型 + 规则保底）

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| G1 降级（模型不可用规则保底,不卡死/不刷屏） | 关闭 ollama 后跑 9 场景,确认规则保底不阻塞 | AI tick + 运行 9 场景（NPC 台词/事件/战斗/发现物/任务/顾问/AI 玩家/情报/播报） | 各场景输出 | PENDING-VERIFICATION |
| G2 AI 玩家行为合理 | 长观察,不刷资源/不破坏市场 | AI tick 日志 | 行为日志 | PENDING-VERIFICATION |
| G3 AI 顾问有价值 | 情报/建议可用、不泄开发信息 | 天下页情报 + 市场顾问 | 输出抽样 | PENDING-VERIFICATION |

## H. 客户端 UI/UX

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| H1 功能可达（无死链/白屏/需 URL） | 浏览器驱动遍历主功能 | `npm run test:browser-dom`、`npm run test:browser-tutorial` | e2e | PENDING-VERIFICATION |
| H2 新手可理解（移动/接任务/打怪/买装/航海/交易/升级/主线） | 新手教学 e2e + 无文档依赖 | `npm run test:browser-tutorial`（new-player-tutorial-e2e） | e2e | PENDING-VERIFICATION |
| H3 状态可见（HP/EXP/Lv/Gold/装备/状态/任务/货舱/船/宠物/船员） | UI 断言核心状态展示 | DOM e2e + 手动核对 | e2e + 截图 | PENDING-VERIFICATION |

## I. 稳定性与性能

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| I1 长稳（8h+ 推荐 24h，真实/少量连接） | 长时运行观察 no crash/泄漏/退化 | `node server/server.js` + `node scripts/benchmark-persistence-hotspots.js` | 运行日志 | PENDING-VERIFICATION |
| I2 无崩溃/无 unhandled rejection/死锁/DB 锁死 | 长稳 + 事件循环观察 | server 日志 + 性能采集（`node scripts/capture-performance-evidence.js`） | 性能证据 | PENDING-VERIFICATION |
| I3 性能指标（API P50/95/99、WS 延迟、事件循环、DB 延迟、eco/AI tick 时长） | 采集基准,阈值按现有基准定 | `capture-performance-evidence.js` | 性能报告 | PENDING-VERIFICATION |

> 50 模拟玩家 soak 本阶段暂缓（见总目标 §0.0 注记 9）。

## J. 可维护性

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| J1 自动化测试（根因修复必加回归） | 全量单测/集成 | `npm run test`（`node --test tests/*.test.js`） | 测试汇总 | PENDING-VERIFICATION |
| J2 内容完整性 CI（ID 存在/前置合法/无循环/图可达/NPC-怪物-物品可达/掉落∈[0,1]/required_level 合法/奖励合法） | content audit 自动化,纳入 CI | `npm run data:validate`（扩展）+ `npm run task:model-global:validate` | CI 输出 | PENDING-VERIFICATION |
| J3 文档一致（README/bible/ADR/策略/数值/API 与实现一致） | 交叉核对文档 vs server/web/src | 人工/AI 核对 | 核对表 | PENDING-VERIFICATION |

## K. 合规

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| K1 许可与商用限制明示 | 核对 LICENSE + README 许可声明 | 文档核对 | 核对表 | PENDING-VERIFICATION |
| K2 无商业化包装/支付/商城/广告/monetization | 扫描 server/web 无支付/商城/广告路径 | grep + 文档核对 | 扫描结果 | PENDING-VERIFICATION |
| K3 外部/跨作品/复原/二创/原创来源记录 | 核对 `docs/design/external-absorption-summary.md`、`source-inventory` | 文档核对 | 来源表 | PENDING-VERIFICATION |

## L. 可观测性与可诊断性

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| L1 核心日志（task/combat/inventory/economy/market/save/load/AI fallback/WS/error） | 检查 `server/.zhsh-logs/` 事件覆盖 | server 日志 | 日志样本 | PENDING-VERIFICATION |
| L2 关联字段（timestamp/playerId/sessionId/taskId/requestId 等） | 日志字段核对 | server 日志 | 字段清单 | PENDING-VERIFICATION |
| L3 卡某任务（如 task.series.12）可通过日志回答：在哪/任务状态/缺何条件/上一状态/未触发事件/物品是否拿到/消耗/何时变化/为何提交失败 | 构造一次卡点,仅凭日志还原链路 | 日志 + 构造场景 | 链路还原 | PENDING-VERIFICATION |

---

## 终局后 / 恢复类

| 证据项 | 判定方法（AI） | 证据命令 / 来源 | 证据产物 | 状态 |
|---|---|---|---|---|
| 终局后持续可玩（战斗/航海/市场/探索/装备/宠物/船员/商会/地牢/钓鱼/潜水/贸易） | series.15 通关后继续操作 | 通关存档 + 后段操作 | 存档 + 日志 | PENDING-VERIFICATION |
| 重启恢复（task/inventory/equip/gold/exp/ship/cargo/pet/crew/reputation/explore/market） | 存档→关停→重启→登录核对全状态 | server 重启流程 | 前后对比 | PENDING-VERIFICATION |
| 故障恢复（AI 不可用/WS 断/超时/tick 错/重复登录/保存异常 → 无重复奖励/复制物品金币/状态破坏） | 逐故障注入场景 | 构造场景 | 故障注入日志 | PENDING-VERIFICATION |

---

## 最终汇总

| 项 | PASS | FAIL | BLOCKED | PENDING-VERIFICATION | SKIPPED | 已知问题 |
|---|---|---|---|---|---|---|
| 单元/集成测试（J1） | | | | | | |
| 内容完整性（J2） | | | | | | |
| 数值审计（C4） | | | | | | |
| 内存求解器（C5） | | | | | | |
| 服务端 API 全主线（C5） | | | | | | |
| Browser E2E（H） | | | | | | |
| 多人 S0–S2（F） | | | | | | |
| 长稳/性能（I，无模拟玩家） | | | | | | |
| 重启恢复 / 第二玩家 / 终局后 | | | | | | |
| AI 降级（G） | | | | | | |

> 运行命令：见各维度「证据命令」列；全量测试 `npm run test`。
