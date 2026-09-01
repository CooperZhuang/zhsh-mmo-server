# 外部仓库可吸收内容总表（976971956/zongheng-sihai）

> 来源：Godot 4 手机竖屏 2D 航海 RPG《纵横四海：潮汐纪事》，基于苏摩科技 2009 年 WAP QQ 家园旧版。
> 本表 = 本项目可吸收项，按价值排序。标注「已吸收」= 已落地。

## 1. 怪物状态效果（最高价值，尚未实现）
外部 `ENEMIES[].effect` 与 `[].special` 结构清晰，可直接迁移：

```gdscript
# effect：普攻概率施加的持续状态
"effect": {"name": "中毒", "chance": 0.12, "rounds": 3}
# special：每 N 回合触发的强力技能
"special": {"name": "裂地重击", "every": 3, "damage_multiplier": 1.45}
```

**迁移到本项目**：给 `monster_definitions` 增加 `effect`、`special` 字段；战斗结算（`CombatRuntime`）在每回合随机判定 `effect` 施加，`special` 按 `round % every === 0` 触发伤害倍增。状态效果作用于玩家攻击/防御/速度，可被「万能药」解除。

**价值**：让战斗深度从纯数值对轰升级为「状态博弈 + 技能节奏」，是最能提升日常游玩体验的一项。

## 2. 装备套装分段共鸣（已在外部验证设计，本项目缺失）
外部 `EQUIPMENT_SETS[].bonuses` 用 `pieces: 2/4/6` 分段激活：

```gdscript
"bonuses": [
  {"pieces": 2, "stats": {"attack": 3, "defense": 2}, "drop_bonus": 0.08},
  {"pieces": 4, "stats": {"max_hp": 24, "speed": 3}, "drop_bonus": 0.12},
  {"pieces": 6, "stats": {"attack": 5, "defense": 4, "speed": 2}}
]
```

**迁移到本项目**：装备表增加 `set_id`；运行时 `effectiveStats` 按已装备同 `set_id` 件数取 2/4/全套加成（攻防/体力/速度/寻宝）。

**价值**：比「全套才生效」平滑，形成换装取舍的长线追求。

## 3. 敌人 rank 分层（普通/精英/首领/副本 Boss/海上）
外部 `ENEMIES[].rank` 五档，配 `sea_enemy: true` 标记海上敌人。

**迁移**：本项目怪物已有 `encounter_type`/`repeatable`，可加 `rank` 字段，用于战利品质量与掉落权重分层，以及「精英词条」在目标中的体现（目标约束提到）。

## 4. 副本 Boss 掉落与阶段结构
外部副本入口 `location.exits[].requires_defeat` + `level` 控制逐层解锁；Boss 层必定掉套装部件。

**迁移**：本项目已有 `dungeons`，可加「层间解锁 = requires_defeat 对应怪」的校验，保证副本顺序通关。

## 5. 数据驱动地点图（Location 有向图 + 文案/服务/敌人规范化）
外部 `LOCATIONS[].{name,tag,chapter,description,flavor,exits,npcs,enemies,services}` 全规范化。

**迁移**：本项目地图已是图结构，可补充 `tag`（安全区/商业区/首领区/状态区）与 `flavor`（文本化状态提示），增强区域辨识度与文案策略性。

## 6. 测试方法论（playability_test / sailing_system_test）
外部测试检查完整链路、图可达、数值边界。

**迁移**：本项目近期已转向「内存级 651 全主线求解器 + 服务端 API 通关」两层测试，思路一致，可借鉴其「每层副本必须顺序击败守卫」的图可达断言。

---

## 已评估「暂不吸收」
- **2D 即时驾驶/摇杆/海图**：本项目是文字 MMO，形态不符。
- **私人舰队/付费神水/失败等待**：违背本项目禁止商用与离线单机定位。
- **宝石镶嵌多孔**：需先迁移装备为独立实例（本项目现为 ID 保存），成本高，列为后续。
