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
export function Terminal({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;

    // The terminal has no CSS custom properties of its own, so its theme is
    // read from the page at construction and swapped when the OS appearance
    // changes. Without this it stayed dark on a light desktop.
    const light = matchMedia('(prefers-color-scheme: light)').matches;
    const term = new Xterm({
      fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
      fontSize: 12,
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

    let disposed = false;

    const sync = () => {
      try {
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
      observer.disconnect();
      offOutput();
      typed.dispose();
      term.dispose();
    };
  }, [sessionId]);

  return <div className="term" ref={host} />;
}
