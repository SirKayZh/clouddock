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
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Account, AppState, CapturedLogin, FillPayload, PendingSave, Tab } from './types';

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

/** 常见站点的友好名称（后缀匹配），其余取注册域名 */
const SITE_NAMES: Array<[string, string]> = [
  ['tencentcloud.com', '腾讯云'],
  ['qcloud.com', '腾讯云'],
  ['tencent.com', '腾讯云'],
  ['aliyun.com', '阿里云'],
  ['amazonaws.com', 'AWS'],
  ['aws.amazon.com', 'AWS'],
  ['azure.com', 'Azure'],
  ['microsoftonline.com', 'Microsoft'],
  ['github.com', 'GitHub'],
  ['google.com', 'Google'],
];

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 取注册域（粗略处理 com.cn / co.uk 一类二级后缀） */
function registrableDomain(host: string): string {
  if (/^\d+(\.\d+){3}$/.test(host) || !host.includes('.')) return host;
  const parts = host.split('.');
  const sld = new Set(['com', 'co', 'net', 'org', 'gov', 'edu']);
  const n = parts.length >= 3 && sld.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

function siteLabel(url: string): string {
  const host = hostnameOf(url);
  if (!host) return '';
  const hit = SITE_NAMES.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`));
  return hit ? hit[1] : registrableDomain(host);
}

/** 账号「首页」：腾讯云直达控制台，其它站点取站点根 */
function homeFor(url: string): string {
  const host = hostnameOf(url);
  if (host === 'tencentcloud.com' || host.endsWith('.tencentcloud.com')) return 'https://console.tencentcloud.com/';
  if (/(^|\.)(tencent|qcloud)\.com$/.test(host)) return 'https://console.cloud.tencent.com/';
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return url;
  }
}

/** 把用户在地址栏输入的内容解析为 URL：网址 / localhost / IP 直接打开，其余当作搜索词 */
function resolveInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}
const SIDEBAR_W = 232;
/** 收起后的窄栏宽度（只显示头像，须容纳 macOS 红绿灯；与 index.html body.collapsed 一致） */
const RAIL_W = 72;
let sidebarCollapsed = false;
function sidebarW(): number {
  return sidebarCollapsed ? RAIL_W : SIDEBAR_W;
}
const TOPBAR_H = 52;
const TABBAR_H = 36;
/** 「保存登录信息」提示条高度（与 index.html #banner 一致） */
const BANNER_H = 40;
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

// 凭据加密不再使用 Chromium 的钥匙串条目（"CloudDock Safe Storage"，授权绑定 ad-hoc 签名，每次更新都会重新弹框），
// 声明 mock 钥匙串，确保 Chromium 任何内部路径都不会触发钥匙串授权弹窗。
app.commandLine.appendSwitch('use-mock-keychain');

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
        url: isHttpUrl(tt.url) ? tt.url : '',
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
    autoName: a.autoName === true,
    // 升级兼容：旧版已按 UIN 自动命名的账号标记为 uin 来源，避免被站点域名覆盖
    nameSource:
      a.nameSource === 'host' || a.nameSource === 'login' || a.nameSource === 'uin'
        ? a.nameSource
        : a.autoName === true && typeof a.uin === 'string'
          ? 'uin'
          : undefined,
    home: isHttpUrl(a.home) ? a.home : undefined,
    uin: typeof a.uin === 'string' && /^\d{4,20}$/.test(a.uin) ? a.uin : undefined,
    ownerUin: typeof a.ownerUin === 'string' && /^\d{4,20}$/.test(a.ownerUin) ? a.ownerUin : undefined,
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
 *  - 安全：密码用 AES-256-GCM 加密、密钥存在系统钥匙串（经 /usr/bin/security 读写，不会因应用重新签名而反复弹授权框），磁盘只存密文；加密不可用时功能自动关闭，绝不明文落盘；密码永不下发到界面进程
 *  - 管理入口：菜单「密码」（查看/删除/恢复提示），不占用主界面
 */

interface CredEntry {
  id: string;
  accountId: string;
  origin: string;
  /** 展示用用户名（非敏感），如「10001 / alice」 */
  label: string;
  /** 'v2:' + base64(iv|tag|密文)：JSON { fields, password } */
  enc: string;
  updatedAt: number;
}
interface NeverSave {
  accountId: string;
  origin: string;
}
interface CredStore {
  entries: CredEntry[];
  never: NeverSave[];
}

let credStore: CredStore = { entries: [], never: [] };
const MAX_ENTRIES_PER_ACCOUNT = 500;

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

function credFile(): string {
  return path.join(app.getPath('userData'), 'credentials.json');
}

/*
 * 密钥管理：随机 32 字节主密钥存入登录钥匙串（服务名 KEY_SERVICE），通过系统自带的 /usr/bin/security 读写。
 * 不用 Electron safeStorage：它的钥匙串条目按「应用代码签名」授权，本应用是 ad-hoc 签名，
 * 每次重新打包签名都会变，导致每次都弹「想要使用钥匙串中的机密信息」。
 * /usr/bin/security 由苹果签名、身份固定，条目由它创建，之后读取不再弹框。
 */
const KEY_SERVICE = 'CloudDock Credential Key';
const KEY_ACCOUNT = 'clouddock';
const SECURITY_BIN = '/usr/bin/security';
let masterKeyCache: Buffer | null = null;

function keychainRead(): Buffer | null {
  try {
    const out = execFileSync(SECURITY_BIN, ['find-generic-password', '-s', KEY_SERVICE, '-a', KEY_ACCOUNT, '-w'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim();
    const buf = Buffer.from(out, 'hex');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

function masterKey(): Buffer | null {
  if (masterKeyCache) return masterKeyCache;
  if (process.platform !== 'darwin') return null;
  let key = keychainRead();
  if (!key) {
    const fresh = randomBytes(32);
    try {
      // 仅首次创建时密钥短暂出现在命令行参数中（毫秒级），之后只经 stdout 读取
      execFileSync(SECURITY_BIN, ['add-generic-password', '-s', KEY_SERVICE, '-a', KEY_ACCOUNT, '-w', fresh.toString('hex'), '-U'], {
        stdio: 'ignore',
        timeout: 15_000,
      });
    } catch (err) {
      console.error('[clouddock] keychain write failed:', err);
      return null;
    }
    key = keychainRead();
    if (!key || !key.equals(fresh)) return null;
  }
  masterKeyCache = key;
  return key;
}

function credAvailable(): boolean {
  return masterKey() !== null;
}

const ENC_PREFIX = 'v2:';

function encryptJson(plain: string): string | null {
  const key = masterKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf-8'), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decryptJson(enc: string): string | null {
  const key = masterKey();
  if (!key || !enc.startsWith(ENC_PREFIX)) return null; // 旧版 safeStorage 密文无法读取，视为未保存
  try {
    const raw = Buffer.from(enc.slice(ENC_PREFIX.length), 'base64');
    if (raw.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

function loadCreds(): void {
  const file = credFile();
  credStore = { entries: [], never: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<CredStore>;
    const seen = new Set<string>();
    for (const r of Array.isArray(data.entries) ? data.entries : []) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.id !== 'string' || seen.has(r.id)) continue;
      if (typeof r.accountId !== 'string' || typeof r.origin !== 'string') continue;
      if (typeof r.enc !== 'string' || typeof r.label !== 'string') continue;
      seen.add(r.id);
      credStore.entries.push({
        id: r.id,
        accountId: r.accountId,
        origin: r.origin,
        label: r.label.slice(0, 120),
        enc: r.enc,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      });
    }
    for (const n of Array.isArray(data.never) ? data.never : []) {
      if (n && typeof n.accountId === 'string' && typeof n.origin === 'string') {
        credStore.never.push({ accountId: n.accountId, origin: n.origin });
      }
    }
  } catch {
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
    }
  }
  // 清理已不存在账号的残留
  credStore.entries = credStore.entries.filter((e) => accounts.some((a) => a.id === e.accountId));
  credStore.never = credStore.never.filter((n) => accounts.some((a) => a.id === n.accountId));
}

function saveCreds(): void {
  try {
    const file = credFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(credStore, null, 2), 0o600);
  } catch (err) {
    console.error('[clouddock] save credentials failed:', err);
  }
}

function decryptEntry(e: CredEntry): FillPayload | null {
  const plain = decryptJson(e.enc);
  if (plain === null) return null;
  try {
    const obj = JSON.parse(plain) as Partial<FillPayload>;
    if (!Array.isArray(obj.fields) || typeof obj.password !== 'string') return null;
    return { fields: obj.fields.map(String), password: obj.password };
  } catch {
    return null; // 钥匙串变化/密文损坏：当作未保存
  }
}

function entriesFor(accountId: string, origin: string): CredEntry[] {
  return credStore.entries
    .filter((e) => e.accountId === accountId && e.origin === origin)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function isNever(accountId: string, origin: string): boolean {
  return credStore.never.some((n) => n.accountId === accountId && n.origin === origin);
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
let pending: RawPending | null = null;
/** 最近一次登录表单提交的用户名：登录页跳转后用于给账号自动命名 */
let loginHint: { accountId: string; tabId: string; label: string; host: string; ts: number } | null = null;
/** 登录成功的跳转通常在提交后数秒内发生；超时视为登录失败/用户已离开 */
const PENDING_TTL = 15_000;

/** webContents.id -> 所属账号/标签（用于校验 IPC 发送方） */
const wcMap = new Map<number, { acc: Account; tab: Tab }>();

function credLabel(fields: string[]): string {
  return fields.filter(Boolean).join(' / ').slice(0, 120);
}

function onCaptured(wcId: number, frameUrl: string | undefined, raw: unknown): void {
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

  if (!credAvailable() || isNever(ctx.acc.id, origin)) return;

  // 同一用户名已有记录？密码也相同 → 不打扰；密码不同 → 提示「更新」
  let existingId: string | null = null;
  for (const e of entriesFor(ctx.acc.id, origin)) {
    const saved = decryptEntry(e);
    if (saved && JSON.stringify(saved.fields) === JSON.stringify(fields)) {
      if (saved.password === r.password) return;
      existingId = e.id;
      break;
    }
  }
  const hadBanner = !!pending?.armed;
  pending = {
    accountId: ctx.acc.id,
    login: { fields, password: r.password },
    origin,
    existingId,
    tabId: ctx.tab.id,
    ts: Date.now(),
    armed: false,
  };
  if (hadBanner) {
    layoutViews();
    sendState();
  }
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
  if (!pending || pending.armed || pending.tabId !== tabId) return;
  if (Date.now() - pending.ts > PENDING_TTL) {
    pending = null;
    return;
  }
  pending.armed = true;
  layoutViews();
  sendState();
}

/** 用户主动导航（地址栏/后退/刷新/首页）不应被当作「登录成功跳转」，丢弃尚未确认的捕获 */
function dropUnarmedPending(): void {
  if (pending && !pending.armed) pending = null;
  loginHint = null;
}

function clearPending(): void {
  const had = !!pending?.armed;
  pending = null;
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
  if (!pending?.armed) return null;
  return {
    accountId: pending.accountId,
    label: credLabel(pending.login.fields),
    host: hostOf(pending.origin),
    update: pending.existingId !== null,
  };
}

function dropAccountCreds(id: string): void {
  credStore.entries = credStore.entries.filter((e) => e.accountId !== id);
  credStore.never = credStore.never.filter((n) => n.accountId !== id);
  if (pending?.accountId === id) clearPending();
  saveCreds();
}

async function deleteCredEntry(entryId: string): Promise<void> {
  const e = credStore.entries.find((x) => x.id === entryId);
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
  credStore.entries = credStore.entries.filter((x) => x.id !== entryId);
  saveCreds();
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
  dropAccountCreds(accountId);
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
  const top = TOPBAR_H + TABBAR_H + (pending?.armed ? BANNER_H : 0);
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
  };
  refreshMenuIfNeeded();
  win.webContents.send('state:update', state);
}

/* ---------- 标签页视图 ---------- */

function createTabView(acc: Account, tab: Tab): WebContentsView {
  const ses = session.fromPartition(`persist:clouddock-${acc.id}`);
  // 去掉 UA 中的 Electron 标识，避免登录链路 UA 校验问题
  const ua = ses.getUserAgent().replace(/Electron\/[\d.]+\s*/i, '');
  ses.setUserAgent(ua);
  applyPermissionPolicy(ses);
  watchAccountIdentity(acc, ses);

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
  safeLoad(wc, isHttpUrl(tab.url) ? tab.url : startUrl());
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
  wcMap.delete(view.webContents.id);
  if (pending && !pending.armed && pending.tabId === tabId) pending = null;
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
  for (const t of acc.tabs) views.get(t.id)?.webContents.reload();
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
    for (const t of a.tabs) views.get(t.id)?.webContents.reload();
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
    onCaptured(e.sender.id, e.senderFrame?.url, raw);
  });

  // 只回给【origin 与保存时完全一致】的页面/iframe；顶层页面也必须是 http(s)
  ipcMain.handle('cred:get', (e): FillPayload | null => {
    const ctx = wcMap.get(e.sender.id);
    if (!ctx || !accounts.includes(ctx.acc)) return null;
    const origin = credOrigin(e.senderFrame?.url);
    if (!origin || !credOrigin(e.sender.getURL())) return null;
    const best = entriesFor(ctx.acc.id, origin)[0];
    return best ? decryptEntry(best) : null;
  });

  // 以下来自界面进程（preload 暴露的 api），只接受主窗口
  const fromUi = (e: Electron.IpcMainInvokeEvent): boolean => !!win && e.sender === win.webContents;

  ipcMain.handle('cred:save', (e): boolean => {
    if (!fromUi(e) || !pending?.armed || !credAvailable()) return false;
    const p = pending;
    const acc = accounts.find((a) => a.id === p.accountId);
    if (!acc) {
      clearPending();
      sendState();
      return false;
    }
    try {
      const enc = encryptJson(JSON.stringify(p.login));
      if (!enc) return false;
      const now = Date.now();
      const exist = p.existingId ? credStore.entries.find((x) => x.id === p.existingId) : undefined;
      if (exist) {
        exist.enc = enc;
        exist.updatedAt = now;
      } else {
        credStore.entries.push({
          id: randomBytes(8).toString('hex'),
          accountId: acc.id,
          origin: p.origin,
          label: credLabel(p.login.fields),
          enc,
          updatedAt: now,
        });
        // 单账号上限：淘汰最旧的
        const mine = credStore.entries.filter((x) => x.accountId === acc.id).sort((a, b) => a.updatedAt - b.updatedAt);
        for (const old of mine.slice(0, Math.max(0, mine.length - MAX_ENTRIES_PER_ACCOUNT))) {
          credStore.entries = credStore.entries.filter((x) => x.id !== old.id);
        }
      }
      saveCreds();
    } catch (err) {
      console.error('[clouddock] encrypt credentials failed:', err);
      return false;
    }
    clearPending();
    sendState();
    return true;
  });

  // never=true：从不保存此网站（对应账号 + origin）
  ipcMain.handle('cred:dismiss', (e, never: unknown): boolean => {
    if (!fromUi(e) || !pending) return false;
    if (never === true && !isNever(pending.accountId, pending.origin)) {
      credStore.never.push({ accountId: pending.accountId, origin: pending.origin });
      saveCreds();
    }
    clearPending();
    sendState();
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
  const mine = acc ? credStore.entries.filter((e) => e.accountId === acc.id).sort((a, b) => b.updatedAt - a.updatedAt) : [];
  const neverCount = acc ? credStore.never.filter((n) => n.accountId === acc.id).length : 0;
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
        credStore.never = credStore.never.filter((n) => n.accountId !== acc.id);
        saveCreds();
        sendState();
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
function refreshMenuIfNeeded(): void {
  const sig = JSON.stringify([
    activeId,
    activeAccount()?.name,
    accounts.length,
    credStore.entries.filter((e) => e.accountId === activeId).map((e) => [e.id, e.origin, e.label]),
    credStore.never.filter((n) => n.accountId === activeId).length,
  ]);
  if (sig === menuSig) return;
  buildMenu();
}

function buildMenu(): void {
  menuSig = JSON.stringify([
    activeId,
    activeAccount()?.name,
    accounts.length,
    credStore.entries.filter((e) => e.accountId === activeId).map((e) => [e.id, e.origin, e.label]),
    credStore.never.filter((n) => n.accountId === activeId).length,
  ]);
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
    loadCreds();
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
