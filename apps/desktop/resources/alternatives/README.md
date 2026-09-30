# Icon

**In use: `K-cells`** (since the rename to Kovan, 2026-09-30), a K built from
seven hive cells: an off-white stem, a clay arm (working) and a grey arm
(waiting), on a near-black tile. Picked from ten options, five by Codex and five
by Claude (https://claude.ai/artifact/51VPzLg52bzRTquqrGBoZN).
`python3 build-k-cells.py` draws it, writes `icon.icns` and both menu bar
glyphs, and a proof (`proof-k-cells.png`).

## Before that: `C5-conductor`

A conductor's baton with two sweeping arcs in clay
on near-black, from when the app was called Baton. Codex drew it (`C5-conductor-source.png`, chosen from six
concepts); `python3 build-conductor.py` centres it on Apple's icon grid and
writes `icon.icns`. The menu bar glyph is redrawn by hand in the same idea
(`python3 tray-conductor.py`), since traced from the icon it faded at 16pt.

## Earlier still

A **ceremonial baton** — cord and tassel, red shaft with cross-lacing, spear
tip, bulb — drawn flat in three colours.

`W4-mono` was in use. The alternatives change only the palette; the layout is
identical across all four.

## Three colours

Near-black field, red, one off-white. The tip, the bulb, the cord and the knot
are all the same white, and the tassel is the same red as the shaft.

The lacing is the one thing that differs from the other palettes: it is drawn
in the **field colour**, so the X marks read as cut out of the shaft rather
than laid on top of it. That trick only works because the field is flat —
against a gradient the cut-outs would not match the tile behind them.

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
`npm run dist --workspace @kovan/desktop`.

## The menu bar glyph

`trayTemplate.png` is built from the same drawing's silhouette, flattened to
black plus alpha, so the menu bar and the Dock cannot drift apart. macOS
recolours it for light and dark menu bars; both were checked.
