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

/** A one-line taste of a document, for the gallery's file list. */
function snippet(markdown: string): string {
  const plain = markdown
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
}

/**
 * A run's own directory — every file it actually contains, seen the way a
 * gallery is browsed rather than a repo: every screenshot visible at once as
 * a real thumbnail, every document listed with a taste of what it says, both
 * on one page. Opening a document takes over this same view (bigger, one
 * thing read at a time) with a way back to the gallery; opening a screenshot
 * only lightboxes it, since a picture is looked at, not read.
 */
export function RunViewer({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const [files, setFiles] = useState<RunFile[]>();
  // Path → a full data URL for an image, or a short text snippet for a
  // document. Fetched once, up front, for every file — run directories are
  // small, and this is what makes the gallery show everything at a glance
  // instead of one file at a time.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<RunFile>();
  const [lightbox, setLightbox] = useState<RunFile>();
  const [text, setText] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.baton.runFiles(run.directory).then(async (found) => {
      if (cancelled) return;
      setFiles(found);
      const pairs = await Promise.all(
        found.map(async (file): Promise<readonly [string, string]> => {
          const absolute = `${run.directory}/${file.path}`;
          try {
            return IMAGE_NAME.test(file.name)
              ? [file.path, await window.baton.runImage(absolute)]
              : [file.path, snippet(await window.baton.runText(absolute))];
          } catch {
            return [file.path, ''];
          }
        })
      );
      if (!cancelled) setPreviews(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [run.directory]);

  // The selected *document's* full text — its gallery preview is only a
  // snippet. Images never go through this: the lightbox reuses the same data
  // URL the gallery already fetched.
  useEffect(() => {
    if (!selected) return undefined;
    let cancelled = false;
    setLoading(true);
    setReadError(undefined);
    setText(undefined);
    window.baton
      .runText(`${run.directory}/${selected.path}`)
      .then((body) => {
        if (!cancelled) setText(body);
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

  const images = useMemo(() => files?.filter((f) => IMAGE_NAME.test(f.name)) ?? [], [files]);
  const documents = useMemo(() => files?.filter((f) => !IMAGE_NAME.test(f.name)) ?? [], [files]);

  const isMarkdown = selected ? MARKDOWN_NAME.test(selected.name) : false;
  const lines = useMemo(
    () => (text !== undefined && selected && !isMarkdown ? highlightLines(text, selected.name) : undefined),
    [text, selected, isMarkdown]
  );

  const lightboxIndex = lightbox ? images.findIndex((f) => f.path === lightbox.path) : -1;
  const showLightbox = (delta: number) => {
    if (lightboxIndex === -1 || images.length === 0) return;
    const next = (lightboxIndex + delta + images.length) % images.length;
    setLightbox(images[next]);
  };

  const openInFinder = (file: RunFile) =>
    void window.baton.openExternal(`file://${run.directory}/${file.path}`);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet run-viewer" onClick={(e) => e.stopPropagation()}>
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

        {selected ? (
          <div className="run-viewer-doc">
            <button type="button" className="link run-viewer-back" onClick={() => setSelected(undefined)}>
              ← All files
            </button>
            <h3>{selected.path}</h3>
            {loading ? (
              <p className="quiet">Loading…</p>
            ) : readError ? (
              <p className="quiet error">{readError}</p>
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
            {!loading && (
              <button type="button" className="link" onClick={() => openInFinder(selected)}>
                Open {selected.name} in Finder
              </button>
            )}
          </div>
        ) : (
          <div className="run-viewer-gallery">
            {files === undefined ? (
              <p className="quiet">Loading…</p>
            ) : files.length === 0 ? (
              <p className="quiet">Nothing was recorded for this run.</p>
            ) : (
              <>
                {images.length > 0 && (
                  <section>
                    <h3>Screenshots</h3>
                    <div className="run-shots-grid">
                      {images.map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          className="run-shot"
                          onClick={() => setLightbox(file)}
                        >
                          <img src={previews[file.path]} alt={file.name} loading="lazy" />
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {documents.length > 0 && (
                  <section>
                    <h3>Files</h3>
                    <ul className="run-doc-list">
                      {documents.map((file) => (
                        <li key={file.path}>
                          <button type="button" className="run-doc" onClick={() => setSelected(file)}>
                            <span className="run-doc-name">{file.path}</span>
                            {previews[file.path] && (
                              <span className="run-doc-snippet">{previews[file.path]}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {lightbox && (
        <div
          className="lightbox-backdrop"
          onClick={(e) => {
            e.stopPropagation();
            setLightbox(undefined);
          }}
        >
          {images.length > 1 && (
            <button
              type="button"
              className="lightbox-nav prev"
              aria-label="Previous screenshot"
              onClick={(e) => {
                e.stopPropagation();
                showLightbox(-1);
              }}
            >
              ‹
            </button>
          )}
          <img src={previews[lightbox.path]} alt={lightbox.name} />
          {images.length > 1 && (
            <button
              type="button"
              className="lightbox-nav next"
              aria-label="Next screenshot"
              onClick={(e) => {
                e.stopPropagation();
                showLightbox(1);
              }}
            >
              ›
            </button>
          )}
        </div>
      )}
    </div>
  );
}
