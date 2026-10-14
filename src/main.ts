import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  shell,
  Menu,
  dialog,
} from 'electron';
import type { Rectangle, WebContents, Session, MenuItemConstructorOptions } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Account, AppState } from './types';

const HOME_URL = 'https://console.cloud.tencent.com/';
const SIDEBAR_W = 232;
const TOPBAR_H = 52;
const PALETTE = [
  '#0052D9', '#00A870', '#ED7B2F', '#7B61FF',
  '#E3737B', '#029BE5', '#B58A00', '#2E7D32',
];

let win: BrowserWindow | null = null;
const views = new Map<string, WebContentsView>();
let accounts: Account[] = [];
let activeId: string | null = null;

/* ---------- 测试支持：自定义数据目录 ---------- */
if (process.env.CLOUDDOCK_DATA_DIR) {
  app.setPath('userData', process.env.CLOUDDOCK_DATA_DIR);
}

/* ---------- 账号持久化 ---------- */

function accountsFile(): string {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function loadAccounts(): void {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(accountsFile(), 'utf-8'));
    if (Array.isArray(data)) {
      accounts = data.filter(
        (a): a is Account =>
          !!a && typeof (a as Account).id === 'string' && typeof (a as Account).name === 'string',
      );
    }
  } catch {
    accounts = [];
  }
}

function saveAccounts(): void {
  const file = accountsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(accounts, null, 2), 'utf-8');
}

/* ---------- 布局 ---------- */

function viewBounds(): Rectangle {
  if (!win) return { x: 0, y: 0, width: 0, height: 0 };
  const [cw, ch] = win.getContentSize();
  return {
    x: SIDEBAR_W,
    y: TOPBAR_H,
    width: Math.max(0, cw - SIDEBAR_W),
    height: Math.max(0, ch - TOPBAR_H),
  };
}

function layoutViews(): void {
  const b = viewBounds();
  for (const view of views.values()) view.setBounds(b);
}

function activeWc(): WebContents | null {
  if (!activeId) return null;
  return views.get(activeId)?.webContents ?? null;
}

function sendState(): void {
  if (!win || win.isDestroyed()) return;
  const wc = activeWc();
  const state: AppState = {
    accounts,
    activeId,
    url: wc ? wc.getURL() : '',
    title: wc ? wc.getTitle() : '',
    canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
    canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
    isLoading: wc ? wc.isLoading() : false,
  };
  win.webContents.send('state:update', state);
}

/* ---------- 账号视图 ---------- */

function createAccountView(acc: Account): WebContentsView {
  const ses = session.fromPartition(`persist:clouddock-${acc.id}`);
  // 去掉 UA 中的 Electron 标识，避免登录链路 UA 校验问题
  const ua = ses.getUserAgent().replace(/Electron\/[\d.]+\s*/i, '');
  ses.setUserAgent(ua);
  applyPermissionPolicy(ses);

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wc = view.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // ⌘1~⌘9 快速切换账号（仅拦截数字键，其余交给应用菜单）
  wc.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || !input.meta) return;
    const m = /^Digit([1-9])$/.exec(input.code);
    if (m) {
      const target = accounts[Number(m[1]) - 1];
      if (target) switchAccount(target.id);
    }
  });

  const refresh = (): void => {
    if (acc.id === activeId) sendState();
  };
  wc.on('did-navigate', refresh);
  wc.on('did-navigate-in-page', refresh);
  wc.on('did-start-loading', refresh);
  wc.on('did-stop-loading', refresh);
  wc.on('page-title-updated', refresh);

  views.set(acc.id, view);
  if (win) {
    win.contentView.addChildView(view);
    view.setBounds(viewBounds());
    view.setVisible(false);
  }
  void wc.loadURL(HOME_URL);
  return view;
}

function ensureView(acc: Account): WebContentsView {
  return views.get(acc.id) ?? createAccountView(acc);
}

function switchAccount(id: string): boolean {
  if (!win) return false;
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return false;
  const view = ensureView(acc);
  for (const [vid, v] of views) v.setVisible(vid === id);
  view.setBounds(viewBounds());
  activeId = id;
  view.webContents.focus();
  sendState();
  return true;
}

async function removeAccount(id: string): Promise<boolean> {
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0 || !win) return false;
  const acc = accounts[idx];
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `删除账号「${acc.name}」？`,
    detail: '将同时清除该账号的登录 Cookie 与本地缓存，重新添加后需重新登录。',
  });
  if (choice.response !== 0) return false;

  accounts.splice(idx, 1);
  saveAccounts();

  const view = views.get(id);
  if (view) {
    win.contentView.removeChildView(view);
    views.delete(id);
    view.webContents.close();
  }
  const ses = session.fromPartition(`persist:clouddock-${id}`);
  await ses.clearStorageData();
  await ses.clearCache();

  if (activeId === id) {
    activeId = null;
    if (accounts.length > 0) {
      switchAccount(accounts[0].id);
    } else {
      win.webContents.focus();
      sendState();
    }
  } else {
    sendState();
  }
  return true;
}

/* ---------- IPC ---------- */

function registerIpc(): void {
  ipcMain.handle('accounts:list', () => accounts);

  ipcMain.handle('accounts:add', (_e, name: unknown, note: unknown): Account => {
    const acc: Account = {
      id: randomBytes(6).toString('hex'),
      name: String(name ?? '').trim().slice(0, 30) || `账号 ${accounts.length + 1}`,
      note: String(note ?? '').trim().slice(0, 60),
      color: PALETTE[accounts.length % PALETTE.length],
      createdAt: Date.now(),
    };
    accounts.push(acc);
    saveAccounts();
    switchAccount(acc.id);
    return acc;
  });

  ipcMain.handle('accounts:remove', (_e, id: unknown) => removeAccount(String(id)));

  ipcMain.handle('accounts:rename', (_e, id: unknown, name: unknown): boolean => {
    const acc = accounts.find((a) => a.id === String(id));
    if (!acc) return false;
    const n = String(name ?? '').trim().slice(0, 30);
    if (!n) return false;
    acc.name = n;
    saveAccounts();
    sendState();
    return true;
  });

  ipcMain.handle('accounts:switch', (_e, id: unknown): boolean => switchAccount(String(id)));

  ipcMain.handle('nav:action', (_e, action: unknown): void => {
    const wc = activeWc();
    if (!wc) return;
    switch (String(action)) {
      case 'back':
        wc.goBack();
        break;
      case 'forward':
        wc.goForward();
        break;
      case 'reload':
        wc.reload();
        break;
      case 'stop':
        wc.stop();
        break;
      case 'home':
        void wc.loadURL(HOME_URL);
        break;
      default:
        break;
    }
  });

  ipcMain.handle('nav:url', (_e, raw: unknown): boolean => {
    const wc = activeWc();
    if (!wc) return false;
    let url = String(raw ?? '').trim();
    if (!url) return false;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      void wc.loadURL(u.toString());
      return true;
    } catch {
      return false;
    }
  });
}

/* ---------- 菜单 ---------- */

function buildMenu(): void {
  const zoom = (delta: number): void => {
    const wc = activeWc();
    if (!wc) return;
    const next = delta === 0 ? 1 : Math.min(3, Math.max(0.5, wc.getZoomFactor() + delta));
    wc.setZoomFactor(next);
  };
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { label: '刷新当前账号页面', accelerator: 'CmdOrCtrl+R', click: () => activeWc()?.reload() },
        { label: '后退', accelerator: 'CmdOrCtrl+[', click: () => activeWc()?.goBack() },
        { label: '前进', accelerator: 'CmdOrCtrl+]', click: () => activeWc()?.goForward() },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.1) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        {
          label: '开发者工具（当前账号）',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => activeWc()?.openDevTools({ mode: 'bottom' }),
        },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 窗口 ---------- */

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: '#F5F7FA',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  win.once('ready-to-show', () => win?.show());

  const relayout = (): void => layoutViews();
  win.on('resize', relayout);
  win.on('enter-full-screen', relayout);
  win.on('leave-full-screen', relayout);
  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('did-finish-load', () => {
    if (activeId === null && accounts.length > 0) {
      switchAccount(accounts[0].id);
    } else {
      sendState();
    }
  });
}

/* ---------- 应用生命周期 ---------- */

/* ---------- 权限策略（session 级） ---------- */

function applyPermissionPolicy(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = new Set([
      'clipboard-read',
      'clipboard-sanitized-write',
      'notifications',
      'fullscreen',
      'pointerLock',
      'media',
    ]);
    callback(allowed.has(permission));
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadAccounts();
    registerIpc();
    buildMenu();
    applyPermissionPolicy(session.defaultSession);
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
