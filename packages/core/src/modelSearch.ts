/**
 * The run sheet's ↻ next to Model: what models an agent can be started with
 * today. Found by asking the agent's own CLI where it can list them
 * (`opencode models`), otherwise by a web search of the vendor's docs.
 *
 * Results only add options to the dropdown, tagged "new"; nothing is run and
 * no choice is changed on the user's behalf.
 */

/** Which CLI a runner is, by its command — `claude-admin` is still Claude Code. */
export type ModelFamily = 'claude' | 'codex' | 'opencode';

export function modelFamily(command: string): ModelFamily | undefined {
  const name = command.toLowerCase();
  if (name.includes('claude')) return 'claude';
  if (name.includes('codex')) return 'codex';
  if (name.includes('opencode')) return 'opencode';
  return undefined;
}

import { balanced } from './priceCheck';

const VENDOR: Record<Exclude<ModelFamily, 'opencode'>, { cli: string; docs: string; example: string }> = {
  claude: { cli: 'Claude Code (`claude --model`)', docs: 'docs.anthropic.com / docs.claude.com', example: '"opus", "sonnet", "claude-opus-5-5"' },
  codex: { cli: 'OpenAI Codex CLI (`codex --model`)', docs: 'platform.openai.com and the Codex docs', example: '"gpt-5", "gpt-5-codex"' }
};

export function modelSearchPrompt(family: Exclude<ModelFamily, 'opencode'>): string {
  const v = VENDOR[family];
  return [
    `List the model names that ${v.cli} accepts today for its --model flag.`,
    `Use web search and the vendor's own documentation (${v.docs}), not blogs.`,
    `Include the short aliases as well as the full current model IDs, for example ${v.example}.`,
    'Leave out retired or deprecated models.',
    '',
    'Answer with only this JSON and nothing after it:',
    '{"models":["…"]}'
  ].join('\n');
}

/**
 * The last `{"models": […]}` in the reply, names checked; an empty or unusable
 * reply is an error. The object is read with strings respected: cutting at
 * the first `]` broke on Claude Code's own `opus[1m]` alias, whose bracket
 * sits inside a name.
 */
export function parseModelSearch(text: string): { models: string[] } | { error: string } {
  const at = text.lastIndexOf('{"models"');
  const from = at >= 0 ? at : text.search(/\{\s*"models"/);
  if (from < 0) return { error: 'The search did not answer with a model list.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(balanced(text.slice(from)));
  } catch {
    return { error: 'The model list was not valid JSON.' };
  }
  const list = (parsed as { models?: unknown }).models;
  const models = Array.isArray(list)
    ? [...new Set(list.filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(isModelName))]
    : [];
  return models.length > 0 ? { models } : { error: 'The search found no model names.' };
}

/**
 * The shape a model name takes on a command line — it ends up as one argv
 * word (quoted, where it goes through a shell). Brackets for Claude Code's
 * context-size aliases, `opus[1m]`.
 */
export function isModelName(name: string): boolean {
  return /^[\w.:@/[\]-]{1,80}$/.test(name);
}

/** `opencode models` output: one `provider/model` per line, anything else is chatter. */
export function parseOpencodeModels(stdout: string): string[] {
  return [...new Set(stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l) && isModelName(l)))];
}
