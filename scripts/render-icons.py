#!/usr/bin/env python3
"""Build opaque Core Sample icons from the v3 master.

Joe's 512 source is kept at app/icons/source/core-sample-icon-source-v3.jpg.
The 1024 master is cropped inside the light bezel (x 77..436, y 77..441)
with the square corners filled by projecting the tile's own edge pixels
outward, so there is no bezel line or outer frame. iOS masks its own
corners. Requires Pillow (`pip install pillow`).
"""

import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'app' / 'icons' / 'source' / 'core-sample-icon-source-v3.jpg'
MASTER = ROOT / 'app' / 'icons' / 'source' / 'core-sample-icon-full-v3.png'
OUT = ROOT / 'app' / 'icons'

# Inside the light bezel. Inclusive source pixels. The crop is slightly taller
# than it is wide; the master is the square that fills those corners.
X0, Y0, X1, Y1 = 77, 77, 436, 441
RADIUS = 54
TAG = 'v41'


def in_tile(x, y):
    if x < X0 or y < Y0 or x > X1 or y > Y1:
        return False
    cx = X0 + RADIUS if x < X0 + RADIUS else (X1 - RADIUS if x > X1 - RADIUS else None)
    cy = Y0 + RADIUS if y < Y0 + RADIUS else (Y1 - RADIUS if y > Y1 - RADIUS else None)
    if cx is None or cy is None:
        return True
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= (RADIUS - 0.5) ** 2


def corner_center(x, y):
    if x < X0 + RADIUS and y < Y0 + RADIUS:
        return X0 + RADIUS, Y0 + RADIUS
    if x > X1 - RADIUS and y < Y0 + RADIUS:
        return X1 - RADIUS, Y0 + RADIUS
    if x < X0 + RADIUS and y > Y1 - RADIUS:
        return X0 + RADIUS, Y1 - RADIUS
    if x > X1 - RADIUS and y > Y1 - RADIUS:
        return X1 - RADIUS, Y1 - RADIUS
    return None


def tile_from_source(source):
    px = source.load()
    side = min(X1 - X0 + 1, Y1 - Y0 + 1)
    left = int(round((X0 + X1) / 2 - side / 2))
    top = int(round((Y0 + Y1) / 2 - side / 2))
    image = Image.new('RGB', (side, side))
    out = image.load()
    for y in range(side):
        for x in range(side):
            sx, sy = left + x, top + y
            if in_tile(sx, sy):
                out[x, y] = px[sx, sy]
                continue
            center = corner_center(sx, sy)
            if center is None:
                sx = min(max(sx, X0), X1)
                sy = min(max(sy, Y0), Y1)
                out[x, y] = px[sx, sy]
                continue
            ccx, ccy = center
            dx, dy = sx - ccx, sy - ccy
            dist = math.hypot(dx, dy) or 1
            scale = (RADIUS - 1.5) / dist
            ix = int(round(ccx + dx * scale))
            iy = int(round(ccy + dy * scale))
            out[x, y] = px[min(max(ix, 0), source.width - 1), min(max(iy, 0), source.height - 1)]
    return image


def maskable(tile, size=512):
    art_size = round(size * 0.8)
    art = tile.resize((art_size, art_size), Image.Resampling.LANCZOS)
    offset = (size - art_size) // 2
    canvas = Image.new('RGB', (size, size))
    src = art.load()
    dst = canvas.load()
    last = art_size - 1
    for y in range(size):
        for x in range(size):
            sx = min(max(x - offset, 0), last)
            sy = min(max(y - offset, 0), last)
            dst[x, y] = src[sx, sy]
    return canvas


def save_png(image, name):
    path = OUT / name
    image.save(path, format='PNG', optimize=True)
    return path


def load_tile():
    if MASTER.exists():
        tile = Image.open(MASTER).convert('RGB')
        if tile.size != (1024, 1024):
            raise SystemExit(f'master is {tile.size}, expected 1024x1024')
        return tile
    source = Image.open(SOURCE).convert('RGB')
    if source.size != (512, 512):
        raise SystemExit(f'source is {source.size}, expected 512x512')
    return tile_from_source(source).resize((1024, 1024), Image.Resampling.LANCZOS)


def main():
    tile = load_tile()
    save_png(tile.resize((180, 180), Image.Resampling.LANCZOS), f'icon-{TAG}-180.png')
    save_png(tile.resize((192, 192), Image.Resampling.LANCZOS), f'icon-{TAG}-192.png')
    save_png(tile.resize((512, 512), Image.Resampling.LANCZOS), f'icon-{TAG}-512.png')
    save_png(maskable(tile, 512), f'icon-{TAG}-512-maskable.png')
    icon32 = tile.resize((32, 32), Image.Resampling.LANCZOS)
    icon16 = tile.resize((16, 16), Image.Resampling.LANCZOS)
    save_png(icon32, f'icon-{TAG}-32.png')
    save_png(icon16, f'icon-{TAG}-16.png')
    tile.save(OUT / f'favicon-{TAG}.ico', format='ICO', sizes=[(16, 16), (32, 32)])
    origin = MASTER.name if MASTER.exists() else SOURCE.name
    print('wrote icons from', origin)


if __name__ == '__main__':
    main()
