import { useEffect, useState } from 'react';
import { formatAge, isMerged } from '@baton/core';
import { States } from './rows';
import { Prose } from './Prose';
import { RunViewer } from './RunViewer';
import type {
  AgentRun, JiraIssue, PullDetail, PullSummary, ReviewComment, Reviewer, RunKind, SessionInfo
} from './types';

/** What a reviewer's last action reads as, and who it puts the ball with. */
const TURN: Record<Reviewer['turn'], { status: string; label: string; tone: 'waiting' | 'fail' | 'pass' }> = {
  pending: { status: 'Asked · no answer yet', label: 'Their turn', tone: 'waiting' },
  changes_requested: { status: 'Asked for changes', label: 'Your turn', tone: 'fail' },
  approved: { status: 'Approved', label: 'Approved', tone: 'pass' }
};

/** How a written review reads inline in the conversation, alongside plain comments. */
const REVIEW_STATE: Record<NonNullable<ReviewComment['reviewState']>, { label: string; tone: 'waiting' | 'fail' | 'pass' }> = {
  approved: { label: 'Approved', tone: 'pass' },
  changes_requested: { label: 'Requested changes', tone: 'fail' },
  commented: { label: 'Reviewed', tone: 'waiting' }
};

function Reviewers({ reviewers }: { reviewers: Reviewer[] }) {
  if (reviewers.length === 0) {
    return null;
  }
  return (
    <section>
      <h3>Reviewers</h3>
      <ul className="reviewers">
        {reviewers.map((reviewer) => {
          const turn = TURN[reviewer.turn];
          const age = reviewer.submittedAt ? formatAge(reviewer.submittedAt) : undefined;
          return (
            <li key={reviewer.login}>
              <span className="reviewer-avatar">{reviewer.login.slice(0, 2).toUpperCase()}</span>
              <span className="reviewer-who">
                <span className="reviewer-name">{reviewer.login}</span>
                <span className="reviewer-status">{turn.status}{age ? ` · ${age} ago` : ''}</span>
              </span>
              <span className="state reviewer-turn">
                <span className={`dot ${turn.tone}`} />
                {turn.label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RunButtons({
  kinds,
  onRun
}: {
  kinds: RunKind[];
  onRun: (kind: RunKind) => void;
}) {
  const LABEL: Record<RunKind, string> = {
    implement: 'Work on this in an agent',
    review: 'Review in an agent',
    unblock: 'Unblock in an agent',
    verify: 'Check it shipped'
  };
  return (
    <div className="run-buttons">
      {kinds.map((kind) => (
        <button key={kind} className="primary" onClick={() => onRun(kind)}>
          {LABEL[kind]}
        </button>
      ))}
    </div>
  );
}

/**
 * Every terminal session started from this ticket or pull request — running
 * or already exited, as long as it is still open — so the one place work
 * gets started is also the one place it can be picked back up, instead of
 * making you go hunt for it in Sessions.
 */
function LiveSessions({
  subject, sessions, onOpen
}: {
  subject: string;
  sessions: SessionInfo[];
  onOpen: (id: string) => void;
}) {
  const mine = sessions.filter((s) => s.subject === subject);
  if (mine.length === 0) {
    return null;
  }
  return (
    <section>
      <h3>Sessions</h3>
      <ul className="runs">
        {mine.map((s) => (
          <li key={s.id}>
            <span className="run-kind">{s.kind ?? 'terminal'}</span>
            <span className="state">
              <span className={s.running ? 'dot live' : 'dot'} />
              {s.running ? 'running' : `exited ${s.exitCode ?? ''}`}
            </span>
            <span className="run-when">{formatAge(new Date(s.startedAt).toISOString())}</span>
            <button className="link" onClick={() => onOpen(s.id)}>
              open
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function History({ subject }: { subject: string }) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [viewing, setViewing] = useState<AgentRun>();

  useEffect(() => {
    void window.baton.runHistory(subject).then(setRuns);
  }, [subject]);

  if (runs.length === 0) {
    return null;
  }
  return (
    <>
      <section>
        <h3>History</h3>
        <ul className="runs">
          {runs.map((run) => {
            const hasFiles = Boolean(run.reportPath || run.promptPath) || run.shots.length > 0;
            return (
              <li key={run.id}>
                <span className="run-kind">{run.kind}</span>
                <span className="run-when">{new Date(run.startedAt).toLocaleString()}</span>
                {run.confidence !== undefined && <span className="score">{run.confidence}/100</span>}
                {run.verdict !== 'unknown' && <span className="verdict">{run.verdict}</span>}
                {hasFiles && (
                  <button className="link" onClick={() => setViewing(run)}>
                    view
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {viewing && <RunViewer run={viewing} onClose={() => setViewing(undefined)} />}
    </>
  );
}

export function PullPane({
  pull,
  viewer,
  sessions,
  onRun,
  onOpenSession
}: {
  pull: PullSummary;
  viewer: string;
  sessions: SessionInfo[];
  onRun: (kind: RunKind, pull: PullSummary) => void;
  onOpenSession: (id: string) => void;
}) {
  const [detail, setDetail] = useState<PullDetail>();
  const [error, setError] = useState('');

  useEffect(() => {
    setDetail(undefined);
    setError('');
    window.baton
      .pullDetail(pull.repo, pull.number)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [pull.repo, pull.number]);

  // Yours or theirs decides what you can do with it: you unblock your own and
  // review other people's. Merged work can only be one thing — there is
  // nothing left to unblock, and offering it next to "Check it shipped" would
  // make the one useful button the second-guessed one.
  const mine = pull.author.toLowerCase() === viewer.toLowerCase();
  const kinds: RunKind[] = isMerged(pull) ? ['verify'] : mine ? ['unblock', 'verify'] : ['review'];
  // The same string `Agents.subjectFor()` computes in main, so a session or a
  // past run started from this pull is found under the ticket it carried,
  // not filed separately under the pull request that happened to open it.
  const subject = pull.title.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? `${pull.repo}#${pull.number}`;

  const unresolved = detail?.threads.filter((t) => !t.isResolved) ?? [];
  // Whether the left column has anything in it. A PR with no description and
  // no open threads should not leave a blank half: the rail spans instead.
  // Decided here rather than with :empty, which would rest on React never
  // emitting a stray whitespace node between the conditionals.
  const hasReading = Boolean(
    error || !detail || detail.body || unresolved.length > 0 || detail.comments.length > 0
  );

  return (
    <div className="detail">
      <header className="detail-head">
        <h2>{pull.title}</h2>
        <div className="detail-meta">
          <span>{pull.repo}</span>
          <span>#{pull.number}</span>
          <span>{pull.author}</span>
          <span>{isMerged(pull) ? `merged ${formatAge(pull.mergedAt!)}` : formatAge(pull.updatedAt)}</span>
          {detail && <span>{detail.baseRef} ← {detail.headRef}</span>}
        </div>
        <div className="detail-states">
          <States pull={pull} max={6} />
        </div>
        {/* One row of actions, the agent runs first: they are the reason this
            app exists, and 'Open on GitHub' is the escape hatch. */}
        <div className="detail-actions">
          <RunButtons kinds={kinds} onRun={(kind) => onRun(kind, pull)} />
          <button className="ghost" onClick={() => void window.baton.openExternal(pull.url)}>
            Open on GitHub
          </button>
        </div>
      </header>

      {/*
        Two columns once the pane is wide enough: what you read on the left at
        a measure, what you glance at on the right. The split is by kind, not
        by length — prose and review conversation are read, checks and file
        lists are scanned — so neither column is padding for the other.
      */}
      <div className={hasReading ? 'detail-body' : 'detail-body solo'}>
        <div className="detail-main">
          {error && <div className="error boxed">{error}</div>}
          {!detail && !error && <p className="quiet">Loading…</p>}

          {detail?.body && (
            <section>
              <h3>Description</h3>
              <Prose text={detail.body} />
            </section>
          )}

          {unresolved.length > 0 && (
            <section>
              <h3>{unresolved.length} unresolved</h3>
              {unresolved.map((thread) => (
                <div key={thread.id} className="thread">
                  {thread.path && (
                    <div className="thread-file">
                      {thread.path}
                      {thread.line ? `:${thread.line}` : ''}
                    </div>
                  )}
                  {thread.comments.map((c, i) => (
                    <div key={i} className="comment">
                      <div className="comment-head">
                        <strong>{c.author}</strong>
                        <span className="when">{formatAge(c.createdAt)}</span>
                      </div>
                      <Prose text={c.body} />
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}

          {detail && detail.comments.length > 0 && (
            <section>
              <h3>Conversation</h3>
              {detail.comments.map((c, i) => {
                const review = c.reviewState ? REVIEW_STATE[c.reviewState] : undefined;
                return (
                  <div key={i} className="comment">
                    <div className="comment-head">
                      <strong>{c.author}</strong>
                      {review && (
                        <span className="state">
                          <span className={`dot ${review.tone}`} />
                          {review.label}
                        </span>
                      )}
                      <span className="when">{formatAge(c.createdAt)}</span>
                    </div>
                    <Prose text={c.body} />
                  </div>
                );
              })}
            </section>
          )}
        </div>

        <aside className="detail-side">
          {detail && <Reviewers reviewers={detail.reviewers} />}

          {detail && detail.checks.length > 0 && (
            <section>
              <h3>Checks</h3>
              <ul className="checks">
                {detail.checks.map((check) => (
                  <li key={check.name}>
                    <span className={`dot ${
                      check.status === 'success' ? 'pass'
                        : check.status === 'failure' ? 'fail'
                          : check.status === 'pending' ? 'running' : ''
                    }`} />
                    <span className="file-path">{check.name}</span>
                    {check.url && (
                      <button className="link" onClick={() => void window.baton.openExternal(check.url!)}>
                        logs
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail && detail.files.length > 0 && (
            <section>
              <h3>
                {detail.changedFiles} files · +{detail.additions} −{detail.deletions}
              </h3>
              <ul className="files">
                {detail.files.map((file) => (
                  <li key={file.path}>
                    <span className="file-path">{file.path}</span>
                    <span className="adds">+{file.additions}</span>
                    <span className="dels">−{file.deletions}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <LiveSessions subject={subject} sessions={sessions} onOpen={onOpenSession} />
          <History subject={subject} />
        </aside>
      </div>
    </div>
  );
}

export function TicketPane({
  issue,
  sessions,
  onRun,
  onOpenSession
}: {
  issue: JiraIssue;
  sessions: SessionInfo[];
  onRun: (kind: RunKind, issue: JiraIssue) => void;
  onOpenSession: (id: string) => void;
}) {
  // The list `issue` renders immediately — summary, status, subtasks are
  // already in hand. Only the description and comments are re-fetched, the
  // same split as `PullPane`/`pullDetail`: that round trip is what resolves
  // inline screenshots to real images instead of `search()`'s cheap
  // plain-text notes, and it is only worth paying for the ticket somebody
  // actually opened.
  const [detail, setDetail] = useState<JiraIssue>();

  useEffect(() => {
    setDetail(undefined);
    window.baton.ticketDetail(issue.key).then(setDetail).catch(() => {
      // The list version still has real (if attachment-free) text, so a
      // failed refetch is not worth surfacing as an error banner.
    });
  }, [issue.key]);

  const description = detail?.description ?? issue.description;
  const comments = detail?.comments ?? issue.comments;

  return (
    <div className="detail">
      <header className="detail-head">
        <h2>
          {issue.summary}
        </h2>
        <div className="detail-meta">
          <span className="key">{issue.key}</span>
          <span>{issue.issueType}</span>
          {issue.priority && <span>{issue.priority}</span>}
          <span>{formatAge(issue.updated)}</span>
        </div>
        <div className="detail-states">
          <span className="state">
            <span className={`dot ${issue.statusCategory === 'done' ? 'pass' : 'waiting'}`} />
            {issue.status}
          </span>
        </div>
        <div className="detail-actions">
          <RunButtons kinds={['implement']} onRun={(kind) => onRun(kind, issue)} />
          <button className="ghost" onClick={() => void window.baton.openExternal(issue.url)}>
            Open in Jira
          </button>
        </div>
      </header>

      <div className="detail-body">
        <div className="detail-main">
          <section>
            <h3>Description</h3>
            <Prose text={description} />
          </section>

          {comments.length > 0 && (
            <section>
              <h3>Comments</h3>
              {comments.map((c, i) => (
                <div key={i} className="comment">
                  <div className="comment-head">
                    <strong>{c.author}</strong>
                    <span className="when">{formatAge(c.created)}</span>
                  </div>
                  <Prose text={c.body} />
                </div>
              ))}
            </section>
          )}
        </div>

        <aside className="detail-side">
          {issue.subtasks.length > 0 && (
            <section>
              <h3>Subtasks</h3>
              <ul className="files">
                {issue.subtasks.map((sub) => (
                  <li key={sub.key}>
                    <button className="link" onClick={() => void window.baton.openExternal(sub.url)}>
                      {sub.key}
                    </button>
                    <span className="file-path">{sub.summary}</span>
                    <span className="run-when">{sub.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <LiveSessions subject={issue.key} sessions={sessions} onOpen={onOpenSession} />
          <History subject={issue.key} />
        </aside>
      </div>
    </div>
  );
}
