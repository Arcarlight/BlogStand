# mobile-editor · 实现契约（前后端共同遵守）

手机端写作 PWA。部署在 Cloudflare Pages（项目名 `nijiboshi-edit`），
后端用 Pages Functions，前端是纯静态页面。**不引入任何 npm 依赖、不做构建步骤。**

仓库：`D:\Projects\hugo-2010-homepage`（origin = Arcarlight/BlogStand，分支 main）。
本目录：`mobile-editor/`。

```
mobile-editor/
  wrangler.toml            ← Lead 维护，别动
  CONTRACT.md              ← 本文件，别动
  README.md                ← Lead 维护
  functions/               ← 后端（队友 A）
    _middleware.js
    api/_shared.js
    api/*.js
  public/                  ← 前端（队友 B）
    index.html app.js style.css
    manifest.webmanifest sw.js _headers
    icons/icon-192.png icons/icon-512.png icons/apple-touch-icon.png
```

线上地址：`https://nijiboshi-edit.pages.dev`（页面本身公开可打开，但所有
`/api/*` 除 `ping` / `login` 外都要登录）。

---

## 0. 运行时约束

- Pages Functions 是 **Workers 运行时**（V8 isolate），**没有 Node API**：
  不能用 `fs` / `Buffer` / `process`。只用 `fetch`、`crypto.subtle`、`atob`/`btoa`、
  `TextEncoder`/`TextDecoder`、`URL`。
- ESM 语法（`export async function onRequestGet(...)`），不要 `require`。
- 不引入第三方包，不写 `node_modules`。
- 所有响应：`Cache-Control: no-store`，`content-type: application/json; charset=utf-8`
  （静态文件除外）。

## 1. 认证

口令登录换一枚签名 cookie，之后所有请求靠它。

- Cookie 名：`be_sess`；属性 `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`（30 天）。
- 值：`<exp>.<sig>`，`exp` 是 Unix 秒（字符串），
  `sig = base64url(HMAC-SHA256(key=SESSION_SECRET, msg=exp))`（无 padding）。
- 校验：重算 sig，**常量时间比较**（逐字节 XOR 累加，不能直接 `===` 字符串）。
- 口令校验：`SHA-256(输入口令)` 与 `SHA-256(env.EDITOR_PASS)` 常量时间比较。
  不要直接比字符串（长度会泄露）。
- `SESSION_SECRET` 或 `EDITOR_PASS` 未配置时：登录接口返回 500
  `{error:"服务端还没配置 EDITOR_PASS / SESSION_SECRET"}`，其它接口 500。
- 登录失败限流：同一 IP 10 分钟内最多 8 次失败，超了返回 429
  `{error:"尝试次数太多，10 分钟后再试"}`。用模块级 `Map`（isolate 内存）即可，
  注释里写明这是尽力而为、冷启动会重置。
- 需要登录的路径：`/api/**`，除了 `/api/ping`、`/api/login`。
  未登录 → 401 `{error:"unauthorized"}`。
- 额外 CSRF 护栏：写接口（POST/PUT/DELETE）要求请求头 `x-editor: 1`，
  缺了返回 400 `{error:"missing x-editor header"}`。
  （`_middleware.js` 里统一判断，`GET` 不要求。）
- 所有响应加 `X-Robots-Tag: noindex`。

## 2. GitHub 读写

环境变量（vars，非 secret）：`GITHUB_REPO=Arcarlight/BlogStand`、`GITHUB_BRANCH=main`、
`GITHUB_API=https://api.github.com`。
Secret：`GITHUB_TOKEN`（fine-grained PAT，Contents: Read and write）。

请求头：`Authorization: Bearer <token>`、`Accept: application/vnd.github+json`、
`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: blogstand-mobile-editor`。

### 写：一次提交原子写多个文件

用 Git Data API，不要用 Contents API 逐个 PUT（会产生多次提交）：

1. `GET /repos/{R}/git/ref/heads/{BRANCH}` → `object.sha`（父提交）
2. `GET /repos/{R}/git/commits/{父}` → `tree.sha`
3. 每个文件 `POST /repos/{R}/git/blobs` `{content:<base64>, encoding:"base64"}`
4. `POST /repos/{R}/git/trees` `{base_tree, tree:[{path, mode:"100644", type:"blob", sha}]}`
5. `POST /repos/{R}/git/commits` `{message, tree, parents:[父]}`
6. `PATCH /repos/{R}/git/refs/heads/{BRANCH}` `{sha, force:false}`

`PATCH` 或整个流程返回 422（别人同时推了）时：**重读 ref 重试，最多 2 次**；
仍失败返回 409 `{error:"仓库刚被别人改过，请刷新重试"}`。
返回 `{commit, htmlUrl, files:[{path, sha}]}`。

### 读

- 单个文件：`GET /repos/{R}/contents/{path}?ref={BRANCH}` →
  `{sha, content(base64), encoding}`；404 视为不存在（返回 `sha:null`，不要当错误）。
- 目录树：`GET /repos/{R}/git/trees/{BRANCH}?recursive=1`。
- 一律加超时：`AbortSignal.timeout(20000)`。
- GitHub 返回非 2xx 时，把 `message` 透出成 `{error:"GitHub: ..."}`，不要吞。

### 路径白名单（硬性）

只允许写这些前缀：`content/`（且只 `.md`）、`static/images/`、`static/music/`。
`..`、绝对路径、反斜杠、其它目录一律 400 `{error:"路径不允许"}`。
`static/images/` 下必须是 `[A-Za-z0-9._/-]+` 且不能以 `/` 开头。

## 3. 内容约定（必须和后端一致）

### 3.1 lastmod

保存 `content/*.md` 时，如果**正文**（front matter 之后的部分）变了，
把 front matter 里的 `lastmod:` 刷成今天（UTC+8），写成不加引号的
`lastmod: 2026-10-21`。没正文变化就不动。日期用北京时间。

### 3.2 新建的三种文件（与本地编辑器 `.editor/server.mjs` 的 `/api/new` 一致）

博客 `content/blog/{name}.md`：
```
---
title: "{title}"
date: {YYYY-MM-DD}
draft: {true|false}
tags: []
description: ""
---

在这里写正文。

<!--more-->
```

页面 `content/{name}.md`：
```
---
title: "{title}"
draft: {true|false}
description: ""
---

在这里写内容。
```

日记 `content/niki/niki_{YYYYMM}.md`（新建整月时才用；月份名表见 §3.4）：
```
---
title: "{y}年{m}月日记"
date: {y}-{MM}-01
draft: {true|false}
description: ""
---

<center>
{y}年 {m}月
</center>
{{< niki-cal >}}
<br>
<center>
<b>{睦月等} {短语}</b>
</center>
<br>
<hr />

<h2><span id="{MM}01">{m}月 1日</span></h2>

在这里写这一天的事。

<!--more-->
```

### 3.3 日记的「写某一天」

日记是**一个月一个文件**，每天一个二级标题小节，锚点格式固定：

```html
<h2><span id="1021">10月 21日</span></h2>

<br>正文第一段（HTML，换行用 <br>）
```

- `id` = `MM`（两位）+ `DD`（两位）；标题文字 = `{m}月 {d}日`
  （`m`/`d` **不补零**，例如 `10月 7日`、`2月 9日`）。
- 小节范围：从标题行到下一个 `<h2`（不含）或 `<!--more-->`（不含）或文件末尾。
- 写某天：
  - 文件不存在 → 用 §3.2 模板生成，再把自己的小节替换进去。
  - 当天小节已存在 → **替换小节正文**（保留标题行）。
  - 不存在 → 插入到 `<!--more-->` 之前（没有 `<!--more-->` 就追加到文件末尾），
    前面空一行，正文后空一行。
  - 插入位置要按日期顺序：找到第一个「id 大于 MM DD」的 `<h2>` 就插在它前面；
    都比它小就插到 `<!--more-->` 之前。这样 10 月的文件里补 10 月 13 日会落在
    12 日和 15 日之间。
- 返回写后的完整文本，前端可以据此刷新。

### 3.4 月份名（新建月文件用，照抄）

| m | 和名 | 短语 |
|---|---|---|
| 1 | 睦月 | 新春将至 万象更新 |
| 2 | 如月 | 草木更生 新年到来 |
| 3 | 弥生月 | 万物复苏 春来花开 |
| 4 | 卯月 | 天高云清 雨露丰裕 |
| 5 | 皐月 | 云转天变 时雨时晴 |
| 6 | 水無月 | 雨水倾覆 日日云墨 |
| 7 | 文月 | 风雨飘摇 冷雨湿涟 |
| 8 | 叶月 | 日悬晴天 酷夏炎炎 |
| 9 | 長月 | 秋雨连绵 云沉满天 |
| 10 | 神無月 | 秋高气爽 红叶满山 |
| 11 | 霜月 | 寒意渐浓 红叶飘零 |
| 12 | 師走 | 岁末将至 一年将尽 |

### 3.5 图片

存 `static/images/`（不用子目录）。前端在**浏览器里**压好再传（不指望 Worker 压图），
一次上传 = 原图 + 1x/2x 两档 webp，命名和站上旧图一致（`tools/build-images.py` 的规则）：

- 长边 > 1600 先缩到 1600；
- 原图：JPEG 照片编 `image/jpeg` q0.85；带透明的 PNG 保持 PNG；
- 派生图：`<原名>-<宽>.webp`，宽度取 `min(显示宽, 原图宽)` 和 `min(显示宽×2, 原图宽)`
  两档（不放大），q0.9（带透明 PNG 用 q0.95，避免平涂边缘出彩噪）；
- 正文写法（`sizes` 跟 `width` 属性一致）：

  ```html
  <center><picture><source type="image/webp" srcset="/images/x-350.webp 350w, /images/x-700.webp 700w" sizes="350px" /><img src="/images/x.jpg" alt="x" width="350" loading="lazy" /></picture></center>
  ```

  `build-images.py` 会跳过已经包在 `<picture>` 里的图，两边不打架。

后端只做「落盘 + 去重命名 + 一次提交」：`name` 已存在就 `name-1`、`name-2`…
（原图和所有派生图都空闲才算可用）。

## 4. API 清单

统一前缀 `/api`。请求体 JSON。错误统一 `{error:"中文说明"}`。
成功返回里可以带额外字段，但下表字段必须有。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/ping` | – | `{ok:true, app:"blogstand-mobile", version:"0.1.0", time}` |
| POST | `/api/login` | `{pass}` | `{ok:true, exp}` + Set-Cookie；错误 401 `{error:"口令不对"}` |
| POST | `/api/logout` | `{}` | `{ok:true}` + 清 cookie |
| GET | `/api/session` | – | `{authed:true, repo, branch}` |
| GET | `/api/list?kind=blog\|niki\|page\|collection` | – | `{kind, items:[{path,name,title,date,draft,lastmod,dayIds?}], fetchedAt}` |
| GET | `/api/file?path=` | – | `{path, text, sha}`（不存在 404 `{error:"not found", sha:null}`） |
| PUT | `/api/file` | `{path, text, sha, force?}` | `{ok:true, path, sha, commit, htmlUrl}`；sha 不匹配 409 `{error:"conflict", sha, text}` |
| POST | `/api/new` | `{kind, name, title, date?, draft?, text?}` | `{ok:true, path, sha, commit, htmlUrl, text}`；已存在 409 |
| POST | `/api/diary` | `{year, month, day, html}` | `{ok:true, path, sha, commit, htmlUrl, text}` |
| GET | `/api/diary?year=&month=` | – | `{path, exists, text, days:[{day, id, date}]}` |
| POST | `/api/upload` | `{name, original:{mime,b64}, variants?:[{w,b64}], webp?}` | `{ok:true, url, path, variantList:[{w,url,path}], bytes, commit}` |
| GET | `/api/board?status=all\|visible\|hidden` | – | 布告栏后端原样返回 `{ok:true, status, notes:[...]}` |
| POST | `/api/board/reply` | `{id, body}` | 布告栏后端原样 |
| POST | `/api/board/hide` | `{id, hidden}` | 布告栏后端原样 |
| POST | `/api/board/delete` | `{id}` | 布告栏后端原样 |
| GET | `/api/build` | – | `{ok:true, status, conclusion, htmlUrl, headSha, createdAt, runNumber}` |

补充规则：

- `/api/list`：从 git tree 取 `content/` 下 `.md`，按 kind 过滤；
  并行拉正文（最多 6 个并发）解析 front matter 的 `title/date/draft/lastmod`；
  结果在 isolate 内存缓存 5 分钟（key 含 branch）。`niki` 额外返回 `dayIds`
  （正则 `/<span\s+id=["'](\d{2})(\d{2})["']/g` 的第二组）。
  解析失败就用文件名兜底，不要整页报错。
- `/api/file` PUT：`sha` 必填（新建走 `/api/new`）。服务端先 GET 当前文件比对，
  不一致 → 409 并把最新 `{sha, text}` 返回，除非 `force:true`。
- `/api/new`：`text` 给了就直接写它（一次提交），否则写模板。
  `name` 去空格、禁 `\\/:*?"<>|`；博客名默认由前端给（如 `post-20261021`）。
- `/api/diary` 的 `html` 是**当天正文**（纯 HTML 片段，不要带 `<h2>` 标题）。
  服务端负责拼标题、定位、插入（§3.3）。
- `/api/upload`：JSON 体积上限 12MB，超了 413。
- 布告栏：服务端用 `BOARD_ADMIN_TOKEN` 打 `x-board-token` 头转发到
  `env.BOARD_API`（`https://nijiboshi-board.pages.dev`），不要暴露 token；
  转发失败返回 502 `{error:"布告栏后端连不上"}`。
- `/api/build`：`GET /repos/{R}/actions/runs?branch={BRANCH}&per_page=1`，
  取第一条；没有运行记录返回 `{ok:true, status:null}`。

## 5. 前端契约

- 纯 ES module：`<script type="module" src="/app.js">`，无框架、无 CDN、无构建。
- hash 路由：`#/`（首页）、`#/login`、`#/blog/new`、`#/diary`、`#/posts`、
  `#/post/<encodeURIComponent(path)>`、`#/board`。
- 所有请求 `credentials:'include'`；写请求自动带 `x-editor: 1`。
- 收到 401 → 清状态、跳 `#/login`。收到 409（冲突）→ 提示「线上版本变了」，
  给「用我的覆盖」和「载入线上版本」两个选择。
- 首页：四张卡（写博客 / 写日记 / 改文章 / 留言板）+ 构建状态条
  （发布后每 15 秒轮询 `/api/build`，`conclusion` 出来就停）。
- 写博客：标题、文件名（默认 `post-{YYYYMMDD}`，可改）、日期、草稿开关、正文
  `<textarea>`；「插入图片」按钮 + 宽度下拉（350 / 500 / 634 满栏）走 `/api/upload`
  后把 §3.5 那段插到光标处；宽度记在 localStorage。写日记同款按钮。
- 写日记：日期默认今天（`<input type="date">`），载入当天已有内容可直接改；
  保存走 `POST /api/diary`；另给「本月已写日期」列表（点一下跳过去）。
- 改文章：列表可搜索（标题/文件名），点开是**原始 Markdown 全文**（含 front matter），
  保存走 `PUT /api/file`。
- 留言板：列表、答复、隐藏/恢复、真删（二次确认）。
- 草稿：未保存正文每 2 秒存 localStorage（key 带路径/日期）；
  有未保存内容时离开页面要 `beforeunload` 提醒。发布成功后清掉。
- 样式：移动优先，`viewport-fit=cover`，安全区 `env(safe-area-inset-*)`，
  输入框字号 ≥16px（防 iOS 缩放），点击目标 ≥44px，底部固定主按钮。
  和电脑端编辑器（`.editor/ui.html`）同一套 **Win7 拟物化**语言，**深浅两套、
  跟随系统** `prefers-color-scheme`（不加手动开关；所有颜色走 CSS 变量）：
  - 浅色：Aero 蓝渐变标题栏（`#4c93dc → #1c5c9f`）、`#eef2f7` 底、白色塑料面板
    （上亮下暗渐变 + 顶沿内白高光 + 内描边 + 底部内暗影 + 近投影）、
    橙色主按钮（`#ffb84d` / `#e08600` / `#4a2b00` 文字）、输入框内阴影 + 聚焦蓝环。
  - 深色（Dark Aero Glass）：`#171d26` 底 / `#1f2732` 面板，标题栏压深到
    `#3f7fbe → #0d2f52` 但保留 48%/52% 弧线，高光降到 8–12%、阴影加深加长，
    橙色主按钮压一档但保留暖色强调，彩色图标加 1px 暗投影（别糊在深面板上）。
  - 两套都是底部操作条顶部亮线 + 向上投影；正文对比度至少 4.5:1。
- 图标：**Fugue Icons**（Yusuke Kamiyamane，CC BY 3.0），图和逻辑名映射在
  `public/icons/fugue/`（含署名 README），首页页脚必须有署名链接
  <https://p.yusukekamiyamane.com/icon/attribution/>。不要引别的图标集。
- PWA：`manifest.webmanifest`（`display:standalone`、`theme_color`、三个图标）、
  `apple-touch-icon`、`<meta name="apple-mobile-web-app-capable">`；
  `sw.js` 只缓存 app shell（HTML/JS/CSS/图标），`/api/*` 一律 network-only，别缓存。
- `_headers`：`X-Robots-Tag: noindex`、`X-Frame-Options: DENY`、
  `Referrer-Policy: no-referrer`、基本 CSP（允许同源脚本和 `data:`/`blob:` 图片）。

## 6. 本地开发

```bash
cd D:/Projects/hugo-2010-homepage/mobile-editor
npx wrangler pages dev public --port 8789 --compatibility-date 2026-10-01
```

`.dev.vars` 里放 `EDITOR_PASS` / `SESSION_SECRET` / `GITHUB_TOKEN` / `BOARD_ADMIN_TOKEN`，
**`GITHUB_BRANCH` 在本地必须指向测试分支**（如 `test-mobile-editor`），绝不写 main。
