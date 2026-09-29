import { describe, expect, it } from 'vitest';
import { fetchPullDetail } from '../src/github/detail';
import type { HttpClient } from '../src/http';

/** Just enough of `HttpClient` for `fetchPullDetail` to run against, no network. */
function fakeHttp(data: unknown): HttpClient {
  return { json: async () => ({ data }) } as unknown as HttpClient;
}

const BASE_PULL = {
  number: 1,
  title: 'Fix the thing',
  url: 'https://github.com/acme/web/pull/1',
  body: '',
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  author: { login: 'someone' },
  baseRefName: 'main',
  headRefName: 'fix/1',
  comments: { nodes: [{ author: { login: 'pm' }, body: 'Ping', createdAt: '2026-01-01T00:00:00.000Z', url: '' }] },
  reviewThreads: { nodes: [] },
  files: { nodes: [] },
  reviewRequests: { nodes: [] },
  latestOpinionatedReviews: { nodes: [] },
  reviews: {
    nodes: [
      {
        author: { login: 'alice-dev' },
        state: 'APPROVED',
        body: 'LGTM, nice tests',
        submittedAt: '2026-01-02T00:00:00.000Z',
        url: ''
      },
      {
        // A plain approve with nothing written — already visible in the
        // reviewer roster, so it should not duplicate into the conversation.
        author: { login: 'carol-dev' },
        state: 'APPROVED',
        body: '',
        submittedAt: '2026-01-03T00:00:00.000Z',
        url: ''
      }
    ]
  },
  commits: { nodes: [] }
};

describe('fetchPullDetail', () => {
  it('merges written reviews into the conversation, in order, tagged with their state', async () => {
    const http = fakeHttp({ repository: { pullRequest: BASE_PULL } });
    const detail = await fetchPullDetail(http, 'https://api.github.com', 'token', 'acme/web', 1);

    expect(detail.comments.map((c) => c.author)).toEqual(['pm', 'alice-dev']);
    expect(detail.comments[1]).toMatchObject({
      author: 'alice-dev',
      body: 'LGTM, nice tests',
      reviewState: 'approved'
    });
  });
});

describe('reviewers (item 106)', () => {
  const pull = {
    ...BASE_PULL,
    // alice-dev asked for changes, the author pushed a fix and asked them again.
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'alice-dev' } }, { requestedReviewer: { login: 'newcomer' } }] },
    latestOpinionatedReviews: {
      nodes: [
        { author: { login: 'alice-dev' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-02T00:00:00.000Z' },
        { author: { login: 'bob-dev' }, state: 'APPROVED', submittedAt: '2026-01-05T00:00:00.000Z' }
      ]
    }
  };

  it("makes a re-requested reviewer's turn theirs, keeping what they said last time", async () => {
    const detail = await fetchPullDetail(fakeHttp({ repository: { pullRequest: pull } }), 'https://api.github.com', 'token', 'acme/web', 1);
    const by = Object.fromEntries(detail.reviewers.map((r) => [r.login, r]));
    expect(by['alice-dev']).toMatchObject({ turn: 'pending', previous: 'changes_requested' });
    expect(by['newcomer']).toMatchObject({ turn: 'pending' });
    expect(by['newcomer']?.previous).toBeUndefined();
    expect(by['bob-dev']).toMatchObject({ turn: 'approved' });
    expect(detail.reviewers).toHaveLength(3);
  });
});
