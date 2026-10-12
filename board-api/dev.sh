#!/usr/bin/env bash
# ============================================================
# board-api / dev.sh —— 本地起布告栏后端（wrangler pages dev + 本地 D1）
# ------------------------------------------------------------
#   ./dev.sh                 -> http://127.0.0.1:8788
#   PORT=9000 ./dev.sh       -> 换端口
#   RESET=1 ./dev.sh         -> 先清掉本地 D1 数据再建表（干净重来）
#
# 这个脚本不用登录 Cloudflare：pages dev 和 --local 的 D1 全在本机跑。
#
# 环境里 pnpm 不一定在 PATH 上（实测本机就没有），所以下面按顺序找：
#   1. 已经装了 wrangler 就直接用
#   2. $PNPM 环境变量
#   3. DSH 运行时自带的 pnpm
#   4. PATH 上的 pnpm
# 找不到就报错退出，不猜。
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-8788}"

# 本地开发的环境变量（ADMIN_TOKEN / IP_SALT）走 .dev.vars —— 不写在 wrangler.toml 里：
# 线上的 secret 和 vars 共用绑定命名空间，同名会让 `pages deploy` 直接失败。
if [ ! -f .dev.vars ]; then
  cp .dev.vars.example .dev.vars
  echo "== 生成了 .dev.vars（本地假令牌，已 gitignore）"
fi

# 本地 D1 是按「库标识」分文件的，不是按库名，而两条命令吃的参数不一样：
#   wrangler d1 execute <name|binding> --local
#       -> 读 wrangler.toml 的 [[d1_databases]]，认 database_name / binding，
#          实际落在 database_id（local-dev）那个文件上
#   pages dev --d1 <binding>=<database_id>
#       -> 等号右边是「库标识」字面量，不查 wrangler.toml
# 两边写法不一致，就会出现「表建好了，请求却报 no such table: notes」。
# 所以这里两个值分开写，各自和 wrangler.toml 对齐。
# 两个值都**从 wrangler.toml 读**，不在脚本里另写一份：
# 一旦两边不一致，就会出现「表建好了，请求却报 no such table: notes」
# （d1 execute 认 database_name，pages dev --d1 认 database_id，各认各的）。
DB_NAME="$(sed -n 's/^database_name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)"
DB_ID="$(sed -n 's/^database_id *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)"
[ -z "${DB_NAME}" ] && DB_NAME="board"
[ -z "${DB_ID}" ] && DB_ID="local-dev"
PERSIST_TO="$DIR/.wrangler/state"

# ---------- 1. 找 wrangler ----------
WRANGLER=()
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
else
  PNPM_BIN="${PNPM:-}"
  if [ -z "$PNPM_BIN" ]; then
    DSH_PNPM="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
    if [ -f "$DSH_PNPM" ]; then PNPM_BIN="$DSH_PNPM"; fi
  fi
  if [ -z "$PNPM_BIN" ] && command -v pnpm >/dev/null 2>&1; then
    PNPM_BIN="$(command -v pnpm)"
  fi
  if [ -z "$PNPM_BIN" ] || [ ! -e "$PNPM_BIN" ]; then
    echo "找不到 wrangler，也没找到 pnpm。" >&2
    echo "请先装 wrangler（npm i -g wrangler），或把 pnpm 的路径写进 \${PNPM}。" >&2
    exit 1
  fi
  # pnpm.mjs 要用 node 跑；pnpm 可执行文件直接跑
  case "$PNPM_BIN" in
    *.mjs|*.js)
      NODE_BIN="${NODE_BIN:-}"
      if [ -z "$NODE_BIN" ]; then
        DSH_NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
        if [ -x "$DSH_NODE" ]; then NODE_BIN="$DSH_NODE"; fi
      fi
      if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
        NODE_BIN="$(command -v node)"
      fi
      if [ -z "$NODE_BIN" ]; then echo "找不到 node。" >&2; exit 1; fi
      WRANGLER=("$NODE_BIN" "$PNPM_BIN" dlx wrangler@latest)
      ;;
    *)
      WRANGLER=("$PNPM_BIN" dlx wrangler@latest)
      ;;
  esac
fi

echo "== wrangler: ${WRANGLER[*]}"

# ---------- 2. 本地 D1 建表 ----------
if [ ! -d public ]; then mkdir -p public; fi

if [ "${RESET:-0}" = "1" ]; then
  echo "== RESET=1：清掉 ${PERSIST_TO}"
  rm -rf "$PERSIST_TO"
fi

echo "== 建表（$DIR/schema.sql -> 本地 D1 \"$DB_NAME\" / id=${DB_ID}）"
"${WRANGLER[@]}" d1 execute "$DB_NAME" --local --persist-to="$PERSIST_TO" --file=schema.sql -y

# ---------- 3. 起服务 ----------
echo
echo "== 服务地址： http://127.0.0.1:$PORT"
echo "== 接口：     /api/notes      （GET 列表 / POST 贴一张 / DELETE 自删）"
echo "==            /api/admin/*    （要 x-board-token: \${ADMIN_TOKEN}）"
echo "== 本地 ADMIN_TOKEN 见 wrangler.toml 的 [vars]"
echo "== Ctrl-C 停。"
echo

# 这里刻意不用 exec：
# exec 会把本脚本的进程号替换成 wrangler，于是调用方 $! 拿到的是**外层 bash**
# 的号，真正要杀的 wrangler/workerd 谁都不知道 —— 那就留下一棵孤儿进程树
# 一直占着端口，下次启动直接 bind: Address already in use（踩过）。
# 改成后台起 + 把 wrangler 自己的 PID 写进文件，谁起的谁就收得干净。
PIDFILE="${BOARD_PIDFILE:-$DIR/.dev.pid}"
"${WRANGLER[@]}" pages dev public \
  --port "$PORT" \
  --persist-to="$PERSIST_TO" \
  --d1 "DB=$DB_ID" \
  --compatibility-date=2026-10-01 &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PIDFILE"

# 转发 Ctrl-C / TERM：连带 wrangler 的子进程（workerd）一起收
shutdown() {
  trap '' INT TERM
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  for c in $(pgrep -P "$SERVER_PID" 2>/dev/null || true); do
    kill "$c" 2>/dev/null || true
  done
}
trap shutdown INT TERM

wait "$SERVER_PID"
STATUS=$?
rm -f "$PIDFILE"
exit "$STATUS"
