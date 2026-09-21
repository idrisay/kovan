import type { JiraIssue, ProviderId, PullSummary } from '@baton/core';
import type { PullDetail, ReviewComment, Reviewer } from '@baton/providers';
import type { AgentRun, Runner, RunKind } from '@baton/agent';
import type {
  ChangeKind, DiffSide, FileChange, FileDiff, RepoStatus, RunTarget
} from '@baton/git';
import type {
  Entry, FileBody, FileStamp, Root, Workspace, WorkspaceRepo, WriteResult
} from '../main/workspace';

export type { PullDetail, ReviewComment, Reviewer, AgentRun, Runner, RunKind, RunTarget, JiraIssue, PullSummary };
export type {
  ChangeKind, DiffSide, FileChange, FileDiff, RepoStatus,
  Entry, FileBody, FileStamp, Root, Workspace, WorkspaceRepo, WriteResult
};

/** A repo's status plus the de-duplicated count the badge shows. */
export type WorkspaceStatus = RepoStatus & { changes: number };

/** 'system' follows the OS; the other two hold regardless of it. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** The two providers a "refresh just this one" control has anything to do
 *  for — see the note on `Snapshot['refreshedAt']` in `main/poller.ts`. */
export type PolledProvider = 'github' | 'jira';

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
  connected: ProviderId[];
  errors: { provider: ProviderId; message: string }[];
  refreshing: boolean;
  refreshedAt: Partial<Record<PolledProvider, number>>;
  refreshingProviders: PolledProvider[];
}

export type StartResult = { ok: true; sessionId: string } | { ok: false; error: string };

export interface BatonApi {
  snapshot(): Promise<Snapshot>;
  refresh(): Promise<Snapshot>;
  refreshProvider(id: PolledProvider): Promise<Snapshot>;
  openExternal(url: string): Promise<void>;
  credentialFields(): Promise<Record<string, { key: string; label: string; placeholder?: string; secret?: boolean }[]>>;
  settings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;
  setSecret(key: string, value: string): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;

  pullDetail(repo: string, number: number): Promise<PullDetail>;
  ticketDetail(key: string): Promise<JiraIssue>;
  /** Widens the merged window to `limit` and returns the republished snapshot. */
  loadMoreMerged(limit: number): Promise<Snapshot>;

  runners(): Promise<Runner[]>;
  runTargets(force?: boolean): Promise<RunTarget[]>;
  buildPrompt(kind: RunKind, subject: { pull?: PullSummary; issue?: JiraIssue }): Promise<string>;
  defaultCwd(repo?: string): Promise<string | undefined>;
  startAgent(
    request: { kind: RunKind; subjectId: string; runnerId: string; cwd?: string; prompt?: string },
    subject: { pull?: PullSummary; issue?: JiraIssue }
  ): Promise<StartResult>;
  runHistory(subject: string): Promise<AgentRun[]>;
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
  workspaceTree(dir: string): Promise<Entry[]>;
  workspaceRead(file: string): Promise<FileBody>;
  workspaceWrite(file: string, text: string, expected?: FileStamp): Promise<WriteResult>;

  sessions(): Promise<SessionInfo[]>;
  sessionBuffer(id: string): Promise<string>;
  sessionWrite(id: string, data: string): Promise<void>;
  sessionResize(id: string, cols: number, rows: number): Promise<void>;
  sessionClose(id: string): Promise<void>;
  openTerminal(cwd?: string): Promise<SessionInfo>;
  onSessionOutput(listener: (id: string, data: string) => void): () => void;
  onSessions(listener: (list: SessionInfo[]) => void): () => void;
}

declare global {
  interface Window {
    baton: BatonApi;
  }
}
