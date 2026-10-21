# 编辑器图标（macOS）

`editor-icon-1024.png` 和 `editor-icon.icns` 都由站长的原画生成，母版是
一张 1024×1024 的满版图（沙漠蜻蜓站在夜空下、金色飘带）。

- `editor-icon-1024.png`：1024 透明画布，画稿缩到 **824×824** 并套上 macOS 的
  圆角形状（superellipse，n≈5），四周留透明边——macOS 的 Dock/Finder 不会自己
  裁形状，所以必须自带这层圆角。
- `editor-icon.icns`：16–1024 全套打包，`tools/make-macos-app.sh` 默认用它。
- `editor-icon.ico`：Windows 桌面快捷方式用的多尺寸图标（16–256）。

## Windows 桌面快捷方式

`.cmd` 本身不能单独设图标，得包一层 `.lnk`。跑：

```powershell
pwsh -File tools/make-desktop-shortcut.ps1
```

它会用这里的 `.ico` 在桌面建一个「星虹巢编辑器.lnk」，并把原来的 `.cmd`
设成隐藏（桌面只留带图标的那个；撤销：`attrib -h` 后删掉 .lnk）。

## 换图标

1. 画一张 1024×1024 的母版（满版、主体放中央 80%，模板见 `icons-template/`）；
2. 重跑生成脚本：

   ```bash
   python tools/make-app-icons.py 母版.png
   ```

   它同时会更新手机写作间那四张 PWA 图标（`mobile-editor/public/icons/`），
   改完记得 bump 一下 `sw.js` 里的 `VERSION`，再重新部署 mobile-editor。

3. 重新生成 macOS 应用（脚本默认就用这里的 `editor-icon-1024.png`）：

   ```bash
   tools/make-macos-app.sh
   ```

## 注意

- macOS 的 `.icns` 必须自带圆角、四周透明；直接塞一张满版方图会变成硬邦邦的方块。
- 这张图**不上网站**（放在 `tools/` 下，不进 Hugo 的 `static/`），和站上的 favicon 无关。
