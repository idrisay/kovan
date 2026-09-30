/**
 * The drag handle between the sidebar and the content.
 *
 * The width lives in a CSS custom property on the document, not in React
 * state. Three views render their own sidebar — the queue, the sessions list
 * and the workspace explorer — and a variable on :root reaches all of them
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
const maxWidth = () => Math.round(window.innerWidth * MAX_RATIO);

const clamp = (px: number) => Math.min(maxWidth(), Math.max(MIN, Math.round(px)));

function apply(px: number) {
  document.documentElement.style.setProperty('--queue-w', `${px}px`);
}

function remember(px: number) {
  // Storage is a preference, never a correctness requirement: a profile with
  // site data blocked should still resize, it just forgets on relaunch.
  try { localStorage.setItem(KEY, String(px)); } catch { /* not worth a log */ }
}

/**
 * Put the remembered width on the document before React first paints, so the
 * sidebar never flashes at the default and then jumps.
 */
export function restoreSidebarWidth() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* fall through to CSS */ }
  const px = Number(saved);
  // No value, a corrupt one, or one from a build with different bounds: leave
  // the property unset and let the stylesheet's own default answer.
  if (Number.isFinite(px) && px > 0) apply(clamp(px));
}

export function Resizer() {
  const bar = useRef<HTMLDivElement>(null);
  // The offset between the pointer and the sidebar's edge, so a drag that
  // starts 3px inside the handle does not snap the edge to the cursor.
  const grab = useRef(0);

  function down(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const sidebar = bar.current?.previousElementSibling;
    if (!(sidebar instanceof HTMLElement)) return;

    grab.current = event.clientX - sidebar.getBoundingClientRect().right;
    bar.current?.setPointerCapture(event.pointerId);
    bar.current?.classList.add('dragging');
    document.body.classList.add('resizing');
    event.preventDefault();
  }

  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (!bar.current?.hasPointerCapture(event.pointerId)) return;
    const sidebar = bar.current.previousElementSibling;
    if (!(sidebar instanceof HTMLElement)) return;
    // Measure from the sidebar's own left edge, not from the window: the
    // activity rail sits to its left and the titlebar offsets nothing here,
    // but a future pane between them would silently skew a window-relative sum.
    apply(clamp(event.clientX - grab.current - sidebar.getBoundingClientRect().left));
  }

  function up(event: React.PointerEvent<HTMLDivElement>) {
    if (!bar.current?.hasPointerCapture(event.pointerId)) return;
    bar.current.releasePointerCapture(event.pointerId);
    bar.current.classList.remove('dragging');
    document.body.classList.remove('resizing');

    const sidebar = bar.current.previousElementSibling;
    if (sidebar instanceof HTMLElement) remember(clamp(sidebar.getBoundingClientRect().width));
  }

  /** Double-click resets, the way every editor's splitter does. */
  function reset() {
    document.documentElement.style.removeProperty('--queue-w');
    try { localStorage.removeItem(KEY); } catch { /* nothing to undo */ }
  }

  /** Arrow keys move it too, because a 8px target is not a keyboard target. */
  function key(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 8;
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    if (delta === 0) return;
    const sidebar = bar.current?.previousElementSibling;
    if (!(sidebar instanceof HTMLElement)) return;
    event.preventDefault();
    const next = clamp(sidebar.getBoundingClientRect().width + delta);
    apply(next);
    remember(next);
  }

  return (
    <div
      ref={bar}
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
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
