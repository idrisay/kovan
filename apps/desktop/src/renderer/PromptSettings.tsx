/**
 * Settings › Prompts (item 181): the text each agent run starts from, and
 * the shared values filled into it.
 *
 * Each prompt is its built-in text until you save your own version, kept in
 * `prompt.template.<kind>`; saving the built-in text again, or Reset, clears
 * it. A run still starts from whatever the run sheet shows, so a one-off
 * change belongs there; this is for every run after. Drafts are kept per
 * prompt while the section is open, so switching tabs loses nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CONVENTIONS, PROMPT_TEMPLATES, missingPlaceholders, previewPrompt, promptFingerprint, promptTemplate,
  unknownPlaceholders, type Conventions, type PromptKind
} from '@kovan/core';

/** Sent when a prompt or the shared values are saved, so an open run sheet can rebuild. */
export const PROMPTS_CHANGED = 'kovan:prompts-changed';

const CONVENTIONS_KEY = 'prompt.conventions';
/** The built-in text's fingerprint when each override was saved. */
const BASES_KEY = 'prompt.templateBase';

/** One per line in a box; blank lines dropped. */
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function SharedValues({ saved, onSaved }: { saved: Conventions; onSaved: (next: Conventions) => void }) {
  const [base, setBase] = useState(saved.baseBranch);
  const [checks, setChecks] = useState(saved.checks.join('\n'));
  const [untouchable, setUntouchable] = useState(saved.untouchable.join('\n'));
  const [reviewers, setReviewers] = useState(saved.pullRequestReviewers.join('\n'));
  const [note, setNote] = useState('');
  const next: Conventions = {
    baseBranch: base.trim() || DEFAULT_CONVENTIONS.baseBranch,
    checks: lines(checks),
    untouchable: lines(untouchable),
    pullRequestReviewers: lines(reviewers)
  };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);

  async function save() {
    await window.kovan.setSetting(CONVENTIONS_KEY, next);
    onSaved(next);
    setNote('Saved. New runs use these.');
    window.dispatchEvent(new CustomEvent(PROMPTS_CHANGED));
  }

  return (
    <div className="prompt-shared" aria-label="Shared values">
      <h3>Shared values</h3>
      <p className="settings-note">Filled into every prompt that names them.</p>
      <label>
        <span>Base branch <code>{'${base}'}</code></span>
        <input type="text" value={base} placeholder="main" spellCheck={false} onChange={(e) => { setBase(e.target.value); setNote(''); }} />
      </label>
      <label>
        <span>Pull request reviewers <code>{'${prReviewers}'}</code>, one per line, as GitHub login — name</span>
        <textarea rows={4} value={reviewers} spellCheck={false} placeholder={'octocat — Mona'} onChange={(e) => { setReviewers(e.target.value); setNote(''); }} />
      </label>
      <label>
        <span>Checks that must pass <code>{'${checks}'}</code>, one command per line</span>
        <textarea rows={3} value={checks} spellCheck={false} placeholder="npm run typecheck" onChange={(e) => { setChecks(e.target.value); setNote(''); }} />
      </label>
      <label>
        <span>Files agents must not edit <code>{'${untouchable}'}</code>, one per line</span>
        <textarea rows={2} value={untouchable} spellCheck={false} placeholder="messages/*.json" onChange={(e) => { setUntouchable(e.target.value); setNote(''); }} />
      </label>
      <div className="prompt-actions">
        <button type="button" className="primary" disabled={!dirty} onClick={() => void save()}>Save shared values</button>
        {dirty && <span className="settings-note">Unsaved changes</span>}
        {!dirty && note && <span className="settings-note ok">{note}</span>}
      </div>
    </div>
  );
}

export function PromptSettings({ initial }: { initial?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [overrides, setOverrides] = useState<Partial<Record<PromptKind, string>>>({});
  const [bases, setBases] = useState<Partial<Record<PromptKind, string>>>({});
  const [conventions, setConventions] = useState<Conventions>(DEFAULT_CONVENTIONS);
  const [kind, setKind] = useState<PromptKind>(
    PROMPT_TEMPLATES.some((t) => t.kind === initial) ? (initial as PromptKind) : 'implement'
  );
  /** Unsaved text per prompt; absent means the saved text. */
  const [drafts, setDrafts] = useState<Partial<Record<PromptKind, string>>>({});
  const [preview, setPreview] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [note, setNote] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.kovan.settings().then((settings) => {
      const found: Partial<Record<PromptKind, string>> = {};
      for (const t of PROMPT_TEMPLATES) {
        const value = settings[t.settingKey];
        if (typeof value === 'string' && value.trim()) found[t.kind] = value;
      }
      setOverrides(found);
      const savedBases = settings[BASES_KEY];
      setBases(savedBases && typeof savedBases === 'object' ? savedBases as Partial<Record<PromptKind, string>> : {});
      // Merged, as main merges them: a hand-edited or imported value may lack fields.
      const raw = settings[CONVENTIONS_KEY];
      setConventions({ ...DEFAULT_CONVENTIONS, ...(raw && typeof raw === 'object' ? raw as Partial<Conventions> : {}) });
      setLoaded(true);
    });
  }, []);

  const info = promptTemplate(kind);
  const saved = overrides[kind] ?? info.builtIn;
  const text = drafts[kind] ?? saved;
  const dirty = text !== saved;
  const customised = overrides[kind] !== undefined;
  const builtInMoved = customised && bases[kind] !== undefined && bases[kind] !== promptFingerprint(info.builtIn);
  const unknown = useMemo(() => unknownPlaceholders(kind, text), [kind, text]);
  const missing = useMemo(() => missingPlaceholders(kind, text), [kind, text]);
  const rendered = useMemo(() => (preview ? previewPrompt(kind, text, conventions) : ''), [preview, kind, text, conventions]);

  const pick = (next: PromptKind) => { setKind(next); setConfirmReset(false); setNote(''); };
  const edit = (value: string) => { setDrafts((d) => ({ ...d, [kind]: value })); setNote(''); };

  /** Writes `value` as this prompt; the built-in text itself is stored as no override. */
  async function store(value: string, message: string) {
    const isBuiltIn = value === info.builtIn || !value.trim();
    await window.kovan.setSetting(info.settingKey, isBuiltIn ? '' : value);
    const nextBases = { ...bases };
    if (isBuiltIn) delete nextBases[kind];
    else nextBases[kind] = promptFingerprint(info.builtIn);
    await window.kovan.setSetting(BASES_KEY, nextBases);
    setBases(nextBases);
    setOverrides((o) => {
      const next = { ...o };
      if (isBuiltIn) delete next[kind];
      else next[kind] = value;
      return next;
    });
    setDrafts((d) => { const next = { ...d }; delete next[kind]; return next; });
    setConfirmReset(false);
    setNote(message);
    window.dispatchEvent(new CustomEvent(PROMPTS_CHANGED));
  }

  /** Puts `${name}` where the cursor is, as if typed. */
  function insert(name: string) {
    const el = box.current;
    const token = `\${${name}}`;
    if (!el) return edit(text + token);
    const [from, to] = [el.selectionStart, el.selectionEnd];
    edit(text.slice(0, from) + token + text.slice(to));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(from + token.length, from + token.length); });
  }

  if (!loaded) return <p className="settings-note">Loading…</p>;

  return (
    <div className="prompt-settings">
      <p className="settings-note">
        What each agent run starts with. Change one for every run from now on; for a single run, edit the prompt in
        the run sheet instead. <code>{'${…}'}</code> names are filled in when the run starts.
      </p>

      <h3>Prompts</h3>
      <div className="prompt-tabs" role="tablist" aria-label="Prompts">
        {PROMPT_TEMPLATES.map((t) => (
          <button
            key={t.kind} type="button" role="tab" aria-selected={t.kind === kind}
            className={t.kind === kind ? 'prompt-tab on' : 'prompt-tab'} onClick={() => pick(t.kind)}
          >
            {t.title}
            {overrides[t.kind] !== undefined && <span className="prompt-tab-mark" title="Customised">edited</span>}
            {drafts[t.kind] !== undefined && drafts[t.kind] !== (overrides[t.kind] ?? t.builtIn) && <span className="prompt-tab-dot" title="Unsaved changes" />}
          </button>
        ))}
      </div>

      <div className="prompt-editor" role="tabpanel" aria-label={info.title}>
        <div className="prompt-editor-head">
          <span className="settings-note">Used by: {info.usedBy}</span>
          <span className={customised ? 'badge' : 'badge quiet'}>{customised ? 'Customised' : 'Built-in'}</span>
        </div>
        {builtInMoved && (
          <p className="settings-note warn">
            Kovan's built-in version of this prompt changed after you customised it, and yours doesn't include those
            changes. Compare with Preview, or Reset to the built-in prompt to take them.
          </p>
        )}

        <textarea
          ref={box} className="prompt-text" aria-label={`${info.title} prompt`} value={text} spellCheck={false}
          rows={18} onChange={(e) => edit(e.target.value)}
        />

        <div className="prompt-placeholders" aria-label="Placeholders">
          <span className="settings-note">Insert:</span>
          {info.placeholders.map((p) => (
            <button key={p.name} type="button" className="prompt-chip" title={p.means} onClick={() => insert(p.name)}>
              {`\${${p.name}}`}
            </button>
          ))}
        </div>

        {unknown.length > 0 && (
          <p className="settings-note error">
            {unknown.map((n) => `\${${n}}`).join(', ')} {unknown.length === 1 ? "isn't a name" : "aren't names"} this prompt
            fills, so {unknown.length === 1 ? 'it' : 'they'} would reach the agent as written. Check the spelling against the list above.
          </p>
        )}
        {missing.includes('report') && (
          <p className="settings-note warn">
            Without <code>{'${report}'}</code> the agent isn't told to leave its record, so the run adds nothing to the
            ticket's file and shows no screenshots.
          </p>
        )}

        <div className="prompt-actions">
          <button type="button" className="primary" disabled={!dirty} onClick={() => void store(text, 'Saved. New runs start from this.')}>
            Save prompt
          </button>
          {dirty && (
            <button type="button" className="link" onClick={() => setDrafts((d) => { const next = { ...d }; delete next[kind]; return next; })}>
              Discard changes
            </button>
          )}
          <button type="button" className={preview ? 'ghost on' : 'ghost'} aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
            Preview
          </button>
          <span className="spacer" />
          {customised && (confirmReset ? (
            <span className="prompt-confirm">
              Reset to the built-in prompt? Your version is deleted.
              <button type="button" className="link" onClick={() => void store(info.builtIn, 'Reset to the built-in prompt.')}>Reset</button>
              <button type="button" className="link" onClick={() => setConfirmReset(false)}>Keep mine</button>
            </span>
          ) : (
            <button type="button" className="link" onClick={() => setConfirmReset(true)}>Reset to built-in…</button>
          ))}
        </div>
        {note && !dirty && <p className="settings-note ok">{note}</p>}

        {preview && (
          <div className="prompt-preview" aria-label="Preview">
            <p className="settings-note">As an agent would get it, on an example {kind === 'sentry' ? 'Sentry error' : kind === 'implement' ? 'ticket' : 'pull request'}, with your shared values{dirty ? ', unsaved changes included' : ''}.</p>
            <pre>{rendered}</pre>
          </div>
        )}
      </div>

      <SharedValues saved={conventions} onSaved={setConventions} />
    </div>
  );
}
