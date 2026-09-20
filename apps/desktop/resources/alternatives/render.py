"""Round three.

What round two showed, again by looking rather than reasoning:
  - The bulb had a dark ring around it and read as a magnifying glass. The
    cause was a compositing slip; the fix is to shade a sphere properly — a
    radial ramp from a light high-left to a dark low-right, plus the rim light
    that is what actually makes chrome look like chrome.
  - The spear tip was a stubby rocket nose. The reference's tip is long and
    fine, so it is now ~30% of the length and much narrower.
  - A 38-degree diagonal wasted the corners. At 52 degrees the object is longer
    inside the same tile, which suits a long, elegant thing.
"""
from PIL import Image, ImageDraw, ImageFilter
import math

S, SS = 1024, 2
W = S * SS

def squircle_mask(size, n=5.0):
    m = Image.new('L', (size, size), 0); px = m.load(); r = c = size / 2
    for y in range(size):
        for x in range(size):
            v = (abs(x + .5 - c) / r) ** n + (abs(y + .5 - c) / r) ** n
            px[x, y] = 255 if v <= 1 else (int(255 * (1.25 - v) / .25) if v < 1.25 else 0)
    return m

def dgrad(size, a, b):
    g = Image.new('RGB', (size, size)); px = g.load()
    for y in range(size):
        for x in range(size):
            t = x / size * .42 + y / size * .58
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return g

def blank(size=W): return Image.new('RGBA', (size, size), (0, 0, 0, 0))

ANGLE = math.radians(52)
AX, AY = math.cos(ANGLE), math.sin(ANGLE)
NX, NY = -math.sin(ANGLE), math.cos(ANGLE)
def at(cx, cy, a, n=0.0): return (cx + AX * a + NX * n, cy + AY * a + NY * n)

def tapered(d, cx, cy, a0, a1, w0, w1, fill, steps=56):
    l, r = [], []
    for i in range(steps + 1):
        t = i / steps; a = a0 + (a1 - a0) * t; w = (w0 + (w1 - w0) * t) / 2
        l.append(at(cx, cy, a, -w)); r.append(at(cx, cy, a, w))
    d.polygon(l + r[::-1], fill=fill)

RED_HI, RED, RED_LO = (240, 84, 70), (197, 25, 31), (112, 9, 19)
CHR_HI, CHR, CHR_LO = (255, 255, 255), (186, 195, 210), (78, 86, 104)

def chrome_sphere(size, r):
    """A shaded metal sphere on its own layer.

    Light high-left, shadow low-right, and a rim light on the shadow side —
    that last one is the whole difference between chrome and grey plastic.
    """
    n = int(r * 2) + 4
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    px = img.load()
    c = n / 2
    lx, ly = -0.46, -0.52          # light direction, normalised below
    ll = math.hypot(lx, ly, 0.72)
    lx, ly, lz = lx / ll, ly / ll, 0.72 / ll
    for y in range(n):
        for x in range(n):
            dx, dy = (x + .5 - c) / r, (y + .5 - c) / r
            d2 = dx * dx + dy * dy
            if d2 > 1.0:
                continue
            dz = math.sqrt(max(0.0, 1.0 - d2))
            lam = max(0.0, dx * lx + dy * ly + dz * lz)
            # Two-tone metal ramp rather than a linear one.
            t = lam ** 0.75
            col = [int(CHR_LO[i] + (CHR[i] - CHR_LO[i]) * min(1.0, t * 1.6)) for i in range(3)]
            if t > 0.62:
                k = (t - 0.62) / 0.38
                col = [int(col[i] + (CHR_HI[i] - col[i]) * k ** 1.7) for i in range(3)]
            # Rim light: the bright edge chrome picks up from the far side.
            edge = d2 ** 4
            rim = max(0.0, (dx * 0.6 + dy * 0.55)) * edge
            col = [min(255, int(col[i] + 165 * rim)) for i in range(3)]
            a = 255 if d2 < 0.965 else int(255 * (1 - (d2 - 0.965) / 0.035))
            px[x, y] = (col[0], col[1], col[2], max(0, a))
    return img

def baton(img, cx, cy, s=1.0, detail=True):
    d = ImageDraw.Draw(img)
    L = W * 0.80 * s
    a_tip, a_end = -L / 2, L / 2
    sw = W * 0.082 * s

    a0 = a_tip + L * 0.28            # long, fine spear tip
    bulb_r = sw * 0.95
    a1 = a_end - bulb_r * 2.05

    tapered(d, cx, cy, a0, a1, sw * .88, sw, RED + (255,))
    sh = blank()
    tapered(ImageDraw.Draw(sh), cx + NX * sw * .30, cy + NY * sw * .30,
            a0, a1, sw * .40, sw * .44, RED_LO + (210,))
    img.alpha_composite(sh)
    hi = blank()
    tapered(ImageDraw.Draw(hi), cx - NX * sw * .28, cy - NY * sw * .28,
            a0, a1, sw * .24, sw * .26, RED_HI + (255,))
    img.alpha_composite(hi.filter(ImageFilter.GaussianBlur(W * .003 * s)))

    if detail:
        lace = blank(); ld = ImageDraw.Draw(lace)
        n = 7; step = (a1 - a0) / n
        cord = max(3, int(W * .0112 * s))
        for i in range(n):
            a = a0 + step * (i + .5); h, w = step * .42, sw * .55
            ld.line([at(cx, cy, a - h, -w), at(cx, cy, a + h, w)], fill=(255, 255, 255, 252), width=cord)
            ld.line([at(cx, cy, a - h, w), at(cx, cy, a + h, -w)], fill=(255, 255, 255, 252), width=cord)
        clip = blank()
        tapered(ImageDraw.Draw(clip), cx, cy, a0, a1, sw * .88, sw, (255, 255, 255, 255))
        img.alpha_composite(Image.composite(lace, blank(), clip.split()[3]))
        for a, w in ((a0, sw * 1.06), (a1, sw * 1.10)):
            tapered(d, cx, cy, a - L * .015, a + L * .015, w, w, CHR + (255,))
            tapered(d, cx, cy, a - L * .015, a, w * .55, w * .55, CHR_HI + (200,))

    # spear tip — long and fine
    tapered(d, cx, cy, a_tip, a0 - L * .03, sw * .05, sw * .52, CHR + (255,))
    tapered(d, cx, cy, a0 - L * .045, a0, sw * .60, sw * .96, CHR + (255,))
    th = blank()
    tapered(ImageDraw.Draw(th), cx - NX * sw * .23, cy - NY * sw * .23,
            a_tip + L * .03, a0 - L * .03, sw * .025, sw * .17, CHR_HI + (240,))
    img.alpha_composite(th.filter(ImageFilter.GaussianBlur(W * .0022 * s)))

    # neck, then the shaded sphere pasted on top — no ring artefact this time
    tapered(d, cx, cy, a1, a_end - bulb_r * 1.30, sw * 1.00, bulb_r * 1.70, CHR + (255,))
    bx, by = at(cx, cy, a_end - bulb_r)
    sphere = chrome_sphere(W, bulb_r)
    img.alpha_composite(sphere, (int(bx - sphere.width / 2), int(by - sphere.height / 2)))

def compose(top, bottom, detail=True, s=1.0):
    base = dgrad(W, top, bottom).convert('RGBA')
    sh = blank(); baton(sh, W / 2 + W * .012, W / 2 + W * .025, s, detail=False)
    base = Image.alpha_composite(base, Image.composite(
        Image.new('RGBA', (W, W), (0, 0, 0, 135)), blank(),
        sh.split()[3]).filter(ImageFilter.GaussianBlur(W * .018)))
    body = blank(); baton(body, W / 2, W / 2, s, detail=detail)
    img = Image.alpha_composite(base, body)
    mask = squircle_mask(W)
    out = blank(); out.paste(img, (0, 0), mask)
    sheen = Image.new('L', (W, W), 0)
    ImageDraw.Draw(sheen).ellipse([-W * .35, -W * .74, W * 1.35, W * .40], fill=38)
    sheen = sheen.filter(ImageFilter.GaussianBlur(W * .035))
    return Image.alpha_composite(out, Image.composite(
        Image.new('RGBA', (W, W), (255, 255, 255, 255)), blank(),
        Image.composite(sheen, Image.new('L', (W, W), 0), mask)))

PALETTES = {
    'Q1-navy':     ((56, 72, 128), (16, 22, 54)),
    'Q2-charcoal': ((66, 68, 80),  (22, 23, 30)),
    'Q3-cream':    ((253, 248, 238), (224, 210, 187)),
    'Q4-ink':      ((40, 44, 92),  (12, 13, 28)),
}
for name, (a, b) in PALETTES.items():
    compose(a, b, True).resize((S, S), Image.LANCZOS).save(f'{name}.png')
    compose(a, b, False, s=1.05).resize((S, S), Image.LANCZOS).save(f'{name}-small.png')
print('rendered')

sheet = Image.new('RGB', (1180, 340), (28, 29, 33))
d = ImageDraw.Draw(sheet)
for i, name in enumerate(PALETTES):
    big = Image.open(f'{name}.png'); small = Image.open(f'{name}-small.png')
    x = 30 + i * 288
    b = big.resize((180, 180), Image.LANCZOS); sheet.paste(b, (x, 28), b)
    for j, (sz, src) in enumerate(((64, big), (32, small), (16, small))):
        sm = src.resize((sz, sz), Image.LANCZOS)
        sheet.paste(sm, (x + j * 62, 250 + (32 - sz) // 2), sm)
    d.text((x, 228), name, fill=(205, 207, 214))
sheet.save('sheet-mehter4.png')
print('sheet written')
