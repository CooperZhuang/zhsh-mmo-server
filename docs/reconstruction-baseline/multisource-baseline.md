# 《纵横四海》多源复原基线

生成日期：2026-07-17  
正式项目基线：5dc1564535c97aae4f937a7635a56a59e9941f3b
本次修订基于：73fa853a4b836b78de7de640726f026c9f35ac2a

## 1. 结论

本阶段建立了可由正式项目直接读取和导入的多源复原基线。JSON 已统一为无 BOM 的标准 UTF-8，并通过 Node.js 原生 `JSON.parse()`；在原有 31 条 `configs.records` 证据摘要之外，`configs.entities` 保存 15 类、5,708 条完整配置实体。四仓中只有 zhsh 保存了可读的完整任务正文，因此 651 条常规任务全部按 SINGLE_SOURCE 原样纳入；未因重复、现代词语、恶搞、时代错位或奇幻题材删改。Astrbot 提供了纵横四海任务、战斗、地图、市场和航行的现代实现交叉证据，但数据库 schema/seed 缺失，不能逐条证明任务或数值。dpcq 是另一题材文字 RPG，只用于结构与行为对照。zonghengsihai 是三文件外部 API 提示页，不是游戏内容源。

当前确定的开发原则是：任务真实前置按同一 JSON 数组相邻项，不按页面 index+1；跨文件连接保持待核实；数值冲突不平均；技术实现可以现代化，但不得改变内容基线。

## 2. 来源角色与覆盖

| 仓库 | 提交 | 文件数 | 角色 | 主要限制 |
|---|---|---:|---|---|
| zhsh | b841e0e7f6dfcc5ef5dccd22c42989b12847816e | 162 | 主要内容源：任务、对白、城市、地图、NPC、物品、装备、怪物、航海和 Node/EJS 行为 | 单一提交；views/pages/help.ejs 表明大量代码由 AI 编写且资料止于妖气长安350 |
| zhsh-game_astrbot | 807503c16e80aa9ea1c698e0fadd4e6ab5e564de | 132 | 纵横四海现代 Web 实现交叉源 | 缺全部数据库 schema、迁移和 seed；无法逐条对齐 651 任务 |
| dpcq | f39aa76ce4d5c95b7cf6c565d815618395eb1d39 | 139 | Laravel/SQL 文字 RPG 结构对照 | 斗破苍穹题材；无任务表，不可混入纵横四海内容 |
| zonghengsihai | 0b8996e8e5b7293321f9827994324d13e3c2509c | 3 | 外部 API 提示 Demo，用于排除误判 | 无游戏任务、地图、战斗、角色或存档 |

四仓均缺少 LICENSE 正文；zhsh/package.json 的 ISC 与 dpcq/composer.json 的 MIT 只是包清单字段，公开复用前仍需单独核验。

## 3. 比对方法

1. 生成并统计四仓完整文件清单，实际读取 JSON、SQL、JavaScript、Vue、PHP、EJS/Blade/HTML，而非只看文件名。
2. 完整解析 zhsh/config/task/task1.json–task15.json 的 651 条记录和全部字段；记录数组位置、原 index、原文对白、奖励、实际前后项及页面断裂标记。
3. 在 Astrbot 的 server/src/routes/quest.js、battle.js、map.js、market.js、sail.js 与 Vue 页面中核对行为；因数据库基线缺失，不把 SQL 查询字段当作内容事实。
4. 解析 dpcq/dpcq.sql 的 21 张表及控制器，用于核对建角、战斗、背包、装备、升级、撤退等结构；题材内容不进入纵横四海基线。
5. 检查 zonghengsihai/index.html:22-83，确认其每 5 秒轮询第三方 API，只记录为 IMPLEMENTATION_ONLY。

判定标签采用 CONSENSUS、SINGLE_SOURCE、CONFLICT、IMPLEMENTATION_ONLY、INCOMPLETE、DERIVED、UNKNOWN。所有 CONFLICT 主体均同步进入 JSON 的集中冲突清单。

### 3.1 数据层级与原作核实状态

- **原始单源内容**：任务原始记录保存在 `raw_source_record`，拆分前字段保存在 `raw_*`；配置实体原值保存在 `raw_data`。这些内容逐条指向 zhsh 的来源文件、JSON Pointer/数组位置和提交，不因规范化而改写。
- **规范化开发数据**：651 条常规任务的 `targets`、`required_quantities`、`required_items`、`kill_targets` 固定为数组；15 类配置实体在 `configs.entities` 中使用稳定 `canonical_id`、`original_display_name` 与 `normalized_data`，可直接作为导入输入。
- **多源冲突**：仍由 32 条 `conflicts` 集中登记，并与 32 个 `status=CONFLICT` 主体一一对应；冲突值不平均、不静默覆盖。
- **尚未核实为原作的内容**：zhsh 单源任务和配置实体保留为复原基线，但标记 `UNVERIFIED_AS_ORIGINAL`，不称为官方原版；尤其 task15 及宠物配置受 help.ejs 的 AI 代码声明影响，仍须外部史料核验。

## 4. 已确定的任务链

常规任务共 651 条，类型为：对话 372、打怪 142、收集 64、送物品 62、运货 11。全部有接取对白、提交对白和奖励来源；524 条未显式写等级字段，这表示当前代码无该条等级门槛，不应擅自补值。

| 文件 | 条数 | index | 判定 | 证据 |
|---|---:|---|---|---|
| task1.json | 13 | -1–11 | SINGLE_SOURCE | config/task/task1.json |
| task2.json | 1 | 12–12 | SINGLE_SOURCE | config/task/task2.json |
| task3.json | 1 | 13–13 | SINGLE_SOURCE | config/task/task3.json |
| task4.json | 7 | 14–20 | SINGLE_SOURCE | config/task/task4.json |
| task5.json | 19 | 21–39 | SINGLE_SOURCE | config/task/task5.json |
| task6.json | 1 | 40–40 | SINGLE_SOURCE | config/task/task6.json |
| task7.json | 3 | 41–43 | SINGLE_SOURCE | config/task/task7.json |
| task8.json | 4 | 44–47 | SINGLE_SOURCE | config/task/task8.json |
| task9.json | 2 | 48–49 | SINGLE_SOURCE | config/task/task9.json |
| task10.json | 10 | 50–59 | SINGLE_SOURCE | config/task/task10.json |
| task11.json | 28 | 60–87 | SINGLE_SOURCE | config/task/task11.json |
| task12.json | 13 | 88–100 | SINGLE_SOURCE | config/task/task12.json |
| task13.json | 69 | 101–169 | SINGLE_SOURCE | config/task/task13.json |
| task14.json | 10 | 170–179 | SINGLE_SOURCE | config/task/task14.json |
| task15.json | 470 | 180–738 | SINGLE_SOURCE | config/task/task15.json |

zhsh/src/task.js:594-648 明确把每个任务文件视为一个系列，并以数组位置前一项作为前置。15 个文件的第一项都可在等级满足时独立接取，跨文件没有强制前置。views/pages/npc-task-direct.ejs:17-31,112-125 却用 index+1 生成“继续”，因此 task15 的 312→400、647→649、685→687 三处只断页面直达，不改变核心数组前置。

task15/274 有三种目标但只有一个原始数量 `"5"`，和 src/task.js:150-161 的逐项数量解析不兼容，是明确待修技术缺陷。开发字段保存为 `targets=["沼泽蜂","沼泽鼠","沼泽玄龟"]`、`required_quantities=[5,null,null]`；后两项不得猜测，并同时引用 `conflict.system.task.progress` 与 `backlog.task.quantity-274`。

收集、送物和运货提交会先检查背包数量，但 src/task.js:186-191,445-452 按名称调用 Backpack.removeItem，而 src/backpack.js:19-31 只按 ID 删除且忽略数量参数，所以当前实际行为通常不消耗任务物品；这是技术修复项，不改变任务需求。

## 5. 已确定的剧情顺序

JSON 中归纳了 20 个剧情节点。除开场冲突外，其余节点标为 DERIVED：节点名是开发用归纳，不冒充官方章节名；顺序只由任务数组和标题直接推导。

- 威尼斯新手阶段：task1.json index -1–11，按老板、福利官、卡萨诺、里皮、小皮特、凯瑟琳小姐、因扎推进。
- 海盗与铁箱候选主线：task5.json index 21–39；32–38 连续形成铁箱→图纸→潜水材料→海皇宝箱→箱中物→徽章→詹姆斯，但 39 立即回到送酒，谜底缺失。
- 通商与龙珠候选链：task13.json index 101–169 和 task14.json index 170–179 连续包含通商、圣火令、玄铁重剑、亚丁、亚特兰蒂斯航海图和龙珠碎片；题材跳跃原样保留。
- 寻裔之路：task15.json index 180–210。
- 聚宝盆：task15.json index 211–312。
- 妖气长安、蓬莱、八仙与地魔：task15.json index 400–738；最后一项是击败地魔戈蒂拉并救回张真人和苦难大师，没有后记或正式结局。

views/pages/intro.ejs:1-70 有离乡远航遭海盗的开场，src/city.js:12-21 和 index.js:83-94 的实际新用户却直接位于威尼斯酒馆。两者均保留，缺失连接不补写，尤其不采用“在船上苏醒、主角是中国海员或船员”等无源码证据设定。

## 6. 配置与数值基线摘要

机器基线保留 31 条配置证据摘要，并新增以下可直接导入的完整实体。原摘要中的两个计数已按源文件逐项复核纠正：地点关系不是 475 条，而是 445 条城内地点成员关系加 182 条野外入口映射，共 627 条；城市商品不是 106 个区间，而是 54 个区间，106 是已填写的上下界端点数。

| 实体集合 | 条数 | 主要来源 |
|---|---:|---|
| 世界分区 | 6 | config/worldMap.json |
| 城市 | 40 | config/cityMap.json |
| 地点 | 641 | config/insideMapFlat.json |
| 地点连接 | 627 | config/insideMap.json |
| NPC 放置 | 636 | config/npcs.json |
| 物品 | 153 | allItems/shopItems/taskItems/fish |
| 装备 | 423 | config/equipment.json |
| 怪物放置 | 278 | config/monsters.json |
| 掉落关系 | 2732 | monsterDrops/monsterItems |
| 商店条目 | 63 | config/cityShop.json |
| 城市商品价格区间 | 54 | config/marketItems.json |
| 船只 | 14 | config/ship.json |
| 鱼类 | 21 | config/fish.json |
| 宠物配置段 | 8 | config/pet.json |
| 试炼任务 | 12 | config/trial.json + src/task.js |

上述 15 类合计 5,708 条；另有 210 级经验表、23 个航海特殊事件和 2 条特殊航线遭遇保留在证据摘要中，但不在本次最低要求的 15 类逐条实体统计内。

已经确认的精确冲突包括：

- 初始属性：zhsh/src/play.js:5-24 为 HP100、攻50–80、防4、敏3；Astrbot server/src/routes/auth.js:34-55 为 HP100、攻1–28、防0、敏0、铜10000；dpcq/CreateRoleController.php:42-53 为 HP500、攻20–30、防12。
- 等级经验：zhsh/config/exp.json 有 210 项；Astrbot 用基础500、每级+300；dpcq.sql 有 168 条等级记录。
- 市场：zhsh/config/index.js:139-147 在进程加载时从城市区间随机取价；Astrbot market.js:24-98 以日期确定 ±15%，卖出九折。
- 航海概率：zhsh/sailingSpecialEvents.json 多数事件为 0.3%–3%；Astrbot sail.js:54-101 途中海盗20%、到港宝藏40%。
- 船速：zhsh/config/ship.json 包含速度92，Astrbot README 将速度限制为1–5；不能直接映射。

所有冲突均保留原值，没有取平均或现代化平衡。

## 7. 系统行为基线

机器基线记录 26 条系统规则。多源一致支持：账号/建角、地点连接移动、NPC 交互、任务接取—推进—提交状态、地点内战斗、经验升级、背包物品生命周期、装备穿脱、商店交易、货币、状态持久化，以及持船从码头航行的核心环。

不得直接定稿的行为包括：

- 任务前置：zhsh/src/task.js:594-648 的数组相邻前置与 Astrbot quest.js:14-76 的 pre_quest_id 模型不同；651 条内容按前者复原。
- 伤害：zhsh/src/monster.js:24-49 用比例防御、敏捷差和15%基础暴击；Astrbot battle.js:149-159,304-311 是攻减防最小1；dpcq 还用速度产生多段攻击。
- 撤退：zhsh/views/pages/attack.ejs:31 显示付500铜，src/monster.js:52-58 实际加500铜；Astrbot 是50%逃跑；dpcq 按敌人撤退费扣金币。
- 战败：Astrbot 扣5%铜、以10%HP送当前城酒馆；其他源没有一致处罚。
- 玩家技能：未找到完整技能目录，不能从宠物技能、装备特效或按钮推断。

Vue、Laravel、Express、MySQL、SQL.js、Redis、WebSocket 和第三方 API 只属于技术实现证据，不自动视为原作玩法。

## 8. 各来源独有内容

- zhsh：651 条常规任务与全部对白、12 条试炼、完整 JSON 内容配置、钓鱼/潜水/航海事件、宠物、套装、帮会、婚姻、邮件等。
- Astrbot：移动优先 Vue 客户端、管理后台、显式任务表模型、数据库市场、实时航行和 WebSocket；精确内容因数据库缺失不可复原。
- dpcq：21 表 SQL 转储、速度多段战斗、吸血/麻痹、分离装备包/道具包；题材数据不进入纵横四海内容。
- zonghengsihai：第三方提示 API 轮询与字段映射；不属于游戏基线。

## 9. 主要冲突与实现断裂

集中冲突共 32 条，完整版本在 JSON conflicts。最高风险项为：开场不可达、任务文件跨系列关系缺失、task15/274 无法正确提交、三处 index+1 页面断裂、詹姆斯线无谜底、任务 NPC/地点漂移、航速字段错位、撤退费用方向错误、传送显示收费但不扣费、初始属性/升级/伤害/航行概率多源冲突。

Astrbot 缺数据库 schema、migration、seed 是关键资料缺口；在补齐前，不能把其 README 所称 7 城、主线/支线/日常或 API 表字段视为完整内容事实。

## 10. 后续接入顺序

1. 先导入稳定标识、40 城、地点连接、NPC 与 651 条任务原文；以 JSON 的 predecessor_task/successor_task 为准。
2. 修复只影响可玩的明确技术断裂：任务274数量维度、三处继续链接、航速字段、已证实的 NPC/地点错位；任何数值未知项保持待核实。
3. 接入背包、物品、装备、怪物、掉落、任务状态和存档，逐条用机器基线验证。
4. 在单独决策中选择战斗、升级、市场和航行的冲突版本；不得混合平均。
5. 完成可玩基线后再接入宠物、钓鱼、潜水、帮会/聊天等扩展，并继续区分内容规则与技术实现。

## 11. 暂时不得实现为最终定论

- 海盗开场如何连接威尼斯酒馆，以及主角身份。
- 15 个任务文件的官方统一主线顺序和跨文件前置。
- 铁箱、图纸、箱中物、徽章、詹姆斯的真实谜底。
- 龙珠、寻裔之路、聚宝盆、妖气长安之间的正式因果。
- 地魔之后的最终敌人、正式结局和龙珠最终用途。
- 三套初始属性、升级、伤害、撤退、死亡、市场、航时和随机概率中的最终版本。
- task15 逐条官方原版归属；单源内容在核实前仍全部保留。

## 12. 交付边界

本阶段没有修改正式游戏代码，没有安装依赖、启动服务、导入数据库或运行参考仓库程序。基线 JSON、两份 Markdown、验证摘要和 ZIP 已更新；新增构建与验证脚本用于复现逐条实体和检查结果。参考仓库保持只读。
