/**
 * 纯函数模块：不依赖 electron / fs，可直接被 vitest 单测覆盖。
 * main.ts 与页面桥共用，保证解析/清洗规则只有一份实现。
 */
import type { Account, Tab } from './types';

export const PALETTE = [
  '#0052D9', '#00A870', '#ED7B2F', '#7B61FF',
  '#E3737B', '#029BE5', '#B58A00', '#2E7D32',
];

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
