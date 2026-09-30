/**
 * Speech providers other than Apple's (item 97): a finished recording in,
 * text out. The wire formats are VoiceSmith's (`CloudSpeechProviders.swift`,
 * `WhisperCPPProvider.swift`), so a key or a server that works there works
 * here.
 *
 * Every function throws an Error whose message is fit to show in the
 * dictation pill or next to Settings' Test button.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  preferredWhisperModel, speechKeyName, speechLanguage, speechProvider, whisperCliText,
  type SpeechProviderId
} from '@kovan/core';
import type { DesktopHost } from './host';

const WHISPER_CLI = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'];

/** Where whisper.cpp models are looked for: Kovan's own folder, and
 *  VoiceSmith's, so a model downloaded there is never downloaded twice. */
export function whisperModelFolders(userData: string): string[] {
  return [
    path.join(userData, 'Models'),
    path.join(os.homedir(), 'Library/Application Support/VoiceSmith/Models')
  ];
}

export function findWhisperModels(userData: string): string[] {
  const found: string[] = [];
  for (const folder of whisperModelFolders(userData)) {
    try {
      for (const name of readdirSync(folder)) {
        if (/^ggml-.*\.bin$/.test(name)) found.push(path.join(folder, name));
      }
    } catch {
      // A folder that isn't there is simply empty.
    }
  }
  return found;
}

export function whisperCliPath(): string | undefined {
  return WHISPER_CLI.find((p) => existsSync(p));
}

export interface SpeechConfig {
  provider: SpeechProviderId;
  model: string;
  baseUrl: string;
  key: string;
  /** "en" etc., or undefined to let the service detect it. */
  language?: string;
  /** whisper.cpp only: the model file. */
  modelFile: string;
}

/** The provider's settings as saved, with its defaults filled in. */
export async function speechConfig(host: DesktopHost, userData: string, provider?: SpeechProviderId): Promise<SpeechConfig> {
  const id = speechProvider(provider ?? host.config.get('dictation.provider', 'apple')).id;
  const info = speechProvider(id);
  const models = host.config.get('dictation.models', {} as Record<string, string>);
  const baseUrls = host.config.get('dictation.baseUrls', {} as Record<string, string>);
  const language = speechLanguage(host.config.get('dictation.locale', ''));
  const saved = host.config.get('dictation.whisperModel', '');
  return {
    provider: id,
    model: models[id]?.trim() || info.defaultModel,
    baseUrl: (baseUrls[id]?.trim() || info.defaultBaseUrl).replace(/\/+$/, ''),
    key: info.kind === 'cloud' ? (await host.secrets.get(speechKeyName(id))) ?? '' : '',
    ...(language ? { language } : {}),
    modelFile: saved && existsSync(saved) ? saved : preferredWhisperModel(findWhisperModels(userData)) ?? ''
  };
}

export async function transcribe(config: SpeechConfig, wav: string): Promise<string> {
  const info = speechProvider(config.provider);
  if (info.kind === 'cloud' && !config.key) {
    throw new Error(`No API key for ${info.label} — add one in Settings › Dictation.`);
  }
  switch (config.provider) {
    case 'whisper-cpp':
      // A base URL means a running whisper-server, which speaks OpenAI's format.
      return config.baseUrl ? openAiCompatible(config, wav, info.label) : whisperCli(config, wav);
    case 'openai':
    case 'groq':
      return openAiCompatible(config, wav, info.label);
    case 'deepgram':
      return deepgram(config, wav);
    case 'assemblyai':
      return assemblyAi(config, wav);
    default:
      throw new Error('Apple Speech transcribes live, not from a recording.');
  }
}

function whisperCli(config: SpeechConfig, wav: string): Promise<string> {
  const cli = whisperCliPath();
  if (!cli) return Promise.reject(new Error('whisper-cli isn’t installed — `brew install whisper-cpp`.'));
  if (!config.modelFile) return Promise.reject(new Error('No whisper.cpp model found — pick a model file in Settings › Dictation.'));
  const args = ['-m', config.modelFile, '-f', wav, '--no-timestamps', '-l', config.language ?? 'auto'];
  return new Promise((resolve, reject) => {
    // stderr is whisper.cpp's chatter; buffered and dropped rather than piped
    // unread, which is what hung VoiceSmith once.
    execFile(cli, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`whisper.cpp failed: ${error.message.split('\n')[0]}`));
      else resolve(whisperCliText(stdout));
    });
  });
}

async function send(label: string, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new Error(`${label} couldn’t be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await response.text();
  if (response.status === 401 || response.status === 403) throw new Error(`${label} rejected the API key.`);
  if (!response.ok) {
    let detail = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string; err_msg?: string; message?: string };
      detail = (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ?? parsed.err_msg ?? parsed.message ?? detail;
    } catch { /* not JSON */ }
    throw new Error(`${label}: ${detail || `HTTP ${response.status}`}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} sent an unreadable answer.`);
  }
}

async function openAiCompatible(config: SpeechConfig, wav: string, label: string): Promise<string> {
  const form = new FormData();
  form.append('model', config.model);
  form.append('response_format', 'json');
  if (config.language) form.append('language', config.language);
  form.append('file', new Blob([await readFile(wav)], { type: 'audio/wav' }), path.basename(wav));
  const headers: Record<string, string> = {};
  // A local whisper-server rejects an Authorization header it can't read.
  if (config.key) headers['Authorization'] = `Bearer ${config.key}`;
  const answer = await send(label, `${config.baseUrl}/audio/transcriptions`, { method: 'POST', headers, body: form }) as { text?: string };
  return (answer.text ?? '').trim();
}

async function deepgram(config: SpeechConfig, wav: string): Promise<string> {
  const query = new URLSearchParams({ model: config.model, smart_format: 'true', punctuate: 'true' });
  if (config.language) query.set('language', config.language);
  else query.set('detect_language', 'true');
  const answer = await send('Deepgram', `${config.baseUrl}/listen?${query}`, {
    method: 'POST',
    headers: { Authorization: `Token ${config.key}`, 'Content-Type': 'audio/wav' },
    body: await readFile(wav)
  }) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
  return (answer.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
}

async function assemblyAi(config: SpeechConfig, wav: string): Promise<string> {
  const auth = { Authorization: config.key };
  const upload = await send('AssemblyAI', `${config.baseUrl}/upload`, {
    method: 'POST', headers: auth, body: await readFile(wav)
  }) as { upload_url?: string };
  if (!upload.upload_url) throw new Error('AssemblyAI: the upload failed.');
  const body: Record<string, unknown> = { audio_url: upload.upload_url, speech_model: config.model, punctuate: true };
  if (config.language) body['language_code'] = config.language;
  else body['language_detection'] = true;
  const job = await send('AssemblyAI', `${config.baseUrl}/transcript`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }) as { id?: string };
  if (!job.id) throw new Error('AssemblyAI didn’t start a transcript.');
  // A dictation-length clip is done in seconds; two minutes is the ceiling.
  for (let i = 0; i < 120; i++) {
    const state = await send('AssemblyAI', `${config.baseUrl}/transcript/${job.id}`, { headers: auth }) as {
      status?: string; text?: string; error?: string;
    };
    if (state.status === 'completed') return (state.text ?? '').trim();
    if (state.status === 'error') throw new Error(`AssemblyAI: ${state.error ?? 'transcription failed'}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('AssemblyAI took too long.');
}
