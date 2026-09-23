/**
 * The run sheet's model list per agent family: the built-in suggestions plus
 * whatever the last ↻ search found, kept in settings so it survives restarts.
 * A search only ever adds names; it never changes which model is picked.
 */

import { modelFamily, modelSearchPrompt, parseModelSearch, type ModelFamily } from '@baton/core';
import { KNOWN_MODELS } from '@baton/agent';
import type { DesktopHost } from './host';
import { WebAsk } from './webAsk';

export interface ModelList {
  models: string[];
  /** Found by the last search and not in the list before it. */
  added: string[];
  /** When the last search finished. */
  at?: number;
}

type Found = Partial<Record<ModelFamily, { models: string[]; added: string[]; at: number }>>;

const FAMILIES: ModelFamily[] = ['claude', 'codex', 'opencode'];
const KEY = 'models.found';

export class ModelSearch {
  private readonly web = new WebAsk();

  constructor(
    private readonly host: DesktopHost,
    /** `opencode models` — opencode can say for itself, no search needed. */
    private readonly opencodeModels: () => Promise<string[]>
  ) {}

  /** Every family's list, keyed by family: `claude`, `codex`, `opencode`. */
  lists(): Record<ModelFamily, ModelList> {
    const found = this.host.config.get<Found>(KEY, {});
    return Object.fromEntries(
      FAMILIES.map((family) => {
        const own = found[family];
        const models = [...new Set([...(KNOWN_MODELS[family] ?? []), ...(own?.models ?? [])])];
        return [family, { models, added: own?.added ?? [], at: own?.at }];
      })
    ) as Record<ModelFamily, ModelList>;
  }

  cancel(): void {
    this.web.cancel();
  }

  async search(command: string): Promise<ModelList | { error: string }> {
    const family = modelFamily(command);
    if (!family) return { error: 'Baton does not know how to look up models for this agent. Type the model name instead.' };

    let models: string[];
    if (process.env['BATON_SMOKE'] && process.env['BATON_USER_DATA']) {
      models = family === 'claude' ? ['opus', 'sonnet', 'haiku', 'claude-opus-5-5'] : ['gpt-5', 'gpt-5-codex'];
    } else if (family === 'opencode') {
      models = await this.opencodeModels();
      if (models.length === 0) return { error: 'opencode listed no models. Check it runs in a terminal.' };
    } else {
      // Haiku for Claude Code: finding a list of names on a docs page does
      // not need a bigger model, and this spends the user's tokens.
      const answer = await this.web.ask(family, family === 'claude' ? 'haiku' : '', modelSearchPrompt(family));
      if ('error' in answer) return answer;
      const parsed = parseModelSearch(answer.text);
      if ('error' in parsed) return parsed;
      models = parsed.models;
    }

    const before = new Set(this.lists()[family].models);
    const found = this.host.config.get<Found>(KEY, {});
    const entry = { models, added: models.filter((m) => !before.has(m)), at: Date.now() };
    await this.host.config.set(KEY, { ...found, [family]: entry });
    return this.lists()[family];
  }
}
