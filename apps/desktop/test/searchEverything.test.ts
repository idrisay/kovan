import { describe, expect, it } from 'vitest';
import { matchWords, nextScope, search, type Candidate } from '../src/renderer/searchEverything';

const c = (kind: Candidate['kind'], id: string, key: string, title: string, extra = '', penalty = 0): Candidate<string> =>
  ({ kind, id, key, title, extra, penalty, data: id });

const ALL: Candidate<string>[] = [
  c('pull', '42', 'web #42', 'Fix the flaky payment retry', 'acme/web fix/ACME-2393'),
  c('pull', '119', 'web #119', 'Spike: replace the retry queue with a worker', 'acme/web'),
  c('pull', '7', 'web #7', 'Retry payments on timeout', 'acme/web', 2),
  c('ticket', 'ACME-2393', 'ACME-2393', 'Payment retry fails on tablet', 'In review'),
  c('session', 's1', 'claude', 'implement · ACME-2393', '/repos/web'),
  c('file', '/r/src/payment/retry.ts', 'ts', 'src/payment/retry.ts'),
  c('file', '/r/src/checkout.ts', 'ts', 'src/checkout.ts'),
  c('action', 'refresh', 'action', 'Refresh everything')
];

describe('matchWords', () => {
  it('needs every word, in any order', () => {
    expect(matchWords('retry pay', ALL[0]!)).toBeDefined();
    expect(matchWords('retry invoice', ALL[0]!)).toBeUndefined();
  });

  it('finds words in the key and extra too, without highlighting them', () => {
    expect(matchWords('2393', ALL[0]!)).toEqual({ score: 1.5, marks: [] });
  });

  it('marks where each word matched in the title', () => {
    expect(matchWords('flaky', ALL[0]!)?.marks).toEqual([[8, 13]]);
  });
});

describe('search', () => {
  it('groups every kind in All, best match first', () => {
    const { hits } = search('retry', 'all', ALL, 4);
    expect(hits.map((h) => h.candidate.id)).toEqual(['42', '119', '7', 'ACME-2393', '/r/src/payment/retry.ts']);
  });

  it('puts a word at the start of the title first, unless it is merged', () => {
    const merged = search('retry', 'pull', ALL, 10).hits.map((h) => h.candidate.id);
    expect(merged.indexOf('7')).toBeGreaterThan(merged.indexOf('42'));
  });

  it('narrows to one kind', () => {
    expect(search('2393', 'ticket', ALL, 10).hits.map((h) => h.candidate.kind)).toEqual(['ticket']);
  });

  it('treats > as actions only', () => {
    const result = search('> refr', 'all', ALL, 4);
    expect(result.scope).toBe('action');
    expect(result.hits.map((h) => h.candidate.id)).toEqual(['refresh']);
  });

  it('matches files fuzzily, as ⌘P does', () => {
    expect(search('payretry', 'file', ALL, 10).hits[0]?.candidate.id).toBe('/r/src/payment/retry.ts');
  });

  it('keeps the given order with nothing typed', () => {
    expect(search('', 'pull', ALL, 10).hits.map((h) => h.candidate.id)).toEqual(['42', '119', '7']);
  });
});

describe('nextScope', () => {
  it('wraps both ways', () => {
    expect(nextScope('all')).toBe('pull');
    expect(nextScope('action')).toBe('all');
    expect(nextScope('all', true)).toBe('action');
  });
});
