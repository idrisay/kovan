import { useCallback, useEffect, useState } from 'react';
import { MinusIcon, PlusIcon } from './icons';

/**
 * One font size for every terminal in the app — the docked one on a pull
 * request or ticket, and the Sessions tab's own — the same way the sidebar
 * has one width rather than one per view. A preference, not a credential, so
 * it lives in localStorage next to the sidebar width and the terminal dock
 * position, not in the settings store.
 */
const KEY = 'baton.terminal-font-size';
const MIN = 9;
const MAX = 22;
const DEFAULT = 12;

function read(): number {
  try {
    const raw = Number(localStorage.getItem(KEY));
    return Number.isFinite(raw) && raw >= MIN && raw <= MAX ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function write(px: number) {
  try { localStorage.setItem(KEY, String(px)); } catch { /* a preference, not a requirement */ }
}

const clamp = (px: number) => Math.min(MAX, Math.max(MIN, px));

/**
 * A step taken anywhere in this window — Settings' own stepper, or Cmd+=/Cmd+-
 * routed here by `zoomTarget.ts` — while several `useTerminalFontSize()`
 * instances are mounted at once (one per docked terminal, one for the
 * Sessions tab, one for Settings). A plain window event, so every instance
 * applies the same step without lifting state somewhere shared.
 */
const LOCAL_STEP_EVENT = 'baton:terminal-font-local-step';

/**
 * The current terminal font size, plus a stepper. Cmd+=/Cmd+- (when a terminal
 * is the zoom target) and every mounted copy of this hook's own stepper all
 * drive the exact same state, so every terminal in the app and Settings' own
 * control move together regardless of which one you used to change it.
 */
export function useTerminalFontSize(): [number, (step: number) => void] {
  const [size, setSize] = useState(read);

  const applyStep = useCallback((step: number) => {
    setSize((current) => {
      const next = clamp(current + step);
      write(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onLocalStep = (event: Event) => applyStep((event as CustomEvent<number>).detail);
    window.addEventListener(LOCAL_STEP_EVENT, onLocalStep);
    return () => window.removeEventListener(LOCAL_STEP_EVENT, onLocalStep);
  }, [applyStep]);

  // Dispatched rather than applied directly: the listener above (registered
  // by every instance, including this one) is the single place a step is
  // actually applied, so a click here cannot double-apply on top of it.
  const bump = useCallback(stepTerminalFont, []);

  return [size, bump];
}

/** One step for every terminal — what Cmd+=/Cmd+- sends when a terminal is the zoom target (see `zoomTarget.ts`). */
export function stepTerminalFont(step: number) {
  window.dispatchEvent(new CustomEvent(LOCAL_STEP_EVENT, { detail: step }));
}

export function FontSizeControl({ size, onBump }: { size: number; onBump: (step: number) => void }) {
  return (
    <div className="font-size-control" role="group" aria-label="Terminal font size" title="Terminal font size (⌘+ / ⌘−)">
      <button
        type="button" className="icon-button" aria-label="Smaller text"
        disabled={size <= MIN} onClick={() => onBump(-1)}
      >
        <MinusIcon />
      </button>
      <span className="font-size-value">{size}</span>
      <button
        type="button" className="icon-button" aria-label="Larger text"
        disabled={size >= MAX} onClick={() => onBump(1)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}
