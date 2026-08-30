# ADR-0002：正式玩法规则与浏览器任务闭包

- 状态：已接受
- 日期：2026-07-17
- 范围：复原阶段的战斗、战败恢复、掉落、商店、船只、航行和浏览器任务闭包

## 结论

正式浏览器入口采用 `zhsh` 参考源码能够明确证明的规则，并以现有静态库中的实体、placement、商店来源和 `location_connections` 为边界。当前机器闭包且经正式端到端覆盖的是 51 个任务，来自 9 个彼此独立的系列或系列连续前缀；没有发明跨系列前置关系。

## 已采纳规则与证据等级

| 规则 | 当前裁决 | 证据等级 | 参考证据 |
| --- | --- | --- | --- |
| 战败 | 生命降为 1，返回威尼斯救济院；不会直接把玩家恢复为满血 | 源码明确 | `zhsh/src/monster.js` 的失败分支；`zhsh/src/city.js` 的 `resetCity()` |
| 战败后恢复 | 玩家必须沿正式地点连接前往威尼斯教堂，由牧师祈祷恢复满生命 | 源码明确 | `zhsh/src/user.js` 的 `priest_pray`；威尼斯教堂牧师 placement |
| 怪物属性 | 采用 `zhsh/src/monster.js` 的 `_setMonsterStats` 等级、类型和倍率公式 | 源码明确 | `zhsh/src/monster.js` |
| 地点遭遇 | 只列出当前位置 placement；普通怪可重复，任务专属怪和 Boss 按用途限制 | 源码明确 | `zhsh/src/city.js`、`zhsh/src/npc.js`、`monster_placements` |
| 怪物经验 | 普通怪采用连续的 `40 × 等级` 兼容梯度，副本普通怪按统一类型系数；单门槛超过 30 场即判异常 | `PROVISIONAL_COMPATIBILITY` | `zhsh/src/monster.js` 的冲突公式、`zhsh-game_astrbot/server/src/routes/battle.js` 的独立奖励字段、正式升级阈值与用户确认 |
| 怪物铜币 | `5 × 等级` | 源码明确 | `zhsh/src/monster.js` |
| 装备掉落 | 每次结算只进行一次 20% 装备池判定，命中后按池权重至多选择一件 | 源码明确 | `zhsh/src/monster.js` |
| 普通掉落 | 每项普通物品独立进行 40% 判定 | 源码明确 | `zhsh/src/monster.js` |
| 必需任务掉落 | 静态库明确标记的任务必需掉落按其正式关系结算 | 源码明确 / 正式库关系 | `drop_relations` 及其来源记录 |
| 撤退 | 扣除 500 铜币 | 技术修复 | 页面明确写“撤退（500 铜）”，源码 `addCopper(+500)` 与页面语义相反，裁定为方向错误 |
| 商店出售 | 只能在对应正式商店出售该商店经营的物品，回收价为售价的 20%，最低 1 铜 | 源码明确 | `zhsh/src/npc.js` |
| 船只与航行 | 购买、持有、选择当前船只；航程按已配置船速推进并可持久化恢复 | 源码明确 + 技术修复 | `zhsh/config/ship.json`、`zhsh/config/lngLat.json`、`zhsh/src/npc.js`、`zhsh/src/sailing.js` |

除怪物经验外，上述规则均有直接参考证据。怪物经验采用隔离兼容规则是因为现存 `level × 2` 源码与升级曲线和可复核体验直接冲突，并非把兼容值宣称为原版事实；发现可信奖励表或可验证原始公式后必须整体替换。仍未确认的航海随机事件和市场动态价格没有进入正式闭包；跨城闭包只采用已有城市坐标、正式港口、船只和确定性航程。

## 浏览器任务闭包

纳入批次如下：

| 系列 | 纳入任务数 |
| --- | ---: |
| `task.series.01` | 13 |
| `task.series.03` | 1 |
| `task.series.04` | 6 |
| `task.series.05` | 11 |
| `task.series.06` | 1 |
| `task.series.08` | 4 |
| `task.series.10` | 7 |
| `task.series.11` | 5 |
| `task.series.12` | 3 |

选择器遍历全部候选，优先完整系列，否则选择从系列开头开始的最大连续可玩前缀；算法不包含系列 ID、任务 ID或目标数量白名单。每条任务分别检查定义、前置与顺序、地点可达性、NPC 与 placement、怪物与正式战斗入口、物品来源、商店、港口/航线/船只、等级装备、目标类型、未解析依赖、复原冲突和自动验证路径。等级闭包按系列头顺序模拟任务奖励、必做战斗经验和可达野怪，当前预测补级段为 22→23 的 23 场和 24→25 的 15 场；超过 30 场会阻断选择。完整选择证据见 `data/generated/runnable-task-selection.json`，651 行最终状态见 `docs/development/task-playability-matrix.json`。

批次边界只截断浏览器内容包内的后继展示，不改变 SQLite 中的原始任务关系；内容包用 `browser_batch_terminal` 明确记录边界。系列选择只改变当前展示系列，不生成系列间前置关系。

## 兼容与替换条件

- schema v1 的真实 1/13 浏览器存档先做校验和验证，再升级到 envelope v2 / 玩法状态 v3；已有任务、背包、奖励账本、事件、位置、金钱和经验保持不变，只补齐新增正式状态和任务定义。E2E 还按 `a97c8af` 的 25 条已验收任务清单形成 25/25 持久化检查点，重新创建运行实例后继续到 51/51，并逐项验证旧奖励账本不变。
- 历史演示入口已经从公共运行时、浏览器正常入口、构建产物和正式 E2E/UAT 退役。
- 将来只有在新参考证据改变上述来源判断，或正式静态库补齐新的实体闭包时，才能通过新 ADR 替换本裁决；不能为了扩大可玩数量而虚构内容或关系。

## 2026-07-18 裁决补充

- 怪物经验规则的证据分区固定为：`source_confidence=CONFLICT`、`runtime_adjudication_status=COMPATIBILITY_PLAYABLE_RETAINED`、`has_active_conflict=true`。
- `round(level × 40 × encounter multiplier)` 不是原作公式，只允许维持已经接受的可玩基线；更高等级任务扩展等待可信奖励表或新的明确复原裁决。
- 装备取得模块从 71 条起点自然新增 `task.series.02.012`，形成 72 条、13 个系列；该任务只要求 6 级，没有扩大经验兼容规则的等级边界。
- `task.series.05.036`、`task.series.10.057`、`task.series.11.065` 的八槽装备来源均已闭包，但正式战斗仍失败，继续作为真实阻塞，不通过修改怪物、装备、任务等级或掉落概率强行解锁。
- 完整证据和替换边界见 [`docs/development/equipment-combat-stage-validation-report.md`](../development/equipment-combat-stage-validation-report.md)。
