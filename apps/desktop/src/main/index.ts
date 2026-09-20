/**
 * Main process entry.
 *
 * Architecture note, because it is easy to undo by accident: this app is
 * main-process-first. The poller, the providers, the credentials and the
 * notifications all live here, and the window is a view onto state that
 * already exists. Closing the window *destroys* it rather than hiding it, so
 * an idle Baton costs one Node process instead of a Chromium tree — which is
 * the whole reason it is worth leaving running, and the advantage it has over
 * the VS Code extension it replaces.
 *
 * If you ever find yourself moving the poller into the renderer, stop.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from './host';
import { Poller, type Snapshot } from './poller';
import { BatonTray } from './tray';
import { Activity } from './notify';
import { CREDENTIAL_FIELDS, HttpClient, fetchPullDetail } from '@baton/providers';
import { adoptImportedTokens } from './adopt';
import { Sessions } from './sessions';
import { Agents } from './agents';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Before anything reads `app.getPath('userData')`. Electron derives that path
// from package.json's `name`, which is the scoped workspace name — without
// this, state lands in "@baton/desktop" and the importer in scripts/ writes to
// a directory the app will never read.
app.setName('Baton');

// Measured, not assumed: `app.disableHardwareAcceleration()` was tried here and
// does NOT remove the GPU process — Chromium still spawns one for compositing,
// so it cost rendering quality for 0MB. The idle floor is what it is; see the
// memory budget in MIGRATION.md §9 for the real numbers.

// A second instance would mean two pollers, two trays and double notifications.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

const host = createHost();
const poller = new Poller(host);
const activity = new Activity(host);
const sessions = new Sessions();
const agents = new Agents(host, sessions);
const detailHttp = new HttpClient(host.log);

let window: BrowserWindow | undefined;
let tray: BatonTray | undefined;
let firstRefresh = true;

function createWindow(): void {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }

  window = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1b1c1f',
    webPreferences: {
      preload: path.join(dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.once('ready-to-show', () => window?.show());

  // Destroy, don't hide. See the note at the top of this file.
  window.on('closed', () => {
    window = undefined;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'));
  }
}

/**
 * Keeps the macOS login item in step with the setting.
 *
 * Applied on every launch rather than only when the setting changes: the login
 * item is registered against a bundle path, so reinstalling the app to a new
 * location silently orphans the old registration. Re-asserting it costs
 * nothing and makes a reinstall self-healing.
 *
 * `openAsHidden` is redundant under LSUIElement — there is no window to hide —
 * but it is what stops a Dock icon flashing on login for a fraction of a second.
 */
function applyLoginItem(): void {
  const wanted = host.config.get('launchAtLogin', false);
  const current = app.getLoginItemSettings();
  if (current.openAtLogin !== wanted) {
    app.setLoginItemSettings({ openAtLogin: wanted, openAsHidden: true });
  }
}

function broadcast(snapshot: Snapshot): void {
  tray?.update(snapshot);
  if (window && !window.isDestroyed()) {
    window.webContents.send('baton:snapshot', snapshot);
  }
}

app.whenReady().then(async () => {
  // The macOS equivalent of the Swift app's LSUIElement: no Dock tile, no menu
  // bar of its own. Baton lives in the status bar.
  app.dock?.hide();

  tray = new BatonTray({
    open: () => createWindow(),
    refresh: () => void poller.refresh(true),
    launchAtLogin: () => host.config.get('launchAtLogin', false),
    toggleLaunchAtLogin: async () => {
      const next = !host.config.get('launchAtLogin', false);
      await host.config.set('launchAtLogin', next);
      applyLoginItem();
      tray?.update(poller.current());
    },
    quit: () => {
      app.exit(0);
    }
  });

  poller.onDidChange((snapshot) => {
    broadcast(snapshot);
    if (!snapshot.refreshing) {
      void activity.report(snapshot.blocked, firstRefresh);
      firstRefresh = false;
    }
  });

  // --- IPC. Every channel is read-only about secrets: tokens are set through
  // --- here but never sent back out, so the renderer cannot leak one.
  ipcMain.handle('baton:snapshot', () => poller.current());
  ipcMain.handle('baton:refresh', () => poller.refresh(true));
  ipcMain.handle('baton:open-external', (_event, url: string) => shell.openExternal(url));
  ipcMain.handle('baton:credential-fields', () => CREDENTIAL_FIELDS);
  ipcMain.handle('baton:settings', () => host.config.all());
  ipcMain.handle('baton:set-setting', async (_event, key: string, value: unknown) => {
    await host.config.set(key, value);
    if (key === 'launchAtLogin') {
      applyLoginItem();
    }
  });
  ipcMain.handle('baton:set-secret', async (_event, key: string, value: string) => {
    await host.secrets.set(key, value);
    return poller.refresh(true);
  });

  // --- Detail ---------------------------------------------------------------
  ipcMain.handle('baton:pull-detail', async (_event, repo: string, number: number) => {
    const token = await host.secrets.get('github');
    if (!token) {
      throw new Error('GitHub is not connected');
    }
    return fetchPullDetail(
      detailHttp,
      host.config.get('github.baseUrl', 'https://api.github.com'),
      token,
      repo,
      number
    );
  });

  // --- Agents ---------------------------------------------------------------
  ipcMain.handle('baton:runners', () => agents.runners());
  ipcMain.handle('baton:run-targets', (_event, force?: boolean) => agents.targets(force));
  ipcMain.handle('baton:build-prompt', (_event, kind, subject) =>
    agents.buildPrompt(kind, subject)
  );
  ipcMain.handle('baton:default-cwd', (_event, repo?: string) => agents.defaultCwd(repo));
  ipcMain.handle('baton:start-agent', async (_event, request, subject) => {
    const result = await agents.start(request, subject);
    if (result.ok) {
      // Surface the terminal straight away: a run that starts invisibly looks
      // like a button that did nothing.
      createWindow();
    }
    return result;
  });
  ipcMain.handle('baton:run-history', (_event, subject: string) => agents.history(subject));

  // --- Terminals ------------------------------------------------------------
  ipcMain.handle('baton:sessions', () => sessions.list());
  ipcMain.handle('baton:session-buffer', (_event, id: string) => sessions.buffer(id));
  ipcMain.handle('baton:session-write', (_event, id: string, data: string) => {
    sessions.write(id, data);
  });
  ipcMain.handle('baton:session-resize', (_event, id: string, cols: number, rows: number) => {
    sessions.resize(id, cols, rows);
  });
  ipcMain.handle('baton:session-close', (_event, id: string) => sessions.close(id));
  ipcMain.handle('baton:open-terminal', async (_event, cwd?: string) => {
    const target = cwd ?? (await agents.defaultCwd());
    if (!target) {
      throw new Error('No folder to open a terminal in');
    }
    return sessions.open({ cwd: target, title: 'Terminal', runnerName: 'Shell' });
  });

  sessions.onOutput(({ id, data }) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('baton:session-output', id, data);
    }
  });
  sessions.onDidChange((list) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('baton:sessions', list);
    }
  });

  // Before the first poll, so an imported token is used on the very first
  // refresh rather than showing "not connected" for a cycle.
  await adoptImportedTokens(host);

  applyLoginItem();

  // Proves the pty layer end to end: open a shell, type a command, read what
  // comes back. A click test cannot do this, and it is the one part of the app
  // that depends on a native module matching Electron's ABI.
  if (process.env['BATON_SMOKE'] === 'pty') {
    const runners = await agents.runners();
    const session = await sessions.open({
      cwd: app.getPath('home'),
      title: 'smoke',
      runnerName: 'Shell'
    });
    let seen = '';
    sessions.onOutput(({ id, data }) => {
      if (id === session.id) seen += data;
    });
    setTimeout(() => sessions.write(session.id, 'echo BATON_PTY_OK-$((6*7))\r'), 600);
    await new Promise((r) => setTimeout(r, 4000));
    const prompt = agents.buildPrompt('unblock', {
      pull: {
        number: 1, title: 'ACME-1 x', url: 'u', repo: 'a/b', author: 'me',
        isDraft: false, createdAt: '', updatedAt: '', mergeable: 'conflicting',
        reviewDecision: 'none', checks: 'none', unresolvedThreads: 0,
        additions: 0, deletions: 0, viewerReviewed: false
      }
    });
    console.log(JSON.stringify({
      ptyOpened: Boolean(session.id),
      sawEcho: seen.includes('BATON_PTY_OK-42'),
      running: sessions.list()[0]?.running,
      bufferBytes: sessions.buffer(session.id).length,
      runnersFound: runners.length,
      runnerNames: runners.map((r) => r.name).slice(0, 8),
      targets: (await agents.targets()).map((x) => x.label).slice(0, 4),
      promptOk: prompt.includes('BATON_REPORT') && prompt.includes('npm run type-check')
    }, null, 2));
    app.exit(0);
    return;
  }

  poller.start();

  // `npm run smoke` drives this: open the window, prove the renderer mounted
  // and the IPC round-trips, print the result and exit. It is the cheapest
  // check that the main/preload/renderer wiring is intact, and it runs without
  // a human or a screen-recording permission.
  // Proves the pty layer end to end: open a shell, type a command, read what
  // comes back. A click test cannot do this, and it is the one part of the app
  // that depends on a native module matching Electron's ABI.
  if (process.env['BATON_SMOKE'] === 'pty') {
    const runners = await agents.runners();
    const session = await sessions.open({
      cwd: app.getPath('home'),
      title: 'smoke',
      runnerName: 'Shell'
    });
    let seen = '';
    sessions.onOutput(({ id, data }) => {
      if (id === session.id) seen += data;
    });
    sessions.write(session.id, 'echo BATON_PTY_OK-$((6*7))\r');
    await new Promise((r) => setTimeout(r, 3500));
    console.log(JSON.stringify({
      ptyOpened: Boolean(session.id),
      sawEcho: seen.includes('BATON_PTY_OK-42'),
      running: sessions.list()[0]?.running,
      bufferBytes: sessions.buffer(session.id).length,
      runnersFound: runners.length,
      runnerNames: runners.map((r) => r.name).slice(0, 8),
      targets: (await agents.targets()).map((t) => t.label).slice(0, 5)
    }, null, 2));
    app.exit(0);
    return;
  }

  if (process.env['BATON_SMOKE']) {
    createWindow();
    const win = window!;
    // Seed a snapshot so the smoke test exercises the row and flag rendering,
    // not just the empty state. Fixture only — nothing reaches the network.
    if (process.env['BATON_SMOKE'] === 'seeded') {
      const pull = {
        number: 42, title: 'Fix the flaky payment retry', url: 'https://example.invalid/pr/42',
        repo: 'acme/web', author: 'someone', isDraft: false,
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
        mergeable: 'conflicting' as const, reviewDecision: 'changes_requested' as const,
        checks: 'failure' as const, unresolvedThreads: 2,
        additions: 10, deletions: 3, viewerReviewed: false
      };
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('baton:snapshot', {
          at: Date.now(), viewer: 'idrisay', blocked: [pull], mine: [pull],
          reviewRequested: [], tickets: [], connected: ['github'], errors: [], refreshing: false
        });
      });
    }
    win.webContents.once('did-finish-load', async () => {
      // Live mode waits for a real network round-trip before asserting.
      await new Promise((r) => setTimeout(r, process.env['BATON_SMOKE'] === 'live' ? 9000 : 400));
      const mounted = await win.webContents.executeJavaScript(
        `document.querySelector('#root')?.children.length > 0`
      );
      const hasApi = await win.webContents.executeJavaScript(`typeof window.baton?.refresh`);
      const heading = await win.webContents.executeJavaScript(
        `document.querySelector('.wordmark')?.textContent ?? ''`
      );
      const rail = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.rail-item span:first-child')).map(e => e.textContent).join(' | ')`
      );
      console.log(JSON.stringify({
        trayCreated: Boolean(tray),
        rendererMounted: mounted,
        preloadApi: hasApi,
        wordmark: heading,
        rail,
        emptyState: await win.webContents.executeJavaScript(
          `document.querySelector('.empty h1')?.textContent ?? ''`
        ),
        connected: poller.current().connected,
        rowTitle: await win.webContents.executeJavaScript(
          `document.querySelector('.row-title')?.textContent ?? ''`),
        rowMeta: await win.webContents.executeJavaScript(
          `document.querySelector('.row-meta')?.textContent ?? ''`),
        flags: await win.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.flag')).map(e => e.textContent).join(' · ')`),
        blockedCount: await win.webContents.executeJavaScript(
          `document.querySelector('.count.alert')?.textContent ?? ''`),
        // Click the first row, then read the detail pane that opens.
        detail: await win.webContents.executeJavaScript(`(async () => {
          document.querySelector('.row')?.click();
          await new Promise(r => setTimeout(r, 4000));
          return {
            heading: document.querySelector('.detail-head h2')?.textContent ?? '',
            runButtons: Array.from(document.querySelectorAll('.run-buttons button')).map(b => b.textContent),
            sections: Array.from(document.querySelectorAll('.detail h3')).map(h => h.textContent),
            error: document.querySelector('.detail .error')?.textContent ?? '',
            loading: Boolean(document.querySelector('.detail .quiet')),
            threads: document.querySelectorAll('.thread').length,
            checks: document.querySelectorAll('.check').length,
            files: document.querySelectorAll('.files li').length
          };
        })()`),
        snapshotOk: typeof poller.current().at === 'number',
        live: {
          viewer: poller.current().viewer,
          blocked: poller.current().blocked.length,
          mine: poller.current().mine.length,
          reviewRequested: poller.current().reviewRequested.length,
          tickets: poller.current().tickets.length,
          errors: poller.current().errors
        },
        userData: app.getPath('userData')
      }, null, 2));
      app.exit(0);
    });
  }

  // Opening from the Dock or a relaunch attempt should surface the window.
  app.on('activate', () => createWindow());
  app.on('second-instance', () => createWindow());
});

// Closing every window must NOT quit: that is the entire point of a menu bar
// app. Overriding the default here is what keeps Baton running.
app.on('window-all-closed', () => {
  // Intentionally empty.
});

app.on('before-quit', () => {
  poller.stop();
  sessions.disposeAll();
  tray?.dispose();
});
