import type {
  ActivityEvent, GitHubBudget, QuickCommand, JiraIssue, ProviderId, PullSummary, ModelFamily, PriceCheckRunner, PriceProposal, PriceRule, QuickJob, QuickKind, QuickResult, ReviewEvent, SentryFrame, SentryIssue, UsageRecord, AgentsReport
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
import type { ModelList } from '../main/modelSearch';

export type {
  PullDetail, ReviewComment, ReviewThread, Reviewer, AgentRun, RunFile, Runner, RunKind, RunTarget,
  ActivityEvent, JiraIssue, PullSummary, SentryIssue, SentryFrame
};
export type { TestEnvironmentSave, TestEnvironmentState, TestSelection };
export type { ModelList };
export type {
  ChangeKind, DiffSide, FileChange, FileDiff, RepoStatus,
  Entry, FileBody, FileStamp, Root, Workspace, WorkspaceRepo, WriteResult
};

/** A repo's status plus the de-duplicated count the badge shows. */
export type WorkspaceStatus = RepoStatus & { changes: number };

export type { ThemeChoice } from '@baton/core';
import type { Problem } from '@baton/core';
export type { Problem };
import type { SpeechProviderId } from '@baton/core';
export type { RunnerLimits } from '../main/agentLimits';
import type { RunnerLimits } from '../main/agentLimits';

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
  /** The title the program running in a plain terminal set — see `SessionInfo.task` in main. */
  task?: string;
  renamed?: boolean;
  /** The quick command (item 91) running in it, if any. */
  commandId?: string;
  /** What the agent says it is doing (item 112) — see `status` on `SessionInfo` in main. */
  status?: 'working' | 'input' | 'done';
  statusAt?: number;
  statusSource?: 'claude' | 'codex' | 'opencode';
  /** Lives in the terminal host, so it outlives Baton (item 114). */
  hosted?: boolean;
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
  /** GitHub's GraphQL budget as of the last poll that got an answer (item 92). */
  githubBudget?: GitHubBudget;
  /** The first refresh after launch, service by service (item 101). */
  booting?: { provider: PolledProvider; state: 'loading' | 'done' | 'failed'; count?: number; message?: string }[];
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
  setNativeTheme(source: 'system' | 'light' | 'dark'): Promise<void>;
  systemAccent(): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;

  pullDetail(repo: string, number: number): Promise<PullDetail>;
  /** People (most requested through Baton first) and teams who can review on this repo. */
  reviewerCandidates(repo: string): Promise<{ people: { login: string; count: number }[]; teams: { slug: string; name: string }[] }>;
  requestReviewers(repo: string, number: number, people: string[], teams: string[]): Promise<void>;
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
  /** The model a quick action runs on (nv-review's for the review). */
  quickModel(kind: QuickKind): Promise<string>;
  /** Remembers a model for one quick action; empty goes back to Settings' default. */
  quickModelSet(kind: QuickKind, model: string): Promise<void>;
  /** `provider/model` for everything opencode can run. Asked on a picker's first open. */
  quickModelsAvailable(): Promise<string[]>;
  /** A web-searching model looks up today's list prices for these rows. Proposals only — nothing is saved. */
  priceCheck(runner: PriceCheckRunner, model: string, rules: PriceRule[]): Promise<{ proposals: PriceProposal[] } | { error: string }>;
  priceCheckCancel(): Promise<void>;
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
  /** The run sheet's model list per agent family: built-in suggestions plus
   *  whatever the last ↻ search found (see `main/modelSearch.ts`). */
  knownModels(): Promise<Record<ModelFamily, ModelList>>;
  /** ↻ in the run sheet: looks up the models this agent's CLI takes today, and adds them. */
  modelsSearch(command: string): Promise<ModelList | { error: string }>;
  /** Every status of the loaded tickets' Jira projects, To Do → Done. */
  ticketStatuses(): Promise<{ name: string; category: string }[]>;
  /** The clipboard's image saved as a PNG; '' when it holds none. */
  clipboardImagePath(): Promise<string>;
  /** Puts text on the clipboard, through main so it works whatever has focus. */
  copyText(text: string): Promise<void>;
  /** Where a dropped file lives on disk; '' for one that has no path. */
  pathForFile(file: File): string;
  modelsSearchCancel(): Promise<void>;
  runTargets(force?: boolean): Promise<RunTarget[]>;
  buildPrompt(kind: RunKind, subject: Subject, test?: TestSelection): Promise<string>;
  /** Environments and test accounts. Passwords never come back — only which are saved. */
  testEnvironments(): Promise<TestEnvironmentState>;
  testEnvironmentsSave(next: TestEnvironmentSave): Promise<TestEnvironmentState>;
  defaultCwd(repo?: string): Promise<string | undefined>;
  startAgent(
    request: {
      kind: RunKind; subjectId: string; runnerId: string; cwd?: string; extraCwds?: string[]; prompt?: string; model?: string;
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
  /** Shows a run's file or folder selected in Finder. */
  runReveal(file: string): Promise<void>;
  /** Watches a run's folder while its viewer is open (item 90). */
  runWatch(directory: string, on: boolean): Promise<void>;
  /** Opens the site the run checked on in the default browser. */
  /** Plan limits per runner id, read from what the agents write (item 108). */
  agentLimits(): Promise<Record<string, RunnerLimits>>;
  /** Opens the page the agent was on — the given screenshot's, when it recorded one (item 109). */
  runSiteOpen(directory: string, shot?: string): Promise<void>;
  onRunChanged(listener: (directory: string) => void): () => void;
  /** Quick commands (item 91): the saved list, and which ran last. */
  /** `busy`: commands still running in their terminal, not just open at a prompt. */
  commands(): Promise<{ commands: QuickCommand[]; last: string; busy: string[] }>;
  commandSave(input: { id?: string; name: string; command: string; cwd: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  commandDuplicate(id: string): Promise<string | undefined>;
  commandDelete(id: string): Promise<void>;
  /** Runs a saved command by id — or finds the session it's already running in. */
  commandRun(id: string): Promise<{ ok: true; sessionId: string; reused: boolean } | { ok: false; error: string }>;
  /** A native folder picker; '' when cancelled. */
  commandFolder(): Promise<string>;
  /** Starts listening (item 88); words arrive through `onDictation`. */
  dictationStart(): Promise<{ ok: true } | { ok: false; message: string }>;
  dictationStop(): Promise<void>;
  dictationCancel(): Promise<void>;
  dictationStatus(refresh?: boolean): Promise<DictationStatus>;
  /** Speech providers (item 97): what's set up, a key, a sample test, a model file. */
  speechSetup(): Promise<SpeechSetup>;
  /** ⌘P (item 100): the active workspace's files; `force` lists them again. */
  quickOpenFiles(force?: boolean): Promise<{ workspace: string | null; files: { path: string; rel: string }[] }>;
  speechKey(provider: SpeechProviderId, key: string): Promise<void>;
  speechTest(provider: SpeechProviderId): Promise<{ ok: true; text: string; ms: number } | { ok: false; message: string }>;
  speechPickModel(): Promise<string | undefined>;
  privacyOpen(pane: 'mic' | 'speech'): Promise<void>;
  onDictation(listener: (event: DictationEvent) => void): () => void;
  /** The Activity inbox, and a subject a clicked notification asked to open. */
  activity(): Promise<{ inbox: ActivityEvent[]; open?: string }>;
  /** Marks events read; returns the inbox after. */
  activityRead(ids: string[] | 'all'): Promise<ActivityEvent[]>;
  /** Connection problems, newest first (item 120). */
  problems(): Promise<Problem[]>;
  onProblems(listener: (update: { log: Problem[]; started: Problem[] }) => void): () => void;
  onActivity(listener: (inbox: ActivityEvent[]) => void): () => void;
  /** New events while the window is in front: show them as toasts. */
  onActivityToast(listener: (events: ActivityEvent[]) => void): () => void;
  /** A notification was clicked: open this subject ('' = the inbox). */
  onActivityOpen(listener: (subject: string) => void): () => void;
  /** Writes what threw to `~/Library/Logs/Baton/baton.log` (item 83). */
  logError(report: RendererErrorReport): Promise<void>;
  /** Shows the log file selected in Finder. */
  revealLog(): Promise<void>;
  runImage(file: string): Promise<string>;

  workspaces(): Promise<{ list: Workspace[]; active?: string }>;
  workspaceCreate(): Promise<Workspace | undefined>;
  workspaceActivate(id: string): Promise<void>;
  workspaceAddFolder(id: string): Promise<Workspace | undefined>;
  workspaceRemoveFolder(id: string, folder: string): Promise<Workspace | undefined>;
  /** Same folders in a new order; anything else is refused and returns undefined. */
  workspaceReorder(id: string, folders: string[]): Promise<Workspace | undefined>;
  workspaceForget(id: string): Promise<void>;
  workspaceRepos(id: string, force?: boolean): Promise<WorkspaceRepo[]>;
  workspaceRoots(id: string, force?: boolean): Promise<Root[]>;
  workspaceRename(id: string, name: string): Promise<Workspace | undefined>;
  workspaceStatus(repo: string): Promise<WorkspaceStatus>;
  /** `context`: lines around each change (default 3); a huge number shows the whole file. */
  workspaceDiff(
    repo: string, file: string, side: DiffSide, from?: string, context?: number
  ): Promise<FileDiff>;
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

/** What the window sends main when something in it throws. */
export interface RendererErrorReport {
  kind: 'render' | 'error' | 'rejection';
  message: string;
  stack?: string;
  componentStack?: string;
  /** Which pane, or which row was open, when it happened. */
  where?: string;
}

export type DictationEvent =
  | { type: 'ready'; locale: string; onDevice: boolean; recording?: boolean }
  | { type: 'level'; value: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'transcribing'; provider: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'ended' };

export interface DictationStatus {
  available: boolean;
  mic: string;
  speech: string;
  system: string;
  locale: string;
  locales: { id: string; name: string; onDevice: boolean }[];
  provider: SpeechProviderId;
}

export interface SpeechSetup {
  provider: SpeechProviderId;
  models: Record<string, string>;
  baseUrls: Record<string, string>;
  keys: Record<string, boolean>;
  whisperCli: string | null;
  whisperModels: string[];
  whisperModel: string;
}
