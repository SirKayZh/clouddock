import { contextBridge, ipcRenderer } from 'electron';

export interface FindbarInit {
  /** 上次搜索词（跨标签页保留，Chrome 行为） */
  text: string;
}

export interface FindbarMatches {
  active: number;
  total: number;
}

/** 页内查找浮层（盖在网页视图右上角的小视图）可用的受限 API */
contextBridge.exposeInMainWorld('findbarApi', {
  onInit: (cb: (init: FindbarInit) => void): void => {
    ipcRenderer.on('findbar:init', (_e, init: FindbarInit) => cb(init));
  },
  onMatches: (cb: (m: FindbarMatches) => void): void => {
    ipcRenderer.on('findbar:matches', (_e, m: FindbarMatches) => cb(m));
  },
  query: (text: string, forward: boolean, findNext: boolean): Promise<void> =>
    ipcRenderer.invoke('find:query', text, forward, findNext),
  close: (): Promise<void> => ipcRenderer.invoke('find:close'),
  ready: (): Promise<void> => ipcRenderer.invoke('findbar:ready'),
});
