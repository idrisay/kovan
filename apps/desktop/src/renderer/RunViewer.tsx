import { useEffect, useMemo, useState } from 'react';
import { Prose } from './Prose';
import { highlightLines } from './languages';
import type { AgentRun, RunFile, RunKind } from './types';

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

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const MARKDOWN_NAME = /\.mdx?$/i;

/**
 * A run's own directory, browsed the way a workspace repo's files are — a
 * list on the left, the selected file's own preview on the right — instead
 * of a fixed report/prompt/screenshots tab strip. `RunStore` only ever
 * guarantees `prompt.md` and `report.md`; an agent that leaves an extra note,
 * a plan, or a second round of screenshots behind used to be invisible here
 * simply because nothing in this viewer had heard of it.
 */
export function RunViewer({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const [files, setFiles] = useState<RunFile[]>();
  const [selected, setSelected] = useState<RunFile>();
  const [text, setText] = useState<string>();
  const [image, setImage] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.baton.runFiles(run.directory).then((found) => {
      if (cancelled) return;
      setFiles(found);
      // The report first — it is the answer — then the prompt it answered,
      // then just whatever the run actually produced.
      setSelected(
        found.find((f) => f.name === 'report.md') ??
          found.find((f) => f.name === 'prompt.md') ??
          found[0]
      );
    });
    return () => {
      cancelled = true;
    };
  }, [run.directory]);

  useEffect(() => {
    if (!selected) return undefined;
    let cancelled = false;
    setLoading(true);
    setReadError(undefined);
    setText(undefined);
    setImage(undefined);

    const absolute = `${run.directory}/${selected.path}`;
    const isImage = IMAGE_NAME.test(selected.name);
    const load = isImage ? window.baton.runImage(absolute) : window.baton.runText(absolute);
    load
      .then((value) => {
        if (cancelled) return;
        if (isImage) setImage(value);
        else setText(value);
      })
      .catch((err) => {
        if (!cancelled) setReadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, run.directory]);

  const isMarkdown = selected ? MARKDOWN_NAME.test(selected.name) : false;
  const lines = useMemo(
    () => (text !== undefined && selected && !isMarkdown ? highlightLines(text, selected.name) : undefined),
    [text, selected, isMarkdown]
  );

  const openInFinder = () =>
    selected && void window.baton.openExternal(`file://${run.directory}/${selected.path}`);

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

        <div className="run-viewer-split">
          <ul className="run-file-list" aria-label="Run files">
            {files === undefined ? (
              <li className="quiet">Loading…</li>
            ) : files.length === 0 ? (
              <li className="quiet">Nothing was recorded for this run.</li>
            ) : (
              files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className={file.path === selected?.path ? 'run-file active' : 'run-file'}
                    onClick={() => setSelected(file)}
                  >
                    {file.path}
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="run-viewer-body">
            {files === undefined || (selected && loading) ? (
              <p className="quiet">Loading…</p>
            ) : !selected ? (
              <p className="quiet">Nothing was recorded for this run.</p>
            ) : readError ? (
              <p className="quiet error">{readError}</p>
            ) : image !== undefined ? (
              <img className="run-file-image" src={image} alt={selected.name} />
            ) : isMarkdown ? (
              <Prose text={text ?? ''} />
            ) : (
              <table className="code-table">
                <tbody>
                  {(lines ?? []).map((html, i) => (
                    <tr key={i}>
                      <td className="code-num">{i + 1}</td>
                      <td className="code-line" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {selected && !loading && (
              <button className="link" onClick={openInFinder}>
                Open {selected.name} in Finder
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
