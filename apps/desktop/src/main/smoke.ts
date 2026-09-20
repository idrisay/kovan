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
import { readFile, writeFile } from 'node:fs/promises';
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
 * over IPC, and a fixed delay passes on a warm cache and fails on a cold one —
 * the exact flakiness that once sent me chasing a phantom view-state bug.
 *
 * It edits and saves a real file, so BATON_WS_FOLDER must point at a scratch
 * clone, never at a working repository.
 */
async function driveWorkspace(win: BrowserWindow): Promise<Record<string, unknown>> {
  const click = (selector: string) =>
    read(win, `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (e) { e.click(); return true; } return false; })()`);

  await read(win, `document.querySelector('.rail-item[aria-label="Workspace"]')?.click()`);
  await until(win, `document.querySelector('.explorer')`);

  if (!(await until(win, `document.querySelector('.repo')`, 30_000))) {
    return {
      reached: false,
      explorer: await read(win, `document.querySelector('.explorer .queue-list')?.textContent ?? ''`)
    };
  }
  // Statuses arrive after the repo list; wait rather than race.
  await until(win, `!document.querySelector('.repo-pill.quiet-pill')?.textContent?.includes('\u00b7')`, 30_000);

  const summary: Record<string, unknown> = {
    reached: true,
    repoCount: await read(win, `document.querySelectorAll('.repo').length`),
    repoCountLabel: await read(win, `document.querySelector('.ws-repo-count')?.textContent ?? ''`),
    repos: await read(
      win,
      `Array.from(document.querySelectorAll('.repo')).map(r => ({
         name: r.querySelector('.repo-name')?.textContent,
         branch: r.querySelector('.repo-branch')?.textContent,
         pill: r.querySelector('.repo-pill')?.textContent
       }))`
    ),
    segments: await read(
      win,
      `Array.from(document.querySelectorAll('.seg')).map(s => s.textContent.trim())`
    )
  };

  // --- Expand a repo, then a folder, and check the tree grows -------------
  await click('.repo-main');
  await until(win, `document.querySelector('.tree-row')`, 20_000);
  const topRows = await read(win, `document.querySelectorAll('.tree-row').length`);

  await read(
    win,
    `(() => { const d = Array.from(document.querySelectorAll('.tree-row'))
       .find(r => r.getAttribute('aria-expanded') === 'false');
       if (d) d.click(); })()`
  );
  await until(win, `document.querySelectorAll('.tree-row').length > ${topRows}`, 20_000);

  summary['tree'] = {
    topRows,
    afterExpand: await read(win, `document.querySelectorAll('.tree-row').length`),
    indentGuides: await read(win, `document.querySelectorAll('.tree-children').length`),
    dirtyDots: await read(win, `document.querySelectorAll('.tree-dot').length`),
    marked: await read(win, `document.querySelectorAll('.tree-row.changed').length`)
  };

  // --- Collapse all: back to the bare repo list ---------------------------
  const deepRows = await read(win, `document.querySelectorAll('.tree-row').length`);
  await click('.icon-button.boxed');
  await until(win, `document.querySelectorAll('.tree-row').length === 0`, 10_000);
  summary['collapseAll'] = {
    rowsBefore: deepRows,
    treeRowsAfter: await read(win, `document.querySelectorAll('.tree-row').length`),
    reposStillVisible: await read(win, `document.querySelectorAll('.repo').length`),
    buttonDisabled: await read(win, `document.querySelector('.icon-button.boxed')?.disabled`)
  };

  if (process.env['BATON_SHOT_REPOS']) {
    await writeFile(process.env['BATON_SHOT_REPOS'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['BATON_SHOT_REPOS']}`);
  }

  // --- Changes tab --------------------------------------------------------
  await read(
    win,
    `Array.from(document.querySelectorAll('.seg')).find(s => s.textContent.includes('Changes'))?.click()`
  );
  await until(win, `document.querySelector('.repo')`, 10_000);
  await click('.repo-main');
  await until(win, `document.querySelector('.change') || document.querySelector('.tree-note.clean')`, 20_000);
  summary['changes'] = {
    groups: await read(
      win,
      `Array.from(document.querySelectorAll('.change-group')).map(g => g.textContent.trim())`
    ),
    rows: await read(win, `document.querySelectorAll('.change').length`)
  };

  if (await click('.change')) {
    await until(win, `document.querySelector('.hunk') || document.querySelector('.diff .quiet')`, 20_000);
    summary['diff'] = await read(
      win,
      `({
        tabs: document.querySelectorAll('.tab').length,
        side: document.querySelector('.diff-side')?.textContent ?? '',
        adds: document.querySelector('.diff-head .adds')?.textContent ?? '',
        hunks: document.querySelectorAll('.hunk').length,
        addLines: document.querySelectorAll('tr.diff-add').length,
        highlighted: document.querySelectorAll('.diff [class^="tok-"]').length
      })`
    );
    if (process.env['BATON_SHOT_DIFF']) {
      await writeFile(process.env['BATON_SHOT_DIFF'], (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${process.env['BATON_SHOT_DIFF']}`);
    }
  }

  // --- Files tab: open a source file in the editor -------------------------
  await read(
    win,
    `Array.from(document.querySelectorAll('.seg')).find(s => s.textContent.trim() === 'Files')?.click()`
  );
  await until(win, `document.querySelector('.tree-row')`, 20_000);
  const opened = await read(
    win,
    `(() => {
       const rows = Array.from(document.querySelectorAll('.tree-row'));
       // The row's textContent carries the status letter too ("README.mdM"),
       // so match the name element, not the row.
       const file = rows.find(r => !r.hasAttribute('aria-expanded')
         && /\\.(ts|tsx|py|js|md)$/.test(r.querySelector('.tree-name')?.textContent || ''));
       if (file) { file.click(); return file.querySelector('.tree-name').textContent; }
       return null;
     })()`
  );

  if (!opened) {
    summary['editor'] = { opened: null };
    return summary;
  }

  await until(win, `document.querySelector('.cm-content')`, 20_000);
  summary['editor'] = await read(
    win,
    `({
      opened: ${JSON.stringify(opened)},
      lines: document.querySelectorAll('.cm-line').length,
      gutter: document.querySelectorAll('.cm-gutterElement').length > 0,
      highlighted: document.querySelectorAll('.cm-content [class^="tok-"]').length,
      language: document.querySelector('.status-bar span:nth-child(2)')?.textContent ?? '',
      status: document.querySelector('.status-bar')?.textContent ?? ''
    })`
  );

  // --- Type, then save ------------------------------------------------------
  // `.click()` does not focus a contenteditable, so insertText would go
  // nowhere and every assertion below would pass for the wrong reason.
  win.webContents.focus();
  await read(win, `document.querySelector('.cm-content')?.focus()`);
  const focused = await read(win, `document.activeElement?.className ?? ''`);

  const before = await read(win, `document.querySelector('.cm-content')?.textContent ?? ''`);
  win.webContents.insertText('BATON_SMOKE_EDIT');
  const wentDirty = await until(win, `document.querySelector('.tab-dirty')`, 10_000);

  let savedViaKeyboard = false;
  let onDisk = '';
  if (wentDirty) {
    // ⌘S, the way a person saves — not the button, which is the easy path.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: ['cmd'] });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 's', modifiers: ['cmd'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: ['cmd'] });
    savedViaKeyboard = await until(win, `!document.querySelector('.tab-dirty')`, 10_000);

    // The assertion that actually matters: the bytes reached the disk.
    const file = process.env['BATON_EDIT_CHECK'];
    if (file) {
      onDisk = await readFile(file, 'utf8').catch(() => '<unreadable>');
    }
  }

  summary['editing'] = {
    focused,
    textChanged: (await read(win, `document.querySelector('.cm-content')?.textContent ?? ''`)) !== before,
    wentDirty,
    savedViaKeyboard,
    editOnDisk: onDisk ? onDisk.includes('BATON_SMOKE_EDIT') : 'not checked',
    conflictShown: await read(win, `Boolean(document.querySelector('.conflict'))`)
  };

  // --- The conflict path ----------------------------------------------------
  // An agent writing the same file while you type is the expected collision,
  // not an exotic one, so it is worth a real test rather than a hand-check:
  // change the file behind the editor's back, type, save, and assert the save
  // was refused rather than silently clobbering.
  const edited = process.env['BATON_EDIT_CHECK'];
  if (wentDirty && edited) {
    const theirs = `changed by something else at ${Date.now()}\n`;
    await writeFile(edited, theirs, 'utf8');

    await read(win, `document.querySelector('.cm-content')?.focus()`);
    win.webContents.insertText('MINE');
    await until(win, `document.querySelector('.tab-dirty')`, 10_000);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: ['cmd'] });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 's', modifiers: ['cmd'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: ['cmd'] });

    const warned = await until(win, `document.querySelector('.conflict')`, 10_000);
    summary['conflict'] = {
      bannerShown: warned,
      buttons: await read(
        win,
        `Array.from(document.querySelectorAll('.conflict button')).map(b => b.textContent)`
      ),
      // The point of the whole mechanism: their bytes are still on disk.
      theirWorkSurvived: (await readFile(edited, 'utf8')) === theirs,
      stillDirty: await read(win, `Boolean(document.querySelector('.tab-dirty'))`)
    };

    if (process.env['BATON_SHOT_CONFLICT']) {
      await writeFile(
        process.env['BATON_SHOT_CONFLICT'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_CONFLICT']}`);
    }
  }

  if (process.env['BATON_SHOT_WS']) {
    await writeFile(process.env['BATON_SHOT_WS'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['BATON_SHOT_WS']}`);
  }

  return summary;
}
