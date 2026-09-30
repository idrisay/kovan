/**
 * The full picture of one pull request.
 *
 * Deliberately separate from the queue query: this costs a round trip and is
 * only wanted when somebody opens a row, while the queues are fetched every
 * refresh for everything. Putting the review threads in the queue query would
 * make the poll several times more expensive for data nobody is looking at.
 */

import type { CancelSignal } from '@kovan/host';
import { graphqlEndpoint } from '@kovan/core';
import type { HttpClient } from '../http';

export interface ReviewComment {
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  url: string;
  /**
   * Set only when this is a review's own written comment (the text that
   * came with an approve/request-changes/comment), not a plain issue
   * comment — lets the conversation badge it the way GitHub does.
   */
  reviewState?: 'approved' | 'changes_requested' | 'commented';
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number;
  comments: ReviewComment[];
}

export interface CheckRun {
  name: string;
  status: 'pending' | 'success' | 'failure' | 'neutral';
  url?: string;
}

/** Whose turn it is because of what this reviewer last did. */
export type ReviewerTurn = 'pending' | 'changes_requested' | 'approved';

export interface Reviewer {
  login: string;
  turn: ReviewerTurn;
  /** When they last submitted a review. Absent for a request nobody has answered. */
  submittedAt?: string;
  /** Asked again after answering (item 106): what they said last time. The
   *  turn is then 'pending' — the ball is back with them. */
  previous?: 'changes_requested' | 'approved';
}

export interface PullDetail {
  number: number;
  repo: string;
  title: string;
  url: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Review threads, unresolved first — those are what is blocking. */
  threads: ReviewThread[];
  /** Top-level conversation, which is not the same as review threads. */
  comments: ReviewComment[];
  checks: CheckRun[];
  files: { path: string; additions: number; deletions: number; status: string }[];
  /**
   * One row per reviewer, most in need of attention first: still-open
   * requests, then whoever answered most recently. A reviewer who only left
   * comments — never approved or asked for changes — has no opinion recorded
   * here, so they don't appear.
   */
  reviewers: Reviewer[];
}

const DETAIL_QUERY = `
query KovanPullDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url body additions deletions changedFiles
      author { login }
      baseRefName headRefName
      comments(last: 50) {
        nodes { author { login } body createdAt url }
      }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated
          comments(first: 50) {
            nodes { author { login } body createdAt path line url }
          }
        }
      }
      files(first: 100) {
        nodes { path additions deletions changeType }
      }
      reviewRequests(first: 30) {
        nodes { requestedReviewer { ... on User { login } } }
      }
      latestOpinionatedReviews(first: 30) {
        nodes { author { login } state submittedAt }
      }
      reviews(first: 50) {
        nodes { author { login } state body submittedAt createdAt url }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 50) {
                nodes {
                  ... on CheckRun { name conclusion status detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface RawComment {
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
  path?: string | null;
  line?: number | null;
  url?: string;
}

function comment(raw: RawComment | null): ReviewComment | undefined {
  if (!raw) return undefined;
  return {
    author: raw.author?.login ?? 'unknown',
    body: raw.body ?? '',
    createdAt: raw.createdAt ?? '',
    path: raw.path ?? undefined,
    line: raw.line ?? undefined,
    url: raw.url ?? ''
  };
}

/** GraphQL reports CheckRun and StatusContext differently; both mean "a check". */
function checkFrom(node: Record<string, unknown>): CheckRun | undefined {
  if (typeof node['name'] === 'string') {
    const status = node['status'] === 'COMPLETED' ? conclusion(node['conclusion']) : 'pending';
    return { name: node['name'], status, url: (node['detailsUrl'] as string) ?? undefined };
  }
  if (typeof node['context'] === 'string') {
    return {
      name: node['context'],
      status: conclusion(node['state']),
      url: (node['targetUrl'] as string) ?? undefined
    };
  }
  return undefined;
}

function conclusion(value: unknown): CheckRun['status'] {
  switch (String(value).toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
    case 'TIMED_OUT':
    case 'CANCELLED':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
    case 'IN_PROGRESS':
    case 'QUEUED':
      return 'pending';
    default:
      return 'neutral';
  }
}

export async function fetchPullDetail(
  http: HttpClient,
  baseUrl: string,
  token: string,
  repo: string,
  number: number,
  signal?: CancelSignal
): Promise<PullDetail> {
  const [owner, name] = repo.split('/');
  const response = await http.json<{
    data?: { repository?: { pullRequest?: Record<string, any> } };
    errors?: { message: string }[];
  }>(graphqlEndpoint(baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: { query: DETAIL_QUERY, variables: { owner, name, number } },
    signal
  });

  // GraphQL answers 200 with an `errors` array, so a bad token or a missing
  // scope arrives looking like success unless it is checked here.
  if (response.errors?.length) {
    throw new Error(response.errors.map((e) => e.message).join('; '));
  }
  const pull = response.data?.repository?.pullRequest;
  if (!pull) {
    throw new Error(`${repo}#${number} not found`);
  }

  const threads: ReviewThread[] = (pull['reviewThreads']?.nodes ?? [])
    .filter(Boolean)
    .map((thread: any) => {
      const comments = (thread.comments?.nodes ?? [])
        .map(comment)
        .filter((c: ReviewComment | undefined): c is ReviewComment => Boolean(c));
      return {
        id: thread.id,
        isResolved: Boolean(thread.isResolved),
        isOutdated: Boolean(thread.isOutdated),
        path: comments[0]?.path,
        line: comments[0]?.line,
        comments
      };
    })
    // Unresolved first: those are what is blocking, and a long list of
    // resolved threads above them buries the reason you opened this.
    .sort((a: ReviewThread, b: ReviewThread) => Number(a.isResolved) - Number(b.isResolved));

  const checkNodes =
    pull['commits']?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

  const answered: Reviewer[] = (pull['latestOpinionatedReviews']?.nodes ?? [])
    .filter(Boolean)
    .map((review: any) => ({
      login: review.author?.login ?? 'unknown',
      turn: review.state === 'CHANGES_REQUESTED' ? 'changes_requested' : 'approved',
      submittedAt: review.submittedAt ?? undefined
    }))
    // Most recently answered first, so a fresh "changes requested" isn't
    // buried under an approval from days earlier.
    .sort((a: Reviewer, b: Reviewer) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));

  // What a reviewer actually wrote, not just the state it left them in — an
  // approve or request-changes with no comment attached is already covered
  // by the reviewer roster, so only the ones with something to say join the
  // conversation.
  const reviewComments: ReviewComment[] = (pull['reviews']?.nodes ?? [])
    .filter(Boolean)
    .filter((r: any) => typeof r.body === 'string' && r.body.trim().length > 0)
    .map((r: any) => ({
      author: r.author?.login ?? 'unknown',
      body: r.body,
      createdAt: r.submittedAt ?? r.createdAt ?? '',
      url: r.url ?? '',
      reviewState:
        r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes_requested' : 'commented'
    }));

  const fold = (login: string) => login.toLowerCase();
  const requested: string[] = (pull['reviewRequests']?.nodes ?? [])
    .filter(Boolean)
    .map((req: any) => req.requestedReviewer?.login as string | undefined)
    .filter((login: string | undefined): login is string => Boolean(login));
  const requestedLogins = new Set(requested.map(fold));
  // A re-request (item 106) is GitHub's "I've addressed it, look again": the
  // reviewer is back in the review requests while their old review still
  // stands. That makes it their turn, as GitHub itself shows it, so the
  // request wins over the answer it follows — it used to be the other way
  // round, which left "Your turn" on a pull request you'd already updated.
  const answeredLogins = new Set(answered.map((r) => fold(r.login)));
  const rerequested = answered
    .filter((r) => requestedLogins.has(fold(r.login)))
    .map((r): Reviewer => ({
      login: r.login, turn: 'pending',
      previous: r.turn === 'changes_requested' ? 'changes_requested' : 'approved',
      ...(r.submittedAt ? { submittedAt: r.submittedAt } : {})
    }));
  const pending: Reviewer[] = [
    ...requested.filter((login) => !answeredLogins.has(fold(login))).map((login) => ({ login, turn: 'pending' as const })),
    ...rerequested
  ];
  const stillStanding = answered.filter((r) => !requestedLogins.has(fold(r.login)));

  return {
    number: pull['number'],
    repo,
    title: pull['title'] ?? '',
    url: pull['url'] ?? '',
    body: pull['body'] ?? '',
    author: pull['author']?.login ?? 'unknown',
    baseRef: pull['baseRefName'] ?? '',
    headRef: pull['headRefName'] ?? '',
    additions: pull['additions'] ?? 0,
    deletions: pull['deletions'] ?? 0,
    changedFiles: pull['changedFiles'] ?? 0,
    threads,
    // Issue comments and written reviews are two different GitHub objects
    // but one timeline to a reader, so they're merged here in the order
    // they actually happened.
    comments: [
      ...(pull['comments']?.nodes ?? [])
        .map(comment)
        .filter((c: ReviewComment | undefined): c is ReviewComment => Boolean(c)),
      ...reviewComments
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    checks: checkNodes.map(checkFrom).filter(Boolean) as CheckRun[],
    files: (pull['files']?.nodes ?? []).filter(Boolean).map((f: any) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      status: String(f.changeType ?? '').toLowerCase()
    })),
    reviewers: [...pending, ...stillStanding]
  };
}

/**
 * A pull request's unified diff, as text — what the Kimi K3 review reads.
 * The REST endpoint with the diff media type; GraphQL has no diff at all.
 * Allowed a long timeout: a big PR's diff is megabytes.
 */
export async function fetchPullDiff(
  http: HttpClient,
  baseUrl: string,
  token: string,
  repo: string,
  number: number
): Promise<string> {
  const { bytes } = await http.binary(`${baseUrl.replace(/\/$/, '')}/repos/${repo}/pulls/${number}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3.diff' },
    timeoutMs: 60_000
  });
  return new TextDecoder().decode(bytes);
}

/**
 * Posts a review on a pull request — approve, request changes, or a plain
 * comment. Only ever called from a click the user confirmed; `mutating` so the
 * HTTP client never dedupes or replays it.
 */
export async function submitPullReview(
  http: HttpClient,
  baseUrl: string,
  token: string,
  repo: string,
  number: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body: string
): Promise<{ url?: string }> {
  const review = await http.json<{ html_url?: string }>(
    `${baseUrl.replace(/\/$/, '')}/repos/${repo}/pulls/${number}/reviews`,
    {
      method: 'POST',
      mutating: true,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      body: { event, body }
    }
  );
  return { url: review?.html_url };
}
