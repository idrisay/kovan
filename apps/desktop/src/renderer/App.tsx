import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatAge } from '@baton/core';
import type { JiraIssue, PullSummary, RunKind, SessionInfo, Snapshot } from './types';
import { Connect } from './Connect';
import { PullPane, TicketPane } from './Detail';
import { RunSheet } from './RunSheet';
import { Terminal } from './Terminal';
import { GroupHead, PullRow } from './rows';
import { WorkspaceView } from './Workspace';
import { Resizer } from './Resizer';
import {
  PullRequestIcon, ReviewIcon, TicketIcon, TerminalIcon, WorkspaceIcon,
  RefreshIcon, SettingsIcon, SearchIcon, SortIcon
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
  tickets: [], connected: [], errors: [], refreshing: false
};

interface Selection { pull?: PullSummary; issue?: JiraIssue }

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [view, setView] = useState<ViewId>('pulls');
  const [connecting, setConnecting] = useState(false);
  const [selected, setSelected] = useState<Selection>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string>();
  const [runSheet, setRunSheet] = useState<({ kind: RunKind } & Selection) | undefined>();
  const [filter, setFilter] = useState('');

  useEffect(() => {
    // Never let an older snapshot win: the initial fetch and the push
    // subscription race, and a late-resolving fetch would roll the view back.
    const accept = (next: Snapshot) =>
      setSnapshot((current) => (next.at >= current.at ? next : current));
    void window.baton.snapshot().then(accept);
    void window.baton.sessions().then(setSessions);
    const offSnapshot = window.baton.onSnapshot(accept);
    const offSessions = window.baton.onSessions(setSessions);
    return () => { offSnapshot(); offSessions(); };
  }, []);

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
  const groups = useMemo(() => {
    if (view === 'review') {
      return [{
        label: 'Awaiting your review',
        pulls: snapshot.reviewRequested.filter(match),
        tint: false
      }];
    }
    const blockedIds = new Set(snapshot.blocked.map((p) => `${p.repo}#${p.number}`));
    const rest = snapshot.mine.filter((p) => !blockedIds.has(`${p.repo}#${p.number}`));
    return [
      { label: 'Blocked on you', pulls: snapshot.blocked.filter(match), tint: true },
      { label: 'Open', pulls: rest.filter((p) => !p.isDraft).filter(match), tint: false },
      { label: 'Drafts', pulls: rest.filter((p) => p.isDraft).filter(match), tint: false }
    ].filter((g) => g.pulls.length > 0);
  }, [view, snapshot, match]);

  const tickets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q
      ? snapshot.tickets.filter((t) =>
          t.summary.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
      : snapshot.tickets;
  }, [snapshot.tickets, filter]);

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
              type="button" aria-label="Connections" className="rail-item"
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
                    tickets.length === 0 ? <p className="quiet">No tickets.</p> : (
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
                    groups.map((group) => (
                      <section key={group.label}>
                        <GroupHead label={group.label} count={group.pulls.length} />
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
                      </section>
                    ))
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

      {connecting && <Connect onClose={() => setConnecting(false)} connected={snapshot.connected} />}
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
