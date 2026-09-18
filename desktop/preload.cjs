const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("点单台桌面", {
  版本: "1.0.0"
});
