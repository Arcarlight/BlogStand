#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成布告栏的像素素材：木框、板面、拱板、木柱、藤、草地、卵石、图钉、纸纹。

    python3.12 tools/build-board-art.py            # 生成
    python3.12 tools/build-board-art.py --dry-run  # 只报告，不写文件

产出（都在 static/images/board/ 下）：
    surface.png      64x64   板面木纹（1:1 平铺）
    frame.png        96x96   画框，九宫格每格 32px（整页用）
    frame-thin.png   48x48   同上 16px 厚（首页缩略版、窄屏用）
    arch.png         300x34  板子上沿的拱形线脚
    beam.png         64x26   顶梁（横向平铺）
    post-cap.png     24x20   木柱圆头；post-body.png 24x24 柱身（纵向平铺）
    vine-left/right  44x60   上角缠的藤
    vine-bot-*       44x60   翻过来的藤（下角用）
    drape*.png       46x116  从上垂下来的藤（三种样式）
    bush.png         44x30   灌木丛；bush-big.png 74x50 大灌木
    ground.png       64x130  板子前面那一整片草地（横向平铺）
    cobble.png       52x26   一堆淡黄卵石；rock.png 24x16、rock2.png 36x24 石头
    tuft.png         24x22   一簇草；flower.png 44x30 一丛花；sprig.png 34x28 小叶
    wall.png         96x48   背后的砖墙（横竖平铺）
    pin-*.png        16x16   图钉（红/蓝/黄）
    paper.png        48x48   做旧纸纹

两条硬规矩：
  1. **像素大小必须统一**。所有图都按 1:1 显示，CSS 里不许再用 background-size
     缩放它们。曾经板面 3 倍、图钉 2 倍、别的 1 倍混着用，整幅画看着发脏。
  2. **站在地上的东西要有接地阴影**。石头、灌木、草丛、花、卵石底部都画了两行
     抖动过的暗绿（shadow_row），否则它们看着是"悬空"贴在草地上的。

配色全部是从站长给的参考图上取样（中位切分量化 + 分区域取主色）来的。
"""
import argparse
import math
import os
import random
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "static", "images", "board")

SEED = 20261012


# ---------------------------------------------------------------- 极简 PNG 写入
def write_png(path, w, h, get_pixel):
    """get_pixel(x, y) -> (r, g, b, a)，直接按 RGBA 写一张真彩 PNG。"""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b, a = get_pixel(x, y)
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def hexrgb(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def clamp(ch):
    return max(0, min(255, int(round(ch))))


def get_from(buf):
    def get(x, y):
        return buf.get((x, y), (0, 0, 0, 0))
    return get


def shadow_row(buf, W, H, inset=1, rows=2, tone="#8f9c16"):
    """接地阴影：底部几行画抖动的暗色，让东西看着是"坐"在地上，不是飘着。"""
    c = hexrgb(tone) + (255,)
    for i in range(rows):
        y = H - 1 - i
        for x in range(inset, max(inset + 1, W - inset)):
            if i == 0 or (x + y) % 2 == 0:
                if (x, y) in buf:
                    buf[(x, y)] = c


# -------------------------------------------------------------------- 板面
SURF_W = SURF_H = 64
SURF_BASE = "#e0942c"          # 木底（板面区块取样）
SURF_LIGHT = "#f1b848"         # 亮一块
SURF_DARK = "#d99d3e"          # 暗一块
SURF_DEEP = "#c3762b"          # 再暗一块
SURF_PIN = "#a8661f"           # 板面上稀疏的小暗点


def surface_pixel_factory():
    """木纹板面：平的底子 + 块状深浅斑驳 + 几粒小暗点（不是逐像素噪声）。"""
    rng = random.Random(SEED + 11)
    W, H = SURF_W, SURF_H
    tones = [hexrgb(SURF_LIGHT), hexrgb(SURF_DARK), hexrgb(SURF_DEEP)]
    base = hexrgb(SURF_BASE)
    pin = hexrgb(SURF_PIN)
    patch = {}
    for _ in range(46):
        x0, y0 = rng.randrange(W), rng.randrange(H)
        w, h = rng.randrange(2, 7), rng.randrange(2, 7)
        c = tones[rng.choices((0, 1, 2), (4, 4, 2))[0]]
        for dy in range(h):
            for dx in range(w):
                patch[((x0 + dx) % W, (y0 + dy) % H)] = c
    dots = set()
    for _ in range(9):
        dots.add((rng.randrange(W), rng.randrange(H)))

    def get(x, y):
        if (x, y) in dots:
            return pin + (255,)
        c = patch.get((x, y), base)
        v = math.sin(2 * math.pi * x / W) * 3.0 + math.sin(2 * math.pi * y / H) * 3.0
        return tuple(clamp(ch + v) for ch in c) + (255,)

    return get


# ------------------------------------------------------------------ 做旧纸纹
PAPER_W = PAPER_H = 48
PAPER_TONES = ["#e5dabd", "#eee4cd", "#f2e9d4", "#f2e9d4", "#f2e9d4", "#f8f2e2"]


def paper_pixel_factory():
    rng = random.Random(SEED + 7)
    spec = {}
    for y in range(PAPER_H):
        for x in range(PAPER_W):
            r = rng.random()
            if r < 0.05:
                spec[(x, y)] = 0
            elif r < 0.11:
                spec[(x, y)] = 1
            elif r < 0.16:
                spec[(x, y)] = 5
    for _ in range(14):
        x0, y0 = rng.randrange(PAPER_W), rng.randrange(PAPER_H)
        for k in range(rng.randrange(2, 5)):
            spec[((x0 + k) % PAPER_W, y0)] = 0

    def get(x, y):
        return hexrgb(PAPER_TONES[spec.get((x, y), 2)]) + (255,)

    return get


# -------------------------------------------------------------------- 画框
# 九宫格（每格 thickness px），CSS 用 border-image: <t> / <t>px repeat。
# 木质：剖面是"受光斜面 → 主面 → 凹槽 → 外面那道面"，纹路靠让剖面分界
# 随长度摆动做出来（不是逐像素噪声 —— 那会变成一团沙子）。
FRAME = 96
SLICE = 32
W_INNER = "#8f4f2c"
W_LEDGE = "#e0c8a8"
W_FACE = "#f1b040"
W_GROOVE = "#c89c54"
W_LEDGE2 = "#d99830"
W_EDGE = "#b57d2e"
W_OUT = "#8f4f2c"
FRAME_PROFILE = [(1, W_INNER), (5, W_LEDGE), (10, W_FACE), (13, W_GROOVE),
                 (22, W_FACE), (25, W_LEDGE2), (28, W_EDGE), (31, W_OUT)]


def _frame_profile(p):
    for limit, c in FRAME_PROFILE:
        if p <= limit:
            return c
    return W_OUT


def frame_pixel_factory(thickness=SLICE):
    W = H = thickness * 3
    SL = thickness
    scale = thickness / 32.0
    rng = random.Random(SEED + 31)
    noise = {}
    for i in range(4):
        for j in range(W // 8 + 2):
            noise[(i, j)] = rng.random()

    def vnoise(x, y):
        gx, gy = x / 8.0, y / 8.0
        x0, y0 = int(gx), int(gy)
        fx, fy = gx - x0, gy - y0
        sx = fx * fx * (3 - 2 * fx)
        sy = fy * fy * (3 - 2 * fy)

        def h(i, j):
            return noise[(i % 4, j)]

        v00, v10, v01, v11 = h(x0, y0), h(x0 + 1, y0), h(x0, y0 + 1), h(x0 + 1, y0 + 1)
        return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy

    def tint(hexc, amt):
        r, g, b = hexrgb(hexc)
        return (clamp(r + amt), clamp(g + amt), clamp(b + amt), 255)

    buf = {}

    def put(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            buf[(x, y)] = c

    for y in range(H):
        for x in range(W):
            dx = max(0, SL - x, x - (W - SL - 1))
            dy = max(0, SL - y, y - (H - SL - 1))
            p = (dx * dx + dy * dy) ** 0.5
            if p > SL - 0.5:
                continue                       # 外角留透明 → 圆角
            along = x if (y < SL or y >= H - SL) else y
            wob = (2.2 * math.sin(2 * math.pi * along / 32)
                   + 0.9 * math.sin(2 * math.pi * along / 16 + 1.1))
            base = _frame_profile((p + wob * scale) / scale)
            amt = int(round((vnoise(x, y) - 0.5) * 10))
            if 6 <= p / scale <= 24:
                g = (p / scale * 0.42 + 0.75 * math.sin(2 * math.pi * along / 32)
                     + 0.35 * math.sin(2 * math.pi * along / 16 + 0.6))
                gv = (math.sin(2 * math.pi * g / 3.1)
                      + 0.6 * math.sin(2 * math.pi * g / 1.7 + 1.2))
                if gv > 1.45:
                    amt -= 9
                elif gv < -1.55:
                    amt += 8
            put(x, y, tint(base, amt))

    return get_from(buf)


# -------------------------------------------------------------------- 拱板
ARCH_W, ARCH_H = 300, 34
ARCH_OUT = "#8f4f2c"
ARCH_CREAM = "#f0c450"
ARCH_FACE = "#e99828"
ARCH_MID = "#d99830"
ARCH_DARK = "#ac632d"


def arch_pixel_factory():
    W, H = ARCH_W, ARCH_H
    buf = {}

    def put(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            buf[(x, y)] = hexrgb(c) + (255,)

    profile = [ARCH_OUT, ARCH_CREAM, ARCH_CREAM, ARCH_FACE, ARCH_FACE, ARCH_FACE,
               ARCH_FACE, ARCH_FACE, ARCH_FACE, ARCH_MID, ARCH_MID, ARCH_DARK,
               ARCH_DARK, ARCH_MID, ARCH_FACE, ARCH_FACE, ARCH_FACE, ARCH_FACE,
               ARCH_FACE, ARCH_FACE]
    for x in range(W):
        t = 2.0 * x / (W - 1) - 1.0
        top = int(round(2 + 9 * t * t))
        for i, c in enumerate(profile):
            put(x, top + i, c)
        put(x, top + len(profile), ARCH_OUT)
    for cx, cy in ((W // 2 - 42, 16), (W // 2 - 38, 17), (W // 2 + 40, 16),
                   (W // 2 + 44, 17), (W // 2 - 2, 12)):
        for dy in (-1, 0, 1):
            for dx in (-2, -1, 0, 1, 2):
                put(cx + dx, cy + dy, ARCH_DARK)

    return get_from(buf)


# ------------------------------------------------------------------ 顶梁
BEAM_W, BEAM_H = 64, 26
BEAM_OUT = "#5f5310"
BEAM_LIGHT = "#b6cb22"
BEAM_FACE = "#b9a818"
BEAM_DARK = "#a99818"
BEAM_DEEP = "#8f7d16"


def beam_pixel_factory():
    W, H = BEAM_W, BEAM_H
    buf = {}

    def put(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            buf[(x, y)] = hexrgb(c) + (255,)

    for y in range(H):
        for x in range(W):
            if y < 2:
                c = BEAM_OUT
            elif y < 4:
                c = BEAM_LIGHT
            elif y < 7:
                c = BEAM_LIGHT if y < 5 else BEAM_FACE
            elif y < H - 6:
                c = BEAM_FACE
            elif y < H - 3:
                c = BEAM_DARK
            else:
                c = BEAM_DEEP
            put(x, y, c)
    for k in range(10):
        x = (k * 7 + (k % 3) * 2) % W
        y0 = 6 + (k % 4)
        for dy in range(3 + (k % 3)):
            put(x, y0 + dy, BEAM_DARK)
            put((x + 1) % W, y0 + dy, BEAM_DEEP if k % 2 else BEAM_DARK)

    return get_from(buf)


# ------------------------------------------------------------------ 木柱
POST_W = 24
POST_CAP_H = 20
POST_BODY_H = 24
POST_OUT = "#5f5310"
POST_LIGHT = "#b6cb22"
POST_FACE = "#b9a818"
POST_DARK = "#a99818"
POST_DEEP = "#8f7d16"


def _post_column(buf, W, y0, y1, put):
    for y in range(y0, y1):
        put(0, y, POST_OUT)
        put(1, y, POST_LIGHT)
        put(2, y, POST_FACE)
        wave = 1 if ((y % POST_BODY_H) % 15) < 5 else 0
        put(3 + wave, y, POST_DARK)
        put(7 + ((y % POST_BODY_H) % 11), y, POST_DEEP)
        for x in range(3, W - 2):
            if x != 3 + wave and x != 7 + ((y % POST_BODY_H) % 11):
                put(x, y, POST_FACE)
        put(W - 2, y, POST_DEEP)
        put(W - 1, y, POST_OUT)


def post_body_pixel_factory():
    W, H = POST_W, POST_BODY_H
    buf = {}

    def put(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            buf[(x, y)] = c if not isinstance(c, str) else hexrgb(c) + (255,)

    _post_column(buf, W, 0, H, put)
    return get_from(buf)


def post_cap_pixel_factory():
    W, H = POST_W, POST_CAP_H
    buf = {}

    def put(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            buf[(x, y)] = c if not isinstance(c, str) else hexrgb(c) + (255,)

    _post_column(buf, W, 0, H, put)
    for y in range(H):
        t = y / float(H)
        cut = int(round((1 - t ** 0.55) * (W / 2 - 2)))
        for x in range(W):
            if x < cut or x >= W - cut:
                buf.pop((x, y), None)
    for x in range(W):
        for y in (0, 1, 2):
            if (x, y) in buf:
                buf[(x, y)] = hexrgb(POST_OUT) + (255,)
        for y in (3, 4):
            if (x, y) in buf:
                buf[(x, y)] = hexrgb(POST_LIGHT) + (255,)
    return get_from(buf)


# -------------------------------------------------------------------- 藤蔓
VINE_W, VINE_H = 44, 60
VINE_STEM = "#8a5a22"
LEAF_OUTLINE = "#294b22"
LEAF_LIGHT = "#8ae04a"
LEAF_HI = "#57d221"
LEAF_MID = "#64ab18"
LEAF_DARK = "#4f7a24"


def _leaf(buf, cx, cy, angle_deg, half_len, half_wid, W, H,
          outline=None, light=None, mid=None, dark=None):
    """按角度画一片叶子：旋转过的椭圆 + 描边 + 中脉。颜色可以临时换。"""
    outline = outline or LEAF_OUTLINE
    light = light or LEAF_LIGHT
    mid = mid or LEAF_MID
    dark = dark or LEAF_DARK
    rad = angle_deg * math.pi / 180.0
    ca, sa = math.cos(rad), math.sin(rad)
    reach = int(half_len + half_wid + 2)
    for y in range(int(cy - reach), int(cy + reach + 1)):
        for x in range(int(cx - reach), int(cx + reach + 1)):
            dx, dy = x - cx, y - cy
            u = dx * ca + dy * sa
            v = -dx * sa + dy * ca
            e = (u / half_len) ** 2 + (v / half_wid) ** 2
            if e > 1.0:
                continue
            if e > 0.70:
                c = outline
            elif abs(v) < half_wid * 0.22 and e < 0.75:
                c = light
            elif e < 0.34:
                c = mid
            else:
                c = dark if (v > 0 and u > 0) else mid
            if 0 <= x < W and 0 <= y < H:
                buf[(x, y)] = hexrgb(c) + (255,)


def vine_pixel_factory():
    W, H = VINE_W, VINE_H
    buf = {}
    p0, p1, p2 = (W - 6, H - 4), (6, H - 22), (26, 4)
    stem = hexrgb(VINE_STEM) + (255,)
    for i in range(121):
        t = i / 120.0
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
        for dx in (0, 1):
            for dy in (0, 1):
                xi, yi = int(x) + dx, int(y) + dy
                if 0 <= xi < W and 0 <= yi < H:
                    buf[(xi, yi)] = stem
    for cx, cy, ang, hl, hw in [(30, 50, -35, 9, 5), (16, 40, -70, 8, 4.5),
                                (13, 26, -30, 8, 4.5), (22, 16, 25, 8, 4.5),
                                (30, 7, 70, 7, 4), (36, 30, 30, 8, 4.5)]:
        _leaf(buf, cx, cy, ang, hl, hw, W, H)
    return get_from(buf)


def vine_right_pixel_factory():
    left = vine_pixel_factory()

    def get(x, y):
        return left(VINE_W - 1 - x, y)

    return get


def vine_bottom_pixel_factory(mirror=False):
    top = vine_pixel_factory()

    def get(x, y):
        xx = (VINE_W - 1 - x) if mirror else x
        return top(xx, VINE_H - 1 - y)

    return get


# ------------------------------------------------------------------ 垂藤
DRAPE_W, DRAPE_H = 46, 116
DRAPE_STYLES = {
    "drape": dict(sway=5, pal=(LEAF_OUTLINE, LEAF_LIGHT, LEAF_MID, LEAF_DARK),
                  leaves=[(10, 14, -25, 11, 6), (18, 26, 165, 10, 5.5), (11, 40, -15, 10, 5.5),
                          (19, 52, 155, 9, 5), (12, 66, -20, 9, 5), (20, 78, 160, 8, 4.5),
                          (13, 92, -10, 8, 4.5), (19, 106, 170, 7, 4), (15, 116, -20, 5, 3)]),
    "drape-dark": dict(sway=7, pal=(LEAF_OUTLINE, LEAF_MID, LEAF_DARK, LEAF_OUTLINE),
                       leaves=[(9, 12, -35, 12, 6.5), (19, 26, 150, 11, 6), (11, 42, -10, 11, 6),
                               (20, 56, 160, 10, 5.5), (12, 72, -25, 9, 5), (21, 86, 170, 8, 4.5),
                               (14, 100, -15, 7, 4), (20, 112, 165, 5.5, 3.5)]),
    "drape-young": dict(sway=4, pal=(LEAF_OUTLINE, LEAF_LIGHT, LEAF_HI, LEAF_MID),
                        leaves=[(11, 12, -20, 10, 5.5), (18, 24, 160, 9, 5), (12, 38, -25, 9, 5),
                                (19, 50, 150, 8, 4.5), (13, 64, -15, 8, 4.5), (20, 76, 165, 7, 4),
                                (14, 90, -30, 6, 3.5), (19, 104, 155, 5, 3)]),
}


def drape_pixel_factory(style="drape"):
    cfg = DRAPE_STYLES[style]
    W, H = DRAPE_W, DRAPE_H
    buf = {}
    stem = hexrgb(VINE_STEM) + (255,)
    for i in range(H):
        x = 12 + int(round(cfg["sway"] * math.sin(i / 20.0)))
        for dx in (0, 1):
            if 0 <= x + dx < W:
                buf[(x + dx, i)] = stem
    outline, light, mid, dark = cfg["pal"]
    for cx, cy, ang, hl, hw in cfg["leaves"]:
        _leaf(buf, cx, cy, ang, hl, hw, W, H, outline, light, mid, dark)
    return get_from(buf)


# ------------------------------------------------------------------ 灌木
BUSH_W, BUSH_H = 44, 30
BUSH_OUT = "#294b22"
BUSH_DARK = "#2e6b22"
BUSH_MID = "#4f9a28"
BUSH_LIGHT = "#6cc02a"
BUSH_HI = "#8ae04a"


def _bush(W, H, seed, r_big, r_small, count):
    rng = random.Random(seed)
    buf = {}

    def blob(cx, cy, r, c):
        for y in range(int(cy - r), int(cy + r + 2)):
            for x in range(int(cx - r), int(cx + r + 2)):
                dx, dy = x - cx, y - cy
                if (dx * dx + dy * dy) <= r * r + 0.5 and 0 <= x < W and 0 <= y < H:
                    buf[(x, y)] = hexrgb(c) + (255,)

    blob(W / 2, H - r_big * 0.55, r_big, BUSH_DARK)
    blob(W / 2, H - r_big * 0.75, r_big - 2, BUSH_MID)
    for _ in range(count):
        blob(rng.uniform(r_small, W - r_small), rng.uniform(H - r_big * 1.5, H - r_small * 0.6),
             rng.uniform(r_small * 0.8, r_small * 1.3),
             rng.choice((BUSH_DARK, BUSH_MID, BUSH_LIGHT)))
    for _ in range(count):
        blob(rng.uniform(r_small, W - r_small), rng.uniform(H - r_big * 1.3, H - r_small),
             rng.uniform(r_small * 0.5, r_small * 0.8), rng.choice((BUSH_LIGHT, BUSH_HI)))
    for x in range(W):                       # 底边压暗
        for y in range(H - 3, H):
            if (x, y) in buf:
                buf[(x, y)] = hexrgb(BUSH_OUT) + (255,)
    shadow_row(buf, W, H, 1, 2)
    return buf


def bush_pixel_factory():
    return get_from(_bush(BUSH_W, BUSH_H, SEED + 77, 13, 7, 8))


BIGBUSH_W, BIGBUSH_H = 74, 50


def bigbush_pixel_factory():
    return get_from(_bush(BIGBUSH_W, BIGBUSH_H, SEED + 211, 22, 10, 14))


# ---------------------------------------------------- 板子下角那种茂密树丛
CORNER_W, CORNER_H = 112, 72


def _bush_corner(W, H, seed):
    """板子左下/右下角用来"压住墙角"的树丛。

    **只画色块，不画一片片叶子。** 站长看过带叶子碎片的版本，说显乱 ——
    他要的是干干净净的一坨：暗底、中绿主体、左上受光、下缘接地阴影。
    轮廓的毛糙感靠各层色块半径的差异做，不靠往外飘的叶子。"""
    rng = random.Random(seed)
    buf = {}

    def blob(cx, cy, r, c):
        for y in range(int(cy - r), int(cy + r + 2)):
            for x in range(int(cx - r), int(cx + r + 2)):
                dx, dy = x - cx, y - cy
                if (dx * dx + dy * dy) <= r * r + 0.5 and 0 <= x < W and 0 <= y < H:
                    buf[(x, y)] = hexrgb(c) + (255,)

    # ① 最暗的底盘：宽扁，把下缘撑满，边缘用半径差异做出毛糙感
    for cx, cy, rr in ((0.50, 0.88, 0.30), (0.20, 0.86, 0.20), (0.80, 0.86, 0.20),
                       (0.35, 0.90, 0.19), (0.65, 0.90, 0.19), (0.08, 0.90, 0.13),
                       (0.92, 0.90, 0.13)):
        blob(W * cx, H * cy, H * rr, BUSH_OUT)

    # ② 主体：中绿，堆成一个鼓起来的大团
    for cx, cy, rr in ((0.50, 0.62, 0.30), (0.26, 0.64, 0.23), (0.74, 0.64, 0.23),
                       (0.38, 0.44, 0.21), (0.62, 0.44, 0.21), (0.50, 0.30, 0.17),
                       (0.18, 0.74, 0.19), (0.82, 0.74, 0.19)):
        blob(W * cx, H * cy, H * rr, BUSH_DARK)
    for cx, cy, rr in ((0.48, 0.60, 0.25), (0.28, 0.62, 0.18), (0.72, 0.62, 0.18),
                       (0.44, 0.38, 0.16), (0.58, 0.36, 0.14), (0.22, 0.72, 0.14),
                       (0.78, 0.72, 0.14)):
        blob(W * cx, H * cy, H * rr, BUSH_MID)

    # ③ 受光面：光从左上来。只画在主体内部，别在顶上留飘着的亮块。
    def inside(x, y, pad=2):
        return pad <= x < W - pad and pad <= y < H - pad and (int(x), int(y)) in buf

    for _ in range(90):
        cx = rng.uniform(W * 0.10, W * 0.84); cy = rng.uniform(H * 0.24, H * 0.62)
        if not inside(cx, cy, 4):
            continue
        blob(cx, cy, rng.uniform(4.0, 7.5),
             rng.choice((BUSH_LIGHT, BUSH_LIGHT, BUSH_MID, BUSH_HI)))

    # ④ 下缘压暗 + 接地阴影（不然整坨像悬在草地上）
    for x in range(W):
        for y in range(H - 3, H):
            if (x, y) in buf:
                buf[(x, y)] = hexrgb(BUSH_OUT) + (255,)
    shadow_row(buf, W, H, 1, 2)
    return buf


def corner_bush_pixel_factory():
    return get_from(_bush_corner(CORNER_W, CORNER_H, SEED + 409))


# -------------------------------------------------------------------- 草地
# 色和纹理都照站长的绿地参考图：底色 #b0c019，细密点纹，草丛满地
GROUND_W, GROUND_H = 64, 130
G_BASE = "#b0c019"
G_DARK = "#a0b019"
G_LIGHT = "#c0d128"
G_HI = "#c2f73a"
G_TUFT = "#9da620"
G_DIRT = "#907030"
G_SOIL = "#c98a35"
G_SOIL_D = "#a86a24"


def ground_pixel_factory():
    rng = random.Random(SEED + 401)
    W, H = GROUND_W, GROUND_H
    base, dark, light, hi = (hexrgb(c) for c in (G_BASE, G_DARK, G_LIGHT, G_HI))
    tuft = hexrgb(G_TUFT)
    dirt = hexrgb(G_DIRT)
    soil, soil_d = hexrgb(G_SOIL), hexrgb(G_SOIL_D)
    buf = {}
    for y in range(H):
        for x in range(W):
            if (x + y * 3) % 4 == 0:
                c = dark
            elif (x * 3 + y) % 7 == 0:
                c = light
            else:
                c = base
            if y >= H - 6:
                c = soil_d
            elif y >= H - 16:
                c = soil
            buf[(x, y)] = c + (255,)
    for _ in range(46):
        buf[(rng.randrange(W), rng.randrange(H - 30))] = dirt + (255,)
    for _ in range(16):
        x, y = rng.randrange(W), rng.randrange(8, H - 20)
        for k in range(rng.randrange(3, 6)):
            bx, by = x + (k % 3) - 1, y - k // 2
            if 0 <= bx < W and 0 <= by < H:
                buf[(bx, by)] = (hi if k < 2 else tuft) + (255,)

    def get(x, y):
        return buf.get((x, y), base + (255,))

    return get


# ------------------------------------------------------------------ 卵石
# 参考图里地面上的石头是**淡黄色的圆卵石**，不是棕色大石头
COBBLE_W, COBBLE_H = 52, 26
C_HI = "#f1e058"
C_MID = "#e0dc50"
C_DARK = "#c8c02a"
C_OUT = "#8f8a1c"


def cobble_pixel_factory():
    W, H = COBBLE_W, COBBLE_H
    buf = {}
    hi, mid, dark, out = (hexrgb(c) for c in (C_HI, C_MID, C_DARK, C_OUT))

    def put(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            buf[(x, y)] = c + (255,)

    for (cx, cy, rx, ry) in ((W * 0.24, H - 6, W * 0.22, H * 0.52),
                             (W * 0.56, H - 7, W * 0.26, H * 0.60),
                             (W * 0.82, H - 5, W * 0.17, H * 0.40)):
        for y in range(H):
            for x in range(W):
                dx, dy = (x - cx) / rx, (y - cy) / ry
                d = dx * dx + dy * dy
                if d > 1.0:
                    continue
                if d > 0.72:
                    put(x, y, out)
                elif dy < -0.25 and dx < 0.05:
                    put(x, y, hi)
                elif dy > 0.35:
                    put(x, y, dark)
                else:
                    put(x, y, mid)
    shadow_row(buf, W, H, 3, 2)
    return get_from(buf)


# ------------------------------------------------------------------ 草簇
TUFT_W, TUFT_H = 24, 22


def tuft_pixel_factory():
    W, H = TUFT_W, TUFT_H
    buf = {}
    hi = hexrgb(G_HI)
    mid = hexrgb(G_TUFT)
    dark = hexrgb("#7f8c14")
    for i, (bx, h) in enumerate(((6, 13), (10, 19), (14, 16), (17, 12), (12, 10), (8, 9))):
        x = bx
        for k in range(h):
            if 0 <= x < W:
                buf[(x, H - 1 - k)] = (hi if k > h - 4 else (mid if k % 3 else dark)) + (255,)
            x += (1 if (i + k) % 5 == 0 else 0) - (1 if (i + k) % 7 == 0 else 0)
    shadow_row(buf, W, H, 3, 2)
    return get_from(buf)


# -------------------------------------------------------------------- 花
# 参考图的花：绿叶子打底，橙粉色的花瓣、黄心
FLOWER_W, FLOWER_H = 44, 30


def flower_pixel_factory():
    W, H = FLOWER_W, FLOWER_H
    buf = {}
    leaf = hexrgb("#62c21e")
    leaf_d = hexrgb("#4f8f18")
    leaf_out = hexrgb("#3f6b14")
    center = hexrgb("#f0c950")
    petal = (hexrgb("#e87c50"), hexrgb("#e888b0"), hexrgb("#e87c50"))

    def put(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            buf[(x, y)] = c + (255,)

    for i in range(9):
        bx = 5 + i * 4
        for k in range(6 + (i % 3) * 2):
            yy = H - 1 - k
            w = 1 + k // 3
            for dx in range(-w, w + 1):
                put(bx + dx, yy, leaf if k < 4 else leaf_d)
            put(bx - w, yy, leaf_out)
            put(bx + w, yy, leaf_out)
    for i, (cx, cy) in enumerate(((12, H - 17), (28, H - 20), (38, H - 14))):
        for dx in range(-3, 4):
            for dy in range(-3, 4):
                d = (dx * dx + dy * dy) ** 0.5
                if d > 3.2:
                    continue
                put(cx + dx, cy + dy, center if d < 1.4 else petal[i % 3])
        for dx, dy in ((-4, 0), (4, 0), (0, -4), (0, 4)):
            put(cx + dx, cy + dy, leaf_out)
    shadow_row(buf, W, H, 6, 2, "#7f8c14")
    return get_from(buf)


# ------------------------------------------------------------------ 小叶
SPRIG_W, SPRIG_H = 34, 28


def sprig_pixel_factory():
    W, H = SPRIG_W, SPRIG_H
    buf = {}
    stem = hexrgb(VINE_STEM) + (255,)
    for i in range(7):
        for dx in (0, 1):
            x, y = W // 2 + dx, H - 1 - i
            if 0 <= x < W and 0 <= y < H:
                buf[(x, y)] = stem
    for cx, cy, ang, hl, hw in [(16, 18, -84, 8, 4.5), (10, 21, -46, 7, 4), (23, 20, 44, 7, 4),
                                (16, 11, -92, 7, 4), (7, 13, -34, 6, 3.5), (26, 12, 32, 6, 3.5)]:
        _leaf(buf, cx, cy, ang, hl, hw, W, H)
    shadow_row(buf, W, H, 8, 2)
    return get_from(buf)


# ------------------------------------------------------------------ 石头
ROCK_W, ROCK_H = 24, 16
ROCK2_W, ROCK2_H = 36, 24
R_OUT = "#4f3a20"
R_DARK = "#7a5a3a"
R_MID = "#a8845c"
R_LIGHT = "#c8a878"


def _rock(W, H, specs):
    buf = {}
    out, dark, mid, light = (hexrgb(c) for c in (R_OUT, R_DARK, R_MID, R_LIGHT))

    def put(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            buf[(x, y)] = c + (255,)

    for (cx, cy, rx, ry) in specs:
        for y in range(H):
            for x in range(W):
                dx, dy = (x - cx) / rx, (y - cy) / ry
                if dx * dx + dy * dy > 1.0:
                    continue
                if dy < -0.35 and dx < 0.1:
                    put(x, y, light)
                elif dy > 0.25 or dx > 0.4:
                    put(x, y, dark)
                else:
                    put(x, y, mid)
    for y in range(H):
        for x in range(W):
            if (x, y) not in buf:
                continue
            if ((x, y + 1) not in buf or (x + 1, y) not in buf
                    or (x, y - 1) not in buf or (x - 1, y) not in buf):
                buf[(x, y)] = out + (255,)
    for x in range(W):
        for y in range(H - 2, H):
            if (x, y) in buf:
                buf[(x, y)] = out + (255,)
    shadow_row(buf, W, H, 2, 2)
    return buf


def rock_pixel_factory():
    return get_from(_rock(ROCK_W, ROCK_H, [(ROCK_W * 0.5, ROCK_H - 3, ROCK_W * 0.42, ROCK_H * 0.68)]))


def rock2_pixel_factory():
    return get_from(_rock(ROCK2_W, ROCK2_H, [(ROCK2_W * 0.36, ROCK2_H - 3, ROCK2_W * 0.32, ROCK2_H * 0.74),
                                             (ROCK2_W * 0.72, ROCK2_H - 3, ROCK2_W * 0.26, ROCK2_H * 0.58)]))


# -------------------------------------------------------------------- 砖墙
WALL_W, WALL_H = 96, 48
WALL_MORTAR = "#96521f"
WALL_TOP = "#f09736"
WALL_MID = "#e07728"
WALL_ALT = "#d8581f"
WALL_DARK = "#a84a1e"


def wall_pixel_factory():
    rng = random.Random(SEED + 131)
    W, H = WALL_W, WALL_H
    BW, BH = 48, 24
    mortar = hexrgb(WALL_MORTAR)
    buf = {}
    for by in range(H // BH + 1):
        offset = (by % 2) * (BW // 2)
        for bx in range(-1, W // BW + 1):
            x0 = bx * BW + offset
            tone = rng.choice((WALL_MID, WALL_MID, WALL_ALT))
            for y in range(BH):
                for x in range(BW):
                    xx, yy = (x0 + x) % W, (by * BH + y) % H
                    if x < 1 or y < 1:
                        buf[(xx, yy)] = mortar + (255,)
                    elif y >= BH - 1:
                        buf[(xx, yy)] = hexrgb(WALL_DARK) + (255,)
                    elif y < 3:
                        buf[(xx, yy)] = hexrgb(WALL_TOP) + (255,)
                    else:
                        buf[(xx, yy)] = hexrgb(tone) + (255,)

    def get(x, y):
        return buf.get((x, y), hexrgb(WALL_MID) + (255,))

    return get


# -------------------------------------------------------------------- 图钉
PIN = 16
PIN_R = 6.4
PIN_SHADOW = 2
PIN_PALETTE = {
    "red":    ("#e23b3b", "#ff9595", "#a01818", "#5e0d0d"),
    "blue":   ("#3f79d0", "#9cc2ff", "#22488f", "#102a5c"),
    "yellow": ("#efc331", "#fff0a8", "#b8860b", "#6b4b00"),
}


def pin_pixel_factory(name):
    base, light, dark, outline = (hexrgb(c) for c in PIN_PALETTE[name])
    cx = cy = 6.0

    def head(x, y):
        dx, dy = x - cx, y - cy
        d = (dx * dx + dy * dy) ** 0.5
        if d > PIN_R + 1.4:
            return None
        if d > PIN_R:
            return outline
        if dx < -0.6 and dy < -0.6 and d > PIN_R - 2.8:
            return light
        if (dx > 1.2 or dy > 1.2) and d > PIN_R - 2.0:
            return dark
        return base

    def get(x, y):
        c = head(x, y)
        if c:
            return c + (255,)
        if head(x - PIN_SHADOW, y - PIN_SHADOW):
            return (0, 0, 0, 70)
        return (0, 0, 0, 0)

    return get


# -------------------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(description="生成布告栏的像素素材")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    args = ap.parse_args()

    jobs = [
        ("surface.png", SURF_W, SURF_H, surface_pixel_factory()),
        ("paper.png", PAPER_W, PAPER_H, paper_pixel_factory()),
        ("frame.png", FRAME, FRAME, frame_pixel_factory(32)),
        ("frame-thin.png", 48, 48, frame_pixel_factory(16)),
        ("arch.png", ARCH_W, ARCH_H, arch_pixel_factory()),
        ("beam.png", BEAM_W, BEAM_H, beam_pixel_factory()),
        ("post-cap.png", POST_W, POST_CAP_H, post_cap_pixel_factory()),
        ("post-body.png", POST_W, POST_BODY_H, post_body_pixel_factory()),
        ("vine-left.png", VINE_W, VINE_H, vine_pixel_factory()),
        ("vine-right.png", VINE_W, VINE_H, vine_right_pixel_factory()),
        ("vine-bot-left.png", VINE_W, VINE_H, vine_bottom_pixel_factory(False)),
        ("vine-bot-right.png", VINE_W, VINE_H, vine_bottom_pixel_factory(True)),
        ("drape.png", DRAPE_W, DRAPE_H, drape_pixel_factory("drape")),
        ("drape-dark.png", DRAPE_W, DRAPE_H, drape_pixel_factory("drape-dark")),
        ("drape-young.png", DRAPE_W, DRAPE_H, drape_pixel_factory("drape-young")),
        ("bush.png", BUSH_W, BUSH_H, bush_pixel_factory()),
        ("bush-big.png", BIGBUSH_W, BIGBUSH_H, bigbush_pixel_factory()),
        ("bush-corner.png", CORNER_W, CORNER_H, corner_bush_pixel_factory()),
        ("ground.png", GROUND_W, GROUND_H, ground_pixel_factory()),
        ("cobble.png", COBBLE_W, COBBLE_H, cobble_pixel_factory()),
        ("tuft.png", TUFT_W, TUFT_H, tuft_pixel_factory()),
        ("flower.png", FLOWER_W, FLOWER_H, flower_pixel_factory()),
        ("sprig.png", SPRIG_W, SPRIG_H, sprig_pixel_factory()),
        ("rock.png", ROCK_W, ROCK_H, rock_pixel_factory()),
        ("rock2.png", ROCK2_W, ROCK2_H, rock2_pixel_factory()),
        ("wall.png", WALL_W, WALL_H, wall_pixel_factory()),
    ]
    for c in ("red", "blue", "yellow"):
        jobs.append(("pin-%s.png" % c, PIN, PIN, pin_pixel_factory(c)))

    if not args.dry_run:
        os.makedirs(OUT_DIR, exist_ok=True)

    total = 0
    for name, w, h, get in jobs:
        if args.dry_run:
            for y in range(h):
                for x in range(w):
                    get(x, y)
            print("[dry-run] %-16s %dx%d" % (name, w, h))
            continue
        size = write_png(os.path.join(OUT_DIR, name), w, h, get)
        total += size
        print("%-16s %dx%d  %5d B" % (name, w, h, size))

    if not args.dry_run:
        print("共 %d 个文件，%d B（%.1f KB）" % (len(jobs), total, total / 1024.0))
    print("输出目录：%s" % os.path.relpath(OUT_DIR, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
