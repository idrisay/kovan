import { useEffect, useState } from 'react';
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
 * A session's name, its identifier's own open-in-its-tab icon, and the
 * pencil that renames it. Shared by the sidebar row and every pane's own
 * header, so all three work the same everywhere a session's name is shown.
 */
export function SessionName({
  session, snapshot, onOpenSubject, editing, onEdit, onRename, className
}: {
  session: SessionInfo;
  snapshot: Snapshot;
  onOpenSubject: (match: Selection) => void;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onRename: (id: string, title: string) => void;
  className: string;
}) {
  const [draft, setDraft] = useState(session.title);
  // What the row shows the instant you commit a rename, rather than however
  // long the round trip to main and back takes — renaming is a fire-and-
  // forget IPC call, and showing the old name for even one more frame after
  // you already typed and confirmed the new one reads as "it didn't work."
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    if (pending !== undefined && session.title === pending) setPending(undefined);
  }, [session.title, pending]);

  const displayTitle = pending ?? session.title;
  const { prefix, subject } = splitTitle({ ...session, title: displayTitle });
  const match = subject ? findSubject(subject, snapshot) : undefined;

  function commit() {
    const next = draft.trim();
    onEdit(false);
    if (next && next !== session.title) {
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
          else if (e.key === 'Escape') { setDraft(session.title); onEdit(false); }
        }}
      />
    );
  }

  return (
    <>
      <span className={className}>{prefix}{subject}</span>
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
        onClick={(e) => { e.stopPropagation(); setDraft(session.title); onEdit(true); }}
      >
        <EditIcon />
      </button>
    </>
  );
}
