#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从站长重新提取的 TTF 生成站点点阵字体（static/fonts/simsun12-pixel*.woff2）。

和 tools/build-pixel-font.py 的区别
-----------------------------------
旧脚本是从**系统宋体的内嵌点阵表（EBDT/EBLC）**里解析位图、再重建成轮廓。
站长发现那份提取是 AI 做的，字形可能和原字体差得多，于是自己重新提取了一份
merge_simsun.ttf（upem 1200，纯像素轮廓，坐标全在 100 单位的栅格上）。

本脚本以**新那份 TTF 为字形来源**，只做三件事：

  1. 把整份字体归一化到 upem 1536（×1.28）。
     新字体 1200 units/em、每格 100；现用 1536 units/em、每格 128。
     100 × 1.28 = 128 正好整数，所以放大后仍然精确落在像素格上。
     归一化的意义：hhea 变成 1280/-256，和现用字体**完全一致** ——
     retro.css 里那份 @font-face 没有 ascent-override，行高直接吃 hhea，
     这样换字体不会让全站行高、基线位置发生变化。

  2. 把旧字体里**新字体缺的码位**补进来（主要是 CJK 扩展A 的 6582 个字）。
     新提取只覆盖了 U+4E00-9FFF 基本区（20902 个，和旧字体一模一样），
     扩展A 一个都没有。旧字体这两块在 simsun12-pixel-2/-3 里，
     upem 同样是 1536，所以**坐标不用缩放，直接搬**。

  3. 按原来的方案分块：常用块（站点用到的字 + ASCII，会 preload）+ 其余均分，
     每块一个 woff2，靠 unicode-range 分流，块定义写进 data/pixel-font.toml。

用法
----
    python tools/build-pixel-font-from-ttf.py                 # 写到 static/fonts/
    python tools/build-pixel-font-from-ttf.py --stage <目录>  # 先写到别处审查
    python tools/build-pixel-font-from-ttf.py --dry-run       # 只报告

⚠️ 跑之前先备份 static/fonts/simsun12-pixel*.woff2 和 data/pixel-font.toml。
⚠️ 跑完要删掉浏览器缓存（Ctrl+F5），字体是按 URL 缓存的。
"""

import argparse
import copy
import importlib.util
import os
import sys

from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem
from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "static", "fonts")
DATA_TOML = os.path.join(ROOT, "data", "pixel-font.toml")

SRC_TTF = r"D:\DSHFiles\out\merge_simsun.ttf"

# 新字体（站长提取）的 upem。**不改它** —— 直接沿用新字体自己的栅格，
# 只把旧字体里缺的那批字（主要是 CJK 扩展A）缩放过来。
#   新字体 1200 units/em -> 每格 100
#   旧字体 1536 units/em -> 每格 128
#   128 × (1200/1536) = 128 × 0.78125 = 100 精确整数
# 实测 38572 个点缩放后 0 个偏离栅格（见 _verify_scale_exact.py）
# 之所以不反过来把新字体放大到 1536：那份字形是站长重新提取、更可信的一份，
# 一个坐标都不动最安全。
KEEP_UPEM = 1200
OLD_UPEM = 1536
MAIN_NAME = "simsun12-pixel.woff2"
CHUNK_PREFIX = "simsun12-pixel-"

# 扩展A 的固定来源（由 tools/sources 随仓库走，保证重建可复现）
EXTA_SOURCE = os.path.join(ROOT, "tools", "sources", "simsun12-exta-1536.woff2")


def load_legacy_tools():
    """复用 build-pixel-font.py 里的 site_chars / gb2312_chars / to_unicode_range。"""
    p = os.path.join(ROOT, "tools", "build-pixel-font.py")
    spec = importlib.util.spec_from_file_location("bpf", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bpf = load_legacy_tools()
site_chars = bpf.site_chars
gb2312_chars = bpf.gb2312_chars
to_unicode_range = bpf.to_unicode_range
ASCII = bpf.ASCII


def load_source():
    """读新字体（站长重新提取的那份）。**不做任何缩放**。"""
    f = TTFont(SRC_TTF)
    upem = f["head"].unitsPerEm
    print("源字体：%s" % SRC_TTF)
    print("  upem=%d  字形=%d  码位=%d  hhea=%d/%d"
          % (upem, f["maxp"].numGlyphs, len(f.getBestCmap()),
             f["hhea"].ascent, f["hhea"].descent))
    if upem != KEEP_UPEM:
        sys.exit("⚠️ 新字体 upem=%d，和脚本假设的 %d 不一致 —— 先确认是不是换了一份字体"
                 % (upem, KEEP_UPEM))
    return f


def harvest_missing(full, base_cps):
    """把「新字体没有、但站点字体原先有」的码位补进来（主要是 CJK 扩展A 6582 字）。

    来源是**固定的构建输入** tools/sources/simsun12-exta-1536.woff2，不是 static/fonts/。
    ⚠️ 为什么不能用 static/fonts/：本脚本的产物就写回 static/fonts/，
       第二次运行时那里的文件已经变成「合并后的新字体」（upem=1200），
       再去读就报 upem 不符、直接跳过 —— 扩展A 会**静默丢失**（实测踩过）。

    那份源文件 upem=1536、每格 128；新字体 1200、每格 100。
    128 × (1200/1536) = 128 × 0.78125 = 100 精确整数，
    实测 38572 个点缩放后 0 个偏离栅格（见 _verify_scale_exact.py）。
    """
    added = 0
    if not os.path.exists(EXTA_SOURCE):
        print("  ⚠️ 缺少 %s —— 扩展A 不会补进来" % EXTA_SOURCE)
        return 0

    order = full.getGlyphOrder()
    hmtx = full["hmtx"].metrics
    glyf = full["glyf"]
    cmaps = [t for t in full["cmap"].tables if t.isUnicode()]
    taken = set(base_cps)

    src = TTFont(EXTA_SOURCE)
    if src["head"].unitsPerEm != OLD_UPEM:
        print("  ⚠️ %s upem=%d 不是 %d" % (EXTA_SOURCE, src["head"].unitsPerEm, OLD_UPEM))
        src.close()
        return 0
    # 缩放到新字体的栅格
    scale_upem(src, KEEP_UPEM)
    scmap = src.getBestCmap()
    sglyf = src["glyf"]
    shmtx = src["hmtx"].metrics
    for cp, gname in sorted(scmap.items()):
        if cp in taken:
            continue
        if gname not in sglyf:
            continue
        newname = "ext_%04X" % cp
        while newname in hmtx:
            newname += "_"
        order.append(newname)
        glyf[newname] = copy.deepcopy(sglyf[gname])
        hmtx[newname] = shmtx[gname]
        for t in cmaps:
            t.cmap[cp] = newname
        taken.add(cp)
        added += 1
    print("  从 %s 补入 %d 个字形"
          % (os.path.basename(EXTA_SOURCE), added))
    src.close()

    full.setGlyphOrder(order)
    full["maxp"].numGlyphs = len(order)
    return added


def write_chunk(full, cps, path):
    """切一块出来存 woff2，返回 (字节数, 实际覆盖码位)。"""
    f = copy.deepcopy(full)
    options = subset.Options()
    options.flavor = "woff2"
    options.drop_tables = []
    options.layout_features = []
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.recalc_bounds = False
    options.glyph_names = False
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=cps)
    sub.subset(f)
    f.flavor = "woff2"
    f.save(path)
    actual = set(TTFont(path).getBestCmap().keys())
    return os.path.getsize(path), actual


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunks", type=int, default=4, help="除常用块外再切几块（默认 4）")
    ap.add_argument("--stage", default=None, help="先写到这个目录（审查用）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    out_dir = args.stage or FONT_DIR
    if not args.dry_run:
        os.makedirs(out_dir, exist_ok=True)

    full = load_source()
    src_cps = set(full.getBestCmap().keys())
    print("源码位：%d" % len(src_cps))

    print("\n补旧字体里有、新字体缺的码位：")
    added = harvest_missing(full, src_cps) if not args.dry_run else 0
    if args.dry_run:
        # dry-run 只统计，不真搬
        missing = set()
        for fn in sorted(os.listdir(FONT_DIR)):
            if fn.startswith(CHUNK_PREFIX) and fn.endswith(".woff2"):
                p = os.path.join(FONT_DIR, fn)
                f = TTFont(p, lazy=True)
                missing |= (set(f.getBestCmap()) - src_cps)
                f.close()
        print("  预计补 %d 个码位" % len(missing))
    print("  合计新增 %d 个字形，现在共 %d 字形 / %d 码位"
          % (added, full["maxp"].numGlyphs, len(full.getBestCmap())))

    # 覆盖检查
    site = {ord(c) for c in site_chars()}
    cmap_now = set(full.getBestCmap().keys())
    still = sorted(site - cmap_now)
    print("\n站点用到的字 %d 个，仍未覆盖 %d 个：%s"
          % (len(site), len(still), "".join(chr(c) for c in still) or "无"))

    if args.dry_run:
        print("\n（dry-run，不写文件）")
        return

    # ---- 分块：常用块 = 站点字 ∪ ASCII；其余均分
    common = (site & cmap_now) | ASCII
    common &= cmap_now
    rest = sorted(cmap_now - common)
    print("\n常用块 %d 字，其余 %d 字，分 %d 块"
          % (len(common), len(rest), args.chunks))

    size, actual = write_chunk(full, sorted(common), os.path.join(out_dir, MAIN_NAME))
    print("  块1 %-28s %6.1f KB  %d 字" % (MAIN_NAME, size / 1024.0, len(actual)))
    files = []
    ranges = []
    n = max(1, args.chunks)
    per = (len(rest) + n - 1) // n
    for i in range(n):
        cps = rest[i * per:(i + 1) * per]
        if not cps:
            continue
        name = "%s%d.woff2" % (CHUNK_PREFIX, i + 2)
        size, actual2 = write_chunk(full, cps, os.path.join(out_dir, name))
        files.append(name)
        ranges.append(to_unicode_range(sorted(actual2)))
        print("  块%d %-28s %6.1f KB  %d 字  U+%X 起"
              % (i + 2, name, size / 1024.0, len(actual2), min(actual2)))

    # ---- 块定义
    if args.stage:
        toml_path = os.path.join(out_dir, "pixel-font.toml")
    else:
        toml_path = DATA_TOML
    with open(toml_path, "w", encoding="utf-8") as fh:
        fh.write("# ============================================================\n")
        fh.write("#  点阵字体的分块定义 —— 由 tools/build-pixel-font-from-ttf.py 生成\n")
        fh.write("#\n")
        fh.write("#  字形来源：站长重新提取的 merge_simsun.ttf（归一化到 upem 1536），\n")
        fh.write("#  扩展A 由旧字体补入。每块一个 woff2，靠 unicode-range 分流。\n")
        fh.write("# ============================================================\n")
        fh.write('[[files]]\n  name = "%s"\n  range = "%s"\n\n'
                 % (MAIN_NAME, to_unicode_range(sorted(actual))))
        for name, rng in zip(files, ranges):
            fh.write('[[files]]\n  name = "%s"\n  range = "%s"\n\n' % (name, rng))
    print("\n块定义: %s（共 %d 块）" % (toml_path, 1 + len(files)))
    print("输出目录: %s" % out_dir)


if __name__ == "__main__":
    main()
