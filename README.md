# 虹星的星虹巢｜ほしのほしにじそう

个人主页 / 博客。**Hugo** 驱动，手工排版成 2010 年代早中期个人站的样子，
内容从原先的 Bear Blog 站点整体迁移而来。

---

## 一、本地预览

```powershell
hugo server -D
```

打开 <http://localhost:1313/>。改文件保存后浏览器自动刷新。

正式构建：

```powershell
hugo --gc --minify
```

产物在 `public/`（已被 `.gitignore` 忽略，不用提交）。

> 需要 Hugo **extended** 版，本项目在 `0.166.0` 上开发。
> 布局目录用的是 0.146 之后的新命名（`layouts/home.html`、`layouts/_partials/`），
> **不要降级到 0.145 及以下**，会找不到模板。

---

## 二、本地编辑器（图形界面）

不想敲命令就用这个。双击桌面上的 **`editor.cmd`**（或项目里的 `.editor\start.cmd`），
浏览器会自动打开 <http://127.0.0.1:4321/>。

它是个跑在本机的小工具，**零依赖**——只用 Node 内置模块，不用 `npm install`。
源代码就在 `.editor/` 里，想改随时改。

### 能做什么

| 功能 | 说明 |
| --- | --- |
| 浏览 / 编辑 | 左侧列出所有页面、模板、样式，点开就能改，`Ctrl+S` 保存 |
| 新建页面 | 博客 / 日记 / 单页。**日记会自动生成整月日历骨架** |
| 删除页面 | 删掉的文件先挪进 `.editor/trash/`，可以手动找回 |
| 站点设置 | `hugo.toml` 的 `[params]` 图形化编辑，**原有的注释不会丢** |
| 友情链接 / 小按钮 | 侧边栏两个挂件的表格化增删改（小按钮带配色预览） |
| 脚本管理 | 管 `static/js/` 下的 JS，开关决定是否全站加载；也能挂外部 CDN 脚本 |
| 图片上传 | 直接**拖拽 / 粘贴 / 选图**，自动存进 `static/images/` 并插入标签 |
| 草稿箱 | `draft: true` 的页面单独一组，一键在草稿 / 发布之间切换 |
| 导航页同步 | 扫日记里的日期锚点，自动刷新 `/navigator/` 的日历 |
| 实时预览 | 右侧内嵌 iframe，**跟着你正在编辑的那一页走**，保存后自动刷新；顶部有预览地址栏，可单独刷新或新标签打开 |
| 一键发布 | 顶部「发布」= `git add` + `commit` + `push` |

### 写日记：三步走

1. 左侧点「➕ 新建页面」，类型选**日记**，填好年月
   → 自动生成当月日历 + 和風月名短句，并在 `/navigator/` 里补上这个月

2. 写每天的段落时，点工具栏的「**📅 插入日期**」，输入几号
   → 自动插入 `<h2><span id="1005">10月 5日</span></h2>`

3. 写完点左侧「**📅 导航页同步**」→「立即同步」
   → 日历里有日记的日子就都变成可点的链接

> 同步默认**「只补不删」**：有锚点的日子指向最精确的那个锚点；
> 没有锚点、但你手工加过链接的日子会保留。想彻底对齐就勾上「清理」。

### 加图片

直接把图片**拖进编辑区**（也可以粘一张截图进来，或者点工具栏「🖼 插图」）。
会自动存进 `static/images/`，并在光标处插入 `<img src="/images/xxx.png">`。
重名会自动加 `-1`、`-2` 后缀，不会覆盖已有文件。

### 日记：每天的独立回复区

日记页里**每一天的日记都有自己的回复区**（不是整页一个留言板）。

因为 utterances 这类评论系统**一个页面只能挂一个实例**，所以实现方式是：
每天用一个 iframe 指向 `/reply/?t=<主题>`，每个 iframe 是独立文档，于是各自有独立留言板。

- 默认**收起**，只显示一行「💬 回复 2月 6日」，点了才加载（免得一页塞十几个 iframe）
- 主题名就是 `2026年2月日记 · 2月 6日`，在 GitHub 上会为每天建一条独立的 Issue
- 博客文章仍然是页面底部一个留言板，不受影响

> ⚠️ **前提**：得先去 <https://github.com/apps/utterances> 把这个 App 装到 `BlogStand` 仓库，
> 否则留言板会提示没装 App。`hugo.toml` 里的 `utterancesRepo` 我已经填好了。

### 草稿

新建的页面默认是**草稿**（`draft: true`），不会出现在线上站。
写完点工具栏的「📌 草稿中 → 点此发布」就上线了。
所有草稿都收在左侧的「草稿」分组里，一眼能看到还有多少没写完。

### 加一个 JS 特效

1. 左侧点「📜 脚本管理」
2. 点「＋ 新建脚本」，起个名字（比如 `sakura.js`）
3. 点「编辑」写代码，`Ctrl+S` 保存
4. 回到「脚本管理」，把它右边的「在网站上加载」打开
5. 顶部「预览」看效果，满意就点「发布」

编辑器会自动往 `layouts/baseof.html` 的这两个标记之间插 `<script>`：

```html
{{/* ==== EDITOR:SCRIPTS 开始（由编辑器管理，请勿手动改）==== */}}
{{/* ==== EDITOR:SCRIPTS 结束 ==== */}}
```

> `retro.js`（时钟、一言那些）和 `sparkle.js`（鼠标星星）是**内置脚本**，
> 由模板直接引入，编辑器里显示成灰色、不能开关。
> 想关掉鼠标星星，去「站点设置」把 `cursorSparkle` 关掉。

### 挂外部脚本

「脚本管理」页面下方有个文本框，贴第三方 CDN 地址，一行一个：

```
https://cdn.jsdelivr.net/npm/xxx/xxx.min.js
```

保存后会以 `<script defer>` 的形式挂到全站。

### 小技巧

- 地址栏可以直接带锚点跳：
  - `#settings` `#links` `#buttons` `#scripts` `#nav` —— 打开工具面板
  - `#preview` —— 进预览模式
  - `#f=content/niki/niki_202602.md&preview` —— 打开某个文件并预览它（可以收藏成书签）
  例如 <http://127.0.0.1:4321/#nav> 直接打开导航页同步
- 编辑器**已经在跑**的时候再双击一次，不会报错，会直接把浏览器打开

### 注意

- 编辑器**只监听 127.0.0.1**，局域网里别的机器访问不到
- 关掉那个命令行窗口 = 停止编辑器；它会把预览用的 hugo server 一起关掉
- 端口默认 4321；被占用了可以 `set EDITOR_PORT=4322 && node .editor\server.mjs`
## 三、目录结构

```
hugo.toml                       ← 站点配置（标题、标语、开关、导航栏）
archetypes/
  default.md                    ← 通用模板
  blog.md                       ← 新建博客文章时用
  niki.md                       ← 新建日记时用
assets/css/retro.css            ← 全部样式（会被 Hugo 当模板处理）
data/
  links.toml                    ← 侧边栏「友情链接」
  buttons.toml                  ← 侧边栏「小按钮」（88×31，纯 CSS 画的）
content/
  _index.md                     ← 首页
  self_intros.md                ← 关于 / 自己紹介（中日双语）
  navigator.md                  ← 导航页 —— 日记的唯一入口
  tobitaiaaken.md               ← 《想要飞的始祖小鸟》公式页
  gallery.md                    ← 虹星鱼拓站
  ihsobijin2006.md              ← 「你看到了」（隐藏页，只能直链访问）
  blog/                         ← 博客 section
    _index.md
    tabideru_20260901.md        ← 广州→宁波 独自游记
    sokuzai_cattest.md          ← Cattest 使用素材
    sokuzai-collected.md        ← 免费游戏素材收集
  niki/                         ← 日记 section
    _index.md                   ← 本身不生成页面，只用来做配置
    niki_202602.md … niki_202609.md
layouts/
  baseof.html  home.html  list.html  single.html
  taxonomy.html  term.html  404.html  rss.xml
  _partials/                    ← 页头、侧边栏、页脚、分页、留言板等零件
static/
  images/migrated/              ← 从旧站搬过来的 93 张图片
  images/avatar.png favicon.png
  js/                           ← 时钟、一言、鼠标星星
```

### 博客 和 日记 是分开的两套东西

这一点和你原来的站点保持一致：

| | 博客 | 日记 |
| --- | --- | --- |
| 文件放在 | `content/blog/` | `content/niki/` |
| 网址 | `/blog/xxx/` | `/niki/niki_2026xx/` |
| 入口 | 导航栏「博客」、首页「最新博客」 | **只有** 导航页 `/navigator/` |
| 列表页 | `/blog/` 会列出 | 不生成列表页 |
| 首页最新列表 | 会 | 不会 |
| 侧边栏最新列表 | 会 | 不会 |
| RSS 订阅源 | 会 | 不会 |
| 上一篇 / 下一篇 | 会 | 不会 |
| 标签云 / 标签页 | 会 | 不会 |

「日记只能从导航页找到」是靠这几处配置一起实现的：

- `content/niki/_index.md` 的 `build.render: never` → 不生成 `/niki/` 列表页
- 同文件里的 `cascade.params.hideNav: true` → 日记页不渲染上下篇区块
- 日记不挂标签 → 不会出现在标签云和标签页里
- `layouts/rss.xml` → 首页订阅源只收 `blog` section

日记仍然会进 `sitemap.xml`（和 Bear Blog 原本的行为一致，方便搜索引擎收录）。
想改成「完全不进 sitemap」，在 `content/niki/` 里每篇加 `build.list: never` 即可。
## 四、日常使用

### 基本循环

```powershell
# 1. 打开一个【新】PowerShell 窗口，进入项目目录
cd D:\Projects\hugo-2010-homepage

# 2. 本地预览（改任何文件，保存后浏览器自动刷新）
hugo server -D

# 3. 看完按 Ctrl+C 停掉，然后发布
git add -A
git commit -m "更新日记"
git push
```

推送后 GitHub Actions 大约 1 分钟自动构建部署，不需要手动做别的。
（`-D` 表示草稿也预览；正式发布前把 front matter 里的 `draft` 改成 `false`。）

### 写一篇博客文章

```powershell
hugo new content blog/文章名.md
```

套用 `archetypes/blog.md`。front matter 填 `title`（标题）、`date`（日期）、
`description`（摘要，列表页显示这句）、`tags`（标签，可选）。

### 写一篇日记

```powershell
hugo new content niki/niki_202610.md
```

套用 `archetypes/niki.md`。写完后记得三件事：

1. `title` 改成「2026年10月日记」这种格式
2. `date` 改成月份第一天（决定排序）
3. **不要打 `tags`** —— 一旦打了标签，日记就会出现在标签云和标签页里，
   等于开了导航页之外的第二个入口
4. **去 `content/navigator.md` 里挂链接** —— 那是日记唯一的入口

#### 在导航页里加一个新月份

`content/navigator.md` 是一块一块的，新月份在最上面，长这样：

```html
<hr>
<center>
2026年9月
</center>
<table>
  <!-- 日历表格：有日记的日子是链接，没有的写纯文本 -->
  <td><a href='/niki/niki_202609/#0901'>1日</a></td>
  <td>3日</td>
</table>
<p><br><center><b>長月 秋雨连绵 云沉满天</b></center><br></p>
```

要加 2026 年 10 月，就把上面这一整块**复制一份放到最前面**，然后：

- `2026年9月` 改成 `2026年10月`
- 重排日历（2026 年 10 月 1 日是周四，前面补三个 `--`）
- 有日记的日子改成 `<a href='/niki/niki_202610/#1005'>5日</a>`
  （`#1005` = 月份 + 日期，四位数，对应日记正文里的锚点）
- 换掉「長月 秋雨连绵」那句季节短句

### 加图片

图片统一放 `static/images/`（从旧站搬来的 93 张在 `static/images/migrated/`）。
正文里引用时**从 `/images/` 开头写**，Hugo 会自动补上 `/BlogStand/` 前缀：

```html
<img src="/images/我的图.png" width="300">
```

Markdown 写法也可以（两种都验证过，本地和线上都正常）：

```markdown
![说明文字](/images/我的图.png)
```

### 改各个页面的内容

| 想改什么 | 改哪个文件 |
| --- | --- |
| 首页（欢迎语、网站导航表、更新日志、友链横幅） | `content/_index.md` |
| 关于 / 自己紹介 | `content/self_intros.md` |
| 导航页（日记目录） | `content/navigator.md` |
| 虹星鱼拓站（画廊） | `content/gallery.md` |
| 想要飞的始祖小鸟 公式页 | `content/tobitaiaaken.md` |
| 「你看到了」（隐藏页） | `content/ihsobijin2006.md` |
| 博客文章 | `content/blog/*.md` |
| 日记 | `content/niki/*.md` |
| 站点名字、标语、顶部滚动公告、邮箱、头像 | `hugo.toml` 的 `[params]` |
| 页脚版权、备案号、建站日期 | 同上 |
| 导航栏菜单项 | `hugo.toml` 的 `[[menu.main]]` |
| 侧边栏「友情链接」 | `data/links.toml` |
| 侧边栏「小按钮」（88×31） | `data/buttons.toml` |
| 配色、字号、间距 | `assets/css/retro.css` |

正文里可以**直接写 HTML**（`<br>`、`<center>`、`<details>`、`<table>`、内联样式），
不会被吞掉——`hugo.toml` 里已经开了 `unsafe = true`。

### 关掉不想用的挂件

`hugo.toml` 的 `[params]` 里：

```toml
busuanzi      = true    # 访客计数器
showClock     = true    # 时钟
showHitokoto  = true    # 一言
cursorSparkle = true    # 鼠标跟随小星星
comments      = true    # 文末留言板
```

改成 `false` 就关掉。

### 改配色

颜色全在 `assets/css/retro.css`，主要几个：

| 颜色 | 用在哪 |
| --- | --- |
| `#1c5c9f` / `#4c93dc` | 顶部 Banner 渐变 |
| `#123f70` | 导航栏底色 |
| `#ff9900` | 橙色点缀（日期块、分割线） |
| `#0645ad` | 链接蓝 |
## 五、⚠️ 关于图片（重要）

从旧站搬过来的图片**目前是 180×180 的压缩版**。

原因：旧站用的图床 `i.ibb.co` 会按请求方特征区别对待——浏览器拿到的是原图，
命令行/脚本请求只能拿到缩略图。所以自动下载下来的是压缩过的版本。

**不影响布局**（尺寸比例是对的），但清晰度不如原图。

### 怎么换成原图

两种办法，任选：

1. **手动替换** —— 把原图下载下来，覆盖 `static/images/migrated/` 里的同名文件即可，
   正文不用改一个字。（推荐：在浏览器里打开旧站，右键另存为）

2. **改用别的图床** —— 上传到任意图床，然后把 .md 里对应的
   `/images/migrated/xxx.png` 换成新的外链。

旧站原址：<https://hoshi-rainbowsou.bearblog.dev/>

---

## 六、部署到 GitHub Pages

### 1. 建仓库

| 仓库名 | 站点地址 |
| --- | --- |
| `你的用户名.github.io` | `https://你的用户名.github.io/`（**推荐**） |
| 其它名字，如 `home` | `https://你的用户名.github.io/home/` |

### 2. 改 `hugo.toml` 里的地址

```toml
baseURL = "https://你的用户名.github.io/"
```

> 子路径仓库记得带目录名：`https://你的用户名.github.io/home/`
> **填错会导致 CSS 和图片全部 404。**

### 3. 开启 Actions 发布

仓库 → **Settings** → **Pages** → **Build and deployment** → **Source** 选 **GitHub Actions**

### 4. 推送

```powershell
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

推送后 `.github/workflows/hugo.yml` 会自动构建部署，约一分钟上线。
之后每次 `git push` 网站自动更新。

---

## 七、从 Bear Blog 迁移的说明

| 项目 | 处理方式 |
| --- | --- |
| 正文文字 | **一字未改**（已用 2093 个文字片段逐段校验过两次） |
| 正文 HTML | 原样保留（`<br>`、`<center>`、`<details>`、内联样式等） |
| 图片 | 已下载到本地 `static/images/migrated/`，不再依赖外链 |
| 站内链接 | 已改为相对路径 |
| 博客 / 日记 | 按老站的结构拆成了两个 section（见上一节） |
| 旧网址 | 全部保留为跳转页，见下表 |
| `tobitaiaaken` 的页面级 CSS | 原来直接改 `body`，会污染整站；已限制在 `.tbtak` 容器内 |
| `ihsobijin2006` 里内嵌的 `<body>` | 改成 `.own-room` 容器，黑底只作用于正文 |
| `ihsobijin2006` 的可见性 | 不参与列表、上下篇、RSS、sitemap，只能直链打开 |
| `#Nikki` 标签 | 已从 8 篇日记上移除（否则标签页会成为日记的另一个入口） |
| 标题/摘要里的 `&gt;` | 已还原（否则会显示成字面的 `&gt;`） |

### 旧地址对照

| 旧地址（Bear Blog） | 新地址 |
| --- | --- |
| `/` | `/` |
| `/self_intros/` | `/self_intros/` |
| `/navigator/` | `/navigator/` |
| `/gallery/` | `/gallery/` |
| `/tobitaiaaken/` | `/tobitaiaaken/` |
| `/ihsobijin2006/` | `/ihsobijin2006/` |
| `/sokuzai_cattest/` | `/blog/sokuzai_cattest/` |
| `/sokuzai-collected/` | `/blog/sokuzai-collected/` |
| `/tabideru_20260901/` | `/blog/tabideru_20260901/` |
| `/niki_202602/` … `/niki_202609/` | `/niki/niki_202602/` … `/niki/niki_202609/` |

以上旧地址都会自动跳转到新地址，贴出去的链接不会失效。
（另外 `/posts/niki_2026xx/` 这个中途用过的地址也保留了跳转。）
## 八、还需要填的地方

- [ ] `hugo.toml` → `baseURL` 改成你的正式域名
- [ ] `hugo.toml` → `email` 改成你的邮箱（页脚和「给我写信」会用到）
- [ ] `hugo.toml` → `utterancesRepo` 改成你的仓库（留言板，需先装 utterances App）
- [ ] 用原图替换 `static/images/migrated/` 里的压缩图
- [ ] 把 `static/images/avatar.png` 换成你喜欢的头像（侧边栏用）