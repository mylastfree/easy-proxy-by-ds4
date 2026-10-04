// tests/popup.test.js —— popup 界面护栏（第七轮 R7-08：异常路径必须复位测试按钮）
// 运行：node tests/popup.test.js
//
// 为什么单独成文件：popup.js 此前没有任何测试覆盖。
//   R7-08 的缺陷特征是「异常路径下界面停在中间态」——存储与后台都正常，
//   只有 popup 卡死（两个测试按钮永久 disabled，用户只能关掉重开 popup）。
//   因此这里所有断言的取值对象都是【popup 自己函数运行后 DOM 元素的真实属性值】
//   （disabled / innerHTML），不是内部变量，也不是「调用过某函数」这类间接证据。
//
// 桩的忠实度：
//   · 用 vm 载入 popup.js 与 settings.js 的原文（同 background.test.js / ownership.test.js），
//     不复制实现，避免测试与实现脱节。
//   · 点击一律通过真实监听器派发（el.testButton.click()），不直接调用 runTest ——
//     直接调用会绕过「调用点是否接住返回的 Promise」这一条（R7-08 要求 3）。
//   · B / C / D 场景从【真实 send 包装】进入：改的是 chrome.runtime.sendMessage 桩，
//     由 popup.js 自己那段 new Promise(...) 把异常或回调翻译成 Promise 状态。
//   · A 场景（send 同步抛错）与 E 场景（runTest 自身失败）只能替换全局函数，
//     因为这两类失败发生在 send 包装之外，属于调用点契约本身的一部分。
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
const popupSrc = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

const EXIT_IP = "203.0.113.9";

// 未处理拒绝的收集器：R7-08 的 E2 情形会在控制台留下 Uncaught (in promise)，
//   调用点补 .catch() 之后就应当彻底消失，因此这里按场景逐一断言。
let sink = [];
process.on('unhandledRejection', (reason) => {
  sink.push(String((reason && reason.message) || reason));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// popup.js 真正用到的 DOM 能力清单；多余的一律不提供，避免桩比实现更宽松
function makeEl(id) {
  return {
    id: id,
    disabled: false,
    value: "",
    checked: false,
    innerHTML: "",
    textContent: "",
    className: "",
    children: [],
    _handlers: {},
    addEventListener(type, fn) {
      (this._handlers[type] = this._handlers[type] || []).push(fn);
    },
    click() {
      // 真实派发：监听器抛错或返回拒绝 Promise，都会如实暴露给调用方
      (this._handlers.click || []).slice().forEach(fn => fn({ type: "click" }));
    },
    appendChild(child) { this.children.push(child); }
  };
}

function buildEnv() {
  const els = {};
  const getEl = id => (els[id] = els[id] || makeEl(id));

  // chrome.runtime.sendMessage 桩的行为开关：
  //   mode "ok"    -> 以 resp 回调（可为 null，模拟「无响应」）
  //   mode "throw" -> 同步抛错，由 popup.js 的 send 包装转成 rejected Promise
  const msg = { mode: "ok", resp: null, error: null };
  const calls = [];      // 每次下发的消息（用于确认 click 真的驱动了 runTest）
  let midState = null;   // send 被调用那一刻的界面状态：证明真的进过「测试中…」

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, Error, JSON, Object, Array,
    String, Number, Boolean, Math, Date,
    document: { getElementById: getEl, createElement: tag => makeEl("created:" + tag) },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(m, cb) {
          probe("sendMessage");
          calls[calls.length - 1].message = m;
          if (msg.mode === "throw") throw new Error(msg.error);
          setTimeout(() => cb(msg.resp), 0);
        }
      },
      storage: {
        sync: {
          get: (keys, cb) => setTimeout(() => cb({}), 0),
          set: (obj, cb) => setTimeout(() => cb && cb(), 0)
        },
        local: {
          get: (keys, cb) => setTimeout(() => cb({}), 0),
          set: (obj, cb) => setTimeout(() => cb && cb(), 0)
        },
        onChanged: { addListener() {} }
      }
    }
  };
  // 记录一次「send 即将发生」：此刻界面必须已处于「测试中…」+ 两按钮禁用。
  //   这条中间态证据同时排除了「click 根本没触发 runTest」造成的假绿。
  function probe(tag) {
    calls.push({ tag: tag, message: null });
    midState = {
      tag: tag,
      testDisabled: getEl("testButton").disabled,
      directDisabled: getEl("testDirectButton").disabled,
      html: getEl("testResult").innerHTML
    };
  }

  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.__probe = probe;
  vm.createContext(sandbox);
  vm.runInContext(settingsSrc, sandbox);
  vm.runInContext(popupSrc, sandbox);

  return {
    sandbox, els, msg, calls,
    get midState() { return midState; },
    // 等 popup.js 启动那两段异步（load 的两级回调 + refreshStatus）走完
    ready: () => sleep(30),
    settle: () => sleep(30),
    resetTrace() { calls.length = 0; midState = null; sink = []; },
    setSend(opt) { msg.mode = "ok"; msg.resp = null; msg.error = null; Object.assign(msg, opt); },
    replaceSend(code) { vm.runInContext(code, sandbox); },
    click(id) { getEl(id).click(); },
    unhandled: () => sink
  };
}
function btn(env) {
  return {
    test: env.els.testButton.disabled,
    direct: env.els.testDirectButton.disabled,
    html: env.els.testResult.innerHTML
  };
}

/* ============================================================
   R8-01 专用：popup × background【端到端联动】环境
   ------------------------------------------------------------
   与上面 R7-08 段的分工：那段覆盖「连接测试」的异常路径；
   本段覆盖【读取存储】的异常路径 —— popup.js 此前用
   `void chrome.runtime.lastError;` 把读取失败静默吞掉。

   本段断言的对象全部是【最终事实】，不是 popup 的内部变量：
     · 代理是否仍在生效 —— 由真实 background.js 在收到 storage 变化后
       真正调用 chrome.proxy.settings.set/clear 的结果决定；
     · 存储有没有被写脏 —— 由 chrome.storage.sync/local.set 的调用序列决定；
     · 界面显示了什么 —— 由 popup.js 运行后 DOM 元素的真实属性值决定。

   为此把 popup.js 与 background.js 分别载入【两个 vm 上下文】，
   二者共享同一组 chrome.storage / chrome.proxy 桩（＝同一浏览器状态），
   避免两个脚本在同一全局里互相覆盖同名函数。
   ============================================================ */
const bgSrcForChain = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// chrome.proxy 实际生效配置的形状 -> "scheme host:port"（未生效时为 null）
function proxyTarget(value) {
  const sp = ((value || {}).rules || {}).singleProxy;
  return sp ? (sp.scheme + " " + sp.host + ":" + sp.port) : null;
}

async function waitUntil(fn, ms) {
  const deadline = Date.now() + (ms === undefined ? 800 : ms);
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= deadline) return fn();
    await sleep(5);
  }
}

function buildChainEnv(opts) {
  opts = opts || {};
  const syncStore = Object.assign({}, opts.syncStore || {});
  const localStore = Object.assign({}, opts.localStore || {});
  const sessionStore = {};
  const proxy = { value: null, applied: [], cleared: [] };
  const syncSetCalls = [];          // sync.set 的调用序列（含失败调用，用于「有没有写」）
  const localSetCalls = [];         // local.set 的调用序列
  const storageListeners = [];      // 两个上下文共同注册，等价于同一浏览器里的多个 onChanged 监听
  // 读取失败模式【按上下文隔离】：本任务要隔离的自变量是「popup 读不到」，
  //   而 background 侧照常读到（用户的代理仍在生效）—— 这正是探针的现场形态。
  const modes = {
    popup: { sync: "ok", local: "ok", payload: "undefined" },
    bg: { sync: "ok", local: "ok", payload: "undefined" }
  };
  for (const realm of ["popup", "bg"]) Object.assign(modes[realm], (opts[realm + "Read"] || {}));

  function makeChrome(realm) {
    const api = {
      runtime: {
        lastError: undefined,
        id: "test-extension-id",
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener() {} },
        sendMessage(message, cb) { if (cb) setTimeout(() => cb(null), 0); }
      },
      storage: {},
      proxy: {
        settings: {
          set(o, cb) {
            const label = proxyTarget(o.value);
            setTimeout(() => {
              proxy.value = o.value;
              proxy.applied.push(label);
              api.runtime.lastError = undefined;
              if (cb) cb();
            }, 0);
          },
          clear(o, cb) {
            setTimeout(() => {
              proxy.cleared.push(o.scope);
              if (o.scope === "regular") proxy.value = null;
              api.runtime.lastError = undefined;
              if (cb) cb();
            }, 0);
          },
          get(o, cb) {
            setTimeout(() => cb({
              value: proxy.value || { mode: "system" },
              levelOfControl: proxy.value ? "controlled_by_this_extension" : "controllable_by_this_extension"
            }), 0);
          },
          onChange: { addListener() {} }
        },
        onProxyError: { addListener() {} }
      },
      action: {
        setIcon(o, cb) { if (cb) setTimeout(cb, 0); },
        setTitle(o, cb) { if (cb) setTimeout(cb, 0); }
      }
    };

    function area(name, store) {
      return {
        get(keys, cb) {
          const ks = Array.isArray(keys) ? keys.slice() : Object.keys(keys || {});
          setTimeout(() => {
            if (modes[realm][name] === "fail") {
              // 真实失败契约：回调期间 runtime.lastError 有值，回调返回后清空
              api.runtime.lastError = { message: "storage." + name + " 读取失败（测试注入）" };
              try { cb(modes[realm].payload === "empty" ? {} : undefined); }
              finally { api.runtime.lastError = undefined; }
              return;
            }
            const out = {};
            for (const k of ks) if (k in store) out[k] = store[k];
            cb(out);
          }, 0);
        },
        set(obj, cb) {
          const snapshot = JSON.parse(JSON.stringify(obj));
          if (name === "sync") syncSetCalls.push(snapshot);
          if (name === "local") localSetCalls.push(snapshot);
          const changes = {};
          for (const k of Object.keys(obj)) {
            if (JSON.stringify(store[k]) !== JSON.stringify(obj[k])) {
              changes[k] = { oldValue: store[k], newValue: obj[k] };
            }
            store[k] = obj[k];
          }
          setTimeout(() => {
            if (cb) cb();
            if (Object.keys(changes).length) {
              for (const fn of storageListeners.slice()) fn(changes, name);
            }
          }, 0);
        }
      };
    }

    api.storage.sync = area("sync", syncStore);
    api.storage.local = area("local", localStore);
    api.storage.session = area("session", sessionStore);
    api.storage.onChanged = { addListener(fn) { storageListeners.push(fn); } };
    return api;
  }

  const els = {};
  const getEl = id => (els[id] = els[id] || makeEl(id));

  const popupCtx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, Error, JSON, Object, Array,
    String, Number, Boolean, Math, Date, TextEncoder,
    document: { getElementById: getEl, createElement: tag => makeEl("created:" + tag) }
  };
  const bgCtx = {
    console: { log() {}, warn() {}, error() {} },
    TextEncoder, setTimeout, clearTimeout, Date, Promise, Object, Array, JSON,
    Number, String, Math, Boolean, Error, AbortController,
    fetch: () => Promise.reject(new Error("chain env 未提供 fetch 桩"))
  };
  bgCtx.importScripts = () => vm.runInContext(settingsSrc, bgCtx);

  popupCtx.chrome = makeChrome("popup");
  bgCtx.chrome = makeChrome("bg");
  popupCtx.self = popupCtx; popupCtx.window = popupCtx; popupCtx.globalThis = popupCtx;
  bgCtx.self = bgCtx; bgCtx.globalThis = bgCtx;

  vm.createContext(popupCtx);
  vm.createContext(bgCtx);
  vm.runInContext(settingsSrc, popupCtx);
  vm.runInContext(popupSrc, popupCtx);
  vm.runInContext(bgSrcForChain, bgCtx);

  return {
    els, popupCtx, bgCtx, proxy, syncStore, localStore, syncSetCalls, localSetCalls,
    readMode(realm, area, m) { modes[realm][area] = m; },
    readPayload(realm, kind) { modes[realm].payload = kind; },
    reload() { popupCtx.load(); },
    click(id) { getEl(id).click(); },
    hint: () => getEl("hint").textContent,
    settle: ms => sleep(ms === undefined ? 40 : ms),
    waitUntil
  };
}
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

(async function main() {
  console.log("== R7-08-A：send 同步抛错 —— 按钮必须复位，且如实显示失败原因 ==");
  {
    const env = buildEnv();
    await env.ready();
    env.resetTrace();
    // send 同步抛错只能发生在 popup 的 send 包装之外，因此这里替换全局 send
    env.replaceSend('send = function () { __probe("send-throw"); throw new Error("消息通道故障：send 同步抛错"); };');
    env.click("testButton");
    await env.settle();
    const st = btn(env);
    const mid = env.midState;
    t("A-中间态：两个按钮确实先被禁用（证明走的是真实 runTest 路径）",
      !!mid && mid.testDisabled === true && mid.directDisabled === true,
      JSON.stringify(mid));
    t("A-中间态：文案是「测试中…」",
      !!mid && mid.html.indexOf("测试中") >= 0, mid && mid.html);
    t("A-终态：testButton.disabled === false", st.test === false, "实际 " + st.test);
    t("A-终态：testDirectButton.disabled === false", st.direct === false, "实际 " + st.direct);
    t("A-终态：显示「测试失败」且带真实原因",
      st.html.indexOf("测试失败") >= 0 && st.html.indexOf("send 同步抛错") >= 0, st.html);
    t("A-终态：不再停留在「测试中…」", st.html.indexOf("测试中") < 0, st.html);
    t("A-终态：没有泄漏未处理拒绝", env.unhandled().length === 0,
      JSON.stringify(env.unhandled()));
  }

  console.log("");
  console.log("== R7-08-B：send 返回 rejected Promise（真实包装路径）—— 同上 ==");
  {
    const env = buildEnv();
    await env.ready();
    env.resetTrace();
    env.setSend({ mode: "throw", error: "runtime 消息通道不可用" });
    env.click("testDirectButton");
    await env.settle();
    const st = btn(env);
    const mid = env.midState;
    t("B-中间态：两个按钮确实先被禁用",
      !!mid && mid.testDisabled === true && mid.directDisabled === true,
      JSON.stringify(mid));
    t("B-中间态：compare 文案含「对比期间会短暂切换为直连」",
      !!mid && mid.html.indexOf("对比期间会短暂切换为直连") >= 0, mid && mid.html);
    t("B-终态：testButton.disabled === false", st.test === false, "实际 " + st.test);
    t("B-终态：testDirectButton.disabled === false", st.direct === false, "实际 " + st.direct);
    t("B-终态：显示「测试失败」且带真实原因",
      st.html.indexOf("测试失败") >= 0 && st.html.indexOf("runtime 消息通道不可用") >= 0, st.html);
    t("B-终态：没有泄漏未处理拒绝（原「Uncaught (in promise)」已消除）",
      env.unhandled().length === 0, JSON.stringify(env.unhandled()));
  }

  console.log("");
  console.log("== R7-08-C：正常返回 {ok:false} 与「无响应」—— 既有失败语义不得改变 ==");
  {
    const env = buildEnv();
    await env.ready();
    env.resetTrace();
    env.setSend({ mode: "ok", resp: { ok: false, error: "PROXY-ERROR-503" } });
    env.click("testButton");
    await env.settle();
    const st = btn(env);
    t("C-终态：testButton.disabled === false", st.test === false, "实际 " + st.test);
    t("C-终态：testDirectButton.disabled === false", st.direct === false, "实际 " + st.direct);
    t("C-终态：显示「测试失败：PROXY-ERROR-503」",
      st.html.indexOf("测试失败：PROXY-ERROR-503") >= 0, st.html);
    t("C-终态：不再停留在「测试中…」", st.html.indexOf("测试中") < 0, st.html);
    t("C-终态：没有泄漏未处理拒绝", env.unhandled().length === 0, JSON.stringify(env.unhandled()));

    // 同一入口的第二种既有失败语义：回调 null（无响应）
    env.resetTrace();
    env.setSend({ mode: "ok", resp: null });
    env.click("testButton");
    await env.settle();
    const st2 = btn(env);
    t("C2-终态：回调 null 时按钮仍复位",
      st2.test === false && st2.direct === false,
      "test=" + st2.test + " direct=" + st2.direct);
    t("C2-终态：显示「测试失败：无响应」",
      st2.html.indexOf("测试失败：无响应") >= 0, st2.html);
  }

  console.log("");
  console.log("== R7-08-D：正常返回 {ok:true,result} —— 既有渲染语义不得改变 ==");
  {
    const env = buildEnv();
    await env.ready();
    env.resetTrace();
    env.setSend({
      mode: "ok",
      resp: {
        ok: true,
        result: {
          exit: { ok: true, ip: EXIT_IP, city: "Test", region: "Test", country: "ZZ", org: "TEST-ORG" },
          settings: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" },
          activeMode: "fixed_servers"
        }
      }
    });
    env.click("testDirectButton");
    await env.settle();
    const st = btn(env);
    t("D-终态：testButton.disabled === false", st.test === false, "实际 " + st.test);
    t("D-终态：testDirectButton.disabled === false", st.direct === false, "实际 " + st.direct);
    t("D-终态：渲染出「当前出口」与出口 IP",
      st.html.indexOf("当前出口") >= 0 && st.html.indexOf(EXIT_IP) >= 0, st.html);
    t("D-终态：渲染出代理配置", st.html.indexOf("socks5 127.0.0.1:10808") >= 0, st.html);
    t("D-终态：给出成功档结论（未被失败文案覆盖）",
      st.html.indexOf("当前出口已获取") >= 0 && st.html.indexOf("测试失败") < 0, st.html);
    t("D-终态：不再停留在「测试中…」", st.html.indexOf("测试中") < 0, st.html);
    t("D-终态：没有泄漏未处理拒绝", env.unhandled().length === 0, JSON.stringify(env.unhandled()));
  }

  console.log("");
  console.log("== R7-08-E：runTest 自身失败 —— 调用点必须接住，不得泄漏未处理拒绝 ==");
  {
    const env = buildEnv();
    await env.ready();
    env.resetTrace();
    // 还原后 runTest 已内聚处理异常；这里刻意把它换成会拒绝的实现，
    //   用来验证 click 调用点自身的 .catch() 确实存在（否则 R7-08 要求 3 无护栏）。
    env.replaceSend('runTest = function () { return Promise.reject(new Error("runTest 自身失败")); };');
    env.click("testButton");
    await env.settle();
    t("E-终态：click 调用点接住了 runTest 的失败，无未处理拒绝",
      env.unhandled().length === 0, JSON.stringify(env.unhandled()));
  }


  /* ============================================================
     R8-01：popup.js 存储读取失败不得被静默吞掉
     缺陷：load() 里「void chrome.runtime.lastError;」只抑制告警、不产生分支，
       读不到 → normalizeSettings 填默认值（enableProxy:false）→ 表单显示「未勾选」
       → 用户点一次保存把 enableProxy:false 写回 sync → 后台 clearProxyScope("regular")
       → 浏览器里仍在生效的代理被真清除，界面却只说「设置已保存」。
     ============================================================ */

  console.log("");
  console.log("== R8-01-A：sync 读取失败 —— 不得把默认值当作真实配置渲染 ==");
  {
    const env = buildChainEnv({
      // 刻意取【非默认值】：若读失败后渲染的是 normalizeSettings 的默认值，
      //   host/port 会变成 127.0.0.1 / 10808，与真实值 10.20.30.40 / 10809 可区分。
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "10.20.30.40", proxyPort: "10809", bypassList: "example.com" },
      localStore: {}
    });
    // 真实先后顺序：用户的代理【已经生效】（上一次保存成功下发过）
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 10.20.30.40:10809");
    t("A-前置：代理已按用户设置生效（10.20.30.40:10809）",
      proxyTarget(env.proxy.value) === "socks5 10.20.30.40:10809",
      "实际 = " + proxyTarget(env.proxy.value));

    // 注入：sync.get 失败（回调置 lastError，payload = undefined）
    env.readMode("popup", "sync", "fail");
    env.readPayload("popup", "undefined");
    env.syncSetCalls.length = 0; env.localSetCalls.length = 0;
    env.reload();
    await env.settle();

    t("A-1：开关【不呈现为未勾选】，而是「不确定」态（indeterminate）",
      env.els.enableProxy.indeterminate === true,
      "indeterminate=" + env.els.enableProxy.indeterminate + " checked=" + env.els.enableProxy.checked);
    t("A-2：读取失败时表单不可编辑（开关被禁用）",
      env.els.enableProxy.disabled === true, "disabled=" + env.els.enableProxy.disabled);
    t("A-3：没有用默认值填充表单（host 既不是默认 127.0.0.1，也不是真实值 10.20.30.40）",
      env.els.proxyHost.value !== "127.0.0.1" && env.els.proxyHost.value !== "10.20.30.40",
      "host=" + JSON.stringify(env.els.proxyHost.value));
    t("A-4：也没有用默认端口/默认绕过列表填充表单",
      env.els.proxyPort.value !== "10808" && env.els.proxyPort.value !== "10809" &&
      env.els.bypassList.value.indexOf("192.168.0.0/16") < 0 && env.els.bypassList.value !== "example.com",
      "port=" + JSON.stringify(env.els.proxyPort.value) + " bypassLen=" + env.els.bypassList.value.length);
    t("A-5：界面明确提示「读取设置失败」",
      env.hint().indexOf("读取设置失败") >= 0, JSON.stringify(env.hint()));
    t("A-6：提示里给出了恢复办法（重新打开弹窗）",
      env.hint().indexOf("重新打开弹窗") >= 0, JSON.stringify(env.hint()));

    // 另一种真实失败形态：回调 payload 是空对象 {}，但 lastError 有值
    await env.settle();
    env.readPayload("popup", "empty");
    env.reload();
    await env.settle();
    t("A-7：payload 为空对象但 lastError 有值时同样判为失败",
      env.els.proxyHost.value !== "127.0.0.1" && env.els.proxyHost.value !== "10.20.30.40" &&
      env.hint().indexOf("读取设置失败") >= 0,
      "host=" + JSON.stringify(env.els.proxyHost.value) + " hint=" + JSON.stringify(env.hint()));

    // 恢复路径：存储恢复后，再次 load（onChanged / 重新打开弹窗）必须回到正常
    env.readMode("popup", "sync", "ok");
    env.reload();
    await env.settle();
    t("A-8：读取恢复后，界面恢复为用户的真实设置（enableProxy=true，10.20.30.40:10809）",
      env.els.enableProxy.checked === true && env.els.enableProxy.indeterminate === false &&
      env.els.proxyHost.value === "10.20.30.40" && env.els.proxyPort.value === "10809",
      JSON.stringify([env.els.enableProxy.checked, env.els.enableProxy.indeterminate, env.els.proxyHost.value, env.els.proxyPort.value]));
    t("A-9：读取恢复后表单重新可编辑，提示不再报读取失败",
      env.els.enableProxy.disabled === false && env.hint().indexOf("读取设置失败") < 0,
      "disabled=" + env.els.enableProxy.disabled + " hint=" + JSON.stringify(env.hint()));
  }

  console.log("");
  console.log("== R8-01-B：读取失败状态下点保存 —— 必须拒绝写入 ==");
  {
    const env = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: {}
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");

    env.readMode("popup", "sync", "fail");
    env.reload();
    await env.settle();
    env.syncSetCalls.length = 0; env.localSetCalls.length = 0;

    env.click("saveButton");     // 桩照常派发 click：即便按钮被禁用，也骗不过 save() 自身的守卫
    await env.settle(120);

    t("B-1：sync.set 调用次数为 0（没有把任何内容写回）",
      env.syncSetCalls.length === 0, JSON.stringify(env.syncSetCalls));
    t("B-2：local.set 调用次数为 0",
      env.localSetCalls.length === 0, JSON.stringify(env.localSetCalls));
    t("B-3：存储内容未被改动（仍是用户的真实配置）",
      env.syncStore.enableProxy === true && env.syncStore.proxyPort === "10808",
      "enableProxy=" + env.syncStore.enableProxy + " port=" + env.syncStore.proxyPort);
    t("B-4：给出明确的「禁止保存」提示",
      env.hint().indexOf("禁止保存") >= 0, JSON.stringify(env.hint()));
    t("B-5：保存按钮也处于禁用态（双保险）",
      env.els.saveButton.disabled === true, "disabled=" + env.els.saveButton.disabled);
  }

  console.log("");
  console.log("== R8-01-C：完整破坏链 —— 读取失败 + 点保存，代理必须仍然生效 ==");
  {
    const env = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "10.20.30.40", proxyPort: "10809", bypassList: "example.com" },
      localStore: {}
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 10.20.30.40:10809");
    env.readMode("popup", "sync", "fail");
    env.reload();
    await env.settle();
    // 存储随后恢复（那次读取失败只是偶发），用户此时以为「界面显示的就是我的设置」，
    // 于是点了一次「保存设置」——这正是探针 POPUP_READ_FAILURE_THEN_SAVE 的先后顺序。
    env.readMode("popup", "sync", "ok");
    env.click("saveButton");
    await env.settle(120);

    t("C-1：chrome.proxy 实际生效配置仍是我方的 socks5 10.20.30.40:10809",
      proxyTarget(env.proxy.value) === "socks5 10.20.30.40:10809",
      "实际生效 = " + proxyTarget(env.proxy.value));
    t("C-2：clearProxyScope 调用次数为 0（没有清掉 regular 作用域）",
      env.proxy.cleared.filter(s => s === "regular").length === 0,
      JSON.stringify(env.proxy.cleared));
    t("C-3：chrome.proxy.settings.set 未被再次写入（也没有多余下发）",
      env.proxy.applied.length === 1, JSON.stringify(env.proxy.applied));
    t("C-4：存储里的 enableProxy 仍是 true（没有被默认值覆盖）",
      env.syncStore.enableProxy === true, "enableProxy=" + env.syncStore.enableProxy);
    t("C-5：界面提示的是读取失败/禁止保存，而不是「设置已保存」",
      env.hint().indexOf("设置已保存") < 0 && env.hint().indexOf("禁止保存") >= 0,
      JSON.stringify(env.hint()));
  }

  console.log("");
  console.log("== R8-01-D：local（bypassList）读取失败 —— 不得触发对 local 的清除写入 ==");
  {
    const LONG_LIST = Array.from({ length: 60 }, (_, i) => "long-" + i + ".internal.example.com").join("\n");
    const env = buildChainEnv({
      // sync 里是空串占位：说明用户的长列表被降级存放在 local（R7-03 的形态）
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "" },
      localStore: { bypassList: LONG_LIST }
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");

    env.readMode("popup", "local", "fail");
    env.reload();
    await env.settle();
    const afterLoad = env.els.bypassList.value;
    t("D-1：local 读取失败时不把「读不到」当成「用户没有列表」（不显示内置默认列表）",
      afterLoad.indexOf("192.168.0.0/16") < 0, JSON.stringify(afterLoad.slice(0, 60)));

    // 用户在以为界面可信的情况下点保存；此刻 local 读取恢复正常
    env.readMode("popup", "local", "ok");
    env.syncSetCalls.length = 0; env.localSetCalls.length = 0;
    env.click("saveButton");
    await env.settle(140);

    const clearedLocal = env.localSetCalls.some(o => o && o.bypassList === "");
    t("D-2：local.set 中没有把 bypassList 写成空串（用户的列表没有被清除）",
      !clearedLocal, JSON.stringify(env.localSetCalls));
    t("D-3：local 存储里的长列表原封不动",
      env.localStore.bypassList === LONG_LIST,
      "长度=" + String(env.localStore.bypassList).length + " 期望=" + LONG_LIST.length);
    t("D-4：界面提示读取失败，用户不会以为「列表已丢失」",
      env.hint().indexOf("读取设置失败") >= 0, JSON.stringify(env.hint()));

    // D-5 起（防回归）：load 成功之后、保存之前 local 读取才失败 ——
    //   此时表单可信、保存被允许，路径会真正走到 clearLocalBypassIfAny，
    //   由它自己的 lastError 守卫挡住「读不到 → 当成没有列表 → 清空」。
    //   没有这一段，那行守卫就只靠「保存被拦」间接保护，缺少直接证据。
    const env2 = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "10.20.30.40", proxyPort: "10809", bypassList: "example.com" },
      localStore: { bypassList: "keep-me.internal" }
    });
    await waitUntil(() => proxyTarget(env2.proxy.value) === "socks5 10.20.30.40:10809");
    t("D-5 前置：读取正常，表单可信（保存不会被拦）",
      env2.els.proxyHost.value === "10.20.30.40" && env2.els.saveButton.disabled === false,
      JSON.stringify([env2.els.proxyHost.value, env2.els.saveButton.disabled]));

    env2.readMode("popup", "local", "fail");   // 保存那一刻 local 读取失败
    env2.syncSetCalls.length = 0; env2.localSetCalls.length = 0;
    env2.click("saveButton");
    await env2.settle(140);

    t("D-6：保存本身被允许（证明路径确实到达 clearLocalBypassIfAny）",
      env2.syncSetCalls.length === 1, JSON.stringify(env2.syncSetCalls));
    t("D-7：clearLocalBypassIfAny 读取失败时不得把列表写成空串",
      !env2.localSetCalls.some(o => o && o.bypassList === "") &&
      env2.localStore.bypassList === "keep-me.internal",
      JSON.stringify([env2.localSetCalls, env2.localStore.bypassList]));
  }

  console.log("");
  console.log("== R8-01-E：读取正常时既有语义不得改变（保存仍然写 sync 并真实下发）==");
  {
    const env = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: {}
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");

    t("E-1：读取正常时表单渲染为用户的真实设置",
      env.els.enableProxy.checked === true && env.els.enableProxy.disabled === false &&
      env.els.proxyHost.value === "127.0.0.1" && env.els.proxyPort.value === "10808" &&
      env.els.bypassList.value === "example.com",
      JSON.stringify([env.els.enableProxy.checked, env.els.proxyHost.value, env.els.proxyPort.value, env.els.bypassList.value]));

    // 界面上改动端口后保存：必须写 sync 并触发一次真实下发
    env.els.proxyPort.value = "10809";
    env.syncSetCalls.length = 0; env.localSetCalls.length = 0;
    env.click("saveButton");
    await env.settle(40);
    t("E-2：保存写入了 sync，且 enableProxy 仍为 true（没有被修复误伤）",
      env.syncSetCalls.length === 1 && env.syncSetCalls[0].enableProxy === true &&
      env.syncSetCalls[0].proxyPort === "10809",
      JSON.stringify(env.syncSetCalls));
    t("E-3：保存提示是「设置已保存」",
      env.hint().indexOf("设置已保存") >= 0, JSON.stringify(env.hint()));

    const applied = await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10809");
    t("E-4：后台收到存储变化后真实下发到 chrome.proxy（127.0.0.1:10809）",
      applied, "实际生效 = " + proxyTarget(env.proxy.value));
    t("E-5：全程没有清除过 regular 作用域",
      env.proxy.cleared.filter(s => s === "regular").length === 0, JSON.stringify(env.proxy.cleared));

    // 超长绕过列表的降级语义（既有行为）不得改变
    const HUGE = Array.from({ length: 400 }, (_, i) => "very-long-domain-name-" + i + ".internal.example.com").join("\n");
    env.els.bypassList.value = HUGE;
    env.syncSetCalls.length = 0; env.localSetCalls.length = 0;
    env.click("saveButton");
    await env.settle(60);
    t("E-6：超长列表仍降级存 local，且 sync 里的 bypassList 写成空串占位",
      env.localSetCalls.some(o => o.bypassList === HUGE) &&
      env.syncSetCalls.some(o => o.bypassList === ""),
      JSON.stringify([env.localSetCalls.map(o => String(o.bypassList).length), env.syncSetCalls.map(o => String(o.bypassList).length)]));
    t("E-7：降级保存的提示语保持原样",
      env.hint().indexOf("已存于本地") >= 0, JSON.stringify(env.hint()));
  }

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
