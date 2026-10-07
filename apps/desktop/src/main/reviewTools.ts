/**
 * Reviewers (item 143): the list in Settings › Agents › Reviewers, and
 * running one on a pull request. The pure half — kinds, the stored model
 * string, agent flags, the test pull request — is `@kovan/core`'s
 * `reviewTools.ts`.
 *
 * A command gets the prompt on stdin, in an empty temp folder: it only ever
 * sees the prompt. An agent gets it in a throwaway worktree at the PR's head,
 * made from your own clone and removed afterwards, so it can read whole files
 * — and it runs read-only there (see `agentReviewArgs`).
 *
 * Nothing here runs by itself: a review starts from the Review button, a
 * test from Settings' Test.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, constants, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  AGENT_FAMILY_NAME, REVIEW_TEST_DIFF, REVIEW_TEST_FILE, REVIEW_TEST_SOURCE, agentFamily, agentReviewArgs, commandReviewArgs,
  foundPlantedBug, isEnvName, isFlagName, normaliseReviewTools, parseCommandHelp, pullReviewPrompt, reviewToolId, splitVerdict,
  stripReviewHeader, NV_REVIEW_TOOL_ID, type AgentFamily, type CommandHelp, type QuickPullInput, type ReviewTool
} from '@kovan/core';
import { isSafeCommandName, loginShell, shellEnvironment, type CommandKind, type Runner } from '@kovan/agent';
import type { DesktopHost } from './host';

/** Something on this machine that could be a reviewer, for the Add form. */
export interface ReviewCandidate {
  command: string;
  kind: 'agent' | 'command';
  family?: AgentFamily;
  /** "on PATH", "shell function" */
  how: string;
}

/** What the Add form learns about a command: whether the shell finds it, and what its --help says. */
export interface CommandSetup {
  found: CommandKind;
  /** Undefined when it printed no usable help. */
  help?: CommandHelp;
  /** The key files its help names, and whether each exists yet. */
  keys: { path: string; exists: boolean }[];
}

/** Key files Kovan may write: under your home, in a dot-folder, named like a key. */
function keyFilePath(display: string): string | undefined {
  if (!/^~\/\.[\w.-]+(\/[\w.-]+)+$/.test(display) || display.includes('..')) return undefined;
  if (!/(^|[._-])(key|token|secret|credentials?|api[_-]?key)([._-]|$)/i.test(display.split('/').pop() ?? '')) return undefined;
  return path.join(homedir(), display.slice(2));
}

export interface ReviewTestCheck {
  label: string;
  ok: boolean;
  /** "41 s", or why it failed. */
  note?: string;
}

/** What a run needs from its caller: where to hang the process, and whether it was cancelled. */
export interface ReviewRunControl {
  onChild(child: ChildProcess): void;
  cancelled(): boolean;
}

const SMOKE = Boolean(process.env['KOVAN_SMOKE'] && process.env['KOVAN_USER_DATA']);

export class ReviewTools {
  constructor(
    private readonly host: DesktopHost,
    private readonly runners: () => Promise<Runner[]>,
    /** The user's clone of `owner/name`, or undefined — never some other folder. */
    private readonly cloneFor: (repo: string) => Promise<string | undefined>
  ) {}

  list(): ReviewTool[] {
    return normaliseReviewTools(this.host.config.get('review.tools', []), this.host.config.get('review.nvModel', ''));
  }

  find(id: string): ReviewTool | undefined {
    return this.list().find((t) => t.id === id);
  }

  /** A reviewer from the window — saved or still a draft — checked the way a saved one is. */
  sanitize(input: Partial<ReviewTool>): ReviewTool | undefined {
    const id = typeof input.id === 'string' && input.id ? input.id : 'draft-unsaved';
    const nv = id === NV_REVIEW_TOOL_ID;
    return normaliseReviewTools([{ ...input, id }], nv ? String(input.model ?? '') : '').find((t) => t.id === id);
  }

  /**
   * Adds or replaces one. A new one (no id) gets one from its command. Refuses
   * what could not run safely rather than repairing it.
   */
  async save(input: Partial<ReviewTool>): Promise<{ ok: boolean; error?: string; tools: ReviewTool[] }> {
    const tools = this.list();
    const command = String(input.command ?? '').trim();
    const fail = (error: string) => ({ ok: false, error, tools });
    if (!isSafeCommandName(command)) return fail('That command name has characters a shell would read as code.');
    const kind = input.kind === 'agent' ? 'agent' : 'command';
    const family = kind === 'agent' ? agentFamily(command) : undefined;
    if (kind === 'agent' && !family) return fail(`Kovan can only run Claude Code or Codex as an agent reviewer, and ${command} is neither.`);
    const modelEnv = input.modelEnv?.trim() || undefined;
    if (modelEnv && !isEnvName(modelEnv)) return fail('The variable name may use only letters, digits and _.');
    const modelFlag = input.modelFlag?.trim() || undefined;
    if (modelFlag && !isFlagName(modelFlag)) return fail('The model flag should look like -m or --model.');
    const id = input.id && tools.some((t) => t.id === input.id) ? input.id : reviewToolId(command, tools.map((t) => t.id));
    const tool: ReviewTool = {
      id, kind, command, family,
      model: input.model?.trim() || undefined,
      modelEnv: kind === 'command' && !modelFlag ? modelEnv : undefined,
      modelFlag: kind === 'command' ? modelFlag : undefined,
      promptAs: kind === 'command' && input.promptAs === 'file' ? 'file' : undefined,
      timeoutMinutes: Number(input.timeoutMinutes) >= 1 ? Math.min(120, Math.round(Number(input.timeoutMinutes))) : 20,
      test: input.test
    };
    if (id === NV_REVIEW_TOOL_ID) {
      // nv-review's model has always lived in review.nvModel; keep it there.
      await this.host.config.set('review.nvModel', tool.model ?? '');
    }
    const next = tools.some((t) => t.id === id) ? tools.map((t) => (t.id === id ? tool : t)) : [...tools, tool];
    await this.host.config.set('review.tools', next);
    return { ok: true, tools: this.list() };
  }

  /** Removes one. nv-review stays. Reviews it already wrote stay in History. */
  async remove(id: string): Promise<ReviewTool[]> {
    if (id === NV_REVIEW_TOOL_ID) return this.list();
    await this.host.config.set('review.tools', this.list().filter((t) => t.id !== id));
    if (this.host.config.get<string>('review.runner', NV_REVIEW_TOOL_ID) === id) {
      await this.host.config.set('review.runner', NV_REVIEW_TOOL_ID);
    }
    return this.list();
  }

  /** Agents and commands Kovan already found, minus the ones already added. */
  async candidates(): Promise<ReviewCandidate[]> {
    const added = new Set(this.list().map((t) => t.command));
    const runners = SMOKE
      ? [
          { command: 'claude', invocation: 'executable' }, { command: 'codex', invocation: 'executable' },
          { command: 'claude-personal', invocation: 'shellFunction' }, { command: 'nv-review', invocation: 'shellFunction' },
          { command: 'or-review', invocation: 'shellFunction' }
        ] as Runner[]
      : await this.runners();
    const found: ReviewCandidate[] = runners
      .filter((r) => r.command && r.invocation !== 'loginShell' && r.command !== 'opencode' && !added.has(r.command))
      .map((r) => {
        const family = agentFamily(r.command);
        return { command: r.command, kind: family ? 'agent' : 'command', family, how: r.invocation === 'shellFunction' ? 'shell function' : 'on PATH' };
      });
    // Review scripts the agent list never guessed: anything called *-review
    // on your PATH or defined in your shell, like ~/.local/bin/cf-review.
    const seen = new Set([...added, ...found.map((c) => c.command)]);
    for (const name of SMOKE ? ['cf-review'] : await this.reviewCommandsOnMachine()) {
      if (!seen.has(name)) {
        seen.add(name);
        found.push({ command: name, kind: 'command', how: 'on PATH' });
      }
    }
    return found;
  }

  private async reviewCommandsOnMachine(): Promise<string[]> {
    const looksLikeReview = (name: string) => /(^|[-_])review([-_]|$)/.test(name) && isSafeCommandName(name) && !agentFamily(name);
    const env = await shellEnvironment.environment();
    const dirs = [...new Set((env['PATH'] ?? '').split(':').filter(Boolean))];
    const names = new Set<string>();
    await Promise.all(dirs.map(async (dir) => {
      const entries = await readdir(dir).catch(() => [] as string[]);
      await Promise.all(entries.filter(looksLikeReview).map(async (name) => {
        const info = await stat(path.join(dir, name)).catch(() => undefined);
        if (info?.isFile() && info.mode & 0o111) names.add(name);
      }));
    }));
    for (const name of await shellEnvironment.definedNames().catch(() => [] as string[])) if (looksLikeReview(name)) names.add(name);
    return [...names].sort();
  }

  /**
   * Whether the shell finds `command`, and what its `--help` says — run with
   * no input, in an empty folder, for a few seconds at most. Only when you
   * pick or type a command in the Add form.
   */
  async setup(command: string): Promise<CommandSetup> {
    const found = await this.check(command);
    if (found === 'none') return { found, keys: [] };
    let help = '';
    if (SMOKE) {
      help = 'usage: cf-review [-m MODELS] [prompt_file]\n  cf-review -m @cf/openai/gpt-oss-120b < prompt.txt\nNeeds an API token saved to\n~/.config/cloudflare/key.\n  prompt_file  file holding the prompt, or - for stdin\n  -m MODELS, --model MODELS';
    } else {
      const cwd = await mkdtemp(path.join(tmpdir(), 'kovan-review-help-'));
      const env = await shellEnvironment.environment();
      try {
        help = await new Promise<string>((resolve) => {
          const child = spawn(loginShell(), ['-i', '-c', `${command} "$@"`, command, '--help'], {
            cwd, env, stdio: ['ignore', 'pipe', 'pipe']
          });
          let out = '';
          const add = (chunk: Buffer) => { if (out.length < 20_000) out += chunk.toString('utf8'); };
          child.stdout.on('data', add);
          child.stderr.on('data', add);
          const timer = setTimeout(() => child.kill('SIGTERM'), 8_000);
          child.on('close', () => { clearTimeout(timer); resolve(out); });
          child.on('error', () => { clearTimeout(timer); resolve(out); });
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
    const parsed = /usage|option|--help|stdin|model/i.test(help) ? parseCommandHelp(help) : undefined;
    const keys = await Promise.all((parsed?.keyFiles ?? []).map(async (display) => {
      const file = keyFilePath(display);
      const exists = SMOKE ? false : file ? await access(file, constants.R_OK).then(() => true, () => false) : true;
      return { path: display, exists };
    }));
    return { found, help: parsed, keys: keys.filter((k) => keyFilePath(k.path)) };
  }

  /**
   * Saves a key a command reads, where its help says it reads it — readable
   * by you only. The value is written and never sent back to the window.
   */
  async saveKey(display: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const file = keyFilePath(display);
    const key = value.trim();
    if (!file) return { ok: false, error: 'Kovan only saves key files in a dot-folder in your home, named like a key.' };
    if (!key || /\s/.test(key)) return { ok: false, error: 'Paste the key on its own, with no spaces or line breaks.' };
    if (SMOKE) return { ok: true };
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, key, { encoding: 'utf8', mode: 0o600 });
      await chmod(file, 0o600);
      this.host.log.info(`review key saved to ${display}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Whether your shell can find `command` now — asked fresh, for a function you just wrote. */
  async check(command: string): Promise<CommandKind> {
    if (!isSafeCommandName(command)) return 'none';
    if (SMOKE) return /review|claude|codex/.test(command) ? 'function' : 'none';
    shellEnvironment.invalidate();
    return (await shellEnvironment.describe([command])).get(command) ?? 'none';
  }

  // --- Running ------------------------------------------------------------------------

  /** One review of a real pull request. Returns the reviewer's answer. */
  async review(tool: ReviewTool, pull: QuickPullInput, diff: string, control: ReviewRunControl): Promise<{ answer: string; prompt: string }> {
    if (tool.kind === 'command') {
      const prompt = pullReviewPrompt(pull, diff);
      return { answer: await this.runCommand(tool, prompt, control), prompt };
    }
    const clone = await this.cloneFor(pull.repo);
    if (!clone) {
      throw new Error(`${AGENT_FAMILY_NAME[tool.family!]} reviews in a copy of ${pull.repo}, and none of your watched folders is a clone of it. Add one in Settings › Connections, or pick a command reviewer.`);
    }
    const prompt = pullReviewPrompt(pull, diff, { checkout: true });
    const answer = await this.withWorktree(clone, pull.number, (dir) => this.runAgent(tool, prompt, dir, control));
    return { answer, prompt };
  }

  /**
   * Settings' Test: a made-up pull request with one planted bug, through the
   * same path a real review takes. Each step says whether it passed; the
   * first failure stops the rest.
   */
  async test(tool: ReviewTool): Promise<{ ok: boolean; checks: ReviewTestCheck[] }> {
    const checks: ReviewTestCheck[] = [];
    const done = async () => {
      const ok = checks.every((c) => c.ok);
      const failed = checks.find((c) => !c.ok);
      const saved = this.find(tool.id);
      if (saved) {
        await this.save({ ...saved, test: { ok, at: new Date().toISOString(), failed: failed ? `${failed.label}: ${failed.note ?? ''}`.trim() : undefined } });
      }
      return { ok, checks };
    };

    const kind = await this.check(tool.command);
    checks.push(kind === 'none'
      ? { label: `Found ${tool.command}`, ok: false, note: 'Your shell can\'t find it. Check the name, or open a new terminal so your .zshrc is read.' }
      : { label: `Found ${tool.command}`, ok: true, note: kind === 'function' || kind === 'alias' ? 'shell function' : 'on PATH' });
    if (!checks[0]!.ok) return done();

    if (SMOKE) {
      checks.push({ label: 'It answered', ok: true, note: '12 s' }, { label: 'It found the planted bug', ok: true },
        { label: 'It ended with VERDICT: REQUEST_CHANGES', ok: true });
      if (tool.kind === 'agent') checks.push({ label: 'It changed no files', ok: true });
      return done();
    }

    const pull: QuickPullInput = {
      repo: 'kovan/review-test', number: 1, title: 'Compute the cart total with a loop', author: 'kovan',
      baseRef: 'main', headRef: 'loop-total', body: 'Replaces the reduce with a plain loop.',
      threads: [], comments: [], checks: [], reviewers: [], additions: 5, deletions: 1, changedFiles: 1
    };
    const control: ReviewRunControl = { onChild: () => undefined, cancelled: () => false };
    const started = Date.now();
    let answer = '';
    let repo: string | undefined;
    try {
      if (tool.kind === 'agent') {
        repo = await mkdtemp(path.join(tmpdir(), 'kovan-review-test-'));
        await mkdir(path.join(repo, 'src'), { recursive: true });
        await writeFile(path.join(repo, REVIEW_TEST_FILE), REVIEW_TEST_SOURCE, 'utf8');
        for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Kovan', '-c', 'user.email=kovan@localhost', 'commit', '--quiet', '-m', 'Loop total']]) {
          await git(repo, args);
        }
        answer = await this.runAgent(tool, pullReviewPrompt(pull, REVIEW_TEST_DIFF, { checkout: true }), repo, control);
      } else {
        answer = await this.runCommand(tool, pullReviewPrompt(pull, REVIEW_TEST_DIFF), control);
      }
      checks.push({ label: 'It answered', ok: true, note: `${Math.round((Date.now() - started) / 1000)} s` });
      checks.push({ label: 'It found the planted bug', ok: foundPlantedBug(answer), note: foundPlantedBug(answer) ? undefined : 'The review didn\'t mention `i <= items.length` reading past the end.' });
      const { verdict } = splitVerdict(answer);
      checks.push(verdict === 'request_changes'
        ? { label: 'It ended with VERDICT: REQUEST_CHANGES', ok: true }
        : { label: 'It ended with VERDICT: REQUEST_CHANGES', ok: false, note: verdict === 'approve' ? 'It approved a change with a bug in it.' : 'Its last line wasn\'t a VERDICT line, so Kovan can\'t offer a recommendation.' });
      if (repo) {
        const changed = (await git(repo, ['status', '--porcelain'])).trim();
        checks.push({ label: 'It changed no files', ok: !changed, note: changed ? `Changed: ${changed.split('\n').join(', ')}` : undefined });
      }
    } catch (err) {
      checks.push({ label: 'It answered', ok: false, note: err instanceof Error ? err.message : String(err) });
    } finally {
      if (repo) await rm(repo, { recursive: true, force: true });
    }
    return done();
  }

  /**
   * A command, in an empty folder: the prompt on stdin or as a file, the model
   * behind its flag or in its variable.
   */
  private async runCommand(tool: ReviewTool, prompt: string, control: ReviewRunControl): Promise<string> {
    const env: Record<string, string> = { ...(await shellEnvironment.environment()) };
    if (tool.modelEnv && !tool.modelFlag && tool.model) env[tool.modelEnv] = tool.model;
    const cwd = await mkdtemp(path.join(tmpdir(), 'kovan-review-'));
    try {
      const promptFile = path.join(cwd, 'prompt.md');
      if (tool.promptAs === 'file') await writeFile(promptFile, prompt, 'utf8');
      const args = commandReviewArgs(tool, promptFile);
      const { out } = await this.spawnTool(tool, args, { cwd, env, stdin: tool.promptAs === 'file' ? '' : prompt }, control);
      const answer = stripReviewHeader(out.trim()).trim();
      if (!answer || answer === '(empty response)') throw new Error(`${tool.command} returned nothing.`);
      return answer;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /** An agent, headless and read-only, in `cwd`. */
  private async runAgent(tool: ReviewTool, prompt: string, cwd: string, control: ReviewRunControl): Promise<string> {
    const env: Record<string, string> = { ...(await shellEnvironment.environment()) };
    const scratch = await mkdtemp(path.join(tmpdir(), 'kovan-review-answer-'));
    const answerFile = path.join(scratch, 'answer.md');
    try {
      const { out } = await this.spawnTool(tool, agentReviewArgs(tool.family!, tool.model, answerFile), { cwd, env, stdin: prompt }, control);
      // Codex prints its whole transcript; its final message is in the file.
      const answer = tool.family === 'codex' ? await readFile(answerFile, 'utf8').catch(() => '') : out;
      if (!answer.trim()) throw new Error(`${tool.command} returned nothing.`);
      return answer.trim();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Through an interactive login shell, so a function in `.zshrc` exists. The
   * command is a checked name and the arguments are positional parameters:
   * nothing from settings is ever parsed as shell code.
   */
  private spawnTool(
    tool: ReviewTool, args: string[], options: { cwd: string; env: Record<string, string>; stdin: string }, control: ReviewRunControl
  ): Promise<{ out: string }> {
    if (!isSafeCommandName(tool.command)) return Promise.reject(new Error(`${tool.command} is not a command name Kovan will run.`));
    const timeoutMs = tool.timeoutMinutes * 60_000;
    return new Promise((resolve, reject) => {
      const child = spawn(loginShell(), ['-i', '-c', `${tool.command} "$@"`, tool.command, ...args], {
        cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe']
      });
      control.onChild(child);
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${tool.command} did not answer within ${tool.timeoutMinutes} minutes.`));
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (control.cancelled()) return reject(new Error('Cancelled.'));
        // An interactive zsh prints rc noise to stderr; a tool's own messages
        // are the lines it prefixes with its name, as nv-review does.
        const own = err.split('\n').filter((line) => line.startsWith(`${tool.command}:`)).join('\n');
        if (code !== 0) return reject(new Error(own || err.trim().split('\n').pop() || `${tool.command} exited ${code}`));
        resolve({ out });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdin, 'utf8');
    });
  }

  /**
   * A detached worktree of `clone` at pull request `number`'s head, removed
   * afterwards whatever happens. Your clone's own checkout is never touched;
   * the fetch only updates FETCH_HEAD.
   */
  private async withWorktree<T>(clone: string, number: number, fn: (dir: string) => Promise<T>): Promise<T> {
    const parent = await mkdtemp(path.join(tmpdir(), 'kovan-review-wt-'));
    const dir = path.join(parent, 'pr');
    try {
      await git(clone, ['fetch', '--quiet', '--no-tags', 'origin', `pull/${number}/head`]).catch((err: Error) => {
        throw new Error(`Couldn't fetch pull request #${number} into ${clone}: ${err.message}`);
      });
      const sha = (await git(clone, ['rev-parse', 'FETCH_HEAD'])).trim();
      await git(clone, ['worktree', 'add', '--detach', '--quiet', dir, sha]);
      return await fn(dir);
    } finally {
      await git(clone, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
      await git(clone, ['worktree', 'prune']).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    void shellEnvironment.environment().then((env) => {
      execFile('git', ['-C', cwd, ...args], { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr).trim().split('\n').pop() || err.message));
        else resolve(String(stdout));
      });
    });
  });
}
