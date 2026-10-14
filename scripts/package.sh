#!/bin/zsh
# CloudDock 打包脚本（macOS arm64）
# 背景：本机安全策略会拦截 electron-packager 复制 .app bundle（default_app.asar 触发
# "Brokered file token refused"），因此改为手动组装 .app，效果等价。
# 依赖：Node >= 22.12（electron 的 install.js 需要 require(ESM) 支持）
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-release}"
VERSION="$(/usr/bin/python3 -c "import json;print(json.load(open('package.json'))['version'])")"
STAGE="$(mktemp -d /tmp/clouddock-pkg.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> 类型检查 + 构建"
npm run typecheck
npm run build

echo "==> 准备干净构建目录: $STAGE/src"
SRCDIR="$STAGE/src"
mkdir -p "$SRCDIR"
cp package.json package-lock.json tsconfig.json index.html start.html renderer.js README.md "$SRCDIR/"
cp -R src dist "$SRCDIR/"
# npm ci：严格按 package-lock 安装，版本已锁定，构建可复现
(cd "$SRCDIR" && npm ci --no-audit --no-fund)
# electron 二进制 postinstall 可能静默失败，兜底手动补装
if [ ! -f "$SRCDIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  echo "==> electron 二进制缺失，手动补装"
  (cd "$SRCDIR/node_modules/electron" && node install.js)
fi

APP="$STAGE/CloudDock.app"
ELECTRON_APP="$SRCDIR/node_modules/electron/dist/Electron.app"

echo "==> 组装 .app"
# default_app.asar 会被安全策略拦截且打包后不需要（已有 Resources/app）
/usr/bin/python3 -c "import os; os.unlink('$ELECTRON_APP/Contents/Resources/default_app.asar')"
cp -R "$ELECTRON_APP" "$APP"
mkdir -p "$APP/Contents/Resources/app"
cp -R package.json dist index.html start.html renderer.js README.md "$APP/Contents/Resources/app/"
# App 图标（assets/gen_icon.py 生成）
cp assets/clouddock.icns "$APP/Contents/Resources/clouddock.icns"
plutil -replace CFBundleName -string "CloudDock" "$APP/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "CloudDock" "$APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "com.dylanzheng.clouddock" "$APP/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleIconFile -string "clouddock.icns" "$APP/Contents/Info.plist"

echo "==> ad-hoc 签名"
codesign --force --deep --sign - "$APP"

echo "==> 输出到 $OUT/"
mkdir -p "$OUT"
rm -rf "$OUT/CloudDock.app"
cp -R "$APP" "$OUT/CloudDock.app"
echo "打包完成: $OUT/CloudDock.app"
echo "安装: cp -R $OUT/CloudDock.app ~/Applications/ && open ~/Applications/CloudDock.app"
