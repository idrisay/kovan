/**
 * The menu bar presence.
 *
 * The title is the product in one glance: how many of your pull requests need
 * work before they can merge. Zero shows the icon alone rather than "0", so a
 * clear queue is quiet.
 *
 * Agents waiting on you (item 182) are listed in the menu and the tooltip,
 * each one click from its session. They stay out of the title: one number
 * there has always meant pull requests, and a sum of two kinds of thing
 * would say neither.
 */

import { app, Menu, Tray, nativeImage, type NativeImage } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY, type Snapshot } from './poller';

/** A session whose agent is waiting on you: a question or a permission prompt. */
export interface WaitingAgent { id: string; title: string; runnerName: string }

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The menu bar glyph.
 *
 * A *template* image: pure black plus alpha, which macOS recolours itself for
 * light and dark menu bars and for the highlighted state. Colour in a template
 * image is discarded, so the entire design here is the silhouette: the K of
 * hive cells from the Dock icon, with wider gaps so the cells stay apart at
 * 16pt, and the waiting arm drawn fainter since grey can't be said in colour
 * (`resources/alternatives/build-k-cells.py`).
 *
 * Loaded from disk rather than drawn in code: `nativeImage` picks the @2x file
 * automatically, which is what every Retina Mac actually displays.
 */
function icon(): NativeImage {
  // macOS tints a template image to the menu bar; Linux panels don't, and are
  // mostly dark, so they get the same glyph drawn light.
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'trayLinux.png';
  const file = app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(dirname, '../../resources', name);
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    // Never leave the menu bar with no hit target: an invisible tray icon is
    // an app the user cannot reach at all.
    return process.platform === 'darwin'
      ? nativeImage.createFromNamedImage('NSApplicationIcon', [0, 0, 0]).resize({ width: 16 })
      : image;
  }
  if (process.platform === 'darwin') image.setTemplateImage(true);
  if (process.env['KOVAN_SMOKE']) {
    const { width, height } = image.getSize();
    console.log(`tray glyph loaded from ${file} (${width}x${height}, template=${image.isTemplateImage()})`);
  }
  return image;
}

export interface TrayActions {
  open(): void;
  refresh(): void;
  launchAtLogin(): boolean;
  toggleLaunchAtLogin(): void;
  openSession(id: string): void;
  quit(): void;
}

export class KovanTray {
  private readonly tray: Tray;
  private snapshot: Snapshot = EMPTY;
  private waiting: WaitingAgent[] = [];

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(icon());
    this.tray.setToolTip('Kovan');
    this.tray.on('click', () => this.actions.open());
    // Draw the menu immediately, so a right-click before the first refresh
    // lands gets a real menu rather than nothing.
    this.update(EMPTY);
  }

  update(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.render();
  }

  /** Redraws only when the list actually changed: sessions publish often. */
  setWaiting(waiting: WaitingAgent[]): void {
    const key = (list: WaitingAgent[]) => list.map((a) => `${a.id}\u0000${a.title}`).join('\u0001');
    if (key(waiting) === key(this.waiting)) return;
    this.waiting = waiting;
    this.render();
  }

  private render(): void {
    const snapshot = this.snapshot;
    const blocked = snapshot.blocked?.length ?? 0;
    const reviews = snapshot.reviewRequested?.length ?? 0;
    const agents = this.waiting.length;
    const agentLine = `${agents} agent${agents === 1 ? '' : 's'} waiting for you`;

    this.tray.setTitle(blocked > 0 ? ` ${blocked}` : '');
    this.tray.setToolTip(
      [blocked > 0 ? `Kovan — ${blocked} blocked on you` : 'Kovan — nothing blocked on you', agents > 0 ? agentLine : '']
        .filter(Boolean).join(' · ')
    );

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: blocked > 0 ? `${blocked} blocked on you` : 'Nothing blocked on you',
          enabled: false
        },
        { label: `${reviews} awaiting your review`, enabled: false },
        ...(agents > 0
          ? [
              { type: 'separator' as const },
              { label: agentLine, enabled: false },
              ...this.waiting.map((agent) => ({
                label: agent.title,
                sublabel: agent.runnerName,
                click: () => this.actions.openSession(agent.id)
              }))
            ]
          : []),
        { type: 'separator' },
        { label: 'Open Kovan', click: () => this.actions.open() },
        {
          label: snapshot.refreshing ? 'Refreshing…' : 'Refresh now',
          enabled: !snapshot.refreshing,
          click: () => this.actions.refresh()
        },
        { type: 'separator' },
        {
          label: 'Open at login',
          type: 'checkbox',
          checked: this.actions.launchAtLogin(),
          click: () => this.actions.toggleLaunchAtLogin()
        },
        { type: 'separator' },
        { label: 'Quit Kovan', accelerator: 'Command+Q', click: () => this.actions.quit() }
      ])
    );
  }

  dispose(): void {
    this.tray.destroy();
  }
}
