"""App icon and menu bar glyph: `K-cells`, a K built from hive cells.

Kovan is Turkish for beehive. The stem is three off-white cells, the upper
arm two clay cells (working), the lower arm two grey cells (waiting). Chosen
on 2026-09-30 from ten options (five by Codex, five by Claude; the artifact
https://claude.ai/artifact/51VPzLg52bzRTquqrGBoZN).

Drawn here rather than traced, at 4x and scaled down, so every size is sharp:
`icon.icns` on Apple's grid (an 824px tile centred in 1024) and the template
glyph for the menu bar, whose gaps between cells are wider so the cells stay
apart at 16pt. Run `python3 build-k-cells.py`.
"""
from PIL import Image, ImageDraw
import math, os, shutil, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)

TILE = (22, 24, 28, 255)       # #16181c
INK = (241, 237, 230, 255)     # #f1ede6
CLAY = (217, 119, 87, 255)     # #d97757, --clay
GREY = (58, 62, 70, 255)       # #3a3e46
SS = 4

# The K on a 1024 grid: flat-topped cells of radius R, the stem centred on
# STEM_X, the whole mark centred in the tile.
R = 112
H = R * math.sqrt(3)
STEM_X = 344
CELLS = [
    (STEM_X, 512 - H, 'ink'), (STEM_X, 512, 'ink'), (STEM_X, 512 + H, 'ink'),
    (STEM_X + 1.5 * R, 512 - H / 2, 'clay'), (STEM_X + 3 * R, 512 - H, 'clay'),
    (STEM_X + 1.5 * R, 512 + H / 2, 'grey'), (STEM_X + 3 * R, 512 + H, 'grey'),
]


def hexagon(cx, cy, r, scale):
    return [((cx + r * math.cos(math.radians(60 * k))) * scale, (cy + r * math.sin(math.radians(60 * k))) * scale) for k in range(6)]


def draw_icon(size):
    s = size * SS / 1024
    im = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([100 * s, 100 * s, 924 * s, 924 * s], radius=185 * s, fill=TILE)
    for cx, cy, tone in CELLS:
        d.polygon(hexagon(cx, cy, R - 8, s), fill={'ink': INK, 'clay': CLAY, 'grey': GREY}[tone])
    return im.resize((size, size), Image.LANCZOS)


def draw_glyph(size):
    """Black plus alpha: macOS recolours it. The waiting arm stays fainter."""
    x0, x1 = STEM_X - R, STEM_X + 4 * R
    y0, y1 = 512 - 1.5 * H, 512 + 1.5 * H
    span = max(x1 - x0, y1 - y0)
    s = size * SS / span
    ox = (span - (x1 - x0)) / 2 - x0
    oy = (span - (y1 - y0)) / 2 - y0
    im = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    gap = 40 if size <= 16 else 30
    for cx, cy, tone in CELLS:
        alpha = 110 if tone == 'grey' else 255
        d.polygon(hexagon(cx + ox, cy + oy, R - gap / 2, s), fill=(0, 0, 0, alpha))
    return im.resize((size, size), Image.LANCZOS)


master = draw_icon(1024)
master.save(os.path.join(HERE, 'K-cells.png'))

iconset = os.path.join(HERE, 'kovan.iconset')
shutil.rmtree(iconset, ignore_errors=True)
os.makedirs(iconset)
for size in (16, 32, 128, 256, 512):
    draw_icon(size).save(f'{iconset}/icon_{size}x{size}.png')
    draw_icon(size * 2).save(f'{iconset}/icon_{size}x{size}@2x.png')
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(OUT, 'icon.icns')], check=True)
shutil.rmtree(iconset)

draw_glyph(16).save(os.path.join(OUT, 'trayTemplate.png'))
draw_glyph(32).save(os.path.join(OUT, 'trayTemplate@2x.png'))

# A proof: the icon at Dock and Finder sizes, and the glyph on both menu bars.
proof = Image.new('RGB', (760, 200), (236, 235, 229))
d = ImageDraw.Draw(proof)
d.rectangle([380, 0, 760, 200], fill=(30, 31, 36))
for half, dark in ((0, False), (380, True)):
    x = half + 20
    for sz in (128, 64, 32, 16):
        icon = draw_icon(sz)
        proof.paste(icon, (x, 20 + (128 - sz) // 2), icon)
        x += sz + 14
    for sz, y in ((16, 164), (32, 156)):
        g = draw_glyph(sz)
        if dark:
            g = Image.merge('RGBA', (*[Image.new('L', g.size, 255)] * 3, g.split()[3]))
        proof.paste(g, (half + 40 + (0 if sz == 16 else 40), y), g)
proof.save(os.path.join(HERE, 'proof-k-cells.png'))
print('icon.icns, trayTemplate.png, trayTemplate@2x.png and proof-k-cells.png written')
