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
  const listeners = { changed: [], message: [], onChange: [], installed: [] };
  const setCalls = [];       // setProxy 的发起序列
  const setConfigs = [];     // R7-01：每次下发给 chrome.proxy 的完整配置对象
  const clearCalls = [];     // clear 的作用域序列
  const timeline = [];       // 窗口内每次 set/clear 【完成】时刻的真实生效配置
  const fetchLog = [];       // 每次 fetch 时刻的 proxyActive
  const iconCalls = [], titleCalls = [];
  let windowOpen = false, proxyActive = false, effective = null, fetchCount = 0;
  // R8-03：模拟外部写入方把【协议】(scheme) 改成别的值 —— Chromium 里一个作用域只有
  //   一份生效配置，所以改写协议会连同 host/port 一起改写（由 externalSetEffective 给出）。
  //   默认 "socks5"：不注入时与修复前的默认回读一字不差，既有用例行为不变。
  let effectiveScheme = "socks5";
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
  // R8-03：外部写入方「同 host/port、换协议」的写入 —— 只改真实生效配置与控制权等级，
  //   不经过我方任何写路径（不推 setCalls、不写 timeline，与 externalSet 语义一致）。
  function externalSetEffective(level, host, port, scheme) {
    effectiveScheme = scheme;
    effective = host === null ? null : host + ":" + port;
    proxyActive = host !== null;
    externalLevel = level;
  }
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
      ? { mode: "fixed_servers", rules: { singleProxy: { scheme: effectiveScheme, host: effective.split(":")[0], port: effective.split(":")[1] } } }
      : { mode: "direct" };
    // externalLevel 非空时优先返回它：模拟外部接管或外部释放控制权（R6-04）。
    const level = externalLevel || "controlled_by_this_extension";
    setTimeout(() => cb({ value, levelOfControl: level }), 0);
  }
  sandbox.chrome = {
    runtime: { lastError: undefined, id: SENDER_ID,
      onInstalled: { addListener(f) { listeners.installed.push(f); } }, onStartup: { addListener() {} },
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
            if (o.value && o.value.mode === "direct") effectiveScheme = "socks5";
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
    // R8-03：外部写入方「同 host/port、换协议」的模拟入口（见 externalSetEffective）。
    externalSetEffective,
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
  console.log("== R7-05：回声抑制必须先过控制权检查（同目标外部接管不得被吞）==");
  {
    // 缺陷事实（R7-05）：回声抑制原先只看「实际生效配置是否等于我方 lastIntent」，
    //   完全不看控制权。外部扩展以【相同】mode/host/port 接管时值比对成立，
    //   回调直接 return —— session 仍写着「我方控制 + 已生效」、图标仍是绿色，
    //   而浏览器真实控制权已是 controlled_by_other_extensions。
    //   路由目标相同 ≠ 控制权相同：后者决定我方后续能否下发（isControllableByUs
    //   白名单），也决定用户排障方向（该查企业策略/其它扩展，还是查自己的代理）。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    const before = env.sessionStore.lastState || {};
    t("R7-05-A 前置：接管前为我方 applied",
      before.status === "applied", "lastState=" + JSON.stringify(before));

    // 外部扩展以【完全相同】的目标接管：host/port 与我方 lastIntent 一字不差。
    env.externalSet("controlled_by_other_extensions", "127.0.0.1", "10808");
    const setBefore = env.setCalls.length, clearBefore = env.clearCalls.length;
    env.fireProxyChange({ levelOfControl: "controlled_by_other_extensions" });
    await drain(env);

    const after = env.sessionStore.lastState || {};
    t("R7-05-A 同目标被外部接管后，session 状态必须转为 overridden（不得被当成我方回声吞掉）",
      after.status === "overridden", "lastState=" + JSON.stringify(after));
    t("R7-05-A 同目标被外部接管后，状态里的控制权必须如实记录为 controlled_by_other_extensions",
      after.levelOfControl === "controlled_by_other_extensions",
      "levelOfControl=" + JSON.stringify(after.levelOfControl));
    t("R7-05-A 同目标被外部接管后，最后一个图标必须是红色（绝不留下绿色）",
      env.iconCalls[env.iconCalls.length - 1] === "icon-red-16.png",
      "icon 序列=" + JSON.stringify(env.iconCalls));

    // R7-05-B：状态纠正【不得】以夺权为代价 —— D-2 只读硬约束必须保持。
    const setDelta = env.setCalls.length - setBefore;
    const clearDelta = env.clearCalls.length - clearBefore;
    t("R7-05-B 同目标接管后回调必须完成状态纠正，且全程零写回（不夺权）",
      after.status === "overridden" && setDelta === 0 && clearDelta === 0,
      "status=" + after.status + "；setDelta=" + setDelta + "；clearDelta=" + clearDelta);
    t("R7-05-B 回调期间不得调用 setProxy（新增 set 必须为 0）",
      setDelta === 0, "新增 set=" + JSON.stringify(env.setCalls.slice(setBefore)));
    t("R7-05-B 回调期间不得调用 clearProxyScope（新增 clear 必须为 0）",
      clearDelta === 0, "新增 clear=" + JSON.stringify(env.clearCalls.slice(clearBefore)));
  }
  {
    // R7-05-C（防回归·关键）：我方 set 成功触发的 onChange 回声必须【仍被抑制】。
    //   修复把 isControllableByUs 前置后，这条路径要求控制权在白名单内 ——
    //   真实 Chromium 对我方 set 派发的回声就是 controlled_by_this_extension，
    //   因此抑制依然成立：不得多写一次状态、不得刷新图标。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10101" }));
    await drain(env);
    const stBefore = JSON.stringify(env.sessionStore.lastState || {});
    t("R7-05-C 前置：我方下发成功后状态为 applied",
      (env.sessionStore.lastState || {}).status === "applied", "lastState=" + stBefore);
    const writesBefore = env.stateWrites.length, iconsBefore = env.iconCalls.length;

    // Chrome 为我方这次 set 派发的回声：实际生效配置与 lastIntent 完全一致。
    env.fireProxyChange({ levelOfControl: "controlled_by_this_extension" });
    await drain(env);

    t("R7-05-C 我方 set 回声不得被当成外部变化（状态一字不变）",
      JSON.stringify(env.sessionStore.lastState || {}) === stBefore,
      "改动后=" + JSON.stringify(env.sessionStore.lastState) + " / 原值=" + stBefore);
    t("R7-05-C 我方 set 回声不得产生额外的状态写入",
      env.stateWrites.length === writesBefore,
      "新增写入=" + JSON.stringify(env.stateWrites.slice(writesBefore)));
    t("R7-05-C 我方 set 回声不得刷新图标（图标不抖动）",
      env.iconCalls.length === iconsBefore,
      "新增图标=" + JSON.stringify(env.iconCalls.slice(iconsBefore)));
  }
  {
    // R7-05-D（防回归·关键）：我方 clear 成功触发的 onChange 回声同样必须被抑制。
    //   真实语义：清除之后控制权回到「当前无人控制」，即 controllable_by_this_extension
    //   —— 它仍在 isControllableByUs 白名单内，所以值比对（lastIntent.mode === "direct"）
    //   依然能把这次变化认作我方回声。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    await setSync(env, Object.assign({}, BASE, { enableProxy: false }));
    await drain(env);
    t("R7-05-D 前置：我方清除成功后状态为 direct",
      (env.sessionStore.lastState || {}).status === "direct",
      "lastState=" + JSON.stringify(env.sessionStore.lastState));

    // 真实 Chromium 语义：clear 之后 level 回到 controllable_by_this_extension。
    env.externalSet("controllable_by_this_extension", null, null);
    const stBeforeD = JSON.stringify(env.sessionStore.lastState || {});
    const writesBeforeD = env.stateWrites.length, iconsBeforeD = env.iconCalls.length;

    env.fireProxyChange({ levelOfControl: "controllable_by_this_extension" });
    await drain(env);

    t("R7-05-D 我方 clear 回声不得被当成外部变化（状态一字不变）",
      JSON.stringify(env.sessionStore.lastState || {}) === stBeforeD,
      "改动后=" + JSON.stringify(env.sessionStore.lastState) + " / 原值=" + stBeforeD);
    t("R7-05-D 我方 clear 回声不得产生额外的状态写入",
      env.stateWrites.length === writesBeforeD,
      "新增写入=" + JSON.stringify(env.stateWrites.slice(writesBeforeD)));
    t("R7-05-D 我方 clear 回声不得刷新图标（图标不抖动）",
      env.iconCalls.length === iconsBeforeD,
      "新增图标=" + JSON.stringify(env.iconCalls.slice(iconsBeforeD)));
  }
  {
    // R7-05-E（防回归）：外部以【不同】目标接管时，行为与修复前完全一致。
    //   值比对本来就不成立，修复只是把控制权检查提前，不改变这条路径。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.externalSet("controlled_by_other_extensions", "external", "9090");
    env.fireProxyChange({ levelOfControl: "controlled_by_other_extensions" });
    await drain(env);

    const st = env.sessionStore.lastState || {};
    t("R7-05-E 不同目标被外部接管后状态仍为 overridden",
      st.status === "overridden", "lastState=" + JSON.stringify(st));
    t("R7-05-E 不同目标被外部接管后 levelOfControl 如实记录",
      st.levelOfControl === "controlled_by_other_extensions",
      "levelOfControl=" + JSON.stringify(st.levelOfControl));
    t("R7-05-E 不同目标被外部接管后末次图标仍为红色",
      env.iconCalls[env.iconCalls.length - 1] === "icon-red-16.png",
      "icon 序列=" + JSON.stringify(env.iconCalls));
  }

  console.log("");
  console.log("");
  console.log("== R8-03：回声抑制必须比对 scheme（协议被外部改动不得被吞）==");
  {
    // 缺陷事实（R8-03）：lastIntent 只记 mode/host/port，isOwnLastIntent 也只比这三项。
    //   外部（或用户手动）把生效配置改成【同 host/port、换协议】（socks5 → https）
    //   后释放控制权，level 回到可控白名单 → 值比对成立、控制权检查放行 →
    //   整次变化被当成我方回声 return：session 继续写 applied、图标继续留绿，
    //   而真实生效的协议早已不是我方下发的那个 —— 界面宣称的配置与实际不符。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    t("R8-03-A 前置：我方下发 socks5 127.0.0.1:10808 后状态为 applied",
      (env.sessionStore.lastState || {}).status === "applied",
      "lastState=" + JSON.stringify(env.sessionStore.lastState || {}));
    // 断言对象是【真实下发给 chrome.proxy 的配置】，不是内部变量。
    const lastCfg = env.setConfigs[env.setConfigs.length - 1] || {};
    const lastSp = ((lastCfg || {}).rules || {}).singleProxy || {};
    t("R8-03-A 前置：我方下发的真实配置是 socks5 127.0.0.1:10808",
      lastSp.scheme === "socks5" && lastSp.host === "127.0.0.1" && String(lastSp.port) === "10808",
      "下发配置=" + JSON.stringify(lastCfg));

    // 外部写入方：同 host/port，协议换成 https，随后释放控制权。
    env.externalSetEffective("controllable_by_this_extension", "127.0.0.1", "10808", "https");
    const writesBefore = env.stateWrites.length, iconsBefore = env.iconCalls.length;
    const setsBefore = env.setCalls.length, clearsBefore = env.clearCalls.length;
    env.fireProxyChange({ levelOfControl: "controllable_by_this_extension" });
    await drain(env);

    const after = env.sessionStore.lastState || {};
    t("R8-03-A 回声抑制必须先比对协议：协议被外部改动后不得继续宣称 applied",
      after.status !== "applied", "lastState=" + JSON.stringify(after));
    t("R8-03-A 协议不一致时必须如实落入既有异常档并说明配置非我方下发",
      after.status === "error" && /不是本扩展下发/.test(String(after.message || "")),
      "lastState=" + JSON.stringify(after));
    t("R8-03-A 协议被外部改动后最后一个图标必须转红（绝不留下绿色）",
      env.iconCalls[env.iconCalls.length - 1] === "icon-red-16.png",
      "icon 序列=" + JSON.stringify(env.iconCalls));

    // R8-03-B：状态纠正不得以夺权为代价 —— D-2 只读硬约束必须保持。
    t("R8-03-B 回调期间不得调用 setProxy（新增 set 必须为 0）",
      env.setCalls.length - setsBefore === 0,
      "新增 set=" + JSON.stringify(env.setCalls.slice(setsBefore)));
    t("R8-03-B 回调期间不得调用 clearProxyScope（新增 clear 必须为 0）",
      env.clearCalls.length - clearsBefore === 0,
      "新增 clear=" + JSON.stringify(env.clearCalls.slice(clearsBefore)));
    t("R8-03-B 协议不一致的纠正必须写状态与图标（不得停在过时结论上）",
      env.stateWrites.length > writesBefore && env.iconCalls.length > iconsBefore,
      "新增写入=" + (env.stateWrites.length - writesBefore) + "；新增图标=" + (env.iconCalls.length - iconsBefore));
    t("R8-03-B 状态里的控制权必须如实记录为 controllable_by_this_extension",
      after.levelOfControl === "controllable_by_this_extension",
      "levelOfControl=" + JSON.stringify(after.levelOfControl));
  }
  {
    // R8-03-C（防回归·关键）：mode/host/port/scheme 全同的真实回声必须【仍被抑制】。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10101" }));
    await drain(env);
    const stBefore = JSON.stringify(env.sessionStore.lastState || {});
    t("R8-03-C 前置：我方下发 socks5 127.0.0.1:10101 后状态为 applied",
      (env.sessionStore.lastState || {}).status === "applied", "lastState=" + stBefore);
    const writesBeforeC = env.stateWrites.length, iconsBeforeC = env.iconCalls.length;

    env.fireProxyChange({ levelOfControl: "controlled_by_this_extension" });
    await drain(env);

    t("R8-03-C 协议一致的真实回声不得被当成外部变化（状态一字不变）",
      JSON.stringify(env.sessionStore.lastState || {}) === stBefore,
      "改动后=" + JSON.stringify(env.sessionStore.lastState) + " / 原值=" + stBefore);
    t("R8-03-C 协议一致的真实回声不得产生额外状态写入",
      env.stateWrites.length === writesBeforeC,
      "新增写入=" + JSON.stringify(env.stateWrites.slice(writesBeforeC)));
    t("R8-03-C 协议一致的真实回声不得刷新图标（不抖动）",
      env.iconCalls.length === iconsBeforeC,
      "新增图标=" + JSON.stringify(env.iconCalls.slice(iconsBeforeC)));
  }
  {
    // R8-03-D（防回归·关键）：我方 clear 成功后 mode:"direct" 的回声必须【仍被抑制】。
    //   direct 意图没有协议字段，值比对必须仍走 isOwnLastIntent 的早退分支。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    await setSync(env, Object.assign({}, BASE, { enableProxy: false }));
    await drain(env);
    t("R8-03-D 前置：我方清除成功后状态为 direct",
      (env.sessionStore.lastState || {}).status === "direct",
      "lastState=" + JSON.stringify(env.sessionStore.lastState));
    env.externalSetEffective("controllable_by_this_extension", null, null, "socks5");
    const stBeforeD = JSON.stringify(env.sessionStore.lastState || {});
    const writesBeforeD = env.stateWrites.length, iconsBeforeD = env.iconCalls.length;

    env.fireProxyChange({ levelOfControl: "controllable_by_this_extension" });
    await drain(env);

    t("R8-03-D direct 意图（无协议字段）的回声不得被当成外部变化（状态一字不变）",
      JSON.stringify(env.sessionStore.lastState || {}) === stBeforeD,
      "改动后=" + JSON.stringify(env.sessionStore.lastState) + " / 原值=" + stBeforeD);
    t("R8-03-D direct 回声不得产生额外状态写入",
      env.stateWrites.length === writesBeforeD,
      "新增写入=" + JSON.stringify(env.stateWrites.slice(writesBeforeD)));
    t("R8-03-D direct 回声不得刷新图标（不抖动）",
      env.iconCalls.length === iconsBeforeD,
      "新增图标=" + JSON.stringify(env.iconCalls.slice(iconsBeforeD)));
  }
  {
    // R8-03-E（防回归）：R7-05 的同目标接管场景（host/port/协议全同、控制权旁落）
    //   行为必须一字不变：把协议纳入比对不得改变这条既有结论。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    t("R8-03-E 前置：接管前为我方 applied",
      (env.sessionStore.lastState || {}).status === "applied",
      "lastState=" + JSON.stringify(env.sessionStore.lastState));

    // 外部以完全相同目标（含协议）接管：协议/host/port 与我方 lastIntent 一字不差。
    env.externalSetEffective("controlled_by_other_extensions", "127.0.0.1", "10808", "socks5");
    const setBeforeE = env.setCalls.length, clearBeforeE = env.clearCalls.length;
    env.fireProxyChange({ levelOfControl: "controlled_by_other_extensions" });
    await drain(env);

    const afterE = env.sessionStore.lastState || {};
    t("R8-03-E 同目标（含协议）被外部接管后状态仍为 overridden",
      afterE.status === "overridden", "lastState=" + JSON.stringify(afterE));
    t("R8-03-E 接管后 levelOfControl 仍如实记录",
      afterE.levelOfControl === "controlled_by_other_extensions",
      "levelOfControl=" + JSON.stringify(afterE.levelOfControl));
    t("R8-03-E 接管后末次图标仍为红色",
      env.iconCalls[env.iconCalls.length - 1] === "icon-red-16.png",
      "icon 序列=" + JSON.stringify(env.iconCalls));
    t("R8-03-E 接管纠正全程零写回（D-2 只读约束不变）",
      env.setCalls.length - setBeforeE === 0 && env.clearCalls.length - clearBeforeE === 0,
      "新增 set=" + (env.setCalls.length - setBeforeE) + "；新增 clear=" + (env.clearCalls.length - clearBeforeE));
  }
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


  {
    // R7-01-F（本条为独立验证会话补充的可见性断言）：读取失败时，
    //   前台与图标标题都不得断言「代理已被回退/可能已回退直连」。
    //
    //   缺陷背景：b133597 把底层语义修成「读不到 ≠ 用户关掉了代理」，
    //   但同一次失败写下的 status:"error" 会命中两处既有文案：
    //     · popup.js  STATUS_TEXT.error = "代理异常，流量可能已回退直连"
    //     · background.js updateIcon 的 error 标题 = "代理异常，可能已回退直连"
    //   两者都与同一条 message 里的「本次未改动代理」直接矛盾 —— 修复的语义
    //   从 UI 层泄露了回去。
    const env = buildEnv({ fetchDelay: 20 });
    await ready(env, "10808");
    env.setStorageHook((area, keys) => {
      if (area !== "sync") return null;
      const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
      if (ks.length === 1 && ks[0] === "bypassList") return null;
      return { error: { message: "QUOTA_BYTES quota exceeded" }, items: undefined };
    });
    await setSync(env, Object.assign({}, BASE, { proxyPort: "10811" }));
    await drain(env);
    await sleep(300);
    env.closeWindow();

    const stF = env.sessionStore.lastState || {};
    const lastTitleF = env.titleCalls[env.titleCalls.length - 1];

    t("R7-01-F 前置事实：读取失败确实写下了带非空 message 的 error 状态",
      stF.status === "error" && typeof stF.message === "string" && stF.message.length > 0,
      "lastState=" + JSON.stringify(stF));

    // 断言一：图标标题不得断言代理已失效。
    t("R7-01-F 图标标题不得声称代理可能已回退直连（读不到 ≠ 代理没了）",
      !(typeof lastTitleF === "string" && /回退直连|流量可能/.test(lastTitleF)),
      "最后一个标题=" + JSON.stringify(lastTitleF));

    // 断言二：前台状态条文案同样不得断言代理已失效。
    const popupSrcF = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
    const pctxF = { el: { statusBar: { textContent: "", className: "" } }, console: { log: function () {} } };
    vm.createContext(pctxF);
    vm.runInContext(
      popupSrcF.slice(popupSrcF.indexOf("var STATUS_TEXT"), popupSrcF.indexOf("function setStorage")),
      pctxF
    );
    vm.runInContext(
      popupSrcF.slice(popupSrcF.indexOf("function renderStatus"), popupSrcF.indexOf("/* ==================== 连接测试渲染")),
      pctxF
    );
    pctxF.renderStatus(JSON.parse(JSON.stringify(stF)));
    const shownF = pctxF.el.statusBar.textContent;

    t("R7-01-F 前台状态条不得声称代理可能已回退直连",
      !/回退直连|流量可能/.test(shownF),
      "状态条=" + JSON.stringify(shownF));

    // 断言三：文案必须表达「未改动代理」这一真实事实。
    t("R7-01-F 前台状态条须明确说明本次未改动代理",
      /未改动代理|未改动现有代理/.test(shownF),
      "状态条=" + JSON.stringify(shownF));

    // 断言四：真实代理故障路径的既有文案必须保持不变（防误伤）。
    const realFailEnv = buildEnv({ fetchDelay: 20 });
    await ready(realFailEnv, "10808");
    const titlesBeforeReal = realFailEnv.titleCalls.length;
    realFailEnv.setSetHook((cfg, cb) => {
      // 真实下发失败：不是读取失败，而是 set 被 Chrome 拒绝。
      realFailEnv.sandbox.chrome.runtime.lastError = { message: "set 被拒绝（注入）" };
      setTimeout(() => { cb && cb(); realFailEnv.sandbox.chrome.runtime.lastError = null; }, 0);
    });
    await setSync(realFailEnv, Object.assign({}, BASE, { proxyPort: "10988" }));
    await drain(realFailEnv);
    await sleep(300);
    realFailEnv.closeWindow();
    const stReal = realFailEnv.sessionStore.lastState || {};
    t("R7-01-F 防御性确认：真实下发失败路径与读取失败路径是不同现场",
      stReal.status === "error",
      "lastState=" + JSON.stringify(stReal));
    // 反向锁：真实故障路径【必须保留】原有如实文案，防止本次修复把文案改得过宽
    //   （若这里也变成"未改动代理"，就会掩盖真实的代理已失效事实）。
    t("R7-01-F 反向锁：真实故障路径不得被误标为 read_failed",
      stReal.reason !== "read_failed",
      "reason=" + JSON.stringify(stReal.reason));
    const titlesAfterReal = realFailEnv.titleCalls.slice(titlesBeforeReal);
    t("R7-01-F 反向锁：真实故障路径的 error 标题不得声称未改动代理",
      !titlesAfterReal.some(x => typeof x === "string" && /未改动代理/.test(x)),
      "标题序列=" + JSON.stringify(titlesAfterReal));
  }

  console.log("");
  console.log("== R7-03：升级补缺必须按【有效来源】判断绕过列表，不得遮蔽 local 用户列表 ==");
  {
    // 缺陷链路（三段，全部只作用于升级补缺这一处判断）：
    //   ① 遮蔽：超长列表保存时 popup 先写 local.bypassList（用户规则），
    //      再把 sync.bypassList 写成【空串】占位。此后一次升级触发
    //      onInstalled({reason:"update"})，旧实现只看 sync 的
    //      normalizeSettings 结果，把占位空串当成「用户没配」，
    //      于是把默认 6 条写进 sync —— 下发给 chrome.proxy 的绕过列表
    //      变成默认值，用户长列表不再生效。
    //   ② 误改：用户【主动清空】绕过列表（sync 写空串）后升级，同样被改回默认。
    //   ③ 永久删除：sync 被写成默认后，用户打开 popup 看到默认 6 条、
    //      自己的规则不可见；点一次「保存」走短列表分支 →
    //      clearLocalBypassIfAny() 把 local.bypassList 写成空串，
    //      local 无第二份副本，长列表彻底丢失。
    //
    // 断言对象一律是【下发给 chrome.proxy 的真实生效配置】(setConfigs)
    //   与【真实的 chrome.storage.sync / local 内容】，不看内部变量。
    const LONG = Array.from({ length: 450 }, (_, i) => "rule-" + (i + 1) + ".internal.example").join("\n");
    // DEFAULTS 从 settings.js 在独立 vm 中取一次，避免与 env 的状态耦合。
    const sbox = { TextEncoder: TextEncoder };
    sbox.self = sbox; sbox.globalThis = sbox;
    vm.createContext(sbox);
    vm.runInContext(settingsSrc, sbox);
    const DEFAULTS = sbox.EasyProxy.DEFAULTS;

    function fireUpdate(env) {
      for (const fn of env.listeners.installed.slice()) fn({ reason: "update" });
    }
    function lastBypass(env) {
      const cfg = env.setConfigs[env.setConfigs.length - 1];
      return (cfg && cfg.rules && cfg.rules.bypassList) || [];
    }
    function put(env, area, obj) {
      return new Promise(r => env.sandbox.chrome.storage[area].set(obj, r));
    }
    // 降级现场的统一构造：sync 有完整配置，bypassList 取 syncBypass 给定值。
    async function degradedEnv(syncBypass, withKey) {
      const env = buildEnv({ fetchDelay: 20 });
      await drain(env);
      const cfg = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" };
      if (withKey) cfg.bypassList = syncBypass;
      await put(env, "sync", cfg);
      if (typeof syncBypass === "string" && syncBypass) await put(env, "local", { bypassList: syncBypass });
      await drain(env);
      return env;
    }

    // ---- R7-03-A（核心）：降级占位空串 + local 有用户长列表 ----
    {
      const envA = buildEnv({ fetchDelay: 20 });
      await drain(envA);
      await put(envA, "sync", { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "" });
      await put(envA, "local", { bypassList: LONG });
      await drain(envA);
      await sleep(60);
      const beforeA = lastBypass(envA);
      t("R7-03-A 前置事实：降级现场下发的绕过列表是用户的 450 条规则（取值规则本身正常）",
        beforeA.length === 450 && beforeA.indexOf("rule-1.internal.example") >= 0,
        "下发的 bypassList 条数=" + beforeA.length);
      t("R7-03-A 前置事实：sync 里确实是降级占位空串，local 里是用户长列表",
        envA.syncStore.bypassList === "" && envA.localStore.bypassList === LONG,
        "sync=" + JSON.stringify(envA.syncStore.bypassList) + "；local 长度=" + String(envA.localStore.bypassList && envA.localStore.bypassList.length));

      const setsBeforeA = envA.setConfigs.length;
      fireUpdate(envA);
      await drain(envA);
      await sleep(80);
      const afterA = lastBypass(envA);
      t("R7-03-A 升级确实触发了新的下发（否则下面的断言会假阳性）",
        envA.setConfigs.length > setsBeforeA,
        "setConfigs " + setsBeforeA + " -> " + envA.setConfigs.length);
      t("R7-03-A 核心：升级后下发给 chrome.proxy 的 bypassList 仍是用户的 450 条规则（不是默认 6 条）",
        afterA.length === 450 && afterA.indexOf("rule-1.internal.example") >= 0 &&
        afterA.indexOf("192.168.0.0/16") < 0,
        "下发的 bypassList 条数=" + afterA.length + "；前 3 条=" + JSON.stringify(afterA.slice(0, 3)));
      t("R7-03-A 升级后 sync.bypassList 不得被写成默认列表",
        envA.syncStore.bypassList !== DEFAULTS.bypassList,
        "sync.bypassList 长度=" + String(envA.syncStore.bypassList && envA.syncStore.bypassList.length));
      t("R7-03-A 升级后 local.bypassList 必须原封不动（永久丢失的源头）",
        envA.localStore.bypassList === LONG,
        "local 长度=" + String(envA.localStore.bypassList && envA.localStore.bypassList.length));
      envA.closeWindow();
    }

    // ---- R7-03-B：用户【主动清空】（sync 空串、local 也无值） ----
    {
      const envB = await degradedEnv("", true);
      t("R7-03-B 前置事实：sync 为空串且 local 无 bypassList 键（用户主动清空的现场）",
        envB.syncStore.bypassList === "" && !("bypassList" in envB.localStore),
        "sync=" + JSON.stringify(envB.syncStore.bypassList) + "；local=" + JSON.stringify(envB.localStore));
      fireUpdate(envB);
      await drain(envB);
      await sleep(80);
      t("R7-03-B 用户主动清空后，升级不得把默认列表塞回 sync",
        envB.syncStore.bypassList === "",
        "sync.bypassList=" + JSON.stringify(envB.syncStore.bypassList));
      const bypassB = lastBypass(envB);
      t("R7-03-B 用户主动清空后，升级不得把默认列表下发给 chrome.proxy",
        bypassB.length === 0,
        "下发的 bypassList=" + JSON.stringify(bypassB));
      envB.closeWindow();
    }

    // ---- R7-03-C（对照）：sync 键【完全缺失】+ local 有用户长列表 ----
    {
      const envC = buildEnv({ fetchDelay: 20 });
      await drain(envC);
      await put(envC, "sync", { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" });
      await put(envC, "local", { bypassList: LONG });
      await drain(envC);
      await sleep(60);
      t("R7-03-C 前置事实：sync 里确实没有 bypassList 键，local 里有用户长列表",
        !("bypassList" in envC.syncStore) && envC.localStore.bypassList === LONG,
        "sync 键=" + JSON.stringify(Object.keys(envC.syncStore)) + "；local 长度=" + String(envC.localStore.bypassList && envC.localStore.bypassList.length));
      fireUpdate(envC);
      await drain(envC);
      await sleep(80);
      const bypassC = lastBypass(envC);
      t("R7-03-C 对照：sync 键缺失但 local 有用户列表时，升级后下发的仍是用户列表",
        bypassC.length === 450 && bypassC.indexOf("rule-1.internal.example") >= 0,
        "下发的 bypassList 条数=" + bypassC.length);
      t("R7-03-C 对照：sync 键缺失且 local 有值时不得把默认列表写进 sync",
        envC.syncStore.bypassList !== DEFAULTS.bypassList,
        "sync.bypassList=" + JSON.stringify(envC.syncStore.bypassList));
      envC.closeWindow();
    }

    // ---- R7-03-D（防回归）：真正从未配置（sync 与 local 都无）→ 仍要补默认值 ----
    {
      const envD = buildEnv({ fetchDelay: 20 });
      await drain(envD);
      await put(envD, "sync", { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" });
      await drain(envD);
      t("R7-03-D 前置事实：从未配置过 —— sync 无 bypassList 键且 local 也无该键",
        !("bypassList" in envD.syncStore) && !("bypassList" in envD.localStore),
        "sync=" + JSON.stringify(envD.syncStore) + "；local=" + JSON.stringify(envD.localStore));
      fireUpdate(envD);
      await drain(envD);
      await sleep(80);
      t("R7-03-D 从未配置过时，升级补默认值的既有语义仍要生效（防回归）",
        envD.syncStore.bypassList === DEFAULTS.bypassList,
        "sync.bypassList 长度=" + String(envD.syncStore.bypassList && envD.syncStore.bypassList.length));
      const bypassD = lastBypass(envD);
      t("R7-03-D 从未配置过时，补出的默认列表要真正下发到 chrome.proxy",
        bypassD.length === 6 && bypassD.indexOf("192.168.0.0/16") >= 0,
        "下发的 bypassList=" + JSON.stringify(bypassD));
      envD.closeWindow();
    }

    // ---- R7-03-E（防回归）：proxyHost / proxyPort 的空缺补默认值语义不受影响 ----
    {
      const envE = buildEnv({ fetchDelay: 20 });
      await drain(envE);
      await put(envE, "sync", { enableProxy: true, proxyType: "socks5", proxyHost: "", proxyPort: "", bypassList: "example.com" });
      await drain(envE);
      fireUpdate(envE);
      await drain(envE);
      await sleep(80);
      t("R7-03-E proxyHost 空缺时仍补默认值（既有语义不受影响）",
        envE.syncStore.proxyHost === DEFAULTS.proxyHost,
        "proxyHost=" + JSON.stringify(envE.syncStore.proxyHost));
      t("R7-03-E proxyPort 空缺时仍补默认值（既有语义不受影响）",
        envE.syncStore.proxyPort === DEFAULTS.proxyPort,
        "proxyPort=" + JSON.stringify(envE.syncStore.proxyPort));
      t("R7-03-E 用户已填的非空绕过列表不得被改写",
        envE.syncStore.bypassList === "example.com",
        "sync.bypassList=" + JSON.stringify(envE.syncStore.bypassList));
      envE.closeWindow();
    }
  }

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error("EXC: " + (e && e.stack || e)); process.exit(2); });
