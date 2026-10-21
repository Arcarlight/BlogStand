# mobile-editor / functions —— 后端（Cloudflare Pages Functions）

手机写作间的后端。全部是 **Pages Functions（Worker 运行时、ESM）**：
没有 Node API、没有 npm 依赖、没有构建步骤。契约见 `../CONTRACT.md`。

```
functions/
  _middleware.js          鉴权 / 公共路径 / x-editor / 统一 401·500 / no-store·noindex
  api/
    _shared.js            共用：JSON、请求体、哈希/HMAC、路径白名单、front matter、
                          lastmod、GitHub 封装（Git Data API 原子提交）、日记、布告栏转发
    ping.js               GET  /api/ping
    login.js              POST /api/login
    logout.js             POST /api/logout
    session.js            GET  /api/session
    list.js               GET  /api/list
    file.js               GET/PUT /api/file
    new.js                POST /api/new
    diary.js              GET/POST /api/diary
    upload.js             POST /api/upload
    build.js              GET  /api/build
    board/index.js        GET  /api/board
    board/reply.js        POST /api/board/reply
    board/hide.js         POST /api/board/hide
    board/delete.js       POST /api/board/delete
```

`_middleware.js` 与 `api/_shared.js` 不会被当成路由（Pages 忽略 `_` 开头的文件 / 只有
`onRequest*` 导出的文件才会成为路由）。

---

## 一、路由清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` | 公共。`{ok:true, app:"blogstand-mobile", version:"0.1.0", time}` |
| POST | `/api/login` | 公共。`{pass}` → `{ok:true, exp}` + `Set-Cookie: be_sess`；口令错 401；8 次/10 分钟/IP 失败后 429 |
| POST | `/api/logout` | 清 cookie → `{ok:true}` |
| GET | `/api/session` | `{authed:true, repo, branch}` |
| GET | `/api/list?kind=blog\|niki\|page\|collection` | git tree + 6 并发解析 front matter，缓存 5 分钟；`niki` 额外带 `dayIds`（DD 字符串数组） |
| GET | `/api/file?path=` | `{path, text, sha}`；不存在 404 `{error:"not found", sha:null}` |
| PUT | `/api/file` | `{path, text, sha, force?}`；sha 不匹配 409 `{error:"conflict", sha, text}`；`force:true` 覆盖 |
| POST | `/api/new` | `{kind, name, title, date?, draft?, text?}`；已存在 409；kind = `blog`/`page`/`collection`/`niki` |
| GET | `/api/diary?year=&month=` | `{path, exists, text, days:[{day,id,date}]}` |
| POST | `/api/diary` | `{year, month, day, html}` → 定位/替换/按 id 排序插入，返回 `{ok,path,sha,commit,htmlUrl,text}` |
| POST | `/api/upload` | `{name, original:{mime,b64}, variants?:[{w,b64}], webp?}`；12MB 上限、去重命名、原图 + 各档 webp 一次提交 |
| GET | `/api/board?status=all\|visible\|hidden` | 带 `x-board-token` 转发到 `env.BOARD_API` 的 `/api/admin/list`，JSON 原样返回 |
| POST | `/api/board/reply` | `{id, body}` → 转发 `/api/admin/reply` |
| POST | `/api/board/hide` | `{id, hidden}` → 转发 `/api/admin/hide` |
| POST | `/api/board/delete` | `{id}` → 转发 `/api/admin/delete` |
| GET | `/api/build` | GitHub Actions 最近一次 run；无记录 `{ok:true, status:null}` |

### 响应里契约没写死、前端需要知道的形状

- `POST /api/upload`：主字段是 `variantList`，形如 `[{w:350, url:"/images/x-350.webp", path:"static/images/x-350.webp"}, {w:700, …}]`，
  按宽度升序；前端拿它拼 `srcset`。`url` 是原图地址。兼容字段 `webp` / `webpUrl` 仍保留
  （旧前端只传 `webp` 时也能用）。
- `GET /api/diary` 的 `days`：`day` 是数字（1–31），`id` 是四位字符串（如 `"1021"`），
  `date` 是 `YYYY-MM-DD`。
- `PUT /api/file` 额外返回写入后的 `text`（`lastmod` 可能被刷新过）。
- `GET /api/list` 按 `date` 倒序（没有 date 的排最后），同一日期按 path。
- 所有错误响应统一 `{error:"中文说明"}`；GitHub 的错误会变成
  `{error:"GitHub: <原始 message>"}`（按契约透出）。

### 鉴权

- 需要登录：`/api/**`，除 `/api/ping`、`/api/login`。
- cookie `be_sess = <exp>.<base64url(HMAC-SHA256(SESSION_SECRET, exp))>`，
  `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`。
- 签名逐字节 XOR 累加比较（`timingSafeEqualStr`），口令比较是
  `SHA-256(输入)` vs `SHA-256(EDITOR_PASS)` 的常量时间比较。
- **写请求（POST/PUT/PATCH/DELETE）必须带 `x-editor: 1`**，包括 `/api/login`；缺了 400
  `{error:"missing x-editor header"}`。
- `EDITOR_PASS` / `SESSION_SECRET` 任一缺失：`/api/ping` 仍可用（部署自检），
  其余 `/api/**` 一律 500 `{error:"服务端还没配置 EDITOR_PASS / SESSION_SECRET"}`。
- 所有响应带 `X-Robots-Tag: noindex`；API 响应带 `Cache-Control: no-store`。

### GitHub 写入

按契约 §2 用 Git Data API：ref → commit → blob → tree → commit → patch ref。
整个提交只产生一个 commit，多文件原子写。冲突（409/422）时重读 ref 重试，最多 2 次
（共 3 次尝试），仍失败 409 `{error:"仓库刚被别人改过，请刷新重试"}`。
所有 GitHub 请求 `AbortSignal.timeout(20000)`。

写路径白名单：`content/**.md`、`static/images/<[A-Za-z0-9._/-]+>`、`static/music/...`；
`..`、绝对路径、反斜杠、其它目录一律 400 `{error:"路径不允许"}`。

---

## 二、环境变量

`wrangler.toml` 的 `[vars]`（Lead 维护，别在后端代码里写死）：

| 变量 | 说明 |
|---|---|
| `GITHUB_REPO` | `Arcarlight/BlogStand` |
| `GITHUB_BRANCH` | 线上 `main`；**本地 .dev.vars 必须是测试分支** |
| `GITHUB_API` | `https://api.github.com` |
| `BOARD_API` | `https://nijiboshi-board.pages.dev` |
| `APP_NAME` | 只给前端读取用，后端不依赖 |

Secret（`wrangler pages secret put` / 本地 `.dev.vars`）：

| 变量 | 说明 |
|---|---|
| `EDITOR_PASS` | 登录口令 |
| `SESSION_SECRET` | cookie 签名密钥 |
| `GITHUB_TOKEN` | fine-grained PAT：Contents 读写（`/api/build` 还需要 Actions 读；不给就是 502 并把 GitHub message 透出） |
| `BOARD_ADMIN_TOKEN` | board-api 的 `ADMIN_TOKEN`，只在转发请求头里出现，绝不进响应 |

本地 `.dev.vars` 模板见 `../.dev.vars.example`。

---

## 三、本地开发 / 自测

```bash
cd D:/Projects/hugo-2010-homepage/mobile-editor
npx wrangler pages dev public --port 8789 --compatibility-date 2026-10-01
```

`.dev.vars` 里的 `GITHUB_BRANCH` 是 `test-mobile-editor`，所以本地所有写操作只会落在
测试分支。没有 `.dev.vars` 时也可以用 `-b KEY=VALUE` 传变量：

```bash
npx wrangler pages dev public --port 8789 -b EDITOR_PASS=dev-pass -b SESSION_SECRET=dev-secret
```

### curl 自测要点

```bash
BASE=http://127.0.0.1:8789
curl -s $BASE/api/ping                              # 200
curl -s $BASE/api/list                              # 401 {"error":"unauthorized"}

# 登录（写请求要带 x-editor）
curl -si -X POST $BASE/api/login -H 'content-type: application/json' \
  -H 'x-editor: 1' -d '{"pass":"dev-pass-123456"}'

# cookie 是 Secure 的：本地 http 下浏览器/curl 不会自动回传，
# 把 Set-Cookie 里的 be_sess=... 手动放进 Cookie 头即可
SESS='be_sess=<exp>.<sig>'
curl -s $BASE/api/session -H "Cookie: $SESS"
curl -s "$BASE/api/list?kind=niki" -H "Cookie: $SESS"
curl -s "$BASE/api/file?path=content/board.md" -H "Cookie: $SESS"
curl -s $BASE/api/build -H "Cookie: $SESS"
```

写接口自测时记得每次 PUT 带上一轮返回的新 `sha`，冲突会返回 409 + 最新 `{sha,text}`。

---

## 四、已知限制（都是有意为之 / 契约范围内的取舍）

1. **登录限流是模块级 `Map`**：isolate 内存、冷启动会重置、多 isolate 各算各的。
   按契约 §1 写，真要做到严格限流得换 KV/D1。
2. **`/api/list` 缓存 5 分钟**（isolate 内存，key 含 branch）。写操作不会主动清缓存，
   最长 5 分钟内列表可能旧；刷新页面重试即可。
3. **本地 http + `Secure` cookie**：浏览器不会把 Secure cookie 回传到 `http://127.0.0.1`，
   本地联调要么手动塞 Cookie 头（curl），要么接受前端在本地表现为「登录后仍 401」。
   线上 https 正常。
4. **上传去重有竞态窗口**：先查重名再提交，两个并发上传同名理论上可能后写覆盖先写
   （单用户写作间，概率极低）。
5. **`/api/new` 的「已存在」检查**同样先读后写；并发下靠 GitHub 的 ref 冲突兜底。
6. **`page` 列表 = `content/` 根下所有 `.md`**（`_` 开头除外），所以会包含
   `board.md` / `updates.md` / `gallery.md` 这类页面。
7. **上传只收图片扩展名**：`png/jpg/jpeg/webp/gif/avif`。`static/music/` 在白名单里，
   但目前没有音频上传接口（契约没要求）。
8. **`/api/diary` 新建整月文件时 `draft: false`**：契约模板没规定默认值，按「写完即发布」
   处理（现有日记也都是 draft false）。需要草稿请走 `PUT /api/file` 改 front matter。
9. **布告栏透传上游状态码**：`BOARD_ADMIN_TOKEN` 配错时前端会收到 board-api 的 401 JSON
   （`{ok:false,error:"unauthorized"}`），这样不会把配置细节暴露给前端；转发失败/超时才 502
   `{error:"布告栏后端连不上"}`。
10. **没有删除文章的接口**（契约没要求）；删除请直接走 GitHub。
11. **大型文件读取**：Contents API 对 >1MB 的文件不返回 `content`，`GET /api/file` 的
    `text` 会是空串。目前只用来读 `.md`，不受影响。
12. **HEAD 请求**：`wrangler pages dev` 的静态资源 HEAD 不经过 `_middleware`（GET 正常带
    `X-Robots-Tag: noindex`）。线上以正常 GET 为准；契约要求的是响应头，正常访问都满足。
13. 依赖 GitHub / board-api 的接口都需要外网；本地断网时表现为 502 + 错误说明。

---

## 五、自测记录（2026-10-21，本地 wrangler 4.151.3，端口 8789）

- `node --check` 全部 16 个 `.js` 通过。
- 纯逻辑单测（Node 直接 import `_shared.js`，15 项）：front matter 解析、`lastmod` 只在正文
  变化时刷新、日记模板、按 id 排序插入、替换小节、legacy `<h1>` 兼容、无 `<!--more-->`
  追加末尾、路径白名单、常量时间比较、base64 往返、北京时间 —— 全过。
- 本地 HTTP：
  - 未登录 `/api/list` → 401；`/api/ping` → 200；
  - 错误口令 → 401，第 9 次错误 → 429；缺 `x-editor` 的写请求 → 400；
  - 正确口令 → cookie，`/api/session`、`/api/list`（blog/niki/page/collection）、
    `/api/file` GET、`/api/diary` GET、`/api/build`（测试分支无 run，`status:null`）均 200；
  - `/api/list` 二次请求命中缓存（~0.06s）；
  - 路径越权 `/api/file?path=../wrangler.toml` → 400；不存在文件 → 404；
  - 上传 13MB JSON → 413；非法 JSON 请求体 → 400。
- 测试分支 `test-mobile-editor` 写入（全部一次提交）：
  - `POST /api/new`（page `tmp-contract-test`）→ 200 + commit；
  - `PUT /api/file` → 200 且 `lastmod: 2026-10-21` 被补上；旧 sha → 409 带最新 `{sha,text}`；
    `force:true` → 覆盖成功；
  - `POST /api/diary`（2099-12）：新建整月模板 → 写 31 日 → 再写 5 日（插到 1201 和 1231
    之间）→ 重写 31 日（替换正文），`GET` 的 `days` 顺序正确；
  - `POST /api/upload` 1×1 PNG + webp → `webp.url` 返回，同名再传 → 自动 `-1`；
  - 清理：用 Git Data API 一个 commit 删掉全部临时文件，`test-mobile-editor` 的 tree
    与 `main` 完全一致（`85699e15...`），`main` head 始终是 `81e79a77...`（没碰过）。
- 错误分支：`BOARD_API` 不可达 → 502 `{error:"布告栏后端连不上"}`；
  `GITHUB_TOKEN` 失效 → 502 `{error:"GitHub: Bad credentials"}`；
  `EDITOR_PASS` / `SESSION_SECRET` 未配置 → 除 ping 外 `/api/**` 500。
- 未执行：真实浏览器 cookie 流程（Secure cookie 在本地 http 的固有限制）、真实 board-api
  管理操作（本地 `.dev.vars` 的 `BOARD_ADMIN_TOKEN` 是占位值）、线上部署（按分工不部署）。
