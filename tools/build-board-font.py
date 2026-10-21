#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为「布告栏」页面切两份专用的「缝合像素字体 / Fusion Pixel Font」子集。

    python tools/build-board-font.py              # 用缓存；没有就下载
    python tools/build-board-font.py --dry-run    # 只报告，不写文件
    python tools/build-board-font.py --force      # 忽略缓存，重新下载

为什么要有它
------------
布告栏要「写得下任意中文便签」：正文里出现什么字，排版就得撑得住。
站点主字体是宋体 12ppem 点阵（static/fonts/simsun12-pixel*.woff2），
但布告栏还需要一个**独立的、尺寸可控的**点阵字体：12px 给正文、
10px 给便签列表里的密排小字。缝合像素字体正好两种尺寸都有。

所以这里不是「补缺口」，是**整份可用字集**：ASCII + GB2312 全集 + 中文标点全角
+ 假名。体积靠 unicode-range 摊掉 —— 不用这些字的页面根本不会下载。

与 tools/build-gap-font.py 的关系
--------------------------------
做法照它来：同样的 release、同样的 subset 选项、同样**改 family 名避开 OFL 保留名**。
区别只有三点：
  · 字符集是整块（GB2312 全集），不是「站点现有字体缺的那些」；
  · 一次出两份字号（12px / 10px proportional zh_hans）；
  · 许可证**不再重复拷贝** —— build-gap-font.py 已经把 OFL.txt 放在
    static/fonts/fusion-pixel-OFL.txt 随站点分发了，这里只检查它在不在。

两份字号的码位不完全相同
------------------------
请求的字符集是同一套（见 CHARSET_SPEC），但**源字体自己的覆盖不同**：
10px proportional 的汉字源比 12px 少，GB2312 里缺 851 字（12px 缺 143 字）。
缺的码位直接跳过（不报错），所以两份产物的 count / unicode-range 不一样 ——
这是源的现实，不是脚本的取舍；缺的字由后面的回退字体（宋体点阵）接住。

许可证
------
Fusion Pixel Font 采用 SIL Open Font License 1.1。
OFL 要求：分发时带许可证，且**不能把保留字体名用在自己改的版本上**。
所以子集后的 family 名改成 FusionPixelBoard12 / FusionPixelBoard10
（**不是** 'Fusion Pixel 12px Prop zh-Hans'）。
"""
import argparse
import importlib.util
import io
import os
import shutil
import sys
import urllib.request
import zipfile

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "static", "fonts")
DATA_TOML = os.path.join(ROOT, "data", "pixel-board-font.toml")


def _load_site_chars():
    """复用 build-pixel-font.py 的 site_chars()：扫 content/data/layouts/
       static/js/assets/css，收集站点真正会显示的字。"""
    p = os.path.join(ROOT, "tools", "build-pixel-font.py")
    spec = importlib.util.spec_from_file_location("bpf", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.site_chars


site_chars = _load_site_chars()

# 下载缓存：放在 .editor/trash/ 下（.gitignore 已忽略，不进仓库）
CACHE = os.path.join(ROOT, ".editor", "trash", "board-font")
# build-gap-font.py 的缓存目录 —— 里面可能已经有 12px 那份，先看这里
LEGACY_CACHE = os.path.join(ROOT, ".editor", "trash", "fusion-pixel")

# 已在随站点分发的许可证（build-gap-font.py 放的），本脚本只检查、不再拷一份
OFL_SITE = os.path.join(FONT_DIR, "fusion-pixel-OFL.txt")

VERSION = "2026.09.25"
BASE_URL = ("https://github.com/TakWolf/fusion-pixel-font/releases/download/%s/"
            % VERSION)

# 两份字号。asset / member 都对着 release 资产列表核过（2026.09.25 的
# fusion-pixel-font-{12,10}px-proportional-ttf.woff2-v2026.09.25.zip）。
TARGETS = [
    {
        "px": 12,
        "asset": "fusion-pixel-font-12px-proportional-ttf.woff2-v%s.zip" % VERSION,
        "member": "fusion-pixel-12px-proportional-zh_hans.ttf.woff2",
        "out": "fusion-board-12.woff2",
        "family": "FusionPixelBoard12",
    },
    {
        "px": 10,
        "asset": "fusion-pixel-font-10px-proportional-ttf.woff2-v%s.zip" % VERSION,
        "member": "fusion-pixel-10px-proportional-zh_hans.ttf.woff2",
        "out": "fusion-board-10.woff2",
        "family": "FusionPixelBoard10",
    },
]

# 布告栏界面里一定会出现的字 —— 验证时逐个查，缺了就报出来
BOARD_UI_TEXT = "布告栏 写下便签 匿名 回复 删除 条"


def board_used_chars():
    """布告栏页面 + 首页便签墙预览**真正会显示**的字。

    为什么要单独算这个：以前把整份 GB2312 都塞进一个文件（224 KB / 179 KB），
    而首页有便签墙预览 —— 每次访问都要把这两份整块下下来，字体负载 403 KB，
    占首页字体总量的 73%。实测（_net_breakdown.js）：
        fusion-board-12  224.5 KB
        fusion-board-10  179.0 KB
    便签是用户写的、字不可预知，所以后文按码位分块、用到才下；
    但**第一块**要装下「站点现在真的会显示的字」，首页就只需要这一块。

    来源：
      · 界面文案 —— 复用 build-pixel-font.py 的 site_chars()（扫 content/data/
        layouts/static/js/assets/css），board.js 里的提示语都算在内
      · 本地便签数据 —— static/board/notes.json（后端不通时的兜底那份）
    """
    cps = {ord(c) for c in site_chars()}
    notes = os.path.join(ROOT, "static", "board", "notes.json")
    if os.path.exists(notes):
        import json
        try:
            d = json.load(io.open(notes, encoding="utf-8"))
            arr = d.get("notes", []) if isinstance(d, dict) else d
            for n in arr:
                for k in ("body", "name"):
                    cps.update(ord(ch) for ch in str(n.get(k) or ""))
                r = n.get("reply") or {}
                cps.update(ord(ch) for ch in str(r.get("body") or ""))
        except Exception as e:
            log("  ⚠️ 读 notes.json 失败（%s），第一块只按界面文案算" % e)
    return cps


def chunk_specs(picked, used, n):
    """把一份字集分成 [块1(站点用到的字+ASCII), 其余按码位均分 n 块]。
       返回 [(文件名后缀, 码位列表)]。"""
    common = {cp for cp in picked if cp in used}
    common |= {cp for cp in picked if cp < 0x80}      # ASCII 永远进第一块
    common &= picked
    rest = sorted(picked - common)
    specs = [("", sorted(common))]
    per = (len(rest) + n - 1) // n if n > 0 else len(rest)
    for i in range(n):
        part = rest[i * per:(i + 1) * per]
        if part:
            specs.append(("-%d" % (i + 2), part))
    return specs


# 请求的字符集：(说明, 起, 止)，含端点
CHARSET_SPEC = [
    ("ASCII", 0x0020, 0x007E),
    ("通用标点（– — ‘ ’ “ ” ‰ …）", 0x2013, 0x2014),
    ("单双引号", 0x2018, 0x201D),
    ("省略号/两点", 0x2025, 0x2026),
    ("千分号", 0x2030, 0x2030),
    ("欧元", 0x20AC, 0x20AC),
    ("箭头（← ↑ → ↓）", 0x2190, 0x2193),
    ("几何图形（■ □ ● ○ …）", 0x25A0, 0x25CF),
    ("实心/空心星", 0x2605, 0x2606),
    ("平假名/片假名", 0x3040, 0x30FF),
    ("CJK 符号与标点（、。〈〉【】〜）", 0x3000, 0x303F),
    ("全角/半角形式（！？：；（）…）", 0xFF00, 0xFFEF),
]


def log(*a):
    print(*a)
    sys.stdout.flush()


def gb2312_codepoints():
    """GB2312 全集 6763 字。

    用 bytes([0xb0+i, 0xa1+j]) 逐字节枚举，不联网抓字表：
    区 16..87 → 0xB0..0xF7（i 从 0 到 0x47，再往上就超出 bytes 的 0..255），
    位 1..94 → 0xA1..0xFE（j 从 0 到 0x5D）。
    88..94 区是空的，decode 会抛 UnicodeDecodeError —— 直接跳过。
    """
    out = []
    for i in range(0x48):       # 0xB0..0xF7 = 区 16..87
        for j in range(0x5E):   # 0xA1..0xFE = 位 1..94
            try:
                ch = bytes([0xB0 + i, 0xA1 + j]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            out.append(ord(ch))
    return out


def requested_charset():
    """要切的码位（两份字号请求的是同一套）。"""
    cps = set(gb2312_codepoints())
    for _name, lo, hi in CHARSET_SPEC:
        cps.update(range(lo, hi + 1))
    return cps


def ensure_source(target, force=False):
    """把某一份源字体拿到本地（先看缓存，再下载）。返回文件路径。"""
    member = target["member"]
    for d in (CACHE, LEGACY_CACHE):
        p = os.path.join(d, member)
        if os.path.exists(p) and not force:
            log("  缓存命中 %s" % os.path.relpath(p, ROOT))
            return p

    os.makedirs(CACHE, exist_ok=True)
    zpath = os.path.join(CACHE, target["asset"])
    if force or not os.path.exists(zpath):
        log("  下载 %s" % target["asset"])
        req = urllib.request.Request(BASE_URL + target["asset"],
                                     headers={"User-Agent": "build-board-font"})
        tmp = zpath + ".part"
        with urllib.request.urlopen(req, timeout=900) as r, open(tmp, "wb") as fh:
            shutil.copyfileobj(r, fh)
        os.replace(tmp, zpath)
        log("    已下载 %.1f MB" % (os.path.getsize(zpath) / 1048576.0))

    with zipfile.ZipFile(zpath) as z:
        if member not in z.namelist():
            raise SystemExit("%s 里没有成员 %s" % (target["asset"], member))
        with z.open(member) as src, open(os.path.join(CACHE, member), "wb") as dst:
            shutil.copyfileobj(src, dst)
    return os.path.join(CACHE, member)


def to_unicode_range(cps):
    """码位集合 → 紧凑的 CSS unicode-range（相邻合并）"""
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


def coarse_range():
    """另一种做法：粗 range（是精确 range 的超集）。

    GB2312 的 6763 个汉字全部落在 U+4E00-9FA5 里，所以一个区间就盖住了。
    代价：页面里出现这个区间内、但字体其实没有的字时，浏览器也会下载字体，
    下载完发现没字形再往后回退 —— 正确性不受影响，只是白下。
    中文站点的页面基本都有汉字，实际差别很小；range 从 40+ KB 缩到一百多字节。
    """
    spans = sorted([(lo, hi) for _n, lo, hi in CHARSET_SPEC] + [(0x4E00, 0x9FA5)])
    merged = []
    for lo, hi in spans:
        if merged and lo <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return ", ".join("U+%04X-%04X" % (a, b) for a, b in merged)


def rename_family(font, family):
    """改 name 表，避开 OFL 保留字体名。

    照 build-gap-font.py 的做法：凡是字符串里带 fusion / 缝合 的记录，换成新名。
    再做一步规范化 —— 否则 full name(4) / PostScript name(6) 会退化成跟
    family(1) 一模一样的字符串（gap 那份就是这样），有些排版软件会抱怨。
    """
    if "name" not in font:
        return
    for rec in font["name"].names:
        try:
            s = rec.toUnicode()
        except Exception:
            continue
        if not s:
            continue
        low = s.lower()
        if "fusion" in low or "缝合" in s:
            rec.string = family
    for rec in font["name"].names:
        try:
            s = rec.toUnicode()
        except Exception:
            continue
        if s != family and rec.nameID not in (2, 17):
            continue
        if rec.nameID in (1, 16):
            rec.string = family
        elif rec.nameID in (2, 17):
            rec.string = "Regular"
        elif rec.nameID == 3:
            rec.string = "%s;%s-subset" % (family, VERSION)
        elif rec.nameID == 4:
            rec.string = "%s Regular" % family
        elif rec.nameID == 6:
            rec.string = "%s-Regular" % family


def subset_one(src_path, target, cps):
    """切一份，写出来。返回 (输出路径, 实际码位集合, 字节数, 度量)。"""
    font = TTFont(src_path)
    src_cmap = set(font.getBestCmap().keys())
    picked = sorted(cps & src_cmap)

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
    sub.populate(unicodes=picked)
    sub.subset(font)

    rename_family(font, target["family"])

    # TTFont.save() 默认会把 head.modified 刷成"现在"，每次重建字节都不一样、
    # 让 git 里凭空多出改动。关掉它，沿用源字体的时间戳，重建就是逐字节一致的。
    font.recalcTimestamp = False

    font.flavor = "woff2"
    out = os.path.join(FONT_DIR, target["out"])
    if os.path.exists(out):
        os.remove(out)
    font.save(out)

    # 以**产物自己的 cmap** 为准写 range（比拿请求列表写更靠谱）
    g = TTFont(out)
    actual = set(g.getBestCmap().keys())
    metrics = {
        "upem": g["head"].unitsPerEm,
        "hhea": (g["hhea"].ascent, g["hhea"].descent),
    }
    g.close()
    return out, actual, os.path.getsize(out), metrics


def verify(out, expected, target, primary=True):
    """重新打开产物自检：cmap 是否就是期望那套、family 名、（第一块才查）界面字串。

    ⚠️ ASCII 和界面文案**只在第一块**里 —— 后面几块是「其余字按码位均分」，
       本来就不该有它们。早先把这三项对所有块都查，导致每块都报「缺」，
       自检永远失败（构建其实是好的）。所以用 primary 区分。"""
    font = TTFont(out)
    cmap = set(font.getBestCmap().keys())
    fam = font["name"].getDebugName(1)
    ps = font["name"].getDebugName(6)
    font.close()

    ok = True
    extra = cmap - expected
    missing = expected - cmap
    log("  [%s]" % os.path.basename(out))
    log("    字形数（cmap）%d  |  期望 %d  |  多余 %d  缺 %d"
        % (len(cmap), len(expected), len(extra), len(missing)))
    if extra or missing:
        ok = False
        log("    ✗ cmap 与期望不符")

    if not primary:
        fam_ok = (fam == target["family"])
        log("    family = %r  %s（非第一块，不查 ASCII/界面字串）"
            % (fam, "✓" if fam_ok else "✗"))
        ok = ok and fam_ok
        return ok

    ascii_missing = [c for c in range(0x20, 0x7F) if c not in cmap]
    log("    ASCII U+0020-007E: %s" % ("全覆盖 95/95" if not ascii_missing
                                       else "缺 " + " ".join("U+%04X" % c for c in ascii_missing)))
    ok = ok and not ascii_missing

    gb = gb2312_codepoints()
    gb_have = sum(1 for c in gb if c in cmap)
    log("    GB2312（本块内）: %d/%d" % (gb_have, len(gb)))

    ui_missing = [c for c in BOARD_UI_TEXT if ord(c) not in cmap]
    log("    界面字串「%s」: %s" % (BOARD_UI_TEXT,
                                   "全覆盖" if not ui_missing else "缺 " + "".join(ui_missing)))
    ok = ok and not ui_missing

    fam_ok = (fam == target["family"])
    log("    family = %r  (name ID 6 = %r)  %s" % (fam, ps, "✓" if fam_ok else "✗"))
    ok = ok and fam_ok

    log("    字节数 %d" % os.path.getsize(out))
    return ok


def write_toml(results):
    with open(DATA_TOML, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# ============================================================\n")
        fh.write("#  布告栏专用点阵字体 —— 由 tools/build-board-font.py 生成，别手改\n")
        fh.write("#\n")
        fh.write("#  布告栏要写得下任意中文便签，所以字集是整份：\n")
        fh.write("#  ASCII + GB2312 全集 6763 字 + 中文标点/全角 + 假名。\n")
        fh.write("#  12px 给正文，10px 给便签列表的密排小字。\n")
        fh.write("#\n")
        fh.write("#  **分块**：名字不带数字的是「第一块」= 布告栏实际会显示的字\n")
        fh.write("#  （界面文案 + 本地便签数据）+ ASCII；后面 -2/-3/... 是其余字按码位均分。\n")
        fh.write("#  同一个 family 的多个 @font-face 靠 unicode-range 分流，\n")
        fh.write("#  浏览器只下页面上真正用到的字所在的那几块。\n")
        fh.write("#\n")
        fh.write("#  ⚠️ 每块的 unicode-range 必须用**精确版**（= 该块自己的 cmap）。\n")
        fh.write("#     不能用「超集粗 range」：同一 family 里若某块声明了它其实没有的字，\n")
        fh.write("#     浏览器会选中这一块、发现没字形后**直接回退到下一个 family（宋体）**，\n")
        fh.write("#     而不是去试同家族的下一块 —— 那样便签会突然变成宋体。\n")
        fh.write("#\n")
        fh.write("#  字体来源：缝合像素字体 / Fusion Pixel Font %s\n" % VERSION)
        fh.write("#    https://github.com/TakWolf/fusion-pixel-font\n")
        fh.write("#    许可 SIL OFL 1.1 —— 见 static/fonts/fusion-pixel-OFL.txt\n")
        fh.write("#    （子集版本的 family 名改成了 FusionPixelBoard12 / FusionPixelBoard10，\n")
        fh.write("#      不占用它的保留字体名；两份的码位不完全相同，因为源字体覆盖不同 ——\n")
        fh.write("#      10px proportional 的汉字源比 12px 少，缺的码位直接跳过。）\n")
        fh.write("#\n")
        fh.write("#  ⚠️ 键名是 `pixel-board-font`（连字符保留）—— Hugo 不改写带连字符的文件名，\n")
        fh.write("#     模板里要用 index hugo.Data \"pixel-board-font\" 取。\n")
        fh.write("# ============================================================\n")
        for r in results:
            fh.write("\n[[font]]\n")
            fh.write('family = "%s"\n' % r["family"])
            fh.write('file = "%s"\n' % r["file"])
            fh.write("size = %d\n" % r["px"])
            fh.write("count = %d\n" % r["count"])
            fh.write("sizeKb = %.1f\n" % r["sizeKb"])
            fh.write('range = "%s"\n' % r["range"])
            fh.write('rangeCoarse = "%s"\n' % r["range"])


def main():
    ap = argparse.ArgumentParser(description="切「布告栏」专用的 Fusion Pixel Font 子集（12px / 10px）")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    ap.add_argument("--force", action="store_true", help="忽略缓存，重新下载")
    ap.add_argument("--chunks", type=int, default=3,
                    help="每个字号除第一块外再切几块（默认 3）")
    args = ap.parse_args()

    cps = requested_charset()
    log("请求字符集 %d 个码位（ASCII + GB2312 %d 字 + 标点/全角/假名）"
        % (len(cps), len(gb2312_codepoints())))
    for name, lo, hi in CHARSET_SPEC:
        n = sum(1 for c in range(lo, hi + 1) if c in cps)
        log("  %-38s U+%04X-%04X  %4d" % (name, lo, hi, n))

    log("")
    log("准备源字体：")
    used = board_used_chars()
    log("  布告栏会显示的字（界面文案 + 本地便签）：%d 个不同码位" % len(used))
    results = []
    for target in TARGETS:
        src = ensure_source(target, args.force)
        f = TTFont(src)
        src_cmap = set(f.getBestCmap().keys())
        picked = cps & src_cmap
        upem = f["head"].unitsPerEm
        log("  %s: 源 cmap %d，命中 %d，源里没有而跳过 %d"
            % (os.path.basename(src), len(src_cmap), len(picked), len(cps) - len(picked)))
        log("    度量 unitsPerEm=%d（设计字号 %dpx，一格 %.0f 单位）hhea=%d/%d"
            % (upem, target["px"], upem / float(target["px"]),
               f["hhea"].ascent, f["hhea"].descent))
        f.close()

        specs = chunk_specs(picked, used, args.chunks)
        if args.dry_run:
            for suffix, ccps in specs:
                name = target["out"].replace(".woff2", suffix + ".woff2")
                log("    （dry-run）%s  %d 码位" % (name, len(ccps)))
            continue

        for suffix, ccps in specs:
            name = target["out"].replace(".woff2", suffix + ".woff2")
            t2 = dict(target, out=name)
            out, actual, size, metrics = subset_one(src, t2, set(ccps))
            log("    → %-30s %6d 码位  %7.1f KB"
                % (name, len(actual), size / 1024.0))
            results.append({
                "px": target["px"], "family": target["family"], "file": name,
                "count": len(actual), "sizeKb": size / 1024.0,
                "range": to_unicode_range(actual),
                "expected": set(actual),
                "out": out,
            })

    if args.dry_run:
        log("")
        log("（dry-run：没写任何文件）")
        return

    if os.path.exists(OFL_SITE):
        log("")
        log("许可证：static/fonts/fusion-pixel-OFL.txt 已在，随站点分发（不重复拷贝）")
    else:
        log("")
        log("⚠️ 没找到 static/fonts/fusion-pixel-OFL.txt —— OFL 要求分发时带许可证，"
            "请先跑一次 tools/build-gap-font.py")

    log("")
    log("自检：")
    all_ok = True
    for r in results:
        target = {"family": r["family"], "px": r["px"]}
        # 文件名不带 -2/-3 的那份是第一块（装着 ASCII + 界面文案）
        is_primary = "-2." not in r["file"] and "-3." not in r["file"] and "-4." not in r["file"]
        all_ok = verify(r["out"], r["expected"], target, primary=is_primary) and all_ok

    # 清掉上一轮多出来、这一轮不再生成的块（比如改了 --chunks）
    keep = set(r["file"] for r in results)
    for fn in sorted(os.listdir(FONT_DIR)):
        if fn.startswith("fusion-board-") and fn.endswith(".woff2") and fn not in keep:
            os.remove(os.path.join(FONT_DIR, fn))
            log("  删掉多余的块 %s" % fn)

    write_toml(results)
    log("")
    for r in results:
        log("%s %-28s %6d 个码位，%7.1f KB"
            % (r["family"], r["file"], r["count"], r["sizeKb"]))
    total = sum(r["sizeKb"] for r in results)
    log("合计 %.1f KB（分 %d 块）" % (total, len(results)))
    log("块定义已写入 data/pixel-board-font.toml")
    if not all_ok:
        raise SystemExit("自检失败 —— 见上面的 ✗")
    log("自检通过。")


if __name__ == "__main__":
    main()
