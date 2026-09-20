"""The tassel, done properly.

It was cut in an earlier round because three hairline strands read as insect
legs. That was the wrong conclusion: the tassel is part of the object, and the
fault was the drawing, not the feature. At this scale it has to be one bold
solid shape — a thick cord and a chunky bell — in the same flat two-tone
language as the rest.

It also earns its place compositionally: the baton runs corner to corner and
leaves the lower-left empty, which is exactly where the tassel hangs.
"""
exec(open('clean.py').read().split('def draw(')[0])
from PIL import Image, ImageDraw
import math

CORD = (245, 247, 252)
TAS, TAS_D = (216, 42, 46), (150, 16, 26)
RED,  RED_D  = (216, 42, 46), (150, 16, 26)
SILV, SILV_D = (232, 237, 245), (160, 169, 185)

def qcurve(p0, p1, p2, steps=28):
    """Quadratic Bezier as a point list."""
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])
            for t in (i / steps for i in range(steps + 1))]

def draw(img, cx, cy, s=1.0, lacing=3, shading=True, tassel=True):
    d = ImageDraw.Draw(img)
    L  = W * 0.70 * s
    sw = W * 0.112 * s
    tip, end = -L / 2, L / 2
    r  = sw * 0.90
    a0 = tip + L * 0.24
    a1 = end - r * 1.72

    def P(a, n=0.0): return (cx + AX * a + NX * n, cy + AY * a + NY * n)

    # ---- tassel, drawn first so the shaft's collar overlaps its knot -------
    if tassel:
        anchor = P(a0 + L * .04, -sw * .30)
        # The cord swings out to the light side and falls; the control point is
        # what gives it slack instead of a straight guy-rope.
        drop = sw * 2.15
        knot = (anchor[0] - sw * 1.62, anchor[1] + drop * 0.92)
        ctrl = (anchor[0] - sw * 1.75, anchor[1] + drop * 0.18)
        d.line(qcurve(anchor, ctrl, knot), fill=CORD + (255,),
               width=int(sw * .21), joint='curve')

        # Knot: a small bound collar at the top of the bell.
        kr = sw * .30
        d.ellipse([knot[0] - kr, knot[1] - kr * .78, knot[0] + kr, knot[1] + kr * .78],
                  fill=CORD + (255,))

        # Bell: widens as it falls, flat fringe at the bottom.
        bw0, bw1 = sw * .42, sw * .92
        bh = sw * 1.35
        top, bot = knot[1] + kr * .45, knot[1] + kr * .45 + bh
        body = [(knot[0] - bw0 / 2, top), (knot[0] + bw0 / 2, top),
                (knot[0] + bw1 / 2, bot), (knot[0] - bw1 / 2, bot)]
        d.polygon(body, fill=TAS + (255,))
        # Same light direction as everything else: shadow on the lower-right.
        d.polygon([(knot[0], top), (knot[0] + bw0 / 2, top),
                   (knot[0] + bw1 / 2, bot), (knot[0], bot)], fill=TAS_D + (255,))
        # Two notches read as fringe; three or more turn to grit when reduced.
        nw = bw1 / 5
        for k in (-1, 1):
            d.polygon([(knot[0] + k * nw * .95 - nw * .34, bot),
                       (knot[0] + k * nw * .95 + nw * .34, bot),
                       (knot[0] + k * nw * .95, bot - sw * .30)],
                      fill=(0, 0, 0, 0))

    # ---- tip --------------------------------------------------------------
    d.polygon(band(cx, cy, tip, a0, sw * .05, sw * .98), fill=SILV + (255,))
    if shading:
        d.polygon(band(cx, cy, tip, a0, sw * .05, sw * .98, .5, 1.), fill=SILV_D + (255,))

    # ---- shaft ------------------------------------------------------------
    d.polygon(band(cx, cy, a0, a1, sw, sw), fill=RED + (255,))
    if shading:
        d.polygon(band(cx, cy, a0, a1, sw, sw, .5, 1.), fill=RED_D + (255,))

    if lacing:
        step = (a1 - a0) / lacing
        for i in range(lacing):
            a = a0 + step * (i + .5)
            h, e = step * .34, sw * .50
            for sign in (1, -1):
                d.line([P(a - h, -e * sign), P(a + h, e * sign)],
                       fill=(255, 255, 255, 255), width=int(sw * .17))

    # ---- neck and bulb ----------------------------------------------------
    d.polygon(band(cx, cy, a1, end - r * 1.15, sw, r * 1.5), fill=SILV + (255,))
    if shading:
        d.polygon(band(cx, cy, a1, end - r * 1.15, sw, r * 1.5, .5, 1.), fill=SILV_D + (255,))
    bx, by = P(end - r)
    box = [bx - r, by - r, bx + r, by + r]
    d.ellipse(box, fill=SILV + (255,))
    if shading:
        d.pieslice(box, DEG, DEG + 180, fill=SILV_D + (255,))

def compose(bg, lacing=3, shading=True, s=1.0, tassel=True):
    base = dgrad(W, *bg).convert('RGBA')
    # Silhouette without lacing, so the white strokes can be clipped to it and
    # never spill over the red edge.
    sil = blank(); draw(sil, W / 2, W / 2, s=s, lacing=0, shading=shading, tassel=tassel)
    body = blank(); draw(body, W / 2, W / 2, s=s, lacing=lacing, shading=shading, tassel=tassel)
    body = Image.composite(body, blank(), sil.split()[3])
    img = Image.alpha_composite(base, body)
    mask = squircle_mask(W)
    out = blank(); out.paste(img, (0, 0), mask)
    return out.resize((S, S), Image.LANCZOS)

NAVY = ((58, 74, 130), (18, 24, 58))
V = {
    'V1-lace3':      dict(lacing=3, tassel=True),
    'V2-lace4':      dict(lacing=4, tassel=True),
    'V3-notassel':   dict(lacing=3, tassel=False),
    'V4-plain':      dict(lacing=0, tassel=True),
}
for n, kw in V.items():
    compose(NAVY, **kw).save(f'{n}.png')
print('rendered')

sheet = Image.new('RGB', (1180, 360), (28, 29, 33))
d = ImageDraw.Draw(sheet)
for i, n in enumerate(V):
    src = Image.open(f'{n}.png'); x = 30 + i * 288
    b = src.resize((200, 200), Image.LANCZOS); sheet.paste(b, (x, 20), b)
    for j, sz in enumerate((64, 32, 16)):
        sm = src.resize((sz, sz), Image.LANCZOS)
        sheet.paste(sm, (x + j * 62, 268 + (32 - sz) // 2), sm)
    d.text((x, 246), n, fill=(205, 207, 214))
sheet.save('sheet-tassel.png')
print('sheet written')
