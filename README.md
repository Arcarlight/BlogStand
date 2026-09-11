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

## 二、目录结构

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
## 三、日常使用

### 写一篇新博客文章

```powershell
hugo new content blog/文章名.md
```

### 写一篇新日记

```powershell
hugo new content niki/niki_202610.md
```

两者分别套用 `archetypes/blog.md` 和 `archetypes/niki.md`，front matter 会自动填好。
写完把 `draft` 改成 `false`，或者预览时加 `-D` 看草稿。

front matter 说明：

| 字段 | 作用 |
| --- | --- |
| `title` | 标题 |
| `date` | 日期，决定排序 |
| `tags` | 标签，侧边栏标签云会用（日记一般不用打标签） |
| `description` | 摘要，列表页显示这句 |
| `draft` | `true` 表示草稿 |
| `aliases` | 旧的网址，会生成跳转页 |
### 正文里可以直接写 HTML

旧站的内容是用 HTML 写的（`<br>`、`<center>`、`<details>`、内联样式……），
Hugo 配置里已经打开 `unsafe = true`，所以**这些标签都能原样保留**，不用担心被吞掉。

### 加图片

图片放在 `static/images/` 下，正文里这样引用：

```html
<img src="/images/我的图.png">
```

### 改站点名字 / 标语 / 挂件开关

都在 `hugo.toml` 的 `[params]` 里：

```toml
authorName = "虹星"
slogan     = "欢迎来到虹星用来堆放日常的博客！"
notice     = "★ 欢迎来到星虹巢 ★ ..."     # 顶部跑马灯
busuanzi      = true    # 访客计数器
showClock     = true    # 时钟
showHitokoto  = true    # 一言
cursorSparkle = true    # 鼠标跟随小星星
comments      = true    # 文末留言板
```

---

## 四、⚠️ 关于图片（重要）

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

## 五、部署到 GitHub Pages

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

## 六、从 Bear Blog 迁移的说明

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
## 七、还需要填的地方

- [ ] `hugo.toml` → `baseURL` 改成你的正式域名
- [ ] `hugo.toml` → `email` 改成你的邮箱（页脚和「给我写信」会用到）
- [ ] `hugo.toml` → `utterancesRepo` 改成你的仓库（留言板，需先装 utterances App）
- [ ] 用原图替换 `static/images/migrated/` 里的压缩图
- [ ] 把 `static/images/avatar.png` 换成你喜欢的头像（侧边栏用）