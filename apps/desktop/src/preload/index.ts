/**
 * The only bridge between the renderer and the main process.
 *
 * Nothing here exposes `ipcRenderer` itself, and no channel returns a secret —
 * tokens go in through `setSecret` and never come back out. The renderer
 * therefore cannot leak a credential even if something on a detail page
 * manages to run.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  snapshot: () => ipcRenderer.invoke('baton:snapshot'),
  refresh: () => ipcRenderer.invoke('baton:refresh'),
  refreshProvider: (id: string) => ipcRenderer.invoke('baton:refresh-provider', id),
  openExternal: (url: string) => ipcRenderer.invoke('baton:open-external', url),
  credentialFields: () => ipcRenderer.invoke('baton:credential-fields'),
  missingFields: (id: string) => ipcRenderer.invoke('baton:missing-fields', id),
  loadMoreMerged: (limit: number) => ipcRenderer.invoke('baton:merged-more', limit),
  settings: () => ipcRenderer.invoke('baton:settings'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('baton:set-setting', key, value),
  setSecret: (key: string, value: string) => ipcRenderer.invoke('baton:set-secret', key, value),
  onSnapshot: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on('baton:snapshot', handler);
    return () => ipcRenderer.removeListener('baton:snapshot', handler);
  },

  // Detail
  pullDetail: (repo: string, number: number) =>
    ipcRenderer.invoke('baton:pull-detail', repo, number),
  ticketDetail: (key: string) => ipcRenderer.invoke('baton:ticket-detail', key),

  // Quick model
  quickState: (kind: string, subject: string) => ipcRenderer.invoke('baton:quick-state', kind, subject),
  quickRun: (kind: string, subject: string) => ipcRenderer.invoke('baton:quick-run', kind, subject),
  quickCancel: (kind: string, subject: string) => ipcRenderer.invoke('baton:quick-cancel', kind, subject),
  quickDismiss: (kind: string, subject: string) => ipcRenderer.invoke('baton:quick-dismiss', kind, subject),
  quickTest: (model?: string) => ipcRenderer.invoke('baton:quick-test', model),
  quickJobs: () => ipcRenderer.invoke('baton:quick-jobs'),
  quickJobRemove: (id: string) => ipcRenderer.invoke('baton:quick-job-remove', id),
  reviewSubmit: (subject: string, event: string) => ipcRenderer.invoke('baton:review-submit', subject, event),
  usage: () => ipcRenderer.invoke('baton:usage'),
  onUsage: (listener: (records: unknown[]) => void) => {
    const handler = (_event: unknown, records: unknown[]) => listener(records);
    ipcRenderer.on('baton:usage', handler);
    return () => ipcRenderer.removeListener('baton:usage', handler);
  },
  runningAgents: () => ipcRenderer.invoke('baton:running-agents'),
  runningAgentsWatch: (on: boolean) => ipcRenderer.invoke('baton:running-agents-watch', on),
  runningAgentsStop: (keys: string[], children: boolean) => ipcRenderer.invoke('baton:running-agents-stop', keys, children),
  runningAgentsForce: (key: string) => ipcRenderer.invoke('baton:running-agents-force', key),
  onRunningAgents: (listener: (report: unknown) => void) => {
    const handler = (_event: unknown, report: unknown) => listener(report);
    ipcRenderer.on('baton:running-agents', handler);
    return () => ipcRenderer.removeListener('baton:running-agents', handler);
  },
  onShowAgents: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('baton:show-agents', handler);
    return () => ipcRenderer.removeListener('baton:show-agents', handler);
  },
  onQuickJobs: (listener: (jobs: unknown[]) => void) => {
    const handler = (_e: unknown, jobs: unknown[]) => listener(jobs);
    ipcRenderer.on('baton:quick-jobs', handler);
    return () => ipcRenderer.removeListener('baton:quick-jobs', handler);
  },
  onQuick: (listener: (kind: string, subject: string, state: unknown) => void) => {
    const handler = (_e: unknown, kind: string, subject: string, state: unknown) => listener(kind, subject, state);
    ipcRenderer.on('baton:quick', handler);
    return () => ipcRenderer.removeListener('baton:quick', handler);
  },

  // Agents
  runners: () => ipcRenderer.invoke('baton:runners'),
  knownModels: () => ipcRenderer.invoke('baton:known-models'),
  runTargets: (force?: boolean) => ipcRenderer.invoke('baton:run-targets', force),
  buildPrompt: (kind: string, subject: unknown) =>
    ipcRenderer.invoke('baton:build-prompt', kind, subject),
  defaultCwd: (repo?: string) => ipcRenderer.invoke('baton:default-cwd', repo),
  startAgent: (request: unknown, subject: unknown) =>
    ipcRenderer.invoke('baton:start-agent', request, subject),
  runHistory: (subject: string) => ipcRenderer.invoke('baton:run-history', subject),
  sentryFrames: (issueId: string) => ipcRenderer.invoke('baton:sentry-frames', issueId),
  sentryCreateTicket: (issue: unknown) => ipcRenderer.invoke('baton:sentry-create-ticket', issue),
  runFiles: (directory: string) => ipcRenderer.invoke('baton:run-files', directory),
  runText: (file: string) => ipcRenderer.invoke('baton:run-text', file),
  runImage: (file: string) => ipcRenderer.invoke('baton:run-image', file),

  // Workspace
  workspaces: () => ipcRenderer.invoke('baton:workspaces'),
  workspaceCreate: () => ipcRenderer.invoke('baton:workspace-create'),
  workspaceActivate: (id: string) => ipcRenderer.invoke('baton:workspace-activate', id),
  workspaceAddFolder: (id: string) => ipcRenderer.invoke('baton:workspace-add-folder', id),
  workspaceRemoveFolder: (id: string, folder: string) =>
    ipcRenderer.invoke('baton:workspace-remove-folder', id, folder),
  workspaceForget: (id: string) => ipcRenderer.invoke('baton:workspace-forget', id),
  workspaceRepos: (id: string, force?: boolean) =>
    ipcRenderer.invoke('baton:workspace-repos', id, force),
  workspaceRoots: (id: string, force?: boolean) =>
    ipcRenderer.invoke('baton:workspace-roots', id, force),
  workspaceRename: (id: string, name: string) =>
    ipcRenderer.invoke('baton:workspace-rename', id, name),
  workspaceStatus: (repo: string) => ipcRenderer.invoke('baton:workspace-status', repo),
  workspaceDiff: (repo: string, file: string, side: string, from?: string) =>
    ipcRenderer.invoke('baton:workspace-diff', repo, file, side, from),
  workspaceRevert: (repo: string, changes: unknown[]) =>
    ipcRenderer.invoke('baton:workspace-revert', repo, changes),
  workspaceTree: (dir: string) => ipcRenderer.invoke('baton:workspace-tree', dir),
  workspaceRead: (file: string) => ipcRenderer.invoke('baton:workspace-read', file),
  workspaceWrite: (file: string, text: string, expected?: unknown) =>
    ipcRenderer.invoke('baton:workspace-write', file, text, expected),

  // Terminals
  sessions: () => ipcRenderer.invoke('baton:sessions'),
  sessionBuffer: (id: string) => ipcRenderer.invoke('baton:session-buffer', id),
  sessionWrite: (id: string, data: string) => ipcRenderer.invoke('baton:session-write', id, data),
  sessionResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('baton:session-resize', id, cols, rows),
  sessionClose: (id: string) => ipcRenderer.invoke('baton:session-close', id),
  sessionRename: (id: string, title: string) => ipcRenderer.invoke('baton:session-rename', id, title),
  openTerminal: (cwd?: string, subject?: string, title?: string) =>
    ipcRenderer.invoke('baton:open-terminal', cwd, subject, title),
  onSessionOutput: (listener: (id: string, data: string) => void) => {
    const handler = (_e: unknown, id: string, data: string) => listener(id, data);
    ipcRenderer.on('baton:session-output', handler);
    return () => ipcRenderer.removeListener('baton:session-output', handler);
  },
  onSessions: (listener: (list: unknown[]) => void) => {
    const handler = (_e: unknown, list: unknown[]) => listener(list);
    ipcRenderer.on('baton:sessions', handler);
    return () => ipcRenderer.removeListener('baton:sessions', handler);
  },
  onFontSizeStep: (listener: (step: number) => void) => {
    const handler = (_e: unknown, step: number) => listener(step);
    ipcRenderer.on('baton:font-size-step', handler);
    return () => ipcRenderer.removeListener('baton:font-size-step', handler);
  }
};

contextBridge.exposeInMainWorld('baton', api);

export type BatonApi = typeof api;
