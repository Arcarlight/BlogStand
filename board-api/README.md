# board-api —— 布告栏后端（Cloudflare Pages Functions + D1）

给 `static/js/board.js` 用的后端。前端那边只要把后端地址填进 HTML 的
`data-bd-live`（`static/js/board.js` 不改：它优先取 live，取不到才回落到
`static/board/notes.json`）。站点本体还在 GitHub Pages，这里只提供 `/api/*`。

为什么是 Pages 不是 Workers：国内网络实测 `*.pages.dev` 通、`*.workers.dev` 被墙。

```
board-api/
  wrangler.toml                  Pages 项目配置（D1 绑定 + 本地环境变量）
  schema.sql                     D1 建表语句
  functions/api/notes.js         GET 列表 / POST 贴一张 / DELETE 自删
  functions/api/_shared.js       共用：CORS、北京时间、sha256、限流、字段映射
  functions/api/admin/reply.js   站长回复
  functions/api/admin/hide.js    隐藏 / 恢复（软删：只改 status，行留着，随时能恢复）
  functions/api/admin/delete.js  **真删**（DELETE FROM notes，删掉就没了）
  functions/api/admin/list.js    站长看全部（含隐藏）
  public/                        pages dev 的静态根，空的（这个项目没有前端页面）
  dev.sh                         本地起服务（建表 + wrangler pages dev）
  test-local.sh                  本地验收脚本（curl，逐条 PASS/FAIL）
```

---

## 一、本地开发

```bash
cd board-api
./dev.sh                 # http://127.0.0.1:8788
PORT=9000 ./dev.sh       # 换端口
RESET=1 ./dev.sh         # 先清掉本地 D1 数据，干净重来
```

`dev.sh` 干两件事：

1. `wrangler d1 execute board --local --file=schema.sql` 建表（本地 SQLite，在
   `board-api/.wrangler/state/`，删掉这个目录就等于清库）
2. `wrangler pages dev public --port 8788 --d1 DB=local-dev`

**不需要登录 Cloudflare**，`pages dev` 和 `--local` 的 D1 全在本机跑。
本地环境变量写在 `wrangler.toml` 的 `[vars]`（`ADMIN_TOKEN=dev-admin-token`、
`IP_SALT=dev-salt-change-me`），只是开发占位值，线上会用 secret 覆盖。

### 本地验收

```bash
cd board-api
./test-local.sh                          # 自己起服务、跑完自己收摊
BASE=http://127.0.0.1:8788 ./test-local.sh   # 打到已经在跑的服务上
KEEP=1 ./test-local.sh                   # 跑完不杀服务
```

跑完逐条打印 PASS / FAIL，最后给总数；有 FAIL 退出码 1。依赖 `curl`、`jq`、`python3`。

> 脚本会清空本地 D1 的 `rate` 表（限流是按 `ip_hash` 计数的，上次跑剩的计数会把
> 「连发 6 条」直接顶成 429）。`notes` 表不动。

---

## 二、部署（三步）

### 1. 建 D1 库，把 database_id 填回来

```bash
cd board-api
npx wrangler login                       # 浏览器里授权一次
npx wrangler d1 create board
```

命令会回一段 `[[d1_databases]]`，把里面的 `database_id` 抄进 `wrangler.toml`，
换掉现在的占位值 `local-dev`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "board"
database_id = "刚刚拿到的 UUID"
```

### 2. 在线上建表 + 写两个 secret

```bash
npx wrangler d1 execute board --remote --file=schema.sql

# 站长钥匙：自己换成一串随机串，别用 dev-admin-token
npx wrangler pages secret put ADMIN_TOKEN

# ip_hash 的盐：随便一串长随机串，定了就别改
# （改了之后同一个 IP 的哈希会变，等于限流计数清零）
npx wrangler pages secret put IP_SALT
```

`ADMIN_TOKEN` 就是管理接口 `x-board-token` 头的值，别提交进仓库、别写进前端。

### 3. 部署

```bash
cd board-api
npx wrangler pages deploy public --project-name board-api
```

第一次会让选/建项目（也可以先 `npx wrangler pages project create board-api`）。
部署完拿到形如 `https://board-api.pages.dev` 的地址。

### 4. 接前端（这一步在博客仓库，本目录不管）

仓库里已经留好入口：`hugo.toml` 的 `params.boardApi`，模板
（`layouts/board/single.html`、`layouts/_shortcodes/board-home.html`）会把它
渲染成 `data-bd-live`。所以**只要填这一行**：

```toml
boardApi = "https://board-api.pages.dev"
```

根地址（`https://board-api.pages.dev`）和完整接口地址
（`https://board-api.pages.dev/api/notes`）两种写法都行 ——
`static/js/board.js` 里的 `apiNotes()` 自己会补 `/api/notes`。
`static/js/board.js` 不用改。

> CORS 白名单写死了 `https://arcarlight.github.io` 和 `http://127.0.0.1:*` /
> `http://localhost:*`。如果换了域名，要改 `functions/api/_shared.js` 里的
> `corsHeaders()` 再重新部署。

---

## 三、接口

所有响应都是 JSON，都带 CORS 头：

- `Access-Control-Allow-Origin` 按请求的 `Origin` 回显，只放行
  `https://arcarlight.github.io` 和 `http://127.0.0.1:*` / `http://localhost:*`
- `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`
- `Access-Control-Allow-Headers: content-type,x-board-token`
- `Access-Control-Max-Age: 86400`
- `OPTIONS` 预检返回 `204`

出错统一是 `{"ok":false,"error":"中文短句"}`。

### 1) `GET /api/notes?limit=40`

只返回 `status='visible'`，按 id 倒序。`limit` 默认 40、上限 100。

```json
{
  "notes": [
    {
      "id": 1,
      "name": "阿岚",
      "color": "pink",
      "body": "……",
      "at": "2026-10-13T20:41:00+08:00",
      "reply": { "by": "虹星", "body": "……", "at": "2026-10-13T21:02:00+08:00" }
    }
  ],
  "more": true
}
```

`reply` 没有回复时是 `null`。**不返回** `ip_hash` / `token_hash` / `status`。

### 2) `POST /api/notes`

```json
{ "name": "", "color": "white", "body": "……", "token": "客户端随机串", "hp": "", "t0": 1791827047000 }
```

校验（任一不过 → `400`/`429`）：

| 条件 | 结果 |
| --- | --- |
| `body` 去首尾空白后 1..300 字 | 否则 400 |
| `name` ≤ 24 字 | 超出截断到 24 |
| `color` ∈ `white cream yellow pink green blue` | 非法值一律当 `white` |
| `hp` 非空 | 400（蜜罐） |
| `t0` 距现在 < 1500ms | 400 |
| 同一 `ip_hash` 每小时 ≤ 5 条 | 超出 429 |
| 同一 `ip_hash` 每天 ≤ 20 条 | 超出 429 |

成功 `201`：

```json
{ "ok": true, "note": { "id": 1, "name": "", "color": "white", "body": "……", "at": "…+08:00", "reply": null } }
```

`token` 只存 sha256（`crypto.subtle.digest`），不返回。
`ip_hash` = `sha256(客户端IP + IP_SALT)` 的前 16 个十六进制字符，**不存原始 IP**。
时间一律北京时间，格式 `YYYY-MM-DDTHH:MM:SS+08:00`（不用 `toISOString()` 的 `Z`）。

### 3) `DELETE /api/notes`

```json
{ "id": 123, "token": "贴的时候那个 token" }
```

`token_hash` 对上且当前不是 `hidden` 才允许；成功把 `status` 改成 `hidden`
（**软删**，不物理删），返回 `{"ok":true}`；否则 400。

### 4) 管理接口

都要请求头 `x-board-token: <ADMIN_TOKEN>`，不对就 `401 {"ok":false,"error":"unauthorized"}`。

- `POST /api/admin/reply` —— `{"id":1,"body":"……"}`，body ≤ 500 字，写
  `reply_body`/`reply_at`，返回更新后的 note（落款固定 `虹星`）
- `POST /api/admin/hide` —— `{"id":1,"hidden":true|false}`，改 `status`
  （**软删**：行留着，回复也在，随时能恢复）
- `POST /api/admin/delete` —— `{"id":1}`，**真删** `DELETE FROM notes WHERE id = ?`。
  和 hide 的区别：删掉就没了，回复一起消失，不可恢复。
  站长在编辑器里点「删除」时前端会走一次二次确认（第一次点只把按钮变成
  「确认删除？」），就是怕手滑。
- `GET /api/admin/list?status=all|visible|hidden&limit=200` —— 含隐藏项，
  `limit` 默认 200、上限 500，每项比公开版多一个 `status` 字段

---

## 四、数据表

`notes`：`id` / `created_at` / `name` / `color` / `body` / `ip_hash` /
`status`（`visible`|`hidden`）/ `reply_body` / `reply_at` / `token_hash`

`rate`：`ip_hash` + `bucket`（`h:YYYY-MM-DDTHH` 小时桶 / `d:YYYY-MM-DD` 天桶）
+ `n`，主键 `(ip_hash, bucket)`

索引：`(status, id DESC)`

---

## 五、已知的坑（都踩过，写在代码注释里了）

- **本地两条命令吃的 D1 标识不一样。** `wrangler d1 execute board --local` 走
  `wrangler.toml`，落到 `database_id`；`pages dev --d1 DB=xxx` 用的是等号右边的
  字面量。写成不一致就会「表建好了，请求却报 `no such table: notes`」。
  `dev.sh` 里两个值分开写、都对齐 `wrangler.toml`。
- **`dev.sh` 不用 `exec`。** 用了 `exec`，调用方 `$!` 拿到的是外层 bash 的号，
  真正要杀的 wrangler/workerd 没人知道，会留下一棵孤儿进程树占着端口，下次启动
  直接 `bind: Address already in use`。现在 `dev.sh` 后台起 wrangler、把它的 PID
  写进 `.dev.pid`，`test-local.sh` 从叶子往上杀整棵树。
- **shell 里 `$VAR` 后面紧跟中文字符要写成 `${VAR}`。** bash 会把多字节字符吃进
  变量名，报 `unbound variable`（`$STARTED_PID）` 就这么坑过一次）。
- `.dev.pid` 和 `.wrangler/` 是本地运行产物，仓库没有对应的 `.gitignore` 条目
  （本目录不允许改仓库其它文件），提交前自己看一眼别带上。

---

## 六、没验证到的部分（照实说）

本地这一套（`pages dev` + 本地 D1）全部跑通、55 项断言全过。但下面这些**本地验不了**：

- **没登录过 Cloudflare，所以没真正部署过。** `wrangler d1 create` /
  `pages secret put` / `pages deploy` 三条命令是按官方文档写的，没有实机验证；
  真机上如果参数有出入，以 `wrangler` 的报错为准。
- **`wrangler.toml` 里的 `database_id = "local-dev"` 是占位值。** 本地够用，
  部署前必须换成 `d1 create` 返回的真实 UUID，否则 `--remote` 的操作会失败。
- **`pages_build_output_dir = "public"` 只影响部署时的静态目录。** 本地是靠
  `dev.sh` 传参（已验证）；线上 `pages deploy public` 那一步没跑过。
- **CORS 白名单是写死的。** 以后换域名（比如绑自定义域）要改
  `functions/api/_shared.js` 的 `corsHeaders()`，否则浏览器会拦。
- **限流的并发竞态没有验证。** 现在「先查计数、再写入」不是原子的：同一瞬间
  并发提交理论上可能略微超出 5/小时。单人小站可以接受；要绝对严格就得上
  Durable Object 或者原子 UPDATE。
- **`IP_SALT` 忘了设也不会报错。** 代码里有个兜底常量，那样盐就是公开的，
  知道 IP 的人能自己算出 `ip_hash` 绕过限流。部署时**务必** `secret put IP_SALT`；
  这件事没有任何机制强制，只是写在这儿提醒。
- **没在真实浏览器里点过。** `static/js/board.js` 是按它的请求格式用 curl 模拟的
  （字段、CORS 预检、token 流程都对上了），但没有实际打开页面验证过。
- **`CF-Connecting-IP` 那条路径没在真机核对。** 本地一律拿到 `127.0.0.1`，
  走的是 `X-Forwarded-For` 分支；线上的取值由 Cloudflare 注入。

