package com.orderdinner.pos;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

@CapacitorPlugin(
    name = "PrinterHost",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = { Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN }
        ),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class PrinterHostPlugin extends Plugin {
    @Override
    public void load() {
        PrinterService.startIfEnabled(getContext());
    }

    @PluginMethod
    public void listPaired(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED) {
            requestPermissionForAlias("bluetooth", call, "pairedPermissionCallback");
            return;
        }
        resolvePaired(call);
    }

    @PermissionCallback
    private void pairedPermissionCallback(PluginCall call) {
        if (getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("请允许蓝牙和附近设备权限");
            return;
        }
        resolvePaired(call);
    }

    private void resolvePaired(PluginCall call) {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) {
            call.reject("这台安卓设备不支持蓝牙");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("请先打开安卓系统蓝牙");
            return;
        }
        List<BluetoothDevice> bonded = new ArrayList<>(adapter.getBondedDevices());
        bonded.sort(Comparator.comparing(device -> {
            String name = device.getName();
            return name == null ? "" : name;
        }));
        JSArray devices = new JSArray();
        for (BluetoothDevice device : bonded) {
            JSObject row = new JSObject();
            row.put("id", device.getAddress());
            row.put("name", device.getName() == null ? "未命名蓝牙设备" : device.getName());
            devices.put(row);
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String deviceId = value(call.getString("deviceId"));
        String deviceName = value(call.getString("deviceName"));
        String printerToken = value(call.getString("printerToken"));
        String serverUrl = value(call.getString("serverUrl"));
        if (deviceId.isEmpty() || printerToken.isEmpty() || serverUrl.isEmpty()) {
            call.reject("打印设备配置不完整");
            return;
        }
        boolean needsBluetooth = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            getPermissionState("bluetooth") != PermissionState.GRANTED;
        boolean needsNotifications = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED;
        if (needsBluetooth || needsNotifications) {
            requestAllPermissions(call, "configurePermissionCallback");
            return;
        }
        saveAndStart(call, deviceId, deviceName, printerToken, serverUrl);
    }

    @PermissionCallback
    private void configurePermissionCallback(PluginCall call) {
        if (getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("请允许蓝牙和附近设备权限");
            return;
        }
        saveAndStart(
            call,
            value(call.getString("deviceId")),
            value(call.getString("deviceName")),
            value(call.getString("printerToken")),
            value(call.getString("serverUrl"))
        );
    }

    private void saveAndStart(PluginCall call, String deviceId, String deviceName, String printerToken, String serverUrl) {
        SharedPreferences preferences = getContext().getSharedPreferences(PrinterService.PREFERENCES, Context.MODE_PRIVATE);
        preferences.edit()
            .putBoolean(PrinterService.KEY_ENABLED, true)
            .putString(PrinterService.KEY_DEVICE_ID, deviceId)
            .putString(PrinterService.KEY_DEVICE_NAME, deviceName)
            .putString(PrinterService.KEY_DEVICE_TOKEN, printerToken)
            .putString(PrinterService.KEY_SERVER_URL, serverUrl.replaceAll("/+$", ""))
            .apply();
        PrinterService.start(getContext());
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().getSharedPreferences(PrinterService.PREFERENCES, Context.MODE_PRIVATE)
            .edit().putBoolean(PrinterService.KEY_ENABLED, false).apply();
        getContext().stopService(new Intent(getContext(), PrinterService.class));
        PrinterService.setStoppedState();
        call.resolve(state());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state());
    }

    private JSObject state() {
        SharedPreferences preferences = getContext().getSharedPreferences(PrinterService.PREFERENCES, Context.MODE_PRIVATE);
        JSObject result = new JSObject();
        result.put("enabled", preferences.getBoolean(PrinterService.KEY_ENABLED, false));
        result.put("connected", PrinterService.isConnected());
        result.put("deviceId", preferences.getString(PrinterService.KEY_DEVICE_ID, ""));
        result.put("deviceName", preferences.getString(PrinterService.KEY_DEVICE_NAME, ""));
        result.put("message", PrinterService.getStateMessage());
        return result;
    }

    private String value(String value) {
        return value == null ? "" : value.trim();
    }
}
