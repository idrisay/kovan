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
 *   `workspace`
 *            drives the explorer against a real clone: expands the tree, opens
 *            a source file, opens a diff, and reads back what rendered.
 *
 * `BATON_SHOT=<path>` also writes a PNG of the window.
 */

import { app, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { Agents } from './agents';
import type { Poller } from './poller';
import type { Sessions } from './sessions';

export type SmokeMode = '1' | 'seeded' | 'live' | 'pty' | 'workspace';

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
  if (mode === 'seeded' || mode === 'workspace') {
    // After the renderer has mounted, not before. `did-finish-load` fires when
    // the document is ready, but React subscribes to this channel in an
    // effect that runs later — a snapshot sent at load time arrives before
    // anyone is listening and is simply dropped, leaving the app on its empty
    // state with no rail to drive.
    await until(win, `document.querySelector('#root')?.children.length > 0`);
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
    await until(win, `document.querySelector('.rail')`);
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

  // Open the first row and read the detail pane that appears. Skipped for the
  // workspace mode: it runs on a throwaway profile with no GitHub token, so
  // the detail fetch can only fail, and it would burn two 15s waits doing it.
  if (mode === 'workspace') {
    result['workspace'] = await driveWorkspace(win);
    return result;
  }

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

/**
 * Drives the explorer the way a person would.
 *
 * Every step waits for the thing it needs rather than sleeping: the tree loads
 * over IPC, and a fixed delay here would pass on a warm cache and fail on a
 * cold one — the exact flakiness that sent me chasing a phantom view-state bug
 * last time.
 */
async function driveWorkspace(win: BrowserWindow): Promise<Record<string, unknown>> {
  const click = (selector: string) =>
    read(win, `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (e) { e.click(); return true; } return false; })()`);

  await read(win, `document.querySelector('.rail-item[aria-label="Workspace"]')?.click()`);
  await until(win, `document.querySelector('.explorer')`);

  const found = await until(win, `document.querySelector('.ws-root')`, 30_000);
  if (!found) {
    return {
      reached: false,
      explorer: await read(win, `document.querySelector('.explorer .queue-list')?.textContent ?? ''`)
    };
  }
  // The status arrives after the repo list; wait for it rather than racing it.
  await until(win, `!document.body.textContent.includes('Reading…')`, 30_000);

  const summary: Record<string, unknown> = {
    reached: true,
    repos: await read(
      win,
      `Array.from(document.querySelectorAll('.ws-name')).map(e => e.textContent)`
    ),
    branch: await read(win, `document.querySelector('.ws-branch')?.textContent ?? ''`),
    changeCount: await read(win, `document.querySelector('.ws-count')?.textContent ?? ''`),
    changeRows: await read(win, `document.querySelectorAll('.change').length`),
    firstChange: await read(
      win,
      `(() => { const c = document.querySelector('.change'); return c ? {
        mark: c.querySelector('.change-mark')?.textContent,
        name: c.querySelector('.change-name')?.textContent } : null; })()`
    ),
    treeRows: await read(win, `document.querySelectorAll('.tree-row').length`),
    markedInTree: await read(win, `document.querySelectorAll('.tree-row.changed').length`)
  };

  // --- A diff tab ---
  await click('.change');
  await until(win, `document.querySelector('.hunk') || document.querySelector('.diff .quiet')`, 20_000);
  summary['diff'] = await read(
    win,
    `({
      tabs: document.querySelectorAll('.tab').length,
      title: document.querySelector('.tab.active .tab-label span')?.textContent ?? '',
      side: document.querySelector('.diff-side')?.textContent ?? '',
      adds: document.querySelector('.diff-head .adds')?.textContent ?? '',
      dels: document.querySelector('.diff-head .dels')?.textContent ?? '',
      hunks: document.querySelectorAll('.hunk').length,
      addLines: document.querySelectorAll('tr.diff-add').length,
      delLines: document.querySelectorAll('tr.diff-del').length,
      highlighted: document.querySelectorAll('.diff .hljs-keyword, .diff .hljs-string').length,
      firstHunkHead: document.querySelector('.hunk-head')?.textContent ?? ''
    })`
  );

  if (process.env['BATON_SHOT_DIFF']) {
    await writeFile(process.env['BATON_SHOT_DIFF'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['BATON_SHOT_DIFF']}`);
  }

  // --- A file tab: expand the tree until a real source file appears ---
  const opened = await read(
    win,
    `(() => {
       const rows = Array.from(document.querySelectorAll('.tree-row'));
       const file = rows.find(r => /\.(ts|tsx|py|js|json|md|css)$/.test(r.textContent || '')
                                   && !r.querySelector('svg + svg'));
       if (file) { file.click(); return file.textContent; }
       return null;
     })()`
  );
  if (opened) {
    await until(win, `document.querySelector('.code-table')`, 20_000);
    summary['file'] = await read(
      win,
      `({
        opened: ${JSON.stringify(opened)},
        tabs: document.querySelectorAll('.tab').length,
        lines: document.querySelectorAll('.code-table tr').length,
        numbered: document.querySelector('.code-num')?.textContent ?? '',
        language: document.querySelector('.code-foot span')?.textContent ?? '',
        highlighted: document.querySelectorAll('.code .hljs-keyword, .code .hljs-string').length
      })`
    );
  } else {
    summary['file'] = { opened: null };
  }

  if (process.env['BATON_SHOT_WS']) {
    await writeFile(process.env['BATON_SHOT_WS'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['BATON_SHOT_WS']}`);
  }

  return summary;
}
