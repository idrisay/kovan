import { describe, expect, it } from 'vitest';
import { costOf, priceFor } from '../src';

// Item 95: Kovan showed $8.13 for a session Claude Code itself priced at $4.75.
describe('current model prices', () => {
  it('prices Opus 5.5 at its own rates, not the older Opus catch-all', () => {
    expect(priceFor('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite1h: 8 });
    // The real session: implement · ACME-2393, from usage.json.
    const usd = costOf({ model: 'claude-opus-5-5', input: 126, output: 52679, cacheWrite: 0, cacheWrite1h: 221682, cacheRead: 11249516 });
    expect(usd).toBeCloseTo(5.08, 2);
  });

  it('gives each current model its own rule', () => {
    expect(priceFor('claude-opus-5')?.input).toBe(5);
    expect(priceFor('claude-opus-4-8')?.input).toBe(5);
    expect(priceFor('claude-sonnet-5')).toMatchObject({ input: 2, output: 10 });
    expect(priceFor('claude-sonnet-4-6')).toMatchObject({ input: 3, output: 15 });
    expect(priceFor('claude-fable-5-1')).toMatchObject({ input: 10, output: 50, cacheRead: 0.25 });
    expect(priceFor('claude-haiku-4-5')).toMatchObject({ input: 1, output: 5 });
  });
});
