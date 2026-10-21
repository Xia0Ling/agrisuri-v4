#!/usr/bin/env python3
"""
Degrade the evaluation set to approximate a phone photo.

Why: the models were trained on images drawn from the same pool as `_eval`, so
in-distribution accuracy measures memorisation as much as learning. Real scans
are handheld, differently lit, slightly rotated and recompressed.

This does NOT replace a field test on 50 real photos. It answers one narrower
question: does accuracy survive capture variance, or does it collapse?

    python tools/make_stress_set.py
    node tools/accuracy.js --dir tools/_eval_stress --out tools/accuracy-stress.json
"""

import random
import shutil
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "_eval"
OUT = ROOT / "tools" / "_eval_stress"

SEED = 7
random.seed(SEED)


def degrade(im: Image.Image) -> Image.Image:
    # Crop in, like a phone held slightly too close.
    w, h = im.size
    keep = random.uniform(0.85, 1.0)
    cw, ch = int(w * keep), int(h * keep)
    x = random.randint(0, w - cw)
    y = random.randint(0, h - ch)
    im = im.crop((x, y, x + cw, y + ch))

    im = im.rotate(random.uniform(-8, 8), resample=Image.BICUBIC, expand=False)

    im = ImageEnhance.Brightness(im).enhance(random.uniform(0.78, 1.22))
    im = ImageEnhance.Contrast(im).enhance(random.uniform(0.85, 1.15))

    if random.random() < 0.5:
        im = im.filter(ImageFilter.GaussianBlur(random.uniform(0.4, 1.2)))

    # Handheld photos are rarely larger than this.
    if max(im.size) > 400:
        scale = 400 / max(im.size)
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)

    return im


def main() -> None:
    if not SRC.exists():
        raise SystemExit("Run tools/make_eval_set.py first.")
    if OUT.exists():
        shutil.rmtree(OUT)

    n = 0
    for src in sorted(SRC.rglob("*.jpg")):
        rel = src.relative_to(SRC)
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            degrade(im.convert("RGB")).save(dst, "JPEG", quality=60)
        n += 1

    print(f"{n} degraded images written to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
