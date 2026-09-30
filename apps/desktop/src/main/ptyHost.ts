/**
 * The terminal host (item 114): a small background process that owns every
 * session's pty, so quitting Baton, an update or a crash no longer ends the
 * agents running in them. Baton connects to it over a Unix socket, the way
 * tmux's client talks to its server, and picks its sessions up again when it
 * starts.
 *
 * Runs as Electron's own binary in Node mode (ELECTRON_RUN_AS_NODE), started
 * detached by `ptyClient.ts`. Imports nothing from Baton — only node and
 * node-pty — so it is its own small file, unpacked from the app archive.
 *
 * It keeps what a restarted Baton needs to redraw each session: its details
 * as Baton last described them (opaque here), the tail of its output, and
 * whether it is still running. It exits by itself once no Baton is
 * connected and nothing is running in it; a restart of the Mac ends it, as
 * it ends any terminal.
 *
 * The messages are one JSON object per line. They only ever grow new
 * optional fields: an older host must keep working with a newer Baton, since
 * a host started before an update serves its sessions until they end.
 */

import { createServer, connect, type Socket } from 'node:net';
import { chmodSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IPty } from 'node-pty';

// node-pty through the app archive's path, as the main process loads it, not
// from the unpacked copy this file runs from: node-pty turns "app.asar" into
// "app.asar.unpacked" to find its spawn helper, and from an already unpacked
// path that makes "app.asar.unpacked.unpacked" — every spawn then fails.
const { spawn } = createRequire(fileURLToPath(import.meta.url).replace(`app.asar.unpacked${sep}`, `app.asar${sep}`))('node-pty') as typeof import('node-pty');

// Kept in step with ptyClient.ts by hand: importing this file would run it.
const PROTOCOL = 1;

const BUFFER_LIMIT = 256 * 1024;
/** How long an empty, unwatched host waits before it goes. */
const IDLE_EXIT_MS = 5_000;

interface HostedPty {
  id: string;
  pty: IPty;
  pid: number;
  meta: unknown;
  buffer: string;
  running: boolean;
  exitCode?: number;
}

type Request =
  | { t: 'hello' }
  | { t: 'spawn'; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number; meta: unknown }
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'meta'; id: string; meta: unknown }
  | { t: 'kill'; id: string }
  | { t: 'forget'; id: string }
  | { t: 'process'; id: string; rid: number };

function main(socketPath: string): void {
  const sessions = new Map<string, HostedPty>();
  const clients = new Set<Socket>();
  let idle: NodeJS.Timeout | undefined;

  const broadcast = (message: object) => {
    const line = `${JSON.stringify(message)}\n`;
    for (const client of clients) client.write(line);
  };

  const checkIdle = () => {
    clearTimeout(idle);
    const running = [...sessions.values()].some((s) => s.running);
    if (clients.size === 0 && !running) {
      idle = setTimeout(() => {
        if (clients.size === 0 && ![...sessions.values()].some((s) => s.running)) shutdown();
      }, IDLE_EXIT_MS);
    }
  };

  const shutdown = () => {
    for (const s of sessions.values()) if (s.running) try { s.pty.kill(); } catch { /* gone */ }
    try { unlinkSync(socketPath); } catch { /* gone */ }
    process.exit(0);
  };

  const handle = (client: Socket, request: Request) => {
    const reply = (message: object) => client.write(`${JSON.stringify(message)}\n`);
    switch (request.t) {
      case 'hello':
        reply({
          t: 'hello', protocol: PROTOCOL, pid: process.pid,
          sessions: [...sessions.values()].map((s) => ({
            id: s.id, pid: s.pid, meta: s.meta, running: s.running, exitCode: s.exitCode, buffer: s.buffer
          }))
        });
        return;
      case 'spawn': {
        try {
          const pty = spawn(request.file, request.args, {
            name: 'xterm-256color', cols: request.cols, rows: request.rows, cwd: request.cwd, env: request.env
          });
          const hosted: HostedPty = { id: request.id, pty, pid: pty.pid, meta: request.meta, buffer: '', running: true };
          sessions.set(request.id, hosted);
          pty.onData((data) => {
            hosted.buffer = (hosted.buffer + data).slice(-BUFFER_LIMIT);
            broadcast({ t: 'data', id: hosted.id, data });
          });
          pty.onExit(({ exitCode }) => {
            hosted.running = false;
            hosted.exitCode = exitCode;
            broadcast({ t: 'exit', id: hosted.id, exitCode });
            checkIdle();
          });
          reply({ t: 'spawned', id: request.id, pid: pty.pid });
        } catch (error) {
          reply({ t: 'spawned', id: request.id, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case 'write':
        sessions.get(request.id)?.pty.write(request.data);
        return;
      case 'resize': {
        const s = sessions.get(request.id);
        if (s?.running) try { s.pty.resize(Math.max(request.cols, 2), Math.max(request.rows, 2)); } catch { /* exiting */ }
        return;
      }
      case 'meta': {
        const s = sessions.get(request.id);
        if (s) s.meta = request.meta;
        return;
      }
      case 'kill': {
        const s = sessions.get(request.id);
        if (s?.running) try { s.pty.kill(); } catch { /* gone */ }
        sessions.delete(request.id);
        checkIdle();
        return;
      }
      case 'forget':
        sessions.delete(request.id);
        return;
      case 'process': {
        const s = sessions.get(request.id);
        let name = '';
        try { name = s?.running ? s.pty.process ?? '' : ''; } catch { /* exiting */ }
        reply({ t: 'process', rid: request.rid, name });
      }
    }
  };

  const server = createServer((client) => {
    clients.add(client);
    clearTimeout(idle);
    client.setEncoding('utf8');
    let carry = '';
    client.on('data', (chunk: string) => {
      carry += chunk;
      let at: number;
      while ((at = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, at);
        carry = carry.slice(at + 1);
        try { handle(client, JSON.parse(line) as Request); } catch { /* one bad line, not the host */ }
      }
    });
    const gone = () => { clients.delete(client); checkIdle(); };
    client.on('close', gone);
    client.on('error', gone);
  });

  const listen = () => server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
    checkIdle();
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') process.exit(1);
    // Another host already answers there — leave it be. A socket file
    // nothing answers on is left from a host that died: take its place.
    const probe = connect(socketPath);
    probe.on('connect', () => { probe.destroy(); process.exit(0); });
    probe.on('error', () => { try { unlinkSync(socketPath); } catch { /* raced */ } listen(); });
  });
  listen();

  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', () => { /* the terminal that started it is not a reason to stop */ });
  // One session's error must not end everyone else's agents.
  process.on('uncaughtException', () => { /* keep serving */ });
}

const socketPath = process.argv[2];
if (socketPath) main(socketPath);
