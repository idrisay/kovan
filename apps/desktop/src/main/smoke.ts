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
import { existsSync } from 'node:fs';
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

/** One open pull request per section, so all four headers have something in them. */
const OPEN_PULLS = [
  {
    ...FIXTURE,
    number: 118,
    title: 'Cache the pricing table between requests',
    repo: 'acme/web',
    author: 'idrisay',
    mergeable: 'mergeable' as const,
    reviewDecision: 'review_required' as const,
    checks: 'success' as const,
    unresolvedThreads: 0,
    updatedAt: new Date(Date.now() - 18_000_000).toISOString()
  },
  {
    ...FIXTURE,
    number: 119,
    title: 'Spike: replace the retry queue with a worker',
    repo: 'acme/web',
    author: 'idrisay',
    isDraft: true,
    mergeable: 'mergeable' as const,
    reviewDecision: 'none' as const,
    checks: 'pending' as const,
    unresolvedThreads: 0,
    updatedAt: new Date(Date.now() - 250_000_000).toISOString()
  },
  {
    // A draft that also cannot merge: the case the "N blocked" note on a
    // folded section exists for.
    ...FIXTURE,
    number: 120,
    title: 'Draft: split the checkout reducer',
    repo: 'acme/web',
    author: 'idrisay',
    isDraft: true,
    mergeable: 'conflicting' as const,
    reviewDecision: 'none' as const,
    checks: 'success' as const,
    unresolvedThreads: 0,
    updatedAt: new Date(Date.now() - 400_000_000).toISOString()
  }
];

/** More merged pull requests than one page, so "Show more" has work to do. */
const MERGED_TOTAL = 34;

const MERGED_TITLES = [
  'Ship the persistent table scrollbar',
  'Drop the unused Stripe webhook handler',
  'Move the session cookie to SameSite=Lax',
  'Bump the node image to 20.18',
  'Fix the off-by-one in the invoice paginator',
  'Add a health endpoint the load balancer can read',
  'Retry FedEx rate calls once before failing',
  'Stop logging the full request body on 500s',
  'Teach the importer about quoted CSV headers',
  'Collapse the two nearly identical row components',
  'Make the cron lock actually expire',
  'Trim 400ms off the cold start'
];

/**
 * A page of merged pull requests.
 *
 * Generated from `count` rather than a fixed list so "Show more" can be driven
 * for real: the handler answers the limit it was asked for, exactly as the
 * live one re-asks GitHub for a wider window.
 */
export function mergedFixture(count: number) {
  return Array.from({ length: Math.min(count, MERGED_TOTAL) }, (_, i) => ({
    ...FIXTURE,
    number: 300 - i,
    title: MERGED_TITLES[i % MERGED_TITLES.length] ?? `Merged change ${i + 1}`,
    repo: i % 3 === 0 ? 'acme/api' : 'acme/web',
    author: 'idrisay',
    isDraft: false,
    mergeable: 'mergeable' as const,
    reviewDecision: 'approved' as const,
    checks: 'success' as const,
    unresolvedThreads: 0,
    updatedAt: new Date(Date.now() - (i + 1) * 43_200_000).toISOString(),
    mergedAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString()
  }));
}

/**
 * The whole seeded snapshot, as a function of how far the merged window has
 * been opened. Both the seeder and the "show more" handler build from this, so
 * pressing the footer goes through the real IPC round trip instead of the
 * smoke quietly pushing a bigger list at the renderer.
 */
export function fixtureSnapshot(mergedCount: number) {
  return {
    at: Date.now(),
    viewer: 'idrisay',
    blocked: [FIXTURE],
    mine: [FIXTURE, ...OPEN_PULLS],
    reviewRequested: [],
    merged: mergedFixture(mergedCount),
    mergedTotal: MERGED_TOTAL,
    loadingMerged: false,
    tickets: [TICKET],
    connected: ['github' as const],
    errors: [],
    refreshing: false
  };
}

/** A ticket with both halves of the split: prose to read, subtasks to scan. */
const TICKET = {
  key: 'ACME-2393',
  summary: 'Make cut-off tables scroll and reveal check-in row actions on hover',
  url: 'https://example.invalid/browse/ACME-2393',
  status: 'In Progress',
  statusCategory: 'indeterminate' as const,
  issueType: 'Bug',
  priority: 'High',
  updated: new Date(Date.now() - 172_800_000).toISOString(),
  description: [
    'Tables wider than their container are silently cut off on tablet and',
    'mobile: no scrollbar appears, and the right-hand columns cannot be',
    'reached at all.',
    '',
    'Second round of QA after the August fix. See the linked PR for the',
    'root cause — a block-level wrapper that can never be wider than its',
    'own scroll container.'
  ].join('\n'),
  subtasks: [
    { key: 'ACME-2401', summary: 'Persistent scrollbar styling', status: 'Done', url: 'https://example.invalid/browse/ACME-2401' },
    { key: 'ACME-2402', summary: 'Row actions on hover and focus', status: 'In Review', url: 'https://example.invalid/browse/ACME-2402' },
    { key: 'ACME-2403', summary: 'Touch fallback above 1000px', status: 'To Do', url: 'https://example.invalid/browse/ACME-2403' }
  ],
  comments: [
    {
      author: 'qa',
      created: new Date(Date.now() - 90_000_000).toISOString(),
      body: 'Re-tested on iPad landscape. The scrollbar is there now, but **Mark Reviewed** still cannot be tapped.'
    }
  ]
};

/**
 * A pull request detail rich enough to judge the layout by: a long body with a
 * table and a code block, checks, threads and a file list. Served instead of
 * the network only when BATON_USER_DATA is also set, so it can never reach a
 * real profile.
 */
export function detailFixture(repo: string, number: number) {
  return {
    number,
    repo,
    title: FIXTURE.title,
    url: FIXTURE.url,
    body: [
      '## Tablet and mobile QA, second round',
      '',
      'The first round shipped in August and QA re-tested 75 minutes after the',
      'merge. The overlaps are still reproducible, plus a new ask: **the scrollbar',
      'should be there whenever a table is cut off, not only on hover.**',
      '',
      '### The actual bug behind "still reproducible"',
      '',
      'Both question tables wrapped their grid like this:',
      '',
      '```html',
      '<div class="overflow-x-auto">          <- scroll container',
      '  <div class="min-w-full overflow-hidden">   <- rounded-corner box',
      '    <div class="grid grid-cols-[...fixed px...]">  <- ~765px of fixed columns',
      '```',
      '',
      'The middle box is block-level, so it is *exactly* as wide as the scroll',
      'container and never wider. The fixed columns therefore overflowed it, were',
      'clipped by its own `overflow-hidden`, and the scroll container never saw',
      'any overflow at all — so no scrollbar appeared.',
      '',
      '### Changes',
      '',
      '| Area | Change |',
      '| --- | --- |',
      '| `globals.css` | New `.table-scroll-x`: horizontal scroll with a persistent styled bar (11px thumb, radius 1000px, `#f9f9fa` track — per Figma) |',
      '| `tailwind.config.ts` | New `hover-wide` screen: `(hover: hover) and (min-width: 1001px)` |',
      '| Question tables | `min-w-full` → `min-w-[860px]` / `min-w-[800px]`; header padding aligned to rows |',
      '| Learning path tables | `min-w-max` → definite floors (840/920, 1000/880) |',
      '| LP performance header | Title capped at 2 lines with ellipsis + `title` attribute |',
      '| Check-in card | Row actions reveal on hover/focus; `StudentRow` extracted so each row owns its state |',
      '',
      '### Why `hover-wide` rather than a plain width breakpoint',
      '',
      'Gating the hover-reveal on width alone strands touch devices over 1000px',
      '(iPad in landscape, touch laptops): with no hover to trigger the reveal, a',
      'tap on the faded button falls straight through to the row\'s stretched link',
      'and navigates away, so **Mark Reviewed can never be reached there**.'
    ].join('\n'),
    baseRef: 'develop',
    headRef: 'fix/ACME-2393-tablet-mobile-qa-round2',
    additions: 214,
    deletions: 63,
    changedFiles: 7,
    checks: [
      { name: 'build', status: 'failure' as const, url: 'https://example.invalid/checks/1' },
      { name: 'lint', status: 'success' as const, url: 'https://example.invalid/checks/2' },
      { name: 'unit (node 20)', status: 'success' as const, url: 'https://example.invalid/checks/3' },
      { name: 'visual regression', status: 'pending' as const, url: 'https://example.invalid/checks/4' }
    ],
    files: [
      { path: 'src/styles/globals.css', additions: 41, deletions: 2 },
      { path: 'tailwind.config.ts', additions: 6, deletions: 0 },
      { path: 'src/components/QuestionTable.tsx', additions: 58, deletions: 19 },
      { path: 'src/components/LearningPathTable.tsx', additions: 44, deletions: 21 },
      { path: 'src/components/StudentRow.tsx', additions: 52, deletions: 0 },
      { path: 'src/components/CheckInCard.tsx', additions: 9, deletions: 18 },
      { path: 'src/hooks/useRowActionsHover.ts', additions: 4, deletions: 3 }
    ],
    threads: [
      {
        id: 't1',
        isResolved: false,
        path: 'src/components/QuestionTable.tsx',
        line: 118,
        comments: [
          {
            author: 'reviewer',
            createdAt: new Date(Date.now() - 7_200_000).toISOString(),
            body: 'Can the `860px` floor come from the column definitions instead of a literal? It will drift the next time a column is added.'
          },
          {
            author: 'idrisay',
            createdAt: new Date(Date.now() - 5_400_000).toISOString(),
            body: 'It can, but the grid template is built at render time and the floor is needed before layout. I left a comment pointing at the two places to keep in step.'
          }
        ]
      }
    ]
  };
}

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
    win.webContents.send('baton:snapshot', fixtureSnapshot(10));
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

  // --- The sections, and the merged accordion ------------------------------
  if (mode === 'seeded') {
    const heads = () =>
      read(
        win,
        `Array.from(document.querySelectorAll('.group-head')).map(h => ({
           label: h.querySelector('.group-label')?.textContent ?? '',
           count: h.querySelector('.count')?.textContent ?? '',
           note: h.querySelector('.group-note')?.textContent ?? null,
           open: h.getAttribute('aria-expanded') === 'true',
           tint: h.classList.contains('tint'),
           // The rule between the words and the count is what lines the
           // headers up; if it collapsed to nothing the design is not there.
           rule: Math.round(h.querySelector('.group-rule')?.getBoundingClientRect().width ?? 0)
         }))`
      );

    const clickHead = (label: string) =>
      read(
        win,
        `(() => {
           const h = Array.from(document.querySelectorAll('.group-head'))
             .find(h => h.querySelector('.group-label')?.textContent === ${JSON.stringify(label)});
           if (!h) return false;
           h.click();
           return true;
         })()`
      );

    const rowCount = () => read(win, `document.querySelectorAll('.row').length`);

    const before = (await rowCount()) as number;
    const sections = await heads();

    // Fold the noisiest section and check its rows actually leave the DOM.
    await clickHead('Open');
    await new Promise((r) => setTimeout(r, 120));
    const folded = await rowCount();
    await clickHead('Open');
    await new Promise((r) => setTimeout(r, 120));

    // Merged starts folded, so unfolding it is what puts the window on screen.
    await clickHead('Recently merged');
    await until(win, `document.querySelector('.more')`, 5_000);
    const mergedRows = () =>
      read(win, `document.querySelectorAll('.row.shipped').length`);
    const firstPage = (await mergedRows()) as number;
    const footer = await read(win, `document.querySelector('.more')?.textContent ?? ''`);

    await read(win, `document.querySelector('.more')?.click()`);
    await until(win, `document.querySelectorAll('.row.shipped').length > ${firstPage}`, 10_000);

    result['sections'] = {
      rowsBefore: before,
      sections,
      // Headers all terminate on one vertical line, so the rules differ.
      rulesVary: Array.isArray(sections) && new Set(
        (sections as { rule: number }[]).map((s) => s.rule)
      ).size > 1,
      rowsWithOpenFolded: folded,
      foldRemovedRows: typeof folded === 'number' && folded < before
    };

    result['merged'] = {
      firstPage,
      footer,
      afterShowMore: await mergedRows(),
      footerAfter: await read(win, `document.querySelector('.more')?.textContent ?? ''`),
      // One line, dated by when it shipped. The second line is dropped on
      // purpose: it would say "Merged" under a header that just did.
      firstRow: await read(
        win,
        `(() => { const r = document.querySelector('.row.shipped'); return r ? {
           title: r.querySelector('.row-title')?.textContent,
           age: r.querySelector('.row-age')?.textContent,
           secondLine: Boolean(r.querySelector('.row-state')),
           height: Math.round(r.getBoundingClientRect().height)
         } : null; })()`
      ),
      // And the working rows above it keep theirs.
      workingRowHeight: await read(
        win,
        `Math.round(document.querySelector('.row:not(.shipped)')?.getBoundingClientRect().height ?? 0)`
      )
    };

    // A merged pull request opens like any other, but there is only one thing
    // left to do with it.
    await read(win, `document.querySelector('.row.shipped')?.click()`);
    await until(win, `document.querySelector('.detail-head h2')`, 15_000);
    await until(win, `!document.querySelector('.pane .quiet')`, 15_000);
    result['mergedDetail'] = await read(
      win,
      `({
        heading: document.querySelector('.detail-head h2')?.textContent ?? '',
        meta: document.querySelector('.detail-meta')?.textContent ?? '',
        states: document.querySelector('.detail-states')?.textContent ?? '',
        actions: Array.from(document.querySelectorAll('.detail-actions button'))
          .map(b => b.textContent)
      })`
    );

    // And that the one button actually reaches an agent: the sheet has to
    // open with a verify prompt in it, or "Check it shipped" is decoration.
    await read(
      win,
      `(() => {
         const b = Array.from(document.querySelectorAll('.detail-actions button'))
           .find(b => b.textContent.includes('Check it shipped'));
         if (b) b.click();
         return Boolean(b);
       })()`
    );
    const sheetOpened = await until(win, `document.querySelector('.sheet')`, 10_000);
    // Runner discovery asks a login shell what is on the PATH, which takes
    // about a second and a half. Reading the selects before it answers gets
    // two empty ones and says nothing about whether the roster works.
    const rosterFilled = await until(
      win,
      `document.querySelector('.run-controls select')?.options.length > 0`,
      15_000
    );
    result['verifySheet'] = {
      opened: sheetOpened,
      rosterFilled,
      subject: await read(win, `document.querySelector('.sheet .subject')?.textContent ?? ''`),
      runners: await read(
        win,
        `Array.from(document.querySelectorAll('.run-controls select')).map(s => s.options.length)`
      ),
      // The prompt is what the agent is actually handed.
      promptBytes: await read(win, `document.querySelector('.sheet textarea')?.value.length ?? 0`),
      promptHead: await read(
        win,
        `(document.querySelector('.sheet textarea')?.value ?? '')
           .split(String.fromCharCode(10))[0]`
      ),
      // The prompt the agent is actually handed: no placeholder may survive
      // into it. Four of them used to.
      unfilledPlaceholders: await read(
        win,
        `((document.querySelector('.sheet textarea')?.value ?? '')
           .match(/\\$\\{\\w+\\}/g) ?? []).join(',')`
      ),
      mentionsThePull: await read(
        win,
        `(document.querySelector('.sheet textarea')?.value ?? '').includes('300')`
      ),
      // Disabled without a working directory, which this throwaway profile has
      // none of. That is the correct answer, not a broken button — an agent
      // started in the wrong directory is worse than one not started.
      startEnabled: await read(
        win,
        `!document.querySelector('.sheet-foot .primary')?.disabled`
      ),
      cwd: await read(
        win,
        `document.querySelectorAll('.run-controls select')[1]?.value ?? ''`
      )
    };
    await read(win, `document.querySelector('.sheet-head .ghost')?.click()`);
    await new Promise((r) => setTimeout(r, 120));

    if (process.env['BATON_SHOT_MERGED']) {
      await writeFile(
        process.env['BATON_SHOT_MERGED'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_MERGED']}`);
    }

    if (process.env['BATON_SHOT_SECTIONS']) {
      await writeFile(
        process.env['BATON_SHOT_SECTIONS'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_SECTIONS']}`);
    }

    // Leave it folded again so the detail steps below start from a known list.
    await clickHead('Recently merged');
  }

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

  // --- The two-column detail --------------------------------------------
  // The container query keys off the pane, not the window, because the sidebar
  // is draggable — so this drags the sidebar and checks the layout answers.
  const layout = () =>
    read(
      win,
      `(() => {
         const round = (n) => Math.round(n);
         const pane = document.querySelector('.pane').getBoundingClientRect();
         const main = document.querySelector('.detail-main')?.getBoundingClientRect();
         const side = document.querySelector('.detail-side')?.getBoundingClientRect();
         const table = document.querySelector('.prose > table')?.getBoundingClientRect();
         const para = document.querySelector('.prose > p')?.getBoundingClientRect();
         return {
           pane: round(pane.width),
           main: main ? round(main.width) : null,
           side: side ? round(side.width) : null,
           // Side by side, not stacked, when there is room for two columns.
           sideBySide: Boolean(main && side && side.left >= main.right - 1),
           // The rail should end at the content's right edge, not float mid-pane.
           sideAtRightEdge: side ? round(pane.right - side.right) : null,
           sticky: side
             ? getComputedStyle(document.querySelector('.detail-side')).position
             : null,
           paragraph: para ? round(para.width) : null,
           table: table ? round(table.width) : null
         };
       })()`
    );

  // A wide window, because the two-column layout is the thing under test and
  // the smoke's default window is narrower than the threshold. Clamped to the
  // display, so this does not silently do nothing on a small screen.
  const { screen } = await import('electron');
  const work = screen.getPrimaryDisplay().workAreaSize;
  win.setBounds({
    x: 0, y: 0,
    width: Math.min(1800, work.width),
    height: Math.min(1150, work.height)
  });
  await new Promise((r) => setTimeout(r, 250));

  result['layoutWide'] = await layout();

  if (process.env['BATON_SHOT_DETAIL']) {
    await writeFile(
      process.env['BATON_SHOT_DETAIL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_DETAIL']}`);
  }

  // The screen this runs on tops out around 1500 logical pixels, and the
  // layout has to hold on a 2500px monitor too. Zooming out multiplies CSS
  // pixels without needing the hardware: the page sees a 2500px viewport.
  await win.webContents.setZoomFactor(0.6);
  await new Promise((r) => setTimeout(r, 250));
  result['layoutUltra'] = await layout();

  if (process.env['BATON_SHOT_ULTRA']) {
    await writeFile(
      process.env['BATON_SHOT_ULTRA'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_ULTRA']}`);
  }
  await win.webContents.setZoomFactor(1);
  await new Promise((r) => setTimeout(r, 200));

  // Squeeze the pane by widening the sidebar, and check it collapses to one
  // column rather than crushing both.
  await read(win, `document.documentElement.style.setProperty('--queue-w', '620px')`);
  await new Promise((r) => setTimeout(r, 200));
  result['layoutNarrow'] = await layout();

  if (process.env['BATON_SHOT_NARROW']) {
    await writeFile(
      process.env['BATON_SHOT_NARROW'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_NARROW']}`);
  }
  await read(win, `document.documentElement.style.removeProperty('--queue-w')`);

  // The ticket pane got the same two-column treatment, so it gets the same
  // measurement rather than a shrug that it typechecks.
  await read(win, `document.querySelector('.rail-item[aria-label="Tickets"]')?.click()`);
  await until(win, `document.querySelector('.row')`, 10_000);
  await read(win, `document.querySelector('.row')?.click()`);
  await until(win, `document.querySelector('.detail-head h2')`, 10_000);
  result['ticket'] = {
    heading: await read(win, `document.querySelector('.detail-head h2')?.textContent ?? ''`),
    actions: await read(
      win,
      `Array.from(document.querySelectorAll('.detail-actions button')).map(b => b.textContent)`
    ),
    main: await read(
      win,
      `Array.from(document.querySelectorAll('.detail-main h3')).map(h => h.textContent)`
    ),
    side: await read(
      win,
      `Array.from(document.querySelectorAll('.detail-side h3')).map(h => h.textContent)`
    ),
    layout: await layout()
  };

  if (process.env['BATON_SHOT_TICKET']) {
    await writeFile(
      process.env['BATON_SHOT_TICKET'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_TICKET']}`);
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

  if (!(await until(win, `document.querySelector('.ws-row')`, 30_000))) {
    return {
      reached: false,
      explorer: await read(win, `document.querySelector('.explorer .queue-list')?.textContent ?? ''`)
    };
  }
  // Statuses arrive after the repo list; wait rather than race.
  await until(win, `!document.querySelector('.repo-pill.quiet-pill')?.textContent?.includes('\u00b7')`, 30_000);

  await until(win, `document.querySelector('.repo')`, 30_000);
  const summary: Record<string, unknown> = {
    reached: true,
    workspaceRow: await read(
      win,
      `(() => { const r = document.querySelector('.ws-row'); return r ? {
         title: r.querySelector('.ws-title')?.textContent,
         kind: r.querySelector('.ws-kind')?.textContent,
         folders: r.querySelector('.ws-folders')?.textContent,
         actions: Array.from(r.querySelectorAll('.icon-button')).map(b => b.getAttribute('aria-label'))
       } : null; })()`
    ),
    // The dropdown is gone; every folder is visible at once instead.
    pickerGone: !(await read(win, `Boolean(document.querySelector('.ws-picker'))`)),
    removeButtons: await read(win, `document.querySelectorAll('.icon-button.remove').length`),
    repoCount: await read(win, `document.querySelectorAll('.repo').length`),
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
    buttonDisabled: await read(win, `document.querySelector('.icon-button.boxed')?.disabled`),
    // Every repo row must agree that it is shut — a chevron still pointing
    // down after Collapse all would be the control lying about the state.
    anyStillExpanded: await read(
      win,
      `Array.from(document.querySelectorAll('.repo-main'))
         .some(b => b.getAttribute('aria-expanded') === 'true')`
    ),
    chevronsRotated: await read(
      win,
      `Array.from(document.querySelectorAll('.repo-main svg'))
         .filter(s => (s.style.transform || '').includes('rotate')).length`
    )
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

  // --- Dragging the sidebar wider -------------------------------------------
  // Through the debugger protocol, not webContents.sendInputEvent. Measured
  // both ways here: sendInputEvent's moves arrive with pointerType '' and
  // never retarget to an element holding pointer capture, so the handle would
  // look broken when it is not. Input.dispatchMouseEvent produces a proper
  // mouse pointer (id 1, pointerType 'mouse') and capture works, which is
  // what a real drag does.
  {
    const handle = (await read(
      win,
      `(() => {
         const r = document.querySelector('.resizer')?.getBoundingClientRect();
         return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
       })()`
    )) as { x: number; y: number } | null;

    const widthOf = async () =>
      (await read(win, `document.querySelector('.queue').getBoundingClientRect().width`)) as number;
    const custom = () =>
      read(win, `document.documentElement.style.getPropertyValue('--queue-w') || null`);

    const startWidth = await widthOf();
    let attached = false;
    try {
      win.webContents.debugger.attach('1.3');
      attached = true;
    } catch (error) {
      summary['resize'] = { skipped: `debugger: ${(error as Error).message}` };
    }

    if (handle && attached) {
      const mouse = (type: string, x: number, y: number, buttons: number) =>
        win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse'
        });

      const drag = async (
        from: { x: number; y: number }, toX: number, hold?: () => Promise<void>
      ) => {
        await mouse('mousePressed', from.x, from.y, 1);
        // Several moves, not one jump: a handler that only works on the first
        // move, or that accumulates its delta instead of tracking the cursor,
        // passes a single-step drag and fails a real one.
        for (const x of [from.x + (toX - from.x) / 2, toX]) {
          await mouse('mouseMoved', Math.round(x), from.y, 1);
        }
        await new Promise((r) => setTimeout(r, 80));
        if (hold) await hold();                    // still held, for a shot
        await mouse('mouseReleased', toX, from.y, 0);
        await new Promise((r) => setTimeout(r, 80));
      };

      await drag(handle, handle.x + 140, async () => {
        summary['resizeDragging'] = await read(
          win,
          `Boolean(document.querySelector('.resizer.dragging')) &&
           document.body.classList.contains('resizing')`
        );
        if (process.env['BATON_SHOT_RESIZE']) {
          await writeFile(
            process.env['BATON_SHOT_RESIZE'],
            (await win.webContents.capturePage()).toPNG()
          );
          console.log(`shot: ${process.env['BATON_SHOT_RESIZE']}`);
        }
      });
      const widened = await widthOf();
      const stored = await read(win, `localStorage.getItem('baton.sidebar-width')`);

      // The handle travelled with the edge, so aim the next drag from there.
      const moved = { x: handle.x + 140, y: handle.y };
      await drag(moved, moved.x - 600);            // well past the floor
      const clamped = await widthOf();

      await read(
        win,
        `document.querySelector('.resizer')
           .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
      );
      await new Promise((r) => setTimeout(r, 80));

      summary['resize'] = {
        startWidth,
        widened,
        grewByExactly140: widened - startWidth === 140,
        clamped,
        stoppedAtFloor: clamped === 220,
        stored,
        // Double-click drops the override, so the stylesheet default is back.
        afterReset: await widthOf(),
        overrideCleared: (await custom()) === null,
        forgotten: (await read(win, `localStorage.getItem('baton.sidebar-width')`)) === null
      };
    } else if (attached) {
      summary['resize'] = { skipped: 'no .resizer in the DOM' };
    }

    if (attached) win.webContents.debugger.detach();
  }

  // --- The workspace menu, and removing a folder ----------------------------
  // Last, because removing a folder mutates the workspace everything above
  // was driving.
  await read(win, `document.querySelector('[aria-label="Workspace actions"]')?.click()`);
  await until(win, `document.querySelector('.menu')`, 5_000);
  summary['menu'] = await read(
    win,
    `Array.from(document.querySelectorAll('.menu button')).map(b => b.textContent.trim())`
  );

  if (process.env['BATON_SHOT_MENU']) {
    await writeFile(process.env['BATON_SHOT_MENU'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['BATON_SHOT_MENU']}`);
  }
  await read(win, `document.body.click()`);

  const reposBefore = await read(win, `document.querySelectorAll('.repo').length`);
  const removedName = await read(
    win,
    `(() => {
       const button = document.querySelector('.icon-button.remove');
       if (!button) return null;
       const name = button.closest('.repo')?.querySelector('.repo-name')?.textContent;
       button.click();
       return name;
     })()`
  );
  if (removedName) {
    await until(win, `document.querySelectorAll('.repo').length < ${reposBefore}`, 15_000);
  }
  summary['removeFolder'] = {
    removed: removedName,
    reposBefore,
    reposAfter: await read(win, `document.querySelectorAll('.repo').length`),
    folderLabel: await read(win, `document.querySelector('.ws-folders')?.textContent ?? ''`),
    // Removing a folder from a workspace must not touch the folder.
    stillOnDisk: removedName
      ? existsSync(`${process.env['BATON_WS_FOLDER']?.split(':')[0]}`)
      : 'not checked'
  };

  if (process.env['BATON_SHOT_WS']) {
    await writeFile(process.env['BATON_SHOT_WS'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['BATON_SHOT_WS']}`);
  }

  return summary;
}
