/**
 * Settings › Agents › Reviewers (item 143): what the Review button can send a
 * pull request to. nv-review is the first row; agents (Claude Code, Codex)
 * and your own commands are added here, tested on a made-up pull request
 * with one planted bug, and then picked on the Review button.
 *
 * Adding a command should take a click, not knowledge of how it is called:
 * picking one reads its `--help` and fills in how it takes the model (a flag
 * or a variable) and the prompt (stdin or a file), and names any key file it
 * needs that is missing, with a field to save it.
 */

import { useEffect, useState } from 'react';
import {
  AGENT_FAMILY_MODELS, AGENT_FAMILY_NAME, NV_REVIEW_DEFAULT_MODEL, NV_REVIEW_TOOL_ID, REVIEW_TOOL_DEFAULT_MINUTES,
  agentFamily, formatAge, reviewToolCommandLine, type ReviewTool, type ReviewToolKind
} from '@kovan/core';

/** Opens Settings at a section, from anywhere in the window (App listens). */
export const OPEN_SETTINGS = 'kovan:open-settings';
export function openSettings(section: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS, { detail: section }));
}

type Candidate = Awaited<ReturnType<typeof window.kovan.reviewToolCandidates>>[number];
type TestResult = Awaited<ReturnType<typeof window.kovan.reviewToolTest>>;
type Setup = Awaited<ReturnType<typeof window.kovan.reviewToolSetup>>;

type ModelHow = 'flag' | 'env' | 'none';

interface Draft {
  id?: string;
  kind: ReviewToolKind;
  command: string;
  model: string;
  modelHow: ModelHow;
  modelFlag: string;
  modelEnv: string;
  promptAs: 'stdin' | 'file';
  timeoutMinutes: string;
}

const EMPTY: Draft = {
  kind: 'agent', command: '', model: '', modelHow: 'none', modelFlag: '', modelEnv: '', promptAs: 'stdin',
  timeoutMinutes: String(REVIEW_TOOL_DEFAULT_MINUTES)
};

function draftOf(tool: ReviewTool): Draft {
  return {
    id: tool.id, kind: tool.kind, command: tool.command, model: tool.model ?? '',
    modelHow: tool.modelFlag ? 'flag' : tool.modelEnv ? 'env' : 'none',
    modelFlag: tool.modelFlag ?? '', modelEnv: tool.modelEnv ?? '', promptAs: tool.promptAs ?? 'stdin',
    timeoutMinutes: String(tool.timeoutMinutes)
  };
}

function toolOf(draft: Draft): Partial<ReviewTool> {
  const command = draft.kind === 'command';
  return {
    id: draft.id, kind: draft.kind, command: draft.command.trim(),
    model: draft.modelHow === 'none' && command ? undefined : draft.model.trim() || undefined,
    modelFlag: command && draft.modelHow === 'flag' ? draft.modelFlag.trim() || undefined : undefined,
    modelEnv: command && draft.modelHow === 'env' ? draft.modelEnv.trim() || undefined : undefined,
    promptAs: command && draft.promptAs === 'file' ? 'file' : undefined,
    timeoutMinutes: Number(draft.timeoutMinutes) || REVIEW_TOOL_DEFAULT_MINUTES,
    family: draft.kind === 'agent' ? agentFamily(draft.command.trim()) : undefined
  };
}

function toolName(tool: ReviewTool): string {
  const model = tool.id === NV_REVIEW_TOOL_ID ? tool.model ?? NV_REVIEW_DEFAULT_MODEL : tool.model;
  return model ? `${tool.command} · ${model}` : tool.command;
}

function kindLine(tool: ReviewTool): string {
  if (tool.kind === 'agent') return `Agent · ${AGENT_FAMILY_NAME[tool.family!]} · read-only, in a worktree of your clone`;
  const prompt = tool.promptAs === 'file' ? 'prompt as a file' : 'prompt on stdin';
  const model = tool.modelFlag ? ` · model after ${tool.modelFlag}` : tool.modelEnv ? ` · model in ${tool.modelEnv}` : '';
  return `Command · ${prompt}${model}`;
}

/** A failed test that a missing key explains: the fix is in the form, so say so. */
function needsSetup(result?: { ok: boolean; at?: string; failed?: string }, checks?: TestResult['checks']): boolean {
  const text = [result?.failed ?? '', ...(checks ?? []).filter((c) => !c.ok).map((c) => c.note ?? '')].join(' ');
  return /no such file|cannot read|not found|key|token|unauthori[sz]ed|401|403/i.test(text);
}

export function ReviewersSettings() {
  const [tools, setTools] = useState<ReviewTool[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const [candidates, setCandidates] = useState<Candidate[]>();
  const [setup, setSetup] = useState<{ command: string; reading?: boolean; result?: Setup }>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  /** Which reviewer is being tested: an id, or 'draft' for the open form. */
  const [testing, setTesting] = useState('');
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [removing, setRemoving] = useState('');

  useEffect(() => {
    void window.kovan.reviewTools().then(setTools);
  }, []);

  // What's on this machine is only asked for once the form opens.
  useEffect(() => {
    if (draft && !candidates) void window.kovan.reviewToolCandidates().then(setCandidates);
  }, [draft, candidates]);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    // A test of the form as it was no longer says anything about it.
    setResults(({ draft: _stale, ...rest }) => rest);
    setError('');
  };

  /**
   * Finds the command and reads its --help. On a new reviewer, what the help
   * says fills the form; on one being edited it only informs.
   */
  const readSetup = async (command: string, fill: boolean) => {
    const name = command.trim();
    if (!name) return setSetup(undefined);
    setSetup({ command: name, reading: true });
    const result = await window.kovan.reviewToolSetup(name);
    setSetup((s) => (s?.command === name ? { command: name, result } : s));
    const help = result.help;
    if (fill && help) {
      setDraft((d) => d && d.command.trim() === name ? {
        ...d,
        modelHow: help.modelFlag ? 'flag' : help.modelEnv ? 'env' : 'none',
        modelFlag: help.modelFlag ?? '',
        modelEnv: help.modelEnv ?? '',
        promptAs: help.promptAs ?? 'stdin'
      } : d);
    }
  };

  const open = (next: Draft) => {
    setDraft(next);
    setSetup(undefined);
    setError('');
    if (next.kind === 'command' && next.command) void readSetup(next.command, false);
  };

  const close = () => {
    setDraft(undefined);
    setSetup(undefined);
    setError('');
    setCandidates(undefined);
  };

  const test = async (key: string, tool: Partial<ReviewTool>) => {
    setTesting(key);
    const result = await window.kovan.reviewToolTest(tool);
    setResults((r) => ({ ...r, [key]: result }));
    setTesting('');
    void window.kovan.reviewTools().then(setTools);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const draftResult = results['draft'];
    const result = await window.kovan.reviewToolSave({
      ...toolOf(draft),
      // A test passed on this exact form counts for the saved reviewer.
      test: draftResult
        ? { ok: draftResult.ok, at: new Date().toISOString(), failed: draftResult.checks.find((c) => !c.ok)?.note }
        : tools.find((t) => t.id === draft.id)?.test
    });
    setSaving(false);
    if (!result.ok) return setError(result.error ?? 'Not saved.');
    setTools(result.tools);
    close();
  };

  const agentCandidates = (candidates ?? []).filter((c) => c.kind === 'agent');
  const commandCandidates = (candidates ?? []).filter((c) => c.kind === 'command');
  const preview = draft && draft.command.trim() ? reviewToolCommandLine({ ...toolOf(draft), command: draft.command.trim() } as ReviewTool) : '';
  const editingNv = draft?.id === NV_REVIEW_TOOL_ID;
  const current = setup && draft && setup.command === draft.command.trim() ? setup : undefined;
  const models = draft?.kind === 'agent'
    ? AGENT_FAMILY_MODELS[agentFamily(draft.command) ?? 'claude']
    : current?.result?.help?.models ?? [];

  return (
    <>
      <h3>Reviewers</h3>
      <p className="settings-note">
        What the Review button on a pull request can send it to, besides an opencode model. Each one gets the diff,
        description and open threads, and should end its review with a VERDICT line. An <strong>agent</strong> runs
        read-only in a temporary worktree of your clone, so it can read whole files. A <strong>command</strong> is
        your own script, like nv-review or cf-review.
      </p>

      <div className="reviewer-list">
        {tools.map((tool) => {
          const result = results[tool.id];
          const failed = result ? !result.ok : tool.test ? !tool.test.ok : false;
          return (
            <div key={tool.id} className="reviewer-row" data-reviewer={tool.id}>
              <div className="reviewer-row-main">
                <span className="reviewer-name">{toolName(tool)}</span>
                <span className="reviewer-sub">
                  {kindLine(tool)}
                  {' · '}
                  {tool.test
                    ? tool.test.ok
                      ? <span className="ok">tested {formatAge(tool.test.at)}</span>
                      : <span className="warn" title={tool.test.failed}>last test failed</span>
                    : <span className="warn">not tested</span>}
                </span>
              </div>
              <div className="reviewer-actions">
                {removing === tool.id ? (
                  <>
                    <span className="settings-note">Remove? Reviews it wrote stay in History.</span>
                    <button type="button" className="link" onClick={() => void window.kovan.reviewToolRemove(tool.id).then((next) => { setTools(next); setRemoving(''); })}>Remove</button>
                    <button type="button" className="link" onClick={() => setRemoving('')}>Keep</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="link" disabled={Boolean(testing)} onClick={() => void test(tool.id, tool)}>
                      {testing === tool.id ? 'Testing…' : 'Test'}
                    </button>
                    <button type="button" className="link" onClick={() => open(draftOf(tool))}>Edit</button>
                    {tool.id !== NV_REVIEW_TOOL_ID && <button type="button" className="link" onClick={() => setRemoving(tool.id)}>Remove</button>}
                  </>
                )}
              </div>
              {result && <TestChecks result={result} />}
              {failed && tool.kind === 'command' && needsSetup(tool.test, result?.checks) && draft?.id !== tool.id && (
                <p className="reviewer-fix">
                  It looks like {tool.command} isn't set up yet.{' '}
                  <button type="button" className="link" onClick={() => open(draftOf(tool))}>Set it up</button>
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!draft && (
        <button type="button" className="ghost reviewer-add" onClick={() => open({ ...EMPTY })}>
          + Add reviewer
        </button>
      )}

      {draft && (
        <div className="reviewer-form" role="group" aria-label={draft.id ? `Edit ${draft.command}` : 'Add reviewer'}>
          {!draft.id && (
            <div className="reviewer-kinds" role="radiogroup" aria-label="Kind">
              {(['agent', 'command'] as const).map((kind) => (
                <button
                  key={kind} type="button" role="radio" aria-checked={draft.kind === kind}
                  className={draft.kind === kind ? 'reviewer-kind on' : 'reviewer-kind'}
                  onClick={() => { update({ ...EMPTY, kind }); setSetup(undefined); }}
                >
                  <strong>{kind === 'agent' ? 'Agent' : 'Command'}</strong>
                  <span>{kind === 'agent' ? 'Claude Code or Codex, read-only' : 'Your own script, like nv-review or cf-review'}</span>
                </button>
              ))}
            </div>
          )}

          {!draft.id && (
            <div className="reviewer-found">
              <span className="settings-note">Found on this machine:</span>
              {!candidates && <span className="settings-note">Looking…</span>}
              {candidates && (draft.kind === 'agent' ? agentCandidates : commandCandidates).length === 0 && (
                <span className="settings-note">
                  {draft.kind === 'agent'
                    ? 'No Claude Code or Codex that isn\'t added already. Install one, or add a command instead.'
                    : 'No *-review commands that aren\'t added already. Type the name of yours below.'}
                </span>
              )}
              {(draft.kind === 'agent' ? agentCandidates : commandCandidates).map((c) => (
                <label key={c.command} className="checkbox-row">
                  <input
                    type="radio" name="reviewer-found" checked={draft.command === c.command}
                    onChange={() => { update({ command: c.command }); if (c.kind === 'command') void readSetup(c.command, true); }}
                  />
                  <span><code>{c.command}</code> {c.family ? `${AGENT_FAMILY_NAME[c.family]} · ` : ''}{c.how}</span>
                </label>
              ))}
            </div>
          )}

          {draft.kind === 'command' && (
            <>
              <label>
                <span>{draft.id ? 'Command' : 'Or type a command'}</span>
                <input
                  type="text" value={draft.command} disabled={Boolean(draft.id)} placeholder="cf-review"
                  onChange={(e) => update({ command: e.target.value })}
                  onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== setup?.command) void readSetup(e.target.value, true); }}
                />
              </label>
              {current && <SetupNotes command={current.command} reading={current.reading} setup={current.result} onKeySaved={(path) =>
                setSetup((s) => s?.result ? { ...s, result: { ...s.result, keys: s.result.keys.map((k) => (k.path === path ? { ...k, exists: true } : k)) } } : s)} />}
            </>
          )}

          {draft.kind === 'command' && !editingNv && (
            <>
              <div className="reviewer-choice">
                <span>Prompt goes</span>
                <Segmented
                  value={draft.promptAs} onChange={(promptAs) => update({ promptAs })}
                  options={[['stdin', 'On stdin'], ['file', 'As a file path']]}
                />
              </div>
              <div className="reviewer-choice">
                <span>Model goes</span>
                <Segmented
                  value={draft.modelHow} onChange={(modelHow) => update({ modelHow })}
                  options={[['none', 'Its own default'], ['flag', 'After a flag'], ['env', 'In a variable']]}
                />
                {draft.modelHow === 'flag' && (
                  <input type="text" className="reviewer-inline" aria-label="Model flag" value={draft.modelFlag} placeholder="--model" onChange={(e) => update({ modelFlag: e.target.value })} />
                )}
                {draft.modelHow === 'env' && (
                  <input type="text" className="reviewer-inline" aria-label="Model variable" value={draft.modelEnv} placeholder="REVIEW_MODEL" onChange={(e) => update({ modelEnv: e.target.value })} />
                )}
              </div>
            </>
          )}

          {(draft.kind === 'agent' || editingNv || draft.modelHow !== 'none') && (
            <label>
              <span>Model{editingNv ? ' (NVIDIA)' : ' (optional)'}</span>
              <input
                type="text" value={draft.model} list="reviewer-models"
                placeholder={editingNv ? NV_REVIEW_DEFAULT_MODEL : draft.kind === 'agent' ? 'the agent\'s default' : models[0] ?? ''}
                onChange={(e) => update({ model: e.target.value })}
              />
              <datalist id="reviewer-models">
                {models.map((m) => <option key={m} value={m} />)}
              </datalist>
            </label>
          )}
          <label>
            <span>Give up after (minutes)</span>
            <input type="number" min={1} max={120} value={draft.timeoutMinutes} onChange={(e) => update({ timeoutMinutes: e.target.value })} />
          </label>

          {preview && <pre className="reviewer-cmdline" aria-label="What Kovan runs">{preview}</pre>}
          {draft.kind === 'agent' && draft.command && (
            <p className="settings-note">It may read and search files, and nothing else: no edits, no shell commands.</p>
          )}

          {results['draft'] && <TestChecks result={results['draft']} />}
          {error && <p className="settings-note error">{error}</p>}

          <div className="reviewer-buttons">
            <button type="button" className="ghost" disabled={!draft.command.trim() || Boolean(testing)} onClick={() => void test('draft', toolOf(draft))}>
              {testing === 'draft' ? 'Testing… (can take a minute)' : 'Test'}
            </button>
            <button type="button" className="primary" disabled={!draft.command.trim() || saving} onClick={() => void save()}>
              {draft.id ? 'Save' : 'Save reviewer'}
            </button>
            <button type="button" className="link" onClick={close}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

/** What Kovan found out about a command: found or not, what its help says, keys it needs. */
function SetupNotes({ command, reading, setup, onKeySaved }: {
  command: string; reading?: boolean; setup?: Setup; onKeySaved: (path: string) => void;
}) {
  if (reading || !setup) return <p className="settings-note">Looking for {command} and reading its --help…</p>;
  if (setup.found === 'none') {
    return (
      <p className="settings-note error">
        Your shell can't find {command}. Check the name. A function you just added to .zshrc is found once the file is saved.
      </p>
    );
  }
  const help = setup.help;
  const how = setup.found === 'function' || setup.found === 'alias' ? 'shell function' : 'on PATH';
  const read = help && [
    help.promptAs === 'file' ? 'prompt as a file' : help.promptAs === 'stdin' ? 'prompt on stdin' : '',
    help.modelFlag ? `model after ${help.modelFlag}` : help.modelEnv ? `model in ${help.modelEnv}` : ''
  ].filter(Boolean).join(', ');
  return (
    <div className="reviewer-setup">
      <p className="settings-note ok">
        Found: {how}.{read ? ` From its --help: ${read}. Filled in below; change it if that's wrong.` : ' Its --help said nothing Kovan could use, so set it up below.'}
      </p>
      {setup.keys.map((key) => <KeyFile key={key.path} command={command} file={key.path} exists={key.exists} onSaved={() => onKeySaved(key.path)} />)}
    </div>
  );
}

/** One key file a command reads: there, or a field to save it. */
function KeyFile({ command, file, exists, onSaved }: { command: string; file: string; exists: boolean; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<{ busy?: boolean; error?: string; saved?: boolean }>({});
  if (exists && !state.saved) return <p className="settings-note ok">✓ {file} is there.</p>;
  if (state.saved) return <p className="settings-note ok">✓ Saved to {file}. Only you can read it. Now press Test.</p>;
  const save = async () => {
    setState({ busy: true });
    const result = await window.kovan.reviewToolSaveKey(file, value);
    if (result.ok) {
      setValue('');
      setState({ saved: true });
      onSaved();
    } else {
      setState({ error: result.error });
    }
  };
  return (
    <div className="reviewer-key">
      <p className="settings-note warn">
        {command} needs a key in <code>{file}</code>, and that file doesn't exist yet. Its --help says how to get one.
      </p>
      <form className="reviewer-key-row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input
          type="password" value={value} autoComplete="off" spellCheck={false} aria-label={`Key for ${file}`}
          placeholder="Paste the key" onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="ghost" disabled={!value.trim() || state.busy}>{state.busy ? 'Saving…' : 'Save key'}</button>
      </form>
      <p className="settings-note">Saved only to that file, readable by you alone. Kovan never shows it again.</p>
      {state.error && <p className="settings-note error">{state.error}</p>}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <span className="reviewer-segmented" role="radiogroup">
      {options.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </span>
  );
}

function TestChecks({ result }: { result: TestResult }) {
  return (
    <ul className="reviewer-checks" aria-label={result.ok ? 'Test passed' : 'Test failed'}>
      {result.checks.map((c, i) => (
        <li key={i} className={c.ok ? 'ok' : 'fail'}>
          <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span>
          <span>{c.label}</span>
          {c.note && <span className="reviewer-check-note">{c.note}</span>}
        </li>
      ))}
    </ul>
  );
}
