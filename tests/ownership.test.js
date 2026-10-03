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
  const listeners = { changed: [], message: [] };
  const setCalls = [];       // setProxy 的发起序列
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
  let setHook = null, clearHook = null;

  function makeArea(store, areaName) {
    return {
      get(keys, cb) {
        const out = {}; const ks = Array.isArray(keys) ? keys : Object.keys(keys || {});
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
          if (Object.keys(changes).length) for (const fn of listeners.changed.slice()) fn(changes, areaName);
        }, 0);
      }
    };
  }
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
    setTimeout(() => cb({ value, levelOfControl: "controlled_by_this_extension" }), 0);
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
        get(o, cb) { getCount++; if (getHook) return getHook(getCount, o, cb, defaultGet); return defaultGet(o, cb); }
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
  return { sandbox, syncStore, localStore, sessionStore, setCalls, clearCalls, timeline, fetchLog, listeners, iconCalls, titleCalls,
    getEffective: () => effective, isProxyActive: () => proxyActive,
    openWindow: () => { windowOpen = true; }, closeWindow: () => { windowOpen = false; },
    onRestoreSet: fn => { onRestoreSet = fn; },
    onClearDuringDirect: fn => { onClearDuringDirect = fn; },
    // 脚本加载时的"未启用"冷启动会 clear 一次 regular，不能让它算作"已经进入过直连阶段"
    resetDirect: () => { directPhaseSeen = false; },
    setGetHook: fn => { getHook = fn; getCount = 0; },
    setSetHook: fn => { setHook = fn; },
    setClearHook: fn => { clearHook = fn; } };
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
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error("EXC: " + (e && e.stack || e)); process.exit(2); });
