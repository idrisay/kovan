/**
 * Item 17: rolling back a change in the Workspace tab, one row or "all of
 * them" at once. This is the second place in Kovan (after `write`) that can
 * destroy work, so it gets the same real-repository treatment as
 * `write.test.ts` rather than mocked git calls — the risk here is entirely
 * in what the actual `git restore` arguments do.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = promisify(execFile);
const trashed: string[] = [];

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  // The real `shell.trashItem` removes the file from where it was — a mock
  // that only records the call would leave `git status` still seeing it,
  // which is not what a real revert does.
  shell: { trashItem: vi.fn(async (p: string) => { trashed.push(p); await rm(p, { force: true }); }) }
}));

const { Workspaces } = await import('../src/main/workspace');
type Host = Parameters<typeof Workspaces.prototype.constructor>[0];

let root: string;
let workspaces: InstanceType<typeof Workspaces>;

function hostFor(folders: string[]) {
  const values: Record<string, unknown> = { workspaces: [{ id: 'w', name: 'test', folders }] };
  return {
    secrets: {} as never,
    files: {} as never,
    config: {
      get: <T>(key: string, fallback: T) => (values[key] as T) ?? fallback,
      set: async (key: string, value: unknown) => { values[key] = value; },
      all: () => values,
      onChange: () => ({ dispose() {} })
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  } as unknown as Host;
}

const git = (...args: string[]) => run('git', ['-C', root, ...args]);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kovan-revert-'));
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await writeFile(path.join(root, 'a.ts'), 'original a\n');
  await writeFile(path.join(root, 'b.ts'), 'original b\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'initial');
  workspaces = new Workspaces(hostFor([root]));
  trashed.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('revert', () => {
  it('discards an unstaged edit back to HEAD, leaving a staged one on another file alone', async () => {
    await writeFile(path.join(root, 'a.ts'), 'unstaged edit\n');
    await writeFile(path.join(root, 'b.ts'), 'staged edit\n');
    await git('add', 'b.ts');

    await workspaces.revert(root, [{ path: 'a.ts', side: 'unstaged', kind: 'modified' }]);

    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('original a\n');
    // b.ts's staged edit is a separate row and must survive a.ts's revert.
    const status = await workspaces.status(root);
    expect(status.staged.map((c) => c.path)).toEqual(['b.ts']);
  });

  it('discards a staged edit back to HEAD, index and worktree both', async () => {
    await writeFile(path.join(root, 'a.ts'), 'staged edit\n');
    await git('add', 'a.ts');

    await workspaces.revert(root, [{ path: 'a.ts', side: 'staged', kind: 'modified' }]);

    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('original a\n');
    const status = await workspaces.status(root);
    expect(status.changes).toBe(0);
  });

  it('moves an untracked file to the Trash rather than unlinking it', async () => {
    await writeFile(path.join(root, 'new.ts'), 'brand new\n');

    await workspaces.revert(root, [{ path: 'new.ts', side: 'untracked', kind: 'untracked' }]);

    // `revert` resolves through `inside()`, which realpaths — and on macOS
    // the tmp dir itself is a symlink (/var -> /private/var), so the trashed
    // path is the resolved one, same as every other boundary check in this
    // file does.
    expect(trashed).toEqual([path.join(await realpath(root), 'new.ts')]);
    const status = await workspaces.status(root);
    expect(status.untracked).toEqual([]);
  });

  it('reverts both sides of a rename, not just the destination', async () => {
    await run('git', ['-C', root, 'mv', 'a.ts', 'renamed.ts']);

    await workspaces.revert(root, [
      { path: 'renamed.ts', from: 'a.ts', side: 'staged', kind: 'renamed' }
    ]);

    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('original a\n');
    const status = await workspaces.status(root);
    expect(status.changes).toBe(0);
  });

  it('"revert all" clears every row across staged, unstaged and untracked in one call', async () => {
    await writeFile(path.join(root, 'a.ts'), 'unstaged\n');
    await writeFile(path.join(root, 'b.ts'), 'staged\n');
    await git('add', 'b.ts');
    await writeFile(path.join(root, 'c.ts'), 'new\n');

    const status = await workspaces.status(root);
    await workspaces.revert(root, [...status.staged, ...status.unstaged, ...status.untracked]);

    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('original a\n');
    expect(await readFile(path.join(root, 'b.ts'), 'utf8')).toBe('original b\n');
    expect(trashed).toEqual([path.join(await realpath(root), 'c.ts')]);
    expect((await workspaces.status(root)).changes).toBe(0);
  });

  it('refuses a path that climbs out of the repo', async () => {
    await expect(
      workspaces.revert(root, [{ path: '../../etc/passwd', side: 'unstaged', kind: 'modified' }])
    ).rejects.toThrow('Invalid path');
  });

  it('refuses a repo outside every workspace folder', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'kovan-outside-'));
    try {
      await expect(
        workspaces.revert(other, [{ path: 'a.ts', side: 'unstaged', kind: 'modified' }])
      ).rejects.toThrow();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
