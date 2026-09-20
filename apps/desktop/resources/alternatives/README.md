# Icon

A **ceremonial baton** — cord and tassel, red shaft with cross-lacing, spear
tip, bulb — drawn flat in three colours.

`W1-three` is in use. The alternatives change only the palette; the layout is
identical across all four.

## Three colours

Navy field, red, one off-white. That is the whole palette: the tip, the bulb,
the cord, the knot and the lacing are all the same white, and the tassel is the
same red as the shaft.

Earlier rounds had gradients, specular highlights and lit/shadow halves. Each
of those is a decision that has to survive being reduced to 16px, and some of
them did not. Flat has none: **one drawing serves every size**, and the 16px
version is the same picture, just smaller. There is nothing left that can turn
to mush.

## The layout is fixed

Tassel hanging lower-left, baton on a 52-degree diagonal, spear tip upper-left,
bulb lower-right, three lacing marks. That arrangement came out of the earlier
rounds and is deliberately unchanged here:

- **52 degrees**, because a shallower diagonal wasted the corners and this is a
  long object.
- **The tassel fills the lower-left**, which the diagonal would otherwise leave
  empty. It is drawn as one bold shape — thick cord with real slack, a bound
  knot, a bell with **two** fringe notches. An early version used three
  hairline strands and read as insect legs.
- **Three lacing marks**, not five. More is closer to the reference photograph
  and starts to blur at 32px.

## Regenerating

```sh
python3 render.py    # the four palettes
python3 build.py     # icon.icns + trayTemplate, straight into resources/
```

`build.py`'s `CHOICE` is the palette dict. Then
`npm run dist --workspace @baton/desktop`.

## The menu bar glyph

`trayTemplate.png` is built from the same drawing's silhouette, flattened to
black plus alpha, so the menu bar and the Dock cannot drift apart. macOS
recolours it for light and dark menu bars; both were checked.
