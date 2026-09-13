#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从系统宋体的 12ppem 内嵌点阵生成点阵字体（static/fonts/simsun12-pixel*.woff2）。

为什么要有这个脚本
------------------
站点正文用的是点阵字体。某个字不在字体里时，浏览器会**静默地**掉到字体栈末尾
的系统宋体上 —— 字号一样，但那是抗锯齿的轮廓，一眼看上去发虚。
2026-09-13 就是这么发现「勇 / 恢」两个字的：当时的字体只收了 2339 个字，
是当初手挑的子集，写新内容很容易漏。

现在默认**全量提取**：系统宋体 12ppem 那档点阵里有 28421 个字形，全都做进来，
以后写什么字都不会再掉。全量约 690 KB，一个文件太大的话，就按下面这样分块。

分块（默认开启）
----------------
每块都是一个独立的 woff2，共用同一个 font-family，靠 CSS `unicode-range` 分流：
浏览器只会下载**页面上真正用到的字所在的那几块**。

    块 1  simsun12-pixel.woff2        站点现在用到的字 + 原先字体里的字（~60 KB，会 preload）
    块 2+ simsun12-pixel-2..N.woff2   其余的字，按码位均分（各 ~160 KB，用到才下）

所以平时访问只花 60 KB；哪天日记里写了个生僻字，浏览器才去下那一块。
块定义写在 data/pixel-font.toml 里，retro.css 会照着生成 @font-face。

用法
----
    python tools/build-pixel-font.py                 # 全量 + 分块（推荐）
    python tools/build-pixel-font.py --chunks 1      # 全量，但只出一个文件（690 KB）
    python tools/build-pixel-font.py --set site      # 只做站点用到的字（最小，~60 KB）
    python tools/build-pixel-font.py --dry-run       # 只报告，不写文件

依赖：fontTools（要带 brotli）、Pillow  →  pip install fonttools brotli pillow

原理
----
宋体的点阵存在 EBDT/EBLC 两张表里。脚本直接按 imageFormat 1 的格式解出 12x12
的位图（① smallGlyphMetrics 5 字节：高、宽、左边距、上边距、步进；② 每行按
字节对齐的 1bpp 位图），再把每行连续的黑格转成一个正方形轮廓。每格 = 128 单位，
upem 1536 = 12 格，所以字形全是直角、坐标全在格点上，缩放永远是整倍 ——
这正是点阵字体锐利的前提。

日文（假名）不归这份字体管：假名由 msgothic12-jp-pixel.woff2 用 unicode-range
路由过去（见 assets/css/retro.css），这个脚本不碰它。
"""
import argparse
import os
import sys

from fontTools.ttLib import TTFont, TTCollection
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "static", "fonts")
MAIN_WOFF = os.path.join(FONT_DIR, "simsun12-pixel.woff2")
DATA_TOML = os.path.join(ROOT, "data", "pixel-font.toml")
TTC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "simsun.ttc")
PPEM = 12
UPEM = 1536          # 12 格
PX = UPEM // PPEM    # 每格 128 单位
ASCII = set(range(0x20, 0x7F))


# ---------------------------------------------------------------- 读宋体点阵
def load_simsun_strike(ppem=PPEM):
    """返回 (cmap, {字形名: (起, 止)}, EBDT 原始字节)"""
    if not os.path.exists(TTC):
        sys.exit("找不到系统宋体：%s" % TTC)
    ttc = TTCollection(TTC, lazy=True)
    sim = ttc.fonts[0]
    strikes = [(s.bitmapSizeTable.ppemX, s) for s in sim["EBLC"].strikes]
    strike = next((s for p, s in strikes if p == ppem), None)
    if strike is None:
        sys.exit("宋体里没有 %dppem 点阵（有的档：%s）" % (ppem, [p for p, _ in strikes]))
    raw = sim.reader["EBDT"]
    locs = {}
    for sub in strike.indexSubTables:
        if sub.imageFormat != 1:
            sys.exit("遇到没见过的点阵格式 %s，脚本只处理 format 1" % sub.imageFormat)
        for name, loc in zip(sub.names, sub.locations):
            locs[name] = loc
    return sim.getBestCmap(), locs, raw


def parse_bitmap(raw, off, end):
    """imageFormat 1 → (h, w, bearingX, bearingY, advance, [[0/1,…], …])"""
    b = raw[off:end]
    h, w = b[0], b[1]
    bx = b[2] - 256 if b[2] > 127 else b[2]
    by = b[3] - 256 if b[3] > 127 else b[3]
    adv = b[4]
    row_bytes = (w + 7) // 8
    bits = b[5:5 + row_bytes * h]
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            byte = bits[y * row_bytes + (x >> 3)]
            row.append((byte >> (7 - (x & 7))) & 1)
        rows.append(row)
    return h, w, bx, by, adv, rows


def build_glyph(h, w, bx, by, rows):
    """位图 → 直角轮廓（每行连续黑格 = 一个正方形）"""
    pen = TTGlyphPen(None)
    for y in range(h):
        x = 0
        while x < w:
            if not rows[y][x]:
                x += 1
                continue
            start = x
            while x < w and rows[y][x]:
                x += 1
            x0 = (bx + start) * PX
            x1 = (bx + x) * PX
            y1 = (by - y) * PX
            y0 = y1 - PX
            pen.moveTo((x0, y0))
            pen.lineTo((x1, y0))
            pen.lineTo((x1, y1))
            pen.lineTo((x0, y1))
            pen.closePath()
    return pen.glyph()


def add_glyphs(font, todo, locs, raw):
    order = font.getGlyphOrder()
    used = set(order)
    glyf = font["glyf"]
    added = 0
    for cp, gn in todo:
        off, end = locs[gn]
        h, w, bx, by, adv, rows = parse_bitmap(raw, off, end)
        name = "uni%04X" % cp if cp > 0x7F else chr(cp)
        if name in used:
            name = "uni%04X.1" % cp
        glyf.glyphs[name] = build_glyph(h, w, bx, by, rows)
        font["hmtx"][name] = (adv * PX, bx * PX)
        order.append(name)
        used.add(name)
        for table in font["cmap"].tables:
            if table.isUnicode():
                table.cmap[cp] = name
        added += 1
    font.setGlyphOrder(order)
    font["maxp"].numGlyphs = len(order)
    return added


# ---------------------------------------------------------------- 字符集
def site_chars():
    """站点上会渲染出来的字符：正文 + 数据文件 + 站点配置 + 模板里写死的字"""
    chars = set()
    for sub in ("content", "layouts"):
        base = os.path.join(ROOT, sub)
        for dirpath, _dirs, files in os.walk(base):
            for name in files:
                if name.endswith((".md", ".html", ".xml")):
                    with open(os.path.join(dirpath, name), encoding="utf-8") as fh:
                        chars.update(fh.read())
    data = os.path.join(ROOT, "data")
    if os.path.isdir(data):
        for name in os.listdir(data):
            if name.endswith(".toml"):
                with open(os.path.join(data, name), encoding="utf-8") as fh:
                    chars.update(fh.read())
    cfg = os.path.join(ROOT, "hugo.toml")
    if os.path.exists(cfg):
        with open(cfg, encoding="utf-8") as fh:
            chars.update(fh.read())
    return {c for c in chars if c not in "\r\n\t"}


def gb2312_chars(level=0):
    chars = set()
    ranges = {1: [(0xB0, 0xD7)], 2: [(0xD8, 0xF7)], 0: [(0xB0, 0xD7), (0xD8, 0xF7)]}[level]
    for hi0, hi1 in ranges:
        for hi in range(hi0, hi1 + 1):
            for lo in range(0xA1, 0xFF):
                try:
                    chars.add(bytes([hi, lo]).decode("gb2312"))
                except UnicodeDecodeError:
                    pass
    return chars


def to_unicode_range(codepoints):
    """把码位集合写成 CSS unicode-range（相邻的合并成区间）"""
    parts = []
    start = prev = None
    for cp in sorted(codepoints):
        if start is None:
            start = prev = cp
            continue
        if cp == prev + 1:
            prev = cp
            continue
        parts.append((start, prev))
        start = prev = cp
    if start is not None:
        parts.append((start, prev))
    out = []
    for a, b in parts:
        out.append("U+%X" % a if a == b else "U+%X-%X" % (a, b))
    return ",".join(out)


def write_chunk(full_font, cps, path):
    """从全量字体里切一块出来存成 woff2，返回 (字节数, 这块实际覆盖的码位)"""
    import copy
    f = copy.deepcopy(full_font)
    options = subset.Options()
    options.flavor = "woff2"
    options.drop_tables = []
    options.layout_features = []
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.recalc_bounds = False
    options.glyph_names = False
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=cps)
    subsetter.subset(f)
    f.flavor = "woff2"
    f.save(path)
    # unicode-range 要按「这块真正有的字」写，不能按请求的字写 ——
    # 请求里可能有宋体点阵没有的字，写进去会让浏览器以为这块能渲染它。
    actual = set(TTFont(path).getBestCmap().keys())
    return os.path.getsize(path), actual


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunks", type=int, default=4,
                    help="除常用块外再切几块（默认 4；给 1 表示不分块）")
    ap.add_argument("--set", default="all",
                    choices=["all", "site", "gb2312", "gb2312-1", "site+gb2312"],
                    help="覆盖哪些字，默认 all（宋体 12ppem 点阵里的全部）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base = TTFont(MAIN_WOFF)
    if base["head"].unitsPerEm != UPEM:
        sys.exit("现有字体 upem=%d，和脚本假设的 %d 不一致" % (base["head"].unitsPerEm, UPEM))
    base_cps = set(base.getBestCmap().keys())
    print("现有字体：字形 %d，覆盖 %d 字" % (base["maxp"].numGlyphs, len(base_cps)))

    sim_cmap, locs, raw = load_simsun_strike()
    print("系统宋体 %dppem 点阵：%d 个字形带点阵" % (PPEM, len(locs)))

    available = {cp for cp in sim_cmap if sim_cmap[cp] in locs}
    if args.set == "all":
        want = set(available)
    elif args.set == "site":
        want = {ord(c) for c in site_chars()}
    elif args.set == "gb2312":
        want = {ord(c) for c in gb2312_chars(0)}
    elif args.set == "gb2312-1":
        want = {ord(c) for c in gb2312_chars(1)}
    else:
        want = {ord(c) for c in site_chars()} | {ord(c) for c in gb2312_chars(0)}

    # 常用块 = 站点现在的字 ∪ 原字体已有的字 ∪ ASCII（模板里的数字和标点）
    common = ({ord(c) for c in site_chars()} | base_cps | ASCII) & available
    # 其余的字（要全量的话）
    rest = (want - common) & available
    # 站点文本里连宋体点阵都没有的字（只能靠别的字体兜底）
    uncovered = sorted({ord(c) for c in site_chars()} - available - base_cps)

    print("常用块：%d 字；其余：%d 字；宋体点阵里都没有、补不了的：%d 个 %s"
          % (len(common), len(rest), len(uncovered), "".join(chr(c) for c in uncovered)))
    if args.dry_run:
        print("（dry-run，不写文件）")
        return

    # ---- 1) 单文件：全量都塞进 simsun12-pixel.woff2
    if args.chunks <= 1 or not rest:
        todo = sorted((cp, sim_cmap[cp]) for cp in (common | rest)
                      if cp not in base_cps and cp in available)
        total = add_glyphs(base, todo, locs, raw)
        base.flavor = "woff2"
        base.save(MAIN_WOFF)
        # 上一次跑过分块的话，把多余的块和定义文件清掉
        for fn in os.listdir(FONT_DIR):
            if fn.startswith("simsun12-pixel-") and fn.endswith(".woff2"):
                os.remove(os.path.join(FONT_DIR, fn))
                print("  删掉多余的分块 %s" % fn)
        if os.path.exists(DATA_TOML):
            os.remove(DATA_TOML)
            print("  删掉分块定义 %s" % DATA_TOML)
        print("已写入 %s：新增 %d 字形，共 %d 个，%.1f KB"
              % (MAIN_WOFF, total, base["maxp"].numGlyphs,
                 os.path.getsize(MAIN_WOFF) / 1024.0))
        still = sorted({ord(c) for c in site_chars()} - set(base.getBestCmap().keys()))
        print("站点文本里仍未覆盖的字（共 %d 个）：%s"
              % (len(still), "".join(chr(c) for c in still)))
        return

    todo = sorted((cp, sim_cmap[cp]) for cp in (common | rest)
                  if cp not in base_cps and cp in available)
    add_glyphs(base, todo, locs, raw)
    print("全量字体：%d 字形" % base["maxp"].numGlyphs)

    # ---- 2) 常用块写回原文件名（preload 的就是它）
    size = write_chunk(base, common, MAIN_WOFF)
    print("  块1 %-28s %6.1f KB  %d 字" % (os.path.basename(MAIN_WOFF), size / 1024.0, len(common)))

    # ---- 3) 其余按码位均分
    rest_sorted = sorted(rest)
    n = args.chunks
    per = (len(rest_sorted) + n - 1) // n
    files = []
    ranges = []
    for i in range(n):
        cps = rest_sorted[i * per:(i + 1) * per]
        if not cps:
            continue
        name = "simsun12-pixel-%d.woff2" % (i + 2)
        size = write_chunk(base, cps, os.path.join(FONT_DIR, name))
        files.append(name)
        ranges.append(to_unicode_range(cps))
        print("  块%d %-28s %6.1f KB  %d 字  U+%X 起"
              % (i + 2, name, size / 1024.0, len(cps), cps[0]))

    # 清掉上一轮多出来的块
    keep = {os.path.basename(MAIN_WOFF)} | set(files)
    for fn in os.listdir(FONT_DIR):
        if fn.startswith("simsun12-pixel-") and fn.endswith(".woff2") and fn not in keep:
            os.remove(os.path.join(FONT_DIR, fn))
            print("  删掉多余的块 %s" % fn)

    # ---- 4) 块定义给 retro.css 用
    with open(DATA_TOML, "w", encoding="utf-8") as fh:
        fh.write("# ============================================================\n")
        fh.write("#  点阵字体的分块定义 —— 由 tools/build-pixel-font.py 生成，别手改\n")
        fh.write("#\n")
        fh.write("#  每块都是一个 woff2，共用同一个 font-family，靠下面的 unicode-range 分流：\n")
        fh.write("#  浏览器只会下载「页面上出现的字」所在的那几块，所以平时只花第一块的体积。\n")
        fh.write("#  第一块是站点现在用到的字，head.html 里 preload 的也是它。\n")
        fh.write("# ============================================================\n")
        fh.write('[[files]]\n  name = "%s"\n  range = "%s"\n\n'
                 % (os.path.basename(MAIN_WOFF), to_unicode_range(common)))
        for name, rng in zip(files, ranges):
            fh.write('[[files]]\n  name = "%s"\n  range = "%s"\n\n' % (name, rng))
    print("块定义已写入 %s（共 %d 块）" % (DATA_TOML, 1 + len(files)))


if __name__ == "__main__":
    main()
