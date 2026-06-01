# trick-brick-server · Cloudflare Workers + D1 版

原 Express + better-sqlite3 后台的无服务器重写。API 行为与路径完全一致：

- 游戏：`/game/`
- 后台：`/admin/`
- 公开配置：`GET /api/levels/config`
- 埋点：`POST /api/track`
- 后台 API：`/api/admin/*`（登录、关卡时长、难度统计）

游戏与后台都由 Workers Assets 在同域托管，前端无需改 CORS。

## 目录

```
worker/
  wrangler.toml        # Workers 配置：Assets + D1 + 限流绑定
  schema.sql           # D1 建表 + 默认关卡时长
  src/
    index.js           # Hono 入口（路由 + 鉴权 + CORS）
    db.js              # D1 查询封装
    track.js           # 埋点入库（批量 D1.batch）
    stats.js           # 难度分析聚合
    auth.js            # Web Crypto：HMAC token / 口令校验 / IP 哈希
  scripts/build-assets.sh  # 汇总 admin + 游戏到 public-dist/
```

## 首次部署

```bash
cd worker
npm install

# 1. 登录（浏览器授权，一次即可）
npx wrangler login

# 2. 创建 D1 数据库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create trick-brick

# 3. 建表 + 灌默认时长
npm run db:init

# 4. 设置机密（逐条输入）
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put JWT_SECRET    # 随机长字符串，可用 openssl rand -hex 32
npx wrangler secret put IP_SALT       # 随机长字符串

# 5. 打包资源并部署
npm run deploy
```

部署后访问 `https://trick-brick-server.<你的子域>.workers.dev/game/`。

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填本地机密
npm run db:init:local            # 初始化本地 D1
npm run dev                      # http://localhost:8787
```

## 更新代码 / 资源

改完代码或游戏资源后，重新 `npm run deploy` 即可。`npm run db:init` 可重复执行，不会覆盖已有配置与埋点数据。
