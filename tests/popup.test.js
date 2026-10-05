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
// 【L-08】诊断快照里含 `chrome.runtime.getManifest().version`，桩必须提供真实版本，
//   否则 background 的 getDiagnostics 分支会抛 TypeError（真实 SW 里该 API 恒存在）。
const manifestVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')).version;

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
  vm.runInContext(settingsSrc, sandbox, { filename: path.join(__dirname, '..', 'settings.js') });
  vm.runInContext(popupSrc, sandbox, { filename: path.join(__dirname, '..', 'popup.js') });

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
  // 【R8-04】popup 侧注册的消息处理器：本环境里 background.js 跑在【另一个 vm 上下文】，
  //   它的 chrome.runtime.onMessage.addListener 注册不到 popup 的 chrome 桩上，
  //   于是 popup.js 的 getStatus 请求过去只会拿到 null（连不上后台）；
  //   而本任务要覆盖的恰恰是「后台确实回答了，但回答的内容是读取失败」。
  //   因此把 popup 的 sendMessage 直接接到【真实 background.js 的监听器】上，
  //   由其 onMessage 处理器经 sendResponse 回调把响应送回来 —— 走的是产品里
  //   真实的那段回调代码。
  const msgHandlers = [];
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
        // 【L-08】getDiagnostics 会读版本号；桩返回真实 manifest 版本。
        getManifest() { return { version: manifestVersion }; },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener(fn) { msgHandlers.push(fn); } },
        sendMessage(message, cb) {
          // 真实链路：popup 发出 getStatus → background.js 从 session 里取 lastState
          //   → 后台经 sendResponse 异步回答。回调期间若读取失败，popup 这段回调里
          //   看到的 chrome.runtime.lastError 就是后台侧注入的那一个。
          if (realm !== "popup" || !cb) { if (cb) setTimeout(() => cb(null), 0); return; }
          setTimeout(() => {
            for (const fn of msgHandlers.slice()) {
              let answered = false;
              const r = fn(message, { id: "test-extension-id" }, function (v) {
                answered = true;
                if (!v) { cb(null); return; }
                try { cb(v); } finally { api.runtime.lastError = undefined; }
              });
              if (r === true) return;              // 后台异步回答（getStatus 分支正是如此）
              if (!answered) cb(null);
            }
          }, 0);
        }
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
          // 【R9-01 门禁】定向失败注入：允许测试只阻断某一类写入（例如后台自愈写下的
          //   {bypassList:""}），从而把「存量污染现场」稳定固定到保存之前，用例因此
          //   不依赖任何挂钟时序。失败契约必须与真实一致：不写 store、不派 onChanged、
          //   且 lastError 只在回调期间存在。
          if (typeof opts.setFilter === "function") {
            const reason = opts.setFilter(realm, name, obj);
            if (reason) {
              setTimeout(() => {
                api.runtime.lastError = { message: typeof reason === "string" ? reason : "storage.set 失败（测试注入）" };
                try { if (cb) cb(); } finally { api.runtime.lastError = undefined; }
              }, 0);
              return;
            }
          }
          // 【第 3 条·审计修复】静默丢弃注入：写入【回调成功】、不置 lastError、也不派发
          //   onChanged，但值没有落地 —— 真实存储层在配额边界 / 并发写回 / 内部异常时
          //   可能出现这种形态（"回调成功 ≠ 值真的可读回"）。
          //   它专门用来证明本次修复新增的「切换引用之前回读确证」这一层是承重的：
          //   删掉确证层，代码就会带着未落地的值去写 sync 占位串，把生效值清成空
          //   （正是本条要消灭的丢数据路径）。
          if (typeof opts.setDrop === "function" && opts.setDrop(realm, name, obj)) {
            setTimeout(() => { if (cb) cb(); }, 0);
            return;
          }
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
        },
        // 【S2】background.js 的 clearPendingRestore 使用 session.remove：
        //   联动环境下后台代码同样会走到窗口 finally，缺桩会抛 TypeError。
        remove(keys, cb) {
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) delete store[k];
          setTimeout(() => { if (cb) cb(); }, 0);
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
  bgCtx.importScripts = () => vm.runInContext(settingsSrc, bgCtx, { filename: path.join(__dirname, '..', 'settings.js') });

  popupCtx.chrome = makeChrome("popup");
  bgCtx.chrome = makeChrome("bg");
  popupCtx.self = popupCtx; popupCtx.window = popupCtx; popupCtx.globalThis = popupCtx;
  bgCtx.self = bgCtx; bgCtx.globalThis = bgCtx;

  vm.createContext(popupCtx);
  vm.createContext(bgCtx);
  vm.runInContext(settingsSrc, popupCtx, { filename: path.join(__dirname, '..', 'settings.js') });
  vm.runInContext(popupSrc, popupCtx, { filename: path.join(__dirname, '..', 'popup.js') });
  vm.runInContext(bgSrcForChain, bgCtx, { filename: path.join(__dirname, '..', 'background.js') });

  return {
    els, popupCtx, bgCtx, proxy, syncStore, localStore, sessionStore, syncSetCalls, localSetCalls,
    // 直接改 session 存储，模拟「上一次下发时写下的真实状态」（真实产品里写于 background.js）
    setSessionState(obj) {
      const changes = {};
      for (const k of Object.keys(obj)) { changes[k] = { newValue: obj[k] }; sessionStore[k] = obj[k]; }
      for (const fn of storageListeners.slice()) fn(changes, "session");
    },
    readMode(realm, area, m) { modes[realm][area] = m; },
    readPayload(realm, kind) { modes[realm].payload = kind; },
    reload() { popupCtx.load(); },
    // 「用户重新打开弹窗」：等价于重新执行 popup.js 末尾的那两个真实入口
    //   （load() 填表单 + refreshStatus() 取状态）。reload() 只跑前者，
    //   用来单独验证表单；凡是状态条的现场都必须走这一条。
    reopen() { popupCtx.load(); popupCtx.refreshStatus(); },
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
    env.reopen();
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
    env.reopen();
    await env.settle();
    t("A-7：payload 为空对象但 lastError 有值时同样判为失败",
      env.els.proxyHost.value !== "127.0.0.1" && env.els.proxyHost.value !== "10.20.30.40" &&
      env.hint().indexOf("读取设置失败") >= 0,
      "host=" + JSON.stringify(env.els.proxyHost.value) + " hint=" + JSON.stringify(env.hint()));

    // 恢复路径：存储恢复后，再次 load（onChanged / 重新打开弹窗）必须回到正常
    env.readMode("popup", "sync", "ok");
    env.reopen();
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
    env.reopen();
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
    env.reopen();
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
    env.reopen();
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
  console.log("== R8-02-B：污染状态下用户「打开 popup 不编辑 + 点一次保存」不得永久删除 local 里的用户长列表 ==");
  {
    // 与 ownership.test.js 的 R8-02-A 同一污染形态：sync 被更早版本写成了【系统内置默认列表】，
    //   用户真正的长列表只在 local。popup 的取值规则是「sync 非空优先」，于是界面显示默认 6 条，
    //   用户的规则完全不可见；用户什么都没改、只点一次「保存」，就走短列表分支把默认列表写回
    //   sync，随后 clearLocalBypassIfAny() 把 local 写成空串 —— local 没有第二份副本，
    //   长列表【永久丢失】。全过程没有任何 lastError（不是读取失败问题，R8-01 覆盖不到）。
    //
    // 这里断言的对象是【真实存储内容】（localStore 与 localSetCalls 的实参），
    //   不是「某函数被调用」这类间接证据 —— 丢数据这件事只能从存储本身体现。
    const sboxB = { TextEncoder: TextEncoder };
    sboxB.self = sboxB; sboxB.globalThis = sboxB;
    vm.createContext(sboxB);
    vm.runInContext(settingsSrc, sboxB, { filename: path.join(__dirname, '..', 'settings.js') });
    const DEFAULTS_B = sboxB.EasyProxy.DEFAULTS;
    const LONG_B = Array.from({ length: 950 }, (_, i) => "legacy-" + (i + 1) + ".internal.example").join("\n");

    const env = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: DEFAULTS_B.bypassList },
      localStore: { bypassList: LONG_B }
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
    await env.settle(60);

    // 【R9-01 契约更新】污染组合现在会在后台的存储变化周期内自愈（sync 恢复空串占位），
    //   于是界面显示的是【用户自己的 950 条规则】而不是被遮蔽的默认 6 条。
    //   原断言把"界面显示默认值"当作前置事实，修复后必然失败；那正是本修复要消除的状态。
    //   数据保全语义（local 不被清空）由下面的 B-2/B-4/B-5 继续覆盖。
    t("B-1 前置事实（已更新）：自愈后界面显示的是用户自己的 950 条规则（不再被默认列表遮蔽）",
      env.els.bypassList.value === LONG_B,
      "界面条数=" + String(env.els.bypassList.value || "").split(String.fromCharCode(10)).length + " 期望 950");
    t("B-2 前置事实：local 里是用户的 950 条长列表",
      env.localStore.bypassList === LONG_B,
      "local 条数=" + String(env.localStore.bypassList || "").split("\n").length);

    env.syncSetCalls.length = 0; env.localSetCalls.length = 0;
    env.click("saveButton");            // 用户没有编辑任何内容，只点了一次「保存」
    await env.settle(140);

    t("B-3 保存确实写入了 sync（证明路径真的走到了 clearLocalBypassIfAny）",
      env.syncSetCalls.length === 1,
      "sync.set 次数=" + env.syncSetCalls.length);
    t("B-4 核心：一次普通保存后 local.bypassList 未被写成空串（断言真实存储内容）",
      env.localStore.bypassList === LONG_B,
      "local 条数=" + String(env.localStore.bypassList || "").split("\n").length + " 期望 950");
    t("B-5 核心：local.set 的调用序列里没有任何一次把 bypassList 写成空串",
      !env.localSetCalls.some(o => o && o.bypassList === ""),
      JSON.stringify(env.localSetCalls.map(o => String(o && o.bypassList).length)));
  }

  console.log("");
  console.log("== R8-02-C：正常用户保存时清理 local 的既有语义必须保留（不许把清理功能整个关掉）==");
  {
    // 防回归（关键）：R8-02-B 的护栏是「保存进 sync 的列表逐字符等于默认列表 → 不清 local」。
    //   若把它写成「一律不清」，长列表确实不会被误删，但清理功能本身被废掉：
    //   用户从超长列表改回短列表后，local 里那份过期副本会永远留下，
    //   而 resolveBypassList 在 sync 为空时【回退 local】—— 用户下次清空绕过列表时，
    //   早就该消失的旧规则会重新生效。因此必须证明「该清的仍然清」。
    const sboxC = { TextEncoder: TextEncoder };
    sboxC.self = sboxC; sboxC.globalThis = sboxC;
    vm.createContext(sboxC);
    vm.runInContext(settingsSrc, sboxC, { filename: path.join(__dirname, '..', 'settings.js') });
    const DEFAULTS_C = sboxC.EasyProxy.DEFAULTS;

    // C-1：sync 是用户自己写的短列表（逐字符 ≠ 默认列表），local 里残留着一份过期副本 ——
    //   这一次保存必须把 local 清掉。
    const envC = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: { bypassList: "stale-from-previous-degrade.internal" }
    });
    await waitUntil(() => proxyTarget(envC.proxy.value) === "socks5 127.0.0.1:10808");
    await envC.settle(60);
    t("C-1 前置事实：sync 是用户自己写的短列表，local 里残留着一份过期副本",
      envC.els.bypassList.value === "example.com" &&
      envC.localStore.bypassList === "stale-from-previous-degrade.internal",
      JSON.stringify([envC.els.bypassList.value, envC.localStore.bypassList]));
    t("C-2 前置事实：用户自己写的短列表逐字符不等于内置默认列表",
      "example.com" !== DEFAULTS_C.bypassList, "默认长度=" + DEFAULTS_C.bypassList.length);

    envC.syncSetCalls.length = 0; envC.localSetCalls.length = 0;
    envC.click("saveButton");
    await envC.settle(140);

    t("C-3 关键：正常用户保存时 local 的过期副本仍被清成空串（该清的仍清）",
      envC.localStore.bypassList === "",
      JSON.stringify(envC.localStore.bypassList));
    t("C-4 关键：确实发生了一次 local.set({bypassList: \"\"})",
      envC.localSetCalls.some(o => o && o.bypassList === ""),
      JSON.stringify(envC.localSetCalls.map(o => String(o && o.bypassList).length)));
    t("C-5 保存写入的仍是用户自己写的短列表（未被默认列表覆盖）",
      envC.syncSetCalls.length === 1 && envC.syncSetCalls[0].bypassList === "example.com",
      JSON.stringify(envC.syncSetCalls.map(o => o.bypassList)));

    // C-6：local 本来就为空（题述的正常用户现场）→ 保存不得产生多余的 local 写入。
    const envD = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: {}
    });
    await waitUntil(() => proxyTarget(envD.proxy.value) === "socks5 127.0.0.1:10808");
    await envD.settle(60);
    envD.syncSetCalls.length = 0; envD.localSetCalls.length = 0;
    envD.click("saveButton");
    await envD.settle(140);
    t("C-6 local 本来就为空时不产生多余的 local 写入（空 → 空 的伪变化）",
      envD.localSetCalls.length === 0 && envD.syncSetCalls.length === 1,
      JSON.stringify([envD.localSetCalls.length, envD.syncSetCalls.length]));
    t("C-7 local 仍没有 bypassList 内容（既没被清、也没被写脏）",
      !envD.localStore.bypassList, JSON.stringify(envD.localStore.bypassList));

    // C-8（防误伤 · 锁住「逐字符」这个判据本身）：
    //   用户自写的列表若【恰好与默认列表等长、条数相同但内容不同】，它仍然不是默认列表，
    //   保存时该清 local 就得清。若有人把逐字符比较改成「长度相同」「条数相同」这类近似判据，
    //   这条断言会立刻变红 —— 那正是 R8-02-E 在 background 侧锁住的同一个陷阱。
    const NEAR_C = DEFAULTS_C.bypassList.split("192.168.0.0/16").join("192.168.9.0/16").split(".lan").join(".laa");
    const envE = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: NEAR_C },
      localStore: { bypassList: "stale-from-previous-degrade.internal" }
    });
    await waitUntil(() => proxyTarget(envE.proxy.value) === "socks5 127.0.0.1:10808");
    await envE.settle(60);
    t("C-8 前置事实：界面显示的是用户自写的等长列表（长度与默认列表相同，内容不同）",
      envE.els.bypassList.value === NEAR_C && NEAR_C.length === DEFAULTS_C.bypassList.length &&
      NEAR_C !== DEFAULTS_C.bypassList,
      "长度 " + NEAR_C.length + " vs " + DEFAULTS_C.bypassList.length);

    envE.syncSetCalls.length = 0; envE.localSetCalls.length = 0;
    envE.click("saveButton");
    await envE.settle(140);

    t("C-9 关键：等长但内容不同的用户列表保存后，local 的过期副本仍被清掉（判据必须是逐字符的）",
      envE.localStore.bypassList === "" && envE.localSetCalls.some(o => o && o.bypassList === ""),
      JSON.stringify([envE.localStore.bypassList, envE.localSetCalls.map(o => String(o && o.bypassList).length)]));
  }

  console.log("");
  console.log("== R9-01（门禁版）：遮蔽现场下用户【编辑后保存】不得删除 local 唯一副本 ==");
  {
    // 与 R8-02-B 同一污染形态，区别在【用户编辑了内容】：
    //   R8-02-B 是「不编辑、只点保存」，保存值逐字符等于默认列表，旧判据侥幸拦住；
    //   本用例把默认列表改一个字，旧判据立即失效并清空 local —— 那是不可逆的数据丢失。
    //
    // 污染现场用【定向失败注入】固定：只阻断后台自愈写下的 {bypassList:""}，
    //   其余写入照常。这样 loadedShadowed 在保存时必定为 true，用例不含任何时序竞争。
    const sboxR9 = { TextEncoder: TextEncoder };
    sboxR9.self = sboxR9; sboxR9.globalThis = sboxR9;
    vm.createContext(sboxR9);
    vm.runInContext(settingsSrc, sboxR9, { filename: path.join(__dirname, '..', 'settings.js') });
    const DEF_R9 = sboxR9.EasyProxy.DEFAULTS.bypassList;
    const NL = String.fromCharCode(10);
    const LONG_R9 = Array.from({ length: 500 }, (_, i) => "r9-" + (i + 1) + ".internal.example").join(NL);

    const envR9 = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: DEF_R9 },
      localStore: { bypassList: LONG_R9 },
      setFilter: (realm, areaName, obj) => {
        if (areaName === "sync" && Object.keys(obj).length === 1 && obj.bypassList === "") {
          return "自愈写入被测试阻断，以固定污染现场";
        }
        return null;
      }
    });
    await waitUntil(() => proxyTarget(envR9.proxy.value) === "socks5 127.0.0.1:10808");
    await envR9.settle(160);

    t("R9-01-A 前置事实：污染现场被固定住（sync 仍是内置默认列表，local 是用户 500 条规则）",
      envR9.syncStore.bypassList === DEF_R9 && envR9.localStore.bypassList === LONG_R9,
      JSON.stringify([String(envR9.syncStore.bypassList).length, String(envR9.localStore.bypassList).split(NL).length]));

    t("R9-01-B 前置事实：界面显示的是被遮蔽后的默认列表（用户自己的规则不可见）",
      envR9.els.bypassList.value === DEF_R9,
      "界面长度=" + String(envR9.els.bypassList.value).length + "；默认长度=" + DEF_R9.length);

    envR9.syncSetCalls.length = 0; envR9.localSetCalls.length = 0;
    // 用户在被遮蔽的表单上编辑一个字：保存值不再等于默认列表
    envR9.els.bypassList.value = DEF_R9 + NL + "edited-by-user.internal.example";
    // 【V-01 契约适配】遮蔽现场下「改过内容的保存」需要二次确认：第一次点击只进入确认态
    //   （零写入、按钮文案变为「确认保存」），第二次点击才真正写入。
    //   断言一字未改 —— 变的只是动作次数，因为新契约要求用户显式确认一次。
    envR9.click("saveButton");
    await envR9.settle(80);
    envR9.click("saveButton");
    await envR9.settle(200);

    t("R9-01-C 核心：编辑后保存不得把 local 写成空串（断言真实存储内容）",
      envR9.localStore.bypassList === LONG_R9,
      "local 条数=" + String(envR9.localStore.bypassList || "").split(NL).length + " 期望 500");

    t("R9-01-D 核心：local.set 的调用序列里不存在把 bypassList 写成空串的条目",
      !envR9.localSetCalls.some(o => o && o.bypassList === ""),
      JSON.stringify(envR9.localSetCalls.map(o => String(o && o.bypassList).length)));

    t("R9-01-E 保存本身确实写入了 sync（排除「根本没保存」造成的假绿）",
      envR9.syncSetCalls.length === 1 && String(envR9.syncSetCalls[0].bypassList).indexOf("edited-by-user") >= 0,
      JSON.stringify(envR9.syncSetCalls.map(o => String(o.bypassList).length)));
  }


  console.log("");
  console.log("== R9-01-F：遮蔽现场下保存【超长列表】不得覆盖 local 唯一副本（V-02）==");
  {
    // 与 R9-01 同一污染形态（sync=内置默认列表 + local=用户 500 条规则），
    //   区别在【表单值超过 MAX_SYNC_BYTES_PER_ITEM(8192)】：
    //   此时 save() 走 oversize 分支，而该分支此前没有 formWasShadowed 守卫，
    //   会直接 setStorage("local", {bypassList: 表单值}) 覆盖用户唯一副本（V-02）。
    //
    // 污染现场仍用【定向失败注入】固定：只阻断后台自愈写下的 {bypassList:""}，
    //   其余写入照常 —— 用例不含任何时序竞争。
    const sboxF = { TextEncoder: TextEncoder };
    sboxF.self = sboxF; sboxF.globalThis = sboxF;
    vm.createContext(sboxF);
    vm.runInContext(settingsSrc, sboxF, { filename: path.join(__dirname, '..', 'settings.js') });
    const DEF_F = sboxF.EasyProxy.DEFAULTS.bypassList;
    const MAX_F = sboxF.EasyProxy.MAX_SYNC_BYTES_PER_ITEM;
    const NL_F = String.fromCharCode(10);
    const LONG_F = Array.from({ length: 500 }, (_, i) => "r9f-" + (i + 1) + ".internal.example").join(NL_F);
    // 用户粘贴的 600 条列表：单条 26 字符左右，总长必然 > 8192
    const PASTED_F = Array.from({ length: 600 }, (_, i) => "pasted-" + (i + 1) + ".big.example.com").join(NL_F);

    t("R9-01-F0 构造前提：粘贴的列表确实超过 sync 单键上限（否则本用例根本不走 oversize 分支）",
      sboxF.EasyProxy.estimateBytes({ bypassList: PASTED_F }) > MAX_F,
      "字节=" + sboxF.EasyProxy.estimateBytes({ bypassList: PASTED_F }) + " 上限=" + MAX_F);

    const envF = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: DEF_F },
      localStore: { bypassList: LONG_F },
      setFilter: (realm, areaName, obj) => {
        if (areaName === "sync" && Object.keys(obj).length === 1 && obj.bypassList === "") {
          return "自愈写入被测试阻断，以固定污染现场";
        }
        return null;
      }
    });
    await waitUntil(() => proxyTarget(envF.proxy.value) === "socks5 127.0.0.1:10808");
    await envF.settle(160);

    t("R9-01-F1 前置事实：污染现场被固定住（sync 仍是默认列表，local 是用户 500 条规则）",
      envF.syncStore.bypassList === DEF_F && envF.localStore.bypassList === LONG_F,
      JSON.stringify([String(envF.syncStore.bypassList).length, String(envF.localStore.bypassList).split(NL_F).length]));

    t("R9-01-F2 前置事实：表单确实渲染出被遮蔽的现场（守卫的本轮新增条件据此判定）",
      envF.els.bypassList.value === DEF_F,
      "界面长度=" + String(envF.els.bypassList.value).length);

    envF.syncSetCalls.length = 0; envF.localSetCalls.length = 0;
    envF.els.bypassList.value = PASTED_F;       // 用户在遮蔽现场粘贴一份超长列表
    envF.click("saveButton");
    await envF.settle(200);

    // 核心（数据完整性）：local 必须逐字符仍是用户原列表
    t("R9-01-F3 核心：遮蔽现场保存超长列表不得覆盖 local 唯一副本（断言真实存储内容）",
      envF.localStore.bypassList === LONG_F,
      "local 条数=" + String(envF.localStore.bypassList || "").split(NL_F).length +
      " 期望 500；首行=" + JSON.stringify(String(envF.localStore.bypassList || "").split(NL_F)[0]));

    // 核心（写入序列）：local.set 的任何一次都必须为空 —— 而不是「除了某次以外」
    //   注意：断言【整条序列为空】比断言「不等于某个值」更严，能同时挡住
    //   「写空串」「写粘贴值」「写默认列表」三种覆盖形态。
    t("R9-01-F4 核心：local.set 的调用序列必须为空（遮蔽现场绝不允许写 local，而不是只禁止写空串）",
      envF.localSetCalls.length === 0,
      JSON.stringify(envF.localSetCalls.map(o => String(o && o.bypassList).length)));

    // 核心（零写入）：遮蔽现场 + 超长值时，连 sync 也不能写。
    //   原因：chrome.storage.sync 的单键上限是 QUOTA_BYTES_PER_ITEM = 8192 字节，
    //   写进去在真实 Chrome 上必然以 lastError 失败，而且会把用户表单内容留成
    //   「半提交」状态（sync 没有该键的新值、用户以为自己存上了）。
    //   local 是唯一副本，超长值又无处安放 —— 唯一安全的动作是【写入之前就拒绝】。
    //   本仓库的 storage 桩不做配额校验，所以「错误地写 sync」在测试里不会自动报错：
    //   这一条断言是唯一能挡住该错误实现的门。
    t("R9-01-F7 核心：遮蔽现场下超长值必须零写入（sync 也不写；真实 sync 单键上限 8192 字节）",
      envF.syncSetCalls.length === 0,
      JSON.stringify(envF.syncSetCalls.map(o => String(o.bypassList).length)));

    // 排除假绿：保存被拒绝时必须给出【可理解且如实】的解释，不能静默什么都不做
    t("R9-01-F5 拒绝保存时必须留下如实的提示（排除「点了没反应」造成的假绿）",
      envF.hint().length > 0 && envF.hint().indexOf("未保存") >= 0,
      JSON.stringify(envF.hint()));

    // 提示语必须如实：不得再出现「已存于本地」这种与事实相反的结论
    t("R9-01-F6 提示语不得声称已经存到本地（local 未被写入，那句话与事实相反）",
      envF.hint().indexOf("已存于本地") < 0,
      JSON.stringify(envF.hint()));

    // ---- 同现场、短列表分支：真正证明「守卫没有把保存功能一并关掉」 ----
    //   上面的 6 条只证明「没有丢数据」；若实现被写成「遮蔽现场一律拒绝保存」，
    //   那 6 条会全绿，但用户的正常保存需求被废掉。这一段是必需的反向对照。
    {
      const SHORT_F = "only-a-few.internal.example";   // 远小于 8192 字节

      const envFs = buildChainEnv({
        syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: DEF_F },
        localStore: { bypassList: LONG_F },
        setFilter: (realm, areaName, obj) => {
          if (areaName === "sync" && Object.keys(obj).length === 1 && obj.bypassList === "") {
            return "自愈写入被测试阻断，以固定污染现场";
          }
          return null;
        }
      });
      await waitUntil(() => proxyTarget(envFs.proxy.value) === "socks5 127.0.0.1:10808");
      await envFs.settle(160);
      t("R9-01-F8 前置事实（短列表分支）：表单仍是被遮蔽的默认列表",
        envFs.els.bypassList.value === DEF_F,
        "界面长度=" + String(envFs.els.bypassList.value).length);

      envFs.syncSetCalls.length = 0; envFs.localSetCalls.length = 0;
      envFs.els.bypassList.value = SHORT_F;
      envFs.click("saveButton");
      await envFs.settle(200);

      t("R9-01-F9 反向对照：遮蔽现场下保存【短】列表必须成功写入 sync（证明保存功能没被关掉）",
        envFs.syncSetCalls.some(o => o.bypassList === SHORT_F),
        JSON.stringify(envFs.syncSetCalls.map(o => String(o.bypassList).length)));
      t("R9-01-F10 反向对照：短列表保存时 local 仍必须零写入",
        envFs.localSetCalls.length === 0 && envFs.localStore.bypassList === LONG_F,
        JSON.stringify([envFs.localSetCalls.length,
          String(envFs.localStore.bypassList || "").split(NL_F).length]));
    }
  }


  console.log("");
  console.log("== V-01：遮蔽现场下「编辑后保存」必须二次确认，首次点击不得写入任何存储 ==");
  {
    // 现场构造：与 R9-01-F 同型（只阻断后台自愈写下的 {bypassList:""}）。
    const sboxV = { TextEncoder: TextEncoder };
    sboxV.self = sboxV; sboxV.globalThis = sboxV;
    vm.createContext(sboxV);
    vm.runInContext(settingsSrc, sboxV, { filename: path.join(__dirname, '..', 'settings.js') });
    const DEF_V = sboxV.EasyProxy.DEFAULTS.bypassList;
    const NL_V = String.fromCharCode(10);
    const LONG_V = Array.from({ length: 500 }, (_, i) => "v1-" + (i + 1) + ".internal.example").join(NL_V);

    function shadowEnv() {
      return buildChainEnv({
        syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: DEF_V },
        localStore: { bypassList: LONG_V },
        setFilter: (realm, areaName, obj) => {
          if (areaName === "sync" && Object.keys(obj).length === 1 && obj.bypassList === "") {
            return "自愈写入被测试阻断，以固定污染现场";
          }
          return null;
        }
      });
    }

    // ---- 第一次点击：只进入确认态，不得写入任何存储 ----
    {
      const envX = shadowEnv();
      await waitUntil(() => proxyTarget(envX.proxy.value) === "socks5 127.0.0.1:10808");
      await envX.settle(160);
      envX.syncSetCalls.length = 0; envX.localSetCalls.length = 0;
      envX.els.bypassList.value = DEF_V + NL_V + "edited-by-user.internel.example";
      envX.click("saveButton");
      await envX.settle(120);
      t("V-01-A 首次点击（确认态）：sync 零写入（未被静默种下）",
        envX.syncSetCalls.length === 0, JSON.stringify(envX.syncSetCalls));
      t("V-01-B 首次点击（确认态）：local 零写入，用户规则完整",
        envX.localSetCalls.length === 0 && envX.localStore.bypassList === LONG_V,
        JSON.stringify([envX.localSetCalls.length, String(envX.localStore.bypassList || "").split(NL_V).length]));
      t("V-01-C 首次点击（确认态）：按钮文案变为「确认保存」（用户看得见需要再确认）",
        envX.els.saveButton.textContent.indexOf("确认保存") >= 0,
        JSON.stringify(envX.els.saveButton.textContent));
      t("V-01-C2 首次点击（确认态）：提示如实说明尚未写入（不得谎报「设置已保存」）",
        envX.hint().indexOf("再点一次") >= 0 && envX.hint().indexOf("设置已保存") < 0,
        JSON.stringify(envX.hint()));
    }

    // ---- 第二次点击：真正写入 sync，仍不碰 local（Task 1 的入口守卫必须同时生效）----
    {
      const envY = shadowEnv();
      await waitUntil(() => proxyTarget(envY.proxy.value) === "socks5 127.0.0.1:10808");
      await envY.settle(160);
      envY.syncSetCalls.length = 0; envY.localSetCalls.length = 0;
      const EDITED = DEF_V + NL_V + "confirmed-by-user.internel.example";
      envY.els.bypassList.value = EDITED;
      envY.click("saveButton");                 // 第一次：进入确认态
      await envY.settle(80);
      envY.click("saveButton");                 // 第二次：确认并写入
      await envY.settle(200);
      t("V-01-D 二次确认后：sync 写入的正是用户表单内容（保存意图被尊重）",
        envY.syncSetCalls.some(o => o.bypassList === EDITED),
        JSON.stringify(envY.syncSetCalls.map(o => String(o.bypassList).length)));
      t("V-01-E 二次确认后：local 仍零写入（Task 1 的入口守卫与确认门同时生效）",
        envY.localSetCalls.length === 0 && envY.localStore.bypassList === LONG_V,
        JSON.stringify(envY.localSetCalls.map(o => String(o && o.bypassList).length)));
      t("V-01-F 二次确认后：按钮文案复位为「保存设置」（确认态不得跨操作残留）",
        envY.els.saveButton.textContent.indexOf("确认保存") < 0,
        JSON.stringify(envY.els.saveButton.textContent));
    }

    // ---- 第一次点击后再改回「等于默认列表」并点击：R9-01 主场景，不得被二次确认打断 ----
    {
      const envZ = shadowEnv();
      await waitUntil(() => proxyTarget(envZ.proxy.value) === "socks5 127.0.0.1:10808");
      await envZ.settle(160);
      envZ.els.bypassList.value = DEF_V + NL_V + "typed-then-reverted.internel.example";
      envZ.click("saveButton");                 // 进入确认态
      await envZ.settle(80);
      envZ.els.bypassList.value = DEF_V;        // 用户又改回与默认列表逐字符相同
      envZ.syncSetCalls.length = 0; envZ.localSetCalls.length = 0;
      envZ.click("saveButton");
      await envZ.settle(200);
      t("V-01-G 已有的确认态不会把「什么都没改」的保存变成空操作：sync 仍被写入默认列表，local 未被清空",
        envZ.syncSetCalls.length === 1 && envZ.syncSetCalls[0].bypassList === DEF_V &&
        envZ.localSetCalls.length === 0 && envZ.localStore.bypassList === LONG_V,
        JSON.stringify([envZ.syncSetCalls.map(o => String(o.bypassList).length),
          envZ.localSetCalls.length, String(envZ.localStore.bypassList || "").split(NL_V).length]));
    }

    // ---- 警示：确认态不得在存储变化（表单重载）后残留 ----
    {
      const envW = shadowEnv();
      await waitUntil(() => proxyTarget(envW.proxy.value) === "socks5 127.0.0.1:10808");
      await envW.settle(160);
      envW.els.bypassList.value = DEF_V + NL_V + "first-tap.internel.example";
      envW.click("saveButton");                 // 进入确认态
      await envW.settle(80);
      const midLabel = envW.els.saveButton.textContent;
      envW.reload();                            // 任意存储变化都会触发 load()
      await envW.settle(120);
      t("V-01-H 确认态不跨表单重载残留：按钮文案复位为「保存设置」",
        midLabel.indexOf("确认保存") >= 0 && envW.els.saveButton.textContent.indexOf("确认保存") < 0,
        JSON.stringify([midLabel, envW.els.saveButton.textContent]));
    }
  }


  /* ============================================================
     R8-04：getStatus 的 session.get 读取失败不得被前台兜底成「直连」
     ------------------------------------------------------------
     缺陷链路（第八轮审计探针 SESSION_READ_FAIL 复现）：
       · background.js 的 getStatus 分支不检查 chrome.runtime.lastError，
         读取失败时 items 为空 → 送回 { state: null }；
       · popup.js 的 renderStatus 第一句 `if (!state) state = { status: "direct" };`
         把「读不到状态」兜底成了「未启用代理（直连）」。
     现场事实：chrome.proxy 里我方的 socks5 仍在生效、session 里的 lastState
       也仍然是 applied —— 界面却宣称用户没开代理。

     本段断言的对象都是【最终事实】，不是 popup 的内部变量：
       · 界面显示的文案 —— statusBar 的真实 textContent；
       · 代理是否被动过 —— chrome.proxy 的生效配置与 set/clear 调用序列；
       · 状态是否读到了 —— 由真实 background.js 的 getStatus 分支（经真实
         chrome.runtime.onMessage 链路）回答，而不是由测试直接编造响应。
     ============================================================ */

  console.log("");
  console.log("== R8-04-A：session 读取失败 —— 界面不得显示「未启用代理（直连）」 ==");
  {
    const env = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: {}
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
    // 真实现场：上一次下发成功，session 里留下的是 applied
    env.setSessionState({ lastState: { status: "applied", mode: "fixed_servers" } });
    await env.settle(60);

    const stEnv = env.popupCtx.el.statusBar;
    t("A-前置：session 里确实存着 applied（代理已生效的真实状态）",
      (env.sessionStore.lastState || {}).status === "applied",
      "lastState=" + JSON.stringify(env.sessionStore.lastState));
    t("A-前置：代理确实生效中（socks5 127.0.0.1:10808）",
      proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808",
      "实际生效 = " + proxyTarget(env.proxy.value));
    t("A-前置（未注入失败时）：界面如实显示「代理已生效」",
      stEnv.textContent.indexOf("代理已生效") >= 0,
      "状态条=" + JSON.stringify(stEnv.textContent));

    // 注入：session.get 读取失败（回调期间 lastError 有值、payload 为空）
    env.readMode("bg", "session", "fail");
    env.readPayload("bg", "undefined");
    env.proxy.applied.length = 0; env.proxy.cleared.length = 0;
    env.reopen();
    await env.settle(80);

    t("A-1 核心：读取失败后界面【不得】出现「未启用代理（直连）」（这正是被兜底出来的假象）",
      stEnv.textContent.indexOf("未启用代理") < 0,
      "状态条=" + JSON.stringify(stEnv.textContent));
    t("A-2 核心：界面必须如实表达「状态未知 / 读取不到」",
      /状态未知|无法读取/.test(stEnv.textContent),
      "状态条=" + JSON.stringify(stEnv.textContent));
    t("A-3 读取失败不是错误态：不得声称代理可能已回退直连",
      !/回退直连|流量可能/.test(stEnv.textContent),
      "状态条=" + JSON.stringify(stEnv.textContent));
    t("A-4 状态条用的是既有的 warn 档（与 R7-01-F 的读取失败同档；不得沿用直连的 muted）",
      stEnv.className === "status warn",
      "className=" + JSON.stringify(stEnv.className));

    // 读取恢复：同一入口必须回到真实状态（证明 A-1/A-2 不是把状态条写死）
    env.readMode("bg", "session", "ok");
    env.reopen();
    await env.settle(80);
    t("A-5 读取恢复后界面回到「代理已生效」（证明没有把状态条写死为未知）",
      stEnv.textContent.indexOf("代理已生效") >= 0,
      "状态条=" + JSON.stringify(stEnv.textContent));
  }

  console.log("");
  console.log("== R8-04-B：同一现场 —— 代理配置绝不能被这次读取失败改动 ==");
  {
    const env = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: {}
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
    env.setSessionState({ lastState: { status: "applied", mode: "fixed_servers" } });
    await env.settle(60);
    const appliedBefore = env.proxy.applied.length;

    env.readMode("bg", "session", "fail");
    env.readPayload("bg", "undefined");
    env.proxy.applied.length = 0; env.proxy.cleared.length = 0;
    env.reopen();
    await env.settle(80);

    t("B-1 核心：chrome.proxy 的实际生效配置仍是 socks5 127.0.0.1:10808",
      proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808",
      "实际生效 = " + proxyTarget(env.proxy.value));
    t("B-2 核心：chrome.proxy.settings.set 调用次数为 0（没有重新下发）",
      env.proxy.applied.length === 0, JSON.stringify(env.proxy.applied));
    t("B-3 核心：clearProxyScope 调用次数为 0（没有把 regular 作用域清掉）",
      env.proxy.cleared.filter(s => s === "regular").length === 0,
      JSON.stringify(env.proxy.cleared));
    t("B-4 存储里的 enableProxy 仍是 true（这次读取失败没有波及 sync）",
      env.syncStore.enableProxy === true, "enableProxy=" + env.syncStore.enableProxy);
    // 交接：读取失败【叠加】用户点一次保存，代理仍必须完好（同一个入口的两段）
    env.click("saveButton");
    await env.settle(160);
    t("B-5 读取失败 + 一次保存：代理仍生效（0 次 clear、生效配置未变）",
      proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808" &&
      env.proxy.cleared.filter(s => s === "regular").length === 0,
      "生效 = " + proxyTarget(env.proxy.value) + " cleared=" + JSON.stringify(env.proxy.cleared));
    t("B-6 前置事实：正常路径本就会下发一次（证明 B-2 的 0 次不是「链路根本没通」）",
      appliedBefore >= 1, "首次下发次数=" + appliedBefore);
  }

  console.log("");
  console.log("== R8-04-C（防回归）：session.get 正常、lastState = applied → 「代理已生效」 ==");
  {
    const env = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: {}
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
    // 【W-03 确定性重写】此前这里直接断言"状态条显示直连兜底"，靠的是"抢在后台
    //   把 lastState 写进 session 之前读界面"——那是一条【挂钟竞态】：后台先写完就
    //   会读到 applied，断言随机变红。实测该竞态在 Linux/Node 20 上约 3/20~5/20 命中，
    //   曾把 CI 的变异门禁基线判成失败（exit 3，"基线失败时变异结果无意义，立即中止"）。
    //   现在改为【受控构造】：先等后台的状态写入确实落地，再显式把 session 清成
    //   "后台还没写下任何状态"，然后让界面按 onChanged 重读——同一语义，不再依赖时序。
    await waitUntil(() => env.sessionStore.lastState !== undefined);
    env.setSessionState({ lastState: undefined });
    await env.settle(60);
    const stEnv = env.popupCtx.el.statusBar;
    t("C-前置：全新安装、后台还没写下任何状态时，界面显示的是「直连」兜底",
      stEnv.textContent === "未启用代理（直连）",
      "状态条=" + JSON.stringify(stEnv.textContent));

    env.setSessionState({ lastState: { status: "applied", mode: "fixed_servers" } });
    await env.settle(80);
    t("C-1 防回归：正常读到 applied 时显示「代理已生效」（既有语义一字不变）",
      stEnv.textContent.indexOf("代理已生效") >= 0,
      "状态条=" + JSON.stringify(stEnv.textContent));
    t("C-2 防回归：applied 档的样式类是 ok",
      stEnv.className === "status ok", "className=" + JSON.stringify(stEnv.className));
    t("C-3 防回归：applied 的文案逐字符等于既有 STATUS_TEXT，未追加任何后缀",
      stEnv.textContent === "代理已生效", "状态条=" + JSON.stringify(stEnv.textContent));
  }

  console.log("");
  console.log("== R8-04-D（防回归，关键）：真的没有状态时「直连」仍然是正确显示 ==");
  {
    // 这一条是本次修复的【反向锁】：R8-04-A 要求「读不到 → 状态未知」，
    //   若把判据写成「只要没有 state 就报未知」，全新安装（从未写入过状态）
    //   就会被谎报成读故障 —— 那是把一个假象换成另一个假象。
    const env = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: {}
    });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
    await env.settle(60);
    const stEnv = env.popupCtx.el.statusBar;

    // 「读取正常、但 session 里确实什么都没有」的真实来历：全新安装时 popup 可能
    //   先于首次下发被打开；service worker 被回收后 session 也可能被清空。
    //   这里直接清掉那两个键 —— 【全程不注入任何 lastError】，所以后台那次
    //   session.get 是成功的：区别只在「没有」，不在「读不到」。
    delete env.sessionStore.lastState;
    delete env.sessionStore.lastTest;
    env.reopen();
    await env.settle(80);

    t("D-前置：session 里确实没有任何状态（读取前）",
      env.sessionStore.lastState === undefined && env.sessionStore.lastTest === undefined,
      "sessionStore=" + JSON.stringify(env.sessionStore));
    t("D-1 关键：读取正常但确实没有状态时，显示「未启用代理（直连）」（该行为必须保留）",
      stEnv.textContent === "未启用代理（直连）",
      "状态条=" + JSON.stringify(stEnv.textContent));
    t("D-2 关键：不得谎报成「状态未知 / 无法读取」",
      !/状态未知|无法读取/.test(stEnv.textContent),
      "状态条=" + JSON.stringify(stEnv.textContent));
    t("D-3 样式类仍是 direct 档的 muted",
      stEnv.className === "status muted", "className=" + JSON.stringify(stEnv.className));

    // D-4 是 D-1 的【对照】：此刻 session 里的内容与 D-1 完全相同（都是空），
    //   唯一变量是后台那次 session.get 是否失败 —— 界面必须据此给出不同结论。
    //   （第二种真实失败形态：回调 payload 是空对象 {} 但 lastError 有值）
    env.readMode("bg", "session", "fail");
    env.readPayload("bg", "empty");
    env.reopen();
    await env.settle(80);
    t("D-4 payload 为空对象但 lastError 有值时同样判为「读不到」，不判「直连」",
      stEnv.textContent.indexOf("未启用代理") < 0 && /状态未知|无法读取/.test(stEnv.textContent),
      "状态条=" + JSON.stringify(stEnv.textContent));
  }
  console.log("");
  console.log("== S1：存量「默认列表+编辑」污染现场 —— 普通保存不得清空 local 唯一副本 ==");
  {
    // S1 的真实到达路径：升级前 V-01 缺陷把「内置默认列表 + 用户编辑」写进了 sync，
    //   用户唯一的长列表只剩 local 一份。旧实现的 loadedShadowed 判据只认「逐字符
    //   相等」，对编辑形态恒为 false → 保存走普通分支 → clearLocalBypassIfAny 的
    //   守卫（保存值 === 默认列表）同样不命中 → local 被静默清空，不可逆。
    //   修复后：load() 用 S.isLegacyShadowPair 识别编辑形态 → loadedShadowed=true
    //   → 保存走遮蔽现场分支（+ V-01 二次确认门），local 逐字符不变。
    const sboxS1 = { TextEncoder: TextEncoder };
    sboxS1.self = sboxS1; sboxS1.globalThis = sboxS1;
    vm.createContext(sboxS1);
    vm.runInContext(settingsSrc, sboxS1, { filename: path.join(__dirname, '..', 'settings.js') });
    const DEF_S1 = sboxS1.EasyProxy.DEFAULTS.bypassList;
    const NL_S1 = String.fromCharCode(10);
    const LONG_S1 = Array.from({ length: 500 }, (_, i) => "s1-" + (i + 1) + ".internal.example").join(NL_S1);
    // 升级前缺陷留下的形态：默认列表整段 + 用户编辑（保存值 !== 默认列表，
    //   旧实现的一切判据都对它失明）
    const EDIT_S1 = DEF_S1 + NL_S1 + "my-custom.internal";

    const envS1 = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: EDIT_S1 },
      localStore: { bypassList: LONG_S1 }
      // 不需要 setFilter：该形态下后台自愈判据（保守、逐字符相等）不会触发，
      //   现场天然稳定，这正是 S1 与 R9-01 场景的关键区别。
    });
    await waitUntil(() => proxyTarget(envS1.proxy.value) === "socks5 127.0.0.1:10808");
    await envS1.settle(160);

    t("S1-A 前置事实：sync 是「默认列表+编辑」形态（不等于默认列表，旧判据对它失明）",
      envS1.syncStore.bypassList === EDIT_S1 && EDIT_S1 !== DEF_S1,
      JSON.stringify([String(envS1.syncStore.bypassList).length, EDIT_S1 === DEF_S1]));
    t("S1-B 前置事实：local 里是用户 500 条规则的唯一副本",
      envS1.localStore.bypassList === LONG_S1,
      "local 条数=" + String(envS1.localStore.bypassList || "").split(NL_S1).length);
    t("S1-C 前置事实：表单显示的是被遮蔽的编辑形态（sync 非空优先）",
      envS1.els.bypassList.value === EDIT_S1,
      "界面长度=" + String(envS1.els.bypassList.value).length + " 期望 " + EDIT_S1.length);

    // 用户什么都没改，只点一次「保存」——正是探针实测复现数据丢失的那一次点击
    envS1.syncSetCalls.length = 0; envS1.localSetCalls.length = 0;
    envS1.click("saveButton");
    await envS1.settle(120);
    // 修复后：遮蔽现场 + 编辑形态 → V-01 的行内二次确认门第一次点击不写入
    t("S1-D 首次点击进入确认态：零写入（sync 与 local 均未被改动）",
      envS1.syncSetCalls.length === 0 && envS1.localSetCalls.length === 0,
      JSON.stringify([envS1.syncSetCalls.length, envS1.localSetCalls.length]));
    t("S1-E 确认态可见：按钮文案变为「确认保存」",
      envS1.els.saveButton.textContent.indexOf("确认保存") >= 0,
      JSON.stringify(envS1.els.saveButton.textContent));

    envS1.click("saveButton");
    await envS1.settle(200);
    t("S1-F 核心数据完整：保存后 local 逐字符仍是用户的 500 条规则（旧实现在这里被清空）",
      envS1.localStore.bypassList === LONG_S1,
      "local 条数=" + String(envS1.localStore.bypassList || "").split(NL_S1).length + " 期望 500");
    t("S1-G 核心写入序列：local.set 中不存在任何一次 bypassList 写入（空串/表单值都不允许）",
      envS1.localSetCalls.length === 0,
      JSON.stringify(envS1.localSetCalls.map(o => String(o && o.bypassList).length)));
    t("S1-H 保存意图被尊重：sync 写入的正是表单内容（编辑形态）",
      envS1.syncSetCalls.length === 1 && envS1.syncSetCalls[0].bypassList === EDIT_S1,
      JSON.stringify(envS1.syncSetCalls.map(o => String(o.bypassList).length)));
  }

  console.log("");
  console.log("== G2：消息通道失败 —— 状态条必须离开「读取状态中…」，如实进入未知档 ==");
  {
    // 缺陷：send() 用 void chrome.runtime.lastError 吞掉通道错误并 resolve(null)，
    //   refreshStatus 在 !resp 时直接 return —— SW 崩溃 / 扩展重载 / 消息通道异常时，
    //   状态条永久停留在初始文案「读取状态中…」，用户既看不到错误也看不到状态。
    const env = buildEnv();
    await env.ready();
    // 初始（后台尚未回答 / 无响应）：不得停留在「读取状态中…」
    t("G2-A 初始加载后台无响应：状态条已进入「无法与后台通信」档（不再静默停留）",
      env.els.statusBar.textContent.indexOf("无法与后台通信") >= 0 &&
      env.els.statusBar.textContent.indexOf("读取状态中") < 0,
      JSON.stringify(env.els.statusBar.textContent));

    // 形态一：chrome.runtime.lastError（send reject）
    env.setSend({ mode: "throw", error: "Extension context invalidated." });
    env.sandbox.refreshStatus();
    await env.settle();
    t("G2-B send reject（lastError）：状态条如实显示「无法与后台通信」",
      env.els.statusBar.textContent.indexOf("无法与后台通信") >= 0,
      JSON.stringify(env.els.statusBar.textContent));
    t("G2-C 样式为 warn 档（未知档，不是 error 也不是 muted 直连）",
      env.els.statusBar.className === "status warn",
      "className=" + JSON.stringify(env.els.statusBar.className));
    t("G2-D 文案不谎报「未启用代理（直连）」",
      env.els.statusBar.textContent.indexOf("未启用代理") < 0,
      JSON.stringify(env.els.statusBar.textContent));

    // 形态二：回调 null（后台无响应）
    env.setSend({ mode: "ok", resp: null });
    env.sandbox.refreshStatus();
    await env.settle();
    t("G2-E 后台无响应（回调 null）同样进入未知档，不得静默停留",
      env.els.statusBar.textContent.indexOf("无法与后台通信") >= 0,
      JSON.stringify(env.els.statusBar.textContent));
  }

  console.log("");
  console.log("== G6：恢复默认改为行内二次确认 —— 第一次点击零写入，不依赖 window.confirm ==");
  {
    // 缺陷：resetDefaults 使用 window.confirm —— popup 失焦即销毁，返回值永远回不来，
    //   会把「恢复默认」变成「点了没反应」（V-01 已论证并修复过同一反模式，此处是
    //   同型残留）。且该操作会清空 local，属必须明确知情的高危操作。
    const sboxG6 = { TextEncoder: TextEncoder };
    sboxG6.self = sboxG6; sboxG6.globalThis = sboxG6;
    vm.createContext(sboxG6);
    vm.runInContext(settingsSrc, sboxG6, { filename: path.join(__dirname, '..', 'settings.js') });
    const DEF_G6 = sboxG6.EasyProxy.DEFAULTS;

    const envG6 = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: "example.com" },
      localStore: { bypassList: "user-own-list.internal" }
    });
    await waitUntil(() => proxyTarget(envG6.proxy.value) === "socks5 127.0.0.1:10808");
    await envG6.settle(60);

    envG6.syncSetCalls.length = 0; envG6.localSetCalls.length = 0;
    envG6.click("resetButton");
    await envG6.settle(120);
    t("G6-A 第一次点击零写入（confirm 反模式已移除，确认不靠弹窗）",
      envG6.syncSetCalls.length === 0 && envG6.localSetCalls.length === 0,
      JSON.stringify([envG6.syncSetCalls.length, envG6.localSetCalls.length]));
    t("G6-B 确认态可见：按钮文案变为「确认恢复默认」",
      envG6.els.resetButton.textContent.indexOf("确认恢复默认") >= 0,
      JSON.stringify(envG6.els.resetButton.textContent));
    t("G6-C 提示如实说明后果：清空本机保存的绕过列表（用户必须知情）",
      envG6.hint().indexOf("清空本机保存的绕过列表") >= 0,
      JSON.stringify(envG6.hint()));

    // 【测试稳定性修复】第二次点击后的链路含一次真实的下发往返（reapply → applyProxy，
    //   其中逐条清理遗留作用域 = 十余次 setTimeout(0) 跳）。固定 sleep(240) 实测完成
    //   时间在 166–270 ms，恰好压在预算上 ⇒ 机器负载高时偶发假红（曾复现）。
    //   改为等待「提示确实被替换」这一完成信号：不预设结果文本（G6-F 仍是真断言），
    //   也不受负载漂移影响。同上，其余「点击后紧接固定 settle 再断言异步结果」处一并改造。
    const confirmHintG6 = envG6.hint();
    envG6.click("resetButton");
    await waitUntil(() => envG6.hint() !== confirmHintG6, 3000);
    t("G6-D 第二次点击执行：sync 写入默认值",
      envG6.syncSetCalls.some(o => o.bypassList === DEF_G6.bypassList),
      JSON.stringify(envG6.syncSetCalls.map(o => String(o.bypassList).length)));
    t("G6-E 第二次点击执行：local 的绕过列表被清空（用户明确知情后的结果）",
      envG6.localSetCalls.some(o => o && o.bypassList === "") && envG6.localStore.bypassList === "",
      JSON.stringify([envG6.localSetCalls.map(o => String(o && o.bypassList).length), envG6.localStore.bypassList]));
    t("G6-F 提示「已恢复默认设置」",
      envG6.hint().indexOf("已恢复默认设置") >= 0, JSON.stringify(envG6.hint()));
    t("G6-G 确认态复位：按钮文案回到「恢复默认」",
      envG6.els.resetButton.textContent.indexOf("确认恢复默认") < 0,
      JSON.stringify(envG6.els.resetButton.textContent));

    // 遮蔽现场下的知情补充：本机规则（可能是唯一副本）将被一并清空，必须先说清
    const envG6b = buildChainEnv({
      syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808", bypassList: DEF_G6.bypassList },
      localStore: { bypassList: "user-only-copy.internal" },
      setFilter: (realm, areaName, obj) => {
        if (areaName === "sync" && Object.keys(obj).length === 1 && obj.bypassList === "") {
          return "自愈写入被测试阻断，以固定污染现场";
        }
        return null;
      }
    });
    await waitUntil(() => proxyTarget(envG6b.proxy.value) === "socks5 127.0.0.1:10808");
    await envG6b.settle(160);
    // 清掉「被阻断的自愈写入」残留的计数（setFilter 挡下的写入同样会计入调用序列）
    envG6b.syncSetCalls.length = 0; envG6b.localSetCalls.length = 0;
    envG6b.click("resetButton");
    await envG6b.settle(120);
    t("G6-H 遮蔽现场：确认提示包含「本机规则将被一并清空」的知情说明",
      envG6b.hint().indexOf("一并清空") >= 0 && envG6b.hint().indexOf("唯一副本") >= 0,
      JSON.stringify(envG6b.hint()));
    t("G6-I 遮蔽现场：第一次点击仍零写入",
      envG6b.syncSetCalls.length === 0 && envG6b.localSetCalls.length === 0,
      JSON.stringify([envG6b.syncSetCalls.length, envG6b.localSetCalls.length]));
  }

  console.log("");
  // ============================================================
  // 【M-1 / M-5】专用表单环境：可捕获 popup 的 storage.onChanged 监听器、
  //   可设置 document.activeElement（焦点保护依赖它）、可配置存储内容。
  //   与上面 R7-08 / R8-01 段的分工：那两段覆盖「点击与读取失败」路径；
  //   本段覆盖「存储变化驱动的表单重绘」路径（M-1 输入丢失）与
  //   「后台状态写入失败标记」（M-5）。
  //   ============================================================
  function buildFormEnv(opts) {
    opts = opts || {};
    const els = {};
    const getEl = id => (els[id] = els[id] || makeEl(id));
    const syncStore = Object.assign({}, opts.syncStore || {});
    const localStore = Object.assign({}, opts.localStore || {});
    const storageListeners = [];
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, Promise, Error, JSON, Object, Array,
      String, Number, Boolean, Math, Date,
      document: { getElementById: getEl, createElement: tag => makeEl("created:" + tag), activeElement: null },
      chrome: {
        runtime: {
          lastError: undefined,
          sendMessage(m, cb) { setTimeout(() => cb({ state: { status: "applied" }, test: null }), 0); }
        },
        storage: {
          sync: {
            get: (keys, cb) => {
              const out = {};
              (Array.isArray(keys) ? keys : Object.keys(keys || {})).forEach(k => { if (k in syncStore) out[k] = syncStore[k]; });
              setTimeout(() => cb(out), 0);
            },
            set: (obj, cb) => { Object.assign(syncStore, obj); setTimeout(() => cb && cb(), 0); }
          },
          local: {
            get: (keys, cb) => {
              const out = {};
              (Array.isArray(keys) ? keys : Object.keys(keys || {})).forEach(k => { if (k in localStore) out[k] = localStore[k]; });
              setTimeout(() => cb(out), 0);
            },
            set: (obj, cb) => { Object.assign(localStore, obj); setTimeout(() => cb && cb(), 0); }
          },
          onChanged: { addListener: f => storageListeners.push(f) }
        }
      }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(settingsSrc, sandbox, { filename: path.join(__dirname, '..', 'settings.js') });
    vm.runInContext(popupSrc, sandbox, { filename: path.join(__dirname, '..', 'popup.js') });
    return {
      sandbox, els, syncStore, localStore, storageListeners,
      fireStorageChange: (changes, area) => { for (const f of storageListeners.slice()) f(changes, area); },
      ready: () => sleep(30),
      settle: () => sleep(30)
    };
  }

  console.log("== M-1：storage 变化触发的表单重绘不得覆盖正在编辑的字段 ==");
  {
    const env = buildFormEnv({ syncStore: { enableProxy: true, proxyType: "socks5", proxyHost: "10.0.0.1", proxyPort: "10808", bypassList: "stored.local" } });
    await env.ready();
    // 用户正在 bypassList 中输入（字段持有焦点），此时外部（后台自愈 / 多设备同步）改写存储
    env.sandbox.document.activeElement = env.els.bypassList;
    env.els.bypassList.value = "user-typing.internal";
    env.syncStore.proxyHost = "10.0.0.2";
    env.fireStorageChange({ proxyHost: { newValue: "10.0.0.2" }, bypassList: { newValue: "stored.local" } }, "sync");
    await env.settle();
    t("M-1-a 焦点字段的用户输入不被重绘覆盖",
      env.els.bypassList.value === "user-typing.internal", env.els.bypassList.value);
    t("M-1-b 非焦点字段照常刷新（界面与存储保持一致）",
      env.els.proxyHost.value === "10.0.0.2", env.els.proxyHost.value);
    // 失焦后（无焦点）→ 恢复全量刷新语义
    env.sandbox.document.activeElement = null;
    env.syncStore.bypassList = "stored-2.local";
    env.fireStorageChange({ bypassList: { newValue: "stored-2.local" } }, "sync");
    await env.settle();
    t("M-1-c 失焦后恢复全量刷新", env.els.bypassList.value === "stored-2.local", env.els.bypassList.value);
    // 焦点在另一个字段时，该字段同样受保护
    env.sandbox.document.activeElement = env.els.proxyHost;
    env.els.proxyHost.value = "typing-host";
    env.fireStorageChange({ proxyHost: { newValue: "10.0.0.2" } }, "sync");
    await env.settle();
    t("M-1-d 焦点在 proxyHost 时其值不被覆盖",
      env.els.proxyHost.value === "typing-host", env.els.proxyHost.value);
    // 开关持有焦点时同样受保护（用户正在切换）
    env.sandbox.document.activeElement = env.els.enableProxy;
    env.els.enableProxy.checked = false;
    env.fireStorageChange({ enableProxy: { newValue: true } }, "sync");
    await env.settle();
    t("M-1-e 焦点在开关上时不覆盖用户切换",
      env.els.enableProxy.checked === false, String(env.els.enableProxy.checked));
    env.sandbox.document.activeElement = null;
  }

  console.log("== M-5：后台状态写入失败标记必须呈现给用户 ==");
  {
    const env = buildFormEnv({});
    await env.ready();
    env.fireStorageChange({ stateWriteFailed: { newValue: { at: 1, key: "lastState", message: "quota exceeded" } } }, "local");
    await env.settle();
    t("M-5-f 写入失败时给出警示文案",
      env.els.hint.textContent.indexOf("状态记录写入失败") >= 0, JSON.stringify(env.els.hint.textContent));
    t("M-5-g 警示为 warn 档（可见且非错误档）",
      env.els.hint.className.indexOf("warn") >= 0, env.els.hint.className);
    // 防误报：普通 local 变化不得触发警示
    const env2 = buildFormEnv({});
    await env2.ready();
    env2.fireStorageChange({ proxyPort: { newValue: "1" } }, "local");
    await env2.settle();
    t("M-5-h 普通存储变化不误报警示",
      env2.els.hint.textContent.indexOf("状态记录写入失败") < 0, JSON.stringify(env2.els.hint.textContent));
  }

  console.log("== M-4：escapeHtml 转义契约与 XSS 回归 ==");
  {
    const env = buildFormEnv({});
    await env.ready();
    const eh = env.sandbox.escapeHtml;
    t("M-4-a 尖括号被转义（标签注入失效）",
      eh("<img src=x onerror=alert(1)>") === "&lt;img src=x onerror=alert(1)&gt;", eh("<img>"));
    t("M-4-b & 被转义", eh("a&b") === "a&amp;b", eh("a&b"));
    t("M-4-c 双引号被转义（属性注入失效）", eh('a"b') === "a&quot;b", eh('a"b'));
    t("M-4-d null 安全兜底为空串", eh(null) === "", String(eh(null)));
    t("M-4-e 数字输入转字符串", eh(5) === "5", String(eh(5)));
    // 端到端：恶意出口/配置数据必须被转义后渲染，不得出现可执行的原始标签
    const env2 = buildEnv();
    await env2.ready();
    env2.setSend({
      resp: {
        ok: true,
        result: {
          exit: { ok: true, ip: "<script>alert(1)</script>", org: "", city: "", region: "", country: "" },
          settings: { enableProxy: true, proxyType: "socks5", proxyHost: "<b>x</b>", proxyPort: "1" },
          activeMode: "fixed_servers"
        }
      }
    });
    env2.click("testButton");
    await env2.settle();
    const html = env2.els.testResult.innerHTML;
    t("M-4-f 恶意出口数据被转义（无原始 <script>）",
      html.indexOf("&lt;script&gt;") >= 0 && html.indexOf("<script>") < 0, html);
    t("M-4-g 恶意代理配置字段被转义",
      html.indexOf("&lt;b&gt;x&lt;/b&gt;") >= 0, html);
  }

  console.log("");
  console.log("== 外部审查修复（v2.12.0）：第 1 / 2 / 3 / 4 / 6 条的前台侧护栏 ==");
  {
    const BASE_SYNC = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" };

    // ---- 第 3 条：超长列表保存失败必须保留旧的有效规则（不得把 sync 清空） ----
    //   修复前：先写 sync 空串占位、再写 local。用户的列表短到能直接存 sync 时
    //   local 是空的，此时 local 写入失败 ⇒ sync="" 且 local 为空
    //   ⇒ resolveBypassList 得空串 ⇒ 原有直连规则凭空消失（一次失败保存改变路由）。
    {
      const env = buildChainEnv({
        syncStore: Object.assign({}, BASE_SYNC, { bypassList: "private.example" }),
        localStore: {},
        setFilter: (realm, area, obj) =>
          (realm === "popup" && area === "local" && obj.bypassList ? "模拟 local 写入失败" : null)
      });
      await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
      env.els.bypassList.value =
        Array.from({ length: 600 }, (_, i) => "h" + i + ".private.example").join("\n");
      env.click("saveButton");
      await env.settle(120);

      t("第3条-a 失败保存不得清空 sync 里的旧列表（否则旧规则凭空消失）",
        env.syncStore.bypassList === "private.example",
        "sync.bypassList=" + JSON.stringify(env.syncStore.bypassList));
      t("第3条-b 实际生效的绕过规则仍保留旧值（没有被清成空）",
        !!env.proxy.value && Array.isArray(env.proxy.value.rules.bypassList) &&
        env.proxy.value.rules.bypassList.indexOf("private.example") >= 0,
        JSON.stringify(env.proxy.value && env.proxy.value.rules.bypassList));
      t("第3条-c 如实报失败，不得谎报成功",
        env.hint().indexOf("保存失败") >= 0,
        JSON.stringify(env.hint()));
      t("第3条-d 全程未把 sync 写成空串占位（切换引用前必须确证落地成功）",
        !env.syncSetCalls.some(o => o.bypassList === ""),
        JSON.stringify(env.syncSetCalls));
    }

    // ---- 第 3 条（续）：写入回调成功但值【没有落地】→ 仍必须放弃切换引用 ----
    //   写入回调不报错 ≠ 值真的可读回。修复的核心动作是「切换 sync 占位引用之前
    //   先回读确证」，本用例把落地动作打成静默丢弃（回调成功、无 lastError、无 onChanged），
    //   证明那一层确证是承重的：删掉它，代码会带着未落地的值去写 sync 占位串，
    //   生效值被清成空 —— 与「先写 sync 空串」的原始缺陷是同一个数据丢失路径。
    {
      const env = buildChainEnv({
        syncStore: Object.assign({}, BASE_SYNC, { bypassList: "private.example" }),
        localStore: {},
        setDrop: (realm, area, obj) =>
          (realm === "popup" && area === "local" &&
            typeof obj.bypassList === "string" && obj.bypassList.length > 100)
      });
      await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
      env.els.bypassList.value =
        Array.from({ length: 600 }, (_, i) => "h" + i + ".private.example").join("\n");
      env.click("saveButton");
      await env.settle(150);

      t("第3条-e 写入回调成功但值未落地时：放弃切换引用，sync 不被清空",
        env.syncStore.bypassList === "private.example",
        "sync.bypassList=" + JSON.stringify(env.syncStore.bypassList));
      t("第3条-f 未确证落地时如实报错，不谎报成功",
        env.hint().indexOf("保存失败") >= 0, JSON.stringify(env.hint()));
    }

    // ---- 第 2 条：清理本机旧绕过列表失败，不得报成「设置已保存」 ----
    //   修复前：setStorage("local",{bypassList:""}).then(resolve, resolve) 把写入失败
    //   映射到与成功同一出口 ⇒ 用户清空了列表、sync 也是空串，但 local 清不掉
    //   ⇒ 生效值仍是旧列表（想取消直连的站点仍然绕过代理），界面却说保存成功。
    {
      const env = buildChainEnv({
        syncStore: Object.assign({}, BASE_SYNC, { bypassList: "example.com" }),
        localStore: { bypassList: "sensitive.example" },
        setFilter: (realm, area, obj) =>
          (realm === "popup" && area === "local" && obj.bypassList === "" ? "模拟 local 清理失败" : null)
      });
      await waitUntil(() => env.els.bypassList.value === "example.com");
      env.els.bypassList.value = "";
      env.click("saveButton");
      await env.settle(120);

      t("第2条-a 清理失败必须如实说明旧列表仍在生效，不得只报「设置已保存」",
        env.hint().indexOf("未能清除") >= 0 && env.hint().indexOf("仍会绕过代理") >= 0,
        JSON.stringify(env.hint()));
      t("第2条-b 失败是真实的（本机旧副本确实未被清掉）",
        env.localStore.bypassList === "sensitive.example",
        JSON.stringify(env.localStore.bypassList));
    }

    // ---- 第 1 条：内容不变的保存必须显式请求一次下发 ----
    //   后台唯一的下发驱动源是 storage.onChanged，而 Chrome 在写入值与库中原值
    //   完全相同时不产生任何 change（Chromium 的 LeveldbValueStore::AddToBatch）。
    //   因此「按恢复指引重新保存一次相同配置」不会触发下发 —— 指引本身失效。
    {
      const env = buildChainEnv({
        syncStore: Object.assign({}, BASE_SYNC, { bypassList: "private.example" }),
        localStore: {}
      });
      await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
      await env.settle(60);
      const appliedBefore = env.proxy.applied.length;
      env.click("saveButton");            // 表单内容与存储完全相同
      // 【测试稳定性修复】save() 的提示序列是「（载入后的空串）→ 异步置『设置已保存』
      //   → 再由下发结果覆盖」，其间有一次真实下发往返（约 200 ms）。固定 sleep(150)
      //   在负载下会假红。这里等到提示进入「终态」为止 —— 终态 = 既非载入期的空串、
      //   也非中间态『设置已保存』；不预设终态的具体文本，故第 1 条-b 仍是独立断言。
      await waitUntil(() => {
        const h = env.hint();
        return h !== "" && h !== "设置已保存";
      }, 3000);

      t("第1条-a 相同内容的保存仍会显式触发一次下发（不依赖 storage 事件）",
        env.proxy.applied.length === appliedBefore + 1,
        "before=" + appliedBefore + " after=" + env.proxy.applied.length);
      t("第1条-b 提示如实区分「已保存」与「已生效」",
        env.hint().indexOf("已按当前配置生效") >= 0,
        JSON.stringify(env.hint()));
    }

    // ---- 第 6 条：恢复阶段被接管，不得落到「代理确实生效」 ----
    //   修复前：background 返回 overriddenDuringRestore，但前台没有任何分支消费它，
    //   渲染链继续下落命中 result.ipChanged 的成功文案 ⇒ 同一屏上「被接管」与
    //   「✓ 代理确实生效」并存。
    {
      const env = buildChainEnv({
        syncStore: Object.assign({}, BASE_SYNC, { bypassList: "" }),
        localStore: {}
      });
      await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
      env.popupCtx.renderTest({
        ok: true,
        exit: { ok: true, ip: EXIT_IP },
        direct: { ok: true, ip: "192.0.2.1" },
        ipChanged: true,
        overriddenDuringRestore: "controlled_by_other_extensions",
        settings: { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" }
      });
      const html6 = env.els.testResult.innerHTML;
      t("第6条-a 恢复期被接管时不得出现「代理确实生效」的成功结论",
        html6.indexOf("代理确实生效") < 0, html6.slice(0, 200));
      t("第6条-b 必须如实说明接管发生在收尾写回时",
        html6.indexOf("被外部接管") >= 0 && html6.indexOf("收尾写回") >= 0,
        html6.slice(0, 200));
    }

    // ---- 第 4 条：禁用后实际沿用系统代理时，不得宣称「直连」 ----
    {
      const env = buildChainEnv({
        syncStore: Object.assign({}, BASE_SYNC, { bypassList: "" }),
        localStore: {}
      });
      await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
      env.popupCtx.renderStatus({
        status: "direct",
        systemProxy: "system",
        message: "已停用本扩展的代理；当前实际生效的是浏览器/系统自身的代理设置（system），并非直连"
      }, false);
      const stText = env.els.statusBar.textContent;
      t("第4条-a 带 systemProxy 的禁用态不得使用「未启用代理（直连）」文案",
        stText.indexOf("未启用代理（直连）") < 0, stText);
      t("第4条-b 必须说明沿用浏览器/系统自身的代理设置",
        stText.indexOf("沿用浏览器/系统自身的代理设置") >= 0, stText);
      // 【M-1·审计修复】禁用态的第三档：clear() 成功、回读实际模式失败。
      //   background 早就在 directState 上写 readFailed，但前台只消费了 systemProxy，
      //   于是本档落到「未启用代理（直连）」—— 与紧随其后的 message 直接矛盾。
      env.popupCtx.renderStatus({
        status: "direct",
        readFailed: true,
        message: "已停用本扩展的代理，但无法确证当前实际生效的模式（回读失败）；" +
          "浏览器可能正沿用系统或其它扩展的代理设置"
      }, false);
      const stTextUnverified = env.els.statusBar.textContent;
      t("第4条-c 回读失败的禁用态不得使用「未启用代理（直连）」文案",
        stTextUnverified.indexOf("未启用代理（直连）") < 0, stTextUnverified);
      t("第4条-d 回读失败的禁用态必须如实说明无法确证",
        stTextUnverified.indexOf("无法确证") >= 0, stTextUnverified);
      // 【L-05·审计修复】reason:"restore_interrupted" 此前在 popup 无文案，
      //   落到泛化的 error 档「代理异常，流量可能已回退直连」——而该情形是
      //   「对比窗口的恢复被 SW 回收打断、扩展已按最新设置重新下发」，语义相反。
      env.popupCtx.renderStatus({
        status: "error",
        reason: "restore_interrupted",
        message: "检测到上一次对比测试的恢复被中断，已按当前设置重新下发代理"
      }, false);
      const stTextRestore = env.els.statusBar.textContent;
      t("L-05-e 恢复被中断不得渲染为「代理异常/可能已回退直连」",
        stTextRestore.indexOf("代理异常") < 0 && stTextRestore.indexOf("恢复被中断") >= 0,
        stTextRestore);
    }

    // ---- M-2：重置默认同样必须分辨失败阶段、并消费下发结果 ----
    //   与第 2 条同族，但路径在 resetDefaults（第 2 条只改了 save）。
    //   修复前：sync 已恢复成默认值、只有本机旧列表没清掉时报「恢复失败」；
    //   且完全不消费 reapply 结果 —— 「已恢复默认」与「代理已按默认设置生效」
    //   被当成同一件事陈述。
    {
      const env = buildChainEnv({
        syncStore: Object.assign({}, BASE_SYNC, { bypassList: "example.com" }),
        localStore: {},
        setFilter: (realm, area, obj) =>
          (realm === "popup" && area === "local" && obj.bypassList === "" ? "模拟 local 清理失败" : null)
      });
      const DEF_BYPASS = env.popupCtx.EasyProxy.DEFAULTS.bypassList;
      await waitUntil(() => env.els.bypassList.value === "example.com");
      env.click("resetButton");
      await env.settle(60);
      env.click("resetButton");
      await env.settle(220);

      t("M-2-a sync 确实已恢复为默认列表（失败只发生在 local 清理这一步）",
        env.syncStore.bypassList === DEF_BYPASS,
        "sync.bypassList.length=" + String(env.syncStore.bypassList).length);
      t("M-2-b 该阶段不得笼统报「恢复失败」，须如实说清「已恢复默认但本机副本未清除」",
        env.hint().indexOf("恢复失败") < 0 &&
        env.hint().indexOf("已恢复默认") >= 0 && env.hint().indexOf("未能清除") >= 0,
        JSON.stringify(env.hint()));
      t("M-2-c 提示不得承诺「不受影响」——本机副本存在时它会被当成历史遗留重新生效",
        env.hint().indexOf("不受影响") < 0 && env.hint().indexOf("重新生效") >= 0,
        JSON.stringify(env.hint()));
      t("M-2-e local 的清理动作确实被尝试过（失败是真实的，不是假红）",
        env.localSetCalls.some(o => o && o.bypassList === ""),
        JSON.stringify(env.localSetCalls));
    }
    {
      // 成功路径必须消费下发结果：括号里的终态只可能来自 reportApplyOutcome。
      const env = buildChainEnv({
        syncStore: Object.assign({}, BASE_SYNC, { bypassList: "example.com" }),
        localStore: { bypassList: "sensitive.example" }
      });
      await waitUntil(() => env.els.bypassList.value === "example.com");
      env.click("resetButton");
      await env.settle(60);
      // 【测试稳定性修复】同 G6：等待提示被替换，替代固定 sleep(260)（实测 166–270 ms，
      //   正好压在预算上）。成功与否由下方断言判定，等待本身不预设结果。
      const confirmHintM2d = env.hint();
      env.click("resetButton");
      await waitUntil(() => env.hint() !== confirmHintM2d, 3000);

      t("M-2-d 恢复成功后必须按后台实际终态陈述（默认设置下为未启用代理）",
        env.hint().indexOf("已恢复默认设置（当前未启用代理）") >= 0,
        JSON.stringify(env.hint()));
    }
  }

  console.log("");
  // ==================== L-08：诊断导出（可观测性） ====================
  //   后台 getDiagnostics 返回的是「用户会直接贴进公开 issue」的快照，因此
  //   ① 脱敏是硬要求（不含出口 IP 与代理地址）、② 读取失败必须如实（读不到 ≠ 没有）、
  //   ③ 内容按文本渲染（存储里的 HTML 不得变成真实节点）—— 逐条守住。
  //   本段走【真实 background.js 的 getDiagnostics 分支】（经真实消息链路），
  //   而不是由测试自己编一个响应，否则就测不到 summarizeTest 的脱敏。
  console.log("== L-08：诊断导出 —— 快照脱敏、失败如实、内容按文本渲染 ==");
  {
    const L08_SYNC = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" };
    const seedSession = {
      lastState: { status: "applied", at: 1, message: "<img src=x onerror=alert(1)>" },
      lastTest: {
        ok: true,
        exit: { ok: true, ip: EXIT_IP, org: "Example Org" },
        direct: { ok: true, ip: "192.0.2.1" },
        ipChanged: true
      }
    };

    const env = buildChainEnv({ syncStore: Object.assign({}, L08_SYNC), localStore: {} });
    await waitUntil(() => proxyTarget(env.proxy.value) === "socks5 127.0.0.1:10808");
    await env.settle(40);
    env.setSessionState(seedSession);

    env.click("diagButton");
    // 完成信号只能等【占位文案消失】—— 占位文案「正在收集诊断信息…」本身含「诊断信息」，
    //   用它当谓词会立刻为真（本用例首版即踩此坑，故此处写明）。
    await waitUntil(() => env.els.testResult.textContent.indexOf("正在收集") < 0, 3000);
    await env.settle(30);          // 让链尾的 .then(done) 复位按钮
    const diagText = env.els.testResult.textContent;

    t("L-08-a 导出诊断渲染后台快照（含版本号，便于对照提交）",
      diagText.indexOf("已脱敏") >= 0 && diagText.indexOf(manifestVersion) >= 0,
      diagText.slice(0, 160));
    t("L-08-b 快照必须脱敏：不含出口 IP 原文，只保留结构性布尔（hasExit）",
      diagText.indexOf(EXIT_IP) < 0 && diagText.indexOf("192.0.2.1") < 0 &&
      diagText.indexOf("\"hasExit\": true") >= 0,
      diagText.slice(0, 320));
    t("L-08-c 快照按文本渲染：存储里的 HTML 不产生真实节点（textContent 而非 innerHTML）",
      env.els.testResult.innerHTML.indexOf("<img") < 0,
      env.els.testResult.innerHTML.slice(0, 200));
    t("L-08-d 导出结束后「导出诊断信息」按钮复位（不得永久禁用）",
      env.els.diagButton.disabled === false, "disabled=" + env.els.diagButton.disabled);

    // 后台无响应（回调 null）：不得停在「正在收集…」，也不得报成成功。
    const envNull = buildChainEnv({ syncStore: Object.assign({}, L08_SYNC), localStore: {} });
    await waitUntil(() => proxyTarget(envNull.proxy.value) === "socks5 127.0.0.1:10808");
    await envNull.settle(40);
    vm.runInContext('send = function () { return Promise.resolve(null); };', envNull.popupCtx);
    envNull.click("diagButton");
    await waitUntil(() => envNull.els.testResult.textContent.indexOf("正在收集") < 0, 3000);
    await envNull.settle(30);
    t("L-08-e 后台无响应时如实报失败，不停在「正在收集…」",
      envNull.els.testResult.textContent.indexOf("无法与后台通信") >= 0 &&
      envNull.els.testResult.textContent.indexOf("正在收集") < 0,
      envNull.els.testResult.textContent);
    t("L-08-f 后台无响应时按钮同样复位",
      envNull.els.diagButton.disabled === false, "disabled=" + envNull.els.diagButton.disabled);

    // 消息通道异常（rejected promise）：同样如实呈现原因。
    const envThrow = buildChainEnv({ syncStore: Object.assign({}, L08_SYNC), localStore: {} });
    await waitUntil(() => proxyTarget(envThrow.proxy.value) === "socks5 127.0.0.1:10808");
    await envThrow.settle(40);
    vm.runInContext('send = function () { return Promise.reject(new Error("消息通道异常（测试注入）")); };', envThrow.popupCtx);
    envThrow.click("diagButton");
    await waitUntil(() => envThrow.els.testResult.textContent.indexOf("正在收集") < 0, 3000);
    t("L-08-g 消息通道异常时如实报失败原因",
      envThrow.els.testResult.textContent.indexOf("消息通道异常（测试注入）") >= 0,
      envThrow.els.testResult.textContent);

    // session 读取失败：快照必须 ok:false + error，绝不伪装成「没有任何状态」。
    const envFail = buildChainEnv({ syncStore: Object.assign({}, L08_SYNC), localStore: {} });
    await waitUntil(() => proxyTarget(envFail.proxy.value) === "socks5 127.0.0.1:10808");
    await envFail.settle(40);
    envFail.readMode("bg", "session", "fail");
    envFail.click("diagButton");
    await waitUntil(() => envFail.els.testResult.textContent.indexOf("正在收集") < 0, 3000);
    const failText = envFail.els.testResult.textContent;
    t("L-08-h session 读取失败时 ok:false 且带 error（读不到 ≠ 没有）",
      failText.indexOf("\"ok\": false") >= 0 && failText.indexOf("\"error\":") >= 0,
      failText.slice(0, 220));
  }

  console.log("");
  // 【G1】文档一致性自检：README 声明的本套件断言数必须与实际通过数一致
{
  const g1 = require("./g1-consistency.js").g1ConsistencyCheck("tests/popup.test.js", pass);
  if (!g1.skipped && g1.declared !== pass) {
    fail++;
    console.log("  FAIL  G1 文档一致性：README 声明 " + g1.declared + " 项，实际通过 " + pass + " 项（改测试后请同步 README 对应行与合计）");
  }
}
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
