/**
 * The only bridge between the renderer and the main process.
 *
 * Nothing here exposes `ipcRenderer` itself, and no channel returns a secret —
 * tokens go in through `setSecret` and never come back out. The renderer
 * therefore cannot leak a credential even if something on a detail page
 * manages to run.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  snapshot: () => ipcRenderer.invoke('kovan:snapshot'),
  refresh: () => ipcRenderer.invoke('kovan:refresh'),
  refreshProvider: (id: string) => ipcRenderer.invoke('kovan:refresh-provider', id),
  /** 'darwin' or 'linux': shortcuts, labels and the title bar follow it. */
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('kovan:open-external', url),
  credentialFields: () => ipcRenderer.invoke('kovan:credential-fields'),
  missingFields: (id: string) => ipcRenderer.invoke('kovan:missing-fields', id),
  loadMoreMerged: (limit: number) => ipcRenderer.invoke('kovan:merged-more', limit),
  teammates: (service: 'github' | 'jira') => ipcRenderer.invoke('kovan:teammates', service),
  personPulls: (login: string, merged: number) => ipcRenderer.invoke('kovan:person-pulls', login, merged),
  personTickets: (accountId: string) => ipcRenderer.invoke('kovan:person-tickets', accountId),
  settings: () => ipcRenderer.invoke('kovan:settings'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('kovan:set-setting', key, value),
  /** Native chrome's side of the painted theme — see `renderer/appearance.tsx`. */
  setNativeTheme: (source: 'system' | 'light' | 'dark'): Promise<void> => ipcRenderer.invoke('kovan:native-theme', source),
  /** The accent colour chosen in System Settings, as "#rrggbb". */
  systemAccent: (): Promise<string | undefined> => ipcRenderer.invoke('kovan:system-accent'),
  setSecret: (key: string, value: string) => ipcRenderer.invoke('kovan:set-secret', key, value),
  onSnapshot: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on('kovan:snapshot', handler);
    return () => ipcRenderer.removeListener('kovan:snapshot', handler);
  },

  // Detail
  pullDetail: (repo: string, number: number) =>
    ipcRenderer.invoke('kovan:pull-detail', repo, number),
  reviewerCandidates: (repo: string) => ipcRenderer.invoke('kovan:reviewer-candidates', repo),
  requestReviewers: (repo: string, number: number, people: string[], teams: string[]) =>
    ipcRenderer.invoke('kovan:reviewers-request', repo, number, people, teams),
  ticketDetail: (key: string) => ipcRenderer.invoke('kovan:ticket-detail', key),
  pullSummary: (repo: string, number: number) => ipcRenderer.invoke('kovan:pull-summary', repo, number),
  ticketStatus: (key: string) => ipcRenderer.invoke('kovan:ticket-status', key),

  // Quick model
  quickState: (kind: string, subject: string) => ipcRenderer.invoke('kovan:quick-state', kind, subject),
  quickRun: (kind: string, subject: string) => ipcRenderer.invoke('kovan:quick-run', kind, subject),
  quickCancel: (kind: string, subject: string) => ipcRenderer.invoke('kovan:quick-cancel', kind, subject),
  quickDismiss: (kind: string, subject: string) => ipcRenderer.invoke('kovan:quick-dismiss', kind, subject),
  quickTest: (model?: string) => ipcRenderer.invoke('kovan:quick-test', model),
  quickJobs: () => ipcRenderer.invoke('kovan:quick-jobs'),
  quickJobRemove: (id: string) => ipcRenderer.invoke('kovan:quick-job-remove', id),
  quickModel: (kind: string) => ipcRenderer.invoke('kovan:quick-model', kind),
  quickModelSet: (kind: string, model: string) => ipcRenderer.invoke('kovan:quick-model-set', kind, model),
  quickModelsAvailable: () => ipcRenderer.invoke('kovan:quick-models-available'),
  priceCheck: (runner: string, model: string, rules: unknown[]) =>
    ipcRenderer.invoke('kovan:price-check', runner, model, rules),
  priceCheckCancel: () => ipcRenderer.invoke('kovan:price-check-cancel'),
  reviewSubmit: (subject: string, event: string) => ipcRenderer.invoke('kovan:review-submit', subject, event),
  usage: () => ipcRenderer.invoke('kovan:usage'),
  onUsage: (listener: (records: unknown[]) => void) => {
    const handler = (_event: unknown, records: unknown[]) => listener(records);
    ipcRenderer.on('kovan:usage', handler);
    return () => ipcRenderer.removeListener('kovan:usage', handler);
  },
  runningAgents: () => ipcRenderer.invoke('kovan:running-agents'),
  runningAgentsWatch: (on: boolean) => ipcRenderer.invoke('kovan:running-agents-watch', on),
  runningAgentsStop: (keys: string[], children: boolean) => ipcRenderer.invoke('kovan:running-agents-stop', keys, children),
  runningAgentsForce: (key: string) => ipcRenderer.invoke('kovan:running-agents-force', key),
  onRunningAgents: (listener: (report: unknown) => void) => {
    const handler = (_event: unknown, report: unknown) => listener(report);
    ipcRenderer.on('kovan:running-agents', handler);
    return () => ipcRenderer.removeListener('kovan:running-agents', handler);
  },
  /** The Dock menu picked a workspace, or a folder in one (item 135). */
  onOpenWorkspace: (listener: (id: string, folder?: string) => void) => {
    const handler = (_event: unknown, id: string, folder?: string) => listener(id, folder);
    ipcRenderer.on('kovan:open-workspace', handler);
    // One picked while no window was open waits in main until now.
    void ipcRenderer.invoke('kovan:open-workspace-pending').then((p?: { id: string; folder?: string }) => {
      if (p) listener(p.id, p.folder);
    });
    return () => ipcRenderer.removeListener('kovan:open-workspace', handler);
  },
  /** The pane beside Claude asked to open a file's diff (item 148). */
  onOpenDiff: (listener: (target: { repo: string; file: string; side: 'staged' | 'unstaged' | 'untracked' }) => void) => {
    const handler = (_event: unknown, target: { repo: string; file: string; side: 'staged' | 'unstaged' | 'untracked' }) => listener(target);
    ipcRenderer.on('kovan:open-diff', handler);
    // One asked for while no window was open waits in main until now.
    void ipcRenderer.invoke('kovan:open-diff-pending').then((p?: { repo: string; file: string; side: 'staged' | 'unstaged' | 'untracked' }) => {
      if (p) listener(p);
    });
    return () => ipcRenderer.removeListener('kovan:open-diff', handler);
  },
  onShowAgents: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('kovan:show-agents', handler);
    return () => ipcRenderer.removeListener('kovan:show-agents', handler);
  },
  onQuickJobs: (listener: (jobs: unknown[]) => void) => {
    const handler = (_e: unknown, jobs: unknown[]) => listener(jobs);
    ipcRenderer.on('kovan:quick-jobs', handler);
    return () => ipcRenderer.removeListener('kovan:quick-jobs', handler);
  },
  onQuick: (listener: (kind: string, subject: string, state: unknown) => void) => {
    const handler = (_e: unknown, kind: string, subject: string, state: unknown) => listener(kind, subject, state);
    ipcRenderer.on('kovan:quick', handler);
    return () => ipcRenderer.removeListener('kovan:quick', handler);
  },

  // Agents
  runners: () => ipcRenderer.invoke('kovan:runners'),
  knownModels: () => ipcRenderer.invoke('kovan:known-models'),
  modelsSearch: (command: string) => ipcRenderer.invoke('kovan:models-search', command),
  ticketStatuses: () => ipcRenderer.invoke('kovan:ticket-statuses'),
  reviewTools: () => ipcRenderer.invoke('kovan:review-tools'),
  reviewToolSave: (tool: unknown) => ipcRenderer.invoke('kovan:review-tool-save', tool),
  reviewToolRemove: (id: string) => ipcRenderer.invoke('kovan:review-tool-remove', id),
  reviewToolCandidates: () => ipcRenderer.invoke('kovan:review-tool-candidates'),
  reviewToolCheck: (command: string) => ipcRenderer.invoke('kovan:review-tool-check', command),
  reviewToolSetup: (command: string) => ipcRenderer.invoke('kovan:review-tool-setup', command),
  reviewToolSaveKey: (file: string, value: string) => ipcRenderer.invoke('kovan:review-tool-save-key', file, value),
  reviewToolTest: (tool: unknown) => ipcRenderer.invoke('kovan:review-tool-test', tool),
  clipboardImagePath: () => ipcRenderer.invoke('kovan:clipboard-image'),
  copyText: (text: string) => ipcRenderer.invoke('kovan:clipboard-write', text),
  // Electron 32 took `File.path` away; this is its replacement, and it has
  // to run here, where the File object still is.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  modelsSearchCancel: () => ipcRenderer.invoke('kovan:models-search-cancel'),
  runTargets: (force?: boolean) => ipcRenderer.invoke('kovan:run-targets', force),
  buildPrompt: (kind: string, subject: unknown, test?: unknown) =>
    ipcRenderer.invoke('kovan:build-prompt', kind, subject, test),
  testEnvironments: () => ipcRenderer.invoke('kovan:test-environments'),
  testEnvironmentsSave: (next: unknown) => ipcRenderer.invoke('kovan:test-environments-save', next),
  ticketPulls: (key: string) => ipcRenderer.invoke('kovan:ticket-pulls', key),
  defaultCwd: (repo?: string) => ipcRenderer.invoke('kovan:default-cwd', repo),
  startAgent: (request: unknown, subject: unknown) =>
    ipcRenderer.invoke('kovan:start-agent', request, subject),
  runHistory: (subject: string) => ipcRenderer.invoke('kovan:run-history', subject),
  sentryFrames: (issueId: string) => ipcRenderer.invoke('kovan:sentry-frames', issueId),
  sentryCreateTicket: (issue: unknown) => ipcRenderer.invoke('kovan:sentry-create-ticket', issue),
  runFiles: (directory: string) => ipcRenderer.invoke('kovan:run-files', directory),
  runText: (file: string) => ipcRenderer.invoke('kovan:run-text', file),
  runImage: (file: string) => ipcRenderer.invoke('kovan:run-image', file),
  runReveal: (file: string) => ipcRenderer.invoke('kovan:run-reveal', file),
  runWatch: (directory: string, on: boolean) => ipcRenderer.invoke('kovan:run-watch', directory, on),
  agentLimits: () => ipcRenderer.invoke('kovan:agent-limits'),
  runSiteOpen: (directory: string, shot?: string) => ipcRenderer.invoke('kovan:run-site-open', directory, shot),
  onRunChanged: (listener: (directory: string) => void) => {
    const handler = (_event: unknown, directory: string) => listener(directory);
    ipcRenderer.on('kovan:run-changed', handler);
    return () => ipcRenderer.removeListener('kovan:run-changed', handler);
  },

  // Quick commands (item 91)
  commands: () => ipcRenderer.invoke('kovan:commands'),
  commandSave: (input: { id?: string; name: string; command: string; cwd: string }) =>
    ipcRenderer.invoke('kovan:command-save', input),
  commandDuplicate: (id: string) => ipcRenderer.invoke('kovan:command-duplicate', id),
  commandDelete: (id: string) => ipcRenderer.invoke('kovan:command-delete', id),
  commandRun: (id: string) => ipcRenderer.invoke('kovan:command-run', id),
  commandFolder: () => ipcRenderer.invoke('kovan:command-folder'),

  // Dictation (item 88)
  dictationStart: () => ipcRenderer.invoke('kovan:dictation-start'),
  dictationStop: () => ipcRenderer.invoke('kovan:dictation-stop'),
  dictationCancel: () => ipcRenderer.invoke('kovan:dictation-cancel'),
  dictationStatus: (refresh?: boolean) => ipcRenderer.invoke('kovan:dictation-status', refresh === true),
  speechSetup: () => ipcRenderer.invoke('kovan:speech-setup'),
  quickOpenFiles: (force?: boolean) => ipcRenderer.invoke('kovan:quick-open-files', force === true),
  speechKey: (provider: string, key: string) => ipcRenderer.invoke('kovan:speech-key', provider, key),
  speechTest: (provider: string) => ipcRenderer.invoke('kovan:speech-test', provider),
  speechPickModel: () => ipcRenderer.invoke('kovan:speech-pick-model'),
  privacyOpen: (pane: 'mic' | 'speech') => ipcRenderer.invoke('kovan:privacy-open', pane),
  onDictation: (listener: (event: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on('kovan:dictation', handler);
    return () => ipcRenderer.removeListener('kovan:dictation', handler);
  },

  // Activity inbox (item 86)
  activity: () => ipcRenderer.invoke('kovan:activity'),
  activityRead: (ids: string[] | 'all') => ipcRenderer.invoke('kovan:activity-read', ids),
  onActivity: (listener: (inbox: unknown) => void) => {
    const handler = (_event: unknown, inbox: unknown) => listener(inbox);
    ipcRenderer.on('kovan:activity', handler);
    return () => ipcRenderer.removeListener('kovan:activity', handler);
  },
  onActivityToast: (listener: (events: unknown) => void) => {
    const handler = (_event: unknown, events: unknown) => listener(events);
    ipcRenderer.on('kovan:activity-toast', handler);
    return () => ipcRenderer.removeListener('kovan:activity-toast', handler);
  },
  onActivityOpen: (listener: (subject: string) => void) => {
    const handler = (_event: unknown, subject: string) => listener(subject);
    ipcRenderer.on('kovan:activity-open', handler);
    return () => ipcRenderer.removeListener('kovan:activity-open', handler);
  },

  // Connection problems (item 120)
  problems: () => ipcRenderer.invoke('kovan:problems'),
  onProblems: (listener: (update: unknown) => void) => {
    const handler = (_event: unknown, update: unknown) => listener(update);
    ipcRenderer.on('kovan:problems', handler);
    return () => ipcRenderer.removeListener('kovan:problems', handler);
  },

  // Log (item 83)
  logError: (report: unknown) => ipcRenderer.invoke('kovan:error-log', report),
  revealLog: () => ipcRenderer.invoke('kovan:log-reveal'),

  // Workspace
  workspaces: () => ipcRenderer.invoke('kovan:workspaces'),
  workspaceCreate: () => ipcRenderer.invoke('kovan:workspace-create'),
  workspaceActivate: (id: string) => ipcRenderer.invoke('kovan:workspace-activate', id),
  newWindow: () => ipcRenderer.invoke('kovan:window-new'),
  workspaceAddFolder: (id: string) => ipcRenderer.invoke('kovan:workspace-add-folder', id),
  workspaceRemoveFolder: (id: string, folder: string) =>
    ipcRenderer.invoke('kovan:workspace-remove-folder', id, folder),
  workspaceReorder: (id: string, folders: string[]) =>
    ipcRenderer.invoke('kovan:workspace-reorder', id, folders),
  workspaceForget: (id: string) => ipcRenderer.invoke('kovan:workspace-forget', id),
  workspaceRepos: (id: string, force?: boolean) =>
    ipcRenderer.invoke('kovan:workspace-repos', id, force),
  workspaceRoots: (id: string, force?: boolean) =>
    ipcRenderer.invoke('kovan:workspace-roots', id, force),
  workspaceRename: (id: string, name: string) =>
    ipcRenderer.invoke('kovan:workspace-rename', id, name),
  workspaceStatus: (repo: string) => ipcRenderer.invoke('kovan:workspace-status', repo),
  workspaceDiff: (repo: string, file: string, side: string, from?: string, context?: number) =>
    ipcRenderer.invoke('kovan:workspace-diff', repo, file, side, from, context),
  workspaceRevert: (repo: string, changes: unknown[]) =>
    ipcRenderer.invoke('kovan:workspace-revert', repo, changes),
  workspaceTree: (dir: string) => ipcRenderer.invoke('kovan:workspace-tree', dir),
  workspaceRead: (file: string) => ipcRenderer.invoke('kovan:workspace-read', file),
  workspaceImage: (file: string) => ipcRenderer.invoke('kovan:workspace-image', file),
  workspaceWrite: (file: string, text: string, expected?: unknown) =>
    ipcRenderer.invoke('kovan:workspace-write', file, text, expected),

  // Terminals
  sessions: () => ipcRenderer.invoke('kovan:sessions'),
  sessionBuffer: (id: string) => ipcRenderer.invoke('kovan:session-buffer', id),
  sessionWrite: (id: string, data: string) => ipcRenderer.invoke('kovan:session-write', id, data),
  sessionResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('kovan:session-resize', id, cols, rows),
  sessionClose: (id: string) => ipcRenderer.invoke('kovan:session-close', id),
  sessionRename: (id: string, title: string) => ipcRenderer.invoke('kovan:session-rename', id, title),
  shells: () => ipcRenderer.invoke('kovan:shells'),
  openTerminal: (cwd?: string, subject?: string, title?: string) =>
    ipcRenderer.invoke('kovan:open-terminal', cwd, subject, title),
  onSessionOutput: (listener: (id: string, data: string) => void) => {
    const handler = (_e: unknown, id: string, data: string) => listener(id, data);
    ipcRenderer.on('kovan:session-output', handler);
    return () => ipcRenderer.removeListener('kovan:session-output', handler);
  },
  onSessions: (listener: (list: unknown[]) => void) => {
    const handler = (_e: unknown, list: unknown[]) => listener(list);
    ipcRenderer.on('kovan:sessions', handler);
    return () => ipcRenderer.removeListener('kovan:sessions', handler);
  },
  onFontSizeStep: (listener: (step: number) => void) => {
    const handler = (_e: unknown, step: number) => listener(step);
    ipcRenderer.on('kovan:font-size-step', handler);
    return () => ipcRenderer.removeListener('kovan:font-size-step', handler);
  }
};

contextBridge.exposeInMainWorld('kovan', api);

export type KovanApi = typeof api;
