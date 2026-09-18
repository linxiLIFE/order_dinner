#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-}}"
if [[ -z "${ANDROID_HOME}" ]]; then
  echo "未找到 ANDROID_HOME 或 ANDROID_SDK_ROOT，请先安装 Android SDK。" >&2
  exit 1
fi
if ! command -v java >/dev/null 2>&1; then
  echo "未找到 Java，请安装 JDK 17。" >&2
  exit 1
fi

npm run build:web
if [[ ! -d android ]]; then
  npx cap add android
fi
npx cap sync android

if [[ ! -x android/gradlew ]]; then
  chmod +x android/gradlew
fi
(cd android && ./gradlew assembleRelease)

mkdir -p release/android
unsigned_apk="android/app/build/outputs/apk/release/app-release-unsigned.apk"
output_apk="release/android/餐厅点单台-release.apk"
cp "$unsigned_apk" "$output_apk"
build_tools="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -type f -name apksigner | sort | tail -1)"
debug_keystore="${ANDROID_DEBUG_KEYSTORE:-${HOME}/.android/debug.keystore}"
if [[ -x "$build_tools" && -f "$debug_keystore" ]]; then
  "$build_tools" sign --ks "$debug_keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android "$output_apk"
  "$build_tools" verify --verbose "$output_apk" >/dev/null
  echo "安卓测试签名安装包：$project_root/$output_apk"
else
  echo "未找到 Android debug keystore，已生成未签名 APK：$project_root/$output_apk" >&2
fi
