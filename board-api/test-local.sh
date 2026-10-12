#!/usr/bin/env bash
# ============================================================
# board-api / test-local.sh —— 本地接口验收（curl 版，可反复跑）
# ------------------------------------------------------------
#   ./test-local.sh                 # 自己起服务、跑完自己收摊
#   BASE=http://127.0.0.1:8788 ./test-local.sh   # 打到已经在跑的服务上
#   KEEP=1 ./test-local.sh          # 跑完不杀服务（自己起的也不杀）
#
# 跑完逐条打印 PASS / FAIL，最后一行给总数；有 FAIL 就退出码 1。
#
# 依赖：curl、jq（brew install jq）、python3（只用来算时间戳）
#
# 注意：脚本开头会清空本地 D1 的 rate 表 —— 限流是按 ip_hash 计数的，
# 上一轮跑剩的计数会把这一轮的「连发 6 条」直接顶成 429。
# 清之前会先看服务在不在，在的话只删 rate 表，notes 不动。
# ============================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-8788}"
BASE="${BASE:-http://127.0.0.1:$PORT}"
# 调用方显式给了 BASE 就算「复用外部服务」，不然端口被占就该报错（见第 0 节）
BASE_OVERRIDE=0
[ -n "${BASE:-}" ] && BASE_OVERRIDE=1
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}"
ORIGIN="${ORIGIN:-https://arcarlight.github.io}"
DB_NAME="$(sed -n 's/^database_name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -1)"
[ -z "${DB_NAME}" ] && DB_NAME="board"
PERSIST_TO="$DIR/.wrangler/state"
PIDFILE="$DIR/.dev.pid"       # dev.sh 会把 wrangler 的 PID 写在这儿

PASS=0
FAIL=0
STARTED_PID=""
STARTED_BY_US=0

# ---------- 输出小工具 ----------
c_ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
c_bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }
head1()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# check <描述> <实际> <期望>
check() {
  if [ "$2" = "$3" ]; then c_ok "$1"; else c_bad "$1" "期望 [$3] 实际 [$2]"; fi
}

req() { # req METHOD path [curl extras...]  -> 同时设置全局 ${CODE}（状态码）和 ${BODY}（正文）
  # 正文走临时文件，不用 $( )：命令替换会开子 shell，里面赋的 CODE 传不出来。
  local m="$1" p="$2"; shift 2
  CODE="$(curl -s -m 20 -o "$BODYFILE" -w '%{http_code}' -X "$m" "$BASE$p" \
    -H "Origin: $ORIGIN" "$@")"
  BODY="$(cat "$BODYFILE")"
}

BODYFILE="$(mktemp -t board-test-body.XXXXXX)"

# 命令行里 pnpm 不一定在 PATH 上，和 dev.sh 用同一套找法
find_wrangler() {
  WRANGLER=()
  if command -v wrangler >/dev/null 2>&1; then WRANGLER=(wrangler); return; fi
  local pnpm_bin="${PNPM:-}"
  if [ -z "$pnpm_bin" ]; then
    local d="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
    [ -f "$d" ] && pnpm_bin="$d"
  fi
  [ -z "$pnpm_bin" ] && command -v pnpm >/dev/null 2>&1 && pnpm_bin="$(command -v pnpm)"
  [ -z "$pnpm_bin" ] && { echo "找不到 wrangler / pnpm" >&2; exit 1; }
  case "$pnpm_bin" in
    *.mjs|*.js)
      local node_bin="${NODE_BIN:-}"
      if [ -z "$node_bin" ]; then
        local n="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
        [ -x "$n" ] && node_bin="$n"
      fi
      [ -z "$node_bin" ] && command -v node >/dev/null 2>&1 && node_bin="$(command -v node)"
      [ -z "$node_bin" ] && { echo "找不到 node" >&2; exit 1; }
      WRANGLER=("$node_bin" "$pnpm_bin" dlx wrangler@latest) ;;
    *) WRANGLER=("$pnpm_bin" dlx wrangler@latest) ;;
  esac
}

alive() { curl -s -m 3 -o /dev/null "$BASE/api/notes" 2>/dev/null; }

# 从叶子往上杀一棵进程树。
# 必须这么干的原因：dev.sh 底下是 bash -> node(wrangler) -> workerd，
# workerd 占着端口。只杀中间那个 node，workerd 会被 init 收养继续活着，
# 而且还有个看门进程不停把它拉起来；反过来只杀 workerd，父进程立刻再开一个。
# 所以先杀最深的，再一级级往上。
kill_tree() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null || true
}

cleanup() {
  rm -f "$BODYFILE" 2>/dev/null || true
  [ "${STARTED_BY_US:-0}" = "1" ] || return 0
  [ "${KEEP:-0}" = "1" ] && return 0

  local root p
  # dev.sh 会把 wrangler 的 PID 写在这个文件里，优先用它；
  # 读不到就退回脚本自己的 PID（两层一起杀，反正 kill 不存在也不报错）。
  root="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$root" ] && kill_tree "$root"
  kill_tree "$STARTED_PID"

  # 再按「谁占着端口」扫尾，反复几次，直到端口真的空出来
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    p="$(lsof -ti :"$PORT" 2>/dev/null || true)"
    [ -z "$p" ] && break
    for x in $p; do kill -9 "$x" 2>/dev/null || true; done
    sleep 1
  done

  rm -f "$PIDFILE" 2>/dev/null || true
  wait "$STARTED_PID" 2>/dev/null || true

  if [ -n "$(lsof -ti :"$PORT" 2>/dev/null || true)" ]; then
    printf '  \033[33m注意\033[0m  端口 %s 还有进程没退干净，可能要手动 kill\n' "$PORT"
  fi
}
trap cleanup EXIT

# ---------- 0. 服务 ----------
head1 "0. 服务"
if ! command -v jq >/dev/null 2>&1; then
  echo "缺少 jq，先装：brew install jq" >&2
  exit 1
fi

if alive; then
  # 这里要小心：如果端口上蹲着的是上一次没收干净的服务，用着用着它挂了，
  # 后面的请求会突然变成 HTTP 000，看起来像接口坏了，其实是环境脏。
  # 只有调用方明确给了 BASE（自己起的服务）才复用它，否则宁可报错让人先清干净。
  if [ -n "${BASE_OVERRIDE:-0}" ] && [ "${BASE_OVERRIDE}" != "0" ]; then
    echo "  $BASE 已经在跑，直接打它。"
  else
    printf '  \033[31m端口 %s 已被占用\033[0m（可能是上次没收干净的 wrangler）。\n' "$PORT" >&2
    echo "  先清掉：  lsof -ti :$PORT | xargs kill -9" >&2
    echo "  或者明确复用它：  BASE=http://127.0.0.1:$PORT ./test-local.sh" >&2
    exit 1
  fi
else
  echo "  $BASE 没在跑，用 dev.sh 起一个…"
  PORT="$PORT" ./dev.sh > /tmp/board-test-dev.log 2>&1 &
  STARTED_PID=$!
  STARTED_BY_US=1
  up=0
  for _ in $(seq 1 120); do
    if alive; then up=1; break; fi
    if ! kill -0 "$STARTED_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ "$up" != "1" ]; then
    echo "服务起不来，日志尾巴：" >&2
    tail -30 /tmp/board-test-dev.log >&2
    exit 1
  fi
  echo "  起来了（pid ${STARTED_PID}）。"
fi

# ---------- 1. 清 rate 表，让限流可复现 ----------
head1 "1. 重置限流计数"
find_wrangler
RESET_OUT="$("${WRANGLER[@]}" d1 execute "$DB_NAME" --local --persist-to="$PERSIST_TO" \
  --command="DELETE FROM rate;" -y 2>&1)"
if printf '%s' "$RESET_OUT" | grep -q '"success": true'; then
  c_ok "本地 rate 表已清空（限流计数从 0 开始）"
else
  c_bad "清空 rate 表失败" "$(printf '%s' "$RESET_OUT" | tail -3)"
fi

TS0="$(python3 -c 'import time;print(int(time.time()*1000)-5000)')"
JSON='Content-Type: application/json'

# ---------- 2. 发一条 + 看列表 ----------
head1 "2. 发便签 / 读列表"
BODY1="第一条测试便签 · $(date +%s)"
TOKEN1="test-token-$(date +%s)-a"
req POST /api/notes -H "$JSON" \
  -d "{\"name\":\"阿岚\",\"color\":\"pink\",\"body\":\"$BODY1\",\"token\":\"$TOKEN1\",\"hp\":\"\",\"t0\":$TS0}"
R="$BODY"
check "POST /api/notes -> 201" "$CODE" "201"
check "返回 ok:true" "$(jq -r '.ok' <<<"$R")" "true"
ID1="$(jq -r '.note.id' <<<"$R")"
check "返回 note.body 与提交一致" "$(jq -r '.note.body' <<<"$R")" "$BODY1"
check "返回 note.reply 为 null" "$(jq -r '.note.reply' <<<"$R")" "null"
check "note 里没有 ip_hash" "$(jq -r '.note | has("ip_hash")' <<<"$R")" "false"
check "note 里没有 token_hash" "$(jq -r '.note | has("token_hash")' <<<"$R")" "false"
check "note 里没有 status" "$(jq -r '.note | has("status")' <<<"$R")" "false"
check "at 是 +08:00 格式" \
  "$(jq -r '.note.at' <<<"$R" | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\+08:00$')" "1"

req GET '/api/notes?limit=40'
R="$BODY"
check "GET /api/notes -> 200" "$CODE" "200"
check "列表里能查到刚发的 id=$ID1" \
  "$(jq --argjson i "$ID1" '[.notes[].id] | index($i) != null' <<<"$R")" "true"
check "列表项没有 status 字段" \
  "$(jq '[.notes[] | has("status")] | any' <<<"$R")" "false"
check "more 是布尔值" "$(jq -r '.more | type' <<<"$R")" "boolean"

# ---------- 3. 校验 / 反垃圾 ----------
head1 "3. 校验与反垃圾"
req POST /api/notes -H "$JSON" -d "{\"body\":\"   \",\"token\":\"t\",\"hp\":\"\",\"t0\":$TS0}"
check "空 body -> 400" "$CODE" "400"
check "空 body 有中文错误信息" "$(jq -r '.error' <<<"$BODY" | grep -c '。')" "1"

LONG="$(python3 -c 'print("字"*301)')"
req POST /api/notes -H "$JSON" -d "{\"body\":\"$LONG\",\"token\":\"t\",\"hp\":\"\",\"t0\":$TS0}"
check "301 字 -> 400" "$CODE" "400"

req POST /api/notes -H "$JSON" -d "{\"body\":\"机器人\",\"token\":\"t\",\"hp\":\"gotcha\",\"t0\":$TS0}"
check "hp 非空（蜜罐）-> 400" "$CODE" "400"

TSNOW="$(python3 -c 'import time;print(int(time.time()*1000))')"
req POST /api/notes -H "$JSON" -d "{\"body\":\"太快了\",\"token\":\"t\",\"hp\":\"\",\"t0\":$TSNOW}"
check "t0 距今 <1500ms -> 400" "$CODE" "400"

req POST /api/notes -H "$JSON" \
  -d "{\"body\":\"颜色兜底\",\"color\":\"neon\",\"token\":\"t-color\",\"hp\":\"\",\"t0\":$TS0}"
check "非法 color -> 201" "$CODE" "201"
check "非法 color 落成 white" "$(jq -r '.note.color' <<<"$BODY")" "white"

req POST /api/notes -H "$JSON" \
  -d "{\"body\":\"六色\",\"color\":\"blue\",\"token\":\"t-blue\",\"hp\":\"\",\"t0\":$TS0}"
check "合法 color=blue 保留" "$(jq -r '.note.color' <<<"$BODY")" "blue"

LONGNAME="$(python3 -c 'print("名"*40)')"
req POST /api/notes -H "$JSON" \
  -d "{\"name\":\"$LONGNAME\",\"body\":\"名字截断\",\"token\":\"t-name\",\"hp\":\"\",\"t0\":$TS0}"
check "name 超 24 字被截到 24" "$(jq -r '.note.name | length' <<<"$BODY")" "24"

# ---------- 4. 限流 ----------
head1 "4. 限流（每小时 5 条）"
# 上面已经成功发了好几条，先再清一次，让这一轮从 0 开始数
"${WRANGLER[@]}" d1 execute "$DB_NAME" --local --persist-to="$PERSIST_TO" \
  --command="DELETE FROM rate;" -y > /dev/null 2>&1

LAST_CODE=""; LAST_BODY=""
for i in 1 2 3 4 5 6; do
  req POST /api/notes -H "$JSON" \
    -d "{\"body\":\"限流第 $i 条\",\"token\":\"t-rate-$i\",\"hp\":\"\",\"t0\":$TS0}"
  LAST_CODE="$CODE"; LAST_BODY="$BODY"
done
check "连发第 6 条 -> 429" "$LAST_CODE" "429"
check "429 的 ok 是 false" "$(jq -r '.ok' <<<"$LAST_BODY")" "false"
check "429 正文有 error 字段" "$(jq -r '.error | length > 0' <<<"$LAST_BODY")" "true"

# ---------- 5. 管理接口 ----------
head1 "5. 管理接口"
req GET '/api/admin/list?status=all'
check "admin/list 无 token -> 401" "$CODE" "401"

req GET '/api/admin/list?status=all' -H 'x-board-token: wrong-token'
check "admin/list 错 token -> 401" "$CODE" "401"
check "401 不透露细节" "$(jq -r '.error' <<<"$BODY")" "unauthorized"

req POST /api/admin/reply -H "$JSON" -H 'x-board-token: wrong' -d "{\"id\":$ID1,\"body\":\"x\"}"
check "admin/reply 错 token -> 401" "$CODE" "401"

REPLY="站长回复 · $(date +%s)"
req POST /api/admin/reply -H "$JSON" -H "x-board-token: $ADMIN_TOKEN" \
  -d "{\"id\":$ID1,\"body\":\"$REPLY\"}"
R="$BODY"
check "admin/reply 对 token -> 200" "$CODE" "200"
check "回复内容写进去了" "$(jq -r '.note.reply.body' <<<"$R")" "$REPLY"
check "回复落款是虹星" "$(jq -r '.note.reply.by' <<<"$R")" "虹星"
check "回复时间也是 +08:00" "$(jq -r '.note.reply.at' <<<"$R" | grep -cE '\+08:00$')" "1"

req GET '/api/notes?limit=40'
check "公开列表里看得到 reply" \
  "$(jq -r --argjson i "$ID1" ".notes[] | select(.id == \$i) | .reply.body" <<<"$BODY")" "$REPLY"

# ---------- 6. 隐藏 / 恢复 ----------
head1 "6. 隐藏与恢复"
req POST /api/admin/hide -H "$JSON" -H "x-board-token: $ADMIN_TOKEN" -d "{\"id\":$ID1,\"hidden\":true}"
check "隐藏 -> 200" "$CODE" "200"
check "隐藏后 status=hidden" "$(jq -r '.note.status' <<<"$BODY")" "hidden"

req GET '/api/notes?limit=100'
check "公开列表里不出现" \
  "$(jq --argjson i "$ID1" '[.notes[].id] | index($i) == null' <<<"$BODY")" "true"

req GET '/api/admin/list?status=all' -H "x-board-token: $ADMIN_TOKEN"
R="$BODY"
check "admin/list?status=all 里有它" \
  "$(jq --argjson i "$ID1" '[.notes[].id] | index($i) != null' <<<"$R")" "true"
check "admin/list 带 status 字段" \
  "$(jq -r --argjson i "$ID1" ".notes[] | select(.id == \$i) | .status" <<<"$R")" "hidden"

req GET '/api/admin/list?status=hidden' -H "x-board-token: $ADMIN_TOKEN"
check "status=hidden 过滤生效" \
  "$(jq '[.notes[].status] | all(. == "hidden")' <<<"$BODY")" "true"

req POST /api/admin/hide -H "$JSON" -H "x-board-token: $ADMIN_TOKEN" -d "{\"id\":$ID1,\"hidden\":false}"
check "恢复 -> status=visible" "$(jq -r '.note.status' <<<"$BODY")" "visible"

# ---------- 7. 自删 ----------
head1 "7. 发帖人自删（软删）"
# 第 4 节已经把小时额度用满了，这里不清就又撞 429
"${WRANGLER[@]}" d1 execute "$DB_NAME" --local --persist-to="$PERSIST_TO" \
  --command="DELETE FROM rate;" -y > /dev/null 2>&1

TOKEN2="test-token-$(date +%s)-b"
req POST /api/notes -H "$JSON" \
  -d "{\"name\":\"沙沙\",\"color\":\"blue\",\"body\":\"这条一会自己撤掉\",\"token\":\"$TOKEN2\",\"hp\":\"\",\"t0\":$TS0}"
ID2="$(jq -r '.note.id' <<<"$BODY")"
check "再发一条（id=${ID2}）-> 201" "$CODE" "201"

req DELETE /api/notes -H "$JSON" -d "{\"id\":$ID2,\"token\":\"不是这个 token\"}"
check "错 token 删 -> 400" "$CODE" "400"

req DELETE /api/notes -H "$JSON" -d "{\"id\":$ID2,\"token\":\"$TOKEN2\"}"
check "对 token 删 -> 200" "$CODE" "200"

req GET '/api/notes?limit=100'
check "删完公开列表里没有了" \
  "$(jq --argjson i "$ID2" '[.notes[].id] | index($i) == null' <<<"$BODY")" "true"

req GET '/api/admin/list?status=all' -H "x-board-token: $ADMIN_TOKEN"
check "软删：管理员还看得到，status=hidden" \
  "$(jq -r --argjson i "$ID2" ".notes[] | select(.id == \$i) | .status" <<<"$BODY")" "hidden"

req DELETE /api/notes -H "$JSON" -d "{\"id\":$ID2,\"token\":\"$TOKEN2\"}"
check "重复删 -> 400" "$CODE" "400"

# ---------- 8. CORS ----------
head1 "8. CORS"
OUT="$(curl -s -m 20 -D - -o /dev/null -X OPTIONS "$BASE/api/notes" \
  -H "Origin: https://arcarlight.github.io" -H 'Access-Control-Request-Method: POST')"
check "OPTIONS -> 204" "$(printf '%s' "$OUT" | head -1 | awk '{print $2}')" "204"
check "OPTIONS 回显 GitHub Pages 来源" \
  "$(printf '%s' "$OUT" | grep -ci 'access-control-allow-origin: https://arcarlight.github.io')" "1"
check "OPTIONS 带 Allow-Methods" \
  "$(printf '%s' "$OUT" | grep -ci 'access-control-allow-methods: GET,POST,DELETE,OPTIONS')" "1"
check "OPTIONS 带 Allow-Headers" \
  "$(printf '%s' "$OUT" | grep -ci 'access-control-allow-headers: content-type,x-board-token')" "1"
check "OPTIONS 带 Max-Age" "$(printf '%s' "$OUT" | grep -ci 'access-control-max-age: 86400')" "1"

OUT="$(curl -s -m 20 -D - -o /dev/null -X OPTIONS "$BASE/api/notes" -H "Origin: http://127.0.0.1:1313")"
check "OPTIONS 允许 http://127.0.0.1:*" \
  "$(printf '%s' "$OUT" | grep -ci 'access-control-allow-origin: http://127.0.0.1:1313')" "1"

OUT="$(curl -s -m 20 -D - -o /dev/null "$BASE/api/notes" -H "Origin: https://evil.example.com")"
check "陌生来源不回 ACAO" "$(printf '%s' "$OUT" | grep -ci 'access-control-allow-origin')" "0"

OUT="$(curl -s -m 20 -D - -o /dev/null "$BASE/api/notes" -H "Origin: https://arcarlight.github.io")"
check "GET 也带 ACAO" "$(printf '%s' "$OUT" | grep -ci 'access-control-allow-origin: https://arcarlight.github.io')" "1"

# ---------- 收尾 ----------
head1 "结果"
printf '  通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32m全部 PASS\033[0m\n'
  exit 0
fi
printf '  \033[31m有 FAIL，见上面\033[0m\n'
exit 1
