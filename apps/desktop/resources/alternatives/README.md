# Icon variants

`E-amber-indigo` is the one in use. The others are kept because icon choice is
taste, and regenerating a rejected direction from scratch is wasted work.

## Why this one

Chosen on the 16px row, not the 1024px one. A menu bar and a Finder list are
where an icon actually has to work, and at that size only the silhouette and
the colour contrast survive — everything else is mud.

- **Amber on indigo** are near-complementary, so the baton separates from the
  field by hue as well as by value. The white-on-colour variants (`A`, `D`)
  start to dissolve at 16px; this one does not.
- It is **not a dark tile**. `C` and `G` read beautifully large and hold up
  small, but a dark icon disappears against a dark wallpaper in the Dock.
- The baton is **shaded across its short axis** so it reads as a cylinder.
  Flat capsules read as a pencil, which is a different object.

`B`/`F` add the queue the baton comes out of — the most on-message idea, since
the app is a queue of things waiting on you. They lose the bars at 16px and the
composition is busier. Worth revisiting if the icon is ever used somewhere it is
always large.

## Swapping

```sh
python3 render.py                 # regenerates every variant at 1024px
```

Then point `build.py`'s `CHOICE` at the one you want and rerun it; it writes
`icon.icns` and the menu bar `trayTemplate` images. Rebuild with
`npm run dist --workspace @baton/desktop`.

## The menu bar glyph is a separate design

`trayTemplate.png` is a *template* image — pure black plus alpha, recoloured by
macOS for light and dark menu bars. Colour is discarded there, so the whole
design is the silhouette, and it is deliberately shorter and thicker than the
Dock icon: a faithful scale becomes a hairline at 16pt, and a hairline in a
menu bar reads as dirt on the screen rather than as a symbol.
