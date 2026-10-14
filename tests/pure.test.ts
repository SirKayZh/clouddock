import { describe, expect, it } from 'vitest';
import {
  PALETTE,
  homeFor,
  hostnameOf,
  isHttpUrl,
  registrableDomain,
  resolveInput,
  sanitizeAccount,
  siteLabel,
} from '../src/pure';

describe('resolveInput（地址栏输入解析）', () => {
  it('空输入返回 null', () => {
    expect(resolveInput('')).toBeNull();
    expect(resolveInput('   ')).toBeNull();
  });

  it('完整 URL 原样返回', () => {
    expect(resolveInput('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(resolveInput('HTTP://EXAMPLE.COM')).toBe('HTTP://EXAMPLE.COM');
  });

  it('localhost / IP 补 http://（内网控制台常见）', () => {
    expect(resolveInput('localhost:3000')).toBe('http://localhost:3000');
    expect(resolveInput('192.168.1.10:8080/admin')).toBe('http://192.168.1.10:8080/admin');
    expect(resolveInput('127.0.0.1')).toBe('http://127.0.0.1');
  });

  it('裸域名补 https://', () => {
    expect(resolveInput('github.com')).toBe('https://github.com');
    expect(resolveInput('a.b.com.cn/x')).toBe('https://a.b.com.cn/x');
    expect(resolveInput('example.com:8443')).toBe('https://example.com:8443');
  });

  it('含空格的搜索词走 Bing 搜索', () => {
    expect(resolveInput('腾讯云 控制台')).toBe(
      `https://www.bing.com/search?q=${encodeURIComponent('腾讯云 控制台')}`,
    );
  });

  it('无点号的单字不是域名，按搜索处理', () => {
    expect(resolveInput('hello')).toBe(`https://www.bing.com/search?q=hello`);
  });
});

describe('registrableDomain（注册域）', () => {
  it('普通二级域', () => {
    expect(registrableDomain('console.cloud.tencent.com')).toBe('tencent.com');
    expect(registrableDomain('github.com')).toBe('github.com');
  });

  it('com.cn / co.uk 一类三级注册域', () => {
    expect(registrableDomain('a.b.com.cn')).toBe('b.com.cn');
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('IP 与单段 host 原样返回', () => {
    expect(registrableDomain('1.2.3.4')).toBe('1.2.3.4');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});

describe('hostnameOf / siteLabel / homeFor', () => {
  it('hostname 小写化并去 www.', () => {
    expect(hostnameOf('https://WWW.Example.COM/x')).toBe('example.com');
    expect(hostnameOf('not a url')).toBe('');
  });

  it('已知站点显示友好名称', () => {
    expect(siteLabel('https://console.cloud.tencent.com/')).toBe('腾讯云');
    expect(siteLabel('https://github.com/login')).toBe('GitHub');
  });

  it('未知站点取注册域', () => {
    expect(siteLabel('https://docs.ffmpeg.org/')).toBe('ffmpeg.org');
  });

  it('腾讯云站点的账号首页直达控制台', () => {
    expect(homeFor('https://console.tencentcloud.com/xxx')).toBe('https://console.tencentcloud.com/');
    expect(homeFor('https://cloud.tencent.com/login')).toBe('https://console.cloud.tencent.com/');
    expect(homeFor('https://github.com/login')).toBe('https://github.com/');
  });
});

describe('isHttpUrl', () => {
  it('只认 http(s)', () => {
    expect(isHttpUrl('https://a.com')).toBe(true);
    expect(isHttpUrl('http://a.com')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl(123)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});

describe('sanitizeAccount（磁盘脏数据防御）', () => {
  const base = {
    id: 'abc123',
    name: '测试账号',
    tabs: [
      { id: 't1', url: 'https://a.com/', title: 'A' },
      { id: 't1', url: 'javascript:evil', title: 'dup' }, // 重复 id，应被丢弃
    ],
  };

  it('合法数据通过并去重 tab id', () => {
    const a = sanitizeAccount(base);
    expect(a).not.toBeNull();
    expect(a?.tabs).toHaveLength(1);
    expect(a?.tabs[0].id).toBe('t1');
  });

  it('非法 url 的 tab 被置空（回起始页）而非保留', () => {
    const a = sanitizeAccount({ ...base, tabs: [{ id: 't2', url: 'file:///x', title: 'x' }] });
    expect(a?.tabs[0].url).toBe('');
  });

  it('id 不合法 / 类型不对整体拒绝', () => {
    expect(sanitizeAccount(null)).toBeNull();
    expect(sanitizeAccount('x')).toBeNull();
    expect(sanitizeAccount({ ...base, id: 'has space' })).toBeNull();
    expect(sanitizeAccount({ ...base, id: 'x'.repeat(65) })).toBeNull();
    expect(sanitizeAccount({ ...base, name: 42 })).toBeNull();
  });

  it('缺失字段回退默认值', () => {
    const a = sanitizeAccount({ id: 'ok1', name: '' });
    expect(a?.name).toBe('未命名');
    expect(a?.color).toBe(PALETTE[0]);
    expect(a?.tabs).toEqual([]);
    expect(a?.activeTabId).toBeNull();
    expect(a?.autoName).toBe(false);
  });

  it('超长字段截断', () => {
    const a = sanitizeAccount({ ...base, name: 'x'.repeat(99), note: 'y'.repeat(99) });
    expect(a?.name).toHaveLength(30);
    expect(a?.note).toHaveLength(60);
  });

  it('uin/nameSource 升级兼容', () => {
    const legacy = sanitizeAccount({ id: 'ok2', name: '10001', autoName: true, uin: '10001' });
    expect(legacy?.nameSource).toBe('uin');
    const bad = sanitizeAccount({ id: 'ok3', name: 'x', uin: '12ab' });
    expect(bad?.uin).toBeUndefined();
  });
});

import { isNewerVersion, sanitizeUpdateManifest } from '../src/pure';

describe('sanitizeUpdateManifest（更新清单校验）', () => {
  const ok = { version: '1.6.0', zip: 'CloudDock-1.6.0-update.zip', sha256: 'a'.repeat(64) };

  it('合法清单原样通过，sha256 归一为小写', () => {
    const m = sanitizeUpdateManifest({ ...ok, sha256: 'A'.repeat(64), notes: 'x'.repeat(600) });
    expect(m?.version).toBe('1.6.0');
    expect(m?.sha256).toBe('a'.repeat(64));
    expect(m?.notes).toHaveLength(500);
  });

  it('结构/字段不合法整体拒绝', () => {
    expect(sanitizeUpdateManifest(null)).toBeNull();
    expect(sanitizeUpdateManifest('x')).toBeNull();
    expect(sanitizeUpdateManifest({ ...ok, version: 'v1.2' })).toBeNull();
    expect(sanitizeUpdateManifest({ ...ok, version: '1.2' })).toBeNull();
    expect(sanitizeUpdateManifest({ ...ok, sha256: 'zz' })).toBeNull();
    expect(sanitizeUpdateManifest({ ...ok, zip: 'a/b.zip' })).toBeNull(); // 不允许路径分隔符
    expect(sanitizeUpdateManifest({ ...ok, zip: '' })).toBeNull();
  });
});

describe('isNewerVersion（语义化版本比较）', () => {
  it('主/次/修订逐段比较', () => {
    expect(isNewerVersion('1.6.0', '1.5.9')).toBe(true);
    expect(isNewerVersion('1.5.9', '1.6.0')).toBe(false);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.5.0', '1.5.0')).toBe(false);
    expect(isNewerVersion('1.5.0', '1.5.0')).toBe(false);
  });

  it('段数不齐时缺省按 0 补', () => {
    expect(isNewerVersion('1.6', '1.5.9')).toBe(true);
    expect(isNewerVersion('1.5.0.1', '1.5.0')).toBe(true);
  });
});
