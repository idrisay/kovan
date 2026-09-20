"""Ship the chosen icon: the .icns for the bundle, and the menu bar glyph.

The menu bar is a separate problem from the Dock. It wants a *template* image —
pure black plus alpha — which macOS recolours itself for light and dark menu
bars and for the highlighted state. Colour in a template image is discarded, so
the whole design there is the silhouette.
"""
from PIL import Image, ImageDraw, ImageFilter
import math, os, shutil, subprocess

exec(open('gen2.py').read().split('def a_indigo')[0])

CHOICE = 'E-amber-indigo'
OUT = '/Users/idrisay/Desktop/coding/ikatia/app/baton/apps/desktop/resources'

# ---- .icns ---------------------------------------------------------------
master = Image.open(f'{CHOICE}.png')
iconset = 'baton.iconset'
shutil.rmtree(iconset, ignore_errors=True)
os.makedirs(iconset)
for size in (16, 32, 128, 256, 512):
    master.resize((size, size), Image.LANCZOS).save(f'{iconset}/icon_{size}x{size}.png')
    master.resize((size * 2, size * 2), Image.LANCZOS).save(f'{iconset}/icon_{size}x{size}@2x.png')
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', f'{OUT}/icon.icns'], check=True)
shutil.rmtree(iconset)
print('icon.icns written')

# ---- menu bar template ---------------------------------------------------
def tray(pt):
    """A baton glyph at `pt` points, rendered 8x and reduced for clean edges.

    Drawn slightly shorter and thicker than the Dock icon: at 16px a faithful
    scale of the app icon becomes a hairline, and a hairline in a menu bar
    reads as dirt on the screen rather than as a symbol.
    """
    F = 8
    n = pt * F
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = n / 2
    a = math.radians(-38)
    L = n * 0.72
    t = n * 0.235
    dx, dy = math.cos(a) * L / 2, math.sin(a) * L / 2
    p0, p1 = (c - dx, c - dy), (c + dx, c + dy)
    d.line([p0, p1], fill=(0, 0, 0, 255), width=int(t), joint='curve')
    r = t / 2
    for (px, py) in (p0, p1):
        d.ellipse([px - r, py - r, px + r, py + r], fill=(0, 0, 0, 255))
    out = img.resize((pt, pt), Image.LANCZOS)
    # Template images are black plus alpha. Any stray colour is discarded by
    # macOS anyway, so normalise it here rather than leave it to chance.
    px = out.load()
    for y in range(pt):
        for x in range(pt):
            px[x, y] = (0, 0, 0, px[x, y][3])
    return out

tray(16).save(f'{OUT}/trayTemplate.png')
tray(32).save(f'{OUT}/trayTemplate@2x.png')
print('trayTemplate written')

# ---- proof sheet ---------------------------------------------------------
sheet = Image.new('RGB', (760, 300), (245, 245, 247))
d = ImageDraw.Draw(sheet)
d.rectangle([0, 150, 760, 300], fill=(28, 29, 33))
for j, sz in enumerate((128, 64, 32, 16)):
    s = master.resize((sz, sz), Image.LANCZOS)
    sheet.paste(s, (30 + j * 150, 30 + (128 - sz) // 2), s)
d.text((30, 8), 'app icon', fill=(60, 60, 66))

# The tray glyph as macOS will actually draw it: black on a light menu bar,
# white on a dark one.
for j, (bg, fg, label) in enumerate(((( 245,245,247), (0,0,0), 'light menu bar'),
                                     ((28,29,33), (255,255,255), 'dark menu bar'))):
    y = 170 + j * 60
    d.rectangle([30, y - 8, 360, y + 32], fill=bg)
    for k, pt in enumerate((16, 32)):
        g = tray(pt)
        tinted = Image.new('RGBA', g.size, fg + (255,))
        tinted.putalpha(g.split()[3])
        sheet.paste(tinted, (46 + k * 60, y + (32 - pt) // 2), tinted)
    d.text((190, y + 8), label, fill=fg)
sheet.save('proof.png')
print('proof written')
