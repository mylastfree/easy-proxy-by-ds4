// tests/fix-safety.test.js —— 验证修复本身未引入新缺陷
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// R3-05：background 会校验 sender.id === chrome.runtime.id，
// 测试必须用真实形态的 sender（含 id），不能再用空对象。
const SENDER_ID = "test-extension-id";

function buildEnv(opts) {
  opts = opts || {};
  const syncStore = {}, localStore = {}, sessionStore = {};
  const listeners = { changed: [], installed: [], startup: [], message: [] };
  const applied = [];
  let proxyActive = false;
  const fetchBehaviour = opts.fetchBehaviour || "ok";

  function makeArea(store, areaName) {
    return {
      get(keys, cb) {
        const out = {};
        const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of ks) if (k in store) out[k] = store[k];
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) {
        const changes = {};
        for (const k of Object.keys(obj)) {
          if (JSON.stringify(store[k]) !== JSON.stringify(obj[k])) changes[k] = { newValue: obj[k] };
          store[k] = obj[k];
        }
        setTimeout(() => {
          if (cb) cb();
          if (Object.keys(changes).length) {
            for (const fn of listeners.changed.slice()) fn(changes, areaName);
          }
        }, 0);
      }
    };
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    TextEncoder, setTimeout, clearTimeout, Date, Promise, Object, Array, JSON,
    Number, String, Math, Boolean, Error, AbortController
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = () => vm.runInContext(settingsSrc, sandbox);

  sandbox.fetch = () => new Promise((resolve, reject) => {
    if (fetchBehaviour === "reject") {
      setTimeout(() => reject(new Error("network down")), 5);
      return;
    }
    setTimeout(() => resolve({
      ok: true,
      json: () => Promise.resolve({
        ip: proxyActive ? "203.0.113.9" : "192.0.2.1",
        org: "", city: "", region: "", country: ""
      })
    }), 15);
  });

  sandbox.chrome = {
    runtime: { lastError: undefined,
      // R3-05 起 background 会校验 sender.id；用 {} 当 sender 属于欠保真的模拟。
      id: SENDER_ID,
      onInstalled: { addListener: f => listeners.installed.push(f) },
      onStartup: { addListener: f => listeners.startup.push(f) },
      onMessage: { addListener: f => listeners.message.push(f) } },
    storage: { sync: makeArea(syncStore, "sync"), local: makeArea(localStore, "local"),
      session: makeArea(sessionStore, "session"),
      onChanged: { addListener: f => listeners.changed.push(f) } },
    proxy: {
      settings: {
        set(o, cb) {
          const sp = (o.value.rules || {}).singleProxy || {};
          setTimeout(() => {
            proxyActive = true;
            applied.push(sp.host + ":" + sp.port);
            sandbox.chrome.runtime.lastError = undefined;
            if (cb) cb();
          }, 0);
        },
        clear(o, cb) {
          setTimeout(() => {
            if (o.scope === "regular") proxyActive = false;
            sandbox.chrome.runtime.lastError = undefined;
            if (cb) cb();
          }, 0);
        },
        get(o, cb) {
          setTimeout(() => cb({
            value: proxyActive ? { mode: "fixed_servers" } : { mode: "system" },
            levelOfControl: "controlled_by_this_extension"
          }), 0);
        }
      },
      onProxyError: { addListener: f => {} }
    },
    action: {
      setIcon: (o, cb) => setTimeout(() => cb && cb(), 0),
      setTitle: (o, cb) => setTimeout(() => cb && cb(), 0)
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(bgSrc, sandbox);
  return { sandbox, syncStore, localStore, sessionStore, applied, listeners,
           getProxyActive: () => proxyActive };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

(async function main() {
  console.log("== 风险1：对比测试后，暂停标志必须复位（下发不能永久失效）==");
  {
    const env = buildEnv();
    await sleep(60);
    env.sandbox.chrome.storage.sync.set({ enableProxy: true, proxyType: "socks5",
      proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "x" }, () => {});
    await sleep(200);

    const handler = env.listeners.message[0];
    await new Promise(r => handler({ action: "testConnection", compare: true }, { id: SENDER_ID }, r));
    await sleep(120);

    env.applied.length = 0;
    env.sandbox.chrome.storage.sync.set({ enableProxy: true, proxyType: "socks5",
      proxyHost: "127.0.0.1", proxyPort: "7777", bypassList: "x" }, () => {});
    await sleep(250);
    t("测试后下发仍正常（暂停标志已复位）",
      env.applied.some(a => a.indexOf(":7777") >= 0), JSON.stringify(env.applied));
  }

  console.log("");
  console.log("== 风险2：fetch 失败时，finally 仍复位标志 ==");
  {
    const env = buildEnv({ fetchBehaviour: "reject" });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set({ enableProxy: true, proxyType: "socks5",
      proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "x" }, () => {});
    await sleep(200);
    const handler = env.listeners.message[0];
    await new Promise(r => handler({ action: "testConnection", compare: true }, { id: SENDER_ID }, r));
    await sleep(150);

    env.applied.length = 0;
    env.sandbox.chrome.storage.sync.set({ enableProxy: true, proxyType: "socks5",
      proxyHost: "127.0.0.1", proxyPort: "6666", bypassList: "x" }, () => {});
    await sleep(250);
    t("fetch 失败后下发仍正常",
      env.applied.some(a => a.indexOf(":6666") >= 0), JSON.stringify(env.applied));
  }

  console.log("");
  console.log("== 风险3：连续快速修改，最终生效的是最后一次 ==");
  {
    const env = buildEnv();
    await sleep(60);
    env.applied.length = 0;
    // 不 await，模拟用户快速连点
    for (let i = 1; i <= 5; i++) {
      env.sandbox.chrome.storage.sync.set({ enableProxy: true, proxyType: "socks5",
        proxyHost: "127.0.0.1", proxyPort: String(9000 + i), bypassList: "x" }, () => {});
      await sleep(4);
    }
    await sleep(700);
    const last = env.applied[env.applied.length - 1] || "(无)";
    t("最终生效为最后一次设置 9005", last.indexOf(":9005") >= 0,
      "实际 = " + last + "；序列 = " + JSON.stringify(env.applied));
    t("队列未累积（执行次数 <= 请求次数 5）", env.applied.length <= 5,
      "执行 " + env.applied.length + " 次");
  }

  console.log("");
  console.log("== 风险4：正常单次保存只下发一次 ==");
  {
    const env = buildEnv();
    await sleep(60);
    env.applied.length = 0;
    env.sandbox.chrome.storage.sync.set({ enableProxy: true, proxyType: "socks5",
      proxyHost: "127.0.0.1", proxyPort: "5555", bypassList: "x" }, () => {});
    await sleep(300);
    t("local 原本为空时只下发一次", env.applied.length === 1,
      "实际 " + env.applied.length + " 次: " + JSON.stringify(env.applied));
  }

  console.log("");
  console.log("== 风险5：CIDR 判定收紧未误伤合法网段 ==");
  {
    const sb = { TextEncoder, console };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(settingsSrc, sb);
    const S = sb.EasyProxy;
    const legal = ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "127.0.0.0/8",
      "fe80::/10", "2001:db8::/32", "100.64.0.0/10", "224.0.0.0/4",
      "0.0.0.0/0", "255.255.255.255/32", "192.168.31.0/24"];
    for (const ip of legal) {
      const got = S.parseBypassList(ip)[0];
      t("网段 " + ip + " 正确保留", got === ip, "得到 " + got);
    }
    const shouldStrip = [["beef.cafe/12", "beef.cafe"], ["abcdef.abc/16", "abcdef.abc"],
      ["example.com/path", "example.com"]];
    for (const pair of shouldStrip) {
      const got = S.parseBypassList(pair[0])[0];
      t("域名 " + pair[0] + " 正确剥离路径", got === pair[1], "得到 " + got);
    }
  }

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) {
  console.error("测试脚本异常:", e);
  process.exit(2);
});
