// background.js —— MV3 Service Worker  [v2.2.0]
importScripts("settings.js");

var S = self.EasyProxy;
var CONFIG_KEYS = Object.keys(S.DEFAULTS);

// 旧版可能残留的其它作用域，启用时一并清理，避免其继续压制流量
var LEGACY_SCOPES = ['regular_only', 'incognito_persistent', 'incognito_session_only'];

// 图标按尺寸分别提供，Chrome 按显示场景挑选合适的一档，避免缩放模糊。
// 两态用不同字形区分，使状态在去掉颜色后依然可辨：
//   红 + 直  = 直连（未启用代理）
//   绿 + 代  = 走代理（已启用）
var ICON_RED = {
  "16": "icon-red-16.png",
  "32": "icon-red-32.png",
  "48": "icon-red-48.png",
  "128": "icon-red-128.png"
};
var ICON_GREEN = {
  "16": "icon-green-16.png",
  "32": "icon-green-32.png",
  "48": "icon-green-48.png",
  "128": "icon-green-128.png"
};

/* ==================== 存储读写 ==================== */

function readSettings() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(CONFIG_KEYS, function (items) {
      void chrome.runtime.lastError;
      resolve(S.normalizeSettings(items));
    });
  });
}

// 绕过列表可能因超长被降级到 local，这里统一取回。
// 取值规则集中在 settings.js 的 resolveBypassList，确保 popup 显示与实际下发一致。
function readBypassText() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(['bypassList'], function (syncItems) {
      chrome.storage.local.get(['bypassList'], function (localItems) {
        resolve(S.resolveBypassList(
          syncItems && syncItems.bypassList,
          localItems && localItems.bypassList
        ));
      });
    });
  });
}

function writeState(state) {
  chrome.storage.session.set({ lastState: state }, function () {
    void chrome.runtime.lastError;
  });
}

function writeTest(result) {
  chrome.storage.session.set({ lastTest: result }, function () {
    void chrome.runtime.lastError;
  });
}

/* ==================== 代理解析与控制 ==================== */

function setProxy(config) {
  return new Promise(function (resolve, reject) {
    chrome.proxy.settings.set({ value: config, scope: "regular" }, function () {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function clearProxyScope(scope) {
  return new Promise(function (resolve) {
    chrome.proxy.settings.clear({ scope: scope }, function () {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function readProxyDetails() {
  return new Promise(function (resolve) {
    chrome.proxy.settings.get({ incognito: false }, function (details) {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(details || null);
    });
  });
}

function updateIcon(status) {
  // 只有真正下发成功才显示绿色，避免"绿着但直连"的误导
  var ok = status === 'applied';
  chrome.action.setIcon({ path: ok ? ICON_GREEN : ICON_RED }, function () {
    void chrome.runtime.lastError;
  });
  var titles = {
    applied: '代理已生效',
    direct: '未启用代理（直连）',
    saved_not_applied: '已保存，尚未生效',
    overridden: '代理设置被外部接管',
    error: '代理异常，可能已回退直连'
  };
  chrome.action.setTitle({ title: titles[status] || "代理设置" }, function () {
    void chrome.runtime.lastError;
  });
}

/* ==================== 出口检测 ==================== */

// 检测当前网络出口。端点支持 CORS，因此无需申请任何 host 权限。
function fetchExit() {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, S.TEST_TIMEOUT_MS);
  var url = S.TEST_ENDPOINT + (S.TEST_ENDPOINT.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();

  return fetch(url, { cache: "no-store", signal: controller.signal })
    .then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then(function (data) {
      return {
        ok: true,
        ip: data.ip || '',
        org: data.org || '',
        city: data.city || '',
        region: data.region || '',
        country: data.country || ''
      };
    })
    .catch(function (err) {
      var msg = (err && err.name === 'AbortError')
        ? '请求超时（' + Math.round(S.TEST_TIMEOUT_MS / 1000) + ' 秒）'
        : ((err && err.message) || String(err));
      return { ok: false, error: msg };
    })
    .finally(function () { clearTimeout(timer); });
}

/* ==================== 主流程 ==================== */

// 串行队列与代次号：
//   · 队列保证同一时刻只有一次下发在跑，杜绝多个 applyProxy 交错；
//   · 代次号保证排队等待期间若已有更新的请求进来，本次直接跳过，
//     避免「较早发起但较慢」的旧配置覆盖新配置。
var applyChain = Promise.resolve();
var applyGeneration = 0;

// 连接测试期间暂停下发：
//   测试的「取直连出口」步骤需要代理确实处于清除状态；
//   若此时有 storage 变化触发重新下发，直连出口会被代理出口污染，
//   导致测试误报「代理很可能未生效」。
//
// 用【计数器】而非布尔标志。原因：布尔标志必须靠「保存前值再恢复」来还原，
// 而该模式在两个测试并发时会失配 —— 后一个测试读到的是前一个已置位的值，
// 恢复后仍然为 true，导致下发被永久跳过（v2.1.2 的 N1 缺陷）。
// 计数器则天然可重入：进入 +1、退出 -1，无论怎样交错，最终必然归零。
var suspendDepth = 0;

async function applyProxy() {
  if (suspendDepth > 0) return { ok: true, status: "suspended" };

  var settings = await readSettings();
  settings.bypassList = await readBypassText();

  // 1) 未启用：清除常规作用域
  if (!settings.enableProxy) {
    await clearProxyScope("regular");
    updateIcon("direct");
    writeState({ status: "direct", at: Date.now() });
    return { ok: true, status: "direct" };
  }

  // 2) 校验：明确回报，不静默跳过
  var errors = S.validateSettings(settings);
  if (errors.length) {
    updateIcon("saved_not_applied");
    writeState({ status: "saved_not_applied", errors: errors, at: Date.now() });
    return { ok: false, status: "saved_not_applied", errors: errors };
  }

  // 3) 清理旧版遗留作用域
  for (var i = 0; i < LEGACY_SCOPES.length; i++) {
    await clearProxyScope(LEGACY_SCOPES[i]);
  }

  // 4) 原生 fixed_servers 下发（不生成 PAC 脚本）
  var config = {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: settings.proxyType,
        // IPv6 字面量若写成 [::1] 形式，下发给 chrome.proxy 时要按 ::1 形式给出
        host: S.stripBrackets(settings.proxyHost),
        port: Number(settings.proxyPort)
      },
      bypassList: S.parseBypassList(settings.bypassList)
    }
  };

  try {
    await setProxy(config);
  } catch (err) {
    var msg = (err && err.message) || String(err);
    updateIcon("error");
    writeState({ status: "error", message: msg, at: Date.now() });
    return { ok: false, status: "error", errors: [msg] };
  }

  // 5) 回读控制等级，识别被策略或其它扩展接管的场景
  var details = await readProxyDetails();
  var level = details ? details.levelOfControl : null;
  if (level && level !== 'controlled_by_this_extension') {
    updateIcon("overridden");
    writeState({ status: "overridden", levelOfControl: level, at: Date.now() });
    return { ok: true, status: "overridden", levelOfControl: level };
  }

  updateIcon("applied");
  writeState({ status: "applied", levelOfControl: level, at: Date.now() });
  return { ok: true, status: "applied" };
}

// applyProxy 的串行化入口。所有事件回调都应调用它，而不是直接调用 applyProxy。
function applyProxySerial() {
  var gen = ++applyGeneration;
  applyChain = applyChain.then(function () {
    if (gen !== applyGeneration) return null;   // 已有更新的请求，本次过时
    return applyProxy();
  }).catch(function (err) {
    console.warn("下发代理设置时出错:", err);
    return null;
  });
  return applyChain;
}

/* ==================== 连接测试 ==================== */

// 连接测试的并发互斥：
//   两个测试同时跑没有意义（第二次的结果与第一次等价），却会互相干扰：
//   一个测试在恢复代理、另一个正在取直连出口，导致直连出口被代理出口污染，
//   从而给出错误结论。因此直接拒绝并发的第二次。
var testInFlight = false;

// compare=true 时额外做一次直连对比：临时清除代理取直连出口，再恢复原配置。
// 该对比是判断"代理是否真的生效"最可靠的方法，但会短暂切换直连，
// 因此仅在用户明确点击"对比直连"时才执行，并用 try/finally 保证恢复。
async function testConnection(compare) {
  if (testInFlight) {
    return { ok: false, skipped: "in_flight", message: "已有测试在进行中，请稍候再试" };
  }
  testInFlight = true;
  try {
    return await runConnectionTest(compare);
  } finally {
    testInFlight = false;
  }
}

// 实际的测试实现（由 testConnection 包裹互斥后调用）
async function runConnectionTest(compare) {
  var settings = await readSettings();
  settings.bypassList = await readBypassText();

  var before = await readProxyDetails();
  var currentExit = await fetchExit();

  var result = {
    at: Date.now(),
    compare: !!compare,
    settings: {
      enableProxy: settings.enableProxy,
      proxyType: settings.proxyType,
      proxyHost: settings.proxyHost,
      proxyPort: settings.proxyPort
    },
    activeMode: before && before.value ? before.value.mode : null,
    levelOfControl: before ? before.levelOfControl : null,
    exit: currentExit,
    direct: null,
    restoreFailed: false,
    compareSkipped: null
  };

  // 仅当代理设置确实由本扩展控制时，才执行「清除→测直连→恢复」的对比流程。
  // 否则 backup 可能属于其它扩展或企业策略，把它写回相当于越权改变控制权归属。
  var controlledByUs = !result.levelOfControl ||
    result.levelOfControl === "controlled_by_this_extension";

  if (compare && settings.enableProxy && !controlledByUs) {
    result.compareSkipped = "not_controlled_by_this_extension";
  }

  if (compare && settings.enableProxy && controlledByUs) {
    var backup = before && before.value ? before.value : null;

    // 暂停自动下发：否则测试期间任何 storage 变化都会把代理重新写回，
    // 使下面这次「直连出口」实际测到代理出口，导致 ipChanged 误判。
    //
    // 用计数器（进入 +1 / 退出 -1）而非布尔保存-恢复：
    // 布尔模式在并发下会失配并永久卡住，计数器无论怎样交错都必然归零。
    // try/finally 保证即使中途抛错也一定递减。
    suspendDepth++;
    try {
      await clearProxyScope("regular");
      result.direct = await fetchExit();
    } finally {
      suspendDepth--;
      if (suspendDepth < 0) suspendDepth = 0;   // 防御性归零，避免异常路径下变负
      try {
        if (backup) await setProxy(backup);
        else await clearProxyScope("regular");
      } catch (restoreErr) {
        result.restoreFailed = true;
        // 尽力恢复：按当前设置重新下发一次（绕过串行队列，确保立即执行）
        try { await applyProxy(); } catch (e2) {}
      }
    }

    result.ipChanged = !!(result.exit.ok && result.direct && result.direct.ok &&
      result.exit.ip !== result.direct.ip);

    // 测试得出「未生效」结论时，同步更新整体状态，避免界面自相矛盾：
    // 此前测试面板会说「代理很可能未生效」，而顶部状态条仍显示「已生效」。
    if (result.exit.ok && result.direct && result.direct.ok && !result.ipChanged) {
      writeState({
        status: "error",
        message: "出口检测显示当前出口与直连相同，代理可能未生效",
        at: Date.now()
      });
      updateIcon("error");
    }
  }

  writeTest(result);
  return result;
}

/* ==================== 生命周期与事件 ==================== */

chrome.runtime.onInstalled.addListener(function (details) {
  var reason = details && details.reason;

  if (reason === 'install') {
    chrome.storage.sync.set(S.DEFAULTS, function () {
      void chrome.runtime.lastError;
      applyProxySerial();
    });
    return;
  }

  if (reason === 'update') {
    // 升级：只补空缺，不覆盖用户已填内容，不改动启用状态
    chrome.storage.sync.get(CONFIG_KEYS, function (items) {
      void chrome.runtime.lastError;
      var cur = S.normalizeSettings(items);
      var patch = {};

      if (!cur.proxyHost) patch.proxyHost = S.DEFAULTS.proxyHost;
      if (!cur.proxyPort) patch.proxyPort = S.DEFAULTS.proxyPort;
      if (!cur.bypassList) patch.bypassList = S.DEFAULTS.bypassList;

      var allowed = S.PROXY_TYPES.map(function (t) { return t.value; });
      if (items.proxyType && allowed.indexOf(items.proxyType) < 0) {
        patch.proxyType = S.DEFAULTS.proxyType;
      }

      if (Object.keys(patch).length) {
        chrome.storage.sync.set(patch, function () {
          void chrome.runtime.lastError;
          applyProxySerial();
        });
      } else {
        applyProxySerial();
      }
    });
    return;
  }

  applyProxySerial();
});

chrome.runtime.onStartup.addListener(function () { applyProxySerial(); });

// 代理运行时错误：fatal=false 恰好表示"已静默回退直连"，必须让用户看见
chrome.proxy.onProxyError.addListener(function (details) {
  console.warn("代理错误:", details);
  writeState({
    status: "error",
    fatal: !!(details && details.fatal),
    message: (details && details.error) || "未知代理错误",
    detail: (details && details.details) || "",
    at: Date.now()
  });
  updateIcon("error");
});

// 唯一驱动源：存储变化即重算（覆盖多窗口与多设备同步）
chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'sync' && areaName !== 'local') return;
  var touched = Object.keys(changes).some(function (k) {
    return CONFIG_KEYS.indexOf(k) >= 0;
  });
  if (touched) applyProxySerial();
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (!request) return;

  if (request.action === "getStatus") {
    chrome.storage.session.get(["lastState", "lastTest"], function (items) {
      sendResponse({
        state: (items && items.lastState) || null,
        test: (items && items.lastTest) || null
      });
    });
    return true;
  }

  if (request.action === "reapply") {
    applyProxySerial().then(sendResponse);
    return true;
  }

  if (request.action === "testConnection") {
    testConnection(request.compare === true)
      .then(function (r) { sendResponse({ ok: true, result: r }); })
      .catch(function (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      });
    return true;
  }
});

// Service Worker 冷启动即对齐一次
applyProxySerial();
