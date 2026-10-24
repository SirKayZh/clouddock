/*
 * updater —— Chrome 式自更新（Versions 双版本 + 原子切换 + 自动回滚）。
 *
 * 触发方式（两种，共用同一套安装流程）：
 *  - 自动：启动 5s 后静默检查 GitHub 最新 Release（checkForUpdatesOnLaunch），
 *    网络失败/无新版不弹窗；有新版才提醒：「立即更新 / 稍后提醒 / 忽略此版本」
 *  - 手动：菜单「检查更新…」（checkForUpdatesInteractive）
 *
 * 流程：
 *  1. 更新源：settings.json 里的 updateFeed；未设置用 DEFAULT_UPDATE_FEED
 *     （GitHub Releases 的 latest 稳定跳转，发版时上传 update.zip + update.json 即生效）。
 *     手动检查时 GitHub 不可达则回落文件选择器（本地测试更新流程用）
 *  2. 读 manifest → sanitizeUpdateManifest 校验 → isNewerVersion 判断
 *  3. 下载 zip → SHA-256 流式校验（对不上立即中止，绝不安装）
 *  4. /usr/bin/ditto 解包（苹果签名二进制，与钥匙串方案一致的供应链原则）→ 剥离 quarantine
 *  5. 原子切换：旧 .app rename 为 *.previous（运行中可 rename）→ 新 .app 就位
 *     —— 磁盘上始终保留两代版本，任一时刻崩溃都能回到上一版（Chrome Versions/.39+.40 的做法）
 *  6. app.relaunch 拉起新版（携带 --workpier-update-token 参数；v1.x 老进程拉起时
 *     传的是旧名 --clouddock-update-token，均能识别），老进程原地等待握手信号：
 *     新版窗口 ready 后写 token → 老进程正常退出；30s 未握手 → 判定新版起不来，
 *     自动回滚 rename 并弹窗告知，老进程继续运行。任何时刻断电/崩溃：
 *     下次启动检查 pending-update.json 兜底清理。
 *
 * 本地包（package.sh 产出）：release/WorkPier-<ver>-update.zip + release/update.json，
 * 把这两个文件放任意目录/静态服务器即可作为更新源；对外分发走 GitHub Release。
 */
import { app, dialog } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { sanitizeUpdateManifest, isNewerVersion, isHttpUrl } from './pure';
import type { UpdateManifest } from './pure';

export const UPDATE_TOKEN_ARG = '--workpier-update-token';
/** v1.x（CloudDock 时代）老进程 relaunch 时携带的旧参数名，兼容 1.7.x → 2.0 跨版升级握手 */
const LEGACY_UPDATE_TOKEN_ARG = '--clouddock-update-token';

/**
 * 默认更新源：GitHub Releases 的 latest 稳定跳转（302 到最新 Release 的同名 asset）。
 * 发版流程：package.sh 产出 update.zip + update.json → 上传到 GitHub Release（tag = vX.Y.Z），
 * 所有已安装用户即自动发现新版本（releases/latest/download/ 始终指向最新非 prerelease）。
 */
export const DEFAULT_UPDATE_FEED = 'https://github.com/SirKayZh/workpier/releases/latest/download/update.json';

export function updateTokenFromArgv(argv: string[]): string | null {
  const i = Math.max(argv.indexOf(UPDATE_TOKEN_ARG), argv.indexOf(LEGACY_UPDATE_TOKEN_ARG));
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/* ---------- settings ---------- */

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readSetting(key: string): unknown {
  return readSettings()[key];
}

function writeSetting(key: string, value: unknown): void {
  try {
    const s = readSettings();
    s[key] = value;
    const file = settingsFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { encoding: 'utf-8' });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[workpier] save settings failed:', err);
  }
}

function readUpdateFeed(): string | null {
  const v = readSetting('updateFeed');
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function writeUpdateFeed(feed: string): void {
  writeSetting('updateFeed', feed);
}

/** 「忽略此版本」记录：直到更高版本发布前不再提醒 */
function readSkippedVersion(): string | null {
  const v = readSetting('skippedVersion');
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

/* ---------- manifest / zip 获取 ---------- */

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    mod.get(url, { timeout: 15_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(new URL(res.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** 把 URL 下载/本地文件复制到目标路径；返回实际写入字节数（用于基本进度感知） */
function downloadTo(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isHttpUrl(src)) {
      fs.copyFile(src, dest, (err) => (err ? reject(err) : resolve()));
      return;
    }
    const mod = src.startsWith('http://') ? http : https;
    mod.get(src, { timeout: 300_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadTo(new URL(res.headers.location, src).toString(), dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function exec(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 300_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

function rmRf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 正在运行的 .app bundle 根目录（Contents/MacOS/exe → 上溯三级） */
export function appBundlePath(): string | null {
  if (!app.isPackaged) return null;
  const exe = process.execPath;
  // <bundle>/Contents/MacOS/<name>
  const macos = path.dirname(exe);
  const contents = path.dirname(macos);
  const root = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents') return null;
  return root;
}

function pendingUpdateFile(): string {
  return path.join(app.getPath('userData'), 'pending-update.json');
}

/**
 * 新实例启动时调用：处理上一次更新遗留。
 *  - pending.to == 当前版本 → 更新成功：清掉 pending（.previous 保留，作为双版本回滚保障）
 *  - 版本不匹配 → 上次更新已被回滚，pending 是残渣：清掉
 */
export function reconcilePendingUpdate(): void {
  try {
    const file = pendingUpdateFile();
    if (!fs.existsSync(file)) return;
    const pending = JSON.parse(fs.readFileSync(file, 'utf-8')) as { to?: unknown };
    if (pending.to === app.getVersion()) {
      console.log(`[workpier] update to ${app.getVersion()} verified`);
    }
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

function msgBox(opts: Electron.MessageBoxOptions): void {
  void dialog.showMessageBox({
    buttons: ['好'],
    ...opts,
  });
}

/* ---------- 主流程 ---------- */

/** manifest 加载结果：ok 之外的 reason 用于区分报错文案 */
type ManifestLoadResult =
  | { ok: true; manifest: UpdateManifest; manifestUrl: string }
  | { ok: false; reason: 'network' | 'format'; error?: string };

/** 读更新清单：http(s) URL 拉远端，本地路径读文件（目录自动找 update.json） */
async function loadManifest(feed: string): Promise<ManifestLoadResult> {
  try {
    let text: string;
    let manifestUrl = feed;
    if (/^https?:\/\//i.test(feed)) {
      text = await fetchText(feed);
    } else {
      let file = feed;
      // 选了目录时自动找 update.json
      if (fs.statSync(file).isDirectory()) {
        file = path.join(file, 'update.json');
        manifestUrl = file;
      }
      text = fs.readFileSync(file, 'utf-8');
    }
    const manifest = sanitizeUpdateManifest(JSON.parse(text));
    if (!manifest) return { ok: false, reason: 'format' };
    return { ok: true, manifest, manifestUrl };
  } catch (err) {
    console.error('[workpier] read manifest failed:', err);
    return { ok: false, reason: 'network', error: String((err as Error).message ?? err) };
  }
}

/**
 * 安装核心（下载 → SHA-256 校验 → 解包 → 原子切换 → relaunch 握手 → 失败回滚）。
 * 手动/自动两个入口共用；失败场景自行弹窗，不影响当前版本运行。
 * preExit：老进程握手成功后、process.exit(0) 前的清理钩子
 * （app.exit/process.exit 都不触发 before-quit，保存状态与清运行标记必须由钩子完成）。
 */
async function downloadAndInstall(
  bundle: string,
  feed: string,
  manifest: UpdateManifest,
  manifestUrl: string,
  preExit: () => void,
): Promise<void> {
  const staging = path.join(app.getPath('userData'), 'update-staging');
  rmRf(staging);
  fs.mkdirSync(staging, { recursive: true });
  const zipPath = path.join(staging, 'update.zip');
  const zipSrc = isHttpUrl(feed)
    ? new URL(manifest.zip, manifestUrl).toString()
    : path.join(path.dirname(manifestUrl), manifest.zip);
  try {
    await downloadTo(zipSrc, zipPath);
    const digest = await sha256File(zipPath);
    if (digest !== manifest.sha256) {
      rmRf(staging);
      msgBox({ type: 'error', message: '更新包校验失败', detail: 'SHA-256 不匹配，已中止安装。请检查更新源文件是否完整。' });
      return;
    }
    const extractDir = path.join(staging, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    await exec('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
    const extracted = fs.readdirSync(extractDir).filter((n) => n.endsWith('.app'));
    if (extracted.length !== 1) throw new Error(`解包结果异常：${extracted.length} 个 .app`);
    // 剥离 quarantine（正式 Developer ID 签名后可移除此步）
    const stagedApp = path.join(extractDir, extracted[0]);
    await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stagedApp]).catch(() => undefined);
    if (!fs.existsSync(path.join(stagedApp, 'Contents', 'MacOS'))) throw new Error('更新包缺少可执行文件');

    // 原子切换（双版本：新 .previous = 旧版）
    const backup = `${bundle}.previous`;
    rmRf(backup);
    fs.renameSync(bundle, backup);
    fs.renameSync(stagedApp, bundle);

    // 写 pending + 重启握手
    const tmp = `${pendingUpdateFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ to: manifest.version, ts: Date.now() }), { encoding: 'utf-8' });
    fs.renameSync(tmp, pendingUpdateFile());

    const token = path.join(app.getPath('userData'), `update-ok-${Date.now()}.token`);
    app.relaunch({ execPath: process.execPath, args: [UPDATE_TOKEN_ARG, token] });

    const deadline = Date.now() + 30_000;
    let ok = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(token)) {
        ok = true;
        break;
      }
    }
    if (ok) {
      try {
        fs.rmSync(token, { force: true });
      } catch {
        /* ignore */
      }
      console.log(`[workpier] updated to ${manifest.version}, exiting old instance`);
      preExit();
      process.exit(0);
    }
    // 握手超时：回滚，老进程继续运行
    rmRf(bundle);
    fs.renameSync(backup, bundle);
    fs.rmSync(pendingUpdateFile(), { force: true });
    rmRf(staging);
    msgBox({ type: 'warning', message: `更新到 ${manifest.version} 失败，已回滚到 ${app.getVersion()}`, detail: '新版本未能正常启动。可直接继续使用当前版本，稍后再试。' });
  } catch (err) {
    console.error('[workpier] update failed:', err);
    rmRf(staging);
    msgBox({ type: 'error', message: '更新失败', detail: `${String((err as Error).message ?? err)}\n当前版本未受影响。` });
  }
}

/** 自更新前提：已打包 + macOS .app bundle 运行形态。返回 bundle 路径，不满足弹窗说明并返回 null */
function requireUpdatableBundle(interactive: boolean): string | null {
  if (!app.isPackaged) {
    if (interactive) msgBox({ type: 'info', message: '开发模式不支持自更新', detail: '请用 scripts/package.sh 打包后再检查更新。' });
    return null;
  }
  const bundle = appBundlePath();
  if (!bundle || process.platform !== 'darwin') {
    if (interactive) msgBox({ type: 'info', message: '当前安装形态不支持自更新', detail: '仅支持 macOS .app bundle 安装方式。' });
    return null;
  }
  return bundle;
}

/**
 * 启动自动检查（静默）：网络失败/无新版/已忽略该版本 → 不打扰；
 * 有新版 → 提醒「立即更新 / 稍后提醒 / 忽略此版本」。
 */
export async function checkForUpdatesOnLaunch(preExit: () => void): Promise<void> {
  const bundle = requireUpdatableBundle(false);
  if (!bundle) return;
  const feed = readUpdateFeed() ?? DEFAULT_UPDATE_FEED;
  const loaded = await loadManifest(feed);
  if (!loaded.ok) return; // 静默失败（GitHub 不可达等，下次启动再试）
  const { manifest, manifestUrl } = loaded;
  const current = app.getVersion();
  if (!isNewerVersion(manifest.version, current)) return;
  if (readSkippedVersion() === manifest.version) return;

  const choice = await dialog.showMessageBox({
    type: 'info',
    buttons: ['立即更新', '稍后提醒', '忽略此版本'],
    defaultId: 0,
    cancelId: 1,
    message: `发现新版本 ${manifest.version}（当前 ${current}）`,
    detail: manifest.notes || '下载并安装后自动重启；新版本启动失败会自动回滚到当前版本。',
  });
  if (choice.response === 2) {
    writeSetting('skippedVersion', manifest.version); // 更高版本发布前不再提醒
    return;
  }
  if (choice.response !== 0) return;
  await downloadAndInstall(bundle, feed, manifest, manifestUrl, preExit);
}

/**
 * 菜单入口「检查更新…」。全部交互用系统对话框（更新是低频操作，不占用主界面）。
 * 更新源：settings.updateFeed（本地测试可指向本地 update.json）→ 默认 GitHub 最新 Release；
 * 默认源不可达时回落文件选择器，便于离线/代理环境选本地更新包。
 */
export async function checkForUpdatesInteractive(preExit: () => void): Promise<void> {
  const bundle = requireUpdatableBundle(true);
  if (!bundle) return;

  // 1. 更新源：自定义 feed 优先，否则 GitHub 最新 Release
  let feed = readUpdateFeed() ?? DEFAULT_UPDATE_FEED;
  let loaded = await loadManifest(feed);
  if (!loaded.ok && feed === DEFAULT_UPDATE_FEED) {
    // GitHub 不可达（常见于无外网/代理环境）：回落本地清单选择器，并记住选择
    const picked = await dialog.showOpenDialog({
      title: `无法访问 GitHub 更新源（${loaded.reason === 'format' ? '清单格式不正确' : '网络不可达'}），选择本地更新清单（update.json）`,
      properties: ['openFile'],
      filters: [{ name: '更新清单', extensions: ['json'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return;
    feed = picked.filePaths[0];
    writeUpdateFeed(feed);
    loaded = await loadManifest(feed);
  }
  if (!loaded.ok) {
    if (loaded.reason === 'format') {
      msgBox({ type: 'error', message: '更新清单格式不正确', detail: '需要 { version, zip, sha256 } 字段（见 scripts/package.sh 产出的 update.json）。' });
    } else {
      msgBox({ type: 'error', message: '读取更新清单失败', detail: loaded.error ?? '' });
    }
    return;
  }
  const { manifest, manifestUrl } = loaded;

  // 2. 版本判断
  const current = app.getVersion();
  if (!isNewerVersion(manifest.version, current)) {
    msgBox({ type: 'info', message: '已是最新版本', detail: `当前版本 ${current}，更新源版本 ${manifest.version}。` });
    return;
  }

  // 3. 确认
  const confirm = await dialog.showMessageBox({
    type: 'question',
    buttons: ['更新并重启', '取消'],
    defaultId: 0,
    cancelId: 1,
    message: `发现新版本 ${manifest.version}（当前 ${current}）`,
    detail: manifest.notes || '下载并安装后自动重启；新版本启动失败会自动回滚到当前版本。',
  });
  if (confirm.response !== 0) return;

  await downloadAndInstall(bundle, feed, manifest, manifestUrl, preExit);
}
