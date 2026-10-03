// background.js —— MV3 Service Worker  [v2.5.0]
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

// 清除失败必须让调用者知道：此前无论成功失败都 resolve，
// 导致"清除没生效"被当成"已清干净"，后续判断全部建立在错误前提上（R3-04）。
function clearProxyScope(scope) {
  return new Promise(function (resolve, reject) {
    chrome.proxy.settings.clear({ scope: scope }, function () {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
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
    // 缺少该键时，标题会退化为兜底的「代理设置」，用户看不出正在暂停下发。
    suspended: '连接测试进行中，暂缓下发（结束后自动恢复）',
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

// 暂停期间是否发生过「被跳过的下发请求」。
// 计数器只保证"以后还能下发"，不保证"暂停期间被跳过的更新会被补上"；
// 因此必须单独记脏，退出暂停后按最新 settings 重放（R3-01）。
var suspendDirty = false;

// 【R6-04】我方最近一次成功下发的意图，用于识别 chrome.proxy.settings.onChange 的
//   自触发回声（本扩展自己 set/clear 也会触发该事件）。用【值比对】而不是时间窗：
//   时间窗会把「我方写完之后立刻被外部接管」这一段真实变化静默吞掉，值比对没有这个盲区。
//   登记在册的代价：外部恰好下发与我方完全相同的 mode/host/port 时会被误判为回声，
//   但那种情况下状态本来等价，影响可忽略。
var lastIntent = null;

async function applyProxy() {
  // 暂停期间不得静默丢弃本次请求：
  // 只 return 会让「测试期间保存的新配置」永远不下发 —— 界面与存储显示新端口，
  // 浏览器却仍在用旧配置，且没有任何报错（R3-01）。
  // 这里记脏，由对比窗口的收尾阶段按【最新 settings】重新下发一次。
  if (suspendDepth > 0) {
    suspendDirty = true;
    updateIcon("suspended");
    writeState({ status: "suspended", at: Date.now() });
    return { ok: true, status: "suspended" };
  }

  // 【R6-03】普通成功路径也必须消费脏标记。
  //   此前清脏点只在对比窗口的收尾（以及它内部的兜底重放），普通下发成功时不清 ——
  //   于是一次"接管期间记脏、接管解除后重放成功"的链条会把 dirty 留给后续窗口，
  //   使一次用户根本没改配置的对比测试报出"有配置变更待下发"（误报）。
  //   这里只在【确认成功终态】时清：error / saved_not_applied / overridden 都不算，
  //   它们要么这次没写下去（overridden），要么写下去也没生效，仍需保留脏标记。
  var core = await applyProxyCore();
  if (core && core.ok === true && core.status !== "overridden") {
    suspendDirty = false;
  }
  return core;
}

// 真正的下发实现，【不含】暂停检查。
// 对比窗口的恢复阶段必须直接用它：窗口期间 suspendDepth 仍然 > 0（暂停贯穿收尾），
// 但恢复本身就是要按最新 settings 提交，不能被自己的暂停挡掉（R3-01）。
async function applyProxyCore() {
  var settings = await readSettings();
  settings.bypassList = await readBypassText();

  // 1) 未启用：清除常规作用域
  if (!settings.enableProxy) {
    try {
      // R6-04：记录本次下发意图（直连），供 onChange 回声抑制按值比对。
      lastIntent = { mode: "direct" };
      await clearProxyScope("regular");
    } catch (clearErr) {
      var cmsg = (clearErr && clearErr.message) || String(clearErr);
      updateIcon("error");
      writeState({ status: "error", message: "清除代理设置失败：" + cmsg, at: Date.now() });
      return { ok: false, status: "error", errors: [cmsg] };
    }
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

  // 3) 清理旧版遗留作用域。
  //    这一步是尽力而为的降级清理：失败不影响本次下发，但必须有记录，不能静默吞掉。
  for (var i = 0; i < LEGACY_SCOPES.length; i++) {
    try {
      await clearProxyScope(LEGACY_SCOPES[i]);
    } catch (legacyErr) {
      console.warn("清理遗留作用域失败（不影响本次下发）:", LEGACY_SCOPES[i], legacyErr);
    }
  }

  // 3.5) 下发前的控制权保护（不夺权）：
  //   若当前代理设置已【确证】被企业策略或其它扩展接管，再写下去就是夺权 ——
  //   对比窗口收尾之后的排队任务会走到这里，此时外部接管仍在，必须跳过。
  //   注意：回读失败（pre 为 null）时不阻断正常下发，否则代理故障期间扩展完全不可用；
  //   "未知即拒绝"的严格判定只用在【对比窗口收尾】那条会造成夺权的路径上。
  var pre = await readProxyDetails();
  var preLevel = pre ? pre.levelOfControl : null;
  if (preLevel && !isControllableByUs(preLevel)) {
    updateIcon("overridden");
    // 【R6-03】带上 pendingResubmit：该分支写下的 overridden 会覆盖对比窗口写下的
    //   带 pending 的状态（session 写入是"先发布后覆盖"）。若这里丢掉该字段，
    //   用户在暂停期改的配置就彻底不可见，与 R3-01 的"静默丢弃"同型。
    writeState({ status: "overridden", levelOfControl: preLevel, pendingResubmit: suspendDirty, at: Date.now() });
    return { ok: true, status: "overridden", levelOfControl: preLevel };
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
    // R6-04：记录本次下发意图，供 onChange 回声抑制按值比对。
    lastIntent = {
      mode: "fixed_servers",
      host: config.rules.singleProxy.host,
      port: String(config.rules.singleProxy.port)
    };
    await setProxy(config);
  } catch (err) {
    var msg = (err && err.message) || String(err);
    updateIcon("error");
    writeState({ status: "error", message: msg, at: Date.now() });
    return { ok: false, status: "error", errors: [msg] };
  }

  // 5) 回读控制等级，识别被策略或其它扩展接管的场景
  var details = await readProxyDetails();

  // 回读失败（details 为 null）意味着"下发调用返回了成功，但我们无法确认控制权"。
  // 这种情况下显示绿色 applied 是在宣称一个未经证实的结论（R3-04）：
  // 必须判为 error，让用户看到"状态未知"而不是"已生效"。
  if (!details) {
    var rmsg = "无法回读代理设置，不能确认代理是否已生效";
    updateIcon("error");
    writeState({ status: "error", message: rmsg, at: Date.now() });
    return { ok: false, status: "error", errors: [rmsg] };
  }

  // 控制权判定改为【白名单】（R3-04）：
  //   此前是 `if (level && level !== 'controlled_by_this_extension')` —— level 缺失
  //   （undefined）时短路为假，直接落入 applied：在"无法确认控制权"的情况下宣称
  //   "已生效"，属失败开放。现在只有确证由本扩展控制才算成功。
  var level = details.levelOfControl;
  if (level !== 'controlled_by_this_extension') {
    if (!level) {
      var umsg = "回读结果缺少 levelOfControl，无法确认代理控制权";
      updateIcon("error");
      writeState({ status: "error", message: umsg, at: Date.now() });
      return { ok: false, status: "error", errors: [umsg] };
    }
    updateIcon("overridden");
    // 【R6-03】同 C-5a：回读后才发现被接管，同样必须如实带上"仍有待下发"。
    writeState({ status: "overridden", levelOfControl: level, pendingResubmit: suspendDirty, at: Date.now() });
    return { ok: true, status: "overridden", levelOfControl: level };
  }

  // 落实校验（R3-07）：set 的回调成功 ≠ 配置真的生效。
  //   此前对比窗口会把 `{mode:"direct"}` 当作 backup 写回，set 成功但代理并未挂上，
  //   状态却仍写 applied —— 界面说"已生效"，实际却在直连。
  var actualMode = details.value && details.value.mode;
  if (actualMode && actualMode !== "fixed_servers") {
    var mmsg = "下发后实际代理模式为 " + actualMode + "，与期望的 fixed_servers 不符";
    updateIcon("error");
    writeState({ status: "error", message: mmsg, levelOfControl: level, at: Date.now() });
    return { ok: false, status: "error", errors: [mmsg] };
  }

  updateIcon("applied");
  writeState({ status: "applied", levelOfControl: level, at: Date.now() });
  return { ok: true, status: "applied" };
}

// 排他入口（R3-01）：把一段会改动 chrome.proxy 的复合操作整体排入同一条串行队列。
//   与 applyProxySerial 的区别：任务体不受「代次跳过」影响（它自身就是最新意图），
//   但它会推进代次，使此前排队的旧请求过期 —— 因为任务收尾时会按最新 settings 提交，
//   那些旧请求想要的结果已经被这次提交覆盖。
//   对比测试的「清除 → 取直连出口 → 恢复」必须整体走这里，否则它会和普通下发
//   构成两条互相交错的写路径：恢复写回在途时保存的新端口会被旧 backup 反向覆盖。
function applyProxyExclusive(task) {
  ++applyGeneration;
  var run = applyChain.then(function () { return task(); });
  applyChain = run.then(function () {}, function () {});
  return run;
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

  // 与窗口、下发前检查共用 isControllableByUs。
  // 缺字段不是“可以由本扩展控制”。
  var controlledByUs = isControllableByUs(result.levelOfControl);

  if (compare && settings.enableProxy && !controlledByUs) {
    result.compareSkipped = result.levelOfControl
      ? "not_controlled_by_this_extension"
      : "unknown_control";
  }

  if (compare && settings.enableProxy && controlledByUs) {
    // 整个对比窗口作为一个【排他任务】排入与普通下发相同的串行队列（R3-01）。
    //   · 此前窗口内的 clear / 恢复都直接调用，与普通下发构成两条并行写路径；
    //     窗口期间保存的新端口会被恢复写回的旧 backup 反向覆盖，且此后没有任何
    //     变化事件来纠正 —— 界面与存储显示新值，浏览器却长期在用旧值。
    //   · 入队后：窗口之前排队的旧请求会在任务开始时过期；窗口期间到达的更新请求
    //     只排队不执行；窗口收尾按【最新 settings】提交，排队请求随后幂等重放。
    await applyProxyExclusive(function () {
      return runCompareWindow(result);
    });

    result.ipChanged = !!(result.exit.ok && result.direct && result.direct.ok &&
      result.exit.ip !== result.direct.ip);

    // 测试得出「未生效」结论时，同步更新整体状态，避免界面自相矛盾。
    // 但【不得覆盖更权威的结论】（R3-07）：窗口内若发生外部接管或控制权变更，
    // 写下的 overridden 表达的是"我们已放弃控制权"——这比"出口相同"的推断更重要；
    // 被改写成 error 会让用户以为只是代理没配对，从而去排查代理，
    // 而真正需要处理的是企业策略或其它扩展。此前这里无条件写 error，把 overridden 盖掉。
    if (result.exit.ok && result.direct && result.direct.ok && !result.ipChanged) {
      if (result.overriddenDuringTest || result.controlChangedBeforeClear) {
        result.stateSuperseded = true;
      }
    }
  }

  writeTest(result);
  return result;
}

// 对比窗口的排他任务体（R3-01 / R3-04 / R3-07）。
// 调用前提：已经在 applyChain 内部执行，因此这里是 chrome.proxy 的唯一写入者。
// 顺序：复核控制权 → 清除 → 取直连出口 → 按最新 settings 收尾提交。
async function runCompareWindow(result) {
  // 暂停标记贯穿整个窗口（含收尾提交）：窗口期间到达的下发请求就此记脏，
  //   收尾提交之后再递减，保证"暂停"不会在恢复之前失效（R3-01 根因之二）。
  suspendDepth++;
  try {
    // 窗口一开始就【主动】把状态转成 suspended（R3-07）。
    //   此前 suspended 只在"暂停期间恰好收到一次 apply 请求"时才产生：
    //   正常的对比测试（用户没动设置）全程没有任何可观测的状态变化，界面会一直
    //   停留在测试前的旧结论上，而实际此刻代理已被清除、正在取直连出口。
    //   现在由窗口自身产生，与"是否有人恰好改设置"无关。
    writeState({ status: "suspended", at: Date.now() });
    updateIcon("suspended");

    // 第一步：清除【之前】重新确认控制权（R3-04）。
    //   runConnectionTest 的 controlledByUs 由公式算出，而清除是在这之后才执行；
    //   两者之间企业策略或其它扩展可能接管（check-then-act TOCTOU）。
    //   若此时已非我方/不可控，就绝不能执行清除 —— 那会把刚被接管方的配置清掉，
    //   而恢复阶段又会因为检测到接管而放弃写回，导致外部配置被我们破坏且无人恢复。
    var controlBeforeClear = await readProxyDetails();
    var levelBeforeClear = controlBeforeClear ? controlBeforeClear.levelOfControl : null;
    if (!isControllableByUs(levelBeforeClear)) {
      result.controlChangedBeforeClear = levelBeforeClear || "unknown";
      result.compareSkipped = "control_changed_before_clear";
      // 即时读取脏标记：此刻暂停窗口可能已经打开了记脏（清除前复核与清除之间的变化）
      result.pendingResubmit = suspendDirty;
      // 【R6-03】写状态时也必须带上 pendingResubmit（与另两处 overridden 早退同型）：
      //   这一条会覆盖窗口开头写下的状态。若在这里丢掉该字段，暂停期用户保存的配置
      //   就彻底不可见（前台状态条不显示「有配置变更待下发」），与 R3-01 的静默丢弃同型。
      writeState({ status: "overridden", levelOfControl: levelBeforeClear || null, pendingResubmit: suspendDirty, at: Date.now() });
      updateIcon("overridden");
      return result;
    }

    try {
      await clearProxyScope("regular");
    } catch (directClearErr) {
      // 清除失败就无法取得可信的直连出口，必须如实标记，不能假装测过直连。
      result.directClearFailed = (directClearErr && directClearErr.message) || String(directClearErr);
    }
    result.direct = await fetchExit();

    // 第二步：收尾复核控制权。
    //   白名单判定（R3-04）：只有确证"本扩展控制"或"当前无人控制（可被我方控制）"
    //   才允许提交。回读失败（controlNow=null）、返回缺字段、或已被外部接管，
    //   一律视为【不可提交】—— 此前回读失败被当成"没人接管"而默认写回旧 backup，
    //   属失败开放。
    var controlNow = await readProxyDetails();
    var levelNow = controlNow ? controlNow.levelOfControl : null;

    if (!isControllableByUs(levelNow)) {
      // 不夺权：绝不写回。
      //   也【不清空脏标记】（R3-01 逃逸面）：暂停期间用户保存的新配置仍然有待提交，
      //   清掉它就等于把这次变更永久丢弃，且没有任何提示 —— 与原始缺陷同型。
      result.overriddenDuringTest = levelNow || "unknown_control";
      // 即时读取脏标记（R3-01 逃逸面）：暂停期保存的新配置确实还有待下发，
      // 必须如实汇报，绝不能清空它后当作"什么都没发生"。
      result.pendingResubmit = suspendDirty;
      writeState({
        status: levelNow ? "overridden" : "error",
        levelOfControl: levelNow || null,
        message: levelNow ? undefined : "对比后无法回读控制权，已放弃写回以免夺权",
        pendingResubmit: suspendDirty,
        at: Date.now()
      });
      updateIcon(levelNow ? "overridden" : "error");
      return result;
    }

    // 第三步：按【最新 settings】提交，而不是写回测试前的旧 backup（R3-01 根因之三）。
    //   旧 backup 会把窗口期间用户改的端口、乃至"关闭代理"反向覆盖，且此后不再有
    //   变化事件来纠正。按最新 settings 提交则天然同时满足：
    //     用户改了端口 → 下发新端口；用户关闭代理 → 清除代理；用户没改 → 语义等价。
    //   applyProxyCore 内部会回读控制权并校验实际模式，因此状态与实际保持一致（R3-07）。
    // 【R6-01】必须消费返回值。背景：真实 chrome.proxy.settings.set 失败走 callback
    //   lastError，被 setProxy reject 后由 applyProxyCore 的 try/catch 转成
    //   { ok:false, status:"error" } 【正常 resolve】—— 只 catch 异常（throw）会漏掉
    //   这条真实故障路径，把"恢复失败"当成"恢复成功"，并顺手清掉脏标记，
    //   使第四步兜底重放条件恒不成立。
    var core = null;
    try {
      core = await applyProxyCore();
    } catch (restoreErr) {
      result.restoreFailed = true;
      var rmsg = (restoreErr && restoreErr.message) || String(restoreErr);
      console.warn("对比后按最新设置提交失败:", rmsg);
      writeState({ status: "error", message: "对比后恢复代理设置失败：" + rmsg, at: Date.now() });
      updateIcon("error");
    }

    // 只有【确认终态】才允许清脏，且必须先按 status 分三类，不能一律当"恢复失败"：
    //   · applied / direct —— 确认已生效 / 已直连：清脏（这是真正的成功终态）；
    //   · overridden      —— 确证被外部接管：我方【按最新意图处理完了】（放弃写入以免夺权），
    //                        所以【不是】恢复失败，但用户的配置确实还有待下发 → 不清脏；
    //   · error / saved_not_applied —— 恢复未完成：如实标记 restoreFailed，也不清脏。
    //   把 overridden 报成"恢复失败"，会让前台显示"请重新保存一次设置"，
    //   把用户引去排查自己的配置，而真正要处理的是企业策略或其它扩展（与 R3-07 同型）。
    if (!result.restoreFailed && core && core.status === "overridden") {
      // 两个都可能是原因：窗口内先被接管（L473–490 已 return，走不到这里），
      // 或复核通过之后、真正下发之前控制权又变了（L235–239 / L282–292）。
      // 两种情况下都不夺权、如实保留待下发。
      result.overriddenDuringRestore = core.levelOfControl || "unknown_control";
      result.pendingResubmit = suspendDirty;
      writeState({
        status: "overridden",
        levelOfControl: core.levelOfControl || null,
        pendingResubmit: suspendDirty,
        at: Date.now()
      });
      updateIcon("overridden");
    //   判据与入口（applyProxy）和兜底重放保持同一种写法：显式排除 overridden，
    //   不依赖上面 if 分支的先后顺序 —— 否则一旦有人重排分支或前置插入新分支，
    //   这里会静默消费掉被接管时的脏标记，退化为 R3-01 同型缺陷。
    } else if (!result.restoreFailed && core && core.ok === true && core.status !== "overridden") {
      suspendDirty = false;
    } else if (!result.restoreFailed) {
      // applyProxyCore 正常返回但状态不是成功终态（error / saved_not_applied）：
      //   与"抛异常"同样属于【恢复未完成】，必须如实标记，不能报成功。
      result.restoreFailed = true;
      var cmsg2 = (core && core.errors && core.errors[0]) || (core && core.status) || "未知原因";
      console.warn("对比后按最新设置提交未达成功终态:", cmsg2);
      writeState({ status: "error", message: "对比后恢复代理设置未生效：" + cmsg2, at: Date.now() });
      updateIcon("error");
    }

    // 第四步：兜底重放。收尾提交已按最新 settings 执行；若期间还有更新到达而
    //   未被子提交覆盖（理论上被队列保证，此处为纵深防御），再补一次。
    if (suspendDirty) {
      try {
        // 【R6-01 同型缺陷】重放也必须消费返回值：真实 set 失败是【正常 resolve】的
        //   （见第三步注释），只 catch 异常会让"重放同样失败"也被当成成功，
        //   无条件清掉脏标记 —— 于是"暂停期间的配置还有待下发"这一事实被抹掉，
        //   界面、状态与图标都说恢复完成，实际浏览器里什么也没挂上。
        //   只有确认终态（applied / direct）才允许清脏。
        var replay = await applyProxyCore();
        if (replay && replay.ok === true && replay.status !== "overridden") suspendDirty = false;
      } catch (e3) {
        console.warn("重放暂停期间的设置变更失败:", e3);
      }
    }

    return result;
  } finally {
    // 暂停贯穿收尾：直到恢复与重放全部结束才递减（R3-01 根因之二）。
    suspendDepth--;
    if (suspendDepth < 0) suspendDepth = 0;   // 防御性归零，避免异常路径下变负
  }
}

// 控制权白名单（R3-04）：只有这两种取值表示"我方可以合法写入代理设置"。
//   · controlled_by_this_extension —— 由本扩展控制；
//   · controllable_by_this_extension —— 当前无人控制，本扩展可以接管。
// 其它取值（其它扩展 / 企业策略）以及 null/undefined（回读失败或缺字段）
// 一律视为不可写：未知不是"没有接管"，未知就是未知。
function isControllableByUs(level) {
  return level === "controlled_by_this_extension" ||
         level === "controllable_by_this_extension";
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

// 【R6-04】代理设置的【外部】变化：企业策略或其它扩展接管 / 释放之后，状态必须及时对齐。
//   此前状态只由 startup、onProxyError 与 storage 变化驱动，全文件未注册 onChange，
//   于是外部接管后 getStatus 会一直返回过时的 applied，外部释放后更是界面宣称生效、
//   实际却在直连（02 探针-H / 探针-J），只能等冷启动才被纠正。
//
// 【硬约束】回调里【只读回查】，绝不写回：
//   · 不调用 setProxy / clearProxyScope / applyProxyCore / applyProxySerial；
//   · 否则会在外部接管的瞬间夺权，与 isControllableByUs 白名单策略直接冲突
//     （那套策略的全部意义就是「确证可写才写」）。
//   本回调只做三件事：readProxyDetails 回读 → 推导状态 → writeState + updateIcon。
//
// 【自触发抑制】本扩展自己每次 set/clear 也会触发该事件。这里用【值比对】而不是时间窗：
//   与 lastIntent 完全一致的变更判定为我方回声，直接忽略；只要值不同（外部接管）立刻生效。
//   时间窗方案会把「我方写完 300ms 内被外部接管」这一段真实变化静默吞掉，本方案没有这个盲区。
//   代价（登记在册）：外部恰好下发与我方完全相同的 mode/host/port 时会被误判为回声。
chrome.proxy.settings.onChange.addListener(function (details) {
  readProxyDetails().then(function (d) {
    // 回读失败：状态未知，如实写 error（不猜、不写回）。
    //   onChange 的 details 在部分 Chrome 版本里只带 levelOfControl、不带完整 value，
    //   因此不能凭 details 猜状态，必须自己回读，才能同时拿到 value 与 levelOfControl。
    if (!d) {
      writeState({ status: "error", message: "代理设置已变化，但无法回读确认当前状态", at: Date.now() });
      updateIcon("error");
      return;
    }

    var level = d.levelOfControl;
    var actualMode = d.value && d.value.mode;
    var sp = (d.value && d.value.rules && d.value.rules.singleProxy) || null;

    // 自触发回声：实际生效配置与我方最近一次意图一致 → 这次变化是我方自己造成的，
    //   状态由下发路径自己写，这里不重复回查、不重复刷新图标。
    if (isOwnLastIntent(actualMode, sp)) return;

    if (!isControllableByUs(level)) {
      // 已被外部接管（企业策略或其它扩展）：如实记录，不夺权、不写回。
      writeState({ status: "overridden", levelOfControl: level || null, pendingResubmit: suspendDirty, at: Date.now() });
      updateIcon("overridden");
      return;
    }

    // 【关键】「无人控制」不等于「生效的是我方的配置」。
    //   外部扩展下发 fixed_servers 后释放控制权，level 会回到
    //   controllable_by_this_extension，而实际生效的仍是【别人的 host/port】。
    //   若这里只看 actualMode === "fixed_servers" 就写 applied，
    //   界面会宣称「本扩展的代理已生效」——那是与 R6-04 同类的新可见性错误。
    //   因此必须把实际 host/port 与我方 settings 比对。
    readSettings().then(function (st) {
      var isFixed = actualMode === "fixed_servers";
      var mineIsFixed = !!st.enableProxy;
      var sameTarget = !!sp && sp.host === S.stripBrackets(st.proxyHost) &&
                       String(sp.port) === String(st.proxyPort);

      if (mineIsFixed && isFixed && sameTarget) {
        writeState({ status: "applied", levelOfControl: level, at: Date.now() });
        updateIcon("applied");
        return;
      }
      if (!mineIsFixed && !isFixed) {
        writeState({ status: "direct", at: Date.now() });
        updateIcon("direct");
        return;
      }
      // 剩下的组合都是「界面结论会与实际不符」的那一档，必须如实报 error：
      //   · 我方已启用，但生效的不是我方目标（外部配置刚被释放）
      //   · 我方未启用，但存在非我方下发的代理配置
      //   前台与图标都按 error 呈现，用户才知道要去查策略或其它扩展，
      //   而不是误以为代理已生效（外部释放）或压根没启用（外部残留配置）。
      var msg = mineIsFixed
        ? "本扩展已启用代理，但当前生效的代理配置不是本扩展下发的（可能被外部释放或覆盖）"
        : "本扩展未启用代理，但当前存在非本扩展下发的代理配置";
      writeState({ status: "error", message: msg, levelOfControl: level, at: Date.now() });
      updateIcon("error");
    });
  });
});

// 判断「实际生效配置」是否就是我方最近一次下发的意图（R6-04 回声抑制）。
//   只比 mode / host / port —— 这三项才是「生效的是不是我要的东西」的判据；
//   bypassList 不参与比对：它不影响控制权归属，也不作为状态结论的依据。
//   端口两侧统一转成字符串，避免 number/string 造成的假差异。
function isOwnLastIntent(actualMode, sp) {
  if (!lastIntent) return false;
  if (actualMode !== lastIntent.mode) return false;
  if (lastIntent.mode !== "fixed_servers") return true;
  if (!sp) return false;
  return sp.host === lastIntent.host && String(sp.port) === String(lastIntent.port);
}

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
  if (touched) {
    if (suspendDepth > 0) suspendDirty = true;
    applyProxySerial();
  }
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (!request) return;

  // 来源校验（R3-05）：只处理本扩展自身发出的消息。
  // 说明：跨扩展通信走 chrome.runtime.onMessageExternal（本项目未注册），
  // 普通网页也无法进入内部通道，因此这里不存在已证的利用链 —— 它是有意为之的
  // 纵深防御：内部通道不该因为"目前没人能打通"就完全不校验来源。
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "unauthorized_sender" });
    return;
  }

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
