// tests/background.test.js —— 异步逻辑测试（覆盖 background.js 的竞态修复）
// 运行：node tests/background.test.js
//
// 设计说明：本测试同时兼容「修复前」与「修复后」的 background.js：
//   · 若存在 applyProxySerial（修复后），走串行化路径
//   · 否则退化为直接触发（修复前），此时断言会失败 —— 这正是我们想要的对照
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const PROXY_EXIT_IP = "203.0.113.9";   // 走代理时的出口
const DIRECT_EXIT_IP = "192.0.2.1";    // 直连时的出口

// R3-05：background 会校验 sender.id === chrome.runtime.id，
// 测试必须用真实形态的 sender（含 id），不能再用空对象。
const SENDER_ID = "test-extension-id";

function buildEnv(opts) {
  opts = opts || {};
  const slowPort = opts.slowPort || 0;       // 该端口的下发被刻意放慢
  const slowMs = opts.slowMs || 0;
  const fetchDelayMs = opts.fetchDelayMs || 0;
  const onStorageChangeDuringFetch = opts.onStorageChangeDuringFetch || null;

  const syncStore = {};
  const localStore = {};
  const sessionStore = {};
  const listeners = { changed: [], installed: [], startup: [], message: [], onChange: [] };
  const applied = [];        // 按「完成时刻」记录真正写入浏览器的配置
  let proxyActive = false;   // 当前是否挂着代理（决定 fetch 返回哪个出口 IP）
  let fetchCount = 0;
  let proxyActiveAtDirectFetch = null;   // 「取直连出口」时刻的代理状态

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
          if (JSON.stringify(store[k]) !== JSON.stringify(obj[k])) {
            changes[k] = { oldValue: store[k], newValue: obj[k] };
          }
          store[k] = obj[k];
        }
        setTimeout(() => {
          if (cb) cb();
          // 对齐 Chromium AddToBatch：值未变化时不派发 onChanged
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

  sandbox.fetch = (url, init) => {
    fetchCount++;
    const n = fetchCount;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 第 2 次 fetch 即「取直连出口」：记录此刻代理是否处于清除状态。
        // 若测试期间被重新下发代理，这里就会变成 true，正是竞态的直接证据。
        if (n === 2) proxyActiveAtDirectFetch = proxyActive;
        resolve({
          ok: true,
          json: () => Promise.resolve({
            ip: proxyActive ? PROXY_EXIT_IP : DIRECT_EXIT_IP,
            org: proxyActive ? "PROXY-ORG" : "DIRECT-ORG",
            city: "Test", region: "Test", country: "ZZ"
          })
        });
      }, fetchDelayMs);
      if (init && init.signal) {
        init.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }
      // 在第 2 次 fetch（取「直连出口」）进行中触发一次存储变化，
      // 这才是真正危险的窗口：此时代理已被清除，若 onChanged 触发重新下发，
      // 直连出口会被代理出口污染，导致 ipChanged 误判为 false。
      if (onStorageChangeDuringFetch && n === 2) {
        setTimeout(() => onStorageChangeDuringFetch(sandbox), 0);
      }
    });
  };

  sandbox.chrome = {
    runtime: {
      lastError: undefined,
      // R3-05 起 background 会校验 sender.id；测试模拟必须提供真实形态的 sender，
      // 否则内部消息会被拒绝（用 {} 当 sender 属于欠保真的模拟）。
      id: SENDER_ID,
      onInstalled: { addListener: f => listeners.installed.push(f) },
      onStartup: { addListener: f => listeners.startup.push(f) },
      onMessage: { addListener: f => listeners.message.push(f) }
    },
    storage: {
      sync: makeArea(syncStore, "sync"),
      local: makeArea(localStore, "local"),
      session: makeArea(sessionStore, "session"),
      onChanged: { addListener: f => listeners.changed.push(f) }
    },
    proxy: {
      settings: {
        set(o, cb) {
          const sp = (o.value.rules || {}).singleProxy || {};
          const label = sp.scheme + " " + sp.host + ":" + sp.port;
          const delay = (Number(sp.port) === slowPort) ? slowMs : 0;
          setTimeout(() => {
            proxyActive = true;
            applied.push(label);        // 完成时刻才记录
            sandbox.chrome.runtime.lastError = undefined;
            cb();
          }, delay);
        },
        clear(o, cb) {
          setTimeout(() => {
            if (o.scope === "regular") proxyActive = false;
            sandbox.chrome.runtime.lastError = undefined;
            cb();
          }, 0);
        },
        get(o, cb) {
          setTimeout(() => cb({
            value: proxyActive ? { mode: "fixed_servers" } : { mode: "system" },
            levelOfControl: "controlled_by_this_extension"
          }), 0);
        },
        // R6-04：background.js 会注册 chrome.proxy.settings.onChange；
        //   缺少该桩会让脚本一加载就抛 TypeError，整套用例连锁失败。
        onChange: { addListener(f) { listeners.onChange.push(f); } }
      },
      onProxyError: { addListener() {} }
    },
    action: {
      setIcon: (o, cb) => setTimeout(() => cb && cb(), 0),
      setTitle: (o, cb) => setTimeout(() => cb && cb(), 0)
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(bgSrc, sandbox);

  return { sandbox, syncStore, localStore, sessionStore, applied, listeners,
           getProxyActive: () => proxyActive,
           getProxyActiveAtDirectFetch: () => proxyActiveAtDirectFetch };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

(async function main() {
  console.log("== A1：并发下发时，最终生效的必须是最新值 ==");
  {
    // 让 10808 的下发慢 200ms，9999 的立即完成，制造「后发先至」窗口
    const env = buildEnv({ slowPort: 10808, slowMs: 200 });
    await sleep(60);

    const base = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1" };
    // 先落到 10808 并让它完成
    env.sandbox.chrome.storage.sync.set(Object.assign({}, base, { proxyPort: "10808", bypassList: "x" }), () => {});
    await sleep(300);
    env.applied.length = 0;

    // 改 10808（慢）→ 紧接着改 9999（快）
    env.sandbox.chrome.storage.sync.set(Object.assign({}, base, { proxyPort: "10808", bypassList: "y" }), () => {});
    await sleep(20);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, base, { proxyPort: "9999", bypassList: "y" }), () => {});
    await sleep(500);

    const lastApplied = env.applied[env.applied.length - 1] || "(无)";
    t("存储中的端口为最新值 9999", env.syncStore.proxyPort === "9999", env.syncStore.proxyPort);
    t("浏览器最终生效的也是最新值 9999", lastApplied.indexOf(":9999") >= 0,
      "实际生效 = " + lastApplied + "；完成序列 = " + JSON.stringify(env.applied));
  }

  console.log("");
  console.log("== A2：测试期间发生存储变化，直连出口不应被污染 ==");
  {
    let extraSetDone = false;
    const env = buildEnv({
      fetchDelayMs: 400,   // 加长窗口，让「测试期间被重新下发」有足够时间发生
      onStorageChangeDuringFetch: (sb) => {
        // 模拟「同步推送」：测试进行中，存储发生一次变化
        if (extraSetDone) return;
        extraSetDone = true;
        sb.chrome.storage.sync.set({ enableProxy: true, proxyType: "socks5",
          proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "pushed" }, () => {});
      }
    });
    await sleep(60);

    env.sandbox.chrome.storage.sync.set({ enableProxy: true, proxyType: "socks5",
      proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "local" }, () => {});
    await sleep(300);

    // 直接调用 testConnection（compare = true）
    const handler = env.listeners.message[0];
    const resp = await new Promise(resolve => {
      handler({ action: "testConnection", compare: true }, { id: SENDER_ID }, resolve);
    });

    const directIp = resp && resp.result && resp.result.direct && resp.result.direct.ip;
    t("取到了直连出口", !!directIp, JSON.stringify(resp && resp.result && resp.result.direct));
    // 直接断言竞态本身：取直连出口时，代理必须确实处于清除状态
    t("取直连出口时代理处于清除状态（未被测试期变化重新下发）",
      env.getProxyActiveAtDirectFetch() === false,
      "当时 proxyActive = " + env.getProxyActiveAtDirectFetch());
    t("直连出口未被代理污染（应为 " + DIRECT_EXIT_IP + "）",
      directIp === DIRECT_EXIT_IP, "实际 = " + directIp);
    t("ipChanged 判定为 true（代理确实生效）",
      resp && resp.result && resp.result.ipChanged === true,
      "ipChanged = " + (resp && resp.result && resp.result.ipChanged));
  }

  console.log("");
  console.log("== B2：popup 与 background 的绕过列表取值必须一致 ==");
  {
    const S = (() => {
      const sb = { TextEncoder, console };
      sb.globalThis = sb;
      vm.createContext(sb);
      vm.runInContext(settingsSrc, sb);
      return sb.EasyProxy;
    })();
    // 修复后 settings.js 应导出 resolveBypassList
    if (typeof S.resolveBypassList !== "function") {
      t("settings.js 导出 resolveBypassList 供两处共用", false, "未导出");
    } else {
      t("settings.js 导出 resolveBypassList 供两处共用", true);
      t("sync 有值优先取 sync", S.resolveBypassList("AAA", "BBB") === "AAA");
      t("sync 为空则取 local", S.resolveBypassList("", "BBB") === "BBB");
      t("sync 缺失则取 local", S.resolveBypassList(undefined, "BBB") === "BBB");
      t("两者皆空则返回空", S.resolveBypassList("", "") === "");
      t("两者皆缺失则返回空", S.resolveBypassList(undefined, undefined) === "");
    }
  }

  console.log("");
  console.log("== C1：CIDR 判定收紧后，纯 hex 域名不应被误判 ==");
  {
    const S = (() => {
      const sb = { TextEncoder, console };
      sb.globalThis = sb;
      vm.createContext(sb);
      vm.runInContext(settingsSrc, sb);
      return sb.EasyProxy;
    })();
    t("192.168.0.0/16 仍识别为网段", S.parseBypassList("192.168.0.0/16")[0] === "192.168.0.0/16");
    t("10.0.0.0/8 仍识别为网段", S.parseBypassList("10.0.0.0/8")[0] === "10.0.0.0/8");
    t("172.16.0.0/12 仍识别为网段", S.parseBypassList("172.16.0.0/12")[0] === "172.16.0.0/12");
    t("fe80::/10 仍识别为网段", S.parseBypassList("fe80::/10")[0] === "fe80::/10");
    t("beef.cafe/12 不再误判（按路径剥离）", S.parseBypassList("beef.cafe/12")[0] === "beef.cafe",
      "实际 = " + S.parseBypassList("beef.cafe/12")[0]);
    t("abcdef.abc/16 不再误判", S.parseBypassList("abcdef.abc/16")[0] === "abcdef.abc",
      "实际 = " + S.parseBypassList("abcdef.abc/16")[0]);
    t("example.com/path 仍正确剥离", S.parseBypassList("example.com/path")[0] === "example.com");
    t("192.168.0.0/16?x 仍保留网段", S.parseBypassList("192.168.0.0/16?x")[0] === "192.168.0.0/16");
    // 以下两条专门覆盖「段数必须为 4」这一判断：
    // 它们全是数字，仅靠 isAllDigits 拦不住，必须依赖分段数校验
    t("1.2.3/8（3 段纯数字）不误判为网段", S.parseBypassList("1.2.3/8")[0] === "1.2.3",
      "实际 = " + S.parseBypassList("1.2.3/8")[0]);
    t("1.2.3.4.5/8（5 段）不误判为网段", S.parseBypassList("1.2.3.4.5/8")[0] === "1.2.3.4.5",
      "实际 = " + S.parseBypassList("1.2.3.4.5/8")[0]);
    t("999.1.1.1/8（段值超 255）不误判为网段",
      S.parseBypassList("999.1.1.1/8")[0] === "999.1.1.1",
      "实际 = " + S.parseBypassList("999.1.1.1/8")[0]);

    console.log("");
    console.log("== N3：IPv6 代理地址不应被误判为「写了端口」==");
    const base6 = S.normalizeSettings({ enableProxy: true });
    const v6cases = ["::1", "fe80::1", "2001:db8::1", "[::1]", "[fe80::1]"];
    for (const h of v6cases) {
      const errs = S.validateSettings(Object.assign({}, base6, { proxyHost: h }));
      t("IPv6 地址 " + h + " 被接受", errs.length === 0, JSON.stringify(errs));
    }
    // 反向：真正的 host:port 误写仍要拦住
    const hp = ["1.2.3.4:8080", "localhost:8080", "example.com:3128"];
    for (const h of hp) {
      const errs = S.validateSettings(Object.assign({}, base6, { proxyHost: h }));
      t("host:port 误写 " + h + " 仍被拦住", errs.length > 0);
    }
    t("stripBrackets([::1]) -> ::1", S.stripBrackets("[::1]") === "::1",
      "实际 " + S.stripBrackets("[::1]"));
    t("stripBrackets(::1) 保持不变", S.stripBrackets("::1") === "::1");
    t("stripBrackets(127.0.0.1) 保持不变", S.stripBrackets("127.0.0.1") === "127.0.0.1");

    console.log("");
    console.log("== N4：全角分隔符应被识别 ==");
    t("全角逗号 分割为两项", S.parseBypassList("a.com\uff0cb.com").length === 2,
      JSON.stringify(S.parseBypassList("a.com\uff0cb.com")));
    t("全角分号 分割为两项", S.parseBypassList("a.com\uff1bb.com").length === 2,
      JSON.stringify(S.parseBypassList("a.com\uff1bb.com")));
    t("中文顿号 分割为两项", S.parseBypassList("a.com\u3001b.com").length === 2,
      JSON.stringify(S.parseBypassList("a.com\u3001b.com")));
    t("全角逗号分隔的网段被正确解析",
      JSON.stringify(S.parseBypassList("192.168.0.0/16\uff0c10.0.0.0/8")) ===
        JSON.stringify(["192.168.0.0/16", "10.0.0.0/8"]),
      JSON.stringify(S.parseBypassList("192.168.0.0/16\uff0c10.0.0.0/8")));
  }

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
