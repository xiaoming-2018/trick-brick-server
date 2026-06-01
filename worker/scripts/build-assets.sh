#!/usr/bin/env bash
# 把后台页面（../public/admin）和游戏前端（../../trick-brick）汇总到 public-dist/，
# 供 Workers Assets 托管。部署形态：
#   /admin/  -> 管理后台
#   /game/   -> 游戏
set -euo pipefail

WORKER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_ROOT="$(cd "$WORKER_ROOT/.." && pwd)"
GAME_SRC="${GAME_SRC:-$(cd "$SERVER_ROOT/../trick-brick" 2>/dev/null && pwd || true)}"
DIST="$WORKER_ROOT/public-dist"

if [ -z "${GAME_SRC:-}" ] || [ ! -d "$GAME_SRC" ]; then
  echo "找不到游戏目录（默认 ../../trick-brick）。可用 GAME_SRC=路径 指定。" >&2
  exit 1
fi

rm -rf "$DIST"
mkdir -p "$DIST/admin" "$DIST/game"

# 后台页面
cp -R "$SERVER_ROOT/public/admin/." "$DIST/admin/"

# 游戏前端（排除版本控制与说明文件，保留运行所需资源）
rsync -a \
  --exclude '.git' \
  --exclude '*.md' \
  "$GAME_SRC/" "$DIST/game/"

echo "✅ 资源已汇总到 $DIST"
echo "   /admin/  <- $SERVER_ROOT/public/admin"
echo "   /game/   <- $GAME_SRC"
