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
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickDictationLocale, type DictationLocale } from '@baton/core';
import type { DesktopHost } from './host';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export type DictationEvent =
  | { type: 'ready'; locale: string; onDevice: boolean }
  | { type: 'level'; value: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
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
}

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'baton-dictate')
    : path.join(dirname, '../../resources/bin/baton-dictate');
}

export class Dictation {
  private child?: ChildProcess;
  private status?: Promise<Omit<DictationStatus, 'locale'>>;

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
            const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Omit<DictationStatus, 'locale' | 'available'>;
            resolve({ available: true, ...parsed });
          } catch (err) {
            this.host.log.warn('Dictation status failed', err);
            resolve({ available: false, mic: 'unknown', speech: 'unknown', system: 'en-US', locales: [] });
          }
        });
      });
    }
    const status = await this.status;
    return { ...status, locale: pickDictationLocale(this.host.config.get('dictation.locale', ''), status.system, status.locales) };
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
    const child = spawn(helperPath(), ['--locale', status.locale], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
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
          const event = JSON.parse(line) as DictationEvent;
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
      send({ type: 'ended' });
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
