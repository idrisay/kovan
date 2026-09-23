import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAge, modelFamily, type ModelFamily } from '@baton/core';
import type {
  JiraIssue, ModelList, PullSummary, RunKind, Runner, RunTarget, SentryFrame, SentryIssue, StartResult, TestSelection
} from './types';
import { RefreshIcon } from './icons';
import { TestEnvironmentPicker } from './TestEnvironments';

const LAST_MODEL_KEY = 'runner.lastModel';

const KIND_LABEL: Record<RunKind, string> = {
  implement: 'Work on this in an agent',
  review: 'Review in an agent',
  unblock: 'Unblock in an agent',
  verify: 'Check it shipped'
};

/**
 * The prompt, before it is sent.
 *
 * You see it first on purpose. The prompts are long because every line is a
 * mistake somebody made once, and an agent started on a prompt nobody read is
 * how the wrong thing gets built confidently.
 */
export function RunSheet({
  kind,
  pull,
  issue,
  sentry,
  onClose,
  onStarted
}: {
  kind: RunKind;
  pull?: PullSummary;
  issue?: JiraIssue;
  sentry?: { issue: SentryIssue; frames: SentryFrame[] };
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}) {
  const [runners, setRunners] = useState<Runner[]>([]);
  const [knownModels, setKnownModels] = useState<Partial<Record<ModelFamily, ModelList>>>({});
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [runnerId, setRunnerId] = useState('');
  const [cwd, setCwd] = useState('');
  // More folders the work spans, beside `cwd` — where the agent starts.
  const [extraCwds, setExtraCwds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<TestSelection>();
  // Hand edits to the prompt survive an environment change: the prompt is
  // only rebuilt for you while you have not touched it.
  const [edited, setEdited] = useState(false);
  const [stale, setStale] = useState(false);
  const firstBuild = useRef(true);

  const subject = { pull, issue, sentry };
  const subjectId = sentry ? sentry.issue.shortId : issue ? issue.key : pull ? `${pull.repo}#${pull.number}` : '';
  const runner = runners.find((r) => r.id === runnerId);

  useEffect(() => {
    void window.baton.runners().then((list) => {
      setRunners(list);
      // The default agent if one is set and still installed, else the first.
      setRunnerId((current) => current || list[0]?.id || '');
    });
    void window.baton.knownModels().then(setKnownModels);
    void window.baton.runTargets().then(setTargets);
    void window.baton.defaultCwd(pull?.repo).then((dir) => setCwd((c) => c || dir || ''));
    // Rebuilding on every keystroke of the prompt would discard the user's
    // edits, so this deliberately runs once per sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, subjectId]);

  // Never leave Folder empty while there are folders to offer: the default
  // above can come back empty (no clone matched, or the list was still being
  // scanned), and an empty Folder silently blocks Run.
  useEffect(() => {
    if (cwd || targets.length === 0) return;
    const match = pull ? targets.find((t) => t.label.toLowerCase() === pull.repo.toLowerCase()) : undefined;
    setCwd((match ?? targets[0]!).path);
  }, [cwd, targets, pull]);

  const rebuild = useCallback((selection: TestSelection | undefined) => {
    void window.baton.buildPrompt(kind, subject, selection).then((next) => {
      setPrompt(next);
      setEdited(false);
      setStale(false);
    });
    // `subject` is rebuilt every render; the sheet is keyed by kind and subject.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, subjectId]);

  const onTestChange = useCallback((selection: TestSelection | undefined) => {
    setTest(selection);
    if (firstBuild.current || !edited) {
      firstBuild.current = false;
      rebuild(selection);
    } else {
      setStale(true);
    }
  }, [edited, rebuild]);

  // Whichever model this agent was last run with, anywhere — not per ticket,
  // per agent: switching the Agent dropdown re-reads this for the newly
  // picked one, which is what "remember it for next time" has to mean when
  // there is no single "next time" to attach it to.
  useEffect(() => {
    if (!runnerId) return;
    void window.baton.settings().then((settings) => {
      const remembered = (settings[LAST_MODEL_KEY] as Record<string, string> | undefined)?.[runnerId];
      setModel(remembered ?? '');
    });
  }, [runnerId]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      const result: StartResult = await window.baton.startAgent(
        { kind, subjectId, runnerId, cwd, extraCwds, prompt, model: model || undefined, test },
        subject
      );
      if (result.ok) {
        const settings = await window.baton.settings();
        const remembered = (settings[LAST_MODEL_KEY] as Record<string, string> | undefined) ?? {};
        void window.baton.setSetting(LAST_MODEL_KEY, { ...remembered, [runnerId]: model });
        onStarted(result.sessionId);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{sentry ? 'Fix in an agent' : KIND_LABEL[kind]}</h2>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </header>

        <p className="subject">
          {sentry ? `${sentry.issue.shortId} — ${sentry.issue.title}` : issue ? `${issue.key} — ${issue.summary}` : pull?.title}
        </p>

        <div className="run-controls">
          <label>
            <span>Agent</span>
            <select value={runnerId} onChange={(e) => setRunnerId(e.target.value)}>
              {runners.map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name}
                  {runner.invocation === 'shellFunction' ? ' (shell function)' : ''}
                </option>
              ))}
            </select>
          </label>
          <FolderField
            targets={targets} cwd={cwd} extras={extraCwds} runner={runner}
            onChange={(main, extras) => { setCwd(main); setExtraCwds(extras); }}
          />
          {runner?.modelFlag && (
            <ModelField
              runner={runner} model={model} onChange={setModel}
              list={knownModels[modelFamily(runner.command) ?? ('' as ModelFamily)]}
              onList={(family, list) => setKnownModels((all) => ({ ...all, [family]: list }))}
            />
          )}
        </div>

        <TestEnvironmentPicker kind={kind} onChange={onTestChange} />

        <label className="prompt-label">
          <span>
            Prompt — edit before sending if you want
            {stale && (
              <>
                {' · '}the environment changed after you edited it.{' '}
                <button type="button" className="link" onClick={() => rebuild(test)}>Rebuild prompt</button>
              </>
            )}
          </span>
          <textarea
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setEdited(true); }}
            spellCheck={false}
            rows={18}
          />
        </label>

        {error && <div className="error boxed">{error}</div>}

        <footer className="sheet-foot">
          <span className="quiet small">
            Filed under {subjectId} · the agent writes its report back here
          </span>
          <button className="primary" disabled={busy || !runnerId || !cwd} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Run'}
          </button>
        </footer>
      </div>
    </div>
  );
}

const OTHER = '__other__';

/**
 * Model: a dropdown of what this agent takes, "Type another model…" for
 * anything else, and ↻ to look up the current list — `opencode models` for
 * opencode, a web search of the vendor's docs for Claude Code and Codex. A
 * search only adds names (tagged new); it never changes the one picked.
 */
function ModelField({ runner, model, list, onChange, onList }: {
  runner: Runner;
  model: string;
  list?: ModelList;
  onChange: (model: string) => void;
  onList: (family: ModelFamily, list: ModelList) => void;
}) {
  const family = modelFamily(runner.command);
  const models = list?.models ?? [];
  const [typing, setTyping] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const other = typing || (model !== '' && !models.includes(model));

  async function search() {
    setSearching(true);
    setError('');
    const result = await window.baton.modelsSearch(runner.command);
    setSearching(false);
    if ('error' in result) setError(result.error);
    else if (family) onList(family, result);
  }

  const age = list?.at ? formatAge(new Date(list.at).toISOString()) : undefined;
  const note = searching
    ? (family === 'opencode' ? 'Asking opencode for its models…' : 'Searching the docs for current models… this spends a little of your quota.')
    : error || (list?.added.length ? `${list.added.length} new since the last search.` : '')
      || (age ? `List updated ${age === 'just now' ? 'just now' : `${age} ago`} · ↻ searches again` : family ? 'Built-in list · ↻ looks up current models' : '');

  return (
    <label className="model-field">
      <span>Model</span>
      <span className="model-field-row">
        {other ? (
          <input
            autoFocus={typing}
            value={model}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => setTyping(false)}
            placeholder="Any model name"
            spellCheck={false}
          />
        ) : (
          <select
            value={model}
            onChange={(e) => {
              if (e.target.value === OTHER) { setTyping(true); onChange(''); }
              else onChange(e.target.value);
            }}
          >
            <option value="">Default{runner.model ? ` (${runner.model})` : ' (agent decides)'}</option>
            {models.map((name) => (
              <option key={name} value={name}>{name}{list?.added.includes(name) ? '  · new' : ''}</option>
            ))}
            <option value={OTHER}>Type another model…</option>
          </select>
        )}
        {other && models.length > 0 && (
          <button type="button" className="link" onClick={() => { setTyping(false); onChange(''); }}>List</button>
        )}
        {searching ? (
          <button type="button" className="link" onClick={() => void window.baton.modelsSearchCancel()}>Cancel</button>
        ) : (
          <button
            type="button" className="icon-button boxed" disabled={!family}
            aria-label="Search for current models"
            title={family ? 'Search for current models' : 'Baton cannot look up models for this agent'}
            onClick={() => void search()}
          >
            <RefreshIcon size={13} />
          </button>
        )}
      </span>
      {note && <span className={error ? 'model-field-note error' : 'model-field-note'}>{note}</span>}
    </label>
  );
}

/**
 * Folder: one or more of the watched clones. The first one ticked is where
 * the agent starts ("starts here"); the rest are opened to it with
 * `--add-dir` where its CLI has that (Claude Code, Codex) and named in the
 * prompt either way.
 */
function FolderField({ targets, cwd, extras, runner, onChange }: {
  targets: RunTarget[];
  cwd: string;
  extras: string[];
  runner?: Runner;
  onChange: (main: string, extras: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const label = (p: string) => targets.find((t) => t.path === p)?.label ?? p.split('/').pop() ?? p;
  const chosen = [cwd, ...extras].filter(Boolean);

  function toggle(p: string) {
    if (p === cwd) {
      // Unticking where it starts hands that role to the next folder, if any.
      if (extras.length > 0) onChange(extras[0]!, extras.slice(1));
      return;
    }
    if (!cwd) return onChange(p, []);
    onChange(cwd, extras.includes(p) ? extras.filter((e) => e !== p) : [...extras, p]);
  }

  const summary = !cwd ? 'Choose a folder' : extras.length ? `${label(cwd)} + ${extras.length} more` : label(cwd);
  const addDir = runner && ['claude', 'codex'].some((c) => runner.command.toLowerCase().includes(c));

  return (
    <div className="folder-field">
      <span className="run-field-label">Folder{extras.length ? 's' : ''}</span>
      <span className="menu-host">
        <button
          type="button" className="folder-button" aria-haspopup="listbox" aria-expanded={open}
          disabled={targets.length === 0}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          <span className="folder-button-text">{targets.length === 0 ? 'No watched folders' : summary}</span>
        </button>
        {open && (
          <div className="menu folder-menu" role="listbox" aria-multiselectable="true" onClick={(e) => e.stopPropagation()}>
            <div className="menu-head">Run across</div>
            {targets.map((t) => {
              const on = chosen.includes(t.path);
              return (
                <div key={t.path} className="folder-option checkbox-row">
                  <input type="checkbox" id={`folder-${t.path}`} checked={on} onChange={() => toggle(t.path)} />
                  <label htmlFor={`folder-${t.path}`} title={t.path}>{t.label}</label>
                  {t.path === cwd ? (
                    <span className="folder-main">starts here</span>
                  ) : on ? (
                    <button type="button" className="link" onClick={() => onChange(t.path, [cwd, ...extras.filter((e) => e !== t.path)])}>Start here</button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </span>
      {extras.length > 0 && (
        <span className="model-field-note">
          {!runner || addDir
            ? `Starts in ${label(cwd)}; the others are opened to it with --add-dir and named in the prompt.`
            : `Starts in ${label(cwd)}; the others are named in the prompt (this agent has no --add-dir).`}
        </span>
      )}
      {targets.length === 0 && <span className="model-field-note">Add a watched folder in Settings → GitHub first.</span>}
    </div>
  );
}
