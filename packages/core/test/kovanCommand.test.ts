import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KOVAN_OPEN_FLAG, appBundleOf, commandLineOpen, isKovanCommandScript, kovanCommandScript, openCandidates,
  scriptTarget, shellQuote
} from '../src/kovanCommand';

describe('the open request in argv', () => {
  it('reads the folder and the paths', () => {
    expect(commandLineOpen(['/Applications/Kovan.app/Contents/MacOS/Kovan', KOVAN_OPEN_FLAG, '--cwd', '/Users/me', '--', 'a.md', '-weird']))
      .toEqual({ cwd: '/Users/me', paths: ['a.md', '-weird'] });
  });

  it('is not an open request without the flag', () => {
    expect(commandLineOpen(['/x/Kovan', '--hidden'])).toBeUndefined();
  });
});

describe('what a path may mean', () => {
  it('tries it as written, then without pasted punctuation, then with a line', () => {
    expect(openCandidates('~/notes/improvements.md.')).toEqual([
      { path: '~/notes/improvements.md.' }, { path: '~/notes/improvements.md' }
    ]);
    expect(openCandidates('src/main.ts:42:7')).toEqual([
      { path: 'src/main.ts:42:7' }, { path: 'src/main.ts', line: 42, column: 7 }
    ]);
    expect(openCandidates('(src/main.ts:42),')).toContainEqual({ path: 'src/main.ts', line: 42 });
  });
});

describe('the script', () => {
  it('quotes anything for sh', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('finds the bundle and reads its target back', () => {
    expect(appBundleOf('/Applications/Kovan.app/Contents/MacOS/Kovan')).toBe('/Applications/Kovan.app');
    expect(appBundleOf('/usr/bin/kovan')).toBeUndefined();
    const mac = kovanCommandScript({ platform: 'darwin', app: "/Users/me/Apps/It's Kovan.app" });
    expect(isKovanCommandScript(mac)).toBe(true);
    expect(scriptTarget(mac)).toBe("/Users/me/Apps/It's Kovan.app");
    expect(scriptTarget(kovanCommandScript({ platform: 'linux', app: '/opt/Kovan/kovan' }))).toBe('/opt/Kovan/kovan');
    expect(isKovanCommandScript('#!/bin/sh\necho someone else\n')).toBe(false);
  });

  // The script really runs: `open` is swapped for a stub that prints what it got.
  it('checks paths in the terminal and hands the rest to Kovan', () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'kovan-cmd-')));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'open'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const script = path.join(dir, 'kovan');
    writeFileSync(script, kovanCommandScript({ platform: 'darwin', app: '/Applications/Kovan.app' }), { mode: 0o755 });
    writeFileSync(path.join(dir, 'improvements.md'), '# notes\n');
    const run = (...args: string[]) => execFileSync('/bin/sh', [script, ...args], {
      cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });

    const out = run('improvements.md.', 'improvements.md:12').trim().split('\n');
    expect(out).toEqual(['-n', '-a', '/Applications/Kovan.app', '--args', KOVAN_OPEN_FLAG, '--cwd', dir, '--', 'improvements.md.', 'improvements.md:12']);

    let failed: { status?: number; stderr?: string } = {};
    try { run('nope.md'); } catch (err) { failed = err as typeof failed; }
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('kovan: no such file or folder: nope.md');
  });
});
