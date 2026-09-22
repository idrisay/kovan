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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Agents } from './agents';
import type { Poller, Snapshot } from './poller';
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

/** Someone else's pull request, waiting on the viewer's review. */
const REVIEW_PULL = {
  ...FIXTURE,
  number: 205,
  title: 'Split the invoice PDF generator out of the request path',
  repo: 'acme/billing',
  author: 'alice-dev',
  mergeable: 'mergeable' as const,
  reviewDecision: 'review_required' as const,
  checks: 'success' as const,
  unresolvedThreads: 0,
  viewerReviewed: false,
  updatedAt: new Date(Date.now() - 5_400_000).toISOString()
};

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
export function fixtureSnapshot(mergedCount: number): Snapshot {
  return {
    at: Date.now(),
    viewer: 'idrisay',
    blocked: [FIXTURE],
    mine: [FIXTURE, ...OPEN_PULLS],
    reviewRequested: [REVIEW_PULL],
    merged: mergedFixture(mergedCount),
    mergedTotal: MERGED_TOTAL,
    loadingMerged: false,
    tickets: [TICKET, TICKET_LOW, TICKET_HIGHEST],
    sentryIssues: [SENTRY_ISSUE],
    connected: ['github' as const, 'sentry' as const],
    errors: [],
    refreshing: false,
    refreshedAt: { github: Date.now() - 90_000 },
    refreshingProviders: []
  };
}

/** One issue, rich enough to judge the tab's layout by: a real-looking level,
 *  counts, and a culprit line. */
const SENTRY_ISSUE = {
  id: '99887766',
  shortId: 'WEB-1A2',
  title: 'TypeError: Cannot read properties of undefined (reading \'total\')',
  culprit: 'renderCheckoutSummary(checkout/summary.tsx)',
  level: 'error',
  count: 342,
  userCount: 58,
  permalink: 'https://example.invalid/organizations/acme/issues/99887766/',
  project: 'web-app',
  firstSeen: new Date(Date.now() - 2_592_000_000).toISOString(),
  lastSeen: new Date(Date.now() - 1_800_000).toISOString()
};

/**
 * The latest event's stack trace, outermost first — one dependency frame and
 * two in-app frames, one of which resolves to a path so the "resolved vs.
 * raw filename" distinction actually shows on screen.
 */
export function sentryFramesFixture(_issueId: string) {
  return [
    { filename: 'node_modules/react-dom/cjs/react-dom.production.js', function: 'commitRoot', lineNo: 12, inApp: false },
    { filename: 'checkout/summary.tsx', function: 'renderCheckoutSummary', lineNo: 41, resolvedPath: '/Users/idrisay/Desktop/coding/ikatia/app/baton/checkout/summary.tsx', inApp: true },
    { filename: 'checkout/total.ts', function: 'formatTotal', lineNo: 9, inApp: true }
  ];
}

/** Filing a ticket from a Sentry issue never actually reaches Jira in a
 *  throwaway smoke profile — same guard as `ticketFixture`. */
export function sentryTicketFixture() {
  return { key: 'ACME-9001', url: 'https://example.invalid/browse/ACME-9001' };
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
  assignee: 'alice-dev',
  updated: new Date(Date.now() - 172_800_000).toISOString(),
  description: [
    'Tables wider than their container are silently cut off on tablet and',
    'mobile: no scrollbar appears, and the right-hand columns cannot be',
    'reached at all.',
    '',
    'Second round of QA after the August fix. See the linked PR for the',
    'root cause — a block-level wrapper that can never be wider than its',
    'own scroll container.',
    '',
    '- [x] Reproduced on tablet and mobile',
    '- [x] Root cause identified',
    '- [ ] Fix verified on production'
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
  ],
  links: []
};

/**
 * Two more, older than `TICKET` so it stays the first row under the default
 * "recently updated" sort — but at opposite ends of the priority scale, so
 * switching to "Priority" visibly reorders the list rather than just adding
 * a label nobody can see move.
 */
const TICKET_LOW = {
  key: 'ACME-1000',
  summary: 'Tidy up the empty-state copy on the dashboard',
  url: 'https://example.invalid/browse/ACME-1000',
  status: 'To Do',
  statusCategory: 'new' as const,
  issueType: 'Task',
  priority: 'Low',
  updated: new Date(Date.now() - 200_000_000).toISOString(),
  description: '',
  subtasks: [],
  comments: [],
  links: []
};

const TICKET_HIGHEST = {
  key: 'ACME-2500',
  summary: 'Checkout throws a 500 on submit in production',
  url: 'https://example.invalid/browse/ACME-2500',
  status: 'In Progress',
  statusCategory: 'indeterminate' as const,
  issueType: 'Bug',
  priority: 'Highest',
  updated: new Date(Date.now() - 300_000_000).toISOString(),
  description: '',
  subtasks: [],
  comments: [],
  links: []
};

/**
 * The same ticket `getIssue` would return, attachments already resolved.
 * Served instead of the network only when `BATON_USER_DATA` is also set —
 * the same guard `detailFixture` uses — so it can never reach a real profile.
 */
export function ticketFixture(_key: string) {
  return TICKET;
}

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
    ],
    comments: [
      {
        author: 'pm',
        createdAt: new Date(Date.now() - 10_800_000).toISOString(),
        body: 'QA re-tested this on the staging tablet rig — flagged as the last blocker before the sprint review.'
      },
      {
        author: 'alice-dev',
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        body: 'Left one inline note on the width floor — otherwise happy with the approach.',
        reviewState: 'changes_requested' as const
      }
    ],
    reviewers: [
      { login: 'carol-dev', turn: 'pending' as const },
      { login: 'bob-dev', turn: 'pending' as const },
      {
        login: 'alice-dev',
        turn: 'changes_requested' as const,
        submittedAt: new Date(Date.now() - 86_400_000).toISOString()
      },
      {
        login: 'erin-dev',
        turn: 'approved' as const,
        submittedAt: new Date(Date.now() - 172_800_000).toISOString()
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

  // A second session, this time through the `line` path itself — the one
  // that used to type a command in on a fixed 250ms beat regardless of how
  // long the shell's own profile took to load, and could leave it sitting
  // typed but never submitted. `sessions.write()` above bypasses that path
  // entirely, so it could not have caught a regression there.
  const lineSession = await sessions.open({
    cwd: app.getPath('home'),
    title: 'smoke-line',
    runnerName: 'Shell',
    line: 'echo BATON_LINE_OK-$((3*4))'
  });
  let seenFromLine = '';
  sessions.onOutput(({ id, data }) => {
    if (id === lineSession.id) seenFromLine += data;
  });
  await new Promise((r) => setTimeout(r, 4500));

  // Item 23: a CLI agent that finishes its turn and sits waiting on you rings
  // the terminal bell, which is the one signal every one of them shares. Rung
  // through a real pty here rather than asserted against a fake chunk, since
  // the whole question is whether it survives the pty at all.
  sessions.write(session.id, "printf '\\a'\r");
  await new Promise((r) => setTimeout(r, 1500));
  const rang = sessions.list().find((s) => s.id === session.id)?.attention;
  // ...and typing back is what says you saw it.
  sessions.write(session.id, '\r');
  await new Promise((r) => setTimeout(r, 500));
  const afterReply = sessions.list().find((s) => s.id === session.id)?.attention;

  // Item 27: renaming is a label change and nothing else — `subject`, which
  // the row's click-through to a ticket goes by, must survive it.
  const subjectBefore = sessions.list().find((s) => s.id === lineSession.id)?.subject;
  sessions.rename(lineSession.id, 'renamed by smoke');
  const renamed = sessions.list().find((s) => s.id === lineSession.id);

  const prompt = agents.buildPrompt('unblock', { pull: FIXTURE });
  return {
    ptyOpened: Boolean(session.id),
    sawEcho: seen.includes('BATON_PTY_OK-42'),
    lineWasRun: seenFromLine.includes('BATON_LINE_OK-12'),
    bellSetsAttention: rang === true,
    replyClearsAttention: afterReply === false,
    renameSticks: renamed?.title === 'renamed by smoke',
    renameKeptSubject: renamed?.subject === subjectBefore,
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

  if (process.env['BATON_SHOT_PULL_FILTER']) {
    await read(win, `document.querySelector('[aria-label="Filter pull requests"]')?.click()`);
    await until(win, `document.querySelector('.filter-menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['BATON_SHOT_PULL_FILTER'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_PULL_FILTER']}`);
    await read(win, `document.body.click()`);
    await new Promise((r) => setTimeout(r, 100));
  }

  // --- Sorting pull requests — the icon used to do nothing at all -----------
  if (process.env['BATON_SHOT_PULL_SORT']) {
    // `read` only marshals JSON-able values across the bridge, so this reads
    // text content into a plain array rather than a live NodeList.
    const draftOrder = () =>
      read(
        win,
        `[...document.querySelectorAll('section')]
          .find(s => s.querySelector('.group-label')?.textContent === 'Drafts')
          ?.querySelectorAll('.row-num')
          ? Array.from([...document.querySelectorAll('section')]
              .find(s => s.querySelector('.group-label')?.textContent === 'Drafts')
              .querySelectorAll('.row-num'), n => n.textContent)
          : []`
      ) as Promise<string[]>;

    const beforeOrder = await draftOrder();

    await read(win, `document.querySelector('[aria-label="Sort pull requests"]')?.click()`);
    await until(win, `document.querySelector('.menu-host .menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['BATON_SHOT_PULL_SORT'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_PULL_SORT']}`);

    await read(
      win,
      `Array.from(document.querySelectorAll('.menu-host .menu button'))
        .find(b => b.textContent.includes('Least recently updated'))?.click()`
    );
    await new Promise((r) => setTimeout(r, 150));
    const afterOrder = await draftOrder();
    console.log(
      'pullSortReordered:',
      JSON.stringify({ beforeOrder, afterOrder, reversed: JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder) })
    );

    if (process.env['BATON_SHOT_PULL_SORTED']) {
      await writeFile(
        process.env['BATON_SHOT_PULL_SORTED'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_PULL_SORTED']}`);
    }
  }

  // --- Two run buttons of different weight on the same pull request ---------
  // A pull request the viewer owns and that has not merged shows both
  // "Unblock in an agent" (writes code) and "Check it shipped" (only judges)
  // — the two used to be visually identical. `idrisay`'s own #118 in Open is
  // exactly that case.
  if (process.env['BATON_SHOT_RUN_BUTTONS']) {
    await read(
      win,
      `Array.from(document.querySelectorAll('.rows .row .row-num'))
        .find(e => e.textContent === '118')?.closest('button')?.click()`
    );
    await until(win, `document.querySelector('.detail-actions .primary.outline')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['BATON_SHOT_RUN_BUTTONS'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_RUN_BUTTONS']}`);

    // Item 28: the same buttons in light mode, where the outline one used to
    // inherit the solid button's near-white label and come out empty.
    await read(win, `window.baton.setSetting('appearance.theme', 'light')`);
    await read(win, `document.documentElement.dataset.theme = 'light'`);
    await new Promise((r) => setTimeout(r, 250));
    const outlineInLight = await read(
      win,
      `(() => {
        const b = document.querySelector('.detail-actions .primary.outline');
        if (!b) return null;
        const style = getComputedStyle(b);
        const pane = getComputedStyle(document.querySelector('.detail'));
        return { label: b.textContent, color: style.color, background: pane.backgroundColor };
      })()`
    );
    await writeFile(
      `${process.env['BATON_SHOT_RUN_BUTTONS']}`.replace(/\.png$/, '-light.png'),
      (await win.webContents.capturePage()).toPNG()
    );
    console.log('runButtonsLight:', JSON.stringify(outlineInLight));
    await read(win, `window.baton.setSetting('appearance.theme', 'dark')`);
    await read(win, `document.documentElement.dataset.theme = 'dark'`);
    await new Promise((r) => setTimeout(r, 200));
  }

  // --- The run sheet's model field, and remembering the last one picked -----
  if (process.env['BATON_SHOT_RUN_MODEL']) {
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, `document.querySelector('.detail-actions .primary')`, 5_000);
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.run-controls select')?.value`, 5_000);
    await new Promise((r) => setTimeout(r, 150));

    const modelField = () =>
      read(
        win,
        `(() => { const i = document.querySelector('.run-controls input[list]');
          return i ? { value: i.value, placeholder: i.placeholder } : null; })()`
      );
    const options = await read(
      win,
      `Array.from(document.querySelectorAll('#run-model-options option')).map(o => o.value)`
    );
    const before = await modelField();

    await writeFile(
      process.env['BATON_SHOT_RUN_MODEL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_RUN_MODEL']}`);

    // Pick a model and cancel — a run sheet closed without running must not
    // remember anything, only one actually started does.
    await read(
      win,
      `(() => { const i = document.querySelector('.run-controls input[list]');
        if (!i) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(i, 'opus');
        i.dispatchEvent(new Event('input', { bubbles: true }));
       })()`
    );
    const afterTyping = await modelField();
    await read(win, `document.querySelector('.sheet-head .ghost')?.click()`);
    await new Promise((r) => setTimeout(r, 100));
    const forgottenAfterCancel = (
      await read(win, `window.baton.settings()`) as { 'runner.lastModel'?: Record<string, string> }
    )['runner.lastModel']?.['claude'];

    console.log(
      'runModel:',
      JSON.stringify({ options, before, afterTyping, forgottenAfterCancel })
    );

    // Now actually run with an explicit model, and check it stuck.
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.run-controls select')?.value`, 5_000);
    await read(
      win,
      `(() => { const i = document.querySelector('.run-controls input[list]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(i, 'haiku');
        i.dispatchEvent(new Event('input', { bubbles: true }));
       })()`
    );
    await until(win, `document.querySelector('.sheet-foot .primary:not(:disabled)')`, 10_000);
    await read(win, `document.querySelector('.sheet-foot .primary')?.click()`);
    await until(win, `document.querySelector('.detail-terminal')`, 10_000);
    await new Promise((r) => setTimeout(r, 300));
    const rememberedAfterRun = (
      await read(win, `window.baton.settings()`) as { 'runner.lastModel'?: Record<string, string> }
    )['runner.lastModel']?.['claude'];

    // Reopening the sheet for the same agent should come back prefilled.
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.run-controls select')?.value`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    const prefilled = await modelField();
    await read(win, `document.querySelector('.sheet-head .ghost')?.click()`);

    console.log(
      'runModelRemembered:',
      JSON.stringify({ rememberedAfterRun, prefilled })
    );
  }

  // --- The bottom status bar -------------------------------------------------
  if (process.env['BATON_SHOT_STATUSBAR']) {
    await writeFile(
      process.env['BATON_SHOT_STATUSBAR'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_STATUSBAR']}`);

    const text = () => read(win, `document.querySelector('.statusbar')?.textContent ?? ''`);
    const before = await text();
    // Every count on the right is a shortcut — "N tickets" switches to Tickets
    // the same as clicking its rail icon would.
    await read(
      win,
      `Array.from(document.querySelectorAll('.statusbar-item'))
        .find(b => b.textContent.includes('tickets'))?.click()`
    );
    await until(win, `document.querySelector('.rail-item[aria-current]')?.getAttribute('aria-label') === 'Tickets'`, 5_000);
    const activeViewAfterClick = await read(
      win, `document.querySelector('.rail-item[aria-current]')?.getAttribute('aria-label')`
    );
    console.log(
      'statusbar:',
      JSON.stringify({ before, activeViewAfterClick })
    );
    // Back to Pulls, so nothing downstream inherits a view it never asked for.
    await read(win, `document.querySelector('.rail-item[aria-label="Pull requests"]')?.click()`);
    await new Promise((r) => setTimeout(r, 150));
  }

  // --- The "just now" stamp, as a refresh menu -------------------------------
  // `connected` here is the seeded fixture's (github only) — the real poller
  // underneath never saw a token in this profile, so clicking a provider's
  // own refresh exercises the button and the IPC round trip without needing
  // a real GitHub/Jira connection.
  if (process.env['BATON_SHOT_REFRESH_MENU']) {
    await read(win, `document.querySelector('[aria-label="Refresh"]')?.click()`);
    await until(win, `document.querySelector('.stamp-menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    const rows = (await read(
      win,
      `Array.from(document.querySelectorAll('.menu-refresh-row')).map(r => ({
         label: r.querySelector('.menu-refresh-label')?.textContent ?? '',
         age: r.querySelector('.menu-refresh-age')?.textContent ?? ''
       }))`
    )) as { label: string; age: string }[];
    console.log('refreshMenuRows:', JSON.stringify(rows));
    await writeFile(
      process.env['BATON_SHOT_REFRESH_MENU'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_REFRESH_MENU']}`);

    const buttonExists = await read(
      win, `Boolean(document.querySelector('[aria-label="Refresh Pull requests"]'))`
    );
    await read(win, `document.querySelector('[aria-label="Refresh Pull requests"]')?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    console.log(
      'refreshOneProvider:',
      JSON.stringify({ rowFound: rows.length > 0, buttonExists })
    );
    await read(win, `document.body.click()`);
    await new Promise((r) => setTimeout(r, 100));
  }

  if (process.env['BATON_SHOT_PR_INLINE_TERMINAL']) {
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, `document.querySelector('.detail-actions .primary')`, 5_000);
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.run-controls select')`, 5_000);
    await until(win, `document.querySelector('.sheet-foot .primary:not(:disabled)')`, 10_000);
    await read(win, `document.querySelector('.sheet-foot .primary')?.click()`);
    await until(win, `document.querySelector('.detail-terminal')`, 10_000);
    await new Promise((r) => setTimeout(r, 400));
    const stayedOnPulls = await read(
      win,
      `document.querySelector('.rail-item[aria-label="Pull requests"]')?.classList.contains('active')`
    );
    console.log('stayedOnPulls:', stayedOnPulls);
    await writeFile(
      process.env['BATON_SHOT_PR_INLINE_TERMINAL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_PR_INLINE_TERMINAL']}`);
  }

  // --- The quick terminal: scoped to looking at one ticket/PR, not a run ----
  // Opened from the "Terminal" button rather than a run sheet, and closed the
  // moment you navigate to a different pull request — unlike an agent run's
  // session, which is meant to outlive the pane it was started from.
  if (process.env['BATON_SHOT_QUICK_TERMINAL']) {
    // Counts how many times the resize IPC actually fires. `Terminal.tsx`
    // used to call it on every ResizeObserver firing, whether or not the
    // char grid changed — and a stray nested `.term` div (Detail.tsx wrapped
    // `<Terminal>` in a *second* element also classed `.term`, so `flex: 1`
    // never reached xterm's own container) kept that observer firing
    // continuously. Each call sent a real SIGWINCH to the shell, and enough
    // prompts redraw their whole line on any SIGWINCH that the redraw storm
    // read as flicker and could eat a keystroke typed in between two of them.
    await read(
      win,
      `(() => {
        window.__resizeCalls = 0;
        const original = window.baton.sessionResize.bind(window.baton);
        window.baton.sessionResize = (...args) => { window.__resizeCalls += 1; return original(...args); };
      })()`
    );

    const openQuickTerminal = () =>
      read(
        win,
        `Array.from(document.querySelectorAll('.detail-actions .ghost'))
          .find(b => b.textContent.includes('Terminal'))?.click()`
      );

    await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
    await until(win, `document.querySelector('.detail-actions .ghost')`, 5_000);
    await openQuickTerminal();
    await until(win, `document.querySelector('.detail-terminal')`, 10_000);
    await new Promise((r) => setTimeout(r, 1_500));
    await writeFile(
      process.env['BATON_SHOT_QUICK_TERMINAL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_QUICK_TERMINAL']}`);
    console.log('resizeCallsAfterSettling:', await read(win, `window.__resizeCalls`));

    // A quick terminal is filed under its ticket/PR the same way a run's
    // session is: navigating to a different one and back should find the
    // *same* session still there, not gone — that's the whole point of
    // docking it by subject rather than by "whatever is currently open".
    const sessionsBefore = await read(win, `window.baton.sessions()`) as { id: string }[];
    await read(win, `document.querySelectorAll('.rows .row')[1]?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    const hiddenOnOtherPull = !(await read(win, `document.querySelector('.detail-terminal')`));
    await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    const reappeared = await read(win, `Boolean(document.querySelector('.detail-terminal'))`);
    const sessionsAfter = await read(win, `window.baton.sessions()`) as { id: string }[];
    console.log(
      'quickTerminalPersists:',
      JSON.stringify({
        hiddenOnOtherPull, reappeared,
        sameSession: sessionsBefore.length === 1 && sessionsAfter.length === 1 &&
          sessionsBefore[0].id === sessionsAfter[0].id
      })
    );

    // Real keystrokes, through the debugger protocol — typing into an xterm
    // instance is keyboard input, not a value a script can set, so this is
    // the only way a regression here would actually get caught.
    await read(win, `document.querySelector('.term')?.click()`);
    await new Promise((r) => setTimeout(r, 150));
    let attached = false;
    try {
      win.webContents.debugger.attach('1.3');
      attached = true;
    } catch { /* already attached elsewhere in this run */ }
    if (attached) {
      await win.webContents.debugger.sendCommand('Input.insertText', { text: 'echo BATON_TYPED_OK' });
      win.webContents.debugger.detach();
    }
    await new Promise((r) => setTimeout(r, 600));
    const typedVisible = await read(
      win,
      `document.querySelector('.term')?.textContent?.includes('BATON_TYPED_OK') ?? false`
    );
    console.log('quickTerminalKeystrokeVisible:', JSON.stringify({ attached, typedVisible }));
  }

  // --- Moving the inline terminal to each of its four docks -----------------
  // The complaint this answers: a run's terminal always landed at the bottom
  // of the pane with no way to move it. Checked the same way the sidebar
  // splitter is — real mouse events through the debugger protocol, because a
  // handler that only reacts to `pointermove` needs actual pointer capture,
  // which a dispatched DOM event cannot grant itself.
  if (process.env['BATON_SHOT_TERMINAL_DOCK']) {
    const prefix = process.env['BATON_SHOT_TERMINAL_DOCK'];
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, `document.querySelector('.detail-actions .primary')`, 5_000);
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.run-controls select')`, 5_000);
    await until(win, `document.querySelector('.sheet-foot .primary:not(:disabled)')`, 10_000);
    await read(win, `document.querySelector('.sheet-foot .primary')?.click()`);
    await until(win, `document.querySelector('.detail-terminal')`, 10_000);
    await new Promise((r) => setTimeout(r, 300));

    const state = () =>
      read(
        win,
        `(() => { const t = document.querySelector('.detail-terminal');
          return t ? {
            dockClass: [...t.classList].find(c => c.startsWith('dock-')),
            shellDirection: getComputedStyle(document.querySelector('.detail-shell')).flexDirection,
            rect: (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(t.getBoundingClientRect())
          } : null; })()`
      ) as Promise<{ dockClass: string; shellDirection: string; rect: { width: number; height: number } } | null>;
    const clickDock = (label: string) =>
      read(win, `document.querySelector('[aria-label="Dock ${label}"]')?.click()`);
    const shot = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };

    const dockedBottom = await state();
    await shot('bottom');

    await clickDock('right');
    await new Promise((r) => setTimeout(r, 150));
    const dockedRight = await state();
    await shot('right');

    // A real drag on the edge the panel resizes along, through the debugger
    // protocol — see the sidebar's own resize test for why not sendInputEvent.
    const handle = (await read(
      win,
      `(() => { const r = document.querySelector('.terminal-resizer')?.getBoundingClientRect();
        return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`
    )) as { x: number; y: number } | null;
    let widthAfterDrag: unknown = 'not attempted';
    let attached = false;
    try {
      win.webContents.debugger.attach('1.3');
      attached = true;
    } catch (error) {
      widthAfterDrag = `skipped: ${(error as Error).message}`;
    }
    if (handle && attached) {
      const mouse = (type: string, x: number, y: number, buttons: number) =>
        win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse'
        });
      await mouse('mousePressed', handle.x, handle.y, 1);
      for (const x of [handle.x - 60, handle.x - 120]) {
        await mouse('mouseMoved', x, handle.y, 1);
      }
      await new Promise((r) => setTimeout(r, 80));
      await mouse('mouseReleased', handle.x - 120, handle.y, 0);
      await new Promise((r) => setTimeout(r, 80));
      win.webContents.debugger.detach();
      widthAfterDrag = ((await state()) as { rect: { width: number } } | null)?.rect.width;
    }

    // A drag far enough that the old fixed 720px ceiling would have caught
    // it — the max is now a share of the shell's own box, not a constant, so
    // this should land near 80% of the pane's width instead of stopping at 720.
    let widthAfterBigDrag: unknown = 'not attempted';
    if (handle && attached) {
      let attached2 = false;
      try {
        win.webContents.debugger.attach('1.3');
        attached2 = true;
      } catch { /* nothing to attach to a second time in the same run */ }
      if (attached2) {
        const mouse = (type: string, x: number, y: number, buttons: number) =>
          win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse'
          });
        const moved = { x: handle.x - 120, y: handle.y };
        await mouse('mousePressed', moved.x, moved.y, 1);
        for (const x of [moved.x - 300, moved.x - 900]) {
          await mouse('mouseMoved', x, moved.y, 1);
        }
        await new Promise((r) => setTimeout(r, 80));
        await mouse('mouseReleased', moved.x - 900, moved.y, 0);
        await new Promise((r) => setTimeout(r, 80));
        win.webContents.debugger.detach();
        const afterBig = (await state()) as { rect: { width: number } } | null;
        const shellWidth = await read(
          win, `document.querySelector('.detail-shell')?.getBoundingClientRect().width`
        );
        widthAfterBigDrag = { width: afterBig?.rect.width, shellWidth };
      }
    }

    await clickDock('bottom');
    await new Promise((r) => setTimeout(r, 150));
    await clickDock('top');
    await new Promise((r) => setTimeout(r, 150));
    const dockedTop = await state();
    await shot('top');

    await clickDock('left');
    await new Promise((r) => setTimeout(r, 150));
    const dockedLeft = await state();
    await shot('left');

    console.log(
      'terminalDock:',
      JSON.stringify({
        dockedBottom, dockedRight, dockedTop, dockedLeft,
        widthBeforeDrag: dockedRight?.rect.width, widthAfterDrag, widthAfterBigDrag,
        storedDock: await read(win, `localStorage.getItem('baton.terminal-dock')`),
        storedWidth: await read(win, `localStorage.getItem('baton.terminal-width')`)
      })
    );
  }

  // --- The Sessions tab: items 22-27 ---------------------------------------
  // One session, driven through every one of them in order: the identifier in
  // its name is a way back to the ticket (22), its name is on the pane at all
  // (24), the font size is settable from the UI (25), renaming sticks (27),
  // and closing it leaves an instruction rather than a dead terminal (26).
  if (process.env['BATON_SHOT_SESSIONS']) {
    const prefix = process.env['BATON_SHOT_SESSIONS'];
    const shot = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };

    // An explicit cwd, since a smoke run's own user data has no watched
    // folders to fall back on. Two sessions, on a fixture ticket and a
    // fixture pull request, so the identifier in each name has something real
    // to resolve back to — one of each kind the row can jump to.
    const cwd = JSON.stringify(process.cwd());
    await read(win, `window.baton.openTerminal(${cwd}, 'acme/web#42', 'review · acme/web#42')`);
    await read(win, `window.baton.openTerminal(${cwd}, 'ACME-2393', 'implement · ACME-2393')`);
    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelector('.term-pane .term')`, 10_000);
    await new Promise((r) => setTimeout(r, 800));
    await shot('open');

    const named = await read(
      win,
      `(() => ({
        rowTitle: document.querySelector('.row-title')?.textContent ?? '',
        headTitle: document.querySelector('.term-title')?.textContent ?? '',
        cwdShown: Boolean(document.querySelector('.term-cwd')?.textContent),
        renameOffered: Boolean(document.querySelector('.row .icon-button.rename')),
        subjectLinks: document.querySelectorAll('.queue-list .subject-link').length,
        linkTexts: Array.from(document.querySelectorAll('.queue-list .subject-link')).map(b => b.textContent)
      }))()`
    );

    // Item 25: the stepper, and the same state the ⌘+/⌘− accelerator drives.
    const fontBefore = await read(win, `document.querySelector('.xterm')?.style.fontSize
      || getComputedStyle(document.querySelector('.xterm-rows')).fontSize`);
    await read(win, `document.querySelector('[aria-label="Larger text"]')?.click()`);
    await new Promise((r) => setTimeout(r, 400));
    const font = {
      before: fontBefore,
      after: await read(win, `getComputedStyle(document.querySelector('.xterm-rows')).fontSize`),
      shown: await read(win, `document.querySelector('.font-size-value')?.textContent`),
      stored: await read(win, `localStorage.getItem('baton.terminal-font-size')`)
    };
    await shot('font');

    // ...and the same state from the keyboard. ⌘+ is intercepted in main so
    // it sizes the terminal instead of zooming the whole page, which is what
    // Electron's own default menu did with it — so check both halves: the
    // font moved, and the page zoom did not.
    await read(
      win,
      `(() => { window.__steps = []; window.baton.onFontSizeStep(step => window.__steps.push(step)); })()`
    );
    // `sendInputEvent`, not the debugger protocol: CDP injects straight into
    // the renderer and never passes the browser-side input pipeline, which is
    // exactly where `before-input-event` — the hook this shortcut hangs on —
    // sits. Checked, not assumed: through CDP the handler never fired at all.
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: ['meta'] });
    await new Promise((r) => setTimeout(r, 500));
    const shortcut = {
      shown: await read(win, `document.querySelector('.font-size-value')?.textContent`),
      rendered: await read(win, `getComputedStyle(document.querySelector('.xterm-rows')).fontSize`),
      pageZoom: win.webContents.getZoomLevel(),
      stepsSeenByRenderer: await read(win, `window.__steps`)
    };

    // Item 23: ring the bell in one session and its row must stop looking like
    // every other running one. Rung through the real pty, since that is the
    // path the signal actually travels. `tput bel` rather than `printf`, so
    // the injected line carries no backslash for two layers of escaping to
    // argue over — one round of that already produced a raw carriage return
    // inside a string literal.
    const openSessions = (await read(win, `window.baton.sessions()`)) as
      { id: string; subject?: string }[];
    const ticketSession = openSessions.find((s) => s.subject === 'ACME-2393');
    await read(
      win,
      `window.baton.sessionWrite(${JSON.stringify(ticketSession?.id ?? '')}, 'tput bel' + String.fromCharCode(13))`
    );
    await new Promise((r) => setTimeout(r, 2000));
    const bell = {
      inMain: await read(
        win,
        `window.baton.sessions().then(l => l.map(s => ({ subject: s.subject, attention: s.attention })))`
      ),
      rows: await read(
        win,
        `(() => Array.from(document.querySelectorAll('.queue-list .row')).map(r => ({
          title: r.querySelector('.row-title')?.textContent ?? '',
          dot: r.querySelector('.row-state .dot')?.className ?? '',
          label: r.querySelector('.row-state .state')?.textContent ?? ''
        })))()`
      )
    };
    await shot('waiting');

    // Item 27: rename from the row, committed with Enter.
    await read(win, `document.querySelector('.row .icon-button.rename')?.click()`);
    await until(win, `document.querySelector('.rename-input')`, 5_000);
    await read(
      win,
      `(() => {
        const input = document.querySelector('.rename-input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'nightly backfill · ACME-2393');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`
    );
    await new Promise((r) => setTimeout(r, 600));
    const renamed = await read(
      win,
      `(() => ({
        rowTitle: document.querySelector('.row-title')?.textContent ?? '',
        headTitle: document.querySelector('.term-title')?.textContent ?? '',
        subjectStillLinked: Boolean(document.querySelector('.row-title .subject-link'))
      }))()`
    );
    await shot('renamed');

    // Item 22: the identifier in the name goes to the thing it names — the
    // ticket for a ticket, the pull request for a pull request.
    const where = () =>
      read(
        win,
        `(() => ({
          view: document.querySelector('.rail-item[aria-current="page"]')?.getAttribute('aria-label'),
          heading: document.querySelector('.detail-head h2')?.textContent ?? '',
          key: document.querySelector('.detail-meta .key')?.textContent ?? ''
        }))()`
      );
    await read(win, `document.querySelectorAll('.queue-list .subject-link')[0]?.click()`);
    await new Promise((r) => setTimeout(r, 600));
    const jumpedToTicket = await where();
    await shot('jumped');

    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelector('.queue-list .subject-link')`, 5_000);
    await read(win, `document.querySelectorAll('.queue-list .subject-link')[1]?.click()`);
    await new Promise((r) => setTimeout(r, 600));
    const jumpedToPull = await where();

    // Item 26: closing what you were watching leaves a way forward, not a
    // terminal pointed at a session the main process has already forgotten.
    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelector('.term-head .ghost')`, 5_000);
    await read(
      win,
      `Array.from(document.querySelectorAll('.term-head .ghost'))
        .find(b => b.textContent.includes('Close'))?.click()`
    );
    await new Promise((r) => setTimeout(r, 700));
    const closed = await read(
      win,
      `(() => ({
        emptyShown: Boolean(document.querySelector('.term-empty')),
        text: document.querySelector('.term-empty .quiet')?.textContent ?? '',
        terminalGone: !document.querySelector('.term-pane .term'),
        rowsLeft: document.querySelectorAll('.queue-list .row').length
      }))()`
    );
    await shot('closed');

    // Leave the app as it was found, so anything checked after this block
    // is not looking at a Sessions tab it did not ask for.
    await read(win, `document.querySelector('[aria-label="Pull requests"]')?.click()`);
    await new Promise((r) => setTimeout(r, 300));

    console.log(
      'sessionsTab:',
      JSON.stringify({ named, font, shortcut, bell, renamed, jumpedToTicket, jumpedToPull, closed }, null, 2)
    );
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
    // Same reason every other shot in this file waits: capturePage() can grab
    // a frame from just before the click's re-render finishes compositing.
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(
      process.env['BATON_SHOT_TICKET'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_TICKET']}`);
  }

  // The Sentry tab: same detail-pane shape as the ticket pane, plus the two
  // actions it is for — starting an agent and filing a ticket — and a stack
  // trace fetched over its own IPC round trip rather than baked into the
  // list, so waiting for it here is a real check that the round trip works.
  await read(win, `document.querySelector('.rail-item[aria-label="Sentry errors"]')?.click()`);
  await until(win, `document.querySelector('.row')`, 10_000);
  await read(win, `document.querySelector('.row')?.click()`);
  await until(win, `document.querySelector('.detail-head h2')`, 10_000);
  await until(win, `document.querySelectorAll('.files.mono li').length > 0`, 5_000);
  result['sentry'] = {
    heading: await read(win, `document.querySelector('.detail-head h2')?.textContent ?? ''`),
    actions: await read(
      win,
      `Array.from(document.querySelectorAll('.detail-actions button')).map(b => b.textContent)`
    ),
    frameCount: await read(win, `document.querySelectorAll('.files.mono li').length`),
    resolvedFrame: await read(
      win,
      `document.querySelector('.files.mono li .file-path')?.textContent ?? ''`
    )
  };

  if (process.env['BATON_SHOT_SENTRY']) {
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(process.env['BATON_SHOT_SENTRY'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['BATON_SHOT_SENTRY']}`);
  }

  if (process.env['BATON_SHOT_SENTRY_TICKET']) {
    await read(
      win,
      `Array.from(document.querySelectorAll('.detail-actions button'))
        .find(b => b.textContent.includes('Create ticket'))?.click()`
    );
    await until(win, `document.querySelector('.quiet.small .link')`, 5_000);
    await new Promise((r) => setTimeout(r, 200));
    result['sentryTicket'] = await read(win, `document.querySelector('.quiet.small')?.textContent ?? ''`);
    await writeFile(
      process.env['BATON_SHOT_SENTRY_TICKET'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_SENTRY_TICKET']}`);
  }

  // Item 18: saving Settings with a required field left blank must not fail
  // silently. It should say what is still missing, and once that field is
  // filled and saved, actually flip to connected without a manual refresh —
  // `save()` re-polls itself now.
  await read(win, `document.querySelector('[aria-label="Settings"]')?.click()`);
  await until(win, `document.querySelector('.settings-nav')`, 5_000);
  await read(
    win,
    `Array.from(document.querySelectorAll('.settings-nav button'))
      .find(b => b.textContent.includes('Sentry'))?.click()`
  );
  await until(win, `document.querySelector('.provider h3')`, 5_000);
  const setField = (match: string, value: string) => `(() => {
    const input = Array.from(document.querySelectorAll('.provider label'))
      .find(l => l.textContent.includes('${match}'))?.querySelector('input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${value}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  const clickSaveSentry = () => read(
    win,
    `Array.from(document.querySelectorAll('.provider .primary'))
      .find(b => b.textContent.includes('Save Sentry'))?.click()`
  );
  // The auth token — a genuinely required field — left blank.
  await read(win, setField('organization slug', 'acme'));
  await clickSaveSentry();
  await until(win, `document.querySelector('.settings-note')`, 10_000);
  result['sentrySaveMissingField'] = {
    note: await read(win, `document.querySelector('.settings-note')?.textContent ?? ''`),
    badge: await read(win, `document.querySelector('.provider h3 .badge')?.textContent ?? ''`)
  };

  // Item 19: the project field is filled in nowhere here — organization and
  // token are all `CREDENTIAL_FIELDS.sentry` asks for since project stopped
  // being one of them, so this alone must be enough to connect.
  await read(win, setField('auth token', 'smoke-test-token'));
  await clickSaveSentry();
  await until(win, `document.querySelector('.settings-note.ok')`, 10_000);
  result['sentrySaveConnectedWithoutProject'] = {
    note: await read(win, `document.querySelector('.settings-note')?.textContent ?? ''`),
    badge: await read(win, `document.querySelector('.provider h3 .badge')?.textContent ?? ''`),
    projectFieldStillOffered: await read(
      win,
      `Array.from(document.querySelectorAll('.provider label'))
        .some(l => l.textContent.includes('Only show one project'))`
    )
  };

  if (process.env['BATON_SHOT_SETTINGS_SAVE']) {
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(
      process.env['BATON_SHOT_SETTINGS_SAVE'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_SETTINGS_SAVE']}`);
  }

  await read(win, `document.querySelector('.sheet-head .ghost')?.click()`);
  await until(win, `!document.querySelector('.settings-nav')`, 5_000);

  // Back to Tickets, so nothing below assumes Sentry is still the active view.
  await read(win, `document.querySelector('.rail-item[aria-label="Tickets"]')?.click()`);
  await until(win, `document.querySelector('.row')`, 10_000);
  await read(win, `document.querySelector('.row')?.click()`);
  await until(win, `document.querySelector('.detail-head h2')`, 10_000);

  if (process.env['BATON_SHOT_INLINE_TERMINAL']) {
    await read(
      win,
      `Array.from(document.querySelectorAll('.detail-actions .primary'))
        .find(b => b.textContent.includes('Work on this'))?.click()`
    );
    await until(win, `document.querySelector('.run-controls select')`, 5_000);
    // Runner + folder options load async; the Run button stays disabled
    // until both are populated.
    await until(win, `document.querySelector('.sheet-foot .primary:not(:disabled)')`, 10_000);
    await read(win, `document.querySelector('.sheet-foot .primary')?.click()`);
    await until(win, `document.querySelector('.detail-terminal')`, 10_000);
    await new Promise((r) => setTimeout(r, 400));
    result['stayedOnTicket'] = await read(
      win,
      `document.querySelector('.rail-item[aria-label="Tickets"]')?.classList.contains('active')`
    );
    await writeFile(
      process.env['BATON_SHOT_INLINE_TERMINAL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_INLINE_TERMINAL']}`);
  }

  if (process.env['BATON_SHOT_RUN_VIEWER']) {
    await until(
      win,
      `Array.from(document.querySelectorAll('.runs .link')).some(b => b.textContent.trim() === 'view')`,
      5_000
    );
    await read(
      win,
      `Array.from(document.querySelectorAll('.runs .link')).find(b => b.textContent.trim() === 'view')?.click()`
    );
    await until(win, `document.querySelector('.run-viewer')`, 5_000);
    // The gallery's contents come from a real directory read, not a fixed
    // set of tabs — wait for it rather than a fixed delay, the same reason
    // every other async render in this file is polled instead of slept past.
    await until(win, `document.querySelectorAll('.run-doc, .run-shot').length > 0`, 5_000);
    await new Promise((r) => setTimeout(r, 200));
    console.log(
      'runViewerGallery:',
      JSON.stringify({
        docs: await read(
          win,
          `Array.from(document.querySelectorAll('.run-doc-name')).map(b => b.textContent)`
        ),
        shots: await read(win, `document.querySelectorAll('.run-shot').length`)
      })
    );
    await writeFile(
      process.env['BATON_SHOT_RUN_VIEWER'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_RUN_VIEWER']}`);

    if (process.env['BATON_SHOT_RUN_VIEWER_SHOTS']) {
      // Opening a document takes over the view; "back" has to return to
      // exactly the gallery that was there before.
      await read(win, `document.querySelector('.run-doc')?.click()`);
      await until(win, `document.querySelector('.run-viewer-doc')`, 5_000);
      await new Promise((r) => setTimeout(r, 200));
      await writeFile(
        process.env['BATON_SHOT_RUN_VIEWER_SHOTS'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_RUN_VIEWER_SHOTS']}`);

      await read(win, `document.querySelector('.run-viewer-back')?.click()`);
      await new Promise((r) => setTimeout(r, 150));
      console.log(
        'runViewerBackToGallery:',
        JSON.stringify({ galleryVisible: await read(win, `Boolean(document.querySelector('.run-viewer-gallery'))`) })
      );
    }

    // The screenshot grid and lightbox, which the fixture run itself never
    // produces (nothing here calls a real agent that takes screenshots) —
    // proven instead by placing one real PNG straight into the run's own
    // shots/ folder, the exact way `RunStore.env()` tells a run to.
    if (process.env['BATON_SHOT_RUN_VIEWER_LIGHTBOX']) {
      await read(win, `document.querySelector('.run-viewer .ghost')?.click()`);
      await new Promise((r) => setTimeout(r, 100));
      const runs = (await read(win, `window.baton.runHistory('ACME-2393')`)) as { directory: string }[];
      const directory = runs[0]?.directory;
      if (directory) {
        const shotsDir = path.join(directory, 'shots');
        await mkdir(shotsDir, { recursive: true });
        // A minimal but real 1x1 PNG, not a text file wearing the extension —
        // this has to survive an actual decode by an <img> tag.
        const onePixelPng = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64'
        );
        await writeFile(path.join(shotsDir, '01-example.png'), onePixelPng);

        await read(
          win,
          `Array.from(document.querySelectorAll('.runs .link')).find(b => b.textContent.trim() === 'view')?.click()`
        );
        await until(win, `document.querySelectorAll('.run-shot').length > 0`, 5_000);
        await new Promise((r) => setTimeout(r, 200));
        await read(win, `document.querySelector('.run-shot')?.click()`);
        await until(win, `document.querySelector('.lightbox-backdrop img')`, 5_000);
        await new Promise((r) => setTimeout(r, 150));
        await writeFile(
          process.env['BATON_SHOT_RUN_VIEWER_LIGHTBOX'],
          (await win.webContents.capturePage()).toPNG()
        );
        console.log(`shot: ${process.env['BATON_SHOT_RUN_VIEWER_LIGHTBOX']}`);
        console.log(
          'runViewerLightbox:',
          JSON.stringify({
            shotCount: await read(win, `document.querySelectorAll('.run-shot').length`),
            lightboxSrcIsDataUrl: await read(
              win, `document.querySelector('.lightbox-backdrop img')?.src.startsWith('data:image/')`
            )
          })
        );
      } else {
        console.log('runViewerLightbox: skipped, no run directory found');
      }
    }

    await read(win, `document.querySelector('.run-viewer .ghost')?.click()`);
    await new Promise((r) => setTimeout(r, 100));
  }

  if (process.env['BATON_SHOT_TICKET_FILTER']) {
    await read(win, `document.querySelector('[aria-label="Filter tickets"]')?.click()`);
    await until(win, `document.querySelector('.filter-menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['BATON_SHOT_TICKET_FILTER'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_TICKET_FILTER']}`);
    // Close it before whatever runs next, so an unrelated shot doesn't
    // inherit an open menu it never asked for.
    await read(win, `document.body.click()`);
    await new Promise((r) => setTimeout(r, 100));
  }

  if (process.env['BATON_SHOT_TICKET_SORT']) {
    await read(win, `document.querySelector('[aria-label="Sort tickets"]')?.click()`);
    await until(win, `document.querySelector('.menu-host .menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['BATON_SHOT_TICKET_SORT'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_TICKET_SORT']}`);

    if (process.env['BATON_SHOT_TICKET_SORTED']) {
      await read(
        win,
        `Array.from(document.querySelectorAll('.menu-host .menu button'))
          .find(b => b.textContent.includes('Priority'))?.click()`
      );
      await new Promise((r) => setTimeout(r, 150));
      await writeFile(
        process.env['BATON_SHOT_TICKET_SORTED'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_TICKET_SORTED']}`);
    }
  }

  if (process.env['BATON_SHOT_NEW_SESSION']) {
    await read(win, `document.querySelector('.rail-item[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelector('[aria-label="New session"]')`, 5_000);
    await read(win, `document.querySelector('[aria-label="New session"]')?.click()`);
    await until(win, `document.querySelector('.new-session-host .menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['BATON_SHOT_NEW_SESSION'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_NEW_SESSION']}`);

    if (process.env['BATON_SHOT_NEW_SESSION_OPENED']) {
      await read(win, `document.querySelector('.new-session-host .menu button[role="menuitem"]')?.click()`);
      await until(win, `document.querySelector('.term-head')`, 10_000);
      await new Promise((r) => setTimeout(r, 250));
      await writeFile(
        process.env['BATON_SHOT_NEW_SESSION_OPENED'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_NEW_SESSION_OPENED']}`);
      // Left open for as long as the docked-terminal check leaves its own
      // open, so a warning-count comparison between the two is fair.
      await new Promise((r) => setTimeout(r, 4_000));
      console.log('sessionsTabTerminalDwellDone');

      // Control: does the same keystroke dispatch work against a terminal
      // that is not docked in a ticket/PR pane?
      await read(win, `document.querySelector('.term')?.click()`);
      await new Promise((r) => setTimeout(r, 150));
      let ctrlAttached = false;
      try {
        win.webContents.debugger.attach('1.3');
        ctrlAttached = true;
      } catch { /* already attached */ }
      if (ctrlAttached) {
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'echo hi' });
        win.webContents.debugger.detach();
      }
      await new Promise((r) => setTimeout(r, 400));
      const ctrlTypedText = await read(
        win,
        `Array.from(document.querySelectorAll('.term .xterm-rows > div')).map(d => d.textContent).join('\\n')`
      );
      console.log('typedIntoSessionsTabTerminal:', JSON.stringify({ ctrlAttached, ctrlTypedText }));
    }
  }

  if (process.env['BATON_SHOT_SETTINGS']) {
    await read(win, `document.querySelector('[aria-label="Settings"]')?.click()`);
    await until(win, `document.querySelector('.settings-nav')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['BATON_SHOT_SETTINGS'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_SETTINGS']}`);

    if (process.env['BATON_SHOT_SETTINGS_ENV']) {
      await read(
        win,
        `Array.from(document.querySelectorAll('.settings-nav button'))
          .find(b => b.textContent.includes('Dev environment'))?.click()`
      );
      await new Promise((r) => setTimeout(r, 150));
      await writeFile(
        process.env['BATON_SHOT_SETTINGS_ENV'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_SETTINGS_ENV']}`);
    }

    if (process.env['BATON_SHOT_SETTINGS_LIGHT']) {
      await read(
        win,
        `Array.from(document.querySelectorAll('.settings-nav button'))
          .find(b => b.textContent.includes('General'))?.click()`
      );
      await new Promise((r) => setTimeout(r, 100));
      await read(
        win,
        `Array.from(document.querySelectorAll('.theme-picker button'))
          .find(b => b.textContent === 'Light')?.click()`
      );
      await new Promise((r) => setTimeout(r, 250));
      await writeFile(
        process.env['BATON_SHOT_SETTINGS_LIGHT'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['BATON_SHOT_SETTINGS_LIGHT']}`);
    }
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

  // Item 17: rolling a change back, one row at a time and "all of them".
  // Gated on its own explicit opt-in, separate from `BATON_SMOKE=workspace`
  // itself — this is the one part of the workspace walk that mutates git
  // state and deletes an untracked file, and `workspace` mode otherwise runs
  // against whatever real folders happen to be configured. Set this only
  // against a disposable repo.
  if (process.env['BATON_SMOKE_REVERT'] === '1') {
    summary['revert'] = await driveRevert(win);
  }

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
      (await read(win, `document.querySelector('.queue')?.getBoundingClientRect().width ?? null`)) as number;
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

      // The handle travelled with the edge, so aim the next drag from there —
      // exactly 140px along only holds because that drag landed short of
      // either bound; re-querying is what a real drag chain always does.
      const handleNow = () =>
        read(
          win,
          `(() => { const r = document.querySelector('.resizer')?.getBoundingClientRect();
             return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`
        ) as Promise<{ x: number; y: number } | null>;

      const moved = (await handleNow()) ?? { x: handle.x + 140, y: handle.y };

      // Far enough that the old fixed 620px ceiling would have caught it —
      // the max is now 70% of the window, not a constant.
      await drag(moved, moved.x + 2000);
      const atCeiling = await widthOf();
      const innerWidth = (await read(win, `window.innerWidth`)) as number;
      const ceiling = { atCeiling, expected: Math.round(innerWidth * 0.7) };

      const afterCeiling = (await handleNow()) ?? { x: moved.x + 2000, y: moved.y };
      await drag(afterCeiling, afterCeiling.x - 2400); // well past the floor
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
        ceiling,
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

/**
 * Item 17, driven for real against whatever repo `driveWorkspace` already
 * has the Changes tab open on. Only ever invoked behind `BATON_SMOKE_REVERT`
 * — see the call site.
 */
async function driveRevert(win: BrowserWindow): Promise<Record<string, unknown>> {
  const read_ = <T>(script: string) => read(win, script) as Promise<T>;

  const rowCount = () => read_<number>(`document.querySelectorAll('.change').length`);
  const confirmText = () => read_<string>(`document.querySelector('.menu.confirm p')?.textContent ?? ''`);

  const before = await rowCount();

  // One row: open its confirm popover, read what it says, cancel it, and
  // check cancelling really did nothing before trying the real thing.
  await read(win, `document.querySelector('.change-row .icon-button.revert')?.click()`);
  await until(win, `document.querySelector('.menu.confirm')`, 5_000);
  const oneRowConfirmText = await confirmText();
  if (process.env['BATON_SHOT_REVERT_CONFIRM']) {
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['BATON_SHOT_REVERT_CONFIRM'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['BATON_SHOT_REVERT_CONFIRM']}`);
  }
  await read(win, `document.querySelector('.confirm-actions button:not(.menu-warn)')?.click()`);
  await new Promise((r) => setTimeout(r, 100));
  const afterCancel = {
    popoverGone: !(await read_<boolean>(`Boolean(document.querySelector('.menu.confirm'))`)),
    rowCount: await rowCount()
  };

  // Same row, for real this time.
  await read(win, `document.querySelector('.change-row .icon-button.revert')?.click()`);
  await until(win, `document.querySelector('.menu.confirm')`, 5_000);
  await read(win, `document.querySelector('.confirm-actions button.menu-warn')?.click()`);
  await until(win, `document.querySelectorAll('.change').length === ${before - 1}`, 10_000);
  const afterOne = await rowCount();

  // Whatever is left, in one shot via "Revert all".
  const hadRevertAll = await read_<boolean>(`Boolean(document.querySelector('.change-list-head .link'))`);
  let allConfirmText = '';
  let afterAll = afterOne;
  let clean = false;
  if (hadRevertAll) {
    await read(win, `document.querySelector('.change-list-head .link')?.click()`);
    await until(win, `document.querySelector('.menu.confirm')`, 5_000);
    allConfirmText = await confirmText();
    await read(win, `document.querySelector('.confirm-actions button.menu-warn')?.click()`);
    await until(
      win,
      `document.querySelector('.tree-note.clean') || document.querySelectorAll('.change').length === 0`,
      10_000
    );
    afterAll = await rowCount();
    clean = await read_<boolean>(`Boolean(document.querySelector('.tree-note.clean'))`);
  }

  return {
    before, oneRowConfirmText, afterCancel, afterOne, hadRevertAll, allConfirmText, afterAll, clean
  };
}
