import { describe, expect, it } from 'vitest';
import { fetchPullDetail, fetchPullDiff } from '../src/github/detail';
import { HttpError, type HttpClient } from '../src/http';

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

describe('fetchPullDiff', () => {
  it("puts the diff together from the file list when GitHub won't send one that big (item 155)", async () => {
    const asked: string[] = [];
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified', patch: `@@ -1 +1 @@\n-a\n+b` }));
    const http = {
      binary: async (url: string) => {
        throw new HttpError(406, url, '{"message":"Sorry, the diff exceeded the maximum number of files (300)."}');
      },
      json: async (url: string) => {
        asked.push(url);
        if (url.endsWith('page=1')) return page(100);
        return [
          { filename: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' },
          { filename: 'src/b.ts', previous_filename: 'src/a.ts', status: 'renamed' },
          { filename: 'logo.png', status: 'modified' }
        ];
      }
    } as unknown as HttpClient;

    const diff = await fetchPullDiff(http, 'https://api.github.com/', 'token', 'acme/web', 7);

    expect(asked).toEqual([
      'https://api.github.com/repos/acme/web/pulls/7/files?per_page=100&page=1',
      'https://api.github.com/repos/acme/web/pulls/7/files?per_page=100&page=2'
    ]);
    expect(diff.match(/^diff --git /gm)).toHaveLength(103);
    expect(diff).toContain('diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+x\n');
    expect(diff).toContain('diff --git a/src/a.ts b/src/b.ts\nrename from src/a.ts\nrename to src/b.ts\n--- a/src/a.ts\n+++ b/src/b.ts\n');
    expect(diff).toContain('+++ b/logo.png\n(GitHub sent no patch for this file: too large, or binary.)\n');
  });

  it('passes any other failure on', async () => {
    const http = {
      binary: async (url: string) => { throw new HttpError(404, url, ''); },
      json: async () => { throw new Error('must not be asked'); }
    } as unknown as HttpClient;
    await expect(fetchPullDiff(http, 'https://api.github.com', 'token', 'acme/web', 7)).rejects.toThrow('HTTP 404');
  });
});
