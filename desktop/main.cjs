const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const dashboardUrl = process.env.ORDER_DINNER_URL || "https://43.142.138.108:1316";
const updateManifestUrl = process.env.ORDER_DINNER_UPDATE_MANIFEST_URL || new URL("/updates/latest.json", dashboardUrl).toString();
const updateChannel = "order-dinner:update";
const manifestLimit = 256 * 1024;
const installerLimit = 2 * 1024 * 1024 * 1024;

function compareVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error("更新清单中的版本号格式不正确。");
    }
    return value.split(".").map((part) => Number(part));
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function validateHttpsUrl(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}地址无效，请检查更新发布配置。`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label}必须使用 HTTPS。`);
  }
  return url;
}

async function fetchResponse(rawUrl, label, timeoutMs = 30_000) {
  const url = validateHttpsUrl(rawUrl, label);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    validateHttpsUrl(response.url, label);
    if (!response.ok) throw new Error(`${label}请求失败（HTTP ${response.status}）。`);
    return { response, finish: () => clearTimeout(timeout) };
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label}连接失败，请检查网络或发布地址。`);
  }
}

async function readBoundedText(response, maxBytes) {
  if (!response.body) throw new Error("服务器没有返回更新清单内容。");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("更新清单过大，已停止检查。");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readManifest() {
  const fetched = await fetchResponse(updateManifestUrl, "更新清单");
  let text;
  try {
    const contentLength = Number(fetched.response.headers.get("content-length") || 0);
    if (contentLength > manifestLimit) throw new Error("更新清单过大，已停止检查。");
    text = await readBoundedText(fetched.response, manifestLimit);
  } finally {
    fetched.finish();
  }

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("更新清单格式错误，请联系管理员检查发布文件。");
  }
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("暂不支持此更新清单版本。");
  compareVersions(manifest.version, app.getVersion());
  if (typeof manifest.notes !== "undefined" && typeof manifest.notes !== "string") {
    throw new Error("更新说明格式错误。");
  }
  const artifact = manifest.windows;
  if (!artifact || typeof artifact !== "object") throw new Error("更新清单缺少 Windows 安装包。");
  validateHttpsUrl(artifact.url, "Windows 安装包");
  if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error("更新清单中的 Windows 安装包校验值无效。");
  }
  return manifest;
}

async function checkForUpdate() {
  const manifest = await readManifest();
  const currentVersion = app.getVersion();
  const available = compareVersions(manifest.version, currentVersion) > 0;
  return {
    available,
    currentVersion,
    latestVersion: manifest.version,
    notes: manifest.notes || "",
    message: available ? "发现新版本。" : "当前已经是最新版本。"
  };
}

async function downloadInstaller(artifact, version, event) {
  const fetched = await fetchResponse(artifact.url, "Windows 安装包", 5 * 60_000);
  try {
    const response = fetched.response;
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > installerLimit) throw new Error("Windows 安装包超过允许大小，已停止下载。");
    if (!response.body) throw new Error("服务器没有返回 Windows 安装包内容。");

    const directory = path.join(app.getPath("temp"), "order-dinner-updates");
    await fs.promises.mkdir(directory, { recursive: true });
    const basename = `order-dinner-${version}-${randomUUID()}`;
    const partialPath = path.join(directory, `${basename}.download`);
    const installerPath = path.join(directory, `${basename}.exe`);
    const hash = createHash("sha256");
    let downloaded = 0;
    const verifier = new Transform({
      transform(chunk, encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > installerLimit) {
          callback(new Error("Windows 安装包超过允许大小，已停止下载。"));
          return;
        }
        hash.update(chunk);
        event.sender.send(`${updateChannel}:progress`, {
          downloadedBytes: downloaded,
          totalBytes: contentLength || null
        });
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(partialPath, { flags: "wx" }));
    const actualSha256 = hash.digest("hex");
    if (actualSha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new Error("Windows 安装包校验失败，文件没有启动。");
    }
    await fs.promises.rename(partialPath, installerPath);
    return installerPath;
  } finally {
    fetched.finish();
  }
}

function assertTrustedSender(event) {
  try {
    const senderOrigin = new URL(event.senderFrame.url).origin;
    const appOrigin = new URL(dashboardUrl).origin;
    if (senderOrigin !== appOrigin) throw new Error("来源不可信。");
  } catch {
    throw new Error("当前页面不能执行更新操作，请重新打开点单系统。");
  }
}

function chineseUpdateError(error) {
  const message = error instanceof Error ? error.message : "";
  return /[\u3400-\u9fff]/.test(message)
    ? message
    : "更新失败，请检查网络连接和磁盘空间后重试。";
}

ipcMain.handle(`${updateChannel}:check`, async (event) => {
  assertTrustedSender(event);
  try {
    return await checkForUpdate();
  } catch (error) {
    throw new Error(chineseUpdateError(error));
  }
});

ipcMain.handle(`${updateChannel}:version`, (event) => {
  assertTrustedSender(event);
  return app.getVersion();
});

ipcMain.handle(`${updateChannel}:install`, async (event) => {
  assertTrustedSender(event);
  try {
    const manifest = await readManifest();
    const currentVersion = app.getVersion();
    if (compareVersions(manifest.version, currentVersion) <= 0) {
      throw new Error("当前已经是最新版本，无需安装。");
    }
    const installerPath = await downloadInstaller(manifest.windows, manifest.version, event);
    const openError = await shell.openPath(installerPath);
    if (openError) throw new Error(`无法启动更新安装程序：${openError}`);
    setTimeout(() => app.quit(), 1200);
    return {
      started: true,
      version: manifest.version,
      message: "安装程序已启动，请按窗口提示完成更新。"
    };
  } catch (error) {
    throw new Error(chineseUpdateError(error));
  }
});

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
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== new URL(dashboardUrl).origin) event.preventDefault();
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
