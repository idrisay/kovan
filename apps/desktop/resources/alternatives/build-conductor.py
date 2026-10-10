"""App icon from C5-conductor-source.png (Codex's image, chosen from six).

The source tile sat off-centre with an uneven margin. It is cropped to the
tile and placed on Apple's icon grid (an 824px tile centred in 1024), so the
Dock icon is the same size as every other app's. The menu bar glyph is
`tray-conductor.py`.
"""
from PIL import Image, ImageDraw
import os, shutil, subprocess

OUT = '/Users/idrisay/Desktop/coding/ikatia/app/kovan/apps/desktop/resources'

src = Image.open('C5-conductor-source.png').convert('RGBA')
tile = src.crop(src.getbbox())
side = max(tile.size)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(tile, ((side - tile.width) // 2, (side - tile.height) // 2))
master = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
master.paste(square.resize((824, 824), Image.LANCZOS), (100, 100))
master.save('C5-conductor.png')

iconset = 'baton.iconset'
shutil.rmtree(iconset, ignore_errors=True); os.makedirs(iconset)
for size in (16, 32, 128, 256, 512):
    master.resize((size, size), Image.LANCZOS).save(f'{iconset}/icon_{size}x{size}.png')
    master.resize((size * 2, size * 2), Image.LANCZOS).save(f'{iconset}/icon_{size}x{size}@2x.png')
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', f'{OUT}/icon.icns'], check=True)
shutil.rmtree(iconset)
print('icon.icns written')

proof = Image.new('RGB', (700, 170), (236, 235, 229))
d = ImageDraw.Draw(proof)
d.rectangle([350, 0, 700, 170], fill=(30, 31, 36))
for half in (0, 350):
    x = half + 20
    for sz in (128, 64, 32, 16):
        s_ = master.resize((sz, sz), Image.LANCZOS)
        proof.paste(s_, (x, 20 + (128 - sz) // 2), s_)
        x += sz + 16
proof.save('proof-conductor.png')
print('proof written')
