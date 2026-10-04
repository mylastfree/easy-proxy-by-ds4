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

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
