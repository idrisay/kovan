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

    const term = new Xterm({
      fontFamily: 'SF Mono, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      // Matches the panel background so the terminal does not look pasted on.
      theme: { background: '#141518', foreground: '#e6e7ea', cursor: '#6ea8fe' },
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
