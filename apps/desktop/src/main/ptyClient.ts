/**
 * Kovan's side of the terminal host (item 114; the host is `ptyHost.ts`).
 *
 * On start it connects to every host this profile has running — the one a
 * previous Kovan left, and one from before an update still serving its own
 * sessions — and hands their sessions back to `Sessions`. New sessions go to
 * the host matching this build, started on first use. When a host can't be
 * started, a session runs inside Kovan as it used to, and ends with it.
 *
 * Hosts are told apart by build: a host keeps using the node-pty it was
 * started with, so a new build gets a host of its own rather than sending new
 * sessions to an old one.
 */

import { spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnLocal } from 'node-pty';

const PROTOCOL = 1;

export interface Pty {
  readonly pid: number;
  /** Whether it lives in the terminal host, and so outlives Kovan. */
  readonly hosted: boolean;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** The foreground program's name, as node-pty's `process`. */
  foreground(): Promise<string>;
  /** What a restarted Kovan gets back with this session. */
  describe(meta: unknown): void;
}

export interface SpawnOptions {
  id: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  meta: unknown;
}

export interface RestoredPty {
  pty: Pty;
  meta: unknown;
  running: boolean;
  exitCode?: number;
  buffer: string;
}

interface HostSession { id: string; pid: number; meta: unknown; running: boolean; exitCode?: number; buffer: string }

type Message =
  | { t: 'hello'; protocol: number; pid: number; sessions: HostSession[] }
  | { t: 'spawned'; id: string; pid?: number; error?: string }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; exitCode: number }
  | { t: 'process'; rid: number; name: string };

class HostConnection {
  private carry = '';
  private readonly data = new Map<string, ((data: string) => void)[]>();
  private readonly exits = new Map<string, ((event: { exitCode: number }) => void)[]>();
  private readonly waiting = new Map<string, (message: Message) => void>();
  private nextRid = 1;
  closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => { this.closed = true; });
  }

  static open(socketPath: string, timeoutMs = 1_000): Promise<HostConnection | undefined> {
    return new Promise((resolve) => {
      const socket = connect(socketPath);
      const timer = setTimeout(() => { socket.destroy(); resolve(undefined); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(new HostConnection(socket)); });
      socket.once('error', () => { clearTimeout(timer); resolve(undefined); });
    });
  }

  private receive(chunk: string): void {
    this.carry += chunk;
    let at: number;
    while ((at = this.carry.indexOf('\n')) >= 0) {
      const line = this.carry.slice(0, at);
      this.carry = this.carry.slice(at + 1);
      let message: Message;
      try { message = JSON.parse(line) as Message; } catch { continue; }
      if (message.t === 'data') for (const l of this.data.get(message.id) ?? []) l(message.data);
      else if (message.t === 'exit') for (const l of this.exits.get(message.id) ?? []) l({ exitCode: message.exitCode });
      else {
        const key = message.t === 'process' ? `process:${message.rid}` : message.t === 'spawned' ? `spawned:${message.id}` : 'hello';
        this.waiting.get(key)?.(message);
        this.waiting.delete(key);
      }
    }
  }

  send(message: object): void {
    if (!this.closed) this.socket.write(`${JSON.stringify(message)}\n`);
  }

  private ask<T extends Message>(key: string, message: object, timeoutMs: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(key); resolve(undefined); }, timeoutMs);
      this.waiting.set(key, (reply) => { clearTimeout(timer); resolve(reply as T); });
      this.send(message);
    });
  }

  hello(): Promise<Extract<Message, { t: 'hello' }> | undefined> {
    return this.ask('hello', { t: 'hello' }, 3_000);
  }

  async spawn(options: SpawnOptions): Promise<Pty | { error: string }> {
    const reply = await this.ask<Extract<Message, { t: 'spawned' }>>(`spawned:${options.id}`, { t: 'spawn', ...options }, 10_000);
    if (!reply) return { error: 'The terminal host did not answer.' };
    if (reply.error || reply.pid === undefined) return { error: reply.error ?? 'The terminal could not start.' };
    return this.pty(options.id, reply.pid);
  }

  pty(id: string, pid: number): Pty {
    const on = <L>(map: Map<string, L[]>, listener: L) => map.set(id, [...(map.get(id) ?? []), listener]);
    return {
      pid,
      hosted: true,
      onData: (listener) => on(this.data, listener),
      onExit: (listener) => on(this.exits, listener),
      write: (data) => this.send({ t: 'write', id, data }),
      resize: (cols, rows) => this.send({ t: 'resize', id, cols, rows }),
      kill: () => this.send({ t: 'kill', id }),
      describe: (meta) => this.send({ t: 'meta', id, meta }),
      foreground: async () => {
        const rid = this.nextRid++;
        const reply = await this.ask<Extract<Message, { t: 'process' }>>(`process:${rid}`, { t: 'process', id, rid }, 2_000);
        return reply?.name ?? '';
      }
    };
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

export class PtyHosts {
  private readonly connections: HostConnection[] = [];
  private own?: HostConnection;
  private starting?: Promise<HostConnection | undefined>;

  constructor(private readonly userData: string, private readonly log: (message: string) => void = () => undefined) {}

  /** The host script, outside the app archive when packaged. */
  private get script(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, 'ptyHost.mjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }

  private get prefix(): string {
    return `kovan-pty-${createHash('sha1').update(this.userData).digest('hex').slice(0, 8)}-`;
  }

  private socketFile?: string;

  private get socketPath(): string {
    this.socketFile ??= this.findSocketPath();
    return this.socketFile;
  }

  private findSocketPath(): string {
    let build = 'dev';
    try {
      const nodePty = path.join(path.dirname(fileURLToPath(import.meta.resolve('node-pty'))), '..', 'package.json');
      build = createHash('sha1').update(readFileSync(this.script)).update(existsSync(nodePty) ? readFileSync(nodePty) : '').digest('hex').slice(0, 8);
    } catch { /* one host for all */ }
    return path.join(os.tmpdir(), `${this.prefix}${build}.sock`);
  }

  /** Every session a host of this profile still has — running or finished while Kovan was away. */
  async restore(): Promise<RestoredPty[]> {
    let names: string[] = [];
    try { names = readdirSync(os.tmpdir()).filter((n) => n.startsWith(this.prefix) && n.endsWith('.sock')); } catch { return []; }
    const restored: RestoredPty[] = [];
    for (const name of names) {
      const connection = await HostConnection.open(path.join(os.tmpdir(), name));
      if (!connection) continue;
      const hello = await connection.hello();
      if (!hello || hello.protocol !== PROTOCOL) { connection.close(); continue; }
      this.connections.push(connection);
      if (path.join(os.tmpdir(), name) === this.socketPath) this.own = connection;
      for (const s of hello.sessions) {
        restored.push({ pty: connection.pty(s.id, s.pid), meta: s.meta, running: s.running, exitCode: s.exitCode, buffer: s.buffer });
      }
      this.log(`terminal host ${name}: ${hello.sessions.length} session(s) picked up`);
    }
    return restored;
  }

  async spawn(options: SpawnOptions): Promise<Pty> {
    const host = await this.ownHost();
    if (host) {
      const pty = await host.spawn(options);
      if (!('error' in pty)) return pty;
      this.log(`terminal host could not start a session: ${pty.error}`);
    }
    return localPty(options);
  }

  private async ownHost(): Promise<HostConnection | undefined> {
    if (this.own && !this.own.closed) return this.own;
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<HostConnection | undefined> {
    const socketPath = this.socketPath;
    let connection = await HostConnection.open(socketPath, 300);
    if (!connection) {
      if (!existsSync(this.script)) return undefined;
      try {
        const child = spawnProcess(process.execPath, [this.script, socketPath], {
          detached: true,
          stdio: 'ignore',
          cwd: os.homedir(),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        });
        child.unref();
      } catch (error) {
        this.log(`terminal host did not start: ${String(error)}`);
        return undefined;
      }
      for (let i = 0; i < 50 && !connection; i++) {
        await new Promise((r) => setTimeout(r, 100));
        connection = await HostConnection.open(socketPath, 300);
      }
    }
    if (!connection) {
      this.log('terminal host did not answer; sessions run inside Kovan');
      return undefined;
    }
    const hello = await connection.hello();
    if (!hello || hello.protocol !== PROTOCOL) { connection.close(); return undefined; }
    this.connections.push(connection);
    this.own = connection;
    return connection;
  }

  /** Kovan is going; its hosts and their sessions stay. */
  detach(): void {
    for (const c of this.connections) c.close();
    this.connections.length = 0;
    this.own = undefined;
  }
}

/** A session inside Kovan itself, as before the host: it ends when Kovan does. */
export function localPty(options: Omit<SpawnOptions, 'id' | 'meta'>): Pty {
  const pty = spawnLocal(options.file, options.args, {
    name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env
  });
  return {
    pid: pty.pid,
    hosted: false,
    onData: (listener) => { pty.onData(listener); },
    onExit: (listener) => { pty.onExit(({ exitCode }) => listener({ exitCode })); },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    foreground: async () => pty.process ?? '',
    describe: () => undefined
  };
}
