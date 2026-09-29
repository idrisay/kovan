import { describe, expect, it } from 'vitest';
import {
  claudeLimitsFromCcstatusline, claudeLimitsFromStatusPayload, codexLimitsFromLine, newestLimits, settleWindows
} from '../src';

describe('agent limits (item 108)', () => {
  it("reads Codex's rate limits from a session-log line", () => {
    const line = JSON.stringify({
      timestamp: '2026-09-29T12:23:27.963Z',
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: {
        primary: { used_percent: 27, window_minutes: 300, resets_at: 1790686281 },
        secondary: { used_percent: 16, window_minutes: 10080, resets_at: 1791184146 },
        plan_type: 'plus'
      } }
    });
    const limits = codexLimitsFromLine(line)!;
    expect(limits.plan).toBe('Plus');
    expect(limits.asOf).toBe(Date.parse('2026-09-29T12:23:27.963Z'));
    expect(limits.windows).toEqual([
      { label: '5 hours', usedPercent: 27, resetsAt: 1790686281000 },
      { label: 'Week', usedPercent: 16, resetsAt: 1791184146000 }
    ]);
    expect(codexLimitsFromLine('{"type":"message"}')).toBeUndefined();
  });

  it("reads Claude Code's status-line payload, dropping empty per-model buckets", () => {
    const limits = claudeLimitsFromStatusPayload({ rate_limits: {
      five_hour: { used_percentage: 37, resets_at: 1790694000 },
      seven_day: { used_percentage: 29, resets_at: 1791000000 },
      seven_day_opus: { used_percentage: 0, resets_at: 1791000000 },
      seven_day_sonnet: null
    } }, 1000)!;
    expect(limits.windows.map((w) => w.label)).toEqual(['5 hours', 'Week']);
    expect(claudeLimitsFromStatusPayload({ model: {} }, 1)).toBeUndefined();
  });

  it("reads ccstatusline's cache", () => {
    const limits = claudeLimitsFromCcstatusline({
      sessionUsage: 37, sessionResetAt: '2026-09-29T15:00:00.509053+00:00', weeklyUsage: 29, weeklyResetAt: '2026-10-03T00:00:00+00:00', weeklyOpusUsage: 0
    }, 5)!;
    expect(limits.windows).toHaveLength(2);
    expect(limits.windows[0]).toMatchObject({ label: '5 hours', usedPercent: 37 });
  });

  it('shows a window as reset once its reset time has passed', () => {
    const limits = { asOf: 0, source: 'x', windows: [
      { label: '5 hours', usedPercent: 80, resetsAt: 1_000 },
      { label: 'Week', usedPercent: 40, resetsAt: 9_000 }
    ] };
    expect(settleWindows(limits, 5_000).windows).toEqual([
      { label: '5 hours', usedPercent: 0, reset: true },
      { label: 'Week', usedPercent: 40, resetsAt: 9_000 }
    ]);
  });

  it('prefers the newest reading', () => {
    const a = { asOf: 1, source: 'a', windows: [] };
    const b = { asOf: 2, source: 'b', windows: [] };
    expect(newestLimits(a, undefined, b)?.source).toBe('b');
  });
});
