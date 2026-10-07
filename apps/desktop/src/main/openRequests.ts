/**
 * "Open in Kovan" requests from the pane beside Claude (item 148).
 *
 * The pane writes `<id>.json` into this folder; Kovan reads it, deletes it,
 * acts on it, and writes `<id>.reply` with a one-line answer the pane shows
 * as a toast. A reply nobody read is removed after a minute, and requests
 * left from before Kovan started are dropped, not acted on: a click from an
 * hour ago must not pull the window forward now.
 */

import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseOpenRequest, type OpenReply, type OpenRequest } from '@kovan/core';

const STALE_MS = 60_000;

export class OpenRequests {
  private watcher?: FSWatcher;
  private sweep?: ReturnType<typeof setInterval>;
  private readonly busy = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly handle: (request: OpenRequest) => Promise<OpenReply>,
    private readonly log: (message: string) => void
  ) {}

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      await rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
    }
    this.watcher = watch(this.dir, (_event, name) => {
      if (name && String(name).endsWith('.json')) void this.take(String(name));
    });
    // macOS can hold a new watcher's first events for seconds, and a click
    // that waits that long reads as broken: a look at this tiny folder each
    // second catches what the watch hasn't reported yet.
    this.sweep = setInterval(() => {
      void readdir(this.dir).then((names) => {
        for (const name of names) if (name.endsWith('.json')) void this.take(name);
      }, () => undefined);
    }, 1_000);
  }

  stop(): void {
    this.watcher?.close();
    if (this.sweep) clearInterval(this.sweep);
  }

  private async take(name: string): Promise<void> {
    if (this.busy.has(name) || !/^[\w.-]+\.json$/.test(name)) return;
    this.busy.add(name);
    const file = path.join(this.dir, name);
    try {
      // The pane writes in one go but a watch can fire mid-write: read until it parses.
      let request: OpenRequest | undefined;
      for (let attempt = 0; attempt < 5 && !request; attempt++) {
        const info = await stat(file).catch(() => undefined);
        if (!info) return;
        if (Date.now() - info.mtimeMs > STALE_MS) break;
        request = parseOpenRequest(await readFile(file, 'utf8').catch(() => ''));
        if (!request) await new Promise((r) => setTimeout(r, 100));
      }
      await rm(file, { force: true });
      const reply: OpenReply = request
        ? await this.handle(request).catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }))
        : { ok: false, message: "Kovan couldn't read that request." };
      const replyFile = file.replace(/\.json$/, '.reply');
      await writeFile(replyFile, JSON.stringify(reply), 'utf8');
      setTimeout(() => { void rm(replyFile, { force: true }); }, STALE_MS);
      this.log(`open request ${request ? `${request.repo} ${request.file}` : '(unreadable)'}: ${reply.message}`);
    } finally {
      this.busy.delete(name);
    }
  }
}
