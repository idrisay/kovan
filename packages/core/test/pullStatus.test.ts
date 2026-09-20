import { describe, expect, it } from 'vitest';
import {
  describePull,
  isBlocked,
  primaryFlag,
  pullFlags,
  reviewDecisionFrom,
  rollUpChecks,
  summaryFromApi,
  type PullState
} from '../src/github/pullStatus';

const open: PullState = {
  mergeable: 'mergeable',
  reviewDecision: 'none',
  checks: 'success',
  unresolvedThreads: 0,
  isDraft: false
};

describe('blocked-on-you', () => {
  it('treats conflicts, changes requested and failing checks as blocking', () => {
    expect(isBlocked({ ...open, mergeable: 'conflicting' })).toBe(true);
    expect(isBlocked({ ...open, reviewDecision: 'changes_requested' })).toBe(true);
    expect(isBlocked({ ...open, checks: 'failure' })).toBe(true);
  });

  it('does not treat unresolved threads or drafts as blocking', () => {
    expect(isBlocked({ ...open, unresolvedThreads: 3 })).toBe(false);
    expect(isBlocked({ ...open, isDraft: true })).toBe(false);
  });

  it('leads with conflicts, because they block every other outcome', () => {
    const pull: PullState = {
      ...open,
      mergeable: 'conflicting',
      reviewDecision: 'approved',
      checks: 'failure'
    };
    expect(primaryFlag(pull).id).toBe('conflict');
  });

  it('never drops a blocking flag to stay inside the label budget', () => {
    const pull: PullState = {
      ...open,
      mergeable: 'conflicting',
      reviewDecision: 'changes_requested',
      checks: 'failure',
      unresolvedThreads: 2
    };
    const described = describePull(pull, 1);
    expect(described).toContain('Conflicts');
    expect(described).toContain('Changes requested');
    expect(described).toContain('Checks failing');
  });

  it('calls a clean pull request Open', () => {
    expect(describePull(open)).toBe('Open');
  });

  it('does not claim a draft is awaiting review', () => {
    const ids = pullFlags({ ...open, reviewDecision: 'review_required', isDraft: true }).map(
      (f) => f.id
    );
    expect(ids).not.toContain('awaiting-review');
  });
});

describe('re-requested reviews', () => {
  it('clears changes-requested once the reviewer has been asked again', () => {
    // GitHub leaves reviewDecision at CHANGES_REQUESTED after a re-request; the
    // ball is actually back with the reviewer.
    const summary = summaryFromApi({
      number: 1,
      title: 'x',
      url: 'u',
      isDraft: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      additions: 0,
      deletions: 0,
      reviewDecision: 'CHANGES_REQUESTED',
      latestOpinionatedReviews: {
        nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'Reviewer' } }]
      },
      reviewRequests: { nodes: [{ requestedReviewer: { login: 'reviewer' } }] }
    });
    expect(summary.reviewDecision).toBe('review_required');
  });

  it('keeps changes-requested when a second reviewer still objects', () => {
    const summary = summaryFromApi({
      number: 1,
      title: 'x',
      url: 'u',
      isDraft: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      additions: 0,
      deletions: 0,
      reviewDecision: 'CHANGES_REQUESTED',
      latestOpinionatedReviews: {
        nodes: [
          { state: 'CHANGES_REQUESTED', author: { login: 'asked-again' } },
          { state: 'CHANGES_REQUESTED', author: { login: 'still-objecting' } }
        ]
      },
      reviewRequests: { nodes: [{ requestedReviewer: { login: 'asked-again' } }] }
    });
    expect(summary.reviewDecision).toBe('changes_requested');
  });

  it('ignores bare comments when collapsing a review list', () => {
    expect(
      reviewDecisionFrom([
        { state: 'APPROVED', submitted_at: '2026-01-01', user: { login: 'a' } },
        { state: 'COMMENTED', submitted_at: '2026-01-02', user: { login: 'a' } }
      ])
    ).toBe('approved');
  });
});

describe('check roll-up', () => {
  it('lets one failure fail the set', () => {
    expect(rollUpChecks(['success', 'failure', 'pending'])).toBe('failure');
    expect(rollUpChecks(['success', 'pending'])).toBe('pending');
    expect(rollUpChecks(['success'])).toBe('success');
    expect(rollUpChecks([])).toBe('none');
  });
});
