# 编辑器图标：Fugue Icons

编辑器界面（`.editor/ui.html`）里的图标用的是 **Fugue Icons**，
作者 **Yusuke Kamiyamane**，共 3,750 枚 16×16 图标，采用
**[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)** 许可。

- 官方主页：<https://p.yusukekamiyamane.com/>
- 署名要求（官方说明）：<https://p.yusukekamiyamane.com/icon/attribution/>

> ⚠️ **这些图只给编辑器用，不上网站。**
> 它们放在 `.editor/icons/`（**不是** `static/`）—— `static/` 下的文件会被 Hugo
> 一起发布到网站上；站长的要求是「编辑器换图标、网页上的图标不动」。
> 编辑器通过 `/editor-icons/fugue/<名字>.png` 这条路由伺服它们（见 `server.mjs`）。

## 这里放的是什么

`fugue/` 下是**用到的那些图标**，取的是 32×32 的放大版
（<https://github.com/chrisjbillington/fugue-2x-icons>，同一套图按 2 倍放大），
显示时按 **16px** —— Retina（DPR 2）下正好 1:1，1x 屏就是普通缩小。

换某个图标：把同名 PNG 换掉即可；想换成另一张，改 `ui.html` 里那张
`FUGUE` 映射表（逻辑名 → 文件名）就行，不用动别的地方。

## 名字对照（编辑器里叫什么 → 用的哪张图）

| 编辑器 | Fugue 文件 | 用在哪 |
| --- | --- | --- |
| `book` | `book.png` | 文集面板 |
| `music` | `music.png` | 音乐 |
| `paint-brush` | `paint-brush.png` | 画廊 |
| `cog` | `gear.png` | 站点设置 |
| `bars` | `navigation.png` | 顶部导航 |
| `link` | `chain.png` | 友情链接 / 工具栏「链接」 |
| `grid` | `ui-buttons.png` | 小按钮 |
| `refresh` | `arrow-repeat.png` | 更新日志 / 拉取线上 / 刷新预览 |
| `notebook` | `notebook.png` | 更新历史 |
| `comment-quote` | `balloon-quotation.png` | 公告栏 / 心声 |
| `message-dots` | `balloon-ellipsis.png` | 宝可梦台词 |
| `diamond` | `diamond.png` | 蒂安希听到了 |
| `pencil-ruler` | `pencil-ruler.png` | 侧栏排序 / 图片宽度 |
| `code` | `script.png` | 脚本管理 |
| `calendar-alt` | `calendar.png` | 日记日历 / 插入日期 |
| `plus` | `plus.png` | 新建页面 |
| `eye` | `eye.png` | 预览 |
| `external-link` | `external.png` | 打开线上站 |
| `check` | `tick.png` | 构建检查 |
| `upload` | `upload.png` | 发布 |
| `bold` / `italics` | `edit-bold.png` / `edit-italic.png` | 加粗 / 倾斜 |
| `expand` | `application-resize.png` | 应用图片宽度 |
| `image` | `image.png` | 插图 |
| `thumbtack` | `pin.png` | 设为草稿 |
| `save` | `disk.png` | 保存 |
| `trash` | `bin.png` | 删除 |
| `search` / `folder` | `magnifier.png` / `folder.png` | 备用（当前面板里没引用） |
