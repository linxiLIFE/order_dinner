const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");

const dashboardUrl = process.env.ORDER_DINNER_URL || "https://dinner.20-48-27-179.sslip.io:1314";

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.loadURL(dashboardUrl).catch((error) => {
    dialog.showErrorBox("无法打开点单系统", `${error.message}\n\n地址：${dashboardUrl}`);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
