# 手机写作间（mobile-editor）

给 <https://arcarlight.github.io/BlogStand/> 用的**手机端写作页**。

电脑上的 `.editor/` 只能在本机 `127.0.0.1:4321` 跑，而且界面是桌面布局；
这个目录是它的手机版：一个手机优先的网页/PWA，部署在 **Cloudflare Pages** 上，
后端 Functions 直接用 GitHub API 把改动提交回 `Arcarlight/BlogStand` 的 `main`。
提交之后 GitHub Actions 照常构建、发布到 GitHub Pages。

所以：**手机 → 本页 → 一次 commit → Actions → 线上站点**。没有数据库，
没有第二条内容通道，站点内容始终只以仓库为准。

```
mobile-editor/
  wrangler.toml          Pages 配置（项目名 nijiboshi-edit）
  CONTRACT.md            前后端实现契约（改代码前先看）
  functions/             Pages Functions：/api/*
  public/                前端静态文件（app shell、PWA）
  .dev.vars.example      本地开发变量模板
```

## 一、首次部署

前置：本机已 `npx wrangler login`，且 `npx wrangler whoami` 能看到账号。

```bash
cd D:/Projects/hugo-2010-homepage/mobile-editor

# 1. 建 Pages 项目（项目名=线上子域名，占了就换一个）
npx wrangler pages project create nijiboshi-edit --production-branch main

# 2. 写四个 secret（每一个都会提示输入值，粘进去回车）
npx wrangler pages secret put EDITOR_PASS       --project-name nijiboshi-edit
npx wrangler pages secret put SESSION_SECRET    --project-name nijiboshi-edit
npx wrangler pages secret put GITHUB_TOKEN      --project-name nijiboshi-edit
npx wrangler pages secret put BOARD_ADMIN_TOKEN --project-name nijiboshi-edit

# 3. 部署（functions/ 会被自动识别成 /api/*）
npx wrangler pages deploy public --project-name nijiboshi-edit --branch main
```

线上地址：`https://nijiboshi-edit.pages.dev`。

四个值的来历：

| 名字 | 是什么 | 怎么弄 |
|---|---|---|
| `EDITOR_PASS` | 打开页面的口令 | 自己定，12 位以上，别和别处复用 |
| `SESSION_SECRET` | 登录 cookie 的签名密钥 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `GITHUB_TOKEN` | 往仓库写内容的令牌 | GitHub → Settings → Developer settings → **Fine-grained tokens** → 只选 BlogStand 仓库，权限只给 **Contents: Read and write**（要读构建状态再加 **Actions: Read**） |
| `BOARD_ADMIN_TOKEN` | 留言板管理令牌 | 就是 `board-api` 里用 `wrangler pages secret put ADMIN_TOKEN` 设的那个值 |

> `vars`（`wrangler.toml` 里的 `[vars]`）和 secret **共用同一个绑定命名空间**，
> 同名会部署失败（`Binding name 'X' already in use`）。所以那四个名字只能走
> `secret put`，不要写进 `[vars]`。

## 二、手机上用

1. 手机浏览器打开 `https://nijiboshi-edit.pages.dev`。
2. 输入 `EDITOR_PASS`。
3. **加到主屏**：
   - iOS Safari：分享 → 「添加到主屏幕」
   - Android Chrome：菜单 → 「安装应用」/「添加到主屏幕」
4. 之后从图标打开就是全屏、无地址栏，和 App 一样。

能做的事：

- **写博客**：标题、文件名、日期、草稿开关、正文，图片直接从相册/相机传；
- **写日记**：选日期 → 自动读当月文件里那一天的小节，改完保存；没写过就按日期顺序插进去；
- **改文章**：博客/日记/页面列表，原始 Markdown 全量编辑（自动刷 `lastmod`）；
- **留言板**：看、回、隐藏/恢复、真删。

改完不是立刻生效：**要等 GitHub Actions 构建**（一般 1～2 分钟）。
首页顶部有构建状态条，发布后每 15 秒查一次，出结果就停。

## 三、安全模型（重要）

- 页面本身公开可访问，但**所有 `/api/*`（除 ping/login）都要登录 cookie**。
  没有口令什么都读不到、写不了。
- `GITHUB_TOKEN` 只存在 Cloudflare secret 里，前端拿不到。
- 口令错了限流：10 分钟 8 次。这个计数在 isolate 内存里，冷启动会重置，
  是「够用」级别，不是堡垒级防御。
- 建议：口令别外借；PAT 定期轮换；如果哪天觉得泄露了，
  改 `EDITOR_PASS` + 重新 `wrangler pages secret put`，旧 cookie 会因
  签名密钥不变而仍然有效——要立刻踢掉所有设备，就连 `SESSION_SECRET` 一起换。

## 四、本地开发

```bash
cd D:/Projects/hugo-2010-homepage/mobile-editor
cp .dev.vars.example .dev.vars     # 然后填真实值
npx wrangler pages dev public --port 8789
```

**本地 `GITHUB_BRANCH` 必须指向测试分支**（例如 `test-mobile-editor`），
不要拿 `main` 练手——每一次保存都是一次真实提交。

## 五、已知限制

- 一次保存 = 一次提交，提交信息自动生成；不合并、不改写历史。
- 一次只能编辑一个文件；不支持重命名/移动文件（那还是回电脑用本地编辑器）。
- 图片在浏览器里压缩（长边 1600）；不入库原图之外的尺寸变体，
  画作画廊那套缩略图仍由电脑端 `tools/` 脚本处理。
- 留言板的答复/隐藏/删除走 `board-api`；那边挂了这里就一起挂。
- 并发冲突：两个设备同时改同一个文件时，后保存的会拿到 409，
  由你选「用我的覆盖」或「载入线上版本」。
