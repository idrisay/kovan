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
  }
};

contextBridge.exposeInMainWorld('baton', api);

export type BatonApi = typeof api;
