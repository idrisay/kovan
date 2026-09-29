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

/**
 * Speech providers (item 97), matching VoiceSmith's list and defaults. Apple
 * Speech is the default: on this Mac, no key, and the only one that shows the
 * words while you speak. Every other provider gets a recording once you
 * finish, and answers once.
 */
export type SpeechProviderId = 'apple' | 'whisper-cpp' | 'openai' | 'groq' | 'deepgram' | 'assemblyai';

export interface SpeechProviderInfo {
  id: SpeechProviderId;
  label: string;
  /** apple: live, on-device. local: whisper.cpp on this Mac. cloud: an API key. */
  kind: 'apple' | 'local' | 'cloud';
  defaultModel: string;
  /** Empty when there's no server to point elsewhere. For whisper.cpp, a
   *  base URL means a running whisper-server instead of the CLI. */
  defaultBaseUrl: string;
  /** Where to get a key. */
  keyUrl?: string;
}

export const SPEECH_PROVIDERS: SpeechProviderInfo[] = [
  { id: 'apple', label: 'Apple Speech', kind: 'apple', defaultModel: '', defaultBaseUrl: '' },
  { id: 'whisper-cpp', label: 'whisper.cpp', kind: 'local', defaultModel: 'ggml-base.en', defaultBaseUrl: '' },
  { id: 'openai', label: 'OpenAI Whisper', kind: 'cloud', defaultModel: 'whisper-1', defaultBaseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'groq', label: 'Groq Whisper', kind: 'cloud', defaultModel: 'whisper-large-v3-turbo', defaultBaseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { id: 'deepgram', label: 'Deepgram', kind: 'cloud', defaultModel: 'nova-2', defaultBaseUrl: 'https://api.deepgram.com/v1', keyUrl: 'https://console.deepgram.com' },
  { id: 'assemblyai', label: 'AssemblyAI', kind: 'cloud', defaultModel: 'best', defaultBaseUrl: 'https://api.assemblyai.com/v2', keyUrl: 'https://www.assemblyai.com/app/api-keys' }
];

export function speechProvider(id: unknown): SpeechProviderInfo {
  return SPEECH_PROVIDERS.find((p) => p.id === id) ?? SPEECH_PROVIDERS[0]!;
}

/** The secret an API key is kept under, in the Keychain like every token. */
export function speechKeyName(id: SpeechProviderId): string {
  return `dictation.key.${id}`;
}

/** A locale for a service that wants a language: "en-GB" → "en"; no
 *  setting → undefined, meaning let the service detect it. */
export function speechLanguage(locale: string): string | undefined {
  const language = locale.split('-')[0]?.trim().toLowerCase();
  return language ? language : undefined;
}

/**
 * whisper-cli's stdout, as text. It prints progress and timing lines next to
 * the words (VoiceSmith filters the same ones), and a blank-audio marker when
 * nothing was said.
 */
export function whisperCliText(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[') && !line.startsWith('whisper_'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which of the model files found to use by default: the provider's default
 *  (base.en) when it's there, otherwise the best of what is. */
export function preferredWhisperModel(files: readonly string[]): string | undefined {
  const name = (file: string) => file.split('/').pop()!.replace(/\.bin$/, '');
  const order = ['ggml-base.en', 'ggml-base', 'ggml-small.en', 'ggml-small', 'ggml-medium.en', 'ggml-medium',
    'ggml-large-v3-turbo', 'ggml-large-v3', 'ggml-tiny.en', 'ggml-tiny'];
  for (const wanted of order) {
    const hit = files.find((f) => name(f) === wanted) ?? files.find((f) => name(f).startsWith(`${wanted}-q`));
    if (hit) return hit;
  }
  return files[0];
}
