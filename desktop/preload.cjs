const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("点单台桌面", {
  获取版本: () => ipcRenderer.invoke("order-dinner:update:version"),
  检查更新: () => ipcRenderer.invoke("order-dinner:update:check"),
  下载并安装更新: () => ipcRenderer.invoke("order-dinner:update:install"),
  监听更新进度: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("order-dinner:update:progress", listener);
    return () => ipcRenderer.removeListener("order-dinner:update:progress", listener);
  }
});
