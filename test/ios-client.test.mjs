import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function client(platform, origin = "https://43.142.138.108:1316") {
  const calls = [], shared = [], events = [], storage = new Map();
  const context = vm.createContext({
    __ORDER_DINNER_API_ORIGIN__: origin,
    Headers, Blob, URL, crypto, atob, console,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { dispatchEvent: event => events.push(event.type), setTimeout: () => {} },
    Event,
    FileReader: class {
      async readAsDataURL(blob) {
        this.result = `data:text/csv;base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
        this.onload();
      }
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response("菜品,份数\n鱼,2", { headers: { "Content-Disposition": "attachment; filename*=UTF-8''%E8%90%A5%E4%B8%9A%E7%BB%9F%E8%AE%A1.csv" } });
    }
  });
  function load(path, require) {
    const source = ts.transpileModule(fs.readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    context.exports = {};
    context.require = require;
    new vm.Script(source, { filename: path }).runInContext(context);
    return context.exports;
  }
  const runtime = load("web/src/platform.ts", () => ({
    Capacitor: { getPlatform: () => platform },
    registerPlugin: () => ({ shareFile: async file => shared.push(file) })
  }));
  const api = load("web/src/api.ts", () => runtime);
  return { api, runtime, calls, shared, events, context };
}

test("iOS 使用与网页一致的点菜布局，安卓保留现有布局", () => {
  assert.equal(client("ios").runtime.usesWebOrderingLayout, true);
  assert.equal(client("web", "").runtime.usesWebOrderingLayout, true);
  assert.equal(client("android", "").runtime.usesWebOrderingLayout, false);
});

test("iOS 业务请求连接同一 HTTPS 后端并携带员工授权", async () => {
  const c = client("ios");
  c.api.setToken("test-token");
  await c.api.api("/api/tables");
  assert.equal(c.calls[0].url, "https://43.142.138.108:1316/api/tables");
  assert.equal(c.calls[0].options.headers.get("Authorization"), "Bearer test-token");
  assert.equal(client("web", "").runtime.apiUrl("/api/tables"), "/api/tables");
});

test("iOS 导出保留 CSV 原始中文和文件名并交给原生分享", async () => {
  const c = client("ios");
  await c.api.downloadFile("/api/stats/export.csv", "报表.csv");
  assert.equal(c.shared.length, 1);
  assert.equal(c.shared[0].filename, "营业统计.csv");
  assert.equal(Buffer.from(c.shared[0].base64, "base64").toString(), "菜品,份数\n鱼,2");
});

test("iOS 请求登录失效时清除授权并通知界面", async () => {
  const c = client("ios");
  c.api.setToken("expired");
  c.context.fetch = async () => new Response(JSON.stringify({ error: "登录失效" }), { status: 401 });
  await assert.rejects(c.api.api("/api/tables"), /登录失效/);
  assert.equal(c.api.getToken(), "");
  assert.deepEqual(c.events, ["点单台登录失效"]);
});
