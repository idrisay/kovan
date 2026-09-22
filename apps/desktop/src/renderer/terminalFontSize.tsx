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
 * The current terminal font size, plus a stepper. Cmd+=/Cmd+- (intercepted in
 * main — see the note in `main/index.ts` on `before-input-event`, which is
 * what used to just zoom the whole window) drive the exact same state, so
 * every mounted terminal and every open instance of this control move
 * together regardless of which one you used to change it.
 */
export function useTerminalFontSize(): [number, (step: number) => void] {
  const [size, setSize] = useState(read);

  useEffect(() => {
    return window.baton.onFontSizeStep((step) => {
      setSize((current) => {
        const next = clamp(current + step);
        write(next);
        return next;
      });
    });
  }, []);

  const bump = useCallback((step: number) => {
    setSize((current) => {
      const next = clamp(current + step);
      write(next);
      return next;
    });
  }, []);

  return [size, bump];
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
