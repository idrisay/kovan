# Icon

A **ceremonial baton** — red lacquered shaft, white cross-lacing, silver spear
tip, chromed bulb — not a relay-race baton. Drawn from a reference photo of the
real object.

`Q1-navy` is in use. The others differ only in the field colour.

## What the drawing had to solve

The real object is roughly **20:1** long and thin, and its identity lives in
the lacing and the two metal ends. At 16px none of that exists — a faithful
scale is a red hairline. So:

- **Proportions are exaggerated** to about 5.5:1. Icons have always done this.
- **The .icns carries different art per size.** 128px and up get the lacing and
  the chrome; 64px and below get a simplified silhouette, scaled larger to fill
  the tile. This is the mechanism `.icns` exists for, and Apple's own icons use
  it.
- **The tip is a fine needle on a collar**, not a cone. An earlier draft had a
  broad cone and read as a rocket nose.

## What three rounds of looking at it fixed

Each of these was invisible until the thing was rendered and examined:

1. **The tassel read as insect legs.** Three thin strands at icon scale are not
   a tassel, they are noise. Cut entirely.
2. **The bulb had a dark ring and read as a magnifying glass** — a compositing
   slip. It is now a properly shaded sphere: radial ramp from a light high-left
   to a dark low-right, plus a **rim light** on the shadow side, which is the
   whole difference between chrome and grey plastic.
3. **A 38-degree diagonal wasted the corners.** At 52 degrees the object is
   longer inside the same tile, which suits a long, elegant thing.

## Colour

Navy, because it lets both the red and the chrome separate. `Q3-cream` looks
like the product photograph and is handsome large, but a pale field gives the
baton nothing to sit against at 16px.

## The menu bar glyph is a separate design

`trayTemplate.png` is a *template* image: black plus alpha, recoloured by macOS
for light and dark menu bars. Colour is discarded there, so the whole design is
the silhouette — spike, shaft, ball — with no lacing and no chrome. Verified in
both themes.

## Regenerating

```sh
python3 render.py    # all four colour variants at 1024px
python3 build.py     # writes icon.icns + the trayTemplate images
```

`build.py`'s `CHOICE` holds the two gradient stops. Then rebuild with
`npm run dist --workspace @baton/desktop`.
