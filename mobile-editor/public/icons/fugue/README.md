# 手机写作间的图标：Fugue Icons

`mobile-editor/public/icons/fugue/` 里的图标来自 **Fugue Icons**，
作者 **Yusuke Kamiyamane**，采用
**[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)** 许可。

- 官方主页：<https://p.yusukekamiyamane.com/>
- **署名要求（官方说明）**：<https://p.yusukekamiyamane.com/icon/attribution/>
- 署名文案（首页页脚已放）：`图标：Fugue Icons by Yusuke Kamiyamane（CC BY 3.0）`

> 页面里用这些图的是**写作间自己的界面**（登录页、首页、编辑器工具按钮、留言板），
> 不是 Hugo 站点正文/站点头像。站点内容里的图标不动。
> 源头是电脑端编辑器 `.editor/icons/fugue/`（同一套图，避免两处各存一套不同的），
> 这里复制了手机端实际用到的那 15 个。

## 文件

`fugue/` 下是 **32×32** 的放大版（<https://github.com/chrisjbillington/fugue-2x-icons>，
同一套图按 2 倍放大），页面上按 **16px** 显示 —— Retina / DPR 2 下正好 1:1，
1x 屏就是普通缩小。首页四张卡的图标显示 26px（同一张图，稍微缩小一点）。

## 逻辑名 → 文件（`app.js` 的 `FUGUE` 映射表）

| 逻辑名 | Fugue 文件 | 用在哪 |
| --- | --- | --- |
| `chevron-left` | `arrow-180-small.png` | 各页左上角「返回」 |
| `chevron-right` | `arrow-000-small.png` | 备用（当前页面没引用） |
| `pen` | `pencil.png` | 首页「写博客」 |
| `book` | `book.png` | 首页「写日记」 |
| `file` | `document-text.png` | 首页「改文章」 |
| `board` | `balloon-quotation.png` | 首页「留言板」 |
| `image` | `image.png` | 编辑器「插入图片」 |
| `refresh` | `arrow-repeat.png` | 列表 / 日记「重新载入」 |
| `reply` | `paper-plane.png` | 留言板「答复」 |
| `trash` | `cross.png` | 留言板「删掉」（和桌面端一样用红叉，不用垃圾桶） |
| `spark` | `diamond.png` | 登录页标识 |
| `check` | `tick.png` | 备用（当前页面没引用） |
| `eye` | `eye.png` | 留言板「恢复」 |
| `eye-off` | `cross.png` | 留言板「隐藏」 |
| `clock` | `calendar.png` | 构建状态条（没有时钟图标，用最接近的日历） |
| `logout` | `external.png` | 首页「退出登录」 |

## 换图标

换某个图标：把同名 PNG 换掉即可（保持 32×32）。
想换成另一张 Fugue：改 `app.js` 里 `FUGUE` 映射表的值就行，路径是 `/icons/fugue/<文件名>.png`。
**不要引新的图标集**——保持和电脑端编辑器同一套（站长特意提醒过）。

## 注意

- `sw.js` 的 app shell 预缓存列表里逐个列了这 15 个文件；新增图标要同步加进 `SHELL`。
- 这些是**界面图标**，不参与 Hugo 构建；文件在 `public/` 下会跟 PWA 一起部署，
  `_headers` 里给 `/icons/*` 设了 `Cache-Control: public, max-age=604800`。
