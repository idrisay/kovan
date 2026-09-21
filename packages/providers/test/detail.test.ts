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
