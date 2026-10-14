/*
 * vaultClient —— 主进程侧的密码库客户端（IPC 封装）。
 *
 * 真正的密钥、密文、明文都在 vaultChild（utilityProcess）里，本模块只：
 *  - 维护与子进程的请求/应答配对（自增 id）；
 *  - 缓存元数据镜像（CredMeta[] / never[]，均非敏感，供菜单与去重同步判断）；
 *  - 子进程崩溃/不可用时把 available 置 false：密码保存与填充整体禁用，
 *    绝不回退到明文存储（Chrome 最小权限进程模型：敏感面收窄到单个子进程）。
 */
import { utilityProcess } from 'electron';
import * as path from 'node:path';
import type { CredMeta, NeverSave } from './types';

interface VaultReply {
  id: number;
  result: unknown;
}

export interface DedupResult {
  same: boolean;
  existingId: string | null;
}

export class Vault {
  private child: Electron.UtilityProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private _meta: { entries: CredMeta[]; never: NeverSave[] } = { entries: [], never: [] };
  private _available = false;
  private exited = false;

  get available(): boolean {
    return this._available && !this.exited;
  }

  get entries(): CredMeta[] {
    return this._meta.entries;
  }

  get never(): NeverSave[] {
    return this._meta.never;
  }

  /** 启动子进程并初始化（whenReady 内调用一次；子进程异常退出不自动重启，密码功能静默禁用） */
  async init(userDataDir: string, accountIds: string[]): Promise<void> {
    try {
      this.child = utilityProcess.fork(path.join(__dirname, 'vaultChild.js'));
      this.child.on('exit', (code) => {
        this.exited = true;
        this._available = false;
        console.error(`[clouddock] vault child exited (code=${code}), password saving/filling disabled`);
      });
      const res = (await this.request('init', { userDataDir, accountIds })) as
        | { available: boolean; meta: { entries: CredMeta[]; never: NeverSave[] } }
        | { error?: unknown };
      if (res && 'available' in res) {
        this._available = res.available;
        this._meta = res.meta;
      }
    } catch (err) {
      console.error('[clouddock] vault child failed to start:', err);
      this._available = false;
    }
  }

  private request(op: string, payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.exited) {
        reject(new Error('vault child not running'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.postMessage({ id, op, ...payload });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`vault op timeout: ${op}`));
      }, 20_000).unref?.();
    });
  }

  private takeMeta(result: unknown): void {
    const r = result as { meta?: { entries: CredMeta[]; never: NeverSave[] } } | null;
    if (r && r.meta) this._meta = r.meta;
  }

  /** 同一用户名是否已有保存记录：same=true（密码也相同，不再打扰）/ existingId（提示「更新」） */
  async dedup(accountId: string, origin: string, fields: string[], password: string): Promise<DedupResult | null> {
    try {
      const r = (await this.request('dedup', { accountId, origin, fields, password })) as DedupResult;
      if (r && typeof r.same === 'boolean') return r;
    } catch {
      /* 超时/子进程退出：当作不可用 */
    }
    return null;
  }

  async save(accountId: string, origin: string, label: string, login: { fields: string[]; password: string }, existingId: string | null): Promise<boolean> {
    try {
      const r = (await this.request('save', { accountId, origin, label, login, existingId })) as { ok?: boolean };
      this.takeMeta(r);
      return r?.ok === true;
    } catch {
      return false;
    }
  }

  async decrypt(accountId: string, origin: string): Promise<{ fields: string[]; password: string } | null> {
    try {
      const r = (await this.request('decrypt', { accountId, origin })) as { payload: { fields: string[]; password: string } | null };
      return r?.payload ?? null;
    } catch {
      return null;
    }
  }

  async addNever(accountId: string, origin: string): Promise<void> {
    try {
      this.takeMeta(await this.request('never', { accountId, origin }));
    } catch {
      /* ignore */
    }
  }

  async removeEntry(id: string): Promise<void> {
    try {
      this.takeMeta(await this.request('remove-entry', { id }));
    } catch {
      /* ignore */
    }
  }

  async dropAccount(accountId: string): Promise<void> {
    try {
      this.takeMeta(await this.request('drop-account', { accountId }));
    } catch {
      /* ignore */
    }
  }

  async restoreNever(accountId: string): Promise<void> {
    try {
      this.takeMeta(await this.request('restore-never', { accountId }));
    } catch {
      /* ignore */
    }
  }
}

export const vault = new Vault();
