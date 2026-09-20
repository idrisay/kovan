import { useCallback, useEffect, useMemo, useState } from 'react';
import { describePull, formatAge, pullFlags, type PullSummary } from '@baton/core';
import type { Snapshot } from './types';
import { Connect } from './Connect';

type ViewId = 'blocked' | 'review' | 'mine' | 'tickets';

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'blocked', label: 'Blocked on you' },
  { id: 'review', label: 'Awaiting your review' },
  { id: 'mine', label: 'Your open PRs' },
  { id: 'tickets', label: 'Tickets' }
];

const EMPTY: Snapshot = {
  at: 0,
  viewer: '',
  blocked: [],
  mine: [],
  reviewRequested: [],
  tickets: [],
  connected: [],
  errors: [],
  refreshing: false
};

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [view, setView] = useState<ViewId>('blocked');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    // Never let an older snapshot win. The initial fetch and the push
    // subscription race: on a fast refresh the pushed snapshot can arrive
    // first, and a late-resolving fetch would then roll the view back to
    // stale data. `at` is monotonic, so it decides.
    const accept = (next: Snapshot) =>
      setSnapshot((current) => (next.at >= current.at ? next : current));
    void window.baton.snapshot().then(accept);
    return window.baton.onSnapshot(accept);
  }, []);

  const refresh = useCallback(() => void window.baton.refresh(), []);

  const counts = useMemo(
    () => ({
      blocked: snapshot.blocked.length,
      review: snapshot.reviewRequested.length,
      mine: snapshot.mine.length,
      tickets: snapshot.tickets.length
    }),
    [snapshot]
  );

  const nothingConnected = snapshot.connected.length === 0;

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">Baton</span>
        {snapshot.viewer && <span className="viewer">{snapshot.viewer}</span>}
        <div className="spacer" />
        {snapshot.at > 0 && (
          <span className="stamp">
            {snapshot.refreshing ? 'Refreshing…' : `Updated ${formatAge(new Date(snapshot.at).toISOString())}`}
          </span>
        )}
        <button className="ghost" onClick={() => setConnecting(true)}>
          Connections
        </button>
        <button className="ghost" onClick={refresh} disabled={snapshot.refreshing}>
          Refresh
        </button>
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
          <main className="list">
            {view === 'tickets' ? (
              <Tickets snapshot={snapshot} />
            ) : (
              <Pulls
                pulls={
                  view === 'blocked'
                    ? snapshot.blocked
                    : view === 'review'
                      ? snapshot.reviewRequested
                      : snapshot.mine
                }
                view={view}
              />
            )}
          </main>
        </div>
      )}

      {connecting && <Connect onClose={() => setConnecting(false)} connected={snapshot.connected} />}
    </div>
  );
}

function Empty({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="empty">
      <h1>Nothing connected yet</h1>
      <p>
        Baton watches your pull requests and tickets and tells you what is blocked on you — even
        when your editor is closed.
      </p>
      <button className="primary" onClick={onConnect}>
        Connect a service
      </button>
    </div>
  );
}

function Pulls({ pulls, view }: { pulls: PullSummary[]; view: ViewId }) {
  if (pulls.length === 0) {
    return (
      <p className="quiet">
        {view === 'blocked' ? 'Nothing is blocked on you.' : 'Nothing here.'}
      </p>
    );
  }
  return (
    <ul className="rows">
      {pulls.map((pull) => (
        <li key={`${pull.repo}#${pull.number}`}>
          <button className="row" onClick={() => void window.baton.openExternal(pull.url)}>
            <div className="row-main">
              <span className="row-title">{pull.title}</span>
              <span className="row-meta">
                {pull.repo} #{pull.number} · {pull.author} · {formatAge(pull.updatedAt)}
              </span>
            </div>
            <div className="flags">
              {pullFlags(pull).slice(0, 3).map((flag) => (
                <span key={flag.id} className={`flag flag-${flag.id}`}>
                  {flag.label}
                </span>
              ))}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Tickets({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.tickets.length === 0) {
    return <p className="quiet">No tickets.</p>;
  }
  return (
    <ul className="rows">
      {snapshot.tickets.map((issue) => (
        <li key={issue.key}>
          <button className="row" onClick={() => void window.baton.openExternal(issue.url)}>
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

export { describePull };
