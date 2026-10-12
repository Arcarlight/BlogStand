#!/usr/bin/env bash
# ============================================================
# board-api / deploy.sh —— 一步步带着你把布告栏后端部署到 Cloudflare
# ------------------------------------------------------------
#   ./deploy.sh
#
# 它替你做的（按顺序）：
#   1. 找 wrangler（和 dev.sh 同一套找法，本机 pnpm 不在 PATH 上也没事）
#   2. wrangler login          —— 会弹浏览器，你点一下授权
#   3. 建 D1 库（已经有了就跳过），并把 database_id 自动写回 wrangler.toml
#   4. 在线上建表
#   5. 建 Pages 项目 → 自动生成两个随机串当 ADMIN_TOKEN / IP_SALT 写进去
#   6. 部署，拿到 https://xxx.pages.dev
#   7. 把地址写进 hugo.toml 的 boardApi，把地址+令牌写进 .editor/board.json
#
# 需要你动手的只有第 2 步（浏览器授权）。中途任何一步失败都会停下并说清楚。
#
# ⚠️ 实机没验过：登录之后的 d1 create / secret put / deploy 三条（写脚本的人
#    没有 Cloudflare 账号）。本地那部分（dev.sh / test-local.sh）是验过的。
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${DIR}/.." && pwd)"
cd "${DIR}"

PROJECT="${PROJECT:-nijiboshi-board}"   # pages.dev 的域名全球唯一，别用太大众的名字；想换：PROJECT=xxx ./deploy.sh
DB_NAME="board"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33m   %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 1. 找 wrangler ----------
WRANGLER=()
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
else
  PNPM_BIN="${PNPM:-}"
  if [ -z "${PNPM_BIN}" ]; then
    DSH_PNPM="${HOME}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
    [ -f "${DSH_PNPM}" ] && PNPM_BIN="${DSH_PNPM}"
  fi
  [ -z "${PNPM_BIN}" ] && command -v pnpm >/dev/null 2>&1 && PNPM_BIN="$(command -v pnpm)"
  [ -z "${PNPM_BIN}" ] && die "找不到 wrangler，也没找到 pnpm。先 npm i -g wrangler，或把 pnpm 路径写进 \${PNPM}。"
  NODE_BIN="${NODE_BIN:-}"
  if [ -z "${NODE_BIN}" ]; then
    DSH_NODE="${HOME}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
    [ -x "${DSH_NODE}" ] && NODE_BIN="${DSH_NODE}"
  fi
  [ -z "${NODE_BIN}" ] && command -v node >/dev/null 2>&1 && NODE_BIN="$(command -v node)"
  [ -z "${NODE_BIN}" ] && die "找不到 node。"
  case "${PNPM_BIN}" in
    *.mjs|*.js) WRANGLER=("${NODE_BIN}" "${PNPM_BIN}" dlx wrangler@latest) ;;
    *)          WRANGLER=("${PNPM_BIN}" dlx wrangler@latest) ;;
  esac
fi
say "用的 wrangler：${WRANGLER[*]}"

PY="${PYTHON:-python3.12}"
command -v "${PY}" >/dev/null 2>&1 || die "找不到 ${PY}（下面要它改 wrangler.toml / hugo.toml）。"

# ---------- 2. 登录 ----------
say "第 1 步：登录 Cloudflare（会弹浏览器，点一下授权）"

# 登录状态要真判，别让管道把失败吞掉：whoami 成功时会打出带 email 的那行
logged_in() { "${WRANGLER[@]}" whoami 2>/dev/null | grep -qiE 'email|@'; }

if ! logged_in; then
  echo "   （现在没登录，下面会弹浏览器；打不开就照它给的链接手动开）"
  if ! "${WRANGLER[@]}" login; then
    die "wrangler login 没成功。手动跑一次：${WRANGLER[*]} login"
  fi
fi
logged_in || die "还是没登录上。手动跑一次：${WRANGLER[*]} login，成功后再跑本脚本。"
"${WRANGLER[@]}" whoami 2>&1 | sed 's/^/   /'

# ---------- 3. 建 D1 库，把 database_id 写回 wrangler.toml ----------
CUR_ID="$(${PY} - <<'PYEOF'
import re, pathlib
s = pathlib.Path('wrangler.toml').read_text(encoding='utf-8')
m = re.search(r'database_id\s*=\s*"([^"]*)"', s)
print(m.group(1) if m else '')
PYEOF
)"

if [ -n "${CUR_ID}" ] && [ "${CUR_ID}" != "local-dev" ]; then
  say "第 2 步：wrangler.toml 里已经有 database_id（${CUR_ID}），跳过建库"
else
  say "第 2 步：建 D1 库「${DB_NAME}」"
  # 已经建过了就直接复用，别报错中断
  OUT="$("${WRANGLER[@]}" d1 create "${DB_NAME}" 2>&1 || true)"
  echo "${OUT}" | sed 's/^/   /'
  ID="$(printf '%s' "${OUT}" | sed -n 's/.*database_id *= *"\([^"]*\)".*/\1/p' | head -1)"
  if [ -z "${ID}" ]; then
    ID="$("${WRANGLER[@]}" d1 list --json 2>/dev/null | ${PY} -c "
import json,sys
try: rows=json.load(sys.stdin)
except Exception: rows=[]
for r in rows:
    if r.get('name')=='${DB_NAME}':
        print(r.get('uuid') or r.get('database_id') or ''); break
" || true)"
  fi
  [ -z "${ID}" ] && die "没能拿到 database_id。请手动跑一次 ${WRANGLER[*]} d1 create ${DB_NAME}，把返回的 UUID 填进 wrangler.toml 再重新跑本脚本。"
  "${PY}" - "${ID}" <<'PYEOF'
import re, sys, pathlib
new = sys.argv[1]
p = pathlib.Path('wrangler.toml')
s = p.read_text(encoding='utf-8')
s2, n = re.subn(r'(database_id\s*=\s*")[^"]*(".*)$',
                lambda m: m.group(1) + new + '"   # 线上库（deploy.sh 自动填的，别手改）',
                s, count=1, flags=re.M)
if not n:
    raise SystemExit('wrangler.toml 里找不到 database_id 那一行')
p.write_text(s2, encoding='utf-8')
print('   已把 database_id 写进 wrangler.toml：' + new)
PYEOF
fi

# ---------- 4. 线上建表 ----------
say "第 3 步：在线上建表"
"${WRANGLER[@]}" d1 execute "${DB_NAME}" --remote --file=schema.sql -y

# ---------- 5. 建 Pages 项目 + 两个 secret ----------
say "第 4 步：建 Pages 项目「${PROJECT}」"
CREATE_OUT="$("${WRANGLER[@]}" pages project create "${PROJECT}" --production-branch main 2>&1 || true)"
echo "${CREATE_OUT}" | sed 's/^/   /'

# 建完必须核对：pages.dev 的域名是全球唯一的，名字被占了就会建失败。
# 以前这里只 warn 一下就往下走，结果第 5 步写 secret 时报「Project does not exist」——
# 报错点离真正的原因隔着一步，很难查。
if ! "${WRANGLER[@]}" pages project list 2>/dev/null | grep -q "${PROJECT}"; then
  warn "没找到叫 ${PROJECT} 的 Pages 项目 —— 上面那段就是失败原因。"
  warn "最常见的是域名被别人占了（项目名要全球唯一）。换个名字重跑即可："
  warn "    PROJECT=你的名字-随机几个字母 ./deploy.sh"
  die "项目没建起来，先解决这一步。"
fi
say "   项目 ${PROJECT} 在。继续。"

say "第 5 步：生成并写入两个 secret（令牌不进终端历史，也不用你手打）"
ADMIN_TOKEN="$(${PY} -c "import secrets;print(secrets.token_urlsafe(32))")"
IP_SALT="$(${PY} -c "import secrets;print(secrets.token_urlsafe(24))")"
put_secret() {   # $1=名字 $2=值；wrangler 有时候不肯从管道读，那就把值打出来让人手动贴
  if printf '%s' "$2" | "${WRANGLER[@]}" pages secret put "$1" --project-name "${PROJECT}" 2>&1 | sed 's/^/   /'; then
    return 0
  fi
  warn "自动写 $1 失败。请手动跑："
  echo "     ${WRANGLER[*]} pages secret put $1 --project-name ${PROJECT}"
  echo "     它要值的时候，把下面这串粘进去："
  echo "     $2"
  die "先把这两个 secret 建好，再重新跑本脚本（前面几步会自动跳过）。"
}
put_secret ADMIN_TOKEN "${ADMIN_TOKEN}"
put_secret IP_SALT "${IP_SALT}"

# ---------- 6. 部署 ----------
say "第 6 步：部署"
echo "   （上传 + 等 Cloudflare 生效，国内网络可能要一两分钟；下面会实时打出来）"
# 关键：**不要再把输出接进变量**。之前写成 OUT="$(wrangler ...)"，
# 命令跑完之前终端上一个字都没有，看着就像卡死（站长就以为它不动了）。
# 用 tee 一边打屏一边存文件，进度看得见。
DEPLOY_LOG="$(mktemp -t board-deploy)"
if ! "${WRANGLER[@]}" pages deploy public --project-name "${PROJECT}" --branch main 2>&1 | tee "${DEPLOY_LOG}"; then
  warn "部署这一步失败了（上面那段就是原因）。"
  warn "想看得更细可以手动跑：WRANGLER_LOG=debug ${WRANGLER[*]} pages deploy public --project-name ${PROJECT} --branch main"
  die "部署没成功，先解决这一步。"
fi
# cloudflare 会同时打出两种地址：本次部署的别名（<hash>.<项目>.pages.dev）和
# 生产地址（<项目>.pages.dev）。**要后者** —— 别名绑的是这一次部署，
# 下次部署就变了，填进站点迟早会失效。
STABLE_URL="https://${PROJECT}.pages.dev"
URL="$(grep -oE 'https://[a-zA-Z0-9._-]+\.pages\.dev' "${DEPLOY_LOG}" | grep -v '^https://[a-f0-9]\{7,\}\.' | head -1)"
[ -z "${URL}" ] && URL="${STABLE_URL}"

# 部署完等它生效：Pages 上线要几十秒，刚部完访问会打 522。
say "   等它上线（最多等 90 秒）"
TRIES="${HEALTH_TRIES:-18}"   # 探测次数（测试时可以调小）
WAIT="${HEALTH_WAIT:-5}"
ok=0
for t in $(seq 1 "${TRIES}"); do
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "${URL}/api/notes" || echo 000)"
  printf '   第 %s 次探测：HTTP %s\n' "${t}" "${code}"
  if [ "${code}" = "200" ]; then ok=1; break; fi
  sleep "${WAIT}"
done
if [ "${ok}" != "1" ]; then
  warn "接口还没起来。多半是刚部署完还在生效，等一两分钟刷新试试。"
  warn "要是过几分钟还是 522，去 Cloudflare 控制台 → Workers 和 Pages → ${PROJECT} 看看有没有一条成功的部署。"
fi
rm -f "${DEPLOY_LOG}"
# ---------- 7. 接线：hugo.toml + .editor/board.json ----------
say "第 7 步：把地址接上（hugo.toml 的 boardApi + 编辑器的管理令牌）"
"${PY}" - "${REPO}/hugo.toml" "${URL}" <<'PYEOF'
import re, sys, pathlib
path, url = sys.argv[1], sys.argv[2]
p = pathlib.Path(path)
s = p.read_text(encoding='utf-8')
s2, n = re.subn(r'(boardApi\s*=\s*)"[^"]*"', lambda m: m.group(1) + '"' + url + '"', s, count=1)
if not n:
    raise SystemExit('hugo.toml 里找不到 boardApi = "..." 那一行')
p.write_text(s2, encoding='utf-8')
print('   hugo.toml: boardApi = ' + url)
PYEOF

BOARD_JSON="${REPO}/.editor/board.json"
"${PY}" - "${BOARD_JSON}" "${URL}" "${ADMIN_TOKEN}" <<'PYEOF'
import json, sys, pathlib
path, url, token = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps({'api': url, 'token': token}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('   .editor/board.json 写好了（已 gitignore，不会进仓库）')
PYEOF

cat <<EOF

============================================================
 搞定了。

   后端地址   ${URL}
   管理令牌   已自动生成，存在 ${BOARD_JSON}
              想看就 cat 那个文件，别贴给人、别 commit。

 接下来：
   1. 重启编辑器（改了 server.mjs 必须重启），侧栏「布告栏」面板里
      应该已经连上了 —— 可以直接看便签、回复、隐藏。
   2. 站点：hugo.toml 的 boardApi 已经填好，跑一次构建/发布即可。
      之后 /board/ 上贴的便签就真的存到 Cloudflare 了。

 想回退：把 hugo.toml 的 boardApi 改回 ""，站点就回到「只读样例 JSON」的状态；
 后端和已经贴上去的便签都还在，数据不会丢。
============================================================
EOF
