/**
 * The drag handle between the sidebar and the content, and between the
 * content and a panel docked on its right (Mixpanel's Discuss, item 180).
 *
 * The width lives in a CSS custom property on the document, not in React
 * state (`--queue-w` for the sidebar, the panel's own otherwise). Three
 * views render their own sidebar — the queue, the sessions list and the
 * workspace explorer — and a variable on :root reaches all of them
 * without threading a prop through any of them, and without re-rendering a
 * tree of rows on every pointer move.
 *
 * The drag uses pointer capture rather than window listeners: the cursor
 * outruns an 8px strip immediately, and capture keeps the events coming
 * anyway, releases automatically if the pointer is lost, and cannot leak a
 * listener if the component unmounts mid-drag.
 */

import { useRef } from 'react';

const KEY = 'kovan.sidebar-width';
const MIN = 220;
// A fraction of the window, not a fixed number of pixels — a constant picked
// against one laptop screen is already short of what an external monitor
// actually has room for. Read live rather than cached, since the window can
// be resized while the sidebar is not being dragged at all.
const MAX_RATIO = 0.7;
const windowMax = () => Math.round(window.innerWidth * MAX_RATIO);

function apply(cssVar: string, px: number) {
  document.documentElement.style.setProperty(cssVar, `${px}px`);
}

function remember(key: string, px: number) {
  // Storage is a preference, never a correctness requirement: a profile with
  // site data blocked should still resize, it just forgets on relaunch.
  try { localStorage.setItem(key, String(px)); } catch { /* not worth a log */ }
}

/**
 * Put a remembered width on the document before the panel first paints, so
 * it never flashes at the default and then jumps. No value, a corrupt one, or
 * one from a build with different bounds: the property stays unset and the
 * stylesheet's own default answers.
 */
export function restoreWidth(cssVar: string, key: string, clamp: (px: number) => number): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(key); } catch { /* fall through to CSS */ }
  const px = Number(saved);
  if (Number.isFinite(px) && px > 0) apply(cssVar, clamp(px));
}

export function restoreSidebarWidth() {
  restoreWidth('--queue-w', KEY, (px) => Math.min(windowMax(), Math.max(MIN, Math.round(px))));
}

export interface ResizerProps {
  /**
   * Where the handle sits beside the panel it sizes. `after` (the sidebar):
   * the panel is on its left and dragging right widens it. `before` (a panel
   * docked on the right, like Mixpanel's Discuss): the panel is on its right
   * and dragging left widens it.
   */
  edge?: 'after' | 'before';
  /** The custom property on :root that holds the width. */
  cssVar?: string;
  /** Where the width is remembered across launches. */
  storageKey?: string;
  min?: number;
  /** The widest the panel may be, asked on every move. The window's 70% by default. */
  max?: (panel: HTMLElement) => number;
  label?: string;
}

export function Resizer({
  edge = 'after', cssVar = '--queue-w', storageKey = KEY, min = MIN, max = windowMax, label = 'Resize sidebar'
}: ResizerProps = {}) {
  const bar = useRef<HTMLDivElement>(null);
  // The offset between the pointer and the panel's edge, so a drag that
  // starts 3px inside the handle does not snap the edge to the cursor.
  const grab = useRef(0);

  const panelOf = (): HTMLElement | undefined => {
    const el = edge === 'after' ? bar.current?.previousElementSibling : bar.current?.nextElementSibling;
    return el instanceof HTMLElement ? el : undefined;
  };
  const clamp = (panel: HTMLElement, px: number) => Math.max(min, Math.min(max(panel), Math.round(px)));

  function down(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const panel = panelOf();
    if (!panel) return;
    const box = panel.getBoundingClientRect();
    grab.current = event.clientX - (edge === 'after' ? box.right : box.left);
    bar.current?.setPointerCapture(event.pointerId);
    bar.current?.classList.add('dragging');
    document.body.classList.add('resizing');
    event.preventDefault();
  }

  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (!bar.current?.hasPointerCapture(event.pointerId)) return;
    const panel = panelOf();
    if (!panel) return;
    // Measured from the panel's own far edge, not from the window: a pane
    // added beside it later would otherwise silently skew a window-relative sum.
    const box = panel.getBoundingClientRect();
    const edgeAt = event.clientX - grab.current;
    apply(cssVar, clamp(panel, edge === 'after' ? edgeAt - box.left : box.right - edgeAt));
  }

  function up(event: React.PointerEvent<HTMLDivElement>) {
    if (!bar.current?.hasPointerCapture(event.pointerId)) return;
    bar.current.releasePointerCapture(event.pointerId);
    bar.current.classList.remove('dragging');
    document.body.classList.remove('resizing');
    const panel = panelOf();
    if (panel) remember(storageKey, clamp(panel, panel.getBoundingClientRect().width));
  }

  /** Double-click resets, the way every editor's splitter does. */
  function reset() {
    document.documentElement.style.removeProperty(cssVar);
    try { localStorage.removeItem(storageKey); } catch { /* nothing to undo */ }
  }

  /** Arrow keys move it too, because a 8px target is not a keyboard target. */
  function key(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 8;
    const toward = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    if (toward === 0) return;
    const panel = panelOf();
    if (!panel) return;
    event.preventDefault();
    // The handle moves with the arrow; which way widens depends on the side.
    const next = clamp(panel, panel.getBoundingClientRect().width + (edge === 'after' ? toward : -toward));
    apply(cssVar, next);
    remember(storageKey, next);
  }

  return (
    <div
      ref={bar}
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={reset}
      onKeyDown={key}
    />
  );
}
