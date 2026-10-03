// popup.js —— 只负责渲染、校验与读写存储；下发决策在 background  [v2.2.0]
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
  error: ["代理异常，流量可能已回退直连", "error"]
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

function renderStatus(state) {
  if (!state) state = { status: "direct" };
  var row = STATUS_TEXT[state.status] || ["状态未知", "muted"];
  var text = row[0];
  if (state.errors && state.errors.length) text += "：" + state.errors.join("；");
  else if (state.message) text += "：" + state.message;
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

  if (result.restoreFailed) {
    verdict = "⚠ 对比后恢复原代理配置失败，请重新保存一次设置以恢复。";
    kind = "error";
  } else if (result.compareSkipped === "not_controlled_by_this_extension") {
    verdict = "ℹ 当前代理设置不由本扩展控制（被策略或其它扩展接管），已跳过直连对比以免影响它。";
    kind = "warn";
  } else if (!result.exit || !result.exit.ok) {
    verdict = "✗ 出口检测失败。若已启用代理，说明流量可能无法出去——请检查代理地址与端口，或代理软件是否在运行。";
    kind = "error";
  } else if (result.direct && result.direct.ok) {
    if (result.ipChanged) {
      verdict = "✓ 代理确实生效：当前出口与直连出口不同。";
      kind = "ok";
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

async function runTest(compare) {
  el.testButton.disabled = true;
  el.testDirectButton.disabled = true;
  el.testResult.innerHTML =
    '<span style="color:#5a6772">测试中…' + (compare ? "（对比期间会短暂切换为直连，随后自动恢复）" : "") + "</span>";

  var resp = await send({ action: "testConnection", compare: compare });

  el.testButton.disabled = false;
  el.testDirectButton.disabled = false;

  if (!resp || !resp.ok) {
    el.testResult.innerHTML =
      '<span style="color:#a3251b">测试失败：' + escapeHtml((resp && resp.error) || "无响应") + "</span>";
    return;
  }
  renderTest(resp.result);
}

/* ==================== 加载与保存 ==================== */

function load() {
  chrome.storage.sync.get(Object.keys(S.DEFAULTS), function (items) {
    void chrome.runtime.lastError;
    var settings = S.normalizeSettings(items);

    // 先读 local，再用与 background 完全相同的规则决定取值。
    // 此前是「先 normalizeSettings 再判断是否为空」，而 normalizeSettings
    // 会把缺失的 bypassList 填成默认值，导致回退 local 的分支永不执行，
    // 界面显示与实际下发可能取到不同的列表。
    chrome.storage.local.get(["bypassList"], function (local) {
      void chrome.runtime.lastError;
      settings.bypassList = S.resolveBypassList(
        items && items.bypassList,
        local && local.bypassList
      );
      renderForm(settings);
    });
  });
}

function refreshStatus() {
  send({ action: "getStatus" }).then(function (resp) {
    if (!resp) return;
    renderStatus(resp.state);
    renderTest(resp.test);
  });
}

// 仅当 local 中确实存有内容时才清空它；
// 否则会产生一次「空 → 空」之外的伪变化并触发多余的下发。
function clearLocalBypassIfAny() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(["bypassList"], function (cur) {
      void chrome.runtime.lastError;
      if (cur && typeof cur.bypassList === "string" && cur.bypassList) {
        setStorage("local", { bypassList: "" }).then(resolve, resolve);
      } else {
        resolve();
      }
    });
  });
}

function save() {
  var settings = readForm();
  var errors = S.validateSettings(settings);
  if (errors.length) {
    showHint(errors.join("；"), "error");
    return;
  }

  var oversize =
    S.estimateBytes({ bypassList: settings.bypassList }) > S.MAX_SYNC_BYTES_PER_ITEM;

  var chain = oversize
    ? setStorage("local", { bypassList: settings.bypassList }).then(function () {
        return setStorage("sync", Object.assign({}, settings, { bypassList: "" }));
      }).then(function () {
        showHint("绕过列表较长，已存于本地（不跨设备同步）", "warn");
      })
    : setStorage("sync", settings).then(function () {
        return clearLocalBypassIfAny();
      }).then(function () {
        showHint("设置已保存", "ok");
      });

  chain.catch(function (err) {
    showHint("保存失败：" + ((err && err.message) || err), "error");
  });
}

function resetDefaults() {
  if (!window.confirm("将把所有设置恢复为默认值（含默认绕过列表），确定吗？")) return;
  setStorage("sync", S.DEFAULTS).then(function () {
    return setStorage("local", { bypassList: "" });
  }).then(function () {
    renderForm(S.normalizeSettings(S.DEFAULTS));
    showHint("已恢复默认设置", "ok");
  }).catch(function (err) {
    showHint("恢复失败：" + ((err && err.message) || err), "error");
  });
}

renderTypeOptions();
el.saveButton.addEventListener("click", save);
el.resetButton.addEventListener("click", resetDefaults);
el.testButton.addEventListener("click", function () { runTest(false); });
el.testDirectButton.addEventListener("click", function () { runTest(true); });

// 任一入口（含其它窗口 / 同步设备）改动存储，都刷新当前界面
chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName === "sync" || areaName === "local") load();
  if (areaName === "session") refreshStatus();
});

load();
refreshStatus();
