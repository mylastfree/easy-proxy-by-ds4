// tests/ownership.test.js —— 所有权与竞态护栏（第四轮 R3-01 / R3-04 / R3-07）
// 运行：node tests/ownership.test.js
//
// 为什么单独成文件：这些用例针对的是【跨所有权的时序】——
//   对比测试的「清除 → 取直连出口 → 恢复」与普通下发之间的交错。
//   本项目 A1、N1、R3-01 三次缺陷的共同特征是「存储一直正确、浏览器实际失效」，
//   因此这里的所有断言对象都是【实际下发给 chrome.proxy 的配置】(effective)
//   或【取样时刻的真实状态】，绝不是内部变量，也不是存储值。
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
const bgPath = process.env.EASY_PROXY_BG || path.join(__dirname, '..', 'background.js');
const bgSrc = fs.readFileSync(bgPath, 'utf8');

const SENDER_ID = "test-extension-id";
const PROXY_IP = "203.0.113.9";
const DIRECT_IP = "192.0.2.1";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildEnv(opts) {
  opts = opts || {};
  const syncStore = {}, localStore = {}, sessionStore = {};
  const listeners = { changed: [], message: [], onChange: [] };
  const setCalls = [];       // setProxy 的发起序列
  const setConfigs = [];     // R7-01：每次下发给 chrome.proxy 的完整配置对象
  const clearCalls = [];     // clear 的作用域序列
  const timeline = [];       // 窗口内每次 set/clear 【完成】时刻的真实生效配置
  const fetchLog = [];       // 每次 fetch 时刻的 proxyActive
  const iconCalls = [], titleCalls = [];
  let windowOpen = false, proxyActive = false, effective = null, fetchCount = 0;
  const fetchDelay = opts.fetchDelay === undefined ? 80 : opts.fetchDelay;
  const slowPort = opts.slowPort || 0, slowMs = opts.slowMs || 0;
  let directPhaseSeen = false, restoreSetSeen = false;
  let onRestoreSet = null, onClearDuringDirect = null;
  let getHook = null, getCount = 0;
  // R7-01：存储读取故障注入（null = 不干预）。签名 (areaName, keys, items) => null | { error, items }
  let storageHook = null;
  // R6-04：模拟外部扩展 / 企业策略的控制等级（null 表示仍由本扩展控制）。
  let externalLevel = null;
  let setHook = null, clearHook = null;

  function makeArea(store, areaName) {
    return {
      get(keys, cb) {
        const out = {}; const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of ks) if (k in store) out[k] = store[k];
        setTimeout(() => {
          // R7-01：按真实 chrome.storage 的失败契约注入 —— 先置 runtime.lastError，
          //   再以空结果回调（items 可为 undefined，也可为 {}），回调返回后清除。
          //   不挂钩子时完全走原路径，既有用例的行为一字不变。
          const inj = storageHook ? storageHook(areaName, keys, out) : null;
          if (inj) {
            sandbox.chrome.runtime.lastError = inj.error || { message: "storage read failed (injected)" };
            cb(inj.items);
            sandbox.chrome.runtime.lastError = undefined;
            return;
          }
          cb(out);
        }, 0);
      },
      set(obj, cb) {
        if (areaName === "session" && obj && obj.lastState) stateWrites.push(obj.lastState);
        const changes = {};
        for (const k of Object.keys(obj)) {
          if (JSON.stringify(store[k]) !== JSON.stringify(obj[k])) changes[k] = { newValue: obj[k] };
          store[k] = obj[k];
        }
        setTimeout(() => {
          if (cb) cb();
          if (Object.keys(changes).length) for (const fn of listeners.changed.slice()) fn(changes, areaName);
        }, 0);
      }
    };
  }
  const stateWrites = [];   // session lastState 的每次写入（按写入顺序）
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    TextEncoder, setTimeout, clearTimeout, Date, Promise, Object, Array, JSON,
    Number, String, Math, Boolean, Error, AbortController
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.importScripts = () => vm.runInContext(settingsSrc, sandbox);
  sandbox.fetch = function () {
    fetchCount++; const n = fetchCount;
    return new Promise(resolve => setTimeout(() => {
      fetchLog.push({ n, proxyActive });
      resolve({ ok: true, json: () => Promise.resolve({ ip: proxyActive ? PROXY_IP : DIRECT_IP, org: "", city: "", region: "", country: "" }) });
    }, fetchDelay));
  };
  function record(v) { if (windowOpen) timeline.push(v); }
  // 把"真实 set 落地"的效果（proxyActive / effective / timeline）抽成一处，
  // 让默认路径与 setHook 注入路径共用同一份保真逻辑，避免两处漂移。
  function applyEffective(label) {
    // 传入字符串 = 代理已按该 label 挂上；传入 null = 没有挂上代理
    //   （真实 Chromium 里 mode:"direct" 的 set 不会挂上代理）。
    proxyActive = label !== null;
    effective = proxyActive ? label : null;
    record(effective);
  }
  function defaultGet(o, cb) {
    // 忠实还原：真实生效配置就是 effective；直连时 mode 为 "direct"
    const value = effective !== null
      ? { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: effective.split(":")[0], port: effective.split(":")[1] } } }
      : { mode: "direct" };
    // externalLevel 非空时优先返回它：模拟外部接管或外部释放控制权（R6-04）。
    const level = externalLevel || "controlled_by_this_extension";
    setTimeout(() => cb({ value, levelOfControl: level }), 0);
  }
  sandbox.chrome = {
    runtime: { lastError: undefined, id: SENDER_ID,
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener(f) { listeners.message.push(f); } } },
    storage: { sync: makeArea(syncStore, "sync"), local: makeArea(localStore, "local"),
      session: makeArea(sessionStore, "session"), onChanged: { addListener(f) { listeners.changed.push(f); } } },
    proxy: {
      settings: {
        set(o, cb) {
          // R7-01：记录真实下发给 chrome.proxy 的【完整配置对象】（不只 host:port）——
          //   绕过列表有没有被静默清空，只能从这份配置里看出来。
          setConfigs.push(o && o.value);
          if (setHook) return setHook(o, cb, sandbox);
          const sp = (o.value && o.value.rules && o.value.rules.singleProxy) || {};
          const label = (sp.host === undefined ? "?" : sp.host) + ":" + (sp.port === undefined ? "?" : sp.port);
          setCalls.push(label);
          if (directPhaseSeen && !restoreSetSeen) { restoreSetSeen = true; if (onRestoreSet) setTimeout(() => onRestoreSet(sandbox), 0); }
          const delay = (Number(sp.port) === slowPort) ? slowMs : 0;
          setTimeout(() => {
            // 关键保真：mode:"direct" 的 set 不会挂上代理（Chromium 语义）
            applyEffective((o.value && o.value.mode === "direct") ? null : label);
            sandbox.chrome.runtime.lastError = undefined;
            if (cb) cb();
          }, delay);
        },
        clear(o, cb) {
          if (clearHook) return clearHook(o, cb, sandbox);
          // 只有 regular 作用域才代表"代理被真正清掉并进入直连取样"。
          // 遗留作用域（regular_only 等）的清理不属于直连阶段，不能用来置位标记，
          // 否则窗口内的 regular clear 会被误判为"已经过了直连阶段"而漏掉注入点。
          clearCalls.push(o.scope);
          const isRegular = o.scope === "regular";
          if (isRegular && onClearDuringDirect && !directPhaseSeen) setTimeout(() => onClearDuringDirect(sandbox), 0);
          setTimeout(() => {
            if (isRegular) { proxyActive = false; effective = null; }
            record(effective);
            if (isRegular) directPhaseSeen = true;
            sandbox.chrome.runtime.lastError = undefined;
            if (cb) cb();
          }, 0);
        },
        get(o, cb) { getCount++; if (getHook) return getHook(getCount, o, cb, defaultGet); return defaultGet(o, cb); },
        // R6-04：background.js 会注册 chrome.proxy.settings.onChange；
        //   缺少该桩会让脚本一加载就抛 TypeError，整套用例连锁失败。
        onChange: { addListener(f) { listeners.onChange.push(f); } }
      },
      onProxyError: { addListener() {} }
    },
    action: {
      setIcon(o, cb) { iconCalls.push(o.path && o.path["16"]); setTimeout(() => cb && cb(), 0); },
      setTitle(o, cb) { titleCalls.push(o.title); setTimeout(() => cb && cb(), 0); }
    }
  };
  // 供 setHook 注入路径复用的"真实落地"函数（见上 applyEffective）。
  sandbox.chrome.proxy.settings._apply = applyEffective;

  vm.createContext(sandbox);
  vm.runInContext(bgSrc, sandbox);
  return { sandbox, syncStore, localStore, sessionStore, stateWrites, setCalls, setConfigs, clearCalls, timeline, fetchLog, listeners, iconCalls, titleCalls,
    getEffective: () => effective, isProxyActive: () => proxyActive,
    openWindow: () => { windowOpen = true; }, closeWindow: () => { windowOpen = false; },
    onRestoreSet: fn => { onRestoreSet = fn; },
    onClearDuringDirect: fn => { onClearDuringDirect = fn; },
    // 脚本加载时的"未启用"冷启动会 clear 一次 regular，不能让它算作"已经进入过直连阶段"
    resetDirect: () => { directPhaseSeen = false; },
    setGetHook: fn => { getHook = fn; getCount = 0; },
    setSetHook: fn => { setHook = fn; },
    // R7-01：注入存储读取失败（真实契约：置 lastError 后回调空结果）。
    setStorageHook: fn => { storageHook = fn; },
    setClearHook: fn => { clearHook = fn; },
    // R6-04：驱动 chrome.proxy.settings.onChange 的真实回调（外部接管 / 释放）。
    fireProxyChange: details => { for (const fn of listeners.onChange.slice()) fn(details); },
    // 模拟外部接管或释放：只改控制等级与实际生效配置，不经过我方任何写路径。
    externalSet: (level, host, port) => {
      effective = host === null ? null : host + ":" + port;
      proxyActive = host !== null;
      externalLevel = level;
    } };
}

// 排空串行队列：background 的 applyChain 挂在 VM 全局上
async function drain(env) {
  let prevLen = -1, prevChain = null;
  for (let i = 0; i < 80; i++) {
    const p = env.sandbox.applyChain;
    if (p && typeof p.then === "function") { try { await p; } catch (e) {} }
    await sleep(4);
    if (i > 4 && env.setCalls.length === prevLen && env.sandbox.applyChain === prevChain) break;
    prevLen = env.setCalls.length; prevChain = env.sandbox.applyChain;
  }
  await sleep(25);
}

const BASE = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", bypassList: "x" };
function setSync(env, obj) { return new Promise(r => env.sandbox.chrome.storage.sync.set(obj, r)); }
function ask(env, msg) {
  const h = env.listeners.message[0];
  return new Promise(r => h(msg, { id: SENDER_ID }, r));
}
async function ready(env, port) {
  await drain(env);
  await setSync(env, Object.assign({}, BASE, { proxyPort: port }));
  await drain(env);
  env.setCalls.length = 0; env.timeline.length = 0; env.fetchLog.length = 0;
  env.iconCalls.length = 0; env.titleCalls.length = 0;
  env.resetDirect();
  env.openWindow();
}

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

(async function main() {
  console.log("== R3-01-R0：对比期间的保存必须最终生效（不依赖注入钩子，纯时序）==");
  {
    // 不挂任何钩子：让旧配置 10808 的写回很慢，在对比窗口内保存 7777。
    // 修复前的行为：窗口收尾写回旧 backup(10808) → 7777 被反向覆盖，最终实际是 10808。
    // 修复后的行为：窗口收尾按【最新 settings】提交 → 最终实际是 7777。
    const env = buildEnv({ fetchDelay: 150, slowPort: 10808, slowMs: 400 });
    await ready(env, "10808");
    const p = ask(env, { action: "testConnection", compare: true });
    await sleep(120);
    await setSync(env, Object.assign({}, BASE, { proxyPort: "7777" }));
    await p;
    await sleep(900); env.closeWindow();

    t("存储中是新端口 7777（前置条件）", env.syncStore.proxyPort === "7777", String(env.syncStore.proxyPort));
    t("浏览器最终实际生效的是最新端口 7777（旧配置不得反向覆盖）",
      env.getEffective() === "127.0.0.1:7777",
      "实际 = " + env.getEffective() + "；set 序列 = " + JSON.stringify(env.setCalls));
  }

  console.log("");
  console.log("== R3-01-R1：恢复窗口【在途】时保存新端口 → 结束实际配置必须是新端口 ==");
  {
    // slowPort 让旧配置 10808 的写回变慢，制造"恢复窗口内新值先落地"的交错
    const env = buildEnv({ fetchDelay: 80, slowPort: 10808, slowMs: 250 });
    await ready(env, "10808");
    // 对比窗口已经打开（代理已被清除、暂停标记生效）时，用户保存 7777。
    // 这正是 R3-01 的反例窗口：旧实现会用旧 backup 把 7777 反向覆盖。
    env.onClearDuringDirect(sb => { sb.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "7777" }), () => {}); });
    await ask(env, { action: "testConnection", compare: true });
    await sleep(800); env.closeWindow();

    t("存储中是新端口 7777（前置条件）", env.syncStore.proxyPort === "7777", String(env.syncStore.proxyPort));
    t("浏览器最终实际生效的也是 7777（不得被旧配置反向覆盖）",
      env.getEffective() === "127.0.0.1:7777",
      "实际 = " + env.getEffective() + "；set 序列 = " + JSON.stringify(env.setCalls));
    const st = env.sessionStore.lastState || {};
    t("结束状态与实际情况一致（applied 且实际确实是 7777）",
      st.status === "applied" && env.getEffective() === "127.0.0.1:7777",
      "lastState = " + JSON.stringify(st));
  }

  console.log("");
  console.log("== R3-01-R2：对比窗口内关闭代理 → 结束实际必须是直连 ==");
  {
    const env = buildEnv({ fetchDelay: 120 });
    await ready(env, "10808");
    env.onClearDuringDirect(sb => { sb.chrome.storage.sync.set({ enableProxy: false }, () => {}); });
    await ask(env, { action: "testConnection", compare: true });
    await sleep(800); env.closeWindow();

    t("存储中 enableProxy 为 false（前置条件）", env.syncStore.enableProxy === false, String(env.syncStore.enableProxy));
    t("浏览器最终确实回到直连（不得被旧 backup 恢复）",
      env.getEffective() === null,
      "实际 = " + env.getEffective() + "；set 序列 = " + JSON.stringify(env.setCalls));
    const st = env.sessionStore.lastState || {};
    t("结束状态为 direct（与实际一致）", st.status === "direct", "lastState = " + JSON.stringify(st));
  }

  console.log("");
  console.log("== R3-01-R3：下发【在途】时启动对比 → 直连取样不得被污染，且不得回退旧值 ==");
  {
    const env = buildEnv({ fetchDelay: 100, slowPort: 9000, slowMs: 200 });
    await ready(env, "10808");
    env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "9000" }), () => {});
    // 等 9000 的 set 真正发起（仍在途，200ms 未完成）后立刻启动对比
    const t0 = Date.now();
    while (env.setCalls.indexOf("127.0.0.1:9000") < 0 && Date.now() - t0 < 1500) await sleep(2);
    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(800); env.closeWindow();

    t("取直连出口时代理确实处于清除状态（未被在途下发污染）",
      env.fetchLog.length >= 2 ? env.fetchLog[1].proxyActive === false : false,
      "fetchLog = " + JSON.stringify(env.fetchLog));
    const directIp = resp && resp.result && resp.result.direct && resp.result.direct.ip;
    t("直连出口是真实直连 IP（未被污染）", directIp === DIRECT_IP, "实际 = " + directIp);
    t("ipChanged 判定为 true（不再误报代理未生效）",
      resp && resp.result && resp.result.ipChanged === true,
      "ipChanged = " + (resp && resp.result && resp.result.ipChanged));
    t("浏览器最终实际生效的是最新端口 9000（不得回退到 10808）",
      env.getEffective() === "127.0.0.1:9000",
      "实际 = " + env.getEffective() + "；set 序列 = " + JSON.stringify(env.setCalls));
  }

  console.log("");
  console.log("== R3-01-R4：外部接管时不得夺权，但也不得丢弃待下发的配置 ==");
  {
    const env = buildEnv({ fetchDelay: 120 });
    await ready(env, "10808");
    env.setGetHook((n, o, cb, dflt) => {
      // n=1 before；n=2 清除前复核（仍由我方控制，允许清除）；
      // n>=3 收尾复核（此时已被外部接管）
      if (n <= 2) return dflt(o, cb);
      setTimeout(() => cb({
        value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } },
        levelOfControl: "controlled_by_other_extensions"
      }), 0);
    });
    env.onClearDuringDirect(sb => {
      sb.chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } } }, () => {});
      sb.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "7777" }), () => {});
    });
    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(1200); env.closeWindow();

    t("检测到外部接管并如实标记",
      !!(resp && resp.result && resp.result.overriddenDuringTest),
      JSON.stringify(resp && resp.result && resp.result.overriddenDuringTest));
    t("接管期间没有发生我方夺权式写回（外部配置仍在）",
      env.setCalls.indexOf("127.0.0.1:10808") < 0 && env.getEffective() === "external:9090",
      "set 序列 = " + JSON.stringify(env.setCalls) + "；实际 = " + env.getEffective());
    t("用户保存的新配置没有被吞掉（存储仍为 7777，未被回退）",
      env.syncStore.proxyPort === "7777", String(env.syncStore.proxyPort));
    t("接管期间我方没有再把 7777 写下去夺权（外部配置仍生效）",
      env.getEffective() === "external:9090" && env.setCalls.indexOf("127.0.0.1:7777") < 0,
      "实际 = " + env.getEffective() + "；set 序列 = " + JSON.stringify(env.setCalls));
    t("接管时如实标记仍有待下发的配置",
      resp && resp.result && resp.result.pendingResubmit === true,
      "pendingResubmit=" + (resp && resp.result && resp.result.pendingResubmit));
  }

  console.log("");
  console.log("== R3-04-R1：回读结果缺 levelOfControl 时不得判 applied（失败开放）==");
  {
    const env = buildEnv({ fetchDelay: 40 });
    await ready(env, "10808");
    env.setGetHook((n, o, cb) => { setTimeout(() => cb({ value: { mode: "fixed_servers" } }), 0); });
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10811" }));
    await sleep(400); env.closeWindow();
    const st = env.sessionStore.lastState || {};
    t("缺少 levelOfControl 时不判 applied", st.status !== "applied", "lastState = " + JSON.stringify(st));
    t("缺少 levelOfControl 时判 error 且有说明",
      st.status === "error" && !!st.message, "lastState = " + JSON.stringify(st));
    t("缺少 levelOfControl 时图标不是绿色",
      env.iconCalls[env.iconCalls.length - 1] !== "icon-green-16.png",
      "最后图标 = " + env.iconCalls[env.iconCalls.length - 1]);
  }

  console.log("");
  console.log("== R3-04-R2：收尾时回读失败 → 不得写回（控制权未知即拒绝）==");
  {
    const env = buildEnv({ fetchDelay: 60 });
    await ready(env, "10808");
    env.setGetHook((n, o, cb, dflt) => {
      if (n === 1) return dflt(o, cb);
      setTimeout(() => { env.sandbox.chrome.runtime.lastError = { message: "get failed (injected)" }; cb(undefined); env.sandbox.chrome.runtime.lastError = undefined; }, 0);
    });
    env.onClearDuringDirect(sb => {
      sb.chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } } }, () => {});
    });
    await ask(env, { action: "testConnection", compare: true });
    await sleep(600); env.closeWindow();
    t("收尾回读失败时没有任何我方写回（set 序列里只有外部那一次）",
      env.setCalls.indexOf("127.0.0.1:10808") < 0 && env.setCalls.indexOf("?:?") < 0,
      "set 序列 = " + JSON.stringify(env.setCalls));
    t("收尾回读失败时状态如实反映无法确认控制权",
      (env.sessionStore.lastState || {}).status !== "applied",
      "lastState = " + JSON.stringify(env.sessionStore.lastState));
  }

  console.log("");
  console.log("== R3-04-R3：对比窗口内【清除之前】发生接管 → 不得执行破坏性清除（TOCTOU）==");
  {
    const env = buildEnv({ fetchDelay: 80 });
    await ready(env, "10808");
    env.setGetHook((n, o, cb, dflt) => {
      if (n === 1) {
        dflt(o, cb);
        // 在 before 回读完成之后、我方 clear 之前，外部接管
        setTimeout(() => { env.sandbox.chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } } }, () => {}); }, 1);
        return;
      }
      setTimeout(() => cb({
        value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } },
        levelOfControl: "controlled_by_other_extensions"
      }), 0);
    });
    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(600); env.closeWindow();
    t("检测到清除前控制权已变更并放弃对比",
      !!(resp && resp.result && resp.result.compareSkipped === "control_changed_before_clear"),
      "compareSkipped = " + (resp && resp.result && resp.result.compareSkipped));
    t("没有执行破坏性清除（外部配置仍在生效）",
      env.getEffective() === "external:9090",
      "实际 = " + env.getEffective() + "；timeline = " + JSON.stringify(env.timeline));
  }

  console.log("");
  console.log("== R3-07-R1：恢复后实际配置与状态必须一致（backup 为 direct 的真实机制）==");
  {
    const env = buildEnv({ fetchDelay: 60 });
    await ready(env, "10808");
    env.setGetHook((n, o, cb, dflt) => {
      if (n === 1) { setTimeout(() => cb({ value: { mode: "direct" }, levelOfControl: "controlled_by_this_extension" }), 0); return; }
      dflt(o, cb);
    });
    await ask(env, { action: "testConnection", compare: true });
    await sleep(600); env.closeWindow();
    const st = env.sessionStore.lastState || {};
    t("测试结束后实际确实挂着代理（不得是直连）",
      env.getEffective() === "127.0.0.1:10808",
      "实际 = " + env.getEffective() + "；set 序列 = " + JSON.stringify(env.setCalls));
    t("状态 applied 与实际生效一致（不存在\"绿着但直连\"）",
      !(st.status === "applied" && env.getEffective() === null),
      "lastState = " + JSON.stringify(st) + "；实际 = " + env.getEffective());
  }

  console.log("");
  console.log("== R3-07-R3：set 回调成功但实际模式不符时，不得判 applied（落实校验）==");
  {
    // 构造：我方下发的是 fixed_servers，但回读到的实际 mode 仍是 direct
    //   （对应真实场景：set 回调成功、配置却没有真正挂上）。
    //   若无落实校验，状态会写成 applied —— 界面"已生效"而实际在直连。
    const env = buildEnv({ fetchDelay: 40 });
    await ready(env, "10808");
    env.setGetHook((n, o, cb) => {
      setTimeout(() => cb({ value: { mode: "direct" }, levelOfControl: "controlled_by_this_extension" }), 0);
    });
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10812" }));
    await sleep(500); env.closeWindow();
    const st = env.sessionStore.lastState || {};
    t("下发后实际模式不符时不判 applied", st.status !== "applied", "lastState = " + JSON.stringify(st));
    t("下发后实际模式不符时判 error 并说明原因",
      st.status === "error" && /模式/.test(String(st.message || "")),
      "lastState = " + JSON.stringify(st));
    t("下发后实际模式不符时图标不是绿色",
      env.iconCalls[env.iconCalls.length - 1] !== "icon-green-16.png",
      "最后图标 = " + env.iconCalls[env.iconCalls.length - 1]);
  }

  console.log("");
  console.log("== R3-07-R2：窗口开始时应主动产生可观测的进行中状态 ==");
  {
    // fetchDelay 决定窗口长度：窗口 = before 回读(readSettings+get) + 第一次出口取样，
    //   因此取样时刻必须晚于第一次 fetch 开始、早于窗口收尾。
    const env = buildEnv({ fetchDelay: 400 });
    await ready(env, "10808");
    env.sessionStore.lastState = undefined;
    env.titleCalls.length = 0;
    const p1 = ask(env, { action: "testConnection", compare: true });
    await sleep(600);
    const during = env.sessionStore.lastState || {};
    t("测试进行中写入了可观测的进行中状态",
      during.status === "suspended", "进行中 lastState = " + JSON.stringify(during));
    t("测试进行中标题不是兜底的「代理设置」",
      env.titleCalls.indexOf("代理设置") < 0,
      "setTitle 序列 = " + JSON.stringify(env.titleCalls));
    await p1;
  }

  console.log("");
  console.log("== R6-04：外部接管与外部释放后，状态必须被刷新（只读回查）==");
  {
    // 方向一：外部接管。本扩展自身【没有任何存储变化】，只发生代理设置变化。
    //   缺陷链路（02 探针-H）：全文件未注册 onChange → getStatus 一直返回过时的 applied。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    const before = env.sessionStore.lastState || {};
    t("前置：接管前状态为 applied", before.status === "applied", JSON.stringify(before));

    env.externalSet("controlled_by_other_extensions", "external", "9090");
    env.fireProxyChange({ levelOfControl: "controlled_by_other_extensions" });
    await drain(env);

    const after = env.sessionStore.lastState || {};
    t("外部接管后状态被刷新为 overridden（不再停留在 applied）",
      after.status === "overridden",
      "lastState=" + JSON.stringify(after));
    t("外部接管后没有发生我方夺权式写回",
      env.setCalls.indexOf("127.0.0.1:10808") < 0,
      "set 序列=" + JSON.stringify(env.setCalls));
    // 通道④：前台状态条与图标都由 writeState/updateIcon 驱动，图标必须转红。
    t("外部接管后末次图标为红色（通道④）",
      env.iconCalls[env.iconCalls.length - 1] === "icon-red-16.png",
      "icon=" + env.iconCalls[env.iconCalls.length - 1]);
    // 通道② 反向护栏：没有脏标记时不得声称"有配置变更待下发"。
    t("外部接管但无待下发变更时不得误报 pendingResubmit（通道②）",
      after.pendingResubmit !== true, "lastState=" + JSON.stringify(after));
  }
  {
    // 通道②/④：接管【期间】用户改过配置（脏标记在位）→ 状态必须如实保留该标记，
    //   否则前台（popup.js:89）看不到「有配置变更待下发」，与 R3-01 静默丢弃同型。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.sandbox.suspendDirty = true;
    env.externalSet("controlled_by_other_extensions", "external", "9090");
    env.fireProxyChange({ levelOfControl: "controlled_by_other_extensions" });
    await drain(env);

    const st = env.sessionStore.lastState || {};
    t("外部接管时状态为 overridden（构造前置事实）",
      st.status === "overridden", "lastState=" + JSON.stringify(st));
    t("接管期间确有未下发变更时，状态必须保留待下发标记（通道②/④）",
      st.pendingResubmit === true, "lastState=" + JSON.stringify(st));
  }
  {
    // 方向二：外部释放（02 探针-J，比接管更危险：界面说 applied 而实际直连）。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.externalSet("controlled_by_other_extensions", "external", "9090");
    env.fireProxyChange({ levelOfControl: "controlled_by_other_extensions" });
    await drain(env);
    t("前置：外部接管已被如实记录",
      (env.sessionStore.lastState || {}).status === "overridden",
      "lastState=" + JSON.stringify(env.sessionStore.lastState));

    // 外部释放：配置回到直连，控制权回到无人控制
    env.externalSet("controllable_by_this_extension", null, null);
    env.fireProxyChange({ levelOfControl: "controllable_by_this_extension" });
    await drain(env);

    const st = env.sessionStore.lastState || {};
    t("外部释放后不得继续宣称 applied（实际已是直连）",
      st.status !== "applied", "lastState=" + JSON.stringify(st));
    // R3-07 同型：我方启用着代理而实际是直连时，结论必须是「异常」而不是「直连」——
    //   后者会告诉用户"你没启用代理"，而用户明明是启用的。
    t("外部释放后如实报异常并说明我方配置未生效",
      st.status === "error" && typeof st.message === "string" && st.message.length > 0,
      "lastState=" + JSON.stringify(st));
    t("外部释放后不得发生我方写回（释放不等于邀请夺权）",
      env.setCalls.indexOf("127.0.0.1:10808") < 0,
      "set 序列=" + JSON.stringify(env.setCalls));
    t("外部释放后末次图标为红色（通道④：绝不留下绿色）",
      env.iconCalls[env.iconCalls.length - 1] === "icon-red-16.png",
      "icon=" + env.iconCalls[env.iconCalls.length - 1]);
  }
  {
    // 方向二·加固：无人控制，但生效的是【别人的 fixed_servers】。
    //   只看 mode === "fixed_servers" 就写 applied，会让界面宣称"本扩展的代理已生效"，
    //   而真正生效的是别人的 host/port —— 与 R6-04 同类的新可见性错误。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.externalSet("controllable_by_this_extension", "someone-else", "7777");
    env.fireProxyChange({ levelOfControl: "controllable_by_this_extension" });
    await drain(env);

    const st = env.sessionStore.lastState || {};
    t("无人控制但生效配置非我方时，不得宣称 applied",
      st.status !== "applied", "lastState=" + JSON.stringify(st));
    t("该情形下状态如实说明配置不是本扩展下发的",
      st.status === "error" && /不是本扩展下发/.test(String(st.message || "")),
      "lastState=" + JSON.stringify(st));
  }
  {
    // 方向二·加固之二：我方【未启用】代理，但外部下发了 fixed_servers 后释放控制权。
    //   此时生效的仍是别人的配置，界面若报 direct（"未启用代理（直连）"）同样是错的。
    const env = buildEnv({ fetchDelay: 20 });
    await drain(env);
    env.externalSet("controllable_by_this_extension", "someone-else", "7777");
    env.fireProxyChange({ levelOfControl: "controllable_by_this_extension" });
    await drain(env);

    const st = env.sessionStore.lastState || {};
    t("未启用代理但存在非我方下发的代理配置时，不得报 direct",
      st.status !== "direct", "lastState=" + JSON.stringify(st));
    t("该情形下状态如实说明存在非本扩展下发的配置",
      st.status === "error" && /非本扩展下发/.test(String(st.message || "")),
      "lastState=" + JSON.stringify(st));
  }
  {
    // 自触发抑制（R6-04）：我方一次成功的下发本身就会触发 onChange，
    //   不得因此被自己的事件再回查、再写一遍状态。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10101" }));
    await drain(env);
    const afterWrite = JSON.stringify(env.sessionStore.lastState || {});
    t("前置：我方下发成功后状态为 applied",
      (env.sessionStore.lastState || {}).status === "applied",
      "lastState=" + afterWrite);

    // 模拟 Chrome 为我方这次 set 派发的回声（值与刚下发的完全一致）
    env.fireProxyChange({ levelOfControl: "controlled_by_this_extension" });
    await drain(env);
    t("我方自己的写操作回声不被重复回查（状态未被二次改写）",
      JSON.stringify(env.sessionStore.lastState || {}) === afterWrite,
      "改动后=" + JSON.stringify(env.sessionStore.lastState) + " / 原值=" + afterWrite);
  }

  console.log("");
  console.log("== R5-01：入口与窗口使用同一个控制权谓词 ==");
  {
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.clearCalls.length = 0;
    env.setGetHook((n, o, cb, dflt) => {
      if (n === 1) {
        setTimeout(() => cb({ value: { mode: "fixed_servers" } }), 0);
        return;
      }
      return dflt(o, cb);
    });
    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(200);
    const skipped = resp && resp.result && resp.result.compareSkipped;
    t("缺 levelOfControl 时不进入对比",
      skipped === "unknown_control", "compareSkipped=" + skipped);
    t("缺 levelOfControl 时不清除 regular",
      env.clearCalls.indexOf("regular") < 0,
      "clears=" + JSON.stringify(env.clearCalls));
  }
  {
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.setGetHook((n, o, cb, dflt) => {
      setTimeout(() => cb({
        value: { mode: "direct" },
        levelOfControl: "controllable_by_this_extension"
      }), 0);
    });
    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(200);
    const skipped = resp && resp.result && resp.result.compareSkipped;
    t("无人控制但可由本扩展接管时，入口不再拒绝",
      skipped !== "not_controlled_by_this_extension",
      "compareSkipped=" + skipped);
  }

  console.log("");
  console.log("== R5-02：出口相同不得把仍生效的代理显示成异常 ==");
  {
    const env = buildEnv({ fetchDelay: 30 });
    await ready(env, "10808");
    env.sandbox.fetch = function () {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ip: "192.0.2.1", org: "", city: "", region: "", country: "" })
      });
    };
    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(200);
    const st = env.sessionStore.lastState || {};
    t("两次出口相同时，生效配置仍是原代理",
      env.getEffective() === "127.0.0.1:10808",
      "effective=" + env.getEffective());
    t("两次出口相同时，状态不是 error",
      st.status === "applied", JSON.stringify(st));
    t("两次出口相同时，最后一档图标仍是绿色",
      env.iconCalls[env.iconCalls.length - 1] === "icon-green-16.png",
      "icon=" + env.iconCalls[env.iconCalls.length - 1]);
    t("测试结果仍记录出口未变化",
      resp && resp.result && resp.result.ipChanged === false);
  }

  console.log("");
  console.log("== R5-04：收尾提交失败后，脏标记不能一直留着 ==");
  {
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    let calls = 0;
    const orig = env.sandbox.applyProxyCore;
    env.sandbox.applyProxyCore = async function () {
      calls++;
      if (calls === 1) throw new Error("injected restore fail");
      return orig.apply(this, arguments);
    };
    env.onClearDuringDirect(sb => {
      sb.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "6666" }), () => {});
    });
    const resp = await ask(env, { action: "testConnection", compare: true });
    await drain(env);
    t("第一次提交失败被记入测试结果",
      resp && resp.result && resp.result.restoreFailed === true);
    t("暂停已结束", env.sandbox.suspendDepth === 0, "depth=" + env.sandbox.suspendDepth);
    t("后续成功下发清掉脏标记",
      env.sandbox.suspendDirty === false, "dirty=" + env.sandbox.suspendDirty);
    t("最终生效的是失败期间保存的 6666",
      env.getEffective() === "127.0.0.1:6666",
      "effective=" + env.getEffective());
  }

  console.log("");
  console.log("== R6-01：收尾遇到真实 callback lastError 时必须识别为恢复失败 ==");
  {
    // 关键：注入的是【真实 Chrome 的失败契约】—— callback 置 lastError 后回调，
    //   而不是 throw。setProxy 会因此 reject，applyProxyCore 会 catch 并【返回】
    //   {ok:false,status:"error"}。收尾若只看 throw，就会把这次失败当成成功。
    const env = buildEnv({ fetchDelay: 40 });
    await ready(env, "10808");

    let setCount = 0;
    env.setSetHook(function (o, cb, sb) {
      setCount++;
      const sp = (o.value && o.value.rules && o.value.rules.singleProxy) || {};
      const label = (sp.host === undefined ? "?" : sp.host) + ":" + (sp.port === undefined ? "?" : sp.port);
      env.setCalls.push(label);
      // 【计数必须从 1 开始数】ready() 已经把冷启动与 10808 的下发跑完、
      //   并清空了 setCalls；窗口内第一次 set 就是收尾提交那一次（清除走的是 clear）。
      //   若写成 2，钩子永远不注入失败，用例会假绿。
      //
      // 【为什么是 >= 1 而不是 === 1】真实场景里 set 失败通常是持续性的
      //   （代理软件没起、端口被占用、被策略阻断），不是"只失败一次"：
      //   收尾失败后第四步还会兜底重放一次，重放同样会失败。若只让收尾那一次失败，
      //   重放成功就会把脏标记清掉，"恢复未完成不得清脏"这条断言就被测空了。
      if (setCount >= 1) {
        setTimeout(function () {
          sb.chrome.runtime.lastError = { message: "set failed (real contract)" };
          cb();
          sb.chrome.runtime.lastError = undefined;
        }, 0);
        return;
      }
      setTimeout(function () {
        sb.chrome.proxy.settings._apply(label);
        sb.chrome.runtime.lastError = undefined;
        cb();
      }, 0);
    });

    // 【构造补强】窗口开启后、收尾提交之前保存一次新端口：该请求在暂停期被挡下 → 记脏。
    //   没有这一步，脏标记在窗口开启前必然是 false（窗口开启即 suspendDepth++，
    //   被挡下的请求只可能来自窗口内部），"不得清空脏标记"这条断言就永远测不到东西。
    env.onClearDuringDirect(sb => {
      sb.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "6666" }), () => {});
    });

    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(400); env.closeWindow();

    t("收尾真实 set 失败被记入测试结果（restoreFailed 为 true）",
      resp && resp.result && resp.result.restoreFailed === true,
      "restoreFailed=" + (resp && resp.result && resp.result.restoreFailed) +
      "；set 序列=" + JSON.stringify(env.setCalls));
    t("收尾真实 set 失败时不得清空脏标记（否则兜底重放恒不可达）",
      env.sandbox.suspendDirty === true,
      "dirty=" + env.sandbox.suspendDirty + "；set 序列=" + JSON.stringify(env.setCalls));
    t("收尾真实 set 失败时实际配置确实没有挂上代理（前置事实）",
      env.getEffective() !== "127.0.0.1:10808",
      "实际=" + env.getEffective());
    const st = env.sessionStore.lastState || {};
    t("收尾真实 set 失败时状态与事实一致（不是 applied）",
      st.status !== "applied", "lastState=" + JSON.stringify(st));
    // R6-01 验收通道③：状态不仅要"不是 applied"，还必须带上非空的失败原因，
    //   否则用户看到"代理异常"却无从知道原因。
    t("收尾真实 set 失败时状态附有非空失败原因",
      typeof st.message === "string" && st.message.length > 0,
      "lastState=" + JSON.stringify(st));
    // R6-01 验收通道④：末次图标必须是红色，绝不能在这条失败路径上留下绿色。
    t("收尾真实 set 失败时末次图标为红色（不是绿色）",
      env.iconCalls[env.iconCalls.length - 1] === "icon-red-16.png",
      "icon=" + env.iconCalls[env.iconCalls.length - 1]);
  }

  console.log("");
  console.log("== R6-03：普通成功下发必须消费脏标记，不得跨窗口遗留 ==");
  {
    const env = buildEnv({ fetchDelay: 20 });
    await drain(env);
    // 制造一个真实的遗留脏标记：直接置位（其可产生性由 02 探针-G3 证明，
    //   本用例只验证"消费"这一环）。
    env.sandbox.suspendDirty = true;

    await setSync(env, Object.assign({}, BASE, { proxyPort: "5555" }));
    await drain(env);

    t("下发确实成功（前置事实）",
      env.getEffective() === "127.0.0.1:5555", "实际=" + env.getEffective());
    t("普通成功下发后必须清掉脏标记（否则跨窗口误报待下发）",
      env.sandbox.suspendDirty === false,
      "dirty=" + env.sandbox.suspendDirty + "；lastState=" + JSON.stringify(env.sessionStore.lastState));
    const st = env.sessionStore.lastState || {};
    t("普通成功下发后状态为 applied（前置事实）", st.status === "applied", JSON.stringify(st));
  }

  {
    // 场景：我方已被外部接管，此时普通下发走 overridden 早退分支。
    //   若该分支写状态时不带 pendingResubmit，会把窗口写下的"有变更待下发"覆盖掉。
    const env = buildEnv({ fetchDelay: 20 });
    await drain(env);
    env.setGetHook((n, o, cb) => {
      setTimeout(() => cb({
        value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } },
        levelOfControl: "controlled_by_other_extensions"
      }), 0);
    });
    env.sandbox.suspendDirty = true;
    await setSync(env, Object.assign({}, BASE, { proxyPort: "4444" }));
    await drain(env);

    const st = env.sessionStore.lastState || {};
    t("外部接管时状态为 overridden（前置事实）",
      st.status === "overridden", JSON.stringify(st));
    t("被接管时不得把待下发标记从状态里抹掉",
      st.pendingResubmit === true,
      "lastState=" + JSON.stringify(st));
  }

  console.log("");
  console.log("== R6-03 fix-round-1：清除前接管路径也必须保留待下发标记 ==");
  {
    // 场景：【清除前接管】早退分支（runCompareWindow 第一步的控制权复核）。
    //   背景（评审 I-1）：该分支写下的 status:"overridden" 是唯一【不带】
    //   pendingResubmit 的一处，会覆盖窗口期间记下的「有配置变更待下发」，
    //   前台（popup.js:89）因此看不到提示 —— 与 R6-03 / R3-01 同型，只是路径更窄。
    //   命中该分支需要两个条件同时成立：①窗口打开前的入口复核仍属我方（否则
    //   连对比窗口都进不去）；②窗口一开始复核就已变为外部接管；③此时已有脏标记。
    //   因此用两次窗口：第一次真正打开窗口并留下真实脏标记，第二次命中早退分支。
    const env = buildEnv({ fetchDelay: 120 });
    await ready(env, "10808");

    // 第一次窗口：入口、窗口开头复核与收尾复核（前 3 次回读）都属我方，
    //   清除与收尾提交都真实执行；真正的接管发生在【收尾提交内部】
    //   （applyProxyCore 下发前的控制权复核）→ 按设计放弃写入、且【不清脏】。
    env.setGetHook((n, o, cb, defaultGet) => {
      if (n <= 3) return defaultGet(o, cb);
      return cb({
        value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } },
        levelOfControl: "controlled_by_other_extensions"
      });
    });
    // 脏标记的真实来源：窗口期间保存设置。suspendDepth > 0 时 onChanged 监听器
    //   先记脏、再排入串行队列；排队任务随后被 applyProxy 的暂停检查挡下，不触碰 chrome.proxy。
    env.onClearDuringDirect(() => {
      env.sandbox.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "8080" }), () => {});
    });
    const resp1 = await ask(env, { action: "testConnection", compare: true });
    await drain(env);
    env.closeWindow();

    t("第一次窗口在收尾提交内部发现外部接管并放弃写回（构造前置事实）",
      !!(resp1 && resp1.result && resp1.result.overriddenDuringRestore === "controlled_by_other_extensions"),
      "overriddenDuringRestore=" + (resp1 && resp1.result && resp1.result.overriddenDuringRestore));
    t("窗口期间保存的设置确实记下了脏标记，且被接管时不得清掉（构造前置事实）",
      env.sandbox.suspendDirty === true, "dirty=" + env.sandbox.suspendDirty);
    // 收尾提交返回 overridden 时的分类分支同样必须保留待下发标记
    //   （任务书 C-6 要求的三分类结构：被接管 ≠ 恢复失败，但也不清脏）。
    const overriddenRestore = env.stateWrites.filter(w => w && w.status === "overridden");
    t("收尾提交被接管时写下的状态必须保留待下发标记",
      overriddenRestore.length >= 1 && overriddenRestore[0].pendingResubmit === true,
      JSON.stringify(overriddenRestore));

    // 【R7-02 之后的必要前置构造】R7-02 给对比入口增加了"当前【实际生效】的配置必须是
    //   我方 fixed_servers"的判据（否则宁可不测，也不许动代理）。而第一次窗口的清除
    //   并没有被恢复（收尾提交被判为外部接管、按设计放弃写回），所以此刻 chrome.proxy
    //   里实际是直连；若不先把配置挂回我方形态，第二次窗口会止步于该入口判据，
    //   根本走不到本用例真正要验证的【清除前接管】分支。
    //   这里直接调用测试桩的真实落地函数（语义等价于"配置确实还挂在我方"），
    //   不经过我方 set 序列，因此不污染任何计数与断言。
    env.sandbox.chrome.proxy.settings._apply("127.0.0.1:8080");

    // 第二次窗口：入口复核仍属我方（才允许进入对比），窗口开头复核即为外部接管
    //   → 命中【清除前接管】早退分支，全程不执行清除、也不下发任何配置。
    env.setGetHook((n, o, cb, defaultGet) => {
      if (n === 1) return defaultGet(o, cb);
      return cb({
        value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } },
        levelOfControl: "controlled_by_other_extensions"
      });
    });
    const writesBefore2 = env.stateWrites.length;
    const setsBefore2 = env.setCalls.length;
    const resp2 = await ask(env, { action: "testConnection", compare: true });
    await drain(env);
    env.closeWindow();

    t("第二次窗口在【清除之前】就发现外部接管并跳过对比（构造前置事实）",
      !!(resp2 && resp2.result && resp2.result.compareSkipped === "control_changed_before_clear"),
      "compareSkipped=" + (resp2 && resp2.result && resp2.result.compareSkipped) +
      "；controlChangedBeforeClear=" + (resp2 && resp2.result && resp2.result.controlChangedBeforeClear));
    t("清除前接管时全程没有下发过代理配置（未夺权的前置事实）",
      env.setCalls.length === setsBefore2,
      "set 序列=" + JSON.stringify(env.setCalls.slice(setsBefore2)));
    t("清除前接管前脏标记确实还在（构造前置事实）",
      env.sandbox.suspendDirty === true, "dirty=" + env.sandbox.suspendDirty);

    // 只取【第二次窗口期间】写下、且状态为 overridden 的那一条，避免被其他写入干扰。
    const overriddenThisWindow = env.stateWrites.slice(writesBefore2)
      .filter(w => w && w.status === "overridden");
    t("清除前接管确实写下了 overridden 状态（构造前置事实）",
      overriddenThisWindow.length >= 1,
      "本条窗口内的 overridden 写入=" + JSON.stringify(overriddenThisWindow));
    // 通道④：前台状态条由 lastState.pendingResubmit 单行驱动（popup.js:89），
    //   这里断言的正是它读取的那个真实状态对象，而不是内部控制变量。
    t("清除前接管写下的状态必须保留待下发标记（通道④：前台才显示得出来）",
      overriddenThisWindow.length >= 1 && overriddenThisWindow[0].pendingResubmit === true,
      "lastState=" + JSON.stringify(overriddenThisWindow[0]));
    // 通道②：配置确实还有待下发，测试结果必须如实上报。
    t("清除前接管时测试结果如实上报仍有待下发的配置（通道②）",
      !!(resp2 && resp2.result && resp2.result.pendingResubmit === true),
      "pendingResubmit=" + (resp2 && resp2.result && resp2.result.pendingResubmit));
    // 汇总护栏：任何一处 overridden 状态写入都不得丢掉待下发标记（覆盖全部三条路径）。
    const overriddenAll = env.stateWrites.filter(w => w && w.status === "overridden");
    t("每一处 overridden 状态写入都必须保留待下发标记（通道②/④ 汇总）",
      overriddenAll.length >= 2 && overriddenAll.every(w => w.pendingResubmit === true),
      JSON.stringify(overriddenAll));
  }

  {
    // 通道② 反向断言：没有脏标记时，任何路径都不得声称「有配置变更待下发」。
    //   这是防「把 pendingResubmit 硬编码为 true」的常驻护栏。
    const env = buildEnv({ fetchDelay: 20 });
    await drain(env);
    env.setGetHook((n, o, cb) => cb({
      value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "external", port: "9090" } } },
        levelOfControl: "controlled_by_other_extensions"
    }));
    await setSync(env, Object.assign({}, BASE, { proxyPort: "4445" }));
    await drain(env);

    t("构造前置事实：此时并无待下发的配置变更",
      env.sandbox.suspendDirty === false, "dirty=" + env.sandbox.suspendDirty);
    const stIdle = env.sessionStore.lastState || {};
    t("无待下发变更时状态不得声称仍有待下发（通道②：误报护栏）",
      stIdle.pendingResubmit !== true, "lastState=" + JSON.stringify(stIdle));
  }

  console.log("");
  console.log("== R7-01-A：存储读取失败（items 为 undefined）不得清代理、不得误报「直连」 ==");
  {
    // 缺陷链路（R7-01）：sync.get 回调置 lastError 且 items 为 undefined →
    //   normalizeSettings(undefined) 归一成默认配置（enableProxy:false）→
    //   applyProxyCore 在【校验之前】就走 clearProxyScope("regular")，
    //   把仍在生效的代理真清除，并把状态写成 direct、图标转红。
    // 修复后：读取失败是显式失败，绝不产生任何破坏性写操作，
    //   状态必须是「未知」而不是「直连」。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    const beforeSet = env.setCalls.length, beforeClear = env.clearCalls.length;
    t("构造前置事实：浏览器里确实挂着代理 10808",
      env.getEffective() === "127.0.0.1:10808", "实际=" + env.getEffective());

    env.setStorageHook((area, keys) => {
      if (area !== "sync") return null;
      const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
      // 只打【主配置读取】；bypassList 的读取由 R7-01-C 单独覆盖，
      //   保证本用例的判据只指向「主配置读取失败」这一条路径。
      if (ks.length === 1 && ks[0] === "bypassList") return null;
      return { error: { message: "QUOTA_BYTES quota exceeded" }, items: undefined };
    });
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10811" }));
    await drain(env);
    await sleep(300);
    env.closeWindow();

    const st = env.sessionStore.lastState || {};
    t("存储读取失败时不得清除代理（clearProxy 调用次数为 0）",
      env.clearCalls.length - beforeClear === 0,
      "clear 序列=" + JSON.stringify(env.clearCalls.slice(beforeClear)));
    t("存储读取失败时不得下发代理（setProxy 调用次数为 0）",
      env.setCalls.length - beforeSet === 0,
      "set 序列=" + JSON.stringify(env.setCalls.slice(beforeSet)));
    t("存储读取失败时浏览器里原有代理仍在（未被真清除）",
      env.getEffective() === "127.0.0.1:10808", "实际=" + env.getEffective());
    t("存储读取失败时状态不得是 direct",
      st.status !== "direct", "lastState=" + JSON.stringify(st));
    t("存储读取失败时状态不得是 applied",
      st.status !== "applied", "lastState=" + JSON.stringify(st));
    t("存储读取失败时末次图标不是绿色",
      env.iconCalls[env.iconCalls.length - 1] !== "icon-green-16.png",
      "icon=" + env.iconCalls[env.iconCalls.length - 1]);
    t("存储读取失败时状态如实反映失败且带非空原因",
      st.status === "error" && typeof st.message === "string" && st.message.length > 0,
      "lastState=" + JSON.stringify(st));
  }

  console.log("");
  console.log("== R7-01-B：存储读取失败（items 为 空对象）同样必须被拦住 ==");
  {
    // 同一条失败路径的另一种取值形态：items 为 {}（修复前 normalizeSettings({})
    //   同样归一成 enableProxy:false，触发面比 undefined 更宽）。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    const beforeSet = env.setCalls.length, beforeClear = env.clearCalls.length;
    t("构造前置事实：浏览器里确实挂着代理 10808",
      env.getEffective() === "127.0.0.1:10808", "实际=" + env.getEffective());

    env.setStorageHook((area, keys) => {
      if (area !== "sync") return null;
      const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
      if (ks.length === 1 && ks[0] === "bypassList") return null;
      return { error: { message: "QUOTA_BYTES quota exceeded" }, items: {} };
    });
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10811" }));
    await drain(env);
    await sleep(300);
    env.closeWindow();

    const st = env.sessionStore.lastState || {};
    t("items 为空对象时同样不得清除代理",
      env.clearCalls.length - beforeClear === 0,
      "clear 序列=" + JSON.stringify(env.clearCalls.slice(beforeClear)));
    t("items 为空对象时同样不得下发代理",
      env.setCalls.length - beforeSet === 0,
      "set 序列=" + JSON.stringify(env.setCalls.slice(beforeSet)));
    t("items 为空对象时浏览器里原有代理仍在",
      env.getEffective() === "127.0.0.1:10808", "实际=" + env.getEffective());
    t("items 为空对象时状态既不是 direct 也不是 applied",
      st.status !== "direct" && st.status !== "applied",
      "lastState=" + JSON.stringify(st));
    t("items 为空对象时末次图标不是绿色",
      env.iconCalls[env.iconCalls.length - 1] !== "icon-green-16.png",
      "icon=" + env.iconCalls[env.iconCalls.length - 1]);
  }

  console.log("");
  console.log("== R7-01-C：绕过列表读取失败不得被静默清空下发给 chrome.proxy ==");
  {
    // 缺陷链路：绕过列表因超长已降级到 local（sync 里为空串），
    //   readBypassText 在 local.get 失败时 resolve("")，
    //   于是【绕过列表被静默下发为空】—— 原本的内网直连规则凭空消失。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    const LOCAL_BYPASS = "192.168.0.0/16\n10.0.0.0/8";
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10808", bypassList: "" }));
    await new Promise(r => env.sandbox.chrome.storage.local.set({ bypassList: LOCAL_BYPASS }, r));
    await drain(env);
    const normalCfg = env.setConfigs[env.setConfigs.length - 1];
    t("构造前置事实：正常路径下确实下发了非空的绕过列表",
      !!(normalCfg && normalCfg.rules &&
         JSON.stringify(normalCfg.rules.bypassList) === JSON.stringify(["192.168.0.0/16", "10.0.0.0/8"])),
      "下发的 bypassList=" + JSON.stringify(normalCfg && normalCfg.rules && normalCfg.rules.bypassList));
    env.setCalls.length = 0; env.setConfigs.length = 0; env.clearCalls.length = 0;

    env.setStorageHook((area, keys) => {
      if (area !== "local") return null;
      const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
      if (ks.indexOf("bypassList") < 0) return null;
      return { error: { message: "local read failed (injected)" }, items: {} };
    });
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10811", bypassList: "" }));
    await drain(env);
    await sleep(300);
    env.closeWindow();

    const lastCfg = env.setConfigs[env.setConfigs.length - 1];
    const bypass = lastCfg && lastCfg.rules && lastCfg.rules.bypassList;
    t("绕过列表读取失败时，下发给 chrome.proxy 的 bypassList 不得是空数组",
      !(Array.isArray(bypass) && bypass.length === 0),
      "下发的 bypassList=" + JSON.stringify(bypass) +
      "；setConfigs=" + JSON.stringify(env.setConfigs));
    t("绕过列表读取失败时不得改用直连清除来「兜底」",
      env.clearCalls.length === 0,
      "clear 序列=" + JSON.stringify(env.clearCalls));
    const stC = env.sessionStore.lastState || {};
    t("绕过列表读取失败时不得判 applied",
      stC.status !== "applied", "lastState=" + JSON.stringify(stC));
  }

  console.log("");
  console.log("== R7-01-D：读取正常时，有效配置仍照常下发并判 applied、图标为绿（防回归） ==");
  {
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.setStorageHook(() => null);   // 显式声明：本用例不注入任何读取失败
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10813" }));
    await drain(env);
    await sleep(200);
    env.closeWindow();

    const st = env.sessionStore.lastState || {};
    const lastCfg = env.setConfigs[env.setConfigs.length - 1];
    t("读取正常时配置照常下发到 chrome.proxy",
      env.getEffective() === "127.0.0.1:10813", "实际=" + env.getEffective());
    t("读取正常时判 applied 且与实际生效一致",
      st.status === "applied", "lastState=" + JSON.stringify(st));
    t("读取正常时末次图标为绿色",
      env.iconCalls[env.iconCalls.length - 1] === "icon-green-16.png",
      "icon=" + env.iconCalls[env.iconCalls.length - 1]);
    t("读取正常时绕过列表按原语义下发（正常路径未被误伤）",
      !!(lastCfg && lastCfg.rules &&
         JSON.stringify(lastCfg.rules.bypassList) === JSON.stringify(["x"])),
      "下发的 bypassList=" + JSON.stringify(lastCfg && lastCfg.rules && lastCfg.rules.bypassList));
  }

  console.log("");
  console.log("== R7-01-E：对比窗口收尾读取失败时，恢复必须如实判失败且不得清脏（要求4） ==");
  {
    // 要求 4：runCompareWindow 收尾调用 applyProxyCore 时若因读取失败而未能恢复，
    //   必须如实置 result.restoreFailed = true 且有非空原因，不得清掉 suspendDirty。
    // 修复前的链路：读取失败 → 归一成默认配置（enableProxy:false）→ 窗口收尾
    //   反而把「未启用」当成结论、clearProxyScope("regular") 后返回 {ok:true,status:"direct"}，
    //   于是恢复被当成成功、脏标记被清掉 —— 用户在窗口期间保存的配置就此永久消失。
    const env = buildEnv({ fetchDelay: 40 });
    await ready(env, "10808");
    t("构造前置事实：浏览器里挂着代理 10808",
      env.getEffective() === "127.0.0.1:10808", "实际=" + env.getEffective());

    env.onClearDuringDirect(sb => {
      // 窗口期间保存新端口：该请求被暂停挡下 → 记脏（真实来源，不靠直接置位）
      sb.chrome.storage.sync.set(Object.assign({}, BASE, { proxyPort: "6666" }), () => {});
      // 自直连取样起，主配置读取全部失败 → 收尾「按最新 settings 恢复」必然读不到配置
      env.setStorageHook((area, keys) => {
        if (area !== "sync") return null;
        const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
        if (ks.length === 1 && ks[0] === "bypassList") return null;
        return { error: { message: "读取设置失败（注入）" }, items: undefined };
      });
    });

    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(400); env.closeWindow();

    t("收尾因读取失败而未恢复时，如实置 restoreFailed 为 true（要求4）",
      !!(resp && resp.result && resp.result.restoreFailed === true),
      "restoreFailed=" + (resp && resp.result && resp.result.restoreFailed));
    t("收尾读取失败时不得清掉脏标记（否则这次变更被永久丢弃）",
      env.sandbox.suspendDirty === true, "dirty=" + env.sandbox.suspendDirty);
    const stE = env.sessionStore.lastState || {};
    t("收尾读取失败时状态不是 applied 且带非空原因",
      stE.status !== "applied" && typeof stE.message === "string" && stE.message.length > 0,
      "lastState=" + JSON.stringify(stE));
    t("收尾读取失败时绝不把状态写成 direct（读不到 ≠ 用户关掉了代理）",
      stE.status !== "direct", "lastState=" + JSON.stringify(stE));
    t("收尾读取失败时末次图标不是绿色",
      env.iconCalls[env.iconCalls.length - 1] !== "icon-green-16.png",
      "icon=" + env.iconCalls[env.iconCalls.length - 1]);
  }
  console.log("");
  console.log("== R7-02：配置无效或生效配置不符时，对比入口不得清除仍在工作的旧代理 ==");

  // 构造 R7-02 的现场：先前成功下发过有效代理 127.0.0.1:10808（chrome.proxy 里挂着它），
  //   随后存储被改成【无效配置】。此时点「对比直连出口」正是缺陷链路的起点。
  async function staleInvalidEnv(invalidPort) {
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    await setSync(env, Object.assign({}, BASE, { proxyPort: invalidPort }));
    await sleep(400);            // 让"存储变化 → 校验失败 → saved_not_applied"完整跑完
    env.setCalls.length = 0; env.setConfigs.length = 0;
    env.clearCalls.length = 0; env.timeline.length = 0;
    env.resetDirect();
    return env;
  }

  {
    // R7-02-A（核心）：无效端口 + 代理仍有效 + compare=true。
    //   缺陷链路：入口只看 enableProxy && controlledByUs，不校验配置有效性 →
    //   窗口先 clearProxyScope("regular") 把仍在工作的 10808 清掉 →
    //   收尾 applyProxyCore 因校验失败返回 saved_not_applied（set 次数为 0）→
    //   测试结束后浏览器里代理为 null，代理丢失且不恢复。
    const env = await staleInvalidEnv("not-a-port");
    const writesBefore = env.stateWrites.length;
    const iconsBefore = env.iconCalls.length, titlesBefore = env.titleCalls.length;
    const stBefore = JSON.parse(JSON.stringify(env.sessionStore.lastState || {}));

    t("R7-02-A 前置事实：浏览器里仍挂着先前成功下发的代理 10808",
      env.getEffective() === "127.0.0.1:10808", "实际=" + env.getEffective());
    t("R7-02-A 前置事实：存储里是无效端口，测试前的真实结论是 saved_not_applied",
      env.syncStore.proxyPort === "not-a-port" && stBefore.status === "saved_not_applied",
      "proxyPort=" + env.syncStore.proxyPort + "；lastState=" + JSON.stringify(stBefore));

    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(400); env.closeWindow();

    const regularClears = env.clearCalls.filter(s => s === "regular").length;
    t("R7-02-A 无效配置下不得清除 regular 作用域（clear 次数为 0）",
      regularClears === 0, "clear 序列=" + JSON.stringify(env.clearCalls));
    t("R7-02-A 无效配置下不得下发任何代理配置（set 次数为 0）",
      env.setCalls.length === 0, "set 序列=" + JSON.stringify(env.setCalls));
    t("R7-02-A 核心事实：测试结束后浏览器里仍挂着原代理 127.0.0.1:10808（代理没有丢失）",
      env.getEffective() === "127.0.0.1:10808", "实际=" + env.getEffective());
    t("R7-02-A 测试期间没有写任何状态（现场未被污染）",
      env.stateWrites.length === writesBefore,
      "新写入=" + JSON.stringify(env.stateWrites.slice(writesBefore)));
    t("R7-02-A 未改动图标与标题（现场未被破坏）",
      env.iconCalls.length === iconsBefore && env.titleCalls.length === titlesBefore,
      "新增图标=" + JSON.stringify(env.iconCalls.slice(iconsBefore)) +
      "；新增标题=" + JSON.stringify(env.titleCalls.slice(titlesBefore)));
    const stA = env.sessionStore.lastState || {};
    t("R7-02-A 状态未被写成 suspended 或 error，仍是测试前的结论",
      stA.status === "saved_not_applied", "lastState=" + JSON.stringify(stA));
    t("R7-02-A 结果如实标记 invalid_settings、带上非空原因，且不误报 restoreFailed",
      !!(resp && resp.result && resp.result.compareSkipped === "invalid_settings") &&
      !!(resp && resp.result && typeof resp.result.compareSkippedReason === "string" &&
         resp.result.compareSkippedReason.length > 0) &&
      !(resp && resp.result && resp.result.restoreFailed === true),
      "result=" + JSON.stringify(resp && resp.result && {
        compareSkipped: resp.result.compareSkipped,
        compareSkippedReason: resp.result.compareSkippedReason,
        restoreFailed: resp.result.restoreFailed
      }));
    t("R7-02-A 未取直连出口（根本没有进入对比窗口）",
      !(resp && resp.result && resp.result.direct),
      "direct=" + JSON.stringify(resp && resp.result && resp.result.direct));
  }

  {
    // R7-02-B：同一现场，但两次出口恰好相同（代理不改变出口）。
    //   出口是否相同与"该不该清代理"无关，早退必须同样成立。
    const env = await staleInvalidEnv("not-a-port");
    env.sandbox.fetch = function () {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ip: DIRECT_IP, org: "", city: "", region: "", country: "" })
      });
    };
    const writesBefore = env.stateWrites.length;
    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(400); env.closeWindow();

    const regularClears = env.clearCalls.filter(s => s === "regular").length;
    t("R7-02-B 出口相同的情形下同样不得清除 regular（clear 次数为 0）",
      regularClears === 0, "clear 序列=" + JSON.stringify(env.clearCalls));
    t("R7-02-B 出口相同的情形下不得下发代理（set 次数为 0）",
      env.setCalls.length === 0, "set 序列=" + JSON.stringify(env.setCalls));
    t("R7-02-B 核心事实：测试结束后代理仍生效且仍是原值",
      env.getEffective() === "127.0.0.1:10808", "实际=" + env.getEffective());
    t("R7-02-B 出口相同时同样不写任何状态",
      env.stateWrites.length === writesBefore,
      "新写入=" + JSON.stringify(env.stateWrites.slice(writesBefore)));
    t("R7-02-B 出口相同时状态不得是 suspended / error",
      (env.sessionStore.lastState || {}).status === "saved_not_applied",
      "lastState=" + JSON.stringify(env.sessionStore.lastState));
    t("R7-02-B 出口相同时同样判 invalid_settings 早退",
      !!(resp && resp.result && resp.result.compareSkipped === "invalid_settings"),
      "compareSkipped=" + (resp && resp.result && resp.result.compareSkipped));
  }

  {
    // R7-02-C（防回归，最重要）：有效配置下，正常对比必须完全照旧 ——
    //   证明这次修复没有把正常对比一起关掉。
    const env = buildEnv({ fetchDelay: 40 });
    await ready(env, "10808");
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10999" }));
    await drain(env);
    await sleep(200);
    t("R7-02-C 前置事实：有效配置已下发并生效",
      env.getEffective() === "127.0.0.1:10999", "实际=" + env.getEffective());
    env.setCalls.length = 0; env.setConfigs.length = 0;
    env.clearCalls.length = 0; env.timeline.length = 0;
    env.iconCalls.length = 0; env.resetDirect();

    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(500); env.closeWindow();

    const regularClears = env.clearCalls.filter(s => s === "regular").length;
    t("R7-02-C 有效配置下仍照旧进入对比：clear(regular) 恰 1 次",
      regularClears === 1, "clear 序列=" + JSON.stringify(env.clearCalls));
    t("R7-02-C 有效配置下仍照旧收尾恢复：setProxy 恰 1 次",
      env.setCalls.length === 1, "set 序列=" + JSON.stringify(env.setCalls));
    t("R7-02-C 测试结束后代理恢复为有效配置",
      env.getEffective() === "127.0.0.1:10999", "实际=" + env.getEffective());
    const stC = env.sessionStore.lastState || {};
    const lastIconC = env.iconCalls[env.iconCalls.length - 1];
    t("R7-02-C 状态 applied 且图标为绿色",
      stC.status === "applied" && lastIconC === "icon-green-16.png",
      "lastState=" + JSON.stringify(stC) + "；icon=" + lastIconC);
    t("R7-02-C 对比仍然有效：直连出口取到了，且未被入口误拦",
      !!(resp && resp.result && resp.result.direct && resp.result.direct.ok) &&
      resp.result.direct.ip === DIRECT_IP &&
      !(resp.result.compareSkipped),
      "direct=" + JSON.stringify(resp && resp.result && resp.result.direct) +
      "；compareSkipped=" + (resp && resp.result && resp.result.compareSkipped));
  }

  {
    // R7-02-D：控制权属我方、存储配置有效，但 chrome.proxy 里【实际生效的模式】
    //   不是 fixed_servers（此处为直连）→ 同样不得 clear。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.setGetHook((n, o, cb) => {
      setTimeout(() => cb({
        value: { mode: "direct" },
        levelOfControl: "controllable_by_this_extension"
      }), 0);
    });
    const writesBefore = env.stateWrites.length;
    const clearsBefore = env.clearCalls.length;
    const resp = await ask(env, { action: "testConnection", compare: true });
    await sleep(400); env.closeWindow();

    // 计数基线取"本用例期间"：ready() 之前的冷启动（未启用配置）本身就会清一次
    //   regular 并顺带清理三个遗留作用域，那是既有语义，不属于本用例的断言对象。
    const clearsDuringTest = env.clearCalls.length - clearsBefore;
    t("R7-02-D 实际模式不是 fixed_servers 时不得清除 regular（clear 次数为 0）",
      clearsDuringTest === 0,
      "本用例期间 clear=" + JSON.stringify(env.clearCalls.slice(clearsBefore)) +
      "；测试前已有 " + clearsBefore + " 次=" + JSON.stringify(env.clearCalls.slice(0, clearsBefore)));
    t("R7-02-D 实际模式不是 fixed_servers 时不得下发代理（set 次数为 0）",
      env.setCalls.length === 0, "set 序列=" + JSON.stringify(env.setCalls));
    t("R7-02-D 实际模式不是 fixed_servers 时不得写任何状态",
      env.stateWrites.length === writesBefore,
      "新写入=" + JSON.stringify(env.stateWrites.slice(writesBefore)));
    const stD = env.sessionStore.lastState || {};
    t("R7-02-D 状态不得是 suspended / error",
      stD.status !== "suspended" && stD.status !== "error", "lastState=" + JSON.stringify(stD));
    t("R7-02-D 结果如实标记跳过对比，且不误报 restoreFailed",
      !!(resp && resp.result && resp.result.compareSkipped === "not_fixed_servers") &&
      !(resp && resp.result && resp.result.restoreFailed === true),
      "compareSkipped=" + (resp && resp.result && resp.result.compareSkipped) +
      "；restoreFailed=" + (resp && resp.result && resp.result.restoreFailed));
  }

  {
    // R7-02-E：前台文案 —— 直接执行 popup.js 的真实渲染函数片段，而不是复述它的逻辑。
    const popupSrc = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
    const pctx = { el: { testResult: {} }, console: { log: function () {} } };
    vm.createContext(pctx);
    vm.runInContext(
      popupSrc.slice(popupSrc.indexOf("function fmtExit"), popupSrc.indexOf("async function runTest")),
      pctx
    );
    pctx.renderTest({
      ok: true,
      compareSkipped: "invalid_settings",
      compareSkippedReason: "端口须为 1 至 65535 之间的整数",
      exit: { ok: true, ip: DIRECT_IP },
      settings: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "not-a-port" }
    });
    const htmlInvalid = pctx.el.testResult.innerHTML;
    t("R7-02-E invalid_settings 文案明确告知未改动现有代理",
      htmlInvalid.indexOf("未改动现有代理") >= 0, htmlInvalid);
    t("R7-02-E invalid_settings 文案要求用户先修正设置",
      htmlInvalid.indexOf("请先修正设置") >= 0, htmlInvalid);
    t("R7-02-E invalid_settings 文案带出具体原因",
      htmlInvalid.indexOf("端口须为 1 至 65535") >= 0, htmlInvalid);
    t("R7-02-E invalid_settings 不渲染成恢复失败（现场未被破坏）",
      htmlInvalid.indexOf("恢复原代理配置失败") < 0, htmlInvalid);
    t("R7-02-E invalid_settings 不渲染成出口可疑",
      htmlInvalid.indexOf("很可能未生效") < 0, htmlInvalid);

    pctx.renderTest({
      ok: true,
      compareSkipped: "not_fixed_servers",
      compareSkippedReason: "当前实际生效的代理模式是 direct，不是本扩展下发的 fixed_servers",
      exit: { ok: true, ip: DIRECT_IP }
    });
    const htmlNotFixed = pctx.el.testResult.innerHTML;
    t("R7-02-E not_fixed_servers 文案同样声明已跳过对比且未改动现有代理",
      htmlNotFixed.indexOf("已跳过直连对比") >= 0 && htmlNotFixed.indexOf("未改动现有代理") >= 0,
      htmlNotFixed);

    // 防回归：三个既有 skip 取值的文案一字不变。
    pctx.renderTest({ ok: true, compareSkipped: "unknown_control", exit: { ok: true, ip: DIRECT_IP } });
    t("R7-02-E unknown_control 文案保持原样",
      pctx.el.testResult.innerHTML.indexOf("无法确认当前代理控制权") >= 0,
      pctx.el.testResult.innerHTML);
    pctx.renderTest({ ok: true, compareSkipped: "control_changed_before_clear", exit: { ok: true, ip: DIRECT_IP } });
    t("R7-02-E control_changed_before_clear 文案保持原样",
      pctx.el.testResult.innerHTML.indexOf("未清除当前代理") >= 0,
      pctx.el.testResult.innerHTML);
    pctx.renderTest({ ok: true, compareSkipped: "not_controlled_by_this_extension", exit: { ok: true, ip: DIRECT_IP } });
    t("R7-02-E not_controlled_by_this_extension 文案保持原样",
      pctx.el.testResult.innerHTML.indexOf("已跳过直连对比以免影响它") >= 0,
      pctx.el.testResult.innerHTML);
  }

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error("EXC: " + (e && e.stack || e)); process.exit(2); });
