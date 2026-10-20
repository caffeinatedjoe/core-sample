#!/usr/bin/env python3
"""Build opaque Core Sample icons from the source photo.

The source is a 512 square: a dark rounded tile with a light border, sitting
on a darker margin. iOS masks its own corners, so the output is the tile
only, cropped inside that border, with the tile color extended into the
square corners. Requires Pillow (`pip install pillow`).
"""

import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'app' / 'icons' / 'source' / 'core-sample-icon-source.jpg'
OUT = ROOT / 'app' / 'icons'

# Tile body, inside the baked-in light border. Inclusive source pixels.
X0, Y0, X1, Y1 = 82, 81, 429, 437
RADIUS = 64


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


def tile_square(source):
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


def main():
    source = Image.open(SOURCE).convert('RGB')
    if source.size != (512, 512):
        raise SystemExit(f'source is {source.size}, expected 512x512')
    tile = tile_square(source)
    full = tile.resize((512, 512), Image.Resampling.LANCZOS)
    save_png(tile.resize((180, 180), Image.Resampling.LANCZOS), 'icon-v9-180.png')
    save_png(tile.resize((192, 192), Image.Resampling.LANCZOS), 'icon-v9-192.png')
    save_png(full, 'icon-v9-512.png')
    save_png(maskable(tile, 512), 'icon-v9-512-maskable.png')
    icon32 = tile.resize((32, 32), Image.Resampling.LANCZOS)
    icon16 = tile.resize((16, 16), Image.Resampling.LANCZOS)
    save_png(icon32, 'icon-v9-32.png')
    save_png(icon16, 'icon-v9-16.png')
    full.save(OUT / 'favicon-v9.ico', format='ICO', sizes=[(16, 16), (32, 32)])
    print('wrote icons from', SOURCE.name)


if __name__ == '__main__':
    main()
