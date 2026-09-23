import type {
  JiraIssue, ProviderId, PullSummary, QuickJob, QuickKind, QuickResult, ReviewEvent, SentryFrame, SentryIssue, UsageRecord, AgentsReport
} from '@baton/core';
import type { PullDetail, ReviewComment, ReviewThread, Reviewer } from '@baton/providers';
import type { AgentRun, RunFile, Runner, RunKind } from '@baton/agent';
import type {
  ChangeKind, DiffSide, FileChange, FileDiff, RepoStatus, RunTarget
} from '@baton/git';
import type {
  Entry, FileBody, FileStamp, Root, Workspace, WorkspaceRepo, WriteResult
} from '../main/workspace';
import type { TestEnvironmentSave, TestEnvironmentState, TestSelection } from '../main/testEnvironments';

export type {
  PullDetail, ReviewComment, ReviewThread, Reviewer, AgentRun, RunFile, Runner, RunKind, RunTarget,
  JiraIssue, PullSummary, SentryIssue, SentryFrame
};
export type { TestEnvironmentSave, TestEnvironmentState, TestSelection };
export type {
  ChangeKind, DiffSide, FileChange, FileDiff, RepoStatus,
  Entry, FileBody, FileStamp, Root, Workspace, WorkspaceRepo, WriteResult
};

/** A repo's status plus the de-duplicated count the badge shows. */
export type WorkspaceStatus = RepoStatus & { changes: number };

/** 'system' follows the OS; the other two hold regardless of it. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** The providers a "refresh just this one" control has anything to do for —
 *  see the note on `Snapshot['refreshedAt']` in `main/poller.ts`. */
export type PolledProvider = 'github' | 'jira' | 'sentry';

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  runnerName: string;
  kind?: RunKind;
  subject?: string;
  startedAt: number;
  running: boolean;
  exitCode?: number;
  runDirectory?: string;
  /** Set while the session is idle on your reply — see `Sessions.write()` in main. */
  attention: boolean;
}

export interface Snapshot {
  at: number;
  viewer: string;
  blocked: PullSummary[];
  mine: PullSummary[];
  reviewRequested: PullSummary[];
  merged: PullSummary[];
  mergedTotal: number;
  loadingMerged: boolean;
  tickets: JiraIssue[];
  sentryIssues: SentryIssue[];
  connected: ProviderId[];
  errors: { provider: ProviderId; message: string }[];
  refreshing: boolean;
  refreshedAt: Partial<Record<PolledProvider, number>>;
  refreshingProviders: PolledProvider[];
}

/** One quick-model job's saved result and live progress; see `main/quick.ts`. */
export interface QuickState {
  result?: QuickResult;
  /** Epoch ms the running job started, when one is running. */
  running?: number;
  error?: string;
}

export type StartResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** Everything a run can be started against — see `Subject` in `main/agents.ts`. */
export interface Subject {
  pull?: PullSummary;
  issue?: JiraIssue;
  sentry?: { issue: SentryIssue; frames: SentryFrame[] };
}

export interface BatonApi {
  snapshot(): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  refreshProvider(id: PolledProvider): Promise<Snapshot>;
  openExternal(url: string): Promise<void>;
  credentialFields(): Promise<Record<string, { key: string; label: string; placeholder?: string; secret?: boolean }[]>>;
  missingFields(id: ProviderId): Promise<string[]>;
  settings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;
  setSecret(key: string, value: string): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;

  pullDetail(repo: string, number: number): Promise<PullDetail>;
  ticketDetail(key: string): Promise<JiraIssue>;
  /** Widens the merged window to `limit` and returns the republished snapshot. */
  loadMoreMerged(limit: number): Promise<Snapshot>;

  quickState(kind: QuickKind, subject: string): Promise<QuickState>;
  /** Starts the job and returns at once; progress arrives through `onQuick`. */
  quickRun(kind: QuickKind, subject: string): Promise<void>;
  quickCancel(kind: QuickKind, subject: string): Promise<void>;
  quickDismiss(kind: QuickKind, subject: string): Promise<void>;
  quickTest(model?: string): Promise<{ ok: boolean; ms: number; error?: string }>;
  onQuick(listener: (kind: QuickKind, subject: string, state: QuickState) => void): () => void;
  /** Recent Summarize/Condense jobs, newest first — the Sessions tab's "Quick model" list. */
  quickJobs(): Promise<QuickJob[]>;
  onQuickJobs(listener: (jobs: QuickJob[]) => void): () => void;
  /** Closes a job's row, cancelling it first when it is still running. */
  quickJobRemove(id: string): Promise<void>;
  /** Posts the saved code review to GitHub as the user's own review. */
  reviewSubmit(subject: string, event: ReviewEvent): Promise<{ ok: boolean; error?: string }>;

  /** Token usage per session and quick job, newest first; see `main/usage.ts`. */
  usage(): Promise<UsageRecord[]>;
  onUsage(listener: (records: UsageRecord[]) => void): () => void;
  /** Every agent process on this Mac; see `main/running.ts`. */
  runningAgents(): Promise<AgentsReport>;
  /** The Running agents pane opened (true) or closed: scan fast, with ports, while open. */
  runningAgentsWatch(on: boolean): Promise<AgentsReport>;
  runningAgentsStop(keys: string[], children: boolean): Promise<{ key: string; stopped: boolean; left: number }[]>;
  runningAgentsForce(key: string): Promise<{ key: string; stopped: boolean; left: number }>;
  onRunningAgents(listener: (report: AgentsReport) => void): () => void;
  /** The idle reminder was clicked. */
  onShowAgents(listener: () => void): () => void;

  runners(): Promise<Runner[]>;
  /** Suggested models per runner id — a starting list, not a live query;
   *  see the note on `KNOWN_MODELS` in `@baton/agent`. */
  knownModels(): Promise<Record<string, string[]>>;
  runTargets(force?: boolean): Promise<RunTarget[]>;
  buildPrompt(kind: RunKind, subject: Subject, test?: TestSelection): Promise<string>;
  /** Environments and test accounts. Passwords never come back — only which are saved. */
  testEnvironments(): Promise<TestEnvironmentState>;
  testEnvironmentsSave(next: TestEnvironmentSave): Promise<TestEnvironmentState>;
  defaultCwd(repo?: string): Promise<string | undefined>;
  startAgent(
    request: {
      kind: RunKind; subjectId: string; runnerId: string; cwd?: string; prompt?: string; model?: string;
      test?: TestSelection;
    },
    subject: Subject
  ): Promise<StartResult>;
  runHistory(subject: string): Promise<AgentRun[]>;
  /** One Sentry issue's latest stack trace, each frame placed on disk where possible. */
  sentryFrames(issueId: string): Promise<SentryFrame[]>;
  /** Files a Jira ticket from a Sentry issue, using the default project set in Settings. */
  sentryCreateTicket(issue: SentryIssue): Promise<{ key: string; url: string }>;
  /** Every file a run's own directory actually contains. */
  runFiles(directory: string): Promise<RunFile[]>;
  /** A run's own report.md or prompt.md — validated server-side to actually belong to a run. */
  runText(file: string): Promise<string>;
  /** A run's own screenshot, as a `data:image/...` URL ready for an `<img src>`. */
  runImage(file: string): Promise<string>;

  workspaces(): Promise<{ list: Workspace[]; active?: string }>;
  workspaceCreate(): Promise<Workspace | undefined>;
  workspaceActivate(id: string): Promise<void>;
  workspaceAddFolder(id: string): Promise<Workspace | undefined>;
  workspaceRemoveFolder(id: string, folder: string): Promise<Workspace | undefined>;
  workspaceForget(id: string): Promise<void>;
  workspaceRepos(id: string, force?: boolean): Promise<WorkspaceRepo[]>;
  workspaceRoots(id: string, force?: boolean): Promise<Root[]>;
  workspaceRename(id: string, name: string): Promise<Workspace | undefined>;
  workspaceStatus(repo: string): Promise<WorkspaceStatus>;
  workspaceDiff(repo: string, file: string, side: DiffSide, from?: string): Promise<FileDiff>;
  workspaceRevert(repo: string, changes: FileChange[]): Promise<void>;
  workspaceTree(dir: string): Promise<Entry[]>;
  workspaceRead(file: string): Promise<FileBody>;
  workspaceWrite(file: string, text: string, expected?: FileStamp): Promise<WriteResult>;

  sessions(): Promise<SessionInfo[]>;
  sessionBuffer(id: string): Promise<string>;
  sessionWrite(id: string, data: string): Promise<void>;
  sessionResize(id: string, cols: number, rows: number): Promise<void>;
  sessionClose(id: string): Promise<void>;
  sessionRename(id: string, title: string): Promise<void>;
  openTerminal(cwd?: string, subject?: string, title?: string): Promise<SessionInfo>;
  onSessionOutput(listener: (id: string, data: string) => void): () => void;
  onSessions(listener: (list: SessionInfo[]) => void): () => void;
  onFontSizeStep(listener: (step: number) => void): () => void;
}

declare global {
  interface Window {
    baton: BatonApi;
  }
}
