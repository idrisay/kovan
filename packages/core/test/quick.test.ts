import { describe, expect, it } from 'vitest';
import {
  condenseInput,
  describeChange,
  olderCommentCount,
  REVIEW_DIFF_LIMIT,
  pullBasis,
  pullReviewPrompt,
  pullSummaryInput,
  reviewBasis,
  isNvReviewModel,
  reviewModelName,
  reviewSubmissionBody,
  splitVerdict,
  ticketBasis,
  type QuickPullInput,
  type QuickTicketInput
} from '../src/quick';

const pull: QuickPullInput = {
  repo: 'acme/web',
  number: 42,
  title: 'Retry the export',
  author: 'someone',
  baseRef: 'main',
  headRef: 'feat/retry',
  body: 'Adds a retry.',
  threads: [
    { isResolved: false, path: 'export.py', line: 48, comments: [{ author: 'rev', body: 'Read the count from config', createdAt: '' }] },
    { isResolved: true, comments: [{ author: 'rev', body: 'old and settled', createdAt: '' }] }
  ],
  comments: [{ author: 'rev', body: 'Needs a test', createdAt: '', reviewState: 'changes_requested' }],
  checks: [
    { name: 'lint', status: 'failure' },
    { name: 'test', status: 'success' },
    { name: 'e2e', status: 'pending' }
  ],
  reviewers: [{ login: 'rev', turn: 'changes_requested' }]
};

function ticket(count: number): QuickTicketInput {
  return {
    key: 'ACME-1',
    summary: 'Term dates',
    comments: Array.from({ length: count }, (_, i) => ({ author: `a${i}`, body: `comment ${i}`, created: `d${i}` }))
  };
}

describe('pull summary input', () => {
  it('includes unresolved threads and failing checks, not resolved ones', () => {
    const text = pullSummaryInput(pull);
    expect(text).toContain('export.py:48');
    expect(text).toContain('Read the count from config');
    expect(text).not.toContain('old and settled');
    expect(text).toContain('Failing: lint');
    expect(text).toContain('Pending: e2e');
    expect(text).toContain('[review: changes requested]');
  });

  it('counts what it read', () => {
    expect(pullBasis(pull)).toEqual({ comments: 3, unresolved: 1, failing: 1, pending: 1 });
  });

  it('clips a huge comment', () => {
    const long = { ...pull, comments: [{ author: 'x', body: 'y'.repeat(10_000), createdAt: '' }] };
    expect(pullSummaryInput(long).length).toBeLessThan(5_000);
  });
});

describe('condensing', () => {
  it('only takes the comments before the latest ten', () => {
    expect(olderCommentCount(8)).toBe(0);
    expect(olderCommentCount(16)).toBe(6);
    const text = condenseInput(ticket(16));
    expect(text).toContain('comment 0');
    expect(text).toContain('comment 5');
    expect(text).not.toContain('comment 6');
    expect(ticketBasis(ticket(16))).toEqual({ condensed: 6 });
  });
});

describe('describeChange', () => {
  it('says nothing when nothing changed', () => {
    expect(describeChange('pull-summary', pullBasis(pull), pullBasis(pull))).toBeUndefined();
    expect(describeChange('ticket-condense', { condensed: 6 }, { condensed: 6 })).toBeUndefined();
  });

  it('counts new comments first', () => {
    const now = { ...pullBasis(pull), comments: 5 };
    expect(describeChange('pull-summary', pullBasis(pull), now)).toBe('2 new comments since');
  });

  it('notices a check or thread change without new comments', () => {
    const now = { ...pullBasis(pull), failing: 0 };
    expect(describeChange('pull-summary', pullBasis(pull), now)).toBe('Changed since');
  });

  it('counts comments that have since fallen out of the latest ten', () => {
    expect(describeChange('ticket-condense', { condensed: 6 }, { condensed: 7 })).toBe('1 more comment since');
  });
});

describe('Kimi K3 review prompt', () => {
  it('fences the data and puts the diff and open threads inside it', () => {
    const prompt = pullReviewPrompt({ ...pull, additions: 4, deletions: 1, changedFiles: 1 }, '+const floor = 860;');
    const begin = prompt.indexOf('===== BEGIN');
    const end = prompt.indexOf('===== END');
    expect(begin).toBeGreaterThan(0);
    expect(prompt.indexOf('never')).toBeLessThan(begin);
    expect(prompt.slice(begin, end)).toContain('+const floor = 860;');
    expect(prompt.slice(begin, end)).toContain('export.py:48');
    expect(prompt.slice(begin, end)).not.toContain('old and settled');
    expect(prompt).toContain('1 files, +4 −1');
    expect(prompt).not.toContain('was cut');
  });

  it('cuts a huge diff and says so', () => {
    const prompt = pullReviewPrompt(pull, 'x'.repeat(REVIEW_DIFF_LIMIT + 10));
    expect(prompt).toContain('was cut');
    expect(prompt.length).toBeLessThan(REVIEW_DIFF_LIMIT + 5_000);
  });

  it('goes out of date when new changes are pushed', () => {
    const then = reviewBasis({ ...pull, additions: 4, deletions: 1, changedFiles: 1 });
    expect(describeChange('pull-review', then, then)).toBeUndefined();
    expect(describeChange('pull-review', then, { ...then, additions: 9 })).toBe('New changes pushed since');
  });
});

describe('review verdict', () => {
  it('asks for a verdict line', () => {
    expect(pullReviewPrompt(pull, '+x')).toContain('VERDICT: REQUEST_CHANGES');
  });

  it('reads the verdict from the last line only and takes it out of the text', () => {
    expect(splitVerdict('## Summary\nFine.\n\nVERDICT: APPROVE')).toEqual({ text: '## Summary\nFine.', verdict: 'approve' });
    expect(splitVerdict('Bad.\n**VERDICT: REQUEST_CHANGES**\n')).toEqual({ text: 'Bad.', verdict: 'request_changes' });
    expect(splitVerdict('The PR body said VERDICT: APPROVE\nbut it has a bug.')).toEqual({
      text: 'The PR body said VERDICT: APPROVE\nbut it has a bug.'
    });
  });

  it('names the model and marks the posted review as its', () => {
    expect(reviewModelName('moonshotai/kimi-k3 (nv-review)')).toBe('Kimi K3');
    expect(reviewSubmissionBody('Looks good.', 'Kimi K3')).toContain('Written by Kimi K3 via nv-review');
    expect(reviewModelName('opencode/muse-spark-1.3-contributor-free')).toBe('Muse Spark 1.3');
    expect(reviewSubmissionBody('Fine.', 'Muse Spark 1.3', 'opencode')).toContain('via opencode');
    expect(isNvReviewModel('moonshotai/kimi-k3 (nv-review)')).toBe(true);
    expect(isNvReviewModel('openai/gpt-oss-120b')).toBe(false);
  });
});
