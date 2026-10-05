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
  const warns = [];          // 【L-4】记录 console.warn，用于断言「某个保守分支确实被走到」
  const titles = [];         // 【L-7】记录 action.setTitle，用于断言图标标题与状态条同档
  let proxySetCount = 0;     // 【L-3】已完成的 chrome.proxy.settings.set 次数（回读注入用）
  let proxyActive = false;   // 当前是否挂着代理（决定 fetch 返回哪个出口 IP）
  let fetchCount = 0;
  let proxyActiveAtDirectFetch = null;   // 「取直连出口」时刻的代理状态

  function makeArea(store, areaName) {
    return {
      get(keys, cb) {
        // 【L-4】可控的读取失败注入：用于覆盖 background.js 两处「读不到 ≠ 没有」的
        //   保守分支（存量污染自愈跳过本轮、待恢复对账仍照常下发）。
        //   默认不注入 —— 既有用例的桩行为逐字节不变。
        if (opts.storageGetError && opts.storageGetError(areaName, keys)) {
          setTimeout(() => {
            sandbox.chrome.runtime.lastError = { message: "simulated storage read failure (" + areaName + ")" };
            cb(undefined);
            // 与真实 Chrome 一致：lastError 只在本次回调期间可见，回调返回即清除
            // （否则会污染后续无关的 storage 回调，让它们误判为失败）。
            sandbox.chrome.runtime.lastError = undefined;
          }, 0);
          return;
        }
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
      },
      // 【S2】background.js 的 clearPendingRestore 使用 session.remove：
      //   缺少该桩会让对比窗口的 finally 抛 TypeError，suspendDepth 永不递减
      //   （N1 同型泄漏），整套并发护栏连锁变红。
      remove(keys, cb) {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) delete store[k];
        setTimeout(() => { if (cb) cb(); }, 0);
      }
    };
  }

  const sandbox = {
    console: { log() {}, warn(...a) { warns.push(a.map(String).join(" ")); }, error() {} },
    TextEncoder, setTimeout, clearTimeout, Date, Promise, Object, Array, JSON,
    Number, String, Math, Boolean, Error, AbortController
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = () => vm.runInContext(settingsSrc, sandbox, { filename: path.join(__dirname, '..', 'settings.js') });

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
          proxySetCount++;
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
          setTimeout(() => {
            // 【L-3】可控的代理回读注入：覆盖 applyProxyCore 的三条失败分支
            //   （回读失败 / 回读缺 levelOfControl / 被外部接管）。
            //   回调收到 proxySetCount，便于按「是否已下发过」切换返回值，
            //   而不依赖绝对调用序号（启动路径本身也会调用本接口）。
            //   返回 null 表示模拟 lastError → readProxyDetails 解析为 null。
            if (typeof opts.proxyGet === "function") {
              const payload = opts.proxyGet(proxySetCount);
              if (payload === null) {
                sandbox.chrome.runtime.lastError = { message: "simulated proxy read failure" };
                cb(undefined);
                // 同 storage 桩：lastError 只在本次回调期间可见
                sandbox.chrome.runtime.lastError = undefined;
                return;
              }
              sandbox.chrome.runtime.lastError = undefined;
              cb(payload);
              return;
            }
            cb({
              value: proxyActive ? { mode: "fixed_servers" } : { mode: "system" },
              levelOfControl: "controlled_by_this_extension"
            });
          }, 0);
        },
        // R6-04：background.js 会注册 chrome.proxy.settings.onChange；
        //   缺少该桩会让脚本一加载就抛 TypeError，整套用例连锁失败。
        onChange: { addListener(f) { listeners.onChange.push(f); } }
      },
      onProxyError: { addListener() {} }
    },
    action: {
      setIcon: (o, cb) => setTimeout(() => cb && cb(), 0),
      // 【L-7】记录标题：用于断言图标档位与状态条同档（含 M-1 的直连三档）。
      setTitle: (o, cb) => { titles.push(o); setTimeout(() => cb && cb(), 0); }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(bgSrc, sandbox, { filename: path.join(__dirname, '..', 'background.js') });

  return { sandbox, syncStore, localStore, sessionStore, applied, listeners,
           warns, titles,
           getProxyActive: () => proxyActive,
           getProxyActiveAtDirectFetch: () => proxyActiveAtDirectFetch };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 【L-3/L-4·测试加固】等待「完成信号」而不是固定 sleep。
//   固定等待在负载下会假红：CI 三矩阵并发、本机同时跑覆盖率时，同样的 sleep 可能
//   不够。本项目已有明确教训（popup 预算 150/240/260 ms vs 实测往返 166–270 ms，
//   10 次采样出现 2 次假红）——因此新增用例一律用「轮询谓词」判定完成。
//   超时后仍返回最终谓词结果，失败时由断言给出真实观测值，不静默放行。
async function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return pred();
    await sleep(5);
  }
}
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
      vm.runInContext(settingsSrc, sb, { filename: path.join(__dirname, '..', 'settings.js') });
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
      vm.runInContext(settingsSrc, sb, { filename: path.join(__dirname, '..', 'settings.js') });
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
  console.log("== L-3：applyProxyCore 的三条失败分支必须有正向用例（R3-04 承重分支）==");
  {
    // 【L-3·审计修复】这三条分支是 R3-04「失败开放」修复的承重分支
    //   （回读失败 / 回读缺 levelOfControl / 回读发现被外部接管）。
    //   此前它们只有变异间接保证（M 系列），没有任何正向用例走过 ——
    //   覆盖率报告里 background.js L693-717 整段为空。
    //   这里用 proxyGet 注入：下发前（proxySetCount===0）返回正常回读，
    //   下发后（>=1）返回三种异常形态之一，正好落在「第 5 步回读控制等级」。
    const GOOD = { value: { mode: "system" }, levelOfControl: "controlled_by_this_extension" };
    const ENABLED = { enableProxy: true, proxyType: "socks5", proxyHost: "127.0.0.1",
                      proxyPort: "10808", bypassList: "x" };
    const cases = [
      { name: "回读失败（details 为 null）→ error，绝不宣称已生效",
        post: null,
        check: s => !!s && s.status === "error" &&
          /无法回读代理设置/.test(s.message || "") && !s.levelOfControl },
      { name: "回读缺少 levelOfControl → error（未知不等于已生效，失败开放已收口）",
        post: { value: { mode: "fixed_servers" } },
        check: s => !!s && s.status === "error" &&
          /缺少 levelOfControl/.test(s.message || "") },
      { name: "回读发现被外部接管 → overridden（不夺权、不宣称生效）",
        post: { value: { mode: "fixed_servers" }, levelOfControl: "controlled_by_other_extensions" },
        check: s => !!s && s.status === "overridden" &&
          s.levelOfControl === "controlled_by_other_extensions" }
    ];
    for (const c of cases) {
      const env = buildEnv({ proxyGet: n => (n === 0 ? GOOD : c.post) });
      // 等冷启动下发跑到终态（默认未启用 → direct），而不是拍一个 sleep：
      //   这保证下面的 sync.set 发生时 proxySetCount 仍为 0，回读注入的基准才成立。
      await waitFor(() => env.sessionStore.lastState &&
        env.sessionStore.lastState.status === "direct");
      env.sandbox.chrome.storage.sync.set(ENABLED, () => {});
      await waitFor(() => {
        const s = env.sessionStore.lastState;
        return !!s && s.status !== "direct";
      });
      t("L-3 " + c.name, c.check(env.sessionStore.lastState),
        "lastState = " + JSON.stringify(env.sessionStore.lastState));
    }
  }

  console.log("");
  console.log("== L-4：两处「读不到即按保守路径继续」的分支必须有正向用例 ==");
  {
    // 【L-4·审计修复】background.js 有两处「读取失败 ≠ 没有」的保守分支，
    //   此前同样零覆盖：
    //     · reconcileLegacyBypass 的 sync 读失败 → 本轮自愈整个跳过（绝不写用户数据）；
    //     · reconcilePendingRestore 的 session 读失败 → 如实留痕后【照常下发】。
    //   两者的取舍方向刻意相反，因此必须分别钉住：一个「宁可不动」，一个「不能不动」。
    {
      // 只让【自愈那一次】sync 读取失败（SW 冷启动的第一个 sync 读就是它），
      //   后续读取恢复正常 —— 这样既精确覆盖该分支，又能验证「失败不阻断
      //   常规冷启动下发」，而不是把整条 sync 通道都打瘸（那会变成 read_failed）。
      let syncGetCount = 0;
      const env = buildEnv({
        storageGetError: area => area === "sync" && (++syncGetCount === 1)
      });
      // 完成信号 = 下发跑到终态（而非固定 sleep —— 负载下固定等待会假红）。
      await waitFor(() => env.sessionStore.lastState &&
        env.sessionStore.lastState.status === "direct");
      t("L-4 sync 读失败时自愈整个跳过：不写 sync（宁可晚一轮，也不动用户数据）",
        !("bypassList" in env.syncStore), JSON.stringify(env.syncStore));
      t("L-4 sync 读失败被如实留痕（console.warn 说明跳过原因）",
        env.warns.some(w => /读取 sync 失败/.test(w)), JSON.stringify(env.warns.slice(0, 3)));
      // 观察点是「下发跑到终态」而不是 applied：默认配置为未启用，禁用路径走的是
      //   clearProxyScope（不进 applied），写下的终态是 direct。
      t("L-4 sync 读失败不影响冷启动下发（仍跑到终态 direct）",
        !!(env.sessionStore.lastState && env.sessionStore.lastState.status === "direct"),
        JSON.stringify(env.sessionStore.lastState));
    }
    {
      const env = buildEnv({ storageGetError: area => area === "session" });
      await waitFor(() => env.warns.some(w => /读取恢复意图失败/.test(w)) &&
        env.sessionStore.lastState && env.sessionStore.lastState.status === "direct");
      t("L-4 session 读失败被如实留痕（读不到 ≠ 没有标记）",
        env.warns.some(w => /读取恢复意图失败/.test(w)), JSON.stringify(env.warns.slice(0, 3)));
      t("L-4 session 读失败时仍照常下发（绝不因对账失败而不下发）",
        !!(env.sessionStore.lastState && env.sessionStore.lastState.status === "direct"),
        JSON.stringify(env.sessionStore.lastState));
    }
  }

  console.log("");
  // 【G1】文档一致性自检：README 声明的本套件断言数必须与实际通过数一致
{
  const g1 = require("./g1-consistency.js").g1ConsistencyCheck("tests/background.test.js", pass);
  if (!g1.skipped && g1.declared !== pass) {
    fail++;
    console.log("  FAIL  G1 文档一致性：README 声明 " + g1.declared + " 项，实际通过 " + pass + " 项（改测试后请同步 README 对应行与合计）");
  }
}
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
