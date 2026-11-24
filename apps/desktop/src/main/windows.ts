/**
 * More than one window, each on its own workspace (item 157), the way VS Code
 * keeps one window per folder or workspace.
 *
 * Everything below a window is still shared: one poller, one set of sessions,
 * one tray. A window only chooses which workspace its Workspace view, ⌘P and
 * dialogs work in. The window in front decides `workspace.active`, so the
 * pull request queue scopes to the workspace you are looking at.
 *
 * New Window opens an empty one (item 159), as VS Code does: the Workspace
 * view shows Open Folder and the workspaces you have, and you pick.
 *
 * Which workspaces had windows is saved, and a normal launch opens them again.
 * Quitting closes every window, so the list is frozen once quitting starts;
 * closing one window yourself takes it off.
 */

import type { BrowserWindow, WebContents } from 'electron';
import type { Workspace } from './workspace';

export const OPEN_WINDOWS_SETTING = 'windows.workspaces';

/** The workspaces to reopen at launch: saved ones that still exist, once each. */
export function windowsToRestore(
  all: readonly Pick<Workspace, 'id'>[],
  saved: unknown,
  active: string | undefined
): (string | undefined)[] {
  const known = new Set(all.map((w) => w.id));
  const ids = Array.isArray(saved)
    ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && known.has(id)))]
    : [];
  return ids.length > 0 ? ids : [active];
}

/** A window's title: its workspace, as the Dock's window list and Mission Control show it. */
export function windowTitle(workspace: Pick<Workspace, 'name'> | undefined): string {
  return workspace ? workspace.name : 'Kovan';
}

interface Shown {
  window: BrowserWindow;
  workspace: string | undefined;
}

export class Windows {
  private readonly shown = new Map<number, Shown>();
  /** Window ids, most recently focused first. */
  private recent: number[] = [];
  private quitting = false;

  constructor(private readonly deps: {
    build: () => BrowserWindow;
    list: () => Workspace[];
    active: () => string | undefined;
    setActive: (id: string) => Promise<void>;
    save: (ids: string[]) => void;
  }) {}

  all(): BrowserWindow[] {
    return [...this.shown.values()].map((s) => s.window).filter((w) => !w.isDestroyed());
  }

  /** The window in front, or the one last in front. */
  front(): BrowserWindow | undefined {
    for (const id of this.recent) {
      const s = this.shown.get(id);
      if (s && !s.window.isDestroyed()) return s.window;
    }
    return undefined;
  }

  /** The focused window, only while Kovan is the app in front. */
  focused(): BrowserWindow | undefined {
    return this.all().find((w) => w.isFocused());
  }

  /** The same message to every window: sessions, the snapshot, activity. */
  send(channel: string, ...args: unknown[]): void {
    for (const w of this.all()) w.webContents.send(channel, ...args);
  }

  /** The window showing this workspace, the front-most if there are several. */
  withWorkspace(id: string): BrowserWindow | undefined {
    for (const recentId of this.recent) {
      const s = this.shown.get(recentId);
      if (s && !s.window.isDestroyed() && s.workspace === id) return s.window;
    }
    return undefined;
  }

  /**
   * The workspace the window that sent an IPC message is on. An empty window
   * has none; a sender that isn't one of these windows gets the active one.
   */
  workspaceOf(sender: WebContents): string | undefined {
    const s = [...this.shown.values()].find((v) => !v.window.isDestroyed() && v.window.webContents === sender);
    if (!s) return this.deps.active();
    return s.workspace && this.deps.list().some((w) => w.id === s.workspace) ? s.workspace : undefined;
  }

  windowOf(sender: WebContents): BrowserWindow | undefined {
    return this.all().find((w) => w.webContents === sender);
  }

  /**
   * A window picked a workspace. When another window already shows it, that
   * window comes forward instead and this one stays as it was (false), as
   * VS Code does with a folder that is open elsewhere.
   */
  async switchTo(sender: WebContents, id: string): Promise<boolean> {
    const s = [...this.shown.values()].find((v) => v.window.webContents === sender);
    const elsewhere = this.withWorkspace(id);
    if (s && elsewhere && elsewhere !== s.window) {
      elsewhere.show();
      elsewhere.focus();
      return false;
    }
    if (s) {
      s.workspace = id;
      this.retitle(s);
      this.persist();
    }
    await this.deps.setActive(id);
    return true;
  }

  /** A new window on a workspace, or an empty one with `undefined`. */
  open(workspace: string | undefined): BrowserWindow {
    const from = this.front();
    const window = this.deps.build();
    // Cascaded from the window in front, as macOS places a new document window.
    if (from && !from.isDestroyed()) {
      const b = from.getBounds();
      window.setBounds({ x: b.x + 28, y: b.y + 28, width: b.width, height: b.height });
    }
    const entry: Shown = { window, workspace };
    const key = window.id;
    this.shown.set(key, entry);
    this.recent.unshift(key);
    this.retitle(entry);
    // The page's own <title> would replace the workspace name on load.
    window.on('page-title-updated', (event) => event.preventDefault());
    window.on('focus', () => {
      this.recent = [key, ...this.recent.filter((r) => r !== key)];
      const current = this.shown.get(key)?.workspace;
      if (current && current !== this.deps.active()) void this.deps.setActive(current);
    });
    window.on('closed', () => {
      this.shown.delete(key);
      this.recent = this.recent.filter((r) => r !== key);
      this.persist();
    });
    this.persist();
    return window;
  }

  /** Shows the window in front, or opens one on the active workspace. */
  show(): { window: BrowserWindow; fresh: boolean } {
    const existing = this.front();
    if (existing) {
      existing.show();
      existing.focus();
      return { window: existing, fresh: false };
    }
    return { window: this.open(this.deps.active()), fresh: true };
  }

  /** Brings forward the window on this workspace, or opens one for it. */
  showWorkspace(id: string): { window: BrowserWindow; fresh: boolean } {
    const existing = this.withWorkspace(id);
    if (existing) {
      existing.show();
      existing.focus();
      return { window: existing, fresh: false };
    }
    return { window: this.open(id), fresh: true };
  }

  /**
   * The workspaces changed: a renamed one retitles its windows, and a window
   * whose workspace was closed is left empty.
   */
  retitleAll(): void {
    const list = this.deps.list();
    for (const s of this.shown.values()) {
      if (s.workspace && !list.some((w) => w.id === s.workspace)) s.workspace = undefined;
      this.retitle(s);
    }
    this.persist();
  }

  /** From here on, windows closing are Kovan quitting, not you closing them. */
  markQuitting(): void {
    this.quitting = true;
  }

  private workspaces(): (string | undefined)[] {
    return [...this.shown.values()].filter((s) => !s.window.isDestroyed()).map((s) => s.workspace);
  }

  private retitle(s: Shown): void {
    if (s.window.isDestroyed()) return;
    s.window.setTitle(windowTitle(this.deps.list().find((w) => w.id === s.workspace)));
  }

  private persist(): void {
    if (this.quitting) return;
    this.deps.save(this.workspaces().filter((id): id is string => Boolean(id)));
  }
}
