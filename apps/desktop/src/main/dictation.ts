/**
 * Voice dictation (improvements item 88): the main-process half.
 *
 * The microphone and Apple's recogniser live in `baton-dictate`, a small Swift
 * helper built from `native/dictate` — see the note at the top of its source
 * for why a helper and not Chromium. This spawns it, forwards what it says to
 * the window as `baton:dictation` events, and passes on stop and cancel.
 *
 * One dictation at a time. The helper exits on EOF, so if Baton goes away
 * mid-dictation the microphone goes off with it.
 */

import { app, type WebContents } from 'electron';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pickDictationLocale, speechKeyName, speechProvider, SPEECH_PROVIDERS,
  type DictationLocale, type SpeechProviderId
} from '@baton/core';
import type { DesktopHost } from './host';
import { findWhisperModels, speechConfig, transcribe, whisperCliPath } from './transcribe';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export type DictationEvent =
  | { type: 'ready'; locale: string; onDevice: boolean; recording?: boolean }
  | { type: 'level'; value: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  /** Recording done; a provider other than Apple's is working on it (item 97). */
  | { type: 'transcribing'; provider: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'ended' };

export interface DictationStatus {
  available: boolean;
  mic: string;
  speech: string;
  system: string;
  /** What `start` will use: the setting, or the best match for the system. */
  locale: string;
  locales: DictationLocale[];
  /** The chosen speech provider (item 97). */
  provider: SpeechProviderId;
}

/** What Settings › Dictation shows about the providers (item 97). */
export interface SpeechSetup {
  provider: SpeechProviderId;
  models: Record<string, string>;
  baseUrls: Record<string, string>;
  /** Which cloud providers have a key saved. The key itself never leaves main. */
  keys: Record<string, boolean>;
  whisperCli: string | null;
  whisperModels: string[];
  /** The model file whisper.cpp will use: the saved one, or the best found. */
  whisperModel: string;
}

export type SpeechTest = { ok: true; text: string; ms: number } | { ok: false; message: string };

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'baton-dictate')
    : path.join(dirname, '../../resources/bin/baton-dictate');
}

export class Dictation {
  private child?: ChildProcess;
  private cancelled = false;
  private status?: Promise<Omit<DictationStatus, 'locale' | 'provider'>>;

  constructor(private readonly host: DesktopHost) {}

  /** Permissions and languages. Never prompts; cached until asked to refresh. */
  async currentStatus(refresh = false): Promise<DictationStatus> {
    if (refresh || !this.status) {
      this.status = new Promise((resolve) => {
        const file = helperPath();
        if (!existsSync(file)) {
          resolve({ available: false, mic: 'unknown', speech: 'unknown', system: 'en-US', locales: [] });
          return;
        }
        execFile(file, ['--status'], { timeout: 10_000 }, (error, stdout) => {
          try {
            if (error) throw error;
            const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Omit<DictationStatus, 'locale' | 'available' | 'provider'>;
            resolve({ available: true, ...parsed });
          } catch (err) {
            this.host.log.warn('Dictation status failed', err);
            resolve({ available: false, mic: 'unknown', speech: 'unknown', system: 'en-US', locales: [] });
          }
        });
      });
    }
    const status = await this.status;
    return {
      ...status,
      locale: pickDictationLocale(this.host.config.get('dictation.locale', ''), status.system, status.locales),
      provider: speechProvider(this.host.config.get('dictation.provider', 'apple')).id
    };
  }

  async setup(): Promise<SpeechSetup> {
    const keys: Record<string, boolean> = {};
    for (const p of SPEECH_PROVIDERS) {
      if (p.kind === 'cloud') keys[p.id] = Boolean(await this.host.secrets.get(speechKeyName(p.id)));
    }
    const config = await speechConfig(this.host, app.getPath('userData'), 'whisper-cpp');
    return {
      provider: speechProvider(this.host.config.get('dictation.provider', 'apple')).id,
      models: this.host.config.get('dictation.models', {} as Record<string, string>),
      baseUrls: this.host.config.get('dictation.baseUrls', {} as Record<string, string>),
      keys,
      whisperCli: whisperCliPath() ?? null,
      whisperModels: findWhisperModels(app.getPath('userData')),
      whisperModel: config.modelFile
    };
  }

  /** Saves (or, with '', removes) a provider's API key — to the Keychain. */
  async setKey(provider: SpeechProviderId, key: string): Promise<void> {
    if (speechProvider(provider).kind !== 'cloud') return;
    const name = speechKeyName(provider);
    if (key.trim()) await this.host.secrets.set(name, key.trim());
    else await this.host.secrets.delete(name);
  }

  /**
   * Transcribes a short sample with a provider, so a wrong key or model shows
   * up in Settings rather than mid-dictation. The sample is spoken by macOS's
   * own `say` — nothing is recorded.
   */
  async test(provider: SpeechProviderId): Promise<SpeechTest> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'baton-speech-'));
    const wav = path.join(dir, 'sample.wav');
    const started = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/say', ['-o', wav, '--data-format=LEI16@16000', 'Baton dictation test, one two three.'],
          { timeout: 20_000 }, (error) => (error ? reject(new Error('Couldn’t make the test sample.')) : resolve()));
      });
      const spoken = Date.now();
      let text: string;
      if (speechProvider(provider).kind === 'apple') {
        const status = await this.currentStatus();
        if (!status.available) throw new Error('The dictation helper is missing from this build.');
        text = await new Promise<string>((resolve, reject) => {
          execFile(helperPath(), ['--locale', status.locale, '--file', wav], { timeout: 30_000 }, (error, stdout) => {
            const events = stdout.split('\n').flatMap((line) => {
              try { return [JSON.parse(line) as DictationEvent]; } catch { return []; }
            });
            const final = events.find((e) => e.type === 'final');
            const failed = events.find((e) => e.type === 'error');
            if (final && final.type === 'final') resolve(final.text);
            else reject(new Error(failed && failed.type === 'error' ? failed.message : error?.message ?? 'No answer.'));
          });
        });
      } else {
        text = await transcribe(await speechConfig(this.host, app.getPath('userData'), provider), wav);
      }
      this.host.log.info(`Speech test ${provider}: sample ${spoken - started} ms, transcription ${Date.now() - spoken} ms`);
      return text ? { ok: true, text, ms: Date.now() - spoken } : { ok: false, message: 'It answered, but heard nothing.' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      void rm(dir, { recursive: true, force: true });
    }
  }

  async start(target: WebContents): Promise<{ ok: true } | { ok: false; message: string }> {
    if (this.child) return { ok: false, message: 'Already listening.' };
    const send = (event: DictationEvent) => {
      if (!target.isDestroyed()) target.send('baton:dictation', event);
    };

    // Smoke runs can't speak into a microphone; a scripted helper stands in,
    // only ever for a throwaway profile.
    if (process.env['BATON_SMOKE'] && process.env['BATON_USER_DATA'] && process.env['BATON_DICTATE_FAKE']) {
      return this.fake(send);
    }

    const status = await this.currentStatus();
    if (!status.available) {
      return { ok: false, message: 'The dictation helper is missing from this build.' };
    }
    // Any provider but Apple's: the helper only records, and the words come
    // from the provider once you finish (item 97).
    const config = status.provider === 'apple' ? undefined : await speechConfig(this.host, app.getPath('userData'));
    if (config && speechProvider(config.provider).kind === 'cloud' && !config.key) {
      return { ok: false, message: `No API key for ${speechProvider(config.provider).label} — add one in Settings › Dictation.` };
    }
    const dir = config ? await mkdtemp(path.join(os.tmpdir(), 'baton-dictation-')) : undefined;
    const args = config && dir ? ['--record', path.join(dir, 'dictation.wav')] : ['--locale', status.locale];
    const child = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.cancelled = false;
    // Set while a recording is with the provider: the helper has exited, but
    // dictation hasn't ended until the words (or an error) are back.
    let working: Promise<void> | undefined;
    const discard = () => { if (dir) void rm(dir, { recursive: true, force: true }); };
    let buffered = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as DictationEvent | { type: 'recorded'; path: string; seconds: number };
          if (event.type === 'recorded') {
            if (!config) continue;
            const label = speechProvider(config.provider).label;
            send({ type: 'transcribing', provider: label });
            working = transcribe(config, event.path)
              .then((text) => { if (!this.cancelled) send({ type: 'final', text }); })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                this.host.log.warn(`Dictation via ${label} failed: ${message}`);
                if (!this.cancelled) send({ type: 'error', code: 'provider', message });
              })
              .finally(() => {
                // Recordings are deleted once transcribed, whatever happened.
                discard();
                send({ type: 'ended' });
              });
            continue;
          }
          if (event.type === 'error') this.host.log.warn(`Dictation: ${event.code}: ${event.message}`);
          send(event);
        } catch {
          // Not ours — the Speech framework prints its own chatter to stderr,
          // but be safe about stdout too.
        }
      }
    });
    // stderr is framework noise ("No Assistant asset for language …"); dropped.
    child.stderr!.resume();
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      if (code !== 0 && code !== null) this.host.log.warn(`Dictation helper exited with ${code}`);
      // stdout may still hold the "recorded" line when exit fires.
      setImmediate(() => {
        if (working) return;
        discard();
        send({ type: 'ended' });
      });
    });
    child.on('error', (err) => {
      this.host.log.error('Dictation helper failed to start', err);
      send({ type: 'error', code: 'spawn', message: 'The dictation helper could not start.' });
    });
    // Permission may just have been granted in the prompt this start caused.
    this.status = undefined;
    return { ok: true };
  }

  stop(): void {
    this.child?.stdin?.write('stop\n');
  }

  cancel(): void {
    // Also drops an answer still on its way from a provider.
    this.cancelled = true;
    const child = this.child;
    if (!child) return;
    child.stdin?.write('cancel\n');
    child.stdin?.end();
    // It exits on its own at once; this is only for one that hangs.
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1_500).unref();
  }

  dispose(): void {
    this.cancel();
  }

  private fake(send: (event: DictationEvent) => void): { ok: true } {
    const words = ['Fix', 'the', 'flaky', 'payment', 'retry', 'test'];
    const timers: NodeJS.Timeout[] = [];
    let said = 0;
    let done = false;
    const finish = (text: string | undefined) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      this.child = undefined;
      if (text !== undefined) send({ type: 'final', text });
      send({ type: 'ended' });
    };
    // Stands in for the child so stop/cancel reach it.
    this.child = {
      stdin: {
        write: (command: string) => {
          if (command.startsWith('stop')) setTimeout(() => finish(`${words.slice(0, Math.max(said, 1)).join(' ')}.`), 150);
          if (command.startsWith('cancel')) finish(undefined);
          return true;
        },
        end: () => undefined
      },
      exitCode: null,
      kill: () => finish(undefined)
    } as unknown as ChildProcess;
    send({ type: 'ready', locale: 'en-GB', onDevice: true });
    words.forEach((_, i) => {
      timers.push(setTimeout(() => {
        said = i + 1;
        send({ type: 'level', value: 0.3 + (i % 3) * 0.2 });
        send({ type: 'partial', text: words.slice(0, said).join(' ') });
      }, 120 * (i + 1)));
    });
    return { ok: true };
  }
}
