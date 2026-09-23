/**
 * A coding agent the app can hand work to. Ported from `DevHubKit/Runner.swift`.
 *
 * ## The security rule, which survives every case below
 *
 * The prompt is **never** interpolated into a shell line. Prompts are built
 * from pull request titles, review comments and ticket descriptions — text
 * other people wrote — and the process receiving them has a shell and the
 * user's credentials. A backtick in a PR title must stay a backtick.
 *
 * Two mechanisms enforce that:
 *   - `resolve()` passes the prompt as a single argv element, `shell: false`.
 *   - `shellLine()` writes the prompt to a file and references it as
 *     `"$(< path)"`, which a shell substitutes once and does not re-parse.
 *
 * ## Why there is more than one way to start one
 *
 * `which` finds executables. It does not find shell functions or aliases,
 * because those do not exist outside an interactive shell — they are lines in
 * a `.zshrc`. On a real machine roughly half the agents somebody uses are
 * invisible to PATH alone, so `Invocation` makes that distinction explicit.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isSafeCommandName, loginShell, shellEnvironment, type CommandKind } from './shell';

export type Invocation =
  /** On the resolved PATH. Spawned directly — no shell between us and it. */
  | 'executable'
  /** A shell function or alias; exists only where its rc file has been read. */
  | 'shellFunction'
  /** The login shell itself. A plain terminal. */
  | 'loginShell';

export interface Runner {
  id: string;
  name: string;
  /** The executable to look for, or the function to call. */
  command: string;
  /** Arguments before the prompt. */
  leadingArgs: string[];
  /** Whether this runner takes a prompt at all. */
  acceptsPrompt: boolean;
  /**
   * Whether the prompt is handed over as a *file path* rather than as text.
   *
   * Not every wrapper takes a prompt on the command line: `or-review
   * prompt.txt` and `cc-review orca <file>` both want a path, and handing
   * either 500 characters of English gets "no such file". It is also the only
   * way to send a prompt longer than ARG_MAX.
   */
  promptFile: boolean;
  /**
   * The flag the prompt goes behind, for agents that do not take a bare
   * positional.
   *
   * Not cosmetic, and `leadingArgs` cannot express it: `opencode [project]`
   * treats its bare positional as a *directory*, so a prompt there produces
   * ENAMETOOLONG. It is separate from `leadingArgs` because it is only correct
   * when there *is* a prompt — otherwise the argv ends in a dangling flag.
   */
  promptFlag?: string;
  model?: string;
  /**
   * The flag the model goes behind, or undefined for an agent that takes none.
   *
   * Undefined is not merely "unknown": a wrapper whose whole purpose is to pin
   * a model must not be handed `--model`.
   */
  modelFlag?: string;
  /** How to ask the agent which models it has, when it can answer at all. */
  modelsArgs?: string[];
  invocation: Invocation;
}

function make(partial: Partial<Runner> & Pick<Runner, 'id' | 'name' | 'command'>): Runner {
  return {
    leadingArgs: [],
    acceptsPrompt: true,
    promptFile: false,
    invocation: 'executable',
    ...partial
  };
}

export const BUILT_IN: Runner[] = [
  make({ id: 'claude', name: 'Claude Code', command: 'claude', modelFlag: '--model' }),
  make({ id: 'codex', name: 'Codex', command: 'codex', modelFlag: '--model' }),
  make({
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    promptFlag: '--prompt',
    modelFlag: '--model',
    modelsArgs: ['models']
  }),
  make({
    id: 'shell',
    name: 'Shell',
    command: '',
    acceptsPrompt: false,
    invocation: 'loginShell'
  })
];

/**
 * Model names a runner is known to accept via its own `modelFlag` — a
 * starting list, not a live query. `modelsArgs` exists for a runner that can
 * actually be asked (OpenCode's own `models` subcommand); neither Claude Code
 * nor Codex offers one, so this is what stands in for it. A runner not listed
 * here still takes a model — the run sheet's own field for it is free text —
 * this only supplies the suggestions. Haiku left off on purpose: it used to
 * be this app's own silent default for review/verify runs, which is exactly
 * the kind of choice a suggestion chip invites back in one click.
 */
export const KNOWN_MODELS: Record<string, string[]> = {
  claude: ['opus', 'sonnet']
};

/**
 * Agent commands worth looking for. Nothing here is required; it is a starting
 * list so the common case is one click rather than seven forms.
 */
export const KNOWN_AGENT_COMMANDS = [
  'claude', 'claude-admin', 'claude-personal', 'claude-work',
  'codex', 'opencode', 'openrouter', 'nv-review',
  'cc-orca', 'cc-token', 'cc-review', 'or-review',
  'aider', 'gemini', 'amp', 'goose', 'cursor-agent', 'crush', 'droid'
];

/**
 * What a wrapper is called when nobody thought of it in advance.
 *
 * The list above only finds agents somebody guessed. Real machines have things
 * like `claude-glm51` that no list would contain, so the shell is also asked
 * what it defines and these decide what is worth offering. A false positive
 * costs one line in a picker; a false negative means the app cannot see an
 * agent you use every day.
 */
const AGENT_NAME_PATTERNS = [
  'claude', 'codex', 'opencode', 'openrouter', 'gemini', 'aider',
  'goose', 'crush', 'droid', 'cursor-agent', 'copilot', 'llm', 'gpt', 'review'
];
const AGENT_NAME_PREFIXES = ['cc-', 'or-', 'nv-', 'ai-'];

/**
 * Wrappers measured to want a prompt *file*. A small table of facts, not a
 * guess: a reviewer that fails the first time it is used is worse than one
 * that was never offered.
 */
const PROMPT_FILE_COMMANDS = new Set(['or-review', 'cc-review']);

export function looksLikeAgent(name: string): boolean {
  // A leading underscore means a shell internal, by a convention zsh follows
  // everywhere — completion functions, the syntax highlighter's machinery.
  // Matching on bare substrings without this drags in a dozen of them.
  if (name.startsWith('_')) {
    return false;
  }
  const lower = name.toLowerCase();
  return (
    AGENT_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    AGENT_NAME_PATTERNS.some((pattern) => lower.includes(pattern))
  );
}

/** Any string as exactly one shell word. */
export function quote(word: string): string {
  // Single quotes: a shell interprets nothing at all inside them, which leaves
  // the quote character itself as the only case to handle and makes this total
  // rather than a blocklist somebody has to keep extending.
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The prompt on disk, for runners that read one from a file.
 *
 * 0700 directory, 0600 file: the prompt is not secret, but it is about to be
 * read by a process holding the user's credentials and nobody else on the
 * machine needs to see it. Not deleted afterwards — the wrapper opens it some
 * time after we return, and the OS clears the temporary directory anyway.
 */
export async function writePrompt(prompt: string): Promise<string> {
  const dir = path.join(tmpdir(), 'baton-prompts');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `prompt-${randomUUID()}.md`);
  await writeFile(file, prompt, { mode: 0o600 });
  return file;
}

export function modelArgs(runner: Runner): string[] {
  if (!runner.model || !runner.modelFlag) {
    return [];
  }
  return [runner.modelFlag, runner.model];
}

async function promptArgsFor(runner: Runner, prompt: string | undefined): Promise<string[]> {
  if (!runner.acceptsPrompt || !prompt) {
    return [];
  }
  const args = runner.promptFile ? [await writePrompt(prompt)] : [prompt];
  // Immediately before the prompt, and only when there is one.
  if (runner.promptFlag) {
    args.unshift(runner.promptFlag);
  }
  return args;
}

export interface Resolved {
  executable: string;
  args: string[];
}

/**
 * Resolves to an absolute executable and its argv, for a direct spawn.
 *
 * This is not what a terminal session runs — that is `shellLine`, which puts
 * the agent inside a shell so the session outlives it. This is kept because it
 * is the definition the safety tests are written against.
 *
 * `undefined` means the runner could not be found, which is the single most
 * likely setup failure and deserves a real message rather than a terminal that
 * opens and immediately dies.
 */
export async function resolve(
  runner: Runner,
  prompt?: string
): Promise<Resolved | undefined> {
  const promptArgs = await promptArgsFor(runner, prompt);

  switch (runner.invocation) {
    case 'loginShell': {
      // A named shell when there is one, the user's own when there is not.
      // `-l` either way: a terminal that does not read your profile is not the
      // terminal you have everywhere else.
      const shell = runner.command || loginShell();
      try {
        await access(shell, constants.X_OK);
      } catch {
        return undefined;
      }
      return { executable: shell, args: ['-l'] };
    }

    case 'executable': {
      if (!runner.command) return undefined;
      const executable = await shellEnvironment.which(runner.command);
      if (!executable) return undefined;
      return {
        executable,
        args: [...modelArgs(runner), ...runner.leadingArgs, ...promptArgs]
      };
    }

    case 'shellFunction': {
      // The only way to reach a function or alias is a shell that has read the
      // file defining it, so this one is interactive — the opposite of the
      // environment probe, where rc output would be noise. Here it is the point.
      if (!isSafeCommandName(runner.command)) return undefined;
      // `zsh -ic 'name "$@"' baton ARGS…` — the prompt arrives as a positional
      // parameter and never passes through the parser. The only thing
      // interpolated is the runner's own name, checked above.
      const script = `${runner.command} "$@"`;
      return {
        executable: loginShell(),
        args: ['-i', '-c', script, 'baton', ...modelArgs(runner), ...runner.leadingArgs, ...promptArgs]
      };
    }
  }
}

/**
 * The same run, written as one line to type into an interactive shell.
 *
 * The terminal starts your login shell and hands it this rather than spawning
 * the agent directly. What that buys is a session that outlives the agent: the
 * scrollback stays, the directory stays, and when the agent exits you are
 * standing in a shell instead of looking at a dead screen.
 *
 * **The security rule survives intact.** Every word here is something the app
 * made or checked — an absolute path it resolved, a command name it validated,
 * or an argument from settings put through `quote`. The prompt is never one of
 * those words: it goes to a file and arrives via `"$(< path)"`.
 */
export async function shellLine(
  runner: Runner,
  prompt?: string
): Promise<string | undefined> {
  const words: string[] = [];

  switch (runner.invocation) {
    case 'loginShell':
      // It *is* the shell. Nothing to type into it.
      return undefined;
    case 'executable': {
      if (!runner.command) return undefined;
      const executable = await shellEnvironment.which(runner.command);
      if (executable) {
        // The absolute path rather than the bare name, so this runs the same
        // program the direct spawn would and a same-named shell function cannot
        // quietly take its place.
        words.push(quote(executable));
        break;
      }
      // The environment probe can miss a PATH entry the interactive shell
      // has; the session types into that same interactive shell, so if it
      // knows the command, the checked bare name reaches it.
      if (!isSafeCommandName(runner.command)) return undefined;
      const kind = (await shellEnvironment.describe([runner.command])).get(runner.command);
      if (!kind || kind === 'none') return undefined;
      words.push(runner.command);
      break;
    }
    case 'shellFunction':
      if (!isSafeCommandName(runner.command)) return undefined;
      // A function only exists inside a shell, which is where this is going.
      words.push(runner.command);
      break;
  }

  // The model before the user's own arguments, so anything they added
  // deliberately has the last word.
  words.push(...modelArgs(runner).map(quote));
  words.push(...runner.leadingArgs.map(quote));

  if (runner.acceptsPrompt && prompt) {
    const file = await writePrompt(prompt);
    if (runner.promptFlag) {
      words.push(quote(runner.promptFlag));
    }
    words.push(runner.promptFile ? quote(file) : `"$(< ${quote(file)})"`);
  }

  return words.join(' ');
}

/**
 * Every runner that can actually be started, in the order to offer them.
 *
 * Discovered agents are included without being added in settings first. Making
 * somebody open a settings pane to tell the app about a wrapper the app can
 * already see is asking them to do the app's job.
 */
export async function available(custom: Runner[] = []): Promise<Runner[]> {
  const shell = BUILT_IN.find((r) => r.id === 'shell')!;
  // Custom runners come from settings, which is external data: a value written
  // by an older app or edited by hand must not be able to take the whole
  // roster down. Anything without a usable command is dropped, not repaired.
  const usableCustom = (Array.isArray(custom) ? custom : []).filter(
    (r): r is Runner => Boolean(r) && typeof r.command === 'string' && typeof r.id === 'string'
  );
  const configured = [...BUILT_IN.filter((r) => r.id !== 'shell'), ...usableCustom];

  const seen = new Set(configured.map((r) => r.command));
  const candidates = [...configured];

  for (const runner of await discover()) {
    if (!seen.has(runner.command)) {
      seen.add(runner.command);
      candidates.push(runner);
    }
  }

  const names = candidates.filter((r) => r.invocation !== 'loginShell').map((r) => r.command);
  const known = await shellEnvironment.describe(names);

  const usable = candidates.filter((runner) => {
    if (runner.invocation === 'loginShell') return true;
    const kind = known.get(runner.command);
    return kind !== undefined && kind !== 'none';
  });

  // The plain shell last: it is the fallback, not a suggestion.
  return [...usable, shell];
}

/** Agents on this machine that nobody configured. */
export async function discover(): Promise<Runner[]> {
  const defined = await shellEnvironment.definedNames();
  const fromShell = defined.filter(looksLikeAgent);
  const names = [...new Set([...KNOWN_AGENT_COMMANDS, ...fromShell])];

  const kinds = await shellEnvironment.describe(names);
  const found: Runner[] = [];

  for (const name of names) {
    const kind = kinds.get(name);
    if (!kind || kind === 'none' || kind === 'builtin') continue;
    found.push(
      make({
        id: name,
        name,
        command: name,
        promptFile: PROMPT_FILE_COMMANDS.has(name),
        invocation: invocationFor(kind)
      })
    );
  }
  return found;
}

function invocationFor(kind: CommandKind): Invocation {
  return kind === 'function' || kind === 'alias' ? 'shellFunction' : 'executable';
}

/**
 * The shells on this machine, as runners.
 *
 * From `/etc/shells`, which is the list the system keeps and `chsh` validates
 * against, rather than a hardcoded guess that would miss a Homebrew shell and
 * offer ones that are not installed.
 */
export async function shells(): Promise<Runner[]> {
  let listed: string[] = [];
  try {
    listed = (await readFile('/etc/shells', 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/'));
  } catch {
    // Fall through to the login shell alone.
  }

  const seen = new Set<string>();
  const found: Runner[] = [];
  const mine = loginShell();

  for (const shellPath of [mine, ...listed]) {
    if (seen.has(shellPath)) continue;
    try {
      await access(shellPath, constants.X_OK);
    } catch {
      continue;
    }
    seen.add(shellPath);
    const name = shellPath.split('/').pop() ?? shellPath;
    found.push(
      make({
        id: `shell:${shellPath}`,
        // Two shells with the same name — /bin/zsh and a Homebrew one — have
        // to be told apart in a menu.
        name: shellPath === mine ? `${name} (default)` : name,
        command: shellPath,
        acceptsPrompt: false,
        invocation: 'loginShell'
      })
    );
  }
  return found;
}
