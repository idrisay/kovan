import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMenuDismiss } from './menuDismiss';
import { DEFAULT_PULL_SORT, formatAge, isBlocked, moveBy, moveItem, PULL_SORTS, sortPulls, type PullSort } from '@baton/core';
import type {
  JiraIssue, PolledProvider, PullSummary, RunKind, RunTarget, SentryFrame, SentryIssue,
  SessionInfo, Snapshot, ThemeChoice
} from './types';
import { Settings } from './Settings';
import { levelTone, PullPane, SentryPane, TicketPane } from './Detail';
import { RunSheet } from './RunSheet';
import { GroupHead, PullRow } from './rows';
import { WorkspaceView } from './Workspace';
import { QuickJobRow, QuickJobView, useQuickJobs } from './QuickJobs';
import { SessionUsageChip, UsageOverview, UsageRow } from './Usage';
import { RunningAgentsPane, RunningAgentsRow, idleAgents, useRunningAgents } from './RunningAgents';
import { Resizer } from './Resizer';
import { useTerminalFontSize } from './terminalFontSize';
import { findSubject, type Selection, SessionName } from './sessionSubject';
import { ErrorBoundary } from './ErrorBoundary';
import { ActivityList, ActivityToasts, useActivity } from './Activity';
import { DictationLayer } from './Dictation';
import { useRailOrder } from './railOrder';
import type { ActivityEvent } from './types';

/** What the detail pane is showing, in words — for its error card and the log (item 83). */
function paneWhere(selected: Selection): string {
  if (selected.pull) return `pull request ${selected.pull.repo}#${selected.pull.number}`;
  if (selected.issue) return `ticket ${selected.issue.key}`;
  if (selected.sentry) return `Sentry issue ${selected.sentry.shortId}`;
  return 'the detail pane';
}
import {
  activateTab, detachSession, focusSession, moveSession, pruneTree, resizeSplit,
  type DropZone, type PaneTree
} from './paneTree';
import { PaneView, type DragHandlers, type DragState } from './PaneView';
import {
  PullRequestIcon, TicketIcon, TerminalIcon, WorkspaceIcon, SentryIcon, AgentsIcon, BellIcon,
  RefreshIcon, SettingsIcon, SearchIcon, SortIcon, FilterIcon, PlusIcon, CloseIcon
} from './icons';

type ViewId = 'pulls' | 'tickets' | 'sentry' | 'activity' | 'workspace' | 'sessions' | 'agents';

const VIEWS: { id: ViewId; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: 'pulls', label: 'Pull requests', icon: PullRequestIcon },
  { id: 'tickets', label: 'Tickets', icon: TicketIcon },
  { id: 'sentry', label: 'Sentry errors', icon: SentryIcon },
  // Item 86: what happened to you — review requests, approvals, new tickets.
  { id: 'activity', label: 'Activity', icon: BellIcon },
  { id: 'workspace', label: 'Workspace', icon: WorkspaceIcon },
  { id: 'sessions', label: 'Sessions', icon: TerminalIcon },
  // Running agents and token usage used to sit on top of the Sessions list;
  // they are about the whole Mac and the whole month, not the terminal you
  // are about to pick, so they get their own tab and Sessions stays a list.
  { id: 'agents', label: 'Agents and usage', icon: AgentsIcon }
];

const VIEW_IDS = VIEWS.map((v) => v.id);

const EMPTY: Snapshot = {
  at: 0, viewer: '', blocked: [], mine: [], reviewRequested: [],
  merged: [], mergedTotal: 0, loadingMerged: false,
  tickets: [], sentryIssues: [], connected: [], errors: [], refreshing: false,
  refreshedAt: {}, refreshingProviders: []
};

/** The providers a per-provider refresh actually has something to do for,
 *  and what the menu calls each one. */
const REFRESHABLE: { id: PolledProvider; label: string }[] = [
  { id: 'github', label: 'Pull requests' },
  { id: 'jira', label: 'Jira tickets' },
  { id: 'sentry', label: 'Sentry errors' }
];

/** How many more merged pull requests one press of the footer asks for. */
const MERGED_STEP = 10;

const COLLAPSED_KEY = 'baton.collapsed-groups';

/** 'system' resolved against the OS right now — never left unresolved. */
function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  return choice === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : choice;
}

/**
 * Writes the resolved theme onto `<html>`, which is all the CSS in
 * `styles.css` keys off — see the note on `:root[data-theme='light']`
 * there for why this replaced a `prefers-color-scheme` media query.
 */
function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice);
}

/**
 * Which sections start folded.
 *
 * Merged work is reference, not a queue: it is there to check something
 * shipped, not to be got through. It opens folded so the sections that *are*
 * waiting on you keep the top of the sidebar.
 */
const FOLDED_BY_DEFAULT = ['merged'];

/**
 * Collapsed sections, remembered.
 *
 * The *collapsed* set is stored rather than the expanded one, so a section
 * added in a later version defaults to open instead of being invisible to
 * anyone whose preference predates it.
 */
function storedCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw === null) {
      return new Set(FOLDED_BY_DEFAULT);
    }
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    // Corrupt or unavailable: the defaults are a fine answer, and a thrown
    // preference must never take the sidebar with it.
    return new Set(FOLDED_BY_DEFAULT);
  }
}

interface Group {
  /** Stable across renames, because the collapsed set is stored on it. */
  id: string;
  label: string;
  pulls: PullSummary[];
  tint: boolean;
  note?: string;
}

const countBlocked = (pulls: readonly PullSummary[]) => pulls.filter(isBlocked).length;

/** The ticket fields a facet filter narrows down. */
type TicketFacetKey = 'status' | 'issueType' | 'priority' | 'assignee';

type TicketFilters = Record<TicketFacetKey, Set<string>>;

function emptyTicketFilters(): TicketFilters {
  return { status: new Set(), issueType: new Set(), priority: new Set(), assignee: new Set() };
}

const TICKET_FACETS: { key: TicketFacetKey; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'issueType', label: 'Type' },
  { key: 'priority', label: 'Priority' },
  { key: 'assignee', label: 'Assignee' }
];

/**
 * The values a ticket filter can narrow the tickets list down to, per facet
 * — every distinct status, type, priority and assignee actually present, so
 * the menu never offers a choice that would just empty the list.
 */
function ticketFacetValues(tickets: readonly JiraIssue[]): Record<TicketFacetKey, string[]> {
  const uniq = (values: (string | undefined)[]) =>
    [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
  return {
    status: uniq(tickets.map((t) => t.status)),
    issueType: uniq(tickets.map((t) => t.issueType)),
    priority: uniq(tickets.map((t) => t.priority)),
    assignee: uniq(tickets.map((t) => t.assignee))
  };
}

/**
 * The funnel button next to Sort. A ticket matches only when every facet
 * with a selection includes it — an empty selection on a facet means "don't
 * care", not "match nothing", which is why an unopened menu leaves the list
 * exactly as the text filter left it.
 */
function TicketFilterMenu({
  values, tickets, active, onToggle, onClear
}: {
  values: Record<TicketFacetKey, string[]>;
  tickets: readonly JiraIssue[];
  active: TicketFilters;
  onToggle: (facet: TicketFacetKey, value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = TICKET_FACETS.reduce((n, f) => n + active[f.key].size, 0);

  // Status offers every status of the projects' workflows, not only the ones
  // a loaded ticket happens to be in right now — otherwise a status with
  // nobody in it ("In Development") looks like it does not exist. Asked from
  // Jira the first time the menu opens; main keeps it for an hour.
  const [projectStatuses, setProjectStatuses] = useState<string[]>();
  useEffect(() => {
    if (!open || projectStatuses) return;
    void window.baton.ticketStatuses().then((list) => setProjectStatuses(list.map((s) => s.name)));
  }, [open, projectStatuses]);
  const statusCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tickets) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    return counts;
  }, [tickets]);
  const options = (facet: TicketFacetKey): string[] => {
    if (facet !== 'status' || !projectStatuses?.length) return values[facet];
    const extra = values.status.filter((s) => !projectStatuses.includes(s));
    return [...projectStatuses, ...extra];
  };

  // Any click outside closes the menu, same as the workspace overflow menu.
  useMenuDismiss(open, () => setOpen(false));

  return (
    <div className="filter-menu-host">
      <button
        type="button"
        className={count > 0 ? 'icon-button active' : 'icon-button'}
        aria-label="Filter tickets" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <FilterIcon />
        {count > 0 && <span className="filter-count">{count}</span>}
      </button>
      {open && (
        <div className="menu filter-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {TICKET_FACETS.map((facet) => {
            const list = options(facet.key);
            if (list.length === 0) return null;
            return (
              <div key={facet.key} className="filter-group">
                <p className="menu-head">{facet.label}</p>
                {list.map((value) => {
                  const n = facet.key === 'status' ? statusCount.get(value) ?? 0 : undefined;
                  return (
                    <label key={value} className={n === 0 ? 'filter-option unused' : 'filter-option'}>
                      <input
                        type="checkbox"
                        checked={active[facet.key].has(value)}
                        onChange={() => onToggle(facet.key, value)}
                      />
                      <span className="filter-option-name">{value}</span>
                      {n !== undefined && <span className="filter-option-count">{n}</span>}
                    </label>
                  );
                })}
              </div>
            );
          })}
          {count > 0 && (
            <>
              <div className="menu-rule" />
              <button type="button" role="menuitem" className="menu-warn" onClick={onClear}>
                Clear filters
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type TicketSort = 'updated' | 'priority' | 'key';

const TICKET_SORTS: { id: TicketSort; label: string }[] = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'priority', label: 'Priority' },
  { id: 'key', label: 'Ticket key' }
];

/**
 * Most urgent first. Jira priorities are per-site configuration with no
 * order of their own — `JiraClient.getPriorities()` can read a site's actual
 * rank, but nothing in this app calls it yet, so this covers the names every
 * default Jira scheme actually uses. An unrecognised priority sorts after
 * the known ones rather than crashing the sort.
 */
const PRIORITY_RANK: Record<string, number> = {
  highest: 0, blocker: 0, urgent: 0,
  critical: 1, high: 1,
  medium: 2, normal: 2,
  low: 3,
  lowest: 4, minor: 4, trivial: 4
};

function priorityRank(priority?: string): number {
  if (!priority) return 99;
  return PRIORITY_RANK[priority.toLowerCase()] ?? 50;
}

/** Only the urgent end of the scale earns a colour; Medium/Low read as plain text. */
function priorityTone(priority: string): string {
  const rank = priorityRank(priority);
  return rank === 0 ? 'fail' : rank === 1 ? 'running' : '';
}

/** The sort icon next to Filter — a menu instead of the dead button it used to be. */
function TicketSortMenu({
  value, onChange
}: {
  value: TicketSort;
  onChange: (sort: TicketSort) => void;
}) {
  const [open, setOpen] = useState(false);

  useMenuDismiss(open, () => setOpen(false));

  return (
    <div className="menu-host">
      <button
        type="button"
        className={value !== 'updated' ? 'icon-button active' : 'icon-button'}
        aria-label="Sort tickets" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <SortIcon />
      </button>
      {open && (
        <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <p className="menu-head">Sort by</p>
          {TICKET_SORTS.map((opt) => (
            <button
              key={opt.id}
              role="menuitemradio"
              aria-checked={opt.id === value}
              className={opt.id === value ? 'active' : ''}
              onClick={() => { onChange(opt.id); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The pull requests view's own sort icon — a menu now, not the dead button
 *  it used to be. `sortPulls`/`PULL_SORTS` already existed in `@baton/core`
 *  for the poller's own default ordering; nothing in the UI ever called them. */
function PullSortMenu({
  value, onChange
}: {
  value: PullSort;
  onChange: (sort: PullSort) => void;
}) {
  const [open, setOpen] = useState(false);

  useMenuDismiss(open, () => setOpen(false));

  return (
    <div className="menu-host">
      <button
        type="button"
        className={value !== DEFAULT_PULL_SORT ? 'icon-button active' : 'icon-button'}
        aria-label="Sort pull requests" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <SortIcon />
      </button>
      {open && (
        <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <p className="menu-head">Sort by</p>
          {PULL_SORTS.map((opt) => (
            <button
              key={opt.key}
              role="menuitemradio"
              aria-checked={opt.key === value}
              className={opt.key === value ? 'active' : ''}
              title={opt.description}
              onClick={() => { onChange(opt.key); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The pull request fields a facet filter narrows down. */
type PullFacetKey = 'repo' | 'author' | 'checks';

type PullFilters = Record<PullFacetKey, Set<string>>;

function emptyPullFilters(): PullFilters {
  return { repo: new Set(), author: new Set(), checks: new Set() };
}

const PULL_FACETS: { key: PullFacetKey; label: string }[] = [
  { key: 'repo', label: 'Repository' },
  { key: 'author', label: 'Author' },
  { key: 'checks', label: 'Checks' }
];

/** Every pull request the "Pull requests" view can show, across every section. */
function pullUniverse(snapshot: Snapshot): PullSummary[] {
  return [...snapshot.blocked, ...snapshot.reviewRequested, ...snapshot.mine, ...snapshot.merged];
}

function pullFacetValues(pulls: readonly PullSummary[]): Record<PullFacetKey, string[]> {
  const uniq = (values: string[]) => [...new Set(values)].sort();
  return {
    repo: uniq(pulls.map((p) => p.repo)),
    author: uniq(pulls.map((p) => p.author)),
    checks: uniq(pulls.map((p) => p.checks))
  };
}

/** The same funnel menu as Tickets, faceted on what a pull request actually carries. */
function PullFilterMenu({
  values, active, onToggle, onClear
}: {
  values: Record<PullFacetKey, string[]>;
  active: PullFilters;
  onToggle: (facet: PullFacetKey, value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = PULL_FACETS.reduce((n, f) => n + active[f.key].size, 0);

  useMenuDismiss(open, () => setOpen(false));

  return (
    <div className="filter-menu-host">
      <button
        type="button"
        className={count > 0 ? 'icon-button active' : 'icon-button'}
        aria-label="Filter pull requests" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <FilterIcon />
        {count > 0 && <span className="filter-count">{count}</span>}
      </button>
      {open && (
        <div className="menu filter-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {PULL_FACETS.map((facet) => {
            const options = values[facet.key];
            if (options.length === 0) return null;
            return (
              <div key={facet.key} className="filter-group">
                <p className="menu-head">{facet.label}</p>
                {options.map((value) => (
                  <label key={value} className="filter-option">
                    <input
                      type="checkbox"
                      checked={active[facet.key].has(value)}
                      onChange={() => onToggle(facet.key, value)}
                    />
                    {value}
                  </label>
                ))}
              </div>
            );
          })}
          {count > 0 && (
            <>
              <div className="menu-rule" />
              <button type="button" role="menuitem" className="menu-warn" onClick={onClear}>
                Clear filters
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** How long ago a refresh finished — seconds under a minute, since that is where it lives. */
function freshness(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds / 10) * 10}s ago`;
  return `${formatAge(new Date(at).toISOString(), now)} ago`;
}

/**
 * The "just now" stamp in the titlebar, turned into a menu.
 *
 * It always answers "refresh all" — that button used to be the whole of the
 * stamp's job — but a slow provider no longer has to hold up a fast one: each
 * connected provider gets its own age and its own refresh, for the ticket
 * that only wants Jira re-asked without waiting on GitHub too.
 */
function RefreshMenu({
  snapshot, onRefreshAll, onRefreshProvider
}: {
  snapshot: Snapshot;
  onRefreshAll: () => void;
  onRefreshProvider: (id: PolledProvider) => void;
}) {
  const [open, setOpen] = useState(false);
  // The poller refreshes every minute, so a minute-grained age read "just now"
  // forever — and nothing re-rendered it between refreshes anyway. A ticking
  // clock and seconds make it say how fresh the data actually is.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  useMenuDismiss(open, () => setOpen(false));

  const rows = REFRESHABLE.filter((p) => snapshot.connected.includes(p.id));

  return (
    <div className="menu-host">
      <button
        type="button"
        className="stamp"
        aria-label="Refresh"
        aria-expanded={open}
        title={`Updated at ${new Date(snapshot.at).toLocaleTimeString()} · checks again every minute`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        {snapshot.refreshing ? 'refreshing' : freshness(snapshot.at, now)}
      </button>
      {open && (
        <div className="menu stamp-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button
            type="button" role="menuitem" className="menu-refresh-all"
            disabled={snapshot.refreshing}
            onClick={() => { onRefreshAll(); setOpen(false); }}
          >
            <RefreshIcon size={13} />
            {snapshot.refreshing ? 'Refreshing…' : 'Refresh all'}
          </button>
          {rows.length > 0 && <div className="menu-rule" />}
          {rows.map(({ id, label }) => {
            const busy = snapshot.refreshingProviders.includes(id);
            const at = snapshot.refreshedAt[id];
            return (
              <div key={id} className="menu-refresh-row">
                <span className="menu-refresh-label">{label}</span>
                <span className="menu-refresh-age">
                  {busy ? 'refreshing' : at ? freshness(at, now) : 'never'}
                </span>
                <button
                  type="button" className="icon-button" aria-label={`Refresh ${label}`}
                  disabled={busy} onClick={() => onRefreshProvider(id)}
                >
                  <RefreshIcon size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Short names for the footer's connection dots — deliberately not exported
 *  from Settings.tsx, which owns the fuller provider chrome (badges, fields).
 *  A five-entry map duplicated once here is cheaper than coupling the two. */
const STATUSBAR_PROVIDER: Record<string, string> = {
  github: 'GitHub', jira: 'Jira', sentry: 'Sentry', grafana: 'Grafana', figma: 'Figma'
};

/**
 * The window's own bottom bar, in the shape VS Code's is: a thin strip that
 * is always there, connections on the left, activity counts on the right,
 * every segment a shortcut to the view it summarises rather than a number
 * with nowhere to go.
 *
 * Deliberately not the rail's job to say twice: the rail's pips answer
 * "is anything waiting", the bar answers "how much, of what, and is a
 * connection actually failing" — the closest thing this app has to Sign in
 * to Bitbucket / 0 errors / 0 warnings on the reference screenshot.
 */
function StatusBar({
  snapshot, sessions, onView
}: {
  snapshot: Snapshot;
  sessions: SessionInfo[];
  onView: (view: ViewId) => void;
}) {
  const running = sessions.filter((s) => s.running).length;
  const failed = new Set(snapshot.errors.map((e) => e.provider));

  return (
    <footer className="statusbar">
      <div className="statusbar-group">
        {snapshot.connected.length === 0 ? (
          <span className="statusbar-item quiet">Nothing connected</span>
        ) : (
          snapshot.connected.map((id) => (
            <span
              key={id}
              className="statusbar-item"
              title={failed.has(id) ? snapshot.errors.find((e) => e.provider === id)?.message : undefined}
            >
              <span className={`dot ${failed.has(id) ? 'fail' : 'pass'}`} />
              {STATUSBAR_PROVIDER[id] ?? id}
            </span>
          ))
        )}
      </div>
      <span className="spacer" />
      <div className="statusbar-group">
        <button
          type="button"
          className={snapshot.blocked.length > 0 ? 'statusbar-item fail' : 'statusbar-item'}
          onClick={() => onView('pulls')}
        >
          <span className={`dot ${snapshot.blocked.length > 0 ? 'fail' : ''}`} />
          {snapshot.blocked.length} blocked
        </button>
        <button type="button" className="statusbar-item" onClick={() => onView('pulls')}>
          {snapshot.reviewRequested.length} awaiting review
        </button>
        <button type="button" className="statusbar-item" onClick={() => onView('tickets')}>
          {snapshot.tickets.length} tickets
        </button>
        <button
          type="button"
          className={running > 0 ? 'statusbar-item live' : 'statusbar-item'}
          onClick={() => onView('sessions')}
        >
          <span className={`dot ${running > 0 ? 'live' : ''}`} />
          {running} running
        </button>
      </div>
    </footer>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [view, setView] = useState<ViewId>('pulls');
  // Clicking the rail icon of the view already open folds its sidebar away,
  // the way VS Code's activity bar does. Going to any other view — by the rail
  // or by opening a session, ticket or pull request from somewhere — brings it
  // back, since that view's list is what you went there for.
  const [queueHidden, setQueueHidden] = useState(false);
  useEffect(() => setQueueHidden(false), [view]);
  // The workspace view is mounted on its first visit and kept from then on;
  // see `keep-alive` below. Not before: opening Baton must not scan folders.
  const [workspaceSeen, setWorkspaceSeen] = useState(false);
  useEffect(() => { if (view === 'workspace') setWorkspaceSeen(true); }, [view]);

  // Cmd+F puts you in the sidebar's filter — what the ⌘F badge in it promises.
  // Left alone inside the code editor, which has its own find, and on views
  // with no filter.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      if (event.target instanceof Element && event.target.closest('.cm-editor')) return;
      if (!document.getElementById('q')) return;
      event.preventDefault();
      setQueueHidden(false);
      // After the sidebar is back in layout: a display:none input takes no focus.
      requestAnimationFrame(() => {
        const input = document.getElementById('q');
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [connecting, setConnecting] = useState(false);
  const [selected, setSelected] = useState<Selection>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Until main has answered once, an empty list means "not asked yet", not
  // "no sessions" — the saved split layout must not be pruned against it.
  const [sessionsReady, setSessionsReady] = useState(false);
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [activeSession, setActiveSession] = useState<string>();
  const [runSheet, setRunSheet] = useState<
    ({ kind: RunKind } & Pick<Selection, 'pull' | 'issue'> & {
      sentry?: { issue: SentryIssue; frames: SentryFrame[] };
    }) | undefined
  >();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(storedCollapsed);
  const [pullFilters, setPullFilters] = useState<PullFilters>(emptyPullFilters);
  const [pullSort, setPullSort] = useState<PullSort>(DEFAULT_PULL_SORT);
  const [ticketFilters, setTicketFilters] = useState<TicketFilters>(emptyTicketFilters);
  const [ticketSort, setTicketSort] = useState<TicketSort>('updated');
  const [theme, setThemeState] = useState<ThemeChoice>('system');
  const [fontSize] = useTerminalFontSize();
  const idleCount = idleAgents(useRunningAgents()).length;
  const [agentsPane, setAgentsPane] = useState<AgentsPaneId>('agents');
  useEffect(() => window.baton.onShowAgents(() => {
    setView('agents');
    setAgentsPane('agents');
  }), []);

  // Seeded once from disk, then applied — and re-applied live if "System" is
  // the choice and the OS itself changes appearance underneath it.
  useEffect(() => {
    void window.baton.settings().then((settings) => {
      const choice = (settings['appearance.theme'] as ThemeChoice) || 'system';
      setThemeState(choice);
      applyTheme(choice);
    });
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') {
      return undefined;
    }
    const mql = matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyTheme('system');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((choice: ThemeChoice) => {
    setThemeState(choice);
    void window.baton.setSetting('appearance.theme', choice);
  }, []);

  const togglePullFilter = useCallback((facet: PullFacetKey, value: string) => {
    setPullFilters((current) => {
      const next = { ...current, [facet]: new Set(current[facet]) };
      if (!next[facet].delete(value)) {
        next[facet].add(value);
      }
      return next;
    });
  }, []);
  const clearPullFilters = useCallback(() => setPullFilters(emptyPullFilters()), []);

  const toggleTicketFilter = useCallback((facet: TicketFacetKey, value: string) => {
    setTicketFilters((current) => {
      const next = { ...current, [facet]: new Set(current[facet]) };
      if (!next[facet].delete(value)) {
        next[facet].add(value);
      }
      return next;
    });
  }, []);
  const clearTicketFilters = useCallback(() => setTicketFilters(emptyTicketFilters()), []);

  const toggleGroup = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* fine */ }
      return next;
    });
  }, []);

  // Never let an older snapshot win: the initial fetch, the push subscription
  // and a "show more" all race, and a late-resolving one would roll the view
  // back. Lifted out of the effect because every call that returns a snapshot
  // has to go through the same gate, not just the ones the effect makes.
  const accept = useCallback((next: Snapshot) => {
    setSnapshot((current) => (next.at >= current.at ? next : current));
  }, []);

  useEffect(() => {
    void window.baton.snapshot().then(accept);
    void window.baton.sessions().then((list) => { setSessions(list); setSessionsReady(true); });
    void window.baton.runTargets().then(setTargets);
    const offSnapshot = window.baton.onSnapshot(accept);
    const offSessions = window.baton.onSessions(setSessions);
    return () => { offSnapshot(); offSessions(); };
  }, [accept]);

  const refresh = useCallback(() => void window.baton.refresh(), []);

  // --- Rail order (item 89) -------------------------------------------------
  // Drag an icon up or down, or ⌥↑ / ⌥↓ on a focused one; the same clay line
  // and dimmed item as reordering Sessions and the workspace's folders.
  const [railOrder, setRailOrder] = useRailOrder(VIEW_IDS);
  const [railDrag, setRailDrag] = useState<{ id: ViewId; moving: boolean; target?: ViewId; after?: boolean }>();
  const railDragged = useRef(false);

  const moveRailItem = useCallback((id: ViewId, delta: -1 | 1) => {
    setRailOrder(moveBy(railOrder, id, delta));
    // Moving a node can drop its focus; keep it, so ⌥↓ can be pressed again.
    requestAnimationFrame(() => (document.querySelector(`.rail-item[data-view="${id}"]`) as HTMLElement | null)?.focus());
  }, [railOrder, setRailOrder]);

  const startRailDrag = useCallback((event: ReactPointerEvent, id: ViewId) => {
    if (event.button !== 0) return;
    const startY = event.clientY;
    let moving = false;
    let target: { id: ViewId; after: boolean } | undefined;
    railDragged.current = false;
    const move = (e: PointerEvent) => {
      if (!moving && Math.abs(e.clientY - startY) < 4) return;
      if (!moving) {
        moving = true;
        document.body.classList.add('dragging-row');
      }
      const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
        ?.closest('.rail-item[data-view]') as HTMLElement | null;
      const overId = over?.dataset['view'] as ViewId | undefined;
      if (over && overId && overId !== id) {
        const rect = over.getBoundingClientRect();
        target = { id: overId, after: e.clientY > rect.top + rect.height / 2 };
      } else if (!over) {
        target = undefined;
      }
      setRailDrag({ id, moving: true, ...(target ? { target: target.id, after: target.after } : {}) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging-row');
      if (moving) {
        railDragged.current = true;
        // Cleared after the click this pointerup is about to cause.
        setTimeout(() => { railDragged.current = false; }, 0);
        if (target) setRailOrder(moveItem(railOrder, id, target.id, target.after));
      }
      setRailDrag(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [railOrder, setRailOrder]);

  // --- Activity inbox (item 86) ---------------------------------------------
  const activity = useActivity();
  const [activityId, setActivityId] = useState<string>();
  /** A subject to open in Activity once the snapshot can find it ('' = just the tab). */
  const [activityRequest, setActivityRequest] = useState<string>();

  /** An event, clicked in the inbox or on a toast: read it and show it beside the inbox. */
  const openEvent = useCallback((event: ActivityEvent) => {
    if (!event.read) activity.markRead([event.id]);
    setView('activity');
    setActivityId(event.id);
    const match = findSubject(event.subject, snapshot);
    if (match) setSelected(match);
    // Merged and aged out, or resolved: not in any list Baton holds any more.
    else void window.baton.openExternal(event.url);
  }, [activity, snapshot]);

  // A clicked macOS notification, now or from before this window existed.
  useEffect(() => {
    if (activity.launchOpen !== undefined) setActivityRequest(activity.launchOpen);
  }, [activity.launchOpen]);
  useEffect(() => window.baton.onActivityOpen((subject) => setActivityRequest(subject)), []);
  useEffect(() => {
    if (activityRequest === undefined) return;
    setView('activity');
    if (activityRequest === '') {
      setActivityRequest(undefined);
      return;
    }
    const event = activity.inbox.find((e) => e.subject === activityRequest);
    if (event && snapshot.at > 0) {
      setActivityRequest(undefined);
      openEvent(event);
    }
  }, [activityRequest, activity.inbox, snapshot.at, openEvent]);

  const counts = useMemo(() => ({
    pulls: snapshot.blocked.length + snapshot.reviewRequested.length,
    tickets: snapshot.tickets.length,
    sentry: snapshot.sentryIssues.length,
    activity: 0,
    workspace: 0,
    sessions: sessions.filter((s) => s.running).length,
    agents: 0
  }), [snapshot, sessions]);

  /** Opening a terminal anywhere lands you in the session that just started. */
  const openTerminal = useCallback((cwd?: string) => {
    void window.baton.openTerminal(cwd).then((s) => {
      setActiveSession(s.id);
      setView('sessions');
    });
  }, []);

  /**
   * Bringing a session into view, from wherever it is found. Deliberately
   * does not change `view` — called from a pull request or ticket's own
   * "Sessions" list, it should surface the terminal right there, docked at
   * the bottom of the pane already open, not jump to the separate tab.
   */
  const openSession = useCallback((id: string) => {
    setActiveSession(id);
  }, []);

  /**
   * A closed session stops being the one on screen.
   *
   * Without this the pane kept rendering a terminal pointed at a session the
   * main process had already forgotten — a frozen last frame you could not
   * type into, which is what "it still shows it" was.
   */
  useEffect(() => {
    if (activeSession && !sessions.some((s) => s.id === activeSession)) {
      setActiveSession(undefined);
    }
  }, [sessions, activeSession]);

  /**
   * Opening Sessions with something already running shows the first one
   * rather than an empty pane — but only ever the once. After that, closing
   * whatever you were watching leaves the choice to you instead of silently
   * sliding the next session into its place, which reads as "the terminal I
   * just closed is still here" all over again.
   */
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current) return;
    if (activeSession) {
      autoPicked.current = true;
    } else if (sessions.length > 0) {
      autoPicked.current = true;
      setActiveSession(sessions[0]!.id);
    }
  }, [sessions, activeSession]);

  /** Renaming only ever touches the label — never `subject`, which is what
   *  the row's own click-through to a pull request or ticket goes by. */
  const renameSession = useCallback((id: string, title: string) => {
    void window.baton.sessionRename(id, title);
  }, []);

  /** A session row's identifier, clicked: the pull request or ticket it was
   *  started on, in its own tab. */
  const openSubject = useCallback((match: Selection) => {
    setSelected(match);
    setView(match.pull ? 'pulls' : match.issue ? 'tickets' : 'sentry');
  }, []);

  const current = VIEWS.find((v) => v.id === view)!;

  const match = useCallback((p: PullSummary) => {
    const q = filter.trim().toLowerCase();
    const textOk = !q ||
      p.title.toLowerCase().includes(q) ||
      p.repo.toLowerCase().includes(q) ||
      String(p.number).includes(q);
    if (!textOk) {
      return false;
    }
    return PULL_FACETS.every(({ key }) => {
      const selected = pullFilters[key];
      return selected.size === 0 || selected.has(p[key]);
    });
  }, [filter, pullFilters]);

  /**
   * One list, grouped by urgency — not one queue per rail item.
   *
   * "Awaiting your review" used to be its own rail tab; folded in here as
   * just another section, it is one fewer place to go looking. Splitting
   * "blocked" into its own view meant every row in it was tinted, which is a
   * wall of red and the opposite of what the tint is for: red has to mean
   * *this one* failed. Grouped, only the first section is tinted and the
   * rest state themselves in grey, which is the design's rule.
   *
   * Every section always shows, even at zero — a section that only
   * appears once something lands in it reads as broken the rest of the
   * time, not as "you're caught up". The fixed set of five is what you
   * check, not just whatever happens to be non-empty today.
   *
   * Drafts sit last because a draft is not waiting on anyone.
   */
  const groups = useMemo((): Group[] => {
    const blockedIds = new Set(snapshot.blocked.map((p) => `${p.repo}#${p.number}`));
    const rest = snapshot.mine.filter((p) => !blockedIds.has(`${p.repo}#${p.number}`));
    const drafts = rest.filter((p) => p.isDraft).filter(match);
    // Merged keeps its own newest-shipped order regardless of the sort menu:
    // it is a window onto a much longer list, paginated by merge date, and
    // re-sorting just the visible page by "created" or "updated" would make
    // "Show more" fetch a wider window that no longer matches what is on screen.
    return [
      {
        id: 'blocked', label: 'Blocked on you',
        pulls: sortPulls(snapshot.blocked.filter(match), pullSort), tint: true
      },
      {
        id: 'review', label: 'Awaiting your review',
        pulls: sortPulls(snapshot.reviewRequested.filter(match), pullSort), tint: false
      },
      {
        id: 'open', label: 'Open',
        pulls: sortPulls(rest.filter((p) => !p.isDraft).filter(match), pullSort), tint: false
      },
      {
        id: 'drafts',
        label: 'Drafts',
        pulls: sortPulls(drafts, pullSort),
        tint: false,
        // A draft is not waiting on anyone, so the section is grey — but one
        // that cannot merge is still worth saying out loud from the outside,
        // because folded is exactly where it would otherwise go unnoticed.
        note: countBlocked(drafts) > 0 ? `${countBlocked(drafts)} blocked` : undefined
      },
      { id: 'merged', label: 'Recently merged', pulls: snapshot.merged.filter(match), tint: false }
    ];
  }, [snapshot, match, pullSort]);

  const pullFacets = useMemo(() => pullFacetValues(pullUniverse(snapshot)), [snapshot]);
  const pullFilterCount = PULL_FACETS.reduce((n, f) => n + pullFilters[f.key].size, 0);

  const loadMoreMerged = useCallback(() => {
    void window.baton.loadMoreMerged(snapshot.merged.length + MERGED_STEP).then(accept);
  }, [snapshot.merged.length, accept]);

  const ticketFacets = useMemo(() => ticketFacetValues(snapshot.tickets), [snapshot.tickets]);
  const ticketFilterCount = TICKET_FACETS.reduce((n, f) => n + ticketFilters[f.key].size, 0);

  const tickets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matching = snapshot.tickets.filter((t) => {
      if (q && !t.summary.toLowerCase().includes(q) && !t.key.toLowerCase().includes(q)) {
        return false;
      }
      return TICKET_FACETS.every(({ key }) => {
        const selected = ticketFilters[key];
        return selected.size === 0 || selected.has(t[key] ?? '');
      });
    });
    const sorted = [...matching];
    if (ticketSort === 'priority') {
      sorted.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.updated.localeCompare(a.updated));
    } else if (ticketSort === 'key') {
      sorted.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    } else {
      sorted.sort((a, b) => b.updated.localeCompare(a.updated));
    }
    return sorted;
  }, [snapshot.tickets, filter, ticketFilters, ticketSort]);

  /** Newest-first, same as the ticket list's own default — no sort/filter
   *  menu of its own yet, just the shared search box. */
  const sentryIssues = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matching = q
      ? snapshot.sentryIssues.filter(
          (i) => i.title.toLowerCase().includes(q) || i.shortId.toLowerCase().includes(q)
        )
      : snapshot.sentryIssues;
    return [...matching].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }, [snapshot.sentryIssues, filter]);

  const onStarted = (sessionId: string) => {
    setRunSheet(undefined);
    setActiveSession(sessionId);
    // No view change: a run is always started from the pull request or
    // ticket it is about, and that pane docks the new session's terminal
    // itself the moment `sessions` includes it — see `PullPane`/`TicketPane`.
    void window.baton.sessions().then(setSessions);
  };

  const nothingConnected = snapshot.connected.length === 0;

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">Baton</span>
        {snapshot.viewer && <span className="viewer">{snapshot.viewer}</span>}
        <span className="spacer" />
        {snapshot.at > 0 && (
          <RefreshMenu
            snapshot={snapshot}
            onRefreshAll={refresh}
            onRefreshProvider={(id) => void window.baton.refreshProvider(id)}
          />
        )}
      </header>

      {snapshot.errors.length > 0 && (
        <div className="errors">
          {snapshot.errors.map((e) => (
            <div key={e.provider} className="error"><strong>{e.provider}</strong> {e.message}</div>
          ))}
        </div>
      )}

      {nothingConnected && !connecting ? (
        <Empty onConnect={() => setConnecting(true)} />
      ) : (
        <div className={queueHidden ? 'body queue-hidden' : 'body'}>
          <nav className="rail" aria-label="Sections">
            {railOrder.map((id) => VIEWS.find((x) => x.id === id)!).map((v) => {
              const Icon = v.icon;
              const n = counts[v.id];
              const drop = railDrag?.target === v.id ? (railDrag.after ? ' drop-after' : ' drop-before') : '';
              return (
                <button
                  key={v.id}
                  type="button"
                  data-view={v.id}
                  aria-label={v.label}
                  aria-current={v.id === view ? 'page' : undefined}
                  aria-expanded={v.id === view ? !queueHidden : undefined}
                  title={`${v.id === view ? (queueHidden ? `Show ${v.label}` : `Hide ${v.label}`) : v.label} — drag or ⌥↑/⌥↓ to reorder`}
                  className={`rail-item${v.id === view ? ' active' : ''}${railDrag?.id === v.id && railDrag.moving ? ' dragged' : ''}${drop}`}
                  onPointerDown={(e) => startRailDrag(e, v.id)}
                  onKeyDown={(e) => {
                    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                    e.preventDefault();
                    moveRailItem(v.id, e.key === 'ArrowUp' ? -1 : 1);
                  }}
                  onClick={() => {
                    // The click that ends a drag isn't a click on the tab.
                    if (railDragged.current) return;
                    if (v.id === view) setQueueHidden((hidden) => !hidden);
                    else setView(v.id);
                  }}
                >
                  <Icon />
                  {v.id === 'pulls' && n > 0 && <span className="rail-pip" />}
                  {v.id === 'sessions' && n > 0 && <span className="rail-pip live" />}
                  {v.id === 'activity' && activity.unread > 0 && (
                    <span className="rail-count" title={`${activity.unread} unread`}>
                      {activity.unread > 99 ? '99+' : activity.unread}
                    </span>
                  )}
                  {v.id === 'agents' && idleCount > 0 && (
                    <span className="rail-pip idle" title={`${idleCount} idle agent${idleCount === 1 ? '' : 's'}`} />
                  )}
                </button>
              );
            })}
            <span className="rail-spacer" />
            <button
              type="button" aria-label="Settings" className="rail-item"
              onClick={() => setConnecting(true)}
            >
              <SettingsIcon />
            </button>
          </nav>

          {/* Mounted on first visit, then only hidden, so it keeps its
              state across rail switches. `display: contents` leaves its
              aside and main as the body's own flex items. */}
          {workspaceSeen && (
            <div className={view === 'workspace' ? 'keep-alive' : 'keep-alive hidden'}>
              <WorkspaceView onTerminal={openTerminal} visible={view === 'workspace'} />
            </div>
          )}

          {view === 'sessions' ? (
            <Sessions
              sessions={sessions} sessionsReady={sessionsReady} active={activeSession} onSelect={setActiveSession}
              targets={targets} onOpen={openTerminal}
              snapshot={snapshot} onOpenSubject={openSubject} onRename={renameSession}
              fontSize={fontSize}
            />
          ) : view === 'agents' ? (
            <AgentsView
              pane={agentsPane} onPane={setAgentsPane}
              snapshot={snapshot} onOpenSubject={openSubject}
              onOpenSession={(id) => { setActiveSession(id); setView('sessions'); }}
            />
          ) : view === 'workspace' ? null : (
            <>
              <aside className="queue" aria-label={current.label}>
                <div className="queue-head">
                  <div className="queue-title-row">
                    <h1>{current.label}</h1>
                    {view === 'tickets' ? (
                      <>
                        <TicketFilterMenu
                          values={ticketFacets}
                          tickets={snapshot.tickets}
                          active={ticketFilters}
                          onToggle={toggleTicketFilter}
                          onClear={clearTicketFilters}
                        />
                        <TicketSortMenu value={ticketSort} onChange={setTicketSort} />
                      </>
                    ) : view === 'pulls' ? (
                      <>
                        <PullFilterMenu
                          values={pullFacets}
                          active={pullFilters}
                          onToggle={togglePullFilter}
                          onClear={clearPullFilters}
                        />
                        <PullSortMenu value={pullSort} onChange={setPullSort} />
                      </>
                    ) : view === 'activity' ? (
                      activity.unread > 0 && (
                        <button type="button" className="link" onClick={() => activity.markRead('all')}>
                          Mark all read
                        </button>
                      )
                    ) : null}
                  </div>
                  <div className="search">
                    <SearchIcon />
                    <label htmlFor="q" className="sr-only" style={{ display: 'none' }}>Filter</label>
                    <input
                      id="q" type="text" placeholder="Filter"
                      value={filter} onChange={(e) => setFilter(e.target.value)}
                    />
                    {filter === '' && <kbd>⌘F</kbd>}
                  </div>
                </div>

                <div className="queue-list">
                  {view === 'activity' ? (
                    <ActivityList
                      inbox={activity.inbox} filter={filter} selectedId={activityId} onOpen={openEvent}
                    />
                  ) : view === 'sentry' ? (
                    sentryIssues.length === 0 ? (
                      <p className="quiet">{filter ? 'No errors match.' : 'No Sentry errors.'}</p>
                    ) : (
                      <ul className="rows">
                        {sentryIssues.map((issue) => (
                          <li key={issue.id}>
                            <button
                              className={selected.sentry?.id === issue.id ? 'row selected' : 'row'}
                              onClick={() => setSelected({ sentry: issue })}
                            >
                              <span className="row-top">
                                <span className="row-num">{issue.shortId}</span>
                                <span className="row-title">{issue.title}</span>
                              </span>
                              <span className="row-state">
                                <span className="state">
                                  <span className={`dot ${levelTone(issue.level)}`} />
                                  {issue.culprit || issue.level}
                                </span>
                                <span className="spacer" />
                                <span className="row-age">{formatAge(issue.lastSeen)}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : view === 'tickets' ? (
                    tickets.length === 0 ? (
                      <p className="quiet">
                        {filter || ticketFilterCount > 0 ? 'No tickets match.' : 'No tickets.'}
                      </p>
                    ) : (
                      <ul className="rows">
                        {tickets.map((issue) => (
                          <li key={issue.key}>
                            <button
                              className={selected.issue?.key === issue.key ? 'row selected' : 'row'}
                              onClick={() => setSelected({ issue })}
                            >
                              <span className="row-top">
                                <span className="row-num">{issue.key}</span>
                                <span className="row-title">{issue.summary}</span>
                              </span>
                              <span className="row-state">
                                <span className="state">
                                  <span className={`dot ${issue.statusCategory === 'done' ? 'pass' : 'waiting'}`} />
                                  {issue.status}
                                </span>
                                {issue.priority && (
                                  <span className={`priority-tag ${priorityTone(issue.priority)}`}>
                                    {issue.priority}
                                  </span>
                                )}
                                <span className="spacer" />
                                <span className="row-age">{formatAge(issue.updated)}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : (
                    groups.map((group) => {
                      const open = !collapsed.has(group.id);
                      const empty = group.pulls.length === 0;
                      return (
                        <section key={group.id}>
                          <GroupHead
                            label={group.label}
                            count={group.pulls.length}
                            total={group.id === 'merged' ? snapshot.mergedTotal : undefined}
                            open={open}
                            tint={group.tint && !empty}
                            note={group.note}
                            onToggle={() => toggleGroup(group.id)}
                          />
                          {open && empty && (
                            <p className="quiet group-empty">
                              {filter || pullFilterCount > 0 ? 'Nothing matches.' : 'Nothing here.'}
                            </p>
                          )}
                          {open && !empty && (
                            <>
                              <ul className="rows">
                                {group.pulls.map((pull) => (
                                  <PullRow
                                    key={`${pull.repo}#${pull.number}`}
                                    pull={pull}
                                    tint={group.tint}
                                    selected={
                                      selected.pull?.number === pull.number &&
                                      selected.pull?.repo === pull.repo
                                    }
                                    onSelect={() => setSelected({ pull })}
                                  />
                                ))}
                              </ul>
                              {/*
                                The merged list is a window onto a much longer
                                one, and a list that stops without saying so is
                                a list you assume is complete.
                              */}
                              {group.id === 'merged' &&
                                snapshot.merged.length < snapshot.mergedTotal && (
                                <button
                                  type="button"
                                  className="more"
                                  disabled={snapshot.loadingMerged}
                                  onClick={loadMoreMerged}
                                >
                                  {snapshot.loadingMerged
                                    ? 'Loading…'
                                    : `Show ${Math.min(
                                        MERGED_STEP,
                                        snapshot.mergedTotal - snapshot.merged.length
                                      )} more of ${snapshot.mergedTotal}`}
                                </button>
                              )}
                            </>
                          )}
                        </section>
                      );
                    })
                  )}
                </div>
              </aside>
              <Resizer />

              <main className="pane">
                <ErrorBoundary
                  where={paneWhere(selected)}
                  resetKey={paneWhere(selected)}
                >
                {selected.pull ? (
                  <PullPane
                    pull={selected.pull}
                    viewer={snapshot.viewer}
                    sessions={sessions}
                    activeSession={activeSession}
                    snapshot={snapshot}
                    onRun={(kind, pull) => setRunSheet({ kind, pull })}
                    onOpenSession={openSession}
                    onOpenSubject={openSubject}
                  />
                ) : selected.issue ? (
                  <TicketPane
                    issue={selected.issue}
                    sessions={sessions}
                    activeSession={activeSession}
                    snapshot={snapshot}
                    onRun={(kind, issue) => setRunSheet({ kind, issue })}
                    onOpenSession={openSession}
                    onOpenSubject={openSubject}
                  />
                ) : selected.sentry ? (
                  <SentryPane
                    issue={selected.sentry}
                    sessions={sessions}
                    activeSession={activeSession}
                    onRun={(issue, frames) => setRunSheet({ kind: 'implement', sentry: { issue, frames } })}
                    onOpenSession={openSession}
                  />
                ) : (
                  <p className="quiet centred">
                    Pick a row to see it, and to hand it to an agent.
                  </p>
                )}
                </ErrorBoundary>
              </main>
            </>
          )}
        </div>
      )}

      <StatusBar snapshot={snapshot} sessions={sessions} onView={setView} />
      <ActivityToasts onOpen={openEvent} onShowAll={() => setView('activity')} />
      <DictationLayer />

      {connecting && (
        <Settings
          onClose={() => setConnecting(false)}
          connected={snapshot.connected}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}
      {runSheet && (
        <RunSheet
          kind={runSheet.kind} pull={runSheet.pull} issue={runSheet.issue} sentry={runSheet.sentry}
          onClose={() => setRunSheet(undefined)} onStarted={onStarted}
        />
      )}
    </div>
  );
}

/** Picks a watched folder to open a fresh, subject-less terminal in. */
function NewSessionMenu({
  targets, onOpen
}: {
  targets: RunTarget[];
  onOpen: (cwd?: string) => void;
}) {
  const [open, setOpen] = useState(false);

  useMenuDismiss(open, () => setOpen(false));

  return (
    <div className="new-session-host">
      <button
        type="button" className="icon-button" aria-label="New session" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <PlusIcon />
      </button>
      {open && (
        <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <p className="menu-head">Open a terminal in</p>
          {targets.length === 0 ? (
            <p className="menu-empty">No watched folders yet.</p>
          ) : (
            targets.map((t) => (
              <button key={t.path} role="menuitem" onClick={() => { setOpen(false); onOpen(t.path); }}>
                {t.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session, selected, snapshot, onSelect, onOpenSubject, onRename, drag, onMove
}: {
  session: SessionInfo;
  selected: boolean;
  snapshot: Snapshot;
  onSelect: () => void;
  onOpenSubject: (match: Selection) => void;
  onRename: (id: string, title: string) => void;
  drag: DragHandlers;
  /** ⌥↑ / ⌥↓: the keyboard way to reorder, beside dragging. */
  onMove: (delta: -1 | 1) => void;
}) {
  const [editing, setEditing] = useState(false);
  const drop = drag.state?.reorder?.targetId === session.id && drag.state.sessionId !== session.id
    ? (drag.state.reorder.after ? ' drop-after' : ' drop-before')
    : '';
  // The ticket or pull request's own title, in the row's tooltip, so a row
  // still says what the work is when its name is only a key.
  const match = session.subject ? findSubject(session.subject, snapshot) : undefined;
  const about = match?.pull?.title ?? match?.issue?.summary ?? match?.sentry?.title;
  const stateText = session.running
    ? (session.attention ? 'waiting for you' : session.runnerName)
    : `exited ${session.exitCode ?? ''}`;

  // A div, not a button: the name inside it carries a link to the ticket and
  // a rename control of its own, and HTML will not nest those in a button —
  // the parser closes the outer one and the row falls apart. It is also a
  // drag source — grabbing the row and dragging it onto a pane is how a
  // session not currently shown anywhere joins the split view.
  return (
    <li>
      <div
        className={`${selected ? 'row one-line selected' : 'row one-line'}${drop}`}
        data-session-row={session.id}
        role="button"
        tabIndex={0}
        title={about ? `${about}\n${stateText}` : stateText}
        {...(editing ? {} : drag.handlers(session.id, onSelect))}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            onMove(e.key === 'ArrowUp' ? -1 : 1);
            return;
          }
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onSelect();
        }}
      >
        {/* One line per session: the dot carries the state (amber, not green,
            the moment the agent rings the bell and goes quiet on you — see
            `attention` in main/sessions.ts), the ticket or PR title and the
            state in words move to the tooltip. */}
        <span className="row-top">
          <span className={session.running ? (session.attention ? 'dot running' : 'dot live') : 'dot'} />
          <SessionName
            session={session} snapshot={snapshot} onOpenSubject={onOpenSubject}
            editing={editing} onEdit={setEditing} onRename={onRename}
            className="row-title"
          />
          <SessionUsageChip id={session.id} />
          {!editing && <SessionCloseButton session={session} />}
          <span className="row-age">{formatAge(new Date(session.startedAt).toISOString())}</span>
        </span>
      </div>
    </li>
  );
}

/**
 * The row's own close, shown on hover. An exited session just goes. A running
 * one would take its agent (and whatever it had spent) down with it, so it
 * asks first, in a small popover by the button that says what will stop.
 *
 * It used to arm instead: the first click turned the icon amber and only a
 * second click closed. That read as a close button that doesn't work on the
 * first click, which is what it looked like to anyone who didn't notice the
 * colour change.
 */
function SessionCloseButton({ session }: { session: SessionInfo }) {
  const [asking, setAsking] = useState(false);
  const [place, setPlace] = useState<{ top: number; right: number }>();
  const button = useRef<HTMLButtonElement>(null);
  useMenuDismiss(asking, () => setAsking(false));
  // Placed after render, from the button as it is then: fixed to the window,
  // because the sidebar list scrolls and would clip a popover inside it, and
  // measured once the open state has made the button visible.
  useLayoutEffect(() => {
    if (!asking || !button.current) { setPlace(undefined); return; }
    const box = button.current.getBoundingClientRect();
    const below = box.bottom + 130 < window.innerHeight;
    setPlace({ top: below ? box.bottom + 4 : box.top - 124, right: window.innerWidth - box.right });
  }, [asking]);
  const confirm = asking ? place : undefined;

  const shell = session.runnerName === 'Shell';
  const label = !session.running ? 'Close session' : shell ? 'Close terminal' : `Stop ${session.runnerName} and close`;
  return (
    <>
      <button
        type="button"
        ref={button}
        className={asking ? 'icon-button session-close armed' : 'icon-button session-close'}
        aria-label={label} title={label} aria-haspopup={session.running ? 'dialog' : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (!session.running) {
            void window.baton.sessionClose(session.id);
            return;
          }
          setAsking((v) => !v);
        }}
      >
        <CloseIcon size={10} />
      </button>
      {confirm && (
        <div
          className="menu confirm session-close-confirm" role="alertdialog" aria-label={label}
          style={{ position: 'fixed', top: confirm.top, right: confirm.right, left: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          <p>
            {shell
              ? 'Close this terminal? Anything still running in it stops.'
              : <>Stop <strong>{session.runnerName}</strong> and close this session? The agent stops where it is.</>}
          </p>
          <button type="button" className="menu-warn" onClick={() => { setAsking(false); void window.baton.sessionClose(session.id); }}>
            {shell ? 'Close terminal' : 'Stop and close'}
          </button>
          {/* Focus lands on Cancel: Enter straight after the click must not stop an agent. */}
          <button type="button" autoFocus onClick={() => setAsking(false)}>Cancel</button>
        </div>
      )}
    </>
  );
}

type AgentsPaneId = 'agents' | 'usage';

/**
 * Everything about agents as a whole rather than one terminal: what is
 * running anywhere on the Mac, and what it has all cost. Same two-row sidebar
 * shape the Sessions tab used to carry these in, now on its own.
 */
function AgentsView({
  pane, onPane, snapshot, onOpenSubject, onOpenSession
}: {
  pane: AgentsPaneId;
  onPane: (pane: AgentsPaneId) => void;
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
  onOpenSession: (id: string) => void;
}) {
  return (
    <>
      <aside className="queue" aria-label="Agents and usage">
        <div className="queue-head">
          <div className="queue-title-row">
            <h1>Agents</h1>
          </div>
        </div>
        <div className="queue-list">
          <RunningAgentsRow selected={pane === 'agents'} onSelect={() => onPane('agents')} />
          <UsageRow selected={pane === 'usage'} onSelect={() => onPane('usage')} />
        </div>
      </aside>
      <Resizer />
      <main className="pane term-pane">
        {pane === 'usage' ? (
          <UsageOverview snapshot={snapshot} onOpenSubject={onOpenSubject} />
        ) : (
          <RunningAgentsPane snapshot={snapshot} onOpenSubject={onOpenSubject} onOpenSession={onOpenSession} />
        )}
      </main>
    </>
  );
}

/**
 * The Sessions tab's split layout, kept outside the component. It used to be
 * the component's own state, so going to another tab and back threw away a
 * side-by-side layout and every session came back as tabs in one pane. Kept
 * in localStorage too, since the sessions outlive the window: reopened, it
 * finds the same terminals in the same places, as VS Code does.
 */
const PANE_KEY = 'baton.session-panes';
type PaneState = { tree?: PaneTree; focusedLeafId?: string };
let savedPane: PaneState | undefined;

function loadPane(): PaneState {
  if (savedPane) return savedPane;
  try {
    const stored = JSON.parse(localStorage.getItem(PANE_KEY) ?? '{}') as PaneState;
    savedPane = stored && typeof stored === 'object' ? stored : {};
  } catch {
    savedPane = {};
  }
  return savedPane;
}

function savePane(pane: PaneState): void {
  savedPane = pane;
  try {
    localStorage.setItem(PANE_KEY, JSON.stringify(pane));
  } catch { /* the layout still holds for this window */ }
}

const ORDER_KEY = 'baton.session-order';

function loadSessionOrder(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveSessionOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch { /* the order still holds until the window closes */ }
}

function Sessions({
  sessions, sessionsReady, active, onSelect, targets, onOpen, snapshot, onOpenSubject, onRename,
  fontSize
}: {
  sessions: SessionInfo[];
  sessionsReady: boolean;
  active?: string;
  onSelect: (id: string) => void;
  targets: RunTarget[];
  onOpen: (cwd?: string) => void;
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
  onRename: (id: string, title: string) => void;
  fontSize: number;
}) {
  // The tree and which leaf a plain click lands on live in one state object
  // on purpose: StrictMode invokes a `useState` updater function twice to
  // catch exactly the bug this avoids — a setter with a side effect (another
  // setState, or a call out to `onSelect`) hidden inside it, called once but
  // silently applied twice. Keeping the pane and its focus together means
  // every updater below just computes a value and returns it; nothing that
  // touches other state ever runs from inside one.
  const [pane, setPane] = useState<PaneState>(loadPane);
  useEffect(() => savePane(pane), [pane]);
  const [dragState, setDragState] = useState<DragState>();
  // A quick-model job shown in the main pane instead of the terminals. Any
  // session being selected — here or from anywhere else — takes the pane back.
  const jobs = useQuickJobs();
  const [jobsOpen, setJobsOpen] = useState(true);
  const [selectedJob, setSelectedJob] = useState<string>();
  const job = selectedJob ? jobs.find((j) => j.id === selectedJob) : undefined;
  const selectSession = useCallback((id: string) => {
    setSelectedJob(undefined);
    onSelect(id);
  }, [onSelect]);
  useEffect(() => setSelectedJob(undefined), [active]);
  const dragRef = useRef<{ sessionId: string; startX: number; startY: number; dragging: boolean } | null>(null);

  // A session opened or focused from anywhere else in the app (a click here,
  // a run started from a ticket, the dock in Detail.tsx) is reconciled into
  // the tree as a plain focus — never a split. Only a drag creates one.
  useEffect(() => {
    if (!active) return;
    setPane((current) => {
      const { tree, leafId } = focusSession(current.tree, active, current.focusedLeafId);
      return { tree, focusedLeafId: leafId };
    });
  }, [active]);

  // A session that closed — anywhere, including from Detail.tsx's own
  // terminal or a completed run — cannot go on holding a tab, the same
  // "not just left stale" fix as item 26's placeholder.
  useEffect(() => {
    if (!sessionsReady) return;
    const live = new Set(sessions.map((s) => s.id));
    setPane((current) => ({ ...current, tree: pruneTree(current.tree, live) }));
  }, [sessions, sessionsReady]);

  const focusTab = useCallback((leafId: string, sessionId: string) => {
    setPane((current) => (
      current.tree ? { tree: activateTab(current.tree, leafId, sessionId), focusedLeafId: leafId } : current
    ));
    selectSession(sessionId);
  }, [selectSession]);

  const detachTab = useCallback((sessionId: string) => {
    setPane((current) => ({ ...current, tree: current.tree ? detachSession(current.tree, sessionId) : current.tree }));
  }, []);

  const resize = useCallback((splitId: string, index: number, delta: number) => {
    setPane((current) => (
      { ...current, tree: current.tree ? resizeSplit(current.tree, splitId, index, delta) : current.tree }
    ));
  }, []);

  // The sidebar's order, as the user dragged it. New sessions (not in the
  // saved order yet) go on top, newest first, as they always have.
  const [order, setOrder] = useState<string[]>(loadSessionOrder);
  const ordered = useMemo(() => {
    const rank = new Map(order.map((id, i) => [id, i]));
    const fresh = sessions.filter((s) => !rank.has(s.id));
    const known = sessions.filter((s) => rank.has(s.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    return [...fresh, ...known];
  }, [sessions, order]);
  const moveInOrder = useCallback((id: string, targetId: string, after: boolean) => {
    const ids = ordered.map((s) => s.id).filter((x) => x !== id);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(after ? at + 1 : at, 0, id);
    setOrder(ids);
    saveSessionOrder(ids);
  }, [ordered]);

  /**
   * Every draggable thing in the tab (a sidebar row, a tab in a pane) spreads
   * `drag.handlers(sessionId, onClick)` onto itself and gets a real drag for
   * free — pointer capture on that same element, exactly like `Resizer`'s own
   * down/move/up/cancel, so it keeps receiving events no matter what the
   * pointer physically crosses over on the way. A move short of a few pixels
   * never leaves "click" behind; anything past that does, and stays a drag
   * even if the pointer doubles back over its own starting point.
   */
  const drag = useMemo<DragHandlers>(() => ({
    state: dragState,
    handlers: (sessionId: string, onClick: () => void) => ({
      onPointerDown: (event: React.PointerEvent) => {
        if (event.button !== 0) return;
        // A button or field inside the row (open-in-its-tab, rename) keeps its
        // own click. Capturing the pointer here would retarget the click to
        // the row, which then only selects the session — the "open" icon
        // that did nothing.
        if ((event.target as HTMLElement).closest('button, input, a')) return;
        dragRef.current = { sessionId, startX: event.clientX, startY: event.clientY, dragging: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: React.PointerEvent) => {
        const state = dragRef.current;
        if (!state || state.sessionId !== sessionId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        if (!state.dragging && Math.hypot(dx, dy) < 4) return;
        state.dragging = true;

        const el = document.elementFromPoint(event.clientX, event.clientY);
        const leafEl = (el?.closest('[data-pane-leaf]') ?? null) as HTMLElement | null;
        let hover: DragState['hover'];
        if (leafEl) {
          const rect = leafEl.getBoundingClientRect();
          // Which fifth of the pane the pointer sits in: a centred box half
          // the pane's own size is "move here as a tab", and past that,
          // whichever edge the pointer leans hardest toward wins — the same
          // biggest-offset-from-centre rule every split-pane UI uses for this.
          const dxN = (event.clientX - rect.left) / rect.width - 0.5;
          const dyN = (event.clientY - rect.top) / rect.height - 0.5;
          const zone: DropZone = Math.max(Math.abs(dxN), Math.abs(dyN)) < 0.25
            ? 'center'
            : Math.abs(dxN) > Math.abs(dyN)
              ? (dxN < 0 ? 'left' : 'right')
              : (dyN < 0 ? 'top' : 'bottom');
          hover = { leafId: leafEl.dataset['paneLeaf']!, zone };
        }
        // Over another row of the sidebar list: reorder, above or below it
        // by which half of the row the pointer is in.
        const rowEl = (el?.closest('[data-session-row]') ?? null) as HTMLElement | null;
        let reorder: DragState['reorder'];
        if (rowEl && !leafEl) {
          const rect = rowEl.getBoundingClientRect();
          reorder = { targetId: rowEl.dataset['sessionRow']!, after: event.clientY > rect.top + rect.height / 2 };
        }
        setDragState({ sessionId, x: event.clientX, y: event.clientY, hover, reorder });
      },
      onPointerUp: (event: React.PointerEvent) => {
        const state = dragRef.current;
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (!state || state.sessionId !== sessionId) return;
        if (!state.dragging) {
          onClick();
          setDragState(undefined);
          return;
        }
        // Read from the closure, not from `setDragState`'s own updater: this
        // handler is rebuilt by the `useMemo` below every time `dragState`
        // changes, so it already holds whatever the last `onPointerMove` saw
        // — no need for the callback form, which is exactly the shape
        // StrictMode's double-invoke is there to catch a side effect hiding in.
        const hover = dragState?.hover;
        const reorder = dragState?.reorder;
        if (reorder && reorder.targetId !== sessionId) {
          moveInOrder(sessionId, reorder.targetId, reorder.after);
        } else if (hover) {
          setPane((current) => (
            current.tree
              ? { tree: moveSession(current.tree, sessionId, hover.leafId, hover.zone), focusedLeafId: hover.leafId }
              : current
          ));
          selectSession(sessionId);
        }
        setDragState(undefined);
      },
      onPointerCancel: () => {
        dragRef.current = null;
        setDragState(undefined);
      }
    })
  }), [dragState, selectSession, moveInOrder]);

  return (
    <>
      <aside className="queue" aria-label="Sessions">
        <div className="queue-head">
          <div className="queue-title-row">
            <h1>Sessions</h1>
            <NewSessionMenu targets={targets} onOpen={onOpen} />
          </div>
        </div>
        <div className="queue-list">
          {sessions.length === 0 ? (
            <p className="quiet">
              {jobs.length > 0
                ? 'No terminal sessions. Start an agent from a pull request or a ticket, or open a terminal.'
                : 'Nothing running. Start an agent from a pull request or a ticket, or open a terminal.'}
            </p>
          ) : (
            <ul className="rows">
              {ordered.map((s, i) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={s.id === active && !job}
                  snapshot={snapshot}
                  onSelect={() => selectSession(s.id)}
                  onOpenSubject={onOpenSubject}
                  onRename={onRename}
                  drag={drag}
                  onMove={(delta) => {
                    const target = ordered[i + delta];
                    if (target) moveInOrder(s.id, target.id, delta > 0);
                  }}
                />
              ))}
            </ul>
          )}
          {jobs.length > 0 && (
            <>
              <GroupHead
                label="Quick model"
                count={jobs.length}
                open={jobsOpen}
                onToggle={() => setJobsOpen((v) => !v)}
              />
              {jobsOpen && (
                <ul className="rows">
                  {jobs.map((j) => (
                    <QuickJobRow
                      key={j.id}
                      job={j}
                      selected={j.id === selectedJob}
                      onSelect={() => setSelectedJob(j.id)}
                      snapshot={snapshot}
                      onOpenSubject={onOpenSubject}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </aside>
      <Resizer />
      <main className="pane term-pane">
        {job ? (
          <QuickJobView job={job} snapshot={snapshot} onOpenSubject={onOpenSubject} />
        ) : pane.tree ? (
          <PaneView
            tree={pane.tree}
            sessions={sessions}
            snapshot={snapshot}
            fontSize={fontSize}
            onOpenSubject={onOpenSubject}
            onRename={onRename}
            drag={drag}
            onFocusTab={focusTab}
            onDetachTab={detachTab}
            onResize={resize}
          />
        ) : (
          <div className="term-empty">
            <p className="quiet">
              {sessions.length > 0
                ? 'Select another session, or start a new one in any repo in the workspace.'
                : 'Nothing running. Start a new session in any repo in the workspace.'}
            </p>
            <NewSessionMenu targets={targets} onOpen={onOpen} />
          </div>
        )}
      </main>
    </>
  );
}

function Empty({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="empty">
      <h1>Nothing connected yet</h1>
      <p>
        Baton watches your pull requests and tickets, tells you what is blocked on you — even
        when your editor is closed — and hands the blocked thing to a coding agent.
      </p>
      <button className="primary" onClick={onConnect}>Connect a service</button>
    </div>
  );
}
