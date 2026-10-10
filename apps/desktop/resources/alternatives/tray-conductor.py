"""Menu bar glyph for the conductor icon.

Redrawn, not traced: lifted off the app icon, the hairline baton vanished at
16pt and the arcs read as a scribbled "9". This keeps the idea — a baton on
the diagonal with a round handle, two arcs swept from its tip — at stroke
widths that survive the menu bar. Black plus alpha: a template image macOS
recolours for light and dark menu bars.
"""
from PIL import Image, ImageDraw

OUT = '/Users/idrisay/Desktop/coding/ikatia/app/kovan/apps/desktop/resources'
N = 512  # drawn big, then shrunk

def qcurve(p0, p1, p2, steps=60):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])
            for t in (i / steps for i in range(steps + 1))]

def stroke(d, pts, w):
    d.line(pts, fill=255, width=w, joint='curve')
    r = w / 2
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)

def draw() -> Image.Image:
    m = Image.new('L', (N, N), 0)
    d = ImageDraw.Draw(m)
    # Baton: lower-left handle to upper-right tip.
    stroke(d, [(118, 402), (468, 46)], 40)
    d.ellipse([56, 360, 150, 454], fill=255)  # handle
    # Two arcs swept from near the tip, round the left, back towards the handle.
    stroke(d, qcurve((400, 46), (60, 60), (64, 300)), 38)
    stroke(d, qcurve((392, 120), (168, 118), (160, 270)), 34)
    return m

def glyph(pt: int) -> Image.Image:
    out = Image.new('RGBA', (pt, pt), (0, 0, 0, 0))
    out.putalpha(draw().resize((pt, pt), Image.LANCZOS))
    return out

glyph(16).save(f'{OUT}/trayTemplate.png')
glyph(32).save(f'{OUT}/trayTemplate@2x.png')

# Proof: 16 and 32 at real size, then 32 enlarged, on light and dark bars.
proof = Image.new('RGB', (260, 200), (236, 235, 229))
d = ImageDraw.Draw(proof)
d.rectangle([0, 100, 260, 200], fill=(30, 31, 36))
for row, fg in ((0, (0, 0, 0)), (1, (255, 255, 255))):
    y = row * 100 + 10
    for x, img in ((16, glyph(16)), (48, glyph(32)), (110, glyph(32).resize((80, 80), Image.NEAREST))):
        tint = Image.new('RGBA', img.size, fg + (255,)); tint.putalpha(img.split()[3])
        proof.paste(tint, (x, y), tint)
proof.save('proof-tray-conductor.png')
print('tray glyph written')
