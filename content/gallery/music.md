---
title: "虹星鱼拓站 · 音乐"
date: 2026-10-22
type: music
draft: false
description: "堆自己做的音乐的地方。MP3 / OGG / MIDI 都能在线播，MIDI 是浏览器现场合成的。"
---

<center><h1>音乐</h1></center>

<br>这里放自己做的音乐。列表和侧栏那个小播放器用的是同一份曲目表
（`data/music.toml`），区别是这里能看完整列表、拖进度、单独挑一首听。

<br>三种格式的处理方式：

- **MP3 / OGG** —— 直接交给浏览器解码播放，点一下就能听。
- **MIDI** —— 浏览器**没有**内建 MIDI 支持（`<audio>` 放不了），所以是本站
  自己用 Web Audio 现场合成的：三角波/方波/锯齿 + ADSR 包络，不下载任何音源文件。
  听起来是芯片音乐的味道，没有真实乐器采样。
  想听真实乐器音色的话，需要另挂一份 GM 音源（FluidR3 Mono GM，MIT 许可，约 18 MB），
  那是「点了才加载」的选项，默认不下载。

<br>正文里也能嵌一首，短代码是：

```
{{</* music file="Lowlayer_moutain.mid" title="低层山" */>}}
```
