package com.orderdinner.pos;

import android.content.Intent;
import android.os.Bundle;
import android.net.Uri;
import android.os.Build;
import android.content.pm.PackageInfo;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PrinterHostPlugin.class);
        registerPlugin(UpdateHostPlugin.class);
        super.onCreate(savedInstanceState);
    }

@CapacitorPlugin(name = "UpdateHost")
public static final class UpdateHostPlugin extends Plugin {
    private static final String PREFERENCES = "order_dinner_updates";
    private static final String MANIFEST_PATH = "/updates/latest.json";
    private static final long MAX_MANIFEST_BYTES = 256L * 1024L;
    private static final long MAX_APK_BYTES = 512L * 1024L * 1024L;
    private static final ExecutorService UPDATE_EXECUTOR = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void checkForUpdate(PluginCall call) {
        final String manifestAddress;
        try {
            manifestAddress = resolveManifestUrl(call.getString("manifestUrl"));
        } catch (Exception error) {
            call.reject(readableError(error));
            return;
        }
        UPDATE_EXECUTOR.execute(() -> {
            try {
                JSONObject manifest = readManifest(manifestAddress);
                String currentVersion = installedVersionName();
                String latestVersion = requiredVersion(manifest);
                boolean available = compareVersions(latestVersion, currentVersion) > 0;
                JSObject result = new JSObject();
                result.put("available", available);
                result.put("currentVersion", currentVersion);
                result.put("latestVersion", latestVersion);
                result.put("notes", manifest.optString("notes", ""));
                result.put("message", available ? "发现新版本。" : "当前已经是最新版本。");
                call.resolve(result);
            } catch (Exception error) {
                call.reject(readableError(error));
            }
        });
    }

    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        final String manifestAddress;
        try {
            manifestAddress = resolveManifestUrl(call.getString("manifestUrl"));
        } catch (Exception error) {
            call.reject(readableError(error));
            return;
        }
        UPDATE_EXECUTOR.execute(() -> {
            try {
                JSONObject manifest = readManifest(manifestAddress);
                String latestVersion = requiredVersion(manifest);
                String currentVersion = installedVersionName();
                if (compareVersions(latestVersion, currentVersion) <= 0) {
                    throw new IOException("当前已经是最新版本，无需下载。");
                }
                JSONObject androidArtifact = manifest.optJSONObject("android");
                if (androidArtifact == null) throw new IOException("更新清单缺少 Android 安装包。");
                String artifactUrl = androidArtifact.optString("url", "");
                String expectedSha256 = androidArtifact.optString("sha256", "").toLowerCase(Locale.ROOT);
                validateSecureUrl(artifactUrl, "Android 安装包");
                if (!expectedSha256.matches("[a-f0-9]{64}")) {
                    throw new IOException("更新清单中的 Android 安装包校验值无效。");
                }

                File apk = downloadApk(artifactUrl, latestVersion, expectedSha256);
                getContext().getSharedPreferences(PREFERENCES, 0).edit()
                    .putString("apk_path", apk.getAbsolutePath())
                    .putString("apk_version", latestVersion)
                    .apply();

                JSObject result = new JSObject();
                result.put("downloaded", true);
                result.put("version", latestVersion);
                result.put("message", "安装包已下载并校验，请点击安装完成更新。");
                call.resolve(result);
            } catch (Exception error) {
                call.reject(readableError(error));
            }
        });
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String apkPath = getContext().getSharedPreferences(PREFERENCES, 0).getString("apk_path", "");
        String version = getContext().getSharedPreferences(PREFERENCES, 0).getString("apk_version", "");
        File apk = apkPath == null || apkPath.isEmpty() ? null : new File(apkPath);
        File updateDirectory = new File(getContext().getCacheDir(), "updates");
        try {
            if (apk == null || !apk.isFile() || !apk.getCanonicalPath().startsWith(updateDirectory.getCanonicalPath() + File.separator)) {
                throw new IOException("没有可安装的更新，请先下载更新包。");
            }
        } catch (IOException error) {
            call.reject(readableError(error));
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().startActivity(settings);
                    JSObject result = new JSObject();
                    result.put("started", false);
                    result.put("permissionRequired", true);
                    result.put("version", version);
                    result.put("message", "请在系统设置中允许本应用安装未知应用，再返回点按安装更新。");
                    call.resolve(result);
                } catch (Exception error) {
                    call.reject("无法打开安装授权设置，请到系统设置中允许本应用安装未知应用。");
                }
            });
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent installer = new Intent(Intent.ACTION_VIEW);
            installer.setDataAndType(uri, "application/vnd.android.package-archive");
            installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(installer);
            JSObject result = new JSObject();
            result.put("started", true);
            result.put("permissionRequired", false);
            result.put("version", version);
            result.put("message", "系统安装程序已打开，请按提示完成更新。");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法打开系统安装程序，请重新下载更新后重试。");
        }
    }

    private JSONObject readManifest(String address) throws Exception {
        byte[] bytes = readUrlBytes(address, MAX_MANIFEST_BYTES);
        JSONObject manifest = new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
        if (manifest.optInt("schemaVersion", -1) != 1) throw new IOException("暂不支持此更新清单版本。");
        requiredVersion(manifest);
        if (manifest.has("notes") && !(manifest.opt("notes") instanceof String)) {
            throw new IOException("更新说明格式错误。");
        }
        return manifest;
    }

    private String resolveManifestUrl(String requestedAddress) throws Exception {
        String currentUrl = getBridge().getWebView().getUrl();
        if (currentUrl == null || currentUrl.isEmpty()) throw new IOException("无法确认线上服务地址，请重新打开点单系统后重试。");
        URI page = URI.create(currentUrl);
        validateSecureUri(page, "线上服务");
        URI pageOrigin = new URI(page.getScheme(), null, page.getHost(), page.getPort(), "/", null, null);
        URI manifest = requestedAddress == null || requestedAddress.trim().isEmpty()
            ? pageOrigin.resolve(MANIFEST_PATH)
            : page.resolve(requestedAddress.trim());
        validateSecureUri(manifest, "更新清单");
        if (!pageOrigin.getScheme().equalsIgnoreCase(manifest.getScheme())
            || !pageOrigin.getHost().equalsIgnoreCase(manifest.getHost())
            || pageOrigin.getPort() != manifest.getPort()) {
            throw new IOException("更新清单必须与当前点单服务同源。");
        }
        return manifest.toASCIIString();
    }

    private File downloadApk(String address, String version, String expectedSha256) throws Exception {
        File directory = new File(getContext().getCacheDir(), "updates");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建更新缓存目录。");
        String uniqueName = "order-dinner-" + version + "-" + UUID.randomUUID();
        File partial = new File(directory, uniqueName + ".download");
        File apk = new File(directory, uniqueName + ".apk");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        HttpURLConnection connection = openHttpsConnection(address, "Android 安装包");
        try {
            long contentLength = connection.getContentLengthLong();
            if (contentLength > MAX_APK_BYTES) throw new IOException("Android 安装包超过允许大小，已停止下载。");
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[32 * 1024];
                long total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_APK_BYTES) throw new IOException("Android 安装包超过允许大小，已停止下载。");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
                output.getFD().sync();
            }
        } finally {
            connection.disconnect();
        }
        String actualSha256 = toHex(digest.digest());
        if (!actualSha256.equalsIgnoreCase(expectedSha256)) throw new IOException("Android 安装包校验失败，文件没有安装。");
        if (!partial.renameTo(apk)) throw new IOException("更新包已下载，但无法准备系统安装文件。");
        return apk;
    }

    private byte[] readUrlBytes(String address, long maxBytes) throws Exception {
        HttpURLConnection connection = openHttpsConnection(address, "更新清单");
        try {
            long contentLength = connection.getContentLengthLong();
            if (contentLength > maxBytes) throw new IOException("更新清单过大，已停止检查。");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8 * 1024];
                long total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > maxBytes) throw new IOException("更新清单过大，已停止检查。");
                    output.write(buffer, 0, count);
                }
                return output.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection openHttpsConnection(String address, String label) throws Exception {
        URI current = URI.create(address);
        for (int redirects = 0; redirects <= 5; redirects++) {
            validateSecureUri(current, label);
            HttpURLConnection connection = (HttpURLConnection) new URL(current.toString()).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json, application/vnd.android.package-archive, application/octet-stream");
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) return connection;
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null || redirects == 5) throw new IOException(label + "跳转失败，请检查发布地址。");
                current = current.resolve(location);
                continue;
            }
            connection.disconnect();
            throw new IOException(label + "请求失败（HTTP " + status + "）。");
        }
        throw new IOException(label + "跳转次数过多。");
    }

    private void validateSecureUrl(String address, String label) throws Exception {
        validateSecureUri(URI.create(address), label);
    }

    private void validateSecureUri(URI uri, String label) throws Exception {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        boolean loopback = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1");
        if (!scheme.equals("https") && !(scheme.equals("http") && loopback)) {
            throw new IOException(label + "必须使用 HTTPS。");
        }
        if (uri.getUserInfo() != null || host.isEmpty()) throw new IOException(label + "地址无效。");
    }

    private String installedVersionName() throws Exception {
        PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
        return info.versionName == null ? "0.0.0" : info.versionName;
    }

    private String requiredVersion(JSONObject manifest) throws Exception {
        String version = manifest.optString("version", "");
        versionParts(version);
        return version;
    }

    private int compareVersions(String left, String right) throws Exception {
        long[] a = versionParts(left);
        long[] b = versionParts(right);
        for (int index = 0; index < a.length; index++) {
            if (a[index] != b[index]) return a[index] > b[index] ? 1 : -1;
        }
        return 0;
    }

    private long[] versionParts(String version) throws Exception {
        if (version == null || !version.matches("\\d+\\.\\d+\\.\\d+")) throw new IOException("更新清单中的版本号格式不正确。");
        try {
            String[] parts = version.split("\\.");
            return new long[] { Long.parseLong(parts[0]), Long.parseLong(parts[1]), Long.parseLong(parts[2]) };
        } catch (NumberFormatException error) {
            throw new IOException("更新清单中的版本号超出范围。");
        }
    }

    private String readableError(Exception error) {
        String message = error.getMessage();
        if (message != null && message.matches(".*[\\u3400-\\u9fff].*")) return message;
        return "更新失败，请检查网络连接、储存空间或安装授权后重试。";
    }

    private String toHex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return value.toString();
    }
}
}
