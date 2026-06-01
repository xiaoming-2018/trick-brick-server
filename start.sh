#!/usr/bin/env bash
# 本地一键启动(非 Docker):自动准备 .env、安装依赖、启动服务。
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ 已生成 .env(默认口令 changeme),生产请修改 ADMIN_PASSWORD / JWT_SECRET / IP_SALT"
fi

if [ ! -d node_modules ]; then
  echo "📦 安装依赖..."
  npm install
fi

PORT_SHOW="${PORT:-3000}"
echo "🚀 启动中:"
echo "   游戏  http://localhost:${PORT_SHOW}/game/"
echo "   后台  http://localhost:${PORT_SHOW}/admin/"
exec node src/app.js
