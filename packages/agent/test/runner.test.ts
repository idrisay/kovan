import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { quote, resolve, shellLine, writePrompt, looksLikeAgent, type Runner } from '../src/runner';

const run = promisify(execFile);

/** A prompt built from text other people wrote, containing every shell trap. */
const HOSTILE = [
  'Fix `id` in the parser',
  'also $(whoami) and ${HOME}',
  "and a single ' quote",
  'and "double" quotes; rm -rf /; echo pwned',
  'and a\nnewline'
].join(' ');

const claude: Runner = {
  id: 'claude',
  name: 'Claude Code',
  command: 'claude',
  leadingArgs: [],
  acceptsPrompt: true,
  promptFile: false,
  invocation: 'executable'
};

describe('the security rule', () => {
  it('passes the prompt as one argv element, never through a shell', async () => {
    const resolved = await resolve(claude, HOSTILE);
    // Skipped rather than failed when claude is not installed: this asserts
    // about argv construction, not about the machine.
    if (!resolved) return;
    expect(resolved.args).toContain(HOSTILE);
    // Exactly one element holds it, unsplit and unexpanded.
    expect(resolved.args.filter((a) => a === HOSTILE)).toHaveLength(1);
  });

  it('writes the prompt to a file for shellLine, never inline', async () => {
    const line = await shellLine(claude, HOSTILE);
    if (!line) return;
    // The dangerous text must not appear in the command line at all.
    expect(line).not.toContain('$(whoami)');
    expect(line).not.toContain('rm -rf');
    expect(line).not.toContain('`id`');
    // It arrives by file substitution instead.
    expect(line).toMatch(/"\$\(< '.*baton-prompts.*'\)"/);
  });

  it('round-trips a hostile prompt through a real shell unchanged', async () => {
    // The actual claim, tested end to end: a shell given this line must hand
    // the program the prompt verbatim — no substitution, no word splitting.
    const file = await writePrompt(HOSTILE);
    const { stdout } = await run(
      '/bin/zsh',
      ['-c', `printf '%s' "$(< ${quote(file)})"`],
      { maxBuffer: 1024 * 1024 }
    );
    expect(stdout).toBe(HOSTILE);
    expect(stdout).toContain('`id`');
    expect(stdout).toContain('$(whoami)');
  });

  it('writes prompt files readable only by their owner', async () => {
    const file = await writePrompt('secret-ish');
    const { stdout } = await run('stat', ['-f', '%Lp', file]);
    expect(stdout.trim()).toBe('600');
  });

  it('refuses a command name that could escape into the script', async () => {
    for (const command of ['evil; rm -rf /', 'a b', '$(id)', '`id`', '', 'x'.repeat(65)]) {
      const runner: Runner = { ...claude, command, invocation: 'shellFunction' };
      expect(await resolve(runner, 'hi')).toBeUndefined();
      expect(await shellLine(runner, 'hi')).toBeUndefined();
    }
  });

  it('keeps a shell function prompt out of the script body', async () => {
    const runner: Runner = { ...claude, command: 'nv-review', invocation: 'shellFunction' };
    const resolved = await resolve(runner, HOSTILE);
    expect(resolved).toBeDefined();
    // The script is fixed; the prompt rides in as a positional parameter.
    expect(resolved!.args).toContain('nv-review "$@"');
    expect(resolved!.args).toContain(HOSTILE);
    expect(resolved!.args.some((a) => a.includes('nv-review') && a.includes('whoami'))).toBe(false);
  });
});

describe('quote', () => {
  it('survives embedded single quotes', async () => {
    const nasty = `it's a 'test' with '' quotes`;
    const { stdout } = await run('/bin/zsh', ['-c', `printf '%s' ${quote(nasty)}`]);
    expect(stdout).toBe(nasty);
  });
});

describe('agent name heuristics', () => {
  it('finds wrappers nobody listed', () => {
    expect(looksLikeAgent('claude-glm51')).toBe(true);
    expect(looksLikeAgent('cc-orca')).toBe(true);
    expect(looksLikeAgent('nv-review')).toBe(true);
  });

  it('ignores zsh internals', () => {
    // Matching on "cursor" alone used to drag these in.
    expect(looksLikeAgent('_zsh_highlight_cursor_moved')).toBe(false);
    expect(looksLikeAgent('_claude_completion')).toBe(false);
  });
});
