import { describe, expect, it } from 'vitest';
import {
  addActivity, diffActivity, FLOOD, summaryFromApi,
  type ActivitySeen, type JiraIssue, type PullSummary
} from '../src';

const pull = (number: number, extra: Partial<PullSummary> = {}): PullSummary => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  repo: 'acme/web',
  author: 'someone',
  isDraft: false,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  mergeable: 'mergeable',
  reviewDecision: 'review_required',
  checks: 'success',
  unresolvedThreads: 0,
  additions: 1,
  deletions: 0,
  viewerReviewed: false,
  ...extra
});

const ticket = (key: string): JiraIssue => ({
  key, summary: `Ticket ${key}`, description: '', status: 'To Do', statusCategory: 'new',
  issueType: 'Task', updated: '2026-09-02T00:00:00Z', url: `https://jira.example/browse/${key}`,
  subtasks: [], comments: [], links: []
} as unknown as JiraIssue);

const github = (mine: PullSummary[], reviewRequested: PullSummary[] = []) =>
  ({ github: { viewer: 'me', mine, reviewRequested } });

/** Two polls: the first sets the baseline, the second is what's reported. */
function twice(first: Parameters<typeof diffActivity>[1], second: Parameters<typeof diffActivity>[1]) {
  const base = diffActivity({}, first, 1);
  expect(base.events).toEqual([]);
  return diffActivity(base.seen, second, 2);
}

describe('diffActivity', () => {
  it('reports nothing on the first answer, only records it', () => {
    const { events, seen } = diffActivity({}, { ...github([pull(1)], [pull(2)]), jira: { tickets: [ticket('A-1')] } });
    expect(events).toEqual([]);
    expect(seen.github?.reviewRequested).toEqual(['acme/web#2']);
    expect(seen.jira?.tickets).toEqual(['A-1']);
  });

  it('reports a new review request, with who asked', () => {
    const { events } = twice(github([], []), github([], [pull(205, { author: 'bob-dev' })]));
    expect(events).toMatchObject([
      { kind: 'review-requested', subject: 'acme/web#205', label: 'web #205', who: 'bob-dev' }
    ]);
  });

  it('reports approval and changes requested on your own pull requests', () => {
    const { events } = twice(
      github([pull(1), pull(2)]),
      github([pull(1, { reviewDecision: 'approved' }), pull(2, { reviewDecision: 'changes_requested' })])
    );
    expect(events.map((e) => [e.kind, e.subject])).toEqual([
      ['approved', 'acme/web#1'],
      ['changes-requested', 'acme/web#2']
    ]);
  });

  it("doesn't call a pull request you just opened news", () => {
    const { events } = twice(github([]), github([pull(3, { reviewDecision: 'approved', commentCount: 4 })]));
    expect(events).toEqual([]);
  });

  it('reports a comment from somebody else, not your own', () => {
    const base = github([pull(1, { commentCount: 2 })]);
    const theirs = twice(base, github([pull(1, { commentCount: 3, lastCommenter: 'bob-dev' })]));
    expect(theirs.events).toMatchObject([{ kind: 'new-comment', who: 'bob-dev' }]);
    const mine = twice(base, github([pull(1, { commentCount: 3, lastCommenter: 'ME' })]));
    expect(mine.events).toEqual([]);
  });

  it('reports a newly assigned ticket', () => {
    const { events } = twice({ jira: { tickets: [ticket('A-1')] } }, { jira: { tickets: [ticket('A-1'), ticket('A-2')] } });
    expect(events).toMatchObject([{ kind: 'new-ticket', subject: 'A-2', title: 'Ticket A-2' }]);
  });

  // The failure this exists to prevent: GitHub fails, publishes empty lists,
  // and the next good poll "discovers" everything you already had.
  it('keeps what it knew when a provider does not answer', () => {
    const base = diffActivity({}, github([pull(1)], [pull(2)]), 1);
    const failed = diffActivity(base.seen, { jira: { tickets: [] } }, 2);
    expect(failed.seen.github).toEqual(base.seen.github);
    const back = diffActivity(failed.seen, github([pull(1)], [pull(2)]), 3);
    expect(back.events).toEqual([]);
  });

  it('re-baselines instead of reporting a flood', () => {
    const many = Array.from({ length: FLOOD + 1 }, (_, i) => ticket(`A-${i + 10}`));
    const { events, seen } = twice({ jira: { tickets: [] } }, { jira: { tickets: many } });
    expect(events).toEqual([]);
    expect(seen.jira?.tickets).toHaveLength(FLOOD + 1);
  });

  it('reports a re-request after you reviewed', () => {
    const asked = pull(205, { updatedAt: '2026-09-03T00:00:00Z' });
    let seen: ActivitySeen = diffActivity({}, github([], [pull(205)]), 1).seen;
    seen = diffActivity(seen, github([], []), 2).seen;
    const { events } = diffActivity(seen, github([], [asked]), 3);
    expect(events).toMatchObject([{ kind: 'review-requested', id: 'review-requested:acme/web#205:2026-09-03T00:00:00Z' }]);
  });
});

describe('addActivity', () => {
  it('puts new events on top, unread, once', () => {
    const one = { id: 'a', kind: 'new-ticket' as const, at: 1, subject: 'A-1', label: 'A-1', title: 't', url: 'u' };
    const inbox = addActivity([], [one]);
    expect(inbox).toMatchObject([{ id: 'a', read: false }]);
    expect(addActivity(inbox, [one])).toHaveLength(1);
    expect(addActivity(inbox, [{ ...one, id: 'b' }]).map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('summaryFromApi comments', () => {
  it('adds conversation and review-thread comments and finds the newest author', () => {
    const summary = summaryFromApi({
      number: 1, title: 't', url: 'u', isDraft: false, createdAt: '', updatedAt: '', additions: 0, deletions: 0,
      comments: { totalCount: 2, nodes: [{ author: { login: 'a' }, createdAt: '2026-09-01T10:00:00Z' }] },
      reviewThreads: {
        nodes: [
          { isResolved: false, comments: { totalCount: 3, nodes: [{ author: { login: 'b' }, createdAt: '2026-09-02T10:00:00Z' }] } },
          { isResolved: true, comments: { totalCount: 1, nodes: [{ author: { login: 'c' }, createdAt: '2026-08-01T10:00:00Z' }] } }
        ]
      }
    });
    expect(summary).toMatchObject({ commentCount: 6, lastCommenter: 'b', lastCommentAt: '2026-09-02T10:00:00Z' });
  });

  it('leaves the count off when the query did not ask for comments', () => {
    const summary = summaryFromApi({
      number: 1, title: 't', url: 'u', isDraft: false, createdAt: '', updatedAt: '', additions: 0, deletions: 0
    });
    expect(summary.commentCount).toBeUndefined();
  });
});
