# E2E 黑盒通关 · Bug 修复审计日志

> 阶段二/三实测记录（2026-08-30）。格式：触发条件（阶段一断言/阶段二卡关）→ 定位 → 修复（Unified Diff 摘要）→ 验证。

## 已修复（已提交或已落盘）

| # | 缺陷 | 定位 | 修复 | 验证 |
|---|---|---|---|---|
| 1 | 启动画面统一报 `POST /api/logs` 404 | `web/app.js:93` 客户端结构化日志桥在「服务器权威版」无路由（单人版 dev-server 曾提供，1ef5426 移除后残留） | `server/server.js` 新增 `/api/logs` POST 路由（204 接收） | 重启测试服后浏览器控制台 0 error |
| 2 | DOM E2E 浏览器无法启动（Edge 直退 code=0） | Edge 新版进程拆分：`msedge.exe` 为 broker，拉起 `new_msedge.exe` 真身后自行退出；`edge-cdp.js launchEdge` 把 broker 退出判为浏览器死亡 | `launchEdge` 仅对非 0 退出立即判死；broker code=0 继续等 DevToolsActivePort | 无头 Edge 15.1 启动成功，dom-e2e 推进到游戏内 |
| 3 | 浏览器测试挂载的 `scripts/dev-server.js` 不存在 | 1ef5426 移除单人版启动器，`browser-tests/edge-cdp.js startStaticServer` 仍 spawn 之 | `startStaticServer` 改用 `server/server.js`（PORT/HOST env + 临时 runtime.sqlite 副本），`stopStaticServer` 清理临时目录 | `test:browser-tutorial` 从 3s 失败推进到游戏内流程 |
| 4 | harness `createNewSave` 卡在 location 页 | 服务器权威版「注册即开局」，无开始屏；harness 仍按内联版「new-game → location」编写 | `createNewSave` 增加注册步骤（填角色名/密码 → 注册并进入 → 无开始屏直接 location） | 注册成功进入游戏（页面实测） |
| 5 | 移动断言间歇失败：'威尼斯' !== '酒馆' | 地点→地点过渡不改 `data-page`，`waitPage('location')` 立即返回后读取异步渲染前的旧文本（服务端渲染竞态） | `waitLocationName(expected)`：等待 `.current-location` 文本等于预期后再断言 | dom-e2e 通过 map movement 阶段 |
| 6 | 目标怪消失（前置跑位）：开局城威尼斯出现 Lv152 wild/repeatable 花精 | `integrate-idle-assets` 把邪恶花精放置在开局城（锚定违规：Lv152 boss 不应出现在新手城） | 迁移至 杭州/野外（与 Lv149 邪恶僵尸同区）；`ensureMonster` 增加旧放置迁移（改配置即挪位置） | 怪物放置分布复核：威尼斯最高 Lv 回到原基线 |
| 7 | 主线主条目变化导致部分编译流程断点 | 内容库扩展（物品 246/装备 438/怪物放置 287/掉落 2798/船 21/鱼 25）与注册表重绑定 | `src/data/validator.js` EXPECTED_COUNTS 同步；`select-runnable-tasks` 渔获锚点 21→25（扩展证据体量时同步锚点） | `data:validate` PASS；`formal-core-e2e` 4/4 |

## 本回合新修复（自愈层）

| # | 缺陷 | 修复 |
|---|---|---|
| 8→已修 | 战斗开始后页面不进入攻击页（装备时代遗留竞态） | fight() 等待攻击控件出现；遭遇页未挂载目标怪时重开遭遇页；活跃战斗直接续战； 自动重开战斗 |
| 11 | 提交/接受完成反馈被异步叙述覆盖 | 完成后门改为观察 /api/game/state（DOM 动作 + 状态断言的合法拆分），waitTaskDone 取代消息正则 |
| 12 | 任务目标怪定位缺失（target.location 为 null 的怪） | monsterLocationFor：任务目标地点优先，否则按怪物放置位置定位 |
| 13 | 商店页无法从主导航进入 | ensurePage('shop') 走地点页【商店】入口 |
| 14 | 移动图与运行时可移动子集不一致（01.009 断边） | reach() 自愈：缺边回城市枢纽重规划 + 页面重载回溯 |
| 15 | 浏览器重开后等待 continue-game 超时 | 重开后应用会直接回到 location，等待二者其一 |

| 16 | 01.010 出海步：data-voyage-start=route.f244… 未找到（8.9 分钟跑程推进至此） | 该航线为 雅典→威尼斯（from_port=3f23f155@雅典），sail() 到达 from_port 后航线未出现在航行页；疑似 运行时当前节点与航线 from_port 节点/城市分叉（雅典 87a20d 与条目节点 3f23f155 归属核对），下一轮核对至日期待续 |

## 未修复（下次推进，附证据）

| # | 缺陷/风险 | 证据 |
|---|---|---|
| 8 | ~~defeat-and-recovery 战斗不结算~~（本回合已修；4199 手工全流程与无头战斗验证通过） | `[COMBAT-DEBUG] attack=0, page=encounter, 7 个进入战斗`——点击 `data-combat-start` 后页面仍停留 encounter；API 复现 `Monster is not at the current formal location`（4199 服务器在酒馆调用时正确返回该错误，属预期判定；harness 场景在你 矿山 点击后页面未进入攻击页，疑似服务端「当前正式位置」与 placement 位置判定在部分场景不一致，需继续复现） |
| 9 | legacy 导入场景（1/13 save）已与服务器权威版脱节 | `importLegacy → 导入结果已保存 → location` 等待超时；服务器版 import 为 no-op（`storage.importPlayer` 跳过）——该场景需要按服务器版重写或废弃 |
| 10 | ~~内容图不可达放置~~（被同名节点误导：威尼斯/矿山 hub→北城门→矿山 可达；山地虎@威尼斯/矿山 正常列出，仅任务独占怪按激活任务显示） | BFS 酒馆→矿山 无路径（矿山仅邻 古村落，古村落未接入枢纽）；山地虎@威尼斯/矿山 即此类——需要核查 location_connections 是否缺边（疑为原版数据保留或导入缺口） |

## 说明

- 第 6 号缺陷是**本阶段集成引入并已自愈**；第 8-10 号为既有/服务器版演进遗留，作为下一轮黑盒通关的主要对象。
- 黑盒通关主线路由 `browser-tests/dom-gameplay-runner.js`（内联时代）与服务器权威版并存；本次已把**启动器、认证、移动竞态**三处对齐服务器版，战斗与保存语义尚待对齐。
