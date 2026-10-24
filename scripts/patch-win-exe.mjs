#!/usr/bin/env node
/**
 * patch-win-exe.mjs —— 用纯 JS（resedit）给 Windows exe 写入图标与版本信息。
 *
 * 为什么不用 rcedit：rcedit 是 Windows 二进制，macOS 上交叉改 exe 需要 wine；
 * resedit 全 JS 实现，零原生依赖，跨平台行为一致（本机无 wine / npm 官方源被断时的替代方案）。
 *
 * 用法：node scripts/patch-win-exe.mjs <exe> <ico> <version> [toolsDir]
 *   toolsDir = 安装了 resedit + pe-library 的 node_modules 所在目录（package.json 同级）
 * 实现细节：
 *  - 图标：复用 exe 自带的 icon group ID（Electron.exe 恒有一个），替换组内全部尺寸；
 *    若 exe 没有任何 icon group（异常）则新增 ID=1 的组
 *  - 版本：只改 VS_VERSION_INFO 的数值字段与 en-US 字符串，不动其它语言块
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [exePath, icoPath, version, toolsDir = path.join(process.cwd(), 'node_modules/..')] = process.argv.slice(2);
if (!exePath || !icoPath || !version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/patch-win-exe.mjs <exe> <ico> <x.y.z> [toolsDir]');
  process.exit(2);
}

const require2 = createRequire(path.join(path.resolve(toolsDir), 'package.json'));
const { load: loadResEdit } = require2('resedit/cjs');
const { load: loadPE } = require2('pe-library/cjs');
const [ResEdit, PELibrary] = await Promise.all([loadResEdit(), loadPE()]);

const data = fs.readFileSync(exePath);
const exe = PELibrary.NtExecutable.from(data);
const res = PELibrary.NtExecutableResource.from(exe);

/* ---------- 图标 ---------- */
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
let groupId;
if (groups.length > 0) {
  groupId = groups[0].id; // 复用 Electron 自带组 ID：任务栏/资源管理器取的就是它
} else {
  groupId = 1; // 无任何组（异常兜底）：新增 ID=1
}
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  groupId,
  1033, // en-US
  iconFile.icons.map((item) => item.data),
);
console.log(`[patch-win-exe] icon -> group ${groupId}（${iconFile.icons.length} 个尺寸）`);

/* ---------- 版本信息 ---------- */
const [maj, min, rev] = version.split('.').map(Number);
const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (viList.length > 0) {
  const vi = viList[0];
  vi.setFileVersion(maj, min, rev, 0, 1033);
  vi.setProductVersion(maj, min, rev, 0, 1033);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      FileDescription: 'WorkPier — 网页工作台',
      ProductName: 'WorkPier',
      CompanyName: 'SirKayZh',
      InternalName: 'WorkPier',
      OriginalFilename: 'WorkPier.exe',
      FileVersion: `${maj}.${min}.${rev}.0`,
      ProductVersion: `${maj}.${min}.${rev}.0`,
      LegalCopyright: 'Copyright (c) SirKayZh',
    },
  );
  vi.outputToResourceEntries(res.entries);
  console.log(`[patch-win-exe] version -> ${version}`);
} else {
  console.warn('[patch-win-exe] exe 无版本资源块，跳过版本信息（图标已写入）');
}

/* ---------- 写回 ---------- */
res.outputResource(exe);
const out = Buffer.from(exe.generate());
const tmp = `${exePath}.tmp`;
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, exePath);
console.log(`[patch-win-exe] done: ${exePath}（${out.length} bytes）`);
