/**
 * The menu bar presence.
 *
 * The title is the product in one glance: how many of your pull requests need
 * work before they can merge. Zero shows the icon alone rather than "0", so a
 * clear queue is quiet.
 */

import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import type { Snapshot } from './poller';

/**
 * A template image, drawn as a filled circle. Template images let macOS invert
 * them for light and dark menu bars, which is why this is black with alpha
 * rather than a fixed colour.
 */
function icon(): NativeImage {
  const size = 16;
  const centre = (size - 1) / 2;
  const radius = 5.5;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      // Antialias the last pixel of the edge so it does not look chewed.
      const alpha = Math.max(0, Math.min(1, radius - distance)) * 255;
      const offset = (y * size + x) * 4;
      buffer[offset] = 0;
      buffer[offset + 1] = 0;
      buffer[offset + 2] = 0;
      buffer[offset + 3] = Math.round(alpha);
    }
  }
  const image = nativeImage.createFromBuffer(buffer, { width: size, height: size });
  image.setTemplateImage(true);
  return image;
}

export interface TrayActions {
  open(): void;
  refresh(): void;
  quit(): void;
}

export class BatonTray {
  private readonly tray: Tray;

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(icon());
    this.tray.setToolTip('Baton');
    this.tray.on('click', () => this.actions.open());
    this.update({ blocked: [], reviewRequested: [], connected: [], refreshing: false } as never);
  }

  update(snapshot: Snapshot): void {
    const blocked = snapshot.blocked?.length ?? 0;
    const reviews = snapshot.reviewRequested?.length ?? 0;

    this.tray.setTitle(blocked > 0 ? ` ${blocked}` : '');
    this.tray.setToolTip(
      blocked > 0 ? `Baton — ${blocked} blocked on you` : 'Baton — nothing blocked on you'
    );

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: blocked > 0 ? `${blocked} blocked on you` : 'Nothing blocked on you',
          enabled: false
        },
        { label: `${reviews} awaiting your review`, enabled: false },
        { type: 'separator' },
        { label: 'Open Baton', click: () => this.actions.open() },
        {
          label: snapshot.refreshing ? 'Refreshing…' : 'Refresh now',
          enabled: !snapshot.refreshing,
          click: () => this.actions.refresh()
        },
        { type: 'separator' },
        { label: 'Quit Baton', accelerator: 'Command+Q', click: () => this.actions.quit() }
      ])
    );
  }

  dispose(): void {
    this.tray.destroy();
  }
}
