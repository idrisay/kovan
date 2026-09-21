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

import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from './host';
import { Poller, type Snapshot } from './poller';
import { BatonTray } from './tray';
import { Activity } from './notify';
import { CREDENTIAL_FIELDS, HttpClient, fetchPullDetail } from '@baton/providers';
import { adoptImportedTokens } from './adopt';
import { smokePty, smokeUi, type SmokeMode, detailFixture, fixtureSnapshot } from './smoke';
import { Sessions } from './sessions';
import { Agents } from './agents';
import { Workspaces } from './workspace';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Before anything reads `app.getPath('userData')`. Electron derives that path
// from package.json's `name`, which is the scoped workspace name — without
// this, state lands in "@baton/desktop" and the importer in scripts/ writes to
// a directory the app will never read.
app.setName('Baton');

// A smoke run must not write into the real settings file — seeding a workspace
// there would leave a folder in the user's app that they never chose. Set
// before anything reads the path, for the same reason `setName` is.
if (process.env['BATON_USER_DATA']) {
  app.setPath('userData', process.env['BATON_USER_DATA']);
}

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
const workspaces = new Workspaces(host);
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
    // Matches the rail on each side of the appearance switch, so the frame and
    // the first paint agree rather than flashing the wrong one.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0e11' : '#edebe5',
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
  ipcMain.handle('baton:merged-more', (_event, limit: number) => {
    const want = Math.max(1, Math.min(100, Math.floor(limit)));
    // Same guard as the detail fixture: only ever a throwaway profile. The
    // handler answers the limit it was asked for, so the footer is driven
    // through the real IPC round trip rather than by the smoke pushing a
    // longer list at the renderer and calling that a test.
    if (process.env['BATON_SMOKE'] && process.env['BATON_USER_DATA']) {
      return fixtureSnapshot(want);
    }
    return poller.loadMoreMerged(want);
  });

  ipcMain.handle('baton:pull-detail', async (_event, repo: string, number: number) => {
    // Guarded by BATON_USER_DATA, the same way workspace seeding is: a fixture
    // can only ever be served to a throwaway profile, never to a real one.
    if (process.env['BATON_SMOKE'] && process.env['BATON_USER_DATA']) {
      return detailFixture(repo, number);
    }
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

  // --- Workspace ------------------------------------------------------------
  // Every path-taking channel below is resolved against the workspace folders
  // inside `Workspaces`; see the note at the top of workspace.ts.
  ipcMain.handle('baton:workspaces', () => ({
    list: workspaces.list(),
    active: workspaces.activeId()
  }));
  ipcMain.handle('baton:workspace-create', () => workspaces.create(window));
  ipcMain.handle('baton:workspace-activate', (_event, id: string) => workspaces.activate(id));
  ipcMain.handle('baton:workspace-add-folder', (_event, id: string) =>
    workspaces.addFolder(id, window)
  );
  ipcMain.handle('baton:workspace-remove-folder', (_event, id: string, folder: string) =>
    workspaces.removeFolder(id, folder)
  );
  ipcMain.handle('baton:workspace-forget', (_event, id: string) => workspaces.forget(id));
  ipcMain.handle('baton:workspace-repos', (_event, id: string, force?: boolean) =>
    workspaces.repos(id, force)
  );
  ipcMain.handle('baton:workspace-roots', (_event, id: string, force?: boolean) =>
    workspaces.roots(id, force)
  );
  ipcMain.handle('baton:workspace-rename', (_event, id: string, name: string) =>
    workspaces.rename(id, name)
  );
  ipcMain.handle('baton:workspace-status', (_event, repo: string) => workspaces.status(repo));
  ipcMain.handle(
    'baton:workspace-diff',
    (_event, repo: string, file: string, side: string, from?: string) =>
      workspaces.diff(repo, file, side as 'staged' | 'unstaged' | 'untracked', from)
  );
  ipcMain.handle('baton:workspace-tree', (_event, dir: string) => workspaces.tree(dir));
  ipcMain.handle('baton:workspace-read', (_event, file: string) => workspaces.read(file));
  ipcMain.handle(
    'baton:workspace-write',
    (_event, file: string, text: string, expected?: { mtimeMs: number; bytes: number }) =>
      workspaces.write(file, text, expected)
  );

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

  // Seeds the workspace the UI smoke then drives. Guarded by the same env var
  // that redirects userData, so it can only ever touch a throwaway profile.
  if (process.env['BATON_SMOKE'] === 'workspace' && process.env['BATON_WS_FOLDER']) {
    await seedWorkspace(process.env['BATON_WS_FOLDER']);
  }

  if (process.env['BATON_SMOKE'] === 'pty') {
    console.log(JSON.stringify(await smokePty(sessions, agents), null, 2));
    app.exit(0);
    return;
  }

  poller.start();

  if (process.env['BATON_SMOKE']) {
    createWindow();
    const win = window!;
    win.webContents.once('did-finish-load', async () => {
      const mode = process.env['BATON_SMOKE'] as SmokeMode;
      // A throw in here used to reject into nothing: `app.exit` never ran and
      // the run hung until whatever was waiting on it gave up, with the actual
      // error nowhere in the output. A smoke that cannot fail is not a check.
      try {
        console.log(JSON.stringify(await smokeUi(win, poller, mode), null, 2));
        app.exit(0);
      } catch (err) {
        console.error('smoke failed:', err instanceof Error ? err.stack ?? err.message : err);
        app.exit(1);
      }
    });
    return;
  }


  app.on('activate', () => createWindow());
  app.on('second-instance', () => createWindow());
});

async function seedWorkspace(folder: string): Promise<void> {
  if (!process.env['BATON_USER_DATA']) {
    throw new Error('Refusing to seed a workspace into the real profile');
  }
  // Colon-separated, so the multi-folder workspace — the case this whole
  // explorer exists for — can actually be exercised.
  const folders = folder.split(':').filter(Boolean);
  await host.config.set('workspaces', [
    {
      id: 'smoke-workspace',
      name: process.env['BATON_WS_NAME'] ?? path.basename(folders[0] ?? folder),
      folders
    }
  ]);
  await host.config.set('workspace.active', 'smoke-workspace');
}

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
