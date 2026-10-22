#!/usr/bin/env python3
"""
Generate home-screen icons from the logo.

iOS renders transparency as BLACK on the home screen, and wants a 180x180 PNG.
Android/Chrome read the manifest. Both get an opaque tile built from the same
source so the icon looks the same everywhere.

    python tools/make_icons.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "AgriSuri_Logo.png"
OUT = ROOT / "assets"

# Opaque background. The logo is green on transparency, so white keeps contrast.
BG = (255, 255, 255)

TARGETS = [
    ("apple-touch-icon.png", 180),
    ("icon-192.png", 192),
    ("icon-512.png", 512),
]

# Fraction of the tile the mark may occupy. Android's maskable safe zone is 80%,
# so staying at or below that survives any shape mask.
CONTENT = 0.78


def build(src: Image.Image, size: int) -> Image.Image:
    im = src.convert("RGBA")

    bbox = im.split()[-1].getbbox()
    if bbox:
        im = im.crop(bbox)

    # Square it off first so the mark is not stretched.
    side = max(im.size)
    square = Image.new("RGBA", (side, side), BG + (255,))
    square.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)

    inner = max(1, round(size * CONTENT))
    mark = square.resize((inner, inner), Image.LANCZOS)

    tile = Image.new("RGB", (size, size), BG)
    off = (size - inner) // 2
    tile.paste(mark, (off, off), mark)
    return tile


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC}")

    src = Image.open(SRC)
    for name, size in TARGETS:
        icon = build(src, size)
        path = OUT / name
        icon.save(path, "PNG", optimize=True)
        print(f"  {name:24s} {icon.size[0]}x{icon.size[1]}  {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
