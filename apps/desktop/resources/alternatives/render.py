"""Same layout, fewer colours.

The composition is unchanged from V1 — tassel hanging lower-left, baton on the
52-degree diagonal, spear tip upper-left, bulb lower-right, three lacing marks.
Only the palette changes: the two-tone shading comes off, so every part is one
flat colour and the whole icon is three or four of them.

Flat removes the last thing that was still scale-dependent. With no lit/shadow
split there is nothing that can turn to mush when reduced — the 16px version is
the same drawing, just smaller.
"""
exec(open('clean.py').read().split('def draw(')[0])
from PIL import Image, ImageDraw
import math

def qcurve(p0, p1, p2, steps=28):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])
            for t in (i / steps for i in range(steps + 1))]

def draw(img, cx, cy, s=1.0, lacing=3, palette=None, tassel=True):
    P_ = palette
    d = ImageDraw.Draw(img)
    L  = W * 0.70 * s
    sw = W * 0.112 * s
    tip, end = -L / 2, L / 2
    r  = sw * 0.90
    a0 = tip + L * 0.24
    a1 = end - r * 1.72
    def P(a, n=0.0): return (cx + AX * a + NX * n, cy + AY * a + NY * n)

    if tassel:
        anchor = P(a0 + L * .04, -sw * .30)
        drop = sw * 2.15
        knot = (anchor[0] - sw * 1.62, anchor[1] + drop * 0.92)
        ctrl = (anchor[0] - sw * 1.75, anchor[1] + drop * 0.18)
        d.line(qcurve(anchor, ctrl, knot), fill=P_['metal'] + (255,),
               width=int(sw * .21), joint='curve')
        kr = sw * .30
        d.ellipse([knot[0] - kr, knot[1] - kr * .78, knot[0] + kr, knot[1] + kr * .78],
                  fill=P_['metal'] + (255,))
        bw0, bw1, bh = sw * .42, sw * .92, sw * 1.35
        top = knot[1] + kr * .45
        bot = top + bh
        d.polygon([(knot[0] - bw0 / 2, top), (knot[0] + bw0 / 2, top),
                   (knot[0] + bw1 / 2, bot), (knot[0] - bw1 / 2, bot)],
                  fill=P_['red'] + (255,))
        nw = bw1 / 5
        for k in (-1, 1):
            d.polygon([(knot[0] + k * nw * .95 - nw * .34, bot),
                       (knot[0] + k * nw * .95 + nw * .34, bot),
                       (knot[0] + k * nw * .95, bot - sw * .30)], fill=(0, 0, 0, 0))

    d.polygon(band(cx, cy, tip, a0, sw * .05, sw * .98), fill=P_['metal'] + (255,))
    d.polygon(band(cx, cy, a0, a1, sw, sw), fill=P_['red'] + (255,))
    if lacing:
        step = (a1 - a0) / lacing
        for i in range(lacing):
            a = a0 + step * (i + .5); h, e = step * .34, sw * .50
            for sign in (1, -1):
                d.line([P(a - h, -e * sign), P(a + h, e * sign)],
                       fill=P_['lace'] + (255,), width=int(sw * .17))
    d.polygon(band(cx, cy, a1, end - r * 1.15, sw, r * 1.5), fill=P_['metal'] + (255,))
    bx, by = P(end - r)
    d.ellipse([bx - r, by - r, bx + r, by + r], fill=P_['metal'] + (255,))

def compose(palette, lacing=3, s=1.0, tassel=True, flat_bg=True):
    bg = palette['bg']
    base = (Image.new('RGB', (W, W), bg) if flat_bg
            else dgrad(W, tuple(min(255, c + 28) for c in bg),
                          tuple(max(0, c - 22) for c in bg))).convert('RGBA')
    sil = blank(); draw(sil, W / 2, W / 2, s=s, lacing=0, palette=palette, tassel=tassel)
    body = blank(); draw(body, W / 2, W / 2, s=s, lacing=lacing, palette=palette, tassel=tassel)
    body = Image.composite(body, blank(), sil.split()[3])
    img = Image.alpha_composite(base, body)
    mask = squircle_mask(W)
    out = blank(); out.paste(img, (0, 0), mask)
    return out.resize((S, S), Image.LANCZOS)

# Three colours each: field, red, one metal/lace tone.
PALETTES = {
    'W1-three':   dict(bg=(37, 48, 92),  red=(219, 46, 48), metal=(244, 246, 250), lace=(244, 246, 250)),
    'W2-warm':    dict(bg=(30, 34, 46),  red=(222, 58, 52), metal=(238, 226, 206), lace=(238, 226, 206)),
    'W3-cream':   dict(bg=(241, 235, 223), red=(206, 46, 46), metal=(58, 62, 78),  lace=(241, 235, 223)),
    'W4-mono':    dict(bg=(24, 26, 34),  red=(226, 52, 50), metal=(232, 236, 244), lace=(24, 26, 34)),
}
for n, kw in PALETTES.items():
    compose(kw).save(f'{n}.png')
print('rendered')

sheet = Image.new('RGB', (1180, 360), (28, 29, 33))
d = ImageDraw.Draw(sheet)
for i, n in enumerate(PALETTES):
    src = Image.open(f'{n}.png'); x = 30 + i * 288
    b = src.resize((200, 200), Image.LANCZOS); sheet.paste(b, (x, 20), b)
    for j, sz in enumerate((64, 32, 16)):
        sm = src.resize((sz, sz), Image.LANCZOS)
        sheet.paste(sm, (x + j * 62, 268 + (32 - sz) // 2), sm)
    d.text((x, 246), n, fill=(205, 207, 214))
sheet.save('sheet-flat.png')
print('sheet written')
