import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DictateButton } from './Dictation';
import { useMenuDismiss } from './menuDismiss';
import {
  folderMemoryFrom, formatAge, modelFamily, recallFolders, rememberFolders, ticketKeyInTitle, type FolderMemory, type ModelFamily
} from '@kovan/core';
import type { TicketPull } from '@kovan/providers';
import type {
  JiraIssue, ModelList, PullSummary, RunKind, Runner, RunnerLimits, RunTarget, SentryFrame, SentryIssue, StartResult, TestSelection
} from './types';
import { CloseIcon, RefreshIcon } from './icons';
import { TestEnvironmentPicker } from './TestEnvironments';
import { AgentLimitsNote } from './AgentLimits';

const LAST_MODEL_KEY = 'runner.lastModel';

/**
 * Item 94: the agent and folders you picked come back next time. Per window,
 * like the environment pick beside them (localStorage, every access in try):
 * the agent per kind of run, the folders per ticket or pull request — a new
 * ticket starts from the last ticket's.
 */
const CHOICES_KEY = 'kovan.run-choices';

interface RunChoices { agent: Partial<Record<RunKind, string>>; folders: FolderMemory }

function readChoices(): RunChoices {
  try {
    const raw = JSON.parse(localStorage.getItem(CHOICES_KEY) ?? '{}') as { agent?: unknown; folders?: unknown };
    const agent = raw.agent && typeof raw.agent === 'object'
      ? Object.fromEntries(Object.entries(raw.agent as Record<string, unknown>).filter(([, v]) => typeof v === 'string'))
      : {};
    return { agent, folders: folderMemoryFrom(raw.folders) };
  } catch {
    return { agent: {}, folders: { bySubject: {} } };
  }
}

/** Whether the prompt was last left unfolded (item 117). */
const PROMPT_OPEN_KEY = 'kovan.run-prompt-open';

function remember(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* a convenience */ }
}

function recall(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeChoices(update: (current: RunChoices) => RunChoices): void {
  try {
    localStorage.setItem(CHOICES_KEY, JSON.stringify(update(readChoices())));
  } catch { /* a convenience, not a requirement */ }
}

export const KIND_LABEL: Record<RunKind, string> = {
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
  const [promptOpen, setPromptOpen] = useState(() => recall(PROMPT_OPEN_KEY));
  const firstBuild = useRef(true);

  // Item 171: a review offers the ticket's other open pull requests, ticked,
  // to review in the same session. Asked of GitHub once, when the sheet opens.
  const ticketKey = kind === 'review' && pull && !issue && !sentry
    ? ticketKeyInTitle(pull.title) || ticketKeyInTitle((pull.headRef ?? '').toUpperCase())
    : '';
  const [siblings, setSiblings] = useState<TicketPull[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const pullId = (p: { repo: string; number: number }) => `${p.repo}#${p.number}`;
  useEffect(() => {
    if (!ticketKey || !pull) return;
    let live = true;
    void window.kovan.ticketPulls(ticketKey).then((all) => {
      if (!live) return;
      setSiblings(all);
      // Ticked: every other open one, except one you already reviewed that
      // has nothing new since. That one stays unticked until you tick it.
      setPicked(new Set(all
        .filter((t) => pullId(t.pull) !== pullId(pull) && !t.pull.mergedAt)
        .filter((t) => !t.yourReview || t.changedSinceYourReview)
        .map((t) => pullId(t.pull))));
    }).catch(() => { if (live) setSiblings([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketKey, pull?.repo, pull?.number]);
  const others = (siblings ?? []).filter((t) => pull && pullId(t.pull) !== pullId(pull));
  const openOthers = others.filter((t) => !t.pull.mergedAt);
  const mergedOthers = others.filter((t) => t.pull.mergedAt);
  const own = siblings?.find((t) => pull && pullId(t.pull) === pullId(pull));
  const pickedKey = [...picked].sort().join(',');
  const together = useMemo(() => {
    if (!pull || picked.size === 0) return undefined;
    const strip = (t: TicketPull) => ({
      pull: t.pull, ...(t.yourReview ? { yourReview: t.yourReview } : {}), changedSinceYourReview: t.changedSinceYourReview
    });
    return {
      key: ticketKey,
      pulls: [own ? strip(own) : { pull }, ...openOthers.filter((t) => picked.has(pullId(t.pull))).map(strip)],
      context: mergedOthers.map((t) => t.pull)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey, siblings]);

  const subject = { pull, issue, sentry, ...(together ? { together } : {}) };
  const subjectId = sentry ? sentry.issue.shortId : issue ? issue.key : pull ? `${pull.repo}#${pull.number}` : '';
  const runner = runners.find((r) => r.id === runnerId);
  // Read once when the sheet opens: files the agents wrote, no requests (item 108).
  const [limits, setLimits] = useState<Record<string, RunnerLimits>>();
  useEffect(() => { void window.kovan.agentLimits().then(setLimits).catch(() => setLimits({})); }, []);

  useEffect(() => {
    void window.kovan.runners().then((list) => {
      setRunners(list);
      // The agent you last used for this kind of run, if it's still
      // installed (item 94); else the first.
      const last = readChoices().agent[kind];
      const remembered = last && list.some((r) => r.id === last) ? last : undefined;
      setRunnerId((current) => current || remembered || list[0]?.id || '');
    });
    void window.kovan.knownModels().then(setKnownModels);
    void window.kovan.runTargets().then(setTargets);
    void window.kovan.defaultCwd(pull?.repo).then((dir) => setCwd((c) => c || dir || ''));
    // Rebuilding on every keystroke of the prompt would discard the user's
    // edits, so this deliberately runs once per sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, subjectId]);

  // The folders this ticket or pull request last ran across, and where it
  // started (item 94) — once the offered folders are known, and only ones
  // still offered. Applied once per sheet, so it never fights a change you make.
  const isTicket = Boolean(issue) && !sentry;
  const recalled = useRef(false);
  useEffect(() => {
    if (recalled.current || targets.length === 0) return;
    recalled.current = true;
    const back = recallFolders(readChoices().folders, subjectId, isTicket, targets.map((t) => t.path));
    if (back) {
      setCwd(back.cwd);
      setExtraCwds(back.extras);
    }
  }, [targets, subjectId, isTicket]);

  // Never leave Folder empty while there are folders to offer: the default
  // above can come back empty (no clone matched, or the list was still being
  // scanned), and an empty Folder silently blocks Run.
  useEffect(() => {
    if (cwd || targets.length === 0) return;
    const match = pull ? targets.find((t) => t.label.toLowerCase() === pull.repo.toLowerCase()) : undefined;
    // Functional: the remembered folders above may have just been set in
    // this same render, and must not be replaced by the fallback.
    setCwd((current) => current || (match ?? targets[0]!).path);
  }, [cwd, targets, pull]);

  const rebuild = useCallback((selection: TestSelection | undefined) => {
    void window.kovan.buildPrompt(kind, subject, selection).then((next) => {
      setPrompt(next);
      setEdited(false);
      setStale(false);
    });
    // `subject` is rebuilt every render; the sheet is keyed by kind and subject,
    // and by which pull requests are reviewed together (item 171).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, subjectId, together]);

  // Ticking or unticking a pull request rewrites the prompt, unless you have
  // edited it: then the note offers to rebuild, as an environment change does.
  const firstTogether = useRef(true);
  useEffect(() => {
    if (firstTogether.current) { firstTogether.current = false; return; }
    if (firstBuild.current) return;
    if (edited) setStale(true);
    else rebuild(test);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [together]);

  // The clone of each ticked pull request's repository joins the folders, and
  // leaves again when unticked; only the ones added here, never yours.
  const autoFolders = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!siblings || targets.length === 0) return;
    const want = new Set(
      openOthers.filter((t) => picked.has(pullId(t.pull)))
        .map((t) => targets.find((x) => x.label.toLowerCase() === t.pull.repo.toLowerCase())?.path)
        .filter((p): p is string => Boolean(p))
    );
    setExtraCwds((current) => {
      const kept = current.filter((p) => !autoFolders.current.has(p) || want.has(p));
      const added = [...want].filter((p) => p !== cwd && !kept.includes(p));
      autoFolders.current = new Set([...[...autoFolders.current].filter((p) => want.has(p)), ...added]);
      return added.length || kept.length !== current.length ? [...kept, ...added] : current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey, siblings, targets, cwd]);

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
    void window.kovan.settings().then((settings) => {
      const remembered = (settings[LAST_MODEL_KEY] as Record<string, string> | undefined)?.[runnerId];
      setModel(remembered ?? '');
    });
  }, [runnerId]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      const result: StartResult = await window.kovan.startAgent(
        { kind, subjectId, runnerId, cwd, extraCwds, prompt, model: model || undefined, test },
        subject
      );
      if (result.ok) {
        const settings = await window.kovan.settings();
        const remembered = (settings[LAST_MODEL_KEY] as Record<string, string> | undefined) ?? {};
        void window.kovan.setSetting(LAST_MODEL_KEY, { ...remembered, [runnerId]: model });
        // What a run actually used is what next time starts from (item 94).
        writeChoices((c) => ({
          agent: { ...c.agent, [kind]: runnerId },
          folders: rememberFolders(c.folders, subjectId, isTicket, { cwd, extras: extraCwds })
        }));
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
      <div className="sheet wide run-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{sentry ? 'Fix in an agent' : KIND_LABEL[kind]}</h2>
          <button type="button" className="icon-button boxed" aria-label="Close" title="Close" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </header>

        <p className="subject">
          {sentry ? `${sentry.issue.shortId} — ${sentry.issue.title}` : issue ? `${issue.key} — ${issue.summary}` : pull?.title}
        </p>

        {ticketKey && openOthers.length > 0 && pull && (
          <section className="together" aria-label={`Other pull requests for ${ticketKey}`}>
            <div className="together-head">
              <span className="together-key">Same ticket · {ticketKey}</span>
              <span className="together-ask">
                {openOthers.length === 1 ? '1 more open pull request' : `${openOthers.length} more open pull requests`}. Review them together?
              </span>
            </div>
            <label className="together-row">
              <input type="checkbox" checked disabled />
              <span className="together-id">{shortRepo(pull.repo)}#{pull.number}</span>
              <span className="together-title">{pull.title}</span>
              <span className="together-state">this one</span>
            </label>
            {openOthers.map((t) => {
              const id = pullId(t.pull);
              return (
                <label key={id} className="together-row">
                  <input
                    type="checkbox" checked={picked.has(id)}
                    onChange={(e) => setPicked((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(id); else next.delete(id);
                      return next;
                    })}
                  />
                  <span className="together-id">{shortRepo(t.pull.repo)}#{t.pull.number}</span>
                  <span className="together-title">{t.pull.title}</span>
                  <span className={`together-state ${reviewTone(t)}`}>{reviewState(t)}</span>
                </label>
              );
            })}
            {mergedOthers.length > 0 && (
              <p className="together-note">
                Already merged, not reviewed again: {mergedOthers.map((t) => `${shortRepo(t.pull.repo)}#${t.pull.number}`).join(', ')}
                {picked.size > 0 ? ' (read as context).' : '.'}
              </p>
            )}
          </section>
        )}

        <div className="run-controls">
          <label>
            <span>Agent</span>
            <select
              value={runnerId}
              onChange={(e) => {
                const id = e.target.value;
                setRunnerId(id);
                writeChoices((c) => ({ ...c, agent: { ...c.agent, [kind]: id } }));
              }}
            >
              {runners.map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name}
                  {runner.invocation === 'shellFunction' ? ' (shell function)' : ''}
                </option>
              ))}
            </select>
            <AgentLimitsNote entry={limits?.[runnerId]} compact />
          </label>
          <FolderField
            targets={targets} cwd={cwd} extras={extraCwds} runner={runner}
            onChange={(main, extras) => {
              setCwd(main);
              setExtraCwds(extras);
              writeChoices((c) => ({ ...c, folders: rememberFolders(c.folders, subjectId, isTicket, { cwd: main, extras }) }));
            }}
          />
          {runner?.modelFlag && (
            <ModelField
              runner={runner} model={model}
              onChange={(next) => {
                setModel(next);
                // Kept the moment it's picked, not only when a run starts (item 94).
                void window.kovan.settings().then((settings) => {
                  const remembered = (settings[LAST_MODEL_KEY] as Record<string, string> | undefined) ?? {};
                  void window.kovan.setSetting(LAST_MODEL_KEY, { ...remembered, [runnerId]: next });
                });
              }}
              list={knownModels[modelFamily(runner.command) ?? ('' as ModelFamily)]}
              onList={(family, list) => setKnownModels((all) => ({ ...all, [family]: list }))}
            />
          )}
        </div>

        <TestEnvironmentPicker kind={kind} onChange={onTestChange} />

        {/* htmlFor, so the mic button inside isn't what the label activates. */}
        <label className="prompt-label" htmlFor="run-prompt">
          <span>
            Prompt — edit before sending if you want
            {stale && (
              <>
                {' · '}the environment or the pull requests changed after you edited it.{' '}
                <button type="button" className="link" onClick={() => rebuild(test)}>Rebuild prompt</button>
              </>
            )}
            {' · '}
            {/* Item 117: folded to a few lines by default — it's there to check
                and tweak, and at full height it made the sheet a whole screen. */}
            <button
              type="button" className="link"
              onClick={(e) => { e.preventDefault(); setPromptOpen((v) => { remember(PROMPT_OPEN_KEY, !v); return !v; }); }}
            >
              {promptOpen ? 'Fold' : `Show all ${prompt.split('\n').length} lines`}
            </button>
          </span>
          <span className="prompt-field">
            <textarea
              id="run-prompt"
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setEdited(true); }}
              spellCheck={false}
              rows={promptOpen ? 28 : 9}
              className={promptOpen ? undefined : 'folded'}
            />
            <DictateButton field={() => document.getElementById('run-prompt')} label="Dictate into the prompt" />
          </span>
        </label>

        {error && <div className="error boxed">{error}</div>}

        <footer className="sheet-foot">
          <span className="quiet small">
            {together
              ? `One session · one review per pull request · filed under ${subjectId}`
              : `Filed under ${subjectId} · the agent writes its report back here`}
          </span>
          <button className="primary" disabled={busy || !runnerId || !cwd} onClick={() => void start()}>
            {busy ? 'Starting…' : together ? `Review ${together.pulls.length} together` : 'Run'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** `acme/acme-backend` → `acme-backend`: the owner is the same on every row. */
function shortRepo(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

/** Where you left another pull request of the ticket, in a word or two. */
function reviewState(t: TicketPull): string {
  if (t.pull.isDraft) return 'draft';
  const said = t.yourReview === 'APPROVED' ? 'you approved'
    : t.yourReview === 'CHANGES_REQUESTED' ? 'you requested changes'
      : t.yourReview ? 'you commented' : '';
  if (!said) return 'awaiting review';
  return t.changedSinceYourReview ? `${said} · new commits` : `${said} · nothing new`;
}

function reviewTone(t: TicketPull): string {
  if (!t.yourReview) return 'waiting';
  return t.changedSinceYourReview ? 'changed' : '';
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
    const result = await window.kovan.modelsSearch(runner.command);
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
          <button type="button" className="link" onClick={() => void window.kovan.modelsSearchCancel()}>Cancel</button>
        ) : (
          <button
            type="button" className="icon-button boxed" disabled={!family}
            aria-label="Search for current models"
            title={family ? 'Search for current models' : 'Kovan cannot look up models for this agent'}
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
  useMenuDismiss(open, () => setOpen(false));

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
