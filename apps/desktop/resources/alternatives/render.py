"""Refined round.

What the first round taught, looking at it rather than reasoning about it:
  - Only the shaded variant read as a *cylinder*. A flat capsule reads as a
    pencil or a slash, which is a different object.
  - The queue bars are the most on-message idea — the app is a queue of things
    waiting on you — but they need to survive being ignored at 16px.
  - Pure blue is generic. An indigo→violet carries further at small sizes and
    is not another blue square in the Dock.
"""
from PIL import Image, ImageDraw, ImageFilter
import math

S, SS = 1024, 2
W = S * SS

def squircle_mask(size, n=5.0):
    m = Image.new('L', (size, size), 0)
    px = m.load()
    r = size / 2
    c = size / 2
    for y in range(size):
        for x in range(size):
            v = (abs(x + .5 - c) / r) ** n + (abs(y + .5 - c) / r) ** n
            px[x, y] = 255 if v <= 1 else (int(255 * (1.25 - v) / .25) if v < 1.25 else 0)
    return m

def dgrad(size, a, b):
    g = Image.new('RGB', (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = x / size * .42 + y / size * .58
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return g

def blank(size=W):
    return Image.new('RGBA', (size, size), (0, 0, 0, 0))

def capsule_layer(p0, p1, thick, fill):
    layer = blank()
    d = ImageDraw.Draw(layer)
    d.line([p0, p1], fill=fill, width=int(thick), joint='curve')
    r = thick / 2
    for (px, py) in (p0, p1):
        d.ellipse([px - r, py - r, px + r, py + r], fill=fill)
    return layer

def cylinder(p0, p1, thick, angle, light=(255, 255, 255), mid=(238, 242, 252), dark=(150, 172, 214)):
    """A capsule shaded across its short axis, so it reads as a tube."""
    body = capsule_layer(p0, p1, thick, mid + (255,))
    alpha = body.split()[3]
    nx, ny = -math.sin(angle), math.cos(angle)

    shade = capsule_layer((p0[0] + nx * thick * .26, p0[1] + ny * thick * .26),
                          (p1[0] + nx * thick * .26, p1[1] + ny * thick * .26),
                          thick * .48, dark + (255,))
    body = Image.alpha_composite(body, Image.composite(shade, blank(), alpha))

    hi = capsule_layer((p0[0] - nx * thick * .22, p0[1] - ny * thick * .22),
                       (p1[0] - nx * thick * .22, p1[1] - ny * thick * .22),
                       thick * .30, light + (255,))
    body = Image.alpha_composite(body, Image.composite(
        hi.filter(ImageFilter.GaussianBlur(W * .004)), blank(), alpha))
    return body

def shadow(p0, p1, thick, strength=120):
    sh = capsule_layer((p0[0] + W * .011, p0[1] + W * .024),
                       (p1[0] + W * .011, p1[1] + W * .024), thick, (0, 0, 0, strength))
    return sh.filter(ImageFilter.GaussianBlur(W * .019))

def geo(length_f, angle_deg, dy=0.0):
    c = W / 2
    a = math.radians(angle_deg)
    dx_, dy_ = math.cos(a) * W * length_f / 2, math.sin(a) * W * length_f / 2
    return (c - dx_, c - dy_ + W * dy), (c + dx_, c + dy_ + W * dy), a

def finish(img, name):
    mask = squircle_mask(W)
    out = blank()
    out.paste(img, (0, 0), mask)
    sheen = Image.new('L', (W, W), 0)
    ImageDraw.Draw(sheen).ellipse([-W * .35, -W * .74, W * 1.35, W * .40], fill=42)
    sheen = sheen.filter(ImageFilter.GaussianBlur(W * .035))
    out = Image.alpha_composite(out, Image.composite(
        Image.new('RGBA', (W, W), (255, 255, 255, 255)), blank(),
        Image.composite(sheen, Image.new('L', (W, W), 0), mask)))
    out.resize((S, S), Image.LANCZOS).save(f'{name}.png')

def a_indigo():
    """Cylinder on indigo→violet. The safe, handsome one."""
    base = dgrad(W, (122, 118, 255), (67, 46, 178)).convert('RGBA')
    p0, p1, a = geo(.50, -38)
    t = W * .150
    base = Image.alpha_composite(base, shadow(p0, p1, t))
    finish(Image.alpha_composite(base, cylinder(p0, p1, t, a)), 'A-indigo')

def b_queue():
    """Cylinder lifted off a queue of three bars. The on-message one."""
    base = dgrad(W, (112, 124, 255), (58, 44, 165)).convert('RGBA')
    bars = blank()
    bd = ImageDraw.Draw(bars)
    bh = W * .050
    for i, alpha in enumerate((128, 86, 50)):
        w_ = W * .385 * (1 - i * .16)
        x = W / 2 - w_ / 2 + W * .015
        y = W * .620 + i * bh * 1.95
        bd.rounded_rectangle([x, y, x + w_, y + bh], radius=bh / 2, fill=(255, 255, 255, alpha))
    base = Image.alpha_composite(base, bars)
    p0, p1, a = geo(.46, -38, -.090)
    t = W * .140
    base = Image.alpha_composite(base, shadow(p0, p1, t, 130))
    finish(Image.alpha_composite(base, cylinder(p0, p1, t, a)), 'B-queue')

def c_amber():
    """Amber cylinder on deep slate. Warm, and unlike anything else in a Dock."""
    base = dgrad(W, (54, 58, 72), (24, 26, 34)).convert('RGBA')
    p0, p1, a = geo(.52, -38)
    t = W * .155
    glow = capsule_layer(p0, p1, t * 1.7, (255, 176, 66, 92))
    base = Image.alpha_composite(base, glow.filter(ImageFilter.GaussianBlur(W * .055)))
    base = Image.alpha_composite(base, shadow(p0, p1, t, 150))
    body = cylinder(p0, p1, t, a,
                    light=(255, 226, 168), mid=(252, 176, 62), dark=(198, 106, 20))
    finish(Image.alpha_composite(base, body), 'C-amber')

def d_teal():
    """Cylinder on teal→green. Reads as 'clear', which is the goal state."""
    base = dgrad(W, (58, 208, 184), (14, 118, 130)).convert('RGBA')
    p0, p1, a = geo(.50, -38)
    t = W * .150
    base = Image.alpha_composite(base, shadow(p0, p1, t))
    finish(Image.alpha_composite(base, cylinder(p0, p1, t, a)), 'D-teal')

for fn in (a_indigo, b_queue, c_amber, d_teal):
    fn(); print('rendered', fn.__name__)

names = ['A-indigo', 'B-queue', 'C-amber', 'D-teal']
sheet = Image.new('RGB', (1180, 300), (28, 29, 33))
d = ImageDraw.Draw(sheet)
for i, name in enumerate(names):
    src = Image.open(f'{name}.png')
    x = 40 + i * 285
    big = src.resize((160, 160), Image.LANCZOS)
    sheet.paste(big, (x, 40), big)
    for j, sz in enumerate((64, 32, 16)):
        sm = src.resize((sz, sz), Image.LANCZOS)
        sheet.paste(sm, (x + j * 60, 225 + (32 - sz) // 2), sm)
    d.text((x, 205), name, fill=(200, 202, 210))
sheet.save('contact-sheet-2.png')
print('sheet written')
