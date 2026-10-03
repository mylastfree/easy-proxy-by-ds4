// tests/concurrency.test.js —— 并发场景护栏（针对 N1/N2）
// 运行：node tests/concurrency.test.js
//
// 背景：v2.1.2 中 testConnection 用「保存-恢复」方式操作 applySuspended 布尔标志，
// 两个测试并发时标志会永久卡在 true，导致之后所有代理下发被静默跳过。
// 本测试用【行为断言】捕捉它：并发测试后改设置，断言 setProxy 确实被调用过。
// 这个断言比「读内部变量」更有价值 —— 它直接观测失效后果。
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const settingsSrc = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
const bgSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

function buildEnv(opts) {
  opts = opts || {};
  const syncStore = {}, localStore = {}, sessionStore = {};
  const listeners = { changed: [], message: [] };
  const setCalls = [];          // 每次 setProxy 的主机:端口
  let proxyActive = false;
  const fetchDelay = opts.fetchDelay || 120;

  function makeArea(store, areaName) {
    return {
      get: function (keys, cb) {
        const out = {};
        const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of ks) if (k in store) out[k] = store[k];
        setTimeout(function () { cb(out); }, 0);
      },
      set: function (obj, cb) {
        const changes = {};
        for (const k of Object.keys(obj)) {
          if (JSON.stringify(store[k]) !== JSON.stringify(obj[k])) changes[k] = { newValue: obj[k] };
          store[k] = obj[k];
        }
        setTimeout(function () {
          if (cb) cb();
          if (Object.keys(changes).length) for (const fn of listeners.changed.slice()) fn(changes, areaName);
        }, 0);
      }
    };
  }

  const sandbox = {
    console: { log: function(){}, warn: function(){}, error: function(){} },
    TextEncoder: TextEncoder, setTimeout: setTimeout, clearTimeout: clearTimeout,
    Date: Date, Promise: Promise, Object: Object, Array: Array, JSON: JSON,
    Number: Number, String: String, Math: Math, Boolean: Boolean, Error: Error,
    AbortController: AbortController
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = function () { vm.runInContext(settingsSrc, sandbox); };
  sandbox.fetch = function () {
    return new Promise(function (resolve) {
      setTimeout(function () {
        const ip = proxyActive ? "203.0.113.9" : "192.0.2.1";
        resolve({ ok: true, json: function () { return Promise.resolve({ ip: ip }); } });
      }, fetchDelay);
    });
  };
sandbox.chrome = {
    runtime: { lastError: undefined,
      onInstalled: { addListener: function(){} }, onStartup: { addListener: function(){} },
      onMessage: { addListener: function (f) { listeners.message.push(f); } } },
    storage: { sync: makeArea(syncStore, "sync"), local: makeArea(localStore, "local"),
      session: makeArea(sessionStore, "session"),
      onChanged: { addListener: function (f) { listeners.changed.push(f); } } },
    proxy: {
      settings: {
        set: function (o, cb) {
          const sp = (o.value.rules || {}).singleProxy || {};
          setCalls.push(sp.host + ":" + sp.port);
          setTimeout(function () { proxyActive = true; sandbox.chrome.runtime.lastError = undefined; if (cb) cb(); }, 0);
        },
        clear: function (o, cb) {
          setTimeout(function () { if (o.scope === "regular") proxyActive = false; sandbox.chrome.runtime.lastError = undefined; if (cb) cb(); }, 0);
        },
        get: function (o, cb) {
          setTimeout(function () { cb({ value: { mode: "fixed_servers" }, levelOfControl: "controlled_by_this_extension" }); }, 0);
        }
      },
      onProxyError: { addListener: function(){} }
    },
    action: { setIcon: function (o, cb) { setTimeout(function(){ if(cb) cb(); }, 0); },
              setTitle: function (o, cb) { setTimeout(function(){ if(cb) cb(); }, 0); } }
  };

  vm.createContext(sandbox);
  vm.runInContext(bgSrc, sandbox);
  return { sandbox: sandbox, syncStore: syncStore, setCalls: setCalls, listeners: listeners };
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

const BASE = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", bypassList: "x" };

function ask(handler, msg) {
  return new Promise(function (r) { handler(msg, {}, r); });
}

(async function main() {
  console.log("== N1: 两个连接测试并发后，自动下发必须仍然工作 ==");
  {
    const env = buildEnv({ fetchDelay: 150 });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(250);

    const handler = env.listeners.message[0];
    // 模拟用户打开两个弹窗、几乎同时点「对比直连出口」
    const p1 = ask(handler, { action: "testConnection", compare: true });
    await sleep(25);
    const p2 = ask(handler, { action: "testConnection", compare: true });
    await Promise.all([p1, p2]);
    await sleep(150);

    // 关键断言：并发测试之后，改设置还能不能真正下发
    env.setCalls.length = 0;
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "7777" }), function () {});
    await sleep(400);

    const applied = env.setCalls.indexOf("127.0.0.1:7777") >= 0;
    t("并发测试后改变设置仍会下发到浏览器", applied,
      "setProxy 调用序列 = " + JSON.stringify(env.setCalls) + "（为空即表示下发被永久跳过）");
  }

  console.log("");
  console.log("== N2: 第二个并发测试应被拒绝，避免出口判定错乱 ==");
  {
    const env = buildEnv({ fetchDelay: 150 });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(250);

    const handler = env.listeners.message[0];
    const p1 = ask(handler, { action: "testConnection", compare: true });
    await sleep(25);
    const r2 = await ask(handler, { action: "testConnection", compare: true });
    await p1;

    const skipped = r2 && r2.result && r2.result.skipped === "in_flight";
    t("并发的第二个测试被明确拒绝（skipped=in_flight）", skipped,
      "第二个测试返回 " + JSON.stringify(r2 && r2.result && { ok: r2.result.ok, skipped: r2.result.skipped }));
  }

  console.log("");
  console.log("== 回归: 单个测试后一切正常 ==");
  {
    const env = buildEnv({ fetchDelay: 120 });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(250);

    const handler = env.listeners.message[0];
    const r = await ask(handler, { action: "testConnection", compare: true });
    t("单个测试返回直连出口", r && r.result && r.result.direct && r.result.direct.ip === "192.0.2.1",
      JSON.stringify(r && r.result && r.result.direct));
    t("单个测试 ipChanged 为 true", !!(r && r.result && r.result.ipChanged));

    env.setCalls.length = 0;
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "6666" }), function () {});
    await sleep(400);
    t("单个测试后下发正常", env.setCalls.indexOf("127.0.0.1:6666") >= 0,
      JSON.stringify(env.setCalls));
  }

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) { console.error("EXC: " + (e && e.stack || e)); process.exit(2); });
