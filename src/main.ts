import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  shell,
  Menu,
  dialog,
  crashReporter,
} from 'electron';
import type { Rectangle, WebContents, Session, MenuItemConstructorOptions } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as dns from 'node:dns';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Account, AppState, CapturedLogin, FillPayload, PendingSave, Tab } from './types';
import {
  PALETTE,
  hostnameOf,
  registrableDomain,
  siteLabel,
  homeFor,
  resolveInput,
  isHttpUrl,
  sanitizeAccount,
} from './pure';
import { vault } from './vaultClient';
import { checkForUpdatesInteractive, updateTokenFromArgv, reconcilePendingUpdate } from './updater';

/*
 * 通用多账号浏览器：账号 = 一个独立会话容器，可登录任意网站。
 * Tab.url 为空字符串 = 内置「起始页」(start.html)：输入网址或点常用站点即可开始。
 */
function startUrl(): string {
  return pathToFileURL(path.join(__dirname, '..', 'start.html')).href;
}
function isStartUrl(u: string): boolean {
  return u.startsWith(startUrl().split('?')[0]);
}
/** 新账号在识别到登录身份之前的占位备注 */
const PENDING_NOTE = '登录后自动识别账号';

const SIDEBAR_W = 232;
/** 收起后的窄栏宽度（只显示头像，须容纳 macOS 红绿灯；与 index.html body.collapsed 一致） */
const RAIL_W = 88;
let sidebarCollapsed = false;
function sidebarW(): number {
  return sidebarCollapsed ? RAIL_W : SIDEBAR_W;
}
const TOPBAR_H = 52;
const TABBAR_H = 36;
/** 「保存登录信息」提示条 / 「恢复会话」横幅高度（与 index.html #banner 一致） */
const BANNER_H = 56;

let win: BrowserWindow | null = null;
/** key: tabId —— 每个 tab 一个视图；同账号的所有 tab 共享同一 partition（登录态） */
const views = new Map<string, WebContentsView>();
let accounts: Account[] = [];
let activeId: string | null = null;

/* ---------- 测试支持：自定义数据目录 ---------- */
if (process.env.CLOUDDOCK_DATA_DIR) {
  app.setPath('userData', process.env.CLOUDDOCK_DATA_DIR);
}

// 凭据加密不再使用 Chromium 的钥匙串条目（"CloudDock Safe Storage"，授权绑定 ad-hoc 签名，每次更新都会重新弹框），
// 声明 mock 钥匙串，确保 Chromium 任何内部路径都不会触发钥匙串授权弹窗。
app.commandLine.appendSwitch('use-mock-keychain');

/* ---------- 崩溃收集（crashpad）与异常退出检测 ---------- */
/*
 *  - crashReporter：主/渲染进程崩溃时由 Chromium 内建 crashpad 落 minidump 到
 *    app.getPath('crashDumps')；不上传（无服务器），仅本地留存，启动时只保留最近 5 份
 *  - running.flag：应用存活标记。启动即写、正常退出（before-quit/will-quit）删除；
 *    下次启动发现标记仍在 = 上次是崩溃/强杀，进入「恢复会话询问」流程（Chrome 同款横幅）
 */
crashReporter.start({
  submitURL: '',
  uploadToServer: false,
  compress: true,
  globalExtra: { version: app.getVersion(), platform: process.platform },
});

function runningFlagFile(): string {
  return path.join(app.getPath('userData'), 'running.flag');
}
/** 更新启动参数（--clouddock-update-token <file>）：非空表示本次由更新流程拉起（须先于 crashedLastRun 判定） */
const updateToken = updateTokenFromArgv(process.argv);
/**
 * 上次是否异常退出（模块加载时判定一次，全程不变）。
 * 更新启动时老实例还没来得及删标记（它在等我们握手），此时标记在不算崩溃。
 */
const crashedLastRun = fs.existsSync(runningFlagFile()) && !updateToken;
/** 用户尚未对「恢复上次会话」做出选择（true 时渲染层显示恢复横幅，不自动恢复标签页） */
let crashRecoveryPending = false;

/** 只保留最近 5 份崩溃转储，避免长期使用磁盘堆积 */
function pruneCrashDumps(): void {
  try {
    const dir = app.getPath('crashDumps');
    const dumps = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.dmp'))
      .map((n) => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const d of dumps.slice(5)) fs.rmSync(path.join(dir, d.name), { force: true });
  } catch {
    /* 目录不存在：首次运行，无需清理 */
  }
}

/* ---------- 持久化 ---------- */

function accountsFile(): string {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function uiFile(): string {
  return path.join(app.getPath('userData'), 'ui.json');
}

/** 原子写：先写临时文件再 rename，避免崩溃/断电写一半导致账号列表损坏丢失 */
function writeFileAtomic(file: string, content: string, mode?: number): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, mode === undefined ? { encoding: 'utf-8' } : { encoding: 'utf-8', mode });
  fs.renameSync(tmp, file);
}

function saveUiNow(): void {
  try {
    const file = uiFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // activeId 为空时沿用已读到的上次值，避免只切侧边栏就丢了「上次账号」
    writeFileAtomic(file, JSON.stringify({ activeId: activeId ?? savedActiveId, sidebarCollapsed }));
  } catch (err) {
    console.error('[clouddock] save ui failed:', err);
  }
}

function saveAccountsNow(): void {
  try {
    const file = accountsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(accounts, null, 2));
    saveUiNow();
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

/** 对磁盘读入的数据做结构/类型校验（实现见 pure.ts，可单测） */

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
    sidebarCollapsed = (ui as { sidebarCollapsed?: unknown }).sidebarCollapsed === true;
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

/* ---------- 密码管理（行为对齐 Chrome） ---------- */
/*
 *  - 任意网站登录成功后询问「保存 / 更新密码」，可选「从不保存此网站」
 *  - 已保存的网站再次打开登录页时自动填充（同一网站多个用户名时填最近使用的）
 *  - 凭据按「账号(会话分区) + 网站 origin + 用户名」存储：账号之间互不可见；只会填充到与保存时完全相同 origin 的页面/iframe
 *  - 安全（Chrome helper 最小权限进程模型的移植）：
 *      * 主密钥与 AES-256-GCM 加解密全部在 utilityProcess（vaultChild）内，
 *        密钥/明文/密文都不进主进程内存；
 *      * 主进程只持有非敏感元数据镜像（站点、用户名展示、更新时间）用于菜单展示；
 *      * 子进程不可用时密码保存/填充整体禁用，绝不明文落盘；
 *      * 密码永不下发到界面进程
 *  - 管理入口：菜单「密码」（查看/删除/恢复提示），不占用主界面
 */

/** 与 Chrome 一致：http/https 页面均可；以 origin（协议+主机+端口）精确绑定 */
function credOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 从不保存此网站（元数据在主进程镜像中，同步判断即可） */
function isNever(accountId: string, origin: string): boolean {
  return vault.never.some((n) => n.accountId === accountId && n.origin === origin);
}

interface RawPending {
  accountId: string;
  login: CapturedLogin;
  origin: string;
  /** 非空 = 同一用户名已有保存记录，本次是更新密码 */
  existingId: string | null;
  tabId: string;
  ts: number;
  /** 登录页发生导航后才置 true（视为登录成功），此时才向用户展示保存提示 */
  armed: boolean;
}
/** 按账号各存一份：两个账号同时登录时互不覆盖对方的保存提示 */
const pendings = new Map<string, RawPending>();
/** 最近一次登录表单提交的用户名：登录页跳转后用于给账号自动命名 */
let loginHint: { accountId: string; tabId: string; label: string; host: string; ts: number } | null = null;
/**
 * 等待登录成功的最长时间（有滑块/短信二次验证的站点会久一些）。
 * 期间页面还在输入（input 心跳）会不断顺延，见 keepPendingAlive。
 */
const PENDING_TTL = 120_000;

/** webContents.id -> 所属账号/标签（用于校验 IPC 发送方） */
const wcMap = new Map<number, { acc: Account; tab: Tab }>();

function credLabel(fields: string[]): string {
  return fields.filter(Boolean).join(' / ').slice(0, 120);
}

async function onCaptured(wcId: number, frameUrl: string | undefined, raw: unknown): Promise<void> {
  const ctx = wcMap.get(wcId);
  if (!ctx || !accounts.includes(ctx.acc)) return;
  const origin = credOrigin(frameUrl);
  if (!origin) return;
  const r = raw as Partial<CapturedLogin> | null;
  if (!r || !Array.isArray(r.fields) || typeof r.password !== 'string') return;
  const fields = r.fields.filter((f): f is string => typeof f === 'string').map((f) => f.slice(0, 200));
  if (fields.length === 0 || fields.length > 5 || !r.password || r.password.length > 256) return;

  // 用提交的用户名给账号自动命名（与是否保存密码无关；真正登录成功要等页面跳转，见 armPending）
  loginHint = { accountId: ctx.acc.id, tabId: ctx.tab.id, label: credLabel(fields), host: hostOf(origin), ts: Date.now() };

  if (!vault.available || isNever(ctx.acc.id, origin)) return;

  // 同一用户名已有记录？密码也相同 → 不打扰；密码不同 → 提示「更新」（去重比较在 vault 子进程内完成）
  const dedup = await vault.dedup(ctx.acc.id, origin, fields, r.password);
  if (!dedup) return; // 子进程超时/不可用：当作未保存，不打扰
  if (dedup.same) return;
  const existingId = dedup.existingId;
  if (!accounts.includes(ctx.acc)) return; // 等待期间账号可能被删除

  const prev = pendings.get(ctx.acc.id) ?? null;
  const hadBanner = !!prev?.armed;
  // 提示已展示且是同一次登录（同一份凭据）→ 保留原记录，用户没点之前不重置、不重复弹
  if (
    hadBanner &&
    prev &&
    prev.origin === origin &&
    prev.login.password === r.password &&
    prev.login.fields.join('\u0001') === fields.join('\u0001')
  ) {
    return;
  }
  pendings.set(ctx.acc.id, {
    accountId: ctx.acc.id,
    login: { fields, password: r.password },
    origin,
    existingId,
    tabId: ctx.tab.id,
    ts: Date.now(),
    armed: false,
  });
  if (hadBanner) {
    layoutViews();
    sendState();
  }
}

/** tabId 全局唯一：在所有账号的待确认捕获里找属于这个 tab 的那条 */
function findUnarmedByTab(tabId: string): RawPending | null {
  for (const p of pendings.values()) {
    if (!p.armed && p.tabId === tabId) return p;
  }
  return null;
}

/** 登录页发生导航 = 很可能登录成功，此时再弹提示（输错密码的页面通常不会跳转） */
function armPending(tabId: string): void {
  if (loginHint && loginHint.tabId === tabId) {
    const h = loginHint;
    loginHint = null;
    const acc = accounts.find((a) => a.id === h.accountId);
    if (acc && Date.now() - h.ts <= PENDING_TTL && h.label) {
      applyAutoName(acc, 'login', h.label, registrableDomain(h.host.replace(/:\d+$/, '')));
    }
  }
  const hit = findUnarmedByTab(tabId);
  if (!hit) return;
  // 距上次输入/提交太久 = 用户已放弃这次登录，之后的普通跳转不能误触发保存提示
  if (Date.now() - hit.ts > PENDING_TTL) {
    pendings.delete(hit.accountId);
    return;
  }
  hit.armed = true;
  hit.ts = Date.now();
  if (win && !win.isFocused() && process.platform === 'darwin') app.dock?.bounce('informational');
  layoutViews();
  sendState();
}

/** 页面还在输入（登录页 input 事件）：顺延等待窗口，覆盖滑块/短信二次验证这类耗时流程 */
function keepPendingAlive(tabId: string): void {
  const p = findUnarmedByTab(tabId);
  if (p) p.ts = Date.now();
}

/**
 * 点了登录但密码框已经消失、页面却没跳转（密码错误、风控拦截）：
 * 丢弃这次捕获，用户改对密码再登录时会重新上报，届时照常提示。
 */
function abandonPending(tabId: string): void {
  const p = findUnarmedByTab(tabId);
  if (p) pendings.delete(p.accountId);
}

/** 用户主动导航（地址栏/后退/刷新/首页）不应被当作「登录成功跳转」，丢弃尚未确认的捕获 */
function dropUnarmedPending(): void {
  for (const [aid, p] of pendings) {
    if (!p.armed) pendings.delete(aid);
  }
  loginHint = null;
}

function clearPending(accountId: string): void {
  const had = !!pendings.get(accountId)?.armed;
  pendings.delete(accountId);
  if (had) layoutViews();
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function pendingForUi(): PendingSave | null {
  const p = activeId ? pendings.get(activeId) : undefined;
  if (!p?.armed) return null;
  // 提示只属于当前账号：banner 上点「保存」落在哪个账号，以此处为准
  return {
    accountId: p.accountId,
    label: credLabel(p.login.fields),
    host: hostOf(p.origin),
    update: p.existingId !== null,
  };
}

/** 删除账号时调用：清掉该账号全部已存密码与「从不保存」（实际删除在 vault 子进程完成） */
function dropAccountCreds(id: string): void {
  if (pendings.has(id)) clearPending(id);
  void vault.dropAccount(id);
}

async function deleteCredEntry(entryId: string): Promise<void> {
  const e = vault.entries.find((x) => x.id === entryId);
  if (!e || !win) return;
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `删除已保存的密码？`,
    detail: `${hostOf(e.origin)} — ${e.label}`,
  });
  if (choice.response !== 0) return;
  await vault.removeEntry(entryId);
  sendState();
}

async function clearAccountCreds(accountId: string): Promise<void> {
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc || !win) return;
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['全部清除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `清除账号「${acc.name}」的全部已保存密码？`,
    detail: '同时会恢复该账号所有「从不保存」的网站。',
  });
  if (choice.response !== 0) return;
  await vault.dropAccount(accountId);
  sendState();
}

/* ---------- 账号 / 标签页模型 ---------- */

function newTabRecord(url = '', title = ''): Tab {
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

/* ---------- 账号自动命名 ---------- */
/*
 * 账号名无需手填，按优先级自动识别（用户手动重命名后不再覆盖）：
 *   uin   腾讯云：读登录 Cookie 中的 uin / ownerUin（最准）
 *   login 任意网站：登录表单提交的用户名，页面跳转后视为登录成功
 *   host  兜底：首次打开的站点名称
 */

const NAME_RANK = { host: 1, login: 2, uin: 3 } as const;

function applyAutoName(acc: Account, source: keyof typeof NAME_RANK, name: string, note: string): void {
  if (!acc.autoName || !accounts.includes(acc)) return;
  const cur = acc.nameSource ? NAME_RANK[acc.nameSource] : 0;
  if (NAME_RANK[source] < cur) return;
  if (source === 'host' && acc.nameSource) return; // 站点名只在首次设置
  let finalName = name.slice(0, 30);
  if (source === 'host') {
    // 多个账号同站点时加序号，便于区分
    let n = 1;
    let candidate = finalName;
    while (accounts.some((a) => a !== acc && a.name === candidate)) {
      n += 1;
      candidate = `${finalName} ${n}`;
    }
    finalName = candidate;
  }
  const finalNote = note.slice(0, 60);
  if (acc.nameSource === source && acc.name === finalName && acc.note === finalNote) return;
  acc.name = finalName;
  acc.note = finalNote;
  acc.nameSource = source;
  scheduleSave();
  sendState();
}

/** 主窗口首次导航到真实网站：记录账号首页，并用站点名兜底命名 */
function onMainNavigated(acc: Account, url: string): void {
  if (!isHttpUrl(url) || !accounts.includes(acc)) return;
  if (!acc.home) {
    acc.home = homeFor(url);
    scheduleSave();
  }
  const label = siteLabel(url);
  if (label && acc.autoName && !acc.nameSource) applyAutoName(acc, 'host', label, PENDING_NOTE);
}

/* ----- 腾讯云：读登录 Cookie 中的 UIN ----- */
/*
 * 腾讯云登录成功后，会在 .cloud.tencent.com 等域写入 uin（当前操作者）与 ownerUin（主账号）Cookie，
 * 这里读取其数字部分作为账号名；仅对腾讯云相关域生效，不影响其它网站。
 */

const UIN_COOKIE_DOMAINS = ['tencent.com', 'tencentcloud.com', 'qcloud.com'];
/** 仅测试：设置了 CLOUDDOCK_DATA_DIR 时才允许本地域名，便于自动化测试 */
const UIN_TEST_DOMAINS: string[] = process.env.CLOUDDOCK_DATA_DIR ? ['127.0.0.1', 'localhost'] : [];

function uinDomainOk(domain: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  if (UIN_TEST_DOMAINS.includes(d)) return true;
  return UIN_COOKIE_DOMAINS.some((s) => d === s || d.endsWith(`.${s}`));
}

async function readUinCookie(ses: Session, name: string): Promise<string> {
  const list = await ses.cookies.get({ name });
  for (const c of list) {
    if (!uinDomainOk(c.domain ?? '')) continue;
    const digits = c.value.replace(/\D/g, '');
    if (/^\d{4,20}$/.test(digits)) return digits;
  }
  return '';
}

async function detectAccountIdentity(accountId: string): Promise<void> {
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return;
  try {
    const ses = session.fromPartition(`persist:clouddock-${acc.id}`);
    const uin = await readUinCookie(ses, 'uin');
    if (!uin) return; // 未登录/已退出：保持现状
    const owner = (await readUinCookie(ses, 'ownerUin')) || uin;
    if (!accounts.includes(acc)) return;
    if (acc.uin !== uin || acc.ownerUin !== owner) {
      acc.uin = uin;
      acc.ownerUin = owner;
      scheduleSave();
    }
    applyAutoName(acc, 'uin', uin, uin === owner ? '腾讯云' : `腾讯云子账号 · 主账号 ${owner}`);
  } catch (err) {
    console.error('[clouddock] detect identity failed:', err);
  }
}

const watchedSessions = new Set<string>();
const identityTimers = new Map<string, NodeJS.Timeout>();

/** 监听该账号会话的 uin 类 Cookie 变化（登录/切换子账号时触发），防抖后重新识别 */
function watchAccountIdentity(acc: Account, ses: Session): void {
  if (watchedSessions.has(acc.id)) return;
  watchedSessions.add(acc.id);
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || (cookie.name !== 'uin' && cookie.name !== 'ownerUin')) return;
    clearTimeout(identityTimers.get(acc.id));
    identityTimers.set(
      acc.id,
      setTimeout(() => void detectAccountIdentity(acc.id), 800),
    );
  });
}

/* ---------- 会话 Cookie 持久化 ---------- */

/**
 * 腾讯云等站点的登录 Cookie 是「会话 Cookie」（不落盘），应用一退出登录态就清零，
 * 每次重启/升级都要全部重新扫码/输密码。Electron 没有 Chromium 的
 * persist-session-cookies 开关，这里在应用层把账号分区里新增的会话 Cookie
 * 改写为带过期时间的持久 Cookie（默认 30 天），重启后登录态保留：
 * - 网站主动删除（removed=true）不拦截，登出行为不受影响；
 * - 改写后的持久 Cookie 再触发 changed 时 session=false，不会进入循环。
 */
const SESSION_COOKIE_TTL_SEC = 30 * 24 * 3600;
const cookiePersistedSessions = new Set<string>();

function persistSessionCookies(acc: Account, ses: Session): void {
  if (cookiePersistedSessions.has(acc.id)) return;
  cookiePersistedSessions.add(acc.id);
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || !cookie.session || !cookie.domain) return;
    const host = cookie.domain.replace(/^\./, '');
    const detail: Electron.CookiesSetDetails = {
      url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_TTL_SEC,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    };
    ses.cookies.set(detail).catch(() => {
      /* 个别 cookie（非法 sameSite 等）改写失败：保持会话语义，不影响页面 */
    });
  });
}

/* ---------- 权限策略（session 级） ---------- */

function applyPermissionPolicy(ses: Session): void {
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    // 摄像头/麦克风：弹框确认。静默放行等于对全网无条件开放，风险过高。
    if (permission === 'media') {
      const host = hostnameOf(wc.getURL());
      if (!win || win.isDestroyed()) return callback(false);
      void dialog
        .showMessageBox(win, {
          type: 'question',
          buttons: ['允许', '拒绝'],
          defaultId: 1,
          cancelId: 1,
          message: '该网站想要使用摄像头 / 麦克风',
          detail: `${host || '未知来源'} 请求使用摄像头或麦克风，允许后即可开始音视频通话或录制。`,
        })
        .then((c) => callback(c.response === 0));
      return;
    }
    // 注意：clipboard-read 不在白名单 —— 任意网页静默读剪贴板会泄露复制的密码/token，默认拒绝。
    // （往剪贴板写内容是低风险的，保留 clipboard-sanitized-write。）
    const allowed = new Set([
      'clipboard-sanitized-write',
      'notifications',
      'fullscreen',
      'pointerLock',
    ]);
    callback(allowed.has(permission));
  });
}

/* ---------- 布局 ---------- */

function viewBounds(): Rectangle {
  if (!win) return { x: 0, y: 0, width: 0, height: 0 };
  const [cw, ch] = win.getContentSize();
  // 「保存密码」提示条与「恢复会话」横幅等高，同一段时间最多显示一个
  const hasBanner = pendingForUi() !== null || crashRecoveryPending;
  const top = TOPBAR_H + TABBAR_H + (hasBanner ? BANNER_H : 0);
  return {
    x: sidebarW(),
    y: top,
    width: Math.max(0, cw - sidebarW()),
    height: Math.max(0, ch - top),
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
    url: wc ? (isHttpUrl(wc.getURL()) ? wc.getURL() : '') : tab?.url ?? '',
    title: wc ? wc.getTitle() : tab?.title ?? '',
    canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
    canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
    isLoading: wc ? wc.isLoading() : false,
    pending: pendingForUi(),
    sidebarCollapsed,
    crashRecovery: crashRecoveryPending,
  };
  refreshMenuIfNeeded();
  win.webContents.send('state:update', state);
}

/* ---------- 标签页视图 ---------- */

/** 已预热（隐藏、仅 about:blank）尚未真正导航的 tab：首次切换时补加载目标地址 */
const prewarmedTabs = new Set<string>();
/** 预热上限：额外常驻渲染进程的内存代价（Chrome Aperitif 同样的取舍） */
const PREWARM_MAX = 4;

function createTabView(acc: Account, tab: Tab, prewarm = false): WebContentsView {
  const ses = session.fromPartition(`persist:clouddock-${acc.id}`);
  // 去掉 UA 中的 Electron 标识，避免登录链路 UA 校验问题
  const ua = ses.getUserAgent().replace(/Electron\/[\d.]+\s*/i, '');
  ses.setUserAgent(ua);
  applyPermissionPolicy(ses);
  watchAccountIdentity(acc, ses);
  persistSessionCookies(acc, ses);

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 登录框常在跨域 iframe 内（如腾讯云登录页），预加载脚本需覆盖子 frame
      nodeIntegrationInSubFrames: true,
      preload: path.join(__dirname, 'pagePreload.js'),
    },
  });
  const wc = view.webContents;
  wcMap.set(wc.id, { acc, tab });

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
    } else if (url === 'about:blank') {
      // 部分 OAuth/支付流程先 window.open('about:blank') 再往里跳转；
      // 开成独立小弹窗（继承同账号会话与安全配置），完成后再由页面自行关闭。
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 980, height: 680, autoHideMenuBar: true },
      };
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
    // 仍处于预热状态（尚未转正）：不识别身份，只预热该会话分区的连接池。
    // 转正（switchTab）会先移出 prewarmedTabs 再导航，之后的 did-finish-load 走正常路径。
    if (prewarmedTabs.has(tab.id)) {
      // no-cors fetch 即便被 CORS 拦截，DNS+TCP+TLS 握手也已完成——正是 Chrome preconnect 的效果。
      if (acc.home && isHttpUrl(acc.home)) {
        wc.executeJavaScript(
          `fetch(${JSON.stringify(acc.home)}, { mode: 'no-cors', cache: 'no-store' }).catch(() => {})`,
        ).catch(() => {
          /* 预热失败无影响 */
        });
      }
      return;
    }
    // 兜底：页面加载完成后再识别一次（覆盖升级前已登录、Cookie 事件早于监听等情况）
    void detectAccountIdentity(acc.id);
  });
  const syncUrl = (): void => {
    const u = wc.getURL();
    if (isHttpUrl(u)) tab.url = u;
    else if (isStartUrl(u)) tab.url = ''; // 起始页不记录文件路径
  };
  wc.on('did-navigate', () => {
    syncUrl();
    onMainNavigated(acc, wc.getURL());
    armPending(tab.id);
    scheduleSave();
    refresh();
  });
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
    syncUrl();
    if (isMainFrame) armPending(tab.id);
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
  if (prewarm) {
    // 预热：只拉起渲染进程 + about:blank（渲染进程初始化是最贵的冷启动部分），目标地址等真正切换时再载
    prewarmedTabs.add(tab.id);
    safeLoad(wc, 'about:blank');
  } else {
    safeLoad(wc, isHttpUrl(tab.url) ? tab.url : startUrl());
  }
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
  prewarmedTabs.delete(tabId);
  wcMap.delete(view.webContents.id);
  const p = findUnarmedByTab(tabId);
  if (p) pendings.delete(p.accountId);
  if (loginHint?.tabId === tabId) loginHint = null;
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
  if (prewarmedTabs.delete(tab.id)) {
    // 预热视图首次转正：渲染进程已在，只需导航到目标地址（Chrome Aperitif 的切换提速收益点）
    safeLoad(view.webContents, isHttpUrl(tab.url) ? tab.url : startUrl());
  }
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
  const t = newTabRecord(url && /^https?:/i.test(url) ? url : '');
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

/* ---------- 侧边栏收起 / 展开 ---------- */

function setSidebarCollapsed(next: boolean): void {
  if (sidebarCollapsed === next) return;
  sidebarCollapsed = next;
  saveUiNow();
  layoutViews();
  sendState();
}

/* ---------- 清除 Cookie ---------- */
/*
 * 三档范围（均只作用于所选账号自己的独立会话，不影响其它账号；已保存的密码不会被清除）：
 *   cookies  该账号全部 Cookie（所有网站退出登录）
 *   site     只清当前标签页网站可见的 Cookie
 *   all      全部站点数据：Cookie + 缓存 + 本地存储等
 */
type ClearScope = 'cookies' | 'site' | 'all';

function accountSession(acc: Account): Session {
  return session.fromPartition(`persist:clouddock-${acc.id}`);
}

/** 账号当前标签页所在网站的主机名（起始页/非网页返回空串） */
function currentHost(acc: Account): string {
  const tab = acc.tabs.find((t) => t.id === acc.activeTabId);
  if (!tab) return '';
  const wcUrl = views.get(tab.id)?.webContents.getURL();
  const url = isHttpUrl(wcUrl) ? wcUrl : tab.url;
  try {
    return isHttpUrl(url) ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function cookieDomain(c: Electron.Cookie): string {
  return (c.domain ?? '').replace(/^\./, '').toLowerCase();
}

async function cookiesFor(ses: Session, host: string | null): Promise<Electron.Cookie[]> {
  const all = await ses.cookies.get({});
  if (host === null) return all;
  // 与浏览器发送规则一致：Cookie 域是主机本身或其上级域
  return all.filter((c) => {
    const d = cookieDomain(c);
    return !!d && (host === d || host.endsWith(`.${d}`));
  });
}

async function clearAccountData(acc: Account, scope: ClearScope): Promise<boolean> {
  if (!win || !accounts.includes(acc)) return false;
  const ses = accountSession(acc);
  const host = scope === 'site' ? currentHost(acc) : null;
  if (scope === 'site' && !host) {
    await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['好'],
      message: '当前标签页不是网站页面',
      detail: '请先切到要清除 Cookie 的网站标签页，再执行此操作。',
    });
    return false;
  }
  const count = (await cookiesFor(ses, host)).length;
  const message =
    scope === 'site'
      ? `清除账号「${acc.name}」在 ${host} 的 Cookie？`
      : scope === 'cookies'
        ? `清除账号「${acc.name}」的全部 Cookie？`
        : `清除账号「${acc.name}」的全部站点数据？`;
  const detail =
    scope === 'all'
      ? `将清除该账号所有网站的 Cookie（共 ${count} 条）、缓存、本地存储，所有网站需重新登录。账号本身和已保存的密码保留。`
      : `共 ${count} 条 Cookie。清除后${scope === 'site' ? '该网站' : '所有网站'}会退出登录，需重新登录。账号本身和已保存的密码保留。`;
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['清除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  if (choice.response !== 0 || !accounts.includes(acc)) return false;

  try {
    if (scope === 'site') {
      for (const c of await cookiesFor(ses, host)) {
        const d = cookieDomain(c);
        await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${d}${c.path ?? '/'}`, c.name);
      }
    } else if (scope === 'cookies') {
      await ses.clearStorageData({ storages: ['cookies'] });
    } else {
      await ses.clearStorageData();
      await ses.clearCache();
    }
    await ses.cookies.flushStore();
  } catch (err) {
    console.error('[clouddock] clear cookies failed:', err);
    return false;
  }

  if (scope !== 'site') {
    delete acc.uin;
    delete acc.ownerUin;
  }
  for (const t of acc.tabs) {
    if (prewarmedTabs.has(t.id)) continue; // 预热视图没载真实页面，无需重载
    views.get(t.id)?.webContents.reload();
  }
  scheduleSave();
  sendState();
  return true;
}

/** 清除所有账号的 Cookie（一次确认） */
async function clearAllAccountsCookies(): Promise<boolean> {
  if (!win || accounts.length === 0) return false;
  let total = 0;
  for (const a of accounts) total += (await cookiesFor(accountSession(a), null)).length;
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['清除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `清除全部 ${accounts.length} 个账号的 Cookie？`,
    detail: `共 ${total} 条 Cookie。所有账号的所有网站都会退出登录。账号本身和已保存的密码保留。`,
  });
  if (choice.response !== 0) return false;
  for (const a of [...accounts]) {
    if (!accounts.includes(a)) continue;
    try {
      const ses = accountSession(a);
      await ses.clearStorageData({ storages: ['cookies'] });
      await ses.cookies.flushStore();
    } catch (err) {
      console.error('[clouddock] clear cookies failed:', err);
    }
    delete a.uin;
    delete a.ownerUin;
    for (const t of a.tabs) {
      if (prewarmedTabs.has(t.id)) continue;
      views.get(t.id)?.webContents.reload();
    }
  }
  scheduleSave();
  sendState();
  return true;
}

/** 清除 Cookie 的三个菜单项（右键菜单与「账号」菜单共用） */
function cookieMenuItems(acc: Account): MenuItemConstructorOptions[] {
  return [
    { label: '清除 Cookie（退出该账号所有网站登录）…', click: () => void clearAccountData(acc, 'cookies') },
    { label: '清除当前网站的 Cookie…', click: () => void clearAccountData(acc, 'site') },
    { label: '清除全部站点数据（Cookie、缓存、本地存储）…', click: () => void clearAccountData(acc, 'all') },
  ];
}

function requestRename(id: string): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.focus();
  win.webContents.send('rename:start', id);
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
  dropAccountCreds(id);
  // 清掉身份监听残留（cookie 监听器挂在已销毁 session 上，timer 不清会空跑）
  watchedSessions.delete(id);
  clearTimeout(identityTimers.get(id));
  identityTimers.delete(id);
  cookiePersistedSessions.delete(id);

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

/* ---------- Aperitif 式空闲预热 ---------- */

/**
 * 空闲时段预热（Chrome Aperitif 的移植）：
 *  - 给尚无视图的账号（有首页的）预建隐藏 WebContentsView（about:blank）——
 *    渲染进程初始化是账号切换冷启动的大头，提前拉起后切换只剩导航时间；
 *  - 视图就绪后向账号首页发起 no-cors fetch，预热该会话分区的 DNS+TCP+TLS 连接池；
 *  - DNS 预解析所有账号首页（OS 层缓存，免费）。
 * 上限 PREWARM_MAX，超出的账号不做进程预热，只做 DNS 预解析。
 */
let prewarmTimer: NodeJS.Timeout | null = null;
function prewarmViews(): void {
  if (!win || win.isDestroyed()) return;
  let made = 0;
  for (const acc of accounts) {
    if (made >= PREWARM_MAX) break;
    if (!acc.home || !isHttpUrl(acc.home)) continue;
    ensureAccountTabs(acc);
    const tab = acc.tabs.find((t) => t.id === acc.activeTabId) ?? acc.tabs[0];
    if (!tab || views.has(tab.id)) continue;
    if (!accounts.includes(acc)) continue;
    createTabView(acc, tab, true);
    made += 1;
  }
  for (const acc of accounts) {
    if (!acc.home || !isHttpUrl(acc.home)) continue;
    try {
      void dns.promises.lookup(new URL(acc.home).hostname, { all: true }).catch(() => {
        /* DNS 预解析失败无影响 */
      });
    } catch {
      /* URL 已校验 */
    }
  }
}

/** 延迟调度预热：启动恢复完成后再预热，不与首屏抢资源；恢复横幅期间延后 */
function schedulePrewarm(delayMs: number): void {
  if (prewarmTimer) clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    if (crashRecoveryPending) return; // 用户还没决定是否恢复，别预建一堆视图
    prewarmViews();
  }, delayMs);
  prewarmTimer.unref?.();
}

/* ---------- 崩溃恢复 ---------- */

/**
 * 用户对「恢复上次会话」横幅做出选择（Chrome 恢复横幅同款交互）。
 *  - restore=true：照常恢复上次的账号与标签页
 *  - restore=false：每个账号回到干净的起始页（账号本身与登录态保留）
 */
function resolveCrash(restore: boolean): void {
  if (!crashRecoveryPending) return;
  crashRecoveryPending = false;
  if (!restore) {
    for (const acc of accounts) {
      // 清掉恢复横幅期间可能已存在的旧视图（横幅期间通常没有，防御性清理）
      for (const old of acc.tabs) destroyTabView(old.id);
      const t = newTabRecord();
      acc.tabs = [t];
      acc.activeTabId = t.id;
    }
    saveAccountsNow();
  }
  // 无论恢复与否都落到上次账号上：恢复=打开上次的标签页；不恢复=该账号干净的起始页
  if (accounts.length > 0) {
    const target = accounts.find((a) => a.id === savedActiveId) ?? accounts[0];
    switchAccount(target.id);
  } else {
    sendState();
  }
  schedulePrewarm(15_000);
}

/* ---------- IPC ---------- */

function registerIpc(): void {
  ipcMain.handle('accounts:list', () => accounts);

  ipcMain.handle('accounts:add', (_e, name: unknown, note: unknown): Account => {
    // 无需手动输入：新建独立会话并打开起始页，选站点登录后自动命名
    const manualName = String(name ?? '').trim().slice(0, 30);
    const loginTab = newTabRecord('');
    let seq = 1;
    while (accounts.some((a) => a.name === `新账号 ${seq}`)) seq += 1;
    const acc: Account = {
      id: randomBytes(6).toString('hex'),
      name: manualName || `新账号 ${seq}`,
      note: manualName ? String(note ?? '').trim().slice(0, 60) : PENDING_NOTE,
      color: pickColor(),
      createdAt: Date.now(),
      autoName: !manualName,
      tabs: [loginTab],
      activeTabId: loginTab.id,
    };
    accounts.push(acc);
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
    acc.autoName = false; // 手动命名后不再被自动识别覆盖
    if (acc.note === PENDING_NOTE) acc.note = '';
    scheduleSave();
    sendState();
    return true;
  });

  ipcMain.handle('accounts:switch', (_e, id: unknown): boolean => switchAccount(String(id)));

  // 侧边栏：收起 / 展开（不传参数 = 切换）
  ipcMain.handle('ui:sidebar', (_e, collapsed: unknown): boolean => {
    setSidebarCollapsed(typeof collapsed === 'boolean' ? collapsed : !sidebarCollapsed);
    return sidebarCollapsed;
  });

  // 侧边栏行内编辑前把键盘焦点拿回 UI 页面（否则按键/输入法会落到网页视图里）
  ipcMain.handle('ui:focus', (): void => {
    win?.webContents.focus();
  });

  // 账号右键菜单 / 「⋯」按钮
  ipcMain.handle('accounts:menu', (_e, id: unknown): void => {
    const acc = accounts.find((a) => a.id === String(id));
    if (!acc || !win) return;
    Menu.buildFromTemplate([
      { label: '重命名', click: () => requestRename(acc.id) },
      { type: 'separator' },
      ...cookieMenuItems(acc),
      { type: 'separator' },
      { label: '删除账号…', click: () => void removeAccount(acc.id) },
    ]).popup({ window: win });
  });

  /* ----- 密码管理 ----- */
  // 页面注入脚本 -> 主进程：发送方必须是账号标签页里的 http(s) 页面
  ipcMain.on('cred:captured', (e, raw: unknown) => {
    if (!credOrigin(e.sender.getURL())) return;
    void onCaptured(e.sender.id, e.senderFrame?.url, raw);
  });

  // 登录过程中的心跳（页面仍在输入）与「表单已消失」。
  // 注意：e.sender.id 是 webContents id，pending 记的是 tab 记录 id，必须经 wcMap 换算，
  // 直接拿数字 id 去比对 hex tab id 永远不匹配（曾导致心跳/放弃检测空转，慢登录超时丢提示）。
  ipcMain.on('cred:active', (e) => {
    if (!credOrigin(e.sender.getURL())) return;
    const ctx = wcMap.get(e.sender.id);
    if (ctx) keepPendingAlive(ctx.tab.id);
  });

  ipcMain.on('cred:form-gone', (e) => {
    if (!credOrigin(e.sender.getURL())) return;
    const ctx = wcMap.get(e.sender.id);
    if (ctx) abandonPending(ctx.tab.id);
  });

  // 起始页的地址输入：由主进程统一解析（与地址栏 nav:url 同一套 resolveInput），start.html 不再留一份拷贝。
  // 只对已登记的 tab 视图、且当前确实停在起始页时生效，普通网站调用一律拒绝。
  ipcMain.handle('nav:start-input', (e, raw: unknown): boolean => {
    const ctx = wcMap.get(e.sender.id);
    if (!ctx || !accounts.includes(ctx.acc)) return false;
    if (!isStartUrl(e.sender.getURL())) return false;
    const url = resolveInput(String(raw ?? ''));
    if (!url) return false;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      safeLoad(e.sender, u.toString());
      return true;
    } catch {
      return false;
    }
  });

  // 只回给【origin 与保存时完全一致】的页面/iframe；顶层页面也必须是 http(s)
  // 解密在 vault 子进程完成，明文只发往发起请求的页面，不落盘、不进 UI 进程
  ipcMain.handle('cred:get', async (e): Promise<FillPayload | null> => {
    const ctx = wcMap.get(e.sender.id);
    if (!ctx || !accounts.includes(ctx.acc)) return null;
    const origin = credOrigin(e.senderFrame?.url);
    if (!origin || !credOrigin(e.sender.getURL())) return null;
    if (!vault.available) return null;
    return vault.decrypt(ctx.acc.id, origin);
  });

  // 以下来自界面进程（preload 暴露的 api），只接受主窗口
  const fromUi = (e: Electron.IpcMainInvokeEvent): boolean => !!win && e.sender === win.webContents;

  ipcMain.handle('cred:save', async (e): Promise<boolean> => {
    // banner 只显示当前账号的提示，保存也只作用于该账号名下的捕获
    const p = activeId ? pendings.get(activeId) : undefined;
    if (!fromUi(e) || !p?.armed || !vault.available) return false;
    const acc = accounts.find((a) => a.id === p.accountId);
    if (!acc) {
      clearPending(p.accountId);
      sendState();
      return false;
    }
    const ok = await vault.save(p.accountId, p.origin, credLabel(p.login.fields), p.login, p.existingId);
    if (!ok) return false;
    clearPending(p.accountId);
    sendState();
    return true;
  });

  // never=true：从不保存此网站（对应账号 + origin）
  ipcMain.handle('cred:dismiss', (e, never: unknown): boolean => {
    const p = activeId ? pendings.get(activeId) : undefined;
    if (!fromUi(e) || !p) return false;
    if (never === true && !isNever(p.accountId, p.origin)) {
      void vault.addNever(p.accountId, p.origin);
    }
    clearPending(p.accountId);
    sendState();
    return true;
  });

  /* ----- 崩溃恢复横幅 ----- */
  ipcMain.handle('crash:resolve', (e, restore: unknown): boolean => {
    if (!fromUi(e)) return false;
    resolveCrash(restore === true);
    return true;
  });

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
    dropUnarmedPending();
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
        safeLoad(wc, activeAccount()?.home ?? startUrl());
        break;
      default:
        break;
    }
  });

  ipcMain.handle('nav:url', (_e, raw: unknown): boolean => {
    const wc = activeWc();
    if (!wc) return false;
    dropUnarmedPending();
    const url = resolveInput(String(raw ?? ''));
    if (!url) return false;
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

/** 「密码」菜单：列出当前账号已保存的密码（点击删除），恢复「从不保存」，全部清除 */
function passwordMenu(): MenuItemConstructorOptions {
  const acc = activeAccount();
  const mine = vault.entries
    .filter((e) => e.accountId === acc?.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const neverCount = vault.never.filter((n) => n.accountId === acc?.id).length;
  const MAX_SHOW = 30;
  const items: MenuItemConstructorOptions[] = [
    { label: acc ? `「${acc.name}」已保存的密码（点击删除）` : '请先选择账号', enabled: false },
    ...(mine.length === 0
      ? [{ label: '（暂无）', enabled: false } as MenuItemConstructorOptions]
      : mine.slice(0, MAX_SHOW).map(
          (e): MenuItemConstructorOptions => ({
            label: `${hostOf(e.origin)} — ${e.label}`.slice(0, 80),
            click: () => void deleteCredEntry(e.id),
          }),
        )),
    ...(mine.length > MAX_SHOW ? [{ label: `…另有 ${mine.length - MAX_SHOW} 条`, enabled: false } as MenuItemConstructorOptions] : []),
    { type: 'separator' },
    {
      label: `恢复「从不保存」的网站（${neverCount}）`,
      enabled: neverCount > 0,
      click: () => {
        if (!acc) return;
        void vault.restoreNever(acc.id).then(() => sendState());
      },
    },
    {
      label: '清除当前账号全部已保存密码…',
      enabled: !!acc && (mine.length > 0 || neverCount > 0),
      click: () => {
        if (acc) void clearAccountCreds(acc.id);
      },
    },
  ];
  return { label: '密码', submenu: items };
}

/** 「账号」菜单：重命名、清除 Cookie（作用于当前账号） */
function accountMenu(): MenuItemConstructorOptions {
  const acc = activeAccount();
  const items: MenuItemConstructorOptions[] = acc
    ? [
        { label: `当前账号：${acc.name}`, enabled: false },
        { label: '重命名', click: () => requestRename(acc.id) },
        { type: 'separator' },
        ...cookieMenuItems(acc),
      ]
    : [{ label: '请先选择账号', enabled: false }];
  items.push({ type: 'separator' }, { label: '清除所有账号的 Cookie…', enabled: accounts.length > 0, click: () => void clearAllAccountsCookies() });
  return { label: '账号', submenu: items };
}

let menuSig = '';
/** 当前账号 / 已存密码变化时才重建菜单（sendState 很频繁） */
function menuSignature(): string {
  return JSON.stringify([
    activeId,
    activeAccount()?.name,
    accounts.length,
    vault.entries.filter((e) => e.accountId === activeId).map((e) => [e.id, e.origin, e.label]),
    vault.never.filter((n) => n.accountId === activeId).length,
  ]);
}
function refreshMenuIfNeeded(): void {
  const sig = menuSignature();
  if (sig === menuSig) return;
  buildMenu();
}

function buildMenu(): void {
  menuSig = menuSignature();
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
        { label: '收起 / 展开侧边栏', accelerator: 'CmdOrCtrl+B', click: () => setSidebarCollapsed(!sidebarCollapsed) },
        { type: 'separator' },
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
    accountMenu(),
    passwordMenu(),
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新…',
          click: () =>
            void checkForUpdatesInteractive(() => {
              // 更新握手成功、老进程退出前的清理（process.exit 不触发 before-quit）
              if (saveTimer) clearTimeout(saveTimer);
              saveAccountsNow();
              try {
                fs.rmSync(runningFlagFile(), { force: true });
              } catch {
                /* ignore */
              }
            }),
        },
        { type: 'separator' },
        { role: 'about' },
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
  win.once('ready-to-show', () => {
    win?.show();
    if (updateToken) {
      // 更新启动：新版本 UI 已就绪，写握手信号让老实例退出，再补拿单实例锁
      try {
        fs.writeFileSync(updateToken, 'ok', { encoding: 'utf-8' });
      } catch {
        /* 写失败由老实例 30s 超时回滚兜底 */
      }
      retrySingleInstanceLock();
    }
  });

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
    if (crashRecoveryPending) {
      // 上次崩溃：不自动恢复标签页，横幅等用户选择（恢复 / 重新开始）
      sendState();
      return;
    }
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

/** 更新启动时老实例仍握着单实例锁：写完握手信号后轮询补拿（老实例收到信号即退出） */
function retrySingleInstanceLock(): void {
  const deadline = Date.now() + 30_000;
  const tryLock = (): void => {
    // 拿到锁（老实例已退出）即可停；拿不到（老实例卡死）超时后放弃，本会话多开保护失效可接受
    if (app.requestSingleInstanceLock()) return;
    if (Date.now() > deadline) return;
    setTimeout(tryLock, 500).unref?.();
  };
  setTimeout(tryLock, 500).unref?.();
}

// 更新启动的瞬间老实例还握着锁（它在等我们的握手信号），此时拿不到锁是预期内的
const gotLock = app.requestSingleInstanceLock() || !!updateToken;
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
    // 上次更新的兜底清理（成功确认 / 失败残渣）
    reconcilePendingUpdate();
    // 运行标记：本次会话存活信号（崩溃/强杀时不会被删，下次启动据此进入恢复流程）
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      writeFileAtomic(runningFlagFile(), String(Date.now()));
    } catch (err) {
      console.error('[clouddock] write running flag failed:', err);
    }
    pruneCrashDumps();

    loadAccounts();
    // 上次异常退出 → 恢复横幅；正常退出 → 直接恢复上次会话（原行为）
    crashRecoveryPending = crashedLastRun && accounts.length > 0;

    // 密码库子进程（utilityProcess）：密钥与加解密隔离在子进程内
    void vault
      .init(app.getPath('userData'), accounts.map((a) => a.id))
      .then(() => {
        buildMenu(); // vault 可用性可能影响菜单项，初始化完成后刷一次
        sendState();
      });

    registerIpc();
    buildMenu();
    applyPermissionPolicy(session.defaultSession);
    createWindow();
    schedulePrewarm(15_000);
  });

  app.on('before-quit', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (prewarmTimer) clearTimeout(prewarmTimer);
    saveAccountsNow();
    // 正常退出：删运行标记（下次启动不做崩溃恢复）
    try {
      fs.rmSync(runningFlagFile(), { force: true });
    } catch {
      /* ignore */
    }
  });

  // 兜底：任何退出路径（含非正常但事件仍触发的场景）都清掉标记
  app.on('will-quit', () => {
    try {
      fs.rmSync(runningFlagFile(), { force: true });
    } catch {
      /* ignore */
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
