#!/usr/bin/env python3
"""
Turn the raw "Rice leaf disease classification" download into upload-ready
folders for the `palay-disease` Roboflow project.

Source layout:
    Rice disease leaf/Train/<class>/...     originals, already split
    Rice disease leaf/Test/<class>/...
    Rice leaf augumention/<class>/...       AUGMENTED COPIES — never used

Why the augmented folder is excluded: those images are transformed duplicates of
the originals. Training on them and validating on originals leaks the answer, and
the reported accuracy becomes meaningless.

Why only the Train split: Roboflow re-splits 70/20/10 itself, and the source
Test split may share source photos with Train.

Usage:
    python tools/arrange_palay.py --src "dataset/palay_disease" --out "dataset/upload/palay-disease"
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from PIL import Image

IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}

# source folder (lowercased, non-alnum stripped) -> diseases.code
MAP = {
    'bacterialleafblight': 'palay_bacterial_blight',
    'brownspot': 'palay_brown_spot',
    'healthy': 'palay_healthy',
    'leafblast': 'palay_blast',
    'sheathblight': 'palay_sheath_blight',
    'tungro': 'palay_tungro',
}

# Present in the download, absent from diseases.code. Including them would teach
# the model classes the app can never display.
SKIP = {
    'leafscald', 'narrowbrownspot', 'neckblast', 'ricehispa',
}


def key(name: str) -> str:
    return ''.join(ch for ch in name.lower() if ch.isalnum())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=Path('dataset/palay_disease'), type=Path)
    ap.add_argument('--out', default=Path('dataset/upload/palay-disease'), type=Path)
    ap.add_argument('--per-class', default=500, type=int, dest='per_class')
    args = ap.parse_args()

    train = args.src / 'Rice leaf disease classification' / 'Rice leaf disease classification' / 'Rice disease leaf' / 'Train'
    if not train.is_dir():
        print(f'error: {train} not found')
        return 1

    total = 0
    for folder in sorted(p for p in train.iterdir() if p.is_dir()):
        code = MAP.get(key(folder.name))
        if not code:
            if key(folder.name) in SKIP:
                print(f'skip  {folder.name}: no matching diseases.code')
            else:
                print(f'skip  {folder.name}: unmapped')
            continue

        files = [p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXT]
        files.sort()

        dest = args.out / code
        dest.mkdir(parents=True, exist_ok=True)

        kept = 0
        for path in files:
            if kept >= args.per_class:
                break
            try:
                with Image.open(path) as im:
                    im.verify()
            except Exception:
                continue
            shutil.copy2(path, dest / f'{kept:05d}{path.suffix.lower()}')
            kept += 1

        total += kept
        print(f'{code}: {kept}')

    print(f'\n{total} images -> {args.out.resolve()}')
    print('upload one folder per class to the palay-disease project.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
