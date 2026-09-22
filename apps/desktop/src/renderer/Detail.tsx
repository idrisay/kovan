import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAge, isMerged } from '@baton/core';
import { States } from './rows';
import { Prose } from './Prose';
import { RunViewer } from './RunViewer';
import { Terminal } from './Terminal';
import { DockBottomIcon, DockLeftIcon, DockRightIcon, DockTopIcon, TerminalIcon } from './icons';
import type {
  AgentRun, JiraIssue, PullDetail, PullSummary, ReviewComment, Reviewer, RunKind, SentryFrame,
  SentryIssue, SessionInfo
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

const RUN_LABEL: Record<RunKind, string> = {
  implement: 'Work on this in an agent',
  review: 'Review in an agent',
  unblock: 'Unblock in an agent',
  verify: 'Check it shipped'
};

/**
 * Which run kinds write, and which only read and judge.
 *
 * `Agents.runnerFor()` already draws this line — review and verify default to
 * a cheaper model because they report back rather than change anything — and
 * it is exactly the distinction "unblock" and "verify" need a visual line
 * between: two buttons of the same weight sitting side by side on a merged,
 * blocked pull request read as the same kind of action, when one of them
 * starts writing code and the other only checks it.
 */
const RUN_WRITES: Record<RunKind, boolean> = {
  implement: true, unblock: true, review: false, verify: false
};

function RunButtons({
  kinds,
  onRun
}: {
  kinds: RunKind[];
  onRun: (kind: RunKind) => void;
}) {
  return (
    <div className="run-buttons">
      {kinds.map((kind) => (
        <button
          key={kind}
          className={RUN_WRITES[kind] ? 'primary' : 'primary outline'}
          onClick={() => onRun(kind)}
        >
          {RUN_LABEL[kind]}
        </button>
      ))}
    </div>
  );
}

/**
 * A subject's own sessions, as a string that changes exactly when `History`
 * needs to re-fetch: a run starting, or an agent finishing without anyone
 * closing its terminal, either one meaning a report or prompt just landed on
 * disk that `History`'s last fetch could not have known about.
 */
function sessionSignature(sessions: SessionInfo[], subject: string): string {
  return sessions
    .filter((s) => s.subject === subject)
    .map((s) => `${s.id}:${s.running}`)
    .join(',');
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

function History({ subject, refreshOn }: { subject: string; refreshOn?: string }) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [viewing, setViewing] = useState<AgentRun>();

  useEffect(() => {
    void window.baton.runHistory(subject).then(setRuns);
    // `refreshOn` is a signature of this subject's own sessions (id:running
    // pairs) — a run starting, or an agent finishing without anyone closing
    // its terminal, changes it, which is exactly when a report or prompt
    // this list does not know about yet lands on disk.
  }, [subject, refreshOn]);

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

/**
 * Where the inline terminal docks against the pane it was started from. A
 * global preference, not one per ticket/PR — you pick a side once and every
 * run from then on opens there, the same way the sidebar's width is one
 * setting rather than one per view.
 */
type DockPosition = 'bottom' | 'top' | 'left' | 'right';

const DOCK_KEY = 'baton.terminal-dock';
const HEIGHT_KEY = 'baton.terminal-height';
const WIDTH_KEY = 'baton.terminal-width';
const MIN_SIZE = 140;
// A fraction of the shell's own box, not a fixed pixel ceiling — the panel
// lives inside a ticket/PR pane whose size already scales with the window,
// so capping it as a share of that box scales the same way rather than
// falling short on anything bigger than the screen this number was picked on.
const MAX_RATIO = 0.8;
const DEFAULT_HEIGHT = 320;
const DEFAULT_WIDTH = 420;

function isDockPosition(value: unknown): value is DockPosition {
  return value === 'bottom' || value === 'top' || value === 'left' || value === 'right';
}

function storedDock(): DockPosition {
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    return isDockPosition(raw) ? raw : 'bottom';
  } catch {
    return 'bottom';
  }
}

function storedSize(key: string, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  } catch {
    return fallback;
  }
}

const clampSize = (px: number, bound: number) =>
  Math.min(Math.round(bound * MAX_RATIO), Math.max(MIN_SIZE, Math.round(px)));

const DOCK_OPTIONS: { id: DockPosition; label: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { id: 'top', label: 'Dock top', Icon: DockTopIcon },
  { id: 'bottom', label: 'Dock bottom', Icon: DockBottomIcon },
  { id: 'left', label: 'Dock left', Icon: DockLeftIcon },
  { id: 'right', label: 'Dock right', Icon: DockRightIcon }
];

/**
 * The session an agent run started in, docked against the pane it was
 * started from — not a jump to the Sessions tab. Starting a run and losing
 * sight of the ticket you started it on was the whole complaint this fixes.
 *
 * It docks to any of the four edges and resizes by dragging the edge that
 * borders the reading area, the same pointer-capture technique as `Resizer`
 * but generalised to whichever axis the current dock position resizes along.
 */
function InlineTerminal({ session, onHide }: { session: SessionInfo; onHide: () => void }) {
  const [dock, setDock] = useState<DockPosition>(storedDock);
  const [height, setHeight] = useState(() => storedSize(HEIGHT_KEY, DEFAULT_HEIGHT));
  const [width, setWidth] = useState(() => storedSize(WIDTH_KEY, DEFAULT_WIDTH));
  const panel = useRef<HTMLDivElement>(null);
  const grab = useRef(0);
  const vertical = dock === 'left' || dock === 'right';

  const changeDock = useCallback((next: DockPosition) => {
    setDock(next);
    try { localStorage.setItem(DOCK_KEY, next); } catch { /* a preference, not a requirement */ }
  }, []);

  function down(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    // The edge that borders the reading area — the one dragging actually
    // moves — expressed once, in mouse coordinates, so `move` never has to
    // re-derive it from a rect that is itself changing size as the drag runs.
    const edge = dock === 'bottom' ? rect.top : dock === 'top' ? rect.bottom
      : dock === 'left' ? rect.right : rect.left;
    grab.current = (vertical ? event.clientX : event.clientY) - edge;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
    document.body.classList.add(vertical ? 'resizing' : 'resizing-row');
    event.preventDefault();
  }

  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // Measured against the shell, not the panel: the shell's own box does not
    // move mid-drag, where the panel's does — the whole edge being dragged.
    const shell = panel.current?.parentElement?.getBoundingClientRect();
    if (!shell) return;
    const pos = (vertical ? event.clientX : event.clientY) - grab.current;
    if (dock === 'bottom') setHeight(clampSize(shell.bottom - pos, shell.height));
    else if (dock === 'top') setHeight(clampSize(pos - shell.top, shell.height));
    else if (dock === 'left') setWidth(clampSize(pos - shell.left, shell.width));
    else setWidth(clampSize(shell.right - pos, shell.width));
  }

  function up(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.classList.remove('dragging');
    document.body.classList.remove('resizing', 'resizing-row');
    try {
      localStorage.setItem(vertical ? WIDTH_KEY : HEIGHT_KEY, String(vertical ? width : height));
    } catch { /* a preference, not a requirement */ }
  }

  const handle = (
    <div
      className={vertical ? 'terminal-resizer vertical' : 'terminal-resizer horizontal'}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label="Resize terminal"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  );

  const style = vertical ? { width } : { height };
  // The handle sits on whichever edge borders the reading area. A bottom or
  // right dock has that edge first (top or left of the panel itself); a top
  // or left dock has it last (bottom or right) — the opposite of where the
  // panel as a whole sits relative to the reading area.
  const handleFirst = dock === 'bottom' || dock === 'right';

  return (
    <div ref={panel} className={`detail-terminal dock-${dock}`} style={style}>
      {handleFirst && handle}
      <div className="detail-terminal-body">
        <div className="term-head">
          <span className="state">
            <span className={session.running ? 'dot live' : 'dot'} />
            {session.running ? (session.kind ?? session.runnerName) : `exited ${session.exitCode ?? ''}`}
          </span>
          <div className="term-head-actions">
            <div className="dock-picker" role="group" aria-label="Dock position">
              {DOCK_OPTIONS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={id === dock ? 'icon-button active' : 'icon-button'}
                  aria-label={label}
                  aria-pressed={id === dock}
                  title={label}
                  onClick={() => changeDock(id)}
                >
                  <Icon size={13} />
                </button>
              ))}
            </div>
            <button className="ghost" onClick={onHide}>
              Hide
            </button>
            <button className="ghost" onClick={() => void window.baton.sessionClose(session.id)}>
              Close
            </button>
          </div>
        </div>
        <Terminal sessionId={session.id} />
      </div>
      {!handleFirst && handle}
    </div>
  );
}

/**
 * A terminal that belongs to this ticket or pull request, not to a run
 * started from it — no prompt, no history, no report, just a shell in the
 * subject's own folder. Filed under the subject the same way a run's session
 * is, so it docks back inline the same way too: navigate away and back and
 * it is still there, exactly like a run's session, until you close it
 * yourself.
 */
function useQuickTerminal(
  cwdHint: string | undefined,
  subject: string,
  onOpenSession: (id: string) => void
): () => void {
  return useCallback(() => {
    void window.baton.defaultCwd(cwdHint).then((cwd) =>
      window.baton.openTerminal(cwd, subject, `Terminal — ${subject}`)
    ).then((session) => onOpenSession(session.id));
  }, [cwdHint, subject, onOpenSession]);
}

export function PullPane({
  pull,
  viewer,
  sessions,
  activeSession,
  onRun,
  onOpenSession
}: {
  pull: PullSummary;
  viewer: string;
  sessions: SessionInfo[];
  activeSession?: string;
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

  // Only the session App.tsx currently has in mind, and only when it is
  // actually this pull's own — otherwise a run started elsewhere would
  // follow you here the moment you opened an unrelated pull request.
  const inlineSession = sessions.find((s) => s.id === activeSession && s.subject === subject);
  const [showTerminal, setShowTerminal] = useState(true);
  useEffect(() => {
    setShowTerminal(true);
  }, [inlineSession?.id]);

  const openQuickTerminal = useQuickTerminal(pull.repo, subject, onOpenSession);

  const unresolved = detail?.threads.filter((t) => !t.isResolved) ?? [];
  // Whether the left column has anything in it. A PR with no description and
  // no open threads should not leave a blank half: the rail spans instead.
  // Decided here rather than with :empty, which would rest on React never
  // emitting a stray whitespace node between the conditionals.
  const hasReading = Boolean(
    error || !detail || detail.body || unresolved.length > 0 || detail.comments.length > 0
  );

  return (
    <div className="detail-shell">
    <div className="detail-scroll">
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
          <button className="ghost" onClick={openQuickTerminal}>
            <TerminalIcon size={13} /> Terminal
          </button>
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
          <History subject={subject} refreshOn={sessionSignature(sessions, subject)} />
        </aside>
      </div>
    </div>
    </div>
    {inlineSession && showTerminal && (
      <InlineTerminal session={inlineSession} onHide={() => setShowTerminal(false)} />
    )}
    </div>
  );
}

export function TicketPane({
  issue,
  sessions,
  activeSession,
  onRun,
  onOpenSession
}: {
  issue: JiraIssue;
  sessions: SessionInfo[];
  activeSession?: string;
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

  const inlineSession = sessions.find((s) => s.id === activeSession && s.subject === issue.key);
  const [showTerminal, setShowTerminal] = useState(true);
  useEffect(() => {
    setShowTerminal(true);
  }, [inlineSession?.id]);

  const openQuickTerminal = useQuickTerminal(undefined, issue.key, onOpenSession);

  return (
    <div className="detail-shell">
    <div className="detail-scroll">
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
          <button className="ghost" onClick={openQuickTerminal}>
            <TerminalIcon size={13} /> Terminal
          </button>
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
          <History subject={issue.key} refreshOn={sessionSignature(sessions, issue.key)} />
        </aside>
      </div>
    </div>
    </div>
    {inlineSession && showTerminal && (
      <InlineTerminal session={inlineSession} onHide={() => setShowTerminal(false)} />
    )}
    </div>
  );
}

/**
 * A level worth calling out with the red dot vs. one that reads as routine —
 * Sentry's own five levels, collapsed to the same pass/waiting/fail vocabulary
 * every other status dot in this app already uses.
 */
export function levelTone(level: string): 'fail' | 'waiting' | 'pass' {
  if (level === 'fatal' || level === 'error') return 'fail';
  if (level === 'warning') return 'waiting';
  return 'pass';
}

export function SentryPane({
  issue,
  sessions,
  activeSession,
  onRun,
  onOpenSession
}: {
  issue: SentryIssue;
  sessions: SessionInfo[];
  activeSession?: string;
  onRun: (issue: SentryIssue, frames: SentryFrame[]) => void;
  onOpenSession: (id: string) => void;
}) {
  const [frames, setFrames] = useState<SentryFrame[]>([]);
  const [loadingFrames, setLoadingFrames] = useState(true);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketResult, setTicketResult] = useState<{ key: string; url: string }>();
  const [ticketError, setTicketError] = useState('');

  useEffect(() => {
    setFrames([]);
    setLoadingFrames(true);
    setTicketResult(undefined);
    setTicketError('');
    window.baton
      .sentryFrames(issue.id)
      .then(setFrames)
      // The pane still shows title/culprit/counts without a trace — worth
      // showing over a blank pane, so a resolution failure only empties the
      // one section that needed it.
      .catch(() => setFrames([]))
      .finally(() => setLoadingFrames(false));
  }, [issue.id]);

  async function createTicket() {
    setTicketBusy(true);
    setTicketError('');
    try {
      setTicketResult(await window.baton.sentryCreateTicket(issue));
    } catch (err) {
      setTicketError(err instanceof Error ? err.message : String(err));
    } finally {
      setTicketBusy(false);
    }
  }

  const inlineSession = sessions.find((s) => s.id === activeSession && s.subject === issue.shortId);
  const [showTerminal, setShowTerminal] = useState(true);
  useEffect(() => {
    setShowTerminal(true);
  }, [inlineSession?.id]);

  const openQuickTerminal = useQuickTerminal(undefined, issue.shortId, onOpenSession);

  return (
    <div className="detail-shell">
    <div className="detail-scroll">
    <div className="detail">
      <header className="detail-head">
        <h2>{issue.title}</h2>
        <div className="detail-meta">
          <span className="key">{issue.shortId}</span>
          <span>{issue.project}</span>
          <span>{formatAge(issue.lastSeen)}</span>
        </div>
        <div className="detail-states">
          <span className="state">
            <span className={`dot ${levelTone(issue.level)}`} />
            {issue.level} · {issue.count} events · {issue.userCount} users affected
          </span>
        </div>
        <div className="detail-actions">
          <div className="run-buttons">
            <button className="primary" disabled={loadingFrames} onClick={() => onRun(issue, frames)}>
              Fix in an agent
            </button>
            <button
              className="primary outline"
              disabled={ticketBusy || Boolean(ticketResult)}
              onClick={() => void createTicket()}
            >
              {ticketBusy ? 'Creating…' : ticketResult ? 'Ticket created' : 'Create ticket'}
            </button>
          </div>
          <button className="ghost" onClick={openQuickTerminal}>
            <TerminalIcon size={13} /> Terminal
          </button>
          <button className="ghost" onClick={() => void window.baton.openExternal(issue.permalink)}>
            Open in Sentry
          </button>
        </div>
        {ticketResult && (
          <p className="quiet small">
            Filed as{' '}
            <button className="link" onClick={() => void window.baton.openExternal(ticketResult.url)}>
              {ticketResult.key}
            </button>
          </p>
        )}
        {ticketError && <div className="error boxed">{ticketError}</div>}
      </header>

      <div className="detail-body">
        <div className="detail-main">
          <section>
            <h3>Culprit</h3>
            <p>{issue.culprit || '(unknown)'}</p>
          </section>

          <section>
            <h3>Stack trace</h3>
            {loadingFrames ? (
              <p className="quiet">Loading…</p>
            ) : frames.length === 0 ? (
              <p className="quiet">No stack trace was available for the latest event.</p>
            ) : (
              <ul className="files mono">
                {frames.map((f, i) => (
                  <li key={i} className={f.inApp ? '' : 'quiet'}>
                    <span className="file-path">
                      {f.resolvedPath ?? f.filename ?? '(unknown file)'}
                      {f.lineNo && (f.resolvedPath ?? f.filename) ? `:${f.lineNo}` : ''}
                    </span>
                    {f.function && <span className="run-when">{f.function}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="detail-side">
          <LiveSessions subject={issue.shortId} sessions={sessions} onOpen={onOpenSession} />
          <History subject={issue.shortId} refreshOn={sessionSignature(sessions, issue.shortId)} />
        </aside>
      </div>
    </div>
    </div>
    {inlineSession && showTerminal && (
      <InlineTerminal session={inlineSession} onHide={() => setShowTerminal(false)} />
    )}
    </div>
  );
}
