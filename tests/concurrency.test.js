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

// R3-05：background 会校验 sender.id === chrome.runtime.id，
// 测试必须用真实形态的 sender（含 id），不能再用空对象。
const SENDER_ID = "test-extension-id";
const settingsSrc = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
const bgSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

function buildEnv(opts) {
  opts = opts || {};
  const syncStore = {}, localStore = {}, sessionStore = {};
  const listeners = { changed: [], message: [], onChange: [] };
  const setCalls = [];          // 每次 setProxy 的主机:端口
  let proxyActive = false;
  // 记录「当前实际生效的代理配置」，供 R3-01 的行为断言使用。
  // 断言对象必须是【下发给 chrome.proxy 的配置】，而不是存储值或内部变量 ——
  // 本项目 A1、N1 两次缺陷都是「存储一直正确、浏览器实际失效」，查存储永远发现不了。
  let effective = null;         // null 表示当前无代理（直连）
  const iconCalls = [];         // setIcon 收到的图标路径
  const titleCalls = [];        // setTitle 收到的标题
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
    runtime: { lastError: undefined, id: SENDER_ID,
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
          setTimeout(function () {
            proxyActive = true;
            effective = sp.host + ":" + sp.port;
            sandbox.chrome.runtime.lastError = undefined; if (cb) cb();
          }, 0);
        },
        clear: function (o, cb) {
          setTimeout(function () {
            if (opts.clearFails) {
              sandbox.chrome.runtime.lastError = { message: "clear failed (injected)" };
              if (cb) cb();
              sandbox.chrome.runtime.lastError = undefined;
              return;
            }
            if (o.scope === "regular") { proxyActive = false; effective = null; }
            sandbox.chrome.runtime.lastError = undefined; if (cb) cb();
          }, 0);
        },
        get: function (o, cb) {
          if (opts.getFails) {
            // 故障注入：回读控制权失败（lastError 置位 + 回调 undefined）
            setTimeout(function () {
              sandbox.chrome.runtime.lastError = { message: "get failed (injected)" };
              cb(undefined);
              sandbox.chrome.runtime.lastError = undefined;
            }, 0);
            return;
          }
          // 返回「当前真实生效」的完整配置，而不是只返回 mode。
          // 只返回 mode 会让测试里的 backup 丢失 rules，恢复阶段写回一个
          // 没有 singleProxy 的配置 —— 那属于 mock 欠保真，会掩盖真实的端口差异。
          var value;
          if (effective !== null) {
            var parts = effective.split(":");
            value = { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: parts[0], port: parts[1] } } };
          } else {
            value = { mode: "direct" };
          }
          setTimeout(function () { cb({ value: value, levelOfControl: "controlled_by_this_extension" }); }, 0);
        },
        // R6-04：background.js 会注册 chrome.proxy.settings.onChange；
        //   缺少该桩会让脚本一加载就抛 TypeError，整套用例连锁失败。
        onChange: { addListener: function (f) { listeners.onChange.push(f); } }
      },
      onProxyError: { addListener: function(){} }
    },
    action: {
      setIcon: function (o, cb) { iconCalls.push(o.path && o.path["16"]); setTimeout(function(){ if(cb) cb(); }, 0); },
      setTitle: function (o, cb) { titleCalls.push(o.title); setTimeout(function(){ if(cb) cb(); }, 0); }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(bgSrc, sandbox);
  return { sandbox: sandbox, syncStore: syncStore, sessionStore: sessionStore,
           setCalls: setCalls, listeners: listeners, iconCalls: iconCalls, titleCalls: titleCalls,
           getEffective: function () { return effective; } };
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

const BASE = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", bypassList: "x" };

function ask(handler, msg) {
  // 真实形态的 sender：R3-05 后 background 会校验 sender.id。
  return new Promise(function (r) { handler(msg, { id: SENDER_ID }, r); });
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

  // ---- R3-01：直连对比测试期间保存的新配置被静默丢弃 ----
  // 断言对象是【实际下发给 chrome.proxy 的配置】(env.getEffective)，
  // 而不是存储值 —— 存储值在这种缺陷下一直是正确的。
  console.log("");
  console.log("== R3-01: 对比测试期间保存的新端口，测试结束后必须真正下发到浏览器 ==");
  {
    const env = buildEnv({ fetchDelay: 200 });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(300);
    env.setCalls.length = 0;

    const handler = env.listeners.message[0];
    // 在第 2 次 fetch（取「直连出口」）进行中保存新端口：这正是被丢弃的窗口
    let n = 0;
    const origFetch = env.sandbox.fetch;
    env.sandbox.fetch = function () {
      n++;
      if (n === 2) {
        setTimeout(function () {
          env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "7777" }), function () {});
        }, 0);
      }
      return origFetch.apply(this, arguments);
    };

    await ask(handler, { action: "testConnection", compare: true });
    await sleep(400);

    t("测试期间保存 7777 后，存储中确实是 7777（前置条件）",
      env.syncStore.proxyPort === "7777", String(env.syncStore.proxyPort));
    t("测试期间保存 7777 后，浏览器实际生效的配置也是 7777",
      env.getEffective() === "127.0.0.1:7777",
      "实际生效 = " + env.getEffective() + "；setProxy 调用序列 = " + JSON.stringify(env.setCalls));
  }

  console.log("");
  console.log("== R3-01b: 对比测试期间【关闭代理】，测试结束后必须真的回到直连 ==");
  {
    const env = buildEnv({ fetchDelay: 200 });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(300);
    env.setCalls.length = 0;

    const handler = env.listeners.message[0];
    let n = 0;
    const origFetch = env.sandbox.fetch;
    env.sandbox.fetch = function () {
      n++;
      if (n === 2) {
        setTimeout(function () {
          env.sandbox.chrome.storage.sync.set({ enableProxy: false }, function () {});
        }, 0);
      }
      return origFetch.apply(this, arguments);
    };

    await ask(handler, { action: "testConnection", compare: true });
    await sleep(400);

    t("测试期间关闭代理后，存储中 enableProxy 为 false（前置条件）",
      env.syncStore.enableProxy === false, String(env.syncStore.enableProxy));
    t("测试期间关闭代理后，浏览器已不再走代理（不得被旧 backup 反向恢复）",
      env.getEffective() === null,
      "实际生效 = " + env.getEffective() + "（null 表示已直连）；setProxy 调用序列 = " + JSON.stringify(env.setCalls));
  }

  // ---- R3-04/R3-07：故障注入与状态链路（断言状态与图标，而非内部变量）----
  console.log("");
  console.log("== R3-04a: 控制权回读失败时，不得显示 applied 绿灯 ==");
  {
    const env = buildEnv({ getFails: true });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(300);

    var st = env.sessionStore.lastState || {};
    t("回读失败时状态不是 applied",
      st.status !== "applied",
      "lastState = " + JSON.stringify(st));
    t("回读失败时状态为 error 且有说明",
      st.status === "error" && !!st.message,
      "lastState = " + JSON.stringify(st));
    t("回读失败时图标不是绿色",
      env.iconCalls[env.iconCalls.length - 1] !== "icon-green-16.png",
      "最后图标 = " + env.iconCalls[env.iconCalls.length - 1]);
  }

  console.log("");
  console.log("== R3-04b: 关闭代理时 clear 失败，必须返回明确错误而不是假装成功 ==");
  {
    const env = buildEnv({ clearFails: true });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(250);
    env.sessionStore.lastState = undefined;

    env.sandbox.chrome.storage.sync.set({ enableProxy: false }, function () {});
    await sleep(300);

    var st2 = env.sessionStore.lastState || {};
    t("clear 失败时状态不是 direct（不得假装已直连）",
      st2.status !== "direct",
      "lastState = " + JSON.stringify(st2));
    t("clear 失败时状态为 error 且有说明",
      st2.status === "error" && !!st2.message,
      "lastState = " + JSON.stringify(st2));
    t("clear 失败时图标不是绿色",
      env.iconCalls[env.iconCalls.length - 1] !== "icon-green-16.png",
      "最后图标 = " + env.iconCalls[env.iconCalls.length - 1]);
  }

  console.log("");
  console.log("== R3-07: 测试暂停期间必须产生可观测的 suspended 状态与标题 ==");
  {
    const env = buildEnv({ fetchDelay: 250 });
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(250);
    env.sessionStore.lastState = undefined;
    env.titleCalls.length = 0;

    const handler = env.listeners.message[0];
    const p1 = ask(handler, { action: "testConnection", compare: true });
    // 暂停窗口 = 第 [1] 次 fetch 结束（约 +250ms）到第 [2] 次 fetch 结束（约 +500ms）。
    // 必须落在这个窗口内，否则 storage 变化会走正常下发而不是 suspended 分支。
    await sleep(320);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10810" }), function () {});
    await sleep(80);

    var during = env.sessionStore.lastState || {};
    t("暂停期间写入了 suspended 状态",
      during.status === "suspended",
      "暂停期间 lastState = " + JSON.stringify(during));
    t("暂停期间 setTitle 收到 suspended 文案（不是兜底的“代理设置”）",
      env.titleCalls.indexOf("代理设置") < 0 &&
      env.titleCalls.some(function (x) { return /暂缓下发/.test(String(x)); }),
      "setTitle 序列 = " + JSON.stringify(env.titleCalls));
    await p1;
  }

  console.log("");
  console.log("== R3-05: 非本扩展来源的消息必须被拒绝（不得触发下发）==");
  {
    const env = buildEnv({});
    await sleep(60);
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "10808" }), function () {});
    await sleep(250);
    env.setCalls.length = 0;

    const handler = env.listeners.message[0];
    const foreign = await new Promise(function (r) {
      handler({ action: "reapply" }, { id: "some-other-extension" }, r);
    });
    await sleep(200);

    t("外部来源的 reapply 被拒绝",
      !!(foreign && foreign.ok === false),
      "响应 = " + JSON.stringify(foreign));
    t("外部来源的消息没有触发任何下发",
      env.setCalls.length === 0,
      "setProxy 序列 = " + JSON.stringify(env.setCalls));

    const missing = await new Promise(function (r) { handler({ action: "reapply" }, {}, r); });
    t("缺失 sender 的消息被拒绝",
      !!(missing && missing.ok === false),
      "响应 = " + JSON.stringify(missing));

    const own = await new Promise(function (r) { handler({ action: "reapply" }, { id: SENDER_ID }, r); });
    t("本扩展自己的消息仍被正常处理",
      !!(own && own.ok === true),
      "响应 = " + JSON.stringify(own));
  }

  console.log("");
  console.log("== R3-03: 并发拒绝必须渲染成“已有测试在进行中”，不是“出口检测失败” ==");
  {
    // 直接执行 popup.js 的真实渲染函数片段，而不是复述它的逻辑。
    const popupSrc = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
    const p = { el: { testResult: {} }, console: { log: function () {} } };
    vm.createContext(p);
    vm.runInContext(
      popupSrc.slice(popupSrc.indexOf("function fmtExit"), popupSrc.indexOf("async function runTest")),
      p
    );

    p.renderTest({ ok: false, skipped: "in_flight", message: "已有测试在进行中，请稍候再试" });
    const html = p.el.testResult.innerHTML;
    t("并发拒绝渲染含“已有测试”提示", html.indexOf("已有测试") >= 0, html);
    t("并发拒绝不再渲染成“出口检测失败”", html.indexOf("出口检测失败") < 0, html);

    // 对照组：真正的出口失败仍必须显示网络故障文案，不能被这次修复顺手改掉。
    p.renderTest({ ok: true, exit: { ok: false, error: "timeout" } });
    const html2 = p.el.testResult.innerHTML;
    t("真正的出口失败仍显示“出口检测失败”（未被误改）",
      html2.indexOf("出口检测失败") >= 0, html2);

    p.renderTest({
      ok: true,
      compareSkipped: "control_changed_before_clear",
      exit: { ok: true, ip: "203.0.113.9" },
      direct: { ok: true, ip: "203.0.113.9" },
      ipChanged: false
    });
    const html3 = p.el.testResult.innerHTML;
    t("放弃清除时说明未清除当前代理", html3.indexOf("未清除当前代理") >= 0, html3);
    t("放弃清除时不渲染成出口相同", html3.indexOf("出口 IP 与直连相同") < 0, html3);

    p.renderTest({
      ok: true,
      compareSkipped: "unknown_control",
      exit: { ok: true, ip: "203.0.113.9" }
    });
    const html4 = p.el.testResult.innerHTML;
    t("控制权未知时说明已跳过对比", html4.indexOf("无法确认当前代理控制权") >= 0, html4);

    p.renderTest({
      ok: true,
      activeMode: "fixed_servers",
      exit: { ok: true, ip: "192.0.2.1" },
      direct: { ok: true, ip: "192.0.2.1" },
      ipChanged: false,
      settings: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" }
    });
    const html5 = p.el.testResult.innerHTML;
    t("配置仍在时，不说代理很可能未生效", html5.indexOf("很可能未生效") < 0, html5);
    t("配置仍在时，说明并未回退直连", html5.indexOf("并未回退直连") >= 0, html5);

    // R6-01：恢复失败时，前台绝不能落到"出口变了 → 代理确实生效"这条成功出口。
    //   真实故障时后端若把 restoreFailed 漏成 false（见 tests/ownership.test.js 的
    //   R6-01 用例），前台就会显示成功文案。这里守住前端这一层。
    p.renderTest({
      ok: true,
      restoreFailed: true,
      ipChanged: true,
      activeMode: "fixed_servers",
      exit: { ok: true, ip: "203.0.113.9" },
      direct: { ok: true, ip: "192.0.2.1" },
      settings: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" }
    });
    const html6 = p.el.testResult.innerHTML;
    t("恢复失败时不得渲染成功文案", html6.indexOf("代理确实生效") < 0, html6);
    t("恢复失败时不得渲染「并未回退直连」", html6.indexOf("并未回退直连") < 0, html6);
    t("恢复失败时渲染恢复失败文案", html6.indexOf("恢复原代理配置失败") >= 0, html6);
    t("恢复失败时判定为 error 档（不是 ok）", html6.indexOf("verdict error") >= 0, html6);
  }

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) { console.error("EXC: " + (e && e.stack || e)); process.exit(2); });
