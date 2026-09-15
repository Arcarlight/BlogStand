#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""始祖小鸟页面（/tobitaiaaken/）的放养区 —— 素材流水线

把**本机游戏工程**里的走图和脸图取出来，重排成网页用的「一人一张」精灵表，
再生成名单索引和台词 JSON。

用法
----
    python tools/build-tbtak.py                 # 全量：精灵表 + 索引 + 台词
    python tools/build-tbtak.py --talk          # 只重生成台词 JSON（不碰素材，也不需要游戏工程）
    python tools/build-tbtak.py --src D:\\xxx   # 换一个素材目录
    python tools/build-tbtak.py --ascii fliegen # 把生成好的精灵表打成字符画（检查用）

输入（可以手改）
----------------
    data/tbtak-pool.toml          名单：谁会出现、用哪张走图/脸图、挑哪几个表情
    data/tbtak-talk/<id>.toml     每只的台词

输出（生成物，会被提交进仓库 —— 网页只读这些）
----------------------------------------------
    static/tbtak/sprite/<id>.png   精灵表：5 行 × 最多 4 列，每格 cw × ch 美术像素
                                     第 0 行 朝下走（3 帧：左步 / 站住 / 右步）
                                     第 1 行 朝左走    第 2 行 朝右走
                                     第 3 行 影子（只有第 0 列）
                                     第 4 行 脸图 96×96（列号见索引 f.c）
    static/tbtak/index.json        名单 + 每只的格子尺寸 / 帧时长 / 脸图槽位（页面内联，尽量小）
    static/tbtak/talk/<id>.json    每只的台词（点开才下载，一人一个文件）

原始素材（不在这个仓库里）
--------------------------
    <src>\\Characters\\$Walk<名字>.png   RPG Maker 走图：一行 3 帧、共 4 行（下 / 左 / 右 / 上）
    <src>\\Faces\\<名字>.png             表情表：4 列 × 2 行，一格 96×96 的半身像

默认找的是 `D:\\MakingGame\\TobenaiArchen\\Graphics`。换机器就 `--src` 指过去；
只想改台词的话用 `--talk`，完全不碰素材。

关于「美术像素」
----------------
和宝可梦放养区一个道理：精灵表里的 1 个像素是美术像素，页面上用整数倍设备像素放大，
所以边缘是硬的。走图的格子大小**按角色原样保留**（符利根 32、桃桃加 48、虹星 64），
所以六只在页面上的大小比例和游戏里一致。这里生成的图**不要做任何缩放**。
"""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import sys
import tomllib
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = Path(r"D:\MakingGame\TobenaiArchen\Graphics")

POOL_FILE = ROOT / "data" / "tbtak-pool.toml"
TALK_DIR = ROOT / "data" / "tbtak-talk"
OUT_DIR = ROOT / "static" / "tbtak"
OUT_SPRITE = OUT_DIR / "sprite"
OUT_TALK = OUT_DIR / "talk"
OUT_INDEX = OUT_DIR / "index.json"

# 精灵表的行号（固定，JS 里也写死同样的值）
ROW_DOWN, ROW_LEFT, ROW_RIGHT, ROW_SHADOW, ROW_FACE = 0, 1, 2, 3, 4
N_ROWS = 5

WALK_COLS = 3                 # RPG Maker 走图一行 3 帧：左步 / 站住 / 右步
WALK_ROWS = 4                 # 下 / 左 / 右 / 上
WALK_MS = [190, 190, 190]     # 每帧时长（和游戏里的节奏接近）
FACE_SIZE = 96                # 表情表一格 96×96
FACE_COLS, FACE_ROWS = 4, 2
FACE_SLOTS = ("normal", "smile", "nag", "wake")

MAX_LINE = 40                 # 一句最多多少字
TALK_REQ = {"greet": 2, "pet": 5, "idle": 8}      # 至少要几条
TALK_OPT = {"pet_more": 2, "night": 2}            # 写了就要够几条
TALK_TOP_KEYS = {"name", "greet", "pet", "pet_more", "idle", "night"}


# ============================================================
#  借用宝可梦那支脚本里的两个函数（字体检查、影子生成），免得两处各写一份
# ============================================================

def _shared():
    path = ROOT / "tools" / "build-pkmn.py"
    spec = importlib.util.spec_from_file_location("build_pkmn_shared", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)          # 它只在 __main__ 里干活，import 是安全的
    return mod


SHARED = None


def unsupported_char(line: str):
    global SHARED
    if SHARED is None:
        SHARED = _shared()
    return SHARED.unsupported_char(line)


def why_text(ch: str, why: str) -> str:
    global SHARED
    if SHARED is None:
        SHARED = _shared()
    return SHARED.why_text(ch, why)


def make_shadow(w: int, h: int) -> Image.Image:
    global SHARED
    if SHARED is None:
        SHARED = _shared()
    return SHARED.make_shadow(w, h)


# ============================================================
#  名单
# ============================================================

def load_pool() -> list[dict]:
    if not POOL_FILE.exists():
        raise SystemExit(f"缺少名单文件：{POOL_FILE}")
    with POOL_FILE.open("rb") as f:
        data = tomllib.load(f)
    items = data.get("chara") or []
    if not items:
        raise SystemExit(f"{POOL_FILE} 里一条 [[chara]] 都没有")
    seen: set[str] = set()
    for it in items:
        for key in ("id", "name", "walk", "face", "faces"):
            if key not in it:
                raise SystemExit(f"{POOL_FILE}：有一条缺 {key}")
        if it["id"] in seen:
            raise SystemExit(f"{POOL_FILE}：id 重复：{it['id']}")
        seen.add(it["id"])
        if len(it["faces"]) != 4:
            raise SystemExit(f"{POOL_FILE}：{it['id']} 的 faces 要正好 4 个槽位"
                             f"（正常 / 笑 / 不耐烦 / 惊醒），现在 {len(it['faces'])} 个")
        for n in it["faces"]:
            if not (0 <= int(n) < FACE_COLS * FACE_ROWS):
                raise SystemExit(f"{POOL_FILE}：{it['id']} 的表情槽位 {n} 超出范围（0~7）")
    return items


# ============================================================
#  走图 / 脸图 → 精灵表
# ============================================================

def slice_walk(img: Image.Image, row: int) -> list[Image.Image]:
    """切出走图里的一行（3 帧）。"""
    fw = img.width // WALK_COLS
    fh = img.height // WALK_ROWS
    return [img.crop((c * fw, row * fh, (c + 1) * fw, (row + 1) * fh))
            for c in range(WALK_COLS)]


def union_bbox(frames: list[Image.Image]):
    box = None
    for im in frames:
        bb = im.getbbox()
        if bb is None:
            continue
        box = bb if box is None else (min(box[0], bb[0]), min(box[1], bb[1]),
                                      max(box[2], bb[2]), max(box[3], bb[3]))
    return box


def face_frames(item: dict, src: Path):
    """从表情表里挑 4 个表情；一样的槽位合并成一张。"""
    path = src / "Faces" / item["face"]
    if not path.exists():
        raise SystemExit(f"找不到表情表：{path}")
    sheet = Image.open(path).convert("RGBA")
    if sheet.size != (FACE_SIZE * FACE_COLS, FACE_SIZE * FACE_ROWS):
        raise SystemExit(f"{path} 的大小是 {sheet.size}，期望 "
                         f"{FACE_SIZE * FACE_COLS}×{FACE_SIZE * FACE_ROWS}")
    imgs: list[Image.Image] = []
    keys: list[bytes] = []
    slots: dict[str, int] = {}
    for slot, n in zip(FACE_SLOTS, item["faces"]):
        r, c = divmod(int(n), FACE_COLS)
        im = sheet.crop((c * FACE_SIZE, r * FACE_SIZE,
                         (c + 1) * FACE_SIZE, (r + 1) * FACE_SIZE))
        k = im.tobytes()
        if k in keys:
            slots[slot] = keys.index(k)
            continue
        slots[slot] = len(imgs)
        imgs.append(im)
        keys.append(k)
    return imgs, slots


def build_sprite(item: dict, src: Path) -> dict:
    cid, name = item["id"], item["name"]
    walk_path = src / "Characters" / item["walk"]
    if not walk_path.exists():
        raise SystemExit(f"找不到走图：{walk_path}")
    walk = Image.open(walk_path).convert("RGBA")
    if walk.width % WALK_COLS or walk.height % WALK_ROWS:
        raise SystemExit(f"{walk_path} 的大小 {walk.size} 不是 3 列 × 4 行的走图")

    groups = {
        "down": slice_walk(walk, ROW_DOWN),     # 面向访客
        "left": slice_walk(walk, ROW_LEFT),
        "right": slice_walk(walk, ROW_RIGHT),
    }

    # 九帧一起做一次并集裁切 —— 帧与帧之间、方向与方向之间的相对位置（脚踩的那条线）全部保住
    all_frames = groups["down"] + groups["left"] + groups["right"]
    bb = union_bbox(all_frames)
    if bb is None:
        raise SystemExit(f"{cid} {name}：走图整张都是空的？")
    groups = {k: [im.crop(bb) for im in fr] for k, fr in groups.items()}

    face_imgs, face_slots = face_frames(item, src)

    # 影子：宽度按身体宽度估（和宝可梦那边一个画法）
    body_w = max(im.width for fr in groups.values() for im in fr)
    body_h = max(im.height for fr in groups.values() for im in fr)
    sh_w = max(8, min(56, int(round(body_w * 0.62))))
    sh_h = max(3, min(9, int(round(sh_w / 6))))
    shadow = make_shadow(sh_w, sh_h)

    cells = max(WALK_COLS, len(face_imgs))
    cw = max(body_w, FACE_SIZE)
    ch = max(body_h, FACE_SIZE)
    sheet = Image.new("RGBA", (cw * cells, ch * N_ROWS), (0, 0, 0, 0))

    def place(im: Image.Image, row: int, col: int):
        x = col * cw + (cw - im.width) // 2
        y = row * ch + (ch - im.height)          # 底边对齐（脚在同一条线上）
        sheet.alpha_composite(im, (x, y))
        return x - col * cw, y - row * ch

    for row, key in ((ROW_DOWN, "down"), (ROW_LEFT, "left"), (ROW_RIGHT, "right")):
        for c, im in enumerate(groups[key]):
            place(im, row, c)
    sh_x, sh_y = place(shadow, ROW_SHADOW, 0)
    f_x = f_y = 0
    for c, im in enumerate(face_imgs):
        f_x, f_y = place(im, ROW_FACE, c)

    OUT_SPRITE.mkdir(parents=True, exist_ok=True)
    out_png = OUT_SPRITE / f"{cid}.png"
    sheet.save(out_png, optimize=True)

    return {
        "n": name,
        "en": item.get("en", ""),
        "kind": item.get("kind", ""),
        "g": item.get("group", ""),          # "trio" = 三只互斥，一次最多出现其中一只
        "cw": cw,
        "ch": ch,
        "ww": body_w,                        # 角色本身的宽高（美术像素），用来核对比例
        "wh": body_h,
        "d": WALK_MS,
        "sh": {"w": sh_w, "h": sh_h, "x": sh_x, "y": sh_y},
        "f": {"w": FACE_SIZE, "h": FACE_SIZE, "x": f_x, "y": f_y,
              "c": [face_slots[s] for s in FACE_SLOTS]},
    }


# ============================================================
#  台词
# ============================================================

def load_talk(cid: str, name: str) -> dict:
    path = TALK_DIR / f"{cid}.toml"
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

    out: dict = {"name": name}
    for key, mn in TALK_REQ.items():
        got = lines(key)
        if len(got) < mn:
            errs.append(f"{key} 只有 {len(got)} 条，至少要 {mn} 条")
        out[key] = got
    for key, mn in TALK_OPT.items():
        got = lines(key)
        if got and len(got) < mn:
            errs.append(f"{key} 写了就要至少 {mn} 条（现在 {len(got)}）")
        out[key] = got

    seen: dict[str, str] = {}
    for key, arr in out.items():
        if not isinstance(arr, list):
            continue
        for ln in arr:
            if "\n" in ln or "\r" in ln:
                errs.append(f"{key}：台词里不能换行 → {ln[:20]}")
            if len(ln) > MAX_LINE:
                errs.append(f"{key}：{len(ln)} 字超过 {MAX_LINE} 字 → {ln}")
            bad = unsupported_char(ln)
            if bad:
                errs.append(f"{key}：{why_text(*bad)} → {ln}")
            if ln in seen:
                errs.append(f"重复句子（{seen[ln]} 和 {key}）→ {ln}")
            else:
                seen[ln] = key

    if errs:
        raise SystemExit(f"data/tbtak-talk/{cid}.toml 有问题：\n  - " + "\n  - ".join(errs))
    return out


def write_talk(pool: list[dict]) -> None:
    OUT_TALK.mkdir(parents=True, exist_ok=True)
    all_lines: dict[str, str] = {}
    total = 0
    print("台词：")
    for item in pool:
        talk = load_talk(item["id"], item["name"])
        n = sum(len(v) for v in talk.values() if isinstance(v, list))
        total += n
        # 跨角色也不许撞句（撞了说明有谁的嘴跑到别人身上去了）
        for k, arr in talk.items():
            if not isinstance(arr, list):
                continue
            for ln in arr:
                if ln in all_lines:
                    raise SystemExit(f"撞句：{item['name']} 的「{ln}」和 {all_lines[ln]} 重复了")
                all_lines[ln] = item["name"]
        path = OUT_TALK / f"{item['id']}.json"
        path.write_text(json.dumps(talk, ensure_ascii=False, indent=1) + "\n",
                        encoding="utf-8", newline="\n")
        print(f"  {item['name']:<6} {n:>3} 句  → talk/{item['id']}.json")
    print(f"  合计 {total} 句 / {len(pool)} 人，无重复句")


# ============================================================
#  检查用：把精灵表打成字符画
# ============================================================

def ascii_dump(cid: str) -> None:
    path = OUT_SPRITE / f"{cid}.png"
    if not path.exists():
        raise SystemExit(f"还没有生成 {path}")
    idx = json.loads(OUT_INDEX.read_text(encoding="utf-8"))["cast"][cid]
    im = Image.open(path).convert("RGBA")
    cw, ch = idx["cw"], idx["ch"]
    for row in range(N_ROWS):
        cols = WALK_COLS if row < ROW_SHADOW else (1 if row == ROW_SHADOW else len(idx["f"]["c"]))
        for c in range(cols):
            print(f"--- 第 {row} 行 第 {c} 列 ---")
            box = (c * cw, row * ch, (c + 1) * cw, (row + 1) * ch)
            cell = im.crop(box)
            bb = cell.getbbox()
            if bb is None:
                print("   (空的)")
                continue
            cell = cell.crop(bb)
            px = cell.load()
            for y in range(cell.height):
                print("   " + "".join("." if px[x, y][3] < 40 else "#"
                                      for x in range(cell.width)))


# ============================================================
#  主流程
# ============================================================

def main() -> int:
    ap = argparse.ArgumentParser(description="始祖小鸟页面放养区素材流水线")
    ap.add_argument("--talk", action="store_true", help="只重新生成台词 JSON（不碰素材）")
    ap.add_argument("--src", default=str(DEFAULT_SRC), help="游戏素材目录（Characters / Faces 的上一级）")
    ap.add_argument("--ascii", metavar="ID", help="把某个角色的精灵表打成字符画")
    args = ap.parse_args()

    pool = load_pool()

    if args.ascii:
        if not OUT_INDEX.exists():
            raise SystemExit("还没生成过索引，先跑一次 python tools/build-tbtak.py")
        ascii_dump(args.ascii)
        return 0

    if not args.talk:
        src = Path(args.src)
        if not (src / "Characters").is_dir() or not (src / "Faces").is_dir():
            raise SystemExit(f"素材目录不对：{src}（下面要有 Characters/ 和 Faces/）")
        cast: dict[str, dict] = {}
        print("精灵表：")
        for item in pool:
            entry = build_sprite(item, src)
            cast[item["id"]] = entry
            out_png = OUT_SPRITE / f"{item['id']}.png"
            print(f"  {item['name']:<6} 格子 {entry['cw']}×{entry['ch']} "
                  f"角色本体 {entry['ww']}×{entry['wh']}  "
                  f"{out_png.stat().st_size / 1024:.1f} KB"
                  f"   {item['walk']} + {item['face']}")
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        # 草皮贴图和宝可梦那边是同一张（同一个函数画出来的，两张文件内容一致）——
        # 各存一份是为了这一页不依赖 static/pkmn/ 有没有生成过
        global SHARED
        if SHARED is None:
            SHARED = _shared()
        SHARED.write_pen_tile(OUT_DIR / "pen-tile.png")
        print(f"  草地贴图 → pen-tile.png "
              f"{(OUT_DIR / 'pen-tile.png').stat().st_size / 1024:.1f} KB")
        OUT_INDEX.write_text(json.dumps({"cast": cast}, ensure_ascii=False,
                                        separators=(",", ":")) + "\n",
                             encoding="utf-8", newline="\n")
        print(f"  → index.json {OUT_INDEX.stat().st_size / 1024:.1f} KB")

    write_talk(pool)
    return 0


if __name__ == "__main__":
    sys.exit(main())
