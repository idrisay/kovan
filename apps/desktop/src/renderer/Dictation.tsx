/**
 * Voice dictation (improvements item 88): double-tap ⌘, speak, double-tap ⌘
 * again, and what you said lands where you were typing — a prompt, a field,
 * or a terminal. Esc throws it away.
 *
 * The words are Apple's on-device recogniser's, through the `baton-dictate`
 * helper (see `main/dictation.ts`). While you speak, a pill at the bottom
 * shows them live with a level meter, so there's never doubt it's listening.
 * Nothing is inserted until you finish: a half-heard sentence never lands in
 * a prompt an agent is about to read.
 *
 * Where it lands is decided at the start — whatever had focus when you
 * double-tapped — so clicking around while talking doesn't send it elsewhere:
 *   - a terminal: typed into that session, never followed by Enter
 *   - a text field or editor: inserted at the caret, undoable with ⌘Z
 *   - nothing: copied to the clipboard, and the pill says so
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DoubleTap, joinDictation, SPEECH_PROVIDERS, speechProvider, type SpeechProviderId } from '@baton/core';
import type { DictationEvent, SpeechSetup } from './types';
import { MicIcon } from './icons';

/** Starts (or finishes) dictation into `target` — the mic buttons' way in. */
export function requestDictation(target?: Element | null): void {
  window.dispatchEvent(new CustomEvent('baton:dictate', { detail: { target: target ?? document.activeElement } }));
}

type Phase = 'idle' | 'starting' | 'listening' | 'finishing' | 'done' | 'error';

interface State {
  phase: Phase;
  text: string;
  levels: number[];
  locale?: string;
  onDevice?: boolean;
  /** Recording for a provider other than Apple's: no words until the end. */
  recording?: boolean;
  /** Which provider is transcribing the recording. */
  transcribing?: string;
  message?: string;
  /** Which permission an error is about, for its button. */
  pane?: 'mic' | 'speech';
}

const IDLE: State = { phase: 'idle', text: '', levels: [0, 0, 0, 0, 0] };

/** Where the words will go. */
function describeTarget(target: Element | null): string {
  if (target?.closest('.term[data-session-id]')) return 'the terminal';
  if (target?.closest('.prompt-label')) return 'the prompt';
  if (isTextField(target)) return 'the field';
  if (target instanceof HTMLElement && target.isContentEditable) return 'the editor';
  return 'the clipboard';
}

function isTextField(el: Element | null): el is HTMLTextAreaElement | HTMLInputElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled && !el.classList.contains('xterm-helper-textarea');
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !el.disabled && ['text', 'search', 'url', 'email', ''].includes(el.type);
  }
  return false;
}

/** Puts the words where they belong. Says where they went. */
async function insert(target: Element | null, text: string): Promise<string> {
  const said = text.trim();
  if (!said) return 'Nothing was heard.';

  const terminal = target?.closest('.term[data-session-id]');
  if (terminal) {
    const id = terminal.getAttribute('data-session-id')!;
    // Typed, not run: Enter is yours to press.
    await window.baton.sessionWrite(id, said);
    (terminal.querySelector('.xterm-helper-textarea') as HTMLElement | null)?.focus();
    return 'Typed into the terminal.';
  }

  if (target && document.contains(target) && (isTextField(target) || (target as HTMLElement).isContentEditable)) {
    (target as HTMLElement).focus();
    let before = '';
    if (isTextField(target)) before = target.value.slice(0, target.selectionStart ?? target.value.length);
    const piece = joinDictation(before, said);
    // execCommand keeps ⌘Z working and fires the input event React listens for.
    const done = document.execCommand('insertText', false, piece);
    if (!done && isTextField(target)) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
      const start = target.selectionStart ?? target.value.length;
      const next = target.value.slice(0, start) + piece + target.value.slice(target.selectionEnd ?? start);
      setter?.call(target, next);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return 'Inserted.';
  }

  await window.baton.copyText(said);
  return 'Copied — no text field was focused.';
}

export function DictationLayer() {
  const [state, setState] = useState<State>(IDLE);
  const phase = useRef<Phase>('idle');
  const target = useRef<Element | null>(null);
  const cancelled = useRef(false);
  const doneTimer = useRef<ReturnType<typeof setTimeout>>();

  const set = useCallback((next: State | ((s: State) => State)) => {
    setState((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      phase.current = value.phase;
      return value;
    });
  }, []);

  const settle = useCallback((message: string) => {
    set((s) => ({ ...s, phase: 'done', message }));
    clearTimeout(doneTimer.current);
    doneTimer.current = setTimeout(() => set(IDLE), 1_600);
  }, [set]);

  const start = useCallback(async (into: Element | null) => {
    const settings = await window.baton.settings();
    if (settings['dictation.enabled'] === false) return;
    clearTimeout(doneTimer.current);
    target.current = into;
    cancelled.current = false;
    set({ ...IDLE, phase: 'starting' });
    const result = await window.baton.dictationStart();
    if (!result.ok) set({ ...IDLE, phase: 'error', message: result.message });
  }, [set]);

  const finish = useCallback(() => {
    set((s) => ({ ...s, phase: 'finishing' }));
    void window.baton.dictationStop();
  }, [set]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    void window.baton.dictationCancel();
    set(IDLE);
    (target.current as HTMLElement | null)?.focus?.();
  }, [set]);

  const toggle = useCallback((into: Element | null) => {
    const now = phase.current;
    if (now === 'idle' || now === 'done' || now === 'error') void start(into);
    else if (now === 'listening' || now === 'starting') finish();
  }, [start, finish]);

  // What the helper says.
  useEffect(() => window.baton.onDictation((event: DictationEvent) => {
    if (cancelled.current) return;
    switch (event.type) {
      case 'ready':
        set((s) => ({
          ...s, phase: s.phase === 'finishing' ? 'finishing' : 'listening',
          locale: event.locale, onDevice: event.onDevice, recording: event.recording === true
        }));
        break;
      case 'transcribing':
        set((s) => ({ ...s, phase: 'finishing', transcribing: event.provider }));
        break;
      case 'level':
        set((s) => ({ ...s, levels: [...s.levels.slice(1), event.value] }));
        break;
      case 'partial':
        set((s) => ({ ...s, text: event.text }));
        break;
      case 'final':
        void insert(target.current, event.text).then(settle);
        break;
      case 'error': {
        const pane = event.code === 'mic-denied' ? 'mic' : event.code === 'speech-denied' ? 'speech' : undefined;
        set({ ...IDLE, phase: 'error', message: event.message, ...(pane ? { pane } : {}) });
        break;
      }
      case 'ended':
        // Ended without a final (it failed to start, or was cut off): don't sit there.
        if (phase.current === 'starting' || phase.current === 'listening' || phase.current === 'finishing') set(IDLE);
        break;
    }
  }), [set, settle]);

  // Double-tap ⌘, and Esc. On the window in the capture phase, so a focused
  // terminal or editor can't swallow them first.
  useEffect(() => {
    const tap = new DoubleTap('Meta');
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase.current !== 'idle') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (phase.current === 'done' || phase.current === 'error') set(IDLE);
        else cancel();
        return;
      }
      tap.down(e.key, e.timeStamp, e.repeat);
    };
    const up = (e: KeyboardEvent) => {
      if (tap.up(e.key, e.timeStamp)) toggle(document.activeElement);
    };
    const blur = () => tap.reset();
    const asked = (e: Event) => toggle((e as CustomEvent<{ target: Element | null }>).detail.target);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    window.addEventListener('baton:dictate', asked);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('baton:dictate', asked);
    };
  }, [toggle, cancel, set]);

  if (state.phase === 'idle') return null;
  const live = state.phase === 'listening' || state.phase === 'starting';
  return (
    <div className={`dictation-pill ${state.phase}`} role="status" aria-live="polite">
      <div className="dictation-head">
        {state.phase === 'error' ? <span className="dot fail" /> : <MicIcon size={14} />}
        {live && (
          <span className="dictation-meter" aria-hidden="true">
            {state.levels.map((level, i) => (
              <span key={i} style={{ height: `${Math.max(3, Math.round(level * 16))}px` }} />
            ))}
          </span>
        )}
        <span className="dictation-state">
          {state.phase === 'starting' ? 'Starting…'
            : state.phase === 'listening' ? `Listening · into ${describeTarget(target.current)}`
            : state.phase === 'finishing' ? (state.transcribing ? `Transcribing with ${state.transcribing}…` : 'Finishing…')
            : state.phase === 'done' ? state.message
            : 'Dictation stopped'}
        </span>
        <span className="spacer" />
        {state.locale && live && (
          <span className="dictation-locale" title={state.onDevice ? 'Recognised on this Mac' : "Recognised by Apple's servers"}>
            {state.locale}{state.onDevice ? '' : ' · online'}
          </span>
        )}
        <button type="button" className="icon-button" aria-label="Cancel dictation" title="Cancel (Esc)" onClick={cancel}>
          ✕
        </button>
      </div>
      {state.phase === 'error' ? (
        <div className="dictation-error">
          <span>{state.message}</span>
          {state.pane && (
            <button type="button" className="ghost" onClick={() => void window.baton.privacyOpen(state.pane!)}>
              Open System Settings
            </button>
          )}
        </div>
      ) : state.phase !== 'done' && (
        <>
          <div className={state.text ? 'dictation-text' : 'dictation-text quiet-text'}>
            {state.text || (state.recording
              ? (state.phase === 'finishing' ? 'The words arrive in a moment…' : 'Recording — the words appear when you finish.')
              : 'Say what you want to type…')}
          </div>
          {live && <div className="dictation-hint">Double-tap ⌘ to insert · Esc to cancel</div>}
        </>
      )}
    </div>
  );
}

/** A mic button for a text field: focuses it and starts (or finishes) dictation. */
export function DictateButton({ field, label = 'Dictate' }: {
  field: () => HTMLElement | null;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="icon-button dictate-button"
      aria-label={label}
      title={`${label} (or double-tap ⌘)`}
      // Keep the caret where it is: a mousedown on the button would take focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const el = field();
        el?.focus();
        requestDictation(el);
      }}
    >
      <MicIcon size={14} />
    </button>
  );
}

const PERMISSION: Record<string, string> = {
  authorized: 'allowed',
  'not-determined': 'asked the first time you dictate',
  denied: 'not allowed',
  restricted: 'blocked by this Mac',
  unknown: 'unknown'
};

const fileName = (file: string) => file.split('/').pop() ?? file;

/**
 * Which speech model turns your voice into text (item 97) — VoiceSmith's
 * providers and defaults. Keys go to the Keychain and are never shown again.
 */
function SpeechProviderSettings({ onProvider }: { onProvider: (id: SpeechProviderId) => void }) {
  const [setup, setSetup] = useState<SpeechSetup>();
  const [key, setKey] = useState('');
  const [test, setTest] = useState<{ running: boolean; text?: string; ok?: boolean }>({ running: false });

  const reload = useCallback(() => window.baton.speechSetup().then(setSetup), []);
  useEffect(() => { void reload(); }, [reload]);
  if (!setup) return null;

  const info = speechProvider(setup.provider);
  const saveMap = (setting: 'dictation.models' | 'dictation.baseUrls', current: Record<string, string>, value: string) => {
    const next = { ...current, [info.id]: value };
    if (!value.trim()) delete next[info.id];
    setSetup({ ...setup, [setting === 'dictation.models' ? 'models' : 'baseUrls']: next });
    void window.baton.setSetting(setting, next);
  };
  const pick = (id: SpeechProviderId) => {
    setSetup({ ...setup, provider: id });
    setKey('');
    setTest({ running: false });
    onProvider(id);
    void window.baton.setSetting('dictation.provider', id);
  };
  const runTest = async () => {
    setTest({ running: true });
    const result = await window.baton.speechTest(info.id);
    setTest(result.ok
      ? { running: false, ok: true, text: `Heard “${result.text}” in ${(result.ms / 1000).toFixed(1)} s.` }
      : { running: false, ok: false, text: result.message });
  };

  return (
    <>
      <label className="settings-field">
        <span>Speech model</span>
        <select value={setup.provider} onChange={(e) => pick(e.target.value as SpeechProviderId)}>
          {SPEECH_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} · {p.kind === 'apple' ? 'on this Mac, live' : p.kind === 'local' ? 'on this Mac' : 'API key'}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-note">
        {info.kind === 'apple'
          ? 'The default: no key, and the only one that shows your words while you speak.'
          : info.kind === 'local'
            ? 'Runs whisper.cpp on this Mac — audio never leaves it. The words appear when you finish.'
            : `Your recording is sent to ${info.label} when you finish, and the words come back. Recordings are deleted after.`}
      </p>

      {info.kind === 'local' && (
        <>
          {!setup.whisperCli && !setup.baseUrls[info.id] && (
            <p className="settings-note warn-note">whisper-cli isn’t installed. <code>brew install whisper-cpp</code>, or point it at a running whisper-server below.</p>
          )}
          <label className="settings-field">
            <span>Model file</span>
            <div className="speech-row">
              <select
                value={setup.whisperModel}
                onChange={(e) => {
                  setSetup({ ...setup, whisperModel: e.target.value });
                  void window.baton.setSetting('dictation.whisperModel', e.target.value);
                }}
              >
                {!setup.whisperModel && <option value="">No model found</option>}
                {[...new Set([...setup.whisperModels, setup.whisperModel].filter(Boolean))].map((f) => (
                  <option key={f} value={f}>{fileName(f)}{f.includes('/VoiceSmith/') ? ' · VoiceSmith’s' : ''}</option>
                ))}
              </select>
              <button type="button" className="ghost" onClick={() => void window.baton.speechPickModel().then((f) => { if (f) void reload(); })}>
                Choose file…
              </button>
            </div>
          </label>
        </>
      )}

      {info.kind === 'cloud' && (
        <>
          <label className="settings-field">
            <span>Model</span>
            <input
              type="text" placeholder={info.defaultModel} value={setup.models[info.id] ?? ''}
              onChange={(e) => saveMap('dictation.models', setup.models, e.target.value)}
            />
          </label>
          <label className="settings-field">
            <span>API key {setup.keys[info.id] ? '· saved' : ''}</span>
            <div className="speech-row">
              <input
                type="password" value={key} autoComplete="off"
                placeholder={setup.keys[info.id] ? '•••••••• (saved in the Keychain)' : `Paste your ${info.label} key`}
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                type="button" className="ghost" disabled={!key.trim()}
                onClick={() => void window.baton.speechKey(info.id, key).then(() => { setKey(''); void reload(); })}
              >
                Save
              </button>
              {setup.keys[info.id] && (
                <button type="button" className="ghost" onClick={() => void window.baton.speechKey(info.id, '').then(reload)}>
                  Remove
                </button>
              )}
            </div>
          </label>
          {info.keyUrl && (
            <p className="settings-note">
              Get a key: <button type="button" className="link" onClick={() => void window.baton.openExternal(info.keyUrl!)}>{info.keyUrl.replace(/^https:\/\//, '')}</button>
            </p>
          )}
        </>
      )}

      {info.kind !== 'apple' && (
        <label className="settings-field">
          <span>{info.kind === 'local' ? 'whisper-server URL (optional)' : 'Base URL (optional)'}</span>
          <input
            type="text"
            placeholder={info.defaultBaseUrl || 'http://127.0.0.1:8080/v1 — leave blank to run whisper-cli'}
            value={setup.baseUrls[info.id] ?? ''}
            onChange={(e) => saveMap('dictation.baseUrls', setup.baseUrls, e.target.value)}
          />
        </label>
      )}

      <div className="speech-test">
        <button type="button" className="ghost" disabled={test.running} onClick={() => void runTest()}>
          {test.running ? 'Testing…' : `Test ${info.label}`}
        </button>
        {test.text && <span className={test.ok ? 'speech-test-ok' : 'speech-test-fail'}>{test.text}</span>}
      </div>
      <p className="settings-note">The test transcribes a short sample spoken by macOS — nothing is recorded.</p>
    </>
  );
}

/** Settings › General › Dictation. */
export function DictationSettings() {
  const [enabled, setEnabled] = useState(true);
  const [setting, setSetting] = useState('');
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.baton.dictationStatus>>>();
  const [provider, setProvider] = useState<SpeechProviderId>();
  const apple = (provider ?? status?.provider ?? 'apple') === 'apple';

  useEffect(() => {
    void window.baton.settings().then((s) => {
      setEnabled(s['dictation.enabled'] !== false);
      setSetting(typeof s['dictation.locale'] === 'string' ? s['dictation.locale'] : '');
    });
    // Permissions may have changed in System Settings since last time.
    void window.baton.dictationStatus(true).then(setStatus);
  }, []);

  const auto = status?.locales.find((l) => l.id === status.locale);
  return (
    <>
      <h3>Dictation</h3>
      <p className="settings-note">
        Double-tap ⌘, speak, and double-tap ⌘ again: the words go where you were typing — a prompt, a field or a
        terminal (typed, never run). Esc cancels. The prompt in the run sheet has a mic button too.
      </p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            void window.baton.setSetting('dictation.enabled', e.target.checked);
          }}
        />
        <span>Dictate with double-tap ⌘</span>
      </label>
      <SpeechProviderSettings onProvider={(id) => setProvider(id)} />
      {status && !status.available ? (
        <p className="settings-note">The dictation helper is missing from this build, so dictation is off.</p>
      ) : (
        <>
          <label className="settings-field">
            <span>Language</span>
            <select
              value={setting}
              onChange={(e) => {
                setSetting(e.target.value);
                void window.baton.setSetting('dictation.locale', e.target.value);
                void window.baton.dictationStatus().then(setStatus);
              }}
            >
              <option value="">
                Automatic{auto ? ` — ${auto.name}` : ''}
              </option>
              {(status?.locales ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.onDevice ? 'on this Mac' : "Apple's servers"}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-note">
            {apple
              ? `"On this Mac" never sends audio anywhere. A language marked "Apple's servers" is recognised online, until macOS downloads it for on-device use (System Settings › Keyboard › Dictation).`
              : 'Told to the speech model as a hint; Automatic lets it detect the language.'}
          </p>
          {status && (
            <div className="dictation-permissions">
              <div>
                Microphone: <strong>{PERMISSION[status.mic] ?? status.mic}</strong>
                {status.mic === 'denied' && (
                  <button type="button" className="link" onClick={() => void window.baton.privacyOpen('mic')}>
                    Open System Settings
                  </button>
                )}
              </div>
              {apple && <div>
                Speech recognition: <strong>{PERMISSION[status.speech] ?? status.speech}</strong>
                {status.speech === 'denied' && (
                  <button type="button" className="link" onClick={() => void window.baton.privacyOpen('speech')}>
                    Open System Settings
                  </button>
                )}
              </div>}
            </div>
          )}
        </>
      )}
    </>
  );
}
