# Icon

A **ceremonial baton** — white cord and red tassel, red lacquered shaft with
white cross-lacing, silver spear tip, chromed bulb — drawn flat, from a
reference photo of the real object.

`V1-lace3` is in use. The alternatives differ in lacing count and whether the
tassel is present.

## Flat, and why that is the harder version

An earlier round rendered this as a small illustration: gradients, specular
highlights, a per-size simplification because the detail turned to smudge below
64px. It looked good at 1024 and muddy everywhere else.

This one is flat two-tone, and **one drawing serves every size**. The
constraint that makes it work is that nothing is faked:

- Every lit and shadowed area is built from **its own vertices**. The shaft and
  tip split exactly along their centreline; the bulb splits along a true chord
  via `pieslice`.
- The previous version got two-tone shading by drawing a second shape offset
  sideways and clipping it. At preview size that looked fine. At 1024px it was
  a stepped seam down the shaft and two visibly overlapping circles where the
  bulb should have been. **That is why every round here was rendered and looked
  at rather than reasoned about.**

## The tassel

Cut in an early round because three hairline strands read as insect legs — the
wrong conclusion. The tassel is part of the object; the fault was the drawing.
It is now one bold shape: a thick cord with real slack, a bound knot, and a
bell that widens as it falls with **two** fringe notches. Three or more return
to grit under reduction.

It also earns its place compositionally. The baton runs corner to corner and
leaves the lower-left empty, which is exactly where a hanging tassel goes.

## Colour

Navy, because it lets the red and the chrome both separate from the field and
from each other.

## The menu bar glyph

`trayTemplate.png` is a *template* image: black plus alpha, recoloured by macOS
for light and dark menu bars. It keeps the tassel, because at @2x — what every
Retina Mac actually draws — it reads as a tassel rather than as a nick in the
shaft, and matching the app icon is worth more than a marginally cleaner 1x
almost nobody sees. Both were rendered side by side before choosing.

## Regenerating

```sh
python3 render.py    # the variants
python3 build.py     # icon.icns + trayTemplate, straight into resources/
```

Then `npm run dist --workspace @baton/desktop`.
