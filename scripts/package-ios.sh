#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

mode="${1:-simulator}"
case "$mode" in simulator|archive|unsigned) ;; *) echo "用法：npm run package:ios -- [simulator|archive|unsigned]" >&2; exit 1 ;; esac
if [[ "$mode" == archive && -z "${IOS_DEVELOPMENT_TEAM:-}" ]]; then
  echo "签名归档需要 IOS_DEVELOPMENT_TEAM；可先使用 simulator 或 unsigned 构建。" >&2
  exit 1
fi
xcodebuild -version
export ORDER_DINNER_PLATFORM=ios
export ORDER_DINNER_API_ORIGIN="${ORDER_DINNER_URL:-https://43.142.138.108:1316}"
node --input-type=module -e 'const u = new URL(process.env.ORDER_DINNER_API_ORIGIN); if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("ORDER_DINNER_URL 必须为不带路径或账号的 HTTPS 服务地址")'
version="$(node -p 'require("./package.json").version')"
output="release/ios/$version/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$output"
export ORDER_DINNER_WEB_OUT_DIR="../$output/web"
export ORDER_DINNER_WEB_DIR="$output/web"
npm run build:web
mkdir -p "$ORDER_DINNER_WEB_DIR/ios-fonts"
cp mobile/ios-assets/NotoSansCJKsc-Regular.otf mobile/ios-assets/OFL.txt "$ORDER_DINNER_WEB_DIR/ios-fonts/"

# Preserve generated assets in Trash before Capacitor replaces its web directory.
for generated in ios/App/App/public ios/capacitor-cordova-ios-plugins; do
  if [[ -e "$generated" ]]; then
    mkdir -p "$HOME/.Trash"
    mv "$generated" "$HOME/.Trash/order-dinner-ios-$(basename "$generated")-$(date +%Y%m%d-%H%M%S)-$$"
  fi
done
npx cap sync ios
node --input-type=module <<'NODE'
import fs from 'node:fs';
const {version} = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号必须是 x.y.z');
const [major, minor, patch] = version.split('.').map(Number);
if (minor > 999 || patch > 999) throw new Error('minor 和 patch 不得超过 999');
const build = major * 1000000 + minor * 1000 + patch;
const path = 'ios/App/App.xcodeproj/project.pbxproj';
fs.writeFileSync(path, fs.readFileSync(path, 'utf8')
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
  .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`));
NODE

args=(-project ios/App/App.xcodeproj -scheme App -derivedDataPath "$output/DerivedData")
if [[ "$mode" == simulator ]]; then
  xcodebuild "${args[@]}" -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build > "$output/build.log" 2>&1 || { tail -60 "$output/build.log"; exit 1; }
  ditto -c -k --keepParent "$output/DerivedData/Build/Products/Debug-iphonesimulator/App.app" "$output/餐厅点单台-$version-模拟器.zip"
else
  archive="$output/餐厅点单台-$version.xcarchive"
  if [[ "$mode" == unsigned ]]; then
    signing=(CODE_SIGNING_ALLOWED=NO)
  else
    signing=(CODE_SIGN_STYLE=Automatic "DEVELOPMENT_TEAM=$IOS_DEVELOPMENT_TEAM" -allowProvisioningUpdates)
  fi
  xcodebuild "${args[@]}" -configuration Release -destination 'generic/platform=iOS' -archivePath "$archive" "${signing[@]}" archive > "$output/build.log" 2>&1 || { tail -60 "$output/build.log"; exit 1; }
  if [[ "$mode" == archive ]]; then
    export_path="$output/ExportOptions.plist"
    IOS_EXPORT_OPTIONS="$export_path" python3 - <<'PY'
import os, plistlib
with open(os.environ['IOS_EXPORT_OPTIONS'], 'wb') as f:
    plistlib.dump({'method': os.environ.get('IOS_EXPORT_METHOD', 'debugging'), 'teamID': os.environ['IOS_DEVELOPMENT_TEAM'], 'signingStyle': 'automatic'}, f)
PY
    xcodebuild -exportArchive -archivePath "$archive" -exportPath "$output/export" -exportOptionsPlist "$export_path" -allowProvisioningUpdates > "$output/export.log" 2>&1 || { tail -60 "$output/export.log"; exit 1; }
    cp "$output/export/App.ipa" "$output/餐厅点单台-$version-开发签名.ipa"
  fi
fi
echo "iOS 构建完成：$project_root/$output"
