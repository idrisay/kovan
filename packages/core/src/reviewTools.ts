/**
 * Reviewers: what the Review button on a pull request can send the PR to,
 * besides an opencode model (item 143).
 *
 * Two kinds, one contract. Both get `pullReviewPrompt()` and must print a
 * markdown review whose last line may carry the verdict:
 * - a **command** — your own shell function or script, like `nv-review`. The
 *   prompt goes in on stdin; the model, if any, in an environment variable
 *   you name (nv-review's is `NV_MODEL`).
 * - an **agent** — Claude Code or Codex, run headless and read-only inside a
 *   throwaway worktree at the PR's head, so it can open whole files and not
 *   just the diff.
 *
 * Pure: the desktop app's `main/reviewTools.ts` runs them.
 */

import { reviewModelName } from './quick';

export type ReviewToolKind = 'agent' | 'command';

/** Agent CLIs Kovan knows how to run headless and read-only. */
export type AgentFamily = 'claude' | 'codex';

export interface ReviewTool {
  /** Unique, and part of the stored model string: `sonnet (claude)`. */
  id: string;
  kind: ReviewToolKind;
  /** What is run: `claude`, `claude-personal`, `codex`, `nv-review`, `gemini-review`. */
  command: string;
  /** Agents only: which CLI's flags to use. */
  family?: AgentFamily;
  model?: string;
  /** Commands only: the environment variable the model goes in. */
  modelEnv?: string;
  /** Commands only: the flag the model goes behind (`-m`, `--model`), instead of a variable. */
  modelFlag?: string;
  /** Commands only: the prompt on stdin (the default), or as a file path argument. */
  promptAs?: 'stdin' | 'file';
  timeoutMinutes: number;
  /** The last Test: whether it passed, when, and what failed. */
  test?: { ok: boolean; at: string; failed?: string };
}

export const NV_REVIEW_TOOL_ID = 'nv-review';
export const REVIEW_TOOL_DEFAULT_MINUTES = 20;

/** `nv-review`, as it always worked: a shell function, its model in `NV_MODEL`. */
export const NV_REVIEW_TOOL: ReviewTool = {
  id: NV_REVIEW_TOOL_ID,
  kind: 'command',
  command: 'nv-review',
  modelEnv: 'NV_MODEL',
  timeoutMinutes: REVIEW_TOOL_DEFAULT_MINUTES
};

export const AGENT_FAMILY_NAME: Record<AgentFamily, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Model suggestions per agent; any other can be typed. */
export const AGENT_FAMILY_MODELS: Record<AgentFamily, string[]> = { claude: ['sonnet', 'opus'], codex: [] };

/** `claude`, `claude-personal` → claude; `codex` → codex; anything else isn't an agent Kovan can drive. */
export function agentFamily(command: string): AgentFamily | undefined {
  if (/^claude([-_].*)?$/.test(command)) return 'claude';
  if (/^codex([-_].*)?$/.test(command)) return 'codex';
  return undefined;
}

/** A model-env name that a shell will accept: `NV_MODEL`, `GEMINI_MODEL`. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** A flag, and only a flag: `-m`, `--model`. Never a value that could carry anything else. */
export function isFlagName(flag: string): boolean {
  return /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(flag);
}

/**
 * The settings value, made safe to use: external data that an older app or a
 * hand edit may have broken. `nv-review` is always there, first, and its
 * model stays in `review.nvModel` where it has always been.
 */
export function normaliseReviewTools(stored: unknown, nvModel: string): ReviewTool[] {
  const list = Array.isArray(stored) ? stored : [];
  const tools: ReviewTool[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Partial<ReviewTool>;
    if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(t.id) || seen.has(t.id)) continue;
    if (typeof t.command !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(t.command)) continue;
    const kind: ReviewToolKind = t.kind === 'agent' ? 'agent' : 'command';
    const family = kind === 'agent' ? agentFamily(t.command) : undefined;
    if (kind === 'agent' && !family) continue;
    seen.add(t.id);
    tools.push({
      id: t.id,
      kind,
      command: t.command,
      family,
      model: typeof t.model === 'string' && t.model.trim() ? t.model.trim() : undefined,
      modelEnv: kind === 'command' && typeof t.modelEnv === 'string' && isEnvName(t.modelEnv) ? t.modelEnv : undefined,
      modelFlag: kind === 'command' && typeof t.modelFlag === 'string' && isFlagName(t.modelFlag) ? t.modelFlag : undefined,
      promptAs: kind === 'command' && t.promptAs === 'file' ? 'file' : undefined,
      timeoutMinutes: Number(t.timeoutMinutes) >= 1 ? Math.min(120, Math.round(Number(t.timeoutMinutes))) : REVIEW_TOOL_DEFAULT_MINUTES,
      test: t.test && typeof t.test.ok === 'boolean' && typeof t.test.at === 'string' ? t.test : undefined
    });
  }
  const nv = tools.find((t) => t.id === NV_REVIEW_TOOL_ID);
  const nvTool: ReviewTool = { ...NV_REVIEW_TOOL, ...nv, kind: 'command', command: 'nv-review', modelEnv: 'NV_MODEL', model: nvModel || undefined };
  return [nvTool, ...tools.filter((t) => t.id !== NV_REVIEW_TOOL_ID)];
}

/** A new tool's id: the command, made unique (`claude`, `claude-2`). */
export function reviewToolId(command: string, taken: readonly string[]): string {
  const base = command.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'reviewer';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

// --- The stored model string -------------------------------------------------------

/**
 * The Review button stores one string. An opencode model is `provider/model`;
 * a reviewer is `<model> (<tool id>)`, or `(<tool id>)` with no model. The
 * format nv-review always used — `moonshotai/kimi-k3 (nv-review)` — is this
 * one, so a saved choice and saved reviews keep working.
 */
export function reviewToolModel(id: string, model?: string): string {
  return model ? `${model} (${id})` : `(${id})`;
}

export function parseReviewToolModel(value: string): { id: string; model?: string } | undefined {
  const match = /^(.*?)\s*\(([a-z0-9][a-z0-9._-]*)\)$/.exec(value.trim());
  if (!match) return undefined;
  return { id: match[2]!, model: match[1]!.trim() || undefined };
}

/**
 * The name a review goes by: on the button's tag, the card, the GitHub post
 * and the saved file. nv-review's keeps the model's own name (`Kimi K3`);
 * any other reviewer is its id and the model: `claude · sonnet`.
 */
export function reviewToolLabel(value: string): string {
  const parsed = parseReviewToolModel(value);
  if (!parsed) return reviewModelName(value);
  if (parsed.id === NV_REVIEW_TOOL_ID) return reviewModelName(value);
  return parsed.model ? `${parsed.id} · ${parsed.model}` : parsed.id;
}

/** What the post and card say the review went through: `nv-review`, `claude`, `opencode`. */
export function reviewToolVia(value: string): string {
  return parseReviewToolModel(value)?.id ?? 'opencode';
}

/** `Kimi K3` → `kimi-k3-review.md`; `claude · sonnet` → `claude-sonnet-review.md`. */
export function reviewFileName(value: string): string {
  const slug = reviewToolLabel(value).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'model'}-review.md`;
}

// --- Running an agent ---------------------------------------------------------------

/** Tools Claude Code may use as a reviewer: reading and searching, nothing else. */
export const CLAUDE_REVIEW_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * The arguments after the agent's command; the prompt goes on stdin.
 *
 * Claude Code: `--print`, and `dontAsk`, which refuses every tool not on the
 * allowed list instead of asking — there is nobody to ask. Codex: `exec` in
 * its `read-only` sandbox, final message written to `lastMessageFile`
 * because its stdout carries the whole transcript.
 */
export function agentReviewArgs(family: AgentFamily, model: string | undefined, lastMessageFile: string): string[] {
  if (family === 'claude') {
    return [
      '--print', '--output-format', 'text', '--permission-mode', 'dontAsk',
      ...(model ? ['--model', model] : []),
      '--allowedTools', ...CLAUDE_REVIEW_TOOLS
    ];
  }
  return [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
    '--output-last-message', lastMessageFile,
    ...(model ? ['--model', model] : []),
    '-'
  ];
}

/**
 * A command's arguments: the model behind its flag when it takes one that
 * way, then the prompt file when it wants a path rather than stdin.
 */
export function commandReviewArgs(tool: Pick<ReviewTool, 'model' | 'modelFlag' | 'promptAs'>, promptFile: string): string[] {
  return [
    ...(tool.modelFlag && tool.model ? [tool.modelFlag, tool.model] : []),
    ...(tool.promptAs === 'file' ? [promptFile] : [])
  ];
}

/** The line a form shows, so nothing about how a reviewer runs is hidden. */
export function reviewToolCommandLine(
  tool: Pick<ReviewTool, 'kind' | 'command' | 'family' | 'model' | 'modelEnv' | 'modelFlag' | 'promptAs'>
): string {
  if (tool.kind === 'agent' && tool.family) {
    const args = agentReviewArgs(tool.family, tool.model, '<answer file>').map((a) => (a.includes(' ') ? `'${a}'` : a));
    return `${tool.command} ${args.join(' ')} < prompt`;
  }
  const env = tool.modelEnv && !tool.modelFlag && tool.model ? `${tool.modelEnv}=${tool.model} ` : '';
  const args = commandReviewArgs(tool, 'prompt.md');
  return `${env}${[tool.command, ...args].join(' ')}${tool.promptAs === 'file' ? '' : ' < prompt'}`;
}

/** What a command's `--help` says about how to call it, for the Add form to fill in. */
export interface CommandHelp {
  modelFlag?: string;
  modelEnv?: string;
  promptAs?: 'stdin' | 'file';
  /** Models its examples pass: `@cf/openai/gpt-oss-120b`. */
  models: string[];
  /** Key or token files it says it reads: `~/.config/cloudflare/key`. */
  keyFiles: string[];
}

/**
 * Reads a review command's `--help`. A guess, shown as one and editable: it
 * only fills in the form. Prefers a model flag over a variable, since a flag
 * named in the usage line is how the command is meant to be called.
 */
export function parseCommandHelp(help: string): CommandHelp {
  const text = help.slice(0, 20_000);
  let modelFlag: string | undefined;
  if (/(^|[\s\[,(])--model\b/m.test(text)) modelFlag = '--model';
  else if (/(^|[\s\[,(])-m\b[^\n]*model/im.test(text)) modelFlag = '-m';
  const modelEnv = /\b([A-Z][A-Z0-9]*_MODEL(?:_ID)?)\b/.exec(text)?.[1];
  const promptAs: CommandHelp['promptAs'] = /\bstdin\b|<\s*prompt/i.test(text)
    ? 'stdin'
    : /\bprompt[_-]?file\b|\bprompt\.(txt|md)\b/i.test(text) ? 'file' : undefined;
  const models = [...new Set(
    [...text.matchAll(/(?:^|\s)(?:-m|--model)[ =]([^\s<>|'"]+)/gm)]
      .map((m) => m[1]!.replace(/[,;.]+$/, ''))
      .filter((m) => m && !/^[A-Z_]+$/.test(m) && !m.startsWith('-'))
  )];
  const keyFiles = [...new Set(
    [...text.matchAll(/(~\/[\w.\/-]+)/g)]
      .map((m) => m[1]!.replace(/[.,;:]+$/, ''))
      .filter((p) => !p.endsWith('/') && /(^|[\/._-])(key|token|secret|credentials?|api[_-]?key)([._-]|$)/i.test(p.split('/').pop() ?? ''))
  )];
  return { modelFlag, modelEnv: modelFlag ? undefined : modelEnv, promptAs, models, keyFiles };
}

/**
 * A review without the one line some scripts print first to say which model
 * answered (`--- @cf/zai-org/glm-4.7-flash`). A rule (`---` alone) stays.
 */
export function stripReviewHeader(text: string): string {
  return text.replace(/^---[ \t]+\S[^\n]*\n+/, '');
}

// --- Test ---------------------------------------------------------------------------

/** The file in the test pull request, after the change. */
export const REVIEW_TEST_FILE = 'src/cart.ts';
export const REVIEW_TEST_SOURCE = [
  'export interface Item { name: string; price: number }',
  '',
  'export function cartTotal(items: Item[]): number {',
  '  let sum = 0;',
  '  for (let i = 0; i <= items.length; i++) {',
  '    sum += items[i].price;',
  '  }',
  '  return sum;',
  '}',
  ''
].join('\n');

/** The made-up pull request Test sends: one change, one obvious bug (`<=` reads past the end). */
export const REVIEW_TEST_DIFF = [
  `diff --git a/${REVIEW_TEST_FILE} b/${REVIEW_TEST_FILE}`,
  `--- a/${REVIEW_TEST_FILE}`,
  `+++ b/${REVIEW_TEST_FILE}`,
  '@@ -1,5 +1,9 @@',
  ' export interface Item { name: string; price: number }',
  ' ',
  ' export function cartTotal(items: Item[]): number {',
  '-  return items.reduce((sum, item) => sum + item.price, 0);',
  '+  let sum = 0;',
  '+  for (let i = 0; i <= items.length; i++) {',
  '+    sum += items[i].price;',
  '+  }',
  '+  return sum;',
  ' }',
  ''
].join('\n');

/** Whether a review noticed the planted bug, by any of the ways people say it. */
export function foundPlantedBug(review: string): boolean {
  return /<=\s*items\.length|off[- ]by[- ]one|out[- ]of[- ](bounds|range)|past the end|items\[items\.length\]|undefined\.price|reading 'price'/i.test(review);
}
