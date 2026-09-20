/**
 * The write path, which is the only place in Baton that can destroy your work.
 *
 * Electron is mocked because `Workspaces` imports `dialog` for the folder
 * picker; nothing under test here touches it.
 */

import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }));

const { Workspaces } = await import('../src/main/workspace');
type Host = Parameters<typeof Workspaces.prototype.constructor>[0];

let root: string;
let outside: string;
let workspaces: InstanceType<typeof Workspaces>;
const logged: unknown[] = [];

function hostFor(folders: string[]) {
  const values: Record<string, unknown> = {
    workspaces: [{ id: 'w', name: 'test', folders }]
  };
  return {
    secrets: {} as never,
    files: {} as never,
    config: {
      get: <T>(key: string, fallback: T) => (values[key] as T) ?? fallback,
      set: async (key: string, value: unknown) => { values[key] = value; },
      all: () => values,
      onChange: () => ({ dispose() {} })
    },
    log: {
      info: () => {}, warn: (...a: unknown[]) => logged.push(a),
      error: (...a: unknown[]) => logged.push(a)
    }
  } as unknown as Host;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'baton-ws-'));
  outside = await mkdtemp(path.join(tmpdir(), 'baton-out-'));
  workspaces = new Workspaces(hostFor([root]));
  logged.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const stamp = async (file: string) => {
  const info = await stat(file);
  return { mtimeMs: info.mtimeMs, bytes: info.size };
};

describe('write', () => {
  it('writes the file and returns a fresh stamp', async () => {
    const file = path.join(root, 'a.ts');
    await writeFile(file, 'before\n');
    const result = await workspaces.write(file, 'after\n', await stamp(file));

    expect(result.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('after\n');
    if (result.ok) {
      expect(result.stamp.bytes).toBe(6);
    }
  });

  it('refuses when the file moved under it, and does not write', async () => {
    const file = path.join(root, 'a.ts');
    await writeFile(file, 'original\n');
    const opened = await stamp(file);

    // Somebody else — an agent in the same clone — writes it.
    await new Promise((r) => setTimeout(r, 12));
    await writeFile(file, 'from the agent, much longer\n');

    const result = await workspaces.write(file, 'mine\n', opened);
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    // The point of the check: their work is still on disk.
    expect(await readFile(file, 'utf8')).toBe('from the agent, much longer\n');
  });

  it('overwrites when no stamp is passed, which is the explicit "keep mine"', async () => {
    const file = path.join(root, 'a.ts');
    await writeFile(file, 'theirs\n');
    const result = await workspaces.write(file, 'mine\n');
    expect(result.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('mine\n');
  });

  it('refuses a path outside every workspace folder', async () => {
    const target = path.join(outside, 'secret.txt');
    await writeFile(target, 'untouched\n');

    const result = await workspaces.write(target, 'owned\n');
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect(await readFile(target, 'utf8')).toBe('untouched\n');
  });

  it('refuses a symlink that points out of the workspace', async () => {
    // The attack the realpath check exists for: the path looks like it is
    // inside, and resolving it is the only way to find out that it is not.
    const target = path.join(outside, 'secret.txt');
    await writeFile(target, 'untouched\n');
    const link = path.join(root, 'innocent.txt');
    await symlink(target, link);

    const result = await workspaces.write(link, 'owned\n');
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect(await readFile(target, 'utf8')).toBe('untouched\n');
  });

  it('refuses a path that climbs out with ..', async () => {
    const target = path.join(outside, 'secret.txt');
    await writeFile(target, 'untouched\n');
    const climbing = path.join(root, '..', path.basename(outside), 'secret.txt');

    const result = await workspaces.write(climbing, 'owned\n');
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect(await readFile(target, 'utf8')).toBe('untouched\n');
  });

  it('refuses a directory', async () => {
    const dir = path.join(root, 'sub');
    await mkdir(dir);
    const result = await workspaces.write(dir, 'nope');
    expect(result).toMatchObject({ ok: false, reason: 'error' });
  });

  it('keeps the original permission bits', async () => {
    // Writing 0644 over a script silently un-executes it.
    const file = path.join(root, 'run.sh');
    await writeFile(file, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await workspaces.write(file, '#!/bin/sh\necho bye\n', await stamp(file));
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it('leaves no temp file behind', async () => {
    const file = path.join(root, 'a.ts');
    await writeFile(file, 'x\n');
    await workspaces.write(file, 'y\n', await stamp(file));
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).filter((n) => n.startsWith('.baton-'))).toEqual([]);
  });

  it('round-trips a save, so the returned stamp is usable for the next one', async () => {
    const file = path.join(root, 'a.ts');
    await writeFile(file, 'one\n');

    const first = await workspaces.write(file, 'two\n', await stamp(file));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Saving again with the stamp the first save returned must not be stale.
    const second = await workspaces.write(file, 'three\n', first.stamp);
    expect(second.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('three\n');
  });
});

describe('read', () => {
  it('carries the stamp the editor needs to detect a conflict', async () => {
    const file = path.join(root, 'a.ts');
    await writeFile(file, 'hello\n');
    const body = await workspaces.read(file);
    expect(body.kind).toBe('text');
    expect(body.bytes).toBe(6);
    expect(body.mtimeMs).toBeGreaterThan(0);
  });

  it('reports a binary file instead of decoding it as text', async () => {
    const file = path.join(root, 'blob.bin');
    await writeFile(file, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    expect((await workspaces.read(file)).kind).toBe('binary');
  });

  it('refuses to read outside the workspace', async () => {
    const target = path.join(outside, 'secret.txt');
    await writeFile(target, 'secret\n');
    await expect(workspaces.read(target)).rejects.toThrow();
  });
});
