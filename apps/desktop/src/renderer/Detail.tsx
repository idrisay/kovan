import { useEffect, useState } from 'react';
import { formatAge, pullFlags } from '@baton/core';
import type { AgentRun, JiraIssue, PullDetail, PullSummary, RunKind } from './types';

function Markdownish({ text }: { text: string }) {
  // Deliberately not a Markdown renderer. Review comments and ticket bodies are
  // other people's text, and the fastest way to an injection in a desktop app
  // is `dangerouslySetInnerHTML` over content from a pull request. Whitespace
  // preservation gets 90% of the readability for none of the risk; a real
  // renderer can land later behind a sanitiser.
  return <div className="prose">{text || <span className="quiet">Nothing written.</span>}</div>;
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
            <span className="quiet">{new Date(run.startedAt).toLocaleString()}</span>
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

  return (
    <div className="detail">
      <header className="detail-head">
        <h2>{pull.title}</h2>
        <div className="row-meta">
          {pull.repo} #{pull.number} · {pull.author} · updated {formatAge(pull.updatedAt)}
          {detail && ` · ${detail.baseRef} ← ${detail.headRef}`}
        </div>
        <div className="flags">
          {pullFlags(pull).map((flag) => (
            <span key={flag.id} className={`flag flag-${flag.id}`}>
              {flag.label}
            </span>
          ))}
        </div>
        <div className="detail-actions">
          <button className="ghost" onClick={() => void window.baton.openExternal(pull.url)}>
            Open on GitHub
          </button>
        </div>
      </header>

      <RunButtons kinds={kinds} onRun={(kind) => onRun(kind, pull)} />

      {error && <div className="error boxed">{error}</div>}
      {!detail && !error && <p className="quiet">Loading…</p>}

      {detail && (
        <>
          {detail.checks.length > 0 && (
            <section>
              <h3>Checks</h3>
              <ul className="checks">
                {detail.checks.map((check) => (
                  <li key={check.name} className={`check check-${check.status}`}>
                    <span className="dot" />
                    <span>{check.name}</span>
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
                        <span className="quiet">{formatAge(c.createdAt)}</span>
                      </div>
                      <Markdownish text={c.body} />
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}

          {detail.body && (
            <section>
              <h3>Description</h3>
              <Markdownish text={detail.body} />
            </section>
          )}

          {detail.files.length > 0 && (
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
        </>
      )}

      <History subject={pull.title.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? `${pull.repo}#${pull.number}`} />
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
          <span className="key">{issue.key}</span> {issue.summary}
        </h2>
        <div className="row-meta">
          {issue.status} · {issue.issueType}
          {issue.priority ? ` · ${issue.priority}` : ''} · updated {formatAge(issue.updated)}
        </div>
        <div className="detail-actions">
          <button className="ghost" onClick={() => void window.baton.openExternal(issue.url)}>
            Open in Jira
          </button>
        </div>
      </header>

      <RunButtons kinds={['implement']} onRun={(kind) => onRun(kind, issue)} />

      <section>
        <h3>Description</h3>
        <Markdownish text={issue.description} />
      </section>

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
                <span className="quiet">{sub.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {issue.comments.length > 0 && (
        <section>
          <h3>Comments</h3>
          {issue.comments.map((c, i) => (
            <div key={i} className="comment">
              <div className="comment-head">
                <strong>{c.author}</strong>
                <span className="quiet">{formatAge(c.created)}</span>
              </div>
              <Markdownish text={c.body} />
            </div>
          ))}
        </section>
      )}

      <History subject={issue.key} />
    </div>
  );
}
