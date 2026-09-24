/**
 * "Check prices online" in Settings → Token prices: a model with web search
 * looks up today's list prices for the rows already in the table, and the
 * answer comes back as proposals the user ticks — never written straight in.
 *
 * The prompt and the parsing live here, apart from the process that runs
 * them, so both are testable without a network or an agent installed.
 */

import type { Price, PriceRule } from './usage';

/** Who does the looking. Each is a CLI that can search the web headless. */
export type PriceCheckRunner = 'claude' | 'codex' | 'opencode';

export const PRICE_CHECK_RUNNERS: { id: PriceCheckRunner; label: string; defaultModel: string }[] = [
  { id: 'claude', label: 'Claude Code', defaultModel: 'sonnet' },
  { id: 'codex', label: 'Codex', defaultModel: '' },
  { id: 'opencode', label: 'opencode', defaultModel: '' }
];

export interface PriceProposal extends PriceRule {
  /** Where the model read it, when it said. */
  source?: string;
  /** No row in the table has this `match` yet. */
  added: boolean;
}

const FIELDS: (keyof Price)[] = ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'];

export function priceCheckPrompt(rules: readonly PriceRule[]): string {
  const rows = rules.map((r) => `- "${r.match}"`).join('\n');
  return [
    'Look up the current official API list prices, in USD per million tokens, for the model families below.',
    'Use web search and read the providers\' own pricing pages (anthropic.com, openai.com, and so on) — not blogs.',
    '',
    'Each entry is text matched as a substring of a model name, so "opus" means the current Opus model and',
    '"opus-4-1" means Opus 4.1 specifically. Keep each "match" exactly as written.',
    rows,
    '',
    'If a provider has a current model none of these would match, you may add a row for it with a short, specific "match".',
    'Leave out any entry you cannot find an official price for. A "free" entry is always 0 everywhere.',
    '',
    'Fields: input, output, cacheWrite (5-minute cache write), cacheWrite1h (1-hour cache write), cacheRead.',
    'Use 0 for a price the provider does not have (for example OpenAI has no cache write price).',
    '',
    'Answer with only this JSON and nothing after it:',
    '{"prices":[{"match":"sonnet","input":3,"output":15,"cacheWrite":3.75,"cacheWrite1h":6,"cacheRead":0.3,"source":"https://…"}]}'
  ].join('\n');
}

/**
 * The last `{"prices": …}` object in whatever the model printed, checked field
 * by field. Anything malformed is dropped rather than guessed at; a reply with
 * nothing usable is an error, not an empty success.
 */
export function parsePriceCheck(
  text: string,
  current: readonly PriceRule[]
): { proposals: PriceProposal[] } | { error: string } {
  const start = text.lastIndexOf('{"prices"');
  const from = start >= 0 ? start : text.search(/\{\s*"prices"/);
  if (from < 0) return { error: 'The model did not answer with a price list.' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(balanced(text.slice(from)));
  } catch {
    return { error: 'The model\'s price list was not valid JSON.' };
  }

  const list = (parsed as { prices?: unknown }).prices;
  if (!Array.isArray(list)) return { error: 'The model did not answer with a price list.' };

  const known = new Set(current.map((r) => r.match.toLowerCase()));
  const seen = new Set<string>();
  const proposals: PriceProposal[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const match = typeof row['match'] === 'string' ? row['match'].trim() : '';
    if (!match || seen.has(match.toLowerCase())) continue;
    const values = FIELDS.map((f) => row[f]);
    if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 10_000)) continue;
    seen.add(match.toLowerCase());
    const price = Object.fromEntries(FIELDS.map((f, i) => [f, values[i]])) as unknown as Price;
    const source = typeof row['source'] === 'string' && /^https?:\/\//.test(row['source']) ? row['source'] : undefined;
    proposals.push({ match, ...price, source, added: !known.has(match.toLowerCase()) });
  }
  return proposals.length > 0 ? { proposals } : { error: 'The model found no prices it could vouch for.' };
}

/** Applies ticked proposals: an existing row is updated in place, a new one goes above the general rows it would otherwise lose to. */
export function applyPriceProposals(current: readonly PriceRule[], picked: readonly PriceProposal[]): PriceRule[] {
  const next = current.map((r) => ({ ...r }));
  const added: PriceRule[] = [];
  for (const p of picked) {
    const { source, added: isNew, ...rule } = p;
    void source;
    void isNew;
    const at = next.findIndex((r) => r.match.toLowerCase() === rule.match.toLowerCase());
    if (at >= 0) next[at] = { ...next[at], ...rule, match: next[at]!.match };
    else added.push(rule);
  }
  // A new specific row ("opus-5") must sit above the general one ("opus") it
  // contains, or the first-match rule would never reach it.
  for (const rule of added) {
    const general = next.findIndex((r) => r.match && rule.match.toLowerCase().includes(r.match.toLowerCase()));
    if (general >= 0) next.splice(general, 0, rule);
    else next.push(rule);
  }
  return next;
}

/** The first complete JSON object at the start of `text`, braces balanced outside strings. */
export function balanced(text: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  return text;
}
