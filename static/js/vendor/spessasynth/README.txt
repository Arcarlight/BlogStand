SpessaSynth 运行时（第三方，原样 vendor）
=========================================

来源    https://github.com/spessasus/spessasynth_lib
版本    spessasynth_lib 4.3.14（npm）
许可    Apache-2.0（见同目录 LICENSE.txt）

文件
  spessasynth.min.js            ESM 单文件，esbuild 打的 bundle
  spessasynth_processor.min.js  AudioWorklet 处理器，必须同源单独加载
                                （new WorkletSynthesizer 之前先
                                  ctx.audioWorklet.addModule(这个文件)）

怎么重新生成的（升级时照做）
  npm i spessasynth_lib@<版本> esbuild
  node node_modules/esbuild/bin/esbuild \
       node_modules/spessasynth_lib/dist/index.js \
       --bundle --format=esm --minify --platform=browser --target=es2020 \
       --outfile=spessasynth.min.js
  cp node_modules/spessasynth_lib/dist/spessasynth_processor.min.js .

为什么不用 CDN 的 dist/index.js：
  npm 包里的 dist/index.js 第一行是
      import { ... } from "spessasynth_core";
  裸模块名浏览器解析不了（得配 importmap 再单独 host 一个 spessasynth_core），
  所以这里直接 bundle 成一个自包含文件。

体积
  spessasynth.min.js            约 440 KB
  spessasynth_processor.min.js  约 403 KB
  两个都是「点了真实音源开关才下载」，不进首屏。

调用方：static/js/midi-soundfont.js
