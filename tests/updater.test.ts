/*
 * updater 集成回归：不启动 Electron —— mock electron API（app/dialog），用本地 http 服务
 * 当更新源、tmp 目录当 userData，真实驱动 checkForUpdatesOnLaunch / checkForUpdatesInteractive
 * 的「读 settings → 拉 manifest → 版本判断 → 提醒弹窗 → 下载尝试」全链路。
 * 不触达真实 GitHub / 真实 .app：zip 均为伪造（下载 404 或 sha 不匹配），不进入
 * 原子切换/relaunch 阶段（该段为 2.3→2.5 生产验证过的原逻辑，仅做了函数抽取）。
 */
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as crypto from 'node:crypto';

/* ---------- electron 替身 ---------- */

const h = vi.hoisted(() => ({
  userDataDir: '',
  version: '2.5.0',
  /** 每次 dialog.showMessageBox 弹出的选项（含 message/buttons），按序消费 responses */
  msgBoxCalls: [] as Array<{ message: string; buttons?: string[] }>,
  /** 每次弹窗用户点掉的按钮序号，shift 消费 */
  responses: [] as number[],
  relaunchCalls: 0,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => h.version,
    getPath: (_key: string) => h.userDataDir,
    relaunch: () => {
      h.relaunchCalls++;
    },
  },
  dialog: {
    showMessageBox: async (opts: { message: string; buttons?: string[] }) => {
      h.msgBoxCalls.push(opts);
      return { response: h.responses.shift() ?? 0 };
    },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
}));

/* ---------- 测试基建 ---------- */

let tmpRoot = '';
let fakeBundle = '';
let origExecPath: string | undefined;
let server: http.Server | null = null;
let serverPort = -1;
/** 服务端收到的请求路径（顺序保留） */
const hits: string[] = [];
/** /update.json 返回内容（每个用例可改写） */
let manifestJson = '';

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0];
      hits.push(url);
      if (url === '/update.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(manifestJson);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (addr && typeof addr === 'object') serverPort = addr.port;
      resolve();
    });
  });
}

function manifestFor(version: string, zip = 'fake.zip', sha256 = '0'.repeat(64), notes?: string): string {
  return JSON.stringify({ version, zip, sha256, ...(notes ? { notes } : {}) });
}

/** 伪造一个「正在运行」的 .app bundle 目录结构 */
function makeFakeBundle(): string {
  const app = path.join(tmpRoot, 'WorkPier.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'WorkPier'), '#!/bin/sh\n', { mode: 0o755 });
  return app;
}

function writeSettings(obj: Record<string, unknown>): void {
  fs.writeFileSync(path.join(h.userDataDir, 'settings.json'), JSON.stringify(obj), 'utf-8');
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'settings.json'), 'utf-8')) as Record<string, unknown>;
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workpier-updater-test.'));
  await startServer();
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例独立的 userData + 干净的弹窗记录
  h.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpier-updater-ud.'));
  h.version = '2.5.0';
  h.msgBoxCalls = [];
  h.responses = [];
  h.relaunchCalls = 0;
  hits.length = 0;
  manifestJson = manifestFor('1.0.0');
  fakeBundle = makeFakeBundle();
  // appBundlePath() 依据 process.execPath 上溯三级定位 .app —— 替换成假 bundle 内的可执行文件
  origExecPath = process.execPath;
  Object.defineProperty(process, 'execPath', {
    value: path.join(fakeBundle, 'Contents', 'MacOS', 'WorkPier'),
    configurable: true,
  });
});

afterEach(() => {
  if (origExecPath !== undefined) {
    Object.defineProperty(process, 'execPath', { value: origExecPath, configurable: true });
  }
  fs.rmSync(h.userDataDir, { recursive: true, force: true });
  fs.rmSync(fakeBundle, { recursive: true, force: true });
});

const feedUrl = (): string => `http://127.0.0.1:${serverPort}/update.json`;

/* ---------- checkForUpdatesOnLaunch ---------- */

describe('checkForUpdatesOnLaunch（启动自动检查）', () => {
  it('旧版本清单：静默，不弹任何窗', async () => {
    writeSettings({ updateFeed: feedUrl() });
    const { checkForUpdatesOnLaunch } = await import('../src/updater');
    await checkForUpdatesOnLaunch(() => {});
    expect(hits).toContain('/update.json'); // 检查确实发生了
    expect(h.msgBoxCalls).toHaveLength(0); // 但完全不打扰
  });

  it('网络不可达：完全静默且不抛错', async () => {
    writeSettings({ updateFeed: 'http://127.0.0.1:1/update.json' }); // 死端口
    const { checkForUpdatesOnLaunch } = await import('../src/updater');
    await expect(checkForUpdatesOnLaunch(() => {})).resolves.toBeUndefined();
    expect(h.msgBoxCalls).toHaveLength(0);
  });

  it('发现新版本：弹「立即更新/稍后提醒/忽略此版本」三键提醒', async () => {
    manifestJson = manifestFor('9.9.9', 'fake.zip', 'a'.repeat(64), '测试新版说明');
    writeSettings({ updateFeed: feedUrl() });
    h.responses = [1]; // 点「稍后提醒」
    const { checkForUpdatesOnLaunch } = await import('../src/updater');
    await checkForUpdatesOnLaunch(() => {});
    expect(h.msgBoxCalls).toHaveLength(1);
    expect(h.msgBoxCalls[0].message).toContain('9.9.9');
    expect(h.msgBoxCalls[0].message).toContain('2.5.0');
    expect(h.msgBoxCalls[0].buttons).toEqual(['立即更新', '稍后提醒', '忽略此版本']);
    // 稍后提醒 ≠ 忽略：不写 skippedVersion
    expect(readSettings().skippedVersion).toBeUndefined();
  });

  it('「忽略此版本」：写入 settings，且同版本下次启动不再提醒', async () => {
    manifestJson = manifestFor('9.9.9');
    writeSettings({ updateFeed: feedUrl() });
    h.responses = [2]; // 点「忽略此版本」
    const { checkForUpdatesOnLaunch } = await import('../src/updater');
    await checkForUpdatesOnLaunch(() => {});
    expect(readSettings().skippedVersion).toBe('9.9.9');

    // 第二次启动（同样新版本）：直接静默
    h.msgBoxCalls = [];
    h.responses = [];
    hits.length = 0;
    await checkForUpdatesOnLaunch(() => {});
    expect(hits).toContain('/update.json'); // 检查照常发生
    expect(h.msgBoxCalls).toHaveLength(0); // 但不再打扰
  });

  it('「忽略」不跨版本：更高版本出现时恢复提醒', async () => {
    manifestJson = manifestFor('9.9.9');
    writeSettings({ updateFeed: feedUrl(), skippedVersion: '9.9.9' });
    const { checkForUpdatesOnLaunch } = await import('../src/updater');
    await checkForUpdatesOnLaunch(() => {});
    expect(h.msgBoxCalls).toHaveLength(0); // 9.9.9 被忽略

    manifestJson = manifestFor('10.0.0');
    h.msgBoxCalls = [];
    h.responses = [1];
    await checkForUpdatesOnLaunch(() => {});
    expect(h.msgBoxCalls).toHaveLength(1); // 10.0.0 恢复提醒
    expect(h.msgBoxCalls[0].message).toContain('10.0.0');
  });

  it('「立即更新」：尝试下载更新包（服务端收到 zip 请求）；下载失败弹错误且不影响当前版本', async () => {
    manifestJson = manifestFor('9.9.9', 'fake.zip', 'a'.repeat(64));
    writeSettings({ updateFeed: feedUrl() });
    h.responses = [0]; // 点「立即更新」
    const { checkForUpdatesOnLaunch } = await import('../src/updater');
    await checkForUpdatesOnLaunch(() => {});
    expect(hits).toContain('/fake.zip'); // 确实发起了下载
    // zip 404 → 下载失败 → 错误弹窗
    expect(h.msgBoxCalls.some((c) => c.message === '更新失败')).toBe(true);
    // 当前版本未受影响：假 bundle 还在，且从未 relaunch
    expect(fs.existsSync(path.join(fakeBundle, 'Contents', 'MacOS', 'WorkPier'))).toBe(true);
    expect(h.relaunchCalls).toBe(0);
  });

  it('开发模式：直接跳过（不检查不弹窗）', async () => {
    const electron = (await import('electron')) as unknown as { app: { isPackaged: boolean } };
    electron.app.isPackaged = false;
    try {
      writeSettings({ updateFeed: feedUrl() });
      const { checkForUpdatesOnLaunch } = await import('../src/updater');
      await checkForUpdatesOnLaunch(() => {});
      expect(hits).toHaveLength(0);
      expect(h.msgBoxCalls).toHaveLength(0);
    } finally {
      electron.app.isPackaged = true;
    }
  });
});

/* ---------- checkForUpdatesInteractive ---------- */

describe('checkForUpdatesInteractive（手动检查）', () => {
  it('已是最新：提示已是最新版本', async () => {
    writeSettings({ updateFeed: feedUrl() });
    const { checkForUpdatesInteractive } = await import('../src/updater');
    await checkForUpdatesInteractive(() => {});
    expect(h.msgBoxCalls).toHaveLength(1);
    expect(h.msgBoxCalls[0].message).toBe('已是最新版本');
  });

  it('本地目录 feed：自动找 update.json，zip 走本地复制；sha 不匹配 → 校验失败弹窗，绝不安装', async () => {
    // 本地目录更新源（模拟用户选了目录而非文件）
    const feedDir = path.join(tmpRoot, 'feeddir');
    fs.mkdirSync(feedDir, { recursive: true });
    const zipBytes = Buffer.from('not-a-real-zip');
    const sha = crypto.createHash('sha256').update(zipBytes).digest('hex');
    fs.writeFileSync(path.join(feedDir, 'app.zip'), zipBytes);
    // 故意写错的 sha（与文件内容不符）→ 必须在校验环节被拦下
    fs.writeFileSync(
      path.join(feedDir, 'update.json'),
      JSON.stringify({ version: '9.9.9', zip: 'app.zip', sha256: 'b'.repeat(64) }),
    );
    writeSettings({ updateFeed: feedDir });
    h.responses = [0]; // 确认更新
    const { checkForUpdatesInteractive } = await import('../src/updater');
    await checkForUpdatesInteractive(() => {});
    expect(h.msgBoxCalls.some((c) => c.message === '更新包校验失败')).toBe(true);
    // 校验失败即中止：未进入解包/切换，bundle 原样
    expect(fs.existsSync(path.join(fakeBundle, 'Contents', 'MacOS', 'WorkPier'))).toBe(true);
    expect(h.relaunchCalls).toBe(0);
  });
});
