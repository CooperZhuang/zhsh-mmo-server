# 旧源码初步盘点

盘点日期：2026-07-17  
盘点范围：仅对指定公开仓库执行 `git clone`、读取文件和静态目录分析。未安装依赖，未运行仓库脚本、批处理文件、可执行文件，未启动服务，未修改参考仓库内容。

## 1. 结论摘要

四个仓库均克隆成功，并与正式项目保持物理目录隔离。参考源码全部位于 `本地参考资料目录`，正式项目中仅新增本报告。

| 仓库 | 默认分支 | 当前提交 | 数据库情况 | 当前能否直接运行 | 初步定位 |
|---|---|---|---|---|---|
| `temorot/zhsh` | `main` | `b841e0e7f6dfcc5ef5dccd22c42989b12847816e` | 代码内创建 14 张 SQL.js 表；无独立 SQL/迁移/预制数据库 | 否 | Node.js/EJS 文字航海游戏原型，游戏配置较丰富 |
| `975269528/zhsh-game_astrbot` | `master` | `807503c16e80aa9ea1c698e0fadd4e6ab5e564de` | 仅有数据库变更说明；无 schema、迁移、seed 或 SQL 文件 | 否 | Vue 3 客户端 + Vue 3 管理端 + Express/MySQL/WebSocket 服务端 |
| `MVP-daijialong/dpcq` | `main` | `f39aa76ce4d5c95b7cf6c565d815618395eb1d39` | `dpcq.sql` 含 21 张表及大量初始/测试数据 | 否 | Laravel 6 + Blade/Layui 的文字 RPG 原型 |
| `hanwolfxue/zonghengsihai` | `master` | `0b8996e8e5b7293321f9827994324d13e3c2509c` | 无 | 仅静态页面可打开，但功能依赖外部 API | 三文件静态轮询提示页，不是完整游戏项目 |

共同情况：四个仓库根目录都没有 `LICENSE`、`COPYING` 或 `NOTICE` 文件。`zhsh/package.json` 声明 `ISC`，`dpcq/composer.json` 声明 `MIT`，但均缺少许可证正文；另外两个仓库未发现仓库级许可声明。后续复用前仍需核验授权范围。

## 2. 保存位置与隔离情况

- 正式项目：`本项目目录`
- 参考源码根目录：`本地参考资料目录`
- `temorot/zhsh`：`zhsh`
- `975269528/zhsh-game_astrbot`：`zhsh-game_astrbot`
- `MVP-daijialong/dpcq`：`dpcq`
- `hanwolfxue/zonghengsihai`：`zonghengsihai`

四个参考仓库克隆后的 `git status --short` 均为空，静态检查期间未修改其内容。未发现旧源码被复制到正式项目中。

## 3. 仓库逐项盘点

### 3.1 `temorot/zhsh`

**Git 信息**

- 默认分支：`main`（`origin/HEAD -> origin/main`）
- 当前分支：`main`
- 当前提交：`b841e0e7f6dfcc5ef5dccd22c42989b12847816e`

**技术栈**

- Node.js、Express 5、EJS、express-session
- SQL.js（SQLite/WASM 形式的文件数据库）
- Webpack 5
- 大量 JSON 游戏配置；另有 Turf、Multiavatar 等依赖

**主要目录和功能模块**

- `config/`：城市、世界地图、商店、装备、怪物、NPC、掉落、宠物、船只、航海事件、副本、任务等约 50 个 JSON 配置文件。
- `config/task/`：15 份任务配置。
- `src/`：用户、战斗、背包、装备、强化、任务、队伍、帮会、宠物、钓鱼、聊天、城市、航海、NPC、怪物、数据库等领域模块。
- `views/pages/`：登录、注册、主界面、地图、战斗、任务、背包、装备、宠物、帮会、市场、婚姻、邮件、航海等约 80 个 EJS 页面。
- `index.js`：Express 入口、认证/session、路由和页面调度。

**数据库结构**

- 没有独立 `.sql`、migration、schema 或预制 `.db` 文件。
- `src/database.js` 在运行时创建 14 张表：`user_data`、`users`、`chat_messages`、`teams`、`gangs`、`gang_members`、`gang_storage`、`gang_donations`、`friends`、`pets`、`marriage_proposals`、`marriages`、`weddings`、`mails`。
- 结构定义与数据库访问集中在一个约 1900 行文件中。仅凭静态阅读可确认主要持久化表存在，但未运行验证，不能确认所有业务路径与表结构完全一致。

**初始化数据**

- 没有关系数据库 seed 或预制用户数据库。
- `config/` 中有较完整的游戏静态数据，可视为内容初始化来源；用户状态主要由代码默认值和运行时写入生成。

**安装和启动说明**

- `readme.md` 只写明 `npm start` 和 `http://localhost:3000/main`。
- 缺少 Node 版本、依赖安装、构建、数据库文件位置和生产部署说明。
- 本次未执行 README 中的启动命令。

**LICENSE**

- 无 LICENSE 文件。
- `package.json` 的 `license` 字段为 `ISC`。

**明显缺失或不一致**

- `package.json` 没有 `"type": "module"`，但 `index.js` 和 `src/*.js` 使用 ESM `import`；`npm start` 直接运行 `index.js`，存在模块模式不匹配风险。
- 没有独立数据库 schema、迁移、测试数据或有效自动化测试；`npm test` 明确是占位失败命令。
- README 过于简略，无法形成可复现安装流程。

**是否可能直接运行**

- 当前不能直接运行：没有 `node_modules`，且存在上述 ESM 配置疑点。
- 即便后续安装依赖，也应先静态修正配置并在隔离环境验证，不能视为开箱即用。

**后续可能值得复用或参考的内容**

- `config/` 中的城市、航海、怪物、掉落、装备、任务和 NPC 数据组织方式。
- `src/` 的游戏领域划分和部分数值/状态流程。
- EJS 页面覆盖的功能清单，可用于核对旧玩法范围。
- 这些内容只能作为候选参考，授权、数据质量、安全性和业务正确性尚未验证。

**移动端响应式改造适配度**

- 有 viewport 设置，部分页面使用 flex，但未发现系统性的媒体查询和统一响应式组件层。
- 文字页面结构相对简单，具备改造基础；现有视图数量多、内联样式较多，预计需要统一布局和交互层。
- 初步评价：中等，适合参考信息架构，不适合原样套用。

**未来迁移到 CloudBase 的适配度**

- 静态 JSON 内容较容易迁移或转成云数据库初始化数据。
- Express 单体、SQL.js 本地文件持久化、进程内 session/缓存不适合直接搬到无状态云函数环境，需要重构认证、会话、存储和并发写入方式。
- 初步评价：内容层可参考，后端需较大改造；本报告不据此决定最终技术架构。

**安全与质量风险**

- 用户密码以明文写入并用明文条件查询验证。
- session secret 硬编码为 `zhsh_game_secret`，且 session 中间件重复注册。
- `express.static('./')` 暴露项目根目录，可能连同源文件、配置、构建文件及运行时 `user_data.db` 一并被静态访问。
- 使用 express-session 默认内存存储，不适合生产环境。

### 3.2 `975269528/zhsh-game_astrbot`

**Git 信息**

- 默认分支：`master`（`origin/HEAD -> origin/master`）
- 当前分支：`master`
- 当前提交：`807503c16e80aa9ea1c698e0fadd4e6ab5e564de`

**技术栈**

- 服务端：Node.js、Express 4、MySQL2、WebSocket (`ws`)、JWT、bcryptjs、dotenv。
- 游戏客户端：Vue 3、Vue Router、Pinia、Vite。
- 管理后台：Vue 3、Element Plus、Axios、ECharts、Pinia、Vite、Sass。
- 部署说明涉及 Nginx、nohup/PM2。

**主要目录和功能模块**

- `server/src/routes/`：认证、玩家、战斗、聊天、地图、NPC、任务、宠物、公会、好友、市场、航海、赌场、排行、铁匠等 API。
- `server/src/routes/admin/`：管理员认证、玩家、地图/地点、NPC、怪物、物品、任务、宠物、船只、配置、枚举、日志和变更记录等管理 API。
- `server/src/ws/`：WebSocket 实时通信。
- `client/src/views/`：23 个左右的游戏页面，另有底部导航、状态栏、战斗覆盖层和组合式 API。
- `admin/src/`：后台布局、路由、状态、API 封装、通用表格组件及各管理页面。

**数据库结构**

- 没有 `.sql`、migration、schema、seed 文件，也没有模型目录。
- 服务端代码直接查询大量 MySQL 表，包括 `user`、`inventory`、`item`、`map`、`place`、`npc`、`npc_dialog`、`npc_shop_item`、`monster`、`quest`、`user_quest`、`pet`、`user_pet`、`ship`、`cargo`、`goods`、`market_price`、`guild`、`guild_member`、`friend`、`chat`、`battle_log`、`bank_log`、`admin_user`、`admin_log`、`game_config`、`enum_definition`、`data_changelog` 等。
- `DB_CHANGES.md` 只是变更记录，不是可导入结构。
- README 明确写着“需根据实际情况准备 SQL 文件”，因此数据库结构不完整。

**初始化数据**

- 无可执行 seed、SQL 或数据快照。
- README 提到默认管理员密码 `admin123`，但仓库没有创建 `admin_user` 或该账号的 SQL，无法仅靠仓库重建。

**安装和启动说明**

- README 包含 Node/MySQL 版本要求、三端依赖安装、环境变量、数据库创建、前端构建、服务启动、Nginx 和本地开发说明。
- 说明相对完整，但关键数据库结构和初始化数据缺失。
- 本次没有执行任何安装、构建或启动命令。

**LICENSE**

- 无 LICENSE 文件。
- 各 `package.json` 未发现仓库级 license 声明。

**明显缺失或不一致**

- README 要求复制 `server/.env.example`，实际仓库没有该文件。
- README 目录树列出 `server/src/models/`，实际没有该目录。
- 缺少全部数据库 schema、迁移和初始化数据，是阻止复现的核心缺口。
- 根目录 `package.json` 只含 `puppeteer-core`，与三端依赖管理分离，README 未解释用途。

**是否可能直接运行**

- 不能。当前没有 `node_modules`，没有环境配置样例，且数据库结构/初始数据缺失。
- 即使安装依赖，服务端也会因所需 MySQL 表不存在而无法完整工作。

**后续可能值得复用或参考的内容**

- Vue 3 移动端客户端布局、底部导航、战斗层、状态管理和 API/WebSocket 封装。
- 管理后台的模块划分、通用表格、数据配置、日志和审计页面结构。
- Express API 的领域路由拆分，以及代码中反映出的数据库实体清单。
- 因缺少数据库基线，业务正确性和端到端完整性无法确认。

**移动端响应式改造适配度**

- 客户端明确采用移动优先样式：viewport 禁止缩放、`100dvh`、触控优化、底部导航、主体最大宽度 480px。
- 管理端有 viewport、flex/grid 和部分 1400px/900px 媒体查询，但大量表格页面仍需单独检查窄屏体验。
- 初步评价：四个仓库中移动客户端基础最好；后台是部分响应式。

**未来迁移到 CloudBase 的适配度**

- 两个 Vue SPA 可作为静态前端候选，前端代码与 API 层已有一定分离。
- Express + MySQL + 独立 WebSocket 长连接服务不是直接迁移形态；需重新处理数据库、认证、实时通信、后台任务和部署边界。
- 初步评价：前端适配度较高，后端迁移工作量较大；本报告不据此选择最终方案。

**安全与质量风险**

- `config.js` 在未设置环境变量时回退到固定 JWT secret（`change_me_jwt_secret` / `change_me_admin_jwt_secret`）和 root/空密码数据库配置。
- README 暴露固定默认管理员密码 `admin123`；如果后续恢复该数据，必须视为不安全默认值。
- 缺失 `.env.example` 增加误用默认密钥和空数据库密码的概率。
- 未发现真实密钥、证书、私钥、压缩包或可执行二进制程序。

### 3.3 `MVP-daijialong/dpcq`

**Git 信息**

- 默认分支：`main`（`origin/HEAD -> origin/main`）
- 当前分支：`main`
- 当前提交：`f39aa76ce4d5c95b7cf6c565d815618395eb1d39`

**技术栈**

- PHP 7.2.5+、Laravel 6.20、Blade。
- MySQL；依赖中包含 Redis 客户端 Predis。
- WebSocket：BeyondCode Laravel WebSockets、Ratchet，并有自定义 `ws_server.php` / Artisan command。
- 前端：Layui、jQuery 3.7.1、Laravel Mix、Sass、Axios 0.19。

**主要目录和功能模块**

- `app/Http/Controllers/`：认证、角色创建、地图/战斗、状态、背包/装备、聊天。
- `app/Models/`：用户、角色、角色属性。
- `app/WebSocket/` 和 `app/Console/Commands/WebSocketServer.php`：聊天 WebSocket。
- `resources/views/`：登录注册、角色创建、主界面、目标/角色状态、背包/装备、聊天。
- `routes/`：Web、API、广播、控制台路由。
- `public/`：Layui、jQuery、游戏脚本、样式和图片。
- `database/`：两个框架迁移、空的默认 seeder 和工厂。
- `dpcq.sql`：完整度较高的数据库转储。

**数据库结构**

- `dpcq.sql` 约 64 KB、748 行，含 21 张表：18 张 `dp_*` 游戏表，加 `users`、`migrations`、`failed_jobs`。
- 游戏表覆盖攻击目标、属性、聊天、掉落、对话、装备属性/套装、物品、等级、地图、境界、恢复物品、角色、角色属性、已装备/装备背包/道具背包和天路榜。
- `database/migrations/` 仅覆盖 WebSocket statistics 和 failed jobs，不能单靠迁移重建游戏结构；实际基线依赖 `dpcq.sql`。
- 静态阅读显示 SQL 与主要模型/控制器命名基本对应，但本次未导入验证约束、字符集和代码一致性。

**初始化数据**

- 有大量游戏数据，包括怪物/目标、掉落、对话、装备、物品、等级、地图、角色和背包数据。
- 同时包含测试用户、bcrypt 密码哈希、测试角色及聊天记录。这不是纯净 seed，后续如需利用，应先清理账号和行为数据。
- `DatabaseSeeder.php` 本身为空，不提供可重复 seed 流程。

**安装和启动说明**

- README 只说明运行 `composer install`，以及执行 `php artisan websocket:serve` 启动 WebSocket。
- 有标准 `.env.example`，但 README 未说明复制环境文件、生成 APP_KEY、导入 `dpcq.sql`、配置数据库、启动 Web 服务或构建前端。
- 本次没有执行 Composer、npm、Artisan、PHP 或 WebSocket 命令。

**LICENSE**

- 无 LICENSE 文件。
- `composer.json` 的 `license` 字段为 `MIT`。

**明显缺失或不一致**

- 无 `composer.lock`，依赖版本无法完全复现；也没有 `vendor/` 或 `node_modules/`（正常的克隆状态，但意味着不能直接运行）。
- migration 远不足以重建游戏数据库，必须依赖 SQL 转储。
- README 缺少数据库导入、APP_KEY、HTTP 服务和前端构建步骤。
- 仓库提交了 `.idea/` IDE 配置，不影响运行但属于非必要内容。

**是否可能直接运行**

- 不能。需要 Composer 依赖、环境配置、APP_KEY、MySQL 数据导入，聊天功能还需要 WebSocket 进程。
- Laravel 6/PHP 7.2 时代依赖较旧，需先在隔离环境确认兼容性和安全维护状态。

**后续可能值得复用或参考的内容**

- `dpcq.sql` 中的实体关系、装备/背包/等级/地图/掉落数据结构。
- 控制器中简化的战斗、物品使用、穿脱装备和角色状态流程。
- Blade 页面体现的文字 RPG 交互方式。
- 数据含明显的《斗破苍穹》题材内容且仓库缺少 LICENSE 正文，内容来源与授权必须另行核验。

**移动端响应式改造适配度**

- 页面包含 viewport，主容器使用 `max-width: 800px`，文字界面较轻。
- 自定义样式很少，主要依赖旧版 Layui；没有形成现代移动端组件和断点体系。
- 初步评价：中等偏低，内容结构可参考，UI 更适合重做而非直接扩展。

**未来迁移到 CloudBase 的适配度**

- SQL 数据模型和静态内容可作为迁移映射的参考输入。
- Laravel/PHP 单体、MySQL、Redis 依赖和常驻 WebSocket 进程不能原样迁移到无状态函数式后端，需要重写服务层和实时通信层。
- 初步评价：数据参考价值高，应用代码直接迁移适配度低；本报告不决定最终技术架构。

**安全与质量风险**

- `.env.example` 默认 `APP_DEBUG=true`、数据库用户 `root` 且密码为空；虽为样例，也不应直接用于公开环境。
- SQL 转储含测试账号的密码哈希、角色状态和聊天内容，应按数据泄露风险处理，不应直接导入生产。
- 依赖栈年代较早且缺少 lock 文件，后续需要单独做依赖与漏洞审计。
- 未发现真实私钥、证书、压缩包或可执行二进制程序。

### 3.4 `hanwolfxue/zonghengsihai`

**Git 信息**

- 默认分支：`master`（`origin/HEAD -> origin/master`）
- 当前分支：`master`
- 当前提交：`0b8996e8e5b7293321f9827994324d13e3c2509c`

**技术栈**

- 静态 XHTML Mobile 1.0、CSS、内联 JavaScript。
- 通过 CDN 加载 jQuery 3.5.1 和 Axios 0.19.2。

**主要目录和功能模块**

- 根目录只有 `index.html`、`index.css`。
- `assets/` 只有 `favicon.ico`。
- 页面每 5 秒请求 `https://admin.gbhome.com/api/v4/common/3in1/zlContent`，把返回记录插入页面；数据总数变化时打开 Bing 新标签页。
- 未发现游戏角色、地图、战斗、任务、存档或服务端模块。

**数据库结构与初始化数据**

- 无数据库、schema、迁移、seed 或本地初始化数据。
- 所有展示数据依赖外部 API。

**安装和启动说明**

- 无 README、依赖清单、安装或启动说明。
- 作为静态文件可以由浏览器或静态服务器加载，但本次没有打开页面或启动服务器。

**LICENSE**

- 无 LICENSE 文件，也无包清单中的许可声明。

**明显缺失或不一致**

- 只有 3 个业务/资源文件，更像独立提示 Demo，而不是可盘点的游戏源码。
- 没有 README、构建配置、本地数据或后端实现。
- 是否“缺失”其他文件无法从仓库自身证明，但它不具备完整游戏项目应有的组成。

**是否可能直接运行**

- 页面壳可以静态打开，但业务依赖外部 API、CDN、CORS 和目标域可用性，因此不是自包含可运行项目。
- 不能作为完整游戏直接运行。

**后续可能值得复用或参考的内容**

- 仅有一个定时轮询和列表展示样例；与目标游戏的直接复用价值很低。
- 外部内容直接拼入 HTML 的实现不应原样复用。

**移动端响应式改造适配度**

- 使用旧式 XHTML Mobile DTD，内容宽度为 80%，但没有现代 viewport、断点或组件体系。
- 文件很少，若只做提示页可轻易重写；作为游戏移动端基础不合适。

**未来迁移到 CloudBase 的适配度**

- 静态页面本身容易放到静态托管。
- 外部 API、跨域、定时轮询和内容安全仍需重新设计；仓库没有可迁移的后端或数据库。
- 初步评价：静态托管容易，但对完整游戏迁移没有实质参考价值。

**安全与质量风险**

- 每 5 秒调用第三方域名，存在外部依赖、隐私和可用性风险。
- 返回的 `title`、`content`、`summary` 等直接以 HTML 字符串插入 DOM，若接口内容不可完全信任，存在 XSS 风险。
- 数据变化时主动 `window.open('https://cn.bing.com/')`，属于意外跳转行为。
- CDN 依赖版本较旧，且未见 SRI 完整性校验。

## 4. 安全与缺失内容汇总

### 4.1 已发现的主要安全风险

1. `zhsh`：明文密码、硬编码 session secret、重复 session 中间件、项目根目录静态暴露。
2. `zhsh-game_astrbot`：固定 JWT fallback、root/空数据库密码 fallback、README 固定默认管理员密码。
3. `dpcq`：SQL 含测试账户密码哈希、聊天和角色数据；开发样例开启 debug、root/空数据库密码；旧依赖且无 `composer.lock`。
4. `zonghengsihai`：高频访问第三方 API、外部数据未转义插入 DOM、自动打开外部页面、旧 CDN 依赖。
5. 四个仓库均缺少 LICENSE 正文，后续复制代码或内容前需确认许可和素材来源。

### 4.2 文件类型检查

- 未发现 `.zip`、`.rar`、`.7z`、`.tar`、`.gz` 等压缩包。
- 未发现 `.exe`、`.dll`、`.msi`、`.com`、`.scr`、`.jar`、`.phar` 等可执行/程序二进制。
- 未发现 `.pem`、`.key`、`.pfx`、`.p12`、`.crt`、`.cer` 等证书或私钥文件。
- 仓库中存在正常的图片、favicon、字体等静态二进制资源；未执行或打开它们。
- `dpcq` 有 `artisan`、`server.php`、`ws_server.php` 和 WebSocket Artisan command；`zhsh-game_astrbot` 有 `ecosystem.config.js`。它们属于正常入口/进程配置文件，本次只记录，未执行。
- `zonghengsihai/index.html` 的外部轮询、未转义插入和自动开页行为具有明显风险，已单独记录。

### 4.3 核心缺失项

- `zhsh`：可复现安装说明、ESM 配置一致性、独立数据库基线、有效测试。
- `zhsh-game_astrbot`：`server/.env.example`、完整数据库 schema、迁移、初始化数据；README 所列 `server/src/models/` 不存在。
- `dpcq`：`composer.lock`、完整迁移/seed 流程、数据库导入与 Web/APP_KEY 配置说明。
- `zonghengsihai`：游戏业务源码、README、构建/部署说明、本地数据和后端。

## 5. 实际执行过的命令

以下命令均由 PowerShell 调用；带“对每个仓库”说明的命令分别在四个仓库目录中执行。文件报告由补丁写入工具创建，不属于仓库脚本。

```powershell
New-Item -ItemType Directory -Path '本地参考资料目录' -Force

git clone https://github.com/temorot/zhsh.git zhsh
git clone https://github.com/975269528/zhsh-game_astrbot.git zhsh-game_astrbot
git clone https://github.com/MVP-daijialong/dpcq.git dpcq
git clone https://github.com/hanwolfxue/zonghengsihai.git zonghengsihai

# 对每个仓库执行
git branch --show-current
git rev-parse HEAD
git symbolic-ref --short refs/remotes/origin/HEAD
git status --short
rg --files -g '!/.git/**'
Get-ChildItem -Force | Select-Object Mode,Length,Name
Get-ChildItem -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\.git\\' } | Group-Object Extension | Sort-Object Count -Descending | Select-Object Count,Name
rg --files -g 'LICENSE*' -g 'COPYING*' -g 'NOTICE*' -g '!/.git/**'
Get-ChildItem -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\.git\\' -and $_.Extension -match '^\.(zip|rar|7z|tar|gz|exe|dll|so|dylib|msi|com|scr|jar|phar|pem|pfx|p12|key|crt|cer|db|sqlite|sqlite3|wasm)$' } | Select-Object Length,FullName
Get-ChildItem -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\.git\\' -and ($_.Name -match '(^|\.)(env|env\..*|htpasswd)$' -or $_.Name -match '(secret|credential|password|passwd|token|apikey|api-key|private)') } | Select-Object Length,FullName
rg -l -i -g '!package-lock.json' -g '!/.git/**' '(password|passwd|secret|api[_-]?key|private[_-]?key|access[_-]?token|jwt)' .

# 关键文件只读查看；实际读取的文件
Get-Content -Raw -LiteralPath 'readme.md'
Get-Content -Raw -LiteralPath 'README.md'
Get-Content -Raw -LiteralPath 'DB_CHANGES.md'
Get-Content -Raw -LiteralPath 'package.json'
Get-Content -Raw -LiteralPath 'server\package.json'
Get-Content -Raw -LiteralPath 'client\package.json'
Get-Content -Raw -LiteralPath 'admin\package.json'
Get-Content -Raw -LiteralPath 'src\database.js'
Get-Content -Raw -LiteralPath 'config\index.js'
Get-Content -Raw -LiteralPath 'server\src\config.js'
Get-Content -Raw -LiteralPath 'server\src\db.js'
Get-Content -Raw -LiteralPath 'server\src\routes\admin\auth.js'
Get-Content -Raw -LiteralPath 'composer.json'
Get-Content -Raw -LiteralPath '.env.example'
Get-Content -Raw -LiteralPath 'database\seeds\DatabaseSeeder.php'
Get-Content -Raw -LiteralPath 'routes\web.php'
Get-Content -Raw -LiteralPath 'index.html'
Get-Content -Raw -LiteralPath 'index.css'
Get-Content -Raw -LiteralPath '.gitignore'
Get-Content -Raw -LiteralPath 'webpack.config.js'
Get-Content -LiteralPath 'index.js' -TotalCount 120
Get-Content -LiteralPath 'client\src\assets\styles\game.css' -TotalCount 180
Get-Content -LiteralPath 'public\css\styles.css' -TotalCount 220

# 定向静态检索与统计
rg -U -o -P 'CREATE TABLE IF NOT EXISTS\s+\w+' src\database.js
rg -n -i 'INSERT\s+(OR\s+\w+\s+)?INTO' src\database.js
rg -n -C 4 -i 'password|login|register' index.js src\database.js
rg -n -C 3 'UserDatabase|user_data\.db|database' index.js src\database.js
rg -n -i -g '*.ejs' -g '*.js' 'viewport|@media|max-width|min-width|display:\s*(flex|grid)' views index.js
rg -n -i '\.env|schema|sql file|database' README.md server\src .gitignore
rg --files -g '*.sql' -g '*migration*' -g '*schema*' -g '*seed*' -g '*.env*' -g '!/.git/**'
rg -o -i -P '(?<=FROM )`?[a-z_][a-z0-9_]*|(?<=JOIN )`?[a-z_][a-z0-9_]*|(?<=INTO )`?[a-z_][a-z0-9_]*|(?<=UPDATE )`?[a-z_][a-z0-9_]*' server\src | Sort-Object -Unique
rg -n -i -g '*.vue' -g '*.css' -g '*.scss' -g '*.html' 'viewport|@media|max-width|min-width|display:\s*(flex|grid)' client admin
rg -n -i '^CREATE TABLE|^INSERT INTO|^ALTER TABLE' dpcq.sql
rg -o -i -P '(?<=CREATE TABLE `)[^`]+' dpcq.sql
rg -o -i -P '(?<=INSERT INTO `)[^`]+' dpcq.sql | Sort-Object -Unique
rg -n -i -C 2 'INSERT INTO `users`|CREATE TABLE `users`' dpcq.sql
(Get-Content -LiteralPath 'dpcq.sql' | Measure-Object -Line).Lines
rg -n -i -g '*.blade.php' -g 'styles.css' 'viewport|@media|max-width|min-width|display:\s*(flex|grid)' resources\views public\css\styles.css
rg -n -i 'https?://|setInterval|window\.open|\.html\(' index.html
Get-ChildItem -Force -Name 'composer.lock','vendor','node_modules' -ErrorAction SilentlyContinue
rg -n 'sql-wasm\.wasm|type.:.module|node_modules/sql\.js' package-lock.json webpack.config.js requireContext.cjs
rg --files -g '*.md' -g 'LICENSE*' -g 'package.json' -g '!/.git/**'
rg -n -i -g '*.blade.php' -g '*.css' -g '*.scss' -g '*.html' 'viewport|@media|max-width|min-width|display:\s*(flex|grid)' resources public

# 正式项目目录准备与报告存在性检查
Get-ChildItem -Force -LiteralPath 'docs' -ErrorAction SilentlyContinue | Select-Object Mode,Length,Name
Test-Path -LiteralPath 'docs'
rg --files -g 'source-inventory.md'
New-Item -ItemType Directory -Path 'docs' -Force

# 完成前只读核验；Git 命令对每个参考仓库执行
git remote get-url origin
git branch --show-current
git rev-parse HEAD
git status --short
Get-Item -LiteralPath 'docs\source-inventory.md' | Select-Object FullName,Length,LastWriteTime
(Get-Content -LiteralPath 'docs\source-inventory.md' | Measure-Object -Line).Lines
Get-ChildItem -Force -LiteralPath 'docs' | Select-Object Mode,Length,Name
rg -n '^#|b841e0e7|807503c1|f39aa76c|0b8996e8' 'docs\source-inventory.md'
```

另在正式项目根目录尝试过一次只读的 `git status --short`；该命令返回“不是 Git 仓库”，未产生文件变更。

明确未执行：`npm install`、`npm start`、`npm run dev`、`npm run build`、`composer install`、`php artisan`、PHP/Node 服务、仓库脚本、批处理文件或可执行程序。

## 6. 本次未验证事项

- 未安装依赖，因此未验证依赖可解析性、构建结果或运行时兼容性。
- 未连接或导入数据库，因此未验证 SQL 能否完整导入、表结构与业务查询是否完全一致。
- 未启动 HTTP/WebSocket 服务，因此未进行端到端功能、性能、移动设备或浏览器兼容性测试。
- 未进行在线许可证、提交历史、issue、依赖漏洞数据库或外部 API 可用性核验。
- CloudBase 判断仅基于当前源码形态做初步适配盘点，不构成最终技术架构建议。
