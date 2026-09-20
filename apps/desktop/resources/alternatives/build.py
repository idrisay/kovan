"""Ship the ceremonial baton.

Two separate jobs:
  - the .icns, which carries a *different drawing per size*: the detailed art
    with lacing for 128px and up, the simplified silhouette for 16/32/64 where
    lacing is a smudge. This is the mechanism .icns exists for.
  - the menu bar glyph, which is a template image — black plus alpha, recoloured
    by macOS. No lacing, no chrome, no colour. Only the silhouette, which for
    this object is spike → shaft → ball, and that is legible.
"""
exec(open('mehter4.py').read().split('PALETTES = {')[0])
from PIL import Image, ImageDraw
import os, shutil, subprocess, math

CHOICE = ((56, 72, 128), (16, 22, 54))          # navy
OUT = '/Users/idrisay/Desktop/coding/ikatia/app/baton/apps/desktop/resources'

detailed = compose(*CHOICE, detail=True).resize((S, S), Image.LANCZOS)
simple   = compose(*CHOICE, detail=False, s=1.34).resize((S, S), Image.LANCZOS)
detailed.save('Q1-navy.png')

iconset = 'baton.iconset'
shutil.rmtree(iconset, ignore_errors=True)
os.makedirs(iconset)
for size in (16, 32, 128, 256, 512):
    for suffix, px in ((f'{size}x{size}', size), (f'{size}x{size}@2x', size * 2)):
        # 64px and below get the simplified drawing.
        src = simple if px <= 64 else detailed
        src.resize((px, px), Image.LANCZOS).save(f'{iconset}/icon_{suffix}.png')
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', f'{OUT}/icon.icns'], check=True)
shutil.rmtree(iconset)
print('icon.icns written (simplified art below 64px)')

def tray(pt):
    """Silhouette only: spike, shaft, ball. Drawn 8x and reduced."""
    F = 8; n = pt * F
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = n / 2
    a = math.radians(52)
    ax, ay = math.cos(a), math.sin(a)
    nx, ny = -math.sin(a), math.cos(a)
    def P(al, ac=0.0): return (c + ax * al + nx * ac, c + ay * al + ny * ac)
    L = n * 0.86
    tip, end = -L / 2, L / 2
    sw = n * 0.125
    r = sw * 1.02
    a0, a1 = tip + L * 0.30, end - r * 2.0

    def tap(x0, x1, w0, w1):
        l, rr = [], []
        for i in range(41):
            t = i / 40; al = x0 + (x1 - x0) * t; w = (w0 + (w1 - w0) * t) / 2
            l.append(P(al, -w)); rr.append(P(al, w))
        d.polygon(l + rr[::-1], fill=(0, 0, 0, 255))

    tap(tip, a0, sw * .10, sw * .92)      # spike
    tap(a0, a1, sw * .90, sw)             # shaft
    tap(a1, end - r * 1.3, sw, r * 1.7)   # neck
    bx, by = P(end - r)
    d.ellipse([bx - r, by - r, bx + r, by + r], fill=(0, 0, 0, 255))

    out = img.resize((pt, pt), Image.LANCZOS)
    px = out.load()
    for y in range(pt):
        for x in range(pt):
            px[x, y] = (0, 0, 0, px[x, y][3])
    return out

tray(16).save(f'{OUT}/trayTemplate.png')
tray(32).save(f'{OUT}/trayTemplate@2x.png')
print('trayTemplate written')

# proof
proof = Image.new('RGB', (760, 330), (245, 245, 247))
d = ImageDraw.Draw(proof)
d.rectangle([0, 170, 760, 330], fill=(28, 29, 33))
for j, (sz, src) in enumerate(((128, detailed), (64, simple), (32, simple), (16, simple))):
    s_ = src.resize((sz, sz), Image.LANCZOS)
    proof.paste(s_, (30 + j * 150, 30 + (128 - sz) // 2), s_)
d.text((30, 8), 'app icon  (detailed >=128,  simplified <=64)', fill=(60, 60, 66))
for j, (bg, fg, label) in enumerate((((245, 245, 247), (0, 0, 0), 'light menu bar'),
                                     ((28, 29, 33), (255, 255, 255), 'dark menu bar'))):
    y = 195 + j * 62
    d.rectangle([30, y - 10, 370, y + 36], fill=bg)
    for k, pt in enumerate((16, 32)):
        g = tray(pt)
        tint = Image.new('RGBA', g.size, fg + (255,)); tint.putalpha(g.split()[3])
        proof.paste(tint, (50 + k * 64, y + (32 - pt) // 2), tint)
    d.text((200, y + 8), label, fill=fg)
proof.save('proof2.png')
print('proof written')
