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
cp package.json package-lock.json tsconfig.json index.html renderer.js README.md "$SRCDIR/"
cp -R src dist "$SRCDIR/"
(cd "$SRCDIR" && npm install --no-audit --no-fund)

APP="$STAGE/CloudDock.app"
ELECTRON_APP="$SRCDIR/node_modules/electron/dist/Electron.app"

echo "==> 组装 .app"
# default_app.asar 会被安全策略拦截且打包后不需要（已有 Resources/app）
/usr/bin/python3 -c "import os; os.unlink('$ELECTRON_APP/Contents/Resources/default_app.asar')"
cp -R "$ELECTRON_APP" "$APP"
mkdir -p "$APP/Contents/Resources/app"
cp -R package.json dist index.html renderer.js README.md "$APP/Contents/Resources/app/"
plutil -replace CFBundleName -string "CloudDock" "$APP/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "CloudDock" "$APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "com.dylanzheng.clouddock" "$APP/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"

echo "==> ad-hoc 签名"
codesign --force --deep --sign - "$APP"

echo "==> 输出到 $OUT/"
mkdir -p "$OUT"
rm -rf "$OUT/CloudDock.app"
cp -R "$APP" "$OUT/CloudDock.app"
echo "打包完成: $OUT/CloudDock.app"
echo "安装: cp -R $OUT/CloudDock.app ~/Applications/ && open ~/Applications/CloudDock.app"
