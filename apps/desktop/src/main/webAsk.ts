/**
 * One headless CLI call whose only tools are web search and fetch, in an
 * empty temp folder — what "Check prices online" and the run sheet's model
 * search both are. Started only by a click, one at a time per instance.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isModelName, type PriceCheckRunner } from '@baton/core';
import { parseQuickOutput, shellEnvironment } from '@baton/agent';

const TIMEOUT_MS = 5 * 60_000;

/** opencode with everything refused but reading the web. */
const OPENCODE_WEB_ONLY = JSON.stringify({
  permission: { '*': 'ask', webfetch: 'allow', websearch: 'allow' },
  share: 'disabled',
  autoupdate: false
});

export class WebAsk {
  private child?: ChildProcess;

  get busy(): boolean {
    return Boolean(this.child);
  }

  cancel(): void {
    this.child?.kill('SIGTERM');
  }

  /** The model's final text, or why there is none. */
  async ask(runner: PriceCheckRunner, model: string, prompt: string): Promise<{ text: string } | { error: string }> {
    if (this.child) return { error: 'A search is already running.' };
    if (runner !== 'claude' && runner !== 'codex' && runner !== 'opencode') return { error: 'Unknown runner.' };
    const trimmed = model.trim();
    // One argv word, never through a shell — but still checked.
    if (trimmed && !isModelName(trimmed)) return { error: `"${trimmed}" does not look like a model name.` };

    const executable = await shellEnvironment.which(runner);
    if (!executable) return { error: `${runner} is not installed, or not on your login shell's PATH.` };

    const cwd = await mkdtemp(path.join(tmpdir(), 'baton-web-'));
    const last = path.join(cwd, 'answer.txt');
    const env = { ...(await shellEnvironment.environment()) };
    let args: string[];
    let stdin: string | undefined;

    switch (runner) {
      case 'claude':
        // The prompt on stdin: `--tools` takes a list and would swallow a
        // trailing argument.
        args = ['-p', '--output-format', 'text', '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'];
        if (trimmed) args.push('--model', trimmed);
        stdin = prompt;
        break;
      case 'codex':
        args = ['--search', 'exec', '--skip-git-repo-check', '-s', 'read-only', '-o', last];
        if (trimmed) args.push('-m', trimmed);
        args.push('-');
        stdin = prompt;
        break;
      case 'opencode':
        args = ['run', '--format', 'json'];
        if (trimmed) args.push('--model', trimmed);
        args.push('--', prompt);
        env['OPENCODE_CONFIG_CONTENT'] = OPENCODE_WEB_ONLY;
        break;
    }

    try {
      const { out, err, code } = await new Promise<{ out: string; err: string; code: number | null }>((resolve, reject) => {
        const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        let out = '';
        let err = '';
        child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('The search did not finish within 5 minutes.'));
        }, TIMEOUT_MS);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (signal) reject(new Error('Cancelled.'));
          else resolve({ out, err, code });
        });
        child.stdin?.end(stdin ?? '');
      });

      let text = out;
      if (runner === 'codex') text = await readFile(last, 'utf8').catch(() => out);
      if (runner === 'opencode') {
        const parsed = parseQuickOutput(out || err);
        if (!parsed.text) return { error: parsed.error ?? 'opencode returned no answer.' };
        text = parsed.text;
      }
      if (code !== 0 && !text.trim()) {
        const said = err.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        return { error: said ? `${runner} failed: ${said}` : `${runner} exited with code ${code}.` };
      }
      return { text };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.child = undefined;
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
