#!/usr/bin/env python3
"""
把 static/tbtak/sprite/<id>.png 那张「网页用精灵表」拆回两份素材：
  · <id>-walk.png   行走帧（下 / 左 / 右 三个方向 × 3 帧）
  · <id>-faces.png  表情（生成时被用到的那些，一般 4 张）

⚠️ 说清楚它是什么、不是什么：
  这张精灵表是 tools/build-tbtak.py **重排**出来的，不是原图的容器——
    · 只有 下 / 左 / 右 三行，**原走图的「上」那一行没放进来**；
    · 每帧先按九帧并集裁切，再按底边在 96×96 的格子里居中；
    · 表里还有一行是影子（本脚本不要它）；
    · 表情只放了被选用的几格（原表情表 4×2 = 8 格，没用到的没进表）。
  所以拆出来的东西**能直接用**（比例、脚底线、帧间对齐都保住了），
  但**不等于**游戏工程里那两个原文件。要分发「原图」，还是从
  Graphics/Characters 和 Graphics/Faces 里拿原件上传。

用法：
    python3 tools/split-tbtak-sprite.py                  # 输出到 /tmp/tbtak-split
    python3 tools/split-tbtak-sprite.py --out 某个目录
    python3 tools/split-tbtak-sprite.py --only fliegen,pontus
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SPRITE_DIR = ROOT / "static" / "tbtak" / "sprite"
INDEX = ROOT / "static" / "tbtak" / "index.json"

ROW_DOWN, ROW_LEFT, ROW_RIGHT, ROW_SHADOW, ROW_FACE = 0, 1, 2, 3, 4
WALK_COLS = 3


def union_bbox(images: list[Image.Image]):
    box = None
    for im in images:
        bb = im.getbbox()
        if bb is None:
            continue
        box = bb if box is None else (min(box[0], bb[0]), min(box[1], bb[1]),
                                      max(box[2], bb[2]), max(box[3], bb[3]))
    return box


def split_one(cid: str, meta: dict, out_dir: Path) -> dict:
    cw, ch = int(meta["cw"]), int(meta["ch"])
    src = SPRITE_DIR / f"{cid}.png"
    if not src.exists():
        raise SystemExit(f"找不到精灵表：{src}")
    sheet = Image.open(src).convert("RGBA")
    cols = sheet.width // cw
    if sheet.width % cw or sheet.height % ch:
        raise SystemExit(f"{src} 尺寸 {sheet.size} 不是 {cw}×{ch} 的整数格")

    def cell(row: int, col: int) -> Image.Image:
        return sheet.crop((col * cw, row * ch, (col + 1) * cw, (row + 1) * ch))

    # ---- 行走帧：三个方向各 3 帧，按九帧并集裁切（保住帧间/方向间的相对位置）----
    walk_rows = [ROW_DOWN, ROW_LEFT, ROW_RIGHT]
    frames = [cell(r, c) for r in walk_rows for c in range(WALK_COLS)]
    bb = union_bbox(frames)
    if bb is None:
        raise SystemExit(f"{cid}：行走帧是空的？")
    fw, fh = bb[2] - bb[0], bb[3] - bb[1]
    walk = Image.new("RGBA", (fw * WALK_COLS, fh * len(walk_rows)), (0, 0, 0, 0))
    for ri, r in enumerate(walk_rows):
        for c in range(WALK_COLS):
            walk.alpha_composite(cell(r, c).crop(bb), (c * fw, ri * fh))
    walk_path = out_dir / f"{cid}-walk.png"
    walk.save(walk_path, optimize=True)

    # ---- 表情：表里第 4 行放了几张就用几张（c 是去重后的槽位表）----
    face_meta = meta.get("f") or {}
    face_slots = face_meta.get("c") or []
    n_face = max(1, len(face_slots))
    fw2 = int(face_meta.get("w") or cw)
    fh2 = int(face_meta.get("h") or ch)
    faces = Image.new("RGBA", (fw2 * n_face, fh2), (0, 0, 0, 0))
    used = 0
    for c in range(min(n_face, cols)):
        im = cell(ROW_FACE, c)
        if im.getbbox() is None:      # 空格子跳过
            continue
        faces.alpha_composite(im, (used * fw2, 0))
        used += 1
    face_path = out_dir / f"{cid}-faces.png"
    if used:
        faces = faces.crop((0, 0, fw2 * used, fh2))
        faces.save(face_path, optimize=True)

    return {
        "id": cid,
        "walk": walk_path,
        "walk_size": walk.size,
        "walk_frame": (fw, fh),
        "faces": face_path if used else None,
        "faces_n": used,
        "faces_size": (fw2 * used, fh2) if used else None,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/tbtak-split", help="输出目录（默认 /tmp/tbtak-split）")
    ap.add_argument("--only", default="", help="只处理这些 id（逗号分隔），默认全部")
    args = ap.parse_args()

    data = json.loads(INDEX.read_text(encoding="utf-8"))
    cast = data.get("cast") or {}
    if not cast:
        raise SystemExit(f"{INDEX} 里没有 cast？先跑 tools/build-tbtak.py")

    only = [x.strip() for x in args.only.split(",") if x.strip()]
    ids = [x for x in cast if (not only or x in only)]

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"输出到 {out_dir}")
    for cid in ids:
        r = split_one(cid, cast[cid], out_dir)
        name = cast[cid].get("n", cid)
        face_txt = f"{r['faces_size'][0]}×{r['faces_size'][1]}（{r['faces_n']} 张）" if r["faces"] else "没有可用表情"
        print(f"  {name:<8} 行走 {r['walk_size'][0]:>4}×{r['walk_size'][1]:<4} 一格 {r['walk_frame'][0]}×{r['walk_frame'][1]}"
              f" | 脸图 {face_txt}")

    print("\n注意：拆出来的是「重排后的素材」，不是游戏工程里的原文件（只含 下/左/右 三行，表情只含用到的几张）。")


if __name__ == "__main__":
    main()
