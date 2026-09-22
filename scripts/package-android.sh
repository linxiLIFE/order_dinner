#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-}}"
if [[ -z "${ANDROID_HOME}" ]]; then
  echo "未找到 ANDROID_HOME 或 ANDROID_SDK_ROOT，请先安装 Android SDK。" >&2
  exit 1
fi
if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then
  selected_java="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
  selected_java="$(command -v java)"
else
  selected_java=""
fi
if [[ -z "$selected_java" ]]; then
  echo "未找到 Java，请安装 JDK 17 或 21。" >&2
  exit 1
fi
java_major="$("$selected_java" -version 2>&1 | awk -F '"' '/version/ { split($2, parts, "."); if (parts[1] == "1") print parts[2]; else print parts[1]; exit }')"
if [[ ! "$java_major" =~ ^[0-9]+$ || "$java_major" -lt 17 || "$java_major" -gt 21 ]]; then
  compatible_java_home=""
  for candidate in \
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
    "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"; do
    if [[ -x "$candidate/bin/java" ]]; then
      candidate_major="$("$candidate/bin/java" -version 2>&1 | awk -F '"' '/version/ { split($2, parts, "."); if (parts[1] == "1") print parts[2]; else print parts[1]; exit }')"
      if [[ "$candidate_major" == "21" ]]; then
        compatible_java_home="$candidate"
        break
      fi
    fi
  done
  if [[ -z "$compatible_java_home" ]]; then
    echo "当前 Java 版本与 Android Gradle 构建不兼容（检测到 $java_major）；请设置 JAVA_HOME 指向 JDK 17 或 21。" >&2
    exit 1
  fi
  export JAVA_HOME="$compatible_java_home"
  export PATH="$JAVA_HOME/bin:$PATH"
  echo "当前 Java 版本不兼容，已选择本机 JDK 21 构建安卓包。" >&2
fi
release_signing_configured=false
if [[ -n "${ANDROID_RELEASE_KEYSTORE:-}" || -n "${ANDROID_RELEASE_KEY_ALIAS:-}" || -n "${ANDROID_RELEASE_STORE_PASSWORD:-}" || -n "${ANDROID_RELEASE_KEY_PASSWORD:-}" ]]; then
  if [[ -z "${ANDROID_RELEASE_KEYSTORE:-}" || ! -f "${ANDROID_RELEASE_KEYSTORE:-}" || -z "${ANDROID_RELEASE_KEY_ALIAS:-}" || -z "${ANDROID_RELEASE_STORE_PASSWORD:-}" || -z "${ANDROID_RELEASE_KEY_PASSWORD:-}" ]]; then
    echo "ANDROID_RELEASE_KEYSTORE、ANDROID_RELEASE_KEY_ALIAS、ANDROID_RELEASE_STORE_PASSWORD 和 ANDROID_RELEASE_KEY_PASSWORD 必须完整配置。" >&2
    exit 1
  fi
  signing_keystore="$ANDROID_RELEASE_KEYSTORE"
  signing_key_alias="$ANDROID_RELEASE_KEY_ALIAS"
  signing_store_password_env="ANDROID_RELEASE_STORE_PASSWORD"
  signing_key_password_env="ANDROID_RELEASE_KEY_PASSWORD"
  signature_label="签名"
  release_signing_configured=true
else
  debug_keystore="${HOME:-}/.android/debug.keystore"
  if [[ ! -f "$debug_keystore" ]]; then
    echo "未找到默认 Android 调试签名密钥 $debug_keystore；请配置 ANDROID_RELEASE_KEYSTORE、ANDROID_RELEASE_KEY_ALIAS、ANDROID_RELEASE_STORE_PASSWORD 和 ANDROID_RELEASE_KEY_PASSWORD。" >&2
    exit 1
  fi
  signing_keystore="$debug_keystore"
  signing_key_alias="androiddebugkey"
  export ORDER_DINNER_TEST_STORE_PASSWORD="android"
  export ORDER_DINNER_TEST_KEY_PASSWORD="android"
  signing_store_password_env="ORDER_DINNER_TEST_STORE_PASSWORD"
  signing_key_password_env="ORDER_DINNER_TEST_KEY_PASSWORD"
  signature_label="测试签名"
  echo "未提供餐厅发布密钥，将使用默认 Android 调试密钥；此安装包仅标记为测试签名。" >&2
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

# Keep the system installer version aligned with package.json so Android can
# compare releases and reject any APK whose version code is not newer.
node --input-type=module <<'NODE'
import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("package.json version 必须是 x.y.z 格式，才能生成安卓更新版本号。");
}
const [major, minor, patch] = version.split(".").map(Number);
if (minor > 999 || patch > 999) throw new Error("安卓更新版本要求 minor 和 patch 都不超过 999。");
const versionCode = major * 1_000_000 + minor * 1_000 + patch;
if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_147_483_647) {
  throw new Error("package.json version 超出安卓 versionCode 支持范围。");
}

const gradlePath = "android/app/build.gradle";
let gradle = fs.readFileSync(gradlePath, "utf8");
const versionCodePattern = /(\bversionCode\s+)\d+/g;
const versionNamePattern = /(\bversionName\s+)["'][^"']+["']/g;
if ([...gradle.matchAll(versionCodePattern)].length !== 1 || [...gradle.matchAll(versionNamePattern)].length !== 1) {
  throw new Error("无法在 android/app/build.gradle 中唯一定位 versionCode 和 versionName。");
}
gradle = gradle.replace(versionCodePattern, `$1${versionCode}`);
gradle = gradle.replace(versionNamePattern, `$1"${version}"`);
fs.writeFileSync(gradlePath, gradle);
NODE

if [[ ! -x android/gradlew ]]; then
  chmod +x android/gradlew
fi
(cd android && ./gradlew assembleRelease)

package_version="$(node -p 'require("./package.json").version')"
mkdir -p "release/android/$package_version"
unsigned_apk="android/app/build/outputs/apk/release/app-release-unsigned.apk"
output_apk="release/android/$package_version/餐厅点单台-$package_version-$signature_label.apk"
if [[ -e "$output_apk" ]]; then
  echo "正式安装包已存在：$project_root/$output_apk；为避免覆盖，请先将旧包移入废纸篓。" >&2
  exit 1
fi
build_tools="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -type f -name apksigner | sort | tail -1)"
if [[ ! -x "$build_tools" ]]; then
  echo "Android SDK 中未找到 apksigner，无法生成正式安装包。" >&2
  exit 1
fi
signed_apk="release/android/$package_version/.餐厅点单台-$package_version-$$.apk"
"$build_tools" sign --out "$signed_apk" --ks "$signing_keystore" --ks-key-alias "$signing_key_alias" --ks-pass "env:$signing_store_password_env" --key-pass "env:$signing_key_password_env" "$unsigned_apk"
"$build_tools" verify --verbose "$signed_apk" >/dev/null
mv "$signed_apk" "$output_apk"
if [[ "$release_signing_configured" == true ]]; then
  echo "已生成签名安卓安装包：$project_root/$output_apk"
else
  echo "已生成安卓测试签名安装包：$project_root/${output_apk}；不能作为正式餐厅签名包发布。"
fi
