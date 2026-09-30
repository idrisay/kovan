import { useEffect, useState } from 'react';
import { pullMentionsTicket } from '@baton/core';
import type { JiraIssue, PullSummary, SentryIssue, SessionInfo, Snapshot } from './types';
import { EditIcon, OpenLinkIcon } from './icons';

export interface Selection { pull?: PullSummary; issue?: JiraIssue; sentry?: SentryIssue }

/**
 * A session's subject (`acme/acme-frontend#2738`, `ACME-2485`) resolved
 * back to whichever already-loaded pull request, ticket or Sentry issue it
 * names — the same string `Agents.subjectFor()` computed when the run
 * started. Only ever looks in the snapshot already on screen: there is no
 * per-subject fetch for a Sentry issue, and a pull or ticket that has since
 * scrolled out of every loaded window (merged and aged out, resolved) simply
 * has nothing to jump to, which is why this returns `undefined` instead of
 * guessing at one.
 */
export function findSubject(subject: string, snapshot: Snapshot): Selection | undefined {
  const hash = subject.lastIndexOf('#');
  if (hash > 0) {
    const repo = subject.slice(0, hash);
    const number = Number(subject.slice(hash + 1));
    if (!Number.isFinite(number)) return undefined;
    const pull = [
      ...snapshot.blocked, ...snapshot.mine, ...snapshot.reviewRequested, ...snapshot.merged
    ].find((p) => p.repo === repo && p.number === number);
    return pull ? { pull } : undefined;
  }
  const issue = snapshot.tickets.find((t) => t.key === subject);
  if (issue) return { issue };
  const sentry = snapshot.sentryIssues.find((s) => s.shortId === subject);
  return sentry ? { sentry } : undefined;
}

/**
 * Every pull request Baton has loaded that belongs to this ticket — the key
 * in its title or its branch — open ones first (blocked, yours, awaiting your
 * review), then merged ones, newest first. Each opens in Baton's own Pull
 * requests tab. Deduplicated: a pull request that is both "blocked on you"
 * and "yours" is one row, not two.
 */
export function findRelatedPulls(ticketKey: string, snapshot: Snapshot): PullSummary[] {
  const open = [...snapshot.blocked, ...snapshot.mine, ...snapshot.reviewRequested];
  const merged = [...snapshot.merged].sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));
  const seen = new Set<string>();
  const related: PullSummary[] = [];
  for (const pull of [...open, ...merged]) {
    const id = `${pull.repo}#${pull.number}`;
    if (seen.has(id) || !pullMentionsTicket(pull, ticketKey)) continue;
    seen.add(id);
    related.push(pull);
  }
  return related;
}

/**
 * A session's title is generated as `${kind} · ${subject}` for an agent run
 * and `Terminal — ${subject}` for a quick one — two different separators, so
 * rather than parse either format this just finds where the subject itself
 * sits inside the title it was built from, and splits there. Holds up even if
 * a title is later renamed to something with no subject in it at all.
 */
export function splitTitle(s: SessionInfo): { prefix: string; subject?: string } {
  if (!s.subject) return { prefix: s.title };
  const at = s.title.lastIndexOf(s.subject);
  if (at === -1) return { prefix: s.title };
  return { prefix: s.title.slice(0, at), subject: s.subject };
}

/**
 * What a session is called on screen: the title its program set, when it set
 * one (see `task` on `SessionInfo`), else the name it was opened with.
 */
export function sessionLabel(s: SessionInfo): string {
  return s.task ?? s.title;
}

/**
 * A session's name, its identifier's own open-in-its-tab icon, and the
 * pencil that renames it. Shared by the sidebar row and every pane's own
 * header, so all three work the same everywhere a session's name is shown.
 */
export function SessionName({
  session, snapshot, onOpenSubject, editing, onEdit, onRename, className, plainName
}: {
  session: SessionInfo;
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onRename: (id: string, title: string) => void;
  className: string;
  /** No tooltip of its own: the sidebar row shows a hover card instead (item 115). */
  plainName?: boolean;
}) {
  const [draft, setDraft] = useState(sessionLabel(session));
  // What the row shows the instant you commit a rename, rather than however
  // long the round trip to main and back takes — renaming is a fire-and-
  // forget IPC call, and showing the old name for even one more frame after
  // you already typed and confirmed the new one reads as "it didn't work."
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    if (pending !== undefined && session.title === pending) setPending(undefined);
  }, [session.title, pending]);

  const displayTitle = pending ?? sessionLabel(session);
  const { prefix, subject } = splitTitle({ ...session, title: displayTitle });
  const match = subject ? findSubject(subject, snapshot) : undefined;

  function commit() {
    const next = draft.trim();
    onEdit(false);
    if (next && next !== sessionLabel(session)) {
      setPending(next);
      onRename(session.id, next);
    }
  }

  if (editing) {
    return (
      <input
        className="rename-input"
        autoFocus
        value={draft}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { setDraft(sessionLabel(session)); onEdit(false); }
        }}
      />
    );
  }

  return (
    <>
      <span className={className} title={plainName ? undefined : session.task ? `${session.task}\nOpened as ${session.title}` : displayTitle}>
        {prefix}{subject}
      </span>
      {match && (
        <button
          type="button"
          className="icon-button open-link"
          aria-label={`Open ${subject}`}
          title={`Open ${subject}`}
          onClick={(e) => { e.stopPropagation(); onOpenSubject(match); }}
        >
          <OpenLinkIcon />
        </button>
      )}
      <button
        type="button"
        className="icon-button rename"
        aria-label="Rename session"
        title="Rename session"
        onClick={(e) => { e.stopPropagation(); setDraft(sessionLabel(session)); onEdit(true); }}
      >
        <EditIcon />
      </button>
    </>
  );
}
