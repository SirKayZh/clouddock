import { contextBridge, ipcRenderer } from 'electron';
import type { Account, AppState } from './types';

contextBridge.exposeInMainWorld('api', {
  list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
  add: (name: string, note: string): Promise<Account> =>
    ipcRenderer.invoke('accounts:add', name, note),
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('accounts:remove', id),
  rename: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('accounts:rename', id, name),
  switch: (id: string): Promise<boolean> => ipcRenderer.invoke('accounts:switch', id),
  nav: (action: 'back' | 'forward' | 'reload' | 'stop' | 'home'): Promise<void> =>
    ipcRenderer.invoke('nav:action', action),
  openUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('nav:url', url),
  onState: (cb: (state: AppState) => void): void => {
    ipcRenderer.on('state:update', (_event, state: AppState) => cb(state));
  },
});
