/**
 * The headless check.
 *
 * Screenshots need a screen-recording permission this environment does not
 * have, and "it rendered" is the assertion that actually matters — so this
 * launches the app, waits for it to be *ready* rather than for a fixed delay,
 * interrogates the real DOM, optionally captures the window, prints one JSON
 * object and exits.
 *
 * Modes, via `BATON_SMOKE`:
 *   `1`      wiring only — main, preload and renderer are talking.
 *   `seeded` the same, plus a fixture snapshot, so row and state rendering is
 *            exercised without the network.
 *   `live`   against the real account.
 *   `pty`    the terminal layer, which no DOM check can reach.
 *
 * `BATON_SHOT=<path>` also writes a PNG of the window.
 */

import { app, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { Agents } from './agents';
import type { Poller } from './poller';
import type { Sessions } from './sessions';

export type SmokeMode = '1' | 'seeded' | 'live' | 'pty';

const FIXTURE = {
  number: 42,
  title: 'Fix the flaky payment retry',
  url: 'https://example.invalid/pr/42',
  repo: 'acme/web',
  author: 'someone',
  isDraft: false,
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  mergeable: 'conflicting' as const,
  reviewDecision: 'changes_requested' as const,
  checks: 'failure' as const,
  unresolvedThreads: 2,
  additions: 10,
  deletions: 3,
  viewerReviewed: false
};

/** The terminal layer, which depends on a native module matching Electron's ABI. */
export async function smokePty(
  sessions: Sessions,
  agents: Agents
): Promise<Record<string, unknown>> {
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

  const prompt = agents.buildPrompt('unblock', { pull: FIXTURE });
  return {
    ptyOpened: Boolean(session.id),
    sawEcho: seen.includes('BATON_PTY_OK-42'),
    running: sessions.list()[0]?.running,
    bufferBytes: sessions.buffer(session.id).length,
    runnersFound: runners.length,
    runnerNames: runners.map((r) => r.name).slice(0, 8),
    targets: (await agents.targets()).map((x) => x.label).slice(0, 4),
    promptOk: prompt.includes('BATON_REPORT')
  };
}

/** Polls a predicate in the page rather than sleeping a guessed interval. */
async function until(
  win: BrowserWindow,
  expression: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const read = (win: BrowserWindow, expression: string) =>
  win.webContents.executeJavaScript(expression) as Promise<unknown>;

export async function smokeUi(
  win: BrowserWindow,
  poller: Poller,
  mode: SmokeMode
): Promise<Record<string, unknown>> {
  if (mode === 'seeded') {
    win.webContents.send('baton:snapshot', {
      at: Date.now(),
      viewer: 'idrisay',
      blocked: [FIXTURE],
      mine: [FIXTURE],
      reviewRequested: [],
      tickets: [],
      connected: ['github'],
      errors: [],
      refreshing: false
    });
  }

  if (mode === 'live') {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && poller.current().at === 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Either the app proper or the empty state counts as rendered.
  await until(win, `document.querySelector('.rail') || document.querySelector('.empty')`);
  await new Promise((r) => setTimeout(r, 350));

  // BATON_THEME forces the appearance so both themes can be captured without
  // changing the machine's System Settings.
  if (process.env['BATON_THEME']) {
    const { nativeTheme } = await import('electron');
    nativeTheme.themeSource = process.env['BATON_THEME'] as 'dark' | 'light';
    await new Promise((r) => setTimeout(r, 400));
  }

  const shot = process.env['BATON_SHOT'];
  if (shot) {
    await writeFile(shot, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${shot}`);
  }

  const result: Record<string, unknown> = {
    rendererMounted: await read(win, `document.querySelector('#root')?.children.length > 0`),
    preloadApi: await read(win, `typeof window.baton?.refresh`),
    wordmark: await read(win, `document.querySelector('.wordmark')?.textContent ?? ''`),
    emptyState: await read(win, `document.querySelector('.empty h1')?.textContent ?? ''`),
    rail: await read(
      win,
      `Array.from(document.querySelectorAll('.rail-item')).map(e => e.getAttribute('aria-label')).join(' | ')`
    ),
    activeView: await read(
      win,
      `document.querySelector('.rail-item[aria-current]')?.getAttribute('aria-label') ?? ''`
    ),
    heading: await read(win, `document.querySelector('.queue-head h1')?.textContent ?? ''`),
    groupHead: await read(win, `document.querySelector('.group-head')?.textContent ?? ''`),
    rowCount: await read(win, `document.querySelectorAll('.row').length`),
    blockedRows: await read(win, `document.querySelectorAll('.row.blocked').length`),
    firstRow: await read(
      win,
      `(() => { const r = document.querySelector('.row'); return r ? {
        num: r.querySelector('.row-num')?.textContent,
        title: r.querySelector('.row-title')?.textContent,
        state: r.querySelector('.row-state')?.textContent
      } : null; })()`
    ),
    // Fonts are bundled; if they failed to load the whole design reads wrong.
    fonts: await read(
      win,
      `(() => { const s = getComputedStyle(document.querySelector('.wordmark') || document.body);
        return { display: s.fontFamily, loaded: document.fonts.status }; })()`
    ),
    connected: poller.current().connected,
    live: {
      viewer: poller.current().viewer,
      blocked: poller.current().blocked.length,
      mine: poller.current().mine.length,
      tickets: poller.current().tickets.length,
      errors: poller.current().errors
    },
    userData: app.getPath('userData')
  };

  // Open the first row and read the detail pane that appears.
  await read(win, `document.querySelector('.row')?.click()`);
  await until(win, `document.querySelector('.detail-head h2')`, 15_000);
  await until(win, `!document.querySelector('.pane .quiet')`, 15_000);
  result['detail'] = await read(
    win,
    `({
      heading: document.querySelector('.detail-head h2')?.textContent ?? '',
      meta: document.querySelector('.detail-meta')?.textContent ?? '',
      states: document.querySelector('.detail-states')?.textContent ?? '',
      runButtons: Array.from(document.querySelectorAll('.run-buttons button')).map(b => b.textContent),
      sections: Array.from(document.querySelectorAll('.detail h3')).map(h => h.textContent),
      error: document.querySelector('.detail .error')?.textContent ?? ''
    })`
  );

  if (process.env['BATON_SHOT_DETAIL']) {
    await writeFile(
      process.env['BATON_SHOT_DETAIL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_DETAIL']}`);
  }

  return result;
}
