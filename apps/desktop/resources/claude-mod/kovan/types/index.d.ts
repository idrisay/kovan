/** One step of the plan Claude keeps (TodoWrite, or TaskCreate/TaskUpdate). */
export type PlanStep = {
  id: string;
  text: string;
  /** What the spinner says while it runs ("Fixing the type error"). */
  active: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** When it went in progress, in $.clock.now() milliseconds. */
  since?: number;
};

/** A file this session changed, against the repository's HEAD. */
export type FileChange = {
  path: string;
  rel: string;
  add: number;
  del: number;
  isNew: boolean;
};

/** The diff shown under the open file. */
export type DiffView = {
  path: string;
  text: string;
  note?: string;
};

/** A test, typecheck or lint run: the agent's own, or Run checks. */
export type Check = {
  name: string;
  /** null while it runs. */
  ok: boolean | null;
  detail: string;
};

export type UsageWindow = { percent: number; resetsAt?: string };

export type Usage = {
  model: string;
  effort: string;
  ctxTokens?: number;
  ctxWindow: number;
  ctxPercent?: number;
  session?: UsageWindow;
  weekly?: UsageWindow;
};

declare module 'claude-code' {
  interface PluginState {
    kovan: {
      plan: PlanStep[];
      files: FileChange[];
      open: string;
      diff: DiffView;
      checks: Check[];
      usage: Usage;
    };
  }
}
