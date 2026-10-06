// background.js —— MV3 Service Worker  [v2.15.2]
// 【L-06·审计修复】补上全局严格模式：本文件是 classic service worker（非 module），
//   默认处于非严格模式，隐式全局赋值、静默失败的写入、`this` 装箱等都无法被
//   静态规则拦住。settings.js 早已声明（在 IIFE 内），此处与 popup.js 补齐一致。
'use strict';
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

// 【R7-01】读取失败必须是【显式失败】，绝不能归一成默认配置。
//   此前只写一句 `void chrome.runtime.lastError;` 把告警抑制掉，却不产生任何分支：
//     · normalizeSettings(undefined) 会填出 enableProxy:false，
//       而 applyProxyCore 的「未启用」分支在【校验之前】就执行 clearProxyScope("regular")，
//       于是「读不到设置」被当成「用户关掉了代理」—— 仍在生效的代理被真清除，
//       状态还写成 direct、图标转红，界面宣称「未启用代理（直连）」；
//     · 绕过列表读不到时则 resolve("")，被静默下发为空列表。
//   chrome.storage 的失败契约是「回调里置 runtime.lastError」，因此必须在这里分支。
//   失败通过 reject 上抛，由调用方转为「状态未知」，全过程不产生任何写操作。
function readSettings() {
  return new Promise(function (resolve, reject) {
    chrome.storage.sync.get(CONFIG_KEYS, function (items) {
      var err = chrome.runtime.lastError;
      if (err) { reject(new Error("读取设置失败：" + err.message)); return; }
      resolve(S.normalizeSettings(items));
    });
  });
}

// 绕过列表可能因超长被降级到 local，这里统一取回。
// 取值规则集中在 settings.js 的 resolveBypassList，确保 popup 显示与实际下发一致。
// 【R7-01】两层读取都必须检查 lastError：sync 里的空串是「已降级到 local」的正常
//   状态（不是失败），但 local 读取失败若被当成空串，就会把绕过列表静默清空下发 ——
//   用户配的内网直连规则凭空消失，且没有任何提示。
function readBypassText() {
  return new Promise(function (resolve, reject) {
    chrome.storage.sync.get(['bypassList'], function (syncItems) {
      var syncErr = chrome.runtime.lastError;
      if (syncErr) { reject(new Error("读取绕过列表失败：" + syncErr.message)); return; }
      chrome.storage.local.get(['bypassList'], function (localItems) {
        var localErr = chrome.runtime.lastError;
        if (localErr) { reject(new Error("读取绕过列表失败：" + localErr.message)); return; }
        resolve(S.resolveBypassList(
          syncItems && syncItems.bypassList,
          localItems && localItems.bypassList
        ));
      });
    });
  });
}

// 【R9-05 / M-5】写入失败必须留痕，且必须让用户【看见】。此前一律用
//   void chrome.runtime.lastError 抑制（R9-05 只补了 console 留痕），
//   而 session.set 失败会让前台长期停留在【过期结论】上（真实已经是 error，
//   界面却还显示上一次的 applied），console 又只有扩展调试时才可见。
//   【M-5】三级处置：
//     1) 失败后做一次有界重试（250ms 后）—— session 写失败多为瞬时故障；
//     2) 重试仍失败：把失败事实写入 storage.local 的 stateWriteFailed 标记 ——
//        local 与 session 是独立存储区，session 不可用时 local 通常仍可用；
//        popup 的 local.onChanged 监听会捕获该标记并向用户显示「状态可能过期」警示；
//     3) 任一次写入成功：清除 local 标记（若有），警示随之解除。
//   返回 { ok, retried?, error? } 供调用方观测（现有调用方均 fire-and-forget）。
var STATE_WRITE_FAIL_KEY = "stateWriteFailed";

// 【第 5 条·审计修复】每个状态键各维护一个递增代次，供延迟重试判定「自己是否已过期」。
//   此前每次写入独立计时重试（250ms），而重试回调【不校验】期间是否已有更新的值写成功：
//   一次 lastState=applied 的写入失败后，若 250ms 内发生了真实 onProxyError 并把
//   lastState=error 写成功，那次重试随后仍会把【过期的 applied】盖回去 ——
//   图标已按 error 变红、状态条却回到「代理已生效」，两者互相矛盾。
//   下发路径早已用 applyGeneration 防同类问题，状态写入路径没有，属设计盲区。
//   语义：某键的代次只由「该键的新一次写入」推进；旧代次的重试一律放弃，
//   由最新那次写入负责上报成功或失败（失败标记也是它写）。
var stateWriteGeneration = {};

function clearStateWriteFailMark(ownerKey) {
  chrome.storage.local.get([STATE_WRITE_FAIL_KEY], function (items) {
    if (chrome.runtime.lastError) return;   // 读不到标记 ≠ 没有标记；仅影响清除时机
    var mark = items && items[STATE_WRITE_FAIL_KEY];
    if (!mark) return;
    // 【第 5 条·审计修复】失败标记按【键】管理：另一键（如 lastTest）写入成功
    //   不该把 lastState 的告警一起抹掉 —— 那会让用户看不到「当前状态可能过期」。
    //   旧标记没有 key 字段时按「同一键」处理，避免历史标记永远清不掉。
    if (ownerKey && mark.key && mark.key !== ownerKey) return;
    chrome.storage.local.remove([STATE_WRITE_FAIL_KEY], function () {
      void chrome.runtime.lastError;
    });
  });
}

function writeSessionValue(key, value, warnMsg) {
  var myGen = (stateWriteGeneration[key] || 0) + 1;
  stateWriteGeneration[key] = myGen;
  // 过期判定：期间只要有【同一键】的更新写入，本次（含其重试）就不再具备写入资格。
  function superseded() { return stateWriteGeneration[key] !== myGen; }

  return new Promise(function (resolve) {
    var pair = {};
    pair[key] = value;
    chrome.storage.session.set(pair, function () {
      var err = chrome.runtime.lastError;
      if (!err) { clearStateWriteFailMark(key); resolve({ ok: true }); return; }
      // 失败后若已有更新的同一键写入进来，本次直接退出：那个更新的值才是要落盘的，
      //   由它负责重试与失败上报。此处【不能】继续重试，否则会用过期值覆盖新状态。
      if (superseded()) { resolve({ ok: true, superseded: true }); return; }
      console.warn(warnMsg + ":", err.message);
      // 一次有界重试：绝不能在状态上报路径上无限等待。
      setTimeout(function () {
        if (superseded()) { resolve({ ok: true, superseded: true }); return; }
        chrome.storage.session.set(pair, function () {
          var err2 = chrome.runtime.lastError;
          if (!err2) { clearStateWriteFailMark(key); resolve({ ok: true, retried: true }); return; }
          if (superseded()) { resolve({ ok: true, superseded: true }); return; }
          console.error(warnMsg + "（重试后仍失败）:", err2.message);
          // 降级通道：把失败事实写到 local（独立于 session 的存储区），
          // 由 popup 的 local.onChanged 呈现给用户。
          var mark = {};
          mark[STATE_WRITE_FAIL_KEY] = { at: Date.now(), key: key, message: err2.message };
          chrome.storage.local.set(mark, function () {
            void chrome.runtime.lastError;
          });
          resolve({ ok: false, error: err2.message });
        });
      }, 250);
    });
  });
}

function writeState(state) {
  return writeSessionValue("lastState", state, "写入 lastState 失败，前台可能显示过期状态");
}

function writeTest(result) {
  return writeSessionValue("lastTest", result, "写入 lastTest 失败，前台可能显示过期测试结果");
}

/* ==================== 对比窗口恢复意图的持久化（S2） ==================== */

// MV3 的 Service Worker 可在任意 await 点被浏览器回收，而对比窗口的「清除 → 恢复」
// 之间有真实的异步区间（直连取样，最长约 COMPARE_EXIT_TIMEOUT_MS=4 秒），
// suspendDepth / suspendDirty 都是模块级内存变量，随 SW 一起消失。
// 若 SW 在【清除之后、恢复之前】被回收（关弹窗、崩溃、扩展重载、休眠唤醒），
// 代理将停留在「已清除（直连）」且无人恢复 —— 用户以为在走代理，实际全部直连，
// 对以「代理是否生效」为唯一价值的工具而言，这是静默的隐私暴露。
//
// 【S2】方案 = 持久化「待恢复意图」+ 冷启动对账（与「显式失败、绝不把读不到
// 当没有」的既有设计哲学一致）：
//   · 清除之前把意图写入 chrome.storage.session（同一浏览器会话内跨 SW 重启存活）；
//   · 窗口收尾（含早退）清除标记 —— SW 存活期间窗口逻辑自己负责恢复与上报；
//   · SW 冷启动若发现残留标记 = 上一次窗口的恢复没有完成：消费标记、如实上报
//     「恢复被中断」，并立即按最新 settings 重新下发代理。
var PENDING_RESTORE_KEY = "pendingRestore";

function writePendingRestore() {
  var patch = {};
  patch[PENDING_RESTORE_KEY] = { at: Date.now() };
  chrome.storage.session.set(patch, function () {
    var err = chrome.runtime.lastError;
    if (err) console.warn("写入恢复意图失败（SW 回收后代理可能停留在直连且无对账依据）:", err.message);
  });
}

function clearPendingRestore() {
  chrome.storage.session.remove([PENDING_RESTORE_KEY], function () {
    var err = chrome.runtime.lastError;
    if (err) console.warn("清除恢复意图失败:", err.message);
  });
}

// 冷启动对账：发现残留的「待恢复意图」= 上一次对比窗口的恢复没有完成。
// 无论有无标记，最终都必须驱动一次按最新 settings 的常规下发（冷启动的既有职责）。
function reconcilePendingRestore() {
  chrome.storage.session.get([PENDING_RESTORE_KEY], function (items) {
    var err = chrome.runtime.lastError;
    if (err) {
      // 读不到标记 ≠ 没有标记：如实留痕后按常规冷启动继续（绝不因对账失败而不下发）。
      console.warn("读取恢复意图失败，按无标记处理并照常下发:", err.message);
      applyProxySerial();
      return;
    }
    var marker = items && items[PENDING_RESTORE_KEY];
    if (!marker) { applyProxySerial(); return; }
    clearPendingRestore();
    var imsg = "检测到上一次对比测试的恢复被中断（Service Worker 在代理被清除后、恢复之前被回收，期间流量可能已直连），已按当前设置重新下发代理";
    console.warn(imsg, marker);
    // 如实上报「恢复未完成」：status 用 error 档（此刻代理确实可能仍处于直连），
    // reason 单列 restore_interrupted 供前台与诊断区分于真实代理故障；
    // 随后的 applyProxySerial 会按最新 settings 重新下发并写出真实终态。
    writeState({ status: "error", reason: "restore_interrupted", message: imsg, at: Date.now() });
    updateIcon("error");
    applyProxySerial();
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

// 【R9-02】控制权回读的【有界】重试：把"读不到"与"无人接管"分开。
//   chrome.proxy.settings.get 的失败是回调 lastError（瞬时故障），
//   重试必须有限次且带退避——绝不能在扩展启动路径上无限等待。
//   超过重试仍无法确证时返回 null，由调用方按"未知"处理。
function readProxyDetailsWithRetry(maxAttempts) {
  var attempts = maxAttempts || 3;
  var attempt = 0;
  function next() {
    return readProxyDetails().then(function (d) {
      if (d && d.levelOfControl) return d;
      attempt++;
      if (attempt >= attempts) return null;
      // 退避必须短：这一步在扩展启动/每次下发的关键路径上，
      //   健康路径第一次就成功（零额外延迟），只有真的读不到时才会等待，
      //   而那时我们最终也会放弃写入，所以等待总时长上限控制在 75ms 以内。
      return new Promise(function (r) { setTimeout(r, 25 * attempt); }).then(next);
    });
  }
  return next();
}

function updateIcon(status, reason) {
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
  // 【R7-01-F】error 档有两个语义完全不同的来源，必须分开陈述：
  //   · 真实代理故障（下发失败 / 被外部接管）→「可能已回退直连」成立；
  //   · 读取配置失败 → 我们【什么都没做】，代理根本没被动过，
  //     此时沿用「可能已回退直连」就是与同一条 message 里的
  //     「本次未改动代理」直接矛盾（读不到 ≠ 代理没了）。
  if (status === 'error' && reason === 'read_failed') {
    titles.error = '无法读取配置，本次未改动代理';
  }
  // 【R9-02】同一条"本次未改动代理"的语义：控制权无法确证时我们什么都没写，
  //   沿用"可能已回退直连"同样与事实相反。
  if (status === 'error' && reason === 'control_unknown') {
    titles.error = '无法确证代理控制权，本次未改动代理';
  }
  // 【M-1·审计修复】direct 档同样有三个语义不同的来源，标题必须跟着分档。
  //   背景：v2.12.0 第 4 条把「状态条文案」按 systemProxy 分了档，但图标标题没有
  //   跟着分 —— 图标标题固定为「未启用代理（直连）」，而图标本身的图例
  //   （README：红·直 = 直连）也是一次独立断言。于是「不得宣称直连」这个验收要点
  //   只落在状态条上，悬停提示仍在宣称直连，与状态条正文自相矛盾。
  //   三个来源：
  //     · reason === 'direct'            → 回读确证就是直连，沿用原句（唯一可宣称直连的情形）
  //     · reason === 'read_failed'       → 回读失败：本扩展代理确已停用，但底层模式读不到
  //     · reason === 其它 mode 字符串    → 回读成功但非 direct（system / pac_script /
  //                                        auto_detect / 外部 fixed_servers）
  if (status === 'direct') {
    if (reason === 'read_failed') {
      titles.direct = '已停用本扩展代理，但无法确证当前实际生效的模式';
    } else if (reason && reason !== 'direct') {
      titles.direct = '未启用本扩展代理（当前沿用 ' + reason + '）';
    }
  }
  chrome.action.setTitle({ title: titles[status] || "代理设置" }, function () {
    void chrome.runtime.lastError;
  });
}

/* ==================== 出口检测 ==================== */

// 【C-3】出口检测响应的 schema 校验与归一化。
//   此前直接信任 resp.json() 的形状（data.ip || '' 兜底），端点被劫持/改版返回
//   缺 ip 或非对象 JSON 时会得到 {ok:true, ip:''} 的「成功」结果，误导测试结论。
//   现在：ip 必须通过 settings.js 的 isIpLiteral 形态校验（非空、长度合理、无空白，
//   且确实是 IPv4 / IPv6 字面量），否则判为端点失败并触发备用端点。
//   其余字段缺失时安全地置空串（备用端点如 ipify 只返回 ip）。
//
//   【L-03·审计修复】「长度 ≤45 + 无空白」这一层是承重的但不充分：SECURITY.md 与
//   PRIVACY.md 都声称响应必须包含「有效的 ip 字段」，而 "not-an-ip" 能通过旧判据 ——
//   界面会把一段无意义文本当作出口 IP 展示，并据「拿到了 ip」判为「出口检测成功」。
//   判据收敛到 settings.js（与 host 校验同一处「单一实现」原则），文档与实现从此一致。
function normalizeExitPayload(data) {
  if (!data || typeof data !== 'object') return null;
  var ip = typeof data.ip === 'string' ? data.ip.trim() : '';
  if (!S.isIpLiteral(ip)) return null;
  function s(v) { return typeof v === 'string' ? v : ''; }
  return {
    ok: true,
    ip: ip,
    org: s(data.org),
    city: s(data.city),
    region: s(data.region),
    country: s(data.country)
  };
}

// 单端点请求 + 独立超时。失败不抛出，返回 { ok:true, ... } 或
// { aborted:boolean, error:string }，由 fetchExit 决定是否换端点重试。
function fetchOneExit(endpoint, limit) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, limit);
  var url = endpoint + (endpoint.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();

  return fetch(url, { cache: "no-store", signal: controller.signal })
    .then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then(function (data) {
      var norm = normalizeExitPayload(data);
      if (!norm) throw new Error('端点响应不符合预期结构（缺少有效 ip 字段）');
      return norm;
    })
    .catch(function (err) {
      var aborted = !!(err && err.name === 'AbortError');
      return {
        aborted: aborted,
        error: aborted
          ? '请求超时（' + Math.round(limit / 1000) + ' 秒）'
          : ((err && err.message) || String(err))
      };
    })
    .finally(function () { clearTimeout(timer); });
}

// 检测当前网络出口。端点支持 CORS，因此无需申请任何 host 权限。
// 【C-3】有序端点容错：主端点失败（HTTP 错误 / schema 不符 / 网络拒绝）时依次尝试
//   S.TEST_ENDPOINTS 中的备用端点；全部失败时汇总各端点错误如实返回。
//   【G5】timeoutMs：可选的独立超时上限（单端点）。全局默认 S.TEST_TIMEOUT_MS（12 秒）
//   适用于「代理仍在生效」的普通出口检测；对比窗口内的直连取样必须传入
//   S.COMPARE_EXIT_TIMEOUT_MS（4 秒）—— 那段时间代理已被清除、流量真实直连，
//   超时越长 = 用户暴露在直连下的时间越长。同时对比窗口采样必须传 maxEndpoints=1：
//   超时（AbortError）本来就不换端点，禁用备用端点进一步保证暴露窗口不被放大。
function fetchExit(timeoutMs, maxEndpoints) {
  var limit = timeoutMs || S.TEST_TIMEOUT_MS;
  var endpoints = S.TEST_ENDPOINTS;
  var tries = typeof maxEndpoints === 'number'
    ? Math.max(1, Math.min(endpoints.length, maxEndpoints))
    : endpoints.length;
  var firstError = '';
  var idx = 0;

  function attempt() {
    return fetchOneExit(endpoints[idx], limit).then(function (res) {
      if (res && res.ok === true) return res;
      var msg = (res && res.error) || '未知错误';
      firstError = firstError ? (firstError + '；' + msg) : msg;
      // 超时不换端点：同一网络环境下其它端点大概率同样不可达，
      // 且对比窗口的直连取样对总时长有硬上限（G5），不允许放大暴露窗口。
      if (res && res.aborted) return { ok: false, error: firstError };
      idx++;
      if (idx < tries) return attempt();
      return { ok: false, error: firstError };
    });
  }

  return attempt();
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
//   【R7-05】但值比对【不足以】独立判定回声：外部扩展以完全相同的 mode/host/port 接管时
//   值比对同样成立，控制权却已经不在我方手里。因此回声判定必须【同时】要求控制权仍在
//   白名单内（见 onChange 回调）。原「同值接管会被误判为回声」的已知代价已由控制权维度消除。
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
  // 【R7-01】读取失败即终止，绝不进入下面的任何写分支：
  //   把「读不到」当成「读到了空」会同时造成两类破坏性后果 ——
  //   清除仍在生效的代理（enableProxy 被归一为 false），
  //   或把绕过列表静默下发为空。此时我们唯一能如实陈述的是「状态未知」。
  var settings;
  try {
    settings = await readSettings();
    settings.bypassList = await readBypassText();
  } catch (readErr) {
    var rmsg = (readErr && readErr.message) || String(readErr);
    console.warn("读取设置失败，本次既不下发也不清除代理:", rmsg);
    // 【R7-01-F】reason 让前台能把「读不到配置」与「代理真的坏了」分开陈述。
    //   status 仍是 "error"（R7-01 的既有契约与断言不变），只增加子类型。
    updateIcon("error", "read_failed");
    writeState({
      status: "error",
      reason: "read_failed",
      message: "未能确认当前配置，本次未改动代理：" + rmsg,
      at: Date.now()
    });
    return { ok: false, status: "error", errors: [rmsg] };
  }

  // 1) 未启用：清除常规作用域
  //   【M-2·审计修复】「未启用」与「已启用」是两条完全独立的流程，各自抽到独立函数
  //   （逐字搬移）。抽出的理由：合在一起使 applyProxyCore 达 263 行，两条分支的失败
  //   语义与状态文案完全不同，却无法被独立定位测试；抽开后 applyProxyCore 退化为
  //   「读配置 + 二选一」。
  if (!settings.enableProxy) {
    return applyDisabledSettings(settings);
  }
  return applyEnabledSettings(settings);
}

// 【M-2·审计修复】applyProxyCore 的「未启用」分支（原步骤 1，逐字搬移）。
//   这是「关闭开关」这条路径的全部处理：写前控制权确证 → 清除 regular →
//   尽力清理旧版遗留作用域 → 回读实际模式 → 如实陈述（只有确证 direct 才说直连）。
//   【缩进约定】函数体刻意保留 4 空格缩进：原语句位于 applyProxyCore 的 if 块内，
//   提到 2 空格会让变异门禁的锚点（含缩进）失配；本仓库对「锚点即契约」的处置是
//   保持原缩进（与 judgeApplyOutcome / windowFinalizeCommit 同款说明），
//   而不是去改 tools/mutation-check.js。
async function applyDisabledSettings(settings) {
    // 【M-1·审计修复】写前控制权确证（与下方启用分支 3.5 同一基调）：
    //   此前禁用分支不做任何控制权检查就 clearProxyScope("regular") 并宣称 direct。
    //   若此刻代理已被企业策略或其它扩展接管，这次 clear 要么无效、要么构成夺权式
    //   写入，而状态却被写成 "direct" —— 与本项目反复修复的「状态≠事实」缺陷族同型
    //   （外部接管 + 未启用时，真实流量可能仍走外部代理）。
    //   处置与启用分支 R9-02 的严格策略一致：控制权未知 → 放弃写入并如实报
    //   control_unknown；已确证被接管 → 报 overridden，绝不清除、绝不宣称直连。
    //   注意：禁用分支的清除动作同样会触碰 chrome.proxy.settings，因此它不是
    //   "只读路径"，不能豁免于「未确证即拒绝」。
    var preDirect = await readProxyDetailsWithRetry(3);
    var preDirectLevel = preDirect ? preDirect.levelOfControl : null;
    if (!preDirectLevel) {
      var unkDirectMsg = "未启用代理，但无法确证代理控制权（回读失败或缺少 levelOfControl），" +
        "已放弃清除以免对外部接管方造成干扰";
      console.warn(unkDirectMsg);
      updateIcon("error", "control_unknown");
      writeState({
        status: "error",
        reason: "control_unknown",
        message: unkDirectMsg,
        at: Date.now()
      });
      return { ok: false, status: "error", errors: [unkDirectMsg] };
    }
    if (!isControllableByUs(preDirectLevel)) {
      updateIcon("overridden");
      writeState({
        status: "overridden",
        levelOfControl: preDirectLevel,
        message: "未启用代理，但当前代理设置被企业策略或其它扩展接管，本扩展未做任何改动",
        at: Date.now()
      });
      return { ok: true, status: "overridden", levelOfControl: preDirectLevel };
    }

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

    // 【C-1】未启用分支同样必须清理旧版遗留作用域。
    //   LEGACY_SCOPES 此前只在启用分支（下方第 3 步）清理；老版本升级而来的安装若在
    //   incognito_persistent / regular_only 上残留代理配置，关闭开关后这里只清了
    //   regular 就无条件写 status:"direct" —— 隐身（或受限）流量仍在走代理，
    //   界面却宣称直连，与项目反复修复的「状态≠事实」缺陷族同型。
    //   处置与启用分支保持同一基调：尽力清理（清理动作不影响 regular 已直连的事实），
    //   失败【必须留痕并如实告知】—— 不能一边宣称 direct 一边隐瞒残留。
    var legacyFailures = [];
    for (var li = 0; li < LEGACY_SCOPES.length; li++) {
      try {
        await clearProxyScope(LEGACY_SCOPES[li]);
      } catch (legacyErr2) {
        legacyFailures.push(LEGACY_SCOPES[li]);
        console.warn("禁用路径清理遗留作用域失败:", LEGACY_SCOPES[li], legacyErr2);
      }
    }

    // 【第 4 条·审计修复】clear() ≠ 强制直连：必须回读实际生效模式再陈述。
    //   chrome.proxy.settings.clear() 只移除【本扩展自己】的偏好设置，使【下层设置重新生效】
    //   （Chrome 文档 Scope / Precedence；实现见 preference_api.cc 的
    //   ClearPreferenceFunction → RemoveExtensionControlledPref）。下层可能是操作系统代理、
    //   pac_script、auto_detect 或其它扩展的配置。因此 clear 成功之后流量【未必是直连】，
    //   此前却无条件写 status:"direct"、图标转红、界面宣称「未启用代理（直连）」——
    //   与事实不符，且会污染后续「直连出口」对比的基准（把系统代理的出口当成直连出口）。
    //   处置：回读实际模式，只有确证 mode === "direct" 才按直连陈述；回读失败也必须说明，
    //   不得把「读不到」当成「是直连」（与 R7-01「读不到 ≠ 没有」同一条原则）。
    var afterClear = await readProxyDetails();
    var afterClearMode = (afterClear && afterClear.value && afterClear.value.mode) || null;
    // 【M-1·审计修复】把回读结果一并交给 updateIcon：图标标题必须与状态条同档，
    //   否则悬停提示会在「回读失败」与「沿用下层代理」两种情形下继续宣称直连。
    //   afterClearMode 为 null（回读失败）时传 'read_failed'，由 updateIcon 取对应文案。
    updateIcon("direct", afterClearMode || "read_failed");
    var directState = { status: "direct", at: Date.now() };
    if (!afterClearMode) {
      directState.readFailed = true;
      directState.message = "已停用本扩展的代理，但无法确证当前实际生效的模式（回读失败）；" +
        "浏览器可能正沿用系统或其它扩展的代理设置";
    } else if (afterClearMode !== "direct") {
      directState.systemProxy = afterClearMode;
      directState.message = "已停用本扩展的代理；当前实际生效的是浏览器/系统自身的代理设置" +
        "（" + afterClearMode + "），并非直连";
    }
    if (legacyFailures.length) {
      var lfmsg = "清理旧版遗留代理作用域失败（" + legacyFailures.join("、") +
        "），隐身窗口或受限场景可能仍走旧代理，建议重启浏览器";
      directState.legacyClearFailed = legacyFailures;
      directState.message = (directState.message ? directState.message + "；" : "") + lfmsg;
    }
    writeState(directState);
    return {
      ok: true,
      status: "direct",
      systemProxy: directState.systemProxy || null,
      legacyClearFailed: legacyFailures
    };
  }

// 【M-2·审计修复】applyProxyCore 的「启用」路径（原步骤 2~5，逐字搬移）。
//   调用前提：settings 已确认 enableProxy === true，且已完成读取失败的早退。
//   顺序：校验配置 → 清理遗留作用域 → 下发前控制权门 → 原生 fixed_servers 下发
//   → 回读控制等级与落实校验。每一句文案、每一个 return 结构与状态字段逐字未改。
async function applyEnabledSettings(settings) {
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

  // 3.5) 下发前的控制权保护（【M-2 抽取】判定移至 ensureControlBeforeApply）。
  //   null = 可以继续下发；返回结果对象 = 就此返回（不夺权 / 状态未知）。
  var gate = await ensureControlBeforeApply();
  if (gate) return gate;

  // 4) 原生 fixed_servers 下发（不生成 PAC 脚本）
  var config = buildProxyConfig(settings);

  try {
    // R6-04：记录本次下发意图，供 onChange 回声抑制按值比对。
    // 【R8-03】必须连【协议】一起记：同 host/port、只把 scheme 换成别的外部写入
    //   （socks5 → https）在只比 host/port 时会被判成我方回声，整次变化被吞掉，
    //   界面继续宣称已生效，而真实生效的协议早已不是我方下发的那个。
    lastIntent = {
      mode: "fixed_servers",
      host: config.rules.singleProxy.host,
      port: String(config.rules.singleProxy.port),
      scheme: config.rules.singleProxy.scheme
    };
    await setProxy(config);
  } catch (err) {
    var msg = (err && err.message) || String(err);
    updateIcon("error");
    // 【L-4·工作区报告修复】这里是**真正生效**的一处：applyProxyCore 被「第四步兜底重放」
    //   再次调用，而重放发生在收尾（windowFinalizeCommit）写状态**之后** —— 于是重放
    //   内部的这条写入会覆盖掉收尾那条更完整的状态。此前这里不落 pendingResubmit，
    //   结果正是：收尾刚如实写下的「还有配置待下发」被重放抹掉，状态与事实重新脱节
    //   （只有 overridden 路径不受影响，因为它不经过重放的这次写入）。
    //   实测证据：tests/ownership.test.js 的 R6-01 用例中，只改收尾两条 error 路径时
    //   末次状态仍是 {"status":"error","message":"set failed ..."}，pendingResubmit 为
    //   undefined —— 断言红；补上这一处才转绿。故【承重的是这一处】。
    writeState({ status: "error", message: msg, pendingResubmit: suspendDirty, at: Date.now() });
    return { ok: false, status: "error", errors: [msg] };
  }

  // 5) 回读控制等级与落实校验（【M-2 抽取】整段移到 judgeApplyOutcome）
  var details = await readProxyDetails();
  return judgeApplyOutcome(details, suspendDirty);
}

// 【M-2·审计修复】下发前的控制权门（原 applyProxyCore 步骤 3.5，逐字搬移）。
//   返回值约定：null = 可以继续下发；否则该对象就是 applyProxyCore 应当返回的结果
//   （「未确证即拒绝」的两种表现：状态未知 / 已被外部接管）。这是纯搬迁，
//   判定顺序、返回结构、每一句文案与 pendingResubmit 字段逐字未改。
async function ensureControlBeforeApply() {
  // 下发前的控制权保护（不夺权）：
  //   若当前代理设置已【确证】被企业策略或其它扩展接管，再写下去就是夺权 ——
  //   对比窗口收尾之后的排队任务会走到这里，此时外部接管仍在，必须跳过。
  //   注意：回读失败（pre 为 null）时不阻断正常下发，否则代理故障期间扩展完全不可用；
  //   "未知即拒绝"的严格判定只用在【对比窗口收尾】那条会造成夺权的路径上。
  // 【R9-02】回读失败不再放行。此前 pre 为 null（回读失败）时会跳过本段直接下发，
  //   而"回读失败"与"无人接管"是两件不同的事：真实企业策略或其它扩展正在接管时，
  //   一次瞬时回读失败就会让我们把配置写下去——那是夺权，与 isControllableByUs
  //   白名单策略直接冲突。现在做一次有界重试，仍无法确证就【放弃写入】并如实
  //   报成"状态未知"。
  //   这不是新发明的严格策略：对比窗口的两次复查（清除前、收尾前）本来就是
  //   "未确证即拒绝"，本段此前是唯一的例外。
  var pre = await readProxyDetailsWithRetry(3);
  var preLevel = pre ? pre.levelOfControl : null;
  if (!preLevel) {
    var unkMsg = "无法确证代理控制权（回读失败或缺少 levelOfControl），已放弃本次下发以免夺权";
    console.warn(unkMsg);
    updateIcon("error", "control_unknown");
    writeState({
      status: "error",
      reason: "control_unknown",
      message: unkMsg,
      pendingResubmit: suspendDirty,
      at: Date.now()
    });
    return { ok: false, status: "error", errors: [unkMsg] };
  }
  if (!isControllableByUs(preLevel)) {
    updateIcon("overridden");
    // 【R6-03】带上 pendingResubmit：该分支写下的 overridden 会覆盖对比窗口写下的
    //   带 pending 的状态（session 写入是"先发布后覆盖"）。若这里丢掉该字段，
    //   用户在暂停期改的配置就彻底不可见，与 R3-01 的"静默丢弃"同型。
    writeState({ status: "overridden", levelOfControl: preLevel, pendingResubmit: suspendDirty, at: Date.now() });
    return { ok: true, status: "overridden", levelOfControl: preLevel };
  }
  return null;
}

// 【M-2·审计修复】「设置 → chrome.proxy 配置」的纯映射（原 applyProxyCore 步骤 4）。
//   纯函数：无副作用、不读存储、不碰 chrome.*，因此可以脱离运行环境直接单测。
//   逐字搬移取值方式（含 IPv6 去方括号、绕过列表解析），未改任何语义。
function buildProxyConfig(settings) {
  return {
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
}

// 【M-2·审计修复】下发后的「回读失败 / 控制权判定 / 落实校验」整段。
//   原来这 47 行压在 applyProxyCore 尾部，使该函数膨胀到 263 行（全仓最大），
//   而它是【下发结果判定的唯一出口】，改动频率高、分支密度大 —— 混在一起
//   既读不动也无法单独测试（覆盖率报告里这一整段此前为空）。
//   本次为纯搬迁：判定顺序、return 结构、每一句文案逐字未改。
//   注意：这里的 if/else 结构刻意保持原缩进，使变异门禁的锚点
//   （M3 的 `if (actualMode && actualMode !== "fixed_servers") {`）继续逐字节命中。
function judgeApplyOutcome(details, suspendDirty) {
  // 回读失败（details 为 null）意味着"下发调用返回了成功，但我们无法确认控制权"。
  // 这种情况下显示绿色 applied 是在宣称一个未经证实的结论（R3-04）：
  // 必须判为 error，让用户看到"状态未知"而不是"已生效"。
  if (!details) {
    // 【A1/lint】此处与函数前部的读取失败分支各有一个消息变量：
    //   同名 var 会被 no-redeclare 拦下，且两处语义不同，刻意不同名。
    var rdmsg = "无法回读代理设置，不能确认代理是否已生效";
    updateIcon("error");
    writeState({ status: "error", message: rdmsg, at: Date.now() });
    return { ok: false, status: "error", errors: [rdmsg] };
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

// 【M-2·审计修复】进入对比窗口「之前」的前置判据（原 runConnectionTest 内联块，逐字搬移）。
//   抽出的理由：runConnectionTest 曾达 108 行，把「能不能进对比窗口」这段纯判定与
//   「怎么进窗口」的执行流程混在一条函数里，分支无法被独立定位测试。
//   返回值 = controlledByUs，调用方仍需它来决定是否进入窗口（语义与原内联写法一致）。
function judgeCompareEntry(compare, settings, before, result) {
  // 与窗口、下发前检查共用 isControllableByUs。
  // 缺字段不是“可以由本扩展控制”。
  var controlledByUs = isControllableByUs(result.levelOfControl);

  if (compare && settings.enableProxy && !controlledByUs) {
    result.compareSkipped = result.levelOfControl
      ? "not_controlled_by_this_extension"
      : "unknown_control";
  }

  // 【R7-02】进入对比窗口之前的前置判据（核心原则：配置无效时，宁可不测，也不许动代理）。
  //   窗口的第一步就是 clearProxyScope("regular")，而收尾的 applyProxyCore 会因为
  //   validateSettings 失败直接返回 saved_not_applied —— 一次 set 都不会发出去。
  //   于是"清除"与"恢复"严重不对称：仍在工作的旧代理被清掉，且永远不会被写回，
  //   测试结束后浏览器里的代理变成 null（代理丢失且不恢复）。
  //   因此进入对比之前必须同时确认两件事，任一不满足都直接早退：
  //     (a) 存储里的配置本身有效 —— 否则收尾根本写不回去；
  //     (b) chrome.proxy 里【当前实际生效】的配置确实是我方下发的 fixed_servers
  //         —— 回读失败（value 缺失）同样是未知，未知不得清除。
  //   before 正是"清除之前"对实际生效配置的那一次真实回读，因此这里的判据
  //   恰好落在 clear 之前；窗口内原有的控制权复核继续承担 TOCTOU 防护。
  //   这条早退【不写状态、不改图标、不清脏】：现场并没有被破坏，
  //   状态应当保持测试前的真实结论，而不是被一次"什么都没做"的测试改写。
  if (compare && settings.enableProxy && controlledByUs) {
    var entryErrors = S.validateSettings(settings);
    var activeMode = before && before.value ? before.value.mode : null;
    if (entryErrors.length) {
      result.compareSkipped = "invalid_settings";
      result.compareSkippedReason = entryErrors.join("；");
    } else if (!activeMode) {
      result.compareSkipped = "unknown_active_mode";
      result.compareSkippedReason = "无法回读当前实际生效的代理配置";
    } else if (activeMode !== "fixed_servers") {
      result.compareSkipped = "not_fixed_servers";
      result.compareSkippedReason = "当前实际生效的代理模式是 " + activeMode +
        "，不是本扩展下发的 fixed_servers";
    }
  }

  return controlledByUs;
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
    compareSkipped: null,
    compareSkippedReason: null
  };

  var controlledByUs = judgeCompareEntry(compare, settings, before, result);

  if (compare && settings.enableProxy && controlledByUs && !result.compareSkipped) {
    // 【G4】取样可信度复核：currentExit 的取样发生在 before 回读与本次回读之间。
    //   若这两次回读之间控制权或实际生效配置发生了变化（用户改设置、多设备同步、
    //   外部接管），取样可能来自「下发前」或「下发后」，得到一个不可信的评价基准，
    //   进而误报「出口 IP 与直连相同 → 代理很可能未生效」，把用户引向错误的排障方向。
    //   因此必须复核：签名不一致就放弃对比并如实标记，绝不给出无依据的结论。
    //   两次回读都失败（都为 null）视为相等 —— 两边同样不可读，不构成「发生了变化」。
    var afterSample = await readProxyDetails();
    if (proxySignature(before) !== proxySignature(afterSample)) {
      result.samplingUnstable = true;
      result.compareSkipped = "sampling_unstable";
      result.compareSkippedReason = "取样期间代理配置或控制权发生了变化，直连评价基准不可信";
      writeTest(result);
      return result;
    }

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

    // 【M-2·审计修复】清除 → 确证实际模式 → 取直连出口（整段移至 windowClearAndSampleDirect）。
    //   这三步构成「暴露窗口」的全部内容（代理已被清除、流量真实直连），是安全性讨论
    //   最集中的一段；抽开后 runCompareWindow 只负责流程编排与控制权判定。
    await windowClearAndSampleDirect(result);

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

    // 【M-2·审计修复】按最新 settings 提交 + 兜底重放（整段移至 windowFinalizeCommit）。
    await windowFinalizeCommit(result);

    return result;
  } finally {
    // 【S2】窗口结束（含任何早退路径）即清除恢复意图：SW 存活期间，恢复与上报
    //   由窗口逻辑自己负责；标记只在「SW 于窗口中途死亡」时残留到冷启动对账。
    //   放在 suspendDepth 递减之前，保证任何异常路径下标记都不晚于窗口关闭被清理。
    clearPendingRestore();
    // 暂停贯穿收尾：直到恢复与重放全部结束才递减（R3-01 根因之二）。
    suspendDepth--;
    if (suspendDepth < 0) suspendDepth = 0;   // 防御性归零，避免异常路径下变负
  }
}

// 【M-2·审计修复】对比窗口的「清除 → 确证实际模式 → 取直连出口」整段
//   （原 runCompareWindow 内联，逐字搬移）。
//   【缩进约定】函数体刻意保留 4 空格缩进：原语句位于 runCompareWindow 的 try 块内，
//   若提到 2 空格会让变异门禁的锚点（含缩进）失配。本仓库对「锚点即契约」的处置是
//   保持原缩进（与 judgeApplyOutcome 同款说明），而不是去改 tools/mutation-check.js。
async function windowClearAndSampleDirect(result) {
    // 【S2】清除之前先持久化「待恢复意图」：从这里到收尾提交之间 SW 随时可能被
    //   回收，标记在位 = 冷启动能识别「恢复未完成」并重新下发。窗口正常收尾时
    //   由 finally 清除；只有「SW 在窗口中途死亡」时标记才会残留到冷启动。
    writePendingRestore();

    try {
      await clearProxyScope("regular");
    } catch (directClearErr) {
      // 清除失败就无法取得可信的直连出口，必须如实标记，不能假装测过直连。
      result.directClearFailed = (directClearErr && directClearErr.message) || String(directClearErr);
    }
    // 【第 4 条·审计修复】clear 之后必须确证「现在到底是不是直连」。
    //   下面的取样此前被直接称为「直连出口」，但 clear() 只是让【下层设置重新生效】：
    //   若下层是系统代理 / PAC / 自动检测，这一段的出口走的是那条链路，并不是直连。
    //   把实际模式如实带回前台（result.afterClearMode），由前台据实标注这一行的含义，
    //   避免把一个被污染的基准当成「直连出口」而给出错误结论。
    if (!result.directClearFailed) {
      var afterClearForSample = await readProxyDetails();
      result.afterClearMode = (afterClearForSample && afterClearForSample.value &&
        afterClearForSample.value.mode) || null;
    }
    // 【G5】直连取样用独立短超时（4 秒）：这段区间代理已被清除、流量真实直连，
    //   不允许沿用 12 秒的全局上限把暴露窗口拉长一个数量级。
    //   【C-3】同时锁定单端点（maxEndpoints=1）：备用端点重试会把「已清除」区间的
    //   总时长放大 N 倍，直连取样宁可如实失败也不能延长暴露。
    result.direct = await fetchExit(S.COMPARE_EXIT_TIMEOUT_MS, 1);
}

// 【M-2·审计修复】对比窗口的「按最新 settings 提交 + 兜底重放」（原内联，逐字搬移）。
//   这是窗口的收尾闸门：清脏与否、restoreFailed 与否、pendingResubmit 是否保留，
//   全部在此决定，也是 R3-01 三轮根因修复的落点。
//   【缩进约定】同 windowClearAndSampleDirect：保留 4 空格以维持变异锚点逐字节命中。
async function windowFinalizeCommit(result) {
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
      writeState({
        status: "error",
        message: "对比后恢复代理设置失败：" + rmsg,
        // 【L-4·工作区报告修复】error 路径此前不落此字段（只有 overridden 路径落）——
        //   于是「暂停期间的配置还有待下发」这一事实只剩内存里的 suspendDirty，
        //   而 SW 随时可能在任意 await 点被回收，事实随之消失（R3-01 逃逸面的另一半）。
        //   与 overridden 路径对齐：与「读不到 ≠ 没有」同源，事实必须立刻落到
        //   可被前台观测的状态里，而不是押注「后面还会有事件来驱动补发」。
        pendingResubmit: suspendDirty,
        at: Date.now()
      });
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
      // 两个都可能是原因：本函数开头的收尾复核已判定被接管（那条路径直接 return，
      // 走不到这里），或复核通过之后、真正下发之前控制权又变了。
      // 两种情况下都不夺权、如实保留待下发。
      // 【注】此处原为硬编码行号引用（"L473–490" / "L235–239 / L282–292"），
      //   行号随每次重构必然失效（本项目已有明确教训），故改为描述性引用。
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
      writeState({
        status: "error",
        message: "对比后恢复代理设置未生效：" + cmsg2,
        // 【L-4·工作区报告修复】与上面「抛异常」路径同款：error 也必须把「待下发」
        //   事实落进状态。此前两处 error 都不落、只有 overridden 落，导致
        //   「前台能否看到待下发」取决于失败的具体形态 —— 同一语义两种呈现，
        //   正是本项目反复吃过亏的「判据漂移」。现在三处（抛异常 / 未达终态 /
        //   overridden）写法一致。
        pendingResubmit: suspendDirty,
        at: Date.now()
      });
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
}

// 【G4】把「实际生效配置 + 控制权」压成一个可比较的签名，用于取样前后的一致性复核。
//   比对 levelOfControl / mode / singleProxy 的 scheme+host+port 四项 —— 与
//   isOwnLastIntent（R6-04/R8-03）的值维度保持同一严格度：协议不同 = 链路不同。
//   回读失败（null）与任何可读配置都不相等；两次都失败视为相等（都不可读）。
function proxySignature(d) {
  if (!d) return null;
  var v = d.value || {};
  var sp = (v.rules && v.rules.singleProxy) || null;
  return JSON.stringify([
    d.levelOfControl || null,
    v.mode || null,
    sp ? [sp.scheme || null, sp.host || null, String(sp.port)] : null
  ]);
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

/* ==================== 存量绕过列表污染自愈（R9-01） ==================== */

// 历史缺陷（更早版本的升级补缺）会把内置默认绕过列表写进 sync.bypassList，
// 而用户真实的长列表只剩 local 一份（超长列表降级保存时 local 是唯一副本）。
// 此后 resolveBypassList 的「sync 非空优先」让默认 6 条遮蔽用户规则：用户看到
// 默认值、自己的规则不可见；若此时用户编辑一次并保存，旧实现会把 local 写空——
// local 没有第二份副本，长列表永久丢失。
//
// 【R9-01】此前这段自愈只在 chrome.runtime.onInstalled 的 update 分支执行一次，
//   覆盖不到两条真实到达路径：
//     ① 升级那一刻 storage.local.get 瞬时失败，自愈被跳过，而 onInstalled
//        只在换版本时触发一次，之后不会重试；
//     ② 另一台设备点了「恢复默认」，默认列表经 storage.sync 同步到本机，本机
//        local 不参与同步，于是形成同样的污染组合，但【不触发 onInstalled】。
//   现在把它抽成幂等函数，在冷启动与 storage 变化时都执行：只要污染组合出现，
//   就在同一个同步周期内被修正。
//
// 判据保持【逐字符等于内置默认列表】，不做长度/条数近似匹配——近似判据会把
//   用户自写的等长列表误判成污染并清掉 sync，那是用一次误伤换一次修复。
// 写入目标【只有 sync.bypassList】：local 是用户唯一的数据副本，绝不动它。
var legacyReconciling = false;

function isLegacyShadowed(syncRaw, localRaw) {
  return typeof syncRaw === 'string' &&
         syncRaw === S.DEFAULTS.bypassList &&
         typeof localRaw === 'string' &&
         localRaw.length > 0 &&
         localRaw !== S.DEFAULTS.bypassList;
}

function reconcileLegacyBypass() {
  if (legacyReconciling) return;
  legacyReconciling = true;
  chrome.storage.sync.get(['bypassList'], function (syncItems) {
    var syncErr = chrome.runtime.lastError;
    if (syncErr) {
      // 读不到就什么都不做：宁可晚一轮自愈，也不能在未知状态下写用户数据。
      console.warn("绕过列表自愈：读取 sync 失败，跳过本轮:", syncErr.message);
      legacyReconciling = false;
      return;
    }
    chrome.storage.local.get(['bypassList'], function (localItems) {
      var localErr = chrome.runtime.lastError;
      if (localErr) {
        console.warn("绕过列表自愈：读取 local 失败，跳过本轮:", localErr.message);
        legacyReconciling = false;
        return;
      }
      if (!isLegacyShadowed(syncItems && syncItems.bypassList, localItems && localItems.bypassList)) {
        legacyReconciling = false;
        return;
      }
      console.warn("检测到存量绕过列表污染（sync 为默认列表、local 为用户规则），正在把 sync 恢复为空串占位以让 local 生效。");
      // 写空串 = 恢复「已降级到 local」的正常占位形态。写完后条件自然不再成立，
      // 因此本函数幂等且不会形成写入循环。
      chrome.storage.sync.set({ bypassList: '' }, function () {
        var setErr = chrome.runtime.lastError;
        if (setErr) {
          console.warn("绕过列表自愈写回失败，将在下次存储变化时重试:", setErr.message);
        }
        legacyReconciling = false;
        applyProxySerial();
      });
    });
  });
}

/* ==================== 生命周期与事件 ==================== */

chrome.runtime.onInstalled.addListener(function (details) {
  var reason = details && details.reason;

  if (reason === 'install') {
    // 【V-04】此前这里无条件 chrome.storage.sync.set(S.DEFAULTS)，前提是
    //   "全新安装 → sync 必然是空的"。该前提在一种真实场景下不成立：
    //   同一 Google 账号下【卸载后重装】，sync 的键值随账号保留在云端，
    //   而 local（用户长列表降级副本）已随卸载清空；此时无条件写入
    //   会把用户云端的代理地址、端口与绕过列表【全键覆盖】为默认值。
    //   改为与 update 分支相同的"只补空缺"语义：先读，仅对【确实不存在】的键补默认值。
    chrome.storage.sync.get(CONFIG_KEYS, function (items) {
      var installReadErr = chrome.runtime.lastError;
      if (installReadErr) {
        // 读不到就什么都不补：与 R7-01 同一条原则 —— 绝不把"读不到"当成"用户没配"。
        console.warn("首次安装补默认值时读取设置失败，跳过补写:", installReadErr.message);
        applyProxySerial();
        return;
      }
      var patch = {};
      // 【为什么不能看 normalizeSettings 的结果】S.normalizeSettings(items) 会用 DEFAULTS
      //   把缺失键【填满】，因此 cur.proxyHost / cur.proxyPort 永不为空 —— 用它判"空缺"
      //   会得到"永远没有空缺"（与 update 分支同样的形状）。这里必须看【原始键】：
      //     键缺失 或 值为空串/纯空白 → 视为空缺，补默认值；
      //     键存在且非空            → 用户配置，绝不覆盖。
      var rawHost = items && items.proxyHost;
      if (typeof rawHost !== 'string' || !rawHost.trim()) patch.proxyHost = S.DEFAULTS.proxyHost;
      var rawPort = items && items.proxyPort;
      if (typeof rawPort !== 'string' || !rawPort.trim()) patch.proxyPort = S.DEFAULTS.proxyPort;
      // 【A-1·审计修复】与 update 分支同一防线：sync 里残留的非法 proxyType
      //   （历史缺陷版本写入或云端脏数据）不能原样留给下发路径 ——
      //   install 分支此前只补空缺、不清洗非法值，与 update 分支行为不一致。
      //   只清洗【键存在但值非法】的情形：键缺失走上面的空缺补写，正常值绝不触碰。
      var allowedInstallTypes = S.PROXY_TYPES.map(function (pt) { return pt.value; });
      if (items && items.proxyType && allowedInstallTypes.indexOf(items.proxyType) < 0) {
        patch.proxyType = S.DEFAULTS.proxyType;
      }
      // bypassList 的三态判据与 update 分支完全一致（键缺失 + local 无值 才算"从未配置"）：
      //   重装场景下 local 必然为空，但 sync 里【有】用户列表 → 不补，用户配置得以保留。
      chrome.storage.local.get(['bypassList'], function (localItems) {
        var localErr = chrome.runtime.lastError;
        if (localErr) {
          console.warn("首次安装补默认值时读取 local 失败，跳过绕过列表补写:", localErr.message);
        } else {
          var syncHasKey = !!items && Object.prototype.hasOwnProperty.call(items, 'bypassList');
          var localRaw = localItems && localItems.bypassList;
          var localHasValue = typeof localRaw === 'string' && localRaw.length > 0;
          if (!syncHasKey && !localHasValue) patch.bypassList = S.DEFAULTS.bypassList;
        }
        if (Object.keys(patch).length) {
          chrome.storage.sync.set(patch, function () {
            var setErr = chrome.runtime.lastError;
            if (setErr) console.warn("首次安装补默认值写回失败:", setErr.message);
            applyProxySerial();
          });
        } else {
          applyProxySerial();
        }
      });
    });
    return;
  }

  if (reason === 'update') {
    // 升级：只补空缺，不覆盖用户已填内容，不改动启用状态
    chrome.storage.sync.get(CONFIG_KEYS, function (items) {
      // 【R7-01】补空缺必须建立在【读到的真实内容】之上：读取失败时 items 为空，
      //   归一化后 proxyHost/proxyPort 全为空，会把「读不到」当成「用户没配」，
      //   用默认值把用户已填的地址与端口覆盖掉。此时直接交给下发路径，
      //   由它把读取失败如实报成状态未知，不做任何补写。
      var updateReadErr = chrome.runtime.lastError;
      if (updateReadErr) {
        console.warn("升级补空缺时读取设置失败，跳过补写:", updateReadErr.message);
        applyProxySerial();
        return;
      }
      var cur = S.normalizeSettings(items);
      var patch = {};

      if (!cur.proxyHost) patch.proxyHost = S.DEFAULTS.proxyHost;
      if (!cur.proxyPort) patch.proxyPort = S.DEFAULTS.proxyPort;

      var allowed = S.PROXY_TYPES.map(function (t) { return t.value; });
      if (items.proxyType && allowed.indexOf(items.proxyType) < 0) {
        patch.proxyType = S.DEFAULTS.proxyType;
      }

      // 【R7-03】绕过列表的补缺必须按【有效来源】判断，不能只看 sync。
      //   绕过列表的取值规则是「sync 非空优先，为空则回退 local」
      //   （settings.js 的 resolveBypassList，popup 与 background 共用）：
      //   超长列表保存时 popup 先写 local.bypassList（用户规则），
      //   再把 sync.bypassList 写成【空串】占位。
      //   此前这里只看 normalizeSettings(items) 的结果，占位空串被判成「用户没配」，
      //   于是默认 6 条覆盖了 sync —— 下发值随即变成默认，用户长列表被遮蔽；
      //   此后用户在 popup 点一次保存就会走 clearLocalBypassIfAny() 把 local 也写成
      //   空串，而 local 并无第二份副本，长列表就此永久丢失。
      //   三态必须分开；判据取【原始键是否存在】，而不是 normalizeSettings 的结果
      //   —— 后者会用默认值填满缺失的键，从而抹掉「从未配置」这一事实：
      //     · 键缺失     + local 无有效值 → 确实从未配置 → 补默认值；
      //     · 键缺失     + local 有有效值 → local 才是有效来源 → 保持现状；
      //     · sync 空串  + local 有有效值 → 降级占位 → 保持现状；
      //     · sync 空串  + local 无有效值 → 用户主动清空 → 保持现状。
      //   local 读取失败时无法区分后两种，宁可不补写，也不覆盖用户数据。
      chrome.storage.local.get(['bypassList'], function (localItems) {
        var localErr = chrome.runtime.lastError;
        var syncHasKey = !!items && Object.prototype.hasOwnProperty.call(items, 'bypassList');
        var localRaw = (!localErr && localItems) ? localItems.bypassList : undefined;
        var localHasValue = typeof localRaw === 'string' && localRaw.length > 0;
        if (!localErr && !syncHasKey && !localHasValue) {
          patch.bypassList = S.DEFAULTS.bypassList;
        }

        // 【R8-02】存量救援：更早版本的升级补缺缺陷把【默认列表】写进了 sync.bypassList，
        //   而用户真实的长列表只剩 local 一份（超长列表降级保存时 local 是唯一副本）。
        //   此后 resolveBypassList 的「sync 非空优先」规则让默认 6 条遮蔽了用户列表：
        //   用户打开 popup 看到的是默认值（自己的规则不可见），点一次「保存」就经
        //   popup 的 clearLocalBypassIfAny() 把 local 也清空 —— local 没有第二份副本，
        //   长列表永久丢失；全程没有任何 lastError，前后端状态都宣称一切正常。
        //   R7-03 只挡住了【新】用户进入该状态，存量已污染用户必须在这里被救回来。
        //
        //   识别判据刻意采用【逐字符等于默认列表】：用户手写出与内置默认列表逐字相同
        //   的列表（含首行注释与空行）的概率可忽略，而「长度」「条数」这类近似判据会把
        //   用户自写的等长列表误判成污染并清掉 sync —— 那是用一次误伤换一次修复，
        //   不可接受。因此这里只认逐字符相等：条件不满足时（正常用户）不做任何写入，
        //   行为与修复前完全一致。
        //
        //   修复动作 = 把 sync.bypassList 写成【空串】：恢复「已降级到 local」的正常
        //   占位形态，使取值规则回退到 local，用户的长列表重新生效并随本次下发生效。
        //   【绝对不要】顺手改 local —— 那是用户唯一的数据副本。
        //
        //   与本段上面的判据互斥：那条要求 sync 里【没有】bypassList 键，
        //   而存量污染要求 sync 里该键存在且逐字符等于默认列表；两者不可能同时成立，
        //   因此这两处赋值不会互相覆盖，正常用户的行为一字不变。
        var syncRaw = items && items.bypassList;
        // 【R9-01】判据改为与冷启动 / 存储变化时的连续自愈共用同一个函数，
        //   避免两份实现随时间漂移（此前这里是一段内联表达式）。
        var legacyShadowed = !localErr && localHasValue && isLegacyShadowed(syncRaw, localRaw);
        if (legacyShadowed) patch.bypassList = '';

        if (Object.keys(patch).length) {
          chrome.storage.sync.set(patch, function () {
            // 【A-2·审计修复】写回失败必须留痕：此前 `void chrome.runtime.lastError`
            //   静默吞掉补空缺的写回失败，界面与日志都无从追溯；缺省值补写失败
            //   意味着本次升级后配置仍不完整，至少要在 SW 日志里留下线索。
            //   不改变控制流：无论成败都继续下发（与原行为一致），只补可见性。
            var wbErr = chrome.runtime.lastError;
            if (wbErr) console.warn("升级补空缺写回失败:", wbErr.message);
            applyProxySerial();
          });
        } else {
          applyProxySerial();
        }
      });
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
// 【自触发抑制】本扩展自己每次 set/clear 也会触发该事件。这里用【值比对 + 控制权】而不是时间窗：
//   只有「实际生效配置与 lastIntent 完全一致」【且】「控制权仍可由我方掌握」才判定为我方回声，
//   直接忽略；值不同（外部接管）或控制权已旁落，都立刻如实生效。
//   时间窗方案会把「我方写完 300ms 内被外部接管」这一段真实变化静默吞掉，本方案没有这个盲区。
//   【R7-05】只看值不看控制权是此前的缺陷：外部以【相同】mode/host/port 接管时，事件被当成
//   回声吞掉 —— 界面继续宣称「我方控制 + 已生效」且图标留绿，而真实控制权已是
//   controlled_by_other_extensions，我方后续下发早已不可行，排障方向也被误导。
//   该已知代价现已由控制权维度消除（是消除，不是降级为「影响可忽略」）。
//   【R8-03】值比对此前漏了协议：同 host/port、只把 scheme 换成别的外部写入会被当成
//   我方回声整次吞掉，界面继续宣称已生效。值比对现为 mode/host/port/scheme 四项，
//   与 isOwnLastIntent 的判据、以及状态推导里的 sameTarget 判据保持一致。
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

    // 自触发回声：必须【同时】满足两点，才认定这次变化是我方自己造成的 ——
    //   ① 实际生效配置与我方最近一次意图一致（isOwnLastIntent：只负责「值是否等于我方意图」）；
    //   ② 控制权仍可由我方掌握（isControllableByUs 白名单）。
    //   缺了②就会把「外部以相同 mode/host/port 接管」误判为回声：值一样，控制权却已旁落，
    //   界面会一直宣称我方已生效（绿色），而后台下发早已不可行（R7-05）。
    //   两条合法回声路径都落在白名单内，因此抑制语义不变：
    //     · set 成功的回声 → controlled_by_this_extension；
    //     · clear 成功的回声 → controllable_by_this_extension，且 lastIntent.mode === "direct"。
    //   认定回声后：状态由下发路径自己写，这里不重复回查、不重复刷新图标。
    if (isControllableByUs(level) && isOwnLastIntent(actualMode, sp)) return;

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
    // 【R7-01】readSettings 现在会 reject，这里必须给出失败分支，
    //   否则「外部变化 + 我方配置读不到」会变成一次静默无操作：
    //   界面继续停留在过时结论上，用户看不到任何提示。
    //   同样只写状态、不写回（本回调的硬约束见上）。
    readSettings().then(function (st) {
      var isFixed = actualMode === "fixed_servers";
      var mineIsFixed = !!st.enableProxy;
      // 【R8-03】同目标必须连协议一起比对：只比 host/port 时，「同 host/port、换协议」
      //   的外部配置会被当成我方目标而写出 applied —— 界面宣称已生效，链路却早已不是那条。
      //   协议不同 → 落入下面的 error 档，如实说明生效配置不是本扩展下发的。
      var sameTarget = !!sp && sp.host === S.stripBrackets(st.proxyHost) &&
                       String(sp.port) === String(st.proxyPort) &&
                       sp.scheme === st.proxyType;

      if (mineIsFixed && isFixed && sameTarget) {
        writeState({ status: "applied", levelOfControl: level, at: Date.now() });
        updateIcon("applied");
        return;
      }
      if (!mineIsFixed && !isFixed) {
        // 【第 4 条·审计修复】!isFixed 涵盖 direct / system / pac_script / auto_detect，
        //   其中只有第一种才是真正的直连。此前一律写 direct 并宣称「未启用代理（直连）」，
        //   与紧随其后那段自述的意图（「存在非我方下发的代理配置」必须如实上报）自相矛盾：
        //   系统代理 / PAC / 自动检测同样「不是本扩展下发的配置」。
        var dState = { status: "direct", at: Date.now() };
        if (actualMode !== "direct") {
          dState.systemProxy = actualMode || null;
          dState.message = "已停用本扩展的代理；当前实际生效的是浏览器/系统自身的代理设置" +
            "（" + (actualMode || "未知模式") + "），并非直连";
        }
        writeState(dState);
        // 【M-1·审计修复】同禁用分支：把实际模式交给 updateIcon，标题不得宣称直连。
        updateIcon("direct", actualMode || "read_failed");
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
    }, function (readErr) {
      var emsg = (readErr && readErr.message) || String(readErr);
      // 【R7-01-F】同一条「读取失败 ≠ 代理没了」的语义，这里同样不能声称已回退直连。
      writeState({
        status: "error",
        reason: "read_failed",
        message: "代理设置已变化，但读取本扩展配置失败，无法确认当前状态：" + emsg,
        at: Date.now()
      });
      updateIcon("error", "read_failed");
    });
  });
});

// 判断「实际生效配置」是否就是我方最近一次下发的意图（R6-04 回声抑制）。
//   比对 mode / host / port / scheme 四项，缺一不可 —— 它们共同构成「生效的是不是
//   我要的东西」的判据：host/port 决定流量去哪儿，scheme 决定用什么协议送过去；
//   同 host/port 而换了协议（socks5 → https）走的完全是另一条链路（R8-03）。
//   bypassList 不参与比对：它不影响控制权归属，也不作为状态结论的依据。
//   端口两侧统一转成字符串，避免 number/string 造成的假差异。
//   【早退分支语义不变】mode !== "fixed_servers" 的意图（直连没有协议可言）
//   在 mode 比对通过后即成立，绝不给它强加 scheme 字段。
function isOwnLastIntent(actualMode, sp) {
  if (!lastIntent) return false;
  if (actualMode !== lastIntent.mode) return false;
  if (lastIntent.mode !== "fixed_servers") return true;
  if (!sp) return false;
  return sp.host === lastIntent.host && String(sp.port) === String(lastIntent.port) &&
         sp.scheme === lastIntent.scheme;
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
    // 【R9-01】同步（含另一台设备）带来的"默认列表 + 本地长列表"组合会在写入前
    //   就被修正，用户来不及在一次被遮蔽的显示上做出破坏性保存。
    reconcileLegacyBypass();
    applyProxySerial();
  }
});

// 【L-08·审计修复】诊断快照的脱敏摘要。
//   背景：全仓 28 处 console.*（background 25 / popup 3）分散在各条路径上，
//   排障只能人工打开 Service Worker 控制台逐条翻，且没有任何「把现状一次性导出来」的入口。
//   脱敏是硬要求：本快照会被用户直接复制进公开 issue，因此
//     · 不含出口 IP（用户真实 IP）—— 只保留「是否拿到出口 / 是否变化」这类结构性信息；
//     · 不含代理地址与端口（用户内网拓扑）—— 只保留状态结论里已有的模式名。
function summarizeTest(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    ok: t.ok === true,
    error: typeof t.error === 'string' ? t.error : null,
    hasExit: !!(t.exit && t.exit.ok),
    hasDirectExit: !!(t.direct && t.direct.ok),
    ipChanged: t.ipChanged === true,
    afterClearMode: t.afterClearMode || null,
    activeMode: t.activeMode || null,
    compareSkipped: t.compareSkipped || null,
    restoreFailed: t.restoreFailed === true,
    overriddenDuringRestore: t.overriddenDuringRestore || null,
    overriddenDuringTest: t.overriddenDuringTest || null,
    stateSuperseded: t.stateSuperseded === true
  };
}

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
      // 【R8-04】读取失败必须如实上报，不得把「读不到」伪装成「没有状态」。
      //   前台 renderStatus 对 !state 的兜底是「未启用代理（直连）」：在此之前，
      //   一次 session 读取失败就会让界面宣称用户没开代理 —— 而 chrome.proxy 里
      //   我方的代理其实还在生效、session 里那份 lastState 也仍然是 applied。
      //   这与 R7-01（配置读取失败）、R8-01（设置读取失败）是同一条语义：
      //   读不到 ≠ 用户关掉了代理。readFailed 是给前台区分「没有」用的。
      var readErr = chrome.runtime.lastError;
      if (readErr) {
        sendResponse({ state: null, test: null, readFailed: true });
        return;
      }
      sendResponse({
        state: (items && items.lastState) || null,
        test: (items && items.lastTest) || null
      });
    });
    return true;
  }

  if (request.action === "reapply") {
    // 【A4 → v2.13.0 更正】原注释写「本分支在产品代码中【没有】任何调用方（popup 从不发送）」，
    //   自 v2.12.0 起已被推翻：popup 有两处真实调用方 ——
    //     · confirmApplied()：内容不变的保存（Chromium 对「写入值与库中原值完全相同」的
    //       storage.set 既不派发 onChanged、也不写盘，故此时必须显式索取一次下发）；
    //     · resetDefaults()：恢复默认后显式索取一次下发。
    //   保留原两点用途，并补充第 3 点：
    //   1) tests/ownership.test.js 与 tests/concurrency.test.js 用它验证消息来源校验
    //      （sender.id 白名单）与「强制重下发」的消息契约，删除会破坏测试；
    //   2) 诊断入口：在扩展的 Service Worker 控制台执行
    //      chrome.runtime.sendMessage({ action: "reapply" })
    //      可强制按最新设置重新下发一次代理；
    //   3) 产品路径：上述两处前台调用方据本分支的返回值陈述「是否真的生效」
    //      （见 popup.js 的 reportApplyOutcome）。
    applyProxySerial().then(sendResponse);
    return true;
  }

  if (request.action === "getDiagnostics") {
    // 【L-08·审计修复】一次性诊断快照，供 popup 的「导出诊断」按钮呈现。
    //   读取失败同样如实上报（ok:false + error），绝不把「读不到」伪装成「没有」——
    //   与 getStatus 的 readFailed 契约同一条原则。
    chrome.storage.session.get(["lastState", "lastTest", PENDING_RESTORE_KEY], function (items) {
      var dErr = chrome.runtime.lastError;
      sendResponse({
        ok: !dErr,
        error: dErr ? dErr.message : null,
        version: chrome.runtime.getManifest().version,
        lastState: dErr ? null : (items && items.lastState) || null,
        lastTest: dErr ? null : summarizeTest(items && items.lastTest),
        pendingRestore: dErr ? null : (items && items[PENDING_RESTORE_KEY]) || null,
        suspendDepth: suspendDepth,
        suspendDirty: suspendDirty,
        at: Date.now()
      });
    });
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

// Service Worker 冷启动即对齐一次。
// 【R9-01】先做一轮幂等的存量污染自愈：污染组合可能在本次会话之前就已存在
//   （另一台设备同步来的默认列表，或升级时自愈被瞬时读失败跳过），
//   而 onInstalled 的一次性自愈覆盖不到这些路径。
//   自愈成功后会自己触发一次下发；这里仍然调用 applyProxySerial()，
//   因为"没有污染"才是绝大多数情况，不能依赖自愈来驱动常规冷启动下发。
//   注意顺序：自愈是异步的，本次 applyProxySerial 可能仍用旧（被遮蔽）的
//   sync 值下发一次，但自愈完成后的 applyProxySerial 会立刻纠正为 local 真值。
reconcileLegacyBypass();
// 【S2】冷启动先对账「待恢复意图」：若上一次对比窗口的恢复被 SW 回收打断，
//   这里会如实上报并立即按最新 settings 重新下发；无标记时行为与原先完全一致
//   （该函数内部所有路径最终都会调用 applyProxySerial，本处不再重复调用）。
reconcilePendingRestore();
