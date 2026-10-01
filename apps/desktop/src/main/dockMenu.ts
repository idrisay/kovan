/**
 * The Dock icon's right-click menu (item 135), the way VS Code's lists recent
 * folders: your workspaces, the active one ticked, then the active
 * workspace's folders with their Finder icons. Picking one brings Kovan
 * forward on the Workspace view, switched to that workspace and, for a
 * folder, opened at it.
 *
 * Rebuilt when the workspaces or the active one change, never on a timer: the
 * menu is read from settings that are already in memory.
 */

import * as path from 'node:path';
import { app, Menu, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { Workspace } from './workspace';

/** More than this and the menu outgrows the screen beside the Dock. */
const MAX_FOLDERS = 12;

export function dockTemplate(
  list: readonly Workspace[],
  activeId: string | undefined,
  open: (id: string, folder?: string) => void,
  icons: ReadonlyMap<string, NativeImage> = new Map()
): MenuItemConstructorOptions[] {
  if (list.length === 0) return [];
  const items: MenuItemConstructorOptions[] = list.map((w) => ({
    label: w.name,
    type: 'checkbox',
    checked: w.id === activeId,
    click: () => open(w.id)
  }));
  const active = list.find((w) => w.id === activeId);
  if (active && active.folders.length > 0) {
    items.push({ type: 'separator' });
    for (const folder of active.folders.slice(0, MAX_FOLDERS)) {
      const icon = icons.get(folder);
      items.push({
        // "app — ikatia", as VS Code names a recent folder by its parent.
        label: `${path.basename(folder)} — ${path.basename(path.dirname(folder))}`,
        ...(icon ? { icon } : {}),
        click: () => open(active.id, folder)
      });
    }
  }
  return items;
}

let latest: DockMenu | undefined;

/** The menu main built, for the smoke run to click through. */
export function latestDockMenu(): DockMenu | undefined {
  return latest;
}

export class DockMenu {
  private readonly icons = new Map<string, NativeImage>();

  constructor(
    private readonly list: () => Workspace[],
    private readonly activeId: () => string | undefined,
    private readonly open: (id: string, folder?: string) => void
  ) {
    latest = this;
  }

  /** The template as it stands, for the smoke run to read. */
  template(): MenuItemConstructorOptions[] {
    return dockTemplate(this.list(), this.activeId(), this.open, this.icons);
  }

  async refresh(): Promise<void> {
    if (process.platform !== 'darwin' || !app.dock) return;
    const active = this.list().find((w) => w.id === this.activeId());
    for (const folder of active?.folders.slice(0, MAX_FOLDERS) ?? []) {
      if (this.icons.has(folder)) continue;
      // A folder that has gone missing just has no icon.
      const icon = await app.getFileIcon(folder, { size: 'small' }).catch(() => undefined);
      if (icon && !icon.isEmpty()) this.icons.set(folder, icon.resize({ width: 16, height: 16 }));
    }
    app.dock.setMenu(Menu.buildFromTemplate(this.template()));
  }
}
