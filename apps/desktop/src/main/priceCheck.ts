/**
 * "Check prices online" (Settings → Token prices). The answer comes back as
 * proposals for the renderer to show; nothing here writes the price table.
 */

import {
  parsePriceCheck, priceCheckPrompt,
  type PriceCheckRunner, type PriceProposal, type PriceRule
} from '@kovan/core';
import { WebAsk } from './webAsk';

export type PriceCheckResult = { proposals: PriceProposal[] } | { error: string };

export class PriceCheck {
  private readonly web = new WebAsk();

  cancel(): void {
    this.web.cancel();
  }

  async run(runner: PriceCheckRunner, model: string, rules: PriceRule[]): Promise<PriceCheckResult> {
    const answer = await this.web.ask(runner, model, priceCheckPrompt(rules));
    return 'error' in answer ? answer : parsePriceCheck(answer.text, rules);
  }
}
