/**
 * The seam.
 *
 * Everything in `@kovan/core` and `@kovan/providers` reaches the outside world
 * through this interface and nothing else. That is the whole reason one
 * provider implementation can serve both the Electron app and the VS Code
 * extension: each supplies its own `Host` and the shared code never learns
 * which one it got.
 *
 * Keep this file free of imports. The moment it depends on `electron` or
 * `vscode` the seam has leaked and the duplication comes back.
 */

// --- Disposables and events --------------------------------------------------
// Deliberately the same shape as the VS Code primitives the ported code was
// written against, so `Hub` and the providers moved across with near-zero edits.

export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (!done) {
        done = true;
        fn();
      }
    }
  };
}

export class DisposableStore implements Disposable {
  private readonly items: Disposable[] = [];

  add<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  dispose(): void {
    while (this.items.length > 0) {
      // Pop rather than iterate: a listener disposed mid-loop may add more.
      this.items.pop()?.dispose();
    }
  }
}

export type Listener<T> = (value: T) => void;

export class EventEmitter<T> implements Disposable {
  private listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  };

  fire(value: T): void {
    // Copy first: a listener that disposes itself must not perturb this pass.
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A throwing listener is its own bug and must not stop the others
        // hearing about a refresh.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

// --- Host --------------------------------------------------------------------

/**
 * Token storage. Backed by the system Keychain on both hosts, which is why
 * every call is async and none of them cache: a stale token held in a property
 * is a support ticket.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Whether a secret exists, without reading it — avoids the auth prompt. */
  has(key: string): Promise<boolean>;
}

export interface ConfigStore {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): Promise<void>;
  onChange(listener: (key: string) => void): Disposable;
}

export interface FileStore {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Absolute path to the per-user state directory. */
  stateDir(): string;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface Host {
  readonly secrets: SecretStore;
  readonly config: ConfigStore;
  readonly files: FileStore;
  readonly log: Logger;
}

// --- Cancellation ------------------------------------------------------------

/**
 * Replaces `vscode.CancellationToken` throughout the ported provider code.
 *
 * `AbortSignal` is the platform primitive `fetch` already speaks, so this swap
 * removed a translation step rather than adding one.
 */
export type CancelSignal = AbortSignal;

export class CancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'CancelledError';
  }
}

/** Rejects with `CancelledError` when the signal aborts; resolves otherwise. */
export function sleep(ms: number, signal?: CancelSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
