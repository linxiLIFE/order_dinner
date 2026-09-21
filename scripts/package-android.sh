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
if [[ -z "${ANDROID_RELEASE_KEYSTORE:-}" || ! -f "${ANDROID_RELEASE_KEYSTORE:-}" || -z "${ANDROID_RELEASE_KEY_ALIAS:-}" || -z "${ANDROID_RELEASE_STORE_PASSWORD:-}" || -z "${ANDROID_RELEASE_KEY_PASSWORD:-}" ]]; then
  echo "正式安装包必须配置 ANDROID_RELEASE_KEYSTORE、ANDROID_RELEASE_KEY_ALIAS、ANDROID_RELEASE_STORE_PASSWORD 和 ANDROID_RELEASE_KEY_PASSWORD；不会使用 debug 密钥签名。" >&2
  exit 1
fi

npm run build:web
if [[ ! -d android ]]; then
  npx cap add android
fi
npx cap sync android

# Capacitor 工程是本机生成目录；每次同步后恢复版本库中的原生打印服务模板，
# 避免重新生成 Android 工程时丢失蓝牙打印能力。
native_template="$project_root/mobile/android-native"
native_java="$project_root/android/app/src/main/java/com/orderdinner/pos"
mkdir -p "$native_java"
cp "$native_template/MainActivity.java" "$native_java/MainActivity.java"
cp "$native_template/PrinterHostPlugin.java" "$native_java/PrinterHostPlugin.java"
cp "$native_template/PrinterService.java" "$native_java/PrinterService.java"
cp "$native_template/BootReceiver.java" "$native_java/BootReceiver.java"
cp "$native_template/AndroidManifest.xml" "$project_root/android/app/src/main/AndroidManifest.xml"

if [[ ! -x android/gradlew ]]; then
  chmod +x android/gradlew
fi
(cd android && ./gradlew assembleRelease)

mkdir -p release/android
unsigned_apk="android/app/build/outputs/apk/release/app-release-unsigned.apk"
output_apk="release/android/餐厅点单台-release.apk"
if [[ -e "$output_apk" ]]; then
  echo "正式安装包已存在：$project_root/$output_apk；为避免覆盖，请先将旧包移入废纸篓。" >&2
  exit 1
fi
build_tools="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -type f -name apksigner | sort | tail -1)"
if [[ ! -x "$build_tools" ]]; then
  echo "Android SDK 中未找到 apksigner，无法生成正式安装包。" >&2
  exit 1
fi
signed_apk="release/android/餐厅点单台-release-$$.apk"
"$build_tools" sign --out "$signed_apk" --ks "$ANDROID_RELEASE_KEYSTORE" --ks-key-alias "$ANDROID_RELEASE_KEY_ALIAS" --ks-pass env:ANDROID_RELEASE_STORE_PASSWORD --key-pass env:ANDROID_RELEASE_KEY_PASSWORD "$unsigned_apk"
"$build_tools" verify --verbose "$signed_apk" >/dev/null
mv "$signed_apk" "$output_apk"
echo "已生成正式签名安卓安装包：$project_root/$output_apk"
