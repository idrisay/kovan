import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatAge, isBlocked } from '@baton/core';
import type { JiraIssue, PullSummary, RunKind, SessionInfo, Snapshot, ThemeChoice } from './types';
import { Settings } from './Settings';
import { PullPane, TicketPane } from './Detail';
import { RunSheet } from './RunSheet';
import { Terminal } from './Terminal';
import { GroupHead, PullRow } from './rows';
import { WorkspaceView } from './Workspace';
import { Resizer } from './Resizer';
import {
  PullRequestIcon, ReviewIcon, TicketIcon, TerminalIcon, WorkspaceIcon,
  RefreshIcon, SettingsIcon, SearchIcon, SortIcon, FilterIcon
} from './icons';

type ViewId = 'pulls' | 'review' | 'tickets' | 'workspace' | 'sessions';

const VIEWS: { id: ViewId; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: 'pulls', label: 'Pull requests', icon: PullRequestIcon },
  { id: 'review', label: 'Awaiting your review', icon: ReviewIcon },
  { id: 'tickets', label: 'Tickets', icon: TicketIcon },
  { id: 'workspace', label: 'Workspace', icon: WorkspaceIcon },
  { id: 'sessions', label: 'Sessions', icon: TerminalIcon }
];

const EMPTY: Snapshot = {
  at: 0, viewer: '', blocked: [], mine: [], reviewRequested: [],
  merged: [], mergedTotal: 0, loadingMerged: false,
  tickets: [], connected: [], errors: [], refreshing: false
};

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

interface Selection { pull?: PullSummary; issue?: JiraIssue }

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

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [view, setView] = useState<ViewId>('pulls');
  const [connecting, setConnecting] = useState(false);
  const [selected, setSelected] = useState<Selection>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string>();
  const [runSheet, setRunSheet] = useState<({ kind: RunKind } & Selection) | undefined>();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(storedCollapsed);
  const [ticketFilters, setTicketFilters] = useState<TicketFilters>(emptyTicketFilters);
  const [theme, setThemeState] = useState<ThemeChoice>('system');

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
    const offSnapshot = window.baton.onSnapshot(accept);
    const offSessions = window.baton.onSessions(setSessions);
    return () => { offSnapshot(); offSessions(); };
  }, [accept]);

  const refresh = useCallback(() => void window.baton.refresh(), []);

  const counts = useMemo(() => ({
    pulls: snapshot.blocked.length,
    review: snapshot.reviewRequested.length,
    tickets: snapshot.tickets.length,
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

  const current = VIEWS.find((v) => v.id === view)!;

  const match = useCallback((p: PullSummary) => {
    const q = filter.trim().toLowerCase();
    return !q ||
      p.title.toLowerCase().includes(q) ||
      p.repo.toLowerCase().includes(q) ||
      String(p.number).includes(q);
  }, [filter]);

  /**
   * One list, grouped by urgency — not one queue per rail item.
   *
   * Splitting "blocked" into its own view meant every row in it was tinted,
   * which is a wall of red and the opposite of what the tint is for: red has
   * to mean *this one* failed. Grouped, only the first section is tinted and
   * the rest state themselves in grey, which is the design's rule.
   *
   * Drafts sit last because a draft is not waiting on anyone.
   */
  const groups = useMemo((): Group[] => {
    if (view === 'review') {
      return [{
        id: 'review',
        label: 'Awaiting your review',
        pulls: snapshot.reviewRequested.filter(match),
        tint: false
      }];
    }
    const blockedIds = new Set(snapshot.blocked.map((p) => `${p.repo}#${p.number}`));
    const rest = snapshot.mine.filter((p) => !blockedIds.has(`${p.repo}#${p.number}`));
    const drafts = rest.filter((p) => p.isDraft).filter(match);
    return [
      { id: 'blocked', label: 'Blocked on you', pulls: snapshot.blocked.filter(match), tint: true },
      { id: 'open', label: 'Open', pulls: rest.filter((p) => !p.isDraft).filter(match), tint: false },
      {
        id: 'drafts',
        label: 'Drafts',
        pulls: drafts,
        tint: false,
        // A draft is not waiting on anyone, so the section is grey — but one
        // that cannot merge is still worth saying out loud from the outside,
        // because folded is exactly where it would otherwise go unnoticed.
        note: countBlocked(drafts) > 0 ? `${countBlocked(drafts)} blocked` : undefined
      },
      { id: 'merged', label: 'Recently merged', pulls: snapshot.merged.filter(match), tint: false }
    ].filter((g) => g.pulls.length > 0);
  }, [view, snapshot, match]);

  const loadMoreMerged = useCallback(() => {
    void window.baton.loadMoreMerged(snapshot.merged.length + MERGED_STEP).then(accept);
  }, [snapshot.merged.length, accept]);

  const ticketFacets = useMemo(() => ticketFacetValues(snapshot.tickets), [snapshot.tickets]);
  const ticketFilterCount = TICKET_FACETS.reduce((n, f) => n + ticketFilters[f.key].size, 0);

  const tickets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return snapshot.tickets.filter((t) => {
      if (q && !t.summary.toLowerCase().includes(q) && !t.key.toLowerCase().includes(q)) {
        return false;
      }
      return TICKET_FACETS.every(({ key }) => {
        const selected = ticketFilters[key];
        return selected.size === 0 || selected.has(t[key] ?? '');
      });
    });
  }, [snapshot.tickets, filter, ticketFilters]);

  const onStarted = (sessionId: string) => {
    setRunSheet(undefined);
    setActiveSession(sessionId);
    setView('sessions');
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
          <span className="stamp">
            {snapshot.refreshing
              ? 'refreshing'
              : formatAge(new Date(snapshot.at).toISOString())}
          </span>
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
                  {v.id === 'sessions' && n > 0 && <span className="rail-pip live" />}
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
            <Sessions sessions={sessions} active={activeSession} onSelect={setActiveSession} />
          ) : view === 'workspace' ? (
            <WorkspaceView onTerminal={openTerminal} />
          ) : (
            <>
              <aside className="queue" aria-label={current.label}>
                <div className="queue-head">
                  <div className="queue-title-row">
                    <h1>{current.label}</h1>
                    {view === 'tickets' && (
                      <TicketFilterMenu
                        values={ticketFacets}
                        active={ticketFilters}
                        onToggle={toggleTicketFilter}
                        onClear={clearTicketFilters}
                      />
                    )}
                    <button type="button" className="icon-button" aria-label="Sort">
                      <SortIcon />
                    </button>
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
                  {view === 'tickets' ? (
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
                                <span className="spacer" />
                                <span className="row-age">{formatAge(issue.updated)}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : groups.length === 0 ? (
                    <p className="quiet">
                      {view === 'review' ? 'Nothing is waiting on your review.' : 'Nothing open.'}
                    </p>
                  ) : (
                    groups.map((group) => {
                      const open = !collapsed.has(group.id);
                      return (
                        <section key={group.id}>
                          <GroupHead
                            label={group.label}
                            count={group.pulls.length}
                            total={group.id === 'merged' ? snapshot.mergedTotal : undefined}
                            open={open}
                            tint={group.tint}
                            note={group.note}
                            onToggle={() => toggleGroup(group.id)}
                          />
                          {open && (
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
                    onRun={(kind, pull) => setRunSheet({ kind, pull })}
                  />
                ) : selected.issue ? (
                  <TicketPane
                    issue={selected.issue}
                    onRun={(kind, issue) => setRunSheet({ kind, issue })}
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
          kind={runSheet.kind} pull={runSheet.pull} issue={runSheet.issue}
          onClose={() => setRunSheet(undefined)} onStarted={onStarted}
        />
      )}
    </div>
  );
}

function Sessions({
  sessions, active, onSelect
}: {
  sessions: SessionInfo[];
  active?: string;
  onSelect: (id: string) => void;
}) {
  const current = active ?? sessions[0]?.id;
  return (
    <>
      <aside className="queue" aria-label="Sessions">
        <div className="queue-head">
          <div className="queue-title-row"><h1>Sessions</h1></div>
        </div>
        <div className="queue-list">
          {sessions.length === 0 ? (
            <p className="quiet">
              Nothing running. Start an agent from a pull request or a ticket, or open a terminal.
            </p>
          ) : (
            <ul className="rows">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    className={s.id === current ? 'row selected' : 'row'}
                    onClick={() => onSelect(s.id)}
                  >
                    <span className="row-top">
                      <span className="row-title">{s.title}</span>
                    </span>
                    <span className="row-state">
                      <span className="state">
                        <span className={s.running ? 'dot live' : 'dot'} />
                        {s.running ? s.runnerName : `exited ${s.exitCode ?? ''}`}
                      </span>
                      <span className="spacer" />
                      <span className="row-age">{formatAge(new Date(s.startedAt).toISOString())}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      <Resizer />
      <main className="pane term-pane">
        {current ? (
          <>
            <div className="term-head">
              <span>{sessions.find((s) => s.id === current)?.cwd}</span>
              <button className="ghost" onClick={() => void window.baton.sessionClose(current)}>
                Close
              </button>
            </div>
            <Terminal sessionId={current} />
          </>
        ) : (
          <p className="quiet centred">Nothing running.</p>
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
