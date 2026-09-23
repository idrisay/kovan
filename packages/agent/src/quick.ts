/**
 * How the quick model is invoked: one `opencode run`, spawned directly (no
 * shell), with its tools locked.
 *
 * Why "ask" and not "deny", measured rather than assumed: denying a tool
 * removes it from the request, and OpenCode's free tier answers a request
 * without its stock tool set with 403 "can only be used from within
 * OpenCode". "ask" keeps the tools declared, and `opencode run` has nobody to
 * ask, so it auto-rejects every call — confirmed with a prompt that asked for
 * `touch` and a file write: neither happened. `OPENCODE_CONFIG_CONTENT` also
 * wins over a project `opencode.json` that allows bash, so a hostile cwd
 * cannot loosen it; the cwd is an empty temp folder regardless.
 *
 * The material goes in an attached file (`-f`), never on a shell line, and the
 * instruction is a fixed string of ours — the same rule every agent run keeps.
 */

export const QUICK_OPENCODE_CONFIG = JSON.stringify({
  permission: { '*': 'ask' },
  share: 'disabled',
  autoupdate: false
});

export function quickArgs(model: string, inputFile: string, instruction: string): string[] {
  // `--` so nothing in the instruction can ever be read as a flag.
  return ['run', '--model', model, '--format', 'json', '-f', inputFile, '--', instruction];
}

export interface QuickTokens {
  input: number;
  output: number;
  reasoning: number;
}

export interface QuickOutput {
  text?: string;
  error?: string;
  /** Summed over every step, as opencode reports them. */
  tokens?: QuickTokens;
  /**
   * Tool calls the model tried and opencode refused, e.g. `read /tmp/…`. Any
   * entry here is the permission setup doing its job, and worth seeing.
   */
  refused: string[];
}

interface QuickEvent {
  type?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: Record<string, unknown> };
    tokens?: { input?: number; output?: number; reasoning?: number };
  };
  error?: { name?: string; data?: { message?: string } };
}

/** The one argument that says what a refused call was aimed at. */
function toolTarget(input?: Record<string, unknown>): string {
  const value = input?.['filePath'] ?? input?.['command'] ?? input?.['path'] ?? input?.['url'] ?? input?.['pattern'];
  return typeof value === 'string' ? ` ${value.slice(0, 120)}` : '';
}

/**
 * The answer out of `--format json`'s event stream: one JSON object per line.
 *
 * The *last* text part is the answer. Earlier ones are commentary the model
 * wrote before trying a tool ("I'll check the workspace…"), which is exactly
 * the step our permission setup rejects.
 */
export function parseQuickOutput(stdout: string): QuickOutput {
  let text: string | undefined;
  let error: string | undefined;
  let tokens: QuickTokens | undefined;
  const refused: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: QuickEvent;
    try {
      event = JSON.parse(line) as QuickEvent;
    } catch {
      continue;
    }
    const part = event.part;
    if (event.type === 'text' && part?.type === 'text' && part.text?.trim()) {
      text = part.text.trim();
    } else if (event.type === 'tool_use' && part?.state?.status === 'error') {
      refused.push(`${part.tool ?? 'tool'}${toolTarget(part.state.input)}`);
    } else if (event.type === 'step_finish' && part?.tokens) {
      tokens = {
        input: (tokens?.input ?? 0) + (part.tokens.input ?? 0),
        output: (tokens?.output ?? 0) + (part.tokens.output ?? 0),
        reasoning: (tokens?.reasoning ?? 0) + (part.tokens.reasoning ?? 0)
      };
    } else if (event.type === 'error') {
      error = event.error?.data?.message ?? event.error?.name ?? 'The quick model returned an error.';
    }
  }
  return text
    ? { text, tokens, refused }
    : { error: error ?? 'The quick model returned no answer.', tokens, refused };
}
