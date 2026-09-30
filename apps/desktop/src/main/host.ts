/**
 * The Electron half of the `Host` seam.
 *
 * Its opposite number is the VS Code implementation in the extension. Neither
 * knows about the other; `@kovan/providers` sees only the interface.
 */

import { app, safeStorage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  EventEmitter,
  type ConfigStore,
  type Disposable,
  type FileStore,
  type Host,
  type Logger,
  type SecretStore
} from '@kovan/host';
import { DEFAULT_SETTINGS, type Settings } from '@kovan/core';
import { appendLog } from './logFile';

const STATE_DIR = () => app.getPath('userData');

// --- Secrets -----------------------------------------------------------------

/**
 * Tokens, encrypted at rest by the OS keychain via `safeStorage`.
 *
 * Note this is *not* the same storage the Swift app used. That wrote one
 * generic-password Keychain item per service under `com.idrisay.devhub.*`;
 * `safeStorage` instead holds a single app key in the Keychain and encrypts a
 * file with it. Existing tokens will therefore look missing on first run —
 * `scripts/import-from-devhub.ts` moves them across, and until it is run the
 * app reports "not connected" rather than failing oddly.
 */
class ElectronSecrets implements SecretStore {
  private readonly file = path.join(STATE_DIR(), 'secrets.json');
  private cache?: Record<string, string>;

  private async load(): Promise<Record<string, string>> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.file);
      const decrypted = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8');
      this.cache = JSON.parse(decrypted) as Record<string, string>;
    } catch {
      // Missing, unreadable or written by a previous OS key. Treating any of
      // those as "no secrets yet" is right: the user is asked to connect again,
      // which is recoverable, where throwing here would wedge startup.
      this.cache = {};
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    const json = JSON.stringify(this.cache ?? {});
    const bytes = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf8');
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key];
  }

  async set(key: string, value: string): Promise<void> {
    const store = await this.load();
    store[key] = value;
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    const store = await this.load();
    delete store[key];
    await this.persist();
  }

  async has(key: string): Promise<boolean> {
    return Boolean((await this.load())[key]);
  }
}

// --- Config ------------------------------------------------------------------

class JsonConfig implements ConfigStore {
  private readonly file = path.join(STATE_DIR(), 'settings.json');
  private values: Partial<Settings> = {};
  private readonly changed = new EventEmitter<string>();

  /**
   * Read synchronously at construction because `get` is synchronous — the
   * ported provider code calls it inline while building a query, and making it
   * async would have rippled through every caller for no gain on a file this
   * small.
   */
  constructor() {
    try {
      if (existsSync(this.file)) {
        this.values = JSON.parse(readFileSync(this.file, 'utf8'));
      }
    } catch {
      this.values = {};
    }
  }

  get<T>(key: string, fallback: T): T {
    const own = (this.values as unknown as Record<string, unknown>)[key];
    if (own !== undefined) {
      return own as T;
    }
    const preset = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
    return (preset !== undefined ? preset : fallback) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    (this.values as unknown as Record<string, unknown>)[key] = value;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.values, null, 2), 'utf8');
    this.changed.fire(key);
  }

  onChange(listener: (key: string) => void): Disposable {
    return this.changed.event(listener);
  }

  all(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.values };
  }
}

// --- Files -------------------------------------------------------------------

class NodeFiles implements FileStore {
  read = (p: string) => fs.readFile(p);
  write = async (p: string, bytes: Uint8Array) => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, bytes);
  };
  mkdirp = async (p: string) => {
    await fs.mkdir(p, { recursive: true });
  };
  remove = async (p: string) => {
    await fs.rm(p, { recursive: true, force: true });
  };
  exists = async (p: string) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  };
  stateDir = () => STATE_DIR();
}

// --- Log ---------------------------------------------------------------------

class ConsoleLog implements Logger {
  private line(level: string, message: string, args: unknown[]): void {
    const stamp = new Date().toISOString();
    console.log(`${stamp} [${level}] ${message}`, ...args);
    // And to disk: the installed app's stdout goes nowhere (item 83).
    appendLog(level, message, args);
  }
  info = (m: string, ...a: unknown[]) => this.line('info', m, a);
  warn = (m: string, ...a: unknown[]) => this.line('warn', m, a);
  error = (m: string, ...a: unknown[]) => this.line('error', m, a);
}

// --- Assembly ----------------------------------------------------------------

export interface DesktopHost extends Host {
  readonly config: JsonConfig;
}

export function createHost(): DesktopHost {
  return {
    secrets: new ElectronSecrets(),
    config: new JsonConfig(),
    files: new NodeFiles(),
    log: new ConsoleLog()
  };
}
