import { describe, expect, it } from 'vitest';
import {
  DEFAULTUPDATETEMPLATE,
  renderPullPrompt,
  substitute,
  ticketKeyInTitle
} from '../src/prompts';
import type { PullSummary } from '../src/github/pullStatus';

const pull: PullSummary = {
  number: 42,
  title: 'ACME-2469 Fix the retry',
  url: 'https://example.invalid/pr/42',
  repo: 'acme/web',
  author: 'someone',
  isDraft: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mergeable: 'conflicting',
  reviewDecision: 'changes_requested',
  checks: 'failure',
  unresolvedThreads: 2,
  additions: 1,
  deletions: 1,
  viewerReviewed: false
};

describe('malformed conventions', () => {
  // These shapes are what an import from the Swift app produced before the
  // Data blobs were decoded, and each one crashed the prompt builder.
  it('survives conventions with missing arrays', () => {
    expect(() =>
      renderPullPrompt(DEFAULTUPDATETEMPLATE, pull, { conventions: {} as never })
    ).not.toThrow();
  });

  it('survives conventions that are not an object at all', () => {
    expect(() =>
      renderPullPrompt(DEFAULTUPDATETEMPLATE, pull, { conventions: 'nonsense' as never })
    ).not.toThrow();
  });

  it('falls back to the default base branch when none is given', () => {
    const out = renderPullPrompt(DEFAULTUPDATETEMPLATE, pull, { conventions: {} as never });
    expect(out).not.toContain('${base}');
  });

  it('uses real conventions when they are well formed', () => {
    const out = renderPullPrompt(DEFAULTUPDATETEMPLATE, pull, {
      conventions: {
        baseBranch: 'develop',
        checks: ['npm run type-check', 'npm run eslint'],
        untouchable: [],
        pullRequestReviewers: []
      }
    });
    expect(out).toContain('npm run type-check');
  });
});

describe('substitution', () => {
  it('leaves an unknown placeholder visible rather than blanking it', () => {
    // A typo somebody can see and fix beats one silently swallowed.
    expect(substitute('a ${nope} b', { x: '1' })).toBe('a ${nope} b');
  });

  it('renders the state in the pull request prompt', () => {
    const out = renderPullPrompt(DEFAULTUPDATETEMPLATE, pull);
    expect(out).toContain('Conflicts');
    expect(out).toContain('Changes requested');
  });

  it('carries the Baton env contract, not DevHub\'s', () => {
    const out = renderPullPrompt(DEFAULTUPDATETEMPLATE, pull);
    expect(out).toContain('BATON_REPORT');
    expect(out).not.toContain('DEVHUB_');
  });
});

describe('ticket keys', () => {
  it('finds the key in a pull request title', () => {
    expect(ticketKeyInTitle('ACME-2469 Fix the retry')).toBe('ACME-2469');
    expect(ticketKeyInTitle('no key here')).toBe('');
  });
});
