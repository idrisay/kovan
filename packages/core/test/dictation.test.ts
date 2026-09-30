import { describe, expect, it } from 'vitest';
import { DoubleTap, joinDictation, pickDictationLocale, preferredWhisperModel, speechLanguage, speechProvider, whisperCliText, type DictationLocale } from '../src';

const locales: DictationLocale[] = [
  { id: 'en-US', name: 'English (US)', onDevice: true },
  { id: 'en-GB', name: 'English (UK)', onDevice: true },
  { id: 'en-AU', name: 'English (Australia)', onDevice: false },
  { id: 'tr-TR', name: 'Turkish', onDevice: false },
  { id: 'de-CH', name: 'German (Switzerland)', onDevice: false },
  { id: 'de-DE', name: 'German', onDevice: false }
];

describe('pickDictationLocale', () => {
  it('uses the setting when the recogniser knows it', () => {
    expect(pickDictationLocale('tr-TR', 'en-CH', locales)).toBe('tr-TR');
  });

  it("falls back to the system's own language", () => {
    expect(pickDictationLocale('', 'de-CH', locales)).toBe('de-CH');
    expect(pickDictationLocale('xx-YY', 'en-US', locales)).toBe('en-US');
  });

  // This Mac: en-CH, which has no recogniser of its own.
  it('picks the same language elsewhere, on-device first, for a region with none', () => {
    expect(pickDictationLocale('', 'en-CH', locales)).toBe('en-GB');
  });

  it('ends on something even for an unknown language', () => {
    expect(pickDictationLocale('', 'xx-XX', locales)).toBe('en-US');
  });
});

describe('DoubleTap', () => {
  const tap = (d: DoubleTap, at: number, hold = 60) => {
    d.down('Meta', at);
    return d.up('Meta', at + hold);
  };

  it('fires on the second quick tap of ⌘', () => {
    const d = new DoubleTap();
    expect(tap(d, 0)).toBe(false);
    expect(tap(d, 200)).toBe(true);
  });

  it('does not fire for taps too far apart', () => {
    const d = new DoubleTap();
    tap(d, 0);
    expect(tap(d, 1_000)).toBe(false);
  });

  it('never fires for a shortcut like ⌘C', () => {
    const d = new DoubleTap();
    tap(d, 0);
    d.down('Meta', 150);
    d.down('c', 170);
    expect(d.up('Meta', 200)).toBe(false);
    expect(tap(d, 300)).toBe(false);
  });

  it('does not count a long hold as a tap', () => {
    const d = new DoubleTap();
    tap(d, 0);
    expect(tap(d, 150, 800)).toBe(false);
  });

  it('is broken by typing between the taps', () => {
    const d = new DoubleTap();
    tap(d, 0);
    d.down('a', 100);
    expect(tap(d, 200)).toBe(false);
  });

  it('ignores key repeat and forgets on reset', () => {
    const d = new DoubleTap();
    tap(d, 0);
    d.reset();
    expect(tap(d, 200)).toBe(false);
    const e = new DoubleTap();
    e.down('Meta', 0);
    e.down('Meta', 30, true);
    expect(e.up('Meta', 60)).toBe(false);
    expect(tap(e, 200)).toBe(true);
  });
});

describe('joinDictation', () => {
  it('adds a space only when the text before needs one', () => {
    expect(joinDictation('', ' hello ')).toBe('hello');
    expect(joinDictation('Fix it', 'now')).toBe(' now');
    expect(joinDictation('Fix it ', 'now')).toBe('now');
    expect(joinDictation('line\n', 'next')).toBe('next');
    expect(joinDictation('x', '   ')).toBe('');
  });
});

describe('speech providers (item 97)', () => {
  it('reads whisper-cli output as text, dropping its chatter', () => {
    const out = 'whisper_init_from_file: loading model\n[00:00:00.000 --> 00:00:02.000]\n Kovan dictation test.\n\n';
    expect(whisperCliText(out)).toBe('Kovan dictation test.');
    expect(whisperCliText('[BLANK_AUDIO]\n')).toBe('');
  });

  it('prefers base.en, then falls back to what is there', () => {
    expect(preferredWhisperModel(['/m/ggml-tiny-q5_1.bin', '/m/ggml-base.en.bin'])).toBe('/m/ggml-base.en.bin');
    expect(preferredWhisperModel(['/m/ggml-tiny-q5_1.bin'])).toBe('/m/ggml-tiny-q5_1.bin');
    expect(preferredWhisperModel([])).toBeUndefined();
  });

  it('knows its providers, and falls back to Apple', () => {
    expect(speechProvider('groq').defaultModel).toBe('whisper-large-v3-turbo');
    expect(speechProvider('nonsense').id).toBe('apple');
    expect(speechLanguage('en-GB')).toBe('en');
    expect(speechLanguage('')).toBeUndefined();
  });
});
