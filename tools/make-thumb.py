#!/usr/bin/env python3
"""给画廊生成缩略图。

    python tools/make-thumb.py <原图> <输出.webp> [宽度]

为什么需要它：Hugo 的图片处理管线读不到 static/ 下的图（resources.Get
只认 assets/），而 hugo 命令行也没有图片处理子命令。但画廊要是直接上原图，
60 张画就是 40MB+，所以缩略图在「上传那一刻」就生成好，静态发出去。

依赖只有 Pillow（这台机器上本来就有，tools/build-pkmn.py 也用它）。
macOS 上没装就 `pip3 install Pillow`。

规则：
  · 输出 webp，长边按给定宽度等比缩（默认 520），质量 82
  · 原图本来就比目标宽度小 -> 不放大，原样另存（这种情况下直接引用原图更省事，
    调用方可以看返回的 resized 字段决定）
  · 动图（多帧）只取第一帧 —— 画廊里不需要会动的缩略图，原图点开还是动的
  · 成功/失败都往 stdout 打一行 JSON，编辑器按这个判断
"""
import io
import json
import os
import sys


def fail(msg, code=1):
    sys.stdout.write(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.stdout.flush()
    return code


def main():
    if len(sys.argv) < 3:
        return fail("用法：make-thumb.py <原图> <输出.webp> [宽度]")
    src, dst = sys.argv[1], sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 520

    if not os.path.isfile(src):
        return fail("找不到原图：%s" % src)

    try:
        from PIL import Image
    except ImportError:
        return fail("没装 Pillow（pip3 install Pillow）")

    try:
        im = Image.open(src)
        im.load()
    except Exception as e:
        return fail("打不开这个图片：%s" % e)

    frames = getattr(im, "n_frames", 1)
    if frames > 1:
        # 动图或多帧图：只留第一帧
        try:
            im.seek(0)
        except Exception:
            pass

    w, h = im.size

    # 太小的图不做缩略图：色板、1px 分隔线这类（实测有 8x8 和 1x15 的），
    # 缩了也没有意义，只会在 thumbs/ 里堆一堆几十字节的垃圾。
    MIN_EDGE = 48
    if w < MIN_EDGE and h < MIN_EDGE:
        out = {
            "ok": True,
            "skipped": "原图只有 %dx%d，用原图就行" % (w, h),
            "src": os.path.basename(src),
            "srcBytes": os.path.getsize(src),
            "resized": False,
        }
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
        sys.stdout.flush()
        return 0

    resized = False
    if w > width:
        new_h = max(1, round(h * width / w))
        im = im.resize((width, new_h), Image.LANCZOS)
        resized = True

    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA")

    # webp 的 alpha 支持没问题；但对不透明的图用 RGB 更小
    has_alpha = im.mode == "RGBA" and im.getchannel("A").getextrema()[0] < 255
    if not has_alpha:
        im = im.convert("RGB")

    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
    tmp = dst + ".tmp"
    try:
        im.save(tmp, "WEBP", quality=82, method=5)
    except Exception as e:
        return fail("写不出 webp：%s" % e)

    src_bytes = os.path.getsize(src)
    dst_bytes = os.path.getsize(tmp)

    # 本来就没缩小、而且 webp 还比原图大 -> 这份缩略图没用，删掉。
    # （实测：已经压过的 256x256 png 转 webp 会变大，留着反而多背几 KB）
    if not resized and dst_bytes >= src_bytes:
        try:
            os.remove(tmp)
        except OSError:
            pass
        out = {
            "ok": True,
            "skipped": "没缩小而且更大（%d -> %d 字节），用原图更省" % (src_bytes, dst_bytes),
            "src": os.path.basename(src),
            "srcBytes": src_bytes,
            "resized": False,
        }
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
        sys.stdout.flush()
        return 0

    os.replace(tmp, dst)

    out = {
        "ok": True,
        "src": os.path.basename(src),
        "dst": os.path.basename(dst),
        "srcBytes": src_bytes,
        "dstBytes": dst_bytes,
        "srcSize": [w, h],
        "dstSize": [im.size[0], im.size[1]],
        "frames": frames,
        "resized": resized,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
