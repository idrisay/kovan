/**
 * Live screenshots (item 90, option C): while a run's viewer is open, its
 * folder is watched, and the window is told the moment the agent writes a
 * screenshot, its status line or its report — so what the agent's browser
 * is looking at shows up while it's still looking.
 *
 * Only run folders (the caller checks `ownsRun`), one watcher per folder
 * however many viewers ask, and gone when the last viewer closes or its
 * window does. Nothing is read here: the viewer asks for what changed through
 * the same run-file IPC it already uses, with the same checks.
 */

import { watch, type FSWatcher } from 'node:fs';
import type { WebContents } from 'electron';

interface Watch {
  watcher: FSWatcher;
  viewers: Set<WebContents>;
  timer?: NodeJS.Timeout;
}

export class RunWatcher {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly log: (message: string, error?: unknown) => void) {}

  watch(directory: string, viewer: WebContents): void {
    let entry = this.watches.get(directory);
    if (!entry) {
      let watcher: FSWatcher;
      try {
        // Recursive: the screenshots are in `shots/`, the status and report
        // beside them. FSEvents makes this cheap on macOS.
        watcher = watch(directory, { recursive: true }, () => this.changed(directory));
      } catch (err) {
        this.log(`Couldn't watch ${directory}`, err);
        return;
      }
      watcher.on('error', (err) => {
        this.log(`Stopped watching ${directory}`, err);
        this.close(directory);
      });
      entry = { watcher, viewers: new Set() };
      this.watches.set(directory, entry);
    }
    if (!entry.viewers.has(viewer)) {
      entry.viewers.add(viewer);
      viewer.once('destroyed', () => this.unwatch(directory, viewer));
    }
  }

  unwatch(directory: string, viewer: WebContents): void {
    const entry = this.watches.get(directory);
    if (!entry) return;
    entry.viewers.delete(viewer);
    if (entry.viewers.size === 0) this.close(directory);
  }

  dispose(): void {
    for (const directory of [...this.watches.keys()]) this.close(directory);
  }

  /** A burst of writes (a PNG is written in several) is one change. */
  private changed(directory: string): void {
    const entry = this.watches.get(directory);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      for (const viewer of entry.viewers) {
        if (!viewer.isDestroyed()) viewer.send('baton:run-changed', directory);
      }
    }, 150);
  }

  private close(directory: string): void {
    const entry = this.watches.get(directory);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.watcher.close();
    this.watches.delete(directory);
  }
}
