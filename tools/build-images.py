#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把正文里内联的 <img> 换成 <picture> + WebP 自适应图（按「实际显示宽度」出派生图）。

    python tools/build-images.py --dry-run                  # 只分析、只报告（默认就是这个模式）
    python tools/build-images.py --dry-run --report         # 再打印每张图的体积对比
    python tools/build-images.py --report --report-file out.txt
    python tools/build-images.py --only niki_202608         # 只处理路径里含这个子串的内容文件
    python tools/build-images.py --apply                    # 真跑：写派生图 + 改 content/
    python tools/build-images.py --images-only              # 只写派生图，先不动 content/

为什么需要它
------------
Hugo 的图片管线只认 assets/（resources.Get 读不到 static/），而正文里的图全在
static/images/ 下，hugo 命令行又没有图片处理子命令。所以派生图必须在「提交之前」
生成好、静态发出去 —— 和 tools/make-thumb.py 给画廊做缩略图是同一个思路。

真正的浪费不在「图太大」，而在「下的是原图、显示只有 300px」：
一篇日记页的 image 负载 2880 KB，其中绝大多数像素从来没被显示出来。
这个脚本按**实际显示宽度**（而不是原始宽度）出 webp，再让浏览器自己挑 1x/2x。

安全约定（写死，不给开关）
--------------------------
  · static/images/ 下的**原始图片绝不修改、绝不删除** —— 派生图一律是新增文件。
    画廊要全分辨率原图，删了就没了。
  · 不碰 static/images/gallery/（画廊有自己的一套缩略图，由 make-thumb.py 管），
    也不碰 data/gallery.toml。
  · 已经是 <picture> 包裹的 <img> 直接跳过 —— 所以这个脚本是幂等的，重复跑第二次
    「0 张需要处理」。
  · 默认就是 dry-run。要真的写文件必须显式加 --apply，避免手滑。

它是怎么定「显示宽度」的
------------------------
按可信度从高到低，每张图都会标出来源（见报告里的 W-SRC 列）：

  attr     width="350"     —— 直接信。HTML 的 width 属性会被浏览器当成「指定宽度」，
                              CSS 只加了 max-width:100%，所以除非撞上栏宽，它**就是**
                              渲染宽度。
  attr-px  width="500px"   —— 同上，带单位的写法。
  attr-pct width=30%       —— 属性值写的是百分比（仓库里还真有，而且没引号），
                              按栏宽换算：0.30 × 634 ≈ 190px。
  class    class="float-wrap" —— 正文内联 <style> 定义了 .float-wrap{width:220px}。
                              **CSS 的 width 会盖掉 width 属性**（CSS 优先于表现属性），
                              所以这一类必须按 class 规则算，否则会把 220px 的浮动
                              缩略图当成 30% 全宽处理。
  unknown  没有 width       —— 按 CSS max-width:100%，渲染宽度是 min(原图宽, 栏宽)。
                              这个推算**默认不做**，只在报告里列出来等人确认
                              （--unknown-mode column 才按栏宽处理）。

栏宽 634 不是拍脑袋来的：retro.css 里 #content 是 656px，减掉 .box 的左右各 1px 边框
和 .box-body 的左右各 10px 内衬，正文栏 = 634px（CSS 注释里也写了实测值）。

像素画
------
整数倍最近邻放大的图（比如 1280x1280 的 4 倍放大 sprite），用 LANCZOS 缩会把硬边
糊成一团、还原不出原本那个「方块」。判定只用**强证据**：
  把图按 N 倍最近邻缩下去再放大回来，如果和原图逐像素完全相同，那它就一定是某个
  1/N 大小原图的整数倍放大 —— 这时用 NEAREST 缩回 N 分之一是**无损**的。
只凭「颜色数少」就上 NEAREST 会误伤平涂插画，所以颜色数只用来选 webp 编码质量，
不用来选重采样算法。判定结果和证据（倍数 / 颜色数）都会打进报告。

依赖只有 Pillow（这台机器上已经装了，tools/make-thumb.py 也在用）。
macOS 上没装就 pip3 install Pillow。
"""
import argparse
import hashlib
import os
import re
import shutil
import sys
import tempfile

try:
    from PIL import Image, ImageChops, ImageOps
except ImportError:  # pragma: no cover - 只在没装依赖时走到
    sys.stderr.write("没装 Pillow：pip install Pillow\n")
    raise

# ---------------------------------------------------------------- 常量

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                        # 仓库根
CONTENT_DIR = os.path.join(ROOT, "content")
STATIC_DIR = os.path.join(ROOT, "static")
IMAGE_URL_PREFIX = "/images/"                       # 正文里引用 static/images 的写法
# 派生图的名字长这样：<原名去扩展名>-<宽>.webp
# 只认 .webp：本脚本产出并写进 srcset 的只有 webp，<img src> 那一路要么保持原图
# （--fallback original）、要么被 <picture> 检查拦下，不靠文件名识别。
DERIVED_NAME_RE = re.compile(r"^(.+)-(\d+)\.webp$", re.I)

# 正文栏宽。为什么是 634：见文件头注释。
COLUMN_WIDTH_DEFAULT = 634

# 太小的图不值得派生（只会在仓库里堆一堆几 KB 的文件）。
MIN_DISPLAY_WIDTH = 48
# webp 相对原图至少省这么多字节才换，否则留着原图更省事。
MIN_SAVING_BYTES = 1024

# 画廊的地盘：派生图绝不允许写进这里。
PROTECTED_DIRS = (os.path.join(STATIC_DIR, "images", "gallery"),)

WEBP_QUALITY = 90           # 高质量插画（需求指定）
WEBP_QUALITY_LOWCOLOR = 95  # 低色数平涂：有损会在大片色块边缘出彩噪，给高一点
WEBP_METHOD = 6             # 最慢但最小
JPEG_FALLBACK_QUALITY = 84
LOW_COLOR_THRESHOLD = 256

IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I | re.S)
PICTURE_BLOCK_RE = re.compile(r"<picture\b.*?</picture\s*>", re.I | re.S)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
# 这些标签里面的 <img> 是「代码/文本」，不是内容，别动。
OPAQUE_BLOCK_RE = re.compile(r"<(pre|code|script|style|textarea)\b[^>]*>.*?</\1\s*>", re.I | re.S)
FENCE_RE = re.compile(r"^[ \t]*(```|~~~)[^\n]*\n.*?^[ \t]*\1[ \t]*$", re.M | re.S)
STYLE_BLOCK_RE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.I | re.S)

# HTML 属性：名字后面可以没有值（比如 <img ... float: left> 里的 float: / left）
ATTR_RE = re.compile(r"""([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?""")
# 只替换 src 的值，其它一律原样保留（alt / loading / border / class / width / fetchpriority）
SRC_ATTR_RE = re.compile(r"""(?P<pre>\bsrc\s*=\s*)(?P<q>["']?)(?P<url>[^"'\s>]*)(?P=q)""", re.I)
# 内联 <style> 里的 .foo { width: 220px; }
CSS_RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.S)
CSS_WIDTH_RE = re.compile(r"(?<![-\w])width\s*:\s*(-?[\d.]+)\s*(px|%)", re.I)

# 报告里 W-SRC 列的取值
W_ATTR = "attr"
W_ATTR_PX = "attr-px"
W_ATTR_PCT = "attr-pct"
W_CLASS = "class"
W_UNKNOWN = "unknown"

FALLBACK_EXTS = (".png", ".jpg", ".jpeg")


def _stdout_setup():
    """Windows 控制台默认是 GBK，直接打中文会炸。保持原编码但别崩。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding=stream.encoding or "utf-8", errors="replace")
        except Exception:
            pass


def kb(n):
    return "%.1f" % (n / 1024.0)


# ---------------------------------------------------------------- 属性 / 宽度解析

def parse_attrs(tag):
    """解析 <img> 标签的属性。返回 (有序列表 [(名字小写, 值)], 字典)。

    值可能为 None（HTML 里允许无值属性）。名字按 HTML 语义一律小写。
    """
    pairs, d = [], {}
    body = tag[4:].rstrip()
    if body.endswith("/>"):
        body = body[:-2]
    elif body.endswith(">"):
        body = body[:-1]
    for m in ATTR_RE.finditer(body):
        name = m.group(1).lower()
        val = m.group(2)
        if val is not None and val[:1] in "\"'":
            val = val[1:-1]
        pairs.append((name, val))
        if name not in d:            # 重复属性按 HTML 规则取第一个
            d[name] = val
    return pairs, d


def parse_inline_class_widths(text):
    """从正文内联 <style> 里挖出「类名 -> px 宽度」。

    为什么需要：.float-wrap{width:220px} 会盖掉 <img width=30%>，
    CSS 的 width 优先级高于表现属性。不认这个就会把 220px 的浮动缩略图
    当成 190px 的全宽图，多出来的像素白下载。
    """
    out = {}
    for block in STYLE_BLOCK_RE.finditer(text):
        for rule in CSS_RULE_RE.finditer(block.group(1)):
            selector, body = rule.group(1).strip(), rule.group(2)
            m = CSS_WIDTH_RE.search(body)
            if not m or m.group(2).lower() != "px":
                continue
            px = int(round(float(m.group(1))))
            if px <= 0:
                continue
            for sel in selector.split(","):
                sel = sel.strip()
                # 只认最简单的 .class 选择器；带组合子/伪类的规则不敢猜
                if re.fullmatch(r"\.[-\w]+", sel):
                    out.setdefault(sel[1:], px)
    return out


def resolve_display_width(attrs, class_widths, column):
    """定这张图显示多宽。返回 (宽度 或 None, 来源, 说明)。"""
    cls = (attrs.get("class") or "").strip()
    if cls:
        for name in cls.split():          # 多个 class 时取第一个命中规则的
            if name in class_widths:
                return class_widths[name], W_CLASS, ".%s { width: %dpx }" % (name, class_widths[name])

    raw = attrs.get("width")
    if raw is not None:
        v = raw.strip()
        m = re.fullmatch(r"(\d+)\s*(?:px)?", v, re.I)
        if m:
            return int(m.group(1)), (W_ATTR_PX if v.lower().endswith("px") else W_ATTR), "width=\"%s\"" % raw
        m = re.fullmatch(r"([\d.]+)\s*%", v)
        if m:
            px = int(round(float(m.group(1)) / 100.0 * column))
            return px, W_ATTR_PCT, "width=%s → %.0f%% × 栏宽 %d" % (raw, float(m.group(1)), column)

    if cls:
        return None, W_UNKNOWN, "有 class=%r 但没有可解析的 px 宽度规则" % cls
    return None, W_UNKNOWN, "没有 width 属性"


# ---------------------------------------------------------------- 像素画判定

def _identical(a, b):
    """两张图是不是逐像素完全相同。

    坑：Image.getbbox() 对 RGBA 图**只看 alpha 通道**。直接用
    ImageChops.difference(a, b).getbbox() 的话，一张 alpha 全是 255 的 JPEG
    （差分 alpha 恒为 0）会被判成「完全相同」—— 实测所有偶数尺寸的照片都会被
    误判成像素画，然后走无损 webp，白忙一场。所以逐 band 拆开看。
    """
    if a.size != b.size or a.mode != b.mode:
        return False
    for band in ImageChops.difference(a, b).split():
        if band.getbbox() is not None:
            return False
    return True


def _crop_is_blocky(base, n):
    """便宜的排除法：只看两块 256px 对齐切片。不通过就一定不是整数倍放大。"""
    w, h = base.size
    if w % n or h % n:
        return False
    cw = min(w, 256) // n * n
    ch = min(h, 256) // n * n
    if cw < n or ch < n:
        return False
    origins = {(0, 0), ((w - cw) // n * n, (h - ch) // n * n)}
    for ox, oy in origins:
        crop = base.crop((ox, oy, ox + cw, oy + ch))
        back = crop.resize((cw // n, ch // n), Image.NEAREST).resize((cw, ch), Image.NEAREST)
        if not _identical(crop, back):
            return False
    return True


def integer_upscale_factor(im):
    """源图是不是某个 1/N 大小原图的整数倍最近邻放大？是就返回 N，否则返回 1。

    判据是强证据：按 N 最近邻缩下去再放大回来，和原图逐像素完全相同。
    这只对「本来就是整数倍放大」成立，平涂插画不会误判。
    先用两块切片做排除（快），只有在切片全部通过时才做全图确认（慢但严格）。
    """
    w, h = im.size
    if w < 16 or h < 16:
        return 1
    base = im.convert("RGBA")
    for n in (2, 3, 4, 5, 6, 8):
        if w % n or h % n:
            continue
        if not _crop_is_blocky(base, n):
            continue
        small = base.resize((w // n, h // n), Image.NEAREST)
        back = small.resize((w, h), Image.NEAREST)
        if _identical(base, back):
            return n
    return 1


def count_colors(im, cap=4096):
    """数颜色种数；超过 cap 返回 None（说明是照片/渐变，不必再看）。"""
    probe = im.convert("RGB")
    if max(probe.size) > 512:                 # 数颜色不需要全分辨率
        r = 512.0 / max(probe.size)
        probe = probe.resize((max(1, int(probe.width * r)), max(1, int(probe.height * r))), Image.NEAREST)
    try:
        cols = probe.getcolors(maxcolors=cap)
    except Exception:
        return None
    return None if cols is None else len(cols)


# ---------------------------------------------------------------- 派生图生成

def load_source(path, im=None):
    """打开原图并规范化：吃掉 EXIF 旋转、动图只取第一帧。返回 (图, 帧数)。"""
    if im is None:
        im = Image.open(path)
        im.load()
    frames = getattr(im, "n_frames", 1)
    if frames > 1:
        im.seek(0)
        im = im.copy()
    try:
        im = ImageOps.exif_transpose(im)      # 不烤进去的话，派生图丢了 EXIF 就会躺倒
    except Exception:
        pass
    return im, frames


def save_webp(im, dst, lossless, quality):
    """写 webp（先写 .tmp 再原子替换，避免半截文件）。返回字节数。"""
    out = im
    if out.mode not in ("RGB", "RGBA"):
        out = out.convert("RGBA")
    if out.mode == "RGBA" and out.getchannel("A").getextrema()[0] == 255:
        out = out.convert("RGB")              # 全不透明就扔掉 alpha 通道，能小一截
    tmp = dst + ".tmp"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if lossless:
        out.save(tmp, "WEBP", lossless=True, method=WEBP_METHOD, quality=100)
    else:
        out.save(tmp, "WEBP", quality=quality, method=WEBP_METHOD)
    os.replace(tmp, dst)
    return os.path.getsize(dst)


def build_derived(src_path, dst_path, target_w, pixel_n, lossless, quality, src_im=None):
    """按目标宽度出 webp 派生图，返回字节数。已存在就直接复用（幂等，而且快）。"""
    if os.path.exists(dst_path):
        return os.path.getsize(dst_path)
    im, _ = load_source(src_path, src_im)
    w, h = im.size
    if target_w >= w:
        new = im                              # 不放大：原图本来就比目标窄
    else:
        new_h = max(1, int(round(h * target_w / float(w))))
        # 整数倍放大过的像素画 → 用 NEAREST，硬边不能糊
        new = im.resize((target_w, new_h), Image.NEAREST if pixel_n > 1 else Image.LANCZOS)
    return save_webp(new, dst_path, lossless, quality)


def build_fallback(src_path, dst_path, target_w, src_im=None, resample=Image.LANCZOS):
    """给不支持 webp 的浏览器兜底：按原格式重出一张小图（png → png，jpg → jpg）。

    为什么按原格式：把 1280x960 的照片重编码成 PNG 会变成 1MB+，
    兜底图反而比原图还大，纯属负优化。
    """
    if os.path.exists(dst_path):
        return os.path.getsize(dst_path)
    im, _ = load_source(src_path, src_im)
    w, h = im.size
    if target_w < w:
        im = im.resize((target_w, max(1, int(round(h * target_w / float(w))))), resample)
    ext = os.path.splitext(dst_path)[1].lower()
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    tmp = dst_path + ".tmp"
    if ext == ".png":
        out = im
        cols = count_colors(out, cap=LOW_COLOR_THRESHOLD + 1)
        if cols is not None:
            if out.mode in ("RGBA", "LA", "P"):
                out = out.convert("RGBA")
            else:
                out = out.convert("RGB")
            out = out.quantize(colors=min(256, max(2, cols)), method=Image.MEDIANCUT)
        out.save(tmp, "PNG", optimize=True)
    else:
        im.convert("RGB").save(tmp, "JPEG", quality=JPEG_FALLBACK_QUALITY, optimize=True, progressive=True)
    os.replace(tmp, dst_path)
    return os.path.getsize(dst_path)


# ---------------------------------------------------------------- 命名 / 路径

def derived_candidates(src_abs, target_w, natural_w):
    """算出 1x / 2x 两档的派生路径。

    命名规则 <原名去扩展名>-<宽>.webp，和已有的 Hoshinijisou-Banner2-700.webp 一致。
    2x 不会超过原图宽度（不放大）。
    """
    d = os.path.dirname(src_abs)
    stem = os.path.splitext(os.path.basename(src_abs))[0]
    out = []
    for w in sorted({target_w, min(target_w * 2, natural_w)}):
        out.append((w, os.path.join(d, "%s-%d.webp" % (stem, w))))
    return out


def url_of(abs_path):
    return "/" + os.path.relpath(abs_path, STATIC_DIR).replace("\\", "/")


def _protected(path):
    ap = os.path.abspath(path).lower()
    for p in PROTECTED_DIRS:
        pp = os.path.abspath(p).lower()
        if ap == pp or ap.startswith(pp + os.sep):
            return True
    return False


_DIRLIST_CACHE = {}


def _dirlist(d):
    if d not in _DIRLIST_CACHE:
        try:
            _DIRLIST_CACHE[d] = set(os.listdir(d))
        except OSError:
            _DIRLIST_CACHE[d] = set()
    return _DIRLIST_CACHE[d]


def looks_like_derived(path):
    """这个 src 指向的是不是本脚本生成出来的派生图？

    不能只看文件名尾巴「-<数字>.扩展名」——仓库里一堆原始文件自带数字后缀：
    IMG-20260215-030455.jpg、Image-1774625453780-335.jpg、
    qq-pic-merged-1771096024753.jpg……光看尾巴会把它们全误判成派生图然后
    静默跳过（实测漏掉 21 张）。所以还要确认：同目录下确实存在
    「去掉 -<数字> 之后」的那个原图。

    而且只认 .webp。曾经也认 png/jpg，结果把
    Nijiboshi-Sou-Banner-20048.png（它旁边真的有一个
    Nijiboshi-Sou-Banner.png，但两者是两张不同的原图）误判成派生图。
    如今 <img src> 那一路由 --fallback 决定、幂等由 <picture> 检查兜底，
    再靠文件名猜 png/jpg 只会帮倒忙。
    """
    d, name = os.path.split(path)
    m = DERIVED_NAME_RE.match(name)
    if not m:
        return False
    stem = m.group(1).lower()
    for other in _dirlist(d):
        if other.lower() == name.lower():
            continue
        if os.path.splitext(other)[0].lower() == stem:
            return True
    return False


# ---------------------------------------------------------------- 扫描

class Item(object):
    __slots__ = ("file", "offset", "tag", "attrs", "src_url", "src_abs", "line",
                 "disp_w", "w_src", "w_note", "natural", "orig_bytes", "skip",
                 "pixel_n", "colors", "derived", "fallback", "fallback_bytes",
                 "fallback_staged", "saving", "frames", "exif_rot")


def scan_file(path, text, column):
    """扫一个内容文件，产出所有「指向 static/images 的 <img>」条目。"""
    opaque = []
    for rx in (OPAQUE_BLOCK_RE, COMMENT_RE, FENCE_RE):
        for m in rx.finditer(text):
            opaque.append((m.start(), m.end()))
    pictures = [(m.start(), m.end()) for m in PICTURE_BLOCK_RE.finditer(text)]
    class_widths = parse_inline_class_widths(text)

    def inside(spans, pos):
        return any(a <= pos < b for a, b in spans)

    items = []
    for m in IMG_TAG_RE.finditer(text):
        pos = m.start()
        if inside(opaque, pos):
            continue                                        # 代码块/注释里的示例，别动
        tag = m.group(0)
        _, attrs = parse_attrs(tag)
        src = attrs.get("src") or ""
        it = Item()
        it.file, it.offset, it.tag, it.attrs = path, pos, tag, attrs
        it.line = text.count("\n", 0, pos) + 1
        it.src_url = src
        it.src_abs = None
        it.skip = None
        it.derived = []
        it.fallback = None
        it.fallback_bytes = 0
        it.fallback_staged = None
        it.saving = None
        it.pixel_n = 1
        it.colors = None
        it.natural = None
        it.orig_bytes = 0
        it.disp_w = None
        it.w_src = None
        it.w_note = ""
        it.frames = 1
        it.exif_rot = 1
        items.append(it)

        if inside(pictures, pos):
            it.skip = "已经是 <picture>（幂等跳过）"
            continue
        if not src.startswith(IMAGE_URL_PREFIX):
            it.skip = "不是 static/images 下的图"
            continue
        src_abs = os.path.join(STATIC_DIR, src.split("?")[0].lstrip("/").replace("/", os.sep))
        it.src_abs = src_abs
        if _protected(src_abs):
            it.skip = "在画廊目录里（不归这个脚本管）"
            continue
        if looks_like_derived(src_abs):
            it.skip = "src 已经是派生图"
            continue
        if not os.path.isfile(src_abs):
            it.skip = "源图不存在"
            continue

        try:
            with Image.open(src_abs) as probe:
                probe.load()
                frames = getattr(probe, "n_frames", 1)
                natural = ImageOps.exif_transpose(probe).size
                it.exif_rot = int(probe.getexif().get(0x0112, 1) or 1)
            it.natural = natural
            it.frames = frames
            it.orig_bytes = os.path.getsize(src_abs)
        except Exception as e:
            it.skip = "打不开：%s" % e
            continue

        if frames > 1:
            it.skip = "动图（%d 帧），缩了就不动了" % frames
            continue

        dw, wsrc, wnote = resolve_display_width(attrs, class_widths, column)
        it.disp_w, it.w_src, it.w_note = dw, wsrc, wnote
        if dw is None:
            it.skip = "__NEED_WIDTH__"      # 占位，交给 CLI 按 --unknown-mode 决定
        elif dw < MIN_DISPLAY_WIDTH:
            it.skip = "显示宽度太小（%dpx）" % dw
        elif dw >= natural[0]:
            it.skip = "原图本来就不比显示宽度宽（%dpx vs 显示 %dpx）" % (natural[0], dw)
    return items


def content_files(only=None, skip=None):
    out = []
    for dirpath, dirnames, filenames in os.walk(CONTENT_DIR):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in sorted(filenames):
            if not fn.lower().endswith((".md", ".html")):
                continue
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, ROOT).replace("\\", "/")
            if only and only.lower() not in rel.lower():
                continue
            if skip and skip.lower() in rel.lower():
                continue
            out.append(fp)
    return sorted(out)


# ---------------------------------------------------------------- dry-run 缓存

def ensure_cache_dir():
    d = os.path.join(tempfile.gettempdir(), "hugo-build-images-cache")
    os.makedirs(d, exist_ok=True)
    return d


# 改编码参数（质量/无损/method）时必须改这个版本号，否则 dry-run 会复用旧缓存，
# 报出来的体积和真跑的结果对不上。（踩过一次：像素画误判修好后，缓存里还留着
# 上一轮的无损 webp，导致照片那一档报出 84KB 的假数字。）
CACHE_VERSION = "v2"


def cache_key(*parts):
    h = hashlib.sha1()
    for p in (CACHE_VERSION,) + parts:
        h.update(str(p).encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:20]


def _commit_staged(staged, dst):
    """把缓存里编好的派生图搬到 static/ 下的目标位置。

    先拷到 <目标>.tmp 再 os.replace：一是缓存常在 C:、仓库在 D:，跨盘符时
    os.replace 会直接报错；二是保证目标位置不会出现半截文件。

    目标已存在就直接沿用、不覆盖 —— 这个脚本对 static/ 的契约是「只会新增文件」，
    永远不覆盖任何已经在那儿的东西（原图、以及别人手工调过的派生图都算在内）。
    返回目标文件最终的实际字节数（沿用旧文件时就是旧文件的大小）。
    """
    if os.path.exists(dst):
        return os.path.getsize(dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp"
    shutil.copyfile(staged, tmp)
    os.replace(tmp, dst)
    return os.path.getsize(dst)


# ---------------------------------------------------------------- 改写

def make_picture_markup(tag, srcset, sizes, new_src):
    """把原始 <img> 包进 <picture>。只换 src 值，其它属性一个不动。"""
    new_tag, n = SRC_ATTR_RE.subn(
        lambda m: "%s%s%s%s" % (m.group("pre"), m.group("q"), new_src, m.group("q")),
        tag, count=1)
    if n != 1:
        return None
    return '<picture><source type="image/webp" srcset="%s" sizes="%dpx" />%s</picture>' % (
        srcset, sizes, new_tag)


def apply_edits(text, edits):
    """按位置从后往前替换，避免偏移错位。edits: [(start, end, new_text)]"""
    for start, end, new in sorted(edits, key=lambda x: -x[0]):
        text = text[:start] + new + text[end:]
    return text


# ---------------------------------------------------------------- 主流程

def main(argv=None):
    _stdout_setup()
    ap = argparse.ArgumentParser(
        description="按实际显示宽度给正文里的图片生成 WebP 派生图并改写成 <picture>",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="真的写派生图并改写 content/（默认只分析）")
    ap.add_argument("--dry-run", action="store_true", help="只报告不写文件（这是默认行为，显式写出来更清楚）")
    ap.add_argument("--images-only", action="store_true", help="只生成派生图，不改 content/（分两步走时用）")
    ap.add_argument("--only", default=None, help="只处理路径里含这个子串的内容文件")
    ap.add_argument("--skip", default=None, help="跳过路径里含这个子串的内容文件")
    ap.add_argument("--report", action="store_true", help="打印每张图的显示/原图/派生体积对比")
    ap.add_argument("--report-file", default=None, help="把完整报告写到这个文件（UTF-8）")
    ap.add_argument("--column", type=int, default=COLUMN_WIDTH_DEFAULT,
                    help="正文栏宽 px，用于换算百分比宽度和推算无宽度图（默认 "
                         + str(COLUMN_WIDTH_DEFAULT) + "）")
    ap.add_argument("--unknown-mode", choices=("skip", "column"), default="skip",
                    help="没有 width 属性的图怎么办：skip=只在报告里列出等人确认（默认），"
                         "column=按 min(原图宽, 栏宽) 处理")
    ap.add_argument("--fallback", choices=("derived", "original"), default="derived",
                    help="<img src> 兜底指向哪：derived=按原格式重出的同尺寸小图（默认），"
                         "original=保持原图不动（省文件，但无 webp 的浏览器仍下原图）")
    ap.add_argument("--no-2x", action="store_true", help="不出 2 倍宽的高分屏档")
    ap.add_argument("--lossless-pixel", dest="lossless_pixel", action="store_true", default=True,
                    help="像素画用无损 webp（默认开）")
    ap.add_argument("--no-lossless-pixel", dest="lossless_pixel", action="store_false",
                    help="像素画也用有损 webp（体积更小，但硬边可能有噪）")
    ap.add_argument("--min-saving-kb", type=float, default=MIN_SAVING_BYTES / 1024.0,
                    help="单张至少省这么多 KB 才换（默认 %(default)s）")
    args = ap.parse_args(argv)

    do_write_content = args.apply and not args.images_only
    do_write_images = args.apply or args.images_only
    cache_dir = ensure_cache_dir()   # 干跑和真跑都先编到这里，真跑筛选后再拷进 static/
    min_saving = int(args.min_saving_kb * 1024)

    files = content_files(args.only, args.skip)
    if not files:
        sys.stderr.write("没有匹配的内容文件\n")
        return 2

    all_items = []
    for fp in files:
        with open(fp, "r", encoding="utf-8", newline="") as f:
            text = f.read()
        all_items.extend(scan_file(fp, text, args.column))

    # 无宽度的一批：默认只报不动
    need_width = [it for it in all_items if it.skip == "__NEED_WIDTH__"]
    for it in need_width:
        if args.unknown_mode == "column":
            it.disp_w = min(it.natural[0], args.column)
            it.w_src = W_UNKNOWN
            it.w_note = "无 width → 按 max-width:100%% 取 min(原图 %d, 栏宽 %d)" % (it.natural[0], args.column)
            if it.disp_w < MIN_DISPLAY_WIDTH:
                it.skip = "显示宽度太小（%dpx）" % it.disp_w
            elif it.disp_w >= it.natural[0]:
                it.skip = "原图本来就不比显示宽度宽"
            else:
                it.skip = None
        else:
            it.skip = "无 width 属性，等人工确认（--unknown-mode column 可按栏宽处理）"

    todo = [it for it in all_items if it.skip is None]

    # ---- 逐张出派生图
    # 一律先编到临时缓存（干跑是为了拿真实字节数，真跑是为了先筛选再落盘）。
    # 为什么不直接写进 static/：后面还有一道「webp 反而更大 / 省得太少」的闸，
    # 先落盘再筛会在仓库里留下永远没人引用的孤儿文件（实测漏了 10 个 / 474 KB）。
    for idx, it in enumerate(todo, 1):
        try:
            pieces_todo = [(w, dst) for w, dst in derived_candidates(it.src_abs, it.disp_w, it.natural[0])
                           if not (args.no_2x and w != it.disp_w)]
            for _, dst in pieces_todo:
                if _protected(dst):
                    raise RuntimeError("派生图路径被保护目录挡住：%s" % dst)

            # 源图只读一次，像素画判定 / 数颜色 / 两次缩放共用这张图
            im, _ = load_source(it.src_abs)
            it.pixel_n = integer_upscale_factor(im)
            it.colors = count_colors(im)
            low_color = it.colors is not None and it.colors <= LOW_COLOR_THRESHOLD
            lossless = it.pixel_n > 1 and args.lossless_pixel
            quality = WEBP_QUALITY_LOWCOLOR if low_color else WEBP_QUALITY

            pieces = []
            for w, dst in pieces_todo:
                staged = os.path.join(cache_dir, cache_key(
                    it.src_abs, os.path.getmtime(it.src_abs), os.path.getsize(it.src_abs),
                    w, ".webp", lossless, quality, WEBP_METHOD) + ".webp")
                b = build_derived(it.src_abs, staged, w, it.pixel_n, lossless, quality, im)
                pieces.append((w, dst, staged, b))
            it.derived = pieces

            # 兜底图
            if args.fallback == "derived":
                ext = os.path.splitext(it.src_abs)[1].lower()
                ext = ".jpg" if ext in (".jpg", ".jpeg") else ".png"
                stem = os.path.splitext(os.path.basename(it.src_abs))[0]
                fb = os.path.join(os.path.dirname(it.src_abs), "%s-%d%s" % (stem, it.disp_w, ext))
                if _protected(fb):
                    raise RuntimeError("兜底图路径被保护目录挡住：%s" % fb)
                it.fallback = fb
                staged = os.path.join(cache_dir, cache_key(
                    "fb", it.src_abs, os.path.getmtime(it.src_abs), it.disp_w, ext,
                    JPEG_FALLBACK_QUALITY, it.pixel_n) + ext)
                it.fallback_bytes = build_fallback(it.src_abs, staged, it.disp_w, im, _resample(it))
                it.fallback_staged = staged
            else:
                it.fallback = None
                it.fallback_bytes = it.orig_bytes
                it.fallback_staged = None

            b1 = it.derived[0][3]
            it.saving = it.orig_bytes - b1
        except Exception as e:
            it.skip = "生成失败：%s" % e
        if idx % 10 == 0:
            sys.stderr.write("  ... 已处理 %d/%d\n" % (idx, len(todo)))
            sys.stderr.flush()

    # 第二道闸：webp 没更小 / 省得太少，就留着原图（此时还没往 static/ 写任何东西）
    final = []
    for it in todo:
        if it.skip is not None:
            continue
        # 顺手丢掉「原图大小重编码」这类没意义的档（没有缩小、webp 还更大）
        kept = [p for p in it.derived
                if not (p[0] >= it.natural[0] and p[3] >= it.orig_bytes)]
        if not kept:
            it.skip = "webp 反而更大（%s KB vs %s KB），保留原图" % (kb(it.derived[0][3]), kb(it.orig_bytes))
            continue
        it.derived = kept
        b1 = it.derived[0][3]
        if b1 >= it.orig_bytes:
            it.skip = "webp 反而更大（%s KB vs %s KB），保留原图" % (kb(b1), kb(it.orig_bytes))
        elif it.orig_bytes - b1 < min_saving:
            it.skip = "省不到 %.1f KB（只省 %s KB）" % (args.min_saving_kb, kb(it.orig_bytes - b1))
        else:
            final.append(it)

    # 通过筛选的才真正落到 static/（从缓存拷过去，不重新编码）
    if do_write_images:
        for it in final:
            committed = []
            for w, dst, staged, b in it.derived:
                real = _commit_staged(staged, dst)
                committed.append((w, dst, staged, real))
            it.derived = committed
            if it.fallback_staged:
                it.fallback_bytes = _commit_staged(it.fallback_staged, it.fallback)
            b1 = it.derived[0][3]
            it.saving = it.orig_bytes - b1

    # ---- 改写 content/
    changed_files = 0
    fallback_changed = []
    if do_write_content:
        by_file = {}
        for it in final:
            by_file.setdefault(it.file, []).append(it)
        for fp, its in by_file.items():
            with open(fp, "r", encoding="utf-8", newline="") as f:
                original = f.read()
            edits = []
            for it in its:
                srcset = ", ".join("%s %dw" % (url_of(p), w) for w, p, _s, _b in it.derived)
                new_src = url_of(it.fallback) if (args.fallback == "derived" and it.fallback) else it.src_url
                markup = make_picture_markup(it.tag, srcset, it.disp_w, new_src)
                if markup is None:
                    it.skip = "改不出 <picture>：src 属性没找到"
                    fallback_changed.append(it)
                    continue
                edits.append((it.offset, it.offset + len(it.tag), markup))
            if not edits:
                continue
            new_text = apply_edits(original, edits)
            if new_text != original:
                with open(fp, "w", encoding="utf-8", newline="") as f:
                    f.write(new_text)          # newline="" → 原有 CRLF/LF 原样保留
                changed_files += 1
        final = [it for it in final if it.skip is None]

    # ------------------------------------------------------------ 报告
    lines = []

    def out(s=""):
        lines.append(s)

    out("=" * 96)
    out("tools/build-images.py   %s" % ("APPLY（写文件）" if args.apply else "DRY-RUN（只报告）"))
    out("  仓库        : %s" % ROOT)
    out("  内容文件    : %d 个   --only=%s --skip=%s" % (len(files), args.only, args.skip))
    out("  正文栏宽    : %dpx   --unknown-mode %s   --fallback %s"
        % (args.column, args.unknown_mode, args.fallback))
    own = [i for i in all_items if i.src_url.startswith(IMAGE_URL_PREFIX)]
    out("  <img> 总数  : %d（其中指向 static/images 的 %d）" % (len(all_items), len(own)))
    out("=" * 96)

    def reason_key(it):
        s = it.skip
        if s is None:
            return "① 将处理"
        if s == "__NEED_WIDTH__":
            return "② 待确认·无 width"
        if s.startswith("无 width 属性"):
            return "② 待确认·无 width"
        if s.startswith("显示宽度太小"):
            return "③ 跳过·显示宽度 < %dpx" % MIN_DISPLAY_WIDTH
        if s.startswith("原图本来就不比"):
            return "③ 跳过·原图比显示宽度还窄"
        if s.startswith("已经是 <picture>"):
            return "③ 跳过·已经是 <picture>"
        if s.startswith("动图"):
            return "③ 跳过·动图"
        if s.startswith("webp 反而更大"):
            return "③ 跳过·webp 反而更大"
        if s.startswith("省不到"):
            return "③ 跳过·省得太少"
        if s.startswith("源图不存在"):
            return "③ 跳过·源图不存在"
        return "③ 跳过·其它"

    buckets = {}
    for it in all_items:
        buckets[reason_key(it)] = buckets.get(reason_key(it), 0) + 1
    out("分组统计：")
    for k in sorted(buckets):
        out("  %-34s %d" % (k, buckets[k]))
    out()

    if final:
        orig = sum(i.orig_bytes for i in final)
        webp1 = sum(i.derived[0][3] for i in final)
        webp2_total = sum(sum(b for _, _, _, b in i.derived) for i in final)
        fb = sum(i.fallback_bytes for i in final)
        out("-" * 96)
        out("【收益】将处理 %d 张图，涉及 %d 个内容文件"
            % (len(final), len(set(i.file for i in final))))
        out("  原图合计                  : %10s KB" % kb(orig))
        out("  1x 派生 webp 合计         : %10s KB   ← 普通屏实际下载的就是这一档" % kb(webp1))
        out("  1x+2x 派生 webp 合计      : %10s KB   ← 两档文件加起来（高分屏只下 2x）"
            % kb(webp2_total))
        if args.fallback == "derived":
            out("  兜底小图合计（新增文件）  : %10s KB   ← 不支持 webp 的浏览器才下"
                % kb(fb))
        out("  单张平均                  : %.0f KB → %.0f KB"
            % (orig / len(final) / 1024.0, webp1 / len(final) / 1024.0))
        out("  ★ 普通屏图片负载少下      : %10s KB（省 %.1f%%）"
            % (kb(orig - webp1), 100.0 * (orig - webp1) / orig))
        out("-" * 96)
        out()
        out("【按页面】正文图片负载（原图 → 1x 派生 webp）")
        per = {}
        for it in final:
            p = per.setdefault(it.file, [0, 0, 0])
            p[0] += it.orig_bytes
            p[1] += it.derived[0][3]
            p[2] += 1
        for f in sorted(per, key=lambda x: -(per[x][0] - per[x][1])):
            o, n, c = per[f]
            out("  %-32s %3d 张  %9s KB → %8s KB   省 %8s KB"
                % (os.path.relpath(f, ROOT).replace("\\", "/"), c, kb(o), kb(n), kb(max(0, o - n))))
        out()

    if args.report:
        out("【逐张明细】只列将处理的")
        out("  %-30s %-5s %-9s %-13s %8s %8s %8s %8s  %s"
            % ("文件", "行", "W-SRC", "显示/原图", "原KB", "1xKB", "2xKB", "省KB", "证据"))
        for it in final:
            d2 = it.derived[-1][3] if len(it.derived) > 1 else 0
            ev = []
            if it.pixel_n > 1:
                ev.append("pixel ×%d" % it.pixel_n)
            if it.colors is not None:
                ev.append("%d colors" % it.colors)
            if it.exif_rot != 1:
                ev.append("exif rot %d" % it.exif_rot)
            out("  %-30s %-5d %-9s %-13s %8s %8s %8s %8s  %s"
                % (os.path.basename(it.file), it.line, it.w_src or "-",
                   "%d / %d" % (it.disp_w, it.natural[0]),
                   kb(it.orig_bytes), kb(it.derived[0][3]), kb(d2), kb(it.saving),
                   " ".join(ev)))
        out()
        out("【宽度来源说明】")
        seen = {}
        for it in final:
            seen.setdefault((it.w_src, it.w_note), 0)
            seen[(it.w_src, it.w_note)] += 1
        for (wsrc, note), n in sorted(seen.items(), key=lambda x: -x[1]):
            out("  %-9s %3d 张   %s" % (wsrc, n, note))
        out()

    if need_width and args.unknown_mode == "skip":
        out("-" * 96)
        out("【待人工确认】没有 width 属性、也没被 class 规则覆盖的图：%d 张" % len(need_width))
        out("  CSS 里 .entry-content img 有 max-width:100%，所以它们的渲染宽度 = min(原图宽, 栏宽 "
            + str(args.column) + ")。")
        out("  想直接按这个规则处理就加 --unknown-mode column；否则请在正文里补 width。")
        out("  %-30s %-5s %-44s %-13s %8s %10s"
            % ("文件", "行", "src", "原图", "原KB", "按栏宽→KB"))
        tot = 0.0
        for it in need_width:
            guess = min(it.natural[0], args.column)
            est = it.orig_bytes * (float(guess) / it.natural[0]) ** 2   # 面积折算，偏乐观
            tot += max(0.0, it.orig_bytes - est)
            out("  %-30s %-5d %-44s %-13s %8s %10s"
                % (os.path.basename(it.file), it.line, it.src_url[-44:],
                   "%dx%d" % it.natural, kb(it.orig_bytes), kb(est)))
        out("  ★ 按栏宽换算，这一批大约还能再省 %.0f KB（按面积折算，偏乐观，仅供估算）"
            % (tot / 1024.0))
        out()

    skipped = [it for it in all_items if it.skip not in (None, "__NEED_WIDTH__")
               and not it.skip.startswith("无 width 属性")]
    if skipped:
        seen = {}
        for it in skipped:
            seen.setdefault(reason_key(it), []).append(it)
        out("-" * 96)
        out("【跳过明细】%d 张" % len(skipped))
        for reason in sorted(seen, key=lambda x: (-len(seen[x]), x)):
            out("  %s —— %d 张" % (reason, len(seen[reason])))
            for it in seen[reason][:8]:
                extra = ""
                if it.disp_w:
                    extra = "  显示 %dpx / 原图 %dx%d" % (it.disp_w, it.natural[0], it.natural[1])
                out("      %s:%d  %s%s"
                    % (os.path.relpath(it.file, ROOT).replace("\\", "/"), it.line, it.src_url, extra))
            if len(seen[reason]) > 8:
                out("      ... 还有 %d 张" % (len(seen[reason]) - 8))
        out()

    if args.apply:
        out("-" * 96)
        out("【写入】内容文件改写 %d 个；新增派生图 %d 个（原图一个都没动）"
            % (changed_files, sum(len(i.derived) + (1 if i.fallback else 0) for i in final)))
        if args.images_only:
            out("  注意：--images-only 只写了派生图，content/ 还是旧的")
        out()

    text = "\n".join(lines)
    sys.stdout.write(text + "\n")
    if args.report_file:
        with open(args.report_file, "w", encoding="utf-8", newline="") as f:
            f.write(text + "\n")
        sys.stdout.write("完整报告已写入 %s\n" % args.report_file)
    return 0


def _resample(item):
    """像素画缩小用 NEAREST，其余用 LANCZOS。"""
    return Image.NEAREST if item.pixel_n > 1 else Image.LANCZOS


if __name__ == "__main__":
    sys.exit(main())
