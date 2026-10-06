// tests/e2e-smoke.js —— 真实浏览器 E2E 冒烟（opt-in；【不】参与 npm test 与 CI 门禁）
// 运行：npm run e2e
//
// 【M-3·审计修复】为什么需要这个文件
//   在此之前，全部 788 项断言都跑在 Node 里的 chrome.* 桩对象上 —— 它们能证明
//   「我们的逻辑按预期处理了给定的回读结果」，但证明不了「Chrome 会给出我们所
//   假设的回读结果」。两者之间的差距正是本项目缺陷密度最高的地方：
//     · chrome.proxy.settings.clear() 只清「调用方槽位」，下层的系统/策略代理会重新
//       显现 —— 桩测试永远返回 direct，真实浏览器返回 system；
//     · 外部扩展接管后 levelOfControl 变成 controlled_by_other_extensions，
//       而桩测试里这个取值只有我们手写时才会出现。
//   本文件在真实 Chromium 里加载【打包产物】，覆盖五条主干：
//     ① 启用 → 回读 levelOfControl === controlled_by_this_extension 且
//        activeMode === fixed_servers（且 singleProxy 与我方设置逐字段一致）；
//     ② 禁用 → 回读确认未残留本扩展的 fixed_servers，且状态回到测试前基线；
//     ③ 外部接管（第二个扩展写入 chrome.proxy）→ 状态落 overridden 而非 applied，
//        且我方【不夺权】（生效配置仍是接管者的，不是我方的）；
//     ④ 真实流量归属（M-3 残余项）：本文件内起一个**最小 SOCKS5 代理**与一个
//        **本地源站**，页面正文由谁返回、两个计数器谁在增长，就是「流量到底走了谁」
//        的机器证明 —— ①②③ 只断言「状态结论与控制权归属」，证明不了「真流量是否
//        真的经代理」。用 `--host-resolver-rules` 造一个非 localhost 的主机名
//        （Chrome 对 localhost 有隐式绕过，用 127.0.0.1 会被绕过而测不到）；
//     ⑤ 存储配额降级：从 popup 表单真实保存一份超过 8192 字节的绕过列表，断言
//        `sync` 只留空串占位、`local` 持有全量、界面如实提示，并核实**降级后的整份
//        列表确实被 `chrome.proxy.settings` 采用**（只改存储不算修好）。
//
// 【为什么 ④ 只用 SOCKS5 与明文 HTTP】扩展只允许 socks5 / https 两种代理类型（见
//   settings.js 的 PROXY_TYPES），而 SOCKS5 是默认值、用户实际最常用的那条；HTTPS
//   代理需要自签证书与 `--ignore-certificate-errors`，等于把「证书信任被关闭」写进
//   测试，反而削弱其它断言的证据力。明文 HTTP 链路已能回答「流量是否经代理」这一
//   唯一问题；**HTTPS/CONNECT 隧道仍是人工项**（见 docs/E2E-SMOKE.md）。
//
// 【为什么是 opt-in 而不是并入 npm test】
//   1) 它需要额外的可选依赖（playwright-core）与一个 Chromium 二进制，二者都不属于
//      本扩展的运行时契约（本扩展仍是零运行时依赖、无构建）；
//   2) 它需要真实图形/进程环境，在纯 headless 容器里可能不可用 —— 并入 run-all.js
//      会让「测试必须环境无关」这条硬约束失效（本仓库已因固定 sleep + CPU 争用
//      踩过假红的坑）。因此它与 run-all.js / ci.yml 完全解耦，只作为发布前人工门禁。
//
// 退出码：0 = 全部通过；1 = 有断言失败（真实缺陷）；2 = 环境未就绪（缺少可选依赖 /
//   缺少 Chromium / 变异哨兵在位），此时【不计为失败】，按提示补齐环境后重跑。
//
// 环境变量：
//   E2E_CHROME_PATH  覆盖 Chromium 可执行文件路径
//   E2E_HEADLESS=1   以无头模式启动（默认有头，兼容性最好）
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { pack } = require("../tools/package.js");

const ROOT = path.join(__dirname, "..");
const WAIT_MS = 20000; // 单个「等待谓词成立」的上限；不用固定 sleep（见文件头第 2 点）

// 我方将要下发的代理与接管者将要下发的代理。端口刻意不同：③ 的「不夺权」断言
// 依赖「生效的 host/port 仍旧是接管者那一组」这一可观测差异。
const OUR_SYNC = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "10808" };
const OUR_PROXY = { scheme: "socks5", host: "127.0.0.1", port: "10808" };
const TAKEOVER_SYNC = { scheme: "http", host: "127.0.0.1", port: 19999 };

// ④ 真实流量用的「非 localhost 主机名」。Chrome 对 localhost / 127.0.0.1 有**隐式绕过**，
//   用它做目标会绕过代理、把「没走代理」误判成「代理不生效」；因此改用 .test 保留域，
//   再用 --host-resolver-rules 把它映射到 127.0.0.1（不依赖任何 DNS 或外网）。
const TARGET_HOST = "e2e-target.test";
// 两个应答体是 ④ 的判据主体：页面正文来自谁，就是流量走了谁。
const BODY_PROXY = JSON.stringify({ via: "socks5" });
const BODY_DIRECT = JSON.stringify({ via: "direct" });

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 环境未就绪：不计失败、不置红，按提示补齐即可。
function notReady(msg) {
  console.log("");
  console.log("  SKIP  E2E 冒烟未执行：" + msg);
  process.exit(2);
}

/* ==================== 环境探测 ==================== */

let chromium = null;
try {
  ({ chromium } = require("playwright-core"));
} catch (e) {
  notReady("缺少可选依赖 playwright-core。执行：npm i -D playwright-core " +
    "（它自带零依赖，不会下载浏览器二进制）");
}

function findChromium() {
  if (process.env.E2E_CHROME_PATH) {
    return fs.existsSync(process.env.E2E_CHROME_PATH) ? process.env.E2E_CHROME_PATH : null;
  }
  // 先问 Playwright 自己认哪条路径，再退回本机缓存目录扫描。
  //   两者都不依赖任何 URL 构造，避免给测试环境额外引入全局名。
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* 落到目录扫描 */ }
  const base = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const bases = [base, path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright")];
  for (const b of bases) {
    if (!fs.existsSync(b)) continue;
    for (const d of fs.readdirSync(b).filter((x) => /^chromium-\d+$/.test(x))) {
      for (const rel of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = path.join(b, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/* ==================== ④ 用的两个本地服务（不联网、端口随机） ==================== */

// 本地「源站」：只有**绕过代理/未启用代理**时浏览器才会直接连到它。
//   因此它的命中数就是「真实直连发生了」的计数器。
function startOriginServer() {
  const state = { hits: 0, urls: [] };
  const srv = http.createServer((req, res) => {
    state.hits++;
    state.urls.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(BODY_DIRECT);
  });
  return new Promise((resolve) => {
    srv.on("error", () => {});
    srv.listen(0, "127.0.0.1", () => resolve({ srv, state, port: srv.address().port }));
  });
}

// 最小 SOCKS5 代理：no-auth + CONNECT，握手成功后自己回一个固定 HTTP 应答。
//   刻意**不转发**到真实目标 —— 本测试要回答的问题是「流量是否经代理」，
//   由「谁返回了正文」直接回答最不易误判；真转发会引入外部网络依赖。
//   记下浏览器请求的目标（host:port），用于确认代理确实是为**该目标**被调用的。
//   注意：Chrome 自身的后台流量（实测有 www.google.com:443）也会走这个代理，
//   所以断言必须按**目标主机**分别计数，不能用总命中数。
function startSocks5Proxy() {
  const state = { hits: 0, dests: [] };
  const srv = net.createServer((sock) => {
    sock.on("error", () => {});
    let phase = "greet";
    // 刻意用一个普通数字数组当字节队列，而不是 Buffer/拼接：本仓库的 eslint 全局
    //   白名单刻意不含 Buffer，用它会被 no-undef 直接拦下（这是既有约定，不是疏漏）。
    //   SOCKS5 握手报文只有几十字节，数组完全够用。
    const q = [];
    const drain = () => {
      if (phase === "greet") {
        if (q.length < 2) return;
        const nm = q[1];
        if (q.length < 2 + nm) return;
        const methods = q.slice(2, 2 + nm);
        q.splice(0, 2 + nm);
        if (methods.indexOf(0) < 0) { sock.end(Uint8Array.from([5, 0xff])); return; }
        sock.write(Uint8Array.from([5, 0]));
        phase = "connect";
      }
      if (phase !== "connect") return;
      if (q.length < 5) return;
      const atyp = q[3];
      let host, portAt;
      if (atyp === 1) { host = [q[4], q[5], q[6], q[7]].join("."); portAt = 8; }
      else if (atyp === 3) { host = String.fromCharCode.apply(null, q.slice(5, 5 + q[4])); portAt = 5 + q[4]; }
      else if (atyp === 4) { host = "ipv6"; portAt = 20; }
      else return;
      if (q.length < portAt + 2) return;
      const port = (q[portAt] << 8) | q[portAt + 1];
      q.splice(0, portAt + 2);
      state.hits++;
      state.dests.push(host + ":" + port);
      // 0.0.0.0:0 的 BND.ADDR/BND.PORT 只是建议值，Chrome 接受。
      sock.write(Uint8Array.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      phase = "serve";
      // 应答体是纯 ASCII，.length 即字节数（避免引入 Buffer.byteLength）
      sock.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
        "Cache-Control: no-store\r\nContent-Length: " + BODY_PROXY.length +
        "\r\nConnection: close\r\n\r\n" + BODY_PROXY);
      sock.end();
    };
    sock.on("data", (d) => {
      for (const b of d) q.push(b);
      drain();
    });
  });
  return new Promise((resolve) => {
    srv.on("error", () => {});
    srv.listen(0, "127.0.0.1", () => resolve({ srv, state, port: srv.address().port }));
  });
}

// 某个目标主机:端口在这个 SOCKS5 代理上被请求过几次（免疫 Chrome 后台流量的噪声）。
function hitsForDest(state, dest) {
  return state.dests.filter((d) => d === dest).length;
}

/* ==================== 与被测扩展对话的小工具 ==================== */

// "chrome-extension://<id>/..." → <id>
function extIdOf(url) {
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(url || "");
  return m ? m[1] : null;
}

// 把「控制权 + 生效模式 + singleProxy」压成可比较签名。
//   与 background.js 的 proxySignature 同一形状（四项），但这里独立实现：
//   本文件测的就是 background 在真实浏览器里的行为，复用被测方的实现做断言
//   会让「被测方算错了」与「期望值算错了」无法区分。
function sig(p) {
  return JSON.stringify([
    p.level || null,
    p.mode || null,
    p.sp ? [p.sp.scheme || null, p.sp.host || null, String(p.sp.port)] : null
  ]);
}

// 在给定扩展页面里回读 chrome.proxy.settings.get。
//   刻意用回调查询（而非 await 形式）：扩展页面的 chrome.proxy 在部分版本下
//   不返回 Promise，回调查询是三平台都成立的写法。
function readProxy(page) {
  return page.evaluate(() => new Promise((resolve) => {
    chrome.proxy.settings.get({ incognito: false }, (d) => {
      void chrome.runtime.lastError;
      const v = (d && d.value) || {};
      resolve({
        level: (d && d.levelOfControl) || null,
        mode: v.mode || null,
        sp: (v.rules && v.rules.singleProxy) || null
      });
    });
  }));
}

function readLastState(page) {
  return page.evaluate(async () => {
    const s = await chrome.storage.session.get(["lastState"]);
    return s.lastState || null;
  });
}

// 回读「代理规则」的完整形状，重点是 bypassList —— ⑤ 要证实降级后的整份列表
//   确实被 chrome.proxy.settings 采用，而不只是躺在存储里。
function readProxyRules(page) {
  return page.evaluate(() => new Promise((resolve) => {
    chrome.proxy.settings.get({ incognito: false }, (d) => {
      void chrome.runtime.lastError;
      const v = (d && d.value) || {};
      resolve({
        level: (d && d.levelOfControl) || null,
        mode: v.mode || null,
        bypass: (v.rules && v.rules.bypassList) || []
      });
    });
  }));
}

// ⑤ 的现场快照：两处存储的**长度**与界面提示文案，一次 evaluate 取全。
//   刻意不返回绕过列表原文：9.7 KB 的文本会把失败信息刷屏，反而淹掉真正的原因。
//   三者必须一起取 —— 降级链路的终点才是界面提示，只等存储会读到「写了一半」的中间态。
function readQuotaState(page) {
  return page.evaluate(async () => {
    const l = await chrome.storage.local.get(["bypassList"]);
    const s = await chrome.storage.sync.get(["bypassList"]);
    const h = document.querySelector("#hint");
    return {
      localLen: typeof l.bypassList === "string" ? l.bypassList.length : -1,
      syncHasKey: Object.prototype.hasOwnProperty.call(s, "bypassList"),
      syncLen: typeof s.bypassList === "string" ? s.bypassList.length : -1,
      hint: h ? h.textContent || "" : ""
    };
  });
}

// 真实用户路径：往表单里填 → 点保存。填完先回读一次表单值，避免后台重绘把用户
//   输入覆盖掉之后再保存（那会把「保存的是旧值」误判成「保存逻辑有缺陷」）。
function fillForm(page, values) {
  return page.evaluate((v) => {
    document.querySelector("#proxyHost").value = v.host;
    document.querySelector("#proxyPort").value = v.port;
    document.querySelector("#proxyType").value = v.type;
    document.querySelector("#bypassList").value = v.bypass;
    return {
      host: document.querySelector("#proxyHost").value,
      port: document.querySelector("#proxyPort").value,
      type: document.querySelector("#proxyType").value,
      bypassSame: document.querySelector("#bypassList").value === v.bypass
    };
  }, values);
}

// 打开一次被测页面并在其上下文里导航到目标 URL，返回页面正文。
//   每次带一个 cache-buster：反复访问同一 URL 时，disk cache 会让某一次
//   「绕过代理」的结果看起来像「经代理」（正文来自缓存），必须排除。
async function fetchVia(page, url) {
  const u = url + (url.indexOf("?") < 0 ? "?" : "&") + "e2e=" + Date.now();
  try {
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 15000 });
  } catch (e) {
    return "GOTO-ERR:" + ((e && e.message) || e);
  }
  return page.evaluate(() => document.body && document.body.textContent);
}

// 写入 sync 后显式索取一次下发：既有测试已证明「写入值与库中相同」时 Chromium
//   不派发 onChanged，因此必须用 reapply 作为【完成信号】——它 resolve 时，
//   串行下发队列已经跑到本次请求的尾部，比任何固定 sleep 都可靠。
function applySettings(page, patch) {
  return page.evaluate(async (p) => {
    await chrome.storage.sync.set(p);
    return chrome.runtime.sendMessage({ action: "reapply" });
  }, patch);
}

// 轮询等待谓词成立。返回最后一次观测值，便于失败时把现场打进日志。
async function waitFor(read, pred, label) {
  const deadline = Date.now() + WAIT_MS;
  let last = null;
  for (;;) {
    try { last = await read(); } catch (e) { last = null; }
    if (pred(last)) return { ok: true, value: last };
    if (Date.now() >= deadline) return { ok: false, value: last, label: label };
    await delay(150);
  }
}

// 收集 service worker，直到两个扩展都被识别。
//   夹具扩展的 ID 由 Chromium 随机分配、无法预知，因此只能通过
//   chrome.runtime.getManifest().name 反查，不能硬编码扩展页面 URL。
async function identifyWorkers(ctx, nameA, nameB, timeoutMs) {
  const byName = new Map();
  const deadline = Date.now() + timeoutMs;
  async function harvest() {
    for (const w of ctx.serviceWorkers()) {
      const id = extIdOf(w.url());
      if (!id || byName.has(id)) continue;
      try {
        const info = await w.evaluate(() => {
          const m = chrome.runtime.getManifest();
          return { name: m.name, version: m.version };
        });
        byName.set(id, { name: info.name, version: info.version, url: w.url() });
      } catch (e) { /* worker 正在启动或关闭，下一轮再试 */ }
    }
  }
  for (;;) {
    await harvest();
    const names = [...byName.values()].map((v) => v.name);
    if (names.indexOf(nameA) >= 0 && names.indexOf(nameB) >= 0) break;
    if (Date.now() >= deadline) break;
    await delay(200);
  }
  const pick = (n) => {
    for (const [id, v] of byName) if (v.name === n) return { id: id, version: v.version };
    return null;
  };
  return { own: pick(nameA), inter: pick(nameB), all: [...byName.entries()] };
}

/* ==================== 主流程 ==================== */

(async () => {
  const repoManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const fixtureDir = path.join(__dirname, "e2e", "fixtures", "interloper");
  const fixtureManifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));

  const exe = findChromium();
  if (!exe) {
    notReady("未找到 Chromium 可执行文件。设置 E2E_CHROME_PATH 指向 chrome/chromium，" +
      "或执行 npx playwright-core install chromium 后重试");
  }

  // 被测对象 = 打包产物，而不是工作树。
  //   工作树里混着 node_modules/ 与 tests/，把它整目录交给 --load-extension 既慢、
  //   又让「E2E 究竟验证了哪份文件」变得含糊；用 tools/package.js 产出与发布完全
  //   同源的那份文件，顺带把「产物真的能被 Chrome 加载」也纳入验证范围。
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "easy-proxy-e2e-"));
  let extDir, profileDir, ctx, origin = null, proxy = null;
  try {
    // ④ 需要的两个本地服务：源站（直连计数器）+ 最小 SOCKS5 代理（经代理计数器）。
    origin = await startOriginServer();
    proxy = await startSocks5Proxy();
    const targetUrl = "http://" + TARGET_HOST + ":" + origin.port + "/";
    const destKey = TARGET_HOST + ":" + origin.port;

    let packed;
    try {
      packed = pack(tmpRoot);
    } catch (e) {
      notReady("打包被测扩展失败（" + ((e && e.message) || e) + "）。" +
        "若提示变异测试正在运行，请等门禁结束后重跑");
    }
    extDir = packed.dest;
    console.log("被测产物：" + path.relative(ROOT, extDir).replace(/\\/g, "/") +
      "（版本 " + packed.version + "）");
    console.log("Chromium：" + exe);
    console.log("本地源站：" + targetUrl + "（直连计数器）");
    console.log("本地 SOCKS5：" + "127.0.0.1:" + proxy.port + "（经代理计数器）");
    console.log("（临时目录 " + tmpRoot + " 将在结束时清理）");
    console.log("");

    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "easy-proxy-e2e-profile-"));
    ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath: exe,
      headless: process.env.E2E_HEADLESS === "1",
      args: [
        "--disable-extensions-except=" + extDir + "," + fixtureDir,
        "--load-extension=" + extDir + "," + fixtureDir,
        // ④ 的前提：让 TARGET_HOST 解析到本机，从而能造出「非 localhost 的本地目标」
        //   （Chrome 对 localhost 有隐式绕过，用 127.0.0.1 会绕过代理而测不到）。
        "--host-resolver-rules=MAP " + TARGET_HOST + " 127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    });

    console.log("== 加载与自检 ==");
    const found = await identifyWorkers(ctx, repoManifest.name, fixtureManifest.name, WAIT_MS);
    if (!found.own || !found.inter) {
      t("两个扩展都已在浏览器中启用", false,
        "已识别：" + JSON.stringify(found.all.map((e) => e[1].name)));
      throw new Error("扩展未能加载，后续断言无法进行");
    }
    t("被测扩展已在浏览器中启用（SW 可达）", !!found.own, found.own && found.own.id);
    t("夹具扩展已在浏览器中启用（用于模拟外部接管）", !!found.inter, found.inter && found.inter.id);
    t("浏览器里加载的版本 = 仓库 manifest.version（E2E 确实在测本次产物）",
      found.own.version === repoManifest.version,
      "浏览器=" + found.own.version + " / 仓库=" + repoManifest.version);
    t("夹具扩展与被测扩展是两个不同扩展（否则接管场景无意义）",
      found.own.id !== found.inter.id);

    // 我方页面：用产品自己的 popup 页面，走与用户完全相同的消息通道
    //   （SW 对自身 sendMessage 不通 —— 实测 "Receiving end does not exist"，
    //    且 onMessage 的来源校验要求 sender.id === 自身 id，页面是本扩展的合法发送方）。
    const own = await ctx.newPage();
    const ownErrors = [];
    own.on("pageerror", (e) => ownErrors.push((e && e.message) || String(e)));
    await own.goto("chrome-extension://" + found.own.id + "/popup.html", { waitUntil: "domcontentloaded" });

    const baseline = await readProxy(own);
    console.log("  基线（未启用任何设置）：" + sig(baseline));

    /* ---- 主干① 启用 → 回读确证生效 ---- */
    console.log("");
    console.log("== 主干① 启用 → 回读 levelOfControl === controlled_by_this_extension 且 mode === fixed_servers ==");
    const enabled = await applySettings(own, OUR_SYNC);
    t("启用后下发返回 applied（完成信号）", !!enabled && enabled.status === "applied",
      JSON.stringify(enabled));
    const w1 = await waitFor(() => readProxy(own),
      (p) => p && p.level === "controlled_by_this_extension" && p.mode === "fixed_servers",
      "回读未落 controlled_by_this_extension + fixed_servers");
    t("回读 levelOfControl === controlled_by_this_extension 且 mode === fixed_servers",
      w1.ok, sig(w1.value || {}));
    t("回读的 singleProxy 与我方设置逐字段一致（scheme/host/port）",
      !!w1.value && !!w1.value.sp &&
      w1.value.sp.scheme === OUR_PROXY.scheme &&
      w1.value.sp.host === OUR_PROXY.host &&
      String(w1.value.sp.port) === OUR_PROXY.port,
      JSON.stringify(w1.value && w1.value.sp));
    const s1 = await waitFor(() => readLastState(own),
      (s) => s && s.status === "applied", "lastState 未落 applied");
    t("session.lastState.status === applied（前台会据此宣称已生效）",
      s1.ok, JSON.stringify(s1.value));

    /* ---- 主干② 禁用 → 未残留 + 回到基线 ---- */
    console.log("");
    console.log("== 主干② 禁用 → 未残留本扩展的 fixed_servers，且状态回到测试前基线 ==");
    const disabled = await applySettings(own, { enableProxy: false });
    t("禁用后下发返回 direct（完成信号）", !!disabled && disabled.status === "direct",
      JSON.stringify(disabled));
    const w2 = await waitFor(() => readProxy(own),
      (p) => p && !(p.sp && p.sp.host === OUR_PROXY.host && String(p.sp.port) === OUR_PROXY.port),
      "回读仍残留我方代理");
    t("回读确认未残留我方下发的 singleProxy（host:port 不再是 127.0.0.1:10808）",
      w2.ok, sig(w2.value || {}));
    t("回读 mode 不再是本扩展下发的 fixed_servers",
      !!w2.value && !(w2.value.mode === "fixed_servers" && w2.value.sp &&
        String(w2.value.sp.port) === OUR_PROXY.port),
      sig(w2.value || {}));
    // 与基线逐字段比对：这是唯一能同时覆盖「Linux 无代理 → direct」与
    //   「Windows 系统代理 → system」两种真实环境的判据（实测本机为 system）。
    const w2b = await waitFor(() => readProxy(own), (p) => p && sig(p) === sig(baseline),
      "回读未回到基线 " + sig(baseline));
    t("回读签名完全回到测试前基线（clear 只清我方槽位，下层配置原样显现）",
      w2b.ok, "实际=" + sig(w2b.value || {}));
    const s2 = await waitFor(() => readLastState(own),
      (s) => s && s.status === "direct", "lastState 未落 direct");
    t("session.lastState.status === direct（确证未启用）", s2.ok, JSON.stringify(s2.value));
    // 「未启用」不等于「直连」：实际生效模式非 direct 时，状态必须【如实】带上它，
    //   否则界面会把「浏览器/系统自身的代理在生效」说成直连（第 4 条·审计修复）。
    const actual2 = await readProxy(own);
    t("实际生效模式非 direct 时，lastState 如实上报 systemProxy（不谎称直连）",
      actual2.mode === "direct" ||
      (!!s2.value && s2.value.systemProxy === actual2.mode),
      "mode=" + actual2.mode + "；systemProxy=" + JSON.stringify(s2.value && s2.value.systemProxy));

    /* ---- 主干④ 真实流量归属（M-3 残余项）---- */
    console.log("");
    console.log("== 主干④ 真实流量是否真的经代理（本地源站 + 本地 SOCKS5，不联网）==");
    // 与 ①②③ 的分工：那三条只断言「状态结论与控制权归属」，本组断言**流量到底走了谁**。
    //   判据只有两个计数器：正文由谁返回（via）、两个服务各自被命中几次。
    const tab = await ctx.newPage();

    // ④-1 启用 → 必须经代理
    const t1 = await applySettings(own, {
      enableProxy: true, proxyType: "socks5",
      proxyHost: "127.0.0.1", proxyPort: String(proxy.port), bypassList: ""
    });
    t("④ 启用测试代理后下发返回 applied（完成信号）", !!t1 && t1.status === "applied", JSON.stringify(t1));
    const socksPre1 = hitsForDest(proxy.state, destKey);
    const originPre1 = origin.state.hits;
    const body1 = await fetchVia(tab, targetUrl);
    t("④ 真实流量经代理：页面正文由代理端返回（via=socks5）而非源站",
      body1 === BODY_PROXY, "body=" + body1);
    t("④ 代理端确实收到**该目标**的 CONNECT（目标 host:port 逐字段一致）",
      hitsForDest(proxy.state, destKey) > socksPre1,
      "该目标命中 " + socksPre1 + " → " + hitsForDest(proxy.state, destKey) +
      "；收到的目标=" + JSON.stringify(proxy.state.dests.slice(0, 6)));
    t("④ 源站完全未被直接访问（证明流量没有绕开代理走后门）",
      origin.state.hits === originPre1, "源站命中 " + originPre1 + " → " + origin.state.hits);

    // ④-2 禁用 → 必须不再经本扩展下发的代理
    const t2 = await applySettings(own, { enableProxy: false });
    t("④ 禁用后下发返回 direct（完成信号）", !!t2 && t2.status === "direct", JSON.stringify(t2));
    const socksPre2 = hitsForDest(proxy.state, destKey);
    const body2 = await fetchVia(tab, targetUrl);
    t("④ 禁用后不再经本扩展下发的代理（该目标在测试代理上的命中数不增）",
      hitsForDest(proxy.state, destKey) === socksPre2,
      "该目标命中 " + socksPre2 + " → " + hitsForDest(proxy.state, destKey));
    t("④ 禁用后页面正文不再来自代理端", body2 !== BODY_PROXY, "body=" + body2);
    // 刻意**不**在这里断言「正文来自源站」：禁用后生效的是下层的 system 代理（本机实测
    //   回读为 system），下一跳由系统配置决定，不是本扩展的行为。「真的走到了本机网络」
    //   由 ④-3 证明 —— 那一组里扩展处于启用态且显式绕过，Chrome 完全不使用任何代理。

    // ④-3 绕过列表命中 → 必须真直连
    const t3 = await applySettings(own, {
      enableProxy: true, proxyType: "socks5",
      proxyHost: "127.0.0.1", proxyPort: String(proxy.port), bypassList: TARGET_HOST
    });
    t("④ 绕过列表命中时仍下发 applied（配置本身生效，排除「整体失败」的误判）",
      !!t3 && t3.status === "applied", JSON.stringify(t3));
    const socksPre3 = hitsForDest(proxy.state, destKey);
    const originPre3 = origin.state.hits;
    const body3 = await fetchVia(tab, targetUrl);
    t("④ 绕过列表命中时页面正文来自源站（via=direct，绕过规则真的生效）",
      body3 === BODY_DIRECT, "body=" + body3);
    t("④ 绕过列表命中时源站命中数增加（流量真的到达了本机网络）",
      origin.state.hits > originPre3, "源站命中 " + originPre3 + " → " + origin.state.hits);
    t("④ 绕过列表命中时未使用代理（该目标在测试代理上的命中数不增）",
      hitsForDest(proxy.state, destKey) === socksPre3,
      "该目标命中 " + socksPre3 + " → " + hitsForDest(proxy.state, destKey));

    /* ---- 主干⑤ 存储配额：超长绕过列表降级到 local，且在真实浏览器里生效 ---- */
    console.log("");
    console.log("== 主干⑤ 超长绕过列表必须降级到 storage.local（sync 单键 8192 字节上限）==");
    // 601 条规则 ≈ 9.7 KB，超过 sync 单键 8192 字节上限；# 开头是注释、空行会被丢弃，
    //   因此这里刻意不用注释行，让「条目数」这条断言可直接核对。
    const QUOTA_MARKER = "quota-marker.test";
    const longList = [QUOTA_MARKER].concat(
      Array.from({ length: 600 }, (_, i) => "quota-fill-" + (i + 1) + ".test")
    ).join("\n");
    const form = await fillForm(own, {
      host: "127.0.0.1", port: String(proxy.port), type: "socks5", bypass: longList
    });
    t("⑤ 表单填写后仍是我们要保存的值（防止后台重绘覆盖用户输入后「存了旧值」）",
      form.host === "127.0.0.1" && form.port === String(proxy.port) &&
      form.type === "socks5" && form.bypassSame,
      JSON.stringify({ host: form.host, port: form.port, type: form.type, bypassSame: form.bypassSame }));
    await own.click("#saveButton");
    const qReady = await waitFor(() => readQuotaState(own),
      (v) => v && v.localLen === longList.length && v.syncHasKey && v.syncLen === 0 &&
        v.hint.indexOf("已存于本地") >= 0,
      "超长列表的降级链路未在限时内走完");
    const qv = qReady.value || {};
    t("⑤ 超长列表降级链路在限时内走完（local 落地 + sync 占位 + 界面提示三者齐备）",
      qReady.ok, JSON.stringify({ localLen: qv.localLen, syncLen: qv.syncLen, hint: qv.hint }));
    t("⑤ 超长列表写入 storage.local（本机保存，不跨设备同步）",
      qv.localLen === longList.length, "local 长度=" + qv.localLen + " 期望=" + longList.length);
    t("⑤ storage.sync 只留空串占位（不试图把超限值写进 sync）",
      qv.syncHasKey === true && qv.syncLen === 0, JSON.stringify({ hasKey: qv.syncHasKey, len: qv.syncLen }));
    t("⑤ 界面如实提示「已存于本地（不跨设备同步）」（不假装已同步）",
      (qv.hint || "").indexOf("已存于本地") >= 0, "hint=" + JSON.stringify(qv.hint));
    const w5 = await waitFor(() => readProxyRules(own),
      (r) => r && Array.isArray(r.bypass) && r.bypass.indexOf(QUOTA_MARKER) >= 0,
      "真实 proxy 配置未采用降级后的列表");
    t("⑤ 降级后的列表确实被 chrome.proxy.settings 采用（降级不是只改存储）",
      w5.ok, "bypass 首项=" + JSON.stringify((w5.value && w5.value.bypass || []).slice(0, 3)));
    t("⑤ 降级后是**整份**列表进配置（不是只进了前几条）",
      !!w5.value && w5.value.bypass.length >= 601,
      "bypass 条目数=" + ((w5.value && w5.value.bypass && w5.value.bypass.length) || 0));
    await applySettings(own, { enableProxy: false });
    const q4 = await waitFor(() => readQuotaState(own),
      (v) => v && v.localLen === longList.length, "关闭代理后长列表丢失");
    t("⑤ 关闭代理后超长列表不丢失（local 仍是用户唯一副本）",
      q4.ok, "local 长度=" + ((q4.value && q4.value.localLen) || "?"));

    /* ---- 主干③ 外部接管 → overridden，且不夺权 ---- */
    console.log("");
    console.log("== 主干③ 外部接管（第二个扩展写入 chrome.proxy）→ overridden 而非 applied ==");
    const reenabled = await applySettings(own, OUR_SYNC);
    const w3pre = await waitFor(() => readProxy(own),
      (p) => p && p.level === "controlled_by_this_extension" && p.mode === "fixed_servers",
      "接管前未能重新落回我方控制");
    t("接管前先确证我方处于 controlled + fixed_servers（保证第③条测的是「被抢走」而非「从未拿到」）",
      w3pre.ok, sig(w3pre.value || {}) + " / reapply=" + JSON.stringify(reenabled));

    const interPage = await ctx.newPage();
    const interErrors = [];
    interPage.on("pageerror", (e) => interErrors.push((e && e.message) || String(e)));
    await interPage.goto("chrome-extension://" + found.inter.id + "/takeover.html",
      { waitUntil: "domcontentloaded" });
    const takeoverErr = await interPage.evaluate((cfg) => new Promise((resolve) => {
      chrome.proxy.settings.set({
        value: { mode: "fixed_servers", rules: { singleProxy: cfg } },
        scope: "regular"
      }, () => {
        const err = chrome.runtime.lastError;
        resolve(err ? err.message : null);
      });
    }), TAKEOVER_SYNC);
    t("夹具扩展成功写入自己的 fixed_servers（外部接管已发生）", takeoverErr === null,
      String(takeoverErr));

    const s3 = await waitFor(() => readLastState(own),
      (s) => s && s.status === "overridden", "lastState 未落 overridden");
    t("session.lastState.status === overridden（而非 applied —— 这是本条的验收要点）",
      s3.ok, JSON.stringify(s3.value));
    t("overridden 状态带上真实控制权取值（不吞掉 levelOfControl）",
      !!s3.value && s3.value.levelOfControl === "controlled_by_other_extensions",
      JSON.stringify(s3.value && s3.value.levelOfControl));

    const w3 = await readProxy(own);
    t("从我方页面回读：控制权已不在我方白名单内",
      w3.level !== "controlled_by_this_extension" && w3.level !== "controllable_by_this_extension",
      sig(w3));
    t("我方【未夺权】：生效的 singleProxy 仍是接管者的（127.0.0.1:19999），不是我方的 10808",
      !!w3.sp && w3.sp.host === TAKEOVER_SYNC.host &&
      String(w3.sp.port) === String(TAKEOVER_SYNC.port),
      JSON.stringify(w3.sp));

    /* ---- 页面级回归护栏 ---- */
    console.log("");
    console.log("== 页面级错误护栏 ==");
    t("popup 页面在整个流程中未抛未捕获异常", ownErrors.length === 0, ownErrors.join(" | "));
    t("夹具页面未抛未捕获异常", interErrors.length === 0, interErrors.join(" | "));
  } catch (e) {
    fail++;
    console.log("  FAIL  E2E 流程中断  -> " + ((e && e.stack) || e));
  } finally {
    if (ctx) { try { await ctx.close(); } catch (e) { /* 已关闭 */ } }
    if (origin) { try { origin.srv.close(); } catch (e) { /* 已关闭 */ } }
    if (proxy) { try { proxy.srv.close(); } catch (e) { /* 已关闭 */ } }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ }
    if (profileDir) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ } }
  }

  console.log("");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})();
