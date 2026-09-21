import { useEffect, useState } from 'react';
import { Prose } from './Prose';
import type { AgentRun, RunKind } from './types';

type Tab = 'report' | 'prompt' | 'shots';

// A value import from `@baton/agent` (unlike a type-only one) would pull its
// Node-only `shell.ts`/`runner.ts` into the renderer bundle along with it —
// `RUN_KIND_LABEL` lives in the same package, so it is copied rather than
// imported. Keep this in sync with `packages/agent/src/runs.ts`.
const RUN_KIND_LABEL: Record<RunKind, string> = {
  implement: 'Implementation',
  review: 'Review',
  unblock: 'Unblock',
  verify: 'Check'
};

/**
 * A run's report, prompt and screenshots, read and shown in the app instead
 * of handed to whatever the OS opens `.md`/`.png` files with. Those three are
 * exactly what `RunStore` ever writes for a run, so the tabs are just
 * whichever of them this run actually has.
 */
export function RunViewer({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const tabs: { id: Tab; label: string }[] = [
    run.reportPath ? { id: 'report' as const, label: 'Report' } : undefined,
    run.promptPath ? { id: 'prompt' as const, label: 'Prompt' } : undefined,
    run.shots.length > 0 ? { id: 'shots' as const, label: `Screenshots (${run.shots.length})` } : undefined
  ].filter((t): t is { id: Tab; label: string } => Boolean(t));

  const [tab, setTab] = useState<Tab | undefined>(tabs[0]?.id);
  const [report, setReport] = useState<string>();
  const [prompt, setPrompt] = useState<string>();
  const [shots, setShots] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      run.reportPath ? window.baton.runText(run.reportPath) : Promise.resolve(undefined),
      run.promptPath ? window.baton.runText(run.promptPath) : Promise.resolve(undefined),
      Promise.all(run.shots.map((s) => window.baton.runImage(s)))
    ])
      .then(([r, p, s]) => {
        if (cancelled) return;
        setReport(r);
        setPrompt(p);
        setShots(s);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run.id]);

  const openPath = (file?: string) => file && void window.baton.openExternal(`file://${file}`);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide run-viewer" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{RUN_KIND_LABEL[run.kind]}</h2>
          <button className="ghost" onClick={onClose}>
            Done
          </button>
        </header>
        <p className="subject">
          {run.subject} · {new Date(run.startedAt).toLocaleString()}
          {run.confidence !== undefined && ` · ${run.confidence}/100`}
          {run.verdict !== 'unknown' && ` · ${run.verdict}`}
        </p>

        {tabs.length > 1 && (
          <div className="run-tabs">
            {tabs.map((t) => (
              <button key={t.id} className={t.id === tab ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="run-viewer-body">
          {loading ? (
            <p className="quiet">Loading…</p>
          ) : tab === 'report' ? (
            <>
              <Prose text={report ?? ''} />
              <button className="link" onClick={() => openPath(run.reportPath)}>
                Open report.md in Finder
              </button>
            </>
          ) : tab === 'prompt' ? (
            <>
              <Prose text={prompt ?? ''} />
              <button className="link" onClick={() => openPath(run.promptPath)}>
                Open prompt.md in Finder
              </button>
            </>
          ) : tab === 'shots' ? (
            <div className="shots-stack">
              {run.shots.map((path, i) => (
                <figure key={path}>
                  <img src={shots[i]} alt={path.split('/').pop()} />
                  <figcaption>{path.split('/').pop()}</figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="quiet">Nothing was recorded for this run.</p>
          )}
        </div>
      </div>
    </div>
  );
}
