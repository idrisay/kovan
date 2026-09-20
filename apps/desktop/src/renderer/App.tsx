import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatAge, pullFlags } from '@baton/core';
import type { JiraIssue, PullSummary, RunKind, SessionInfo, Snapshot } from './types';
import { Connect } from './Connect';
import { PullPane, TicketPane } from './Detail';
import { RunSheet } from './RunSheet';
import { Terminal } from './Terminal';

type ViewId = 'blocked' | 'review' | 'mine' | 'tickets' | 'sessions';

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'blocked', label: 'Blocked on you' },
  { id: 'review', label: 'Awaiting your review' },
  { id: 'mine', label: 'Your open PRs' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'sessions', label: 'Sessions' }
];

const EMPTY: Snapshot = {
  at: 0, viewer: '', blocked: [], mine: [], reviewRequested: [],
  tickets: [], connected: [], errors: [], refreshing: false
};

interface Selection {
  pull?: PullSummary;
  issue?: JiraIssue;
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [view, setView] = useState<ViewId>('blocked');
  const [connecting, setConnecting] = useState(false);
  const [selected, setSelected] = useState<Selection>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string>();
  const [runSheet, setRunSheet] = useState<{ kind: RunKind } & Selection>();

  useEffect(() => {
    // Never let an older snapshot win. The initial fetch and the push
    // subscription race: on a fast refresh the pushed snapshot can arrive
    // first, and a late-resolving fetch would roll the view back to stale data.
    const accept = (next: Snapshot) =>
      setSnapshot((current) => (next.at >= current.at ? next : current));
    void window.baton.snapshot().then(accept);
    void window.baton.sessions().then(setSessions);
    const offSnapshot = window.baton.onSnapshot(accept);
    const offSessions = window.baton.onSessions(setSessions);
    return () => {
      offSnapshot();
      offSessions();
    };
  }, []);

  const refresh = useCallback(() => void window.baton.refresh(), []);

  const counts = useMemo(
    () => ({
      blocked: snapshot.blocked.length,
      review: snapshot.reviewRequested.length,
      mine: snapshot.mine.length,
      tickets: snapshot.tickets.length,
      sessions: sessions.filter((s) => s.running).length
    }),
    [snapshot, sessions]
  );

  const openRun = (kind: RunKind, subject: Selection) => setRunSheet({ kind, ...subject });

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
        <div className="spacer" />
        {snapshot.at > 0 && (
          <span className="stamp">
            {snapshot.refreshing
              ? 'Refreshing…'
              : `Updated ${formatAge(new Date(snapshot.at).toISOString())}`}
          </span>
        )}
        <button className="ghost" onClick={() => void window.baton.openTerminal().then((s) => {
          setActiveSession(s.id);
          setView('sessions');
        })}>
          Terminal
        </button>
        <button className="ghost" onClick={() => setConnecting(true)}>Connections</button>
        <button className="ghost" onClick={refresh} disabled={snapshot.refreshing}>Refresh</button>
      </header>

      {snapshot.errors.length > 0 && (
        <div className="errors">
          {snapshot.errors.map((e) => (
            <div key={e.provider} className="error">
              <strong>{e.provider}</strong> {e.message}
            </div>
          ))}
        </div>
      )}

      {nothingConnected && !connecting ? (
        <Empty onConnect={() => setConnecting(true)} />
      ) : (
        <div className="body">
          <nav className="rail">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                className={v.id === view ? 'rail-item active' : 'rail-item'}
                onClick={() => setView(v.id)}
              >
                <span>{v.label}</span>
                <span className={v.id === 'blocked' && counts.blocked > 0 ? 'count alert' : 'count'}>
                  {counts[v.id]}
                </span>
              </button>
            ))}
          </nav>

          {view === 'sessions' ? (
            <SessionsView
              sessions={sessions}
              active={activeSession}
              onSelect={setActiveSession}
            />
          ) : (
            <>
              <main className="list">
                {view === 'tickets' ? (
                  <Tickets
                    tickets={snapshot.tickets}
                    selected={selected.issue}
                    onSelect={(issue) => setSelected({ issue })}
                  />
                ) : (
                  <Pulls
                    pulls={
                      view === 'blocked' ? snapshot.blocked
                        : view === 'review' ? snapshot.reviewRequested
                          : snapshot.mine
                    }
                    view={view}
                    selected={selected.pull}
                    onSelect={(pull) => setSelected({ pull })}
                  />
                )}
              </main>
              <aside className="pane">
                {selected.pull ? (
                  <PullPane
                    pull={selected.pull}
                    viewer={snapshot.viewer}
                    onRun={(kind, pull) => openRun(kind, { pull })}
                  />
                ) : selected.issue ? (
                  <TicketPane issue={selected.issue} onRun={(kind, issue) => openRun(kind, { issue })} />
                ) : (
                  <p className="quiet centred">Pick a row to see it, and to hand it to an agent.</p>
                )}
              </aside>
            </>
          )}
        </div>
      )}

      {connecting && <Connect onClose={() => setConnecting(false)} connected={snapshot.connected} />}
      {runSheet && (
        <RunSheet
          kind={runSheet.kind}
          pull={runSheet.pull}
          issue={runSheet.issue}
          onClose={() => setRunSheet(undefined)}
          onStarted={onStarted}
        />
      )}
    </div>
  );
}

function SessionsView({
  sessions,
  active,
  onSelect
}: {
  sessions: SessionInfo[];
  active?: string;
  onSelect: (id: string) => void;
}) {
  const current = active ?? sessions[0]?.id;
  return (
    <>
      <main className="list narrow">
        {sessions.length === 0 ? (
          <p className="quiet">
            No sessions. Start one from a pull request or a ticket, or open a plain terminal.
          </p>
        ) : (
          <ul className="rows">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  className={session.id === current ? 'row selected' : 'row'}
                  onClick={() => onSelect(session.id)}
                >
                  <div className="row-main">
                    <span className="row-title">{session.title}</span>
                    <span className="row-meta">
                      {session.runnerName} · {session.cwd.split('/').pop()} ·{' '}
                      {session.running ? 'running' : `exited ${session.exitCode ?? ''}`}
                    </span>
                  </div>
                  <span className={session.running ? 'dot live' : 'dot'} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
      <aside className="pane term-pane">
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
      </aside>
    </>
  );
}

function Empty({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="empty">
      <h1>Nothing connected yet</h1>
      <p>
        Baton watches your pull requests and tickets, tells you what is blocked on you — even when
        your editor is closed — and hands the blocked thing to a coding agent.
      </p>
      <button className="primary" onClick={onConnect}>Connect a service</button>
    </div>
  );
}

function Pulls({
  pulls, view, selected, onSelect
}: {
  pulls: PullSummary[];
  view: ViewId;
  selected?: PullSummary;
  onSelect: (pull: PullSummary) => void;
}) {
  if (pulls.length === 0) {
    return <p className="quiet">{view === 'blocked' ? 'Nothing is blocked on you.' : 'Nothing here.'}</p>;
  }
  return (
    <ul className="rows">
      {pulls.map((pull) => {
        const id = `${pull.repo}#${pull.number}`;
        const isSelected = selected && `${selected.repo}#${selected.number}` === id;
        return (
          <li key={id}>
            <button className={isSelected ? 'row selected' : 'row'} onClick={() => onSelect(pull)}>
              <div className="row-main">
                <span className="row-title">{pull.title}</span>
                <span className="row-meta">
                  {pull.repo} #{pull.number} · {pull.author} · {formatAge(pull.updatedAt)}
                </span>
              </div>
              <div className="flags">
                {pullFlags(pull).slice(0, 2).map((flag) => (
                  <span key={flag.id} className={`flag flag-${flag.id}`}>{flag.label}</span>
                ))}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Tickets({
  tickets, selected, onSelect
}: {
  tickets: JiraIssue[];
  selected?: JiraIssue;
  onSelect: (issue: JiraIssue) => void;
}) {
  if (tickets.length === 0) {
    return <p className="quiet">No tickets.</p>;
  }
  return (
    <ul className="rows">
      {tickets.map((issue) => (
        <li key={issue.key}>
          <button
            className={selected?.key === issue.key ? 'row selected' : 'row'}
            onClick={() => onSelect(issue)}
          >
            <div className="row-main">
              <span className="row-title">
                <span className="key">{issue.key}</span> {issue.summary}
              </span>
              <span className="row-meta">
                {issue.status} · {issue.issueType}
                {issue.priority ? ` · ${issue.priority}` : ''} · {formatAge(issue.updated)}
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
