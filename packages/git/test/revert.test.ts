import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { revertTracked } from '../src/revert';

const repos: string[] = [];
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'kovan-revert-'));
  repos.push(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(repo, name), text);
  git('add', '-A');
  git('commit', '-qm', 'base');
  return repo;
}

describe('revertTracked', () => {
  it('reads a path as a file name, not a pathspec pattern', async () => {
    // `:!keep.txt` is git's "everything except keep.txt" unless paths are literal.
    const repo = repoWith({ ':!keep.txt': 'odd\n', 'keep.txt': 'a\n', 'other.txt': 'b\n' });
    writeFileSync(path.join(repo, ':!keep.txt'), 'odd edited\n');
    writeFileSync(path.join(repo, 'other.txt'), 'b edited\n');
    await revertTracked(repo, [':!keep.txt'], 'unstaged');
    expect(readFileSync(path.join(repo, ':!keep.txt'), 'utf8')).toBe('odd\n');
    // The other file's edit is still there.
    expect(readFileSync(path.join(repo, 'other.txt'), 'utf8')).toBe('b edited\n');
  });
});
