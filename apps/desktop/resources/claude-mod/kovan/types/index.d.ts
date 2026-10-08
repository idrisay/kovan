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

/** A link in the chat the pane lists (item 154): a pull request, a Figma design, a ticket or a local page. */
export type LinkItem = {
  kind: 'pull' | 'figma' | 'ticket' | 'page';
  url: string;
  /** What the row says: `acme-frontend#2789`, `Contact Us popup`, `ACME-1234`, `app.acme.test/en`. */
  key: string;
  /** For a pull request: owner/name and number, to ask gh. */
  repo?: string;
  number?: number;
  /** A pull request's, from gh once it answered. */
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
  /** US dollars so far, as /cost totals it (item 153). */
  cost?: number;
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
      links: LinkItem[];
    };
  }
}
