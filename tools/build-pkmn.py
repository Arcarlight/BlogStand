#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宝可梦放养区 —— 素材流水线

把 PMDCollab 的 PMD 风格行走图（SpriteCollab）和脸图（Portrait）抓下来，
按放养区需要的样子重新拼成「一只宝可梦一张精灵表」，再生成名单索引和台词 JSON。

用法
----
    python tools/build-pkmn.py            # 全量：下载素材 + 生成精灵表 + 索引 + 台词
    python tools/build-pkmn.py --talk     # 只重新生成台词 JSON（不联网）
    python tools/build-pkmn.py --force    # 无视缓存重新下载
    python tools/build-pkmn.py --ascii 330   # 把生成好的精灵表用字符画打出来（检查用）

输入（可以手改）
----------------
    data/pkmn-pool.toml          放养区会出现哪些宝可梦（收藏名单）
    data/pkmn-talk/<dex>.toml    每只的台词

输出（生成物，会被提交进仓库）
------------------------------
    static/pkmn/sprite/<dex>.png    精灵表：5 行 × N 列，每格 cellW × cellH 美术像素
                                      第 0 行 Idle（朝下 / 面向访客）
                                      第 1 行 Walk 左     第 2 行 Walk 右
                                      第 3 行 脸图 40×40（列号见索引 f.c）
                                      第 4 行 影子（只有第 0 列）
    static/pkmn/index.json          名单 + 每只的格子尺寸/帧数/帧时长（页面内联，所以尽量小）
    static/pkmn/talk/<dex>.json     每只的台词（点开才下载，一只一个文件）
    static/pkmn/pen-tile.png        放养区草地的点阵贴图（32×28 美术像素，横向平铺）
    static/pkmn/icon-sheet.png      天气 / 时间图标表（24×24 一格，两行：深色 / 白色）

（<dex> 就是图鉴号本身，不补零：579.png 对应 data/pkmn-talk/579.toml）

关于「美术像素」
----------------
精灵表里的 1 个像素是「美术像素」，不是屏幕像素。页面上用整数倍设备像素放大
（2 或 3 设备像素 = 1 美术像素），所以边缘是硬的、不会糊 —— 和站点其它点阵
字体一个道理。所以这里生成的图**不要做任何缩放**。

方向行索引（PMD 精灵表固定 8 行）：0=下 1=右下 2=右 3=右上 4=上 5=左上 6=左 7=左下
（已用「镜像相似度矩阵」核对过：镜像第 1 行 ≈ 第 7 行、镜像第 2 行 ≈ 第 6 行、
镜像第 3 行 ≈ 第 5 行、第 4 行自身最对称，和 PMD 的资料一致。）

授权
----
SpriteCollab 的素材是 CC BY-NC 4.0：非商业使用 + 署名。这个站是个人非商业博客。
作者的 Discord ID 会用仓库里的 credit_names.txt 换成名字，写进每只的台词 JSON，
在挂件里做成 title 提示；.notes/宝可梦放养区.md 里也有完整来源说明。
"""

from __future__ import annotations

import argparse
import io
import json
import random
import re
import sys
import time
import tomllib
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
POOL_FILE = ROOT / "data" / "pkmn-pool.toml"
TALK_DIR = ROOT / "data" / "pkmn-talk"
CACHE = ROOT / "tools" / ".pkmn-cache"
OUT_DIR = ROOT / "static" / "pkmn"
OUT_SPRITE = OUT_DIR / "sprite"
OUT_TALK = OUT_DIR / "talk"
OUT_INDEX = OUT_DIR / "index.json"
OUT_TILE = OUT_DIR / "pen-tile.png"
OUT_ICONS = OUT_DIR / "icon-sheet.png"

BASE = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master"
UA = "BlogStand-pkmn-pipeline/1.0 (+https://arcarlight.github.io/BlogStand/)"

# 精灵表的行号（固定，JS 里也写死同样的值）
ROW_IDLE, ROW_WL, ROW_WR, ROW_FACE, ROW_SHADOW = 0, 1, 2, 3, 4
ROW_SLEEP = 5
N_ROWS = 6

# 下载下来的原始精灵表里，方向行的行号（PMD 固定 8 行，见文件头说明）
DIR_DOWN, DIR_RIGHT, DIR_LEFT = 0, 2, 6

# 天气 / 时间图标的精灵表：一格 24×24，两行（第 0 行深色图标白天用、第 1 行白色图标夜里用）。
# 顺序就是列号，改顺序要同时改 JS 里的取用方式（JS 是从索引里读这份顺序的，所以只改这里也行）。
ICON_SIZE = 24
ICON_BASE = "https://raw.githubusercontent.com/hackernoon/pixel-icon-library/main/icons/PNG"
ICON_KEYS = ["clear", "cloudy", "fog", "drizzle", "rain", "snow", "thunder",
             "dawn", "day", "dusk", "night"]
# 库里有的图标；cloudy / snow 库里没有，从 cloud-rain 抠出来（见 write_icon_sheet）
ICON_SRC = {
    "clear": "regular/sun",
    "fog": "regular/cloud-fog",
    "drizzle": "regular/cloud-rain",
    "rain": "regular/cloud-rain",
    "thunder": "regular/bolt",
    "dawn": "regular/sun",
    "day": "solid/sun-solid",
    "dusk": "regular/star-crescent",
    "night": "regular/moon",
}

PORTRAIT_SIZE = 40  # PMD 脸图固定 40×40

# 四个表情槽：正常 / 笑（被摸） / 不耐烦（连着摸太多次） / 惊醒（被戳醒）。
# 每只宝可梦有的表情不一样（比如宝包茧只有 Normal，三首恶龙没有 Joyous），
# 按下面的优先顺序挑第一个存在的；都没有就退回 Normal。
FACE_PREF = {
    "normal": ["Normal"],
    "smile": ["Joyous", "Happy", "Inspired", "Delighted", "Special0", "Normal"],
    "nag": ["Worried", "Sigh", "Shouting", "Angry", "Stunned", "Surprised", "Sad", "Pain", "Normal"],
    "wake": ["Surprised", "Stunned", "Dizzy", "Determined", "Normal"],
}

# 台词文件允许出现的键（多写别的直接报错，免得拼错了没发现）
TALK_TOP_KEYS = {"name", "pet", "pet_more", "idle", "night",
                 "sleepy", "sleep", "wake", "page", "weather"}
TALK_PAGE_KEYS = ["home", "about", "blog", "diary", "nav", "gallery", "tbtak", "other"]
TALK_WEATHER_KEYS = ["clear", "cloudy", "rain", "snow", "thunder", "fog", "drizzle"]

# 各段最少要写几条（写手的目标比这个高一截，这里只是兜底）
TALK_MIN = {
    "pet": 6,
    "idle": 9,
    "sleepy": 2,   # 打瞌睡前说的
    "sleep": 2,    # 睡着时的梦话
    "wake": 2,     # 被戳醒时说的
}
TALK_MIN_PAGE = {"home": 3, "about": 3, "blog": 3, "diary": 3, "nav": 3}
TALK_MIN_WEATHER = {"clear": 2, "cloudy": 2, "rain": 2, "snow": 2, "thunder": 2}

MAX_LINE = 40  # 一句台词最多多少字（对话框只有 3 行，一行 ~16 字）

# 台词里不该出现的字符：引号 / 书名号 / 括号 —— 对话框只显示这句话本身，
# 这些符号会和站点自己的排版打架。
BAD_CHARS = set("\"'“”‘’「」『』（）()《》〈〉【】[]{}【】")

# 变体选择符 U+FE0F 会把前一个字符变成「彩色 emoji 呈现」（Windows 上就是
# Segoe UI Emoji），那样就不在点阵字体里了，所以单独禁掉。
BAD_CODEPOINTS = {0xFE0F}

# ============================================================
#  「这个字能不能用」= 站里那三份点阵字体有没有它的字形
#  ------------------------------------------------------------
#  比一刀切禁掉某个 Unicode 段靠谱得多：★ ☆ ♥ ← ■ 这些字体里本来就有，
#  当然该让写；♪ 这种字体里没有的，写上去会掉到系统字体上、边缘发糊 ——
#  那才是真要拦的东西。（2026-09-14 之前是按 U+2600–U+27BF 一刀切的，
#  结果把站长想写的 ♪ 也拦了，所以才改成现在这样。）
#  unicode-range 直接从 retro.css 里读，免得两处各写一份、改了一处忘了另一处。
# ============================================================
PIXEL_FONTS = ["simsun12-pixel.woff2", "msgothic12-jp-pixel.woff2", "mona12emoji.woff2"]
CSS_FILE = ROOT / "assets" / "css" / "retro.css"
_CHARSET: set | None = None


def _font_unicode_ranges(css_text: str) -> dict:
    """从 retro.css 里读每个 @font-face 的 unicode-range（没有这条 = 全部码位）"""
    out: dict[str, set | None] = {}
    for m in re.finditer(r"@font-face\s*\{(.*?)\}", css_text, re.S):
        block = m.group(1)
        fm = re.search(r"url\([^)]*?([\w\-.]+\.woff2)\)", block)
        if not fm:
            continue
        name = fm.group(1)
        rm = re.search(r"unicode-range:\s*([^;]+);", block, re.S)
        if not rm:
            out[name] = None          # 没有范围限制
            continue
        cps: set[int] = set()
        for part in rm.group(1).split(","):
            mm = re.match(r"U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$", part.strip())
            if not mm:
                continue
            a = int(mm.group(1), 16)
            b = int(mm.group(2), 16) if mm.group(2) else a
            cps.update(range(a, b + 1))
        out[name] = cps
    return out


def pixel_charset() -> set | None:
    """三份点阵字体合起来能渲染的字符集合；判断不了就返回 None（那就不检查）"""
    global _CHARSET
    if _CHARSET is not None:
        return _CHARSET
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        print("  ⚠ 没装 fontTools，跳过「这个字有没有点阵字形」的检查"
              "（pip install fonttools 之后就会检查）")
        return None
    try:
        ranges = _font_unicode_ranges(CSS_FILE.read_text(encoding="utf-8"))
    except OSError:
        ranges = {}
    safe: set[int] = set()
    for fn in PIXEL_FONTS:
        p = ROOT / "static" / "fonts" / fn
        if not p.exists():
            continue
        f = TTFont(p, lazy=True)
        cps = set(f.getBestCmap().keys())
        f.close()
        rng = ranges.get(fn, None)
        # 没写 unicode-range 的（宋体那份）就是全部码位都能命中它
        safe |= cps if rng is None else (cps & rng)
    if not safe:
        print("  ⚠ 一份点阵字体都没读到，跳过字符检查")
        return None
    _CHARSET = safe
    return safe


def unsupported_char(line: str) -> tuple[str, str] | None:
    """返回第一个用不了的字符 + 原因（None = 这句没问题）"""
    chars = pixel_charset()
    for ch in line:
        cp = ord(ch)
        if ch in BAD_CHARS:
            return ch, "标点"
        if cp < 0x20 or cp == 0x7F or cp in BAD_CODEPOINTS:
            return ch, "控制符"
        if chars is not None and cp not in chars:
            return ch, "字体"
    return None


def why_text(ch: str, why: str) -> str:
    if why == "标点":
        return f"不要用引号、书名号、括号（「{ch}」）"
    if why == "控制符":
        return f"这里有个看不见的控制符（U+{ord(ch):04X}）"
    try:
        names = __import__("unicodedata").name(ch)
    except Exception:
        names = "?"
    return (f"站里三份点阵字体都没有「{ch}」（U+{ord(ch):04X} {names}），"
            f"写上去会掉到系统字体上、边缘发糊")



# ============================================================
#  下载（带缓存：tools/.pkmn-cache/，已在 .gitignore 里）
# ============================================================

def fetch(rel: str, force: bool = False):
    """下载仓库里的一个文件，返回 bytes；404 返回 None。结果缓存在本地。"""
    cache_path = CACHE / rel.replace("/", "_")
    if cache_path.exists() and not force:
        return cache_path.read_bytes()
    url = f"{BASE}/{rel}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(data)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:  # 网络抖动 / 代理没开
            last = e
        time.sleep(1.0 + 2.0 * attempt)
    raise SystemExit(
        f"下载失败：{url}\n  {last}\n"
        "  国内直连 githubusercontent 基本不通，先开代理再跑：\n"
        r"  $env:HTTPS_PROXY='http://127.0.0.1:7897'"
    )


def fetch_url(url: str, cache_key: str, force: bool = False):
    """按完整网址下载（图标库不在 SpriteCollab 那边），同样走本地缓存。"""
    cache_path = CACHE / cache_key
    if cache_path.exists() and not force:
        return cache_path.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(data)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:
            last = e
        time.sleep(1.0 + 2.0 * attempt)
    raise SystemExit(f"下载失败：{url}\n  {last}")


def load_pool() -> list[dict]:
    with POOL_FILE.open("rb") as f:
        data = tomllib.load(f)
    items = data.get("items") or []
    if not items:
        raise SystemExit(f"{POOL_FILE} 里没有 [[items]]")
    out = []
    for it in items:
        dex = int(it["dex"])
        sleep = str(it.get("sleep", "night")).strip().lower()
        if sleep not in ("night", "day"):
            raise SystemExit(f"{POOL_FILE}：{dex} 的 sleep 只能是 \"night\"（夜里睡）或 \"day\"（白天睡）")
        out.append({"dex": dex, "name": str(it["name"]), "en": str(it.get("en", "")), "sleep": sleep})
    return out


# ============================================================
#  AnimData.xml
# ============================================================

def parse_animdata(xml_bytes: bytes) -> dict:
    """把 AnimData.xml 解析成 {动画名: {fw, fh, durs}}。CopyOf 的动画继承原动画。"""
    root = ET.fromstring(xml_bytes)
    raws = {}
    for a in root.findall("./Anims/Anim"):
        nm = (a.findtext("Name") or "").strip()
        if nm:
            raws[nm] = a
    resolved: dict[str, dict] = {}

    def resolve(name: str, seen: tuple) -> dict | None:
        if name in resolved:
            return resolved[name]
        a = raws.get(name)
        if a is None or name in seen:
            return None
        copy = (a.findtext("CopyOf") or "").strip()
        if copy:
            got = resolve(copy, seen + (name,))
            if got:
                resolved[name] = got
            return got
        fw = a.findtext("FrameWidth")
        fh = a.findtext("FrameHeight")
        if not fw or not fh:
            return None
        durs = [int(d.text) for d in a.findall("./Durations/Duration")]
        got = {"fw": int(fw), "fh": int(fh), "durs": durs, "name": name}
        resolved[name] = got
        return got

    for nm in raws:
        resolve(nm, ())
    return resolved


def frames_of(img: Image.Image, info: dict, row: int) -> list[Image.Image] | None:
    """取出某一行（某个方向）的所有帧。行不存在返回 None。"""
    fw, fh = info["fw"], info["fh"]
    nrows = img.height // fh
    ncols = min(len(info["durs"]) if info["durs"] else 1, img.width // fw)
    if row >= nrows or ncols <= 0:
        return None
    return [img.crop((i * fw, row * fh, i * fw + fw, row * fh + fh)) for i in range(ncols)]


def union_bbox(frames: list[Image.Image]) -> tuple | None:
    """一组帧的不透明区域并集（用来裁掉四周的空白，同时保住帧之间的相对位移）。"""
    x0 = y0 = 10 ** 9
    x1 = y1 = -1
    for f in frames:
        bb = f.getchannel("A").getbbox()
        if not bb:
            continue
        x0, y0 = min(x0, bb[0]), min(y0, bb[1])
        x1, y1 = max(x1, bb[2]), max(y1, bb[3])
    if x1 < 0:
        return None
    return (x0, y0, x1, y1)


def make_shadow(w: int, h: int) -> Image.Image:
    """画一个硬边点阵椭圆当影子（不能有抗锯齿，否则缩放到屏幕上会发虚）。"""
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = im.load()
    for y in range(h):
        for x in range(w):
            dx = (x + 0.5 - w / 2) / (w / 2)
            dy = (y + 0.5 - h / 2) / (h / 2)
            d = dx * dx + dy * dy
            if d <= 1.0:
                px[x, y] = (24, 40, 24, 104 if d <= 0.5 else 62)
    return im


def pick_face(dex: int, slot: str, faces_cache: dict, force: bool) -> str:
    """挑一个存在的表情文件名。结果记在缓存里，之后不再逐个探测。"""
    dd = f"{dex:04d}"
    cached = faces_cache.get(dd, {})
    if slot in cached and not force:
        return cached[slot]
    for cand in FACE_PREF[slot]:
        if fetch(f"portrait/{dd}/{cand}.png", force) is not None:
            cached[slot] = cand
            faces_cache[dd] = cached
            return cand
    raise SystemExit(f"{dd} 连 Normal 脸图都没有？")


# ============================================================
#  合成一只的精灵表
# ============================================================

def build_sprite(item: dict, faces_cache: dict, force: bool) -> dict:
    dex, name = item["dex"], item["name"]
    dd = f"{dex:04d}"

    xml = fetch(f"sprite/{dd}/AnimData.xml", force)
    if xml is None:
        raise SystemExit(f"{dd} {name}：在 SpriteCollab 里找不到 sprite/{dd}/AnimData.xml")
    anims = parse_animdata(xml)
    idle_info = anims.get("Idle") or anims.get("Walk")
    walk_info = anims.get("Walk") or idle_info
    if not idle_info or not walk_info:
        raise SystemExit(f"{dd} {name}：AnimData.xml 里没有 Idle / Walk")

    idle_png = fetch(f"sprite/{dd}/Idle-Anim.png", force)
    walk_png = fetch(f"sprite/{dd}/Walk-Anim.png", force)
    if idle_png is None or walk_png is None:
        raise SystemExit(f"{dd} {name}：缺少 Idle-Anim.png 或 Walk-Anim.png")
    idle_img = Image.open(io.BytesIO(idle_png)).convert("RGBA")
    walk_img = Image.open(io.BytesIO(walk_png)).convert("RGBA")

    groups: dict[str, list[Image.Image]] = {}

    down = frames_of(idle_img, idle_info, DIR_DOWN)
    if down is None:
        raise SystemExit(f"{dd} {name}：Idle 表里没有「下」这一行")
    groups["i"] = down

    wl = frames_of(walk_img, walk_info, DIR_LEFT)
    wr = frames_of(walk_img, walk_info, DIR_RIGHT)
    if wl is None and wr is None:
        # 只有单向的动画：拿朝下的帧顶替，左向镜像一份
        wl = [f.transpose(Image.FLIP_LEFT_RIGHT) for f in down]
        wr = down
    elif wl is None:
        wl = [f.transpose(Image.FLIP_LEFT_RIGHT) for f in wr]
    elif wr is None:
        wr = [f.transpose(Image.FLIP_LEFT_RIGHT) for f in wl]
    groups["wl"], groups["wr"] = wl, wr

    # 睡觉动画（35 只都有；万一哪只没有就退回 Idle）
    sleep_info = anims.get("Sleep")
    sl = None
    if sleep_info:
        sleep_png = fetch(f"sprite/{dd}/Sleep-Anim.png", force)
        if sleep_png is not None:
            sl = frames_of(Image.open(io.BytesIO(sleep_png)).convert("RGBA"), sleep_info, DIR_DOWN)
    if not sl:
        sleep_info = idle_info
        sl = down
    groups["sl"] = sl

    # 每组按「整组并集」裁一次：既去掉空白，又保住帧与帧之间的相对位置（走路的起伏就在里面）
    cropped: dict[str, list[Image.Image]] = {}
    for key, fr in groups.items():
        bb = union_bbox(fr)
        if bb is None:
            raise SystemExit(f"{dd} {name}：{key} 这一组全是透明的？")
        cropped[key] = [f.crop(bb) for f in fr]

    # 脸图（去重：有的宝可梦三个槽会落到同一张图上）
    faces: dict[str, int] = {}
    face_imgs: list[Image.Image] = []
    face_file: dict[str, str] = {}
    for slot in ("normal", "smile", "nag", "wake"):
        fname = pick_face(dex, slot, faces_cache, force)
        face_file[slot] = fname
        if fname in [face_file.get(s) for s in faces]:
            # 已经有同一张图了
            faces[slot] = [face_file[s] for s in faces].index(fname)
            continue
        png = fetch(f"portrait/{dd}/{fname}.png", force)
        im = Image.open(io.BytesIO(png)).convert("RGBA")
        if im.size != (PORTRAIT_SIZE, PORTRAIT_SIZE):
            im = im.crop((0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE))
        faces[slot] = len(face_imgs)
        face_imgs.append(im)

    # 影子：宽度按身体宽度估
    body_w = max(im.width for fr in cropped.values() for im in fr)
    sh_w = max(8, min(44, int(round(body_w * 0.62))))
    sh_h = max(3, min(7, int(round(sh_w / 6))))
    shadow = make_shadow(sh_w, sh_h)

    # 格子尺寸：所有帧里最宽/最高的那个，底边对齐（脚踩在同一条线上）
    all_imgs = [im for fr in cropped.values() for im in fr] + face_imgs + [shadow]
    cell_w = max(im.width for im in all_imgs)
    cell_h = max(im.height for im in all_imgs)
    cols = max(len(cropped["i"]), len(cropped["wl"]), len(cropped["wr"]), len(face_imgs), 1)

    sheet = Image.new("RGBA", (cell_w * cols, cell_h * N_ROWS), (0, 0, 0, 0))

    def place(im: Image.Image, row: int, col: int) -> tuple[int, int]:
        x = col * cell_w + (cell_w - im.width) // 2
        y = row * cell_h + (cell_h - im.height)
        sheet.alpha_composite(im, (x, y))
        return x - col * cell_w, y - row * cell_h

    anims_out = {}
    for key, row in (("i", ROW_IDLE), ("wl", ROW_WL), ("wr", ROW_WR), ("sl", ROW_SLEEP)):
        for i, im in enumerate(cropped[key]):
            place(im, row, i)
    face_x = face_y = 0
    for col, im in enumerate(face_imgs):
        face_x, face_y = place(im, ROW_FACE, col)
    sh_x, sh_y = place(shadow, ROW_SHADOW, 0)

    OUT_SPRITE.mkdir(parents=True, exist_ok=True)
    out_png = OUT_SPRITE / f"{dex}.png"
    sheet.save(out_png, optimize=True)

    def dur_ms(info: dict, n: int) -> list[int]:
        # AnimData 的时长单位是 1/60 秒
        d = [int(round(x * 1000 / 60)) for x in info["durs"]]
        return (d + [500] * n)[:n]      # 万一时长表比帧数短，补个默认值

    entry = {
        "n": name,
        "cw": cell_w,
        "ch": cell_h,
        "cols": cols,
        "i": {"n": len(cropped["i"]), "d": dur_ms(idle_info, len(cropped["i"]))},
        "wl": {"n": len(cropped["wl"]), "d": dur_ms(walk_info, len(cropped["wl"]))},
        "wr": {"n": len(cropped["wr"]), "d": dur_ms(walk_info, len(cropped["wr"]))},
        "sl": {"n": len(cropped["sl"]), "d": dur_ms(sleep_info, len(cropped["sl"]))},
        # f.c 是四个表情在图上的列号：正常 / 笑 / 不耐烦 / 惊醒
        "f": {"w": PORTRAIT_SIZE, "h": PORTRAIT_SIZE, "x": face_x, "y": face_y,
              "c": [faces["normal"], faces["smile"], faces["nag"], faces["wake"]]},
        "s": {"w": sh_w, "h": sh_h, "x": sh_x, "y": sh_y},
        # 作息：night = 夜里睡（白天活动），day = 白天睡（夜行性），来自 data/pkmn-pool.toml
        "z": item.get("sleep", "night"),
        # 只是给 --ascii 和人看的信息，页面不用
        "_face": face_file,
    }
    return entry


# ============================================================
#  天气 / 时间图标
# ============================================================

def _icon_png(variant: str, rel: str, force: bool) -> Image.Image:
    data = fetch_url(f"{ICON_BASE}/{variant}/24px/{rel}.png",
                     f"icon_{variant}_{rel.replace('/', '_')}.png", force)
    if data is None:
        raise SystemExit(f"图标库下载失败：{variant}/24px/{rel}.png")
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    if im.size != (ICON_SIZE, ICON_SIZE):
        im = im.resize((ICON_SIZE, ICON_SIZE), Image.NEAREST)
    return im


def _centered(im: Image.Image) -> Image.Image:
    """把图形挪到格子正中（抠掉雨点之后云会偏上）。"""
    bb = im.getbbox()
    if not bb:
        return im
    out = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    out.paste(im.crop(bb), ((ICON_SIZE - (bb[2] - bb[0])) // 2,
                            (ICON_SIZE - (bb[3] - bb[1])) // 2))
    return out


def _glyph_color(im: Image.Image) -> tuple:
    """取图标的主色（深色变体是墨色、白色变体是白色），给小雪花用。"""
    counts = {}
    for c in im.getdata():
        if c[3] > 200:
            counts[c] = counts.get(c, 0) + 1
    return max(counts, key=counts.get) if counts else (0, 0, 0, 255)


def write_icon_sheet(path: Path, force: bool = False) -> None:
    """天气 / 时间图标表：2 行 × len(ICON_KEYS) 列，一格 24×24。
       第 0 行 = 库里的 for-light-mode（深色图标，白天配浅蓝天空）
       第 1 行 = 库里的 for-dark-mode（白色图标，夜里配深蓝天空）

    来源：HackerNoon Pixel Icon Library（MIT / CC BY 4.0），24px 那一档就是它
    的原生栅格（1 个图标像素 = 1 个图像像素），所以放大的时候只能整倍放。
    库里没有「纯云」和「雪」，这两个是从 cloud-rain 上抠的：
    去掉雨点就是多云，把雨点换成小雪花就是雪。
    """
    sheet = Image.new("RGBA", (ICON_SIZE * len(ICON_KEYS), ICON_SIZE * 2), (0, 0, 0, 0))
    for row, variant in enumerate(("for-light-mode", "for-dark-mode")):
        rain = _icon_png(variant, ICON_SRC["rain"], force)
        cloud = _centered(_mask_below(rain, 16))          # 雨点都在 y>=17，切掉剩下的就是云
        for col, key in enumerate(ICON_KEYS):
            if key == "cloudy":
                im = cloud
            elif key == "snow":
                im = _snow_icon(cloud, _glyph_color(rain))
            elif key == "drizzle":
                im = rain                                    # 和小雨共用图标，页面上画得淡一点
            else:
                im = _icon_png(variant, ICON_SRC[key], force)
            sheet.alpha_composite(im, (col * ICON_SIZE, row * ICON_SIZE))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, optimize=True)


def _mask_below(im: Image.Image, y_cut: int) -> Image.Image:
    out = im.copy()
    px = out.load()
    for y in range(y_cut, ICON_SIZE):
        for x in range(ICON_SIZE):
            px[x, y] = (0, 0, 0, 0)
    return out


def _snow_icon(cloud: Image.Image, color: tuple) -> Image.Image:
    """云 + 三片小雪花（雪花是 1 像素十字，和库里的笔画粗细一致）。"""
    out = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    out.alpha_composite(cloud, (0, -3))     # 云往上挪，给雪花腾地方
    for cx, cy in ((6, 19), (12, 21), (18, 19)):
        for dx, dy in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)):
            x, y = cx + dx, cy + dy
            if 0 <= x < ICON_SIZE and 0 <= y < ICON_SIZE:
                out.putpixel((x, y), color)
    return out


# ============================================================
#  草地贴图
# ============================================================

def write_pen_tile(path: Path) -> None:
    """放养区的地面：32×28 美术像素的草地，横向平铺。
    上面 4 行是透明的（露出天空），只在几个位置冒出草尖。"""
    W, H = 32, 28
    SKY_TOP = 4          # 前 4 行留空（草尖除外）
    GRASS_HI = (156, 214, 116, 255)
    GRASS = (124, 192, 92, 255)
    GRASS_D = (106, 172, 78, 255)
    DIRT = (96, 154, 72, 255)
    DIRT_D = (76, 128, 58, 255)
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = im.load()
    for y in range(SKY_TOP, H):
        for x in range(W):
            if y < SKY_TOP + 2:
                c = GRASS_HI
            elif y < H - 6:
                c = GRASS
            elif y < H - 3:
                c = DIRT
            else:
                c = DIRT_D
            px[x, y] = c
    rnd = random.Random(20100914)
    # 草丛里的深色斑（横向平铺的接缝处也要能对上，所以左右各画一遍）
    for _ in range(26):
        x = rnd.randrange(W)
        y = rnd.randrange(SKY_TOP + 3, H - 6)
        px[x, y] = GRASS_D
        if rnd.random() < 0.5:
            px[(x + 1) % W, y] = GRASS_D
    # 上边缘的草尖（往天空里伸出来的那几撮）
    for x in (5, 6, 13, 22, 23, 29):
        px[x % W, SKY_TOP - 1] = GRASS
    for x in (6, 22):
        px[x, SKY_TOP - 2] = GRASS
    for x in (14, 30):
        px[x, SKY_TOP - 1] = GRASS_HI
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, optimize=True)


# ============================================================
#  台词
# ============================================================

def read_credits(dex: int, name_map: dict) -> dict:
    """把 credit_names.txt 里的 Discord ID 换成名字，拼一句署名。"""
    dd = f"{dex:04d}"

    def one(rel: str) -> list[str]:
        data = fetch(rel)
        if not data:
            return []
        names: list[str] = []
        for line in data.decode("utf-8", "replace").splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            who = parts[1].strip()
            who = name_map.get(who, who.replace("<@!", "").replace(">", "").strip())
            if who and who not in names:
                names.append(who)
        return names

    return {"sprite": one(f"sprite/{dd}/credits.txt"),
            "portrait": one(f"portrait/{dd}/credits.txt")}


def bad_char(line: str) -> str | None:
    """（旧接口，保留给外部脚本调用；新代码用 unsupported_char）"""
    hit = unsupported_char(line)
    return hit[0] if hit else None


def load_talk(dex: int, name: str) -> dict:
    """读一只的台词 TOML 并校验。有问题直接抛异常（宁可报错也不要坏数据上线）。"""
    path = TALK_DIR / f"{dex}.toml"
    if not path.exists():
        raise SystemExit(f"缺少台词文件：{path}")
    with path.open("rb") as f:
        data = tomllib.load(f)
    errs: list[str] = []

    unknown = set(data) - TALK_TOP_KEYS
    if unknown:
        errs.append(f"不认识的键：{sorted(unknown)}（只允许 {sorted(TALK_TOP_KEYS)}）")
    if data.get("name") and data["name"] != name:
        errs.append(f"name 写的是 {data['name']}，名单里是 {name}")

    def lines(key: str) -> list[str]:
        v = data.get(key)
        if v is None:
            return []
        if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
            errs.append(f"{key} 必须是字符串数组")
            return []
        return v

    out = {"name": name}
    for key, mn in TALK_MIN.items():
        got = lines(key)
        if len(got) < mn:
            errs.append(f"{key} 只有 {len(got)} 条，至少要 {mn} 条")
        out[key] = got
    for key in ("pet_more", "night"):
        got = lines(key)
        if got and len(got) < 2:
            errs.append(f"{key} 写了就要至少 2 条（现在 {len(got)}）")
        if got:
            out[key] = got
    page = data.get("page") or {}
    weather = data.get("weather") or {}
    if not isinstance(page, dict) or not isinstance(weather, dict):
        errs.append("page / weather 必须是 [page] / [weather] 这样的段")
        page, weather = {}, {}
    if set(page) - set(TALK_PAGE_KEYS):
        errs.append(f"page 里不认识的键：{sorted(set(page) - set(TALK_PAGE_KEYS))}")
    if set(weather) - set(TALK_WEATHER_KEYS):
        errs.append(f"weather 里不认识的键：{sorted(set(weather) - set(TALK_WEATHER_KEYS))}")
    out["page"] = {}
    for k in TALK_PAGE_KEYS:
        got = [x for x in (page.get(k) or []) if isinstance(x, str)]
        if len(got) < TALK_MIN_PAGE.get(k, 0):
            errs.append(f"page.{k} 只有 {len(got)} 条，至少要 {TALK_MIN_PAGE.get(k, 0)} 条")
        if got:
            out["page"][k] = got
    out["weather"] = {}
    for k in TALK_WEATHER_KEYS:
        got = [x for x in (weather.get(k) or []) if isinstance(x, str)]
        if len(got) < TALK_MIN_WEATHER.get(k, 0):
            errs.append(f"weather.{k} 只有 {len(got)} 条，至少要 {TALK_MIN_WEATHER.get(k, 0)} 条")
        if got:
            out["weather"][k] = got

    # 每一条：长度、换行、禁用字符、同段内重复
    seen: dict[str, str] = {}
    for key, arr in list(out.items()):
        if not isinstance(arr, list):
            continue
        for ln in arr:
            if "\n" in ln or "\r" in ln:
                errs.append(f"{key}：台词里不能换行 → {ln[:20]}")
            if len(ln) > MAX_LINE:
                errs.append(f"{key}：{len(ln)} 字超过 {MAX_LINE} 字 → {ln}")
            b = unsupported_char(ln)
            if b:
                errs.append(f"{key}：{why_text(*b)} → {ln}")
            if ln in seen:
                errs.append(f"重复句子（{seen[ln]} 和 {key}）→ {ln}")
            else:
                seen[ln] = key
    for sec in ("page", "weather"):
        for k, arr in out[sec].items():
            for ln in arr:
                if len(ln) > MAX_LINE:
                    errs.append(f"{sec}.{k}：{len(ln)} 字超过 {MAX_LINE} 字 → {ln}")
                b = unsupported_char(ln)
                if b:
                    errs.append(f"{sec}.{k}：{why_text(*b)} → {ln}")
                if ln in seen:
                    errs.append(f"重复句子（{seen[ln]} 和 {sec}.{k}）→ {ln}")
                else:
                    seen[ln] = f"{sec}.{k}"

    if errs:
        raise SystemExit(f"data/pkmn-talk/{dex}.toml 有问题：\n  - " + "\n  - ".join(errs))
    return out


def write_talk(pool: list[dict], credits_by_dex: dict, strict: bool = True,
               allow_fetch: bool = True) -> None:
    OUT_TALK.mkdir(parents=True, exist_ok=True)
    total = 0
    all_lines: dict[str, str] = {}
    cross: list[str] = []
    skipped: list[str] = []
    print("台词：")
    for item in pool:
        dex, name = item["dex"], item["name"]
        if not (TALK_DIR / f"{dex}.toml").exists():
            if strict:
                raise SystemExit(f"缺少台词文件：data/pkmn-talk/{dex}.toml")
            skipped.append(f"{dex} {name}")
            continue
        talk = load_talk(dex, name)
        cred = credits_by_dex.get(dex)
        if cred is None and allow_fetch:
            try:
                cred = read_credits(dex, load_name_map())
            except BaseException:
                cred = None  # 没网也没缓存时就不写署名，不影响台词
        if cred:
            talk["credits"] = cred
        n = sum(len(v) for v in (talk["pet"], talk["idle"]))
        n += sum(len(v) for k, v in talk.items() if k in ("pet_more", "night") and isinstance(v, list))
        n += sum(len(v) for v in talk["page"].values()) + sum(len(v) for v in talk["weather"].values())
        total += n
        # 跨只重复（不报错，只提示）
        for arr in list(talk["page"].values()) + list(talk["weather"].values()) + [talk["pet"], talk["idle"]]:
            for ln in arr:
                if ln in all_lines:
                    cross.append(f"{ln}（{all_lines[ln]} / {name}）")
                else:
                    all_lines[ln] = name
        outp = OUT_TALK / f"{dex}.json"
        outp.write_text(json.dumps(talk, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  {dex:>4} {name:<6} 共 {n:>3} 句  "
              f"（摸 {len(talk['pet'])} / 嘟囔 {len(talk['idle'])} / "
              f"分页 {sum(len(v) for v in talk['page'].values())} / "
              f"天气 {sum(len(v) for v in talk['weather'].values())}）"
              f"  {outp.stat().st_size / 1024:.1f} KB")
    print(f"  合计 {total} 句台词，{len(pool) - len(skipped)} 只")
    if skipped:
        print(f"  ⚠ 还没写台词、本次跳过 {len(skipped)} 只：{'、'.join(skipped)}")
    if cross:
        print(f"  ⚠ 不同宝可梦之间重复了 {len(cross)} 句：")
        for c in cross[:10]:
            print(f"      {c}")


def load_name_map() -> dict:
    raw = fetch("credit_names.txt")
    m: dict[str, str] = {}
    if not raw:
        return m
    for line in raw.decode("utf-8", "replace").splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) >= 2:
            m[parts[1].strip()] = parts[0].strip()
    return m


def existing_credits(dex: int) -> dict | None:
    """已经生成好的台词 JSON 里那份署名。

    --talk（只重生成台词）用它，这一步就完全不联网 —— 编辑器里改一句保存时
    也走这条路，不能因为没开代理就卡在那里重试下载。
    """
    p = OUT_TALK / f"{dex}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("credits")
    except Exception:
        return None


# ============================================================
#  自检：把生成好的精灵表用字符画打出来
# ============================================================

def ascii_dump(dex: int) -> None:
    p = OUT_SPRITE / f"{dex}.png"
    if not p.exists():
        raise SystemExit(f"{p} 不存在")
    idx = json.loads(OUT_INDEX.read_text(encoding="utf-8"))
    e = idx["sheet"][str(dex)]
    sheet = Image.open(p).convert("RGBA")
    cw, ch = e["cw"], e["ch"]
    print(f"{dex:04d} {e['n']}  cell={cw}x{ch}  cols={e['cols']}  sheet={sheet.size}")
    for row, label in ((ROW_IDLE, "Idle 下"), (ROW_WL, "Walk 左"), (ROW_WR, "Walk 右"), (ROW_FACE, "脸图")):
        n = {"i": e["i"]["n"], "wl": e["wl"]["n"], "wr": e["wr"]["n"]}.get(
            {ROW_IDLE: "i", ROW_WL: "wl", ROW_WR: "wr"}.get(row, ""), 3 if row == ROW_FACE else 0)
        print(f"\n--- 第 {row} 行 {label}（{n} 帧，只画第 0 帧）---")
        cell = sheet.crop((0, row * ch, cw, row * ch + ch))
        a = cell.getchannel("A").load()
        for y in range(ch):
            print("".join("#" if a[x, y] > 100 else ("+" if a[x, y] else ".") for x in range(cw)))


# ============================================================

def main() -> None:
    ap = argparse.ArgumentParser(description="宝可梦放养区素材流水线")
    ap.add_argument("--talk", action="store_true", help="只重新生成台词 JSON（不联网、不动精灵表）")
    ap.add_argument("--sprites", action="store_true", help="只重做精灵表和图标，不碰台词")
    ap.add_argument("--force", action="store_true", help="无视缓存重新下载")
    ap.add_argument("--ascii", type=int, metavar="DEX", help="把某只的精灵表打成字符画")
    args = ap.parse_args()

    if args.ascii:
        ascii_dump(args.ascii)
        return

    pool = load_pool()
    faces_cache_path = CACHE / "_faces.json"
    faces_cache = json.loads(faces_cache_path.read_text(encoding="utf-8")) if faces_cache_path.exists() else {}

    if not args.talk:
        print(f"名单：{len(pool)} 只")
        index = {"_doc": "由 tools/build-pkmn.py 生成；行号 0=Idle下 1=Walk左 2=Walk右 3=脸图 4=影子 5=Sleep",
                 "gen": 3, "sheet": {}}
        for item in pool:
            e = build_sprite(item, faces_cache, args.force)
            face_file = e.pop("_face")
            index["sheet"][str(item["dex"])] = e
            p = OUT_SPRITE / f"{item['dex']}.png"
            print(f"  {item['dex']:>4} {item['name']:<6} {e['cw']}x{e['ch']} ×{e['cols']} 列 "
                  f"栅格 {Image.open(p).size}  {p.stat().st_size / 1024:>5.1f} KB  "
                  f"表情 {face_file['normal']}/{face_file['smile']}/{face_file['nag']}")
        CACHE.mkdir(parents=True, exist_ok=True)
        faces_cache_path.write_text(json.dumps(faces_cache, ensure_ascii=False, indent=1), encoding="utf-8")
        write_pen_tile(OUT_TILE)
        write_icon_sheet(OUT_ICONS, args.force)
        index["icons"] = {"size": ICON_SIZE, "keys": ICON_KEYS,
                          "_doc": "第 0 行是深色图标（白天用）、第 1 行是白色（夜里用）；列号 = keys 里的下标"}
        OUT_INDEX.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"索引：{OUT_INDEX.relative_to(ROOT)}  {OUT_INDEX.stat().st_size / 1024:.1f} KB")
        print(f"草地：{OUT_TILE.relative_to(ROOT)}")
        print(f"图标：{OUT_ICONS.relative_to(ROOT)}  {OUT_ICONS.stat().st_size / 1024:.1f} KB  "
              f"{ICON_SIZE}×{ICON_SIZE} × {len(ICON_KEYS)} 列 × 2 行")
        if args.sprites:
            return

    # 台词：署名信息优先从已经生成好的 JSON / 下载缓存里取
    credits_by_dex: dict[int, dict] = {}
    if args.talk:
        # 只重生成台词：完全不联网（编辑器里保存台词走的就是这条路）
        for item in pool:
            c = existing_credits(item["dex"])
            if c:
                credits_by_dex[item["dex"]] = c
    else:
        for item in pool:
            try:
                c = read_credits(item["dex"], load_name_map())
            except BaseException:
                continue
            if c["sprite"] or c["portrait"]:
                credits_by_dex[item["dex"]] = c
    write_talk(pool, credits_by_dex, strict=args.talk, allow_fetch=not args.talk)


if __name__ == "__main__":
    sys.exit(main())
