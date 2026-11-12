/**
 * Everything about how a pull request's state is derived and presented, kept
 * free of both `vscode` and the network so it can be unit tested.
 */

export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'none';
export type CheckRollup = 'success' | 'failure' | 'pending' | 'neutral' | 'none';

/** A pull request as it appears in the "mine" and "awaiting my review" lists. */
export interface PullSummary {
  number: number;
  title: string;
  url: string;
  /** `owner/name`. */
  repo: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergeable: Mergeable;
  reviewDecision: ReviewDecision;
  checks: CheckRollup;
  unresolvedThreads: number;
  additions: number;
  deletions: number;
  /** True when the viewer has already submitted a review on this PR. */
  viewerReviewed: boolean;
  /**
   * When it merged, or absent on an open one.
   *
   * The merged queue is ordered on this rather than on `updatedAt`: a comment
   * left on something that shipped last month should not push it back above
   * what shipped this morning.
   */
  mergedAt?: string;
  /** The branch it merges from — where a ticket key usually is (`fix/ACME-2409-…`). */
  headRef?: string;
  /**
   * Every comment on it: the conversation's plus those in review threads on
   * the code. Only rises, so a rise is "somebody said something" (item 86).
   * Absent when the query didn't ask.
   */
  commentCount?: number;
  /** Who wrote the most recent of those, and when — so your own comment isn't news to you. */
  lastCommenter?: string;
  lastCommentAt?: string;
  /**
   * When the most recent of those is a review, what kind: an approval is
   * counted with the comments but isn't one (item 130). Unset when it is a
   * conversation comment.
   */
  lastReviewState?: ApiReviewState;
}

/** A review's `state` as GitHub's GraphQL API spells it. */
export type ApiReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export type PullFlagId =
  | 'merged'
  | 'conflict'
  | 'changes-requested'
  | 'checks-failing'
  | 'unresolved'
  | 'approved'
  | 'checks-pending'
  | 'awaiting-review'
  | 'draft'
  /** None of the above: open, with nothing to say about it. Only `primaryFlag` returns it. */
  | 'open';

export interface PullFlag {
  id: PullFlagId;
  label: string;
  icon: string;
  color?: string;
  /** What the label means, in a sentence — the tooltip, for the ones a word can't explain. */
  hint?: string;
}

/**
 * Just the fields the flags are derived from. Everything that reasons about a
 * pull request's state takes this rather than a whole `PullSummary`, so the
 * prompt renderers can ask for the state of a pull request without pretending
 * to hold one.
 */
export type PullState = Pick<
  PullSummary,
  'mergeable' | 'reviewDecision' | 'checks' | 'unresolvedThreads' | 'isDraft'
> & Partial<Pick<PullSummary, 'mergedAt'>>;

/** Whether it has already shipped. */
export function isMerged(pull: Pick<PullState, 'mergedAt'>): boolean {
  return Boolean(pull.mergedAt);
}

/**
 * The flags that stop a pull request merging, as opposed to the ones that
 * merely describe where it has got to. A row may drop "3 unresolved" or "Draft"
 * when it runs out of space; it may never drop one of these, because they are
 * the reason you would go and look at the pull request at all.
 */
const BLOCKING: ReadonlySet<PullFlagId> = new Set<PullFlagId>([
  'conflict',
  'changes-requested',
  'checks-failing'
]);

function isBlocking(flag: PullFlag): boolean {
  return BLOCKING.has(flag.id);
}

/** Whether the pull request needs work before it can merge. */
export function isBlocked(pull: PullState): boolean {
  return pullFlags(pull).some(isBlocking);
}

/**
 * The states a pull request is in, most actionable first.
 *
 * Order is the whole point: a PR is usually in several of these at once, and
 * the first one decides the row's icon. Conflicts lead because they block
 * every other outcome — an approved PR that won't merge still needs a rebase
 * before anything else can happen to it.
 */
export function pullFlags(pull: PullState): PullFlag[] {
  const flags: PullFlag[] = [];

  // Merged ends the story, so it is the whole story. Everything below asks
  // what is stopping this from merging, and GitHub keeps answering after the
  // fact — a merged pull request still reports `review_required` if nobody
  // ever reviewed it, and "Awaiting review" on something that shipped last
  // week is not a stale label, it is a false one.
  if (isMerged(pull)) {
    return [{ id: 'merged', label: 'Merged', icon: 'git-merge', color: 'charts.purple' }];
  }

  if (pull.mergeable === 'conflicting') {
    flags.push({ id: 'conflict', label: 'Conflicts', icon: 'git-merge', color: 'charts.red' });
  }
  if (pull.reviewDecision === 'changes_requested') {
    flags.push({
      id: 'changes-requested',
      label: 'Changes requested',
      icon: 'request-changes',
      color: 'charts.orange'
    });
  }
  if (pull.checks === 'failure') {
    flags.push({ id: 'checks-failing', label: 'Checks failing', icon: 'error', color: 'charts.red' });
  }
  if (pull.unresolvedThreads > 0) {
    const n = pull.unresolvedThreads;
    flags.push({
      id: 'unresolved',
      label: `${n} unresolved ${n === 1 ? 'comment' : 'comments'}`,
      icon: 'comment-unresolved',
      color: 'charts.orange',
      hint:
        `${n === 1 ? 'A review comment thread' : `${n} review comment threads`} on the code that ` +
        `nobody has marked resolved yet. Reply or fix, then resolve ${n === 1 ? 'it' : 'them'} on GitHub.`
    });
  }
  if (pull.reviewDecision === 'approved') {
    flags.push({ id: 'approved', label: 'Approved', icon: 'check', color: 'charts.green' });
  }
  if (pull.checks === 'pending') {
    flags.push({ id: 'checks-pending', label: 'Checks running', icon: 'sync~spin' });
  }
  // A draft isn't waiting on anyone, so "awaiting review" would be a lie.
  if (pull.reviewDecision === 'review_required' && !pull.isDraft) {
    flags.push({ id: 'awaiting-review', label: 'Awaiting review', icon: 'eye', color: 'charts.blue' });
  }
  if (pull.isDraft) {
    flags.push({
      id: 'draft',
      label: 'Draft',
      icon: 'git-pull-request-draft',
      color: 'descriptionForeground'
    });
  }

  return flags;
}

/**
 * Its own id, not a borrowed one. It used to be `awaiting-review`, which would
 * colour a pull request nobody has been asked to review as if somebody had.
 */
const PLAIN_OPEN: PullFlag = {
  id: 'open',
  label: 'Open',
  icon: 'git-pull-request',
  hint: 'Open, with no review decision, no checks and no conflicts to report.'
};

/**
 * The flag that drives the row icon and the detail pane's pill. Never
 * undefined, so callers stay simple — use this, not `pullFlags(pull)[0]`: a
 * pull request with no review rule, no checks and no conflicts has no flags at
 * all, and indexing into that empty list is what blanked the whole window.
 */
export function primaryFlag(pull: PullState): PullFlag {
  return pullFlags(pull)[0] ?? PLAIN_OPEN;
}

/**
 * The pull request's state as words.
 *
 * `max` caps how many flags are named, for the row description — five of them
 * at once is more than the row can show, and they are pushed in order of what
 * you would want to know first.
 *
 * The cap is a budget for the *informational* flags only. A blocking one —
 * conflicts, changes requested, failing checks — is never dropped to stay
 * under it, because a row that says "Conflicts · Changes requested" while
 * quietly omitting that the tests are also failing is worse than a row that
 * runs long: it reads as a complete account and isn't one.
 *
 * What survives is chosen first and then read back off `pullFlags` in its
 * order, rather than being concatenated blocking-first. Today those two are
 * the same list, because the blocking flags are also the first three pushed —
 * but that is a coincidence of the current order, and a fourth blocking flag
 * added further down would otherwise jump the queue silently.
 */
export function describePull(pull: PullState, max = Number.POSITIVE_INFINITY): string {
  const flags = pullFlags(pull);
  const blocking = flags.filter(isBlocking);
  const budget = Math.max(max - blocking.length, blocking.length > 0 ? 0 : 1);
  const keep = new Set([...blocking, ...flags.filter((f) => !isBlocking(f)).slice(0, budget)]);
  const kept = flags.filter((flag) => keep.has(flag));
  return kept.length > 0 ? kept.map((f) => f.label).join(' · ') : 'Open';
}

/**
 * Row form of an age: "14m ago". "just now" is already a phrase and stays as
 * one.
 */
export function ageLabel(iso: string, now?: number): string | undefined {
  const age = formatAge(iso, now);
  return age === undefined || age === 'just now' ? age : `${age} ago`;
}

/**
 * Compact age, for showing how long a review request has been sitting there.
 * Anything under a minute reads as "just now" rather than "0m".
 */
export function formatAge(iso: string, now: number = Date.now()): string | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`;
}

export type PullSort = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc';

export const DEFAULT_PULL_SORT: PullSort = 'updated-desc';

export const PULL_SORTS: {
  key: PullSort;
  label: string;
  description: string;
  short: string;
}[] = [
  {
    key: 'updated-desc',
    label: 'Recently updated',
    description: 'Newest activity first',
    short: 'Updated'
  },
  {
    key: 'updated-asc',
    label: 'Least recently updated',
    description: 'Stalest first',
    short: 'Stalest'
  },
  { key: 'created-desc', label: 'Newest', description: 'Most recently opened first', short: 'Newest' },
  { key: 'created-asc', label: 'Oldest', description: 'Open the longest first', short: 'Oldest' }
];

export function isPullSort(value: unknown): value is PullSort {
  return PULL_SORTS.some((s) => s.key === value);
}

export function pullSortLabel(sort: PullSort): string {
  const match = PULL_SORTS.find((s) => s.key === sort);
  return match ? `${match.label} · ${match.description}` : sort;
}

/** Terse form for the view header, where there is only room for a word. */
export function pullSortShortLabel(sort: PullSort): string {
  return PULL_SORTS.find((s) => s.key === sort)?.short ?? sort;
}

function millis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortPulls(pulls: readonly PullSummary[], sort: PullSort): PullSummary[] {
  // Repo then number as the tie-break, so equal timestamps produce a stable
  // order instead of shuffling between refreshes.
  const stable = (a: PullSummary, b: PullSummary) =>
    a.repo.localeCompare(b.repo) || a.number - b.number;

  const comparators: Record<PullSort, (a: PullSummary, b: PullSummary) => number> = {
    'updated-desc': (a, b) => millis(b.updatedAt) - millis(a.updatedAt) || stable(a, b),
    'updated-asc': (a, b) => millis(a.updatedAt) - millis(b.updatedAt) || stable(a, b),
    'created-desc': (a, b) => millis(b.createdAt) - millis(a.createdAt) || stable(a, b),
    'created-asc': (a, b) => millis(a.createdAt) - millis(b.createdAt) || stable(a, b)
  };

  return [...pulls].sort(comparators[sort]);
}

// --- Wire-format translation -------------------------------------------------

export function mergeableFromApi(value: string | null | undefined): Mergeable {
  switch (value) {
    case 'MERGEABLE':
      return 'mergeable';
    case 'CONFLICTING':
      return 'conflicting';
    default:
      // Includes 'UNKNOWN': GitHub computes mergeability lazily and reports
      // UNKNOWN on the first ask while it works it out.
      return 'unknown';
  }
}

export function reviewDecisionFromApi(value: string | null | undefined): ReviewDecision {
  switch (value) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return 'none';
  }
}

/** GraphQL `statusCheckRollup.state`. */
export function checksFromRollup(value: string | null | undefined): CheckRollup {
  switch (value) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

/**
 * One entry of `statusCheckRollup.contexts`: a GitHub Actions (or app) check
 * run, or a commit status posted through the statuses API.
 */
export interface ApiCheckContext {
  name?: string;
  status?: string | null;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  detailsUrl?: string | null;
  checkSuite?: { workflowRun?: { workflow?: { name?: string | null } | null } | null } | null;
  context?: string;
  state?: string | null;
  targetUrl?: string | null;
}

/** A check context's own state, from GraphQL's upper-case enums. */
export function checkContextStatus(node: ApiCheckContext): 'pending' | 'success' | 'failure' | 'neutral' {
  if (typeof node.name === 'string' && node.status !== 'COMPLETED') return 'pending';
  switch (String(node.conclusion ?? node.state ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
    case 'TIMED_OUT':
    case 'CANCELLED':
    case 'STARTUP_FAILURE':
    case 'ACTION_REQUIRED':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
    case 'IN_PROGRESS':
    case 'QUEUED':
    case 'WAITING':
    case 'REQUESTED':
      return 'pending';
    default:
      return 'neutral';
  }
}

/**
 * The checks that still count: the newest run of each check (item 170).
 *
 * A workflow that runs on more than one event (a migration gate that runs on
 * `pull_request` and again on `pull_request_review`) leaves a run per event on
 * the same commit. GitHub's own `statusCheckRollup.state` counts all of them,
 * so a gate that failed before the approvals and passed after them still
 * reads FAILURE, and the pull request sat in "Blocked on you" though nothing
 * was left to do. GitHub's merge box, like a required check, goes by the
 * newest run; so does this. Runs are told apart by workflow and job name, so
 * two workflows that happen to name a job alike stay two checks. A commit
 * status is already only its newest state per context.
 */
export function currentCheckContexts<T extends ApiCheckContext>(nodes: readonly (T | null | undefined)[]): T[] {
  const newest = new Map<string, T>();
  const order: string[] = [];
  for (const node of nodes) {
    if (!node) continue;
    let key: string;
    if (typeof node.name === 'string') {
      key = `run\u0000${node.checkSuite?.workflowRun?.workflow?.name ?? ''}\u0000${node.name}`;
    } else if (typeof node.context === 'string') {
      key = `status\u0000${node.context}`;
    } else {
      continue;
    }
    const held = newest.get(key);
    if (!held) {
      order.push(key);
      newest.set(key, node);
    } else if (startOf(node) >= startOf(held)) {
      newest.set(key, node);
    }
  }
  return order.map((key) => newest.get(key)!);
}

/** When a run started; a queued run has no start yet and is the newest. */
function startOf(node: ApiCheckContext): string {
  if (typeof node.name !== 'string') return '';
  return node.startedAt ?? node.completedAt ?? '\uffff';
}

/** `comments(last: 1) { totalCount nodes { author createdAt } }` */
export interface ApiCommentPage {
  totalCount?: number;
  nodes?: ({ author?: { login?: string } | null; createdAt?: string } | null)[] | null;
}

/** `reviews(last: 1) { totalCount nodes { author submittedAt state } }` */
export interface ApiReviewPage {
  totalCount?: number;
  nodes?: ({ author?: { login?: string } | null; submittedAt?: string; state?: ApiReviewState } | null)[] | null;
}

/**
 * How much has been said on a pull request, and who said the latest of it:
 * conversation comments plus reviews (a reply in a code thread is posted as a
 * review). Undefined when the query didn't ask — only your own pull requests'
 * search does, because asking costs points (item 92).
 */
function commentsOf(node: ApiPullNode): Pick<PullSummary, 'commentCount' | 'lastCommenter' | 'lastCommentAt' | 'lastReviewState'> {
  if (!node.comments && !node.reviews) return {};
  const newestComment = node.comments?.nodes?.[node.comments.nodes.length - 1];
  const newestReview = node.reviews?.nodes?.[node.reviews.nodes.length - 1];
  type Said = { author: string; at: string; review?: ApiReviewState };
  const candidates = [
    newestComment?.createdAt ? { author: newestComment.author?.login ?? '', at: newestComment.createdAt } : undefined,
    newestReview?.submittedAt
      ? { author: newestReview.author?.login ?? '', at: newestReview.submittedAt, review: newestReview.state ?? 'COMMENTED' }
      : undefined
  ].filter((c): c is Said => Boolean(c));
  const last = candidates.sort((a, b) => a.at.localeCompare(b.at)).pop();
  return {
    commentCount: (node.comments?.totalCount ?? 0) + (node.reviews?.totalCount ?? 0),
    ...(last ? { lastCommenter: last.author, lastCommentAt: last.at } : {}),
    ...(last?.review ? { lastReviewState: last.review } : {})
  };
}

/** One `PullRequest` node as the GraphQL query asks for it. */
export interface ApiPullNode {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string | null;
  headRefName?: string | null;
  additions: number;
  deletions: number;
  mergeable?: string | null;
  reviewDecision?: string | null;
  author?: { login?: string } | null;
  repository?: { nameWithOwner?: string } | null;
  viewerLatestReview?: { state?: string } | null;
  latestOpinionatedReviews?: {
    nodes?: ({ state?: string; author?: { login?: string } | null } | null)[] | null;
  } | null;
  reviewRequests?: {
    nodes?: ({ requestedReviewer?: { login?: string } | null } | null)[] | null;
  } | null;
  reviewThreads?: { nodes?: ({ isResolved?: boolean } | null)[] | null } | null;
  comments?: ApiCommentPage | null;
  reviews?: ApiReviewPage | null;
  commits?: {
    nodes?: ({
      commit?: {
        statusCheckRollup?: {
          state?: string;
          contexts?: {
            pageInfo?: { hasNextPage?: boolean } | null;
            nodes?: (ApiCheckContext | null)[] | null;
          } | null;
        } | null;
      };
    } | null)[] | null;
  } | null;
}

type ApiRollup = NonNullable<NonNullable<NonNullable<NonNullable<ApiPullNode['commits']>['nodes']>[number]>['commit']>['statusCheckRollup'];

/**
 * The pull request's checks from the newest run of each (item 170). Falls back
 * to GitHub's own state when the runs weren't asked for, or there were more
 * than one page of them: judging from part of the list could call a failing
 * pull request green.
 */
function checksOf(rollup: ApiRollup | undefined): CheckRollup {
  const contexts = rollup?.contexts;
  const nodes = contexts?.nodes;
  if (!nodes || nodes.length === 0 || contexts?.pageInfo?.hasNextPage) return checksFromRollup(rollup?.state);
  return rollUpChecks(currentCheckContexts(nodes).map(checkContextStatus));
}

export function summaryFromApi(node: ApiPullNode): PullSummary {
  const threads = node.reviewThreads?.nodes ?? [];
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;

  return {
    number: node.number,
    title: node.title,
    url: node.url,
    repo: node.repository?.nameWithOwner ?? '',
    author: node.author?.login ?? 'unknown',
    isDraft: Boolean(node.isDraft),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergeable: mergeableFromApi(node.mergeable),
    reviewDecision: decisionFromNode(node),
    checks: checksOf(rollup),
    unresolvedThreads: threads.filter((t) => t && t.isResolved === false).length,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    viewerReviewed: Boolean(node.viewerLatestReview?.state),
    // Left off rather than set to undefined: the field is optional, and an
    // explicit `mergedAt: undefined` survives a structuredClone over IPC as a
    // present key, which `'mergedAt' in pull` would then believe.
    ...(node.mergedAt ? { mergedAt: node.mergedAt } : {}),
    ...(node.headRefName ? { headRef: node.headRefName } : {}),
    ...commentsOf(node)
  };
}

export interface ReviewLike {
  state: string;
  submitted_at: string;
  user?: { login?: string } | null;
}

/** GitHub logins differ only in case, so compare them folded. */
function sameLogin(login: string | null | undefined): string {
  return (login ?? '').toLowerCase();
}

/** The reviewers still being waited on, from either wire format. */
function pendingReviewersOf(node: ApiPullNode): string[] {
  return (node.reviewRequests?.nodes ?? [])
    .map((request) => request?.requestedReviewer?.login)
    .filter((login): login is string => Boolean(login));
}

/**
 * The verdicts that still stand, once the ones a re-request has superseded are
 * dropped.
 *
 * GitHub only lists a reviewer as requested while the request is outstanding —
 * it drops them the moment they submit — so a reviewer who has both a verdict
 * on record and a request outstanding has been asked again since, and their
 * old verdict is no longer what the pull request is waiting on.
 */
function standingVerdicts(
  verdicts: readonly { author: string; state: string }[],
  pendingReviewers: readonly string[]
): string[] {
  const pending = new Set(pendingReviewers.map(sameLogin));
  return verdicts.filter((v) => !pending.has(sameLogin(v.author))).map((v) => v.state);
}

/**
 * The pull request's decision, corrected for re-requested reviews.
 *
 * GitHub leaves `reviewDecision` at CHANGES_REQUESTED after the author
 * re-requests the reviewer who asked for the changes: it only clears when that
 * reviewer submits a new review, or the old one is dismissed outright. The ball
 * is back in the reviewer's court, though, so a row that still says "Changes
 * requested" is reporting work that has already been done.
 *
 * Otherwise GitHub's decision stands, because it is the only side that knows
 * the branch's protection rules — how many approvals are required, and whose
 * count. Except when it has none: a repository without a "require a review"
 * rule always answers null (item 134), even with an approval in and reviewers
 * asked. Then the reviews themselves decide, the way GitHub's own page reads
 * them, so such a pull request says "Approved" or "Awaiting review" like one
 * from a protected repository instead of a bare "Open".
 */
function decisionFromNode(node: ApiPullNode): ReviewDecision {
  const decision = reviewDecisionFromApi(node.reviewDecision);
  const verdicts = (node.latestOpinionatedReviews?.nodes ?? [])
    .filter((review): review is { state?: string; author?: { login?: string } | null } =>
      Boolean(review)
    )
    .map((review) => ({ author: review.author?.login ?? '', state: review.state ?? '' }));
  if (decision === 'none' && node.reviewDecision == null) {
    return decisionFromVerdicts(verdicts, pendingReviewersOf(node));
  }
  if (decision !== 'changes_requested') {
    return decision;
  }
  if (verdicts.length === 0) {
    // Either the query didn't ask for them or GitHub didn't say; with nothing
    // to reason from, its own decision stands.
    return decision;
  }
  const standing = standingVerdicts(verdicts, pendingReviewersOf(node));
  return standing.includes('CHANGES_REQUESTED') ? 'changes_requested' : 'review_required';
}

/**
 * Collapses a review list into one decision, the way GitHub's own branch rules
 * do: only a reviewer's latest review counts, and a bare comment is not a
 * verdict. Used for the current-branch PR, which comes from REST and so has no
 * `reviewDecision` field of its own.
 *
 * `pendingReviewers` are the logins with a review request outstanding; a
 * verdict from one of them has been superseded by a fresh request and no longer
 * counts, the same correction `decisionFromNode` makes on the GraphQL side.
 */
export function reviewDecisionFrom(
  reviews: readonly ReviewLike[],
  pendingReviewers: readonly string[] = []
): ReviewDecision {
  const latestByUser = new Map<string, string>();
  for (const review of [...reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) {
    if (review.state !== 'COMMENTED') {
      latestByUser.set(sameLogin(review.user?.login), review.state);
    }
  }
  return decisionFromVerdicts([...latestByUser].map(([author, state]) => ({ author, state })), pendingReviewers);
}

/** Each reviewer's latest verdict, plus who is still asked, as one decision. */
function decisionFromVerdicts(
  verdicts: readonly { author: string; state: string }[],
  pendingReviewers: readonly string[]
): ReviewDecision {
  const standing = standingVerdicts(verdicts, pendingReviewers);
  if (standing.includes('CHANGES_REQUESTED')) {
    return 'changes_requested';
  }
  if (standing.includes('APPROVED')) {
    return 'approved';
  }
  if (standing.length > 0) {
    return 'review_required';
  }
  // Nothing stands: either someone has been asked and not answered yet, or
  // every verdict on record has been superseded by a fresh request. Both are
  // the pull request waiting on a reviewer.
  return verdicts.length > 0 || pendingReviewers.length > 0 ? 'review_required' : 'none';
}

export interface CheckRunLike {
  status: string;
  conclusion?: string | null;
}

/** REST check-run status, for the current-branch PR's per-check rows. */
export function checkRunStatus(run: CheckRunLike): 'pending' | 'success' | 'failure' | 'neutral' {
  if (run.status !== 'completed') {
    return 'pending';
  }
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
      return 'failure';
    default:
      return 'neutral';
  }
}

/** Worst-case roll-up of individual check runs: one failure fails the set. */
export function rollUpChecks(
  states: readonly ('pending' | 'success' | 'failure' | 'neutral')[]
): CheckRollup {
  if (states.length === 0) {
    return 'none';
  }
  if (states.includes('failure')) {
    return 'failure';
  }
  if (states.includes('pending')) {
    return 'pending';
  }
  return states.includes('success') ? 'success' : 'neutral';
}

/**
 * Whether a pull request belongs to a ticket: the key in its title or in its
 * branch name, as a whole key (ACME-24 is not ACME-240) and in any case —
 * branches are usually lower-case (`fix/acme-2409-…`).
 */
export function pullMentionsTicket(pull: Pick<PullSummary, 'title' | 'headRef'>, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, 'i');
  return pattern.test(pull.title) || pattern.test(pull.headRef ?? '');
}
