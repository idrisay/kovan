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

/** A file this session changed, against its own repository's HEAD. */
export type FileChange = {
  path: string;
  /** Its repository's root, absolute; '' for a file in no repository (item 152). */
  repo: string;
  /** Relative to `repo`; for a file in no repository, its path with `~` for home. */
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
  /** The file itself, not a diff: a file in no repository has nothing to diff against. */
  plain?: boolean;
};

/** A test, typecheck or lint run: the agent's own, or Run checks. */
export type Check = {
  name: string;
  /** null while it runs. */
  ok: boolean | null;
  detail: string;
};

/** A pull request a link in the chat named (item 154). */
export type PullLink = {
  url: string;
  /** owner/name */
  repo: string;
  number: number;
  /** From `gh`, once it answered; absent before, or when it can't. */
  title?: string;
  state?: 'open' | 'merged' | 'closed' | 'draft';
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
      scripts: boolean;
      /** The session's folders' repositories, main first (KOVAN_FOLDERS). */
      folders: string[];
      pulls: PullLink[];
    };
  }
}
