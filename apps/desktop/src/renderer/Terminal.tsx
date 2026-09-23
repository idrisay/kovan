import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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

    // The terminal has no CSS custom properties of its own, so its theme is
    // read from the page at construction. `data-theme` is App.tsx's already
    // resolved choice — System included, it never leaves that unresolved —
    // so this follows the in-app theme setting rather than the raw OS media
    // query, which would ignore an explicit Light/Dark override.
    const light = document.documentElement.dataset.theme === 'light';
    const term = new Xterm({
      fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
      fontSize,
      cursorBlink: true,
      // The editor surface and the status palette, so the terminal belongs to
      // the same room as the rest of the app rather than looking pasted on.
      theme: light
        ? {
            background: '#fbfaf7', foreground: '#2a2b2f', cursor: '#c0603c',
            selectionBackground: 'rgba(192,96,60,0.22)',
            black: '#16171a', brightBlack: '#8a8984',
            red: '#b4544a', brightRed: '#a5473e',
            green: '#4e8a62', brightGreen: '#3e7350',
            yellow: '#a9783a', brightYellow: '#8d6230',
            blue: '#4c74ae', brightBlue: '#3d5f92',
            magenta: '#8b5fa0', brightMagenta: '#744d87',
            cyan: '#3f7f7a', brightCyan: '#336763',
            white: '#5c5c58', brightWhite: '#16171a'
          }
        : {
            background: '#191b20', foreground: '#dad8d3', cursor: '#d97757',
            selectionBackground: 'rgba(217,119,87,0.28)',
            black: '#0d0e11', brightBlack: '#6e6d69',
            red: '#c4635a', brightRed: '#d4756b',
            green: '#6fa97f', brightGreen: '#8bc196',
            yellow: '#d0a05a', brightYellow: '#e0b877',
            blue: '#7ca0d4', brightBlue: '#9db9e0',
            magenta: '#b58fc4', brightMagenta: '#c9a8d6',
            cyan: '#79b0ab', brightCyan: '#95c6c1',
            white: '#c9c7c2', brightWhite: '#f5f3ef'
          },
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
        void window.baton.sessionResize(sessionId, term.cols, term.rows);
      } catch {
        // Fitting a detached or zero-size element throws; the observer below
        // will call again once it has a size.
      }
    };

    void window.baton.sessionBuffer(sessionId).then((buffer) => {
      if (disposed) return;
      if (buffer) term.write(buffer);
      sync();
      term.focus();
    });

    const offOutput = window.baton.onSessionOutput((id, data) => {
      if (id === sessionId) term.write(data);
    });
    const typed = term.onData((data) => void window.baton.sessionWrite(sessionId, data));

    const observer = new ResizeObserver(sync);
    observer.observe(host.current);

    return () => {
      disposed = true;
      live.current = null;
      observer.disconnect();
      offOutput();
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
      if (proposed) void window.baton.sessionResize(sessionId, proposed.cols, proposed.rows);
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
    <div className="term">
      <div className="term-host" ref={host} />
    </div>
  );
}
