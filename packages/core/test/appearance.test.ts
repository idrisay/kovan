import { describe, expect, it } from 'vitest';
import { clockMinutes, DEFAULT_SCHEDULE, isDaytime, resolveTheme, THEMES, themeInfo } from '../src';

const at = (h: number, m = 0) => new Date(2026, 8, 29, h, m);

describe('appearance', () => {
  it('reads clock times and rejects nonsense', () => {
    expect(clockMinutes('07:30')).toBe(450);
    expect(clockMinutes('24:00')).toBeUndefined();
    expect(clockMinutes('7pm')).toBeUndefined();
  });

  it('knows day from night, including a schedule that wraps midnight', () => {
    expect(isDaytime(DEFAULT_SCHEDULE, at(6, 59))).toBe(false);
    expect(isDaytime(DEFAULT_SCHEDULE, at(7))).toBe(true);
    expect(isDaytime(DEFAULT_SCHEDULE, at(19))).toBe(false);
    const nightShift = { dayStart: '22:00', nightStart: '06:00' };
    expect(isDaytime(nightShift, at(23))).toBe(true);
    expect(isDaytime(nightShift, at(12))).toBe(false);
  });

  it('resolves each kind of choice to one theme', () => {
    const schedule = { ...DEFAULT_SCHEDULE, day: 'paper' as const, night: 'ember' as const };
    expect(resolveTheme('system', schedule, { osLight: true, now: at(3) })).toBe('paper');
    expect(resolveTheme('system', schedule, { osLight: false, now: at(12) })).toBe('ember');
    expect(resolveTheme('schedule', schedule, { osLight: false, now: at(12) })).toBe('paper');
    expect(resolveTheme('schedule', schedule, { osLight: true, now: at(21) })).toBe('ember');
    expect(resolveTheme('oled', schedule, { osLight: true, now: at(12) })).toBe('oled');
  });

  it('gives every theme a tone', () => {
    expect(THEMES.filter((t) => t.tone === 'light').map((t) => t.id)).toEqual(['light', 'paper']);
    expect(themeInfo('contrast').tone).toBe('dark');
  });
});
