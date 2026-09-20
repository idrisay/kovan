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
  openExternal: (url: string) => ipcRenderer.invoke('baton:open-external', url),
  credentialFields: () => ipcRenderer.invoke('baton:credential-fields'),
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

  // Agents
  runners: () => ipcRenderer.invoke('baton:runners'),
  runTargets: (force?: boolean) => ipcRenderer.invoke('baton:run-targets', force),
  buildPrompt: (kind: string, subject: unknown) =>
    ipcRenderer.invoke('baton:build-prompt', kind, subject),
  defaultCwd: (repo?: string) => ipcRenderer.invoke('baton:default-cwd', repo),
  startAgent: (request: unknown, subject: unknown) =>
    ipcRenderer.invoke('baton:start-agent', request, subject),
  runHistory: (subject: string) => ipcRenderer.invoke('baton:run-history', subject),

  // Terminals
  sessions: () => ipcRenderer.invoke('baton:sessions'),
  sessionBuffer: (id: string) => ipcRenderer.invoke('baton:session-buffer', id),
  sessionWrite: (id: string, data: string) => ipcRenderer.invoke('baton:session-write', id, data),
  sessionResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('baton:session-resize', id, cols, rows),
  sessionClose: (id: string) => ipcRenderer.invoke('baton:session-close', id),
  openTerminal: (cwd?: string) => ipcRenderer.invoke('baton:open-terminal', cwd),
  onSessionOutput: (listener: (id: string, data: string) => void) => {
    const handler = (_e: unknown, id: string, data: string) => listener(id, data);
    ipcRenderer.on('baton:session-output', handler);
    return () => ipcRenderer.removeListener('baton:session-output', handler);
  },
  onSessions: (listener: (list: unknown[]) => void) => {
    const handler = (_e: unknown, list: unknown[]) => listener(list);
    ipcRenderer.on('baton:sessions', handler);
    return () => ipcRenderer.removeListener('baton:sessions', handler);
  }
};

contextBridge.exposeInMainWorld('baton', api);

export type BatonApi = typeof api;
