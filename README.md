# trick-brick-server

《会捣乱的积木》后台管理系统后端。技术方案见 [../trick-brick/PLAN.md](../trick-brick/PLAN.md)。

## 技术栈
Node.js + Express + SQLite（better-sqlite3）。

## 快速开始

**方式一：一键脚本（本地，推荐开发用）**
```bash
cd trick-brick-server
./start.sh        # 自动生成 .env、装依赖、启动
```

**方式二：手动**
```bash
cd trick-brick-server
nvm use
cp .env.example .env      # 按需修改端口、口令、盐
npm install
npm run dev               # 或 npm start
```

**方式三：Docker（推荐部署用）**
```bash
cd trick-brick-server
# 生产务必通过环境变量或 .env 覆盖口令/密钥
ADMIN_PASSWORD=你的口令 JWT_SECRET=随机串 IP_SALT=随机串 docker compose up -d --build
```
- 游戏前端（`../trick-brick`）以只读卷挂载到容器并由后端托管；
- SQLite 持久化到宿主 `./data`。

## 免费部署

这个服务依赖 SQLite 文件持久化。Render / Koyeb 的免费 Web 实例适合临时演示，但免费实例不适合长期保存本地 SQLite 数据；推荐部署到 Oracle Cloud Always Free VM。

```bash
cd trick-brick-server
ADMIN_PASSWORD='改成强口令' ./scripts/deploy-free-vm.sh ubuntu@服务器IP
```

详细说明见 [DEPLOY_FREE.md](./DEPLOY_FREE.md)。

启动后：
- 游戏：`http://localhost:3000/game/`
- 后台：`http://localhost:3000/admin/`（口令为 `.env` 的 `ADMIN_PASSWORD`）
- 配置接口：`GET http://localhost:3000/api/levels/config`（游戏前端拉取）

> 后台图表使用本地 `public/admin/vendor/chart.umd.min.js`（已内置，无 CDN/外网依赖）。

## 进度（按 PLAN 分阶段）
- [x] **P1** 后端骨架 + SQLite 建表 + 默认时长 seed + `GET /api/levels/config` + 前端拉取覆盖（含 fallback）
- [x] **P2** 埋点表写入 + `POST /api/track`（限流 + IP 哈希）+ 前端 `tracker.js` 插桩
- [x] **P3** 单口令登录（HttpOnly Cookie）+ 改时长接口/页面（`/admin/`）
- [x] **P4** 统计聚合 + 图表看板 + 难度分析与调参建议

## 难度分析看板（P4）
- 接口：`GET /api/admin/stats?from=&to=`（需登录，`from/to` 为 ISO 时间，可选）。
- 看板（`/admin/` 登录后）：
  - 概览：总游玩次数 / 通关全部 / 关卡尝试总数
  - 漏斗图：各关到达 vs 通过人数（看流失在哪关）
  - 柱状图：通关率 / 平均尝试次数 / 通关剩余时间占比 / 综合难度分
  - 明细表：每关指标 + 自动**调参建议**（偏松→缩时 / 差一点→加时 / 机制难→降难度 / 样本不足）
  - 支持日期范围筛选（对比改时长前后效果）
- 图表用 Chart.js（CDN）；离线环境图表不显示，但明细表仍可用。

## 管理后台（P3）
- 页面：`http://localhost:3000/admin/`，输入 `.env` 的 `ADMIN_PASSWORD` 登录。
- 接口（除 login/me 外需登录）：
  - `POST /api/admin/login` `{password}` → 下发 HttpOnly Cookie（12h）
  - `GET  /api/admin/me` → `{authed}`
  - `GET  /api/admin/levels` → 各关当前时长 + 默认时长 + 更新时间
  - `PUT  /api/admin/levels/:idx` `{time_seconds}` → 改某关时长
  - `POST /api/admin/logout`
- 鉴权：无状态 HMAC token（密钥 `JWT_SECRET`），口令用 `ADMIN_PASSWORD`。**生产务必改这两个 .env 值**。

## 埋点说明（P2）
前端 `trick-brick/tracker.js` 在以下节点上报，IP 由后端从请求头取并哈希存储：
- `game_start`：开始一次全新游玩（splash 开始 / 通关后"从头再玩"）
- `level_start`：某关正式开始（重试累加 `attempt_no`）
- `level_win` / `level_lose`：每关每次尝试结束，写入 `level_attempt`
- `run_quit`：离开页面（`reason=quit`）或通关全部（`reason=cleared`）

接口：`POST /api/track`，接收单事件或事件数组，按 IP 限流（默认 240 次/分钟）。

## 数据
- SQLite 文件：`data/app.db`（已 gitignore）。
- 默认时长定义在 `src/db.js` 的 `DEFAULT_LEVELS`，与游戏 `LEVELS[i].time` 一致。
  首次启动以 `INSERT OR IGNORE` 灌入，已存在的配置不会被覆盖。
