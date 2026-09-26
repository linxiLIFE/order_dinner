import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("package.json 版本必须为 x.y.z 格式。");

function oneFile(directory, matcher, description) {
  const matches = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  if (matches.length !== 1) throw new Error(`${description}应有且仅有一个，当前找到 ${matches.length} 个。`);
  return matches[0];
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const androidPackage = oneFile(
  path.join(root, "release", "android", version),
  new RegExp(`^餐厅点单台-${version}-.+\\.apk$`, "i"),
  "安卓安装包"
);
const windowsPackage = oneFile(
  path.join(root, "release", "desktop", version),
  /\.exe$/i,
  "Windows 安装包"
);

const updatesRoot = path.join(root, "updates");
const baseUrl = new URL(process.env.UPDATE_BASE_URL || "https://43.142.138.108:1316");
if (baseUrl.protocol !== "https:") throw new Error("更新服务地址必须使用 HTTPS。");
const versionDirectory = path.join(updatesRoot, version);
if (fs.existsSync(versionDirectory)) {
  throw new Error(`线上发布目录已存在：${versionDirectory}。请先升级 package.json 版本，禁止覆盖已发布安装包。`);
}

fs.mkdirSync(updatesRoot, { recursive: true });
const nonce = `${process.pid}-${crypto.randomUUID()}`;
const stagingDirectory = path.join(updatesRoot, `.staging-${version}-${nonce}`);
fs.mkdirSync(stagingDirectory, { recursive: false });

const artifacts = {};
for (const [platform, source] of [["android", androidPackage], ["windows", windowsPackage]]) {
  const name = path.basename(source);
  const destination = path.join(stagingDirectory, name);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const urlPath = `/updates/${version}/${encodeURIComponent(name)}`;
  artifacts[platform] = { url: new URL(urlPath, baseUrl).toString(), sha256: sha256(destination) };
}

fs.renameSync(stagingDirectory, versionDirectory);
const manifest = {
  schemaVersion: 1,
  version,
  notes: "点菜界面可独立滚动并固定合计；增加宴席备菜单提醒和备注编辑；网页、安卓和 Windows 更新。",
  android: artifacts.android,
  windows: artifacts.windows
};

const latestManifest = path.join(updatesRoot, "latest.json");
const stagedManifest = path.join(updatesRoot, `.latest-${nonce}.json`);
fs.writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

let archivedManifest;
if (fs.existsSync(latestManifest)) {
  let previousVersion = "previous";
  try {
    previousVersion = JSON.parse(fs.readFileSync(latestManifest, "utf8")).version || previousVersion;
  } catch {
    // Preserve malformed prior content in the archive before publishing a replacement.
  }
  const archiveDirectory = path.join(updatesRoot, "archive");
  fs.mkdirSync(archiveDirectory, { recursive: true });
  archivedManifest = path.join(archiveDirectory, `latest-${previousVersion}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  if (fs.existsSync(archivedManifest)) throw new Error("更新清单归档路径已存在，停止覆盖。");
  fs.renameSync(latestManifest, archivedManifest);
}

try {
  fs.renameSync(stagedManifest, latestManifest);
} catch (error) {
  if (archivedManifest && !fs.existsSync(latestManifest)) fs.renameSync(archivedManifest, latestManifest);
  throw error;
}

console.log(JSON.stringify({ manifest: latestManifest, versionDirectory, manifestData: manifest }, null, 2));
