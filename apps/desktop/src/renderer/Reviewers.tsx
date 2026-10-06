/**
 * Settings › Agents › Reviewers (item 143): what the Review button can send a
 * pull request to. nv-review is the first row; agents (Claude Code, Codex)
 * and your own commands are added here, tested on a made-up pull request
 * with one planted bug, and then picked on the Review button.
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

interface Draft {
  id?: string;
  kind: ReviewToolKind;
  command: string;
  model: string;
  modelEnv: string;
  timeoutMinutes: string;
}

const EMPTY: Draft = { kind: 'agent', command: '', model: '', modelEnv: '', timeoutMinutes: String(REVIEW_TOOL_DEFAULT_MINUTES) };

function draftOf(tool: ReviewTool): Draft {
  return {
    id: tool.id, kind: tool.kind, command: tool.command, model: tool.model ?? '', modelEnv: tool.modelEnv ?? '',
    timeoutMinutes: String(tool.timeoutMinutes)
  };
}

function toolOf(draft: Draft): Partial<ReviewTool> {
  return {
    id: draft.id, kind: draft.kind, command: draft.command.trim(), model: draft.model.trim() || undefined,
    modelEnv: draft.modelEnv.trim() || undefined, timeoutMinutes: Number(draft.timeoutMinutes) || REVIEW_TOOL_DEFAULT_MINUTES,
    family: draft.kind === 'agent' ? agentFamily(draft.command.trim()) : undefined
  };
}

function toolName(tool: ReviewTool): string {
  const model = tool.id === NV_REVIEW_TOOL_ID ? tool.model ?? NV_REVIEW_DEFAULT_MODEL : tool.model;
  return model ? `${tool.command} · ${model}` : tool.command;
}

function kindLine(tool: ReviewTool): string {
  if (tool.kind === 'agent') return `Agent · ${AGENT_FAMILY_NAME[tool.family!]} · read-only, in a worktree of your clone`;
  return `Command · prompt on stdin${tool.modelEnv ? ` · model in ${tool.modelEnv}` : ''}`;
}

export function ReviewersSettings() {
  const [tools, setTools] = useState<ReviewTool[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const [candidates, setCandidates] = useState<Candidate[]>();
  const [found, setFound] = useState<{ command: string; kind: string }>();
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

  const check = async (command: string) => {
    const name = command.trim();
    if (!name) return setFound(undefined);
    setFound({ command: name, kind: await window.kovan.reviewToolCheck(name) });
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
      test: draftResult ? { ok: draftResult.ok, at: new Date().toISOString() } : tools.find((t) => t.id === draft.id)?.test
    });
    setSaving(false);
    if (!result.ok) return setError(result.error ?? 'Not saved.');
    setTools(result.tools);
    setDraft(undefined);
    setFound(undefined);
    setCandidates(undefined);
  };

  const agentCandidates = (candidates ?? []).filter((c) => c.kind === 'agent');
  const commandCandidates = (candidates ?? []).filter((c) => c.kind === 'command');
  const preview = draft && draft.command.trim() ? reviewToolCommandLine({ ...toolOf(draft), command: draft.command.trim() } as ReviewTool) : '';
  const editingNv = draft?.id === NV_REVIEW_TOOL_ID;

  return (
    <>
      <h3>Reviewers</h3>
      <p className="settings-note">
        What the Review button on a pull request can send it to, besides an opencode model. Each one gets the diff,
        description and open threads, and should end its review with a VERDICT line. An <strong>agent</strong> runs
        read-only in a temporary worktree of your clone, so it can read whole files. A <strong>command</strong> gets
        the prompt on stdin and prints the review, like nv-review.
      </p>

      <div className="reviewer-list">
        {tools.map((tool) => {
          const result = results[tool.id];
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
                    <button type="button" className="link" onClick={() => { setDraft(draftOf(tool)); setFound(undefined); setError(''); }}>Edit</button>
                    {tool.id !== NV_REVIEW_TOOL_ID && <button type="button" className="link" onClick={() => setRemoving(tool.id)}>Remove</button>}
                  </>
                )}
              </div>
              {result && <TestChecks result={result} />}
            </div>
          );
        })}
      </div>

      {!draft && (
        <button type="button" className="ghost reviewer-add" onClick={() => { setDraft({ ...EMPTY }); setFound(undefined); setError(''); }}>
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
                  onClick={() => { update({ kind, command: '', model: '', modelEnv: '' }); setFound(undefined); }}
                >
                  <strong>{kind === 'agent' ? 'Agent' : 'Command'}</strong>
                  <span>{kind === 'agent' ? 'Claude Code or Codex, read-only' : 'A shell function or script, like nv-review'}</span>
                </button>
              ))}
            </div>
          )}

          {draft.kind === 'agent' && !draft.id && (
            <div className="reviewer-found">
              <span className="settings-note">Found on this machine:</span>
              {!candidates && <span className="settings-note">Looking…</span>}
              {candidates && agentCandidates.length === 0 && (
                <span className="settings-note">No Claude Code or Codex that isn't added already. Install one, or add a command instead.</span>
              )}
              {agentCandidates.map((c) => (
                <label key={c.command} className="checkbox-row">
                  <input type="radio" name="reviewer-agent" checked={draft.command === c.command} onChange={() => update({ command: c.command })} />
                  <span><code>{c.command}</code> {AGENT_FAMILY_NAME[c.family!]} · {c.how}</span>
                </label>
              ))}
            </div>
          )}

          {draft.kind === 'command' && (
            <>
              <label>
                <span>Command</span>
                <input
                  type="text" value={draft.command} disabled={Boolean(draft.id)} placeholder="gemini-review"
                  onChange={(e) => { update({ command: e.target.value }); setFound(undefined); }}
                  onBlur={(e) => void check(e.target.value)}
                />
              </label>
              {found && found.command === draft.command.trim() && (
                <p className={found.kind === 'none' ? 'settings-note error' : 'settings-note ok'}>
                  {found.kind === 'none'
                    ? `Your shell can't find ${found.command}. Check the name; a function you just added to .zshrc is found once it's saved.`
                    : `Found: ${found.kind === 'function' || found.kind === 'alias' ? 'shell function' : 'on PATH'}.`}
                </p>
              )}
              {!draft.id && commandCandidates.length > 0 && (
                <div className="reviewer-chips">
                  <span className="settings-note">Found:</span>
                  {commandCandidates.map((c) => (
                    <button key={c.command} type="button" className="ghost" onClick={() => { update({ command: c.command }); void check(c.command); }}>{c.command}</button>
                  ))}
                </div>
              )}
            </>
          )}

          <label>
            <span>Model{editingNv ? ' (NVIDIA)' : ' (optional)'}</span>
            <input
              type="text" value={draft.model} list="reviewer-models"
              placeholder={editingNv ? NV_REVIEW_DEFAULT_MODEL : draft.kind === 'agent' ? 'the agent\'s default' : ''}
              onChange={(e) => update({ model: e.target.value })}
            />
            <datalist id="reviewer-models">
              {(draft.kind === 'agent' ? AGENT_FAMILY_MODELS[agentFamily(draft.command) ?? 'claude'] : []).map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          {draft.kind === 'command' && (
            <label>
              <span>Model goes in</span>
              <input
                type="text" value={draft.modelEnv} disabled={editingNv} placeholder="REVIEW_MODEL"
                onChange={(e) => update({ modelEnv: e.target.value })}
              />
            </label>
          )}
          {draft.kind === 'command' && !editingNv && (
            <p className="settings-note">The environment variable your command reads its model from. nv-review's is NV_MODEL.</p>
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
              {testing === 'draft' ? 'Testing… (an agent can take a minute)' : 'Test'}
            </button>
            <button type="button" className="primary" disabled={!draft.command.trim() || saving} onClick={() => void save()}>
              {draft.id ? 'Save' : 'Save reviewer'}
            </button>
            <button type="button" className="link" onClick={() => { setDraft(undefined); setFound(undefined); setError(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </>
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
