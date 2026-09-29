import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icons';
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
/** `$BATON_STATUS`: the agent's current step, shown as a caption — not a file to list. */
const STATUS_FILE = 'status.txt';

/** "12 s ago" for the newest screenshot while a run is live. */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short' });
}
const MARKDOWN_NAME = /\.mdx?$/i;

/**
 * When a screenshot was taken. The full date and time for the lightbox, and
 * just the time under a thumbnail when it's the same day the run started —
 * which is nearly always, and the date on every thumbnail would be noise.
 */
function shotTime(iso: string, runStarted: string | number, full: boolean): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime()) || when.getTime() === 0) return '';
  if (full) return when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const sameDay = when.toDateString() === new Date(runStarted).toDateString();
  return sameDay
    ? when.toLocaleTimeString(undefined, { timeStyle: 'medium' })
    : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

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

  // What the files looked like when last fetched, so a change fetches only
  // what's new or rewritten, not every screenshot again (item 90).
  const fetched = useRef<Record<string, string>>({});
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');

  const load = useCallback(async (cancelled: () => boolean) => {
    const found = await window.baton.runFiles(run.directory);
    if (cancelled()) return;
    setFiles(found);
    const changed = found.filter((file) => fetched.current[file.path] !== file.modifiedAt);
    const pairs = await Promise.all(
      changed.map(async (file): Promise<readonly [string, string]> => {
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
    if (cancelled()) return;
    const firstLoad = Object.keys(fetched.current).length === 0;
    for (const file of changed) fetched.current[file.path] = file.modifiedAt;
    setPreviews((current) => ({ ...current, ...Object.fromEntries(pairs) }));
    const statusFile = found.find((f) => f.path === STATUS_FILE);
    if (statusFile) {
      const line = await window.baton.runText(`${run.directory}/${STATUS_FILE}`).catch(() => '');
      if (!cancelled()) setStatus(line.trim().split('\n').pop()?.slice(0, 200) ?? '');
    }
    // New screenshots flash for a moment, so the eye finds them — not on
    // the first load, where everything is "new".
    const added = firstLoad ? [] : changed.filter((f) => IMAGE_NAME.test(f.name)).map((f) => f.path);
    if (added.length > 0) {
      setFresh((current) => new Set([...current, ...added]));
      setTimeout(() => setFresh((current) => new Set([...current].filter((p) => !added.includes(p)))), 2_500);
    }
  }, [run.directory]);

  useEffect(() => {
    let cancelled = false;
    fetched.current = {};
    void load(() => cancelled);
    // Live: the folder is watched while this is open, so a screenshot shows
    // up here the moment the agent saves it.
    void window.baton.runWatch(run.directory, true).catch(() => undefined);
    const off = window.baton.onRunChanged((directory) => {
      if (directory === run.directory) void load(() => cancelled);
    });
    return () => {
      cancelled = true;
      off();
      void window.baton.runWatch(run.directory, false).catch(() => undefined);
    };
  }, [run.directory, load]);

  // Whether its agent is still running: a session attached to this run folder.
  const [live, setLive] = useState(false);
  useEffect(() => {
    const check = (list: { running: boolean; runDirectory?: string }[]) =>
      setLive(list.some((s) => s.running && s.runDirectory === run.directory));
    void window.baton.sessions().then(check);
    return window.baton.onSessions(check);
  }, [run.directory]);

  // "12 s ago" keeps counting while it's live.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [live]);

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
  const documents = useMemo(
    () => files?.filter((f) => !IMAGE_NAME.test(f.name) && f.path !== STATUS_FILE) ?? [],
    [files]
  );
  const newest = useMemo(
    () => [...images].sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt)).pop(),
    [images]
  );

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

  /**
   * ← → between screenshots, Home and End to the first and last, Esc back to
   * the gallery. On the window and in the capture phase, so it works whatever
   * had focus when the lightbox opened — a terminal behind the sheet would
   * otherwise take the arrows for its shell, which is why they did nothing.
   */
  useEffect(() => {
    if (!lightbox) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const at = images.findIndex((f) => f.path === lightbox.path);
      let next: RunFile | undefined;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        next = images[(at - 1 + images.length) % images.length];
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' ') {
        next = images[(at + 1) % images.length];
      } else if (event.key === 'Home') {
        next = images[0];
      } else if (event.key === 'End') {
        next = images[images.length - 1];
      } else if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setLightbox(event.key === 'Escape' ? undefined : next);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [lightbox, images]);

  // Finder with the file selected, not the file opened in Preview — "in
  // Finder" is what the button says.
  const reveal = (relative?: string) =>
    void window.baton.runReveal(relative ? `${run.directory}/${relative}` : run.directory);
  const openInFinder = (file: RunFile) => reveal(file.path);
  /** The folder holding the screenshots — `shots/` as a rule, the run itself otherwise. */
  const shotsFolder = images.length > 0 && images.every((f) => f.path.includes('/'))
    ? images[0]!.path.slice(0, images[0]!.path.lastIndexOf('/'))
    : undefined;

  // Portalled to <body> (item 98). The viewer is opened from inside a pull
  // request or ticket pane, and `.pane` is a CSS container — which also makes
  // it the containing block and stacking context for anything `fixed` inside
  // it. Left there, the backdrop covered only the pane, and a docked terminal
  // beside it painted over the viewer's right half. No z-index can climb out
  // of that; only leaving the pane can.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet run-viewer" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{RUN_KIND_LABEL[run.kind]}</h2>
          {live && (
            <span className="state run-live" title="Its agent is still running; new screenshots appear as they're saved">
              <span className="dot live" />
              Live
            </span>
          )}
          <span className="spacer" />
          {run.site && (
            <button
              type="button" className="ghost run-site-open"
              title={`The page in ${newest ? 'the screenshot shown' : 'the report'}, on ${run.site} — in your default browser`}
              // The page of the screenshot on screen, not the site's front
              // door, which redirects to the dashboard (item 109).
              onClick={() => void window.baton.runSiteOpen(run.directory, (lightbox ?? newest)?.path.split('/').pop())}
            >
              Open this page on {run.environment || 'the site'}
            </button>
          )}
          <button type="button" className="icon-button boxed" aria-label="Close" title="Close" onClick={onClose}>
            <CloseIcon size={14} />
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
                Show {selected.name} in Finder
              </button>
            )}
          </div>
        ) : (
          <div className="run-viewer-gallery">
            {live && (
              // While the agent works: what its browser showed last, and what
              // it says it's doing now (item 90).
              <section className="run-now">
                <div className="run-section-head">
                  <h3>Now</h3>
                  {status && <span className="run-now-step">{status}</span>}
                </div>
                {newest ? (
                  <button type="button" className="run-now-shot" onClick={() => setLightbox(newest)}>
                    <img src={previews[newest.path]} alt={newest.name} />
                    <span className="run-now-caption">
                      <span className="run-shot-name">{newest.name}</span>
                      <span className="run-shot-time">taken {ago(newest.modifiedAt, now)}</span>
                    </span>
                  </button>
                ) : (
                  <p className="quiet">Waiting for the first screenshot…</p>
                )}
              </section>
            )}
            {files === undefined ? (
              <p className="quiet">Loading…</p>
            ) : files.length === 0 || (live && images.length === 0 && documents.length === 0) ? (
              live ? null : <p className="quiet">Nothing was recorded for this run.</p>
            ) : (
              <>
                {images.length > 0 && (
                  <section>
                    <div className="run-section-head">
                      <h3>Screenshots <span className="run-section-count">{images.length}</span></h3>
                      <button type="button" className="link" onClick={() => reveal(shotsFolder)}>
                        Show in Finder
                      </button>
                    </div>
                    <div className="run-shots-grid">
                      {images.map((file, index) => (
                        <figure key={file.path} className={fresh.has(file.path) ? 'run-shot-item fresh' : 'run-shot-item'}>
                          <button
                            type="button"
                            className="run-shot"
                            aria-label={`Screenshot ${index + 1} of ${images.length}: ${file.name}`}
                            onClick={() => setLightbox(file)}
                          >
                            <img src={previews[file.path]} alt={file.name} loading="lazy" />
                          </button>
                          <figcaption title={`${file.name}\nTaken ${shotTime(file.modifiedAt, run.startedAt, true)}`}>
                            <span className="run-shot-name">{file.name}</span>
                            <span className="run-shot-time">{shotTime(file.modifiedAt, run.startedAt, false)}</span>
                          </figcaption>
                        </figure>
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
          role="dialog"
          aria-label={`Screenshot ${lightboxIndex + 1} of ${images.length}`}
          onClick={(e) => {
            e.stopPropagation();
            setLightbox(undefined);
          }}
        >
          <div className="lightbox-stage">
            {images.length > 1 && (
              <button
                type="button"
                className="lightbox-nav prev"
                aria-label="Previous screenshot"
                title="Previous (←)"
                onClick={(e) => {
                  e.stopPropagation();
                  showLightbox(-1);
                }}
              >
                ‹
              </button>
            )}
            <img src={previews[lightbox.path]} alt={lightbox.name} onClick={(e) => e.stopPropagation()} />
            {images.length > 1 && (
              <button
                type="button"
                className="lightbox-nav next"
                aria-label="Next screenshot"
                title="Next (→)"
                onClick={(e) => {
                  e.stopPropagation();
                  showLightbox(1);
                }}
              >
                ›
              </button>
            )}
          </div>
          {/* What you're looking at, and when it was taken. A click here
              doesn't close the lightbox — only the dark backdrop does. */}
          <div className="lightbox-caption" onClick={(e) => e.stopPropagation()}>
            <span className="lightbox-name">{lightbox.path}</span>
            <span className="lightbox-time" title={lightbox.modifiedAt}>
              Taken {shotTime(lightbox.modifiedAt, run.startedAt, true)}
            </span>
            <span className="spacer" />
            {images.length > 1 && (
              <span className="lightbox-count">{lightboxIndex + 1} of {images.length}</span>
            )}
            <span className="lightbox-keys" aria-hidden="true">
              <kbd>←</kbd><kbd>→</kbd> move · <kbd>esc</kbd> close
            </span>
            <button type="button" className="ghost lightbox-finder" onClick={() => openInFinder(lightbox)}>
              Show in Finder
            </button>
            <button
              type="button" className="icon-button" aria-label="Close screenshot" title="Close (esc)"
              onClick={() => setLightbox(undefined)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
