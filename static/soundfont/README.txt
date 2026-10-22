FluidR3Mono_GM.sf3 —— 通用 MIDI 音源（SoundFont3）
==================================================

来源    Debian 软件包 fluidr3mono-gm-soundfont 2.315-7
        https://packages.debian.org/bookworm/sound/fluidr3mono-gm-soundfont
        包里的文件在 /usr/share/fluidr3mono-gm-soundfont/FluidR3Mono_GM.sf3
        （/usr/share/sounds/sf3/FluidR3Mono_GM.sf3 是指向它的符号链接）
许可    MIT（完整版权与许可声明见同目录 LICENSE.txt）

体积    23.6 MB（SF3 = 采样用 Ogg Vorbis 压过，没法再压了）

为什么放仓库里而不是外链：
  · 站点部署在 GitHub Pages，本仓库自己的静态文件就是最稳的 CDN；
    外链（Google Drive / 各种 sample 站）随时会挂，跨域还会被 CORS 挡。
  · GitHub Pages 单文件上限 100 MB，23.6 MB 没问题。

谁在用它：
  static/js/midi-soundfont.js —— 只有访客在音乐页点「真实音源」时才下载，
  并且下载完会存进 Cache Storage（mus-sf3-v1），第二次访问不再重下。
  默认仍然是零下载的内置合成（static/js/midi-player.js）。
