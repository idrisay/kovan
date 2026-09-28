/**
 * Voice dictation (item 88): the parts that are only logic — which language
 * to listen in, and what counts as a double-tap of ⌘.
 */

export interface DictationLocale { id: string; name: string; onDevice: boolean }

/**
 * The language to listen in. The setting when the recogniser knows it;
 * otherwise the system's own, or — since a region like en-CH often has no
 * recogniser of its own — the same language elsewhere, on-device first.
 */
export function pickDictationLocale(setting: string, system: string, locales: readonly DictationLocale[]): string {
  const known = (id: string) => locales.find((l) => l.id.toLowerCase() === id.toLowerCase());
  const chosen = setting ? known(setting) : undefined;
  if (chosen) return chosen.id;
  const exact = known(system);
  if (exact) return exact.id;
  const language = system.split('-')[0]!.toLowerCase();
  const same = locales.filter((l) => l.id.split('-')[0]!.toLowerCase() === language);
  const preferred = ['en-GB', 'en-US', 'de-DE', 'fr-FR', 'it-IT', 'tr-TR'];
  // In the order of `preferred`, not the order the recogniser listed them.
  const pick =
    preferred.map((id) => same.find((l) => l.onDevice && l.id === id)).find(Boolean) ??
    same.find((l) => l.onDevice) ?? same[0];
  return pick?.id ?? known('en-US')?.id ?? locales[0]?.id ?? 'en-US';
}

/**
 * Double-tap ⌘, the way getbaton.dev and VoiceSmith's double-tap Shift work:
 * two presses of ⌘ *alone*, each short, the second soon after the first.
 * Any other key while ⌘ is down makes it a shortcut (⌘C, ⌘S…), not a tap,
 * so an ordinary shortcut can never start dictation by accident.
 *
 * Fed raw key events with their time; says `true` from `up` on the second tap.
 */
export class DoubleTap {
  /** Longest a press can be held and still count as a tap. */
  static readonly HOLD_MS = 350;
  /** Longest gap between the two taps. */
  static readonly GAP_MS = 400;

  private downAt?: number;
  private spoiled = false;
  private lastTapAt?: number;

  constructor(private readonly key = 'Meta') {}

  down(key: string, at: number, repeat = false): void {
    if (key === this.key) {
      if (repeat) return;
      this.downAt = at;
      this.spoiled = false;
      return;
    }
    // Another key: during the press it's a shortcut; between taps it breaks the pair.
    if (this.downAt !== undefined) this.spoiled = true;
    this.lastTapAt = undefined;
  }

  up(key: string, at: number): boolean {
    if (key !== this.key || this.downAt === undefined) return false;
    const held = at - this.downAt;
    const clean = !this.spoiled && held <= DoubleTap.HOLD_MS;
    this.downAt = undefined;
    this.spoiled = false;
    if (!clean) {
      this.lastTapAt = undefined;
      return false;
    }
    if (this.lastTapAt !== undefined && at - this.lastTapAt <= DoubleTap.GAP_MS) {
      this.lastTapAt = undefined;
      return true;
    }
    this.lastTapAt = at;
    return false;
  }

  /** Focus left the window: a half-finished tap mustn't finish later. */
  reset(): void {
    this.downAt = undefined;
    this.spoiled = false;
    this.lastTapAt = undefined;
  }
}

/**
 * Text to insert after what's already before the caret: a space in between
 * unless there's already one (or nothing), so dictating twice doesn't run the
 * words together.
 */
export function joinDictation(before: string, text: string): string {
  const said = text.trim();
  if (!said) return '';
  return before === '' || /\s$/.test(before) ? said : ` ${said}`;
}
