#!/bin/zsh
# WorkPier Windows x64 交叉打包（在 macOS 上执行）
# 产物：
#   release/WorkPier-<ver>-win-x64.zip  —— portable（解压即用，免安装免管理员）
#   release/update.json                 —— 合并 win_zip/win_sha256 字段（同一份清单服务两个平台）
#
# 与 package.sh（macOS）的对应关系：
#   Electron.exe → WorkPier.exe（isPackaged 判定：basename != 'electron'，两平台同源）
#   图标/版本信息：scripts/patch-win-exe.mjs（纯 JS resedit，无需 wine/rcedit）
#   签名：无（Windows 无强制签名门槛，SmartScreen 会提示「未知发布者」，属 portable 分发常态）
# 依赖：Node >= 22、curl、zip（/usr/bin/zip）
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-release}"
VERSION="$(/usr/bin/python3 -c "import json;print(json.load(open('package.json'))['version'])")"
ELECTRON_VERSION="$(/usr/bin/python3 -c "import json;print(json.load(open('package.json'))['devDependencies']['electron'])")"
CACHE="${HOME}/Library/Caches/workpier"
EZIP="electron-v${ELECTRON_VERSION}-win32-x64.zip"

echo "==> 类型检查 + 构建"
npm run typecheck
npm run build

echo "==> 获取 Electron ${ELECTRON_VERSION} (win32-x64) 运行时"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$EZIP" ]; then
  echo "  下载（GitHub → npmmirror 兜底）..."
  curl -fL --retry 2 --progress-bar -o "$CACHE/$EZIP.part" \
    "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/$EZIP" \
    || curl -fL --retry 2 --progress-bar -o "$CACHE/$EZIP.part" \
    "https://npmmirror.com/mirrors/electron/v${ELECTRON_VERSION}/$EZIP"
  mv "$CACHE/$EZIP.part" "$CACHE/$EZIP"
fi

STAGE="$(mktemp -d /tmp/workpier-win-pkg.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> 组装 portable 目录: $STAGE/WorkPier"
# Windows zip 是平铺结构（electron.exe 在根）：解压到 e/ 再整体归拢进 WorkPier/
ditto -x -k "$CACHE/$EZIP" "$STAGE/e"
APP="$STAGE/WorkPier"
mkdir -p "$APP"
for f in "$STAGE"/e/*(N); do
  mv "$f" "$APP/"
done
rm -rf "$APP/resources/default_app.asar" 2>/dev/null || \
  echo "  (default_app.asar 删除被拦截，忽略：resources/app 存在时 Electron 不会加载它)"
mv "$APP/electron.exe" "$APP/WorkPier.exe"

mkdir -p "$APP/resources/app"
cp package.json index.html start.html overlay.html overlay.js findbar.html findbar.js renderer.js README.md "$APP/resources/app/"
cp -R dist "$APP/resources/app/"

echo "==> 写入图标与版本信息（resedit 纯 JS，免 wine）"
TOOLS="$STAGE/tools"
mkdir -p "$TOOLS"
npm install --prefix "$TOOLS" --no-audit --no-fund --silent resedit pe-library
node scripts/patch-win-exe.mjs "$APP/WorkPier.exe" assets/workpier.ico "$VERSION" "$TOOLS"

echo "==> 输出到 $OUT/"
mkdir -p "$OUT"
ZIP="$OUT/WorkPier-$VERSION-win-x64.zip"
rm -f "$ZIP"
# 顶层 WorkPier/ 目录结构 = 自更新解包后定位 WorkPier.exe 的约定（updater.ts 依赖）
(cd "$STAGE" && /usr/bin/zip -q -r -X "$OLDPWD/$ZIP" WorkPier)
SHA=$(/usr/bin/shasum -a 256 "$ZIP" | awk '{print $1}')
echo "Windows 包: $ZIP"
echo "SHA-256: $SHA"

# update.json：同版本则合并 win 字段（保留 mac 字段）；否则新建（警告补跑 package.sh）
/usr/bin/python3 - "$OUT/update.json" "$VERSION" "WorkPier-$VERSION-win-x64.zip" "$SHA" <<'PYEOF'
import json, os, sys
mf, version, win_zip, win_sha = sys.argv[1:5]
m = {}
if os.path.exists(mf):
    try:
        m = json.load(open(mf))
    except Exception:
        m = {}
if m.get('version') != version:
    if m:
        print(f"  注意: update.json 版本({m.get('version')}) != 当前({version})，win 字段写入新版本块")
    m = {'version': version, 'notes': ''}
m['win_zip'] = win_zip
m['win_sha256'] = win_sha
if 'zip' not in m or 'sha256' not in m:
    print("  注意: 清单缺少 macOS 字段(zip/sha256) —— 发版前请先跑 scripts/package.sh 合并，否则 macOS 端无法自更新")
with open(mf, 'w') as f:
    json.dump(m, f, indent=2)
print(f"  更新清单: {mf}")
PYEOF

echo ""
echo "==> 发布（与 macOS DMG 同一个 Release，update.json 需覆盖为合并后的最新版）:"
echo "    gh release create v$VERSION $ZIP $OUT/update.json --title \"WorkPier v$VERSION\" --notes '<更新说明>'"
echo "    Windows 用户: 解压 zip 到任意目录，双击 WorkPier/WorkPier.exe 即可；应用内「检查更新」自动识别 win_zip"
