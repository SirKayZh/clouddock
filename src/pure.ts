/**
 * 纯函数模块：不依赖 electron / fs，可直接被 vitest 单测覆盖。
 * main.ts 与页面桥共用，保证解析/清洗规则只有一份实现。
 */
import type { Account, Berth, Tab } from './types';

export const PALETTE = [
  '#0052D9', '#00A870', '#ED7B2F', '#7B61FF',
  '#E3737B', '#029BE5', '#B58A00', '#2E7D32',
];

/** 默认工作区：v2.0 前的全部老账号（无 berthId）自动归入 */
export const DEFAULT_BERTH_ID = 'cloud';

/** 账号所属工作区：berthId 缺省/无效（工作区已被删）= 默认区 */
export function berthOfAccount(acc: Account, berthIds?: Set<string>): string {
  const b = acc.berthId;
  return b && (!berthIds || berthIds.has(b)) ? b : DEFAULT_BERTH_ID;
}

/**
 * 工作区内账号重排（拖拽排序核心逻辑）：
 * orderedIds 必须恰好是「该工作区当前可见账号」的完整新顺序（多一个/少一个都拒绝）。
 * 语义：本区账号在全局数组中的「槽位集合」不变，只是槽位内按新顺序重新填充；
 * 其他工作区账号的位置与相对顺序完全不受影响。
 * 无变化/入参不合法时原样返回（引用不变，调用方可直接判 === 短路）。
 */
export function reorderAccountsInBerth(
  accounts: Account[],
  berthId: string,
  orderedIds: string[],
): Account[] {
  const berthIds = new Set(accounts.filter((a) => berthOfAccount(a) === berthId).map((a) => a.id));
  if (berthIds.size < 2) return accounts; // 0/1 个账号没有重排意义
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (!berthIds.has(id) || seen.has(id)) return accounts; // 含外区 id / 重复 id → 拒绝
    seen.add(id);
  }
  if (seen.size !== berthIds.size) return accounts; // 不是完整列表 → 拒绝
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const queue = orderedIds.map((id) => byId.get(id)).filter((a): a is Account => Boolean(a));
  const result: Account[] = [];
  let qi = 0;
  for (const a of accounts) {
    if (berthIds.has(a.id)) {
      const acc = queue[qi];
      if (acc) result.push(acc);
      qi += 1;
    } else {
      result.push(a);
    }
  }
  return result;
}

/** 磁盘读入的 Berth 结构/类型校验（berths.json） */
export function sanitizeBerth(raw: unknown): Berth | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<Berth>;
  if (typeof b.id !== 'string' || !/^[\w-]{1,64}$/.test(b.id)) return null;
  if (typeof b.name !== 'string' || b.name.trim().length === 0) return null;
  return {
    id: b.id,
    name: b.name.trim().slice(0, 12),
    // emoji 可能是多 code point（ZWJ 序列），不能 slice 粗暴截断；长度超限视为无效给默认值
    icon: typeof b.icon === 'string' && b.icon.length > 0 && b.icon.length <= 16 ? b.icon : '⚓️',
    createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now(),
  };
}

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

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 取注册域（粗略处理 com.cn / co.uk 一类二级后缀） */
export function registrableDomain(host: string): string {
  if (/^\d+(\.\d+){3}$/.test(host) || !host.includes('.')) return host;
  const parts = host.split('.');
  const sld = new Set(['com', 'co', 'net', 'org', 'gov', 'edu']);
  const n = parts.length >= 3 && sld.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

export function siteLabel(url: string): string {
  const host = hostnameOf(url);
  if (!host) return '';
  const hit = SITE_NAMES.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`));
  return hit ? hit[1] : registrableDomain(host);
}

/** 账号「首页」：腾讯云直达控制台，其它站点取站点根 */
export function homeFor(url: string): string {
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
export function resolveInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

export function isHttpUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

/** 对磁盘读入的数据做结构/类型校验，脏数据不会拖垮渲染或会话分区 */
export function sanitizeAccount(raw: unknown): Account | null {
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
    berthId: typeof a.berthId === 'string' && a.berthId.length > 0 ? a.berthId : undefined,
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

/* ---------- 更新清单（Chrome 式自更新：manifest 校验 + 版本比较） ---------- */

export interface UpdateManifest {
  version: string;
  /** zip 文件名（本地 feed = 相对 manifest 的路径；http feed = 相对 URL 或绝对 URL） */
  zip: string;
  sha256: string;
  notes?: string;
}

/**
 * 校验 update.json 的结构：version 必须是 x.y.z 形态、zip 不含路径分隔符
 * （只允许「文件名」，路径由主进程基于 manifest 位置拼接，防止清单里塞绝对路径/穿越路径）。
 */
export function sanitizeUpdateManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<UpdateManifest>;
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) return null;
  if (typeof m.zip !== 'string' || m.zip.length === 0 || m.zip.length > 200) return null;
  if (/[/\\]/.test(m.zip)) return null;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) return null;
  return {
    version: m.version,
    zip: m.zip,
    sha256: m.sha256.toLowerCase(),
    notes: typeof m.notes === 'string' ? m.notes.slice(0, 500) : undefined,
  };
}

/** 语义化版本比较：candidate 是否比 current 新（逐段数值比较） */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((x) => /^\d+$/.test(x) ? Number(x) : 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
