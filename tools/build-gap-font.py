#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从「缝合像素字体 / Fusion Pixel Font」切一份**只补符号缺口**的小字体。

    python tools/build-gap-font.py              # 自动找缓存里的 fusion，没有就下载
    python tools/build-gap-font.py --dry-run    # 只报告，不写文件
    python tools/build-gap-font.py --force      # 忽略缓存，重新下载

为什么要有它
------------
站点的点阵字体是**宋体 12ppem 点阵**提取的，它缺一批符号：
  ⇆（播放器循环） ↻（重播） ©（页脚版权） »（"看全部 »"）
宋体 12px 点阵里**根本没有**这些字形，任何"从宋体提取"的方案都补不出来。
结果是它们静默回退到系统字体 —— 字形对，但边缘不点阵，混在同一行里很明显。

「缝合像素字体」正好填这个洞：它是 12 像素格的泛中日韩点阵字体，
**Arrows 112/112、Latin-1 95/95、Geometric Shapes 96/96** 全覆盖。
（它补不了汉字缺口 —— 汉字那块我们自己更强：基本区 20902 字、扩展A 6582 字，
  fusion 分别是 19219 和 1481。所以这里**只切符号**。）

切哪些
------
不是"只切缺的那几个"（那样写新内容碰到旁边一个符号又缺），而是：
**站点会用到的符号区块里、我们缺的那些码位，整块补齐。**
允许的区块见 ALLOWED_BLOCKS —— 刻意**不含**韩文音节、CJK 扩展B、盲文这些
用不上的大块（全切进去要多 250 KB，而实际上一次都用不到）。

体积：约 40 KB（因为带 unicode-range，不用这些符号的页面根本不会下载）。

许可证
------
Fusion Pixel Font 采用 SIL Open Font License 1.1（见 dist 里的 OFL.txt）。
OFL 要求：分发时要带上许可证、且**不能把保留字体名（Reserved Font Name）用在自己改的版本上**。
所以这里：
  · 子集后的 family 名改成 `FusionPixelGap`（**不是** `Fusion Pixel 12px Proportional zh_hans`），
    避免占用它的保留名；
  · 把 OFL.txt 一并复制到 static/fonts/ 下随站点分发。
"""
import argparse
import io
import json
import os
import shutil
import sys
import urllib.request
import zipfile

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "static", "fonts")
DATA_TOML = os.path.join(ROOT, "data", "pixel-gap-font.toml")
CACHE = os.path.join(ROOT, ".editor", "trash", "fusion-pixel")

# 站点自己的字体：它们的覆盖范围**不能动**
OUR_FONTS = ["simsun12-pixel", "msgothic12-jp-pixel", "mona12emoji"]

VERSION = "2026.09.25"
ASSET = "fusion-pixel-font-12px-proportional-ttf.woff2-v%s.zip" % VERSION
URL = ("https://github.com/TakWolf/fusion-pixel-font/releases/download/%s/%s"
       % (VERSION, ASSET))
# 简体中文版（标点与汉字字形按《通用规范汉字表》）
MEMBER = "fusion-pixel-12px-proportional-zh_hans.ttf.woff2"

OUT_NAME = "fusion-gap-symbols.woff2"
OUT_FAMILY = "FusionPixelGap"


# 允许补的区块：(名称, 起, 止)
# 刻意不含：韩文音节 U+AC00-D7AF、CJK 扩展 B U+20000+、盲文 U+2800-28FF、
# 制表符/方块元素（站点不用画表格）、CJK 兼容区。
ALLOWED_BLOCKS = [
    ("Latin-1 补充（© ® ° ± ¼ ½ …）", 0x00A0, 0x00FF),
    ("Latin 扩展-A", 0x0100, 0x017F),
    ("通用标点（– — ‘ ’ “ ” † ‰ …）", 0x2000, 0x206F),
    ("上下标（¹ ₂ ⁿ）", 0x2070, 0x209F),
    ("货币符号（€ ₩ ₽）", 0x20A0, 0x20CF),
    ("字母式符号（™ Ω №）", 0x2100, 0x214F),
    ("数字形式（⅓ ① ⅰ）", 0x2150, 0x218F),
    ("箭头（← ↑ → ↓ ⇆ ↻ ↔）", 0x2190, 0x21FF),
    ("数学运算符（≤ ≥ ≠ ∞ ∑ √）", 0x2200, 0x22FF),
    ("杂项技术符号（⌘ ⌚ ⏰）", 0x2300, 0x23FF),
    ("带圈字母数字（① Ⓐ ㊀）", 0x2460, 0x24FF),
    ("几何图形（■ ● ▲ ◆ ○）", 0x25A0, 0x25FF),
    ("杂项符号（★ ☆ ♪ ♡ ☀ ☂ ☎）", 0x2600, 0x26FF),
    ("装饰符号（✂ ✈ ✎ ✓ ✗）", 0x2700, 0x27BF),
    ("CJK 符号与标点（、。〈〉【】〜）", 0x3000, 0x303F),
]


def log(*a):
    print(*a)
    sys.stdout.flush()


def ensure_fusion(force=False):
    """把 fusion 的 12px zh_hans 拿本地来（缓存到 .editor/trash/，不进仓库）。"""
    os.makedirs(CACHE, exist_ok=True)
    font = os.path.join(CACHE, MEMBER)
    ofl = os.path.join(CACHE, "OFL.txt")
    if force or not os.path.exists(font):
        log("下载 %s" % ASSET)
        zpath = os.path.join(CACHE, ASSET)
        req = urllib.request.Request(URL, headers={"User-Agent": "build-gap-font"})
        with urllib.request.urlopen(req, timeout=600) as r, open(zpath, "wb") as fh:
            shutil.copyfileobj(r, fh)
        log("  已下载 %.1f MB" % (os.path.getsize(zpath) / 1048576.0))
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                base = os.path.basename(name)
                if base == MEMBER:
                    with z.open(name) as src, open(font, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                elif base == "OFL.txt" and not os.path.exists(ofl):
                    with z.open(name) as src, open(ofl, "wb") as dst:
                        shutil.copyfileobj(src, dst)
        os.remove(zpath)
    if not os.path.exists(font):
        raise SystemExit("解压后没找到 %s" % MEMBER)
    return font, ofl


def _parse_css_unicode_range(css_text):
    """从 CSS 文本里取出 font-family -> 该字体声明的 unicode-range 集合。
    只做粗解析：找 @font-face 块，取 font-family 和 unicode-range。"""
    import re
    out = {}
    for block in re.findall(r"@font-face\s*\{([^}]*)\}", css_text, re.S):
        fam = re.search(r"font-family:\s*'([^']+)'", block) or re.search(r'font-family:\s*"([^"]+)"', block)
        rng = re.search(r"unicode-range:\s*([^;]+);", block, re.S)
        if not fam or not rng:
            continue
        cps = set()
        for part in rng.group(1).split(","):
            m = re.match(r"^\s*U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?\s*$", part)
            if not m:
                continue
            lo = int(m.group(1), 16)
            hi = int(m.group(2), 16) if m.group(2) else lo
            cps.update(range(lo, hi + 1))
        out.setdefault(fam.group(1), set()).update(cps)
    return out


def our_coverage():
    """站点现有所有点阵字体的**真实**覆盖 —— 这些不能被 gap 字体抢走。

    ⚠️ 不能只用字体文件的 cmap，也不能只用 CSS 里声明的 unicode-range：
       两者取**交集**才是浏览器真正能渲染的范围。
       为什么：CSS 里的 unicode-range 会**盖得比字体实际字形宽**。
       实测 Mona12Emoji 的 range 写着 U+24C2, U+25AA-25AB, … U+260E-2653 …，
       但它的 cmap 里**没有 U+00A9（©）也没有 U+2699（⚙）**。
       只看 range 就会以为「© 已经被覆盖了」，于是不补它，
       结果浏览器在 Mona 里找不到字形、继续往后回退 —— 最终还是系统字体。
       （2026-10-11 踩过：© ⚙ 就是这么漏掉的。）
    """
    # ① 把 CSS 渲染出来（里面有 Hugo 模板），拿到声明的 range
    css_path = os.path.join(ROOT, "assets", "css", "retro.css")
    css = ""
    if os.path.exists(css_path):
        css = io.open(css_path, encoding="utf-8").read()
    declared = _parse_css_unicode_range(css)

    cps = set()
    for fn in os.listdir(FONT_DIR):
        if not fn.endswith(".woff2"):
            continue
        if not any(fn.startswith(p) for p in OUR_FONTS):
            continue
        f = TTFont(os.path.join(FONT_DIR, fn))
        actual = set(f.getBestCmap().keys())
        # 找到这份文件在 CSS 里对应的 family 名（按文件名猜；找不到就只看 cmap）
        rng = None
        for fam, s in declared.items():
            key = fam.lower().replace("12", "").replace("pixel", "").replace("jppixel", "")
            if ("simsun" in key and fn.startswith("simsun")) or \
               ("msgothic" in key and fn.startswith("msgothic")) or \
               ("mona" in key and fn.startswith("mona")):
                rng = s
                break
        if rng is None:
            cps |= actual
        else:
            cps |= (actual & rng)
    return cps


def build_gap_list(fusion_path):
    ours = our_coverage()
    f = TTFont(fusion_path)
    fcm = f.getBestCmap()
    log("站点现有字体覆盖 %d 个码位" % len(ours))
    log("fusion 覆盖 %d 个码位" % len(fcm))

    picked = []
    per_block = []
    for name, lo, hi in ALLOWED_BLOCKS:
        cps = sorted(cp for cp in range(lo, hi + 1) if cp in fcm and cp not in ours)
        per_block.append((name, lo, hi, len(cps)))
        picked += cps
    picked = sorted(set(picked))
    log("")
    log("%-44s %6s %6s" % ("区块", "区间", "补几个"))
    for name, lo, hi, n in per_block:
        log("%-44s %6d %6d" % (name, hi - lo + 1, n))
    log("")
    log("合计要补 %d 个码位" % len(picked))
    return picked


def to_unicode_range(cps):
    """码位列表 → 紧凑的 CSS unicode-range（相邻合并）"""
    cps = sorted(set(cps))
    parts = []
    start = prev = None
    for cp in cps:
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
        if a == b:
            out.append("U+%04X" % a)
        elif b == a + 1:
            out.append("U+%04X" % a)
            out.append("U+%04X" % b)
        else:
            out.append("U+%04X-%04X" % (a, b))
    return ", ".join(out)


def main():
    ap = argparse.ArgumentParser(description="从 Fusion Pixel Font 切一份只补符号缺口的小字体")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="忽略缓存，重新下载")
    args = ap.parse_args()

    fusion_path, ofl = ensure_fusion(args.force)
    cps = build_gap_list(fusion_path)
    if not cps:
        log("没有缺口，不需要字体。")
        return

    f = TTFont(fusion_path)
    upem = f["head"].unitsPerEm
    log("")
    log("fusion 度量: unitsPerEm=%d  一格=%.0f 单位  hhea=%d/%d"
        % (upem, upem / 12.0, f["hhea"].ascent, f["hhea"].descent))

    if args.dry_run:
        log("（dry-run，不写文件）")
        return

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.drop_tables = []
    opts.layout_features = []
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.recalc_bounds = False
    opts.glyph_names = False
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=cps)
    sub.subset(f)

    # 改 family 名：OFL 的保留字体名不能占用（我们这是"改过的版本"）
    if "name" in f:
        for rec in f["name"].names:
            try:
                s = rec.toUnicode()
            except Exception:
                continue
            if not s:
                continue
            low = s.lower()
            if "fusion" in low or "缝合" in s:
                rec.string = OUT_FAMILY
    f.flavor = "woff2"
    out = os.path.join(FONT_DIR, OUT_NAME)
    if os.path.exists(out):
        os.remove(out)
    f.save(out)
    size = os.path.getsize(out)
    log("")
    log("已写入 %s：%d 个码位，%.1f KB" % (OUT_NAME, len(cps), size / 1024.0))

    # hhea 度量按宋体对齐，避免混排时基线不齐
    g = TTFont(out)
    log("  子集后 unitsPerEm=%d  一格=%.0f  hhea=%d/%d"
        % (g["head"].unitsPerEm, g["head"].unitsPerEm / 12.0,
           g["hhea"].ascent, g["hhea"].descent))

    # 许可文件随站点分发
    if ofl and os.path.exists(ofl):
        dst = os.path.join(FONT_DIR, "fusion-pixel-OFL.txt")
        shutil.copyfile(ofl, dst)
        log("  许可证已复制到 static/fonts/fusion-pixel-OFL.txt")

    # 块定义给 retro.css 用
    rng = to_unicode_range(cps)
    with open(DATA_TOML, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# ============================================================\n")
        fh.write("#  符号缺口字体 —— 由 tools/build-gap-font.py 生成，别手改\n")
        fh.write("#\n")
        fh.write("#  为什么需要：宋体 12px 点阵缺 ⇆ ↻ © » 这些符号，\n")
        fh.write("#  它们会回退到系统字体、边缘不点阵。这份字体只补那些缺口。\n")
        fh.write("#\n")
        fh.write("#  字体来源：缝合像素字体 / Fusion Pixel Font %s\n" % VERSION)
        fh.write("#    https://github.com/TakWolf/fusion-pixel-font\n")
        fh.write("#    许可 SIL OFL 1.1 —— 见 static/fonts/fusion-pixel-OFL.txt\n")
        fh.write("#    （子集版本的 family 名改成了 %s，不占用它的保留字体名）\n" % OUT_FAMILY)
        fh.write("# ============================================================\n")
        fh.write('family = "%s"\n' % OUT_FAMILY)
        fh.write('file = "%s"\n' % OUT_NAME)
        fh.write("count = %d\n" % len(cps))
        fh.write("sizeKb = %.1f\n" % (size / 1024.0))
        fh.write('range = "%s"\n' % rng)
    log("  块定义已写入 data/pixel-gap-font.toml（range 共 %d 段）" % (rng.count("U+")))


if __name__ == "__main__":
    main()
