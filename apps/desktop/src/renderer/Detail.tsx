import { useEffect, useState } from 'react';
import { formatAge } from '@baton/core';
import { States } from './rows';
import { Prose } from './Prose';
import type { AgentRun, JiraIssue, PullDetail, PullSummary, RunKind } from './types';

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

function History({ subject }: { subject: string }) {
  const [runs, setRuns] = useState<AgentRun[]>([]);

  useEffect(() => {
    void window.baton.runHistory(subject).then(setRuns);
  }, [subject]);

  if (runs.length === 0) {
    return null;
  }
  return (
    <section>
      <h3>History</h3>
      <ul className="runs">
        {runs.map((run) => (
          <li key={run.id}>
            <span className="run-kind">{run.kind}</span>
            <span className="run-when">{new Date(run.startedAt).toLocaleString()}</span>
            {run.confidence !== undefined && <span className="score">{run.confidence}/100</span>}
            {run.verdict !== 'unknown' && <span className="verdict">{run.verdict}</span>}
            {run.reportPath && (
              <button
                className="link"
                onClick={() => void window.baton.openExternal(`file://${run.reportPath}`)}
              >
                report
              </button>
            )}
            {run.promptPath && (
              <button
                className="link"
                onClick={() => void window.baton.openExternal(`file://${run.promptPath}`)}
              >
                prompt
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PullPane({
  pull,
  viewer,
  onRun
}: {
  pull: PullSummary;
  viewer: string;
  onRun: (kind: RunKind, pull: PullSummary) => void;
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
  // review other people's.
  const mine = pull.author.toLowerCase() === viewer.toLowerCase();
  const kinds: RunKind[] = mine ? ['unblock', 'verify'] : ['review'];

  const unresolved = detail?.threads.filter((t) => !t.isResolved) ?? [];
  // Whether the left column has anything in it. A PR with no description and
  // no open threads should not leave a blank half: the rail spans instead.
  // Decided here rather than with :empty, which would rest on React never
  // emitting a stray whitespace node between the conditionals.
  const hasReading = Boolean(error || !detail || detail.body || unresolved.length > 0);

  return (
    <div className="detail">
      <header className="detail-head">
        <h2>{pull.title}</h2>
        <div className="detail-meta">
          <span>{pull.repo}</span>
          <span>#{pull.number}</span>
          <span>{pull.author}</span>
          <span>{formatAge(pull.updatedAt)}</span>
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
        </div>

        <aside className="detail-side">
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

          <History
            subject={pull.title.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? `${pull.repo}#${pull.number}`}
          />
        </aside>
      </div>
    </div>
  );
}

export function TicketPane({
  issue,
  onRun
}: {
  issue: JiraIssue;
  onRun: (kind: RunKind, issue: JiraIssue) => void;
}) {
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
            <Prose text={issue.description} />
          </section>

          {issue.comments.length > 0 && (
            <section>
              <h3>Comments</h3>
              {issue.comments.map((c, i) => (
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

          <History subject={issue.key} />
        </aside>
      </div>
    </div>
  );
}
