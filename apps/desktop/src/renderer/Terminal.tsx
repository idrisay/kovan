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

/**
 * One xterm.js view onto a pty living in the main process.
 *
 * The buffer is replayed on mount rather than kept here, because the session
 * outlives this component: closing the window destroys the renderer, and the
 * agent carries on. Whatever it printed meanwhile has to be recoverable.
 */
export function Terminal({ sessionId, fontSize = 12 }: { sessionId: string; fontSize?: number }) {
  const host = useRef<HTMLDivElement>(null);
  // Read by the font-size effect below, which intentionally does not tear
  // down and rebuild the terminal on every keystroke of Cmd+= — that would
  // cost the scroll position and flicker on every step.
  const live = useRef<{ term: Xterm; fit: FitAddon } | null>(null);

  useEffect(() => {
    if (!host.current) return;

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
    term.open(host.current);
    live.current = { term, fit };

    let disposed = false;

    const sync = () => {
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
        // Fitting a detached or zero-size element throws; the observer below
        // will call again once it has a size.
      }
    };

    void window.kovan.sessionBuffer(sessionId).then((buffer) => {
      if (disposed) return;
      if (buffer) term.write(buffer);
      sync();
      term.focus();
    });

    const offOutput = window.kovan.onSessionOutput((id, data) => {
      if (id === sessionId) term.write(data);
    });
    const typed = term.onData((data) => void window.kovan.sessionWrite(sessionId, data));

    // xterm draws on a canvas, not with CSS, so a theme or accent change has
    // to be handed to it — otherwise a terminal keeps the theme it opened in.
    const offAppearance = subscribeAppearance(() => {
      term.options.theme = terminalTheme();
    });

    const observer = new ResizeObserver(sync);
    observer.observe(host.current);

    // Files and images in, as VS Code's terminal takes them: a dropped file,
    // a file copied in Finder, or a screenshot on the clipboard all arrive as
    // their path, typed in as a paste. xterm on its own only pastes text, so
    // an image-only clipboard did nothing at all.
    const element = host.current;
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
      disposed = true;
      live.current = null;
      observer.disconnect();
      element.removeEventListener('dragover', onDragOver);
      element.removeEventListener('drop', onDrop);
      element.removeEventListener('paste', onPaste, true);
      offOutput();
      offAppearance();
      typed.dispose();
      term.dispose();
    };
  }, [sessionId]);

  // Mutates the live instance rather than rebuilding it — a remount here
  // would cost the scroll position and flicker on every step of Cmd+=.
  useEffect(() => {
    const current = live.current;
    if (!current || current.term.options.fontSize === fontSize) return;
    current.term.options.fontSize = fontSize;
    try {
      const proposed = current.fit.proposeDimensions();
      current.fit.fit();
      if (proposed) void window.kovan.sessionResize(sessionId, proposed.cols, proposed.rows);
    } catch {
      // Same detached/zero-size case `sync` above already tolerates.
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
