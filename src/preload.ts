import { contextBridge, ipcRenderer } from 'electron';
import type { Account, AppState, Berth } from './types';

contextBridge.exposeInMainWorld('api', {
  list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
  add: (name?: string, note?: string): Promise<Account> =>
    ipcRenderer.invoke('accounts:add', name, note),
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('accounts:remove', id),
  rename: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('accounts:rename', id, name),
  switch: (id: string): Promise<boolean> => ipcRenderer.invoke('accounts:switch', id),
  berthsList: (): Promise<Berth[]> => ipcRenderer.invoke('berths:list'),
  berthAdd: (name: string, icon?: string): Promise<Berth | null> =>
    ipcRenderer.invoke('berths:add', name, icon),
  berthRename: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('berths:rename', id, name),
  berthRemove: (id: string): Promise<boolean> => ipcRenderer.invoke('berths:remove', id),
  berthSwitch: (id: string): Promise<boolean> => ipcRenderer.invoke('berths:switch', id),
  berthMenu: (id: string): Promise<void> => ipcRenderer.invoke('berths:menu', id),
  newTab: (url?: string): Promise<boolean> => ipcRenderer.invoke('tabs:new', url),
  closeTab: (tabId: string): Promise<boolean> => ipcRenderer.invoke('tabs:close', tabId),
  switchTab: (tabId: string): Promise<boolean> => ipcRenderer.invoke('tabs:switch', tabId),
  nav: (action: 'back' | 'forward' | 'reload' | 'stop' | 'home'): Promise<void> =>
    ipcRenderer.invoke('nav:action', action),
  openUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('nav:url', url),
  credSave: (): Promise<boolean> => ipcRenderer.invoke('cred:save'),
  credDismiss: (never: boolean): Promise<boolean> => ipcRenderer.invoke('cred:dismiss', never),
  /** 崩溃恢复横幅的用户选择：true=恢复上次会话，false=重新开始 */
  resolveCrash: (restore: boolean): Promise<boolean> => ipcRenderer.invoke('crash:resolve', restore),
  toggleSidebar: (collapsed?: boolean): Promise<boolean> => ipcRenderer.invoke('ui:sidebar', collapsed),
  focusUi: (): Promise<void> => ipcRenderer.invoke('ui:focus'),
  accountMenu: (id: string): Promise<void> => ipcRenderer.invoke('accounts:menu', id),
  onRenameStart: (cb: (id: string) => void): void => {
    ipcRenderer.on('rename:start', (_event, id: unknown) => cb(String(id)));
  },
  onBerthRenameStart: (cb: (id: string) => void): void => {
    ipcRenderer.on('berth:rename-start', (_event, id: unknown) => cb(String(id)));
  },
  onState: (cb: (state: AppState) => void): void => {
    ipcRenderer.on('state:update', (_event, state: AppState) => cb(state));
  },
});
