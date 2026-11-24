import { describe, expect, it } from 'vitest';
import {
  agentFamily, agentReviewArgs, foundPlantedBug, normaliseReviewTools, parseReviewToolModel, pullReviewPrompt,
  reviewFileName, reviewToolCommandLine, reviewToolId, reviewToolLabel, reviewToolModel, reviewToolVia
} from '../src';

describe('reviewers (item 143)', () => {
  it('keeps the model string nv-review always used', () => {
    expect(parseReviewToolModel('moonshotai/kimi-k3 (nv-review)')).toEqual({ id: 'nv-review', model: 'moonshotai/kimi-k3' });
    expect(reviewToolLabel('moonshotai/kimi-k3 (nv-review)')).toBe('Kimi K3');
    expect(reviewFileName('moonshotai/kimi-k3 (nv-review)')).toBe('kimi-k3-review.md');
    expect(reviewToolVia('moonshotai/kimi-k3 (nv-review)')).toBe('nv-review');
  });

  it('names other reviewers by id and model', () => {
    expect(reviewToolModel('claude', 'sonnet')).toBe('sonnet (claude)');
    expect(reviewToolModel('gemini-review')).toBe('(gemini-review)');
    expect(parseReviewToolModel('(gemini-review)')).toEqual({ id: 'gemini-review', model: undefined });
    expect(reviewToolLabel('sonnet (claude)')).toBe('claude · sonnet');
    expect(reviewFileName('sonnet (claude)')).toBe('claude-sonnet-review.md');
    expect(reviewToolVia('opencode/big-pickle')).toBe('opencode');
    expect(parseReviewToolModel('opencode/big-pickle')).toBeUndefined();
  });

  it('knows which commands are agents it can drive', () => {
    expect(agentFamily('claude')).toBe('claude');
    expect(agentFamily('claude-personal')).toBe('claude');
    expect(agentFamily('codex')).toBe('codex');
    expect(agentFamily('cc-review')).toBeUndefined();
    expect(agentFamily('claudette')).toBeUndefined();
  });

  it('runs agents read-only', () => {
    const claude = agentReviewArgs('claude', 'sonnet', '/tmp/out');
    expect(claude).toContain('--print');
    expect(claude.slice(claude.indexOf('--permission-mode'), claude.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk']);
    expect(claude.slice(claude.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Grep', 'Glob']);
    const codex = agentReviewArgs('codex', undefined, '/tmp/out');
    expect(codex.slice(0, 3)).toEqual(['exec', '--sandbox', 'read-only']);
    expect(codex).not.toContain('--model');
    expect(codex[codex.length - 1]).toBe('-');
    expect(reviewToolCommandLine({ kind: 'command', command: 'gemini-review', model: 'gemini-3-pro', modelEnv: 'GEMINI_MODEL' }))
      .toBe('GEMINI_MODEL=gemini-3-pro gemini-review < prompt');
  });

  it('always lists nv-review first and drops broken entries', () => {
    const tools = normaliseReviewTools([
      { id: 'claude', kind: 'agent', command: 'claude', model: 'sonnet', timeoutMinutes: 15 },
      { id: 'bad', kind: 'agent', command: 'cc-review' },
      { id: 'evil', kind: 'command', command: 'rm -rf ~' },
      { id: 'gemini-review', kind: 'command', command: 'gemini-review', modelEnv: 'NOT VALID' },
      null
    ], 'nvidia/nemotron');
    expect(tools.map((t) => t.id)).toEqual(['nv-review', 'claude', 'gemini-review']);
    expect(tools[0]).toMatchObject({ command: 'nv-review', modelEnv: 'NV_MODEL', model: 'nvidia/nemotron' });
    expect(tools[1]).toMatchObject({ family: 'claude', timeoutMinutes: 15 });
    expect(tools[2]!.modelEnv).toBeUndefined();
    expect(reviewToolId('claude', ['nv-review', 'claude'])).toBe('claude-2');
  });

  it('spots the planted bug in a test review', () => {
    expect(foundPlantedBug('`src/cart.ts:5` — `i <= items.length` reads one past the end.')).toBe(true);
    expect(foundPlantedBug('Off-by-one in the loop.')).toBe(true);
    expect(foundPlantedBug('Looks good to me.')).toBe(false);
  });

  it('tells an agent it may read the checkout', () => {
    const pull = { repo: 'a/b', number: 1, title: 't', author: 'x', headRef: 'h', baseRef: 'main', body: '', threads: [] };
    expect(pullReviewPrompt(pull as never, 'diff', { checkout: true })).toContain('read-only checkout');
    expect(pullReviewPrompt(pull as never, 'diff')).toContain('You have no tools');
  });
});

describe('command reviewers from their --help (item 143, cf-review)', () => {
  const CF_HELP = `usage: cf-review [-h] [-m MODELS] [--deep] [-o OUT] [--max-tokens MAX_TOKENS]
                 [prompt_file]

  cf-review prompt.txt -o review.md          # everyday models (GLM-4.7-Flash first)
  cf-review -m @cf/openai/gpt-oss-120b < prompt.txt

Needs an API token with "Workers AI: Read" + "Workers AI: Edit" saved to
~/.config/cloudflare/key. The account id comes from CF_ACCOUNT_ID or
~/.config/cloudflare/account_id, falling back to the wrangler login's account.

positional arguments:
  prompt_file           file holding the prompt, or - for stdin
options:
  -m MODELS, --model MODELS
                        override the model list; repeat for a fallback order`;

  it('reads how cf-review takes its model, prompt and key', async () => {
    const { parseCommandHelp } = await import('../src');
    expect(parseCommandHelp(CF_HELP)).toEqual({
      modelFlag: '--model', modelEnv: undefined, promptAs: 'stdin',
      models: ['@cf/openai/gpt-oss-120b'], keyFiles: ['~/.config/cloudflare/key']
    });
  });

  it('finds a model variable when there is no flag', async () => {
    const { parseCommandHelp } = await import('../src');
    expect(parseCommandHelp('usage: nv-review < prompt\nModel from NV_MODEL (default moonshotai/kimi-k3).'))
      .toMatchObject({ modelFlag: undefined, modelEnv: 'NV_MODEL', promptAs: 'stdin' });
  });

  it('runs a flag-model, file-prompt command as written', async () => {
    const { commandReviewArgs, reviewToolCommandLine } = await import('../src');
    const tool = { kind: 'command' as const, command: 'or-review', model: 'x/y', modelFlag: '-m', promptAs: 'file' as const };
    expect(commandReviewArgs(tool, '/tmp/p.md')).toEqual(['-m', 'x/y', '/tmp/p.md']);
    expect(reviewToolCommandLine(tool)).toBe('or-review -m x/y prompt.md');
    expect(reviewToolCommandLine({ ...tool, promptAs: undefined, modelFlag: '--model' })).toBe('or-review --model x/y < prompt');
  });

  it('refuses a flag that is not just a flag', async () => {
    const { normaliseReviewTools } = await import('../src');
    const [, tool] = normaliseReviewTools([{ id: 'x', kind: 'command', command: 'x-review', modelFlag: '-m; rm -rf ~' }], '');
    expect(tool!.modelFlag).toBeUndefined();
  });

  it('drops the model header cf-review prints first', async () => {
    const { stripReviewHeader } = await import('../src');
    expect(stripReviewHeader('--- @cf/zai-org/glm-4.7-flash (412 neurons)\n\n## Summary\nok')).toBe('## Summary\nok');
    expect(stripReviewHeader('---\n## Summary')).toBe('---\n## Summary');
  });
});
