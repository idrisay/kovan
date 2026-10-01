/**
 * Main process entry.
 *
 * Architecture note, because it is easy to undo by accident: this app is
 * main-process-first. The poller, the providers, the credentials and the
 * notifications all live here, and the window is a view onto state that
 * already exists. Closing the window *destroys* it rather than hiding it, so
 * an idle Kovan costs one Node process instead of a Chromium tree — which is
 * the whole reason it is worth leaving running, and the advantage it has over
 * the VS Code extension it replaces.
 *
 * If you ever find yourself moving the poller into the renderer, stop.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, Notification, shell, systemPreferences } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from './host';
import { logFilePath, logRendererError } from './logFile';
import { Poller, type PolledProvider, type Snapshot } from './poller';
import type { ProviderId, SpeechProviderId, ThemeId } from '@kovan/core';
import { DEFAULT_SETTINGS, resolveTheme, themeInfo } from '@kovan/core';
import type { ChangeKind } from '@kovan/git';
import { KovanTray } from './tray';
import { Activity } from './notify';
import { ActivityFeed } from './activityFeed';
import { Dictation } from './dictation';
import { FileIndex } from './fileIndex';
import { RunWatcher } from './runWatch';
import { QuickCommands } from './quickCommands';
import {
  CREDENTIAL_FIELDS, Credentials, HttpClient, JiraClient, fetchPullDetail, fetchPullDiff, fetchReviewerCandidates,
  requestPullReviewers, submitPullReview
} from '@kovan/providers';
import { adoptImportedTokens } from './adopt';
import { adoptBatonSecrets, copyBatonState } from './renamed';
import {
  smokePty, smokeUi, type SmokeMode, detailFixture, diffFixture, fixtureSnapshot, sentryFramesFixture,
  sentryTicketFixture, ticketFixture
} from './smoke';
import { Sessions } from './sessions';
import { PtyHosts } from './ptyClient';
import { AgentStatus } from './agentStatus';
import { ProblemLog } from './problems';
import { Agents } from './agents';
import type { TestEnvironmentSave, TestSelection } from './testEnvironments';
import { Workspaces } from './workspace';
import { QuickModel } from './quick';
import { PriceCheck } from './priceCheck';
import { ModelSearch } from './modelSearch';
import { Usage } from './usage';
import { RunningAgents } from './running';
import { SHELL_SETTING, chosenShell, listShells } from './shells';
import { activityLabel, githubAnswered, ticketKeyInTitle, type ActivityEvent, type PriceCheckRunner, type PriceRule, type QuickKind, type ReviewEvent } from '@kovan/core';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Before anything reads `app.getPath('userData')`. Electron derives that path
// from package.json's `name`, which is the scoped workspace name — without
// this, state lands in "@kovan/desktop" and the importer in scripts/ writes to
// a directory the app will never read.
app.setName('Kovan');

// A smoke run must not write into the real settings file — seeding a workspace
// there would leave a folder in the user's app that they never chose. Set
// before anything reads the path, for the same reason `setName` is.
if (process.env['KOVAN_USER_DATA']) {
  app.setPath('userData', process.env['KOVAN_USER_DATA']);
  // Its log too: a smoke run's crashes are not the user's.
  app.setAppLogsPath(path.join(process.env['KOVAN_USER_DATA'], 'logs'));
} else {
  // The first launch after the rename finds Baton's state and copies it over.
  copyBatonState();
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

// Logged rather than left to Electron's default, which in the installed app
// prints to nowhere — the crash that blanked the window left no trace at all
// (item 83). Main keeps running: the poller and the tray are still useful.
process.on('uncaughtException', (error) => host.log.error('Uncaught exception in main', error));
process.on('unhandledRejection', (reason) => host.log.error('Unhandled rejection in main', reason));
const poller = new Poller(host);
const activity = new Activity(host);

// --- Activity inbox (item 86) ------------------------------------------------
// A subject a notification was clicked for, waiting for a window to open it.
let pendingActivityOpen: string | undefined;

function deliverActivity(inbox: ActivityEvent[], fresh: ActivityEvent[], quiet: boolean): void {
  const live = window && !window.isDestroyed() ? window : undefined;
  live?.webContents.send('kovan:activity', inbox);
  if (quiet || fresh.length === 0) return;

  // In front: a toast in the window. Anywhere else — closed, hidden, behind
  // another app — a macOS notification, because a toast nobody sees is none.
  // A smoke run never reaches Notification Center: it would pop up on the
  // machine running it, and the toast path is the one it can check.
  const inFront = live && (process.env['KOVAN_SMOKE'] ? true : live.isVisible() && live.isFocused());
  if (inFront) {
    live.webContents.send('kovan:activity-toast', fresh);
    return;
  }
  if (!host.config.get('notify.enabled', true) || !Notification.isSupported()) return;
  // "Changes requested" also makes the pull request blocked, and the blocked
  // notification already says so; two for one change would be noise.
  const notify = fresh.filter((event) => event.kind !== 'changes-requested');
  if (notify.length === 0) return;
  const open = (subject: string) => {
    pendingActivityOpen = subject;
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      window.webContents.send('kovan:activity-open', subject);
      pendingActivityOpen = undefined;
    } else {
      createWindow();
    }
  };
  if (notify.length <= 2) {
    for (const event of notify) {
      const n = new Notification({
        title: activityLabel(event.kind),
        subtitle: event.who ? `${event.label} · ${event.who}` : event.label,
        // A mention says what was written (item 119).
        body: event.excerpt ? `“${event.excerpt}”` : event.title
      });
      n.on('click', () => open(event.subject));
      n.show();
    }
    return;
  }
  const n = new Notification({
    title: 'Kovan',
    body: `${notify.length} new: ${[...new Set(notify.map((e) => activityLabel(e.kind).toLowerCase()))].join(', ')}`
  });
  n.on('click', () => open(''));
  n.show();
}

const activityFeed = new ActivityFeed(host, deliverActivity);
const dictation = new Dictation(host);
const fileIndex = new FileIndex();
const runWatcher = new RunWatcher((message, error) => host.log.warn(message, error));
// A ticket key in a terminal's title only counts for a project Kovan already
// has tickets from, as for branch names in `nameTerminal` below.
// Sessions live in a background terminal host so quitting Kovan doesn't end
// them (item 114), and agents report Working / Input / Done (item 112).
const agentStatus = new AgentStatus(app.getPath('userData'));
// A service that didn't answer, and the ones before it (item 120).
const problems = new ProblemLog(app.getPath('userData'));
const sessions = new Sessions((text) => {
  const key = ticketKeyInTitle(text.toUpperCase());
  const projects = new Set(poller.current().tickets.map((t) => t.key.split('-')[0]));
  return key && projects.has(key.split('-')[0]!) ? key : undefined;
}, {
  hosts: new PtyHosts(app.getPath('userData'), (message) => host.log.info(message)),
  statusDir: agentStatus.dir
});
const quickCommands = new QuickCommands(host, sessions);
const detailHttp = new HttpClient(host.log);
const credentials = new Credentials(host);
const quick = new QuickModel(host, {
  pull: loadPullDetail, ticket: loadTicket, diff: loadPullDiff, submitReview: postPullReview
});
const usage = new Usage(host, sessions, () => quick.listJobs());
const agents = new Agents(host, sessions, quick);
const running = new RunningAgents(host, sessions, () => {
  createWindow();
  window?.webContents.send('kovan:show-agents');
});
const workspaces = new Workspaces(host);

/**
 * One pull request's full detail. Shared by the detail pane and the quick
 * model, so "Summarize" reads exactly what the pane shows.
 */
async function loadPullDetail(repo: string, number: number) {
  // Guarded by KOVAN_USER_DATA, the same way workspace seeding is: a fixture
  // can only ever be served to a throwaway profile, never to a real one.
  if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
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
}

/** A pull request's unified diff, for the Kimi K3 review. */
async function loadPullDiff(repo: string, number: number) {
  if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
    return diffFixture();
  }
  const token = await host.secrets.get('github');
  if (!token) {
    throw new Error('GitHub is not connected');
  }
  return fetchPullDiff(detailHttp, host.config.get('github.baseUrl', 'https://api.github.com'), token, repo, number);
}

/** Posts a review as the user. Only from a confirmed click on the review card. */
async function postPullReview(repo: string, number: number, event: ReviewEvent, body: string) {
  // A smoke run must never post anything, anywhere.
  if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
    return { url: `https://github.com/${repo}/pull/${number}#pullrequestreview-smoke` };
  }
  const token = await host.secrets.get('github');
  if (!token) {
    throw new Error('GitHub is not connected');
  }
  return submitPullReview(detailHttp, host.config.get('github.baseUrl', 'https://api.github.com'), token, repo, number, event, body);
}

/**
 * Who can be asked to review on a repo, most-asked first. "Most asked" is
 * Kovan's own count of the requests you made through it, per repo — kept in
 * settings, so the people you always pick float to the top.
 */
type ReviewHistory = Record<string, Record<string, number>>;

async function loadReviewerCandidates(repo: string) {
  const counts = host.config.get<ReviewHistory>('reviewers.history', {})[repo] ?? {};
  let found: { people: string[]; teams: { slug: string; name: string }[] };
  if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
    found = { people: ['sara-k', 'mehmet-b', 'lena-t', 'someone'], teams: [{ slug: 'frontend-team', name: 'Frontend team' }] };
  } else {
    const token = await host.secrets.get('github');
    if (!token) throw new Error('GitHub is not connected');
    found = await fetchReviewerCandidates(detailHttp, host.config.get('github.baseUrl', 'https://api.github.com'), token, repo);
  }
  const people = [...new Set([...Object.keys(counts), ...found.people])]
    .map((login) => ({ login, count: counts[login] ?? 0 }))
    .sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
  return { people, teams: found.teams };
}

/** Requests reviews as the user. Only from a click in the Reviewers picker. */
async function requestReviewers(repo: string, number: number, people: string[], teams: string[]) {
  // A smoke run must never post anything, anywhere.
  if (!(process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA'])) {
    const token = await host.secrets.get('github');
    if (!token) throw new Error('GitHub is not connected');
    await requestPullReviewers(detailHttp, host.config.get('github.baseUrl', 'https://api.github.com'), token, repo, number, people, teams);
  }
  const history = host.config.get<ReviewHistory>('reviewers.history', {});
  const counts = { ...(history[repo] ?? {}) };
  for (const login of people) counts[login] = (counts[login] ?? 0) + 1;
  await host.config.set('reviewers.history', { ...history, [repo]: counts });
}

/**
 * Every status of the projects the loaded tickets come from, for the tickets
 * filter. Asked when the filter first opens, and kept for an hour: workflows
 * change about never, and a click should not cost a round trip each time.
 */
let statusCache: { key: string; at: number; statuses: { name: string; category: string }[] } | undefined;

async function loadTicketStatuses(): Promise<{ name: string; category: string }[]> {
  const projects = [...new Set(poller.current().tickets.map((t) => t.key.split('-')[0]!))].sort();
  if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
    return ['To Specify', 'Ready for Tech Analysis', 'Ready For Implementation', 'In Development', 'In Review', 'QA', 'APPROVED', 'DEPLOYED', 'Closed']
      .map((name, i) => ({ name, category: i < 3 ? 'new' : i < 6 ? 'indeterminate' : 'done' }));
  }
  const key = projects.join(',');
  if (statusCache && statusCache.key === key && Date.now() - statusCache.at < 60 * 60_000) return statusCache.statuses;
  const token = await host.secrets.get('jira');
  const site = host.config.get('jira.baseUrl', '');
  const email = host.config.get('jira.email', '');
  if (!token || !site || !email || projects.length === 0) return [];
  const client = new JiraClient(detailHttp, site, email, token);
  const lists = await Promise.all(projects.map((p) => client.getProjectStatuses(p).catch(() => [])));
  const seen = new Map<string, { name: string; category: string }>();
  for (const status of lists.flat()) if (!seen.has(status.name)) seen.set(status.name, status);
  const rank: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
  const statuses = [...seen.values()].sort((a, b) => (rank[a.category] ?? 3) - (rank[b.category] ?? 3));
  if (statuses.length > 0) statusCache = { key, at: Date.now(), statuses };
  return statuses;
}

async function loadTicket(key: string) {
  if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
    return ticketFixture(key);
  }
  const token = await host.secrets.get('jira');
  const site = host.config.get('jira.baseUrl', '');
  const email = host.config.get('jira.email', '');
  if (!token || !site || !email) {
    throw new Error('Jira is not connected');
  }
  return new JiraClient(detailHttp, site, email, token).getIssue(key);
}

/**
 * What a plain terminal is called, when nothing opening it named it: the
 * repository and branch it sits on, and the ticket when the branch names one
 * (`fix/ACME-2393-tablet-qa` → `acme/acme-frontend · ACME-2393`) — so
 * the row links to that ticket instead of reading "Terminal" like every other.
 */
async function nameTerminal(cwd: string, subject?: string): Promise<{ title: string; subject?: string }> {
  // One git call: the clone's root (a terminal opened in a subfolder is
  // still named after its repository) and the branch.
  const [root, branch] = await new Promise<[string, string]>((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { timeout: 3000 }, (err, stdout) => {
      const [top = '', head = ''] = err ? [] : stdout.trim().split('\n');
      resolve([top.trim(), head.trim()]);
    });
  });
  const targets = await agents.targets().catch(() => []);
  const target = targets.find((t) => t.path === cwd) ?? targets.find((t) => root && t.path === root);
  const label = target?.label ?? path.basename(root || cwd);
  if (subject) return { title: `${label} · ${subject}`, subject };
  // Branches are usually lower-case (`fix/acme-2393-…`); an upper-cased
  // match only counts for a project Kovan already has tickets from, so
  // `feat/utf-8` does not become ticket UTF-8.
  const projects = new Set(poller.current().tickets.map((t) => t.key.split('-')[0]));
  const loose = ticketKeyInTitle(branch.toUpperCase());
  const key = ticketKeyInTitle(branch) || (loose && projects.has(loose.split('-')[0]!) ? loose : '');
  if (key) return { title: `${label} · ${key}`, subject: key };
  return { title: branch && branch !== 'HEAD' ? `${label} (${branch})` : label };
}

let window: BrowserWindow | undefined;
let tray: KovanTray | undefined;
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
    backgroundColor: launchBackground(),
    webPreferences: {
      preload: path.join(dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.once('ready-to-show', () => window?.show());

  if (process.env['KOVAN_SMOKE']) {
    window.webContents.on('console-message', (_event, _level, message) => {
      console.log('[renderer]', message);
    });
  }

  // The window's own process going away is the other way to a black screen.
  window.webContents.on('render-process-gone', (_event, details) => {
    host.log.error(`Window process gone: ${details.reason} (exit code ${details.exitCode})`);
  });
  window.on('unresponsive', () => host.log.warn('Window stopped responding'));

  // Destroy, don't hide. See the note at the top of this file.
  window.on('closed', () => {
    window = undefined;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Cmd+=/Cmd+- already did something before this line existed: Electron's
  // own default menu zooms the whole page with it, chrome and all, because
  // this window never installs a menu of its own. Rather than replace that
  // menu wholesale (and take on reimplementing every other default — Cmd+Q,
  // Cmd+W, copy/paste — as a side effect), intercept just these two keys at
  // the input level and repoint them at the terminal's own font size, which
  // is the thing people actually meant to be resizing.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.alt || input.control) return;
    if (input.key === '=' || input.key === '+') {
      event.preventDefault();
      window?.webContents.send('kovan:font-size-step', 1);
    } else if (input.key === '-') {
      event.preventDefault();
      window?.webContents.send('kovan:font-size-step', -1);
    }
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
 * `openAsHidden` keeps a login launch quiet: Kovan starts polling with its
 * Dock icon and menu bar glyph, but no window jumps up at login.
 */
function applyLoginItem(): void {
  const wanted = host.config.get('launchAtLogin', false);
  const current = app.getLoginItemSettings();
  if (current.openAtLogin !== wanted) {
    app.setLoginItemSettings({ openAtLogin: wanted, openAsHidden: true });
  }
}

/**
 * Native chrome follows the same choice the page does — the window's own
 * `backgroundColor` at creation (used for the flash-free first paint above),
 * and OS-drawn bits the CSS can never reach, like a native `<select>` or a
 * scrollbar. `nativeTheme.themeSource` is Electron's side of exactly the
 * System/Light/Dark choice `data-theme` is the renderer's side of.
 */
function applyTheme(): void {
  nativeTheme.themeSource = themeSource();
}

/** The theme the saved settings ask for right now. The renderer keeps
 *  native chrome current afterwards (a scheduled switch, say) through
 *  `kovan:native-theme`; this is for launch, before it has loaded. */
function savedTheme(): ThemeId {
  const get = <K extends 'appearance.theme' | 'appearance.dayTheme' | 'appearance.nightTheme' | 'appearance.dayStart' | 'appearance.nightStart'>(key: K) =>
    host.config.get(key, DEFAULT_SETTINGS[key]);
  return resolveTheme(get('appearance.theme'), {
    day: get('appearance.dayTheme'),
    night: get('appearance.nightTheme'),
    dayStart: get('appearance.dayStart'),
    nightStart: get('appearance.nightStart')
  }, { osLight: !nativeTheme.shouldUseDarkColors, now: new Date() });
}

/** The saved theme choice as Electron's System/Light/Dark. */
function themeSource(): 'system' | 'light' | 'dark' {
  return host.config.get('appearance.theme', 'system') === 'system' ? 'system' : themeInfo(savedTheme()).tone;
}

/** The first paint's colour: the rail of the theme about to be painted. */
function launchBackground(): string {
  return themeInfo(savedTheme()).rail;
}

function broadcast(snapshot: Snapshot): void {
  tray?.update(snapshot);
  if (window && !window.isDestroyed()) {
    window.webContents.send('kovan:snapshot', snapshot);
  }
}

app.whenReady().then(async () => {
  // First, before anything reads a token and caches what it found.
  await adoptBatonSecrets(host.log);

  // A normal Dock app, like VS Code: it shows in Cmd+Tab and has a menu bar,
  // and the menu bar glyph stays as a glance at what is blocked. It used to be
  // menu-bar-only (LSUIElement), which left Cmd+Tab and the Dock with nothing
  // to switch to and made opening it from Finder look like it did nothing.

  tray = new KovanTray({
    open: () => createWindow(),
    refresh: () => void poller.refresh(true),
    launchAtLogin: () => host.config.get('launchAtLogin', false),
    toggleLaunchAtLogin: async () => {
      const next = !host.config.get('launchAtLogin', false);
      await host.config.set('launchAtLogin', next);
      applyLoginItem();
      tray?.update(poller.current());
    },
    // Through `quit`, not `exit`, so the tray's Quit asks about running
    // sessions the same way Cmd+Q does.
    quit: () => app.quit()
  });

  // Before the first window: what was running when Kovan last quit is there
  // from the start, and so is what its agents said while Kovan was away.
  try {
    const restored = await sessions.restore();
    if (restored) host.log.info(`picked up ${restored} session(s) from the terminal host`);
  } catch (error) {
    host.log.warn('could not pick up sessions from the terminal host', error);
  }
  void agentStatus.watch((id, state) => sessions.setStatus(id, state));

  poller.onDidChange((snapshot) => {
    broadcast(snapshot);
    if (!snapshot.refreshing && snapshot.at > 0) {
      const polled: ProviderId[] = ['github', 'jira', 'sentry'];
      const answered = snapshot.connected.filter((id) => polled.includes(id) && !snapshot.errors.some((e) => e.provider === id));
      void problems.record(snapshot.errors, answered, snapshot.at);
    }
    if (!snapshot.refreshing) {
      void activity.report(snapshot, firstRefresh);
      void activityFeed.report(snapshot, firstRefresh);
      // Only an answered poll is the first one: a launch that starts during a
      // rate limit must still stay quiet about what it finds afterwards.
      // (Without GitHub connected there's nothing to wait for.)
      if (githubAnswered(snapshot) || !snapshot.connected.includes('github')) firstRefresh = false;
    }
  });

  // --- IPC. Every channel is read-only about secrets: tokens are set through
  // --- here but never sent back out, so the renderer cannot leak one.
  ipcMain.handle('kovan:snapshot', () => poller.current());
  ipcMain.handle('kovan:problems', () => problems.list());
  problems.onDidChange(({ log, started }) => {
    if (window && !window.isDestroyed()) window.webContents.send('kovan:problems', { log, started });
  });
  ipcMain.handle('kovan:refresh', () => poller.refresh(true));
  ipcMain.handle('kovan:refresh-provider', (_event, id: PolledProvider) => poller.refreshProvider(id));
  ipcMain.handle('kovan:open-external', (_event, url: string) => shell.openExternal(url));
  ipcMain.handle('kovan:credential-fields', () => CREDENTIAL_FIELDS);
  ipcMain.handle('kovan:missing-fields', (_event, id: ProviderId) => credentials.missingFields(id));
  ipcMain.handle('kovan:settings', () => host.config.all());
  ipcMain.handle('kovan:set-setting', async (_event, key: string, value: unknown) => {
    await host.config.set(key, value);
    if (key === 'launchAtLogin') {
      applyLoginItem();
    }
    if (key === 'appearance.theme') {
      applyTheme();
    }
  });
  ipcMain.handle('kovan:native-theme', (_event, source: 'system' | 'light' | 'dark') => {
    if (source === 'system' || source === 'light' || source === 'dark') nativeTheme.themeSource = source;
  });
  ipcMain.handle('kovan:system-accent', () => {
    // 'rrggbbaa' on macOS; empty or throwing where there is no such setting.
    try {
      const raw = systemPreferences.getAccentColor();
      return /^[0-9a-f]{6}/i.test(raw) ? `#${raw.slice(0, 6)}` : undefined;
    } catch {
      return undefined;
    }
  });
  ipcMain.handle('kovan:set-secret', async (_event, key: string, value: string) => {
    await host.secrets.set(key, value);
    return poller.refresh(true);
  });

  // --- Detail ---------------------------------------------------------------
  ipcMain.handle('kovan:merged-more', (_event, limit: number) => {
    const want = Math.max(1, Math.min(100, Math.floor(limit)));
    // Same guard as the detail fixture: only ever a throwaway profile. The
    // handler answers the limit it was asked for, so the footer is driven
    // through the real IPC round trip rather than by the smoke pushing a
    // longer list at the renderer and calling that a test.
    if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
      return fixtureSnapshot(want);
    }
    return poller.loadMoreMerged(want);
  });

  ipcMain.handle('kovan:pull-detail', (_event, repo: string, number: number) => loadPullDetail(repo, number));
  ipcMain.handle('kovan:reviewer-candidates', (_event, repo: string) => loadReviewerCandidates(repo));
  ipcMain.handle('kovan:reviewers-request', (_event, repo: string, number: number, people: string[], teams: string[]) =>
    requestReviewers(repo, number, people, teams));
  ipcMain.handle('kovan:ticket-detail', (_event, key: string) => loadTicket(key));

  // --- Quick model ----------------------------------------------------------
  quick.onChange((kind, subject, state) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('kovan:quick', kind, subject, state);
    }
  });
  quick.onJobs((jobs) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('kovan:quick-jobs', jobs);
    }
    void usage.quickChanged();
  });
  ipcMain.handle('kovan:quick-jobs', () => quick.listJobs());
  ipcMain.handle('kovan:quick-job-remove', (_event, id: string) => quick.removeJob(id));
  ipcMain.handle('kovan:quick-model', (_event, kind: QuickKind) => quick.modelFor(kind));
  ipcMain.handle('kovan:quick-model-set', (_event, kind: QuickKind, model: string) => quick.setModelFor(kind, model));
  ipcMain.handle('kovan:quick-models-available', () => quick.available());
  // Settings → Token prices → Check prices online. Proposals only: the
  // renderer shows them and the user picks what to apply.
  const priceCheck = new PriceCheck();
  ipcMain.handle('kovan:price-check', (_event, runner: PriceCheckRunner, model: string, rules: PriceRule[]) =>
    priceCheck.run(runner, model, rules));
  ipcMain.handle('kovan:price-check-cancel', () => priceCheck.cancel());
  ipcMain.handle('kovan:quick-state', (_event, kind: QuickKind, subject: string) => quick.state(kind, subject));
  ipcMain.handle('kovan:quick-run', (_event, kind: QuickKind, subject: string) => quick.run(kind, subject));
  ipcMain.handle('kovan:quick-cancel', (_event, kind: QuickKind, subject: string) => quick.cancel(kind, subject));
  ipcMain.handle('kovan:quick-dismiss', (_event, kind: QuickKind, subject: string) => quick.dismiss(kind, subject));
  ipcMain.handle('kovan:quick-test', (_event, model?: string) => quick.test(model));
  ipcMain.handle('kovan:review-submit', (_event, subject: string, event: ReviewEvent) => quick.submitReview(subject, event));

  // --- Token usage ----------------------------------------------------------
  usage.onChange((records) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('kovan:usage', records);
    }
  });
  ipcMain.handle('kovan:usage', () => usage.list());
  usage.start();

  // --- Running agents -------------------------------------------------------
  running.onChange((report) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('kovan:running-agents', report);
    }
  });
  ipcMain.handle('kovan:running-agents', () => running.current());
  ipcMain.handle('kovan:running-agents-watch', (_event, on: boolean) => running.watch(on));
  ipcMain.handle('kovan:running-agents-stop', (_event, keys: string[], children: boolean) =>
    running.stop(Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : [], children !== false)
  );
  ipcMain.handle('kovan:running-agents-force', (_event, key: string) => running.forceStop(key));
  running.start();

  // --- Agents ---------------------------------------------------------------
  ipcMain.handle('kovan:runners', () => agents.runners());
  // The run sheet's Model dropdown, and its ↻. Searching only adds names.
  const modelSearch = new ModelSearch(host, () => quick.available(true));
  ipcMain.handle('kovan:known-models', () => modelSearch.lists());
  ipcMain.handle('kovan:ticket-statuses', () => loadTicketStatuses().catch(() => []));
  // A screenshot on the clipboard, pasted into a terminal: saved as a file and
  // its path typed in, which is how Claude Code takes an image in any
  // terminal (VS Code's drop does the same with the dropped file's path).
  ipcMain.handle('kovan:clipboard-write', (_event, text: string) => { clipboard.writeText(String(text)); });
  ipcMain.handle('kovan:clipboard-image', async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return '';
    const dir = path.join(tmpdir(), 'kovan-paste');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await writeFile(file, image.toPNG());
    return file;
  });
  ipcMain.handle('kovan:models-search', (_event, command: string) => modelSearch.search(command));
  ipcMain.handle('kovan:models-search-cancel', () => modelSearch.cancel());
  ipcMain.handle('kovan:run-targets', (_event, force?: boolean) => agents.targets(force));
  ipcMain.handle('kovan:build-prompt', (_event, kind, subject, test?: TestSelection) =>
    agents.buildPrompt(kind, subject, test)
  );
  ipcMain.handle('kovan:test-environments', () => agents.testEnvironments.state());
  ipcMain.handle('kovan:test-environments-save', (_event, next: TestEnvironmentSave) =>
    agents.testEnvironments.save(next)
  );
  ipcMain.handle('kovan:default-cwd', (_event, repo?: string) => agents.defaultCwd(repo));
  ipcMain.handle('kovan:start-agent', async (_event, request, subject) => {
    const result = await agents.start(request, subject);
    if (result.ok) {
      // Surface the terminal straight away: a run that starts invisibly looks
      // like a button that did nothing.
      createWindow();
    }
    return result;
  });
  ipcMain.handle('kovan:run-history', (_event, subject: string) => agents.history(subject));
  ipcMain.handle('kovan:sentry-frames', (_event, issueId: string) => {
    if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
      return sentryFramesFixture(issueId);
    }
    return agents.sentryFrames(issueId);
  });
  ipcMain.handle('kovan:sentry-create-ticket', (_event, issue) => {
    if (process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']) {
      return sentryTicketFixture();
    }
    return agents.createTicketFromSentry(issue);
  });
  ipcMain.handle('kovan:run-files', (_event, directory: string) => agents.runFiles(directory));
  ipcMain.handle('kovan:run-text', (_event, file: string) => agents.readRunText(file));
  // Item 90: live screenshots while a run's viewer is open, and its site in
  // the default browser. Run folders only; the site comes from run.json.
  ipcMain.handle('kovan:run-watch', (event, directory: string, on: boolean) => {
    if (typeof directory !== 'string' || !agents.ownsRun(directory)) throw new Error('Not a run directory.');
    if (on) runWatcher.watch(directory, event.sender);
    else runWatcher.unwatch(directory, event.sender);
  });
  // Plan limits per runner, from what the agents write themselves (item 108).
  ipcMain.handle('kovan:agent-limits', async () => agents.limits.read(await agents.runners()));
  ipcMain.handle('kovan:run-site-open', (_event, directory: string, shot?: string) =>
    agents.openRunSite(directory, typeof shot === 'string' ? shot : undefined));
  ipcMain.handle('kovan:run-image', (_event, file: string) => agents.readRunImage(file));
  ipcMain.handle('kovan:run-reveal', (_event, file: string) => agents.revealRunFile(file));

  // --- Quick commands (item 91) ---------------------------------------------
  // Saved and edited here, validated in main; run only by id, so the command
  // that reaches a shell is always the one stored, never one the page sent.
  ipcMain.handle('kovan:commands', () => quickCommands.list());
  ipcMain.handle('kovan:command-save', (_event, input: unknown) =>
    quickCommands.save(input && typeof input === 'object' ? (input as Record<string, unknown>) : {}));
  ipcMain.handle('kovan:command-duplicate', (_event, id: string) => quickCommands.duplicate(String(id)));
  ipcMain.handle('kovan:command-delete', (_event, id: string) => quickCommands.remove(String(id)));
  ipcMain.handle('kovan:command-run', (_event, id: string) => quickCommands.run(String(id)));
  ipcMain.handle('kovan:command-folder', async () => {
    const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], title: 'Run the command in' };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? '' : picked.filePaths[0] ?? '';
  });

  // --- Dictation (item 88) ---------------------------------------------------
  // Only ever the window that asked hears the words; the helper exits with it.
  ipcMain.handle('kovan:dictation-start', (event) => dictation.start(event.sender));
  ipcMain.handle('kovan:dictation-stop', () => dictation.stop());
  ipcMain.handle('kovan:dictation-cancel', () => dictation.cancel());
  ipcMain.handle('kovan:dictation-status', (_event, refresh: unknown) => dictation.currentStatus(refresh === true));
  // Speech providers (item 97).
  ipcMain.handle('kovan:speech-setup', () => dictation.setup());
  ipcMain.handle('kovan:speech-key', (_event, provider: SpeechProviderId, key: string) => dictation.setKey(provider, String(key ?? '')));
  ipcMain.handle('kovan:speech-test', (_event, provider: SpeechProviderId) => dictation.test(provider));
  ipcMain.handle('kovan:speech-pick-model', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a whisper.cpp model',
      filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }],
      properties: ['openFile']
    });
    const file = picked.canceled ? undefined : picked.filePaths[0];
    if (file) await host.config.set('dictation.whisperModel', file);
    return file;
  });
  // A fixed pair of Settings panes, never a URL from the renderer.
  ipcMain.handle('kovan:privacy-open', (_event, pane: unknown) =>
    shell.openExternal(
      pane === 'speech'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
  );

  // --- Activity inbox (item 86) ---------------------------------------------
  ipcMain.handle('kovan:activity', async () => {
    const open = pendingActivityOpen;
    pendingActivityOpen = undefined;
    return { inbox: await activityFeed.inbox(), open };
  });
  ipcMain.handle('kovan:activity-read', (_event, ids: unknown) =>
    activityFeed.markRead(
      ids === 'all' ? 'all' : Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    )
  );

  // --- Log (item 83) --------------------------------------------------------
  // The renderer reports what threw; main writes it. Only a report goes in and
  // nothing comes back — the renderer never learns or chooses a path.
  ipcMain.handle('kovan:error-log', (_event, report: unknown) => logRendererError(report));
  ipcMain.handle('kovan:log-reveal', () => shell.showItemInFolder(logFilePath()));

  // --- Workspace ------------------------------------------------------------
  // Every path-taking channel below is resolved against the workspace folders
  // inside `Workspaces`; see the note at the top of workspace.ts.
  ipcMain.handle('kovan:workspaces', () => ({
    list: workspaces.list(),
    active: workspaces.activeId()
  }));
  // ⌘P (item 100): the active workspace's files, listed on demand.
  ipcMain.handle('kovan:quick-open-files', async (_event, force?: boolean) => {
    const active = workspaces.list().find((w) => w.id === workspaces.activeId());
    if (!active || active.folders.length === 0) return { workspace: null, files: [] };
    return { workspace: active.name, files: await fileIndex.files(active.folders, force === true) };
  });
  ipcMain.handle('kovan:workspace-create', () => workspaces.create(window));
  ipcMain.handle('kovan:workspace-activate', (_event, id: string) => workspaces.activate(id));
  ipcMain.handle('kovan:workspace-add-folder', (_event, id: string) =>
    workspaces.addFolder(id, window)
  );
  ipcMain.handle('kovan:workspace-remove-folder', (_event, id: string, folder: string) =>
    workspaces.removeFolder(id, folder)
  );
  ipcMain.handle('kovan:workspace-reorder', (_event, id: string, folders: string[]) =>
    workspaces.reorder(id, Array.isArray(folders) ? folders.filter((f) => typeof f === 'string') : [])
  );
  ipcMain.handle('kovan:workspace-forget', (_event, id: string) => workspaces.forget(id));
  ipcMain.handle('kovan:workspace-repos', (_event, id: string, force?: boolean) =>
    workspaces.repos(id, force)
  );
  ipcMain.handle('kovan:workspace-roots', (_event, id: string, force?: boolean) =>
    workspaces.roots(id, force)
  );
  ipcMain.handle('kovan:workspace-rename', (_event, id: string, name: string) =>
    workspaces.rename(id, name)
  );
  ipcMain.handle('kovan:workspace-status', (_event, repo: string) => workspaces.status(repo));
  ipcMain.handle(
    'kovan:workspace-diff',
    (_event, repo: string, file: string, side: string, from?: string, context?: number) =>
      workspaces.diff(repo, file, side as 'staged' | 'unstaged' | 'untracked', from, context)
  );
  ipcMain.handle(
    'kovan:workspace-revert',
    (_event, repo: string, changes: { path: string; from?: string; side: string; kind: string }[]) =>
      workspaces.revert(
        repo,
        changes as { path: string; from?: string; side: 'staged' | 'unstaged' | 'untracked'; kind: ChangeKind }[]
      )
  );
  ipcMain.handle('kovan:workspace-tree', (_event, dir: string) => workspaces.tree(dir));
  ipcMain.handle('kovan:workspace-read', (_event, file: string) => workspaces.read(file));
  ipcMain.handle(
    'kovan:workspace-write',
    (_event, file: string, text: string, expected?: { mtimeMs: number; bytes: number }) =>
      workspaces.write(file, text, expected)
  );

  // --- Terminals ------------------------------------------------------------
  ipcMain.handle('kovan:sessions', () => sessions.list());
  ipcMain.handle('kovan:session-buffer', (_event, id: string) => sessions.buffer(id));
  ipcMain.handle('kovan:session-write', (_event, id: string, data: string) => {
    sessions.write(id, data);
  });
  ipcMain.handle('kovan:session-resize', (_event, id: string, cols: number, rows: number) => {
    sessions.resize(id, cols, rows);
  });
  ipcMain.handle('kovan:session-close', (_event, id: string) => {
    sessions.close(id);
    agentStatus.forget(id);
  });
  ipcMain.handle('kovan:session-rename', (_event, id: string, title: string) => {
    sessions.rename(id, title);
  });
  ipcMain.handle(
    'kovan:open-terminal',
    async (_event, cwd?: string, subject?: string, title?: string) => {
      const target = cwd ?? (await agents.defaultCwd());
      if (!target) {
        throw new Error('No folder to open a terminal in');
      }
      const named = title ? { title, subject } : await nameTerminal(target, subject);
      const shell = chosenShell(host.config.get<string>(SHELL_SETTING, ''));
      return sessions.open({ cwd: target, title: named.title, runnerName: 'Shell', subject: named.subject, shell });
    }
  );
  ipcMain.handle('kovan:shells', () => listShells());

  sessions.onOutput(({ id, data }) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('kovan:session-output', id, data);
    }
  });
  sessions.onDidChange((list) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('kovan:sessions', list);
    }
  });

  // Before the first poll, so an imported token is used on the very first
  // refresh rather than showing "not connected" for a cycle.
  await adoptImportedTokens(host);

  applyLoginItem();
  applyTheme();

  // Seeds the workspace the UI smoke then drives. Guarded by the same env var
  // that redirects userData, so it can only ever touch a throwaway profile.
  if ((process.env['KOVAN_SMOKE'] === 'workspace' || process.env['KOVAN_SMOKE_ITEM100']) && process.env['KOVAN_WS_FOLDER']) {
    await seedWorkspace(process.env['KOVAN_WS_FOLDER']);
  }

  if (process.env['KOVAN_SMOKE'] === 'pty') {
    console.log(JSON.stringify(await smokePty(sessions, agents), null, 2));
    sessions.disposeAll();
    app.exit(0);
    return;
  }

  poller.start();

  if (process.env['KOVAN_SMOKE']) {
    createWindow();
    const win = window!;
    win.webContents.once('did-finish-load', async () => {
      const mode = process.env['KOVAN_SMOKE'] as SmokeMode;
      // A throw in here used to reject into nothing: `app.exit` never ran and
      // the run hung until whatever was waiting on it gave up, with the actual
      // error nowhere in the output. A smoke that cannot fail is not a check.
      try {
        console.log(JSON.stringify(await smokeUi(win, poller, mode, activityFeed, sessions), null, 2));
        // `app.exit` skips will-quit: a smoke run's sessions end here, or the
        // terminal host keeps them (item 114).
        sessions.disposeAll();
        app.exit(0);
      } catch (err) {
        console.error('smoke failed:', err instanceof Error ? err.stack ?? err.message : err);
        sessions.disposeAll();
        app.exit(1);
      }
    });
    return;
  }


  app.on('activate', () => createWindow());
  app.on('second-instance', () => createWindow());
  // Cmd+Tab to Kovan with its window closed: `activate` only fires for a Dock
  // click, so switching to it would show a menu bar and nothing else.
  app.on('did-become-active', () => {
    if (!window || window.isDestroyed()) createWindow();
  });

  // Opened from Finder, Spotlight or the Dock: show the window. Only a login
  // launch stays in the background.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) createWindow();
});

async function seedWorkspace(folder: string): Promise<void> {
  if (!process.env['KOVAN_USER_DATA']) {
    throw new Error('Refusing to seed a workspace into the real profile');
  }
  // Colon-separated, so the multi-folder workspace — the case this whole
  // explorer exists for — can actually be exercised.
  const folders = folder.split(':').filter(Boolean);
  await host.config.set('workspaces', [
    {
      id: 'smoke-workspace',
      name: process.env['KOVAN_WS_NAME'] ?? path.basename(folders[0] ?? folder),
      folders
    }
  ]);
  await host.config.set('workspace.active', 'smoke-workspace');
}

// Closing the window must NOT quit, as with any Mac app: the poller, the
// sessions and the notifications keep running, and the Dock icon reopens it.
app.on('window-all-closed', () => {
  // Intentionally empty.
});

// Quitting no longer stops anything (item 114): the sessions live in the
// terminal host and come back on the next start, so there is nothing to ask.
// A session that had to run inside Kovan (no host could start) is the
// exception, and only then is it worth a question.
let quitConfirmed = false;
app.on('before-quit', (event) => {
  const live = sessions.list().filter((s) => s.running && !s.hosted).length;
  if (quitConfirmed || live === 0 || process.env['KOVAN_SMOKE']) return;
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    message: `Quit Kovan and stop ${live === 1 ? 'the running session' : `${live} running sessions`}?`,
    detail: 'These couldn\'t be moved to the background terminal host, so they stop when Kovan quits.',
    buttons: ['Cancel', 'Quit'],
    defaultId: 0,
    cancelId: 0
  });
  if (choice === 0) {
    event.preventDefault();
    return;
  }
  quitConfirmed = true;
});

app.on('will-quit', () => {
  runWatcher.dispose();
  dictation.dispose();
  usage.dispose();
  running.dispose();
  poller.stop();
  agentStatus.dispose();
  // A smoke run leaves nothing behind; a real quit leaves the agents working.
  if (process.env['KOVAN_SMOKE']) sessions.disposeAll();
  else sessions.detachAll();
  tray?.dispose();
});
