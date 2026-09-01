# 外部仓库玩法型任务目标吸收 — 本地缩放规划

> 依据外部仓库 `docs/design/_external-zongheng-game-data.gd`（数值表：`TRADE_GOODS` / `RECIPES` / `TRADE_ORDERS` / `ENEMIES`），
> 按「参考外部结构 + 数值锚定本项目基准」原则吸收到本项目。**只吸收玩法机制与数据形态，不照搬绝对数值。**

## 一、本项目基准锚点（缩放换算依据）

### 1. 装备经济曲线（`src/task-runtime/formal-gameplay.js` + `integrate-idle-assets.js`）
- 价格 `lj ≈ 300 + 6*Lv`（库内装备 359~510 区间，reqLv 17~55）。
- 武器 `attack ≈ 6 + 0.9*Lv`；重甲 `defense ≈ 0.85*Lv`；头盔 `defense≈0.15*Lv + morale≈0.38*Lv`；
  靴 `defense≈0.5*Lv + agility≈0.3*Lv`；饰品 `defense≈0.3*Lv`。

### 2. 怪物属性（`monsterStats`，`src/task-runtime/formal-gameplay.js`）
- 由 `monster.type-level.v1` 公式派生：`health=floor((50+20*(Lv-1))*hpMult)`，
  `attack=floor((8+4*(Lv-1))*mult)`，`max_attack=floor((12+6*(Lv-1))*mult)`，
  `defense=floor((8+3*(Lv-1))*mult)`，`agility=floor((5+2*(Lv-1))*mult)`。
- `hpMult`/`mult` 按 `monster_type`(40/45/6/50/55) 查表（40:1.5, 45:2.5, 50:2, 6:3, 55:3.5）。
- 植物/矿物型(type 3/4)：`health=floor(200+300*(Lv-1)/209)`，defense=10000（近战无效）。

### 3. 商品价格（`server/content/goods.json`）
- 区域 specialty 商品，`base_price ≈ 500`；多区域商品构成市场套利的价差基准。

## 二、外部数值结构 → 本地方案

### 1. 烹饪配方 `RECIPES`（cook 目标）
外部结构：`{"port","cargo":{good:qty},"silver":cost,"result","description"}`。
- **本地化**：`cargo` 用本项目已有的物品/商品（`content_entities` 之物品、`goods.json` 商品），
  `result` 产出「餐食」物品（新增，属性按装备/效果曲线锚定），`silver` 手续费按配方等级缩放。
- 餐食效果：多场战斗 buff（attack/defense/max_health），数值锚定同等级装备单件属性量级。

### 2. 贸易商品 `TRADE_GOODS`（trade_sell / trade_order 目标）
外部结构：`{"name","unit","space"(载重),"supply","demand","origin"(产地港),"prices"(各港)}}`。
- **本地化**：用本项目 12 区域/城市（`server/content/goods.json` 的 region.specialty）映射为若干商品，
  每个商品有 `origin`（产地城市）+ 各城 `prices`（产地低、异城高，梯度参考外部 24→142）。
- **价格锚定**：绝对价格按本项目 `base_price≈500` 缩放（外部 24~142 → 本地 ×~3.5 到 500 量级），
  且同一商品产地价/异城价比例沿用外部（如威尼斯玻璃产地 24、阿姆斯特丹 86，约为 3.6 倍）。

### 3. 港口订单 `TRADE_ORDERS`（trade_order 目标）
外部结构：`{"title","port"(交货港),"good","amount","bonus","reputation","description"}`。
- **本地化**：订单 = 在某交货港交付某商品若干件，得银币 `bonus` + 港口 `reputation`。
  `bonus` 按商品市场价差锚定（确保跑单有利可图但不破坏经济平衡）。

### 4. 护航物资（prepare_voyage 目标，外部在 ship_owner 对话提及）
- 出航前购买护航物资，降低本航程风险/抵消一次风暴。数值锚定商品价格量级，不可囤积（每航程绑定消耗）。

### 5. 港口声望 `trade_reputation`
- 完成订单累积，阈值达标。锚定本项目城市/商会系统（`GuildRuntime`/`CityRuntime`）。

## 三、target_kind 扩展
新增：`cook`、`trade_order`、`trade_sell`、`prepare_voyage`、`trade_reputation`、`upgrade_ship`。
- 任务引擎 `task-engine.js` 的 `advanceTarget`/`syncItemTargets` 增加对应推进挂钩。
- 事件来源：Cook/Order/Sell/Prep 运行时产生事件 → `advanceTarget` 推进进度。

## 四、叙事层（story + 章卷）
- 给 651 个任务补 `story`（剧情化目标叙述），文风参考外部 `STORY_CHAPTERS`/`STORY_VOLUMES`，
  内容锚定本项目原版任务（基于 `normalized_value`/`dialogues` 提炼），不改变任务数值与结构。
