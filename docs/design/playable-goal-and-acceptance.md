# 《纵横四海》（zhsh-mmo-server）真正可玩化总目标与验收标准

版本：0.1
状态：目标纲领（总纲），非当前实现状态声明

> 本文件是「真正可玩」的**目标定义与验收标准**，与 [game-design-bible](./game-design-bible.md)（复原基线与禁止事项）、
> [content-adaptation-policy](./content-adaptation-policy.md)（内容策略）、[external-absorption-summary](./external-absorption-summary.md)（吸收纪律）
> 配套使用。本文件描述**要去到的状态**，当前项目的实际进度以 `tests/`、`browser-tests/`、各类 `audit`/`verify` 脚本与
> `docs/development/` 为准。

## 0.0 与本项目现状的对齐注记（落地本地化）

以下为落成本仓库文档时，针对本项目**真实实现**对通用目标做的校对与修正。除注明外，正文保持目标总纲原义。

1. **零依赖**：本项目**无第三方 npm 依赖**（纯 Node.js 内置模块 + 本地 SQLite WAL），运行仅需 **Node.js 22+**。
   「安装依赖」在本项目中等同于"确保 Node 22+ 已安装"，无 `npm install` 环节。
2. **启动方式**：Windows 下双击根目录 `启动游戏.cmd`（或 `启动游戏.vbs`，系统托盘常驻后台并自动开浏览器）；
   跨平台手动启动：`node server/server.js`。服务器监听 `http://0.0.0.0:4173`，客户端 `http://127.0.0.1:4173/`，
   局域网 `http://<本机IP>:4173/`。存档与账号位于 `server/data/`。
3. **AI 系统**：本项目为**本地大模型**驱动（默认 ollama `http://127.0.0.1:11434`，`qwen3.8-4b/2b/9b`），共 **9 个 AI 场景**；
   未部署或模型不可用时走**规则保底**，核心玩法不依赖 AI。因此 §G「AI 不得成为单点依赖」在本项目中天然满足，
   只需验证降级路径健全。
4. **多人在线负载（§F S0–S5）**：本项目为**单进程 Node + SQLite WAL + WebSocket 广播**架构。
   S0（1 人）应为现状可达；S1–S5（2/10/50/100/200+）为**验收目标待验证**，其中 S3+ 需以压测确认单进程能承载，
   并注意「多玩家同时交易/占城/任务推进」的状态一致性。达到对应负载是 PASS 条件，不是现状。
5. **架构事实**：经济引擎 `server/eco/`，AI `server/ai/`，内容 `server/content/`，任务引擎 `src/task-runtime/`，
   客户端 `web/`。数值与内容库 `data/`、`design/numbers/gameplay-numbers.xlsx`。
6. **既有测试分层**（与 §12 要求吻合，本项目已具备基础，落地点是补全与固化）：
   - `tests/*.test.js`：单元与集成测试（含 `formal-gameplay.test.js`、`trade-runtime`、`cook-runtime` 等）；
   - `browser-tests/*.e2e.test.js`：浏览器端到端（含主线上探索、新玩家教学、分阶段发布、长链等）；
   - 内存级全主线求解器 + 服务端 API 全主线通关（两层）；
   - `scripts/audit-gameplay-numbers.js` 数值审计、`scripts/verify.js`、内容完整性校验。
7. **待核实裁决机制**：§2.3 的 `pending-verification` 与本项目
   `docs/design/blocked-targets-adjudication.md` + `scripts/adjudicate-blocked-targets.js` 的裁决机制对应；
   引用本文件时以该裁决文档为落地载体，禁止将「待核实」当作错误处理或绕过手段。
8. **数值基线**：C0 的权威公式（防御减伤、装备曲线、价格锚点、海域等级段、exp/级量级）均已有本项目既有锚定
   （见 `game-design-bible`、`external-absorption-summary.md`、`scripts/audit-gameplay-numbers.js`）。
   C0 的落地动作是**把散落在代码/Excel/文档/测试断言里的锚点集中到 `design/numbers/gameplay-numbers.xlsx` 单一事实源**，
   而非从零制定。（本文件的数值锚定引用属**本地已确认基准**，非待定。）
9. **模拟玩家与目标负载（§F S3–S5、§I 的 50 模拟玩家 soak）本阶段暂不纳入验收范围**。多人验收以
   S0–S2（1 / 2 / 10 玩家）为本阶段基线；S3–S5（50 / 100 / 200+ 目标负载）与 50 模拟玩家的 soak
   保留为**后续增强目标**，不作为本阶段「真正可玩」的 PASS 门槛。相关正文已标注暂缓。

---

## 0. 项目总目标

### 一句话目标

将《纵横四海》（`zhsh-mmo-server`）推进到真正意义上的「完整可玩」状态。

一个全新玩家应当能够在：

* 无开发者介入；
* 无管理员手工改库；
* 无 GM 补道具；
* 无测试作弊路径；
* 无隐藏修复提示；
* 无需重启服务器；
* 无任务卡死；
* 无系统死链；

的前提下，从零注册账号开始，完整经历：

**注册 → 新手教学 → 主线成长 → 战斗 → 航海 → 市场贸易 → 探索 → 装备成长 → 宠物 → 船员 → 技能职业 → 商会 → 钓鱼 → 潜水 → 地牢 → 地魔终局 → 终局后持续游玩**

并确保该游戏在多人同时游玩、服务器持续运行、经济持续演化的情况下，仍保持：

* 内容自洽；
* 剧情完整；
* 数值健康；
* 经济合理；
* 状态一致；
* 性能稳定；
* 可长期继续游玩；
* 可持续维护。

最终目标不是：

> 「能启动」

也不是：

> 「能创建存档」

也不是：

> 「自动化测试能过」

而是：

> **真实玩家可以完整地把它当成一款游戏玩下来。**

---

# 1. 完成定义 Definition of Done

只有满足以下全部条件，项目才能被声明为「真正可玩」。

## 1.1 环境要求

必须从以下干净环境开始验收：

* Node.js 22+（本项目零第三方依赖，无 `npm install` 环节，见 §0.0 注记 1/2）；
* Fresh database（清空/重建 `server/data/` 下的运行时与玩家库，遵循 `scripts/import-content.js` 重建流程）；
* Fresh player account；
* 无预制管理员存档；
* 无测试专属角色；
* 无预置高级装备；
* 无人工注入金币；
* 无人工修改任务状态。

必须能够按照项目正式 README / 启动说明完成：

```text
确保 Node.js 22+
→ 启动服务端（启动游戏.cmd 或 node server/server.js）
→ 打开客户端 http://127.0.0.1:4173/
→ 注册账号
→ 创建角色
→ 开始游戏
```

不得依赖未文档化的隐藏步骤。

---

## 1.2 全主线完成标准

全新玩家必须能够完整完成：

```text
task.series.01
↓
task.series.02
↓
...
↓
task.series.15
↓
地魔终局
```

全过程：

* 不修改数据库；
* 不修改源代码；
* 不调用 GM 指令；
* 不调用开发者补偿接口；
* 不人为修改任务状态；
* 不人为生成任务物品；
* 不人为增加等级；
* 不人为增加金币；
* 不重启服务器解决状态异常；
* 不跳过任务环节；
* 不通过测试特判绕过玩法。

---

## 1.3 验收层级

项目完成状态统一使用：

### L0 — Bootable

服务器与客户端基本可运行。

必须满足：

* 服务端可启动；
* 客户端可访问；
* 数据初始化成功；
* 玩家可注册；
* 玩家可登录；
* 玩家可创建角色；
* 玩家可进入世界。

---

### L1 — Playable

完整 Golden Path 可通关。

必须满足：

* `task.series.01–15` 全部可完成；
* 无任务死锁；
* 无不可达地点；
* 无缺失 NPC；
* 无缺失怪物；
* 无缺失物品；
* 无任务条件无法满足；
* 玩家不依赖开发者即可通关。

---

### L2 — Complete

核心玩法与成长经济闭环全部成立。

包括：

* 战斗；
* 航海；
* 市场；
* 探索；
* 成长；
* 装备；
* 强化；
* 宠物；
* 船员；
* 技能职业；
* 商会占城；
* 钓鱼；
* 潜水；
* 地牢；
* 掉落；
* 声望；
* 爵位；
* 贸易；
* 经济；
* 数值平衡。

---

### L3 — MMO Ready

在 L0–L2 全部成立基础上，进一步满足：

* 多人并发；
* 状态同步；
* AI 系统；
* UI/UX；
* 长时稳定性；
* 性能；
* 可观测性；
* 可维护性；
* 内容保真；
* 合规。

最终：

> **真正可玩 = L3 PASS**

任何阶段不得用「基本完成」「大致可用」「理论可通」代替正式 PASS。

---

# 2. 最高优先级：Golden Standard

以下标准拥有唯一最高优先级。

---

## 2.1 全新账号完整通关

全新账号：

```text
注册
→ 创建角色
→ 教学引导
→ 威尼斯新手阶段
→ task.series.01–15
→ 地魔终局
```

必须完整零阻塞通过。

---

## 2.2 每个任务三个阶段全部成立

所有任务都必须分别验证：

### 接取

确认：

* 前置任务正确；
* NPC 正确；
* NPC 所在地点正确；
* 等级条件正确；
* 道具条件正确；
* 对话触发正确；
* 状态写入正确。

### 中间流程

包括：

* 跑图；
* 对话；
* 打怪；
* 收集；
* 掉落；
* 航海；
* 送物；
* 探索；
* 市场购买；
* 装备要求；
* 特殊系统触发。

必须确认每一步真实可达。

### 提交

确认：

* 提交 NPC 正确；
* 地点正确；
* 所需条件可满足；
* 任务状态正确推进；
* 奖励正确；
* 后续任务正确解锁。

---

## 2.3 禁止任务静默失败

发现断裂点时，只允许三种结果：

### 已修复

确认根因已经解决。

### 已批准待核实

必须明确记录：

```yaml
status: pending-verification
source:
reason:
affected_system:
affected_content:
temporary_behavior:
fidelity_risk:
approved_by:
created_at:
blocking:
```

> 注：落地载体为 `docs/design/blocked-targets-adjudication.md`（`pending-verification` 与本项目裁决机制一致）。

### 明确阻塞

标记为 P0 / P1。

禁止：

* 静默失败；
* catch 后吞错；
* 默认自动完成；
* 默认补物品；
* 默认绕过条件。

特别规定：

> `pending-verification != fallback`

「待核实」不能作为错误处理机制。

---

# 3. Canonical Full Playthrough

建立唯一正式的「标准全流程游玩路径」。

这是最终人工 E2E 与自动化验收共同使用的基准。

标准路径至少覆盖：

```text
注册
→ 创建角色
→ 新手教学
→ series.01
→ 首次 NPC 对话
→ 首次任务接取
→ 首次移动
→ 首次战斗
→ 首次掉落
→ 首次装备
→ 首次技能成长
→ 首次航海
→ 首次船只使用
→ 首次港口切换
→ 首次市场买入
→ 首次贸易运输
→ 首次市场卖出
→ 首次探索发现
→ 首次声望变化
→ 首次爵位进展
→ 首次装备强化
→ 首次宠物获得/使用
→ 首次船员系统
→ 首次职业/技能系统
→ 首次钓鱼
→ 首次潜水
→ 首次地牢
→ 首次商会
→ 首次占城相关玩法
→ series.15
→ 地魔终局
→ 终局后继续游戏
```

每个关键节点必须至少记录：

```text
Trigger
Action
Expected State
Expected Feedback
Expected Persistent State
```

不能只验证函数返回值。

必须同时验证：

* 玩家行为；
* 游戏状态；
* UI 反馈；
* 持久化结果。

---

# 4. 反作弊 / 反伪通关验收规则

所有正式通关验证必须走与普通玩家完全一致的生产路径。

禁止为了让测试通过而加入：

* `if taskId === xxx` 式一次性特判；
* `if testMode` 自动完成任务；
* 自动补任务物品；
* 自动补金币；
* 自动补经验；
* 自动补血；
* 自动补装备；
* 自动修改角色等级；
* 自动修改任务状态；
* 自动降低指定 Boss 属性；
* 为测试账号添加隐藏 Buff；
* E2E 直接写数据库；
* E2E 直接调用内部任务完成接口；
* 绕过客户端核心玩法完成任务。

允许测试使用 API 的前提是：

> API 本身就是普通客户端正常调用的正式 gameplay API。

原则：

> 测试必须证明游戏能玩，而不是证明测试能让游戏通过。

---

# 5. 问题严重程度

所有发现的问题统一分级。

## P0 — Blocking

包括：

* 无法注册；
* 无法登录；
* 无法进入世界；
* 主线无法继续；
* 存档损坏；
* 服务器崩溃；
* 永久丢档；
* 关键系统导致通关不可能。

P0 未清零：

> 禁止宣布 L1 PASS。

---

## P1 — Critical

包括：

* 核心玩法不可用；
* 严重战斗数值断层；
* 玩家正常成长无法击败主线敌人；
* 经济无限刷钱；
* 经济导致玩家必然破产；
* 多人状态严重错乱；
* 世界共享状态被永久破坏。

---

## P2 — Major

包括：

* 非阻塞功能错误；
* 明显 UI/UX 问题；
* 非主线玩法异常；
* 数值轻度失衡；
* 数据不一致但存在正常绕行方式。

---

## P3 — Minor

包括：

* 文案问题；
* UI 细节；
* 轻微反馈不足；
* 非关键一致性问题。

---

## P4 — Polish

视觉与体验打磨。

---

执行优先级：

```text
Golden Path P0
>
Golden Path P1
>
B–E P0/P1
>
F–L P0/P1
>
P2
>
P3
>
P4
```

---

# A. 内容与叙事

## A1. 任务线完整性

系统性验证：

* task.series.01–15；
* 前置关系；
* NPC；
* 地点；
* 怪物；
* 道具；
* 奖励；
* 对话；
* 剧情；
* 跨系列连接。

---

## A2. 数据一致性

统一检查：

* NPC ID；
* Monster ID；
* Item ID；
* Equipment ID；
* Map / Location ID；
* Dialogue ID；
* Task ID；
* Reward ID；
* Drop Table ID。

不得出现：

* 引用不存在；
* 重复但含义冲突；
* 字段名称错位；
* 同内容多套来源无裁决。

---

## A3. 多源内容冲突

遇到多源冲突：

不得：

* 平均；
* 猜测；
* 编造；
* 为了结构完整随意补值。

必须：

* 明确来源；
* 明确冲突；
* 保留证据；
* 根据现有裁决机制处理；
* 无法裁决时标为「待核实」。

> 注：落地载体为 `docs/design/blocked-targets-adjudication.md`。

---

## A4. 剧情和对白保真

严格遵守：

`docs/design/game-design-bible.md §13`

禁止：

* 改写原剧情；
* 改对白含义；
* 改任务顺序；
* 改名称；
* 改关键人物关系；
* 改原系统行为；
* 删除原内容；
* 让原始内容不可体验。

---

## A5. 内容保真自动回归

建立：

```text
Original Content Snapshot
↓
Canonical Normalization
↓
Current Content
↓
Diff
```

至少比较：

* 任务名称；
* 顺序；
* NPC；
* 对白；
* 地点；
* 目标；
* 奖励；
* 怪物；
* 装备；
* 商品；
* 剧情触发。

所有差异必须分类：

```text
[原作数值]
[本地锚定折算]
[调平]
[技术兼容]
[待核实]
```

未分类内容变更：

> CI Fail

---

## A 验收证据

必须提供：

* 内容完整性审计；
* Task graph；
* Missing reference 检查；
* Fidelity diff；
* 实际游玩剧情记录。

---

# B. 核心玩法闭环

必须确认以下所有系统不是「代码存在」，而是在 Canonical Full Playthrough 中真实触发。

---

## B1. 战斗

包括：

* 普通攻击；
* 技能；
* 命中；
* 暴击；
* 防御；
* 状态效果；
* Morale；
* 套装；
* 宠物；
* 掉落；
* 死亡；
* 恢复。

---

## B2. 航海

包括：

* 船只；
* 船属性；
* 载重；
* 货物；
* 港口；
* 海域；
* 自动航行；
* 航程；
* 航海资源；
* 航行状态。

---

## B3. 市场贸易

包括：

```text
买入
→ 装载
→ 航海
→ 异港
→ 卖出
→ 利润
```

真实验证：

* 价格差；
* 市场库存；
* 供需；
* 动态价格；
* 事件影响。

---

## B4. 探索

包括：

* 发现物；
* 地点；
* 探索条件；
* 奖励；
* 声望；
* 爵位。

---

## B5. 成长

包括：

* 等级；
* 经验；
* 装备；
* 强化；
* 技能；
* 职业；
* 船员；
* 宠物；
* 船只。

---

## B6. 其他核心玩法

必须实际验证：

* 商会；
* 占城；
* 钓鱼；
* 潜水；
* 地牢；
* 掉落系统。

---

# C. 数值系统

数值设计作为独立一级维度。

不是「经济系统的一部分」。

---

# C0. 数值基线单一事实源

将散落于：

* 代码；
* Excel；
* 文档；
* 吸收记录；
* 裁决文档；
* 测试断言；

中的所有核心数值规则集中到一个权威基线。

优先扩展：

`design/numbers/gameplay-numbers.xlsx`

并结合：

`scripts/audit-gameplay-numbers.js`

形成唯一事实源。

---

至少明确：

## 战斗

```text
damage
hit
critical
defense
agility
status effect
morale
set bonus
pet modifier
```

防御减伤锚点：

```text
damageReduction =
defense / (defense + 300)
```

最低伤害：

```text
damage >= 1
```

## 装备

属性曲线例如：

```text
attack ≈ 6 + 0.9 × Lv
```

实际公式以已有本地权威锚点为准。

## 怪物

遵循：

```text
monster.type-level.v1
```

## 海域等级

例如：

```text
Mediterranean ≈ Lv5–24
```

并保持既有比例关系。

## 市场价格

锚点：

```text
产区价格 ≈ base × 0.75
异区价格 ≈ base × 1.25
出售价格 ≈ local × 0.9
base_price ≈ 500 量级
```

## 经验

明确：

* 等级经验曲线；
* 怪物 EXP；
* 任务 EXP；
* 每等级需求。

## 其他

包括：

* 恢复费；
* 掉落概率；
* 强化费用；
* 航海费用；
* 宠物；
* 船员；
* 船只；
* 技能成长；
* 声望；
* 爵位。

---

# C1. 成长曲线健康

必须满足：

* Monster reward 随等级总体单调；
* EXP/级约保持既有 40 量级；
* 升级需求无异常跳变；
* 装备属性随 required_level 合理增长；
* 装备价格随等级合理增长；
* 高等级装备不得漏填 required_level；
* 同类型装备无明显属性断层；
* 无大量重复冗余档位。

---

# C2. 战斗数值自洽

完整验证：

```text
玩家
+
装备
+
技能
+
宠物
+
套装
+
状态
+
morale
```

与：

```text
怪物
+
技能
+
防御
+
状态
```

组合后闭环必须收敛。

禁止：

* 某阵容无脑永久碾压；
* 某等级区间完全打不动；
* 暴击无限；
* 防御无限；
* 永久控制；
* 负伤害；
* 状态效果造成无限循环；
* 最低伤害机制导致异常无限刷怪。

---

# C3. 数值锚定纪律

新增或吸收：

* 装备；
* 宠物；
* 船只；
* 商品；
* 怪物；

不得直接复制外部作品绝对值。

例如：

```text
外部：24–142
```

应根据本地：

```text
约 ×3.5
→ 约 500 量级
```

进行本地锚定。

规则：

* 比例可参考来源；
* 绝对值必须服从本地基线；
* 禁止手写漂移；
* 多倍掉落不得意外改变经济；
* 任务必掉不得造成经济无限套利。

---

# C4. 数值验证自动化

以：

`scripts/audit-gameplay-numbers.js`

为骨架。

扩展检查：

* EXP 曲线；
* 怪物成长；
* 装备成长；
* required_level；
* 价格；
* 掉落；
* 战斗公式；
* 防御；
* 暴击；
* 市场；
* 强化；
* 宠物；
* 船只；
* 船员。

与：

`tests/formal-gameplay.test.js`

中的正式数值锚点保持一致。

任何数值修改必须提供：

```text
Before Audit
vs
After Audit
```

---

# C5. 数值平衡方法论

禁止仅靠查看表格判断平衡。

必须结合：

```text
内存级全主线求解器
+
服务端 API 全主线
+
真实浏览器游玩
```

验证：

> 一个按照正常成长路径发展的玩家，在关键节点确实能够战胜目标敌人。

---

# C6. 成长可达性 Progression Reachability

对主线关键节点建立 Player Power Snapshot。

记录：

```text
玩家等级
累计 EXP
金币
可获得装备
当前装备
强化等级
技能
宠物
船员
消耗品
船只
声望
```

以及：

```text
Expected Player Power
vs
Required Encounter Power
```

必须满足：

```text
Normal Progression
→ Expected Power >= Required Power
```

不得出现：

> 理论上有某装备能打 Boss，但正常玩家在该阶段根本无法获得。

---

# D. 经济平衡

---

## D1. 市场动力学

验证：

* Base price；
* 地区差；
* Supply；
* Demand；
* Event；
* AI player；
* Player trade；
* Tax；
* Price update。

---

## D2. 主线贸易节奏

重点验证：

```text
垫资
→ 买货
→ 航海
→ 异国交付
→ 复命奖励
```

节奏必须符合原版。

如果实测垫资过重：

仅允许通过既有数值旋钮，例如：

> 调整挂牌价到允许区间下限。

不得改剧情或任务设计解决经济问题。

---

## D3. 财富轨迹 Wealth Trajectory

至少记录：

```text
注册时
series.01 后
series.03 后
series.05 后
series.10 后
series.15 前
series.15 后
```

玩家拥有：

* 金币；
* 商品；
* 装备；
* 船只；
* 关键资产。

拆解收入：

```text
任务
战斗
掉落
贸易
探索
地牢
其他
```

拆解支出：

```text
装备
强化
补给
恢复
航海
市场
其他
```

---

## D4. 必须发现三类风险

### 破产点

正常玩家推进任务所需支出：

```text
> 正常收入
```

导致无法继续。

### 财富爆炸点

某个：

* 商品；
* 掉落；
* 奖励；
* 市场差；
* 任务；

可以无限刷钱。

### 无意义经济

玩家财富不断增长但：

* 没有有效消费；
* 买东西没有意义；
* 强化没有意义；
* 贸易没有意义。

---

# E. 系统间一致性

验证同一个概念在：

* 战斗；
* 市场；
* 任务；
* 装备；
* 强化；
* 宠物；
* 船员；
* 商会；
* 掉落；

之间不存在不同定义。

例如：

```text
attack
defense
price
required_level
item_id
player_level
currency
```

必须只有一个语义。

禁止：

* 同一属性两套公式；
* 同一价格两个权威源；
* 同一 Item 两套 ID；
* 同一等级两个判断方式；
* 同一货币两种单位。

---

# F. 多人在线体验

不得使用「任意数量玩家」这种不可验收描述。

改为负载等级。

> 本阶段验收基线为 **S0–S2**（1 / 2 / 10 玩家）。S3–S5（50 / 100 / 200+ 目标负载）为**后续增强目标，
> 本阶段暂不验收**（见 §0.0 注记 9）。

## S0 — 1 Player

完整单人通关。

---

## S1 — 2 Players

验证：

* 同城可见；
* WS；
* 状态同步；
* 世界交互。

---

## S2 — 10 Players

基础多人环境。

---

## S3 — 50 Players

目标正常并发。

---

## S4 — 100 Players

压力测试。

---

## S5 — 200+ Players

极限测试。

允许性能下降。

但禁止：

* 丢档；
* 数据错乱；
* 状态永久分叉；
* 经济损坏。

> 注：本项目为单进程 Node + SQLite WAL + WebSocket；S0/S1 应为现状可达，S2–S5 为**验收目标待验证**。
> 达到对应负载是 PASS 条件，非现状（见 §0.0 注记 4）。

---

## F1. 必测项目

包括：

* 注册；
* 登录；
* 存档；
* 自动保存；
* 手动保存；
* 断线重连；
* WS broadcast；
* 同城可见；
* 市场并发；
* NPC 状态；
* 占城状态；
* 多玩家同时交易；
* 同时任务推进。

---

# G. AI 系统

现有 9 个 AI 场景必须逐一测试。

核心原则：

> AI 可增强体验，但 AI 不得成为游戏能否继续运行的单点依赖。

> 注：本项目为本地 ollama 模型 + 规则保底（未部署时不依赖模型，见 §0.0 注记 3）。

---

## G1. 降级

本地模型 / 云模型不可用时：

必须规则保底。

禁止：

* NPC 不回应；
* 游戏卡住；
* 无限重试；
* 无限刷屏；
* Blocking API；
* AI Tick 卡主线程。

---

## G2. AI 玩家

验证：

* 行为合理；
* 不无限刷资源；
* 不破坏市场；
* 不长期堵塞世界资源。

---

## G3. AI 顾问

包括：

* 市场顾问；
* 情报；
* 建议。

要求：

* 有价值；
* 不产生虚假不可达信息；
* 不泄露开发信息。

---

# H. 客户端 UI/UX

---

## H1. 功能可达

所有核心功能：

必须存在玩家可发现入口。

禁止：

* 死链；
* 白屏；
* 无响应按钮；
* Debug 页面才能操作；
* 必须知道 URL 才能进入。

---

## H2. 新手可理解

玩家无需阅读代码或设计文档。

必须通过游戏本身理解：

* 怎么移动；
* 怎么接任务；
* 怎么打怪；
* 怎么买装备；
* 怎么航海；
* 怎么交易；
* 怎么升级；
* 怎么继续主线。

---

## H3. 状态可见

重要状态应在 UI 可理解展示：

* HP；
* EXP；
* Level；
* Gold；
* Equipment；
* Status；
* Buff/Debuff；
* Task；
* Cargo；
* Ship；
* Market；
* Pet；
* Crew。

---

# I. 稳定性与性能

---

## I1. Soak Test

至少执行：

```text
8h
```

推荐进一步执行：

```text
24h
```

环境：

```text
（模拟玩家 soak 本阶段暂缓——以真实/少量连接为准，见 §0.0 注记 9）
economic tick ON
AI tick ON
WS ON
market ON
autosave ON
```

---

## I2. 必须满足

* 无 crash；
* 无 unhandled rejection；
* 无 deadlock；
* 无 save corruption；
* 无数据库锁死；
* 无 heap 持续线性增长；
* 无经济 tick 越跑越慢；
* 无 AI tick 拖死 event loop。

---

## I3. 性能指标

至少统计：

```text
API P50 / P95 / P99
WS latency
event loop lag
memory
CPU
DB latency
economic tick duration
AI tick duration
```

阈值根据现有基准确定。

不得凭空设定不可实现指标。

---

# J. 可维护性

---

## J1. 自动化测试

任何根因修复：

应增加对应回归测试。

---

## J2. 内容完整性 CI

建立 Content Integrity Audit。

至少自动检测：

```text
所有 ID 引用存在
任务前置合法
任务前置无循环
任务图可达
NPC location 存在
Monster location 存在
Task item 存在
Task item 存在获取路径
提交 NPC 可达
Drop probability ∈ [0,1]
required_level 合法
Reward 合法
```

---

## J3. 文档一致

以下必须和实际实现一致：

* README；
* game-design-bible；
* ADR；
* content-adaptation-policy；
* Gameplay Numbers；
* API 文档。

禁止：

> 文档描述 A，代码实现 B。

---

# K. 合规

必须明确记录：

* 项目许可；
* 禁止商用要求；
* 外部内容来源；
* 跨作品元素；
* 复原内容；
* 二创内容；
* 原创补充内容。

禁止：

* 商业化包装；
* 支付系统；
* 商城；
* 广告；
* 商业 monetization；
* 为「产品化」主动改变原项目性质。

---

# L. 可观测性与可诊断性

新增独立维度。

真正可玩的系统必须可诊断。

---

## L1. 核心日志

至少具备：

```text
task transition
combat result
inventory mutation
economy transaction
market price
player save
player load
AI fallback
WS connect
WS disconnect
server error
```

---

## L2. 日志关联字段

至少：

```text
timestamp
playerId
sessionId
taskId
requestId
```

相关系统增加：

```text
itemId
monsterId
marketId
locationId
```

---

## L3. 目标

当玩家卡在：

```text
task.series.12
```

时，不修改数据库即可通过日志回答：

```text
玩家在哪里？
任务状态是什么？
缺哪个条件？
上一个状态是什么？
哪个事件没有触发？
物品有没有拿到？
物品有没有被消耗？
任务状态什么时候变化？
为什么提交失败？
```

---

# 6. 终局后持续可玩

完成：

```text
task.series.15
→ 地魔终局
```

不代表游戏结束后系统可以坏掉。

终局后必须继续允许：

* 战斗；
* 航海；
* 市场；
* 探索；
* 装备强化；
* 宠物；
* 船员；
* 商会；
* 地牢；
* 钓鱼；
* 潜水；
* 贸易。

验证：

> Endgame Complete ≠ World Disabled

---

# 7. 第二玩家验证

单个测试账号通关不足以证明 MMO 正常。

必须执行：

```text
Player A
→ 完整通关

服务器不重置
数据库不重置

Player B
→ 新注册
→ 正常开始
→ 正常推进
```

必须验证：

Player A 的行为不会让 Player B：

* 无任务；
* 无 NPC；
* 无怪物；
* 无商品；
* 无资源；
* 无法完成世界事件；
* 无法继续主线。

---

# 8. 重启恢复测试

虽然正式游玩不能依赖重启解决问题，但必须测试服务器正常重启后的状态恢复。

场景：

```text
Player playing
↓
normal save
↓
server shutdown
↓
server start
↓
player login
```

验证：

* Task；
* Inventory；
* Equipment；
* Gold；
* EXP；
* Ship；
* Cargo；
* Pet；
* Crew；
* Reputation；
* Exploration；
* Market relevant state；

全部正确恢复。

---

# 9. 故障恢复

验证：

* AI 服务不可用；
* WS 临时断开；
* 单请求超时；
* 市场 Tick 错误；
* 玩家断线；
* 玩家重复登录；
* 数据保存异常。

必须确保：

* 不产生重复奖励；
* 不产生物品复制；
* 不产生金币复制；
* 不破坏任务状态；
* 不破坏存档。

---

# 10. 根因修复纪律

原则：

> 一次性做对，修根因，不修症状。

遇到：

```text
Task 7 无法提交
```

不得第一反应：

```js
if (taskId === 7) {
  complete();
}
```

而必须调查：

```text
数据？
任务状态机？
Item reference？
事件？
Location？
Save？
API？
Client？
```

找到系统级根因。

同类问题必须一次性修复。

---

# 11. 数值红线

任何平衡调整必须遵守：

`game-design-bible §13`

不得：

* 平均冲突数值；
* 猜缺失数值；
* 为结构完整补数；
* 直接修改原作明确数值；
* 因为 Boss 难就随意降低；
* 因为钱不够就随意送钱。

数值来源统一标注：

```text
[原作数值]
[本地锚定折算]
[调平]
```

---

# 12. 自动化测试与真实游玩双重标准

必须同时成立：

## 自动化

包括：

* Unit；
* Integration；
* Content audit；
* Number audit；
* In-memory Solver；
* Server API Full Playthrough；
* Browser E2E。

## 真实游玩

必须执行实际浏览器：

```text
注册
→ 创建角色
→ 完整任务
→ 操作所有系统
→ 通关
```

规则：

> 自动化测试通过不能替代真实游玩。

同时：

> 真实游玩一次通过不能替代自动化回归。

二者必须同时成立。

---

# 13. Evidence Matrix

所有 A–L 验收项必须给出证据。

统一格式：

| 维度 | 现状差距 | 根因 | 修复动作 | 自动化证据 | 实际游玩证据 | 存档/日志证据 | 状态 |
| -- | ---- | -- | ---- | ----- | ------ | ------- | -- |

状态只允许：

```text
PASS
FAIL
BLOCKED
PENDING-VERIFICATION
```

禁止：

```text
基本完成
应该没问题
理论支持
大概可以
暂时正常
```

---

# 14. 最终全流程通关报告

最终必须生成一份完整通关记录。

至少包括：

```text
玩家创建时间
角色
通关时间线
Task Series 01–15
Level progression
Gold progression
Equipment progression
Ship progression
Pet progression
Crew progression
Skill progression
Major battles
Major trades
Major exploration
Endgame status
```

并记录每个关键系统首次触发位置。

---

# 15. 数值最终验收报告

必须生成：

## 15.1 数值基线

权威公式与锚点。

---

## 15.2 分类

所有主要数值标记：

```text
原作数值
本地锚定折算
调平
```

---

## 15.3 改动对比

```text
Before
After
Reason
Evidence
```

---

## 15.4 Progression Snapshot

主线关键节点：

```text
Level
EXP
Gold
Equipment
Attack
Defense
Pet
Skill
Expected DPS
Enemy
Expected TTK
```

---

# 16. 最终测试通过汇总

最终报告必须至少包含：

```text
Unit Tests
Integration Tests
Content Integrity
Gameplay Number Audit
Formal Gameplay Tests
Memory Full Solver
Server API Full Playthrough
Browser E2E
Multiplayer
Performance
Soak
Restart Recovery
AI Fallback
```

必须记录：

```text
PASS count
FAIL count
Skipped count
Known Issues
```

---

# 17. 完成前禁止事项

不得因为进度压力：

* 删除失败测试；
* Skip 关键测试；
* 放宽断言让测试通过；
* 降低玩法要求；
* 把主线通关变成局部通关；
* 把真实 E2E 改成 API 伪造；
* 添加隐藏 Cheat；
* 删除原作内容；
* 隐藏错误；
* 用文档宣称替代实际实现。

---

# 18. 最终交付物

项目完成必须交付以下内容。

---

## 18.1 可复现全流程通关记录

Fresh Player：

```text
注册
→ 教学
→ Series 01–15
→ Endgame
```

完整记录。

---

## 18.2 测试通过汇总

列出：

* 测试名称；
* 数量；
* PASS / FAIL；
* 运行命令。

---

## 18.3 A–L 差距—动作—证据表

每个维度必须有：

```text
现状差距
→
根因
→
修复动作
→
验收证据
```

---

## 18.4 数值审计报告

必须包含：

```text
原作数值
本地锚定折算
调平
```

三类标注。

---

## 18.5 实际验收存档

至少保存：

```text
Fresh Start
Mid Game
Pre-Endgame
Post-Endgame
```

---

## 18.6 已知问题

所有未解决问题必须：

* 明确；
* 有等级；
* 有影响范围；
* 有证据；
* 有状态。

禁止静默存在。

---

# 19. 推荐执行顺序

必须严格按照以下优先级推进。

---

## Phase 0 — Baseline

先运行现有：

* Tests；
* Browser tests；
* Full solver；
* Server API playthrough；
* Number audit；
* Content audit。

生成：

```text
Baseline Report
```

任何修复前先保存现状。

---

## Phase 1 — Golden Path

唯一第一优先级：

```text
Fresh Player
→ task.series.01–15
→ Endgame
```

清零所有 P0 / P1。

---

## Phase 2 — Core Gameplay

依次验证：

```text
B
C
D
E
```

即：

```text
玩法
→ 数值
→ 经济
→ 系统一致性
```

---

## Phase 3 — MMO

验证：

```text
F
G
H
```

即：

* 多人；
* AI；
* UI/UX。

---

## Phase 4 — Production Readiness

验证：

```text
I
J
K
L
```

即：

* 稳定；
* 可维护；
* 合规；
* 可观测。

---

## Phase 5 — Final Regression

全部再次运行：

```text
Fresh install
Fresh DB
Fresh player
Full playthrough
All tests
```

---

# 20. 最终验收判定

项目只有在满足以下条件时才能标记：

```text
STATUS = TRULY_PLAYABLE
```

条件：

```text
L0 PASS
L1 PASS
L2 PASS
L3 PASS

Golden Path P0 = 0
Golden Path P1 = 0

A–L 无未说明阻塞项

Browser Full Playthrough PASS
Server API Full Playthrough PASS
Memory Solver PASS

Second Player PASS
Post-Endgame PASS
Restart Recovery PASS
Soak Test PASS

Number Audit PASS
Content Integrity PASS
```

最终判断问题只有一个：

> **如果现在把服务器交给一个从未参与开发的人，不给他数据库权限，不告诉他 Debug 方法，也不给任何人工帮助，他能否从零开始把《纵横四海》完整玩到地魔终局，并在通关后继续正常游玩？**

如果答案不是明确的：

> **能。**

则项目仍未达到「真正可玩」状态。
