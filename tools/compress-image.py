#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""压缩上传的图片 —— 「上传那一刻」就把过大的图压下来。

    python tools/compress-image.py <输入文件> <输出文件> [--long-edge 1600] [--quality 85]
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

输出：一行 JSON（编辑器按这个判断）
    {"ok": true, "changed": true,  "before": 1174318, "after": 841000,
     "from": [1917,1325], "to": [1600,1106], "format": "PNG", "pixel": 1}
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


def compress(src, dst=None, long_edge=LONG_EDGE, quality=QUALITY):
    """压一张图。dst 为 None 时只算不写（仍会返回结果）。"""
    ext = os.path.splitext(src)[1].lower()
    before = os.path.getsize(src)
    fmt = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG"}.get(ext)

    if ext in SKIP_EXT:
        return {"ok": True, "changed": False, "reason": "这种格式不压（%s）" % ext}
    if fmt is None:
        return {"ok": True, "changed": False, "reason": "不认识的格式 %s，原样保留" % ext}

    im, frames = load_source(src)
    if frames > 1:
        return {"ok": True, "changed": False, "reason": "动图（%d 帧），不压以免破坏动画" % frames}
    if before < MIN_BYTES:
        return {"ok": True, "changed": False, "reason": "只有 %.1f KB，不值得压" % (before / 1024)}

    w0, h0 = im.size

    # 尺寸本来就不超上限、且文件不大 —— 完全不动。
    # 不做「无意义的重编码」：那只会引入一次有损损失、却省不下多少
    # （实测把 1434x1410 的 PNG 重存一遍只小 3%）。
    if max(w0, h0) <= long_edge:
        return {"ok": True, "changed": False,
                "reason": "尺寸 %dx%d 没超上限 %d，不动" % (w0, h0, long_edge)}

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
        return {"ok": True, "changed": False,
                "reason": "缩完反而更大（%.1f KB -> %.1f KB），保留原图"
                          % (before / 1024, len(data) / 1024),
                "before": before, "after": len(data)}

    if dst is None:
        return {"ok": True, "changed": True, "dry": True,
                "before": before, "after": len(data),
                "from": [w0, h0], "to": [nw, nh], "format": fmt, "pixel": pixel}

    tmp = dst + ".tmp"
    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, dst)
    return {"ok": True, "changed": True,
            "before": before, "after": len(data),
            "from": [w0, h0], "to": [nw, nh], "format": fmt, "pixel": pixel}


def main():
    ap = argparse.ArgumentParser(description="压缩上传的图片（保持原格式）")
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?")
    ap.add_argument("--long-edge", type=int, default=LONG_EDGE)
    ap.add_argument("--quality", type=int, default=QUALITY)
    ap.add_argument("--in-place", action="store_true",
                    help="压完直接替换原文件（先写临时文件再原子替换）")
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
        r = compress(args.src, dst, args.long_edge, args.quality)
    except Exception as e:                              # pragma: no cover
        r = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    sys.stdout.write(json.dumps(r, ensure_ascii=False))
    sys.stdout.flush()
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
