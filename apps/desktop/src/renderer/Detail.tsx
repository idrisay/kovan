import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  formatAge, isMerged, olderCommentCount, pullBasis, pullFlags, reviewBasis, ticketBasis, ticketKeyInTitle,
  KIMI_REVIEW_FILE,
  isNvReviewModel,
  reviewModelName,
  TICKET_RECENT_COMMENTS
} from '@baton/core';
import { States, TONE } from './rows';
import { Prose } from './Prose';
import { CardTitle, CopyResult, QuickButton, QuickCard, ReviewDecision, VerdictBadge, useQuick } from './Quick';
import { KIND_LABEL } from './RunSheet';
import { useFold } from './folds';
import { SubjectUsage } from './Usage';
import { RunViewer } from './RunViewer';
import { Terminal } from './Terminal';
import { useTerminalFontSize } from './terminalFontSize';
import { findRelatedPulls, findSubject, type Selection } from './sessionSubject';
import {
  ChevronIcon, CloseIcon, DockBottomIcon, DockLeftIcon, DockRightIcon, DockTopIcon, HideIcon, OpenLinkIcon,
  TerminalIcon
} from './icons';
import type {
  AgentRun, JiraIssue, PullDetail, PullSummary, ReviewComment, ReviewThread, Reviewer, RunKind, SentryFrame,
  SentryIssue, SessionInfo, Snapshot
} from './types';

/** A stand-in for a real photo: initials on a colour picked from the name
 *  itself, so the same person is always the same colour without anyone
 *  having to assign one. */
const AVATAR_TONES = ['#4c74ae', '#6fa97f', '#c4635a', '#d0a05a', '#8b5fa0', '#3f7f7a'];

function avatarTone(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.length === 1 ? parts[0]!.slice(0, 2).toUpperCase() : (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: avatarTone(name), fontSize: size * 0.4 }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

/** The single most important fact about a pull request or ticket, read at a
 *  glance the way GitHub's own Open/Merged/Draft pill is — everything
 *  `States` already lists in more detail stays right underneath it. */
function StatusPill({ tone, label }: { tone: string; label: string }) {
  return (
    <span className={`status-pill ${tone}`}>
      <span className={`dot ${tone}`} />
      {label}
    </span>
  );
}

/** The pull request(s) or ticket this one names in its own title, the other
 *  half of the link `SessionName`'s open-link icon already follows from a
 *  session back to whatever it was started on. */
function RelatedLinks({ links }: { links: { label: string; onClick: () => void }[] }) {
  if (links.length === 0) return null;
  return (
    <div className="detail-related">
      {links.map((link, i) => (
        <button key={i} type="button" className="detail-related-link" onClick={link.onClick}>
          <OpenLinkIcon size={11} />
          {link.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One entry in a conversation — a review comment, a plain comment, or (for a
 * pull request) a whole review thread's worth of them collapsed to one card.
 * Starts collapsed except for whichever card is passed `defaultExpanded`;
 * the header is the click target either way, so scanning a long conversation
 * never depends on hitting a tiny chevron.
 */
function CommentCard({
  author, when, body, reviewState, pathLabel, defaultExpanded, extra
}: {
  author: string;
  when: string;
  body: string;
  reviewState?: { label: string; tone: 'waiting' | 'fail' | 'pass' };
  pathLabel?: string;
  defaultExpanded: boolean;
  /** Further comments in the same thread, shown under the first once expanded. */
  extra?: { author: string; when: string; body: string }[];
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="timeline-row">
      <Avatar name={author} />
      <div className={expanded ? 'timeline-card expanded' : 'timeline-card'}>
        <button type="button" className="timeline-card-head" onClick={() => setExpanded((v) => !v)}>
          <strong>{author}</strong>
          {reviewState && (
            <span className={`state timeline-card-review ${reviewState.tone}`}>
              <span className={`dot ${reviewState.tone}`} />
              {reviewState.label}
            </span>
          )}
          {pathLabel && <span className="timeline-card-path">{pathLabel}</span>}
          <span className="when">{when}</span>
          <ChevronIcon size={11} open={expanded} />
        </button>
        {expanded && (
          <div className="timeline-card-body">
            <Prose text={body} />
            {extra?.map((c, i) => (
              <div key={i} className="timeline-card-reply">
                <div className="timeline-card-subhead">
                  <strong>{c.author}</strong>
                  <span className="when">{c.when}</span>
                </div>
                <Prose text={c.body} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A description that can fold away, like GitHub's, so a long PR body doesn't
 * push the conversation off screen. Remembered per PR or ticket.
 */
function DescriptionSection({ subject, children }: { subject: string; children: React.ReactNode }) {
  const [collapsed, toggle] = useFold(subject, 'baton.collapsed-descriptions');
  return (
    <section className={collapsed ? 'collapsible collapsed' : 'collapsible'}>
      <h3>
        <button type="button" className="section-toggle" aria-expanded={!collapsed} onClick={toggle}>
          <ChevronIcon size={10} open={!collapsed} />
          Description
          {collapsed && <span className="section-toggle-hint">Show</span>}
        </button>
      </h3>
      {!collapsed && children}
    </section>
  );
}

/** An unresolved review thread as one card — the file/line it is pinned to
 *  where a plain comment would show a review-state badge, every reply in the
 *  thread folded in together rather than as separate cards of their own. */
function ThreadCard({ thread, defaultExpanded }: { thread: ReviewThread; defaultExpanded: boolean }) {
  const [first, ...rest] = thread.comments;
  if (!first) return null;
  return (
    <CommentCard
      author={first.author}
      when={formatAge(first.createdAt) ?? ''}
      body={first.body}
      pathLabel={thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ''}` : undefined}
      defaultExpanded={defaultExpanded}
      extra={rest.map((c) => ({ author: c.author, when: formatAge(c.createdAt) ?? '', body: c.body }))}
    />
  );
}

/**
 * A ticket's pull requests, in its header where they are seen first at any
 * window width: one line each — headline state, where it lives, title — and
 * a click opens it in Baton's own Pull requests tab. Open ones first, then
 * merged. They used to be small `repo #number` chips that said nothing about
 * state and only listed open pull requests with the key in their title; in
 * the side column they fell below the comments on a narrow window.
 */
function TicketPulls({ pulls, onOpen }: { pulls: PullSummary[]; onOpen: (pull: PullSummary) => void }) {
  if (pulls.length === 0) return null;
  return (
    <div className="linked-pulls" role="list" aria-label="Pull requests for this ticket">
      {pulls.map((pull) => {
        const flag = pullFlags(pull)[0]!;
        const name = pull.repo.split('/').pop() ?? pull.repo;
        return (
          <button
            key={`${pull.repo}#${pull.number}`} role="listitem"
            type="button" className="linked-pull" onClick={() => onOpen(pull)}
            title={`${pull.repo} #${pull.number} · ${pull.author}\nOpen in Pull requests`}
          >
            <span className={`dot ${TONE[flag.id]}`} />
            <span className="linked-pull-state">{flag.label}</span>
            <span className="linked-pull-id">{name} #{pull.number}</span>
            <span className="linked-pull-title">{pull.title}</span>
            <span className="linked-pull-age">{formatAge(pull.mergedAt ?? pull.updatedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}

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

function Reviewers({ reviewers, request }: {
  reviewers: Reviewer[];
  /** Present on an open pull request: the picker for asking more people. */
  request?: { repo: string; number: number; author: string; onRequested: () => void };
}) {
  if (reviewers.length === 0 && !request) {
    return null;
  }
  return (
    <section>
      <h3>Reviewers</h3>
      {reviewers.length === 0 && <p className="quiet reviewers-none">Nobody asked yet.</p>}
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
      {request && <ReviewerPicker {...request} taken={reviewers.map((r) => r.login)} />}
    </section>
  );
}

type Candidates = Awaited<ReturnType<typeof window.baton.reviewerCandidates>>;

/**
 * "Add a reviewer…": the repo's collaborators and teams, the people you've
 * asked most through Baton first. Picking one requests them on GitHub at
 * once — GitHub does the notifying. Loaded on first focus, not on opening
 * the pull request, so a PR you only read costs no extra call.
 */
function ReviewerPicker({ repo, number, author, taken, onRequested }: {
  repo: string; number: number; author: string; taken: string[]; onRequested: () => void;
}) {
  const [candidates, setCandidates] = useState<Candidates>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [asked, setAsked] = useState<string[]>([]);

  useEffect(() => {
    setCandidates(undefined);
    setAsked([]);
    setError('');
  }, [repo, number]);

  function load() {
    setOpen(true);
    if (candidates) return;
    window.baton.reviewerCandidates(repo).then(setCandidates).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  async function ask(person?: string, team?: string) {
    const who = person ?? team!;
    setBusy(who);
    setError('');
    try {
      await window.baton.requestReviewers(repo, number, person ? [person] : [], team ? [team] : []);
      setAsked((list) => [...list, who]);
      setQuery('');
      setOpen(false);
      onRequested();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }

  const skip = new Set([...taken, ...asked, author].map((l) => l.toLowerCase()));
  const q = query.trim().toLowerCase();
  const people = (candidates?.people ?? []).filter((p) => !skip.has(p.login.toLowerCase()) && p.login.toLowerCase().includes(q));
  const usual = people.filter((p) => p.count > 0);
  const others = people.filter((p) => p.count === 0);
  const teams = (candidates?.teams ?? []).filter((t) => !skip.has(t.slug.toLowerCase()) && `${t.slug} ${t.name}`.toLowerCase().includes(q));
  const Person = ({ login, count }: { login: string; count: number }) => (
    <button type="button" role="option" aria-selected={false} className="reviewer-option" disabled={Boolean(busy)} onMouseDown={(e) => e.preventDefault()} onClick={() => void ask(login)}>
      <span className="reviewer-avatar">{login.slice(0, 2).toUpperCase()}</span>
      <span className="reviewer-option-name">{login}</span>
      {busy === login ? <span className="reviewer-option-meta">requesting…</span>
        : count > 0 && <span className="reviewer-option-meta">{count} {count === 1 ? 'PR' : 'PRs'}</span>}
    </button>
  );

  return (
    <div className="reviewer-picker">
      {asked.length > 0 && <p className="reviewer-asked">Requested {asked.join(', ')}. GitHub has notified them.</p>}
      <input
        type="text" className="reviewer-input" placeholder="Add a reviewer…" aria-label="Add a reviewer"
        value={query}
        onFocus={load}
        onBlur={() => setOpen(false)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Enter') {
            const first = usual[0] ?? others[0];
            if (first) void ask(first.login);
            else if (teams[0]) void ask(undefined, teams[0].slug);
          }
        }}
      />
      {open && (
        <div className="menu reviewer-menu" role="listbox">
          {!candidates && !error && <p className="menu-empty">Loading who can review…</p>}
          {candidates && usual.length + others.length + teams.length === 0 && (
            <p className="menu-empty">{q ? 'Nobody matches.' : 'Nobody else can be asked on this repository.'}</p>
          )}
          {usual.length > 0 && <div className="menu-head">Your usual reviewers</div>}
          {usual.map((p) => <Person key={p.login} {...p} />)}
          {others.length > 0 && <div className="menu-head">{usual.length > 0 ? 'Everyone else' : 'People'}</div>}
          {others.slice(0, 30).map((p) => <Person key={p.login} {...p} />)}
          {teams.length > 0 && <div className="menu-head">Teams</div>}
          {teams.map((t) => (
            <button key={t.slug} type="button" role="option" aria-selected={false} className="reviewer-option" disabled={Boolean(busy)} onMouseDown={(e) => e.preventDefault()} onClick={() => void ask(undefined, t.slug)}>
              <span className="reviewer-avatar team">{t.name.slice(0, 2).toUpperCase()}</span>
              <span className="reviewer-option-name">{t.name}</span>
              <span className="reviewer-option-meta">{busy === t.slug ? 'requesting…' : 'whole team'}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
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
 * This is exactly the distinction "unblock" and "verify" need a visual line
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
              <span className={s.running ? (s.attention ? 'dot running' : 'dot live') : 'dot'} />
              {s.running
                ? (s.attention ? 'waiting for you' : 'running')
                : `exited ${s.exitCode ?? ''}`}
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

const VERDICT_SHOWN: Record<AgentRun['verdict'], { label: string; tone: string } | undefined> = {
  implemented: { label: 'Implemented', tone: 'pass' },
  partly: { label: 'Partly implemented', tone: 'running' },
  'not-implemented': { label: 'Not implemented', tone: 'fail' },
  unchecked: { label: 'Could not check', tone: '' },
  unknown: undefined
};

/**
 * The latest agent report for this pull request or ticket — "Check it
 * shipped", an agent review, an unblock — at the top of the page, where a
 * finished run's answer belongs. It used to be one line in History, at the
 * bottom of the side column under every changed file, which is to say it
 * could not be found at all.
 */
function AgentReport({ subject, pull, refreshOn }: { subject: string; pull?: string; refreshOn?: string }) {
  const [run, setRun] = useState<AgentRun>();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [folded, toggleFold] = useFold(`report:${pull ?? subject}`);

  useEffect(() => {
    let live = true;
    void window.baton.runHistory(subject).then(async (runs) => {
      // On a pull request's page, only runs started from that pull request:
      // a ticket's folder collects runs from every pull request that named it.
      const latest = runs
        .filter((r) => r.reportPath && (!pull || r.pull === pull || r.subject === pull))
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const body = latest?.reportPath ? await window.baton.runText(latest.reportPath).catch(() => '') : '';
      if (!live) return;
      setRun(latest);
      setText(body.trim());
    });
    return () => { live = false; };
  }, [subject, pull, refreshOn]);

  if (!run || !text) return null;
  const verdict = VERDICT_SHOWN[run.verdict];
  // The verdict line is shown as the badge; the rest is the report.
  const body = text.replace(/^\s*\**VERDICT:[^\n]*\n+/i, '');
  const long = body.split('\n').length > 14;
  return (
    <section className={folded ? 'agent-report folded' : 'agent-report'}>
      <div className="quick-card-head">
        <CardTitle title={KIND_LABEL[run.kind] ?? run.kind} folded={folded} onToggle={toggleFold} />
        <span className="quick-tag agent-report-tag">agent report</span>
        {verdict && (
          <span className={`state agent-report-verdict ${verdict.tone}`}>
            <span className={`dot ${verdict.tone}`} />
            {verdict.label}
          </span>
        )}
        <span className="quick-card-actions">
          <span className="quick-card-meta">
            {(() => { const age = formatAge(new Date(run.startedAt).toISOString()) ?? ''; return /now/.test(age) ? age : `${age} ago`; })()}
            {run.shots.length > 0 ? ` · ${run.shots.length} screenshot${run.shots.length === 1 ? '' : 's'}` : ''}
          </span>
          <CopyResult text={text} what="report" />
          <button type="button" className="link" onClick={() => setViewing(true)}>
            {run.shots.length > 0 ? 'Open with screenshots' : 'Open'}
          </button>
        </span>
      </div>
      {!folded && (
        <div className={long && !open ? 'agent-report-body folded' : 'agent-report-body'}>
          <Prose text={body} />
        </div>
      )}
      {!folded && long && (
        <button type="button" className="link agent-report-more" onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show the whole report'}
        </button>
      )}
      {viewing && <RunViewer run={run} onClose={() => setViewing(false)} />}
    </section>
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
  const [fontSize] = useTerminalFontSize();
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
            <span className={session.running ? (session.attention ? 'dot running' : 'dot live') : 'dot'} />
            {session.running
              ? (session.attention ? 'waiting for you' : (session.kind ?? session.runnerName))
              : `exited ${session.exitCode ?? ''}`}
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
            <button
              type="button" className="icon-button boxed" aria-label="Hide terminal" title="Hide terminal"
              onClick={onHide}
            >
              <HideIcon size={12} />
            </button>
            <button
              type="button" className="icon-button boxed" aria-label="Close session" title="Close session"
              onClick={() => void window.baton.sessionClose(session.id)}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        </div>
        <Terminal sessionId={session.id} fontSize={fontSize} />
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
  snapshot,
  onRun,
  onOpenSession,
  onOpenSubject
}: {
  pull: PullSummary;
  viewer: string;
  sessions: SessionInfo[];
  activeSession?: string;
  snapshot: Snapshot;
  onRun: (kind: RunKind, pull: PullSummary) => void;
  onOpenSession: (id: string) => void;
  onOpenSubject: (match: Selection) => void;
}) {
  const [detail, setDetail] = useState<PullDetail>();
  const [error, setError] = useState('');

  const [detailVersion, setDetailVersion] = useState(0);
  useEffect(() => {
    // A reload after requesting a reviewer keeps what is on screen until the
    // new answer lands, rather than blanking the pane.
    if (detailVersion === 0) setDetail(undefined);
    setError('');
    window.baton
      .pullDetail(pull.repo, pull.number)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [pull.repo, pull.number, detailVersion]);
  useEffect(() => setDetailVersion(0), [pull.repo, pull.number]);

  // Yours or theirs decides what you can do with it: you unblock your own and
  // review other people's. Merged work can only be one thing — there is
  // nothing left to unblock, and offering it next to "Check it shipped" would
  // make the one useful button the second-guessed one.
  const mine = pull.author.toLowerCase() === viewer.toLowerCase();
  const kinds: RunKind[] = isMerged(pull) ? ['verify'] : mine ? ['unblock', 'verify'] : ['review'];
  // The same string `Agents.subjectFor()` computes in main, so a session or a
  // past run started from this pull is found under the ticket it carried,
  // not filed separately under the pull request that happened to open it.
  const ticketKey = ticketKeyInTitle(pull.title);
  const subject = ticketKey || `${pull.repo}#${pull.number}`;
  // The ticket this PR names, if it is one currently on screen — the other
  // direction of the link a ticket's own "related PRs" row follows.
  const relatedTicket = ticketKey ? findSubject(ticketKey, snapshot)?.issue : undefined;

  // Only the session App.tsx currently has in mind, and only when it is
  // actually this pull's own — otherwise a run started elsewhere would
  // follow you here the moment you opened an unrelated pull request.
  const inlineSession = sessions.find((s) => s.id === activeSession && s.subject === subject);
  const [showTerminal, setShowTerminal] = useState(true);
  useEffect(() => {
    setShowTerminal(true);
  }, [inlineSession?.id]);

  const openQuickTerminal = useQuickTerminal(pull.repo, subject, onOpenSession);

  // The same priority order the queue row's own state chips already use —
  // `pullFlags` puts the one thing that matters most first, so the header
  // pill and the first chip in `States` below it never disagree.
  const primaryFlag = pullFlags(pull)[0]!;

  // Keyed by the pull request itself, not `subject`: a summary is about this
  // PR's own reviews and checks, even when its title names a ticket.
  const summary = useQuick('pull-summary', `${pull.repo}#${pull.number}`);
  const review = useQuick('pull-review', `${pull.repo}#${pull.number}`);
  const showSummary = [summary.state, review.state].some((q) => Boolean(q.result || q.running || q.error));

  const unresolved = detail?.threads.filter((t) => !t.isResolved) ?? [];
  // Whether the left column has anything in it. A PR with no description and
  // no open threads should not leave a blank half: the rail spans instead.
  // Decided here rather than with :empty, which would rest on React never
  // emitting a stray whitespace node between the conditionals.
  const hasReading = Boolean(
    error || !detail || detail.body || unresolved.length > 0 || detail.comments.length > 0 || showSummary
  );

  return (
    <div className="detail-shell">
    <div className="detail-scroll">
    <div className="detail reading">
      <header className="detail-head">
        <div className="detail-pill-row">
          <StatusPill tone={TONE[primaryFlag.id]} label={primaryFlag.label} />
          <span className="detail-pill-repo">{pull.repo} #{pull.number}</span>
        </div>
        <h2>{pull.title}</h2>
        <div className="detail-meta">
          <span>{pull.author}</span>
          <span>{isMerged(pull) ? `merged ${formatAge(pull.mergedAt!)}` : formatAge(pull.updatedAt)}</span>
          {detail && (
            <span>
              wants to merge into <code>{detail.baseRef}</code> from <code>{detail.headRef}</code>
            </span>
          )}
        </div>
        <RelatedLinks
          links={relatedTicket ? [{ label: relatedTicket.key, onClick: () => onOpenSubject({ issue: relatedTicket }) }] : []}
        />
        {/* The pill above already says the headline state; this line lists
            the rest, and goes when there is no rest ("Approved" twice). */}
        {pullFlags(pull).some((flag) => flag.id !== primaryFlag.id) && (
          <div className="detail-states">
            <States pull={pull} max={6} skip={primaryFlag.id} />
          </div>
        )}
        {/* One row of actions, the agent runs first: they are the reason this
            app exists, and 'Open on GitHub' is the escape hatch. */}
        <div className="detail-actions">
          <RunButtons kinds={kinds} onRun={(kind) => onRun(kind, pull)} />
          <span className="action-divider" />
          <QuickButton kind="pull-summary" label="Summarize" runningLabel="Summarizing" state={summary.state} onRun={summary.run} />
          <QuickButton
            kind="pull-review"
            label="Review"
            runningLabel="Reviewing"
            state={review.state}
            onRun={review.run}
            tooltip="Sends the diff to the model on the button's tag (NVIDIA through nv-review, or any opencode model). It recommends approve or request changes, and you decide what goes to GitHub. Reads only; never changes code. Can take several minutes."
          />
          <span className="action-divider" />
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
          <AgentReport
            subject={subject} pull={`${pull.repo}#${pull.number}`}
            refreshOn={sessionSignature(sessions, subject)}
          />
          <QuickCard
            kind="pull-summary"
            title={isMerged(pull) ? 'Summary' : "Why it's blocked"}
            state={summary.state}
            basisNow={detail ? pullBasis(detail) : undefined}
            footer="Written by a free quick model from this PR's reviews, threads and checks. It read nothing else and changed nothing."
            onRun={summary.run}
            onCancel={summary.cancel}
            onDismiss={summary.dismiss}
          />

          <QuickCard
            kind="pull-review"
            title="Code review"
            runningNote="A review reads the whole diff: expect a few minutes, more on NVIDIA's free API. You can leave this pane."
            tag={review.state.result ? reviewModelName(review.state.result.model) : 'review'}
            badge={<VerdictBadge verdict={review.state.result?.verdict} />}
            state={review.state}
            basisNow={detail ? reviewBasis(detail) : undefined}
            footer={`Read the diff, description and open threads through ${review.state.result && !isNvReviewModel(review.state.result.model) ? 'opencode' : 'nv-review'}, and changed nothing. Saved as ${KIMI_REVIEW_FILE} in this PR's History below.`}
            onRun={review.run}
            onCancel={review.cancel}
            onDismiss={review.dismiss}
          >
            {(stale) => review.state.result && (
              <ReviewDecision
                subject={`${pull.repo}#${pull.number}`}
                result={review.state.result}
                stale={stale}
                onRefresh={review.run}
              />
            )}
          </QuickCard>

          {error && <div className="error boxed">{error}</div>}
          {!detail && !error && <p className="quiet">Loading…</p>}

          {detail?.body && (
            <DescriptionSection subject={`${pull.repo}#${pull.number}`}>
              <Prose text={detail.body} />
            </DescriptionSection>
          )}

          {unresolved.length > 0 && (
            <section>
              <h3>{unresolved.length} unresolved</h3>
              {unresolved.map((thread, i) => (
                <ThreadCard
                  key={thread.id}
                  thread={thread}
                  // Only ever the very last card in the whole conversation —
                  // the comments section below, when there is one, always
                  // has the true last word, so a thread only opens by
                  // default when nothing follows it.
                  defaultExpanded={detail!.comments.length === 0 && i === unresolved.length - 1}
                />
              ))}
            </section>
          )}

          {detail && detail.comments.length > 0 && (
            <section>
              <h3>Conversation</h3>
              {detail.comments.map((c, i) => (
                <CommentCard
                  key={i}
                  author={c.author}
                  when={formatAge(c.createdAt) ?? ''}
                  body={c.body}
                  reviewState={c.reviewState ? REVIEW_STATE[c.reviewState] : undefined}
                  defaultExpanded={i === detail.comments.length - 1}
                />
              ))}
            </section>
          )}
        </div>

        <aside className="detail-side">
          {detail && (
            <Reviewers
              reviewers={detail.reviewers}
              request={isMerged(pull) ? undefined : {
                repo: pull.repo, number: pull.number, author: pull.author,
                onRequested: () => setDetailVersion((v) => v + 1)
              }}
            />
          )}

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

          <SubjectUsage subject={`${pull.repo}#${pull.number}`} />
          <LiveSessions subject={subject} sessions={sessions} onOpen={onOpenSession} />
          <History
            subject={subject}
            refreshOn={`${sessionSignature(sessions, subject)}|${review.state.result?.createdAt ?? ''}`}
          />
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
  snapshot,
  onRun,
  onOpenSession,
  onOpenSubject
}: {
  issue: JiraIssue;
  sessions: SessionInfo[];
  activeSession?: string;
  snapshot: Snapshot;
  onRun: (kind: RunKind, issue: JiraIssue) => void;
  onOpenSession: (id: string) => void;
  onOpenSubject: (match: Selection) => void;
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

  // "Condense": the comments before the latest few that ticket.md keeps in full.
  const condense = useQuick('ticket-condense', issue.key);
  const older = olderCommentCount(comments.length);
  const condensed = condense.state.result;
  const covered = Math.min(condensed?.basis['condensed'] ?? 0, older);
  const [showOriginals, setShowOriginals] = useState(false);
  useEffect(() => setShowOriginals(false), [issue.key]);
  const showCondenseCard = Boolean(condensed || condense.state.running || condense.state.error);

  const inlineSession = sessions.find((s) => s.id === activeSession && s.subject === issue.key);
  const [showTerminal, setShowTerminal] = useState(true);
  useEffect(() => {
    setShowTerminal(true);
  }, [inlineSession?.id]);

  const openQuickTerminal = useQuickTerminal(undefined, issue.key, onOpenSession);
  // The pull requests that belong to this ticket — the other direction of the
  // link a pull request's own header follows back to its ticket.
  const relatedPulls = findRelatedPulls(issue.key, snapshot);

  return (
    <div className="detail-shell">
    <div className="detail-scroll">
    <div className="detail reading">
      <header className="detail-head">
        <div className="detail-pill-row">
          <StatusPill tone={issue.statusCategory === 'done' ? 'pass' : 'waiting'} label={issue.status} />
          <span className="detail-pill-repo">{issue.key}</span>
        </div>
        <h2>
          {issue.summary}
        </h2>
        <div className="detail-meta">
          <span>{issue.issueType}</span>
          {issue.priority && <span>{issue.priority}</span>}
          <span>{formatAge(issue.updated)}</span>
        </div>
        <TicketPulls pulls={relatedPulls} onOpen={(pull) => onOpenSubject({ pull })} />
        <div className="detail-actions">
          <RunButtons kinds={['implement']} onRun={(kind) => onRun(kind, issue)} />
          {older > 0 && (
            <>
              <span className="action-divider" />
              <QuickButton
                kind="ticket-condense"
                label={`Condense ${older} earlier comment${older === 1 ? '' : 's'}`}
                runningLabel="Condensing"
                state={condense.state}
                onRun={condense.run}
              />
              <span className="action-divider" />
            </>
          )}
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
          <AgentReport subject={issue.key} refreshOn={sessionSignature(sessions, issue.key)} />
          <DescriptionSection subject={issue.key}>
            <Prose text={description} />
          </DescriptionSection>

          {comments.length > 0 && (
            <section>
              <h3>Comments · {comments.length}</h3>
              {showCondenseCard && (
                <QuickCard
                  kind="ticket-condense"
                  title="Earlier discussion"
                  subtitle={condensed ? `${covered} comment${covered === 1 ? '' : 's'}, condensed` : undefined}
                  state={condense.state}
                  basisNow={ticketBasis({ key: issue.key, summary: issue.summary, comments })}
                  footer="Goes into ticket.md for the next agent run, in place of the omitted comments. The originals stay on the ticket."
                  onRun={condense.run}
                  onCancel={condense.cancel}
                  onDismiss={condense.dismiss}
                />
              )}
              {condensed && covered > 0 && (
                <div className="quick-card-links">
                  <button type="button" className="link" onClick={() => setShowOriginals((v) => !v)}>
                    {showOriginals ? 'Hide the originals' : `Show the ${covered} originals`}
                  </button>
                </div>
              )}
              {comments.map((c, i) =>
                // Once condensed, the comments it covers fold away behind the
                // link above — the card already says what they said.
                condensed && i < covered && !showOriginals ? null : (
                  <Fragment key={i}>
                    {condensed && covered > 0 && i === comments.length - TICKET_RECENT_COMMENTS && (
                      <div className="comments-subhead">Latest {TICKET_RECENT_COMMENTS}, in full</div>
                    )}
                    <CommentCard
                      author={c.author}
                      when={formatAge(c.created) ?? ''}
                      body={c.body}
                      defaultExpanded={i === comments.length - 1}
                    />
                  </Fragment>
                )
              )}
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

          <SubjectUsage subject={issue.key} />
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
    <div className="detail reading">
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
