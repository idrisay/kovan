/**
 * Token usage and what it would cost — per session, per ticket, per pull
 * request.
 *
 * Nothing here estimates. The numbers are read out of the agents' own logs
 * (Claude Code's transcripts, Codex's session logs, opencode's step events),
 * and this file only knows how to read those formats and put a price on the
 * result. Finding the logs is main's job (`main/usage.ts`).
 *
 * "Cost" is always the API-equivalent: a Claude or ChatGPT subscription is not
 * billed per token, so the UI must never present it as a bill.
 */

/** Tokens of one model. `input` never includes cache reads or writes. */
export interface TokenCounts {
  input: number;
  output: number;
  /** Prompt-cache writes at the 5-minute rate. */
  cacheWrite: number;
  /** Prompt-cache writes at the 1-hour rate. */
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelUsage extends TokenCounts {
  model: string;
}

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface PriceRule extends Price {
  /** Matched case-insensitively as a substring of the model name; first rule wins. */
  match: string;
}

/**
 * List prices as of this writing, USD per million tokens. A starting point,
 * editable in Settings — a price table baked into an app goes stale, and a
 * model that matches nothing shows "no price" rather than a guess.
 */
export const DEFAULT_PRICES: PriceRule[] = [
  { match: 'free', input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
  { match: 'opus-4-1', input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  { match: 'opus-4-2', input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  // Item 95: the current models, before the catch-alls below. Opus 5.5 fell
  // through to "opus" at $5 / $25 with cache reads at $0.50 — but it's $4 /
  // $20 and $0.20, and cache reads are most of an agent's tokens, so a
  // session showed $8.13 where Claude Code itself said $4.75. Cache writes use
  // Anthropic's standard multipliers: 1.25× input for 5 minutes, 2× for 1 hour.
  { match: 'opus-5-5', input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  { match: 'fable-5-1', input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  { match: 'mythos-5-1', input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  { match: 'fable', input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  { match: 'opus', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  { match: 'sonnet-5', input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  { match: 'sonnet', input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  { match: 'haiku', input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  { match: 'gpt-5-mini', input: 0.25, output: 2, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0.025 },
  { match: 'gpt-5', input: 1.25, output: 10, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0.125 }
];

export function emptyCounts(): TokenCounts {
  return { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
}

export function totalTokens(c: TokenCounts): number {
  return c.input + c.output + c.cacheWrite + c.cacheWrite1h + c.cacheRead;
}

export function addCounts(into: TokenCounts, c: TokenCounts): TokenCounts {
  into.input += c.input;
  into.output += c.output;
  into.cacheWrite += c.cacheWrite;
  into.cacheWrite1h += c.cacheWrite1h;
  into.cacheRead += c.cacheRead;
  return into;
}

export function priceFor(model: string, rules: PriceRule[] = DEFAULT_PRICES): Price | undefined {
  const lower = model.toLowerCase();
  return rules.find((rule) => rule.match && lower.includes(rule.match.toLowerCase()));
}

/** USD, or undefined when no rule prices this model. */
export function costOf(usage: ModelUsage, rules: PriceRule[] = DEFAULT_PRICES): number | undefined {
  const price = priceFor(usage.model, rules);
  if (!price) return undefined;
  return (
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheWrite * price.cacheWrite +
    usage.cacheWrite1h * price.cacheWrite1h +
    usage.cacheRead * price.cacheRead
  ) / 1_000_000;
}

/** Sum of every model's cost; `unpriced` says whether any model had no price. */
export function costOfAll(models: ModelUsage[], rules: PriceRule[] = DEFAULT_PRICES): { usd: number; unpriced: boolean } {
  let usd = 0;
  let unpriced = false;
  for (const m of models) {
    const cost = costOf(m, rules);
    if (cost === undefined) unpriced = totalTokens(m) > 0 || unpriced;
    else usd += cost;
  }
  return { usd, unpriced };
}

/** Folds several lists of per-model usage into one, by model. */
export function mergeModels(lists: ModelUsage[][]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const list of lists) {
    for (const m of list) {
      const into = byModel.get(m.model) ?? { model: m.model, ...emptyCounts() };
      addCounts(into, m);
      byModel.set(m.model, into);
    }
  }
  return [...byModel.values()].sort((a, b) => totalTokens(b) - totalTokens(a));
}

export function cacheHitRate(c: TokenCounts): number | undefined {
  const prompt = c.input + c.cacheWrite + c.cacheWrite1h + c.cacheRead;
  return prompt > 0 ? c.cacheRead / prompt : undefined;
}

// --- Formatting ----------------------------------------------------------------------

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

// --- Claude Code transcripts ---------------------------------------------------------

/**
 * Running totals over a Claude Code transcript (`<config>/projects/…/<id>.jsonl`),
 * fed a chunk at a time so a growing transcript is only ever read once.
 *
 * One API response is written as several lines — one per content block — each
 * repeating the same `usage`, so they are keyed by message id and the last
 * one wins.
 */
export class ClaudeTranscript {
  private readonly messages = new Map<string, ModelUsage>();
  private rest = '';
  /** Claude Code's own running total for the whole conversation (item 111). */
  private conversationUsd?: number;

  /**
   * @param since Epoch ms: responses before it are not this session's (item
   *   111). A conversation resumed in a new terminal (`claude --resume` or
   *   `--continue`) keeps writing to the same transcript, and reading it from
   *   the top counted the earlier terminal's spend a second time.
   */
  constructor(private readonly since = 0) {}

  /**
   * Claude Code's `cost-state` total: everything the conversation has cost
   * since it first started — earlier terminals it was resumed from,
   * subagents, the small helper calls — i.e. what its status line shows.
   */
  conversationTotal(): number | undefined {
    return this.conversationUsd;
  }

  feed(chunk: string): void {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (line.includes('"cost-state"')) {
      try {
        const state = JSON.parse(line) as { type?: string; totalCostUSD?: unknown };
        if (state.type === 'cost-state' && typeof state.totalCostUSD === 'number') this.conversationUsd = state.totalCostUSD;
      } catch { /* not ours */ }
      return;
    }
    if (!line.includes('"usage"')) return;
    let entry: {
      type?: string;
      timestamp?: string;
      requestId?: string;
      message?: {
        id?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
        };
      };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const message = entry.message;
    const usage = message?.usage;
    if (entry.type !== 'assistant' || !usage || !message?.model || message.model === '<synthetic>') return;
    if (this.since && entry.timestamp && Date.parse(entry.timestamp) < this.since) return;
    const key = message.id ?? entry.requestId ?? `line-${this.messages.size}`;
    const written = usage.cache_creation_input_tokens ?? 0;
    const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    this.messages.set(key, {
      model: message.model,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheWrite1h: hour,
      cacheWrite: Math.max(0, written - hour),
      cacheRead: usage.cache_read_input_tokens ?? 0
    });
  }

  models(): ModelUsage[] {
    return mergeModels([[...this.messages.values()]]);
  }
}

// --- Codex session logs --------------------------------------------------------------

/**
 * Codex writes a running `total_token_usage` into its session log
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), so the last one is the
 * session's total. Its `input_tokens` includes the cached part; ours does not.
 */
export class CodexLog {
  private model = 'codex';
  private total?: TokenCounts;
  private rest = '';

  feed(chunk: string): void {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return;
    let entry: { type?: string; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const payload = entry.payload ?? {};
    if (entry.type === 'turn_context' && typeof payload['model'] === 'string') {
      this.model = payload['model'];
    }
    const info = payload['type'] === 'token_count'
      ? (payload['info'] as { total_token_usage?: Record<string, number> } | null)
      : undefined;
    const total = info?.total_token_usage;
    if (total) {
      const cached = total['cached_input_tokens'] ?? 0;
      this.total = {
        input: Math.max(0, (total['input_tokens'] ?? 0) - cached),
        output: total['output_tokens'] ?? 0,
        cacheWrite: total['cache_write_input_tokens'] ?? 0,
        cacheWrite1h: 0,
        cacheRead: cached
      };
    }
  }

  models(): ModelUsage[] {
    return this.total ? [{ model: this.model, ...this.total }] : [];
  }
}

/** The first line of a Codex log: where and when the session started. */
export function codexSessionMeta(firstLine: string): { cwd: string; startedAt: number } | undefined {
  try {
    const entry = JSON.parse(firstLine) as { type?: string; payload?: { cwd?: string; timestamp?: string } };
    if (entry.type !== 'session_meta' || !entry.payload?.cwd) return undefined;
    const startedAt = Date.parse(entry.payload.timestamp ?? '');
    return Number.isFinite(startedAt) ? { cwd: entry.payload.cwd, startedAt } : undefined;
  } catch {
    return undefined;
  }
}

// --- The ledger ---------------------------------------------------------------------

export type UsageSource = 'claude' | 'codex' | 'quick';

/**
 * One Baton session's usage, or one quick-model job's. What the Sessions tab,
 * the Usage overview and the ticket/PR panes all total up.
 */
export interface UsageRecord {
  /** The Baton session id, or the quick job id. */
  id: string;
  title: string;
  /** A ticket key or `repo#number` — what the session was started from. */
  subject?: string;
  /** The pull request a run came from, when it did. */
  pull?: string;
  /** `implement`, `review`… or the quick job's kind. */
  kind?: string;
  runnerName: string;
  source?: UsageSource;
  startedAt: number;
  updatedAt: number;
  models: ModelUsage[];
  /**
   * Claude Code's own total for the whole conversation, when it has written
   * one (item 111). More than this session's cost when the conversation was
   * resumed here from an earlier terminal — it is what Claude's status line
   * shows.
   */
  conversationUsd?: number;
}

export function recordCounts(record: UsageRecord): TokenCounts {
  return record.models.reduce((sum, m) => addCounts(sum, m), emptyCounts());
}

/** Whether a record belongs on a ticket's or a pull request's pane. */
export function recordMatches(record: UsageRecord, subject: string): boolean {
  return record.subject === subject || record.pull === subject;
}

export interface UsageTotals extends TokenCounts {
  usd: number;
  unpriced: boolean;
  records: number;
}

export function totalsOf(records: UsageRecord[], rules: PriceRule[] = DEFAULT_PRICES): UsageTotals {
  const models = mergeModels(records.map((r) => r.models));
  const counts = models.reduce((sum, m) => addCounts(sum, m), emptyCounts());
  return { ...counts, ...costOfAll(models, rules), records: records.length };
}
