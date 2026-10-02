/**
 * The headless check.
 *
 * Screenshots need a screen-recording permission this environment does not
 * have, and "it rendered" is the assertion that actually matters — so this
 * launches the app, waits for it to be *ready* rather than for a fixed delay,
 * interrogates the real DOM, optionally captures the window, prints one JSON
 * object and exits.
 *
 * Modes, via `KOVAN_SMOKE`:
 *   `1`      wiring only — main, preload and renderer are talking.
 *   `seeded` the same, plus a fixture snapshot, so row and state rendering is
 *            exercised without the network.
 *   `live`   against the real account.
 *   `pty`    the terminal layer, which no DOM check can reach.
 *   `workspace`
 *            drives the explorer against a real clone: expands the tree, opens
 *            a source file, opens a diff, and reads back what rendered.
 *
 * `KOVAN_SHOT=<path>` also writes a PNG of the window.
 */

import { app, clipboard, ClipboardItem, type BrowserWindow } from 'electron';
import { latestDockMenu } from './dockMenu';
import { existsSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Agents } from './agents';
import type { ActivityFeed } from './activityFeed';
import type { Poller, Snapshot } from './poller';
import { Sessions } from './sessions';
import { PtyHosts } from './ptyClient';
import { AgentStatus } from './agentStatus';
import { reviewBasis, trackProblems } from '@kovan/core';
import { RunStore, type Runner } from '@kovan/agent';

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
  viewerReviewed: false,
  // Names ticket ACME-2393 in its branch only, not its title.
  headRef: 'fix/ACME-2393-tablet-mobile-qa-round2'
};

/** One open pull request per section, so all four headers have something in them. */
const OPEN_PULLS = [
  {
    ...FIXTURE,
    headRef: 'feat/unrelated-change',
    number: 118,
    // Carries the same ticket key as `TICKET` below on purpose — item 32's
    // two-way link needs one real match to exercise against.
    title: 'Cache the pricing table between requests (ACME-2393)',
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
    headRef: 'feat/unrelated-change',
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
    headRef: 'feat/unrelated-change',
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
  headRef: 'feat/unrelated-change',
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
    // One merged pull request per ticket's history, found by a lower-case branch.
    headRef: i === 1 ? 'feat/acme-2393-first-round' : `feat/change-${i + 1}`,
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
 * Served instead of the network only when `KOVAN_USER_DATA` is also set —
 * the same guard `detailFixture` uses — so it can never reach a real profile.
 */
/** A small diff with one real defect in it, for the Kimi K3 review shot. */
export function diffFixture(): string {
  return [
    'diff --git a/src/components/QuestionTable.tsx b/src/components/QuestionTable.tsx',
    '--- a/src/components/QuestionTable.tsx',
    '+++ b/src/components/QuestionTable.tsx',
    '@@ -112,7 +112,11 @@ export function QuestionTable({ rows, columns }: Props) {',
    '-  return <div className="overflow-x-auto"><div className="min-w-full overflow-hidden">',
    '+  const floor = 860;',
    '+  const width = columns.reduce((sum, c) => sum + c.width, 0);',
    '+  const scroll = width / rows.length > floor;',
    '+  return <div className={scroll ? "table-scroll-x" : ""}>',
    '+    <div className="min-w-full" style={{ minWidth: floor }}>'
  ].join('\n');
}

export function ticketFixture(_key: string) {
  // The quick-model shot needs a thread long enough for "Condense" to appear
  // (more than the latest ten). Only under that flag, so every other shot of
  // the ticket pane keeps the one comment it was taken with.
  if (process.env['KOVAN_SHOT_QUICK']) {
    return { ...TICKET, comments: [...LONG_THREAD, ...TICKET.comments] };
  }
  return TICKET;
}

const LONG_THREAD = [
  'Reproduced on iPad landscape: the table overlaps the sidebar below 1100px.',
  'Is this the same bug as the scrollbar ticket, or separate?',
  'Separate. The scrollbar is ACME-2401; this is the row actions overlapping.',
  'Decision from design: keep the scrollbar visible whenever the table is cut off, not only on hover.',
  'We tried a CSS-only fix with overflow: overlay, but Safari dropped support, so that is out.',
  'Touch devices above 1000px should get the tap fallback, not hover.',
  'Still open: do we need the fallback on Android tablets too?',
  'QA: first round shipped in August, overlaps still reproducible 75 minutes after merge.',
  'Root cause: the row actions are absolutely positioned against the wrong container.',
  'Fix in review, see the linked PR.',
  'Re-test scheduled for Thursday.',
  'Design signed off on the persistent scrollbar colours.',
  'Android tablets: product says yes, same fallback.',
  'PR updated with the Android fallback.',
  'Waiting on QA.'
].map((body, i) => ({
  author: ['qa', 'dev', 'design', 'product'][i % 4]!,
  created: new Date(Date.now() - (40 - i) * 86_400_000).toISOString(),
  body
}));

/**
 * A pull request detail rich enough to judge the layout by: a long body with a
 * table and a code block, checks, threads and a file list. Served instead of
 * the network only when KOVAN_USER_DATA is also set, so it can never reach a
 * real profile.
 */
export function detailFixture(repo: string, number: number) {
  return {
    number,
    repo,
    title: FIXTURE.title,
    url: FIXTURE.url,
    author: 'someone',
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
  setTimeout(() => sessions.write(session.id, 'echo KOVAN_PTY_OK-$((6*7))\r'), 600);
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
    line: 'echo KOVAN_LINE_OK-$((3*4))'
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

  const prompt = await agents.buildPrompt('unblock', { pull: FIXTURE });
  return {
    ptyOpened: Boolean(session.id),
    sawEcho: seen.includes('KOVAN_PTY_OK-42'),
    lineWasRun: seenFromLine.includes('KOVAN_LINE_OK-12'),
    bellSetsAttention: rang === true,
    replyClearsAttention: afterReply === false,
    renameSticks: renamed?.title === 'renamed by smoke',
    renameKeptSubject: renamed?.subject === subjectBefore,
    running: sessions.list()[0]?.running,
    bufferBytes: sessions.buffer(session.id).data.length,
    runnersFound: runners.length,
    runnerNames: runners.map((r) => r.name).slice(0, 8),
    targets: (await agents.targets()).map((x) => x.label).slice(0, 4),
    promptOk: prompt.includes('KOVAN_REPORT')
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

/**
 * Clicks a quick-model button and waits for the card — a real `opencode run`
 * against the fixture, so it is opt-in (KOVAN_SHOT_QUICK) and allowed to be
 * slow. Captures the running state and the finished card.
 */
async function shootQuick(
  win: BrowserWindow, file: string, label = '', timeoutMs = 180_000
): Promise<Record<string, unknown>> {
  const button = `Array.from(document.querySelectorAll('.detail-actions button.quick-run')).find(b => b.textContent.includes(${JSON.stringify(label)}))`;
  await read(win, `${button}?.click()`);
  await until(win, `document.querySelector('.quick-card')`, 10_000);
  await new Promise((r) => setTimeout(r, 1200));
  await writeFile(file.replace(/\.png$/, '-running.png'), (await win.webContents.capturePage()).toPNG());
  await until(
    win,
    `!Array.from(document.querySelectorAll('.detail-actions button.quick-run')).some(b => b.disabled)`,
    timeoutMs
  );
  await new Promise((r) => setTimeout(r, 300));
  await read(win, `document.querySelector('.quick-card')?.scrollIntoView({ block: 'start' })`);
  await new Promise((r) => setTimeout(r, 200));
  await writeFile(file, (await win.webContents.capturePage()).toPNG());
  console.log(`shot: ${file}`);
  return {
    button: await read(win, `document.querySelector('.detail-actions button.quick-run')?.textContent ?? ''`),
    card: await read(win, `document.querySelector('.quick-card')?.innerText ?? ''`)
  };
}

export async function smokeUi(
  win: BrowserWindow,
  poller: Poller,
  mode: SmokeMode,
  feed?: ActivityFeed,
  sessions?: Sessions
): Promise<Record<string, unknown>> {
  if (mode === 'seeded' || mode === 'workspace') {
    // After the renderer has mounted, not before. `did-finish-load` fires when
    // the document is ready, but React subscribes to this channel in an
    // effect that runs later — a snapshot sent at load time arrives before
    // anyone is listening and is simply dropped, leaving the app on its empty
    // state with no rail to drive.
    await until(win, `document.querySelector('#root')?.children.length > 0`);
    win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
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

  // KOVAN_THEME forces the appearance so both themes can be captured without
  // changing the machine's System Settings.
  if (process.env['KOVAN_THEME']) {
    const { nativeTheme } = await import('electron');
    nativeTheme.themeSource = process.env['KOVAN_THEME'] as 'dark' | 'light';
    await new Promise((r) => setTimeout(r, 400));
  }

  const shot = process.env['KOVAN_SHOT'];
  if (shot) {
    await writeFile(shot, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${shot}`);
  }

  // Items 83–85 on their own: a pull request with nothing to report (the one
  // that blanked the window), the repository on every row, and the
  // "unresolved" chip's wording. `KOVAN_SMOKE_ITEM83=<shot prefix>`.
  // Item 119: mentions and assignments in Activity.
  if (process.env['KOVAN_SMOKE_ITEM119'] && mode === 'seeded') {
    return { item119: await driveItem119(win, process.env['KOVAN_SMOKE_ITEM119']) };
  }

  // Item 127: search everything in the title bar.
  if (process.env['KOVAN_SMOKE_ITEM127'] && mode === 'seeded') {
    return { item127: await driveItem127(win, process.env['KOVAN_SMOKE_ITEM127']) };
  }

  // Item 131: Jira's logo beside a ticket's title, in both themes.
  if (process.env['KOVAN_SMOKE_ITEM139'] && mode === 'seeded') {
    return { item139: await driveItem139(win, process.env['KOVAN_SMOKE_ITEM139']) };
  }
  if (process.env['KOVAN_SMOKE_LINUX'] && mode === 'seeded') {
    return { linux: await driveLinux(win, process.env['KOVAN_SMOKE_LINUX']) };
  }
  if (process.env['KOVAN_SMOKE_SECURITY'] && mode === 'seeded') {
    return { security: await driveSecurity(win, process.env['KOVAN_SMOKE_SECURITY']) };
  }
  if (process.env['KOVAN_SMOKE_ITEM136'] && mode === 'seeded') {
    return { item136: await driveItem136(win, process.env['KOVAN_SMOKE_ITEM136']) };
  }
  if (process.env['KOVAN_SMOKE_ITEM135'] && mode === 'seeded') {
    return { item135: await driveItem135(win, process.env['KOVAN_SMOKE_ITEM135']) };
  }
  if (process.env['KOVAN_SMOKE_ITEM133'] && mode === 'seeded') {
    return { item133: await driveItem133(win, process.env['KOVAN_SMOKE_ITEM133']) };
  }
  if (process.env['KOVAN_SMOKE_ITEM132'] && mode === 'seeded') {
    return { item132: await driveItem132(win, process.env['KOVAN_SMOKE_ITEM132']) };
  }
  if (process.env['KOVAN_SMOKE_ITEM131'] && mode === 'seeded') {
    return { item131: await driveItem131(win, process.env['KOVAN_SMOKE_ITEM131']) };
  }

  // Item 129: a full-screen program's bottom lines survive a trip to another view.
  if (process.env['KOVAN_SMOKE_ITEM129'] && mode === 'seeded') {
    return { item129: await driveItem129(win, process.env['KOVAN_SMOKE_ITEM129']) };
  }

  // Item 126: the shell switch in Sessions' + menu.
  if (process.env['KOVAN_SMOKE_ITEM126'] && mode === 'seeded') {
    return { item126: await driveItem126(win, process.env['KOVAN_SMOKE_ITEM126']) };
  }

  // Item 124: Summarize, Review and Condense, chosen in Settings › Agents.
  if (process.env['KOVAN_SMOKE_ITEM124'] && mode === 'seeded') {
    return { item124: await driveItem124(win, process.env['KOVAN_SMOKE_ITEM124']) };
  }

  // Item 120: connection problems in the status bar.
  if (process.env['KOVAN_SMOKE_ITEM120'] && mode === 'seeded') {
    return { item120: await driveItem120(win, process.env['KOVAN_SMOKE_ITEM120']) };
  }

  // Item 118: the detail header, per density.
  if (process.env['KOVAN_SMOKE_ITEM118'] && mode === 'seeded') {
    return { item118: await driveItem118(win, process.env['KOVAN_SMOKE_ITEM118']) };
  }

  // Items 116, 117: Back / Forward, and the folded run sheet.
  if (process.env['KOVAN_SMOKE_ITEM116'] && mode === 'seeded') {
    return { item116: await driveItem116(win, process.env['KOVAN_SMOKE_ITEM116']) };
  }

  // Items 112, 114, 115: status badges, the hover card, the terminal host.
  if (process.env['KOVAN_SMOKE_ITEM112'] && mode === 'seeded' && sessions) {
    return { item112: await driveItem112(win, sessions, process.env['KOVAN_SMOKE_ITEM112']) };
  }

  // Item 110, the header's link row: `KOVAN_SMOKE_ITEM110=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM110'] && mode === 'seeded') {
    return { item110: await driveItem110(win, process.env['KOVAN_SMOKE_ITEM110']) };
  }

  // Item 108, plan limits in the run sheet: `KOVAN_SMOKE_ITEM108=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM108'] && mode === 'seeded') {
    return { item108: await driveItem108(win, process.env['KOVAN_SMOKE_ITEM108']) };
  }

  // Item 101, the startup list: `KOVAN_SMOKE_ITEM101=<shot prefix>` (mode 1).
  if (process.env['KOVAN_SMOKE_ITEM101'] && mode === '1') {
    return { item101: await driveItem101(win, process.env['KOVAN_SMOKE_ITEM101']) };
  }

  // Item 104, closing a running session: `KOVAN_SMOKE_ITEM104=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM104'] && mode === 'seeded' && sessions) {
    return { item104: await driveItem104(win, sessions, process.env['KOVAN_SMOKE_ITEM104']) };
  }

  // Item 99, Settings as one searchable list: `KOVAN_SMOKE_ITEM99=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM99'] && mode === 'seeded') {
    return { item99: await driveItem99(win, process.env['KOVAN_SMOKE_ITEM99']) };
  }

  // Item 100, ⌘P: `KOVAN_SMOKE_ITEM100=<shot prefix>` with KOVAN_WS_FOLDER.
  if (process.env['KOVAN_SMOKE_ITEM100'] && mode === 'seeded') {
    return { item100: await driveItem100(win, process.env['KOVAN_SMOKE_ITEM100']) };
  }

  // Item 98, the run viewer over a docked terminal: `KOVAN_SMOKE_ITEM98=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM98'] && mode === 'seeded' && sessions) {
    return { item98: await driveItem98(win, sessions, process.env['KOVAN_SMOKE_ITEM98']) };
  }

  // Item 97, speech providers: `KOVAN_SMOKE_ITEM97=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM97'] && mode === 'seeded') {
    return { item97: await driveItem97(win, process.env['KOVAN_SMOKE_ITEM97']) };
  }

  // Item 96, the themes: `KOVAN_SMOKE_ITEM96=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM96'] && mode === 'seeded' && sessions) {
    return { item96: await driveItem96(win, sessions, process.env['KOVAN_SMOKE_ITEM96']) };
  }

  // Items 93 and 94 together: `KOVAN_SMOKE_ITEM93=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM93'] && mode === 'seeded') {
    return { item93: await driveItems93and94(win, process.env['KOVAN_SMOKE_ITEM93']) };
  }

  // Item 92 (fixes 3 and 4) on its own: `KOVAN_SMOKE_ITEM92=1`.
  if (process.env['KOVAN_SMOKE_ITEM92'] && mode === 'seeded') {
    return { item92: await driveItem92(win) };
  }

  // Item 91 on its own: `KOVAN_SMOKE_ITEM91=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM91'] && mode === 'seeded') {
    return { item91: await driveItem91(win, process.env['KOVAN_SMOKE_ITEM91']) };
  }

  // Item 90 (C + D) on its own: `KOVAN_SMOKE_ITEM90=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM90'] && mode === 'seeded' && sessions) {
    return { item90: await driveItem90(win, sessions, process.env['KOVAN_SMOKE_ITEM90']) };
  }

  // Item 89 on its own: `KOVAN_SMOKE_ITEM89=<shot prefix>`.
  if (process.env['KOVAN_SMOKE_ITEM89'] && mode === 'seeded') {
    return { item89: await driveItem89(win, process.env['KOVAN_SMOKE_ITEM89']) };
  }

  // Item 88 on its own: `KOVAN_SMOKE_ITEM88=<shot prefix>` with
  // KOVAN_DICTATE_FAKE=1 — real key events, scripted words.
  if (process.env['KOVAN_SMOKE_ITEM88'] && mode === 'seeded') {
    return { item88: await driveItem88(win, process.env['KOVAN_SMOKE_ITEM88']) };
  }

  // Item 86 on its own: `KOVAN_SMOKE_ITEM86=<shot prefix>`. Snapshots go
  // through the real ActivityFeed in main, not straight to the window.
  if (process.env['KOVAN_SMOKE_ITEM86'] && mode === 'seeded' && feed) {
    return { item86: await driveItem86(win, feed, process.env['KOVAN_SMOKE_ITEM86']) };
  }
  if (process.env['KOVAN_SMOKE_ITEM83'] && mode === 'seeded') {
    return { item83: await driveItem83(win, process.env['KOVAN_SMOKE_ITEM83']) };
  }

  // --- Items 49–52, 55: sidebar size, ⌘F, rail collapse, sheet close ------
  if (process.env['KOVAN_SHOT_ITEMS_49']) {
    const prefix = process.env['KOVAN_SHOT_ITEMS_49'];
    const snap = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    const key = async (keyCode: string) => {
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['meta'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['meta'] });
      await new Promise((r) => setTimeout(r, 300));
    };
    const report: Record<string, unknown> = {};

    // ⌘+ after clicking in the sidebar sizes the sidebar, not the terminal.
    await read(win, `document.querySelector('.queue-list').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    const terminalBefore = await read(win, `localStorage.getItem('kovan.terminal-font-size')`);
    await key('=');
    await key('=');
    report['sidebarZoom'] = await read(win, `getComputedStyle(document.querySelector('.queue-head')).zoom`);
    report['queueWidthUnchanged'] = await read(win, `document.querySelector('.queue').getBoundingClientRect().width`);
    report['terminalUntouched'] = terminalBefore === (await read(win, `localStorage.getItem('kovan.terminal-font-size')`));
    await snap('sidebar-120');
    await key('-');
    await key('-');
    report['sidebarZoomBack'] = await read(win, `getComputedStyle(document.querySelector('.queue-head')).zoom`);

    // ⌘F lands in the filter.
    await read(win, `document.activeElement?.blur()`);
    await key('f');
    report['cmdFFocusesFilter'] = await read(win, `document.activeElement?.id === 'q'`);

    // The active rail icon folds the sidebar away, and brings it back.
    await read(win, `document.querySelector('.rail-item.active')?.click()`);
    await new Promise((r) => setTimeout(r, 150));
    report['collapsed'] = await read(win, `getComputedStyle(document.querySelector('.queue')).display === 'none'`);
    await snap('collapsed');
    await key('f');
    report['cmdFReopens'] = await read(win, `getComputedStyle(document.querySelector('.queue')).display !== 'none' && document.activeElement?.id === 'q'`);

    // Settings closes with an ✕, and Token prices offers the online check.
    await read(win, `document.querySelector('.rail-item[aria-label="Settings"]')?.click()`);
    await until(win, `document.querySelector('.settings-list')`, 5_000);
    report['closeIsIcon'] = await read(win, `Boolean(document.querySelector('.sheet-head button[aria-label="Close"] svg'))`);
    await read(win, `document.querySelector('.settings-row[data-section="agents"]:not(.open) .settings-row-head')?.click()`);
    await new Promise((r) => setTimeout(r, 150));
    await read(win, `Array.from(document.querySelectorAll('.settings button')).find(b => b.textContent.includes('Check prices online'))?.click()`);
    await new Promise((r) => setTimeout(r, 150));
    await read(win, `document.querySelector('.price-check')?.scrollIntoView({ block: 'center' })`);
    report['priceCheckPanel'] = await read(win, `document.querySelector('.price-check select')?.value`);
    await snap('prices');
    await read(win, `document.querySelector('.sheet-head .icon-button')?.scrollIntoView()`);
    await snap('settings-head');
    await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
    await until(win, `!document.querySelector('.settings-list')`, 5_000);
    console.log('items49:', JSON.stringify(report));
  }

  // --- Items 46, 47, 57: reviewer picker, quick model tag, model dropdown ---
  if (process.env['KOVAN_SHOT_ITEMS_46']) {
    const prefix = process.env['KOVAN_SHOT_ITEMS_46'];
    const snap = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    const report: Record<string, unknown> = {};
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, `document.querySelector('.detail-side')`, 10_000);
    await until(win, `document.querySelector('.reviewer-input')`, 10_000);

    // 46: focus the picker, see the candidates, request one.
    await read(win, `document.querySelector('.reviewer-input').focus()`);
    await until(win, `document.querySelector('.reviewer-option')`, 5_000);
    report['candidates'] = await read(win, `Array.from(document.querySelectorAll('.reviewer-option-name')).map(n => n.textContent)`);
    await new Promise((r) => setTimeout(r, 150));
    await snap('reviewers');
    await read(win, `document.querySelector('.reviewer-option')?.click()`);
    await until(win, `document.querySelector('.reviewer-asked')`, 5_000);
    report['asked'] = await read(win, `document.querySelector('.reviewer-asked')?.textContent`);
    report['history'] = (await read(win, `window.kovan.settings()`) as Record<string, unknown>)['reviewers.history'];

    // 47: the tags name their models; the picker lists opencode's.
    report['tags'] = await read(win, `Array.from(document.querySelectorAll('.quick-model')).map(b => b.textContent)`);
    await read(win, `document.querySelector('.detail-actions')?.scrollIntoView({ block: 'start' })`);
    await read(win, `document.querySelector('.quick-model')?.click()`);
    await until(win, `document.querySelector('.quick-model-list button')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    report['pickerModels'] = await read(win, `Array.from(document.querySelectorAll('.quick-model-list .quick-model-id')).map(n => n.textContent)`);
    await snap('quick-model');
    await read(win, `Array.from(document.querySelectorAll('.quick-model-field select option')).map(o => o.value).includes('openai') && (() => {
      const sel = document.querySelector('.quick-model-field select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'openai');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 100));
    await read(win, `document.querySelector('.quick-model-list button')?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    report['tagAfterPick'] = await read(win, `document.querySelector('.quick-model')?.textContent`);
    report['savedQuickModels'] = (await read(win, `window.kovan.settings()`) as Record<string, unknown>)['quick.models'];

    // 57: the run sheet's dropdown and its ↻.
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.model-field select')`, 5_000);
    report['modelOptionsBefore'] = await read(win, `Array.from(document.querySelectorAll('.model-field select option')).map(o => o.textContent)`);
    await read(win, `document.querySelector('.model-field .icon-button')?.click()`);
    await until(win, `Array.from(document.querySelectorAll('.model-field select option')).some(o => o.textContent.includes('new'))`, 10_000);
    report['modelOptionsAfter'] = await read(win, `Array.from(document.querySelectorAll('.model-field select option')).map(o => o.textContent)`);
    report['modelNote'] = await read(win, `document.querySelector('.model-field-note')?.textContent`);
    await snap('run-model');
    await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);

    // 58: more than one folder. Two scratch folders stand in for two clones.
    const folders = process.env['KOVAN_SMOKE_FOLDERS']?.split(',') ?? [];
    await read(win, `window.kovan.setSetting('repos.folders', ${JSON.stringify(folders)})`);
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.folder-button:not(:disabled)')`, 10_000);
    await until(win, `!document.querySelector('.folder-button-text')?.textContent.startsWith('Choose')`, 5_000);
    await read(win, `document.querySelector('.folder-button')?.click()`);
    await until(win, `document.querySelector('.folder-option')`, 5_000);
    await read(win, `Array.from(document.querySelectorAll('.folder-option input')).find(i => !i.checked)?.click()`);
    await new Promise((r) => setTimeout(r, 150));
    report['folderSummary'] = await read(win, `document.querySelector('.folder-button-text')?.textContent`);
    report['folderNote'] = await read(win, `document.querySelector('.folder-field .model-field-note')?.textContent`);
    report['folderRows'] = await read(win, `Array.from(document.querySelectorAll('.folder-option')).map(r => r.innerText.replace(/\\s+/g, ' '))`);
    report['agentLoadedLater'] = await until(win, `document.querySelector('.run-controls select')?.value`, 15_000).then(() => true, () => false);
    report['agentValue'] = await read(win, `document.querySelector('.run-controls select')?.value`);
    await snap('folders');
    await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
    console.log('items46:', JSON.stringify(report));
  }

  if (process.env['KOVAN_SHOT_TICKET_PULLS']) {
    const report: Record<string, unknown> = {};
    await read(win, `document.querySelector('.rail-item[aria-label="Tickets"]')?.click()`);
    await until(win, `Array.from(document.querySelectorAll('.queue .row')).some(r => r.innerText.includes('ACME-2393'))`, 10_000);
    await read(win, `Array.from(document.querySelectorAll('.queue .row')).find(r => r.innerText.includes('ACME-2393')).click()`);
    await until(win, `document.querySelector('.linked-pull')`, 10_000);
    report['rows'] = await read(win, `Array.from(document.querySelectorAll('.linked-pull')).map(b => b.innerText.split('\\n').join(' | '))`);
    report['inHeader'] = await read(win, `Boolean(document.querySelector('.detail-head .linked-pulls'))`);
    report['chipsGone'] = await read(win, `!document.querySelector('.detail-head .detail-related')`);
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(process.env['KOVAN_SHOT_TICKET_PULLS'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['KOVAN_SHOT_TICKET_PULLS']}`);
    await read(win, `document.querySelectorAll('.linked-pull')[1].click()`);
    await until(win, `document.querySelector('.rail-item.active')?.getAttribute('aria-label') === 'Pull requests'`, 5_000);
    report['opened'] = await read(win, `[document.querySelector('.rail-item.active')?.getAttribute('aria-label'), document.querySelector('.detail-pill-repo')?.textContent]`);
    console.log('ticketPulls:', JSON.stringify(report));
  }

  if (process.env['KOVAN_SHOT_AGENT_REPORT']) {
    const prefix = process.env['KOVAN_SHOT_AGENT_REPORT'];
    const report: Record<string, unknown> = {};
    const store = new RunStore(RunStore.rootFor(app.getPath('userData')));
    const run = await store.begin({ subject: 'ACME-2393', pull: 'acme/web#118', kind: 'verify', prompt: 'Check it shipped.' });
    await writeFile(path.join(run.directory, 'report.md'),
      'VERDICT: implemented\n\nChecked acme/web#118 live on dev with a real browser, signed in as the teacher account.\n\n' +
      Array.from({ length: 18 }, (_, i) => `${i + 1}. Behaviour ${i + 1} of the pull request is live (0${i}-shot.png).`).join('\n') + '\n', 'utf8');
    await writeFile(path.join(run.directory, 'shots', '01-landing.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    const card = `document.querySelector('.agent-report')`;
    // The ticket shows it, and so does the pull request it was started from.
    await read(win, `document.querySelector('.rail-item[aria-label="Tickets"]')?.click()`);
    await until(win, `Array.from(document.querySelectorAll('.queue .row')).some(r => r.innerText.includes('ACME-2393'))`, 10_000);
    await read(win, `Array.from(document.querySelectorAll('.queue .row')).find(r => r.innerText.includes('ACME-2393')).click()`);
    await until(win, card, 10_000);
    report['ticketCard'] = await read(win, `${card}.querySelector('.quick-card-head').innerText.split('\\n').join(' | ')`);
    report['folded'] = await read(win, `Boolean(${card}.querySelector('.agent-report-body.folded'))`);
    if (process.env['KOVAN_SHOT_LIGHTBOX']) {
      report['lightbox'] = await driveLightbox(win, path.join(run.directory, 'shots'));
    }
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(`${prefix}-ticket.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-ticket.png`);
    await read(win, `document.querySelector('.linked-pull:nth-child(2)')?.click()`);
    await until(win, `document.querySelector('.detail-pill-repo')?.textContent === 'acme/web #118'`, 10_000);
    report['pullCard'] = await until(win, card, 10_000).then(() => true, () => false);
    await read(win, `Array.from(document.querySelectorAll('.rows .row')).find(r => r.innerText.trim().startsWith('42'))?.click()`);
    await until(win, `document.querySelector('.detail-pill-repo')?.textContent === 'acme/web #42'`, 10_000);
    await new Promise((r) => setTimeout(r, 500));
    report['otherPullHasNone'] = await read(win, `!${card}`);
    console.log('agentReport:', JSON.stringify(report));
  }

  if (process.env['KOVAN_SHOT_ITEMS_60']) {
    const prefix = process.env['KOVAN_SHOT_ITEMS_60'];
    const report: Record<string, unknown> = {};
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, `document.querySelector('.detail-pill-repo')`, 10_000);
    const [, repo, num] = /^(\S+) #(\d+)$/.exec(String(await read(win, `document.querySelector('.detail-pill-repo').textContent`)).trim()) ?? [];
    const subject = `${repo}#${num}`;
    // 62: the pill and the line under it no longer repeat one state.
    report['pill'] = await read(win, `document.querySelector('.status-pill')?.textContent`);
    report['stateLine'] = await read(win, `document.querySelector('.detail-states')?.innerText.split('\\n').join(' · ') ?? '(none)'`);
    // 60: a saved review, and its Copy.
    await mkdir(path.join(app.getPath('userData'), 'quick'), { recursive: true });
    const text = '## Summary\nNot ready.\n\n## Must fix\n- `src/a.ts:4`: anchor the actions to the scroll container.';
    await writeFile(
      path.join(app.getPath('userData'), 'quick', `${subject.replace(/[/\\:]/g, '_')}.json`),
      JSON.stringify({ 'pull-review': {
        kind: 'pull-review', subject, model: 'moonshotai/kimi-k3 (nv-review)', createdAt: new Date().toISOString(),
        basis: reviewBasis(detailFixture(repo!, Number(num))), verdict: 'request_changes', text
      } }),
      'utf8'
    );
    await read(win, `document.querySelectorAll('.rows .row')[1]?.click()`);
    await new Promise((r) => setTimeout(r, 500));
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, `document.querySelector('.quick-copy')`, 10_000);
    await clipboard.writeText('');
    await read(win, `document.querySelector('.quick-copy').click()`);
    await until(win, `document.querySelector('.quick-copy.copied')`, 5_000);
    report['copied'] = (await clipboard.readText()) === text;
    report['button'] = await read(win, `document.querySelector('.quick-copy').textContent`);
    await read(win, `document.querySelector('.quick-copy').closest('.quick-card').scrollIntoView({ block: 'start' })`);
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(`${prefix}-copy.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-copy.png`);
    // Folding: the review card's title folds it, and it stays folded for this PR.
    const reviewCard = `Array.from(document.querySelectorAll('.quick-card')).find(c => c.querySelector('.card-toggle')?.textContent === 'Code review')`;
    await read(win, `${reviewCard}.querySelector('.card-toggle').click()`);
    await new Promise((r) => setTimeout(r, 150));
    report['foldedHidesBody'] = await read(win, `!${reviewCard}.querySelector('.quick-card-body')`);
    await writeFile(`${prefix}-folded.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-folded.png`);
    await read(win, `document.querySelectorAll('.rows .row')[1]?.click()`);
    await new Promise((r) => setTimeout(r, 500));
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, reviewCard, 10_000);
    report['stillFolded'] = await read(win, `${reviewCard}.querySelector('.card-toggle').getAttribute('aria-expanded') === 'false'`);
    await read(win, `${reviewCard}.querySelector('.card-toggle').click()`);
    await new Promise((r) => setTimeout(r, 150));
    report['unfolds'] = await read(win, `Boolean(${reviewCard}.querySelector('.quick-card-body'))`);
    console.log('items60:', JSON.stringify(report));
  }

  if (process.env['KOVAN_SHOT_ITEMS_63']) {
    const prefix = process.env['KOVAN_SHOT_ITEMS_63'];
    const snap = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const report: Record<string, unknown> = {};
    const railTo = (label: string) => read(win, `document.querySelector('.rail-item[aria-label="${label}"]')?.click()`);

    // 66, 67: the review's picker offers nv-review and opencode; one menu at a time.
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, `document.querySelectorAll('.quick-model').length >= 2`, 10_000);
    report['buttons'] = await read(win, `Array.from(document.querySelectorAll('.quick-run')).map(b => b.textContent)`);
    await read(win, `document.querySelectorAll('.quick-model')[0].click()`);
    await until(win, `document.querySelector('.quick-model-menu')`, 5_000);
    await read(win, `document.querySelectorAll('.quick-model')[1].click()`);
    await until(win, `document.querySelector('.quick-model-field select option[value="nv-review"]')`, 5_000);
    await until(win, `document.querySelectorAll('.quick-model-field select option').length > 2`, 10_000);
    report['menusOpen'] = await read(win, `document.querySelectorAll('.quick-model-menu').length`);
    report['reviewProviders'] = await read(win, `Array.from(document.querySelectorAll('.quick-model-field select option')).map(o => o.textContent)`);
    await read(win, `document.querySelector('.quick-model-type')?.click()`);
    await until(win, `document.querySelector('.quick-model-other input')`, 5_000);
    await pause(150);
    await snap('review-picker');
    await read(win, `(() => {
      const sel = document.querySelector('.quick-model-field select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'openai');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await pause(150);
    await read(win, `document.querySelector('.quick-model-list button')?.click()`);
    await pause(400);
    report['reviewTagAfterPick'] = await read(win, `document.querySelectorAll('.quick-model')[1]?.textContent`);
    report['reviewSettings'] = await read(win, `window.kovan.settings().then(s => [s['review.runner'], (s['quick.models'] || {})['pull-review']])`);
    // Back to nv-review, as the user had it.
    await read(win, `window.kovan.quickModelSet('pull-review', 'moonshotai/kimi-k3 (nv-review)')`);

    // 63: every workflow status in the tickets filter.
    await railTo('Tickets');
    await until(win, `document.querySelector('[aria-label="Filter tickets"]')`, 10_000);
    await read(win, `document.querySelector('[aria-label="Filter tickets"]').click()`);
    await until(win, `Array.from(document.querySelectorAll('.filter-option-name')).some(n => n.textContent === 'In Development')`, 10_000);
    report['statuses'] = await read(win, `Array.from(document.querySelectorAll('.filter-group')[0].querySelectorAll('.filter-option')).map(r => r.innerText.replace(/\s+/g, ' '))`);
    await pause(150);
    await snap('statuses');
    await read(win, `document.body.click()`);

    // 68, 69, 65, 70 in Sessions: two terminals, a program title, a split that survives a tab switch.
    const cwd = process.env['KOVAN_SMOKE_FOLDERS']?.split(',')[0] ?? process.cwd();
    const a = await read(win, `window.kovan.openTerminal(${JSON.stringify(cwd)}).then(s => s.id)`) as string;
    const b = await read(win, `window.kovan.openTerminal(${JSON.stringify(cwd)}).then(s => s.id)`) as string;
    await pause(1500);
    await read(win, `window.kovan.sessionWrite(${JSON.stringify(a)}, "printf '\\\\033]0;\\\\342\\\\234\\\\263 Investigate ACME-2409\\\\007'\\r")`);
    await until(win, `window.kovan.sessions().then(l => l.some(s => s.task))`, 8_000).catch(() => undefined);
    report['task'] = await read(win, `window.kovan.sessions().then(l => l.map(s => [s.title, s.task, s.subject]))`);
    await read(win, `localStorage.setItem('kovan.session-panes', JSON.stringify({ focusedLeafId: 'l1', tree: {
      type: 'split', id: 's1', orientation: 'row', children: [
        { node: { type: 'leaf', id: 'l1', sessions: [${JSON.stringify(a)}], active: ${JSON.stringify(a)} }, size: 0.5 },
        { node: { type: 'leaf', id: 'l2', sessions: [${JSON.stringify(b)}], active: ${JSON.stringify(b)} }, size: 0.5 }
      ] } }))`);
    await railTo('Sessions');
    await until(win, `document.querySelectorAll('.pane-leaf').length >= 1`, 10_000);
    report['leavesFirst'] = await read(win, `document.querySelectorAll('.pane-leaf').length`);
    await railTo('Pull requests');
    await pause(500);
    await railTo('Sessions');
    await until(win, `document.querySelectorAll('.pane-leaf').length >= 1`, 10_000);
    report['leavesAfterSwitch'] = await read(win, `document.querySelectorAll('.pane-leaf').length`);
    report['rowTitles'] = await read(win, `Array.from(document.querySelectorAll('.queue .row-title')).map(n => n.textContent)`);

    // 70: a running quick job next to finished ones.
    await read(win, `window.kovan.quickRun('pull-summary', 'acme/web#205')`);
    await until(win, `document.querySelector('.row.quick-job.running')`, 10_000).catch(() => undefined);
    report['jobStates'] = await read(win, `Array.from(document.querySelectorAll('.row.quick-job')).map(r => r.className + ' | ' + r.querySelector('.quick-job-state')?.textContent)`);

    // Reorder: drag the second session row above the first, then ⌥↓ it back.
    const rowIds = () => read(win, `Array.from(document.querySelectorAll('[data-session-row]')).map(r => r.dataset.sessionRow)`) as Promise<string[]>;
    report['orderBefore'] = await rowIds();
    {
      let attached = false;
      try { win.webContents.debugger.attach('1.3'); attached = true; } catch { /* already attached */ }
      const mouse = (type: string, x: number, y: number, buttons: number) =>
        win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse' });
      const box = (i: number) => read(win, `(() => { const r = document.querySelectorAll('[data-session-row]')[${i}].getBoundingClientRect(); return { x: Math.round(r.x + 40), top: Math.round(r.top), mid: Math.round(r.top + r.height / 2) }; })()`) as Promise<{ x: number; top: number; mid: number }>;
      const from = await box(1);
      const to = await box(0);
      await mouse('mousePressed', from.x, from.mid, 1);
      for (let i = 1; i <= 8; i += 1) {
        await mouse('mouseMoved', from.x, Math.round(from.mid + (to.top + 3 - from.mid) * (i / 8)), 1);
        await pause(20);
      }
      report['dropLine'] = await read(win, `Boolean(document.querySelector('.row.drop-before'))`);
      await snap('reorder');
      await mouse('mouseReleased', from.x, to.top + 3, 0);
      if (attached) win.webContents.debugger.detach();
    }
    await pause(300);
    report['orderAfterDrag'] = await rowIds();
    report['orderSaved'] = await read(win, `JSON.parse(localStorage.getItem('kovan.session-order') || '[]')`);
    await read(win, `document.querySelector('[data-session-row]').focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['alt'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['alt'] });
    await pause(300);
    report['orderAfterKey'] = await rowIds();

    // Hovering a row must not change its height: reveal its hover icons as :hover would.
    report['rowHeights'] = await read(win, `(() => {
      const row = document.querySelector('.queue .row.one-line');
      const before = row.getBoundingClientRect().height;
      const icons = Array.from(row.querySelectorAll('.icon-button.rename, .icon-button.session-close, .icon-button.open-link'));
      icons.forEach(i => { i.style.display = 'grid'; });
      const after = row.getBoundingClientRect().height;
      icons.forEach(i => { i.style.display = ''; });
      return [before, after];
    })()`);
    // 65: the close asks first, and Cancel keeps the session.
    await read(win, `document.querySelector('.queue .session-close')?.click()`);
    await until(win, `document.querySelector('.session-close-confirm')`, 5_000);
    report['confirmText'] = await read(win, `document.querySelector('.session-close-confirm')?.innerText.replace(/\s+/g, ' ')`);
    report['focused'] = await read(win, `document.activeElement?.textContent`);
    await pause(150);
    await snap('sessions');
    await read(win, `Array.from(document.querySelectorAll('.session-close-confirm button')).find(b => b.textContent === 'Cancel')?.click()`);
    await pause(200);
    report['sessionsAfterCancel'] = await read(win, `window.kovan.sessions().then(l => l.length)`);
    await read(win, `window.kovan.quickCancel('pull-summary', 'acme/web#205')`);
    // Leave the app as the rest of the run expects it.
    await read(win, `window.kovan.sessionClose(${JSON.stringify(a)})`);
    await read(win, `window.kovan.sessionClose(${JSON.stringify(b)})`);
    await read(win, `localStorage.removeItem('kovan.session-panes')`);
    await railTo('Pull requests');
    await pause(500);
    console.log('items63:', JSON.stringify(report));
  }

  if (process.env['KOVAN_SHOT_ITEM_59']) {
    const prefix = process.env['KOVAN_SHOT_ITEM_59'];
    const snap = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    const report: Record<string, unknown> = {};
    const toggle = `document.querySelector('.detail-main .section-toggle')`;
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, toggle, 10_000);
    await snap('open');
    await read(win, `${toggle}.click()`);
    await new Promise((r) => setTimeout(r, 150));
    report['collapsedHasProse'] = await read(win, `!!document.querySelector('.collapsible .prose')`);
    report['expanded'] = await read(win, `${toggle}.getAttribute('aria-expanded')`);
    await snap('collapsed');
    // Another PR keeps its own state; coming back keeps this one folded.
    await read(win, `document.querySelectorAll('.rows .row')[1]?.click()`);
    await new Promise((r) => setTimeout(r, 600));
    report['otherExpanded'] = await read(win, `${toggle}?.getAttribute('aria-expanded') ?? 'no description'`);
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, toggle, 10_000);
    report['backExpanded'] = await read(win, `${toggle}.getAttribute('aria-expanded')`);
    report['stored'] = await read(win, `localStorage.getItem('kovan.collapsed-descriptions')`);
    console.log('item59:', JSON.stringify(report));
  }

  if (process.env['KOVAN_SHOT_PULL_FILTER']) {
    await read(win, `document.querySelector('[aria-label="Filter pull requests"]')?.click()`);
    await until(win, `document.querySelector('.filter-menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['KOVAN_SHOT_PULL_FILTER'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_PULL_FILTER']}`);
    await read(win, `document.body.click()`);
    await new Promise((r) => setTimeout(r, 100));
  }

  // --- Sorting pull requests — the icon used to do nothing at all -----------
  if (process.env['KOVAN_SHOT_PULL_SORT']) {
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
      process.env['KOVAN_SHOT_PULL_SORT'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_PULL_SORT']}`);

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

    if (process.env['KOVAN_SHOT_PULL_SORTED']) {
      await writeFile(
        process.env['KOVAN_SHOT_PULL_SORTED'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_PULL_SORTED']}`);
    }
  }

  // --- Two run buttons of different weight on the same pull request ---------
  // A pull request the viewer owns and that has not merged shows both
  // "Unblock in an agent" (writes code) and "Check it shipped" (only judges)
  // — the two used to be visually identical. `idrisay`'s own #118 in Open is
  // exactly that case.
  if (process.env['KOVAN_SHOT_RUN_BUTTONS']) {
    await read(
      win,
      `Array.from(document.querySelectorAll('.rows .row .row-num'))
        .find(e => e.textContent === '118')?.closest('button')?.click()`
    );
    await until(win, `document.querySelector('.detail-actions .primary.outline')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['KOVAN_SHOT_RUN_BUTTONS'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_RUN_BUTTONS']}`);

    // Item 28: the same buttons in light mode, where the outline one used to
    // inherit the solid button's near-white label and come out empty.
    await read(win, `window.kovan.setSetting('appearance.theme', 'light')`);
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
      `${process.env['KOVAN_SHOT_RUN_BUTTONS']}`.replace(/\.png$/, '-light.png'),
      (await win.webContents.capturePage()).toPNG()
    );
    console.log('runButtonsLight:', JSON.stringify(outlineInLight));
    await read(win, `window.kovan.setSetting('appearance.theme', 'dark')`);
    await read(win, `document.documentElement.dataset.theme = 'dark'`);
    await new Promise((r) => setTimeout(r, 200));
  }

  // --- The run sheet's model field, and remembering the last one picked -----
  if (process.env['KOVAN_SHOT_RUN_MODEL']) {
    await read(win, `document.querySelector('.rows .row')?.click()`);
    await until(win, `document.querySelector('.detail-actions .primary')`, 5_000);
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.run-controls select')?.value`, 5_000);
    await new Promise((r) => setTimeout(r, 150));

    const modelField = () =>
      read(
        win,
        `(() => { const i = document.querySelector('.model-field select, .model-field input');
          return i ? { value: i.value, placeholder: i.placeholder || i.options?.[0]?.text } : null; })()`
      );
    const options = await read(
      win,
      `Array.from(document.querySelectorAll('.model-field select option')).map(o => o.value).filter(v => v && v !== '__other__')`
    );
    const before = await modelField();

    await writeFile(
      process.env['KOVAN_SHOT_RUN_MODEL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_RUN_MODEL']}`);

    // Pick a model and cancel — a run sheet closed without running must not
    // remember anything, only one actually started does.
    await read(
      win,
      `(() => { const i = document.querySelector('.model-field select');
        if (!i) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(i, 'opus');
        i.dispatchEvent(new Event('change', { bubbles: true }));
       })()`
    );
    const afterTyping = await modelField();
    await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
    await new Promise((r) => setTimeout(r, 100));
    const forgottenAfterCancel = (
      await read(win, `window.kovan.settings()`) as { 'runner.lastModel'?: Record<string, string> }
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
      `(() => { const i = document.querySelector('.model-field select');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(i, 'sonnet');
        i.dispatchEvent(new Event('change', { bubbles: true }));
       })()`
    );
    await until(win, `document.querySelector('.sheet-foot .primary:not(:disabled)')`, 10_000);
    await read(win, `document.querySelector('.sheet-foot .primary')?.click()`);
    await until(win, `document.querySelector('.detail-terminal')`, 10_000);
    await new Promise((r) => setTimeout(r, 300));
    const rememberedAfterRun = (
      await read(win, `window.kovan.settings()`) as { 'runner.lastModel'?: Record<string, string> }
    )['runner.lastModel']?.['claude'];

    // Reopening the sheet for the same agent should come back prefilled.
    await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
    await until(win, `document.querySelector('.run-controls select')?.value`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    const prefilled = await modelField();
    await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);

    console.log(
      'runModelRemembered:',
      JSON.stringify({ rememberedAfterRun, prefilled })
    );
  }

  // --- The bottom status bar -------------------------------------------------
  if (process.env['KOVAN_SHOT_STATUSBAR']) {
    await writeFile(
      process.env['KOVAN_SHOT_STATUSBAR'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_STATUSBAR']}`);

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
  if (process.env['KOVAN_SHOT_REFRESH_MENU']) {
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
      process.env['KOVAN_SHOT_REFRESH_MENU'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_REFRESH_MENU']}`);

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

  if (process.env['KOVAN_SHOT_PR_INLINE_TERMINAL']) {
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
      process.env['KOVAN_SHOT_PR_INLINE_TERMINAL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_PR_INLINE_TERMINAL']}`);
  }

  // --- The quick terminal: scoped to looking at one ticket/PR, not a run ----
  // Opened from the "Terminal" button rather than a run sheet, and closed the
  // moment you navigate to a different pull request — unlike an agent run's
  // session, which is meant to outlive the pane it was started from.
  if (process.env['KOVAN_SHOT_QUICK_TERMINAL']) {
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
        const original = window.kovan.sessionResize.bind(window.kovan);
        window.kovan.sessionResize = (...args) => { window.__resizeCalls += 1; return original(...args); };
      })()`
    );

    const openQuickTerminal = () =>
      read(
        win,
        `Array.from(document.querySelectorAll('.detail-related .detail-place'))
          .find(b => b.textContent.includes('Terminal'))?.click()`
      );

    await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
    await until(win, `document.querySelector('.detail-actions .ghost')`, 5_000);
    await openQuickTerminal();
    await until(win, `document.querySelector('.detail-terminal')`, 10_000);
    await new Promise((r) => setTimeout(r, 1_500));
    await writeFile(
      process.env['KOVAN_SHOT_QUICK_TERMINAL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_QUICK_TERMINAL']}`);
    console.log('resizeCallsAfterSettling:', await read(win, `window.__resizeCalls`));

    // A quick terminal is filed under its ticket/PR the same way a run's
    // session is: navigating to a different one and back should find the
    // *same* session still there, not gone — that's the whole point of
    // docking it by subject rather than by "whatever is currently open".
    const sessionsBefore = await read(win, `window.kovan.sessions()`) as { id: string }[];
    await read(win, `document.querySelectorAll('.rows .row')[1]?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    const hiddenOnOtherPull = !(await read(win, `document.querySelector('.detail-terminal')`));
    await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    const reappeared = await read(win, `Boolean(document.querySelector('.detail-terminal'))`);
    const sessionsAfter = await read(win, `window.kovan.sessions()`) as { id: string }[];
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
      await win.webContents.debugger.sendCommand('Input.insertText', { text: 'echo KOVAN_TYPED_OK' });
      win.webContents.debugger.detach();
    }
    await new Promise((r) => setTimeout(r, 600));
    const typedVisible = await read(
      win,
      `document.querySelector('.term')?.textContent?.includes('KOVAN_TYPED_OK') ?? false`
    );
    console.log('quickTerminalKeystrokeVisible:', JSON.stringify({ attached, typedVisible }));
  }

  // --- Moving the inline terminal to each of its four docks -----------------
  // The complaint this answers: a run's terminal always landed at the bottom
  // of the pane with no way to move it. Checked the same way the sidebar
  // splitter is — real mouse events through the debugger protocol, because a
  // handler that only reacts to `pointermove` needs actual pointer capture,
  // which a dispatched DOM event cannot grant itself.
  if (process.env['KOVAN_SHOT_TERMINAL_DOCK']) {
    const prefix = process.env['KOVAN_SHOT_TERMINAL_DOCK'];
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
        storedDock: await read(win, `localStorage.getItem('kovan.terminal-dock')`),
        storedWidth: await read(win, `localStorage.getItem('kovan.terminal-width')`)
      })
    );
  }

  // --- The Sessions tab: items 22-27 ---------------------------------------
  // One session, driven through every one of them in order: the identifier in
  // its name is a way back to the ticket (22), its name is on the pane at all
  // (24), the font size is settable from the UI (25), renaming sticks (27),
  // and closing it leaves an instruction rather than a dead terminal (26).
  if (process.env['KOVAN_SHOT_SESSIONS']) {
    const prefix = process.env['KOVAN_SHOT_SESSIONS'];
    const shot = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };

    // An explicit cwd, since a smoke run's own user data has no watched
    // folders to fall back on. Two sessions, on a fixture ticket and a
    // fixture pull request, so the identifier in each name has something real
    // to resolve back to — one of each kind the row can jump to.
    const cwd = JSON.stringify(process.cwd());
    await read(win, `window.kovan.openTerminal(${cwd}, 'acme/web#42', 'review · acme/web#42')`);
    await read(win, `window.kovan.openTerminal(${cwd}, 'ACME-2393', 'implement · ACME-2393')`);
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
        openLinkIcons: document.querySelectorAll('.queue-list .icon-button.open-link').length,
        noInlineTextLinks: !document.querySelector('.queue-list .subject-link'),
        noInlineStepperInTermHead: !document.querySelector('.term-head .font-size-control'),
        closeIsIconOnly: (() => {
          const b = Array.from(document.querySelectorAll('.term-head-actions button'))
            .find(x => x.getAttribute('aria-label') === 'Close session');
          return b ? { hasSvg: Boolean(b.querySelector('svg')), text: b.textContent.trim() } : null;
        })()
      }))()`
    );

    // Item 29: the stepper lives in Settings now, not the terminal header.
    await read(win, `document.querySelector('[aria-label="Settings"]')?.click()`);
    await until(win, `document.querySelector('.settings')`, 5_000);
    const fontBefore = await read(win, `getComputedStyle(document.querySelector('.xterm-rows')).fontSize`);
    await read(win, `document.querySelector('.settings [aria-label="Larger text"]')?.click()`);
    await new Promise((r) => setTimeout(r, 400));
    const font = {
      before: fontBefore,
      after: await read(win, `getComputedStyle(document.querySelector('.xterm-rows')).fontSize`),
      shown: await read(win, `document.querySelector('.settings .font-size-value')?.textContent`),
      stored: await read(win, `localStorage.getItem('kovan.terminal-font-size')`)
    };
    await shot('font');
    await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
    await new Promise((r) => setTimeout(r, 200));

    // ...and the same state from the keyboard. ⌘+ is intercepted in main so
    // it sizes the terminal instead of zooming the whole page, which is what
    // Electron's own default menu did with it — so check both halves: the
    // font moved, and the page zoom did not.
    await read(
      win,
      `(() => { window.__steps = []; window.kovan.onFontSizeStep(step => window.__steps.push(step)); })()`
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
      rendered: await read(win, `getComputedStyle(document.querySelector('.xterm-rows')).fontSize`),
      stored: await read(win, `localStorage.getItem('kovan.terminal-font-size')`),
      pageZoom: win.webContents.getZoomLevel(),
      stepsSeenByRenderer: await read(win, `window.__steps`)
    };

    // Item 23: ring the bell in one session and its row must stop looking like
    // every other running one. Rung through the real pty, since that is the
    // path the signal actually travels. `tput bel` rather than `printf`, so
    // the injected line carries no backslash for two layers of escaping to
    // argue over — one round of that already produced a raw carriage return
    // inside a string literal.
    const openSessions = (await read(win, `window.kovan.sessions()`)) as
      { id: string; subject?: string }[];
    const ticketSession = openSessions.find((s) => s.subject === 'ACME-2393');
    await read(
      win,
      `window.kovan.sessionWrite(${JSON.stringify(ticketSession?.id ?? '')}, 'tput bel' + String.fromCharCode(13))`
    );
    await new Promise((r) => setTimeout(r, 2000));
    const bell = {
      inMain: await read(
        win,
        `window.kovan.sessions().then(l => l.map(s => ({ subject: s.subject, attention: s.attention })))`
      ),
      rows: await read(
        win,
        `(() => Array.from(document.querySelectorAll('.queue-list .row')).map(r => ({
          title: r.querySelector('.row-title')?.textContent ?? '',
          dot: r.querySelector('.row-top > .dot')?.className ?? '',
          label: r.getAttribute('title') ?? ''
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
        subjectStillHasOpenIcon: Boolean(document.querySelector('.row-title')?.parentElement?.querySelector('.icon-button.open-link'))
      }))()`
    );
    await shot('renamed');

    // Visual check for item 30: the open-link and rename icons, forced
    // visible for the screenshot — real `:hover` is OS pointer state, which
    // a dispatched DOM event cannot fake, so this checks the same opacity a
    // real hover would set rather than trying to simulate the hover itself.
    await read(
      win,
      `document.querySelectorAll('.row .icon-button.rename, .row .icon-button.open-link')
        .forEach(b => { b.style.opacity = '1'; })`
    );
    await new Promise((r) => setTimeout(r, 100));
    await shot('hover-icons');

    // Item 22: the identifier in the name goes to the thing it names — the
    // ticket for a ticket, the pull request for a pull request. Item 30:
    // that's an icon now, not a link drawn into the text itself.
    const where = () =>
      read(
        win,
        `(() => ({
          view: document.querySelector('.rail-item[aria-current="page"]')?.getAttribute('aria-label'),
          heading: document.querySelector('.detail-head h2')?.textContent ?? '',
          key: document.querySelector('.detail-meta .key')?.textContent ?? ''
        }))()`
      );
    await read(win, `document.querySelectorAll('.queue-list .icon-button.open-link')[0]?.click()`);
    await new Promise((r) => setTimeout(r, 600));
    const jumpedToTicket = await where();
    await shot('jumped');

    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelector('.queue-list .icon-button.open-link')`, 5_000);
    await read(win, `document.querySelectorAll('.queue-list .icon-button.open-link')[1]?.click()`);
    await new Promise((r) => setTimeout(r, 600));
    const jumpedToPull = await where();

    // Item 26: closing what you were watching leaves a way forward, not a
    // terminal pointed at a session the main process has already forgotten.
    // Item 30: "Close" is an icon-only button now.
    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelector('.term-head [aria-label="Close session"]')`, 5_000);
    await read(win, `document.querySelector('.term-head [aria-label="Close session"]')?.click()`);
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

  // --- Item 20: dragging sessions into a split view ------------------------
  // A real mouse drag through the debugger protocol — dispatched DOM events
  // cannot grant pointer capture to themselves, which the whole interaction
  // depends on — from a sidebar row onto the edge of a pane, then a second
  // drag onto an existing pane's centre to merge as a tab, then a resize and
  // a detach. Each step is checked against the actual tree it produced, not
  // just a screenshot.
  if (process.env['KOVAN_SHOT_SPLIT']) {
    const prefix = process.env['KOVAN_SHOT_SPLIT'];
    const shot = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    const cwd = JSON.stringify(process.cwd());
    await read(win, `window.kovan.openTerminal(${cwd}, 'ACME-2393', 'implement · ACME-2393')`);
    await read(win, `window.kovan.openTerminal(${cwd}, 'acme/web#42', 'review · acme/web#42')`);
    await read(win, `window.kovan.openTerminal(${cwd}, 'ACME-1000', 'unblock · ACME-1000')`);
    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelectorAll('.queue-list .row').length >= 3`, 5_000);
    await new Promise((r) => setTimeout(r, 500));

    let attached = false;
    try { win.webContents.debugger.attach('1.3'); attached = true; } catch { /* already attached */ }
    const mouse = (type: string, x: number, y: number, buttons: number) =>
      win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse'
      });
    const dragTo = async (fromSel: string, toX: number, toY: number, steps = 8) => {
      const from = (await read(
        win, `(() => { const r = document.querySelector(${JSON.stringify(fromSel)})?.getBoundingClientRect();
          return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`
      )) as { x: number; y: number } | null;
      if (!from) return false;
      await mouse('mousePressed', from.x, from.y, 1);
      for (let i = 1; i <= steps; i += 1) {
        const x = Math.round(from.x + (toX - from.x) * (i / steps));
        const y = Math.round(from.y + (toY - from.y) * (i / steps));
        await mouse('mouseMoved', x, y, 1);
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 100));
      await mouse('mouseReleased', toX, toY, 0);
      return true;
    };

    const paneState = () =>
      read(
        win,
        `(() => ({
          leaves: document.querySelectorAll('.pane-leaf').length,
          splits: Array.from(document.querySelectorAll('.pane-split')).map(s => s.classList.contains('row') ? 'row' : 'column'),
          tabs: Array.from(document.querySelectorAll('.pane-tab-title')).map(t => t.textContent)
        }))()`
      );

    const before = attached ? await paneState() : null;

    // Drag the second row onto the right edge of the pane already showing
    // the first session — should split into two side-by-side panes.
    const laneRect = (await read(
      win, `(() => { const r = document.querySelector('.term-pane')?.getBoundingClientRect();
        return r ? { right: Math.round(r.right - 20), midY: Math.round(r.top + r.height / 2) } : null; })()`
    )) as { right: number; midY: number } | null;
    let splitOk = false;
    if (attached && laneRect) {
      splitOk = await dragTo('.queue-list li:nth-child(2) .row', laneRect.right, laneRect.midY);
      await new Promise((r) => setTimeout(r, 300));
    }
    const afterSplit = attached ? await paneState() : null;
    await shot('split');

    // Drag the third session onto the centre of the pane that split created
    // — should join it as a second tab there, not a third split. Picked by
    // name (ACME-1000), not by sidebar position: the sidebar always lists
    // every session regardless of which pane currently shows it, and two
    // sessions opened close enough together can tie on `startedAt`, which
    // makes row *position* an unreliable way to name "the untouched one".
    let mergeOk = false;
    if (attached) {
      const rightPane = (await read(
        win, `(() => { const panes = document.querySelectorAll('.pane-leaf'); const r = panes[panes.length - 1]?.getBoundingClientRect();
          return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`
      )) as { x: number; y: number } | null;
      if (rightPane) {
        const thirdRow = (await read(
          win,
          `(() => {
            const row = Array.from(document.querySelectorAll('.queue-list .row'))
              .find(r => r.querySelector('.row-title')?.textContent?.includes('ACME-1000'));
            const r = row?.getBoundingClientRect();
            return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
          })()`
        )) as { x: number; y: number } | null;
        if (thirdRow) {
          await mouse('mousePressed', thirdRow.x, thirdRow.y, 1);
          for (let i = 1; i <= 8; i += 1) {
            const x = Math.round(thirdRow.x + (rightPane.x - thirdRow.x) * (i / 8));
            const y = Math.round(thirdRow.y + (rightPane.y - thirdRow.y) * (i / 8));
            await mouse('mouseMoved', x, y, 1);
            await new Promise((r) => setTimeout(r, 20));
          }
          await new Promise((r) => setTimeout(r, 100));
          await mouse('mouseReleased', rightPane.x, rightPane.y, 0);
          mergeOk = true;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const afterMerge = attached ? await paneState() : null;
    await shot('merged');

    // Resize the divider between the two panes.
    let widthBefore: unknown, widthAfterResize: unknown;
    if (attached) {
      widthBefore = await read(win, `document.querySelector('.pane-split-child')?.getBoundingClientRect().width`);
      const handle = (await read(
        win, `(() => { const r = document.querySelector('.pane-divider')?.getBoundingClientRect();
          return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`
      )) as { x: number; y: number } | null;
      if (handle) {
        await mouse('mousePressed', handle.x, handle.y, 1);
        for (const dx of [40, 90]) {
          await mouse('mouseMoved', handle.x + dx, handle.y, 1);
          await new Promise((r) => setTimeout(r, 30));
        }
        await mouse('mouseReleased', handle.x + 90, handle.y, 0);
      }
      widthAfterResize = await read(win, `document.querySelector('.pane-split-child')?.getBoundingClientRect().width`);
    }
    await shot('resized');

    // Detach the merged-in tab: the pane should drop back to one tab (no
    // strip), and the session itself stays running — still in the sidebar.
    let detached: unknown;
    if (attached) {
      await read(win, `document.querySelector('.pane-tab:not(.active) .pane-tab-close')?.click()`);
      await new Promise((r) => setTimeout(r, 300));
      detached = {
        pane: await paneState(),
        rowsStillListed: await read(win, `document.querySelectorAll('.queue-list .row').length`)
      };
    }
    await shot('detached');

    if (attached) {
      try { win.webContents.debugger.detach(); } catch { /* already gone */ }
    }

    console.log(
      'splitView:',
      JSON.stringify({
        attached, before, splitOk, afterSplit, mergeOk, afterMerge,
        widthBefore, widthAfterResize, detached
      }, null, 2)
    );

    await read(win, `document.querySelector('[aria-label="Pull requests"]')?.click()`);
    await new Promise((r) => setTimeout(r, 300));
  }

  const result: Record<string, unknown> = {
    rendererMounted: await read(win, `document.querySelector('#root')?.children.length > 0`),
    preloadApi: await read(win, `typeof window.kovan?.refresh`),
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
    await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
    await new Promise((r) => setTimeout(r, 120));

    if (process.env['KOVAN_SHOT_MERGED']) {
      await writeFile(
        process.env['KOVAN_SHOT_MERGED'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_MERGED']}`);
    }

    if (process.env['KOVAN_SHOT_SECTIONS']) {
      await writeFile(
        process.env['KOVAN_SHOT_SECTIONS'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_SECTIONS']}`);
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

  if (process.env['KOVAN_SHOT_DETAIL_LIGHT']) {
    await read(win, `window.kovan.setSetting('appearance.theme', 'light')`);
    await read(win, `document.documentElement.dataset.theme = 'light'`);
    await new Promise((r) => setTimeout(r, 200));
    await read(win, `document.querySelector('.detail-scroll').scrollTo(0, 1400)`);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['KOVAN_SHOT_DETAIL_LIGHT'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_DETAIL_LIGHT']}`);
    await read(win, `window.kovan.setSetting('appearance.theme', 'dark')`);
    await read(win, `document.documentElement.dataset.theme = 'dark'`);
    await new Promise((r) => setTimeout(r, 150));
  }

  if (process.env['KOVAN_SHOT_DETAIL']) {
    await writeFile(
      process.env['KOVAN_SHOT_DETAIL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_DETAIL']}`);

    // Scrolled to the conversation, to see the collapse-by-default state:
    // only the last card (thread or comment) open, everything above it shut.
    await read(win, `document.querySelector('.detail-scroll').scrollTo(0, 1400)`);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      `${process.env['KOVAN_SHOT_DETAIL']}`.replace(/\.png$/, '-timeline.png'),
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_DETAIL']}-timeline.png`);

    const timelineState = await read(
      win,
      `Array.from(document.querySelectorAll('.timeline-card')).map(c => ({
        expanded: c.classList.contains('expanded'),
        head: c.querySelector('.timeline-card-head')?.textContent?.trim().slice(0, 60)
      }))`
    );
    console.log('timelineState:', JSON.stringify(timelineState, null, 2));

    // Click the first (collapsed) card and confirm it opens.
    await read(win, `document.querySelectorAll('.timeline-card-head')[0]?.click()`);
    await new Promise((r) => setTimeout(r, 150));
    const afterClick = await read(
      win,
      `document.querySelectorAll('.timeline-card')[0]?.classList.contains('expanded')`
    );
    console.log('firstCardExpandsOnClick:', afterClick);
    await writeFile(
      `${process.env['KOVAN_SHOT_DETAIL']}`.replace(/\.png$/, '-expanded.png'),
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_DETAIL']}-expanded.png`);
  }

  if (process.env['KOVAN_SHOT_QUICK']) {
    await read(win, `document.querySelector('.detail-scroll').scrollTo(0, 0)`);
    result['quickPull'] = await shootQuick(win, process.env['KOVAN_SHOT_QUICK'].replace(/\.png$/, '-pull.png'), 'Summarize');
  }

  // Opt-in on its own: a real Kimi K3 review takes minutes, so this polls
  // every ten seconds rather than holding one long wait open.
  if (process.env['KOVAN_SHOT_KIMI']) {
    const file = process.env['KOVAN_SHOT_KIMI'];
    await read(win, `document.querySelector('.detail-scroll').scrollTo(0, 0)`);
    await read(win, `Array.from(document.querySelectorAll('.detail-actions button.quick-run')).find(b => b.textContent.includes('nv-review'))?.click()`);
    await new Promise((r) => setTimeout(r, 1500));
    await writeFile(file.replace(/\.png$/, '-running.png'), (await win.webContents.capturePage()).toPNG());
    const cardOf = `Array.from(document.querySelectorAll('.quick-card')).find(c => c.innerText.startsWith('Kimi K3 review'))`;
    const deadline = Date.now() + 21 * 60_000;
    while (Date.now() < deadline) {
      const done = await read(win, `Boolean(${cardOf}?.querySelector('.quick-card-body') || ${cardOf}?.classList.contains('failed'))`);
      if (done) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    await read(win, `${cardOf}?.scrollIntoView({ block: 'start' })`);
    // After a long wait in the background Chromium stops painting the window,
    // and capturePage hands back the last frame it did paint — here, the
    // card still "reviewing… 2s". Bring it forward and repaint first.
    win.show();
    win.focus();
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 600));
    await writeFile(file, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${file}`);
    result['kimiReview'] = await read(win, `${cardOf}?.innerText ?? ''`);
    result['kimiHistory'] = await read(win, `Array.from(document.querySelectorAll('.runs li')).map(li => li.innerText)`);
    // Put the pane back as the later layout checks expect to find it.
    await read(win, `${cardOf}?.querySelector('[aria-label="Dismiss"]')?.click()`);
    await read(win, `document.querySelector('.detail-scroll').scrollTo(0, 0)`);
    await new Promise((r) => setTimeout(r, 300));
  }

  // --- Items 33 and 34: token usage, and submitting a review ----------------
  // Seeds a finished review for whichever PR is open (usage.json is seeded by
  // the caller before launch), then walks: verdict card → confirm → posted
  // (the smoke's own submit never reaches GitHub) → Sessions' Token usage.
  if (process.env['KOVAN_SHOT_USAGE']) {
    const prefix = process.env['KOVAN_SHOT_USAGE'];
    const shot = async (name: string) => {
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 400));
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    // A live poll (the fixture profile's Sentry 401) can replace the fixture
    // snapshot mid-run; put it back before driving the pane.
    win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
    await read(win, `document.querySelector('[aria-label="Pull requests"]')?.click()`);
    await until(win, `document.querySelector('.queue .row')`, 5_000);
    if (!(await read(win, `Boolean(document.querySelector('.detail-pill-repo'))`))) {
      await read(win, `document.querySelector('.queue .row')?.click()`);
      await until(win, `document.querySelector('.detail-pill-repo')`, 10_000);
    }
    const repoText = String(await read(win, `document.querySelector('.detail-pill-repo')?.textContent ?? ''`));
    const [, repo, num] = /^(\S+) #(\d+)$/.exec(repoText.trim()) ?? [];
    const subject = `${repo}#${num}`;
    const detail = detailFixture(repo!, Number(num));
    await mkdir(path.join(app.getPath('userData'), 'quick'), { recursive: true });
    await writeFile(
      path.join(app.getPath('userData'), 'quick', `${subject.replace(/[/\\:]/g, '_')}.json`),
      JSON.stringify({
        'pull-review': {
          kind: 'pull-review', subject, model: 'moonshotai/kimi-k3 (nv-review)', createdAt: new Date(Date.now() - 180_000).toISOString(),
          basis: reviewBasis(detail), verdict: 'request_changes',
          text: '## Summary\nMakes the question table scroll horizontally on tablets. Not ready: one overflow case is still broken.\n\n' +
            '## Must fix\n- `src/components/QuestionTable.tsx:48`: the row actions are positioned against the wrong container, so they still overlap below 1100px. Anchor them to the scroll container.\n\n' +
            '## Should fix\n- No test covers the tap fallback added for touch devices.\n\n## Already raised\nnone'
        }
      }),
      'utf8'
    );
    // Select another pull request and come back, so the pane reads the seeded result.
    const rowOf = (n: string) => `Array.from(document.querySelectorAll('.queue .row')).find(r => r.innerText.trim().startsWith(${JSON.stringify(n)}))`;
    await read(win, `Array.from(document.querySelectorAll('.queue .row')).find(r => !r.innerText.trim().startsWith(${JSON.stringify(num)}))?.click()`);
    await new Promise((r) => setTimeout(r, 500));
    await read(win, `${rowOf(num!)}?.click()`);
    await until(win, `Array.from(document.querySelectorAll('.quick-card')).some(c => c.innerText.startsWith('Code review'))`, 10_000);
    const cardOf = `Array.from(document.querySelectorAll('.quick-card')).find(c => c.innerText.startsWith('Code review'))`;
    await read(win, `${cardOf}?.scrollIntoView({ block: 'start' })`);
    await shot('review-verdict');
    await read(win, `${cardOf}?.querySelector('.review-event.changes')?.click()`);
    await new Promise((r) => setTimeout(r, 200));
    await shot('review-confirm');
    result['usageConfirm'] = await read(win, `${cardOf}?.querySelector('.review-confirm')?.innerText ?? ''`);
    await read(win, `Array.from(${cardOf}?.querySelectorAll('.review-confirm button') ?? []).find(b => b.textContent === 'Post review')?.click()`);
    await until(win, `Boolean(${cardOf}?.querySelector('.review-decision.posted'))`, 10_000);
    await shot('review-posted');
    result['usagePosted'] = await read(win, `${cardOf}?.querySelector('.review-decision')?.innerText ?? ''`);
    result['usageRail'] = await read(win, `document.querySelector('.rail-usage')?.innerText ?? ''`);
    await read(win, `document.querySelector('.rail-usage')?.scrollIntoView({ block: 'center' })`);
    await shot('pull-rail');

    await read(win, `document.querySelector('[aria-label="Agents and usage"]')?.click()`);
    await until(win, `Array.from(document.querySelectorAll('.row-title')).some(t => t.textContent === 'Token usage')`, 5_000);
    await read(win, `Array.from(document.querySelectorAll('.row')).find(r => r.innerText.startsWith('Token usage'))?.click()`);
    await until(win, `document.querySelector('.detail.usage')`, 5_000);
    await read(win, `Array.from(document.querySelectorAll('.usage-range')).find(b => b.textContent === '30 days')?.click()`);
    await shot('overview');
    result['usageOverview'] = await read(win, `document.querySelector('.detail.usage')?.innerText.slice(0, 1500) ?? ''`);
    await read(win, `document.querySelector('.detail.usage .detail-scroll, .detail-scroll')?.scrollTo(0, 10000)`);
    await shot('overview-bottom');
    await read(win, `document.querySelector('[aria-label="Pull requests"]')?.click()`);
    await new Promise((r) => setTimeout(r, 400));
  }

  // --- Items 42–44: environments, test accounts, reading text size ----------
  if (process.env['KOVAN_SHOT_ENVS']) {
    const prefix = process.env['KOVAN_SHOT_ENVS'];
    const shot = async (name: string) => {
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 400));
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    win.show();
    win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
    // The single environment this replaces, as an existing profile has it.
    // `setSecret` re-polls, and a poll with no real credentials replaces the
    // fixture with "Nothing connected" — keep putting it back.
    const keepEnvFixture = setInterval(() => win.webContents.send('kovan:snapshot', fixtureSnapshot(10)), 1_000);
    // An earlier step may already have seeded the list; start again from the old shape.
    await read(win, `window.kovan.setSetting('verify.environments', [])`);
    await read(win, `window.kovan.setSetting('verify.environment', 'Dev')`);
    await read(win, `window.kovan.setSetting('verify.site', 'https://dev.example.invalid')`);
    await read(win, `window.kovan.setSetting('verify.username', 'legacy@example.invalid')`);
    await read(win, `window.kovan.setSecret('verify.password', 'legacy-pw')`);
    const migrated = await read(win, `window.kovan.testEnvironments()`) as {
      environments: { id: string; name: string; site: string }[];
      accounts: { id: string; environmentId: string; username: string }[];
      savedPasswords: string[];
    };
    const legacy = migrated.accounts[0];
    await read(win, `window.kovan.testEnvironmentsSave(${JSON.stringify({
      environments: migrated.environments,
      defaultEnvironment: 'dev',
      accounts: [
        ...migrated.accounts,
        { id: 'acct-student', environmentId: 'local', label: 'Student', role: 'student', segment: 'b2c', username: 'student@example.invalid', notes: '' },
        { id: 'acct-teacher', environmentId: 'local', label: 'Teacher with two classes', role: 'teacher', segment: 'b2b', username: 'teacher@example.invalid', notes: 'owns class 7B' },
        { id: 'acct-parent', environmentId: 'local', label: 'Parent', role: 'parent', segment: 'b2c', username: 'parent@example.invalid', notes: '' }
      ],
      passwords: { 'testAccount.acct-student.password': 'x', 'testAccount.acct-teacher.password': 'y' }
    })})`);

    win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
    await until(win, `document.querySelector('.rail [aria-label="Settings"]')`, 10_000);
    await read(win, `document.querySelector('.rail [aria-label="Settings"]')?.click()`);
    await until(win, `document.querySelector('.settings-list')`, 5_000);
    await read(win, `document.querySelector('.settings-row[data-section="environments"]:not(.open) .settings-row-head')?.click()`);
    await until(win, `document.querySelector('.test-envs .account-card')`, 5_000);
    await shot('settings-dev');
    await read(win, `Array.from(document.querySelectorAll('.test-envs .env-picker button')).find(b => b.textContent.trim() === 'Local')?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    await shot('settings-local');
    const settingsView = await read(win, `({
      tabs: Array.from(document.querySelectorAll('.test-envs .env-picker button')).map(b => b.textContent.trim()),
      cards: document.querySelectorAll('.test-envs .account-card').length,
      placeholders: Array.from(document.querySelectorAll('.test-envs .account-card input[type=password]')).map(i => i.placeholder)
    })`);
    await read(win, `document.querySelector('.settings-row[data-section="text"]:not(.open) .settings-row-head')?.click()`);
    await new Promise((r) => setTimeout(r, 200));
    await read(win, `document.querySelector('[aria-label="Larger reading text"]')?.click()`);
    await read(win, `document.querySelector('[aria-label="Larger reading text"]')?.click()`);
    const readingSize = await read(win, `document.querySelector('[aria-label="Ticket and pull request text size"] .font-size-value')?.textContent`);
    await shot('settings-general');
    await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);

    // A merged pull request, so "Check it shipped" is offered.
    await read(win, `document.querySelector('[aria-label="Pull requests"]')?.click()`);
    await until(win, `document.querySelector('.queue .row')`, 5_000);
    if (!(await read(win, `Boolean(document.querySelector('.queue .row.shipped'))`))) {
      await read(win, `Array.from(document.querySelectorAll('.queue button')).find(b => /recently merged/i.test(b.textContent))?.click()`);
      await until(win, `document.querySelector('.queue .row.shipped')`, 5_000);
    }
    await read(win, `document.querySelector('.queue .row.shipped')?.click()`);
    await until(win, `Array.from(document.querySelectorAll('.detail-actions button')).some(b => b.textContent.includes('Check it shipped'))`, 10_000);
    const zoom = await read(win, `getComputedStyle(document.querySelector('.detail.reading')).zoom`);
    await shot('pull-at-120');
    const hasVerify = await read(win, `Boolean(Array.from(document.querySelectorAll('.detail-actions button')).find(b => b.textContent.includes('Check it shipped')))`);
    await read(win, `Array.from(document.querySelectorAll('.detail-actions button')).find(b => b.textContent.includes('Check it shipped'))?.click()`);
    await until(win, `document.querySelector('.run-test-env')`, 5_000);
    await until(win, `document.querySelector('.prompt-label textarea')?.value.includes('actually live on')`, 10_000);
    const devPrompt = await read(win, `document.querySelector('.prompt-label textarea').value`) as string;
    await shot('verify-dev');
    await read(win, `Array.from(document.querySelectorAll('.run-test-env .env-picker button')).find(b => b.textContent.trim() === 'Local')?.click()`);
    await until(win, `document.querySelector('.prompt-label textarea')?.value.includes('live on Local')`, 10_000);
    await read(win, `Array.from(document.querySelectorAll('.run-test-accounts label')).find(l => l.textContent.startsWith('Parent'))?.querySelector('input')?.click()`);
    await until(win, `!document.querySelector('.prompt-label textarea')?.value.includes('Parent')`, 10_000);
    const localPrompt = await read(win, `document.querySelector('.prompt-label textarea').value`) as string;
    await shot('verify-local');
    // Item 45: the URL is an input; typing a different one rewrites this run's prompt.
    await read(win, `(() => {
      const input = document.querySelector('.run-test-env-site');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, 'http://localhost:5173');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(win, `document.querySelector('.prompt-label textarea')?.value.includes('The site is http://localhost:5173')`, 10_000);
    const typedSite = {
      inPrompt: await read(win, `document.querySelector('.prompt-label textarea').value.includes('The site is http://localhost:5173')`),
      saveOffered: await read(win, `Array.from(document.querySelectorAll('.run-test-env .link')).some(b => b.textContent.includes('Save as default'))`),
      stillSaved: await read(win, `window.kovan.testEnvironments().then(s => s.environments.find(e => e.id === 'local').site)`)
    };
    await shot('verify-typed-site');
    await read(win, `Array.from(document.querySelectorAll('.sheet-head button')).find(b => b.textContent.trim() === 'Cancel')?.click()`);
    await read(win, `document.querySelector('[aria-label="Smaller reading text"]')`);

    clearInterval(keepEnvFixture);
    const pick = (text: string, re: RegExp) => (text.match(re) ?? []).join(' | ');
    console.log(JSON.stringify({
      migrated: {
        environments: migrated.environments.map((e) => `${e.name} ${e.site}`),
        legacyAccount: legacy ? `${legacy.environmentId} ${legacy.username}` : null,
        legacyPasswordCarried: legacy ? migrated.savedPasswords.includes(`testAccount.${legacy.id}.password`) : false
      },
      settingsView, readingSize, zoom, hasVerify, typedSite,
      devPrompt: pick(devPrompt, /live on \w+|Sign in as [^\n]*/g),
      localPrompt: pick(localPrompt, /live on \w+|\d\. [^\n]*/g),
      // Usernames and passwords, not the site URL, which is meant to be there.
      credentialsInPrompt: /@example\.invalid|legacy-pw/.test(devPrompt + localPrompt)
    }, null, 2));
  }

  // --- Items 37–41: a simpler Sessions tab, a leaner rail, a fitted terminal --
  if (process.env['KOVAN_SHOT_LAYOUT']) {
    const prefix = process.env['KOVAN_SHOT_LAYOUT'];
    const shot = async (name: string) => {
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 400));
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    win.show();
    win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
    await new Promise((r) => setTimeout(r, 300));
    const cwd = JSON.stringify(process.cwd());
    await read(win, `window.kovan.openTerminal(${cwd}, 'acme/web#42', 'review · acme/web#42')`);
    await read(win, `window.kovan.openTerminal(${cwd}, 'ACME-2393', 'implement · ACME-2393')`);
    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelector('.term-pane .term .xterm-rows')`, 10_000);
    // Fill the screen so the bottom row has something on it to be cut off.
    const sessionId = await read(win, `window.kovan.sessions().then(s => s[s.length - 1].id)`) as string;
    await read(win, `window.kovan.sessionWrite(${JSON.stringify(sessionId)}, 'for i in $(seq 1 200); do echo line $i; done; echo LAST-LINE-VISIBLE\\r')`);
    await new Promise((r) => setTimeout(r, 1500));
    await shot('sessions');

    const layout = await read(
      win,
      `(() => {
        const host = document.querySelector('.term-pane .term-host');
        const screen = host?.querySelector('.xterm-screen');
        const h = host?.getBoundingClientRect();
        const x = screen?.getBoundingClientRect();
        const rows = Array.from(document.querySelectorAll('.queue-list .row'));
        return {
          railButtons: Array.from(document.querySelectorAll('.rail button')).map(b => b.getAttribute('aria-label')),
          sessionsListHasUsage: /Token usage|Running agents/.test(document.querySelector('.queue-list')?.innerText ?? ''),
          rowHeights: rows.map(r => Math.round(r.getBoundingClientRect().height)),
          rowsOneLine: rows.every(r => r.classList.contains('one-line') && !r.querySelector('.row-state, .row-about')),
          terminal: h && x ? {
            hostBottom: Math.round(h.bottom), screenBottom: Math.round(x.bottom),
            hostRight: Math.round(h.right), screenRight: Math.round(x.right),
            fitsVertically: x.bottom <= h.bottom + 0.5, fitsHorizontally: x.right <= h.right + 0.5
          } : null
        };
      })()`
    );

    await read(win, `document.querySelector('[aria-label="Agents and usage"]')?.click()`);
    await until(win, `document.querySelector('.queue[aria-label="Agents and usage"]')`, 5_000);
    await new Promise((r) => setTimeout(r, 600));
    await shot('agents');
    const agents = await read(win, `document.querySelector('.queue[aria-label="Agents and usage"] .queue-list')?.innerText ?? ''`);
    await read(win, `Array.from(document.querySelectorAll('.queue-list .row')).find(r => r.innerText.includes('Token usage'))?.click()`);
    await new Promise((r) => setTimeout(r, 600));
    await shot('usage');
    const usagePane = await read(win, `document.querySelector('main.pane')?.innerText.slice(0, 80) ?? ''`);
    await read(win, `document.querySelector('.rail [aria-label="Settings"]')?.scrollIntoView()`);
    await shot('rail');
    console.log(JSON.stringify({ layout, agents, usagePane }, null, 2));
  }

  // --- Item 35: Sessions tab — open links, terminal names, quick-job controls --
  // Real mouse events, not element.click(): the open-link bug lived in the
  // row's pointer capture, which a synthetic click never goes through.
  if (process.env['KOVAN_SHOT_SESSIONS']) {
    const prefix = process.env['KOVAN_SHOT_SESSIONS'];
    const shot = async (name: string) => {
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 400));
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    const mouseClick = async (expression: string) => {
      const rect = await read(win, `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number } | null;
      if (!rect) return false;
      const x = Math.round(rect.x);
      const y = Math.round(rect.y);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await new Promise((r) => setTimeout(r, 80));
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 40));
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 300));
      return true;
    };
    win.show();
    win.focus();
    win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
    await new Promise((r) => setTimeout(r, 300));

    // Three ways a terminal gets opened: from a PR's own Terminal button
    // (named), from the + menu on a folder with a branch, and on a folder
    // that is not a clone at all.
    await read(win, `window.kovan.openTerminal(${JSON.stringify(process.cwd())}, 'acme/web#42', 'Terminal — acme/web#42')`);
    await read(win, `window.kovan.openTerminal(${JSON.stringify(process.cwd())})`);
    await read(win, `window.kovan.openTerminal(${JSON.stringify(app.getPath('userData'))})`);
    // A quick job to cancel and close.
    await read(win, `window.kovan.quickRun('pull-summary', 'acme/web#118')`);
    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelectorAll('.queue .row').length >= 4`, 10_000);
    await new Promise((r) => setTimeout(r, 800));
    result['sessionRows'] = await read(win, `Array.from(document.querySelectorAll('.queue .row')).map(r => r.innerText.replace(/\\n/g, ' | '))`);
    await shot('list');

    const rowWith = (text: string) => `Array.from(document.querySelectorAll('.queue .row')).find(r => r.innerText.includes(${JSON.stringify(text)}))`;
    // Hover the row first, as a real pointer does: one-line rows keep the open
    // icon out of the layout until then.
    const rowRect = await read(win, `(() => { const r = ${rowWith('Terminal — acme/web#42')}?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`) as { x: number; y: number } | null;
    if (rowRect) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: rowRect.x, y: rowRect.y });
      await new Promise((r) => setTimeout(r, 150));
    }
    result['openLinkHover'] = await read(win, `(() => { const b = ${rowWith('Terminal — acme/web#42')}?.querySelector('.open-link'); return b ? { display: getComputedStyle(b).display, w: b.getBoundingClientRect().width, rowHover: b.closest('.row').matches(':hover') } : null; })()`);
    await mouseClick(`${rowWith('Terminal — acme/web#42')}?.querySelector('.open-link')`);
    result['openLinkLanded'] = await read(win, `({
      view: document.querySelector('.rail-item[aria-current="page"]')?.getAttribute('aria-label'),
      pill: document.querySelector('.detail-pill-repo')?.textContent ?? ''
    })`);
    await shot('open-link-landed');

    await read(win, `document.querySelector('[aria-label="Sessions"]')?.click()`);
    await until(win, `${rowWith('Summarize · acme/web#118')}`, 5_000);
    await mouseClick(`${rowWith('Summarize · acme/web#118')}?.querySelector('[aria-label="Cancel"]')`);
    await until(win, `${rowWith('Summarize · acme/web#118')}?.title.includes('cancelled')`, 10_000);
    // One-line rows: the status in words is the row's tooltip.
    result['quickAfterCancel'] = await read(win, `${rowWith('Summarize · acme/web#118')}?.title ?? 'gone'`);
    await shot('quick-cancelled');
    await mouseClick(`${rowWith('Summarize · acme/web#118')}?.querySelector('[aria-label="Close"]')`);
    await new Promise((r) => setTimeout(r, 500));
    result['quickAfterClose'] = await read(win, `${rowWith('Summarize · acme/web#118')}?.innerText ?? 'gone'`);
    await shot('after-close');
  }

  // --- Item 36: Running agents ---------------------------------------------
  // A fake `claude` (KOVAN_FAKE_AGENT: a node script that ignores SIGINT and
  // starts a web server) in a Kovan terminal: listed with its port, turns
  // idle, and Stop takes both it and the server down through the escalation.
  // Only ever the fake's own row is clicked — every other agent on the Mac is
  // real.
  if (process.env['KOVAN_SHOT_AGENTS'] && process.env['KOVAN_FAKE_AGENT']) {
    const prefix = process.env['KOVAN_SHOT_AGENTS'];
    const fake = process.env['KOVAN_FAKE_AGENT'];
    const shot = async (name: string) => {
      // A live poll with no real credentials replaces the fixture mid-run.
      win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 400));
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };
    const mouseClick = async (expression: string) => {
      const rect = await read(win, `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number } | null;
      if (!rect) return false;
      const x = Math.round(rect.x);
      const y = Math.round(rect.y);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await new Promise((r) => setTimeout(r, 80));
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 40));
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 300));
      return true;
    };
    win.show();
    win.focus();
    win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
    await read(win, `window.kovan.setSetting('agents.idleMinutes', 1)`);
    const keepFixture = setInterval(() => win.webContents.send('kovan:snapshot', fixtureSnapshot(10)), 2_000);

    const session = await read(win, `window.kovan.openTerminal(${JSON.stringify(process.cwd())}, undefined, 'Fake agent · smoke')`) as { id: string };
    await read(win, `window.kovan.sessionWrite(${JSON.stringify(session.id)}, ${JSON.stringify(`node ${fake}`)} + String.fromCharCode(13))`);
    await read(win, `document.querySelector('[aria-label="Agents and usage"]')?.click()`);
    await until(win, `document.querySelectorAll('.queue .row').length >= 2`, 10_000);
    const agentsRow = `Array.from(document.querySelectorAll('.queue .row')).find(r => r.innerText.includes('Running agents'))`;
    await mouseClick(agentsRow);
    const fakeRow = `Array.from(document.querySelectorAll('.agent')).find(r => r.innerText.includes('Fake agent · smoke'))`;
    // The fixture flickering back in remounts the tab and drops the pane.
    const showAgents = async () => {
      if (await read(win, `Boolean(document.querySelector('.detail.agents'))`)) return;
      await read(win, `document.querySelector('[aria-label="Agents and usage"]')?.click()`);
      await until(win, agentsRow, 5_000);
      await mouseClick(agentsRow);
      await until(win, fakeRow, 10_000);
    };
    await until(win, `${fakeRow}?.innerText.includes(':8765')`, 30_000);
    result['agentsListed'] = await read(win, `Array.from(document.querySelectorAll('.agents-group')).map(g => g.innerText.replace(/\\n/g, ' | '))`);
    await shot('pane');

    const idleBy = Date.now() + 120_000;
    while (Date.now() < idleBy && !(await read(win, `Boolean(${fakeRow}?.querySelector('.agent-state.idle'))`))) {
      await showAgents();
      await new Promise((r) => setTimeout(r, 1_000));
    }
    result['idleRow'] = await read(win, `${fakeRow}?.innerText.replace(/\\n/g, ' | ')`);
    result['railIdlePip'] = await read(win, `Boolean(document.querySelector('.rail-pip.idle'))`);
    await shot('idle');

    await showAgents();
    await mouseClick(`${fakeRow}?.querySelector('.agents-stop')`);
    await until(win, `document.querySelector('.agents-confirm')`, 5_000);
    result['confirm'] = await read(win, `document.querySelector('.agents-confirm')?.innerText.replace(/\\n/g, ' | ')`);
    await shot('confirm');
    await mouseClick(`document.querySelector('.agents-confirm .agents-stop.strong')`);
    await until(win, `${fakeRow}?.innerText.includes('Stopping')`, 5_000);
    await shot('stopping');
    const goneBy = Date.now() + 30_000;
    while (Date.now() < goneBy && (await read(win, `Boolean(${fakeRow})`) || !(await read(win, `Boolean(document.querySelector('.detail.agents'))`)))) {
      await showAgents().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1_000));
    }
    await new Promise((r) => setTimeout(r, 500));
    result['afterStop'] = await read(win, `Array.from(document.querySelectorAll('.agents-group')).map(g => g.innerText.replace(/\\n/g, ' | '))`);
    result['sessionStillOpen'] = await read(win, `window.kovan.sessions().then(l => l.filter(s => s.id === ${JSON.stringify(session.id)}).map(s => s.running))`);
    await shot('stopped');
    console.log('agents36:', JSON.stringify({
      agentsListed: result['agentsListed'], idleRow: result['idleRow'], railIdlePip: result['railIdlePip'],
      confirm: result['confirm'], afterStop: result['afterStop'], sessionStillOpen: result['sessionStillOpen']
    }, null, 2));
    clearInterval(keepFixture);
    await read(win, `window.kovan.setSetting('agents.idleMinutes', 60)`);
    // The rest of the seeded run expects the state it set up, not this one.
    process.exit(0);
  }

  // --- Item 32: ticket <-> pull request cross-links -------------------------
  if (process.env['KOVAN_SHOT_RELATED']) {
    const prefix = process.env['KOVAN_SHOT_RELATED'];
    const shot = async (name: string) => {
      await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${prefix}-${name}.png`);
    };

    // The ticket side: ACME-2393 should list the one open pull request
    // whose title names it, and clicking it should land on that PR.
    await read(win, `document.querySelector('[aria-label="Tickets"]')?.click()`);
    await until(win, `document.querySelector('.row')`, 5_000);
    await read(win, `document.querySelector('.row')?.click()`);
    await until(win, `document.querySelector('.detail-head h2')`, 15_000);
    const ticketSide = await read(
      win,
      `Array.from(document.querySelectorAll('.detail-related-link')).map(b => b.textContent.trim())`
    );
    await shot('ticket-side');
    await read(win, `document.querySelector('.detail-related-link')?.click()`);
    await new Promise((r) => setTimeout(r, 500));
    const jumpedFromTicket = await read(
      win,
      `({
        view: document.querySelector('.rail-item[aria-current="page"]')?.getAttribute('aria-label'),
        heading: document.querySelector('.detail-head h2')?.textContent ?? ''
      })`
    );
    await shot('jumped-from-ticket');

    // The pull request side, from wherever that jump landed: its own
    // related link should point back at the ticket, and following it should
    // return to the exact ticket it came from.
    const pullSide = await read(
      win,
      `Array.from(document.querySelectorAll('.detail-related-link')).map(b => b.textContent.trim())`
    );
    await read(win, `document.querySelector('.detail-related-link')?.click()`);
    await new Promise((r) => setTimeout(r, 500));
    const jumpedBackToTicket = await read(
      win,
      `({
        view: document.querySelector('.rail-item[aria-current="page"]')?.getAttribute('aria-label'),
        heading: document.querySelector('.detail-head h2')?.textContent ?? ''
      })`
    );

    // A pull request with nothing to relate to (no ticket key in its title)
    // must show no related-links row at all, not an empty one.
    await read(win, `document.querySelector('[aria-label="Pull requests"]')?.click()`);
    await until(win, `document.querySelector('.row')`, 5_000);
    await read(win, `document.querySelector('.row')?.click()`);
    await until(win, `document.querySelector('.detail-head h2')`, 15_000);
    const noRelatedWhenNoMatch = await read(win, `!document.querySelector('.detail-related')`);

    console.log(
      'relatedLinks:',
      JSON.stringify({ ticketSide, jumpedFromTicket, pullSide, jumpedBackToTicket, noRelatedWhenNoMatch }, null, 2)
    );
  }

  // The screen this runs on tops out around 1500 logical pixels, and the
  // layout has to hold on a 2500px monitor too. Zooming out multiplies CSS
  // pixels without needing the hardware: the page sees a 2500px viewport.
  await win.webContents.setZoomFactor(0.6);
  await new Promise((r) => setTimeout(r, 250));
  result['layoutUltra'] = await layout();

  if (process.env['KOVAN_SHOT_ULTRA']) {
    await writeFile(
      process.env['KOVAN_SHOT_ULTRA'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_ULTRA']}`);
  }
  await win.webContents.setZoomFactor(1);
  await new Promise((r) => setTimeout(r, 200));

  // Squeeze the pane by widening the sidebar, and check it collapses to one
  // column rather than crushing both.
  await read(win, `document.documentElement.style.setProperty('--queue-w', '620px')`);
  await new Promise((r) => setTimeout(r, 200));
  result['layoutNarrow'] = await layout();

  if (process.env['KOVAN_SHOT_NARROW']) {
    await writeFile(
      process.env['KOVAN_SHOT_NARROW'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_NARROW']}`);
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

  if (process.env['KOVAN_SHOT_TICKET']) {
    // Same reason every other shot in this file waits: capturePage() can grab
    // a frame from just before the click's re-render finishes compositing.
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(
      process.env['KOVAN_SHOT_TICKET'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_TICKET']}`);
  }

  if (process.env['KOVAN_SHOT_QUICK']) {
    result['quickTicket'] = await shootQuick(win, process.env['KOVAN_SHOT_QUICK'].replace(/\.png$/, '-ticket.png'));
  }

  // Both jobs just run, as the Sessions tab lists them, and one opened with
  // what it read unfolded.
  if (process.env['KOVAN_SHOT_QUICK']) {
    const base = process.env['KOVAN_SHOT_QUICK'];
    await read(win, `document.querySelector('.rail-item[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelectorAll('.queue-list .row').length >= 2`, 10_000);
    const pullRow = `Array.from(document.querySelectorAll('.queue-list button.row')).find(b => b.textContent.includes('Summarize'))`;
    await read(win, `${pullRow}?.click()`);
    await until(win, `document.querySelector('.quick-job')`, 5_000);
    await new Promise((r) => setTimeout(r, 250));
    await writeFile(base.replace(/\.png$/, '-sessions.png'), (await win.webContents.capturePage()).toPNG());
    await read(win, `document.querySelector('.quick-job-fold-head')?.click()`);
    await new Promise((r) => setTimeout(r, 250));
    await writeFile(base.replace(/\.png$/, '-sessions-read.png'), (await win.webContents.capturePage()).toPNG());
    result['quickJobs'] = {
      rows: await read(win, `Array.from(document.querySelectorAll('.queue-list button.row')).map(b => b.innerText.split(String.fromCharCode(10)).join(' | '))`),
      facts: await read(win, `document.querySelector('.quick-job-facts')?.innerText ?? ''`)
    };
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

  if (process.env['KOVAN_SHOT_SENTRY']) {
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(process.env['KOVAN_SHOT_SENTRY'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['KOVAN_SHOT_SENTRY']}`);
  }

  if (process.env['KOVAN_SHOT_SENTRY_TICKET']) {
    await read(
      win,
      `Array.from(document.querySelectorAll('.detail-actions button'))
        .find(b => b.textContent.includes('Create ticket'))?.click()`
    );
    await until(win, `document.querySelector('.quiet.small .link')`, 5_000);
    await new Promise((r) => setTimeout(r, 200));
    result['sentryTicket'] = await read(win, `document.querySelector('.quiet.small')?.textContent ?? ''`);
    await writeFile(
      process.env['KOVAN_SHOT_SENTRY_TICKET'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_SENTRY_TICKET']}`);
  }

  // Item 18: saving Settings with a required field left blank must not fail
  // silently. It should say what is still missing, and once that field is
  // filled and saved, actually flip to connected without a manual refresh —
  // `save()` re-polls itself now.
  await read(win, `document.querySelector('[aria-label="Settings"]')?.click()`);
  await until(win, `document.querySelector('.settings-list')`, 5_000);
  await read(
    win,
    `document.querySelector('.settings-row[data-section="connections"]:not(.open) .settings-row-head')?.click()`
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

  if (process.env['KOVAN_SHOT_SETTINGS_SAVE']) {
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(
      process.env['KOVAN_SHOT_SETTINGS_SAVE'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_SETTINGS_SAVE']}`);
  }

  await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
  await until(win, `!document.querySelector('.settings-list')`, 5_000);

  // Back to Tickets, so nothing below assumes Sentry is still the active view.
  await read(win, `document.querySelector('.rail-item[aria-label="Tickets"]')?.click()`);
  await until(win, `document.querySelector('.row')`, 10_000);
  await read(win, `document.querySelector('.row')?.click()`);
  await until(win, `document.querySelector('.detail-head h2')`, 10_000);

  if (process.env['KOVAN_SHOT_INLINE_TERMINAL']) {
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
      process.env['KOVAN_SHOT_INLINE_TERMINAL'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_INLINE_TERMINAL']}`);
  }

  if (process.env['KOVAN_SHOT_RUN_VIEWER']) {
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
      process.env['KOVAN_SHOT_RUN_VIEWER'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_RUN_VIEWER']}`);

    if (process.env['KOVAN_SHOT_RUN_VIEWER_SHOTS']) {
      // Opening a document takes over the view; "back" has to return to
      // exactly the gallery that was there before.
      await read(win, `document.querySelector('.run-doc')?.click()`);
      await until(win, `document.querySelector('.run-viewer-doc')`, 5_000);
      await new Promise((r) => setTimeout(r, 200));
      await writeFile(
        process.env['KOVAN_SHOT_RUN_VIEWER_SHOTS'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_RUN_VIEWER_SHOTS']}`);

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
    if (process.env['KOVAN_SHOT_RUN_VIEWER_LIGHTBOX']) {
      await read(win, `document.querySelector('.run-viewer .ghost')?.click()`);
      await new Promise((r) => setTimeout(r, 100));
      const runs = (await read(win, `window.kovan.runHistory('ACME-2393')`)) as { directory: string }[];
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
          process.env['KOVAN_SHOT_RUN_VIEWER_LIGHTBOX'],
          (await win.webContents.capturePage()).toPNG()
        );
        console.log(`shot: ${process.env['KOVAN_SHOT_RUN_VIEWER_LIGHTBOX']}`);
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

  if (process.env['KOVAN_SHOT_TICKET_FILTER']) {
    await read(win, `document.querySelector('[aria-label="Filter tickets"]')?.click()`);
    await until(win, `document.querySelector('.filter-menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['KOVAN_SHOT_TICKET_FILTER'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_TICKET_FILTER']}`);
    // Close it before whatever runs next, so an unrelated shot doesn't
    // inherit an open menu it never asked for.
    await read(win, `document.body.click()`);
    await new Promise((r) => setTimeout(r, 100));
  }

  if (process.env['KOVAN_SHOT_TICKET_SORT']) {
    await read(win, `document.querySelector('[aria-label="Sort tickets"]')?.click()`);
    await until(win, `document.querySelector('.menu-host .menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['KOVAN_SHOT_TICKET_SORT'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_TICKET_SORT']}`);

    if (process.env['KOVAN_SHOT_TICKET_SORTED']) {
      await read(
        win,
        `Array.from(document.querySelectorAll('.menu-host .menu button'))
          .find(b => b.textContent.includes('Priority'))?.click()`
      );
      await new Promise((r) => setTimeout(r, 150));
      await writeFile(
        process.env['KOVAN_SHOT_TICKET_SORTED'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_TICKET_SORTED']}`);
    }
  }

  if (process.env['KOVAN_SHOT_NEW_SESSION']) {
    await read(win, `document.querySelector('.rail-item[aria-label="Sessions"]')?.click()`);
    await until(win, `document.querySelector('[aria-label="New session"]')`, 5_000);
    await read(win, `document.querySelector('[aria-label="New session"]')?.click()`);
    await until(win, `document.querySelector('.new-session-host .menu')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['KOVAN_SHOT_NEW_SESSION'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_NEW_SESSION']}`);

    if (process.env['KOVAN_SHOT_NEW_SESSION_OPENED']) {
      await read(win, `document.querySelector('.new-session-host .menu button[role="menuitem"]')?.click()`);
      await until(win, `document.querySelector('.term-head')`, 10_000);
      await new Promise((r) => setTimeout(r, 250));
      await writeFile(
        process.env['KOVAN_SHOT_NEW_SESSION_OPENED'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_NEW_SESSION_OPENED']}`);
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

  if (process.env['KOVAN_SHOT_SETTINGS']) {
    await read(win, `document.querySelector('[aria-label="Settings"]')?.click()`);
    await until(win, `document.querySelector('.settings-list')`, 5_000);
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['KOVAN_SHOT_SETTINGS'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_SETTINGS']}`);

    if (process.env['KOVAN_SHOT_SETTINGS_ENV']) {
      await read(
        win,
        `document.querySelector('.settings-row[data-section="environments"]:not(.open) .settings-row-head')?.click()`
      );
      await new Promise((r) => setTimeout(r, 150));
      await writeFile(
        process.env['KOVAN_SHOT_SETTINGS_ENV'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_SETTINGS_ENV']}`);
    }

    if (process.env['KOVAN_SHOT_SETTINGS_LIGHT']) {
      await read(
        win,
        `document.querySelector('.settings-row[data-section="appearance"]:not(.open) .settings-row-head')?.click()`
      );
      await new Promise((r) => setTimeout(r, 100));
      await read(
        win,
        `(Array.from(document.querySelectorAll('.theme-picker button')).find(b => b.textContent === 'Always one')?.click(),
          setTimeout(() => Array.from(document.querySelectorAll('.theme-grid .theme-name')).find(b => b.textContent === 'Light')?.click(), 50))`
      );
      await new Promise((r) => setTimeout(r, 250));
      await writeFile(
        process.env['KOVAN_SHOT_SETTINGS_LIGHT'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_SETTINGS_LIGHT']}`);
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
 * It edits and saves a real file, so KOVAN_WS_FOLDER must point at a scratch
 * clone, never at a working repository.
 */
/**
 * Item 80: a diff or file tab follows what git and the disk say now, not what
 * they said when it was opened. Changes the repo from outside, the way an
 * agent in a terminal would, then gives the window focus back.
 */
async function driveEditorFreshness(win: BrowserWindow, repo: string): Promise<Record<string, unknown>> {
  const { execFileSync } = await import('node:child_process');
  const { appendFileSync } = await import('node:fs');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const focus = async () => { await read(win, `window.dispatchEvent(new Event('focus'))`); await pause(700); };
  const shot = async (name: string) => {
    const prefix = process.env['KOVAN_SHOT_EDITOR'];
    if (!prefix) return;
    // A background window hands back its last painted frame; show it and
    // force a paint so the shot is of what the DOM says now.
    win.show();
    win.webContents.invalidate();
    await pause(400);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
  };
  const out: Record<string, unknown> = {};

  await read(win, `Array.from(document.querySelectorAll('.seg')).find(s => s.textContent.includes('Changes'))?.click()`);
  await until(win, `document.querySelector('.repo-main')`, 10_000);
  if (await read(win, `document.querySelector('.repo-main')?.getAttribute('aria-expanded') !== 'true'`)) {
    await read(win, `document.querySelector('.repo-main')?.click()`);
  }
  await until(win, `document.querySelector('.change')`, 20_000);
  await read(win, `document.querySelector('.change')?.click()`);
  await until(win, `document.querySelector('.hunk')`, 20_000);
  out['opened'] = await read(win, `({ hunks: document.querySelectorAll('.hunk').length, adds: document.querySelector('.diff-head .adds')?.textContent })`);

  // An agent stashes its work (as Claude Code does to compare test runs).
  git('stash', '--include-untracked');
  await focus();
  out['whileStashed'] = await read(win, `({
    empty: document.querySelector('.diff-empty .quiet')?.textContent ?? null,
    hunks: document.querySelectorAll('.hunk').length,
    listRows: document.querySelectorAll('.change').length
  })`);
  await shot('stashed');

  git('stash', 'pop');
  await focus();
  out['afterPop'] = await read(win, `({
    hunks: document.querySelectorAll('.hunk').length,
    listRows: document.querySelectorAll('.change').length
  })`);

  // Whole file: one hunk holding every line.
  const partLines = await read(win, `document.querySelectorAll('.diff tr').length`);
  await read(win, `document.querySelector('.diff-toggle')?.click()`);
  await until(win, `document.querySelector('.diff-toggle.on')`, 5_000);
  await pause(600);
  out['wholeFile'] = await read(win, `({
    pressed: document.querySelector('.diff-toggle')?.getAttribute('aria-pressed'),
    hunks: document.querySelectorAll('.hunk').length,
    rows: document.querySelectorAll('.diff tr').length,
    rowsBefore: ${partLines}
  })`);
  await shot('whole');
  await read(win, `document.querySelector('.diff-toggle')?.click()`);

  // Open file: the editor, with VS Code's change bars.
  await read(win, `document.querySelector('.diff-open')?.click()`);
  await until(win, `document.querySelector('.cm-content')`, 20_000);
  await until(win, `document.querySelector('.cm-change-bar')`, 10_000);
  out['editor'] = await read(win, `({
    tabs: Array.from(document.querySelectorAll('.tab .tab-label')).map(t => t.textContent),
    added: document.querySelectorAll('.cm-change-bar.added').length,
    modified: document.querySelectorAll('.cm-change-bar.modified').length,
    deleted: document.querySelectorAll('.cm-change-bar.deleted').length,
    status: document.querySelector('.status-changes')?.textContent ?? null
  })`);
  await shot('editor');

  // The agent writes to the open file; the editor, with no edits of its own, follows.
  const file = (await read(win, `document.querySelector('.tab.active + .tab, .tab.active')?.parentElement
    && document.querySelector('.tab-path bdi')?.textContent`)) as string;
  appendFileSync(file, 'const fromAgent = true;\n');
  await focus();
  out['externalWrite'] = await read(win, `({
    shown: document.querySelector('.cm-content')?.textContent?.includes('fromAgent') ?? false,
    dirty: Boolean(document.querySelector('.tab-dirty')),
    conflict: Boolean(document.querySelector('.conflict'))
  })`);
  return out;
}

/**
 * Items 81/82: the screenshot lightbox — ← → Home End Esc from a real
 * keyboard, each screenshot's time, and Show in Finder refusing anything
 * outside the runs store. `shotsDir` gets two real window captures "taken"
 * five minutes apart next to whatever is already there.
 */
async function driveLightbox(win: BrowserWindow, shotsDir: string): Promise<Record<string, unknown>> {
  const { utimes } = await import('node:fs/promises');
  const page = (await win.webContents.capturePage()).toPNG();
  const base = Date.now() - 20 * 60_000;
  for (const [i, name] of ['02-ticket.png', '03-ticket-again.png'].entries()) {
    await writeFile(path.join(shotsDir, name), page);
    const at = new Date(base + (i + 1) * 5 * 60_000);
    await utimes(path.join(shotsDir, name), at, at);
  }
  const first = new Date(base);
  await utimes(path.join(shotsDir, '01-landing.png'), first, first).catch(() => undefined);

  await read(win, `Array.from(document.querySelectorAll('.agent-report button')).find(b => b.textContent.includes('Open'))?.click()`);
  await until(win, `document.querySelectorAll('.run-shot').length >= 3`, 10_000);
  await new Promise((r) => setTimeout(r, 300));
  const gallery = {
    shotCount: await read(win, `document.querySelectorAll('.run-shot').length`),
    thumbTimes: await read(win, `Array.from(document.querySelectorAll('.run-shot-time')).map(t => t.textContent)`),
    finderLink: await read(win, `Boolean(Array.from(document.querySelectorAll('.run-section-head .link')).find(b => b.textContent.includes('Finder')))`)
  };
  const prefix = process.env['KOVAN_SHOT_LIGHTBOX'];
  const shot = async (name: string) => {
    if (!prefix) return;
    win.show();
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
  };
  await shot('gallery');
  await read(win, `document.querySelector('.run-shot')?.click()`);
  await until(win, `document.querySelector('.lightbox-backdrop img')`, 5_000);
  const caption = () => read(win, `({
    name: document.querySelector('.lightbox-name')?.textContent,
    time: document.querySelector('.lightbox-time')?.textContent,
    count: document.querySelector('.lightbox-count')?.textContent
  })`);
  const key = async (keyCode: string) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await new Promise((r) => setTimeout(r, 150));
  };
  const opened = await caption();
  // Focus somewhere else first, as a terminal or field behind the sheet
  // would have it: the arrows must still move the lightbox.
  await read(win, `document.querySelector('.run-viewer input, .run-viewer button')?.focus()`);
  await key('Right');
  const afterRight = await caption();
  await key('Right');
  await key('Right');
  const wrapped = await caption();
  await key('Left');
  const afterLeft = await caption();
  await key('End');
  const atEnd = await caption();
  await shot('caption');
  await key('Escape');
  const afterEscape = await read(win, `({
    lightbox: Boolean(document.querySelector('.lightbox-backdrop')),
    viewer: Boolean(document.querySelector('.run-viewer'))
  })`);
  // Reveal is only for run files; anything else is refused. (Not called
  // on a real run file here: that would open Finder on this machine.)
  const outsideRefused = await read(
    win, `window.kovan.runReveal('/etc/hosts').then(() => false, () => true)`
  );
  await read(win, `document.querySelector('.run-viewer .sheet-head .icon-button')?.click()`);
  return { gallery, opened, afterRight, wrapped, afterLeft, atEnd, afterEscape, outsideRefused };
}

/**
 * acme/acme-infra#40 as it really was: no branch protection so no review
 * decision, no checks, no conflicts, not a draft — `pullFlags` is empty, and
 * the detail pane's `pullFlags(pull)[0]!.id` threw on it.
 */
const QUIET_PULL = {
  ...FIXTURE,
  number: 40,
  title: 'fix: pass the Sentry auth token to image builds as a BuildKit secret',
  repo: 'acme/infra',
  author: 'idrisay',
  headRef: 'fix/sentry-auth-token-buildkit-secret',
  mergeable: 'mergeable' as const,
  reviewDecision: 'none' as const,
  checks: 'none' as const,
  unresolvedThreads: 0,
  updatedAt: new Date(Date.now() - 259_200_000).toISOString()
};

async function driveItem83(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const base = fixtureSnapshot(10);
  win.webContents.send('kovan:snapshot', { ...base, mine: [...base.mine, QUIET_PULL] });
  await until(win, `Array.from(document.querySelectorAll('.row-num')).some(n => n.textContent === '40')`);

  const row = (num: number) => read(win, `(() => {
    const r = Array.from(document.querySelectorAll('button.row'))
      .find(b => b.querySelector('.row-num')?.textContent === '${num}');
    return r ? {
      state: Array.from(r.querySelectorAll('.state')).map(s => ({ text: s.textContent, hint: s.getAttribute('title') })),
      repo: r.querySelector('.row-repo')?.textContent ?? null,
      repoTitle: r.querySelector('.row-repo')?.getAttribute('title') ?? null,
      oneLine: !r.querySelector('.row-state')
    } : null; })()`);
  const rows = { quiet40: await row(40), unresolved42: await row(42) };
  const merged = await read(win, `(() => { const r = document.querySelector('button.row.shipped');
    return r ? { repo: r.querySelector('.row-repo')?.textContent ?? null } : null; })()`);
  const everyOpenRowHasRepo = await read(win, `Array.from(document.querySelectorAll('button.row'))
    .every(r => Boolean(r.querySelector('.row-repo')?.textContent))`);
  await snap('rows');

  await read(win, `Array.from(document.querySelectorAll('button.row'))
    .find(b => b.querySelector('.row-num')?.textContent === '40')?.click()`);
  await until(win, `document.querySelector('.detail-head') || document.querySelector('.error-card')`, 10_000);
  await new Promise((r) => setTimeout(r, 400));
  const opened = await read(win, `({
    pill: document.querySelector('.detail-head .status-pill')?.textContent ?? null,
    pillTitle: document.querySelector('.detail-head .status-pill')?.getAttribute('title') ?? null,
    title: document.querySelector('.detail-head h2')?.textContent ?? null,
    errorCard: document.querySelector('.error-card')?.innerText ?? null,
    railStillThere: Boolean(document.querySelector('.rail')),
    sidebarStillThere: Boolean(document.querySelector('aside.queue'))
  })`);
  await snap('detail-40');

  // Picking another row after that must work either way — the boundary
  // resets on a new selection rather than staying broken.
  await read(win, `Array.from(document.querySelectorAll('button.row'))
    .find(b => b.querySelector('.row-num')?.textContent === '42')?.click()`);
  await until(win, `document.querySelector('.detail-head h2')?.textContent?.includes('flaky payment')`, 10_000);
  const afterOther = await read(win, `({
    pill: document.querySelector('.detail-head .status-pill')?.textContent ?? null,
    states: Array.from(document.querySelectorAll('.detail-states .state'))
      .map(s => ({ text: s.textContent, hint: s.getAttribute('title') })),
    errorCard: Boolean(document.querySelector('.error-card'))
  })`);

  const { readFile: read_, stat } = await import('node:fs/promises');
  const logFile = path.join(app.getPath('logs'), 'kovan.log');
  const log = await read_(logFile, 'utf8').catch(() => '');
  const logSize = await stat(logFile).then((s) => s.size, () => -1);
  return {
    rows, merged, everyOpenRowHasRepo, opened, afterOther,
    log: { file: logFile, size: logSize, rendererErrors: log.split('\n').filter((l) => l.includes('[renderer')).slice(0, 3) }
  };
}

async function driveItems93and94(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const click = (selector: string) => read(win, `document.querySelector(${JSON.stringify(selector)})?.click()`);
  const rail = (label: string) => click(`.rail-item[aria-label="${label}"]`);
  const reload = async () => {
    win.webContents.reload();
    await until(win, `document.querySelector('#root')?.children.length > 0`);
    win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
    await until(win, `document.querySelector('.rail-item[data-view]')`, 10_000);
    await pause(400);
  };
  // The ticked options of whichever filter menu is open.
  const ticked = () => read(win, `Array.from(document.querySelectorAll('.filter-menu .filter-option')).filter(l => l.querySelector('input').checked).map(l => l.textContent.trim())`);
  win.focus();

  // --- 93: tick filters and change sorts, in both views -------------------
  await rail('Tickets');
  await until(win, `document.querySelector('[aria-label="Filter tickets"]')`, 5_000);
  await click('[aria-label="Filter tickets"]');
  await until(win, `document.querySelector('.filter-menu .filter-option input')`, 5_000);
  await read(win, `document.querySelector('.filter-menu .filter-option input').click()`);
  const ticketTicked = await ticked();
  await click('[aria-label="Filter tickets"]');
  await click('[aria-label="Sort tickets"]');
  await read(win, `Array.from(document.querySelectorAll('.menu [role=menuitemradio]')).find(b => b.textContent === 'Priority')?.click()`);
  await read(win, `(() => { const q = document.getElementById('q'); q.focus(); document.execCommand('insertText', false, 'payment'); })()`);

  await rail('Pull requests');
  await until(win, `document.querySelector('[aria-label="Filter pull requests"]')`, 5_000);
  await click('[aria-label="Filter pull requests"]');
  await until(win, `document.querySelector('.filter-menu .filter-option input')`, 5_000);
  await read(win, `document.querySelector('.filter-menu .filter-option input').click()`);
  const pullTicked = await ticked();
  await click('[aria-label="Filter pull requests"]');
  await click('[aria-label="Sort pull requests"]');
  await read(win, `Array.from(document.querySelectorAll('.menu [role=menuitemradio]')).find(b => b.textContent === 'Oldest')?.click()`);
  const stored = await read(win, `JSON.parse(localStorage.getItem('kovan.view-prefs'))`);

  // Close and reopen the window: everything but the search text comes back.
  await reload();
  const pullBadge = await read(win, `document.querySelector('[aria-label="Filter pull requests"] .filter-count')?.textContent ?? null`);
  const pullSortActive = await read(win, `document.querySelector('[aria-label="Sort pull requests"]')?.classList.contains('active')`);
  await click('[aria-label="Filter pull requests"]');
  await until(win, `document.querySelector('.filter-menu')`, 3_000);
  const pullTickedAfter = await ticked();
  await click('[aria-label="Filter pull requests"]');
  await rail('Tickets');
  await until(win, `document.querySelector('[aria-label="Filter tickets"]')`, 5_000);
  const ticketBadge = await read(win, `document.querySelector('[aria-label="Filter tickets"] .filter-count')?.textContent ?? null`);
  const ticketSortActive = await read(win, `document.querySelector('[aria-label="Sort tickets"]')?.classList.contains('active')`);
  await click('[aria-label="Filter tickets"]');
  await until(win, `document.querySelector('.filter-menu')`, 3_000);
  const ticketTickedAfter = await ticked();
  await click('[aria-label="Filter tickets"]');
  const searchAfter = await read(win, `document.getElementById('q')?.value`);
  await snap('filters-restored');

  // A remembered value nothing has any more still shows, ticked, to untick.
  await read(win, `(() => { const p = JSON.parse(localStorage.getItem('kovan.view-prefs'));
    p.ticketFilters.assignee = ['Nobody Here']; localStorage.setItem('kovan.view-prefs', JSON.stringify(p)); })()`);
  await reload();
  await rail('Tickets');
  await until(win, `document.querySelector('[aria-label="Filter tickets"]')`, 5_000);
  await click('[aria-label="Filter tickets"]');
  await until(win, `document.querySelector('.filter-menu')`, 3_000);
  const orphanShown = (await ticked() as string[]).includes('Nobody Here');
  await snap('orphan');
  // Clear everything, so the run sheet part sees every ticket.
  await read(win, `Array.from(document.querySelectorAll('.filter-menu button')).find(b => b.textContent.includes('Clear'))?.click()`);

  // --- 94: the run sheet remembers agent and folders ----------------------
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const root = path.join(app.getPath('userData'), 'repos');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  for (const dir of [alpha, beta]) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
  }
  await read(win, `window.kovan.setSetting('repos.folders', ${JSON.stringify([alpha, beta])})`);
  await read(win, `window.kovan.runTargets(true)`);

  const openSheet = async (key: string) => {
    await rail('Tickets');
    await until(win, `Array.from(document.querySelectorAll('.rows .row .row-num')).some(n => n.textContent === '${key}')`, 5_000);
    await read(win, `Array.from(document.querySelectorAll('.rows .row .row-num')).find(n => n.textContent === '${key}').closest('button').click()`);
    await until(win, `document.querySelector('.detail-actions .primary')`, 5_000);
    await click('.detail-actions .primary');
    await until(win, `document.querySelector('.folder-button-text') && !document.querySelector('.folder-button-text').textContent.includes('No watched')`, 10_000);
    // Agents are found by probing a login shell, which takes a few seconds.
    await until(win, `document.querySelectorAll('.run-controls select option').length > 0`, 20_000);
    await pause(600);
  };
  const sheetState = () => read(win, `({
    folders: document.querySelector('.folder-button-text')?.textContent ?? null,
    agent: document.querySelector('.run-controls select')?.value ?? null,
    agents: document.querySelectorAll('.run-controls select option').length })`);
  const closeSheet = async () => {
    await click('.sheet-head .icon-button.boxed');
    await until(win, `!document.querySelector('.folder-button')`, 3_000);
  };

  await openSheet('ACME-2393');
  const firstOpen = await sheetState();
  // Run across both, starting in beta.
  await click('.folder-button');
  await until(win, `document.querySelector('.folder-menu .folder-option')`, 3_000);
  await read(win, `Array.from(document.querySelectorAll('.folder-menu .folder-option')).forEach(o => { const i = o.querySelector('input'); if (i && !i.checked) i.click(); })`);
  await pause(200);
  await read(win, `Array.from(document.querySelectorAll('.folder-menu .folder-option')).find(o => o.textContent.includes('beta'))?.querySelector('button.link')?.click()`);
  await pause(200);
  await click('.folder-button');
  // Pick the second agent, when there is one.
  const pickedAgent = await read(win, `(() => { const s = document.querySelector('.run-controls select'); if (s.options.length < 2) return null;
    const v = s.options[1].value; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, v);
    s.dispatchEvent(new Event('change', { bubbles: true })); return v; })()`);
  await pause(200);
  const chosen = await sheetState();
  await snap('sheet-chosen');
  await closeSheet();

  await reload();
  await openSheet('ACME-2393');
  const reopened = await sheetState();
  const startsIn = await read(win, `(() => { document.querySelector('.folder-button').click(); return new Promise(r => setTimeout(() => {
    const o = Array.from(document.querySelectorAll('.folder-menu .folder-option')).find(x => x.querySelector('.folder-main'));
    r(o ? o.textContent.replace('starts here', '').trim() : null); }, 200)); })()`);
  await snap('sheet-reopened');
  await closeSheet();

  // A ticket never run starts from the last ticket's folders.
  await openSheet('ACME-1000');
  const newTicket = await sheetState();
  await closeSheet();

  return {
    ticketTicked, pullTicked, stored, pullBadge, pullSortActive, pullTickedAfter, ticketBadge, ticketSortActive,
    ticketTickedAfter, searchAfter, orphanShown, firstOpen, pickedAgent, chosen, reopened, startsIn, newTicket
  };
}

async function driveItem92(win: BrowserWindow): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 4. The budget in the GitHub item's tooltip.
  const base = fixtureSnapshot(10);
  win.webContents.send('kovan:snapshot', {
    ...base, githubBudget: { remaining: 4768, limit: 5000, resetAt: '2026-09-28T13:55:38Z', cost: 5 }
  });
  await pause(300);
  const tooltip = await read(win, `Array.from(document.querySelectorAll('.statusbar-item')).find(i => i.textContent.includes('GitHub'))?.getAttribute('title') ?? null`);

  // 3. A failed poll between two good ones must not re-announce what's blocked.
  const { createHost } = await import('./host');
  const { Activity } = await import('./notify');
  const notices: { title: string; body: string }[] = [];
  const activity = new Activity(createHost(), (notice) => notices.push(notice));
  const good: Snapshot = { ...base, viewer: 'idrisay', errors: [] };
  const failed: Snapshot = { ...base, viewer: '', blocked: [], mine: [], reviewRequested: [], errors: [{ provider: 'github', message: 'API rate limit already exceeded' }] };
  await activity.report(good, true);
  const afterBaseline = notices.length;
  await activity.report(failed, false);
  await activity.report(good, false);
  const afterFailureAndBack = notices.length;
  // And something that really did become blocked still gets through.
  const newly = { ...base.mine[1]!, number: 777, title: 'Newly blocked', mergeable: 'conflicting' as const };
  await activity.report({ ...good, blocked: [...good.blocked, newly], mine: [...good.mine, newly] }, false);
  return { tooltip, afterBaseline, afterFailureAndBack, afterRealChange: notices.length, lastNotice: notices[notices.length - 1] ?? null };
}

/**
 * Item 110 (option A): GitHub and Terminal beside the ticket chip on a pull
 * request, Jira and Terminal on a ticket; the action bar on one line.
 */
async function driveItem110(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const header = () => read(win, `(() => {
    const places = Array.from(document.querySelectorAll('.detail-related .detail-place')).map(b => b.textContent.trim());
    const actions = document.querySelector('.detail-actions');
    const buttons = Array.from(actions?.querySelectorAll(':scope > button, :scope > * button') ?? []);
    const tops = new Set(buttons.map(b => Math.round(b.getBoundingClientRect().top)));
    return { places, actions: buttons.map(b => b.textContent.trim().replace(/\s+/g, ' ')), lines: tops.size };
  })()`);
  win.focus();
  const report: Record<string, unknown> = {};
  await read(win, `document.querySelector('.rows .row')?.click()`);
  await until(win, `document.querySelector('.detail-related .detail-place')`, 8_000);
  await pause(600);
  report['pull'] = await header();
  await snap('pull');
  await read(win, `document.querySelector('.rail-item[aria-label="Tickets"]')?.click()`);
  await until(win, `document.querySelector('.rows .row')`, 5_000).catch(() => undefined);
  await read(win, `document.querySelector('.rows .row')?.click()`);
  await until(win, `document.querySelector('.detail-related .detail-place')`, 8_000).catch(() => undefined);
  await pause(600);
  report['ticket'] = await header();
  await snap('ticket');
  return report;
}

/**
 * Item 108: the run sheet's Agent picker, switched between the agents found
 * on this Mac; each one's limits line read back and shot. The numbers are
 * whatever Codex's log and the status-line cache say right now.
 */
/**
 * Items 116 and 117. Back / Forward across views and selections; then the
 * run sheet folded (prompt, accounts, limits) and unfolded.
 */
async function driveItem116(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  const where = () => read(win, `({ view: document.querySelector('.rail-item.active')?.getAttribute('data-view'),
    selected: document.querySelector('.row.selected .row-title, .row.selected .title')?.textContent?.trim() ?? null,
    back: !document.querySelector('.history-nav [aria-label="Back"]').disabled,
    forward: !document.querySelector('.history-nav [aria-label="Forward"]').disabled,
    backTitle: document.querySelector('.history-nav [aria-label="Back"]').title })`);
  await until(win, `document.querySelector('.rows .row')`, 10_000);
  // Pull request 1, then a ticket, then another pull request.
  await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
  await pause(400);
  await read(win, `document.querySelector('.rail-item[data-view="tickets"]')?.click()`);
  await pause(400);
  await read(win, `document.querySelectorAll('.rows .row')[1]?.click()`);
  await pause(400);
  await read(win, `document.querySelector('.rail-item[data-view="pulls"]')?.click()`);
  await pause(400);
  await read(win, `document.querySelectorAll('.rows .row')[1]?.click()`);
  await pause(400);
  report['start'] = await where();
  await snap('nav');
  const click = (label: string) => read(win, `document.querySelector('.history-nav [aria-label="${label}"]')?.click()`);
  const steps: unknown[] = [];
  for (const label of ['Back', 'Back', 'Back', 'Forward']) {
    await click(label);
    await pause(400);
    steps.push({ after: label, ...(await where() as object) });
  }
  report['steps'] = steps;
  // ⌘] goes forward as well.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ']', modifiers: ['meta'] });
  await pause(400);
  report['afterCmdBracket'] = await where();

  // Item 117: the run sheet, with accounts to fold.
  const state = await read(win, `window.kovan.testEnvironments()`) as { environments: { id: string; name: string }[]; accounts: unknown[] };
  const env = state.environments[0]?.id ?? 'local';
  await read(win, `window.kovan.testEnvironmentsSave(${JSON.stringify({
    environments: state.environments.length ? state.environments : [{ id: 'local', name: 'Local', site: 'https://app.example.test/en' }],
    defaultEnvironment: env,
    accounts: [
      { id: 'a1', environmentId: env, label: 'Admin', role: 'school admin', segment: 'b2b', username: 'admin@example.invalid', notes: '' },
      { id: 'a2', environmentId: env, label: 'Teacher', role: 'teacher', segment: 'b2b', username: 'teacher@example.invalid', notes: '' },
      { id: 'a3', environmentId: env, label: 'Student', role: 'student', segment: 'b2b', username: 'student@example.invalid', notes: '' },
      { id: 'a4', environmentId: env, label: 'Joiner', role: 'student', segment: 'b2c', username: 'joiner@example.invalid', notes: '' },
      { id: 'a5', environmentId: env, label: 'Parent', role: 'parent', segment: 'b2c', username: 'parent@example.invalid', notes: '' }
    ],
    passwords: {}
  })})`);
  await read(win, `document.querySelector('.rail-item[data-view="tickets"]')?.click()`);
  await pause(300);
  await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
  await until(win, `Array.from(document.querySelectorAll('button')).some(b => /in an agent/.test(b.textContent))`, 8_000);
  await read(win, `Array.from(document.querySelectorAll('button')).find(b => /in an agent/.test(b.textContent))?.click()`);
  await until(win, `document.querySelector('.run-controls select')?.options.length > 0`, 15_000);
  await read(win, `Array.from(document.querySelectorAll('.env-picker button')).find(b => b.textContent.trim() !== 'None')?.click()`);
  await pause(1_500);
  const sheet = () => read(win, `(() => { const s = document.querySelector('.sheet'); const r = s.getBoundingClientRect();
    return { height: Math.round(r.height), window: innerHeight, accounts: document.querySelector('.run-test-accounts-summary')?.innerText ?? 'list',
      rows: document.getElementById('run-prompt')?.rows, limits: document.querySelector('.agent-limits')?.innerText ?? null }; })()`);
  report['folded'] = await sheet();
  await snap('sheet-folded');
  await read(win, `document.querySelector('.run-test-accounts-summary .link')?.click()`);
  await read(win, `Array.from(document.querySelectorAll('.prompt-label .link')).find(b => /Show all/.test(b.textContent))?.click()`);
  await pause(400);
  report['unfolded'] = await sheet();
  await snap('sheet-unfolded');
  // Leave it folded for the next person.
  await read(win, `Array.from(document.querySelectorAll('.prompt-label .link')).find(b => /Fold/.test(b.textContent))?.click()`);
  return report;
}

/**
 * Item 118: the detail header — option C (toolbar) on comfortable, option D
 * (two lines) on compact — for a ticket, a pull request and a Sentry issue;
 * and on comfortable, that the toolbar stays while the pane scrolls.
 * `KOVAN_DENSITY=compact` for the compact run.
 */
/**
 * Item 124: the quick-model buttons start hidden, appear the moment they are
 * ticked in Settings › Agents (behind the sheet), and go again when unticked.
 */
/** Item 127: ⌘K, typing, ⇥ scopes, ⏎ to open, `>` for actions — by real key events. */
async function driveItem127(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(600);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const key = async (keyCode: string, modifiers: ('meta' | 'shift')[] = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await pause(250);
  };
  const type = async (text: string) => { await win.webContents.insertText(text); await pause(400); };
  const groups = () => read(win, `Array.from(document.querySelectorAll('.tsearch-list [role=group]')).map((g) => g.getAttribute('aria-label') + ': ' + Array.from(g.querySelectorAll('.tsearch-row')).map((r) => r.querySelector('.tsearch-key').textContent + ' ' + r.querySelector('.tsearch-title').textContent + ' [' + r.querySelector('.tsearch-meta').textContent + ']').join(' | '))`);
  win.show();
  win.focus();
  await until(win, `document.querySelector('.rows .row')`, 15_000);
  const report: Record<string, unknown> = {};
  report['idle'] = await read(win, `document.querySelector('.tsearch input')?.placeholder`);
  await snap('idle');
  await key('K', ['meta']);
  report['openedByCmdK'] = await read(win, `Boolean(document.querySelector('.tsearch.open')) && document.activeElement === document.querySelector('.tsearch input')`);
  report['empty'] = await groups();
  await snap('empty');
  await type('retry');
  report['retry'] = await groups();
  report['highlight'] = await read(win, `Array.from(document.querySelectorAll('.tsearch-title mark')).slice(0, 3).map((m) => m.textContent)`);
  await snap('retry');
  await key('Tab');
  report['scopeAfterTab'] = await read(win, `document.querySelector('.tsearch-scope.on')?.textContent`);
  report['retryPullsOnly'] = await groups();
  await key('Tab', ['shift']);
  await key('Enter');
  await pause(800);
  report['openedTitle'] = await read(win, `document.querySelector('.detail h2, main h2')?.textContent`);
  report['closedAfterEnter'] = await read(win, `!document.querySelector('.tsearch.open')`);
  await key('K', ['meta']);
  await type('> settings');
  report['actions'] = await groups();
  await snap('actions');
  await key('Enter');
  await pause(800);
  report['settingsOpened'] = await read(win, `Boolean(document.querySelector('.settings-list'))`);
  await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
  if (!(await until(win, `!document.querySelector('.settings-list')`, 2_000))) await key('Escape');
  await until(win, `!document.querySelector('.settings-list')`, 2_000);
  await pause(300);
  await key('K', ['meta']);
  await type('zzzz nothing');
  report['noMatch'] = await read(win, `document.querySelector('.tsearch-empty')?.textContent`);
  await key('Escape');
  report['closedByEscape'] = await read(win, `!document.querySelector('.tsearch.open')`);
  return report;
}

/**
 * Item 126: picks bash in the + menu's shell switch, opens a terminal, and
 * checks what actually runs in it — then that the choice stuck, and that
 * Settings › Text & terminal shows the same one.
 */
/**
 * Item 139: a ticket with its agent terminal docked to the right, taking most
 * of a wide window. The ticket's own width, not the window's, must decide
 * whether the side column (token usage, sessions, history) sits beside the
 * text or under it.
 */
async function driveItem139(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  win.setSize(1600, 1000);
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  await until(win, `document.querySelector('.rail-item[data-view="tickets"]')`, 15_000);
  await read(win, `localStorage.setItem('kovan.terminal-dock', 'right'); localStorage.setItem('kovan.terminal-width', '1000')`);
  await read(win, `document.querySelector('.rail-item[data-view="tickets"]').click()`);
  await until(win, `document.querySelector('.rows .row')`, 5_000);
  await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
  await until(win, `document.querySelector('.detail-place-icon')`, 8_000);
  const layout = () => read(win, `(() => {
    const scroll = document.querySelector('.detail-scroll'), main = document.querySelector('.detail-main'), side = document.querySelector('.detail-side');
    const r = (e) => e ? Math.round(e.getBoundingClientRect().width) : null;
    return { pane: r(document.querySelector('.pane')), ticket: r(scroll), main: r(main), side: r(side),
      sideBySide: Boolean(main && side && side.getBoundingClientRect().left > main.getBoundingClientRect().right - 1),
      terminal: r(document.querySelector('.detail-terminal')) };
  })()`);
  report['before'] = await layout();
  // The toolbar's >_ opens a terminal for this ticket, docked in it.
  await read(win, `document.querySelector('.detail-place-icon[aria-label="Open a terminal for this"]')?.click()`);
  report['dockedRight'] = await until(win, `document.querySelector('.detail-terminal.dock-right')`, 10_000);
  await pause(800);
  report['docked'] = await layout();
  win.webContents.invalidate();
  await pause(300);
  await writeFile(`${prefix}-docked.png`, (await win.webContents.capturePage()).toPNG());
  return report;
}

/**
 * Kovan on Linux: Ctrl in place of ⌘ (but a terminal keeps Ctrl+K), the
 * desktop's own frame, open-at-login as an autostart entry, and the terminal
 * host's socket in the private runtime folder.
 */
async function driveLinux(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name: string) => {
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
  };
  const ctrl = async (key: string) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['control'] });
    await pause(400);
  };
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  await until(win, `document.querySelector('.rail-item[data-view="pulls"]')`, 15_000);
  report['platform'] = await read(win, `document.documentElement.dataset.platform`);
  report['labels'] = await read(win, `[...document.querySelectorAll('kbd')].map((k) => k.textContent)`);
  report['titlebarPadding'] = await read(win, `getComputedStyle(document.querySelector('.titlebar')).paddingLeft`);
  report['menuBarHidden'] = win.isMenuBarAutoHide();
  await read(win, `document.activeElement?.blur()`);
  await ctrl('K');
  report['ctrlKOpensSearch'] = await read(win, `Boolean(document.querySelector('.tsearch.open'))`);
  await shot('search');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await pause(300);

  // In a terminal, Ctrl+K is the shell's (cut to end of line).
  await read(win, `document.querySelector('.rail-item[data-view="sessions"]')?.click()`);
  const folders = await read(win, `window.kovan.settings().then((s) => s['repos.folders'])`) as string[];
  await read(win, `window.kovan.openTerminal(${JSON.stringify(folders[0])}, undefined, 'linux check')`);
  await until(win, `document.querySelector('.xterm-helper-textarea')`, 10_000);
  await read(win, `document.querySelector('.xterm-helper-textarea').focus()`);
  await pause(1_500);
  await ctrl('K');
  report['ctrlKInTerminalOpensSearch'] = await read(win, `Boolean(document.querySelector('.tsearch.open'))`);
  await shot('terminal');

  await read(win, `window.kovan.setSetting('launchAtLogin', true)`);
  await pause(500);
  const entry = path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'autostart', 'kovan.desktop');
  report['autostart'] = existsSync(entry) ? (await readFile(entry, 'utf8')).split('\n').find((l) => l.startsWith('Exec=')) : null;
  await read(win, `window.kovan.setSetting('launchAtLogin', false)`);
  await pause(500);
  report['autostartRemoved'] = !existsSync(entry);
  const runtime = process.env['XDG_RUNTIME_DIR'];
  report['socketInRuntimeDir'] = runtime ? readdirSync(runtime).filter((n) => n.startsWith('kovan-pty-')) : 'no XDG_RUNTIME_DIR';
  return report;
}

/**
 * The security review's fixes (2026-10): the window is sandboxed on Electron
 * 44, a screenshot still pastes after the clipboard API change, and links that
 * aren't http(s) or mailto never reach the OS. The clipboard is put back after.
 */
async function driveSecurity(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  await until(win, `document.querySelector('.rail-item[data-view="pulls"]')`, 15_000);
  report['electron'] = process.versions.electron;
  // Exists at runtime; Electron's own types leave it out.
  report['sandboxed'] = (win.webContents as unknown as { getLastWebPreferences(): { sandbox?: boolean } | null }).getLastWebPreferences()?.sandbox;
  report['bridge'] = await read(win, `typeof window.kovan?.sessionWrite`);
  report['nodeInWindow'] = await read(win, `typeof require + ' / ' + typeof process`);

  const saved = await clipboard.read().catch(() => []);
  try {
    const png = (await win.webContents.capturePage({ x: 0, y: 0, width: 40, height: 40 })).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
    const file = await read(win, `window.kovan.clipboardImagePath()`) as string;
    report['paste'] = file ? { file: file.split('/').slice(-2).join('/'), bytes: (await readFile(file)).length, png: png.length } : null;
  } finally {
    if (saved.length) await clipboard.write(saved).catch(() => undefined);
  }

  const before = Date.now();
  await read(win, `window.kovan.openExternal('file:///System/Applications/Calculator.app')`);
  await read(win, `window.open('file:///System/Applications/Calculator.app')`);
  await read(win, `window.kovan.openExternal('vscode://file/etc/hosts')`);
  await new Promise((r) => setTimeout(r, 800));
  report['refusedLinksElapsed'] = Date.now() - before;
  await writeFile(`${prefix}-done.txt`, 'ok');
  return report;
}

/** Item 136: GitHub, Jira and Sentry icons in grey, in each toolbar and the rail. */
async function driveItem136(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  await until(win, `document.querySelector('.rail-item[data-view="sentry"]')`, 15_000);
  for (const [view, service] of [['pulls', 'GitHub'], ['tickets', 'Jira'], ['sentry', 'Sentry']] as const) {
    await read(win, `document.querySelector('.rail-item[data-view="${view}"]')?.click()`);
    await until(win, `document.querySelector('.rows .row')`, 5_000);
    await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
    const sel = `.detail-place-icon[aria-label="Open on ${service}"]`;
    report[service] = await until(win, `document.querySelector('${sel} svg')`, 5_000)
      ? await read(win, `getComputedStyle(document.querySelector('${sel} svg path')).fill`) : null;
    await pause(500);
    const box = await read(win, `(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: Math.max(0, Math.round(r.x - 260)), y: Math.max(0, Math.round(r.y - 14)), width: 380, height: Math.round(r.height + 28) }; })()`) as Electron.Rectangle;
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${service}.png`, (await win.webContents.capturePage(box)).toPNG());
  }
  const rail = await read(win, `(() => { const r = document.querySelector('.rail-item[data-view="sentry"]').getBoundingClientRect(); return { x: 0, y: Math.max(0, Math.round(r.y - 140)), width: 70, height: 280 }; })()`) as Electron.Rectangle;
  await writeFile(`${prefix}-rail.png`, (await win.webContents.capturePage(rail)).toPNG());
  return report;
}

/**
 * Item 135: the Dock menu. Two workspaces are seeded in the profile's
 * settings.json before launch; the menu's own click handlers are called, the
 * same ones macOS calls.
 */
async function driveItem135(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const menu = latestDockMenu();
  if (!menu) return { menu: null };
  await menu.refresh();
  const describe = () => menu.template().map((i) => i.type === 'separator' ? '---' : `${i.checked ? '✓ ' : ''}${i.label}${i.icon ? ' [icon]' : ''}`);
  const click = (label: string) => (menu.template().find((i) => i.label === label)?.click as (() => void) | undefined)?.();
  const state = () => read(win, `({
    view: document.querySelector('.rail-item.active')?.dataset.view,
    workspace: document.querySelector('.ws-main')?.innerText.split('\\n')[0],
    roots: [...document.querySelectorAll('[data-root-row]')].map((r) => r.dataset.rootRow.split('/').pop() + (r.querySelector('.repo-main')?.getAttribute('aria-expanded') === 'true' ? ' (open)' : ''))
  })`);
  win.show();
  win.focus();
  await until(win, `document.querySelector('.rail-item[data-view="pulls"]')`, 15_000);
  const report: Record<string, unknown> = {};
  report['menu'] = describe();
  const other = menu.template().find((i) => i.type === 'checkbox' && !i.checked)?.label as string;
  click(other);
  await until(win, `document.querySelector('.rail-item.active')?.dataset.view === 'workspace' && document.querySelector('[data-root-row]')`, 8_000);
  await pause(600);
  report['afterWorkspace'] = await state();
  report['menuAfter'] = describe();
  const folder = menu.template().filter((i) => i.click && i.type !== 'checkbox').pop()?.label as string;
  await read(win, `document.querySelectorAll('.ws-root .repo-main[aria-expanded="true"]').forEach((b) => b.click())`);
  await pause(300);
  report['collapsed'] = await state();
  await read(win, `document.querySelector('.rail-item[data-view="pulls"]').click()`);
  await pause(400);
  click(folder);
  await pause(1_200);
  report['afterFolder'] = { picked: folder, ...(await state() as object) };
  win.webContents.invalidate();
  await pause(300);
  await writeFile(`${prefix}-folder.png`, (await win.webContents.capturePage()).toPNG());
  console.log(`shot: ${prefix}-folder.png`);
  report['afterShot'] = await state();
  await pause(1_500);
  report['later'] = await state();
  win.webContents.invalidate();
  await pause(300);
  await writeFile(`${prefix}-later.png`, (await win.webContents.capturePage()).toPNG());
  return report;
}

/**
 * Item 133: a red service chip and the toast's Details, clicked with the real
 * mouse (sendInputEvent), not `.click()`, must open the problems popover.
 */
async function driveItem133(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const mouse = async (selector: string) => {
    const r = await read(win, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`) as { x: number; y: number } | null;
    if (!r) return false;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await pause(400);
    return true;
  };
  const open = () => read(win, `document.querySelector('.problems-pop')?.innerText.slice(0, 120) ?? null`);
  win.show();
  win.focus();
  await until(win, `document.querySelector('.statusbar [data-provider]')`, 15_000);
  const report: Record<string, unknown> = {};
  const timeout = 'Request to https://sentry.io/api/0/organizations/acme/issues/ timed out after 15000ms';
  const last = trackProblems([], [{ provider: 'sentry', message: timeout }], [], Date.now());
  win.webContents.send('kovan:snapshot', { ...fixtureSnapshot(10), connected: ['github', 'jira', 'sentry'], errors: [{ provider: 'sentry', message: timeout }] });
  win.webContents.send('kovan:problems', { log: last.log, started: [last.log[0]] });
  await pause(600);
  report['toast'] = Boolean(await read(win, `document.querySelector('.problem-toast')`));
  report['detailsClicked'] = await mouse('.problem-toast-actions .link');
  report['afterDetails'] = await open();
  await mouse('.detail-pane, main');
  await pause(300);
  report['closedByOutside'] = !(await open());
  report['chipClicked'] = await mouse('.statusbar [data-provider="sentry"]');
  report['afterChip'] = await open();
  win.webContents.invalidate();
  await pause(300);
  await writeFile(`${prefix}-chip.png`, (await win.webContents.capturePage()).toPNG());
  console.log(`shot: ${prefix}-chip.png`);
  report['chipClickedAgain'] = await mouse('.statusbar [data-provider="sentry"]');
  report['toggledShut'] = !(await open());
  return report;
}

/** The terminal icon (item 132): the rail with Sessions selected. */
async function driveItem132(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  report['railFound'] = await until(win, `document.querySelector('.rail-item[data-view="sessions"]')`, 15_000);
  await read(win, `document.querySelector('.rail-item[data-view="sessions"]')?.click()`);
  report['boxless'] = await read(win, `!document.querySelector('.rail-item[data-view="sessions"] svg rect')`);
  await pause(800);
  const box = await read(win, `(() => { const r = document.querySelector('.rail-item[data-view="sessions"]').getBoundingClientRect(); return { x: 0, y: Math.max(0, Math.round(r.y - 120)), width: 260, height: 240 }; })()`) as Electron.Rectangle;
  win.webContents.invalidate();
  await pause(300);
  await writeFile(`${prefix}-rail.png`, (await win.webContents.capturePage(box)).toPNG());
  console.log(`shot: ${prefix}-rail.png`);
  return report;
}

async function driveItem131(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  report['railFound'] = await until(win, `document.querySelector('.rail-item[data-view="tickets"]')`, 15_000);
  await read(win, `document.querySelector('.rail-item[data-view="tickets"]')?.click()`);
  await until(win, `document.querySelector('.rows .row')`, 5_000);
  await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
  report['iconFound'] = await until(win, `document.querySelector('.detail-place-icon[aria-label="Open on Jira"] svg rect')`, 5_000);
  for (const theme of ['dark', 'light']) {
    // The tokens follow the root's data-theme; this is only a look at both.
    await read(win, `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await pause(800);
    const box = await read(win, `(() => { const r = document.querySelector('.detail-place-icon[aria-label="Open on Jira"]').getBoundingClientRect(); return { x: Math.max(0, Math.round(r.x - 260)), y: Math.max(0, Math.round(r.y - 14)), width: 340, height: Math.round(r.height + 28) }; })()`) as Electron.Rectangle;
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${theme}.png`, (await win.webContents.capturePage(box)).toPNG());
    console.log(`shot: ${prefix}-${theme}.png`);
  }
  return report;
}

async function driveItem129(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(600);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  report['railFound'] = await until(win, `document.querySelector('.rail-item[data-view="sessions"]')`, 15_000);
  await read(win, `document.querySelector('.rail-item[data-view="sessions"]')?.click()`);
  // A folder from the profile's settings.json (written before launch), so
  // the session is listed in Sessions.
  const folders = await read(win, `window.kovan.settings().then((s) => s['repos.folders'])`) as string[];
  const folder = folders[0]!;
  const opened = await read(win, `window.kovan.openTerminal(${JSON.stringify(folder)}, undefined, 'tui 129')`) as { id: string };
  await until(win, `document.querySelector('.term .xterm-rows')`, 10_000);
  // The shell's prompt first: typed into a half-started shell, the line can
  // run before the profile has finished, and the prompt then lands on top.
  await until(win, `Array.from(document.querySelectorAll('.term .xterm-rows > div')).some((r) => r.textContent.trim())`, 15_000);
  await pause(2_500);
  // Draws like Claude Code: a box at the bottom drawn once, then only the
  // cells that change rewritten in place — a timer ticking in the status line.
  const script = path.join(app.getPath('userData'), 'tui129.py');
  await writeFile(script, [
    'import shutil, signal, sys, time',
    'out = sys.stdout.write',
    'def at(row, col, text): out(f"\\x1b[{row};{col}H{text}")',
    'def draw(*_):',
    '    global w, h',
    '    w, h = shutil.get_terminal_size()',
    '    out("\\x1b[2J\\x1b[H")',
    '    for i in range(12): print(f"{i:02d} " + "history " * 8)',
    '    at(h - 4, 1, "╭" + "─" * (w - 2) + "╮")',
    '    at(h - 3, 1, "│ > typed here".ljust(w - 1) + "│")',
    '    at(h - 2, 1, "╰" + "─" * (w - 2) + "╯")',
    '    at(h - 1, 1, "  status tick 0s   tokens 0")',
    '    sys.stdout.flush()',
    // Like Claude Code: a resize draws everything again.
    'signal.signal(signal.SIGWINCH, draw)',
    'draw()',
    // More ticks than the 256 KB a replay keeps, so the box itself is no
    // longer in the replay: only the ticks are, as after a long Claude turn.
    'for tick in range(1, 40001):',
    '    at(h - 1, 15, str(tick % 10)); at(h - 1, 27, str(tick % 7)); at(h - 3, 15, "")',
    'sys.stdout.flush()',
    'time.sleep(3600)'
  ].join('\n'));
  await read(win, `window.kovan.sessionWrite(${JSON.stringify(opened.id)}, ${JSON.stringify(`clear; python3 '${script}'\r`)})`);
  await until(win, `Array.from(document.querySelectorAll('.term .xterm-rows > div')).some((r) => r.textContent.includes('typed here'))`, 15_000);
  await pause(2_500);
  const screen = () => read(win, `Array.from(document.querySelectorAll('.term .xterm-rows > div')).map((r) => r.textContent.replace(/\\s+$/, '')).filter(Boolean).slice(-5)`);
  report['before'] = await screen();
  await snap('before');
  await read(win, `document.querySelector('.rail-item[data-view="pulls"]')?.click()`);
  await pause(1_500);
  report['termGoneWhileAway'] = await read(win, `!document.querySelector('.term .xterm-rows')`);
  await read(win, `document.querySelector('.rail-item[data-view="sessions"]')?.click()`);
  await until(win, `document.querySelector('.term .xterm-rows')`, 5_000);
  await pause(1_000);
  report['after'] = await screen();
  report['same'] = JSON.stringify(report['before']) === JSON.stringify(report['after']);
  await snap('after');
  // A new window has no kept xterm and replays the output, which by now has
  // lost the box to the cap: it has to have the program draw it again.
  report['replay'] = await read(win, `window.kovan.sessionBuffer(${JSON.stringify(opened.id)}).then((r) => ({ grid: r.cols + 'x' + r.rows, truncated: r.truncated, startsWith: JSON.stringify(r.data.slice(0, 12)) }))`);
  win.webContents.reload();
  await until(win, `document.querySelector('#root')?.children.length > 0`, 15_000);
  win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
  await until(win, `document.querySelector('.rail-item[data-view="sessions"]')`, 10_000);
  await read(win, `document.querySelector('.rail-item[data-view="sessions"]')?.click()`);
  await until(win, `document.querySelector('.term .xterm-rows')`, 5_000);
  await pause(2_000);
  report['afterReload'] = await screen();
  // The redraw restarts the counters; everything else must match.
  const counters = (lines: unknown) => JSON.stringify(lines).replace(/tick \d+|tokens \d+/g, '');
  report['sameAfterReload'] = counters(report['afterReload']) === counters(report['before']);
  await snap('after-reload');
  await read(win, `window.kovan.sessionClose(${JSON.stringify(opened.id)})`);
  return report;
}

async function driveItem126(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(800);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  // The watched folder comes from the profile's settings.json, written before
  // launch: a reload to pick up a new one would drop the seeded data.
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  report['railFound'] = await until(win, `document.querySelector('.rail-item[data-view="sessions"]')`, 15_000);
  await read(win, `document.querySelector('.rail-item[data-view="sessions"]')?.click()`);
  report['plusFound'] = await until(win, `document.querySelector('.new-session-host button')`, 5_000);
  if (!report['plusFound']) return report;
  const openMenu = async () => {
    await read(win, `document.querySelector('.new-session-host button').click()`);
    await until(win, `document.querySelector('.new-session-host .menu')`, 5_000);
  };
  const segments = () => read(win, `Array.from(document.querySelectorAll('.shell-switch .seg')).map((b) => b.textContent + (b.classList.contains('on') ? ' ✓' : ''))`);

  await openMenu();
  report['segmentsAtFirst'] = await segments();
  await snap('menu-default');
  await read(win, `Array.from(document.querySelectorAll('.shell-switch .seg')).find((b) => b.textContent === 'More…')?.click()`);
  await pause(200);
  report['more'] = await read(win, `Array.from(document.querySelectorAll('.new-session-host .menu > button')).map((b) => b.textContent)`);
  await snap('menu-more');
  await read(win, `Array.from(document.querySelectorAll('.shell-switch .seg')).find((b) => b.textContent === 'bash')?.click()`);
  await pause(300);
  report['segmentsAfterBash'] = await segments();
  await read(win, `Array.from(document.querySelectorAll('.new-session-host .menu > button')).find((b) => !b.closest('.shell-switch') && b.textContent.includes('acme-web'))?.click()`);
  await until(win, `document.querySelector('.row-shell')`, 10_000);
  await pause(2_500);
  const sessions = await read(win, `window.kovan.sessions()`) as { id: string; shell?: string }[];
  report['sessionShell'] = sessions.map((x) => x.shell);
  report['rowTag'] = await read(win, `document.querySelector('.row-shell')?.textContent`);
  report['saved'] = await read(win, `window.kovan.settings().then((s) => s['terminal.shell'])`);
  // What the pty really runs: the shell itself writes its name and version to a file.
  const out = path.join(app.getPath('userData'), 'shell126.txt');
  await read(win, `window.kovan.sessionWrite(${JSON.stringify(sessions[0]?.id)}, ${JSON.stringify(`echo "$0 $BASH_VERSION" > '${out}'\r`)})`);
  await pause(1_500);
  report['ptyRuns'] = await readFile(out, 'utf8').then((t) => t.trim(), () => 'nothing written');
  await snap('terminal-bash');

  await openMenu();
  report['segmentsReopened'] = await segments();
  await read(win, `document.body.click()`);
  await read(win, `document.querySelector('.rail-item[aria-label="Settings"]')?.click()`);
  await until(win, `document.querySelector('.settings-list')`, 5_000);
  report['textSummary'] = await read(win, `document.querySelector('.settings-row[data-section="text"] .settings-row-summary')?.textContent`);
  await read(win, `document.querySelector('.settings-row[data-section="text"] .settings-row-head')?.click()`);
  await pause(500);
  report['settingValue'] = await read(win, `Array.from(document.querySelectorAll('.settings-row.open label')).find((l) => l.textContent.includes('Shell for new terminals'))?.querySelector('select')?.value`);
  await snap('settings');
  return report;
}

async function driveItem124(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(1_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.show();
  win.focus();
  await until(win, `document.querySelector('.rows .row')`, 15_000);
  const report: Record<string, unknown> = {};
  const headerButtons = () => read(win, `Array.from(document.querySelectorAll('.detail-toolbar-end button, .detail-head .detail-actions button')).map((b) => b.textContent.trim()).filter(Boolean)`);
  const cards = () => read(win, `Array.from(document.querySelectorAll('.quick-card h3, .quick-card .quick-card-title')).map((h) => h.textContent.trim())`);
  const openPull = async () => {
    await read(win, `document.querySelector('.rail-item[data-view="pulls"]')?.click()`);
    await pause(400);
    await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
    await pause(1_200);
  };
  const box = (label: string) => `Array.from(document.querySelectorAll('.settings-row.open .checkbox-row')).find((r) => r.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input')`;

  await openPull();
  report['offButtons'] = await headerButtons();
  await snap('pull-default');

  await read(win, `document.querySelector('.rail-item[aria-label="Settings"]')?.click()`);
  await until(win, `document.querySelector('.settings-list')`, 5_000);
  await read(win, `document.querySelector('.settings-row[data-section="agents"] .settings-row-head')?.click()`);
  await pause(500);
  report['boxesAtFirst'] = await read(win, `Array.from(document.querySelectorAll('.settings-row.open .checkbox-row')).slice(0, 3).map((r) => r.textContent.trim() + ': ' + r.querySelector('input').checked)`);
  report['quickModelShown'] = await read(win, `Array.from(document.querySelectorAll('.settings-row.open h3')).map((h) => h.textContent)`);
  report['agentsSummary'] = await read(win, `document.querySelector('.settings-row[data-section="agents"] .settings-row-summary')?.textContent`);
  await snap('settings-default');
  await read(win, `${box('Summarize')}?.click()`);
  await read(win, `${box('Review')}?.click()`);
  await pause(400);
  report['buttonsBehindSheet'] = await headerButtons();
  await snap('settings-ticked');
  await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
  await pause(600);
  report['onButtons'] = await headerButtons();
  await snap('pull-on');

  // Off again, Condense too: every quick button and the quick model settings go.
  await read(win, `document.querySelector('.rail-item[aria-label="Settings"]')?.click()`);
  await until(win, `document.querySelector('.settings-list')`, 5_000);
  if (!(await read(win, `Boolean(document.querySelector('.settings-row.open[data-section="agents"]'))`))) {
    await read(win, `document.querySelector('.settings-row[data-section="agents"] .settings-row-head')?.click()`);
    await pause(500);
  }
  for (const label of ['Summarize', 'Review', 'Condense earlier comments']) await read(win, `${box(label)}?.click()`);
  await pause(400);
  report['quickModelWhenAllOff'] = await read(win, `Array.from(document.querySelectorAll('.settings-row.open h3')).map((h) => h.textContent)`);
  report['agentsSummaryAllOff'] = await read(win, `document.querySelector('.settings-row[data-section="agents"] .settings-row-summary')?.textContent`);
  await snap('settings-all-off');
  await read(win, `document.querySelector('.sheet-head button[aria-label="Close"], .sheet-head .ghost')?.click()`);
  await pause(600);
  report['offAgainButtons'] = await headerButtons();
  report['cardsWhenOff'] = await cards();
  report['saved'] = await read(win, `window.kovan.settings().then((s) => ({ summarize: s['buttons.summarize'], review: s['buttons.review'], condense: s['buttons.condense'] }))`);
  return report;
}

async function driveItem118(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.show();
  win.focus();
  const density = process.env['KOVAN_DENSITY'] === 'compact' ? 'compact' : 'comfortable';
  await read(win, `window.kovan.setSetting('appearance.density', '${density}')`);
  win.webContents.reload();
  await pause(2_500);
  // The reload drops the seeded snapshot: send it again.
  win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
  await until(win, `document.querySelector('.rows .row')`, 15_000);
  const report: Record<string, unknown> = { density };
  const head = () => read(win, `(() => {
    const bar = document.querySelector('.detail-toolbar'); const h = document.querySelector('.detail-head');
    return { toolbar: bar ? bar.innerText.replace(/\\n+/g, ' | ') : null, head: h ? h.innerText.replace(/\\n+/g, ' | ').slice(0, 300) : null,
      headHeight: h ? Math.round(h.getBoundingClientRect().height) : null, chips: [...document.querySelectorAll('.detail-related-link')].map((c) => c.textContent) };
  })()`);
  for (const [view, name] of [['tickets', 'ticket'], ['pulls', 'pull'], ['sentry', 'sentry']] as const) {
    await read(win, `document.querySelector('.rail-item[data-view="${view}"]')?.click()`);
    await pause(400);
    await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
    await pause(1_200);
    report[name] = await head();
    await snap(`${density}-${name}`);
  }
  // A pull request's ticket chip opens that ticket (the note on option C).
  await read(win, `document.querySelector('.rail-item[data-view="pulls"]')?.click()`);
  await pause(300);
  await read(win, `document.querySelectorAll('.rows .row')[0]?.click()`);
  await pause(800);
  await read(win, `document.querySelector('.detail-related-link')?.click()`);
  await pause(800);
  report['chipOpens'] = await read(win, `({ view: document.querySelector('.rail-item.active')?.getAttribute('data-view'), title: document.querySelector('.detail-head h2')?.textContent })`);
  if (density === 'comfortable') {
    await read(win, `document.querySelector('.detail-scroll').scrollTop = 600`);
    await pause(300);
    report['afterScroll'] = await read(win, `(() => { const bar = document.querySelector('.detail-toolbar').getBoundingClientRect();
      const pane = document.querySelector('.detail-scroll').getBoundingClientRect();
      return { scrolled: document.querySelector('.detail-scroll').scrollTop, toolbarTop: Math.round(bar.top - pane.top) }; })()`);
    await snap('comfortable-scrolled');
  }
  return report;
}

/**
 * Item 119: a mention and an assignment arriving — the toast, the Activity
 * rows with who and what was written, and the new switch in Settings.
 */
async function driveItem119(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.show();
  win.focus();
  await until(win, `document.querySelector('.rail-item[data-view="activity"]')`, 15_000);
  const report: Record<string, unknown> = {};
  const now = Date.now();
  const mention = {
    id: 'mentioned:ACME-2393:100', kind: 'mentioned', at: now, subject: 'ACME-2393', label: 'ACME-2393',
    title: 'Make cut-off tables scroll and reveal check-in row actions on hover', who: 'Giovanni',
    excerpt: '@Idris can you check the parent view on the iPad before we move it to QA?', url: 'https://example.invalid/browse/ACME-2393', read: false
  };
  const assigned = {
    id: 'new-ticket:ACME-1000:2026-09-30', kind: 'new-ticket', at: now - 60_000, subject: 'ACME-1000', label: 'ACME-1000',
    title: 'Tidy up the empty-state copy on the dashboard', who: 'Yisong', url: 'https://example.invalid/browse/ACME-1000', read: false
  };
  win.webContents.send('kovan:activity', [mention, assigned]);
  win.webContents.send('kovan:activity-toast', [mention]);
  await pause(600);
  report['toast'] = await read(win, `document.querySelector('.toast')?.innerText ?? null`);
  await snap('toast');
  await read(win, `document.querySelector('.rail-item[data-view="activity"]')?.click()`);
  await pause(800);
  report['rows'] = await read(win, `[...document.querySelectorAll('.rows .row')].slice(0, 2).map((r) => r.innerText.replace(/\\n+/g, ' | '))`);
  await snap('activity');
  report['settingsKinds'] = await read(win, `window.kovan.settings().then(() => true)`);
  return report;
}

/**
 * Item 120 (option B): Sentry times out. No strip; a toast, a red chip in the
 * status bar, and the chip's popover with Now and the earlier problems.
 */
async function driveItem120(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.show();
  win.focus();
  await until(win, `document.querySelector('.statusbar [data-provider]')`, 15_000);
  const report: Record<string, unknown> = {};
  const timeout = 'Request to https://sentry.io/api/0/organizations/acme/issues/?query=is%3Aunresolved&limit=25&statsPeriod=14d timed out after 15000ms';
  const now = Date.now();
  const day = 86_400_000;
  let log = trackProblems([], [{ provider: 'github', message: 'HTTP 401 Bad credentials' }], [], now - 2 * day).log;
  log = trackProblems(log, [], ['github'], now - 2 * day + 20 * 60_000).log;
  log = trackProblems(log, [{ provider: 'jira', message: 'HTTP 429 Too Many Requests' }], [], now - day).log;
  log = trackProblems(log, [], ['jira'], now - day + 60_000).log;
  log = trackProblems(log, [{ provider: 'sentry', message: timeout }], [], now - 11 * 60_000).log;
  const last = trackProblems(log, [{ provider: 'sentry', message: timeout }], [], now);
  win.webContents.send('kovan:snapshot', { ...fixtureSnapshot(10), connected: ['github', 'jira', 'sentry'], errors: [{ provider: 'sentry', message: timeout }] });
  win.webContents.send('kovan:problems', { log: last.log, started: [last.log[0]] });
  await pause(600);
  report['strip'] = await read(win, `Boolean(document.querySelector('.errors'))`);
  report['chip'] = await read(win, `[...document.querySelectorAll('.statusbar [data-provider]')].map((b) => b.textContent + (b.classList.contains('problem') ? ' (red)' : ''))`);
  report['toast'] = await read(win, `document.querySelector('.problem-toast')?.innerText ?? null`);
  await snap('toast');
  await read(win, `document.querySelector('.statusbar [data-provider="sentry"]').click()`);
  await pause(400);
  report['popover'] = await read(win, `(() => { const p = document.querySelector('.problems-pop'); if (!p) return null; const r = p.getBoundingClientRect();
    return { text: p.innerText, onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
  await snap('popover');
  await snap('popover-2');
  await read(win, `document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.body.click()`);
  await pause(300);
  report['closesOnOutsideClick'] = await read(win, `!document.querySelector('.problems-pop')`);
  return report;
}

async function driveItem108(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.focus();
  const report: Record<string, unknown> = {};
  await read(win, `document.querySelector('.rows .row')?.click()`);
  await until(win, `document.querySelector('.detail-actions button, .run-buttons button')`, 8_000);
  await read(win, `Array.from(document.querySelectorAll('button')).find(b => /in an agent/.test(b.textContent))?.click()`);
  await until(win, `document.querySelector('.run-controls select')?.options.length > 0`, 15_000);
  await pause(1_500);
  const options = await read(win, `Array.from(document.querySelector('.run-controls select').options).map(o => ({ value: o.value, text: o.textContent }))`) as { value: string; text: string }[];
  report['agents'] = options.map((o) => o.text);
  for (const option of options.filter((o) => /claude|codex|opencode/i.test(o.text)).slice(0, 4)) {
    await read(win, `(() => { const s = document.querySelector('.run-controls select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(s, ${JSON.stringify(option.value)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pause(300);
    report[option.text] = await read(win, `document.querySelector('.agent-limits')?.innerText ?? null`);
    await snap(option.value.replace(/[^\w-]/g, '_'));
  }
  return report;
}

/**
 * Item 101 (option B): the first refresh after launch, played as the poller
 * publishes it — every service loading, then one by one answering (one of
 * them failing) — and then the normal view once all are in. Stamped in the
 * future so the real poller's own first answer can't overtake the script.
 */
async function driveItem101(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.focus();
  await until(win, `document.querySelector('#root')?.children.length > 0`);
  const report: Record<string, unknown> = {};
  report['beforeAnything'] = await read(win, `({ empty: Boolean(document.querySelector('.empty')), boot: Boolean(document.querySelector('.boot')) })`);
  const base = { ...fixtureSnapshot(0), at: 0, connected: ['github', 'jira', 'sentry'] as never, refreshing: true };
  const future = Date.now() + 10 * 365 * 24 * 3600 * 1000;
  const send = (booting: unknown, at = future) => win.webContents.send('kovan:snapshot', { ...base, at, booting });
  const steps = () => read(win, `Array.from(document.querySelectorAll('.boot-step')).map(li => li.className.replace('boot-step ', '') + ': ' + li.textContent)`);

  send([{ provider: 'github', state: 'loading' }, { provider: 'jira', state: 'loading' }, { provider: 'sentry', state: 'loading' }]);
  await pause(300);
  report['loading'] = await steps();
  report['noEmpty'] = await read(win, `!document.querySelector('.empty')`);
  await snap('loading');
  send([{ provider: 'github', state: 'done', count: 4 }, { provider: 'jira', state: 'loading' }, { provider: 'sentry', state: 'failed', message: 'HTTP 401 — the token was rejected' }], future + 1);
  await pause(300);
  report['partial'] = await steps();
  await snap('partial');
  win.webContents.send('kovan:snapshot', { ...fixtureSnapshot(10), at: future + 2 });
  await until(win, `document.querySelector('.rail')`, 5_000).catch(() => undefined);
  report['after'] = await read(win, `({ boot: Boolean(document.querySelector('.boot')), rail: Boolean(document.querySelector('.rail')) })`);
  return report;
}

/**
 * Item 104: a running session's × must open its "Stop and close?" popover
 * next to the button and on screen — at the default sidebar size and at a
 * larger one — and "Stop and close" must close the session.
 */
/**
 * Items 112, 114 and 115 together. Three sessions whose shells write their
 * status the way an agent's hook does (one through the real hook script),
 * the badges they get, the hover card on a ticket's session, and then a
 * second client picking the same sessions up from the terminal host — what a
 * restarted Kovan does.
 */
async function driveItem112(win: BrowserWindow, sessions: Sessions, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.show();
  win.focus();
  const report: Record<string, unknown> = {};
  // The seeded fixture's own ticket and pull request.
  const snapshot = { ticket: 'ACME-2393', pull: 'acme/web#42' };
  report['subjects'] = snapshot;
  const userData = app.getPath('userData');
  const status = new AgentStatus(userData);
  const claude = await status.forRunner({ id: 'claude', name: 'Claude Code', command: 'claude', leadingArgs: [], acceptsPrompt: true, promptFile: false } as unknown as Runner);
  report['claudeHooks'] = Object.keys((claude.claudeSettings?.['hooks'] ?? {}) as object);
  const hook = path.join(userData, 'bin', 'kovan-agent-status.sh');

  const done = await sessions.open({
    cwd: userData, title: `implement · ${snapshot.ticket ?? 'ACME-1'}`, subject: snapshot.ticket, kind: 'implement', runnerName: 'Claude Code',
    statusSource: 'claude', line: `sleep 1; echo '{}' | '${hook}' done claude; sleep 300`
  });
  const input = await sessions.open({
    cwd: userData, title: `review · ${snapshot.pull ?? 'a/b#1'}`, subject: snapshot.pull, kind: 'review', runnerName: 'Codex',
    statusSource: 'claude', line: `sleep 1; echo '{"notification_type":"permission_prompt"}' | '${hook}' input claude; sleep 300`
  });
  await sessions.open({
    cwd: userData, title: 'implement · ACME-2', subject: 'ACME-2', kind: 'implement', runnerName: 'OpenCode',
    statusSource: 'opencode', line: 'sleep 300'
  });
  // An idle "waiting for your input" after a turn must not turn Done into Input.
  await pause(2_500);
  await sessions.open({ cwd: userData, title: 'plain terminal', runnerName: 'Shell', line: `echo '{"notification_type":"idle_prompt"}' | KOVAN_SESSION_ID=${done.id} '${hook}' input claude` });
  await read(win, `document.querySelector('.rail-item[aria-label="Sessions"]')?.click()`);
  await until(win, `document.querySelectorAll('.row.one-line').length >= 4`, 8_000);
  await pause(3_000);
  report['states'] = sessions.list().map((s) => ({ title: s.title, status: s.status, hosted: s.hosted }));
  report['badges'] = await read(win, `[...document.querySelectorAll('.row.one-line')].map((r) => (r.querySelector('.row-title')?.textContent ?? '') + ' → ' + (r.querySelector('.session-state')?.textContent ?? '—'))`);
  await snap('badges');

  // Hover the ticket's session for the card.
  const box = await read(win, `(() => { const row = [...document.querySelectorAll('.row.one-line')].find((r) => r.textContent.includes(${JSON.stringify(snapshot.ticket ?? 'ACME-1')}));
    const r = row.getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`) as { x: number; y: number };
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x + 300, y: box.y + 300 });
  await pause(100);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
  await pause(50);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x + 4, y: box.y });
  await until(win, `Boolean(document.querySelector('.hover-card'))`, 4_000);
  report['card'] = await read(win, `(() => { const c = document.querySelector('.hover-card'); if (!c) return null; const r = c.getBoundingClientRect();
    return { text: c.innerText, box: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
  await snap('card');
  // The pull request's session too.
  const box2 = await read(win, `(() => { const row = [...document.querySelectorAll('.row.one-line')].find((r) => r.textContent.includes('review'));
    const r = row.getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`) as { x: number; y: number };
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box2.x, y: box2.y });
  await pause(50);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box2.x + 4, y: box2.y });
  await pause(1_200);
  report['pullCard'] = await read(win, `document.querySelector('.hover-card')?.innerText ?? null`);
  await snap('pull-card');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x + 900, y: box.y + 300 });

  // Opening the Done session clears its badge.
  await read(win, `[...document.querySelectorAll('.row.one-line')].find((r) => r.textContent.includes(${JSON.stringify(snapshot.ticket ?? 'ACME-1')}))?.click()`);
  await pause(1_500);
  report['afterOpen'] = await read(win, `[...document.querySelectorAll('.row.one-line')].map((r) => (r.querySelector('.row-title')?.textContent ?? '') + ' → ' + (r.querySelector('.session-state')?.textContent ?? '—'))`);
  await snap('after-open');

  // Finishing while another session is on screen: Done stays until it's looked at.
  // Rows select on pointer events, so a real click.
  win.webContents.sendInputEvent({ type: 'mouseDown', x: box2.x, y: box2.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: box2.x, y: box2.y, button: 'left', clickCount: 1 });
  await pause(800);
  sessions.setStatus(done.id, 'working');
  await pause(300);
  sessions.setStatus(done.id, 'done');
  await pause(1_000);
  report['doneUnseen'] = await read(win, `[...document.querySelectorAll('.row.one-line')].map((r) => (r.querySelector('.row-title')?.textContent ?? '') + ' → ' + (r.querySelector('.session-state')?.textContent ?? '—'))`);
  await snap('done-unseen');

  // Item 114: what a restarted Kovan gets back from the terminal host.
  const again = new Sessions(undefined, { hosts: new PtyHosts(userData) });
  report['restored'] = await again.restore();
  report['restoredSessions'] = again.list().map((s) => ({ title: s.title, running: s.running, hosted: s.hosted, status: s.status, subject: s.subject }));
  report['restoredBuffer'] = again.buffer(input.id).data.length;
  again.detachAll();
  return report;
}

async function driveItem104(win: BrowserWindow, sessions: Sessions, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  win.focus();
  const report: Record<string, unknown> = {};
  for (const name of ['first agent', 'second agent']) {
    await sessions.open({ cwd: app.getPath('userData'), title: name, runnerName: 'Claude Code', line: 'sleep 300' });
  }
  await read(win, `document.querySelector('.rail-item[aria-label="Sessions"]')?.click()`);
  await until(win, `document.querySelectorAll('.row.one-line').length >= 2`, 8_000);
  await pause(1_500);

  const tryClose = async (label: string) => {
    // Hover the row (the × only shows on hover), then a real click on the ×.
    const box = await read(win, `(() => { const row = document.querySelectorAll('.row.one-line')[1];
      const r = row.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`) as { x: number; y: number };
    // Hover needs real movement into the row, and a window that takes input.
    win.show();
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x + 200, y: box.y + 200 });
    await pause(100);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
    await pause(250);
    const btn = await read(win, `(() => { const row = document.querySelectorAll('.row.one-line')[1];
      const b = row.querySelector('.session-close'); const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), shown: getComputedStyle(b).display }; })()`) as { x: number; y: number; shown: string };
    win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    await pause(400);
    report[label] = {
      button: btn,
      ...(await read(win, `(() => { const p = document.querySelector('.session-close-confirm');
        if (!p) return { popover: null, armed: Boolean(document.querySelector('.session-close.armed')) };
        const r = p.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { popover: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
          onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          onTop: Boolean(hit?.closest('.session-close-confirm')), window: { w: innerWidth, h: innerHeight } }; })()`) as Record<string, unknown>)
    };
    await snap(label);
  };

  await tryClose('at100');
  await read(win, `document.querySelector('.session-close-confirm button:not(.menu-warn)')?.click()`);
  await pause(200);
  // A larger sidebar, as someone with a big screen would set it.
  await read(win, `localStorage.setItem('kovan.sidebar-size', '130'); document.documentElement.style.setProperty('--sidebar-zoom', '1.3')`);
  await pause(300);
  await tryClose('at130');
  await read(win, `document.querySelector('.session-close-confirm .menu-warn')?.click()`);
  await pause(1_200);
  report['rowsLeft'] = await read(win, `document.querySelectorAll('.row.one-line').length`);
  return report;
}

/**
 * Item 99 (option B): Settings opens as seven summarised rows; a row opens in
 * place and another row closes it; search narrows the rows and names the
 * settings that matched, and choosing one opens its section at it.
 */
async function driveItem99(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const head = (id: string) => read(win, `document.querySelector('.settings-row[data-section="${id}"] .settings-row-head')?.click()`);
  const openRows = () => read(win, `Array.from(document.querySelectorAll('.settings-row.open')).map(r => r.dataset.section)`);
  const search = (text: string) => read(win, `(() => { const f = document.getElementById('settings-search'); f.focus(); f.select(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
  win.focus();
  const report: Record<string, unknown> = {};

  await read(win, `document.querySelector('.rail-item[aria-label="Settings"]')?.click()`);
  await until(win, `document.querySelector('.settings-list')`, 5_000);
  await pause(400);
  report['rows'] = await read(win, `Array.from(document.querySelectorAll('.settings-row')).map(r => r.querySelector('.settings-row-title').textContent + ' — ' + r.querySelector('.settings-row-summary').textContent)`);
  report['searchFocused'] = await read(win, `document.activeElement?.id === 'settings-search'`);
  await snap('closed');

  await head('text');
  await pause(200);
  report['openText'] = await openRows();
  await head('agents');
  await pause(300);
  report['openAgents'] = await openRows();
  await snap('agents-open');
  await head('agents');
  await pause(200);
  report['allClosed'] = await openRows();

  await search('key');
  await pause(200);
  report['searchKey'] = await read(win, `Array.from(document.querySelectorAll('.settings-row')).map(r => ({ row: r.dataset.section, hits: Array.from(r.querySelectorAll('.settings-hit')).map(h => h.textContent) }))`);
  await snap('search-key');
  await read(win, `Array.from(document.querySelectorAll('.settings-row[data-section="dictation"] .settings-hit')).find(h => h.textContent === 'API key')?.click()`);
  await pause(600);
  report['afterHit'] = await openRows();

  await search('zzz');
  await pause(150);
  report['noMatch'] = await read(win, `document.querySelector('.settings-none')?.textContent ?? null`);
  await search('idle');
  await pause(150);
  report['searchIdle'] = await read(win, `Array.from(document.querySelectorAll('.settings-row')).map(r => r.dataset.section)`);
  return report;
}

/**
 * Item 100: ⌘P from the pull requests view, pressed as keys. Typing finds a
 * file, Enter opens it in the Workspace; ⌘P again lists it as recently
 * opened; "name:40" opens a file with the caret on line 40.
 */
async function driveItem100(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name: string) => {
    await pause(2_500);
    win.webContents.invalidate();
    await pause(300);
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const press = async (keyCode: string, modifiers: ('meta')[] = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await pause(150);
  };
  const type = (text: string) => read(win, `(() => { const f = document.getElementById('quick-open-input'); f.focus(); f.select(); document.execCommand('insertText', false, ${JSON.stringify(text)}); return f.value; })()`);
  const rows = () => read(win, `Array.from(document.querySelectorAll('.quick-open-row')).slice(0, 5).map(r => r.textContent)`);
  win.focus();
  win.webContents.focus();
  const report: Record<string, unknown> = {};

  await press('P', ['meta']);
  report['opened'] = await until(win, `document.querySelector('.quick-open')`, 3_000);
  report['emptyState'] = await read(win, `document.querySelector('.quick-open-empty')?.textContent ?? null`);
  await type('quickopen');
  await until(win, `document.querySelectorAll('.quick-open-row').length > 0`, 20_000);
  report['typed'] = await rows();
  await snap('typed');
  await press('Return');
  await until(win, `document.querySelector('.workspace .tab-path, .tab-path')`, 8_000);
  await pause(500);
  report['afterEnter'] = await read(win, `({ picker: Boolean(document.querySelector('.quick-open')), tab: document.querySelector('.tab-path')?.textContent ?? null })`);

  await press('P', ['meta']);
  await until(win, `document.querySelector('.quick-open-row')`, 3_000);
  report['recent'] = await rows();
  await snap('recent');

  await type('poller.ts:40');
  await until(win, `Array.from(document.querySelectorAll('.quick-open-row')).some(r => r.textContent.includes('poller.ts'))`, 5_000);
  report['foot'] = await read(win, `document.querySelector('.quick-open-foot')?.textContent ?? null`);
  await press('Return');
  await until(win, `(document.querySelector('.status-bar')?.textContent ?? '').includes('Ln 40')`, 8_000);
  report['atLine'] = await read(win, `document.querySelector('.status-bar')?.textContent ?? null`);
  await snap('at-line');

  await press('P', ['meta']);
  await until(win, `document.querySelector('.quick-open')`, 3_000);
  await press('Escape');
  report['escCloses'] = await read(win, `!document.querySelector('.quick-open')`);
  return report;
}

/**
 * Item 98: the screenshot's layout — a run on a pull request, its terminal
 * docked on the right — then "watch". The viewer must cover the window and
 * be what's on top at every corner of itself, terminal side included.
 */
async function driveItem98(win: BrowserWindow, sessions: Sessions, prefix: string): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const store = new RunStore(RunStore.rootFor(app.getPath('userData')));
  const run = await store.begin({ subject: 'acme/web#42', pull: 'acme/web#42', kind: 'unblock', prompt: 'Unblock it.' });
  await sessions.open({
    cwd: app.getPath('userData'), title: 'unblock · acme/web#42', runnerName: 'smoke', line: 'sleep 300',
    kind: 'unblock', subject: 'acme/web#42', pull: 'acme/web#42', runDirectory: run.directory
  });
  await read(win, `localStorage.setItem('kovan.terminal-dock', 'right')`);
  win.focus();
  await read(win, `Array.from(document.querySelectorAll('.rows .row .row-num')).find(e => e.textContent === '42')?.closest('button')?.click()`);
  await until(win, `Array.from(document.querySelectorAll('.runs button.link')).some(b => b.textContent.trim() === 'watch')`, 10_000);
  await pause(800);
  const docked = await read(win, `Boolean(document.querySelector('.pane .term, .term'))`);
  await read(win, `Array.from(document.querySelectorAll('.runs button.link')).find(b => b.textContent.trim() === 'watch').click()`);
  await until(win, `document.querySelector('.run-viewer')`, 5_000);
  await pause(400);
  // capturePage lags the page by a few seconds here (it handed back frames
  // from before "watch" was clicked); wait, and ask for a fresh frame.
  await pause(4_000);
  win.webContents.invalidate();
  await pause(300);
  await writeFile(`${prefix}-viewer.png`, (await win.webContents.capturePage()).toPNG());
  console.log(`shot: ${prefix}-viewer.png`);
  return {
    docked,
    ...(await read(win, `(() => {
      const back = document.querySelector('.sheet-backdrop').getBoundingClientRect();
      const sheet = document.querySelector('.run-viewer').getBoundingClientRect();
      const onTop = (x, y) => Boolean(document.elementFromPoint(x, y)?.closest('.run-viewer'));
      return {
        backdropCoversWindow: back.left === 0 && back.top === 0 && back.width === innerWidth && back.height === innerHeight,
        inBody: document.querySelector('.sheet-backdrop').parentElement === document.body,
        corners: [onTop(sheet.left + 8, sheet.top + 8), onTop(sheet.right - 8, sheet.top + 8), onTop(sheet.left + 8, sheet.bottom - 8), onTop(sheet.right - 8, sheet.bottom - 8)]
      };
    })()`) as Record<string, unknown>)
  };
}

/**
 * Item 97: the speech model picker in Settings › Dictation, driven by
 * selecting each kind of provider — whisper.cpp's Test runs the real
 * whisper-cli on a sample spoken by \`say\`; a cloud provider without a key,
 * and with a bogus one, must say so plainly.
 */
async function driveItem97(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const choose = (id: string) => read(win, `(() => { const s = Array.from(document.querySelectorAll('.settings-field select')).find(x => Array.from(x.options).some(o => o.value === 'whisper-cpp'));
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(id)});
    s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  const testResult = async () => {
    await read(win, `Array.from(document.querySelectorAll('.speech-test button')).find(b => b.textContent.startsWith('Test'))?.click()`);
    await until(win, `document.querySelector('.speech-test-ok, .speech-test-fail')`, 90_000).catch(() => undefined);
    return read(win, `(() => { const e = document.querySelector('.speech-test-ok, .speech-test-fail'); return e ? { ok: e.classList.contains('speech-test-ok'), text: e.textContent } : null; })()`);
  };
  const scrollTo = () => read(win, `document.querySelector('.speech-test')?.scrollIntoView({ block: 'center' })`);
  win.focus();
  const report: Record<string, unknown> = {};

  await read(win, `document.querySelector('.rail-item[aria-label="Settings"]')?.click()`);
  await until(win, `document.querySelector('.settings-list')`, 5_000);
  await read(win, `document.querySelector('.settings-row[data-section="dictation"]:not(.open) .settings-row-head')?.click()`);
  await until(win, `document.querySelector('.settings-field select')`, 5_000);
  await pause(300);
  report['default'] = await read(win, `document.querySelector('.speech-test button')?.textContent`);

  await choose('whisper-cpp');
  await pause(300);
  report['whisperModels'] = await read(win, `Array.from(document.querySelectorAll('.speech-row select option')).map(o => o.textContent)`);
  await scrollTo();
  report['whisperTest'] = await testResult();
  await snap('whisper-cpp');

  await choose('groq');
  await pause(300);
  await scrollTo();
  report['groqNoKey'] = await testResult();
  await snap('groq-no-key');

  await choose('openai');
  await pause(300);
  await read(win, `(() => { const f = document.querySelector('.speech-row input[type=password]'); f.focus(); document.execCommand('insertText', false, 'sk-bogus-kovan-smoke'); })()`);
  await read(win, `Array.from(document.querySelectorAll('.speech-row button')).find(b => b.textContent === 'Save')?.click()`);
  await until(win, `document.querySelector('.speech-row input[type=password]')?.placeholder.includes('saved')`, 5_000).catch(() => undefined);
  report['keySaved'] = await read(win, `document.querySelector('.speech-row input[type=password]')?.placeholder`);
  report['keyNotEchoed'] = await read(win, `document.querySelector('.speech-row input[type=password]')?.value === ''`);
  await scrollTo();
  report['openaiBogusKey'] = await testResult();
  await snap('openai-bogus-key');

  await choose('apple');
  await pause(300);
  await scrollTo();
  await snap('apple');
  report['saved'] = await read(win, `window.kovan.settings().then(s => ({ provider: s['dictation.provider'], secretInSettings: JSON.stringify(s).includes('sk-bogus') }))`);
  return report;
}

/**
 * Item 96: every theme painted over a real pull request, then each option
 * driven through Settings the way a person would — the painted attributes
 * and tokens read back after each click, and a shot of each.
 */
async function driveItem96(win: BrowserWindow, sessions: Sessions, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const click = (selector: string) => read(win, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`);
  const clickText = (scope: string, text: string) => read(win, `(() => { const e = Array.from(document.querySelectorAll(${JSON.stringify(scope)})).find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!e) return false; e.click(); return true; })()`);
  const painted = () => read(win, `(() => { const r = document.documentElement; const css = getComputedStyle(r);
    return { theme: r.dataset.theme, palette: r.dataset.palette ?? null, accent: r.dataset.accent ?? null, status: r.dataset.status ?? null,
      shapes: 'shapes' in r.dataset, density: r.dataset.density, rail: css.getPropertyValue('--rail').trim(), clay: css.getPropertyValue('--clay').trim(),
      pass: css.getPropertyValue('--pass').trim(), bodyBg: getComputedStyle(document.body).backgroundColor,
      rowPad: getComputedStyle(document.querySelector('.rows .row') ?? document.body).paddingTop,
      dotGlyph: getComputedStyle(document.querySelector('.rows .dot') ?? document.body, '::before').content }; })()`);
  const openSettings = async () => {
    await click('.rail-item[aria-label="Settings"]');
    await until(win, `document.querySelector('.settings-list')`, 5_000);
    await read(win, `document.querySelector('.settings-row[data-section="appearance"]:not(.open) .settings-row-head')?.click()`);
    await pause(200);
  };
  const closeSettings = async () => {
    await click('.sheet-head [aria-label="Close"]');
    await until(win, `!document.querySelector('.settings-list')`, 5_000);
  };
  win.focus();
  const report: Record<string, unknown> = {};

  await click('.rows .row');
  await pause(400);

  // 1. Every theme, chosen as "Always one" in Settings.
  await openSettings();
  await clickText('.theme-picker button', 'Always one');
  await pause(150);
  await snap('settings-fixed');
  const themes = ['Dark', 'Light', 'OLED Black', 'Cool Graphite', 'Ember Low Light', 'High Contrast', 'Paper Soft'];
  const perTheme: Record<string, unknown> = {};
  for (const label of themes) {
    await openSettings().catch(() => undefined);
    await clickText('.theme-grid .theme-name', label);
    await pause(150);
    await closeSettings();
    await pause(250);
    perTheme[label] = await painted();
    await snap(`theme-${label.toLowerCase().replace(/ /g, '-')}`);
  }
  report['themes'] = perTheme;
  report['savedTheme'] = await read(win, `window.kovan.settings().then(s => s['appearance.theme'])`);

  // 2. Options, back on Dark: accent, colour-safe status, shapes off, compact, boosted.
  await openSettings();
  await clickText('.theme-grid .theme-name', 'Dark');
  await clickText('.accent-picker button', 'Teal');
  await pause(150);
  report['teal'] = await painted();
  await snap('settings-teal');
  await clickText('.accent-picker button', 'macOS');
  await pause(400);
  report['macos'] = await painted();
  await snap('settings-macos-accent');
  await clickText('.accent-picker button', 'Teal');
  await clickText('.checkbox-row', 'Colour-safe');
  await clickText('.theme-picker button', 'Compact');
  await clickText('.theme-picker button', 'Boosted');
  await pause(150);
  await closeSettings();
  await pause(250);
  report['options'] = await painted();
  await snap('options-teal-safe-compact');
  await openSettings();
  await clickText('.checkbox-row', 'Show a shape');
  await pause(150);
  await closeSettings();
  report['shapesOff'] = await painted();
  await snap('shapes-off');

  // 3. A terminal follows the theme live — xterm paints a canvas, not CSS.
  const termBg = () => read(win, `(() => { const v = document.querySelector('.xterm .xterm-viewport'); return v ? getComputedStyle(v).backgroundColor : null; })()`);
  await sessions.open({
    cwd: app.getPath('userData'), title: 'colours', runnerName: 'smoke',
    line: `printf '\\033[31mred \\033[32mgreen \\033[33myellow \\033[34mblue \\033[35mmagenta \\033[36mcyan \\033[0mplain\\n'; sleep 300`
  });
  await click('.rail-item[aria-label="Sessions"]');
  await until(win, `document.querySelector('.xterm')`, 8_000).catch(() => undefined);
  await pause(6000);
  report['terminalDark'] = await termBg();
  await snap('terminal-dark-boosted');
  await openSettings();
  await clickText('.theme-grid .theme-name', 'Cool Graphite');
  await clickText('.theme-picker button', 'From the theme');
  await closeSettings();
  await pause(400);
  report['terminalGraphite'] = await termBg();
  await snap('terminal-graphite');

  // 4. The two switching modes.
  await openSettings();
  await clickText('.theme-picker button', 'Match macOS');
  await pause(150);
  await snap('settings-system');
  await clickText('.theme-picker button', 'On a schedule');
  await pause(150);
  await snap('settings-schedule');
  report['schedule'] = await painted();

  // Put everything back so the throwaway profile ends where it started.
  for (const [key, value] of [['appearance.theme', 'system'], ['appearance.accent', 'clay'], ['appearance.colorSafeStatus', false],
    ['appearance.statusShapes', true], ['appearance.density', 'comfortable'], ['appearance.terminalColors', 'integrated']] as const) {
    await read(win, `window.kovan.setSetting(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }
  return report;
}

async function driveItem91(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const click = (selector: string) => read(win, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`);
  // Typed the way a person types, so React sees every field change.
  const type = (selector: string, text: string) => read(win, `(() => { const f = document.querySelector(${JSON.stringify(selector)});
    f.focus(); f.select?.(); document.execCommand('insertText', false, ${JSON.stringify(text)}); return f.value; })()`);
  const rows = () => read(win, `Array.from(document.querySelectorAll('.qc-row')).map(r => ({
    name: r.querySelector('.qc-row-name')?.firstChild?.textContent, command: r.querySelector('.qc-row-command')?.textContent,
    running: Boolean(r.querySelector('.dot.live')) }))`);
  win.focus();

  // 1. Nothing saved: the button says what it is, and opens a new command.
  const emptyLabel = await read(win, `document.querySelector('.qc-run-name')?.textContent`);
  await click('.qc-run');
  await until(win, `document.querySelector('.qc-editor')`, 3_000);
  // Saving with no name says why.
  await click('.qc-editor button[type="submit"]');
  await until(win, `document.querySelector('.qc-error')`, 3_000);
  const noName = await read(win, `document.querySelector('.qc-error')?.textContent`);
  const dragRegion = await read(win, `getComputedStyle(document.querySelector('.qc-editor textarea')).webkitAppRegion ?? getComputedStyle(document.querySelector('.qc-editor textarea')).getPropertyValue('-webkit-app-region')`);

  // 2. Two commands. The output is computed by the shell, so seeing it proves it ran.
  await type('.qc-editor input', 'frontend dev');
  await type('.qc-editor textarea', 'echo serving-$((6*7)) && sleep 120');
  await click('.qc-editor button[type="submit"]');
  await until(win, `document.querySelectorAll('.qc-row').length === 1`, 3_000);
  await click('.qc-add');
  await until(win, `document.querySelector('.qc-editor')`, 3_000);
  await type('.qc-editor input', 'optimize');
  await type('.qc-editor textarea', 'echo opti$((1+1))mized');
  await type('.qc-folder input', app.getPath('userData'));
  await pause(100);
  await snap('editor');
  await click('.qc-editor button[type="submit"]');
  await until(win, `document.querySelectorAll('.qc-row').length === 2`, 3_000);
  const saved = await rows();
  await snap('menu');

  // 3. Search and Enter runs the match, in Sessions.
  await type('.qc-search input', 'opt');
  await pause(100);
  const searched = await rows();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await until(win, `document.querySelector('.rail-item.active')?.getAttribute('aria-label') === 'Sessions'`, 5_000);
  await until(win, `window.kovan.sessions().then(l => l.some(s => s.title === 'optimize'))`, 5_000);
  const optimize = await read(win, `window.kovan.sessions().then(l => l.find(s => s.title === 'optimize'))`) as { id: string; cwd: string; commandId?: string };
  let output = '';
  for (let i = 0; i < 30 && !output.includes('opti2mized'); i++) {
    await pause(300);
    output = (await read(win, `window.kovan.sessionBuffer(${JSON.stringify(optimize.id)}).then((r) => r.data)`) as string) ?? '';
  }
  const ranOptimize = { ran: output.includes('opti2mized'), cwd: optimize.cwd, tagged: Boolean(optimize.commandId),
    menuClosed: !(await read(win, `Boolean(document.querySelector('.qc-menu'))`)) };

  // A one-off that finished runs again in the same terminal, not a new one.
  await pause(800);
  const titles = () => read(win, `window.kovan.sessions().then(l => l.filter(s => s.running).map(s => s.title))`) as Promise<string[]>;
  const beforeRerun = await titles();
  await click('.qc-run');
  let rerunOut = '';
  for (let i = 0; i < 30 && (rerunOut.match(/opti2mized/g) ?? []).length < 2; i++) {
    await pause(300);
    rerunOut = (await read(win, `window.kovan.sessionBuffer(${JSON.stringify(optimize.id)}).then((r) => r.data)`) as string) ?? '';
  }
  const rerun = { sessionsBefore: beforeRerun, sessionsAfter: await titles(), outputs: (rerunOut.match(/opti2mized/g) ?? []).length };

  // 4. The last one run is on the ▶ button; a running server isn't started twice.
  const splitAfter = await read(win, `document.querySelector('.qc-run-name')?.textContent`);
  await click('.qc-toggle');
  await until(win, `document.querySelector('.qc-row')`, 3_000);
  await read(win, `Array.from(document.querySelectorAll('.qc-row-run')).find(b => b.textContent.includes('frontend dev')).click()`);
  await until(win, `window.kovan.sessions().then(l => l.some(s => s.title === 'frontend dev' && s.running))`, 5_000);
  await pause(1_500);
  const before = await titles();
  await click('.qc-run');
  await pause(800);
  const after = await titles();
  const dev = await read(win, `window.kovan.sessions().then(l => l.find(s => s.title === 'frontend dev'))`) as { id: string };
  let devOut = '';
  for (let i = 0; i < 20 && !devOut.includes('serving-42'); i++) {
    await pause(300);
    devOut = (await read(win, `window.kovan.sessionBuffer(${JSON.stringify(dev.id)}).then((r) => r.data)`) as string) ?? '';
  }
  const reuse = { before, after, servingOutput: devOut.includes('serving-42'),
    activeIsDev: await read(win, `document.querySelector('.term')?.getAttribute('data-session-id') === ${JSON.stringify(dev.id)}`),
    splitRunningDot: await read(win, `Boolean(document.querySelector('.qc-run .dot.live'))`) };

  // 5. Edit, duplicate, delete (Cancel first — it asks).
  await click('.qc-toggle');
  await until(win, `document.querySelector('.qc-row')`, 3_000);
  await pause(300);
  const runningRows = await rows();
  await read(win, `document.querySelector('.qc-row-actions button[aria-label="Edit optimize"]').click()`);
  await until(win, `document.querySelector('.qc-editor')`, 3_000);
  await type('.qc-editor input', 'optimize images');
  await click('.qc-editor button[type="submit"]');
  await until(win, `Array.from(document.querySelectorAll('.qc-row-name')).some(n => n.textContent.startsWith('optimize images'))`, 3_000);
  await read(win, `document.querySelector('.qc-row-actions button[aria-label="Duplicate optimize images"]').click()`);
  await until(win, `document.querySelectorAll('.qc-row').length === 3`, 3_000);
  const afterDuplicate = await rows();
  await read(win, `document.querySelector('.qc-row-actions button[aria-label="Delete optimize images (copy)"]').click()`);
  await until(win, `document.querySelector('.qc-confirm')`, 3_000);
  const confirmText = await read(win, `document.querySelector('.qc-confirm span')?.textContent`);
  await snap('confirm');
  await read(win, `document.querySelector('.qc-confirm .link').click()`);
  const afterCancel = (await rows() as unknown[]).length;
  await read(win, `document.querySelector('.qc-row-actions button[aria-label="Delete optimize images (copy)"]').click()`);
  await until(win, `document.querySelector('.qc-confirm')`, 3_000);
  await read(win, `document.querySelector('.qc-confirm .qc-delete').click()`);
  await until(win, `document.querySelectorAll('.qc-row').length === 2`, 3_000);
  const afterDelete = await rows();

  // 6. A folder that's gone says so, instead of opening a shell somewhere else.
  await click('.qc-add');
  await until(win, `document.querySelector('.qc-editor')`, 3_000);
  await type('.qc-editor input', 'old project');
  await type('.qc-editor textarea', 'ls');
  await type('.qc-folder input', '/nonexistent/kovan-smoke');
  await click('.qc-editor button[type="submit"]');
  await until(win, `!document.querySelector('.qc-editor')`, 3_000);
  await read(win, `Array.from(document.querySelectorAll('.qc-row-run')).find(b => b.textContent.includes('old project')).click()`);
  await until(win, `document.querySelector('.qc-error')`, 3_000);
  const missingFolder = await read(win, `document.querySelector('.qc-error')?.textContent`);
  const stored = await read(win, `window.kovan.settings().then(s => (s.quickCommands ?? []).map(c => c.name))`);
  await click('.qc-search .icon-button');

  for (const id of [optimize.id, dev.id]) await read(win, `window.kovan.sessionClose(${JSON.stringify(id)})`);
  return { emptyLabel, noName, dragRegion, saved, searched, ranOptimize, rerun, splitAfter, reuse, runningRows, afterDuplicate, confirmText, afterCancel, afterDelete, missingFolder, stored };
}

async function driveItem90(win: BrowserWindow, sessions: Sessions, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Nothing may really open a browser on the machine running this: record instead.
  const { shell } = await import('electron');
  const opened: string[] = [];
  let stubbed = false;
  try {
    (shell as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => { opened.push(url); };
    stubbed = true;
  } catch {
    stubbed = false;
  }

  // A run whose "agent" is a sleeping shell, attached to the run's folder.
  const store = new RunStore(RunStore.rootFor(app.getPath('userData')));
  const run = await store.begin({
    subject: 'acme/web#42', pull: 'acme/web#42', kind: 'verify', prompt: 'Check it.',
    environment: 'Dev', site: 'https://dev.example.invalid/'
  });
  const session = await sessions.open({
    cwd: app.getPath('userData'), title: 'verify · acme/web#42', runnerName: 'smoke', line: 'sleep 300',
    kind: 'verify', subject: 'acme/web#42', pull: 'acme/web#42', runDirectory: run.directory
  });
  const shots = path.join(run.directory, 'shots');

  await read(win, `Array.from(document.querySelectorAll('.rows .row .row-num')).find(e => e.textContent === '42')?.closest('button')?.click()`);
  await until(win, `Array.from(document.querySelectorAll('.runs button.link')).some(b => b.textContent.trim() === 'watch')`, 10_000);
  await read(win, `Array.from(document.querySelectorAll('.runs button.link')).find(b => b.textContent.trim() === 'watch').click()`);
  await until(win, `document.querySelector('.run-viewer .run-now')`, 5_000);
  const waiting = await read(win, `({
    live: document.querySelector('.run-live')?.textContent ?? null,
    now: document.querySelector('.run-now')?.textContent ?? null,
    siteButton: document.querySelector('.run-site-open')?.textContent ?? null })`);

  // The agent says what it's doing, then takes two screenshots, a second apart.
  await writeFile(path.join(run.directory, 'status.txt'), 'Signing in as Teacher\n');
  await until(win, `document.querySelector('.run-now-step')?.textContent === 'Signing in as Teacher'`, 5_000);
  const picture = (await win.webContents.capturePage()).toPNG();
  await writeFile(path.join(shots, '01-signed-in.png'), picture);
  const firstArrived = await until(win, `document.querySelector('.run-now-shot img')?.getAttribute('alt') === '01-signed-in.png'`, 5_000);
  await pause(1_200);
  await writeFile(path.join(run.directory, 'status.txt'), 'Opening the lesson page\n');
  await writeFile(path.join(shots, '02-lesson-page.png'), picture);
  const secondArrived = await until(win, `document.querySelector('.run-now-shot img')?.getAttribute('alt') === '02-lesson-page.png'`, 5_000);
  await pause(300);
  const live = await read(win, `({
    step: document.querySelector('.run-now-step')?.textContent ?? null,
    newest: document.querySelector('.run-now-shot img')?.getAttribute('alt') ?? null,
    taken: document.querySelector('.run-now-caption .run-shot-time')?.textContent ?? null,
    count: document.querySelector('.run-section-count')?.textContent ?? null,
    fresh: document.querySelectorAll('.run-shot-item.fresh').length,
    statusListed: Array.from(document.querySelectorAll('.run-doc-name')).some(e => e.textContent === 'status.txt') })`);
  await snap('live');

  // D: the viewer's button opens the run's own site — from run.json, not the page.
  await read(win, `document.querySelector('.run-site-open')?.click()`);
  await pause(200);
  const fromViewer = [...opened];
  // A run whose site isn't http(s) is refused in main, whatever the page asks.
  const bad = await store.begin({ subject: 'acme/web#42', pull: 'acme/web#42', kind: 'verify', prompt: 'x', environment: 'Odd', site: 'file:///etc/hosts' });
  const refusedBadScheme = await read(win, `window.kovan.runSiteOpen(${JSON.stringify(bad.directory)}).then(() => false, () => true)`);
  const refusedOutside = await read(win, `window.kovan.runSiteOpen('/etc').then(() => false, () => true)`);
  const refusedWatch = await read(win, `window.kovan.runWatch('/etc', true).then(() => false, () => true)`);

  // The agent finishes: Live and Now go, the gallery stays.
  await read(win, `window.kovan.sessionClose(${JSON.stringify(session.id)})`);
  await until(win, `!document.querySelector('.run-live')`, 10_000);
  // No settling pause: the viewer must not remount (and empty) as the session goes.
  const finished = await read(win, `({ live: Boolean(document.querySelector('.run-live')), now: Boolean(document.querySelector('.run-now')),
    viewerOpen: Boolean(document.querySelector('.run-viewer')),
    gallery: document.querySelector('.run-viewer-gallery')?.innerText?.slice(0, 200) ?? null,
    thumbnails: document.querySelectorAll('.run-shot-item').length })`);
  await read(win, `document.querySelector('.run-viewer .sheet-head .icon-button.boxed')?.click()`);

  // D in the run sheet: Open beside the environment's URL.
  await until(win, `document.querySelector('.detail-actions .primary')`, 5_000);
  await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
  await until(win, `document.querySelector('.env-picker')`, 10_000);
  await read(win, `Array.from(document.querySelectorAll('.env-picker button')).find(b => b.textContent !== 'None')?.click()`);
  // The seeded environment has no URL: type one, the way you would.
  await until(win, `document.querySelector('.run-test-env-site')`, 5_000);
  const openBeforeUrl = await read(win, `Boolean(document.querySelector('.run-test-env-open'))`);
  await read(win, `(() => { const f = document.querySelector('.run-test-env-site'); f.focus();
    document.execCommand('insertText', false, 'https://dev.example.invalid/lesson/7'); })()`);
  await until(win, `document.querySelector('.run-test-env-open')`, 5_000);
  const sheetSite = await read(win, `document.querySelector('.run-test-env-site')?.value ?? null`);
  await read(win, `document.querySelector('.run-test-env-open')?.click()`);
  await pause(200);
  await snap('sheet');
  const fromSheet = opened.slice(fromViewer.length);

  return { stubbed, waiting, firstArrived, secondArrived, live, fromViewer, refusedBadScheme, refusedOutside, refusedWatch, finished, openBeforeUrl, sheetSite, fromSheet };
}

async function driveItem89(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const order = () => read(win, `Array.from(document.querySelectorAll('.rail > .rail-item[data-view]')).map(b => b.getAttribute('aria-label'))`);
  const centre = (label: string) => read(win, `(() => { const r = document.querySelector('.rail-item[aria-label="${label}"]').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(r.top) }; })()`) as Promise<{ x: number; y: number; top: number }>;
  const active = () => read(win, `document.querySelector('.rail-item.active')?.getAttribute('aria-label')`);
  win.focus();

  const initial = await order();
  const activeBefore = await active();

  // A real drag: Sessions up onto the top half of Pull requests.
  const from = await centre('Sessions');
  const to = await centre('Pull requests');
  win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: Math.round(from.y + ((to.top + 6) - from.y) * i / 8), button: 'left' });
    await pause(30);
  }
  await pause(100);
  const midDrag = await read(win, `({ line: document.querySelector('.rail-item.drop-before, .rail-item.drop-after')?.getAttribute('aria-label') ?? null,
    where: document.querySelector('.rail-item.drop-before') ? 'before' : document.querySelector('.rail-item.drop-after') ? 'after' : null,
    dimmed: document.querySelector('.rail-item.dragged')?.getAttribute('aria-label') ?? null })`);
  await snap('dragging');
  win.webContents.sendInputEvent({ type: 'mouseUp', x: from.x, y: to.top + 6, button: 'left', clickCount: 1 });
  await pause(300);
  const afterDrag = await order();
  const activeAfterDrag = await active();
  await snap('dropped');

  // ⌥↓ on the focused icon moves it one down, and it keeps focus.
  await read(win, `document.querySelector('.rail-item[aria-label="Sessions"]').focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['alt'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['alt'] });
  await pause(200);
  const afterKey = await order();
  const keptFocus = await read(win, `document.activeElement?.getAttribute('aria-label')`);
  const saved = await read(win, `localStorage.getItem('kovan.rail-order')`);

  // Remembered across a reload of the window.
  win.webContents.reload();
  await until(win, `document.querySelector('#root')?.children.length > 0`);
  win.webContents.send('kovan:snapshot', fixtureSnapshot(10));
  await until(win, `document.querySelector('.rail-item[data-view]')`, 10_000);
  await pause(300);
  const afterReload = await order();

  // A plain click still just switches tab.
  const tickets = await centre('Tickets');
  win.webContents.sendInputEvent({ type: 'mouseDown', x: tickets.x, y: tickets.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: tickets.x, y: tickets.y, button: 'left', clickCount: 1 });
  await pause(300);
  const clickSwitched = await active();
  const settingsLast = await read(win, `(() => { const items = Array.from(document.querySelectorAll('.rail > .rail-item'));
    return items[items.length - 1]?.getAttribute('aria-label'); })()`);

  return { initial, activeBefore, midDrag, afterDrag, activeAfterDrag, afterKey, keptFocus, saved, afterReload, clickSwitched, settingsLast };
}

async function driveItem88(win: BrowserWindow, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const key = (type: 'keyDown' | 'keyUp', keyCode: string, modifiers: ('meta')[] = []) =>
    win.webContents.sendInputEvent({ type, keyCode, modifiers });
  // Two taps of ⌘ alone, the way a hand does it.
  const doubleTap = async () => {
    for (let i = 0; i < 2; i++) {
      key('keyDown', 'Meta', ['meta']);
      await pause(50);
      key('keyUp', 'Meta');
      await pause(120);
    }
  };
  const pill = () => read(win, `(() => { const p = document.querySelector('.dictation-pill');
    return p ? { phase: p.className.replace('dictation-pill ', ''), state: p.querySelector('.dictation-state')?.textContent,
      text: p.querySelector('.dictation-text')?.textContent ?? null, bars: p.querySelectorAll('.dictation-meter span').length } : null; })()`);
  win.focus();

  // 1. Into the run sheet's prompt, at the caret.
  await read(win, `Array.from(document.querySelectorAll('.rows .row .row-num')).find(e => e.textContent === '42')?.closest('button')?.click()`);
  await until(win, `document.querySelector('.detail-actions .primary')`, 5_000);
  await read(win, `document.querySelector('.detail-actions .primary')?.click()`);
  await until(win, `document.getElementById('run-prompt')?.value.length > 0`, 10_000);
  await pause(300);
  const before = await read(win, `(() => { const t = document.getElementById('run-prompt'); t.focus();
    t.setSelectionRange(t.value.length, t.value.length); return t.value.length; })()`) as number;
  const micButton = await read(win, `Boolean(document.querySelector('.prompt-field .dictate-button'))`);
  await doubleTap();
  await until(win, `document.querySelector('.dictation-pill .dictation-text')?.textContent?.includes('retry test')`, 5_000);
  const listening = await pill();
  await snap('listening');
  await doubleTap();
  await until(win, `document.querySelector('.dictation-pill.done')`, 5_000);
  const inserted = await read(win, `(() => { const t = document.getElementById('run-prompt');
    return { tail: t.value.slice(-40), length: t.value.length, grew: t.value.length - ${before}, focused: document.activeElement === t,
      pill: document.querySelector('.dictation-state')?.textContent }; })()`);
  await snap('inserted');
  // ⌘Z takes it back out: inserted as an edit, not by replacing the value.
  // ⌘Z is Electron's default Edit menu, which macOS dispatches — out of
  // `sendInputEvent`'s reach — so this calls what that menu item calls.
  win.webContents.undo();
  await pause(200);
  const afterUndo = await read(win, `document.getElementById('run-prompt').value.length`) as number;

  // 2. Esc cancels, and only cancels: the sheet stays open, nothing inserted.
  await until(win, `!document.querySelector('.dictation-pill')`, 3_000);
  await doubleTap();
  await until(win, `document.querySelector('.dictation-pill .dictation-text')?.textContent?.includes('flaky')`, 5_000);
  key('keyDown', 'Escape');
  key('keyUp', 'Escape');
  await pause(500);
  const cancelled = await read(win, `({ pill: Boolean(document.querySelector('.dictation-pill')),
    sheetOpen: Boolean(document.getElementById('run-prompt')), length: document.getElementById('run-prompt')?.value.length })`);

  // 3. ⌘C is a shortcut, never a tap.
  for (let i = 0; i < 2; i++) {
    key('keyDown', 'Meta', ['meta']);
    key('keyDown', 'C', ['meta']);
    key('keyUp', 'C', ['meta']);
    await pause(40);
    key('keyUp', 'Meta');
    await pause(100);
  }
  await pause(300);
  const shortcutIgnored = !(await read(win, `Boolean(document.querySelector('.dictation-pill'))`));
  await read(win, `document.querySelector('.sheet-head .icon-button.boxed')?.click()`);
  await until(win, `!document.getElementById('run-prompt')`, 3_000);

  // 4. Into a terminal: typed, never run.
  const cwd = app.getPath('userData');
  const session = await read(win, `window.kovan.openTerminal(${JSON.stringify(cwd)}).then(s => s.id)`) as string;
  // Opened through the bridge, so go and show it the way a person would.
  await read(win, `document.querySelector('.rail-item[aria-label="Sessions"]')?.click()`);
  await until(win, `document.querySelector('.row.one-line')`, 5_000);
  await read(win, `document.querySelector('.row.one-line')?.click()`);
  await until(win, `document.querySelector('.term[data-session-id="${session}"] .xterm-helper-textarea')`, 10_000);
  await pause(800);
  await read(win, `document.querySelector('.term[data-session-id="${session}"] .xterm-helper-textarea').focus()`);
  await doubleTap();
  await until(win, `document.querySelector('.dictation-pill .dictation-state')?.textContent?.includes('terminal')`, 5_000);
  const intoTerminal = await read(win, `document.querySelector('.dictation-state')?.textContent`);
  await until(win, `document.querySelector('.dictation-pill .dictation-text')?.textContent?.includes('retry test')`, 5_000);
  await doubleTap();
  await until(win, `document.querySelector('.dictation-pill.done')`, 5_000);
  await pause(600);
  const buffer = await read(win, `window.kovan.sessionBuffer(${JSON.stringify(session)}).then((r) => r.data)`) as string;
  const plain = buffer.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const terminal = {
    pill: await read(win, `document.querySelector('.dictation-state')?.textContent`),
    typed: plain.includes('Fix the flaky payment retry test.'),
    // Enter wasn't pressed: the shell never tried to run it.
    ran: /command not found|no such file/i.test(plain)
  };
  await snap('terminal');
  await read(win, `window.kovan.sessionClose(${JSON.stringify(session)})`);

  // 5. Nothing focused: the clipboard.
  await until(win, `!document.querySelector('.dictation-pill')`, 3_000);
  await read(win, `document.activeElement?.blur()`);
  await clipboard.writeText('');
  await doubleTap();
  await until(win, `document.querySelector('.dictation-pill .dictation-text')?.textContent?.includes('retry test')`, 5_000);
  await doubleTap();
  await until(win, `document.querySelector('.dictation-pill.done')`, 5_000);
  const toClipboard = { pill: await read(win, `document.querySelector('.dictation-state')?.textContent`), clipboard: await clipboard.readText() };

  // 6. Settings: switch, languages from the real helper, permissions.
  await read(win, `document.querySelector('.rail-item[aria-label="Settings"]')?.click()`);
  await until(win, `Array.from(document.querySelectorAll('h3')).some(h => h.textContent === 'Dictation')`, 5_000);
  await until(win, `document.querySelectorAll('.settings-field select option').length > 1`, 10_000);
  const settings = await read(win, `(() => { const s = document.querySelector('.settings-field select');
    return { options: s?.options.length, automatic: s?.options[0]?.textContent,
      permissions: document.querySelector('.dictation-permissions')?.textContent,
      toggle: Array.from(document.querySelectorAll('label.checkbox-row')).some(l => l.textContent.includes('double-tap ⌘')) }; })()`);
  await read(win, `Array.from(document.querySelectorAll('h3')).find(h => h.textContent === 'Dictation')?.scrollIntoView({ block: 'start' })`);
  await pause(200);
  await snap('settings');

  return { micButton, listening, inserted, afterUndo, before, cancelled, shortcutIgnored, intoTerminal, terminal, toClipboard, settings };
}

async function driveItem86(win: BrowserWindow, feed: ActivityFeed, prefix: string): Promise<Record<string, unknown>> {
  const snap = async (name: string) => {
    await writeFile(`${prefix}-${name}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${prefix}-${name}.png`);
  };
  // Jira only counts once it's set up; the scratch profile isn't.
  await read(win, `Promise.all([
    window.kovan.setSetting('jira.baseUrl', 'https://example.invalid'),
    window.kovan.setSetting('jira.email', 'me@example.invalid')])`);

  const base = fixtureSnapshot(10);
  const withJira = (s: Snapshot): Snapshot => ({ ...s, connected: ['github', 'jira', 'sentry'] });
  const mine = base.mine.map((p) => ({ ...p, commentCount: 3, lastCommenter: 'idrisay' }));
  const before = withJira({ ...base, mine });
  // What the next poll finds: a new review request, #118 approved, a new
  // ticket, and a comment from somebody else on #42.
  const asked = { ...REVIEW_PULL, number: 206, title: 'Move invoice numbering into the ledger service', author: 'bob-dev' };
  const after = withJira({
    ...base,
    reviewRequested: [...base.reviewRequested, asked],
    mine: mine.map((p) =>
      p.number === 118 ? { ...p, reviewDecision: 'approved' as const }
      : p.number === 42 ? { ...p, commentCount: 4, lastCommenter: 'alice-dev' } : p),
    tickets: [...base.tickets, { ...TICKET, key: 'ACME-2510', summary: 'Export the class report as CSV' }]
  });

  win.webContents.send('kovan:snapshot', after);
  await feed.report(before, true);
  const afterBaseline = (await feed.inbox()).length;
  await feed.report(after, false);
  await until(win, `document.querySelectorAll('.toast').length > 0`, 5_000);
  await new Promise((r) => setTimeout(r, 300));
  const toasts = await read(win, `Array.from(document.querySelectorAll('.toast')).map(t => ({
    kind: t.querySelector('.toast-kind')?.textContent, subject: t.querySelector('.toast-subject')?.textContent }))`);
  const badge = await read(win, `document.querySelector('.rail-item[aria-label="Activity"] .rail-count')?.textContent ?? null`);
  await snap('toasts');

  // The same poll again is not news twice.
  await feed.report(after, false);
  const afterRepeat = (await feed.inbox()).length;

  await read(win, `document.querySelector('.rail-item[aria-label="Activity"]')?.click()`);
  await until(win, `document.querySelector('.activity-row')`, 5_000);
  const rows = await read(win, `Array.from(document.querySelectorAll('.activity-row')).map(r => ({
    label: r.querySelector('.row-num')?.textContent, kind: r.querySelector('.state')?.textContent,
    who: r.querySelector('.activity-who')?.textContent ?? null, read: r.classList.contains('read') }))`);
  const days = await read(win, `Array.from(document.querySelectorAll('.activity-day')).map(d => d.textContent)`);
  await snap('inbox');

  // Clicking one opens the pull request beside the inbox and reads it.
  await read(win, `Array.from(document.querySelectorAll('.activity-row'))
    .find(r => r.querySelector('.row-num')?.textContent === 'billing #206')?.click()`);
  await until(win, `document.querySelector('.detail-head h2')?.textContent?.includes('invoice numbering')`, 5_000);
  const opened = await read(win, `({
    title: document.querySelector('.detail-head h2')?.textContent ?? null,
    stillInActivity: document.querySelector('.rail-item.active')?.getAttribute('aria-label'),
    badge: document.querySelector('.rail-item[aria-label="Activity"] .rail-count')?.textContent ?? null,
    rowRead: Array.from(document.querySelectorAll('.activity-row'))
      .find(r => r.querySelector('.row-num')?.textContent === 'billing #206')?.classList.contains('read') ?? null
  })`);
  await snap('opened');

  // A toast's Open lands on the same thing in Activity.
  const toastOpen = await read(win, `(() => { const b = Array.from(document.querySelectorAll('.toast'))
    .find(t => t.querySelector('.toast-kind')?.textContent === 'New ticket')?.querySelector('.toast-actions button');
    if (!b) return 'no toast'; b.click(); return 'clicked'; })()`);
  await until(win, `document.querySelector('.detail-head h2')?.textContent?.includes('class report')`, 5_000);
  const fromToast = await read(win, `document.querySelector('.detail-head h2')?.textContent ?? null`);

  await read(win, `Array.from(document.querySelectorAll('.queue-title-row button.link')).find(b => b.textContent === 'Mark all read')?.click()`);
  await until(win, `!document.querySelector('.rail-count')`, 5_000);
  const afterMarkAll = await read(win, `({
    badge: Boolean(document.querySelector('.rail-count')),
    unreadRows: document.querySelectorAll('.activity-row:not(.read)').length })`);

  // A failed GitHub poll (empty lists, an error) must not produce a flood next time.
  const failed: Snapshot = { ...after, viewer: '', mine: [], reviewRequested: [], errors: [{ provider: 'github', message: 'HTTP 502' }] };
  await feed.report(failed, false);
  await feed.report(after, false);
  const afterFailure = (await feed.inbox()).length;

  // Settings shows the four switches.
  await read(win, `document.querySelector('.rail-item[aria-label="Settings"]')?.click()`);
  await until(win, `Array.from(document.querySelectorAll('h3')).some(h => h.textContent === 'Activity')`, 5_000);
  const settings = await read(win, `(() => { const h = Array.from(document.querySelectorAll('h3')).find(h => h.textContent === 'Activity');
    const out = []; let n = h?.nextElementSibling;
    while (n && n.tagName !== 'H3') { if (n.matches('label.checkbox-row')) out.push({ label: n.textContent, on: n.querySelector('input').checked }); n = n.nextElementSibling; }
    return out; })()`);
  await read(win, `(() => { const h = Array.from(document.querySelectorAll('h3')).find(h => h.textContent === 'Activity'); h?.scrollIntoView({ block: 'start' }); })()`);
  await new Promise((r) => setTimeout(r, 200));
  await snap('settings');

  const stored = JSON.parse(await readFile(path.join(app.getPath('userData'), 'activity-feed.json'), 'utf8')) as { inbox: unknown[] };
  return {
    afterBaseline, toasts, badge, afterRepeat, rows, days, opened, toastOpen, fromToast,
    afterMarkAll, afterFailure, settings, storedEvents: stored.inbox.length
  };
}

async function driveWorkspace(win: BrowserWindow): Promise<Record<string, unknown>> {
  const click = (selector: string) =>
    read(win, `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (e) { e.click(); return true; } return false; })()`);

  await read(win, `document.querySelector('.rail-item[aria-label="Workspace"]')?.click()`);
  await until(win, `document.querySelector('.explorer')`);

  // Item 80 on its own: `KOVAN_SMOKE_EDITOR=<repo>` drives the diff and the
  // editor against that disposable repo (it runs git stash in it) and stops.
  if (process.env['KOVAN_SMOKE_EDITOR']) {
    await until(win, `document.querySelector('.ws-row')`, 30_000);
    return { editor80: await driveEditorFreshness(win, process.env['KOVAN_SMOKE_EDITOR']) };
  }

  if (!(await until(win, `document.querySelector('.ws-row')`, 30_000))) {
    return {
      reached: false,
      explorer: await read(win, `document.querySelector('.explorer .queue-list')?.textContent ?? ''`)
    };
  }
  // Statuses arrive after the repo list; wait rather than race. A repo row
  // shows nothing until its status is in, then a dot or a count.
  await until(win, `Array.from(document.querySelectorAll('.repo-main'))
    .every(b => b.querySelector('.dot, .repo-pill'))`, 30_000);

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
         pill: r.querySelector('.repo-pill')?.textContent,
         clean: r.querySelector('.dot.pass')?.getAttribute('title') ?? null
       }))`
    ),
    // Item 78: every repository's name starts at the same x. The chevron used
    // to shrink by however much a long name needed.
    nameLefts: await read(
      win,
      `Array.from(new Set(Array.from(document.querySelectorAll('.repo-main > .repo-name'))
         .map(n => Math.round(n.getBoundingClientRect().left))))`
    ),
    // Terminal and remove take no space until hover.
    hiddenActions: await read(
      win,
      `Array.from(document.querySelectorAll('.repo .icon-button.reveal'))
         .every(b => getComputedStyle(b).display === 'none')`
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

  // --- Item 78: leaving the view and coming back keeps its state ---------
  await read(
    win,
    `Array.from(document.querySelectorAll('.seg')).find(s => s.textContent.includes('Changes'))?.click()`
  );
  const last = await read(win, `document.querySelectorAll('.repo-main').length - 1`) as number;
  await read(win, `document.querySelectorAll('.repo-main')[${last}]?.click()`);
  await until(win, `document.querySelector('.change') || document.querySelector('.tree-note.clean')`, 20_000);
  const openBefore = await read(
    win,
    `Array.from(document.querySelectorAll('.repo-main[aria-expanded="true"] .repo-name')).map(n => n.textContent)`
  );
  await read(win, `document.querySelector('.rail-item[aria-label="Pull requests"]')?.click()`);
  await until(win, `document.querySelector('.keep-alive.hidden')`, 5_000);
  const hiddenWhileAway = await read(
    win, `getComputedStyle(document.querySelector('.keep-alive')).display === 'none'`
  );
  await read(win, `document.querySelector('.rail-item[aria-label="Workspace"]')?.click()`);
  await until(win, `!document.querySelector('.keep-alive.hidden')`, 5_000);
  summary['keepsState'] = {
    hiddenWhileAway,
    pane: await read(win, `document.querySelector('.seg.on')?.textContent?.trim()`),
    openBefore,
    openAfter: await read(
      win,
      `Array.from(document.querySelectorAll('.repo-main[aria-expanded="true"] .repo-name')).map(n => n.textContent)`
    ),
    // Clicking the active rail icon still folds the sidebar away.
    foldsSidebar: await (async () => {
      await read(win, `document.querySelector('.rail-item[aria-label="Workspace"]')?.click()`);
      await new Promise((r) => setTimeout(r, 100));
      const gone = await read(win, `getComputedStyle(document.querySelector('.explorer')).display === 'none'`);
      await read(win, `document.querySelector('.rail-item[aria-label="Workspace"]')?.click()`);
      await new Promise((r) => setTimeout(r, 100));
      return gone;
    })()
  };
  if (process.env['KOVAN_SHOT_KEPT']) {
    await writeFile(process.env['KOVAN_SHOT_KEPT'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['KOVAN_SHOT_KEPT']}`);
  }
  await click('.icon-button.boxed');
  await read(
    win,
    `Array.from(document.querySelectorAll('.seg')).find(s => s.textContent.trim() === 'Files')?.click()`
  );

  // --- Item 79: reordering the workspace's folders ------------------------
  summary['reorder'] = await driveFolderReorder(win);

  if (process.env['KOVAN_SHOT_REPOS']) {
    await writeFile(process.env['KOVAN_SHOT_REPOS'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['KOVAN_SHOT_REPOS']}`);
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
  // Gated on its own explicit opt-in, separate from `KOVAN_SMOKE=workspace`
  // itself — this is the one part of the workspace walk that mutates git
  // state and deletes an untracked file, and `workspace` mode otherwise runs
  // against whatever real folders happen to be configured. Set this only
  // against a disposable repo.
  if (process.env['KOVAN_SMOKE_REVERT'] === '1') {
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
    if (process.env['KOVAN_SHOT_DIFF']) {
      await writeFile(process.env['KOVAN_SHOT_DIFF'], (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${process.env['KOVAN_SHOT_DIFF']}`);
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
  win.webContents.insertText('KOVAN_SMOKE_EDIT');
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
    const file = process.env['KOVAN_EDIT_CHECK'];
    if (file) {
      onDisk = await readFile(file, 'utf8').catch(() => '<unreadable>');
    }
  }

  summary['editing'] = {
    focused,
    textChanged: (await read(win, `document.querySelector('.cm-content')?.textContent ?? ''`)) !== before,
    wentDirty,
    savedViaKeyboard,
    editOnDisk: onDisk ? onDisk.includes('KOVAN_SMOKE_EDIT') : 'not checked',
    conflictShown: await read(win, `Boolean(document.querySelector('.conflict'))`)
  };

  // --- The conflict path ----------------------------------------------------
  // An agent writing the same file while you type is the expected collision,
  // not an exotic one, so it is worth a real test rather than a hand-check:
  // change the file behind the editor's back, type, save, and assert the save
  // was refused rather than silently clobbering.
  const edited = process.env['KOVAN_EDIT_CHECK'];
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

    if (process.env['KOVAN_SHOT_CONFLICT']) {
      await writeFile(
        process.env['KOVAN_SHOT_CONFLICT'],
        (await win.webContents.capturePage()).toPNG()
      );
      console.log(`shot: ${process.env['KOVAN_SHOT_CONFLICT']}`);
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
        if (process.env['KOVAN_SHOT_RESIZE']) {
          await writeFile(
            process.env['KOVAN_SHOT_RESIZE'],
            (await win.webContents.capturePage()).toPNG()
          );
          console.log(`shot: ${process.env['KOVAN_SHOT_RESIZE']}`);
        }
      });
      const widened = await widthOf();
      const stored = await read(win, `localStorage.getItem('kovan.sidebar-width')`);

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
        forgotten: (await read(win, `localStorage.getItem('kovan.sidebar-width')`)) === null
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

  if (process.env['KOVAN_SHOT_MENU']) {
    await writeFile(process.env['KOVAN_SHOT_MENU'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['KOVAN_SHOT_MENU']}`);
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
      ? existsSync(`${process.env['KOVAN_WS_FOLDER']?.split(':')[0]}`)
      : 'not checked'
  };

  if (process.env['KOVAN_SHOT_WS']) {
    await writeFile(process.env['KOVAN_SHOT_WS'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['KOVAN_SHOT_WS']}`);
  }

  return summary;
}

/**
 * Item 79: drags the last folder row above the first with a real mouse, then
 * moves it back down with ⌥↓, and checks each order reached the stored
 * workspace — plus that a drag doesn't also open the row, and a plain click
 * still does.
 */
async function driveFolderReorder(win: BrowserWindow): Promise<Record<string, unknown>> {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const names = () => read(win, `Array.from(document.querySelectorAll('[data-root-row] > .repo .repo-name')).map(n => n.textContent)`);
  const stored = () => read(win, `window.kovan.workspaces().then(({ list, active }) =>
    list.find(w => w.id === active).folders.map(f => f.split('/').pop()))`);
  const centre = async (index: number, dy = 0) => await read(win, `(() => {
    const r = document.querySelectorAll('[data-root-row] > .repo')[${index}].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 3), y: Math.round(r.top + r.height / 2 + ${dy}) };
  })()`) as { x: number; y: number };

  win.show();
  win.focus();
  const before = await names();
  const count = (before as string[]).length;
  const from = await centre(count - 1);
  const to = await centre(0, -8);

  win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
  await pause(60);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / 8);
    const y = Math.round(from.y + ((to.y - from.y) * i) / 8);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y, button: 'left' } as Electron.MouseInputEvent);
    await pause(30);
  }
  await pause(100);
  const midDrag = await read(win, `({
    line: document.querySelector('.ws-root.drop-before, .ws-root.drop-after')?.className ?? null,
    dimmed: Boolean(document.querySelector('.ws-root.dragged'))
  })`);
  if (process.env['KOVAN_SHOT_REORDER']) {
    await writeFile(process.env['KOVAN_SHOT_REORDER'], (await win.webContents.capturePage()).toPNG());
    console.log(`shot: ${process.env['KOVAN_SHOT_REORDER']}`);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await pause(400);
  const afterDrag = await names();
  const storedAfterDrag = await stored();
  const openedByDrop = await read(win, `Array.from(document.querySelectorAll('[data-root-row] > .repo .repo-main'))
    .some(b => b.getAttribute('aria-expanded') === 'true')`);

  // ⌥↓ on the moved row puts it back one place, and keeps focus on it.
  await read(win, `document.querySelector('[data-root-row] > .repo .repo-main')?.focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['alt'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['alt'] });
  await pause(400);
  const afterKey = await names();
  const storedAfterKey = await stored();
  const focusKept = await read(win, `document.activeElement?.closest('[data-root-row]')?.querySelector('.repo-name')?.textContent`);

  // A plain click still opens a row.
  const first = await centre(0);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: first.x, y: first.y, button: 'left', clickCount: 1 });
  await pause(40);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: first.x, y: first.y, button: 'left', clickCount: 1 });
  await pause(300);
  const clickOpens = await read(win, `document.querySelector('[data-root-row] > .repo .repo-main')?.getAttribute('aria-expanded')`);
  await read(win, `document.querySelector('.icon-button.boxed')?.click()`);

  return { before, midDrag, afterDrag, storedAfterDrag, openedByDrop, afterKey, storedAfterKey, focusKept, clickOpens };
}

/**
 * Item 17, driven for real against whatever repo `driveWorkspace` already
 * has the Changes tab open on. Only ever invoked behind `KOVAN_SMOKE_REVERT`
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
  if (process.env['KOVAN_SHOT_REVERT_CONFIRM']) {
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(
      process.env['KOVAN_SHOT_REVERT_CONFIRM'],
      (await win.webContents.capturePage()).toPNG()
    );
    console.log(`shot: ${process.env['KOVAN_SHOT_REVERT_CONFIRM']}`);
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
  const hadRevertAll = await read_<boolean>(`Boolean(document.querySelector('.icon-button.revert-all'))`);
  let allConfirmText = '';
  let afterAll = afterOne;
  let clean = false;
  if (hadRevertAll) {
    await read(win, `document.querySelector('.icon-button.revert-all')?.click()`);
    await until(win, `document.querySelector('.menu.confirm')`, 5_000);
    allConfirmText = await confirmText();
    if (process.env['KOVAN_SHOT_REVERT_ALL']) {
      await new Promise((r) => setTimeout(r, 150));
      await writeFile(process.env['KOVAN_SHOT_REVERT_ALL'], (await win.webContents.capturePage()).toPNG());
      console.log(`shot: ${process.env['KOVAN_SHOT_REVERT_ALL']}`);
    }
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
