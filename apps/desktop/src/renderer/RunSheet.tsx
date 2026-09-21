import { useEffect, useState } from 'react';
import type { JiraIssue, PullSummary, RunKind, Runner, RunTarget, StartResult } from './types';

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
  onClose,
  onStarted
}: {
  kind: RunKind;
  pull?: PullSummary;
  issue?: JiraIssue;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}) {
  const [runners, setRunners] = useState<Runner[]>([]);
  const [knownModels, setKnownModels] = useState<Record<string, string[]>>({});
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [runnerId, setRunnerId] = useState('');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const subject = { pull, issue };
  const subjectId = issue ? issue.key : pull ? `${pull.repo}#${pull.number}` : '';
  const runner = runners.find((r) => r.id === runnerId);

  useEffect(() => {
    void window.baton.runners().then((list) => {
      setRunners(list);
      // The default agent if one is set and still installed, else the first.
      setRunnerId((current) => current || list[0]?.id || '');
    });
    void window.baton.knownModels().then(setKnownModels);
    void window.baton.runTargets().then(setTargets);
    void window.baton.buildPrompt(kind, subject).then(setPrompt);
    void window.baton.defaultCwd(pull?.repo).then((dir) => setCwd((c) => c || dir || ''));
    // Rebuilding on every keystroke of the prompt would discard the user's
    // edits, so this deliberately runs once per sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, subjectId]);

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
        { kind, subjectId, runnerId, cwd, prompt, model: model || undefined },
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
          <h2>{KIND_LABEL[kind]}</h2>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </header>

        <p className="subject">{issue ? `${issue.key} — ${issue.summary}` : pull?.title}</p>

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
          <label>
            <span>Folder</span>
            <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
              {targets.map((target) => (
                <option key={target.path} value={target.path}>
                  {target.label}
                </option>
              ))}
            </select>
          </label>
          {runner?.modelFlag && (
            <label>
              <span>Model</span>
              <input
                list="run-model-options"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={`Default${runner.model ? ` (${runner.model})` : ''}`}
                spellCheck={false}
              />
              <datalist id="run-model-options">
                {(knownModels[runnerId] ?? []).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
          )}
        </div>

        <label className="prompt-label">
          <span>Prompt — edit before sending if you want</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
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
