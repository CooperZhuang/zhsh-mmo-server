# 闲置视觉资产集成设计（编号：idle-assets-integration）

> 状态：**已实施**（2026-08-30）。落库脚本 `scripts/integrate-idle-assets.js`（幂等）+ 映射规则更新
> `scripts/integrate-authoritative-assets.js` + 离线重绑定 `scripts/rebind-authoritative-assets.js`。
> 验收：`node scripts/verify-idle-assets.js` 12/12 PASS；`npm run data:validate` PASS；
> `tests/formal-core-e2e` 4/4 PASS（含 71 检查点兼容回归）。

## 0. 审计结论（《闲置资产清单》摘要）

| 类别 | 数量 | 状态 |
|---|---|---|
| 媒体资产（PNG×458 + CSS×2） | 460（去 dist 后 230 唯一） | 全部有注册表引用（计数=3/9），**无零引用图片** |
| 未绑定正式实体的视觉映射 | **198 条**（type_slot 51 / name_family 58 / task_reference 32 / interface_slot 48 / variant 9） | 本次全部挂载（见 §2） |
| 死代码 JS | 5（audit-maritime-capabilities / e2e-gameplay-test / mainline-e2e / smoke-public-release / ai-task-narrative） | 已接入引用（§4） |
| 孤儿 JSON | 2（formal-stage-start-71.json / formal-stage-start-72-completed-tasks.json） | 已接入回归校验（§4） |
| dist/ 与 web/ 重复 | 完整快照关系 | 构建产物，不入库管理 |

视觉研判：229 张 PNG 分批人像/道具/怪物/船只目测通过，与 `display_name` 语义一致（附件
`artifacts/asset-review/*.png` 联系表 + `*.txt` 编号清单）；稀有版为 9 个 rare_glow 变体。

## 1. 集成决策（绑定 或 创建实体）

- **绑定已有实体**（填充 binding_ids/canonical_id）：28 怪物 + 29 NPC + 神秘铁箱/百宝箱 + 宠物蛋 +
  沙丁鱼/金枪鱼/鳕鱼 + 4 艘语义同型船（单栀帆船⇐小型单桅帆船 等。同名精确绑定额外补齐海盗船/幽灵船/
  三桅大型帆船/明永乐大帆船）。
- **创建缺失实体（数值锚定）**：
  - 装备 15（哥伦布套 Lv30-35 / 月宫套 Lv44-46 / 海军 Lv15 / 航海 Lv18-28 / 红宝石戒指 Lv35）：
    属性按库内曲线（武器 attack≈6+0.9Lv / 重甲 defense≈0.85Lv / 头盔 defense≈0.15Lv + morale≈0.38Lv /
    靴 defense≈0.5Lv+agility≈0.3Lv / 饰品 defense≈0.3Lv），lj≈300+6Lv——全部落在现存装备区间；
  - 普通物品 2：百宝袋 / 黄金金币（price=null，仅掉落）；
  - 剧情任务物 29：圣火令 / 龙珠碎片×4 / 通商卷轴 / 各钥匙 / 圣杯 / 玉筒 / 水晶头骨 / 漩涡怀表 等
    （price=null，不可交易，不进入经济系统；奖励挂接到提及它们的 12/13/15 章节任务）；
  - 怪物 2：狐仙（Lv88 泉州/丹霞山，type5）、邪恶花精（Lv152 威尼斯/后山）——属性由
    `monster.type-level.v1` 公式自动派生；**邪恶花精 补齐后，原版悬空掉落行（邪恶花精→小良的毛笔）
    在同名规则下自动解析**（adjudicate-blocked-targets 同名兜底）；
  - NPC 1：威尼斯国王（威尼斯/王宫，Lv55）→ 支线「御前嘱托」（sidequests.json，
    奖励 500 银贝/30 声望，区间内）讨伐海盗头子扎布拉；
  - 船只 7：双桅商船/武装商船/卡拉维尔帆船/海盗船/幽灵船/远洋帆船/大型鱼带泡船
    （价格 7000~26000、载重 65~130、速度 22~42，锚定现有 1000~26000 区间）；
  - 渔获 4：鲑鱼/common、螃蟹/common、章鱼/uncommon、剑鱼/rare（价格/稀有度对齐现有渔获表）；
  - 宠物 12：小猫/小狗/鹦鹉/小猴/小海龟/玉兔/幼狐/狼崽/凤凰雏鸟/小龙/龙虾（+宠物蛋已有）
    入 pets.json，属性锚定月虎 12/12/8/90 先例。
- **多倍掉落约束**：全部 0.4/1（与库内普通掉落一致），任务激活 guaranteed 由引擎接管；不影响经济。

## 2. 绑定重算结果（229 行）

| mapping_status | 行数 | 说明 |
|---|---|---|
| mapped_explicit_canonical | 30 | 文件名直连实体 |
| mapped_name_family | 79 | 怪物/NPC/装备同族绑定 |
| mapped_task_reference | 30 | 剧情物→任务文本引用（task_reference_ids 已挂 12/13/15 章节） |
| mapped_type_slot | 39 | 船型/宠物/渔获/场景类型槽位（含实体 binding 的 船上同名牌） |
| mapped_interface_slot | 42 | UI 图标/航海事件图/地点插图/功能 NPC 槽位（运行时按名渲染） |
| mapped_variant_family | 9 | rare_glow 变体（随基础族） |

运行时渲染：`visualForCanonical`（背包/战斗/任务）、`visualByName`（怪物/NPC/任务物/地点）、
`renderUiIcon`（界面）、`visualForMaritimeEncounter`（新增 12 个航海事件图别名）、
宠物图鉴按名渲染、主线终幕结算画面（威尼斯国王 + 圣火令 + 龙珠碎片·金 + 装备编年）。

## 3. 数值锚定校验

- 怪物：无手写属性，全部 `monster.type-level.v1` 派生（type5 公式）；
- 装备：属性/lj 由库内样本曲线函数生成，未超出同类型装备极值；
- 剧情物/百宝袋/黄金金币 price=null：不可交易、无购买/出售条目，不污染经济；
- 支线/渔获/船只/宠物：奖励与配置均落在现有区间。

## 4. 引用计数>0 接入清单

- npm scripts：`audit:maritime` / `e2e:manual` / `mainline:e2e` / `smoke:public`；
- server/server.js：require(ai-task-narrative) + `/api/game/task_narrative` 路由；
- scripts/build-formal-stage-start-72-fixture.js：对账 `formal-stage-start-72-completed-tasks.json`；
- tests/formal-core-e2e.test.js：legacy 71 检查点兼容回归（旧指针解析断言）；
- 全部 458 PNG：注册表（assets 229 行）与映射 CSV 同步，`verify:idle-assets` 断言覆盖。

## 5. 遗留说明（按既有策略不作为挂载缺口）

- 12 宠物 + 宠物蛋 + 6 世界场景视觉为「类型/界面槽位」——注册表策略
  `visual_layer_ids_do_not_create_game_entities:true`；运行时已按名渲染（宠物图鉴/首页/世界场景）。
- `威尼斯国王` 视觉为「终幕画面按名渲染」挂载点（NPC 实体在库/配置中存在，不入任务包白名单）。
