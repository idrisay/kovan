import { useCallback, useEffect, useState } from 'react';
import { MinusIcon, PlusIcon } from './icons';

/**
 * A remembered zoom for one region of the window, as a CSS variable on :root.
 *
 * Two regions have one: the reading pane (a pull request's, ticket's or
 * Sentry error's own text — description, comments, review threads) and the
 * sidebar (the queue, the sessions list, the workspace explorer). Each is
 * independent of the terminal's font size and of the other.
 *
 * A zoom rather than a font-size variable: both regions set dozens of sizes
 * (headings, code, chips, avatars, line heights) and scaling only the text
 * would leave them out of proportion. A preference, so it lives in
 * localStorage like the terminal size and the sidebar width.
 */
const MIN = 80;
const MAX = 160;
const STEP = 10;
const DEFAULT = 100;

interface Scale {
  key: string;
  variable: string;
  event: string;
}

const READING: Scale = { key: 'baton.reading-size', variable: '--reading-zoom', event: 'baton:reading-size' };
const SIDEBAR: Scale = { key: 'baton.sidebar-size', variable: '--sidebar-zoom', event: 'baton:sidebar-size' };
/** Item 103: the terminal tab strip, a session's header and the status bar —
 *  the small print around the work, too small to read on a large screen. */
const CHROME: Scale = { key: 'baton.chrome-size', variable: '--chrome-zoom', event: 'baton:chrome-size' };

function read(scale: Scale): number {
  try {
    const raw = Number(localStorage.getItem(scale.key));
    return Number.isFinite(raw) && raw >= MIN && raw <= MAX ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function apply(scale: Scale, percent: number) {
  document.documentElement.style.setProperty(scale.variable, String(percent / 100));
}

function step(scale: Scale, direction: number) {
  const next = Math.min(MAX, Math.max(MIN, read(scale) + direction * STEP));
  try { localStorage.setItem(scale.key, String(next)); } catch { /* a preference, not a requirement */ }
  apply(scale, next);
  window.dispatchEvent(new CustomEvent(scale.event, { detail: next }));
}

/** Before the first render, so neither region paints at 100% and then jumps. */
export function restoreReadingSize() {
  apply(READING, read(READING));
  apply(SIDEBAR, read(SIDEBAR));
  apply(CHROME, read(CHROME));
}

export const stepReadingSize = (direction: number) => step(READING, direction);
export const stepSidebarSize = (direction: number) => step(SIDEBAR, direction);
export const stepChromeSize = (direction: number) => step(CHROME, direction);

function useScale(scale: Scale): [number, (direction: number) => void] {
  const [percent, setPercent] = useState(() => read(scale));

  useEffect(() => {
    const onChange = (event: Event) => setPercent((event as CustomEvent<number>).detail);
    window.addEventListener(scale.event, onChange);
    return () => window.removeEventListener(scale.event, onChange);
  }, [scale]);

  const bump = useCallback((direction: number) => step(scale, direction), [scale]);
  return [percent, bump];
}

export const useReadingSize = () => useScale(READING);
export const useSidebarSize = () => useScale(SIDEBAR);
export const useChromeSize = () => useScale(CHROME);

function ScaleControl({ label, noun, value, onBump }: { label: string; noun: string; value: number; onBump: (direction: number) => void }) {
  return (
    <div className="font-size-control" role="group" aria-label={label}>
      <button type="button" className="icon-button" aria-label={`Smaller ${noun}`} disabled={value <= MIN} onClick={() => onBump(-1)}>
        <MinusIcon />
      </button>
      <span className="font-size-value">{value}%</span>
      <button type="button" className="icon-button" aria-label={`Larger ${noun}`} disabled={value >= MAX} onClick={() => onBump(1)}>
        <PlusIcon />
      </button>
    </div>
  );
}

export function ReadingSizeControl() {
  const [percent, bump] = useReadingSize();
  return <ScaleControl label="Ticket and pull request text size" noun="reading text" value={percent} onBump={bump} />;
}

export function ChromeSizeControl() {
  const [percent, bump] = useChromeSize();
  return <ScaleControl label="Tabs, session header and status bar text size" noun="tab and status bar text" value={percent} onBump={bump} />;
}

export function SidebarSizeControl() {
  const [percent, bump] = useSidebarSize();
  return <ScaleControl label="Sidebar text size" noun="sidebar text" value={percent} onBump={bump} />;
}
