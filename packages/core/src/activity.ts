/**
 * What changed between two polls that you'd want to hear about (item 86):
 * somebody asked for your review, your pull request was approved or sent back,
 * a new ticket is yours, or somebody commented on your pull request.
 *
 * Pure: it compares what was seen last time with what the poll just returned
 * and says what's new. Main keeps the result, shows it and notifies.
 *
 * Two rules keep it from crying wolf:
 *
 * - **A provider that didn't answer is not compared.** A failed GitHub poll
 *   publishes empty lists; compared naively, the next good poll would
 *   announce every review request you already had. Its part of `seen` is kept
 *   as it was instead.
 * - **The first answer only sets the baseline.** Nothing is reported until
 *   there is a previous answer from the same provider to compare with, and a
 *   burst bigger than `FLOOD` of one kind (a changed JQL, a new repository
 *   scope) re-baselines instead of reporting fifty "new" tickets.
 */

import type { PullSummary } from './github/pullStatus';
import type { JiraIssue } from './types';

export type ActivityKind =
  | 'review-requested'
  | 'approved'
  | 'changes-requested'
  | 'new-ticket'
  | 'new-comment';

export const ACTIVITY_KINDS: { kind: ActivityKind; label: string; setting: string; description: string }[] = [
  {
    kind: 'review-requested', label: 'Review requested', setting: 'activity.reviewRequested',
    description: 'Somebody asks you to review their pull request.'
  },
  {
    kind: 'approved', label: 'Approved', setting: 'activity.decisions',
    description: 'A reviewer approves one of your pull requests.'
  },
  {
    kind: 'changes-requested', label: 'Changes requested', setting: 'activity.decisions',
    description: 'A reviewer asks for changes on one of your pull requests.'
  },
  {
    kind: 'new-ticket', label: 'New ticket', setting: 'activity.newTicket',
    description: 'A ticket newly assigned to you appears in Tickets.'
  },
  {
    kind: 'new-comment', label: 'New comment', setting: 'activity.newComment',
    description: 'Somebody else comments on one of your pull requests.'
  }
];

export function activityLabel(kind: ActivityKind): string {
  return ACTIVITY_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

/** One thing that happened, as the inbox and a toast show it. */
export interface ActivityEvent {
  /** Unique and stable: the same happening polled twice is one event. */
  id: string;
  kind: ActivityKind;
  /** Epoch ms when Baton noticed it. */
  at: number;
  /** `owner/name#123` or `ACME-2485` — the same string sessions use. */
  subject: string;
  /** Short form for a row: `acme-frontend #2671`, `ACME-2485`. */
  label: string;
  title: string;
  /** Who did it, when known: the author asking, the commenter. */
  who?: string;
  url: string;
  read: boolean;
}

/** What the last poll looked like, as far as activity cares. Persisted. */
export interface ActivitySeen {
  /** Set once GitHub has answered at least once. */
  github?: {
    reviewRequested: string[];
    /** `repo#number` → review decision, for your own open pull requests. */
    decisions: Record<string, string>;
    /** `repo#number` → comment count, for your own open pull requests. */
    comments: Record<string, number>;
  };
  /** Set once Jira has answered at least once. */
  jira?: { tickets: string[] };
}

/** What one poll returned. A provider is absent when it didn't answer. */
export interface ActivityPoll {
  github?: { viewer: string; mine: readonly PullSummary[]; reviewRequested: readonly PullSummary[] };
  jira?: { tickets: readonly JiraIssue[] };
}

/** More than this many new things of one kind at once is a changed view, not news. */
export const FLOOD = 10;

const key = (pull: Pick<PullSummary, 'repo' | 'number'>) => `${pull.repo}#${pull.number}`;
const short = (pull: Pick<PullSummary, 'repo' | 'number'>) =>
  `${pull.repo.split('/').pop() || pull.repo} #${pull.number}`;
const sameLogin = (a?: string, b?: string) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

type Fresh = Omit<ActivityEvent, 'read'>;

export function diffActivity(
  seen: ActivitySeen,
  poll: ActivityPoll,
  now: number = Date.now()
): { events: Fresh[]; seen: ActivitySeen } {
  const events: Fresh[] = [];
  const next: ActivitySeen = { ...seen };

  if (poll.github) {
    const { viewer, mine, reviewRequested } = poll.github;
    const before = seen.github;
    const requested: Fresh[] = [];
    const decided: Fresh[] = [];
    const commented: Fresh[] = [];

    if (before) {
      const wasRequested = new Set(before.reviewRequested);
      for (const pull of reviewRequested) {
        if (wasRequested.has(key(pull))) continue;
        requested.push({
          id: `review-requested:${key(pull)}:${pull.updatedAt}`,
          kind: 'review-requested', at: now, subject: key(pull), label: short(pull),
          title: pull.title, who: pull.author, url: pull.url
        });
      }

      for (const pull of mine) {
        const id = key(pull);
        const was = before.decisions[id];
        // A pull request not seen before is newly yours: its state isn't news.
        if (was !== undefined && was !== pull.reviewDecision) {
          if (pull.reviewDecision === 'approved' || pull.reviewDecision === 'changes_requested') {
            const kind = pull.reviewDecision === 'approved' ? 'approved' : 'changes-requested';
            decided.push({
              id: `${kind}:${id}:${pull.updatedAt}`,
              kind, at: now, subject: id, label: short(pull), title: pull.title, url: pull.url
            });
          }
        }

        const count = pull.commentCount;
        const hadCount = before.comments[id];
        if (count !== undefined && hadCount !== undefined && count > hadCount &&
            !sameLogin(pull.lastCommenter, viewer)) {
          commented.push({
            id: `new-comment:${id}:${count}`,
            kind: 'new-comment', at: now, subject: id, label: short(pull), title: pull.title,
            ...(pull.lastCommenter ? { who: pull.lastCommenter } : {}),
            url: pull.url
          });
        }
      }
    }

    for (const batch of [requested, decided, commented]) {
      if (batch.length <= FLOOD) events.push(...batch);
    }

    next.github = {
      reviewRequested: reviewRequested.map(key),
      decisions: Object.fromEntries(mine.map((pull) => [key(pull), pull.reviewDecision])),
      comments: Object.fromEntries(
        mine.filter((pull) => pull.commentCount !== undefined).map((pull) => [key(pull), pull.commentCount!])
      )
    };
  }

  if (poll.jira) {
    const before = seen.jira;
    if (before) {
      const had = new Set(before.tickets);
      const fresh = poll.jira.tickets.filter((ticket) => !had.has(ticket.key));
      if (fresh.length <= FLOOD) {
        for (const ticket of fresh) {
          events.push({
            id: `new-ticket:${ticket.key}`,
            kind: 'new-ticket', at: now, subject: ticket.key, label: ticket.key,
            title: ticket.summary, url: ticket.url
          });
        }
      }
    }
    next.jira = { tickets: poll.jira.tickets.map((ticket) => ticket.key) };
  }

  return { events, seen: next };
}

/** How many events the inbox keeps; the oldest go first. */
export const ACTIVITY_KEEP = 200;

/**
 * New events on top of the inbox. An id already there is not added twice
 * (the same happening noticed by two polls), and the list is capped.
 */
export function addActivity(
  inbox: readonly ActivityEvent[],
  fresh: readonly Omit<ActivityEvent, 'read'>[]
): ActivityEvent[] {
  const known = new Set(inbox.map((event) => event.id));
  const added = fresh.filter((event) => !known.has(event.id)).map((event) => ({ ...event, read: false }));
  return [...added.reverse(), ...inbox].slice(0, ACTIVITY_KEEP);
}
