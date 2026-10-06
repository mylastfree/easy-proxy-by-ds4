// popup.js —— 只负责渲染、校验与读写存储；下发决策在 background  [v2.15.0]
// 【L-06·审计修复】补上全局严格模式（理由同 background.js：classic script 默认非严格）。
'use strict';
var S = window.EasyProxy;

// 【M-1】用户可直接编辑的表单字段。storage 变化触发的表单重绘，
//   绝不允许覆盖这些字段中【当前持有焦点】的那一个 —— 否则后台自愈
//   （写 sync.bypassList=''）或多设备同步会让用户正在输入的内容凭空消失。
var EDITABLE_IDS = ["enableProxy", "proxyType", "proxyHost", "proxyPort", "bypassList"];

function activeEditableId() {
  var ae = document.activeElement;
  if (!ae || !ae.id) return null;
  return EDITABLE_IDS.indexOf(ae.id) >= 0 ? ae.id : null;
}

var el = {
  enableProxy: document.getElementById("enableProxy"),
  proxyType: document.getElementById("proxyType"),
  proxyHost: document.getElementById("proxyHost"),
  proxyPort: document.getElementById("proxyPort"),
  bypassList: document.getElementById("bypassList"),
  saveButton: document.getElementById("saveButton"),
  resetButton: document.getElementById("resetButton"),
  statusBar: document.getElementById("statusBar"),
  hint: document.getElementById("hint"),
  testButton: document.getElementById("testButton"),
  testDirectButton: document.getElementById("testDirectButton"),
  diagButton: document.getElementById("diagButton"),
  testResult: document.getElementById("testResult")
};

var STATUS_TEXT = {
  applied: ["代理已生效", "ok"],
  direct: ["未启用代理（直连）", "muted"],
  // 【第 4 条·审计修复】禁用路径在 clear() 之后回读到下层仍有代理
  //   （system / pac_script / auto_detect）：此时【不是】直连，
  //   不能沿用上面那句「未启用代理（直连）」。background 会在该情形下带 systemProxy 字段。
  direct_system_proxy: ["未启用本扩展代理：沿用浏览器/系统自身的代理设置", "muted"],
  // 【M-1·审计修复】禁用态的第三档：clear() 成功、但回读实际模式失败。
  //   与 direct_system_proxy 同属「不得宣称直连」的下位分支，成因不同：
  //   那一档是回读成功但非 direct，本档是回读本身失败（读不到 ≠ 是直连，与 R7-01 同源）。
  //   背景：background 早已在 directState 上写 readFailed，但前台只消费 systemProxy，
  //   于是本档落到「未启用代理（直连）」这一句上 —— 与紧随其后的 message
  //   「无法确证当前实际生效的模式」在同一条状态条里直接矛盾。
  direct_unverified: ["未启用本扩展代理：无法确证当前实际生效的模式", "warn"],
  saved_not_applied: ["已保存，但尚未生效", "warn"],
  overridden: ["设置被企业策略或其它扩展接管", "warn"],
  // suspended 是「连接测试进行中，暂时跳过下发」的临时状态，
  // 补上文案以免落入兜底的「状态未知」而让用户困惑。
  suspended: ["连接测试进行中，暂缓下发（结束后自动恢复）", "warn"],
  error: ["代理异常，流量可能已回退直连", "error"],
  // 【R7-01-F】error 档的第二种来源：读取配置失败。此时我们什么都没做，
  //   代理未被改动，因此绝不能沿用上面那条「可能已回退直连」的断言。
  error_read_failed: ["无法读取配置，本次未改动代理", "warn"],
  // 【R9-02】控制权无法确证时同样是"本次未改动代理"；
  //   不得沿用"代理异常，流量可能已回退直连"——没有写入任何东西时那句话与事实相反。
  error_control_unknown: ["无法确证代理控制权，本次未改动代理", "warn"],
  // 【L-05·审计修复】error 档的第三种来源：上一次对比窗口的「清除 → 恢复」被 SW 回收
  //   打断。它与「代理故障」语义相反 —— 扩展没有坏，而且已经按最新设置重新下发；
  //   此前本档没有文案，落到泛化的 error 档「代理异常，流量可能已回退直连」，
  //   把一次自动恢复指向了错误的排障方向（与 R7-01-F / R9-02 同族）。
  //   取值集合以 settings.js 的 REASON 为唯一事实来源，由 manifest.test.js 双向核对。
  error_restore_interrupted: ["对比测试的恢复被中断：已按当前设置重新下发代理", "warn"],
  // 【R8-04】状态本身没读到（session.get 失败）。与 direct 的区别是本质性的：
  //   这一档下我们【根本不知道】代理现在是什么状态，必须如实说不知道；
  //   用 muted 档的直连文案会把「读不到」谎报成「用户没开代理」。
  //   也不并入 error 档：本次什么都没做，代理没有被改动，凭什么说它异常。
  //   status_read_failed: ["状态未知：无法读取当前状态，代理可能仍在生效", "warn"]
  status_read_failed: ["状态未知：无法读取当前状态，代理可能仍在生效", "warn"],
  // 【G2】消息通道层面失败（send reject / 后台无响应）：与 status_read_failed 同为
  //   「未知」档，但成因不同 —— 不是「读不到 session」，而是「根本没能与后台通信」
  //   （SW 崩溃 / 扩展重载 / 消息通道异常）。同样必须如实说不知道，
  //   绝不能静默停留在初始文案「读取状态中…」，把未知伪装成一切正常。
  channel_failed: ["状态未知：无法与后台通信，代理可能仍在生效（可尝试关闭后重新打开弹窗）", "warn"]
};

function setStorage(area, obj) {
  return new Promise(function (resolve, reject) {
    chrome.storage[area].set(obj, function () {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

// 【第 2 条·审计修复】带「阶段」标记的错误。
//   save() 必须区分两种含义完全不同的失败，不能一律报「保存失败」：
//     · 设置根本没写进 sync（校验拒绝 / sync 写入失败）；
//     · 设置【已经】写进 sync，只有本机那份旧绕过列表没清干净。
//   后者若被笼统报成「保存失败」，用户会以为什么都没保存，而生效值其实已经变了 ——
//   与本项目反复修复的「状态≠事实」缺陷族同型。
function phaseError(phase, message) {
  var e = new Error(message);
  e.phase = phase;
  return e;
}

// 【第 1 条·审计修复】「上次从存储读到的内容」的签名，供 save() 判断本次保存
//   是否会真正改变存储 —— 见 save() 末尾 confirmApplied 的说明。
var lastLoadedSig = null;

function settingsSignature(s) {
  if (!s) return null;
  return [s.enableProxy ? 1 : 0, s.proxyType, s.proxyHost, s.proxyPort,
    s.bypassList].join("\u0000");
}

// 【G2】通道错误必须暴露：此前 `void chrome.runtime.lastError` 把「根本没能与后台
//   通信」吞成 resolve(null)，调用方无法区分「后台回答了：没有状态」与「后台根本
//   没回答」。现在 lastError 存在时 reject，由调用方各自渲染失败档：
//   runTest 走 R7-08 的「测试失败」文案，refreshStatus 走 G2 的「无法与后台通信」状态条。
function send(message) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(message, function (resp) {
      var err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message || "消息通道异常")); return; }
      resolve(resp || null);
    });
  });
}

function renderTypeOptions() {
  el.proxyType.innerHTML = "";
  S.PROXY_TYPES.forEach(function (t) {
    var o = document.createElement("option");
    o.value = t.value;
    o.textContent = t.label;
    el.proxyType.appendChild(o);
  });
}

function readForm() {
  return S.normalizeSettings({
    enableProxy: el.enableProxy.checked,
    proxyType: el.proxyType.value,
    proxyHost: el.proxyHost.value,
    proxyPort: el.proxyPort.value,
    bypassList: el.bypassList.value
  });
}

function renderForm(settings) {
  // 【M-1】焦点保护：焦点所在的字段保持用户正在输入的值，其余字段照常刷新。
  //   失焦后的存储变化仍然全量刷新（activeEditableId 返回 null），
  //   「界面与存储一致」的既有语义不变。
  var focusId = activeEditableId();
  if (focusId !== "enableProxy") el.enableProxy.checked = settings.enableProxy;
  if (focusId !== "proxyType") el.proxyType.value = settings.proxyType;
  if (focusId !== "proxyHost") el.proxyHost.value = settings.proxyHost;
  if (focusId !== "proxyPort") el.proxyPort.value = settings.proxyPort;
  if (focusId !== "bypassList") el.bypassList.value = settings.bypassList;
}

function showHint(message, kind) {
  el.hint.textContent = message || "";
  el.hint.className = "hint " + (kind || "");
}

// 【R8-04】第二个参数 readFailed 来自后台 getStatus 的失败标记，
//   它必须与「真的没有状态」分开：两者在旧代码里都是 state 为空，
//   而旧代码那句兜底会把两者一起说成「未启用代理（直连）」。
function renderStatus(state, readFailed) {
  if (!state) state = readFailed ? { status: "status_read_failed" } : { status: "direct" };
  // 【R7-01-F】读取失败不是「代理坏了」：单独取文案，避免状态条自相矛盾
  //   （前半句说代理可能已回退直连、后半句说本次未改动代理）。
  var key = state.status;
  // 【第 4 条·审计修复】禁用态带 systemProxy 时，实际生效的是浏览器/系统自身的代理，
  //   不是直连 —— 取单独文案，避免把「沿用系统代理」谎报成「直连」。
  // 【M-1·审计修复】并补上「回读失败」这一档：background 早已写 readFailed，
  //   前台此前只消费 systemProxy，导致本档复用「未启用代理（直连）」的文案，
  //   与同一条状态条里 message 的「无法确证」直接矛盾（读不到 ≠ 是直连）。
  if (key === "direct" && state.systemProxy) key = "direct_system_proxy";
  else if (key === "direct" && state.readFailed === true) key = "direct_unverified";
  if (state.status === "error" && state.reason === "read_failed") key = "error_read_failed";
  else if (state.status === "error" && state.reason === "control_unknown") key = "error_control_unknown";
  else if (state.status === "error" && state.reason === "restore_interrupted") key = "error_restore_interrupted";
  var row = STATUS_TEXT[key] || ["状态未知", "muted"];
  var text = row[0];
  if (state.errors && state.errors.length) text += "：" + state.errors.join("；");
  else if (state.message) text += "：" + state.message;
  // 对比测试期间保存的配置，若因外部接管而尚未下发，必须让用户看得见（R3-01）。
  // 此前这种情况被静默丢弃：存储里是新值、界面无任何提示、浏览器仍在用旧配置。
  if (state.pendingResubmit) text += "（有配置变更待下发）";
  // 【L-7·审计修复】状态条此前【只用颜色】区分严重度（class="ok|warn|error|muted"）：
  //   色觉障碍、灰度打印、把截图转黑白，都无法分辨「已生效 / 提示 / 故障」。
  //   而图标本身早已用字形区分（绿=代 / 红=直，见 README 图例）—— 同一屏的两个
  //   信息面一个双编码、一个单编码。这里补前置符号，与图标同一策略。
  //   符号表刻意声明在函数【内部】：ownership.test.js 会按源码标记切片、
  //   把 renderStatus 单独注入一个空上下文执行，引用切片外的常量会直接 ReferenceError。
  var mark = { ok: "✓", warn: "⚠", error: "✗", muted: "·" }[row[1]] || "";
  el.statusBar.textContent = (mark ? mark + " " : "") + text;
  el.statusBar.className = "status " + row[1];
}

/* ==================== 连接测试渲染 ==================== */

function fmtExit(exit) {
  if (!exit) return "（未测试）";
  if (!exit.ok) return "失败：" + (exit.error || "未知错误");
  var parts = [];
  if (exit.ip) parts.push(exit.ip);
  var loc = [exit.city, exit.region, exit.country].filter(Boolean).join(" ");
  if (loc) parts.push(loc);
  if (exit.org) parts.push(exit.org);
  return parts.join(" · ") || "（无数据）";
}

function renderTest(result) {
  if (!result) {
    // 【A5】内联色值改为 popup.html 中定义的样式类，消除样式双轨。
    el.testResult.innerHTML =
      '<span class="t-muted">尚未测试。点击「测试当前出口」查看流量实际从哪里出去。</span>';
    return;
  }
  // 【M-2 抽取】原 renderTest 140 行，把「判定」与「拼 DOM」混在一起。
  //   现在只做编排：判定交给纯函数，内容交给拼装函数，本函数只负责写 innerHTML。
  var c = classifyTestResult(result);
  el.testResult.innerHTML = buildTestHeader(result) +
    '<div class="verdict ' + c.kind + '">' + escapeHtml(c.verdict) + "</div>";
}

// 【M-2 抽取】结果区头部（当前出口 / 直连出口 / 代理配置 / 生效模式）。
//   只拼 HTML 片段，不做任何判定 —— 与 classifyTestResult 的职责互不重叠。
function buildTestHeader(result) {
  var html = "";
  html += "<div><b>当前出口</b>" + escapeHtml(fmtExit(result.exit)) + "</div>";

  if (result.direct) {
    // 【第 4 条·审计修复】对比窗口的「直连」取样发生在 clearProxyScope() 之后，
    //   而 clear() 只是让下层设置重新生效：若下层是系统代理 / PAC / 自动检测，
    //   这一行拿到的其实是那条链路的出口，不是直连。后台已把实际模式带回
    //   （result.afterClearMode），这里据此如实改写标题，不再冒称「直连出口」——
    //   否则一个被污染的基准会让「代理是否生效」的结论整体失真。
    var directLabel = "直连出口";
    if (result.afterClearMode && result.afterClearMode !== "direct") {
      directLabel = "清除后出口（实际模式 " + result.afterClearMode + "，并非直连）";
    }
    html += "<div><b>" + escapeHtml(directLabel) + "</b>" +
      escapeHtml(fmtExit(result.direct)) + "</div>";
  }

  if (result.settings) {
    var s = result.settings;
    var proxyText = s.enableProxy
      ? (s.proxyType + " " + s.proxyHost + ":" + s.proxyPort)
      : "未启用";
    html += "<div><b>代理配置</b>" + escapeHtml(proxyText) + "</div>";
    // 【A-6·审计修复】第三方出口知情提示前移到 UI：此前「流量经第三方代理服务器
    //   出去、其运营方可见目标地址」这一事实只存在于 README/SECURITY 文档，
    //   用户在扩展界面得不到任何提示。出口测试正是感知这一事实的最佳时机 ——
    //   此刻用户看到的就是代理服务器的出口，把知情提示放在同一屏最合适。
    if (s.enableProxy) {
      html += '<div class="t-muted">提示：启用第三方代理后，你的流量会经由该代理服务器出去' +
        "（其运营方可以看到你访问的目标地址）；「当前出口」显示的就是代理服务器的出口。</div>";
    }
  }

  if (result.activeMode) {
    html += "<div><b>生效模式</b>" + escapeHtml(result.activeMode) + "</div>";
  }

  return html;
}

// 【M-2/L-5 抽取】「结果 → 判定」链，纯函数：输入 result，输出 { verdict, kind }。
//   抽出的两个理由都不是为了好看：
//     · M-2：它原本是 renderTest 里的 90 行分支链；
//     · L-5：它是【用户唯一看到的结论面】，历次修复（R6-01 / 第 4 条 / 第 6 条 /
//       R7-02 / G4）全部落在这里，却因为藏在 innerHTML 组装中间而只被间接覆盖 ——
//       覆盖率报告里 popup.js L255-307 与 L319-323 整段为空。
//   现在每个分支都能被直接断言（见 tests/popup.test.js 的 L-5 段）。
//   本次只做搬迁：不合并分支、不改一句文案、不动判定顺序。
function classifyTestResult(result) {
  var verdict = "";
  var kind = "warn";

  // 后台返回的 {ok:false} 有两类含义完全不同的情况，必须分开渲染：
  //   1) 带 skipped 的并发互斥拒绝 —— 功能本身正常，只是"已有测试在跑"，
  //      此前被渲染成"出口检测失败"，把用户引去排查代理（R3-03）；
  //   2) 真正的错误 —— 需要如实显示原因。
  if (result.ok === false && result.skipped) {
    verdict = "ℹ " + (result.message || "已有测试在进行中，请稍候再试。");
    kind = "warn";
  } else if (result.ok === false) {
    verdict = "✗ " + (result.message || "出口检测未能完成，请稍后重试。");
    kind = "error";
  } else if (result.restoreFailed) {
    verdict = "⚠ 对比后恢复原代理配置失败，请重新保存一次设置以恢复。";
    kind = "error";
  } else if (result.overriddenDuringRestore) {
    // 【第 6 条·审计修复】对比窗口收尾（第三阶段）被外部接管时，后台会返回
    //   overriddenDuringRestore（background.js 的「两个都可能是原因」那段），
    //   但此前前台【没有任何分支消费它】—— 该标识符在 popup.js 中零命中，
    //   渲染链继续下落，最终命中下面 result.ipChanged 的成功文案：
    //   同一屏上状态条说「设置被企业策略或其它扩展接管」，结果区却说
    //   「✓ 代理确实生效」，用户无法据此确认当前链路（与 R6-01 同族）。
    //   处置：与其他恢复异常一起放在【IP 比较之前】，并明确区分
    //   「取样时的出口」与「收尾后的实际状态」—— 出口比较只对取样那一刻成立。
    verdict = "⚠ 对比期间出口确实与直连不同（取样那一刻），但收尾写回时发现代理设置" +
      "被外部接管（" + result.overriddenDuringRestore + "），已放弃写回以免夺权。" +
      "不能据此认为本扩展的代理目前仍生效；请检查企业策略或其它扩展。";
    kind = "warn";
  } else if (result.overriddenDuringTest) {
    verdict = "⚠ 对比期间代理设置被外部接管（" + result.overriddenDuringTest + "），已放弃写回以免夺权，请检查企业策略或其它扩展。";
    kind = "warn";
  } else if (result.directClearFailed) {
    verdict = "⚠ 对比时清除代理失败，本次「直连出口」不可信：" + result.directClearFailed;
    kind = "error";
  } else if (result.compareSkipped === "unknown_control") {
    verdict = "ℹ 无法确认当前代理控制权，已跳过直连对比，未清除现有代理。";
    kind = "warn";
  } else if (result.compareSkipped === "control_changed_before_clear") {
    verdict = "ℹ 清除前代理控制权已变更，已放弃对比，未清除当前代理。";
    kind = "warn";
  } else if (result.compareSkipped === "not_controlled_by_this_extension") {
    verdict = "ℹ 当前代理设置不由本扩展控制（被策略或其它扩展接管），已跳过直连对比以免影响它。";
    kind = "warn";
  } else if (result.compareSkipped === "invalid_settings") {
    // R7-02：配置无效时后台【根本没有进入对比窗口】，因此现有代理没有被清掉也不存在恢复问题。
    //   文案必须说清"未改动现有代理"，否则用户会以为代理被这次测试搞坏了。
    verdict = "ℹ 当前保存的代理配置不完整或无效，已跳过直连对比，未改动现有代理；请先修正设置。";
    if (result.compareSkippedReason) verdict += "（" + result.compareSkippedReason + "）";
    kind = "warn";
  } else if (result.compareSkipped === "not_fixed_servers") {
    verdict = "ℹ 当前实际生效的代理不是本扩展下发的配置，已跳过直连对比，未改动现有代理。";
    if (result.compareSkippedReason) verdict += "（" + result.compareSkippedReason + "）";
    kind = "warn";
  } else if (result.compareSkipped === "unknown_active_mode") {
    verdict = "ℹ 无法确认当前实际生效的代理配置，已跳过直连对比，未改动现有代理。";
    kind = "warn";
  } else if (result.compareSkipped === "sampling_unstable") {
    // 【G4】取样期间配置发生了变化：直连评价基准不可信，必须如实说明并请用户重测，
    //   绝不能带着不可信的基准给出「代理未生效」之类的结论。
    verdict = "ℹ 取样期间代理配置发生了变化，本次「直连出口」不可信，已放弃对比，未改动现有代理；请重测。";
    if (result.compareSkippedReason) verdict += "（" + result.compareSkippedReason + "）";
    kind = "warn";
  } else if (!result.exit || !result.exit.ok) {
    verdict = "✗ 出口检测失败。若已启用代理，说明流量可能无法出去——请检查代理地址与端口，或代理软件是否在运行。";
    kind = "error";
  } else if (result.direct && result.direct.ok) {
    // R6-01（防御性冗余）：恢复失败时出口比较的结论没有意义，不得落到成功文案。
    if (result.ipChanged && !result.restoreFailed) {
      verdict = "✓ 代理确实生效：当前出口与直连出口不同。";
      kind = "ok";
    } else if (result.stateSuperseded) {
      verdict = "ℹ 对比期间控制权已变更，保留接管结论，不用出口比较覆盖它。";
      kind = "warn";
    } else if (result.activeMode === "fixed_servers" && !result.restoreFailed && !result.directClearFailed) {
      // R6-01：这句在宣称「代理配置仍在」，而 activeMode 是【窗口开始前】的快照。
      //   若收尾恢复失败，实际配置可能已被清成直连，此句与事实相反。
      //   因此必须以"恢复确实成功"为前提，不能只凭窗口前的快照。
      //   同时排除 directClearFailed（直连取样本身失败时，"并未回退直连"同样无依据）。
      verdict = "ℹ 出口 IP 与直连相同，但代理配置仍在，并未回退直连。";
      kind = "warn";
    } else {
      verdict = "✗ 出口 IP 与直连相同——代理很可能未生效，或代理本身不改变出口。";
      kind = "error";
    }
  } else if (!result.settings || !result.settings.enableProxy) {
    verdict = "ℹ 当前未启用代理，此结果即为你的直连出口。";
    kind = "warn";
  } else {
    verdict = "ℹ 当前出口已获取。点击「对比直连出口」可确认代理是否真的改变了出口。";
    kind = "warn";
  }

  return { verdict: verdict, kind: kind };
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // 【A-3·审计修复】补转义单引号：当前所有插值都在文本节点上下文（不可利用），
    //   但 escapeHtml 是公共转义出口，一旦被复用到单引号属性插值（如 title='...'）
    //   缺这条就会成为注入点。纵深防御按最坏上下文假设补齐。
    .replace(/'/g, "&#39;");
}

// 【R7-08】测试请求失败的统一出口。
//   消息通道自身出错时（send 同步抛错，或抛错使 send 返回 rejected Promise），
//   必须与「后台返回 {ok:false}」走同一档失败文案，如实带出原因，不得静默吞掉。
function renderTestError(err) {
  var reason = (err && err.message) ? err.message : err;
  if (!reason) reason = "消息通道异常";
  // 【A5】内联色值改为样式类（与 renderTest 的 muted 同一处理）。
  el.testResult.innerHTML =
    '<span class="t-error">测试失败：' + escapeHtml(reason) + "</span>";
}

async function runTest(compare) {
  el.testButton.disabled = true;
  el.testDirectButton.disabled = true;
  el.testResult.innerHTML =
    '<span class="t-muted">测试中…' + (compare ? "（对比期间会短暂切换为直连，随后自动恢复）" : "") + "</span>";

  try {
    var resp = await send({ action: "testConnection", compare: compare });

    if (!resp || !resp.ok) {
      el.testResult.innerHTML =
        '<span class="t-error">测试失败：' + escapeHtml((resp && resp.error) || "无响应") + "</span>";
      return;
    }
    renderTest(resp.result);
  } catch (err) {
    // 【R7-08】此前 await 一旦抛出，下面那两行复位永不执行 ——
    //   两个测试按钮永久禁用，用户只能关掉并重开 popup。
    renderTestError(err);
  } finally {
    // 复位必须放在 finally：正常返回、{ok:false}、抛错三条路径都要回到可点状态
    el.testButton.disabled = false;
    el.testDirectButton.disabled = false;
  }
}

/* ==================== 诊断导出（L-08） ==================== */

// 【L-08·审计修复】把后台的状态快照渲染成可直接复制的纯文本。
//   两处刻意的实现选择：
//     · 用 textContent 而非 innerHTML —— 快照内容来自存储，天然不可注入；
//     · 失败同样如实呈现（后台无响应 / 通道异常各给一档），不得静默停在「正在收集…」。
function exportDiagnostics() {
  el.diagButton.disabled = true;
  el.testResult.textContent = "正在收集诊断信息…";
  var done = function () { el.diagButton.disabled = false; };
  // 【必须 return】调用点写的是 `exportDiagnostics().catch(renderTestError)`（与 runTest 同一
  //   契约）。若这里不把 Promise 交出去，`undefined.catch` 会在点击时同步抛 TypeError ——
  //   按钮停在 disabled、结果区停在「正在收集…」，正是 R7-08 要消灭的「异常路径卡死」形态。
  //   （本缺陷由 L-08 新增的用例在首跑时抓出。）
  return send({ action: "getDiagnostics" }).then(function (resp) {
    if (!resp) {
      el.testResult.textContent = "诊断失败：无法与后台通信（请关闭后重新打开弹窗再试）。";
      return;
    }
    el.testResult.textContent = "诊断信息（已脱敏：不含你的出口 IP 与代理地址；可直接复制进 issue）：\n" +
      JSON.stringify(resp, null, 2);
  }, function (err) {
    el.testResult.textContent = "诊断失败（消息通道异常）：" + ((err && err.message) || err);
  }).then(done, done);
}

/* ==================== 加载与保存 ==================== */

// 【R8-01】读取失败 = 表单内容不可信，必须同时做到两件事：
//   ① 不误导显示：绝不把 normalizeSettings 的默认值当作「用户的真实配置」渲染
//      （开关置为 indeterminate 并禁用整个表单，用户不会把「读不到」读成「我关掉了代理」）；
//   ② 不放行保存：save() 在 loadFailed 时一律拒绝写入 —— 只改文案而不阻止写入，
//      缺陷依然存在：用户点一次保存就会把 enableProxy:false 写回 sync，
//      后台随即 clearProxyScope("regular")，浏览器里仍在生效的代理被真清除。
var loadFailed = false;
// 【R9-01】本次表单内容是否来自「用户规则被内置默认列表遮蔽」的现场。
//   在那样的现场里，表单显示的默认值并不属于用户；用户哪怕只是照着它改一个字，
//   保存值也不再等于默认列表，clearLocalBypassIfAny 的原判据就会失效并把 local
//   唯一副本写空。因此这个标记必须在【渲染表单的那一刻】记录下来，
//   供保存路径判断"本次保存值能否用来证明 local 是过期副本"。
var loadedShadowed = false;
// 【V-01】遮蔽现场下「改字后保存」的行内二次确认状态。
//   不用 window.confirm()：popup 一旦失焦就会被销毁，原生对话框的返回值
//   永远回不来，会把保存变成「点了没反应」——用一个静默失败换另一个不可接受。
var pendingShadowConfirm = false;
// 【G6】「恢复默认」的行内二次确认状态。与 pendingShadowConfirm 同一条反模式防线：
//   window.confirm 在 popup 失焦时永不返回，会把高危操作变成「点了没反应」。
var pendingResetConfirm = false;
var READ_FAIL_HINT = "读取设置失败，当前显示可能不是你的真实设置；为避免覆盖你的设置，已禁止保存。请关闭并重新打开弹窗（或等存储恢复后自动刷新）。";

function setFormDisabled(disabled) {
  el.enableProxy.disabled = disabled;
  el.proxyType.disabled = disabled;
  el.proxyHost.disabled = disabled;
  el.proxyPort.disabled = disabled;
  el.bypassList.disabled = disabled;
  el.saveButton.disabled = disabled;
}

// 确认态复位：任何一次表单重载或保存结束都必须复位，否则确认态会跨操作残留
//   （变成「隔了很久之后一次普通点击就种下去了」）。
function resetShadowConfirm() {
  pendingShadowConfirm = false;
  el.saveButton.textContent = "保存设置";
}

// 【G6】「恢复默认」确认态复位：表单重载或操作结束时与 saveButton 同步复位，
//   避免确认态跨操作残留（隔了很久之后一次普通点击直接执行清空）。
function resetResetConfirm() {
  pendingResetConfirm = false;
  el.resetButton.textContent = "恢复默认";
}

// 读取失败时统一清空 + 禁用全部表单字段（enableProxy / proxyType / proxyHost /
//   proxyPort / bypassList）。
//   清空是必须的 —— 存储里可能是用户上一次的真实配置（sync 与 local 两次读取之间失败时），
//   留着它就等于让用户在一份【不完整】的显示上继续编辑，那正是本缺陷的误导来源。

function clearForm() {
  el.enableProxy.checked = false;
  el.proxyType.value = "";
  el.proxyHost.value = "";
  el.proxyPort.value = "";
  el.bypassList.value = "";
}

function markLoadFailed() {
  loadFailed = true;
  // 刻意【不调用 renderForm】：绝不把 normalizeSettings 的默认值当作真实配置渲染。
  //   enableProxy 置为 indeterminate —— 视觉上是「不确定」，而不是「未勾选」。
  clearForm();
  el.enableProxy.indeterminate = true;
  setFormDisabled(true);
  showHint(READ_FAIL_HINT, "error");
}

function markLoadOk() {
  var wasFailed = loadFailed;
  loadFailed = false;
  el.enableProxy.indeterminate = false;
  setFormDisabled(false);
  // 只在「从失败态恢复」时清掉那条提示：正常刷新（onChanged 触发的 load）
  //   不得覆盖「设置已保存」等既有提示。
  if (wasFailed) showHint("", "muted");
}

function load() {
  chrome.storage.sync.get(Object.keys(S.DEFAULTS), function (items) {
    // 【R8-01】此前这里只写「void chrome.runtime.lastError;」：读取失败被静默吞掉，
    //   items 为空 → normalizeSettings 给出默认值（enableProxy:false）→ 表单显示「未勾选」，
    //   用户点一次保存就把 enableProxy:false 写回 sync，后台随即清除仍在生效的代理。
    //   读不到 ≠ 用户关掉了代理，必须显式分支。
    var syncErr = chrome.runtime.lastError;
    if (syncErr || !items) { markLoadFailed(); return; }

    // 先读 local，再用与 background 完全相同的规则决定取值。
    // 此前是「先 normalizeSettings 再判断是否为空」，而 normalizeSettings
    // 会把缺失的 bypassList 填成默认值，导致回退 local 的分支永不执行，
    // 界面显示与实际下发可能取到不同的列表。
    chrome.storage.local.get(["bypassList"], function (local) {
      // 【R8-01】local 失败时 local 为 undefined：若继续走 resolveBypassList，
      //   长列表（降级存于 local）会被显示成默认值 —— 用户点保存就把默认列表写回，
      //   并顺手清空 local 里的长列表（与 R7-03 同型）。同样必须显式失败。
      var localErr = chrome.runtime.lastError;
      if (localErr || !local) { markLoadFailed(); return; }

      var settings = S.normalizeSettings(items);
      settings.bypassList = S.resolveBypassList(
        items && items.bypassList,
        local && local.bypassList
      );
      // 【第 1 条】记下「这次从存储读到的内容」，供 save() 判断本次保存是否会改变存储。
      lastLoadedSig = settingsSignature(settings);
      markLoadOk();
      renderForm(settings);

      // 【R9-01】把"历史遗留的绕过列表冲突"显式告诉用户，而不是让默认值静默
      //   遮蔽他真正的规则。后台的连续自愈会很快把 sync 恢复为空串占位、让 local
      //   重新生效；在自愈完成之前，用户至少能看到发生了什么，不会把"看到默认值"
      //   误当成"我的规则丢了"而重新手打一遍。
      // 【S1/G3】判据收敛到 settings.js 的唯一实现 isLegacyShadowPair：
      //   此前这里是内联的「逐字符相等」判据，与 background.js 的 isLegacyShadowed
      //   一样识别不了「默认列表 + 编辑」形态（升级前 V-01 缺陷留下的存量污染：
      //   sync = 内置默认列表整段 + 用户追加/编辑的内容）。该形态下用户点一次保存
      //   就会经 clearLocalBypassIfAny 把 local 唯一副本静默清空（不可逆，且全程
      //   无 lastError）。isLegacyShadowPair 同时覆盖「逐字符相等」与「默认列表 +
      //   编辑」两种形态，并有 settings.test.js V-01-a…k 共 11 条断言护住语义。
      //   后台自愈判据刻意保持保守（逐字符相等）：它要执行写操作，放宽会误伤
      //   用户自写列表 —— 保守侧不放宽，前台确认门放宽，这是 settings.js 注释里
      //   「后台保守、前台可放宽」的既有设计意图。
      var shadowed = S.isLegacyShadowPair(
        items && items.bypassList,
        local && local.bypassList
      );
      loadedShadowed = shadowed;
      // 【V-01】表单重载即复位确认态与按钮文案：任何一次存储变化（含保存成功后
      //   自己触发的那次）都会走到这里，确认态不会跨操作残留。
      //   【G6】「恢复默认」的行内确认态同理一并复位。
      resetShadowConfirm();
      resetResetConfirm();
      if (shadowed) {
        console.warn("检测到历史遗留的绕过列表污染现场：本机 local 保存着用户规则，但 sync 是内置默认列表（或以其为前缀的编辑形态）。已标记本次表单，保存时不会据此删除 local。");
        // 【W-01】把两件事分开说清：「保存不会丢数据」与「保存会覆盖生效值」。
        //   【S1】不再承诺「后台正在自动恢复」：对「默认列表 + 编辑」形态，后台
        //   自愈判据（保守、逐字符相等）不会触发，提示必须对两种形态都成立。
        showHint("检测到历史遗留的绕过列表：本机保存着你自己的规则，但当前生效的是内置默认列表（或以其为前缀的内容）。" +
          "此时可以直接保存（不会删掉本机那份规则），但保存的内容会成为当前生效值；" +
          "若想恢复自己的规则，请先核对本机那份内容，再把它重新保存一次。", "warn");
      }
    });
  });
}

// 【G2】通道失败的统一渲染：状态条必须离开初始文案，如实进入「未知」档。
//   此前 refreshStatus 在 !resp 时直接 return、通道错误被 send 吞掉，
//   SW 崩溃 / 扩展重载后状态条会永久停留在「读取状态中…」，用户看不到任何异常。
function renderChannelFailed() {
  el.statusBar.textContent = STATUS_TEXT.channel_failed[0];
  el.statusBar.className = "status " + STATUS_TEXT.channel_failed[1];
}

function refreshStatus() {
  send({ action: "getStatus" }).then(function (resp) {
    // 【G2】resp 为 null（后台无响应）与通道错误同档：都是「无法与后台通信」，
    //   必须如实渲染，不得静默 return 让状态条停留在初始文案上。
    if (!resp) { renderChannelFailed(); return; }
    // 【R8-04】resp.readFailed 为真时 state 必为 null，两者一起交给 renderStatus：
    //   只传 state 会让它走了「真的没有状态」那条正确兜底，重新变成假象。
    renderStatus(resp.state, resp.readFailed === true);
    renderTest(resp.test);
  }, function () {
    // 【G2】send reject（chrome.runtime.lastError / 同步抛错）：同上，如实呈现。
    renderChannelFailed();
  });
}

// 仅当 local 中确实存有内容时才清空它；
// 否则会产生一次「空 → 空」之外的伪变化并触发多余的下发。
//
// 【R8-02】参数 savedBypassList = 【本次写入 sync 的 bypassList】。
//   当它【逐字符等于】内置默认列表时，绝对不清 local —— 这不是冗余判断，
//   删掉它会让用户的长列表永久丢失，理由如下：
//     · 更早版本的升级补缺缺陷把默认列表写进了 sync.bypassList，而用户真实的长列表
//       只剩 local 一份（超长列表降级保存时 local 是唯一副本）；
//     · 此时 resolveBypassList 的「sync 非空优先」让界面显示默认 6 条，用户看不到
//       自己的规则，什么都没改就点一次「保存」—— 表单里回写的正是这份默认列表；
//     · 「保存的是系统默认列表」与「用户主动清空/改写列表」在存储层面无法区分，
//       只有这一条判据能把两者分开，从而保住 local 里那份唯一副本
//       （另一半防线在 background.js 的 onInstalled 存量救援）。
//
//   判据必须是【逐字符】比较：长度、条数这类近似判据会把用户自写的等长列表误判成
//   默认值，使正常的「改短列表后清理 local」被静默跳过 —— 那份过期副本会在用户下次
//   清空绕过列表时经 resolveBypassList 的回退规则重新生效。
//   误判的代价也经过权衡：用户手写出与默认列表逐字相同的列表（含首行注释与空行）
//   概率可忽略；即使真的发生，代价只是 local 多留一份与 sync 相同的残留，
//   不丢数据 —— 保守方向正确。
function clearLocalBypassIfAny(savedBypassList, formWasShadowed) {
  // 【S1】纵深防御第二层：调用点已保证遮蔽现场不会进入本函数，这里再挡一次 ——
  //   即使上游判据将来发生漂移（G3 正是这么发生的），只要本次保存发生在遮蔽现场
  //   （表单内容不来自用户自己的规则），就绝不写 local。写空串会丢用户唯一副本，
  //   写表单值会覆盖唯一副本，两种动作都不允许。
  if (formWasShadowed === true) return Promise.resolve();
  // 【R8-02】保存的正是系统默认列表 → 保留 local，不发任何写入。
  // 【R9-01】本判据（逐字符等于内置默认列表 = 存量污染特征）保持不变：
  //   R8-02-C 已论证把它放宽成"一律不清"会让过期副本复活，那不可接受。
  //   本轮把防护前移：污染现场在用户动手之前就被自愈（见 background.js 的
  //   reconcileLegacyBypass 与 popup 的 loadedShadowed 守卫），而不是在这里放宽。
  if (typeof savedBypassList === "string" && savedBypassList === S.DEFAULTS.bypassList) {
    return Promise.resolve();
  }
  return new Promise(function (resolve, reject) {
    chrome.storage.local.get(["bypassList"], function (cur) {
      // 【R8-01】读取失败时 cur 为 undefined：绝不能把它当成「local 里没有列表」，
      //   更不能继续走到下面的清除分支 —— 那会把用户的长列表永久清空（与 R7-03 同型）。
      //   读不到就什么都不做，等下一次存储变化或用户重新打开弹窗。
      //   【第 2 条·审计修复】这里是【有意】的保守放过（什么都没写），
      //   与下面的「写入失败」必须区别对待 —— 前者没有产生任何副作用。
      if (chrome.runtime.lastError || !cur) { resolve(); return; }
      if (typeof cur.bypassList === "string" && cur.bypassList) {
        // 【第 2 条·审计修复】此前是 .then(resolve, resolve)：把 local 写入失败映射到
        //   与成功【同一个出口】，失败被彻底吞掉，调用方随后照样显示「设置已保存」。
        //   而取值规则是「sync 非空优先，为空则回退 local」——
        //   用户【清空】列表时 sync 是空串，此刻 local 清不掉 ⇒ 生效值仍是旧列表：
        //   「用户原本想取消直连的站点仍可绕过代理」，界面却宣称保存成功。
        //   与 R7-03/R8-01 同族（静默失败），现在如实上抛，由 save() 分辨阶段给准确文案。
        setStorage("local", { bypassList: "" }).then(resolve, function (err) {
          reject(phaseError("local_cleanup",
            "本机旧绕过列表清理失败：" + ((err && err.message) || err)));
        });
      } else {
        resolve();
      }
    });
  });
}

function save() {
  // 【M-2·审计修复】「能不能保存」的 4 道前置守卫 + 写入链所需输入，整体抽到 prepareSave()
  //   （逐字搬移）。返回值 null = 已被守卫拦截（提示已给出、未写入任何存储）。
  //   抽出的理由：save() 曾达 198 行，把「拒绝写入的判定」与「怎么写入」混在一起 ——
  //   前者是安全断言（读取失败/校验失败/遮蔽确认/遮蔽+超长），需要被独立测试与评审。
  var prep = prepareSave();
  if (!prep) return;
  var settings = prep.settings;
  var formWasShadowed = prep.formWasShadowed;
  var oversize = prep.oversize;

  var chain = formWasShadowed
    ? saveShadowBranch(settings)
    : (oversize
        // 【第 3 条·审计修复】超长列表必须「先落地、再切换引用」，且切换前要确证落地成功。
        //
        //   此前的顺序是「先写 sync 空串占位、再写 local」，它留下的理由写的是：
        //     · local 写入失败 → 报错；sync="" + 旧 local → 生效值回退旧列表，
        //       新值丢失但无遮蔽、无覆盖，且用户看到失败提示。
        //   ——该推理【只对「local 里本来就有一份旧列表」成立】。
        //   而常见情形恰恰相反：用户的列表短到能直接存 sync，此时 local 是【空的】。
        //   于是 local 写入失败后 sync 已被写成 ""、local 仍为空
        //   ⇒ resolveBypassList("", undefined) 得空串
        //   ⇒ 用户原有的直连规则【凭空消失】，而这只是一次「保存失败」造成的路由变更：
        //      原本应本地直连的内网主机改走代理服务器（内网断连、内部主机名暴露给代理方）。
        //
        //   三种顺序各自的状态都要检查「生效值可能是空吗」：
        //     A) 先 sync 占位、后 local（旧实现）：本地为空时失败 → 空 ⇒ 丢数据 ❌
        //     B) 先 local、后 sync（更早的实现）：sync 失败 → 旧 sync 非空 ⇒ 旧值 ✅
        //       但它留下的中间态是「local=新长列表 / sync=旧非空列表」，新列表被旧值遮蔽。
        //     C) 本实现 = B + 落地确证：仍然先写 local，但【回读确认新值确实可读回】
        //        之后才写 sync 占位。于是每个失败点都保留旧的有效配置：
        //          · local 写入失败 → 链路中断报错；sync 未被改动 ⇒ 生效值 = 旧 sync ✅
        //          · 回读确证失败   → 同样不写 sync ⇒ 生效值 = 旧 sync ✅
        //          · sync 占位失败 → local 已是新值但 sync 仍是非空旧值 ⇒ 生效值 = 旧 sync ✅
        //        三个失败点都不会出现「生效值为空」，即不再有丢数据路径。
        //        中间态（local 新值被 sync 旧值遮蔽）是短暂且安全的：下一步立即切换引用；
        //        即使切换失败，也只是「新列表没生效、旧列表照旧」，并已如实报错。
        //
        //   【不可两全的说明】两次写入无法原子化，中间态客观存在（报告也指出
        //   「不要仅颠倒两个写入顺序，因为反向同样存在半提交状态」）。因此本修复的目标
        //   不是消灭中间态，而是保证【任何中间态下生效值都不是空】—— 这是丢数据的充要条件。
        ? setStorage("local", { bypassList: settings.bypassList })
            .then(function () {
              // 落地后回读确证：写入回调成功 ≠ 值真的可读回（配额、并发、存储层异常）。
              return new Promise(function (resolve, reject) {
                chrome.storage.local.get(["bypassList"], function (cur) {
                  var e = chrome.runtime.lastError;
                  if (e) {
                    reject(phaseError("stage_verify",
                      "确认本机绕过列表写入失败：" + e.message));
                    return;
                  }
                  if (!cur || cur.bypassList !== settings.bypassList) {
                    reject(phaseError("stage_verify",
                      "本机绕过列表写入后未能确证，已放弃切换生效值（原配置保持不变）"));
                    return;
                  }
                  resolve();
                });
              });
            })
            .then(function () {
              return setStorage("sync", Object.assign({}, settings, { bypassList: "" }));
            })
            .then(function () {
              showHint("绕过列表较长，已存于本地（不跨设备同步）", "warn");
              return "oversize";
            })
        : saveGenericBranch(settings, formWasShadowed));

  // 【第 1 条·审计修复】本次保存是否会真正改变存储。
  //   快照由 load() 写入，因此这里比较的是「表单内容」与「上次从存储读到的内容」。
  var sigChanged = settingsSignature(settings) !== lastLoadedSig;

  chain.then(function (kind) {
    // 【V-01】保存结束即复位确认态与按钮文案（含成功与失败两条路径）。
    resetShadowConfirm();
    // 【第 1 条】存储确实变了 → onChanged 会驱动下发，分支里的提示语已经准确。
    //   没变 → 不会产生任何 storage 事件，必须显式请求一次下发并消费后台结果。
    //   遮蔽现场（shadow）的提示是数据安全告知，只补发请求、不覆盖文案。
    return confirmApplied(sigChanged, kind === "shadow");
  }, function (err) {
    handleSaveFailure(err, settings);
  });
}

// 【M-2·审计修复】保存的前置守卫 + 写入链输入（原 save() 开头 677–743 行，逐字搬移）。
//   返回值：null = 已被守卫拦截（提示已给出、未写入任何存储）；
//          否则 { settings, formWasShadowed, oversize } 交给写入链。
//   四道守卫依次为：读取失败即拒写（R8-01）、参数校验、遮蔽现场行内二次确认（V-01）、
//   遮蔽现场 + 超长列表在写入前拒绝（V-02）。它们的共同点是「拒绝」而非「写入」，
//   因此与写入链分开后可以各自独立评审与断言。
function prepareSave() {
  // 【R8-01】核心安全要求：读取失败后表单内容不可信，必须【拒绝写入】。
  //   仅提示而不阻止，用户点一次「保存」仍会把默认值写回 sync 并清掉代理。
  if (loadFailed) {
    showHint(READ_FAIL_HINT, "error");
    return null;
  }

  var settings = readForm();
  var errors = S.validateSettings(settings);
  if (errors.length) {
    showHint(errors.join("；"), "error");
    return null;
  }

  // 【V-01】遮蔽现场下用户「改字后保存」会让后台自愈的判据（逐字符等于默认列表）
  //   永久失效：写进 sync 的值成为当前生效值（resolveBypassList 的 sync 非空优先），
  //   而用户自己那份规则不再被自动恢复。R9-01 的守卫保证了 local 不被删除
  //   （数据不丢），但"规则长期不生效"仍是用户必须知情后才能接受的结果。
  //
  //   这里刻意不用 window.confirm()：popup 一旦失焦就会被销毁，原生对话框的返回值
  //   永远回不来，会让保存变成"点了没反应"——那是用一个静默失败换另一个。
  //   改用行内二次确认：第一次点击只改按钮文案与提示，不写任何存储。
  //   判据用 looksLikeShadowEdit（「默认列表 + 编辑」形态）：逐字符等于默认列表
  //   是 R9-01 主场景（用户什么都没改），既有守卫已能安全处理，不在这里打断。
  //   位置刻意放在 readForm/validateSettings 之后：先把参数校验的错误说出来，
  //   再让用户确认，避免"先确认、后被告知输入非法"。
  if (loadedShadowed && !pendingShadowConfirm && S.looksLikeShadowEdit(settings.bypassList)) {
    pendingShadowConfirm = true;
    el.saveButton.textContent = "确认保存（会用此内容替换当前生效的绕过列表）";
    showHint("当前显示的绕过列表来自内置默认值，并不是你自己保存的那一份（你自己的规则保存在本机）。" +
      "再点一次上面的「确认保存」才会写入；取消请直接关闭弹窗。", "warn");
    return null;
  }

  var oversize =
    S.estimateBytes({ bypassList: settings.bypassList }) > S.MAX_SYNC_BYTES_PER_ITEM;

  // 【R9-01】必须在【发起写入之前】快照这个标记。
  //   写入 sync 会触发 storage.onChanged，popup 自己的 onChanged 监听会重新执行
  //   load()，而 load() 会用「新值是否等于默认列表」重算 loadedShadowed —— 对刚
  //   写进去的新值而言恒为 false。若在回调里读 loadedShadowed，守卫会被自己的
  //   写入冲掉，等同不存在（真实浏览器的 storage 事件同样会触发）。
  //   因此这里取快照，回调里只读快照。
  var formWasShadowed = loadedShadowed;

  // 【V-02】安全守卫必须挂在【分支判定之前】，而不是挂在短列表分支的清理动作上。
  //   遮蔽现场的表单内容不属于用户：此时 oversize 分支的语义前提（「列表太大，
  //   sync 放不下，所以存一份到 local」）根本不成立 —— local 里躺着的很可能正是
  //   用户规则的最后一份副本，而表单里那份是内置默认列表加用户的改动。
  //   因此遮蔽现场【一律不写 local】：写空串会丢副本，写表单值会覆盖副本。
  //
  //   第二层约束：遮蔽现场下也不能「顺手把表单值写进 sync」。chrome.storage.sync
  //   的【单键】上限是 8192 字节（S.MAX_SYNC_BYTES_PER_ITEM 就是它），而走到
  //   oversize 分支的正是「用户粘贴了超长列表」的情形：写 sync 在真实 Chrome 上
  //   必然以 lastError 失败，用户却会以为自己保存成功了。
  //   local 不能写、sync 装不下 → 唯一安全的动作是【在写入之前就拒绝】。
  //   【注意】本仓库测试的 storage 桩不做配额校验，「错误地写 sync」不会在测试里
  //   报错，所以这一层由 R9-01-F7 显式断言守住，不能省。
  if (formWasShadowed && oversize) {
    console.warn("遮蔽现场下拒绝保存超长绕过列表：local 是用户规则唯一副本不可覆盖，" +
      "而 sync 的单键上限（" + S.MAX_SYNC_BYTES_PER_ITEM + " 字节）装不下这份列表。" +
      "本次未写入任何存储。");
    showHint("未保存：当前显示的绕过列表来自内置默认值，而你粘贴的列表超过了可直接保存的长度上限（" +
      S.MAX_SYNC_BYTES_PER_ITEM + " 字节），本机还保存着你自己的规则（不会被覆盖）。" +
      "请先等后台恢复你自己的规则，或把列表缩短后重试。", "error");
    return null;
  }

  return { settings: settings, formWasShadowed: formWasShadowed, oversize: oversize };
}

// 【M-2·审计修复】保存失败的阶段化呈现（原 save() 的失败回调体，逐字搬移）。
//   【第 2 条·审计修复】按阶段分辨失败，不把「已写入但没清理干净」笼统报成「保存失败」。
function handleSaveFailure(err, settings) {
  if (err && err.phase === "local_cleanup") {
    // 取值规则是「sync 非空优先，为空则回退 local」：只有在 sync 为空
    // （用户把列表清空了）时，没清掉的旧 local 才会成为真正生效的那一份。
    if (!settings.bypassList) {
      showHint("设置已保存，但本机保存的旧绕过列表未能清除，因此当前实际生效的仍是" +
        "那份旧列表——你刚清空的规则可能仍会绕过代理。请重试保存。（" +
        ((err && err.message) || err) + "）", "error");
    } else {
      showHint("设置已保存；只是本机多留了一份旧的绕过列表副本没能清除" +
        "（当前生效的是你刚保存的这份，不受影响）。可稍后重试保存。（" +
        ((err && err.message) || err) + "）", "warn");
    }
  } else {
    showHint("保存失败：" + ((err && err.message) || err), "error");
  }
  resetShadowConfirm();
}

// 【M-2·审计修复】遮蔽现场下的写入链（原 save() 三元分支的一支，逐字搬移）。
//   只写 sync、绝不触碰 local（其中的绕过列表可能是用户规则唯一副本）。
//   返回值 "shadow" 让调用方保留这条【数据安全告知】文案（confirmApplied 的 silent 模式）。
function saveShadowBranch(settings) {
  return setStorage("sync", settings).then(function () {
    // 把「用户规则可能仍未生效」的事实留在日志里，而不是只留在界面：
    //   后续若出现「我的规则不生效」的报障，维护者能直接定位到这一次主动保存。
    console.warn("遮蔽现场下保存：已按用户表单写入 sync，但未改动 storage.local" +
      "（其中的绕过列表可能是用户规则唯一副本，且后台自愈判据已因本次写入不再成立）。");
    showHint("已保存；但本机还保存着你自己的规则，当前生效的仍可能是这一份表单内容。" +
      "关闭并重新打开弹窗，或等待后台自动恢复后再确认。", "warn");
    // 【第 1 条】本分支的提示是【数据安全告知】，信息量高于「是否已生效」，
    //   因此后续不覆盖它（confirmApplied 的 silent 模式）。
    return "shadow";
  });
}

// 【M-2·审计修复】普通短列表的写入链（原 save() 三元分支的一支，逐字搬移）。
//   先写 sync，再按「写入的列表是不是系统默认列表」决定是否清理本机旧副本。
function saveGenericBranch(settings, formWasShadowed) {
  return setStorage("sync", settings).then(function () {
    // 【R8-02】把本次写进 sync 的 bypassList 一并交给清理函数：
    //   它据此判断「保存的是系统默认列表」还是「用户自己撰写的列表」。
    //   【S1】同时传入 formWasShadowed 快照：遮蔽现场下绝不写 local（纵深防御）。
    return clearLocalBypassIfAny(settings.bypassList, formWasShadowed);
  }).then(function () {
    showHint("设置已保存", "ok");
    return "generic";
  });
}

// 【第 1 条·审计修复】保存成功后确认「到底有没有生效」，把「已保存」与「已生效」分开陈述。
//
//   根因：后台的【唯一下发驱动源】是 storage.onChanged（见 background.js 的 onChanged 监听）。
//   而 Chrome 在写入值与库中原值完全相同时【不产生任何 change】——
//   Chromium 的 LeveldbValueStore::AddToBatch 在 old == new 时既不记 change、也不写库，
//   空变更列表 ⇒ onChanged 不派发。于是「按界面提示重新保存一次相同配置」不会触发任何下发。
//   这条路径正是本文件 renderTest 给出的恢复指引（restoreFailed 文案：
//   「请重新保存一次设置以恢复」）—— 指引本身失效，用户还会看到「设置已保存」这个假成功。
//
//   ⇒ 当本次保存不会产生存储变化时，显式请求一次重下发，并以【后台下发结果】作为提示依据。
//     与事件驱动的下发共用 background 的 applyChain 串行队列，两者不会交错。
// 【M-2·审计修复】「消费后台下发结果 → 给诚实文案」的阶梯，抽出来供 save() 与
//   resetDefaults() 共用。
//   背景：这段阶梯此前只存在于 confirmApplied 内部，于是「恢复默认」既不分辨失败
//   阶段、也完全不消费下发结果 —— sync 已恢复成默认值、只有本机旧列表没清掉时报
//   「恢复失败」；通道异常时同样报「恢复失败」，而在「已恢复默认，但代理没生效」
//   这种最需要说清的情形下反而只说「已恢复默认设置」。第 2 条的修复只覆盖了 save()
//   一条路径，这里是同族路径的补齐（与项目自身总结的 M-3 教训同型）。
//   prefix = 「动作本身已经成功」的那半句，后半句由本阶梯按后台实际结果给出。
function reportApplyOutcome(resp, prefix) {
  if (!resp) {
    showHint(prefix + "，但未能与后台确认是否已生效（后台无响应）。" +
      "可点击「测试当前出口」确认，或关闭后重新打开弹窗。", "warn");
  } else if (resp.ok === true && resp.status === "applied") {
    showHint(prefix + "，且代理已按当前配置生效。", "ok");
  } else if (resp.ok === true && resp.status === "direct") {
    showHint(prefix + "（当前未启用代理）。", "ok");
  } else if (resp.ok === true && resp.status === "suspended") {
    // 连接测试进行中：后台已记脏，测试收尾会按最新设置下发。
    showHint(prefix + "；连接测试结束后会自动下发。", "warn");
  } else if (resp.ok === true && resp.status === "overridden") {
    showHint(prefix + "，但代理设置被企业策略或其它扩展接管，本次未下发。" +
      "请检查企业策略或其它扩展。", "warn");
  } else {
    // error / saved_not_applied / 未知档：存储已写入，但代理【没有】生效。
    //   绝不能沿用「已保存 / 已恢复」——那正是本条要修的假成功。
    var why = (resp.errors && resp.errors[0]) || resp.message || resp.status || "原因未知";
    showHint(prefix + "，但代理未能生效：" + why, "error");
  }
}

function confirmApplied(sigChanged, silent) {
  if (sigChanged) return Promise.resolve(null);
  return send({ action: "reapply" }).then(function (resp) {
    if (!silent) reportApplyOutcome(resp, "设置已保存");
    return resp;
  }, function (err) {
    if (!silent) {
      showHint("设置已保存，但无法确认代理是否生效（消息通道异常：" +
        ((err && err.message) || err) + "）。可点击「测试当前出口」确认。", "warn");
    }
    return null;
  });
}

// 【G6】恢复默认：移除 window.confirm，改用与 save()（V-01）一致的行内二次确认。
//   同一反模式的第二个实例：popup 一旦失焦即被销毁，原生对话框的返回值永远回不来，
//   会把「恢复默认」变成「点了没反应」。而该操作会清空本机 local 里的绕过列表
//   （遮蔽现场下那很可能是用户规则的唯一副本），属用户必须明确知情的高危操作，
//   绝不允许静默失败。第一次点击只进入确认态（零写入），第二次点击才执行。
function resetDefaults() {
  if (!pendingResetConfirm) {
    pendingResetConfirm = true;
    el.resetButton.textContent = "确认恢复默认";
    var msg = "将把所有设置恢复为默认值（含默认绕过列表），并清空本机保存的绕过列表。" +
      "再点一次上面的「确认恢复默认」才会执行；取消请直接关闭弹窗。";
    // 【G6】遮蔽现场下的知情补充：本机 local 里躺着的很可能是用户规则的唯一副本，
    //   恢复默认会把它一并清空 —— 必须让用户在确认之前知道这一点（与 save() 在
    //   遮蔽现场下的处理保持同一知情标准）。
    if (loadedShadowed) {
      msg = "注意：本机还保存着你自己的绕过规则（可能是唯一副本），恢复默认将把它一并清空。" + msg;
    }
    showHint(msg, "warn");
    return;
  }
  pendingResetConfirm = false;
  el.resetButton.textContent = "恢复默认";
  // 【M-2·审计修复】按阶段分辨失败 + 消费下发结果，与 save() 同构（共用 reportApplyOutcome）。
  //   restored 标记用于把「设置根本没恢复」与「已恢复、但后续步骤失败」分开 ——
  //   后者沿用「恢复失败」与事实相反（用户会以为什么都没改）。
  var restored = false;
  setStorage("sync", S.DEFAULTS).then(function () {
    return setStorage("local", { bypassList: "" }).catch(function (err) {
      throw phaseError("local_cleanup", (err && err.message) || err);
    });
  }).then(function () {
    restored = true;
    // 【R8-01】用户明确要求恢复默认：此时内容可信，解除「读取失败」的禁用态。
    markLoadOk();
    renderForm(S.normalizeSettings(S.DEFAULTS));
    // 存储一定被改写（除非本来就是默认值）→ onChanged 会驱动下发；这里仍显式请求
    //   一次并按其结果陈述，因为「已恢复默认」不等于「代理已按默认设置生效」。
    return send({ action: "reapply" });
  }).then(function (resp) {
    reportApplyOutcome(resp, "已恢复默认设置");
  }, function (err) {
    if (err && err.phase === "local_cleanup") {
      // 只清 local 失败，sync 已恢复默认 —— 用「恢复失败」会与事实相反。
      // 措辞必须如实，且**不能**承诺「不受影响」：取值规则是「sync 非空优先，为空则
      //   回退 local」，而 resetDefaults 写进 sync 的正是【内置默认列表】；一旦本机
      //   还存有另一份列表，这种「sync == 默认列表 + local 非空」的组合同样命中后台的
      //   存量污染自愈判据（isLegacyShadowed 是逐字符相等），自愈会把 sync 清成空串占位，
      //   于是本机那份旧列表【重新成为生效值】—— 也就是说用户刚执行的「恢复默认」
      //   可能并未真正生效（与 SECURITY.md 第 6 条披露的组合同源）。
      //   这里如实说明并指向唯一可行的动作：重试，直到本机副本被真正清掉。
      showHint("设置已恢复默认；但本机保存的旧绕过列表副本未能清除。若本机确实还存有" +
        "另一份列表，它会被当作「历史遗留」重新生效 —— 即你之前的列表可能仍在绕过代理。" +
        "请重试「恢复默认」直到不再出现本提示。（" + ((err && err.message) || err) + "）", "error");
      return;
    }
    if (restored) {
      showHint("已恢复默认设置，但无法确认代理是否生效（消息通道异常：" +
        ((err && err.message) || err) + "）。可点击「测试当前出口」确认。", "warn");
      return;
    }
    showHint("恢复失败：" + ((err && err.message) || err), "error");
  });
}

renderTypeOptions();
el.saveButton.addEventListener("click", save);
el.resetButton.addEventListener("click", resetDefaults);
// 【R7-08】runTest 内部已有 try/catch/finally 兜底，正常情况下不会再拒绝；
//   调用点再补一层 .catch 是契约：即便 runTest 的同步段（禁用按钮、写「测试中…」）
//   将来抛出，也不会留下 Uncaught (in promise)，失败原因照样显示在结果区。
el.testButton.addEventListener("click", function () { runTest(false).catch(renderTestError); });
el.testDirectButton.addEventListener("click", function () { runTest(true).catch(renderTestError); });
// 【L-08】诊断导出同样补一层 .catch：runTest 的教训（异常不复位按钮）在此适用。
el.diagButton.addEventListener("click", function () { exportDiagnostics().catch(renderTestError); });

// 任一入口（含其它窗口 / 同步设备）改动存储，都刷新当前界面
chrome.storage.onChanged.addListener(function (changes, areaName) {
  // 【M-5】后台 session 状态写入失败（重试后仍失败）时会经 local 区下发
  //   stateWriteFailed 标记：此时前台显示的状态可能已过期，必须如实告知用户，
  //   而不是让界面停留在「看起来一切正常」的过期结论上。
  if (areaName === "local" && changes && changes.stateWriteFailed) {
    showHint("状态记录写入失败：当前显示的代理状态可能过期。可关闭并重新打开弹窗重试。", "warn");
  }
  if (areaName === "sync" || areaName === "local") load();
  if (areaName === "session") refreshStatus();
});

load();
refreshStatus();
