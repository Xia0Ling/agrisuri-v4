#!/usr/bin/env python3
"""
Build the three training sets for AgriSuri from public leaf datasets.

Why this exists: layers 1 and 2 must never be trained on whole PlantVillage
frames. Those images are shot on a lab bench, so a model trained on them learns
"grey background = leaf" instead of leaf shape or leaf texture. This script cuts
interior patches that contain no background, which is the only way to make the
gates usable in a field.

Output layout (one folder per class — zip it and upload to Roboflow):

    <out>/disease/<diseases.code>/...        full images, resized
    <out>/shape/plant|not_plant/...          whole images
    <out>/texture/leaf_texture/...           224 px interior patches
    <out>/texture/<wall|floor|paper|fabric>/  224 px patches from --negatives

Usage:
    python tools/prepare_datasets.py \
        --leaves  C:/data/PlantVillage \
        --negatives C:/data/surfaces \
        --out C:/data/agrisuri-dataset \
        --per-class 400

`--negatives` is optional; without it only the leaf side is produced.
Requires Pillow:  pip install pillow
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

from PIL import Image, ImageStat

IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}

# Folder name -> diseases.code in sql/schema.sql. First match wins, so the more
# specific patterns must come first.
RULES = [
    ('tomato', 'early', 'tomato_early_blight'),
    ('tomato', 'late', 'tomato_late_blight'),
    ('tomato', 'mold', 'tomato_leaf_mold'),
    ('tomato', 'septoria', 'tomato_septoria'),
    ('tomato', 'bacterial', 'tomato_bacterial_spot'),
    ('tomato', 'yellow', 'tomato_yellow_leaf_curl'),
    ('tomato', 'mosaic', 'tomato_mosaic'),
    ('tomato', 'healthy', 'tomato_healthy'),
    ('palay', 'blast', 'palay_blast'),
    ('palay', 'brown', 'palay_brown_spot'),
    ('palay', 'bacterial', 'palay_bacterial_blight'),
    ('palay', 'sheath', 'palay_sheath_blight'),
    ('palay', 'tungro', 'palay_tungro'),
    ('palay', 'healthy', 'palay_healthy'),
]

CROP_WORDS = {'tomato': 'tomato', 'palay': 'palay', 'rice': 'palay'}

# A patch is kept only if it has real structure and real colour. Grey lab
# background is low-saturation and nearly flat, so both tests reject it.
MIN_STDDEV = 12.0
MIN_SATURATION = 40.0


def crop_of(folder: str, hint: str | None) -> str | None:
    low = folder.lower()
    for word, crop in CROP_WORDS.items():
        if word in low:
            return crop
    return hint


def disease_code(folder: str, crop: str | None) -> str | None:
    if not crop:
        return None
    low = folder.lower()
    for want_crop, keyword, code in RULES:
        if want_crop == crop and keyword in low:
            return code
    return None


def iter_images(root: Path, limit: int, exclude: tuple[str, ...] = ()):
    seen = 0
    for path in root.rglob('*'):
        if path.suffix.lower() not in IMAGE_EXT or not path.is_file():
            continue
        if any(token in str(path) for token in exclude):
            continue
        yield path
        seen += 1
        if seen >= limit:
            return


def open_rgb(path: Path) -> Image.Image | None:
    try:
        img = Image.open(path)
        img.load()
        return img.convert('RGB')
    except Exception:
        return None


def resize_max(img: Image.Image, side: int) -> Image.Image:
    if max(img.size) <= side:
        return img
    img.thumbnail((side, side), Image.LANCZOS)
    return img


def usable_patch(patch: Image.Image) -> bool:
    """A leaf patch needs structure and colour.

    Grey bench background is flat and desaturated, so both tests reject it —
    that is the whole point of cropping instead of using the full frame.
    """
    stddev = sum(ImageStat.Stat(patch).stddev) / 3
    if stddev < MIN_STDDEV:
        return False
    return ImageStat.Stat(patch.convert('HSV')).mean[1] >= MIN_SATURATION


def interior_patch(img: Image.Image, size: int, rng: random.Random, tries: int = 6) -> Image.Image | None:
    """Random patch from the middle 60% of the frame — the leaf, not the bench."""
    w, h = img.size
    box_w, box_h = int(w * 0.6), int(h * 0.6)
    if box_w < size or box_h < size:
        scale = size / min(box_w, box_h)
        img = img.resize((max(size, int(w * scale)), max(size, int(h * scale))), Image.LANCZOS)
        w, h = img.size
        box_w, box_h = int(w * 0.6), int(h * 0.6)

    left0 = (w - box_w) // 2
    top0 = (h - box_h) // 2

    for _ in range(tries):
        x = left0 + rng.randint(0, max(0, box_w - size))
        y = top0 + rng.randint(0, max(0, box_h - size))
        patch = img.crop((x, y, x + size, y + size))
        if usable_patch(patch):
            return patch
    return None


def center_square(img: Image.Image, size: int) -> Image.Image:
    """Centre crop to a square, then resize. Used for explicit negatives.

    Negatives are trusted: a plain painted wall is a valid negative even though
    it is flat and grey, so no structure or colour filter is applied here.
    """
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)


def save(img: Image.Image, path: Path, quality: int = 88) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, 'JPEG', quality=quality, optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser(description='Build AgriSuri training sets.')
    ap.add_argument('--leaves', required=True, action='append', type=Path,
                    help='leaf dataset root; repeat the flag to merge several')
    ap.add_argument('--negatives', action='append', default=[], type=Path,
                    help='negative dataset root; repeat to merge')
    ap.add_argument('--exclude', action='append', default=[],
                    help='skip any path containing this substring, e.g. .coco')
    ap.add_argument('--collapse-negatives', metavar='CLASS', dest='collapse',
                    help='put every negative image into one class, e.g. not_leaf')
    ap.add_argument('--out', default=Path('dataset'), type=Path)
    ap.add_argument('--patch', default=224, type=int)
    ap.add_argument('--per-class', default=400, type=int, dest='per_class')
    ap.add_argument('--max-scan', default=8000, type=int, dest='max_scan')
    ap.add_argument('--crop', choices=['tomato', 'palay'], help='crop for folders that do not name one')
    ap.add_argument('--seed', default=42, type=int)
    args = ap.parse_args()

    for root in args.leaves:
        if not root.is_dir():
            print(f'error: {root} is not a folder', file=sys.stderr)
            return 1

    rng = random.Random(args.seed)
    out = args.out
    exclude = tuple(args.exclude)

    # Group leaf images by the disease code their folder maps to.
    by_code: dict[str, list[Path]] = {}
    unmapped: dict[str, int] = {}
    all_leaves: list[Path] = []

    # Walk folders, not files: PlantVillage is 126k images, and scanning it file
    # by file would hit the cap long before the Tomato___* folders.
    for root in args.leaves:
        if any(token in str(root) for token in exclude):
            continue
        folders = [root, *[d for d in root.rglob('*') if d.is_dir()]]
        for folder in folders:
            if any(token in str(folder) for token in exclude):
                continue
            files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXT]
            if not files:
                continue

            code = disease_code(folder.name, crop_of(folder.name, args.crop))
            if not code:
                low = folder.name.lower()
                if 'tomato' in low or 'rice' in low or 'palay' in low:
                    unmapped[folder.name] = len(files)
                continue

            all_leaves.extend(files)
            bucket = by_code.setdefault(code, [])
            bucket.extend(files[: args.per_class * 2])

    # 1. Disease sets — full images, one folder per class.
    for code, paths in sorted(by_code.items()):
        rng.shuffle(paths)
        kept = 0
        for path in paths[: args.per_class]:
            img = open_rgb(path)
            if img is None:
                continue
            save(resize_max(img, 640), out / 'disease' / code / f'{kept:05d}.jpg')
            kept += 1
        print(f'disease/{code}: {kept}')

    # 2. Shape set — whole leaf frames. Negatives come from --negatives.
    rng.shuffle(all_leaves)
    plant = all_leaves[: args.per_class]
    kept = 0
    for path in plant:
        img = open_rgb(path)
        if img is None:
            continue
        save(resize_max(img, 512), out / 'shape' / 'plant' / f'{kept:05d}.jpg')
        kept += 1
    print(f'shape/plant: {kept}')

    # 3. Texture set — interior patches, the only usable training signal for layer 2.
    kept = 0
    for path in all_leaves:
        if kept >= args.per_class:
            break
        img = open_rgb(path)
        if img is None:
            continue
        patch = interior_patch(img, args.patch, rng)
        if patch is None:
            continue
        save(patch, out / 'texture' / 'leaf_texture' / f'{kept:05d}.jpg')
        kept += 1
    print(f'texture/leaf_texture: {kept}')

    # 4. Negatives — same patch size, otherwise the model learns scale, not texture.
    roots = [r for r in args.negatives if r.is_dir()]
    if not roots:
        print('texture negatives: skipped (no --negatives)')
    else:
        groups: dict[str, list[Path]] = {}
        if args.collapse:
            groups[args.collapse] = [
                p for root in roots for p in iter_images(root, args.max_scan, exclude)
            ]
        else:
            for root in roots:
                for folder in sorted(p for p in root.iterdir() if p.is_dir()):
                    groups[folder.name] = list(iter_images(folder, args.max_scan, exclude))

        for name, paths in groups.items():
            rng.shuffle(paths)

            kept = 0
            for path in paths:
                if kept >= args.per_class:
                    break
                img = open_rgb(path)
                if img is None:
                    continue
                save(center_square(img, args.patch), out / 'texture' / name / f'{kept:05d}.jpg')
                kept += 1
            print(f'texture/{name}: {kept}')

            neg_kept = 0
            for path in paths:
                if neg_kept >= args.per_class:
                    break
                img = open_rgb(path)
                if img is None:
                    continue
                save(resize_max(img, 512), out / 'shape' / 'not_plant' / f'{neg_kept:05d}.jpg')
                neg_kept += 1
            print(f'shape/not_plant: {neg_kept}')

    if unmapped:
        print('\nfolders with no matching diseases.code (skipped for layer 3):')
        for folder, count in sorted(unmapped.items(), key=lambda kv: -kv[1])[:12]:
            print(f'  {folder} ({count})')

    print(f'\nwrote to {out.resolve()}')
    print('zip each class folder and upload it to the matching Roboflow project.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
