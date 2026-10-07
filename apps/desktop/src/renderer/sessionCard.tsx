/**
 * Two things a session row says beyond its name:
 *
 * - The agent's own status (item 112): Working, Input (a question or a
 *   permission prompt waiting on you) or Done (its turn is over). Done is news
 *   only until you look: it goes once the session has been on screen.
 * - A card on hover (item 115) with the pull request, ticket or Sentry issue
 *   the session is about — only what Kovan already has loaded, nothing is
 *   fetched for it — and the session itself: agent, folder, age, cost.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatAge, pullFlags } from '@kovan/core';
import type { SessionInfo, Snapshot } from './types';
import { findRelatedPulls, findSubject, sessionLabel } from './sessionSubject';
import { SessionUsageChip } from './Usage';

// --- Status ----------------------------------------------------------------

/**
 * When each session's status was last seen on screen. Kept for this window
 * only: a Done you haven't looked at before a restart shows again after it.
 */
export function useSeenStatus(sessions: SessionInfo[], shown: string[]): (s: SessionInfo) => boolean {
  const [seenAt, setSeenAt] = useState<Record<string, number>>({});
  const key = shown.join(',');
  useEffect(() => {
    const now = Date.now();
    const next: Record<string, number> = {};
    for (const s of sessions) {
      if (shown.includes(s.id) && s.statusAt && (seenAt[s.id] ?? 0) < s.statusAt) next[s.id] = now;
    }
    if (Object.keys(next).length) setSeenAt((current) => ({ ...current, ...next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, key]);
  return (s) => (seenAt[s.id] ?? 0) >= (s.statusAt ?? 0);
}

const STATE_TEXT = { working: 'Working', input: 'Input', done: 'Done' } as const;
const STATE_HINT = {
  working: 'The agent is working on it.',
  input: 'The agent is waiting on you: a question or a permission prompt.',
  done: 'The agent finished its turn.'
} as const;

/** Nothing for a plain terminal, an agent that can't say, or a Done already seen. */
export function AgentStateBadge({ session, seen }: { session: SessionInfo; seen: boolean }) {
  const state = session.running ? session.status : undefined;
  if (!state || (state === 'done' && seen)) return null;
  return (
    <span className={`session-state ${state}`} title={STATE_HINT[state]}>
      {state === 'working' && <span className="session-state-spin" aria-hidden="true" />}
      {STATE_TEXT[state]}
    </span>
  );
}

/**
 * The sidebar row's status (item 146, option B): one small icon in a fixed
 * slot before the age, so they line up and scan as a column. ✓ for a Done
 * you haven't looked at, ! for Input, a spinner while it works; nothing
 * otherwise. The badge with words stays where there is room for it (the
 * terminal's header, a pane tab); the row's hover card says it in full.
 */
export function SessionStateIcon({ session, seen }: { session: SessionInfo; seen: boolean }) {
  const state = session.running ? session.status : undefined;
  const shown = state && !(state === 'done' && seen) ? state : undefined;
  return (
    <span className={`session-icon${shown ? ` ${shown}` : ''}`} title={shown ? STATE_HINT[shown] : undefined} aria-label={shown ? STATE_TEXT[shown] : undefined}>
      {shown === 'done' && (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      )}
      {shown === 'input' && (
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="8" r="6.9" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <rect x="7.2" y="4" width="1.6" height="5.2" rx="0.8" />
          <circle cx="8" cy="11.6" r="0.95" />
        </svg>
      )}
      {shown === 'working' && <span className="session-icon-spin" aria-hidden="true" />}
    </span>
  );
}

/** The row's dot: amber for a bell or Input, as before for everything else. */
export function sessionDot(session: SessionInfo): string {
  if (!session.running) return 'dot';
  const waiting = session.status ? session.status === 'input' : session.attention;
  return waiting ? 'dot running' : 'dot live';
}

// --- Hover card --------------------------------------------------------------

const HOVER_DELAY_MS = 500;

/**
 * Handlers for a row, and the card they open: after half a second of
 * hovering, gone as the pointer leaves or anything is pressed.
 */
export function useHoverCard(): {
  anchor?: DOMRect;
  handlers: { onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void; onMouseLeave: () => void; onPointerDown: () => void };
} {
  const [anchor, setAnchor] = useState<DOMRect>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const hide = () => { clearTimeout(timer.current); setAnchor(undefined); };
  return {
    anchor,
    handlers: {
      onMouseEnter: (e) => {
        const el = e.currentTarget;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setAnchor(el.getBoundingClientRect()), HOVER_DELAY_MS);
      },
      onMouseLeave: hide,
      onPointerDown: hide
    }
  };
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hover-card-line">
      <span className="hover-card-label">{label}</span>
      <span className="hover-card-value">{children}</span>
    </div>
  );
}

function age(iso?: string): string | undefined {
  if (!iso) return undefined;
  const text = formatAge(iso);
  return text && !/now/.test(text) ? `${text} ago` : text;
}

const CHECKS: Record<string, string | undefined> = {
  success: 'passing', failure: 'failing', pending: 'running', neutral: 'neutral', none: undefined
};

function SubjectPart({ subject, fallback, snapshot }: { subject?: string; fallback: string; snapshot: Snapshot }) {
  const match = subject ? findSubject(subject, snapshot) : undefined;
  if (match?.pull) {
    const p = match.pull;
    const turn = snapshot.blocked.some((x) => x.repo === p.repo && x.number === p.number)
      ? 'Yours — it needs work'
      : snapshot.reviewRequested.some((x) => x.repo === p.repo && x.number === p.number)
        ? 'Yours — your review is asked for'
        : p.mergedAt ? undefined : 'Theirs';
    const flags = pullFlags(p).map((f) => f.label).join(' · ');
    return (
      <>
        <div className="hover-card-kind mono">{p.repo}#{p.number}</div>
        <div className="hover-card-title">{p.title}</div>
        <Line label="State">{p.mergedAt ? `Merged ${age(p.mergedAt) ?? ''}` : flags || (p.isDraft ? 'Draft' : 'Open')}</Line>
        <Line label="Author">{p.author}</Line>
        {turn && <Line label="Turn">{turn}</Line>}
        {CHECKS[p.checks] && <Line label="Checks">{CHECKS[p.checks]}</Line>}
        <Line label="Changes"><span className="hover-card-add">+{p.additions}</span> <span className="hover-card-del">−{p.deletions}</span></Line>
        <Line label="Updated">{age(p.updatedAt)}</Line>
      </>
    );
  }
  if (match?.issue) {
    const t = match.issue;
    const done = t.subtasks.filter((s) => /done|closed|resolved/i.test(s.status)).length;
    const pulls = findRelatedPulls(t.key, snapshot);
    return (
      <>
        <div className="hover-card-kind mono">{t.key} · {t.issueType}</div>
        <div className="hover-card-title">{t.summary}</div>
        <Line label="Status">{t.status}</Line>
        {t.priority && <Line label="Priority">{t.priority}</Line>}
        <Line label="Assignee">{t.assignee ?? 'Unassigned'}</Line>
        {t.subtasks.length > 0 && <Line label="Subtasks">{done} of {t.subtasks.length} done</Line>}
        {pulls.length > 0 && (
          <Line label={pulls.length === 1 ? 'Pull request' : 'Pull requests'}>
            {pulls.slice(0, 3).map((p) => `#${p.number}${p.mergedAt ? ' (merged)' : ''}`).join(', ')}
            {pulls.length > 3 ? ` +${pulls.length - 3}` : ''}
          </Line>
        )}
        <Line label="Updated">{age(t.updated)}</Line>
      </>
    );
  }
  if (match?.sentry) {
    const e = match.sentry;
    return (
      <>
        <div className="hover-card-kind mono">{e.shortId} · {e.level}</div>
        <div className="hover-card-title">{e.title}</div>
        <Line label="Seen">{e.count} events · {e.userCount} users</Line>
        <Line label="Last seen">{age(e.lastSeen)}</Line>
      </>
    );
  }
  return (
    <>
      <div className="hover-card-title">{fallback}</div>
      {subject && <p className="hover-card-note">{subject} isn't in the loaded lists any more.</p>}
    </>
  );
}

function SessionCard({ session, snapshot, seen }: { session: SessionInfo; snapshot: Snapshot; seen?: boolean }) {
  const home = /^\/Users\/[^/]+/;
  const state = !session.running
    ? `Exited${session.exitCode !== undefined ? ` (${session.exitCode})` : ''}`
    : session.status === 'done'
      // What the row's ✓ means, in words (item 146).
      ? `Done${session.statusAt ? `, ${age(new Date(session.statusAt).toISOString())}` : ''}${seen === false ? ', not opened yet' : ''}`
      : session.status
        ? STATE_TEXT[session.status]
        : session.attention ? 'Waiting for you' : 'Running';
  const matched = session.subject ? findSubject(session.subject, snapshot) : undefined;
  return (
    <>
      <SubjectPart subject={session.subject} fallback={sessionLabel(session)} snapshot={snapshot} />
      <div className="hover-card-rule" />
      {matched && <div className="hover-card-session">{sessionLabel(session)}</div>}
      <Line label="Agent">{session.runnerName}</Line>
      {session.shell && <Line label="Shell"><span className="mono">{session.shell}</span></Line>}
      <Line label="Folder"><span className="mono">{session.cwd.replace(home, '~')}</span></Line>
      <Line label="Started">{age(new Date(session.startedAt).toISOString())}</Line>
      <Line label="Now">{state}{session.hosted ? '' : ' · ends when Kovan quits'}</Line>
      <Line label="Cost"><SessionUsageChip id={session.id} /></Line>
    </>
  );
}

/** A Quick model job's card: the work it read, then the job. */
export function JobCard({ subject, kind, state, startedAt, snapshot }: {
  subject: string; kind: string; state: string; startedAt: number; snapshot: Snapshot;
}) {
  return (
    <>
      <SubjectPart subject={subject} fallback={subject} snapshot={snapshot} />
      <div className="hover-card-rule" />
      <Line label="Job">{kind}</Line>
      <Line label="Started">{age(new Date(startedAt).toISOString())}</Line>
      <Line label="Now">{state}</Line>
    </>
  );
}

export function SessionHoverCard({ anchor, session, snapshot, seen }: { anchor?: DOMRect; session: SessionInfo; snapshot: Snapshot; seen?: boolean }) {
  return <HoverCard anchor={anchor}><SessionCard session={session} snapshot={snapshot} seen={seen} /></HoverCard>;
}

/** Beside the row, kept inside the window; outside the sidebar's zoom and scroll. */
export function HoverCard({ anchor, children }: { anchor?: DOMRect; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number }>();
  useLayoutEffect(() => {
    if (!anchor || !card.current) { setPlace(undefined); return; }
    const box = card.current.getBoundingClientRect();
    const gap = 8;
    let left = anchor.right + gap;
    if (left + box.width > window.innerWidth - gap) left = Math.max(gap, anchor.left - box.width - gap);
    const top = Math.min(Math.max(gap, anchor.top), window.innerHeight - box.height - gap);
    setPlace({ top, left });
  }, [anchor]);
  if (!anchor) return null;
  return createPortal(
    <div
      ref={card}
      className="menu hover-card"
      role="tooltip"
      style={place ? { top: place.top, left: place.left } : { top: -9999, left: -9999 }}
    >
      {children}
    </div>,
    document.body
  );
}
