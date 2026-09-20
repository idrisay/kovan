exec(open('tassel.py').read().split("NAVY = ((58")[0])
from PIL import Image, ImageDraw
import os, shutil, subprocess, math

NAVY = ((58, 74, 130), (18, 24, 58))
OUT = '/Users/idrisay/Desktop/coding/ikatia/app/baton/apps/desktop/resources'

master = compose(NAVY, lacing=3, shading=True, tassel=True)
master.save('V1-lace3.png')

iconset = 'baton.iconset'
shutil.rmtree(iconset, ignore_errors=True); os.makedirs(iconset)
for size in (16, 32, 128, 256, 512):
    master.resize((size, size), Image.LANCZOS).save(f'{iconset}/icon_{size}x{size}.png')
    master.resize((size * 2, size * 2), Image.LANCZOS).save(f'{iconset}/icon_{size}x{size}@2x.png')
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', f'{OUT}/icon.icns'], check=True)
shutil.rmtree(iconset)
print('icon.icns written')

def tray(pt, tassel):
    """Template glyph. Rendered 8x and reduced.

    Whether the tassel belongs here is a separate question from whether it
    belongs on the app icon: a template image is one flat colour, so the cord
    and the bell merge into the shaft instead of reading as a separate thing.
    Both are rendered so the reduction can be judged rather than assumed.
    """
    F = 8; n = pt * F
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    g = globals()
    # Reuse the real drawing at glyph scale, then flatten to black.
    big = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    draw(big, W / 2, W / 2, s=0.94, lacing=0, shading=False, tassel=tassel)
    alpha = big.split()[3].resize((pt, pt), Image.LANCZOS)
    out = Image.new('RGBA', (pt, pt), (0, 0, 0, 0))
    out.putalpha(alpha)
    return out

for tas in (True, False):
    tag = 'tassel' if tas else 'plain'
    tray(16, tas).save(f'tray16-{tag}.png')
    tray(32, tas).save(f'tray32-{tag}.png')

proof = Image.new('RGB', (820, 360), (243, 243, 246))
d = ImageDraw.Draw(proof)
d.rectangle([0, 180, 820, 360], fill=(28, 29, 33))
for j, sz in enumerate((128, 64, 32, 16)):
    s_ = master.resize((sz, sz), Image.LANCZOS)
    proof.paste(s_, (30 + j * 150, 35 + (128 - sz) // 2), s_)
d.text((30, 10), 'app icon', fill=(60, 60, 66))
for j, (bg, fg, label) in enumerate((((243, 243, 246), (0, 0, 0), 'light'),
                                     ((28, 29, 33), (255, 255, 255), 'dark'))):
    y = 208 + j * 66
    d.rectangle([30, y - 12, 520, y + 40], fill=bg)
    for k, (pt, tas) in enumerate(((16, True), (32, True), (16, False), (32, False))):
        g = tray(pt, tas)
        tint = Image.new('RGBA', g.size, fg + (255,)); tint.putalpha(g.split()[3])
        proof.paste(tint, (48 + k * 62, y + (32 - pt) // 2), tint)
    d.text((330, y + 8), f'{label}:  tassel | tassel@2x | plain | plain@2x', fill=fg)
proof.save('proof4.png')
print('proof written')
