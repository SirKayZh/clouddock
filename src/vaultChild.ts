/*
 * vaultChild —— 密码库 utilityProcess 子进程（Chrome helper 思想：最小权限进程拆分）。
 *
 * 职责边界（与主进程之间只传最小必要数据）：
 *  - 主密钥的生成/读取/迁移只发生在这里，密钥永远不进主进程内存；
 *  - credentials.json 的加载/加密/落盘全部在本进程完成（原子写，0600）；
 *  - 主进程只拿到 CredMeta 元数据（id/origin/label/updatedAt，不含明文也不含密文），
 *    与 never 列表（仅 accountId+origin，非敏感），用于菜单展示与去重判断；
 *  - 解密后的 FillPayload 只会发往发起 cred:get 的页面注入脚本（经主进程透传，不落盘）。
 *
 * 钥匙串命名迁移（Chrome keychain-access-groups 命名规范的本地版）：
 *  - 新服务名 com.clouddock.credentials.v1；
 *  - 首次启动读到旧条目（CloudDock Credential Key）时，把同一密钥写入新服务名，
 *    密文无需重新加密；旧条目保留不删，防止用户在旧版本间来回切换丢数据。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ParentPort } from 'electron';

interface CredEntry {
  id: string;
  accountId: string;
  origin: string;
  label: string;
  /** 'v2:' + base64(iv|tag|密文)：JSON { fields, password } */
  enc: string;
  updatedAt: number;
}
interface CredStore {
  entries: CredEntry[];
  never: { accountId: string; origin: string }[];
}

const ENC_PREFIX = 'v2:';
const KEY_SERVICE = 'com.clouddock.credentials.v1';
const LEGACY_KEY_SERVICE = 'CloudDock Credential Key';
const KEY_ACCOUNT = 'clouddock';
const SECURITY_BIN = '/usr/bin/security';
const MAX_ENTRIES_PER_ACCOUNT = 500;

let userDataDir = '';
let store: CredStore = { entries: [], never: [] };
let masterKey: Buffer | null = null;
/** 正在写盘的入口保护：避免 save 与 prune 并发交错写坏文件（单进程内顺序化足够） */
let saveQueued = false;

/* ---------- 钥匙串 ---------- */

function keychainRead(service: string): Buffer | null {
  try {
    const out = execFileSync(
      SECURITY_BIN,
      ['find-generic-password', '-s', service, '-a', KEY_ACCOUNT, '-w'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 },
    ).trim();
    const buf = Buffer.from(out, 'hex');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

function keychainWrite(service: string, key: Buffer): boolean {
  try {
    // 仅首次创建时密钥短暂出现在命令行参数中（毫秒级），之后只经 stdout 读取
    execFileSync(
      SECURITY_BIN,
      ['add-generic-password', '-s', service, '-a', KEY_ACCOUNT, '-w', key.toString('hex'), '-U'],
      { stdio: 'ignore', timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** 取主密钥：新服务名 → 旧服务名迁移 → 全新创建。失败返回 null（上层禁用功能，绝不明文降级） */
function ensureMasterKey(): Buffer | null {
  if (masterKey) return masterKey;
  if (process.platform !== 'darwin') return null;
  let key = keychainRead(KEY_SERVICE);
  if (!key) {
    const legacy = keychainRead(LEGACY_KEY_SERVICE);
    if (legacy) {
      // 旧密钥迁到新服务名；迁移成功与否都继续用旧值解密（密文未变）
      keychainWrite(KEY_SERVICE, legacy);
      key = legacy;
    }
  }
  if (!key) {
    const fresh = randomBytes(32);
    if (!keychainWrite(KEY_SERVICE, fresh)) return null;
    const verify = keychainRead(KEY_SERVICE);
    if (!verify || !verify.equals(fresh)) return null;
    key = fresh;
  }
  masterKey = key;
  return key;
}

/* ---------- AES-256-GCM ---------- */

function encryptJson(plain: string): string | null {
  const key = ensureMasterKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf-8'), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decryptJson(enc: string): string | null {
  const key = ensureMasterKey();
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

/* ---------- 存储文件 ---------- */

function credFile(): string {
  return path.join(userDataDir, 'credentials.json');
}

/** 原子写：先写临时文件再 rename，避免崩溃/断电写一半损坏密码库 */
function saveStore(): void {
  if (saveQueued) return;
  saveQueued = true;
  try {
    const file = credFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[vault] save failed:', err);
  } finally {
    saveQueued = false;
  }
}

function loadStore(): void {
  const file = credFile();
  store = { entries: [], never: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<CredStore>;
    const seen = new Set<string>();
    for (const r of Array.isArray(data.entries) ? data.entries : []) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.id !== 'string' || seen.has(r.id)) continue;
      if (typeof r.accountId !== 'string' || typeof r.origin !== 'string') continue;
      if (typeof r.enc !== 'string' || typeof r.label !== 'string') continue;
      seen.add(r.id);
      store.entries.push({
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
        store.never.push({ accountId: n.accountId, origin: n.origin });
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
}

/** 主进程是账号列表的唯一权威：清理已删账号的残留条目，有变化则落盘 */
function pruneAccounts(validIds: string[]): boolean {
  const valid = new Set(validIds);
  const before = store.entries.length + store.never.length;
  store.entries = store.entries.filter((e) => valid.has(e.accountId));
  store.never = store.never.filter((n) => valid.has(n.accountId));
  const changed = store.entries.length + store.never.length !== before;
  if (changed) saveStore();
  return changed;
}

/* ---------- 去重 / 填充 ---------- */

function normFields(f: string[]): string {
  return f.map((x) => x.trim().toLowerCase()).join('\u0001');
}

interface LoginPayload {
  fields: string[];
  password: string;
}

function decryptEntry(e: CredEntry): LoginPayload | null {
  const plain = decryptJson(e.enc);
  if (plain === null) return null;
  try {
    const obj = JSON.parse(plain) as Partial<LoginPayload>;
    if (!Array.isArray(obj.fields) || typeof obj.password !== 'string') return null;
    return { fields: obj.fields.map(String), password: obj.password };
  } catch {
    return null; // 钥匙串变化/密文损坏：当作未保存
  }
}

/* ---------- IPC 协议 ---------- */

interface VaultRequest {
  id: number;
  op: string;
  [k: string]: unknown;
}

function meta(): unknown {
  return {
    entries: store.entries.map((e) => ({ id: e.id, accountId: e.accountId, origin: e.origin, label: e.label, updatedAt: e.updatedAt })),
    never: store.never.map((n) => ({ accountId: n.accountId, origin: n.origin })),
  };
}

function handle(req: VaultRequest): unknown {
  switch (req.op) {
    case 'init': {
      userDataDir = String(req.userDataDir ?? '');
      const valid = Array.isArray(req.accountIds) ? (req.accountIds as unknown[]).map(String) : [];
      masterKey = null; // 测试/热重启场景下重置缓存
      const available = ensureMasterKey() !== null;
      loadStore();
      if (valid.length > 0) pruneAccounts(valid);
      return { available, meta: meta() };
    }
    case 'available':
      return { available: ensureMasterKey() !== null };
    case 'dedup': {
      // 同用户名已有记录？密码相同 → 提示不再打扰；密码不同 → 返回 existingId 供「更新」
      const accountId = String(req.accountId ?? '');
      const origin = String(req.origin ?? '');
      const fields = Array.isArray(req.fields) ? (req.fields as unknown[]).map(String) : [];
      const password = String(req.password ?? '');
      for (const e of store.entries) {
        if (e.accountId !== accountId || e.origin !== origin) continue;
        const saved = decryptEntry(e);
        if (saved && normFields(saved.fields) === normFields(fields)) {
          return saved.password === password ? { same: true, existingId: e.id } : { same: false, existingId: e.id };
        }
      }
      return { same: false, existingId: null };
    }
    case 'save': {
      const key = ensureMasterKey();
      const accountId = String(req.accountId ?? '');
      const origin = String(req.origin ?? '');
      const label = String(req.label ?? '').slice(0, 120);
      const login = req.login as Partial<LoginPayload> | undefined;
      if (!key || !login || !Array.isArray(login.fields) || typeof login.password !== 'string') return { ok: false, meta: meta() };
      const enc = encryptJson(JSON.stringify({ fields: login.fields.map(String), password: login.password }));
      if (!enc) return { ok: false, meta: meta() };
      const now = Date.now();
      const existingId = typeof req.existingId === 'string' ? req.existingId : null;
      const exist = existingId ? store.entries.find((x) => x.id === existingId) : undefined;
      if (exist) {
        exist.enc = enc;
        exist.label = label || exist.label;
        exist.updatedAt = now;
      } else {
        store.entries.push({
          id: randomBytes(8).toString('hex'),
          accountId,
          origin,
          label,
          enc,
          updatedAt: now,
        });
        // 单账号上限：淘汰最旧的
        const mine = store.entries.filter((x) => x.accountId === accountId).sort((a, b) => a.updatedAt - b.updatedAt);
        for (const old of mine.slice(0, Math.max(0, mine.length - MAX_ENTRIES_PER_ACCOUNT))) {
          store.entries = store.entries.filter((x) => x.id !== old.id);
        }
      }
      saveStore();
      return { ok: true, meta: meta() };
    }
    case 'decrypt': {
      // 取该账号该 origin 最近保存的一条，解密后回给页面填充
      const accountId = String(req.accountId ?? '');
      const origin = String(req.origin ?? '');
      const best = store.entries
        .filter((e) => e.accountId === accountId && e.origin === origin)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!best) return { payload: null };
      return { payload: decryptEntry(best) };
    }
    case 'never': {
      const accountId = String(req.accountId ?? '');
      const origin = String(req.origin ?? '');
      if (!store.never.some((n) => n.accountId === accountId && n.origin === origin)) {
        store.never.push({ accountId, origin });
        saveStore();
      }
      return { meta: meta() };
    }
    case 'remove-entry': {
      const id = String(req.id ?? '');
      store.entries = store.entries.filter((x) => x.id !== id);
      saveStore();
      return { meta: meta() };
    }
    case 'drop-account': {
      const accountId = String(req.accountId ?? '');
      store.entries = store.entries.filter((e) => e.accountId !== accountId);
      store.never = store.never.filter((n) => n.accountId !== accountId);
      saveStore();
      return { meta: meta() };
    }
    case 'restore-never': {
      const accountId = String(req.accountId ?? '');
      store.never = store.never.filter((n) => n.accountId !== accountId);
      saveStore();
      return { meta: meta() };
    }
    default:
      return { error: `unknown op: ${req.op}` };
  }
}

// utilityProcess 子进程入口：process.parentPort 由 Electron 注入（Node 侧无其类型声明）
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
parentPort.on('message', (e) => {
  const req = (e as unknown as { data: VaultRequest }).data;
  try {
    const result = handle(req);
    parentPort.postMessage({ id: req.id, result });
  } catch (err) {
    console.error('[vault] op failed:', req.op, err);
    parentPort.postMessage({ id: req.id, result: { error: String(err) } });
  }
});
