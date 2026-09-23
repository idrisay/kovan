import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PULL_SORT, formatAge, isBlocked, PULL_SORTS, sortPulls, type PullSort } from '@baton/core';
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
import {
  activateTab, detachSession, focusSession, moveSession, pruneTree, resizeSplit,
  type DropZone, type PaneTree
} from './paneTree';
import { PaneView, type DragHandlers, type DragState } from './PaneView';
import {
  PullRequestIcon, TicketIcon, TerminalIcon, WorkspaceIcon, SentryIcon,
  RefreshIcon, SettingsIcon, SearchIcon, SortIcon, FilterIcon, PlusIcon
} from './icons';

type ViewId = 'pulls' | 'tickets' | 'sentry' | 'workspace' | 'sessions';

const VIEWS: { id: ViewId; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: 'pulls', label: 'Pull requests', icon: PullRequestIcon },
  { id: 'tickets', label: 'Tickets', icon: TicketIcon },
  { id: 'sentry', label: 'Sentry errors', icon: SentryIcon },
  { id: 'workspace', label: 'Workspace', icon: WorkspaceIcon },
  { id: 'sessions', label: 'Sessions', icon: TerminalIcon }
];

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
  values, active, onToggle, onClear
}: {
  values: Record<TicketFacetKey, string[]>;
  active: TicketFilters;
  onToggle: (facet: TicketFacetKey, value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = TICKET_FACETS.reduce((n, f) => n + active[f.key].size, 0);

  // Any click outside closes the menu, same as the workspace overflow menu.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

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

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

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

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

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

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

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

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const rows = REFRESHABLE.filter((p) => snapshot.connected.includes(p.id));

  return (
    <div className="menu-host">
      <button
        type="button"
        className="stamp"
        aria-label="Refresh"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        {snapshot.refreshing ? 'refreshing' : formatAge(new Date(snapshot.at).toISOString())}
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
                  {busy ? 'refreshing' : at ? formatAge(new Date(at).toISOString()) : 'never'}
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
  const [connecting, setConnecting] = useState(false);
  const [selected, setSelected] = useState<Selection>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
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
  const [openAgents, setOpenAgents] = useState(false);
  const agentsOpened = useCallback(() => setOpenAgents(false), []);
  useEffect(() => window.baton.onShowAgents(() => {
    setView('sessions');
    setOpenAgents(true);
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
    void window.baton.sessions().then(setSessions);
    void window.baton.runTargets().then(setTargets);
    const offSnapshot = window.baton.onSnapshot(accept);
    const offSessions = window.baton.onSessions(setSessions);
    return () => { offSnapshot(); offSessions(); };
  }, [accept]);

  const refresh = useCallback(() => void window.baton.refresh(), []);

  const counts = useMemo(() => ({
    pulls: snapshot.blocked.length + snapshot.reviewRequested.length,
    tickets: snapshot.tickets.length,
    sentry: snapshot.sentryIssues.length,
    workspace: 0,
    sessions: sessions.filter((s) => s.running).length
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
        <div className="body">
          <nav className="rail" aria-label="Sections">
            {VIEWS.map((v) => {
              const Icon = v.icon;
              const n = counts[v.id];
              return (
                <button
                  key={v.id}
                  type="button"
                  aria-label={v.label}
                  aria-current={v.id === view ? 'page' : undefined}
                  className={v.id === view ? 'rail-item active' : 'rail-item'}
                  onClick={() => setView(v.id)}
                >
                  <Icon />
                  {v.id === 'pulls' && n > 0 && <span className="rail-pip" />}
                  {v.id === 'sessions' && idleCount > 0 ? (
                    <span className="rail-pip idle" title={`${idleCount} idle agent${idleCount === 1 ? '' : 's'}`} />
                  ) : v.id === 'sessions' && n > 0 && <span className="rail-pip live" />}
                </button>
              );
            })}
            <span className="rail-spacer" />
            <button
              type="button" aria-label="Open a terminal" className="rail-item"
              onClick={() => openTerminal()}
            >
              <TerminalIcon size={18} />
            </button>
            <button
              type="button" aria-label="Refresh" className="rail-item"
              disabled={snapshot.refreshing} onClick={refresh}
            >
              <RefreshIcon />
            </button>
            <button
              type="button" aria-label="Settings" className="rail-item"
              onClick={() => setConnecting(true)}
            >
              <SettingsIcon />
            </button>
          </nav>

          {view === 'sessions' ? (
            <Sessions
              sessions={sessions} active={activeSession} onSelect={setActiveSession}
              targets={targets} onOpen={openTerminal}
              snapshot={snapshot} onOpenSubject={openSubject} onRename={renameSession}
              fontSize={fontSize}
              openAgents={openAgents} onAgentsOpened={agentsOpened}
            />
          ) : view === 'workspace' ? (
            <WorkspaceView onTerminal={openTerminal} />
          ) : (
            <>
              <aside className="queue" aria-label={current.label}>
                <div className="queue-head">
                  <div className="queue-title-row">
                    <h1>{current.label}</h1>
                    {view === 'tickets' ? (
                      <>
                        <TicketFilterMenu
                          values={ticketFacets}
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
                  {view === 'sentry' ? (
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
              </main>
            </>
          )}
        </div>
      )}

      <StatusBar snapshot={snapshot} sessions={sessions} onView={setView} />

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

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

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
  session, selected, snapshot, onSelect, onOpenSubject, onRename, drag
}: {
  session: SessionInfo;
  selected: boolean;
  snapshot: Snapshot;
  onSelect: () => void;
  onOpenSubject: (match: Selection) => void;
  onRename: (id: string, title: string) => void;
  drag: DragHandlers;
}) {
  const [editing, setEditing] = useState(false);
  // The ticket or pull request's own title under the session's name, so a
  // row says what the work is, not just its key.
  const match = session.subject ? findSubject(session.subject, snapshot) : undefined;
  const about = match?.pull?.title ?? match?.issue?.summary ?? match?.sentry?.title;

  // A div, not a button: the name inside it carries a link to the ticket and
  // a rename control of its own, and HTML will not nest those in a button —
  // the parser closes the outer one and the row falls apart. It is also a
  // drag source — grabbing the row and dragging it onto a pane is how a
  // session not currently shown anywhere joins the split view.
  return (
    <li>
      <div
        className={selected ? 'row selected' : 'row'}
        role="button"
        tabIndex={0}
        {...(editing ? {} : drag.handlers(session.id, onSelect))}
        onKeyDown={(e) => {
          if (editing || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onSelect();
        }}
      >
        <span className="row-top">
          <SessionName
            session={session} snapshot={snapshot} onOpenSubject={onOpenSubject}
            editing={editing} onEdit={setEditing} onRename={onRename}
            className="row-title"
          />
        </span>
        {about && <span className="row-about" title={about}>{about}</span>}
        <span className="row-state">
          <span className="state">
            {/* Amber, not green, the moment the agent rings the bell and goes
                quiet on you — see `attention` in main/sessions.ts. */}
            <span className={session.running ? (session.attention ? 'dot running' : 'dot live') : 'dot'} />
            {session.running
              ? (session.attention ? 'waiting for you' : session.runnerName)
              : `exited ${session.exitCode ?? ''}`}
          </span>
          <span className="spacer" />
          <SessionUsageChip id={session.id} />
          <span className="row-age">{formatAge(new Date(session.startedAt).toISOString())}</span>
        </span>
      </div>
    </li>
  );
}

/** `selectedJob`'s value when the Usage overview, not a job, has the pane. */
const USAGE_PANE = 'usage';
/** …and when the Running agents pane has it. */
const AGENTS_PANE = 'agents';

function Sessions({
  sessions, active, onSelect, targets, onOpen, snapshot, onOpenSubject, onRename,
  fontSize, openAgents, onAgentsOpened
}: {
  sessions: SessionInfo[];
  active?: string;
  onSelect: (id: string) => void;
  targets: RunTarget[];
  onOpen: (cwd?: string) => void;
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
  onRename: (id: string, title: string) => void;
  fontSize: number;
  /** The idle reminder was clicked: show Running agents. */
  openAgents: boolean;
  onAgentsOpened: () => void;
}) {
  // The tree and which leaf a plain click lands on live in one state object
  // on purpose: StrictMode invokes a `useState` updater function twice to
  // catch exactly the bug this avoids — a setter with a side effect (another
  // setState, or a call out to `onSelect`) hidden inside it, called once but
  // silently applied twice. Keeping the pane and its focus together means
  // every updater below just computes a value and returns it; nothing that
  // touches other state ever runs from inside one.
  const [pane, setPane] = useState<{ tree?: PaneTree; focusedLeafId?: string }>({});
  const [dragState, setDragState] = useState<DragState>();
  // A quick-model job shown in the main pane instead of the terminals. Any
  // session being selected — here or from anywhere else — takes the pane back.
  const jobs = useQuickJobs();
  const [jobsOpen, setJobsOpen] = useState(true);
  const [selectedJob, setSelectedJob] = useState<string>();
  // The Usage overview takes the main pane the same way a job does.
  const showUsage = selectedJob === USAGE_PANE;
  const showAgents = selectedJob === AGENTS_PANE;
  const job = selectedJob && !showUsage && !showAgents ? jobs.find((j) => j.id === selectedJob) : undefined;
  const selectSession = useCallback((id: string) => {
    setSelectedJob(undefined);
    onSelect(id);
  }, [onSelect]);
  useEffect(() => setSelectedJob(undefined), [active]);
  useEffect(() => {
    if (!openAgents) return;
    setSelectedJob(AGENTS_PANE);
    onAgentsOpened();
  }, [openAgents, onAgentsOpened]);
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
    const live = new Set(sessions.map((s) => s.id));
    setPane((current) => ({ ...current, tree: pruneTree(current.tree, live) }));
  }, [sessions]);

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
        setDragState({ sessionId, x: event.clientX, y: event.clientY, hover });
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
        if (hover) {
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
  }), [dragState, selectSession]);

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
          <UsageRow selected={showUsage} onSelect={() => setSelectedJob(USAGE_PANE)} />
          <RunningAgentsRow selected={showAgents} onSelect={() => setSelectedJob(AGENTS_PANE)} />
          {sessions.length === 0 ? (
            <p className="quiet">
              {jobs.length > 0
                ? 'No terminal sessions. Start an agent from a pull request or a ticket, or open a terminal.'
                : 'Nothing running. Start an agent from a pull request or a ticket, or open a terminal.'}
            </p>
          ) : (
            <ul className="rows">
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={s.id === active && !job && !showUsage && !showAgents}
                  snapshot={snapshot}
                  onSelect={() => selectSession(s.id)}
                  onOpenSubject={onOpenSubject}
                  onRename={onRename}
                  drag={drag}
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
        {showUsage ? (
          <UsageOverview snapshot={snapshot} onOpenSubject={onOpenSubject} />
        ) : showAgents ? (
          <RunningAgentsPane snapshot={snapshot} onOpenSubject={onOpenSubject} onOpenSession={selectSession} />
        ) : job ? (
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
