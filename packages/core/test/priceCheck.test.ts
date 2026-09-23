import { describe, expect, it } from 'vitest';
import { applyPriceProposals, parsePriceCheck, priceCheckPrompt } from '../src/priceCheck';
import type { PriceRule } from '../src/usage';

const rule = (match: string, input: number): PriceRule =>
  ({ match, input, output: input * 5, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 });

const current = [rule('free', 0), rule('opus', 5), rule('sonnet', 3)];

describe('priceCheckPrompt', () => {
  it('names every row by its match text', () => {
    const prompt = priceCheckPrompt(current);
    expect(prompt).toContain('- "opus"');
    expect(prompt).toContain('- "sonnet"');
  });
});

describe('parsePriceCheck', () => {
  it('reads the last price list after any chatter, and marks new rows', () => {
    const text = 'Searching…\n{"prices":[]}\nDone:\n{"prices":[' +
      '{"match":"sonnet","input":3,"output":15,"cacheWrite":3.75,"cacheWrite1h":6,"cacheRead":0.3,"source":"https://x.test/p"},' +
      '{"match":"opus-5","input":6,"output":30,"cacheWrite":7.5,"cacheWrite1h":12,"cacheRead":0.6}]}';
    const result = parsePriceCheck(text, current);
    expect('proposals' in result && result.proposals.map((p) => [p.match, p.added, p.source])).toEqual([
      ['sonnet', false, 'https://x.test/p'],
      ['opus-5', true, undefined]
    ]);
  });

  it('drops rows with missing, negative or non-numeric prices', () => {
    const text = '{"prices":[{"match":"opus","input":-1,"output":1,"cacheWrite":0,"cacheWrite1h":0,"cacheRead":0},' +
      '{"match":"sonnet","input":"3","output":1,"cacheWrite":0,"cacheWrite1h":0,"cacheRead":0}]}';
    expect(parsePriceCheck(text, current)).toEqual({ error: 'The model found no prices it could vouch for.' });
  });

  it('says so when there is no JSON at all', () => {
    expect('error' in parsePriceCheck('I could not browse.', current)).toBe(true);
  });
});

describe('applyPriceProposals', () => {
  it('updates rows in place and puts a new specific row above the general one it contains', () => {
    const next = applyPriceProposals(current, [
      { ...rule('Sonnet', 4), added: false },
      { ...rule('opus-5', 6), added: true }
    ]);
    expect(next.map((r) => [r.match, r.input])).toEqual([
      ['free', 0], ['opus-5', 6], ['opus', 5], ['sonnet', 4]
    ]);
  });
});
