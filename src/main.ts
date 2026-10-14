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
import type { Account, AppState, Tab } from './types';

const HOME_URL = 'https://console.cloud.tencent.com/';
const SIDEBAR_W = 232;
const TOPBAR_H = 52;
const TABBAR_H = 36;
const PALETTE = [
  '#0052D9', '#00A870', '#ED7B2F', '#7B61FF',
  '#E3737B', '#029BE5', '#B58A00', '#2E7D32',
];

let win: BrowserWindow | null = null;
/** key: tabId —— 每个 tab 一个视图；同账号的所有 tab 共享同一 partition（登录态） */
const views = new Map<string, WebContentsView>();
let accounts: Account[] = [];
let activeId: string | null = null;

/* ---------- 测试支持：自定义数据目录 ---------- */
if (process.env.CLOUDDOCK_DATA_DIR) {
  app.setPath('userData', process.env.CLOUDDOCK_DATA_DIR);
}

/* ---------- 持久化 ---------- */

function accountsFile(): string {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function uiFile(): string {
  return path.join(app.getPath('userData'), 'ui.json');
}

/** 原子写：先写临时文件再 rename，避免崩溃/断电写一半导致账号列表损坏丢失 */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

function saveAccountsNow(): void {
  try {
    const file = accountsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(accounts, null, 2));
    if (activeId) writeFileAtomic(uiFile(), JSON.stringify({ activeId }));
  } catch (err) {
    console.error('[clouddock] save failed:', err);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
/** 防抖保存（页面导航/标题变化频繁触发） */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveAccountsNow();
  }, 500);
}

function isHttpUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

/** 对磁盘读入的数据做结构/类型校验，脏数据不会拖垮渲染或会话分区 */
function sanitizeAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<Account>;
  if (typeof a.id !== 'string' || !/^[\w-]{1,64}$/.test(a.id)) return null;
  if (typeof a.name !== 'string') return null;
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  if (Array.isArray(a.tabs)) {
    for (const t of a.tabs as unknown[]) {
      if (!t || typeof t !== 'object') continue;
      const tt = t as Partial<Tab>;
      if (typeof tt.id !== 'string' || !tt.id || seen.has(tt.id)) continue;
      seen.add(tt.id);
      tabs.push({
        id: tt.id,
        url: isHttpUrl(tt.url) ? tt.url : HOME_URL,
        title: typeof tt.title === 'string' ? tt.title : '',
      });
    }
  }
  return {
    id: a.id,
    name: a.name.slice(0, 30) || '未命名',
    note: typeof a.note === 'string' ? a.note.slice(0, 60) : '',
    color: typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : PALETTE[0],
    createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
    tabs,
    activeTabId: typeof a.activeTabId === 'string' ? a.activeTabId : null,
  };
}

let savedActiveId: string | null = null;

function loadAccounts(): void {
  const file = accountsFile();
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(data)) {
      accounts = data.map(sanitizeAccount).filter((a): a is Account => a !== null);
    }
  } catch (err) {
    accounts = [];
    // 文件存在但解析失败：备份损坏文件，避免下次保存时被空列表覆盖而永久丢失
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      console.error('[clouddock] accounts.json 解析失败，已备份:', err);
    }
  }
  for (const acc of accounts) ensureAccountTabs(acc);
  try {
    const ui: unknown = JSON.parse(fs.readFileSync(uiFile(), 'utf-8'));
    const id = (ui as { activeId?: unknown }).activeId;
    savedActiveId = typeof id === 'string' ? id : null;
  } catch {
    savedActiveId = null;
  }
}

/** 选一个当前使用最少的配色，避免删除账号后颜色重复 */
function pickColor(): string {
  const used = new Map<string, number>();
  for (const a of accounts) used.set(a.color, (used.get(a.color) ?? 0) + 1);
  return PALETTE.reduce((best, c) => ((used.get(c) ?? 0) < (used.get(best) ?? 0) ? c : best), PALETTE[0]);
}

/* ---------- 账号 / 标签页模型 ---------- */

function newTabRecord(url = HOME_URL, title = ''): Tab {
  return { id: randomBytes(6).toString('hex'), url, title };
}

/** 保证账号至少有一个 tab，且 activeTabId 有效（兼容 v1.0.0 旧数据迁移） */
function ensureAccountTabs(acc: Account): void {
  if (!Array.isArray(acc.tabs)) acc.tabs = [];
  if (acc.tabs.length === 0) {
    const t = newTabRecord();
    acc.tabs.push(t);
    acc.activeTabId = t.id;
  }
  if (!acc.tabs.some((t) => t.id === acc.activeTabId)) {
    acc.activeTabId = acc.tabs[0].id;
  }
}

function activeAccount(): Account | null {
  return accounts.find((a) => a.id === activeId) ?? null;
}

function activeTab(): Tab | null {
  const acc = activeAccount();
  if (!acc) return null;
  return acc.tabs.find((t) => t.id === acc.activeTabId) ?? null;
}

function findAccountByTab(tabId: string): { acc: Account; tab: Tab } | null {
  for (const acc of accounts) {
    const tab = acc.tabs.find((t) => t.id === tabId);
    if (tab) return { acc, tab };
  }
  return null;
}

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

/* ---------- 布局 ---------- */

function viewBounds(): Rectangle {
  if (!win) return { x: 0, y: 0, width: 0, height: 0 };
  const [cw, ch] = win.getContentSize();
  return {
    x: SIDEBAR_W,
    y: TOPBAR_H + TABBAR_H,
    width: Math.max(0, cw - SIDEBAR_W),
    height: Math.max(0, ch - TOPBAR_H - TABBAR_H),
  };
}

function layoutViews(): void {
  const b = viewBounds();
  for (const view of views.values()) view.setBounds(b);
}

function activeWc(): WebContents | null {
  const tab = activeTab();
  if (!tab) return null;
  return views.get(tab.id)?.webContents ?? null;
}

function sendState(): void {
  if (!win || win.isDestroyed()) return;
  const tab = activeTab();
  const wc = tab ? views.get(tab.id)?.webContents : undefined;
  const state: AppState = {
    accounts,
    activeId,
    activeTabId: tab?.id ?? null,
    url: wc ? wc.getURL() : tab?.url ?? '',
    title: wc ? wc.getTitle() : tab?.title ?? '',
    canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
    canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
    isLoading: wc ? wc.isLoading() : false,
  };
  win.webContents.send('state:update', state);
}

/* ---------- 标签页视图 ---------- */

function createTabView(acc: Account, tab: Tab): WebContentsView {
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

  // target=_blank / window.open：在【同一账号】内开新标签，共享登录态。
  // 若交给系统浏览器，会丢失该账号的会话（落到别的账号或未登录）。
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url)) {
      const isCurrent = activeId === acc.id && acc.activeTabId === tab.id;
      const activate = disposition !== 'background-tab' && isCurrent;
      // 异步执行，避免在 handler 回调里同步改动视图
      setImmediate(() => {
        if (accounts.includes(acc)) newTabForAccount(acc, url, activate);
      });
    } else if (/^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // ⌘1~⌘9 切换账号（仅拦截数字键，其余交给应用菜单）
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta) return;
    const m = /^Digit([1-9])$/.exec(input.code);
    if (m) {
      const target = accounts[Number(m[1]) - 1];
      if (target) {
        event.preventDefault();
        switchAccount(target.id);
      }
    }
  });

  // 同账号下任一 tab（含后台 tab）的标题/加载状态变化都需要刷新标签栏
  const refresh = (): void => {
    if (activeId === acc.id) sendState();
  };

  // 渲染进程崩溃自动恢复（连续崩溃 3 次后放弃，避免死循环）
  let crashCount = 0;
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    crashCount += 1;
    if (crashCount > 3) return;
    setTimeout(() => {
      if (!wc.isDestroyed()) wc.reload();
    }, 500);
  });
  wc.on('did-finish-load', () => {
    crashCount = 0;
  });
  wc.on('did-navigate', () => {
    tab.url = wc.getURL();
    scheduleSave();
    refresh();
  });
  wc.on('did-navigate-in-page', () => {
    tab.url = wc.getURL();
    scheduleSave();
    refresh();
  });
  wc.on('did-start-loading', refresh);
  wc.on('did-stop-loading', refresh);
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    scheduleSave();
    refresh();
  });

  views.set(tab.id, view);
  if (win) {
    win.contentView.addChildView(view);
    view.setBounds(viewBounds());
    view.setVisible(false);
  }
  safeLoad(wc, isHttpUrl(tab.url) ? tab.url : HOME_URL);
  return view;
}

/** loadURL 在被新导航打断（ERR_ABORTED）等情况下会 reject，吞掉避免 unhandled rejection */
function safeLoad(wc: WebContents, url: string): void {
  wc.loadURL(url).catch(() => {
    /* 导航被打断/失败：错误页由 Chromium 自行展示 */
  });
}

function ensureTabView(acc: Account, tab: Tab): WebContentsView {
  return views.get(tab.id) ?? createTabView(acc, tab);
}

function destroyTabView(tabId: string): void {
  const view = views.get(tabId);
  if (!view) return;
  if (win) win.contentView.removeChildView(view);
  views.delete(tabId);
  view.webContents.close();
}

/** 只显示指定 tab 的视图，其余全部隐藏 */
function showOnly(tabId: string): void {
  for (const [vid, v] of views) v.setVisible(vid === tabId);
}

/* ---------- 切换 ---------- */

function switchTab(tabId: string): boolean {
  const found = findAccountByTab(tabId);
  if (!found || !win) return false;
  const { acc, tab } = found;
  acc.activeTabId = tabId;
  activeId = acc.id;
  const view = ensureTabView(acc, tab);
  showOnly(tabId);
  view.setBounds(viewBounds());
  view.webContents.focus();
  scheduleSave();
  sendState();
  return true;
}

function switchAccount(id: string): boolean {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return false;
  ensureAccountTabs(acc);
  const tabId = acc.activeTabId;
  if (!tabId) return false;
  return switchTab(tabId);
}

/* ---------- 标签页操作 ---------- */

function newTabForAccount(acc: Account, url?: string, activate = true): Tab {
  ensureAccountTabs(acc);
  const t = newTabRecord(url && /^https?:/i.test(url) ? url : HOME_URL);
  acc.tabs.push(t);
  if (activate) {
    acc.activeTabId = t.id;
    switchTab(t.id);
  } else {
    // 后台标签：只记录，视图在首次激活时懒创建
    scheduleSave();
    if (activeId === acc.id) sendState();
  }
  return t;
}

function closeTab(tabId: string): boolean {
  const found = findAccountByTab(tabId);
  if (!found) return false;
  const { acc, tab } = found;
  const idx = acc.tabs.findIndex((t) => t.id === tab.id);
  if (idx < 0) return false;
  acc.tabs.splice(idx, 1);
  destroyTabView(tab.id);
  // 关掉最后一个 tab 时，自动补一个首页 tab（账号保持）
  if (acc.tabs.length === 0) {
    const t = newTabRecord();
    acc.tabs.push(t);
    acc.activeTabId = t.id;
  } else if (acc.activeTabId === tab.id) {
    acc.activeTabId = acc.tabs[Math.min(idx, acc.tabs.length - 1)].id;
  }
  if (activeId === acc.id) {
    const next = acc.activeTabId;
    if (next) switchTab(next);
  }
  scheduleSave();
  sendState();
  return true;
}

function cycleTab(delta: number): void {
  const acc = activeAccount();
  if (!acc) return;
  ensureAccountTabs(acc);
  const idx = acc.tabs.findIndex((t) => t.id === acc.activeTabId);
  const next = acc.tabs[(idx + delta + acc.tabs.length) % acc.tabs.length];
  if (next) switchTab(next.id);
}

/* ---------- 删除账号 ---------- */

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
    detail: '将同时关闭其全部标签页，并清除该账号的登录 Cookie 与本地缓存，重新添加后需重新登录。',
  });
  if (choice.response !== 0) return false;

  // 对话框期间 accounts 可能已变化，重新定位而不是用旧下标
  const cur = accounts.indexOf(acc);
  if (cur < 0) return false;
  accounts.splice(cur, 1);
  for (const t of acc.tabs) destroyTabView(t.id);

  // 先切走并刷新 UI，再清理数据：清理可能耗时，避免界面卡在已删除账号上
  if (activeId === id) {
    activeId = null;
    if (accounts.length > 0) {
      ensureAccountTabs(accounts[0]);
      const tabId = accounts[0].activeTabId;
      if (tabId) switchTab(tabId);
    } else {
      win?.webContents.focus();
    }
  }
  scheduleSave();
  sendState();

  try {
    const ses = session.fromPartition(`persist:clouddock-${id}`);
    await ses.clearStorageData();
    await ses.clearCache();
  } catch (err) {
    console.error('[clouddock] clear session failed:', err);
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
      color: pickColor(),
      createdAt: Date.now(),
      tabs: [],
      activeTabId: null,
    };
    accounts.push(acc);
    ensureAccountTabs(acc);
    scheduleSave();
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
    scheduleSave();
    sendState();
    return true;
  });

  ipcMain.handle('accounts:switch', (_e, id: unknown): boolean => switchAccount(String(id)));

  ipcMain.handle('tabs:new', (_e, url: unknown): boolean => {
    const acc = activeAccount() ?? accounts[0];
    if (!acc) return false;
    newTabForAccount(acc, typeof url === 'string' ? url : undefined);
    return true;
  });

  ipcMain.handle('tabs:close', (_e, tabId: unknown): boolean => closeTab(String(tabId)));

  ipcMain.handle('tabs:switch', (_e, tabId: unknown): boolean => switchTab(String(tabId)));

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
        safeLoad(wc, HOME_URL);
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
      safeLoad(wc, u.toString());
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
        { label: '刷新当前标签页', accelerator: 'CmdOrCtrl+R', click: () => activeWc()?.reload() },
        { label: '后退', accelerator: 'CmdOrCtrl+[', click: () => activeWc()?.goBack() },
        { label: '前进', accelerator: 'CmdOrCtrl+]', click: () => activeWc()?.goForward() },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.1) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { type: 'separator' },
        {
          label: '开发者工具（当前标签页）',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => activeWc()?.openDevTools({ mode: 'bottom' }),
        },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '标签页',
      submenu: [
        {
          label: '新建标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const acc = activeAccount() ?? accounts[0];
            if (acc) newTabForAccount(acc);
          },
        },
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const tab = activeTab();
            if (tab) closeTab(tab.id);
          },
        },
        { type: 'separator' },
        { label: '上一个标签页', accelerator: 'CmdOrCtrl+Shift+[', click: () => cycleTab(-1) },
        { label: '下一个标签页', accelerator: 'CmdOrCtrl+Shift+]', click: () => cycleTab(1) },
      ],
    },
    // 不用 role:'windowMenu'：它自带「关闭窗口 ⌘W」，会与「关闭标签页 ⌘W」抢快捷键
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
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

  // UI 页面只允许加载自身：拖入文件/链接不得让主窗口导航走（否则整个界面丢失）
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('did-finish-load', () => {
    if (activeId === null && accounts.length > 0) {
      // 直接恢复上次使用的账号，避免先白白加载第一个账号再切换
      const target = accounts.find((a) => a.id === savedActiveId) ?? accounts[0];
      switchAccount(target.id);
    } else {
      sendState();
    }
  });
}

/* ---------- 应用生命周期 ---------- */

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

  app.on('before-quit', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveAccountsNow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
