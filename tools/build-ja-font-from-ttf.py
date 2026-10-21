#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从人工提取的 msgothic-12px.ttf 生成 static/fonts/msgothic12-jp-pixel.woff2。

背景
----
原来这份是 tools/build-pixel-font.py --ja 从**系统 MS Gothic 的 EBDT 点阵表**
解析出来再重建成轮廓的。站长后来找到了人工从 Windows XP SP3 镜像提取的一整套
点阵字体（D:\\ToolsSoftware\\Use_Fonts\\winxp-pixel-font-ttf-v2026.09.18），
其中 msgothic-12px.ttf 的假名**居中更准**：

    あ 手工版占 1..10 格（左右各留 1px）✅
    あ 现用版占 0..8 格（左贴边、右边空 3px）❌

所以改成以手工版为字形来源。

本脚本做三件事
--------------
 1. 按 retro.css 里 MSGothic12JPPixel 的 unicode-range 取子集
    （假名 / 半角片假名 / 一批符号 —— 汉字**不要**，中文的汉字必须走宋体，
      不能用日文字形）。
 2. 补上手工版缺的一个字：**〜 U+301C**。
    CSS 把 U+301C 路由给这份字体，手工版偏偏没有 —— 不补的话站点里的 〜
    会掉到系统字体、不是点阵。从旧字体缩放搬过来
    （旧 upem 1536、每格 128；新 1200、每格 100；×0.78125 精确整数）。
 3. 改字体族名为 MSGothic12JPPixel，写 woff2。

用法
----
    python tools/build-ja-font-from-ttf.py
    python tools/build-ja-font-from-ttf.py --dry-run
"""

import argparse
import copy
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTDIR = os.path.join(ROOT, "static", "fonts")
OUT = os.path.join(FONTDIR, "msgothic12-jp-pixel.woff2")

SRC = r"D:\ToolsSoftware\Use_Fonts\winxp-pixel-font-ttf-v2026.09.18\msgothic-12px.ttf"
FAMILY = "MSGothic12JPPixel"

# 和旧字体的拼接源（只为了拿 〜 等手工版缺的字）
LEGACY = os.path.join(ROOT, "tools", "sources", "msgothic12-jp-1536.woff2")

# retro.css 里 MSGothic12JPPixel 的 unicode-range（改 CSS 要同步改这里）
CSS_RANGES = [
    (0x2190, 0x2193), (0x25A0, 0x25A1), (0x25B2, 0x25B3), (0x25CB, 0x25CB),
    (0x25CE, 0x25CF), (0x2605, 0x2606), (0x2660, 0x2660), (0x2663, 0x2663),
    (0x2665, 0x2666), (0x266A, 0x266B), (0x266D, 0x266D), (0x266F, 0x266F),
    (0x301C, 0x301C), (0x3041, 0x3093), (0x309B, 0x309E), (0x30A1, 0x30F6),
    (0x30FB, 0x30FE), (0xFF61, 0xFF9F),
]
WANT = set()
for _a, _b in CSS_RANGES:
    WANT.update(range(_a, _b + 1))


def log(*a):
    print(*a, flush=True)


def to_unicode_range(cps):
    cps = sorted(set(cps))
    out = []
    start = prev = None
    for cp in cps:
        if start is None:
            start = prev = cp
            continue
        if cp == prev + 1:
            prev = cp
            continue
        out.append((start, prev))
        start = prev = cp
    if start is not None:
        out.append((start, prev))
    parts = []
    for a, b in out:
        parts.append("U+%04X" % a if a == b else "U+%04X-%04X" % (a, b))
    return ", ".join(parts)


def rename_family(font, family):
    nm = font["name"]
    for rec in list(nm.names):
        try:
            cur = rec.toUnicode()
        except Exception:
            continue
        if "MS Gothic" in cur or "MSGothic" in cur or cur in ("Regular",):
            pass
        if "MS Gothic" in cur or "MSGothic" in cur:
            rec.string = cur.replace("MS Gothic", family).replace("MSGothic", family)
    for pid, eid, lid, nid, val in (
        (3, 1, 0x409, 1, family), (3, 1, 0x409, 4, family + " Regular"),
        (3, 1, 0x409, 6, family + "-Regular"), (1, 0, 0, 1, family),
        (1, 0, 0, 4, family + " Regular"),
    ):
        nm.setName(val, nid, pid, eid, lid)


def main():
    ap = argparse.ArgumentParser(description="从手工提取的 msgothic-12px.ttf 重建日文字体")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(SRC):
        sys.exit("找不到源字体：%s" % SRC)

    font = TTFont(SRC)
    upem = font["head"].unitsPerEm
    cmap = set(font.getBestCmap().keys())
    log("源字体：%s" % SRC)
    log("  upem=%d  hhea=%d/%d  码位=%d  字形=%d"
        % (upem, font["hhea"].ascent, font["hhea"].descent,
           len(cmap), font["maxp"].numGlyphs))

    want = WANT & cmap
    missing = sorted(WANT - cmap)
    log("  CSS 路由的码位 %d，源里有 %d，缺 %d：%s"
        % (len(WANT), len(want), len(missing), "".join(chr(c) for c in missing) or "无"))

    # 子集
    opts = subset.Options()
    opts.flavor = None
    opts.drop_tables = ["vhea", "vmtx"]
    opts.layout_features = []
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.recalc_bounds = False
    opts.glyph_names = False
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=sorted(want))
    sub.subset(font)

    # 补手工版缺的字
    added = []
    if missing and os.path.exists(LEGACY):
        leg = TTFont(LEGACY)
        if leg["head"].unitsPerEm != 1536:
            log("  ⚠️ 旧字体 upem=%d 不是 1536，跳过补字" % leg["head"].unitsPerEm)
            leg.close()
        else:
            scale_upem(leg, upem)          # 1536 -> 1200，×0.78125 精确
            lcmap = leg.getBestCmap()
            order = font.getGlyphOrder()
            hmtx = font["hmtx"].metrics
            glyf = font["glyf"]
            cmaps = [t for t in font["cmap"].tables if t.isUnicode()]
            for cp in missing:
                gname = lcmap.get(cp)
                if not gname or gname not in leg["glyf"]:
                    continue
                newname = "ext_%04X" % cp
                while newname in hmtx:
                    newname += "_"
                order.append(newname)
                glyf[newname] = copy.deepcopy(leg["glyf"][gname])
                hmtx[newname] = leg["hmtx"].metrics[gname]
                for t in cmaps:
                    t.cmap[cp] = newname
                added.append(cp)
            font.setGlyphOrder(order)
            font["maxp"].numGlyphs = len(order)
            leg.close()
            log("  从旧字体补入 %d 个：%s" % (len(added), "".join(chr(c) for c in added)))
    elif missing:
        log("  ⚠️ 缺字 %s，且没有旧字体可补" % "".join(chr(c) for c in missing))

    rename_family(font, FAMILY)
    font.recalcTimestamp = False
    font.flavor = "woff2"

    if args.dry_run:
        log("\n（dry-run，不写文件）")
        return

    font.save(OUT)
    out = TTFont(OUT)
    actual = set(out.getBestCmap().keys())
    log("")
    log("输出 %s" % OUT)
    log("  %.1f KB  码位 %d  upem=%d  hhea=%d/%d  family=%r"
        % (os.path.getsize(OUT) / 1024.0, len(actual),
           out["head"].unitsPerEm, out["hhea"].ascent, out["hhea"].descent,
           out["name"].getDebugName(1)))
    still = sorted(WANT - actual)
    log("  CSS 路由的码位仍未覆盖: %d %s"
        % (len(still), "".join(chr(c) for c in still) or "无"))
    log("")
    log("建议的 unicode-range（应与 retro.css 一致）:")
    log("  " + to_unicode_range(actual))
    out.close()


if __name__ == "__main__":
    main()
