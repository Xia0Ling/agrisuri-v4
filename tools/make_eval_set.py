#!/usr/bin/env python3
"""
Build a fixed evaluation set for accuracy measurement.

Why a separate set: `script/quality.js` downscales to 512 px and re-encodes as
JPEG q82 before inference. Measuring accuracy on full-resolution originals
measures a different input than the app ever sends. This script reproduces that
preprocessing exactly, so the number the report prints is the number a farmer
would experience.

    python tools/make_eval_set.py --per-class 8
    python tools/make_eval_set.py --per-class 20 --seed 42

Writes tools/_eval/<group>/<class>/<n>.jpg and is gitignored.
"""

import argparse
import random
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tools" / "_eval"

GROUPS = {
    "tomato": ROOT / "dataset" / "tomato_disease",
    "palay": ROOT / "dataset" / "palay-disease",
    "negative": ROOT / "dataset" / "texture" / "not_leaf",
}

MAX_EDGE = 512
QUALITY = 82


def preprocess(src: Path, dst: Path) -> bool:
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            scale = min(1.0, MAX_EDGE / max(im.size))
            if scale < 1.0:
                size = (max(1, round(im.width * scale)), max(1, round(im.height * scale)))
                im = im.resize(size, Image.LANCZOS)
            dst.parent.mkdir(parents=True, exist_ok=True)
            im.save(dst, "JPEG", quality=QUALITY)
        return True
    except Exception as exc:  # a corrupt file must not abort the whole run
        print(f"    skip {src.name}: {exc}")
        return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-class", type=int, default=8)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    random.seed(args.seed)

    if OUT.exists():
        shutil.rmtree(OUT)

    total = 0
    for group, root in GROUPS.items():
        if not root.exists():
            print(f"{group}: missing {root}")
            continue
        # The negative folder holds loose images, not class subfolders.
        classes = [root] if group == "negative" else sorted(p for p in root.iterdir() if p.is_dir())
        for cls_dir in classes:
            files = sorted(cls_dir.glob("*.jpg")) + sorted(cls_dir.glob("*.png"))
            if not files:
                print(f"  {cls_dir.name}: no images")
                continue
            picked = random.sample(files, min(args.per_class, len(files)))
            written = 0
            for i, src in enumerate(picked):
                if preprocess(src, OUT / group / cls_dir.name / f"{i:03d}.jpg"):
                    written += 1
            total += written
            print(f"  {group}/{cls_dir.name:26s} {written:3d}")

    print(f"\n{total} images written to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
