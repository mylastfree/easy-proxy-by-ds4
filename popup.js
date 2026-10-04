// popup.js —— 只负责渲染、校验与读写存储；下发决策在 background  [v2.7.0]
var S = window.EasyProxy;

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
  testResult: document.getElementById("testResult")
};

var STATUS_TEXT = {
  applied: ["代理已生效", "ok"],
  direct: ["未启用代理（直连）", "muted"],
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
  // 【R8-04】状态本身没读到（session.get 失败）。与 direct 的区别是本质性的：
  //   这一档下我们【根本不知道】代理现在是什么状态，必须如实说不知道；
  //   用 muted 档的直连文案会把「读不到」谎报成「用户没开代理」。
  //   也不并入 error 档：本次什么都没做，代理没有被改动，凭什么说它异常。
  status_read_failed: ["状态未知：无法读取当前状态，代理可能仍在生效", "warn"]
};

function setStorage(area, obj) {
  return new Promise(function (resolve, reject) {
    chrome.storage[area].set(obj, function () {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function send(message) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(message, function (resp) {
      void chrome.runtime.lastError;
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
  el.enableProxy.checked = settings.enableProxy;
  el.proxyType.value = settings.proxyType;
  el.proxyHost.value = settings.proxyHost;
  el.proxyPort.value = settings.proxyPort;
  el.bypassList.value = settings.bypassList;
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
  if (state.status === "error" && state.reason === "read_failed") key = "error_read_failed";
  else if (state.status === "error" && state.reason === "control_unknown") key = "error_control_unknown";
  var row = STATUS_TEXT[key] || ["状态未知", "muted"];
  var text = row[0];
  if (state.errors && state.errors.length) text += "：" + state.errors.join("；");
  else if (state.message) text += "：" + state.message;
  // 对比测试期间保存的配置，若因外部接管而尚未下发，必须让用户看得见（R3-01）。
  // 此前这种情况被静默丢弃：存储里是新值、界面无任何提示、浏览器仍在用旧配置。
  if (state.pendingResubmit) text += "（有配置变更待下发）";
  el.statusBar.textContent = text;
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
    el.testResult.innerHTML =
      '<span style="color:#5a6772">尚未测试。点击「测试当前出口」查看流量实际从哪里出去。</span>';
    return;
  }

  var html = "";
  html += "<div><b>当前出口</b>" + escapeHtml(fmtExit(result.exit)) + "</div>";

  if (result.direct) {
    html += "<div><b>直连出口</b>" + escapeHtml(fmtExit(result.direct)) + "</div>";
  }

  if (result.settings) {
    var s = result.settings;
    var proxyText = s.enableProxy
      ? (s.proxyType + " " + s.proxyHost + ":" + s.proxyPort)
      : "未启用";
    html += "<div><b>代理配置</b>" + escapeHtml(proxyText) + "</div>";
  }

  if (result.activeMode) {
    html += "<div><b>生效模式</b>" + escapeHtml(result.activeMode) + "</div>";
  }

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

  html += '<div class="verdict ' + kind + '">' + escapeHtml(verdict) + "</div>";
  el.testResult.innerHTML = html;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 【R7-08】测试请求失败的统一出口。
//   消息通道自身出错时（send 同步抛错，或抛错使 send 返回 rejected Promise），
//   必须与「后台返回 {ok:false}」走同一档失败文案，如实带出原因，不得静默吞掉。
function renderTestError(err) {
  var reason = (err && err.message) ? err.message : err;
  if (!reason) reason = "消息通道异常";
  el.testResult.innerHTML =
    '<span style="color:#a3251b">测试失败：' + escapeHtml(reason) + "</span>";
}

async function runTest(compare) {
  el.testButton.disabled = true;
  el.testDirectButton.disabled = true;
  el.testResult.innerHTML =
    '<span style="color:#5a6772">测试中…' + (compare ? "（对比期间会短暂切换为直连，随后自动恢复）" : "") + "</span>";

  try {
    var resp = await send({ action: "testConnection", compare: compare });

    if (!resp || !resp.ok) {
      el.testResult.innerHTML =
        '<span style="color:#a3251b">测试失败：' + escapeHtml((resp && resp.error) || "无响应") + "</span>";
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

// 表单字段清单：读取失败时统一清空 + 禁用。
//   清空是必须的 —— 存储里可能是用户上一次的真实配置（sync 与 local 两次读取之间失败时），
//   留着它就等于让用户在一份【不完整】的显示上继续编辑，那正是本缺陷的误导来源。
var FORM_FIELDS = ["enableProxy", "proxyType", "proxyHost", "proxyPort", "bypassList"];

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
      markLoadOk();
      renderForm(settings);

      // 【R9-01】把"历史遗留的绕过列表冲突"显式告诉用户，而不是让默认值静默
      //   遮蔽他真正的规则。后台的连续自愈会很快把 sync 恢复为空串占位、让 local
      //   重新生效；在自愈完成之前，用户至少能看到发生了什么，不会把"看到默认值"
      //   误当成"我的规则丢了"而重新手打一遍。
      var shadowed =
        typeof (items && items.bypassList) === "string" &&
        items.bypassList === S.DEFAULTS.bypassList &&
        typeof (local && local.bypassList) === "string" &&
        local.bypassList.length > 0 &&
        local.bypassList !== S.DEFAULTS.bypassList;
      loadedShadowed = shadowed;
      // 【V-01】表单重载即复位确认态与按钮文案：任何一次存储变化（含保存成功后
      //   自己触发的那次）都会走到这里，确认态不会跨操作残留。
      resetShadowConfirm();
      if (shadowed) {
        console.warn("检测到历史遗留的绕过列表污染现场：本机 local 保存着用户规则，但 sync 是内置默认列表。已标记本次表单，保存时不会据此删除 local。");
        // 【W-01】此前的文案是「此提示存在期间请勿保存」——守卫补全覆盖全部写入路径之后，
        //   这句话已经变成谎言（保存不会删掉本机那份规则），而且会诱导用户在被遮蔽的
        //   界面上空等。新文案把两件事分开说清：「保存不会丢数据」与「保存会覆盖生效值」。
        showHint("检测到历史遗留的绕过列表：本机保存着你自己的规则，但当前生效的是内置默认列表。" +
          "后台正在自动恢复为你的规则。此时可以直接保存（不会删掉本机那份规则），" +
          "但保存的内容会成为当前生效值；若想恢复自己的规则，请等本提示消失后再保存。", "warn");
      }
    });
  });
}

function refreshStatus() {
  send({ action: "getStatus" }).then(function (resp) {
    if (!resp) return;
    // 【R8-04】resp.readFailed 为真时 state 必为 null，两者一起交给 renderStatus：
    //   只传 state 会让它走了「真的没有状态」那条正确兜底，重新变成假象。
    renderStatus(resp.state, resp.readFailed === true);
    renderTest(resp.test);
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
function clearLocalBypassIfAny(savedBypassList) {
  // 【R8-02】保存的正是系统默认列表 → 保留 local，不发任何写入。
  // 【R9-01】本判据（逐字符等于内置默认列表 = 存量污染特征）保持不变：
  //   R8-02-C 已论证把它放宽成"一律不清"会让过期副本复活，那不可接受。
  //   本轮把防护前移：污染现场在用户动手之前就被自愈（见 background.js 的
  //   reconcileLegacyBypass 与 popup 的 loadedShadowed 守卫），而不是在这里放宽。
  if (typeof savedBypassList === "string" && savedBypassList === S.DEFAULTS.bypassList) {
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    chrome.storage.local.get(["bypassList"], function (cur) {
      // 【R8-01】读取失败时 cur 为 undefined：绝不能把它当成「local 里没有列表」，
      //   更不能继续走到下面的清除分支 —— 那会把用户的长列表永久清空（与 R7-03 同型）。
      //   读不到就什么都不做，等下一次存储变化或用户重新打开弹窗。
      if (chrome.runtime.lastError || !cur) { resolve(); return; }
      if (typeof cur.bypassList === "string" && cur.bypassList) {
        setStorage("local", { bypassList: "" }).then(resolve, resolve);
      } else {
        resolve();
      }
    });
  });
}

function save() {
  // 【R8-01】核心安全要求：读取失败后表单内容不可信，必须【拒绝写入】。
  //   仅提示而不阻止，用户点一次「保存」仍会把默认值写回 sync 并清掉代理。
  if (loadFailed) {
    showHint(READ_FAIL_HINT, "error");
    return;
  }

  var settings = readForm();
  var errors = S.validateSettings(settings);
  if (errors.length) {
    showHint(errors.join("；"), "error");
    return;
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
    return;
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
    return;
  }

  var chain = formWasShadowed
    ? setStorage("sync", settings).then(function () {
        // 把「用户规则可能仍未生效」的事实留在日志里，而不是只留在界面：
        //   后续若出现「我的规则不生效」的报障，维护者能直接定位到这一次主动保存。
        console.warn("遮蔽现场下保存：已按用户表单写入 sync，但未改动 storage.local" +
          "（其中的绕过列表可能是用户规则唯一副本，且后台自愈判据已因本次写入不再成立）。");
        showHint("已保存；但本机还保存着你自己的规则，当前生效的仍可能是这一份表单内容。" +
          "关闭并重新打开弹窗，或等待后台自动恢复后再确认。", "warn");
      })
    : (oversize
        ? setStorage("local", { bypassList: settings.bypassList }).then(function () {
            return setStorage("sync", Object.assign({}, settings, { bypassList: "" }));
          }).then(function () {
            showHint("绕过列表较长，已存于本地（不跨设备同步）", "warn");
          })
        : setStorage("sync", settings).then(function () {
            // 【R8-02】把本次写进 sync 的 bypassList 一并交给清理函数：
            //   它据此判断「保存的是系统默认列表」还是「用户自己撰写的列表」。
            return clearLocalBypassIfAny(settings.bypassList);
          }).then(function () {
            showHint("设置已保存", "ok");
          }));

  chain.then(function () {
    // 【V-01】保存结束即复位确认态与按钮文案（含成功与失败两条路径）。
    resetShadowConfirm();
  }, function (err) {
    showHint("保存失败：" + ((err && err.message) || err), "error");
    resetShadowConfirm();
  });
}

function resetDefaults() {
  if (!window.confirm("将把所有设置恢复为默认值（含默认绕过列表），确定吗？")) return;
  setStorage("sync", S.DEFAULTS).then(function () {
    return setStorage("local", { bypassList: "" });
  }).then(function () {
    // 【R8-01】用户明确要求恢复默认：此时内容可信，解除「读取失败」的禁用态。
    markLoadOk();
    renderForm(S.normalizeSettings(S.DEFAULTS));
    showHint("已恢复默认设置", "ok");
  }).catch(function (err) {
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

// 任一入口（含其它窗口 / 同步设备）改动存储，都刷新当前界面
chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName === "sync" || areaName === "local") load();
  if (areaName === "session") refreshStatus();
});

load();
refreshStatus();
