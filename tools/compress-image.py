#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""压缩上传的图片 —— 「上传那一刻」就把过大的图压下来。

    python tools/compress-image.py <输入文件> <输出文件> [--long-edge 1600] [--quality 85] [--webp 输出.webp]
    python tools/compress-image.py --in-place <文件> [--long-edge 1600]

为什么要有这个脚本
------------------
站长反馈：每次往站里放图，都得麻烦别人跑一次优化脚本，太麻烦。
根因是**上传这一环没有任何压缩** —— 直接用编辑器上传一张 1917x1325 的 PNG
（1.1 MB），它就原样进 static/images/，读者也要原样下载 1.1 MB。

所以把压缩放在上传路径上，而不是靠事后补救。`.editor/server.mjs` 的
`/api/upload` 会调这个脚本（用临时文件过一手），
于是**所有上传入口**（正文插图、画廊、拖拽）都自动压缩。

几条写死的原则
--------------
· **只做「尺寸过大」这一件事**，不搞有损调色板量化。
  为什么不做量化：实测把插画量化到 256 色能把 PNG 压到 14~19%，很诱人 ——
  但代价是「通道差 > 8 的像素占 3.6~14.6%、最大通道差 30~58」。
  插画勉强能接受，**照片就是明显劣化**，而这个脚本是每次上传都自动跑的，
  赌不起。真正会暴涨的是「1892x1303 截图」这类**尺寸**问题，处理它收益最大也最可预测。
  （想进一步压成 webp 自适应图，另有 tools/build-images.py，那个有逐张的人工判据。
    以后若要做量化，应当做成显式的 --crush 开关，让站长自己决定。）
· **保持原扩展名/原格式**（PNG 存 PNG、JPEG 存 JPEG）。
  为什么不一律转 webp：画廊的缩略图命名和 data/gallery.toml 里的 `file`
  都是按**原文件名**推的（见 server.mjs 的 thumbRelFor / gallery.html），
  而且 gallery.html 对 `.webp` 的项**直接跳过缩略图生成**（它会下整份图当缩略图）。
  改了扩展名会把已经修好的那个问题又踩回去。
· **像素画用最近邻**，不能用 LANCZOS，否则边缘会糊。
  判据与 tools/build-images.py 的 integer_upscale_factor 一致：
  「按 N 最近邻缩下去再放大回来，与原图逐像素完全相同」——
  这是强证据，平涂插画不会误判。
· **没有变小就保留原图**。有的图本来就已经优化过，重编码只会更大（负优化）。
· **动图（GIF）和非静态图一律不动**，避免破坏动画。
· 小于 MIN_BYTES 的图不折腾 —— 几 KB 的文件省不出什么，重编码只会有损。

顺手出一张 webp（给了 --webp 才做）
-----------------------------------
上传时**存两份**：原图（上面那套规则压过的）+ 旁边一张同名 .webp。
正文里插的是 `<picture><source type="image/webp" src=…webp><img src=…原图>`，
支持 webp 的浏览器（97%+）只下 webp，不支持的拿原图 —— 所以原图是**兜底**，
webp 才是常态。为什么不像别的站那样「干脆只存 webp」：原图还能当兜底、
也能留着以后重新出派生图，多一个文件的代价换这两个好处，值。

webp 用什么编码：
  · JPEG（照片）    -> 有损 q82（默认，--webp-quality 可改）
  · PNG 颜色数少    -> **无损**，而且**不缩尺寸**（边长 ≤ 2048 时）。截图 / 平涂插画 /
                       像素画都在这一类：有损会在硬边上留振铃、在纯色块里放噪点，
                       而点阵风最怕这个；这类图的无损 webp 通常还比 PNG 小，等于白赚。
                       为什么不缩：本来也就 2000px 上下，读者那边最多显示 634px，
                       缩了只会把线条糊掉、又省不下多少（实测 8 色 2000x1200：
                       原尺寸无损 879 KB，缩到 1400 再有损 738 KB —— 差 19%，
                       但一个是原像素无损、一个有振铃）。
  · PNG 颜色数多    -> 有损 q82（照片存成了 PNG 的情况）
  · 边长 > 2048     -> 有损 q82（超大截图/图形，先缩到上限再说）
  · 动图 / 已是 webp -> 一张都不出（保持原状）
压完**不比原图小就不写** webp（负优化不如不加），JSON 里会说明原因。

判「图形还是照片」用的是**源图**的颜色数，不是缩完那张 —— LANCZOS 会把平涂的
硬边插值出上百万种颜色，按缩完的判会把图形误判成照片（这个坑实测踩过一次）。

输出：一行 JSON（编辑器按这个判断）
    {"ok": true, "changed": true,  "before": 1174318, "after": 841000,
     "from": [1917,1325], "to": [1600,1106], "format": "PNG", "pixel": 1,
     "webp": {"bytes": 214833, "lossless": true, "saving_pct": 74,
              "from": [1917,1325], "to": [1400,968]}}
    {"ok": true, "changed": false, "reason": "尺寸本来就不超上限，不动",
     "webp": null, "webp_reason": "webp 没有更小（9.1 KB vs 8.4 KB），只用原图"}
    {"ok": true, "changed": false, "reason": "尺寸本来就不超上限，不动"}
"""
import argparse
import io
import json
import os
import sys

try:
    from PIL import Image, ImageOps
except ImportError:                                    # pragma: no cover
    sys.stdout.write(json.dumps({"ok": False, "error": "没装 Pillow（pip install Pillow）"},
                                ensure_ascii=False))
    sys.exit(1)

# 长边上限。正文栏宽 628px，按 DPR2（视网膜屏）是 1256px；1400 比这个需要更清晰一点，
# 同时能把 1600~4000 像素的图真正压下来。
# 为什么不是 1920：站里现有的图大多在 1300~1900px，上限放到 1920 等于什么都不做（实测）。
LONG_EDGE = 1400
QUALITY = 85
# 小于这个字节数就不折腾了：省不出什么，重编码只会有损。
MIN_BYTES = 60 * 1024
# 这些格式不碰：webp/svg 已经是压缩格式，gif 是动图（只取第一帧会毁掉动画）。
SKIP_EXT = {".webp", ".svg", ".gif", ".ico", ".avif"}

# webp 兄弟文件的参数
WEBP_QUALITY = 82            # 有损（照片 / JPEG / 颜色很多的 PNG）
WEBP_METHOD = 6              # 0(快) ~ 6(小)
WEBP_LOSSLESS_COLORS = 5000  # 颜色数不超过这个就当「图形」→ 无损；超过当「照片」→ 有损
WEBP_KEEP_FULL_EDGE = 2048   # 图形不缩尺寸的上限。2048 已经远超实际显示（栏宽 628
                             # 的 3 倍），这类图缩了只会糊线条又省不下多少


def integer_upscale_factor(im):
    """源图是不是某个 1/N 大小原图的整数倍最近邻放大？是就返回 N，否则返回 1。

    与 tools/build-images.py 里的同名函数保持一致的判据 —— 两处必须同一套标准，
    否则「编辑器觉得是像素画、优化脚本觉得不是」会互相打架。
    先用两块切片快速排除，只有切片全过才做全图确认。
    """
    w, h = im.size
    if w < 16 or h < 16:
        return 1
    base = im.convert("RGBA")
    for n in (2, 4, 8):
        if w % n or h % n:
            continue
        # 快速排除：看左上和右下两块里，每 n x n 个像素是不是同色
        ok = True
        for ox, oy in ((0, 0), (max(0, w - 64), max(0, h - 64))):
            block = base.crop((ox, oy, min(w, ox + 64), min(h, oy + 64)))
            small = block.resize((max(1, block.width // n), max(1, block.height // n)), Image.NEAREST)
            back = small.resize(block.size, Image.NEAREST)
            if list(back.getdata()) != list(block.getdata()):
                ok = False
                break
        if not ok:
            continue
        small = base.resize((w // n, h // n), Image.NEAREST)
        back = small.resize((w, h), Image.NEAREST)
        if list(back.getdata()) == list(base.getdata()):
            return n
    return 1


def load_source(path):
    """打开图片并规范化：吃掉 EXIF 旋转；多帧图只取第一帧。返回 (图, 帧数)。"""
    im = Image.open(path)
    im.load()
    frames = getattr(im, "n_frames", 1)
    if frames > 1:
        im.seek(0)
        im = im.copy()
    try:
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    return im, frames


def encode(im, fmt, quality):
    """按原格式编码到内存，返回字节。"""
    buf = io.BytesIO()
    out = im
    if fmt in ("JPEG", "JPG"):
        if out.mode in ("RGBA", "LA", "P"):
            # JPEG 不支持透明：铺白底（站点背景本来就是纸色，不会突兀）
            out = out.convert("RGBA")
            bg = Image.new("RGB", out.size, (255, 255, 255))
            bg.paste(out, mask=out.getchannel("A"))
            out = bg
        elif out.mode != "RGB":
            out = out.convert("RGB")
        out.save(buf, "JPEG", quality=quality, optimize=True, progressive=True, subsampling=0)
    else:
        if out.mode not in ("RGB", "RGBA", "P", "L"):
            out = out.convert("RGBA")
        out.save(buf, "PNG", optimize=True, compress_level=9)
    return buf.getvalue()


def count_colors(im, cap):
    """数颜色数；超过 cap 返回 None。只用来判断「图形」还是「照片」。"""
    cols = im.convert("RGB").getcolors(maxcolors=cap)
    return None if cols is None else len(cols)


def atomic_write(path, data):
    """先写 .tmp 再 os.replace —— 目标位置不会出现半截文件。"""
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def encode_webp(im, lossless, quality):
    """出一种 webp 字节。走不走无损由调用方按「图形 / 照片」决定。

    为什么图形走无损：截图 / 平涂插画 / 像素画的有损编码会在硬边上留振铃、
    在纯色块里放噪点 —— 那正是点阵风最怕的；这类图的无损 webp 通常还比 PNG 小。
    """
    out = im if im.mode in ("RGB", "RGBA") else im.convert("RGBA")
    buf = io.BytesIO()
    if lossless:
        out.save(buf, "WEBP", lossless=True, method=WEBP_METHOD)
    else:
        out.save(buf, "WEBP", lossless=False, quality=quality, method=WEBP_METHOD)
    return buf.getvalue()


def compress(src, dst=None, long_edge=LONG_EDGE, quality=QUALITY,
             webp_dst=None, webp_quality=WEBP_QUALITY):
    """压一张图。dst 为 None 时只算不写（仍会返回结果）。

    两件事，互相独立：
      ① 原图那一份 —— 只做「尺寸超过上限就缩到上限」，保持原格式（老行为）。
      ② webp 兄弟 —— 给了 webp_dst 就在旁边出一张同名 .webp（正文插 <picture>，
         支持 webp 的浏览器只下它，不支持的拿原图兜底）。
    webp 按「理想尺寸」出（缩过的那张），和兜底原图尺寸可能不同 —— 长宽比一样，
    不影响排版，只是 webp 更小。
    """
    ext = os.path.splitext(src)[1].lower()
    before = os.path.getsize(src)
    fmt = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG"}.get(ext)

    if ext in SKIP_EXT:
        return {"ok": True, "changed": False, "webp": None,
                "reason": "这种格式不压（%s）" % ext}
    if fmt is None:
        return {"ok": True, "changed": False, "webp": None,
                "reason": "不认识的格式 %s，原样保留" % ext}

    im, frames = load_source(src)
    if frames > 1:
        return {"ok": True, "changed": False, "webp": None,
                "reason": "动图（%d 帧），不压以免破坏动画" % frames}
    if before < MIN_BYTES:
        return {"ok": True, "changed": False, "webp": None,
                "reason": "只有 %.1f KB，不值得压" % (before / 1024)}

    w0, h0 = im.size
    # 「图形」还是「照片」—— 用**源图**的颜色数判，别用缩完那张：
    # LANCZOS 会把平涂的硬边插值出上百万种颜色，按缩完的判会把图形误判成照片。
    graphic = fmt == "PNG" and count_colors(im, WEBP_LOSSLESS_COLORS) is not None
    res = {"ok": True, "changed": False, "webp": None}
    work = im
    kept = True                     # 兜底那份是不是原样保留的原图
    pixel = 1

    if max(w0, h0) > long_edge:
        pixel = integer_upscale_factor(im)

        # 只缩不放
        scale = long_edge / float(max(w0, h0))
        nw, nh = max(1, round(w0 * scale)), max(1, round(h0 * scale))
        # 像素画按整数倍缩，避免出现半格 —— 那会让点阵边缘糊或错位
        if pixel > 1:
            px_w = max(pixel, int(round(nw / float(pixel))) * pixel)
            px_h = max(pixel, int(round(nh / float(pixel))) * pixel)
            nw, nh = px_w, px_h

        work = im.resize((nw, nh), Image.NEAREST if pixel > 1 else Image.LANCZOS)
        data = encode(work, fmt, quality)

        # 没有变小就保留原图 —— 重编码只会让它更大（有的图本来就已经优化过）
        if len(data) >= before:
            res["reason"] = ("缩完反而更大（%.1f KB -> %.1f KB），保留原图"
                             % (before / 1024, len(data) / 1024))
            res["after"] = len(data)
        else:
            kept = False
            res.update({"changed": True, "before": before, "after": len(data),
                        "from": [w0, h0], "to": [nw, nh], "format": fmt, "pixel": pixel})
            if dst is None:
                res["dry"] = True
            else:
                atomic_write(dst, data)
    else:
        # 尺寸本来就不超上限 —— 原图完全不动。
        # 不做「无意义的重编码」：那只会引入一次有损损失、却省不下多少
        # （实测把 1434x1410 的 PNG 重存一遍只小 3%）。
        res["reason"] = "尺寸 %dx%d 没超上限 %d，不动" % (w0, h0, long_edge)

    # ---------- webp 兄弟 ----------
    if webp_dst is not None:
        fallback = before if kept else res["after"]
        # 用哪张图、走不走无损，都在这里定：
        #   图形且本来就不大 → 原尺寸 + 无损（线条清晰、像素零损失）
        #   其余（照片 / 超大图） → 缩到上限 + 有损 q82（靠尺寸和量化省）
        if graphic and max(w0, h0) <= WEBP_KEEP_FULL_EDGE:
            src_im, lossless = im, True
        else:
            src_im, lossless = work, False
        wb = encode_webp(src_im, lossless, webp_quality)
        if len(wb) < fallback:
            atomic_write(webp_dst, wb)
            res["webp"] = {
                "bytes": len(wb), "lossless": lossless,
                "saving": fallback - len(wb),
                "saving_pct": round(100.0 * (1 - len(wb) / float(fallback))),
                "from": [w0, h0], "to": [src_im.size[0], src_im.size[1]],
            }
        else:
            res["webp_reason"] = ("webp 没有更小（%.1f KB vs %.1f KB），只用原图"
                                  % (len(wb) / 1024, fallback / 1024))

    return res


def main():
    ap = argparse.ArgumentParser(description="压缩上传的图片（保持原格式；可选再出一张 webp）")
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--long-edge", type=int, default=LONG_EDGE)
    ap.add_argument("--quality", type=int, default=QUALITY)
    ap.add_argument("--in-place", action="store_true",
                    help="压完直接替换原文件（先写临时文件再原子替换）")
    ap.add_argument("--webp", default=None, metavar="路径",
                    help="顺便出一张 webp（上传时会放在原图旁边、同名 .webp）")
    ap.add_argument("--webp-quality", type=int, default=WEBP_QUALITY,
                    help="有损 webp 的质量（默认 %(default)s；PNG 走无损时用不到）")
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        sys.stdout.write(json.dumps({"ok": False, "error": "找不到文件：%s" % args.src},
                                    ensure_ascii=False))
        return 1

    dst = args.src if args.in_place else args.dst
    if not args.in_place and not dst:
        # 没给 dst 就当 dry-run 算一遍（编辑器有时只想先看看能省多少）
        dst = None

    try:
        r = compress(args.src, dst, args.long_edge, args.quality,
                     webp_dst=args.webp, webp_quality=args.webp_quality)
    except Exception as e:                              # pragma: no cover
        r = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(r, ensure_ascii=False))
    sys.stdout.flush()
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
