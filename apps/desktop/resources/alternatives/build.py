exec(open('flat.py').read().split('PALETTES = {')[0])
from PIL import Image, ImageDraw
import os, shutil, subprocess

OUT = '/Users/idrisay/Desktop/coding/ikatia/app/baton/apps/desktop/resources'
# W4-mono. The lacing is drawn in the field colour rather than white, so the X
# marks read as cut out of the shaft instead of laid on top of it. That works
# only because the field is flat — against a gradient the cut-outs would not
# match the surrounding tile.
CHOICE = dict(bg=(24, 26, 34), red=(226, 52, 50),
              metal=(232, 236, 244), lace=(24, 26, 34))

master = compose(CHOICE)
master.save('W4-mono.png')

iconset = 'baton.iconset'
shutil.rmtree(iconset, ignore_errors=True); os.makedirs(iconset)
for size in (16, 32, 128, 256, 512):
    master.resize((size, size), Image.LANCZOS).save(f'{iconset}/icon_{size}x{size}.png')
    master.resize((size * 2, size * 2), Image.LANCZOS).save(f'{iconset}/icon_{size}x{size}@2x.png')
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', f'{OUT}/icon.icns'], check=True)
shutil.rmtree(iconset)
print('icon.icns written')

def tray(pt):
    """Template glyph: the same drawing flattened to black plus alpha.

    Built from the silhouette rather than redrawn, so the menu bar and the Dock
    can never drift apart.
    """
    big = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    draw(big, W / 2, W / 2, s=0.94, lacing=0, palette=CHOICE, tassel=True)
    out = Image.new('RGBA', (pt, pt), (0, 0, 0, 0))
    out.putalpha(big.split()[3].resize((pt, pt), Image.LANCZOS))
    return out

tray(16).save(f'{OUT}/trayTemplate.png')
tray(32).save(f'{OUT}/trayTemplate@2x.png')
print('trayTemplate written')

proof = Image.new('RGB', (780, 330), (241, 241, 245))
d = ImageDraw.Draw(proof)
d.rectangle([0, 178, 780, 330], fill=(28, 29, 33))
for j, sz in enumerate((128, 64, 32, 16)):
    s_ = master.resize((sz, sz), Image.LANCZOS)
    proof.paste(s_, (30 + j * 150, 32 + (128 - sz) // 2), s_)
d.text((30, 8), 'app icon — W4-mono, lacing as negative space', fill=(60, 60, 66))
for j, (bg, fg, label) in enumerate((((241, 241, 245), (0, 0, 0), 'light menu bar'),
                                     ((28, 29, 33), (255, 255, 255), 'dark menu bar'))):
    y = 202 + j * 60
    d.rectangle([30, y - 10, 380, y + 36], fill=bg)
    for k, pt in enumerate((16, 32)):
        g = tray(pt)
        tint = Image.new('RGBA', g.size, fg + (255,)); tint.putalpha(g.split()[3])
        proof.paste(tint, (50 + k * 64, y + (32 - pt) // 2), tint)
    d.text((205, y + 8), label, fill=fg)
proof.save('proof5.png')
print('proof written')
