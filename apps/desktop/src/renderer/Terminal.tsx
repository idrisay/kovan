import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { shellPath } from '@kovan/core';
import '@xterm/xterm/css/xterm.css';
import { getAppearance, subscribeAppearance } from './appearance';

/** "#rrggbb" → [r, g, b]; anything else (a color-mix, say) → undefined. */
function rgb(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1]!, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/** `a` moved `amount` of the way to `b`, both "#rrggbb". */
function mix(a: string, b: string, amount: number): string {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return a;
  return '#' + x.map((v, i) => Math.round(v * (1 - amount) + y[i]! * amount).toString(16).padStart(2, '0')).join('');
}

/**
 * The terminal's palette, read from the theme tokens painted right now —
 * the editor surface and the status colours — so a terminal belongs to
 * whichever theme is on, rather than to two palettes hard-coded here (item 96).
 * Boosted lifts every colour toward full contrast for brighter output.
 */
function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => {
    const value = css.getPropertyValue(`--${name}`).trim();
    return rgb(value) ? value : fallback;
  };
  const light = document.documentElement.dataset.theme === 'light';
  const boosted = getAppearance().terminalColors === 'boosted';
  const far = light ? '#000000' : '#ffffff';
  const lift = (hex: string) => (boosted ? mix(hex, far, light ? 0.25 : 0.3) : hex);
  // The bright ANSI variants: a step further from the background.
  const bright = (hex: string) => mix(hex, far, light ? 0.18 : 0.22);

  const clay = token('clay', light ? '#c0603c' : '#d97757');
  const red = lift(token('blocked', '#c4635a'));
  const green = lift(token('pass', '#6fa97f'));
  const yellow = lift(token('running', '#d0a05a'));
  const blue = lift(token('waiting', '#7ca0d4'));
  const magenta = lift(token('merged', '#9a7bc8'));
  // No cyan token: halfway between pass and waiting stays in the family.
  const cyan = mix(green, blue, 0.5);
  const [r, g, b] = rgb(clay) ?? [217, 119, 87];
  return {
    background: token('editor', light ? '#fbfaf7' : '#191b20'),
    foreground: boosted ? far : token('prose', light ? '#2a2b2f' : '#dad8d3'),
    cursor: clay,
    selectionBackground: `rgba(${r},${g},${b},${light ? 0.22 : 0.28})`,
    black: token('rail', '#0d0e11'), brightBlack: lift(token('dim', '#6e6d69')),
    red, brightRed: bright(red),
    green, brightGreen: bright(green),
    yellow, brightYellow: bright(yellow),
    blue, brightBlue: bright(blue),
    magenta, brightMagenta: bright(magenta),
    cyan, brightCyan: bright(cyan),
    white: lift(token('secondary', '#c9c7c2')), brightWhite: token('title', '#f5f3ef')
  };
}

/** One session's xterm, kept for as long as the session is open. */
interface Live {
  term: Xterm;
  fit: FitAddon;
  /** What xterm draws into. Moved from view to view, never rebuilt. */
  box: HTMLDivElement;
  /** Fits the grid to the view the box is in now, and tells the pty. */
  sync(): void;
  dispose(): void;
}

/**
 * The xterms, by session, outliving the views that show them (item 129).
 *
 * Switching to another view used to dispose a session's xterm, and coming
 * back built a fresh one at xterm's default 80×24 and replayed the raw output
 * into it. A full-screen program — Claude Code's input box and status line —
 * draws with cursor moves relative to the grid it had, so replayed onto a
 * different grid they landed in the wrong rows, and the bottom of the screen
 * stayed garbled until a resize made the program redraw. Keeping the xterm
 * means there is nothing to replay: output keeps arriving while the view is
 * elsewhere, and coming back only moves the box. A replay is now only for a
 * window that is new (opened again, or reloaded), and that one is drawn on the
 * grid the pty had, which the main process remembers.
 */
const kept = new Map<string, Live>();
let watchingClosed = false;

/** Lets go of a session's xterm once the session is closed. */
function watchClosed(): void {
  if (watchingClosed) return;
  watchingClosed = true;
  window.kovan.onSessions((list) => {
    const open = new Set(list.map((session) => session.id));
    for (const [id, live] of kept) if (!open.has(id)) live.dispose();
  });
}

function create(sessionId: string, host: HTMLElement, fontSize: number): Live {
  const box = document.createElement('div');
  box.className = 'term-box';
  host.appendChild(box);

  const term = new Xterm({
    fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
    fontSize,
    cursorBlink: true,
    theme: terminalTheme(),
    scrollback: 10_000,
    allowProposedApi: true
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box);

  // Output that arrives before the replay is in the replay already: the
  // reply to `sessionBuffer` and the output events travel the same channel,
  // in order, so everything after the reply is new.
  let replayed = false;

  const sync = () => {
    // Not while parked between views, where there is no size to fit to.
    if (!replayed || !box.isConnected) return;
    try {
      // Only when the char grid actually changes. A container nested in
      // flex layout — the docked panel in a pull request or ticket pane,
      // not this component's fault but its neighbourhood — can report a
      // sub-pixel-different box on nearly every frame without the whole
      // number of cols/rows ever moving; resizing on every one of those
      // sent a real SIGWINCH to the shell each time; many prompts redraw
      // their entire line on any SIGWINCH, whether or not the size
      // actually changed, and that redraw storm is what shows as flicker
      // and swallows a keystroke typed in between two of them.
      const proposed = fit.proposeDimensions();
      if (!proposed || (proposed.cols === term.cols && proposed.rows === term.rows)) {
        return;
      }
      fit.fit();
      void window.kovan.sessionResize(sessionId, term.cols, term.rows);
    } catch {
      // Fitting a detached or zero-size element throws; the observer
      // calls again once it has a size.
    }
  };

  void window.kovan.sessionBuffer(sessionId).then(({ data, cols, rows, truncated }) => {
    if (!kept.has(sessionId)) return;
    // Replay on the grid the output was drawn for, then fit; a different
    // fit resizes the pty, and the program redraws for the new grid. A
    // session restored from the terminal host has no grid on record, and
    // the likeliest one is the view's.
    if (cols && rows) term.resize(cols, rows);
    else if (box.isConnected) {
      try { fit.fit(); } catch { /* zero-size; sync tries again */ }
    }
    if (data) term.write(data);
    replayed = true;
    sync();
    if (box.isConnected) term.focus();
    // The replay lost its start, and with it the first draw of whatever a
    // full-screen program keeps on screen — Claude Code's input box and
    // status line, which it then only patches cell by cell. A one-row
    // wobble of the pty is a SIGWINCH, and the program draws it all again.
    if (truncated && term.rows > 2) {
      void window.kovan.sessionResize(sessionId, term.cols, term.rows - 1);
      setTimeout(() => {
        if (kept.get(sessionId) === live) void window.kovan.sessionResize(sessionId, term.cols, term.rows);
      }, 120);
    }
  });

  const offOutput = window.kovan.onSessionOutput((id, data) => {
    if (id === sessionId && replayed) term.write(data);
  });
  const typed = term.onData((data) => void window.kovan.sessionWrite(sessionId, data));

  // xterm draws on a canvas, not with CSS, so a theme or accent change has
  // to be handed to it — otherwise a terminal keeps the theme it opened in.
  const offAppearance = subscribeAppearance(() => {
    term.options.theme = terminalTheme();
  });

  const live: Live = {
    term,
    fit,
    box,
    sync,
    dispose: () => {
      kept.delete(sessionId);
      offOutput();
      offAppearance();
      typed.dispose();
      term.dispose();
      box.remove();
    }
  };
  kept.set(sessionId, live);
  return live;
}

/**
 * One view onto a pty living in the main process, through the session's kept
 * xterm (see `kept`). The session outlives this component and the xterm
 * outlives it too; unmounting only parks the xterm's box.
 */
export function Terminal({ sessionId, fontSize = 12 }: { sessionId: string; fontSize?: number }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    watchClosed();

    let live = kept.get(sessionId);
    if (live) {
      element.appendChild(live.box);
      live.sync();
      // What it printed while parked is in the buffer; paint it now.
      live.term.refresh(0, live.term.rows - 1);
      live.term.focus();
    } else {
      live = create(sessionId, element, fontSize);
    }
    const { term, box, sync } = live;

    const observer = new ResizeObserver(sync);
    observer.observe(element);

    // Files and images in, as VS Code's terminal takes them: a dropped file,
    // a file copied in Finder, or a screenshot on the clipboard all arrive as
    // their path, typed in as a paste. xterm on its own only pastes text, so
    // an image-only clipboard did nothing at all.
    const pastePaths = (paths: string[]) => {
      const words = paths.filter(Boolean).map(shellPath);
      if (words.length === 0) return false;
      term.paste(`${words.join(' ')} `);
      term.focus();
      return true;
    };
    const filesOf = (list?: FileList | null) => Array.from(list ?? []).map((f) => window.kovan.pathForFile(f));
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      pastePaths(filesOf(event.dataTransfer.files));
    };
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      // A file copied in Finder also carries its name as text; the path is what's wanted.
      if (data.files.length > 0 && pastePaths(filesOf(data.files))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const hasImage = Array.from(data.items).some((item) => item.type.startsWith('image/'));
      if (!hasImage || data.getData('text/plain')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void window.kovan.clipboardImagePath().then((file) => { if (file) pastePaths([file]); });
    };
    element.addEventListener('dragover', onDragOver);
    element.addEventListener('drop', onDrop);
    // Capture, so this sees the paste before xterm's own textarea handler does.
    element.addEventListener('paste', onPaste, true);

    return () => {
      observer.disconnect();
      element.removeEventListener('dragover', onDragOver);
      element.removeEventListener('drop', onDrop);
      element.removeEventListener('paste', onPaste, true);
      // Parked, not disposed: the next view of this session picks it up.
      // Only if it is still here — another view may have taken it meanwhile.
      if (box.parentElement === element) box.remove();
    };
    // fontSize is applied by the effect below, not by rebuilding.
  }, [sessionId]);

  // Mutates the live instance rather than rebuilding it — a rebuild here
  // would cost the scroll position and flicker on every step of Cmd+=.
  useEffect(() => {
    const current = kept.get(sessionId);
    if (!current || current.term.options.fontSize === fontSize) return;
    current.term.options.fontSize = fontSize;
    try {
      const proposed = current.fit.proposeDimensions();
      current.fit.fit();
      if (proposed) void window.kovan.sessionResize(sessionId, proposed.cols, proposed.rows);
    } catch {
      // Same detached/zero-size case `sync` already tolerates.
    }
  }, [fontSize, sessionId]);

  // Two boxes, not one: FitAddon sizes the grid from its host's computed
  // `height`/`width`, and under the app-wide `box-sizing: border-box` those
  // include the host's own padding — so padding on the host made the grid
  // one row taller (and a few columns wider) than what is visible, and
  // `overflow: hidden` cropped the bottom line. The padding lives on the
  // outer box; the host xterm measures has none.
  return (
    // The session id is how dictation (item 88) knows which terminal to type into.
    <div className="term" data-session-id={sessionId}>
      <div className="term-host" ref={host} />
    </div>
  );
}
