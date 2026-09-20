package com.orderdinner.pos;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class PrinterService extends Service {
    public static final String PREFERENCES = "printer_host";
    public static final String KEY_ENABLED = "enabled";
    public static final String KEY_DEVICE_ID = "device_id";
    public static final String KEY_DEVICE_NAME = "device_name";
    public static final String KEY_DEVICE_TOKEN = "device_token";
    public static final String KEY_SERVER_URL = "server_url";
    private static final String KEY_CURRENT_JOB = "current_job";
    private static final String CHANNEL_ID = "order_dinner_printer";
    private static final int NOTIFICATION_ID = 1314;
    private static final UUID SERIAL_PORT_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final Charset PRINTER_CHARSET = Charset.forName("GB18030");
    private static volatile boolean connected = false;
    private static volatile String stateMessage = "打印服务未启用";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean running;
    private BluetoothSocket socket;
    private SharedPreferences preferences;

    public static void start(Context context) {
        Intent intent = new Intent(context, PrinterService.class);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void startIfEnabled(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        if (preferences.getBoolean(KEY_ENABLED, false)) start(context);
    }

    public static boolean isConnected() {
        return connected;
    }

    public static String getStateMessage() {
        return stateMessage;
    }

    public static void setStoppedState() {
        connected = false;
        stateMessage = "打印服务已停用";
    }

    @Override
    public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE);
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, notification("正在启动打印服务"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!preferences.getBoolean(KEY_ENABLED, false)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            worker.submit(this::runLoop);
        }
        return START_STICKY;
    }

    private void runLoop() {
        while (running && preferences.getBoolean(KEY_ENABLED, false)) {
            try {
                ensureBluetoothPermission();
                connectPrinter();
                String sessionStartedAt = Instant.now().toString();
                updateState(true, "打印机已连接，只处理连接后新任务");
                while (running && socket != null && socket.isConnected()) {
                    if (!recoverUncertainJob()) {
                        sleep(3000);
                        continue;
                    }
                    JSONObject job = claim(sessionStartedAt);
                    if (job == null) {
                        sleep(1800);
                        continue;
                    }
                    processJob(job);
                }
            } catch (Exception error) {
                updateState(false, readableError(error));
                closeSocket();
                sleep(5000);
            }
        }
        closeSocket();
        updateState(false, "打印服务已停用");
    }

    private void ensureBluetoothPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            throw new IllegalStateException("请打开应用并允许蓝牙和附近设备权限");
        }
    }

    private void connectPrinter() throws Exception {
        closeSocket();
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) throw new IllegalStateException("当前安卓设备不支持蓝牙");
        if (!adapter.isEnabled()) throw new IllegalStateException("蓝牙未开启，等待重新连接");
        String deviceId = preferences.getString(KEY_DEVICE_ID, "");
        if (deviceId.isEmpty()) throw new IllegalStateException("尚未选择蓝牙打印机");
        BluetoothDevice device = adapter.getRemoteDevice(deviceId);
        adapter.cancelDiscovery();
        updateState(false, "正在连接 " + safeDeviceName());
        socket = device.createRfcommSocketToServiceRecord(SERIAL_PORT_UUID);
        socket.connect();
    }

    private JSONObject claim(String sessionStartedAt) throws Exception {
        JSONObject body = new JSONObject();
        body.put("sessionStartedAt", sessionStartedAt);
        JSONObject response = post("/api/print-jobs/claim", body);
        if (response.isNull("job")) return null;
        return response.getJSONObject("job");
    }

    private void processJob(JSONObject job) throws Exception {
        String jobId = job.getString("id");
        preferences.edit().putString(KEY_CURRENT_JOB, jobId).apply();
        boolean writeStarted = false;
        try {
            byte[] bytes = render(job);
            OutputStream output = socket.getOutputStream();
            writeStarted = true;
            output.write(bytes);
            output.flush();
            sleep(350);
            ack(jobId, "SENT", "");
            preferences.edit().remove(KEY_CURRENT_JOB).apply();
            updateState(true, "最近打印成功：" + shortId(jobId));
        } catch (Exception error) {
            String status = writeStarted ? "NEEDS_CHECK" : "FAILED";
            try {
                ack(jobId, status, readableError(error));
                preferences.edit().remove(KEY_CURRENT_JOB).apply();
            } catch (Exception ignored) {
                // 保留 current_job；网络恢复后标记为待核对，绝不自动重复出纸。
            }
            throw error;
        }
    }

    private boolean recoverUncertainJob() {
        String jobId = preferences.getString(KEY_CURRENT_JOB, "");
        if (jobId.isEmpty()) return true;
        try {
            ack(jobId, "NEEDS_CHECK", "打印服务中断，无法确认是否已经出纸");
            preferences.edit().remove(KEY_CURRENT_JOB).apply();
            updateState(connected, "存在结果不明任务，请到打印队列核对");
            return true;
        } catch (Exception error) {
            updateState(connected, "正在恢复未确认任务：" + readableError(error));
            return false;
        }
    }

    private void ack(String jobId, String status, String error) throws Exception {
        JSONObject body = new JSONObject();
        body.put("status", status);
        body.put("error", error);
        post("/api/print-jobs/" + jobId + "/ack", body);
    }

    private JSONObject post(String path, JSONObject body) throws Exception {
        String base = preferences.getString(KEY_SERVER_URL, "").replaceAll("/+$", "");
        String deviceId = preferences.getString(KEY_DEVICE_ID, "");
        String deviceToken = preferences.getString(KEY_DEVICE_TOKEN, "");
        if (base.isEmpty() || deviceId.isEmpty() || deviceToken.isEmpty()) {
            throw new IllegalStateException("打印服务认证未配置");
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(15000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("X-Printer-Device-Id", deviceId);
        connection.setRequestProperty("X-Printer-Token", deviceToken);
        byte[] request = body.toString().getBytes(Charset.forName("UTF-8"));
        connection.setFixedLengthStreamingMode(request.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(request);
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String response = readAll(stream);
        connection.disconnect();
        if (status < 200 || status >= 300) {
            String message = response;
            try { message = new JSONObject(response).optString("error", response); } catch (Exception ignored) { }
            throw new IllegalStateException("服务器返回 " + status + "：" + message);
        }
        return response.isEmpty() ? new JSONObject() : new JSONObject(response);
    }

    private String readAll(InputStream input) throws Exception {
        if (input == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, Charset.forName("UTF-8")))) {
            String line;
            while ((line = reader.readLine()) != null) result.append(line);
        }
        return result.toString();
    }

    private byte[] render(JSONObject job) throws Exception {
        JSONObject payload = job.getJSONObject("payload");
        String kind = job.optString("kind", "KITCHEN");
        boolean receipt = "RECEIPT".equals(kind);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        command(output, 0x1B, 0x40); // 初始化
        command(output, 0x1C, 0x26); // 中文模式
        command(output, 0x1B, 0x61, 0x01);
        command(output, 0x1D, 0x21, 0x11);
        line(output, payload.optString("title", receipt ? "结账小票" : "备菜单"));
        command(output, 0x1D, 0x21, 0x00);
        command(output, 0x1B, 0x61, 0x01);
        command(output, 0x1D, 0x21, 0x11);
        line(output, tableName(payload));
        command(output, 0x1D, 0x21, 0x00);
        command(output, 0x1B, 0x61, 0x00);
        line(output, "人数：" + payload.optInt("peopleCount", 0) + "    顾客：" + payload.optString("customer", "散客"));
        if (payload.has("batchNo")) line(output, "批次：第 " + payload.optInt("batchNo") + " 批");
        if (receipt) {
            line(output, "开台时间：" + formatTime(payload.optString("openedAt", "")));
            line(output, "结账时间：" + formatTime(payload.optString("settledAt", payload.optString("createdAt", ""))));
        } else {
            line(output, "时间：" + formatTime(payload.optString("createdAt", "")));
        }
        String orderNote = payload.optString("orderNote", "");
        if (!receipt && !orderNote.isEmpty()) line(output, "本单备注：" + orderNote);
        separator(output);
        JSONArray items = payload.optJSONArray("items");
        if (items != null) {
            for (int index = 0; index < items.length(); index += 1) {
                JSONObject item = items.getJSONObject(index);
                int quantity = item.optInt("quantity", 0);
                String unit = item.optString("unit", "份");
                int priceFen = item.optInt("priceFen", 0);
                command(output, 0x1D, 0x21, 0x01);
                line(output, item.optString("name", "菜品") + " × " + quantity + " " + unit);
                command(output, 0x1D, 0x21, 0x00);
                if (receipt) {
                    line(output, "  单价 " + money(priceFen) + "  小计 " + money(priceFen * quantity));
                }
                String note = formatItemNote(item.optString("note", ""));
                if (!note.isEmpty()) line(output, "  " + note);
            }
        }
        if (receipt) {
            JSONObject totals = payload.optJSONObject("totals");
            if (totals != null) {
                separator(output);
                line(output, "应收：" + money(totals.optInt("dueFen", totals.optInt("receivedFen"))));
                command(output, 0x1D, 0x21, 0x01);
                line(output, "实收：" + money(totals.optInt("receivedFen")));
                command(output, 0x1D, 0x21, 0x00);
            }
        }
        String footer = payload.optString("footer", "");
        if (!footer.isEmpty()) {
            separator(output);
            command(output, 0x1B, 0x61, 0x01);
            line(output, footer);
        }
        line(output, "");
        line(output, "");
        line(output, "");
        command(output, 0x1D, 0x56, 0x42, 0x00);
        return output.toByteArray();
    }

    private void command(ByteArrayOutputStream output, int... values) {
        for (int value : values) output.write(value);
    }

    private void line(ByteArrayOutputStream output, String value) throws Exception {
        output.write(value.getBytes(PRINTER_CHARSET));
        output.write('\n');
    }

    private void separator(ByteArrayOutputStream output) throws Exception {
        line(output, "------------------------------------------");
    }

    private String tableName(JSONObject payload) {
        String name = payload.optString("tableName", "");
        if (!name.isEmpty()) return name;
        int number = payload.optInt("tableNumber", 0);
        return number > 0 ? number + "号桌" : "无桌台";
    }

    private String formatItemNote(String raw) {
        if (raw == null || raw.trim().isEmpty()) return "";
        String[] parts = raw.split("[；;]");
        StringBuilder result = new StringBuilder();
        for (String value : parts) {
            String part = value.trim();
            if (part.isEmpty()) continue;
            if (parts.length == 1 && (part.startsWith("备注：") || part.startsWith("备注:"))) {
                part = part.substring(3).trim();
            }
            if (part.isEmpty()) continue;
            if (result.length() > 0) result.append('，');
            result.append(part);
        }
        return result.toString();
    }

    private String money(int fen) {
        return String.format(Locale.CHINA, "￥%.2f", fen / 100.0);
    }

    private String formatTime(String value) {
        if (value == null || value.isEmpty() || "null".equals(value)) return "—";
        try {
            ZonedDateTime time = ZonedDateTime.ofInstant(Instant.parse(value), ZoneId.of("Asia/Shanghai"));
            return DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").format(time);
        } catch (Exception ignored) {
            return value;
        }
    }

    private void updateState(boolean isConnected, String message) {
        connected = isConnected;
        stateMessage = message;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, notification(message));
    }

    private Notification notification(String message) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("餐厅打印服务 · " + safeDeviceName())
            .setContentText(message)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "餐厅打印服务", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("保持蓝牙打印机连接并处理新订单打印任务");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private String safeDeviceName() {
        String name = preferences == null ? "打印机" : preferences.getString(KEY_DEVICE_NAME, "打印机");
        return name == null || name.isEmpty() ? "打印机" : name;
    }

    private String shortId(String id) {
        return id.length() > 8 ? id.substring(0, 8) : id;
    }

    private String readableError(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private void closeSocket() {
        connected = false;
        if (socket != null) {
            try { socket.close(); } catch (Exception ignored) { }
            socket = null;
        }
    }

    private void sleep(long milliseconds) {
        try {
            Thread.sleep(milliseconds);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            running = false;
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        closeSocket();
        worker.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
