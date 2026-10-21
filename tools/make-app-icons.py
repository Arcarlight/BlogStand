#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从一张 1024×1024 的母版生成全部应用图标。

    python tools/make-app-icons.py D:/ToolsSoftware/DSH_Website/app-icon.png

做的事：
  1. 手机写作间 PWA（mobile-editor/public/icons/）
       icon-512.png / icon-192.png / apple-touch-icon.png（180，不透明）
       maskable-512.png（Android 自适应）
  2. macOS 编辑器（tools/editor-icon/）
       editor-icon-1024.png  1024 透明画布 + 824×824 macOS 圆角（superellipse）
       editor-icon.icns      16–1024 全套，给 make-macos-app.sh 用

母版要求：1024×1024 PNG，不透明（有 alpha 也行，但背景要铺满），
主体在中央 80% 内。模板见 icons-template/（仓库外的工作区里）。

改完图标记得：
  - manifest 里 maskable 条目、sw.js 的 VERSION（让旧缓存失效）；
  - 重新部署 mobile-editor（wrangler pages deploy）。
"""
import argparse
import os
import struct

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PWA = os.path.join(ROOT, "mobile-editor", "public", "icons")
MAC = os.path.join(ROOT, "tools", "editor-icon")
ICNS_ENTRIES = [
    (b"icp4", 16), (b"icp5", 32), (b"icp6", 64),
    (b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024),
    (b"ic11", 32), (b"ic12", 64), (b"ic13", 256), (b"ic14", 512),
]
SQUIRCLE_N = 5.0
MAC_ART = 824  # Apple 模板：1024 画布上圆角矩形 824×824


def squircle_mask(size, n=SQUIRCLE_N, ss=4):
    m = Image.new("L", (size * ss, size * ss), 0)
    px = m.load()
    half = size * ss / 2.0
    for y in range(size * ss):
        dy = abs(y + 0.5 - half) / half
        for x in range(size * ss):
            dx = abs(x + 0.5 - half) / half
            if dx ** n + dy ** n <= 1.0:
                px[x, y] = 255
    return m.resize((size, size), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="1024×1024 母版 PNG")
    args = ap.parse_args()

    im = Image.open(args.source).convert("RGBA")
    if im.size != (1024, 1024):
        im = im.resize((1024, 1024), Image.LANCZOS)

    os.makedirs(PWA, exist_ok=True)
    os.makedirs(MAC, exist_ok=True)

    # ---------- PWA ----------
    im.resize((512, 512), Image.LANCZOS).save(os.path.join(PWA, "icon-512.png"))
    im.resize((192, 192), Image.LANCZOS).save(os.path.join(PWA, "icon-192.png"))
    im.resize((180, 180), Image.LANCZOS).convert("RGB").save(os.path.join(PWA, "apple-touch-icon.png"))
    im.resize((512, 512), Image.LANCZOS).save(os.path.join(PWA, "maskable-512.png"))

    # ---------- macOS ----------
    art = im.resize((MAC_ART, MAC_ART), Image.LANCZOS)
    master = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    master.paste(art, ((1024 - MAC_ART) // 2, (1024 - MAC_ART) // 2), squircle_mask(MAC_ART))
    master.save(os.path.join(MAC, "editor-icon-1024.png"))

    png = {}
    for _, s in ICNS_ENTRIES:
        if s not in png:
            tmp = os.path.join(MAC, "._tmp_%d.png" % s)
            master.resize((s, s), Image.LANCZOS).save(tmp)
            png[s] = open(tmp, "rb").read()
            os.remove(tmp)

    body = b""
    for typ, s in ICNS_ENTRIES:
        data = png[s]
        body += typ + struct.pack(">I", len(data) + 8) + data
    open(os.path.join(MAC, "editor-icon.icns"), "wb").write(
        b"icns" + struct.pack(">I", len(body) + 8) + body)

    Image.open(os.path.join(MAC, "editor-icon.icns")).verify()  # 回读校验
    print("ok: pwa -> %s" % PWA)
    print("ok: mac -> %s" % MAC)


if __name__ == "__main__":
    main()
