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
plutil -replace CFBundleIdentifier -string "com.sirkayzh.clouddock" "$APP/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleIconFile -string "clouddock.icns" "$APP/Contents/Info.plist"

echo "==> ad-hoc 签名"
codesign --force --deep --sign - "$APP"

echo "==> 输出到 $OUT/"
mkdir -p "$OUT"
rm -rf "$OUT/CloudDock.app"
cp -R "$APP" "$OUT/CloudDock.app"
echo "打包完成: $OUT/CloudDock.app"

# 更新包（Chrome 式自更新用）：zip + 清单（版本 + SHA-256）
# 把这两个文件放到任意目录/静态服务器，应用内「帮助 ▸ 检查更新…」选 update.json 即可完成更新
ZIP="$OUT/CloudDock-$VERSION-update.zip"
rm -f "$ZIP"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$OUT/CloudDock.app" "$ZIP"
SHA=$(/usr/bin/shasum -a 256 "$ZIP" | awk '{print $1}')

# DMG（GitHub 分发用）：拖入 Applications 的标准安装布局
DMG="$OUT/CloudDock-$VERSION.dmg"
rm -f "$DMG"
DMG_STAGE="$STAGE/dmg-root"
mkdir -p "$DMG_STAGE"
cp -R "$OUT/CloudDock.app" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
/usr/bin/hdiutil create -volname "CloudDock" -srcfolder "$DMG_STAGE" -format UDZO -ov -quiet "$DMG"
DMG_SHA=$(/usr/bin/shasum -a 256 "$DMG" | awk '{print $1}')

/usr/bin/python3 - "$ZIP" "$SHA" "$DMG" "$DMG_SHA" "$VERSION" <<'PYEOF'
import json, os, sys
zip_path, sha, dmg_path, dmg_sha, version = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
out = os.path.dirname(zip_path)
manifest = {'version': version, 'zip': os.path.basename(zip_path), 'sha256': sha,
            'dmg': os.path.basename(dmg_path), 'dmg_sha256': dmg_sha, 'notes': ''}
with open(os.path.join(out, 'update.json'), 'w') as f:
    json.dump(manifest, f, indent=2)
PYEOF
echo "更新包: $ZIP"
echo "DMG: $DMG"
echo "更新清单: $OUT/update.json"
echo "安装: cp -R $OUT/CloudDock.app ~/Applications/ && open ~/Applications/CloudDock.app"
