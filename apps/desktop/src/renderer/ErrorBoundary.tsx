/**
 * What happens when something in the window throws (item 83).
 *
 * Without a boundary, React unmounts the whole tree on a render error, which
 * is how opening one pull request left a black window: one `undefined.id` in
 * the detail pane took the sidebar, the rail and the status bar with it.
 *
 * Now the pane that threw is replaced by a card saying so, the rest of the
 * window keeps working, and the error — with the component stack that says
 * where — is written to `~/Library/Logs/Baton/baton.log`.
 */

import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import type { RendererErrorReport } from './types';

function report(report: RendererErrorReport): void {
  // Logging must never be what breaks: no bridge (a test page) or a failed
  // write is swallowed, and the console still has it.
  try {
    void window.baton?.logError(report).catch(() => undefined);
  } catch {
    // Nothing left to tell.
  }
}

/**
 * Errors outside React's render — an event handler, a timer, a promise
 * nobody awaited. They don't blank the window, but they are the same kind of
 * bug, and without this they were only ever visible with DevTools open.
 */
export function installErrorReporting(): void {
  window.addEventListener('error', (event) => {
    report({
      kind: 'error',
      message: event.message || String(event.error),
      stack: event.error instanceof Error ? event.error.stack : undefined,
      where: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    report({
      kind: 'rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined
    });
  });
}

interface Props {
  /** Said in the card and in the log: which pane, and what was open in it. */
  where: string;
  /** A change clears the error, so picking another row gets a fresh try. */
  resetKey?: string;
  /** The whole window rather than one pane: the card fills it. */
  whole?: boolean;
  children: ReactNode;
}

interface State {
  error?: Error;
  componentStack?: string;
  resetKey?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Moving to another row is a new pane, not the broken one again.
    if (props.resetKey !== state.resetKey) {
      return { resetKey: props.resetKey, error: undefined, componentStack: undefined };
    }
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? undefined;
    this.setState({ componentStack });
    report({ kind: 'render', message: error.message, stack: error.stack, componentStack, where: this.props.where });
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return (
      <ErrorCard
        where={this.props.where}
        error={error}
        componentStack={componentStack}
        whole={this.props.whole}
        onRetry={() => this.setState({ error: undefined, componentStack: undefined })}
      />
    );
  }
}

function ErrorCard({ where, error, componentStack, whole, onRetry }: {
  where: string;
  error: Error;
  componentStack?: string;
  whole?: boolean;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const details = [
    `Where: ${where}`,
    `${error.name}: ${error.message}`,
    error.stack ?? '',
    componentStack ? `Component stack:${componentStack}` : ''
  ].filter(Boolean).join('\n');

  return (
    <div className={`error-card${whole ? ' whole' : ''}`} role="alert">
      <h2>{whole ? 'Baton hit an error' : 'This pane hit an error'}</h2>
      <p className="error-card-note">
        {whole
          ? 'Something in the window broke.'
          : 'Something in it broke; the rest of Baton is fine, and picking another row works.'}{' '}
        What happened is saved in Baton's log, so it can be fixed.
      </p>
      <pre className="error-card-message">{error.name}: {error.message}</pre>
      <div className="error-card-actions">
        <button type="button" className="ghost" onClick={whole ? () => location.reload() : onRetry}>
          {whole ? 'Reload the window' : 'Try again'}
        </button>
        <button type="button" className="ghost" onClick={() => void window.baton.revealLog()}>
          Show log in Finder
        </button>
        <button
          type="button"
          className="link"
          onClick={() => void window.baton.copyText(details).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
    </div>
  );
}
