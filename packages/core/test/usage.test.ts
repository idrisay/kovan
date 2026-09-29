import { describe, expect, it } from 'vitest';
import {
  ClaudeTranscript,
  CodexLog,
  codexSessionMeta,
  costOf,
  formatTokens,
  formatUsd,
  priceFor,
  recordMatches,
  totalsOf,
  type UsageRecord
} from '../src/usage';

function assistant(id: string, model: string, usage: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', requestId: `req-${id}`, message: { id, model, usage } });
}

describe('Claude Code transcripts', () => {
  it('counts each response once, even when its blocks repeat the usage', () => {
    const t = new ClaudeTranscript();
    const usage = {
      input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000,
      cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 600 }
    };
    t.feed([assistant('m1', 'claude-opus-5-5', usage), assistant('m1', 'claude-opus-5-5', usage), ''].join('\n'));
    expect(t.models()).toEqual([
      { model: 'claude-opus-5-5', input: 2, output: 100, cacheWrite: 600, cacheWrite1h: 400, cacheRead: 5000 }
    ]);
  });

  it('keeps a line split across two reads, and skips synthetic and user lines', () => {
    const t = new ClaudeTranscript();
    const line = assistant('m2', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 20 });
    const text = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistant('m3', '<synthetic>', { input_tokens: 9, output_tokens: 9 }),
      line,
      ''
    ].join('\n');
    t.feed(text.slice(0, text.length - 20));
    expect(t.models()).toEqual([]);
    t.feed(text.slice(text.length - 20));
    expect(t.models()).toEqual([{ model: 'claude-sonnet-5', input: 10, output: 20, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }]);
  });
});

describe('Codex logs', () => {
  it('takes the last running total, with cached input split out', () => {
    const log = new CodexLog();
    const count = (input: number, cached: number, output: number) => JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } }
    });
    log.feed([
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra' } }),
      count(100, 50, 5),
      count(36093, 27136, 192),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      ''
    ].join('\n'));
    expect(log.models()).toEqual([{ model: 'gpt-5.6-terra', input: 8957, output: 192, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 27136 }]);
  });

  it('reads where and when a session started', () => {
    const line = JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo', timestamp: '2026-09-22T13:01:57.907Z' } });
    expect(codexSessionMeta(line)).toEqual({ cwd: '/repo', startedAt: Date.parse('2026-09-22T13:01:57.907Z') });
    expect(codexSessionMeta('{"type":"event_msg"}')).toBeUndefined();
  });
});

describe('prices', () => {
  it('matches the first rule and prices every kind of token', () => {
    expect(priceFor('claude-opus-4-1-20250805')?.input).toBe(15);
    // Its own rate since item 95 — it used to fall through to the older Opus catch-all at $5.
    expect(priceFor('claude-opus-5-5')?.input).toBe(4);
    expect(priceFor('opencode/muse-spark-1.3-contributor-free')?.output).toBe(0);
    expect(priceFor('some-unknown-model')).toBeUndefined();
    const cost = costOf({ model: 'claude-sonnet-5', input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 1_000_000 });
    // Sonnet 5 is $2 / $10, cache reads $0.20 (item 95); it used to be priced as Sonnet 4.6.
    expect(cost).toBeCloseTo(2 + 10 + 0.2);
  });

  it('totals records by ticket or pull request and flags a model with no price', () => {
    const base = { runnerName: 'Claude Code', startedAt: 0, updatedAt: 0 };
    const records: UsageRecord[] = [
      { ...base, id: 'a', title: 'a', subject: 'ACME-1', pull: 'acme/web#4', models: [{ model: 'claude-haiku-4-5', input: 1_000_000, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }] },
      { ...base, id: 'b', title: 'b', subject: 'acme/web#4', models: [{ model: 'mystery', input: 10, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }] }
    ];
    expect(records.filter((r) => recordMatches(r, 'acme/web#4')).length).toBe(2);
    expect(records.filter((r) => recordMatches(r, 'ACME-1')).length).toBe(1);
    const totals = totalsOf(records);
    expect(totals.usd).toBeCloseTo(1);
    expect(totals.unpriced).toBe(true);
  });

  it('formats', () => {
    expect(formatTokens(2_400_000)).toBe('2.4M');
    expect(formatTokens(310_400)).toBe('310k');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(3.836)).toBe('$3.84');
  });
});
