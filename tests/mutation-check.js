// tests/mutation-check.js —— 变异测试
// 目的：故意破坏每一个修复点，确认护栏测试会失败（退出码非 0）。
// 若某变异未被拦截，说明该修复点缺少有效护栏 —— 属于测试漏洞，需补用例。
//
// 【第四轮加固】判定必须是【基线绿 + 注入成功 + 变异被拦截】三者同时成立。
//   此前 runTest() 返回 -1（进程启动失败）时，"failed = code !== 0" 会把
//   【根本没跑起来】误判成【测试失败 = 变异已被拦截】：若 spawn 全部失败，
//   门禁会打印"达标 9 项，未达标 0 项"并以 exit 0 放行 —— 整个护栏体系静默失效。
//   现在启动失败一律记 BAD（不计入 hit），并让最终退出码非 0。
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.join(__dirname, "..");
const targets = {
  bg: path.join(rootDir, "background.js"),
  set: path.join(rootDir, "settings.js")
};
// 变异后必须运行【全部】测试：只跑其中一个会漏掉护栏。
// 曾经踩过的坑：护栏写在 concurrency.test.js，而这里只跑 background.test.js，
// 导致「去掉暂停计数器递减」（即 N1 的形态）变异后没有任何用例失败。
const testFiles = [
  "manifest.test.js",
  "settings.test.js",
  "background.test.js",
  "fix-safety.test.js",
  "concurrency.test.js",
  "ownership.test.js"
].map(function (f) { return path.join(__dirname, f); });

// 换行符处理：
//   变异用的 from/to 片段统一按 LF 书写，但仓库在 Windows 检出时可能是 CRLF。
//   若直接拿含 \n 的片段去匹配 CRLF 文件，会注入失败 —— 这在 CI（Linux）与
//   本地（Windows）之间表现不一致，属于可移植性缺陷。
//   这里读取时把 CRLF 归一为 LF 做匹配，写回时再还原成原文件的风格。
function detectEol(s) { return s.indexOf("\r\n") >= 0 ? "\r\n" : "\n"; }
function toLf(s) { return s.split("\r\n").join("\n"); }
function restoreEol(s, eol) { return eol === "\n" ? s : s.split("\n").join(eol); }

const originals = {
  bg: fs.readFileSync(targets.bg, "utf8"),
  set: fs.readFileSync(targets.set, "utf8")
};

// 匹配用（LF 归一），写回用（原风格）
const norm = {
  bg: toLf(originals.bg),
  set: toLf(originals.set)
};
const eol = {
  bg: detectEol(originals.bg),
  set: detectEol(originals.set)
};

// 只要有一个测试文件失败，就认为变异被拦截。
// 返回值语义（第四轮起为结构化结果，避免 -1 与断言失败混淆）：
//   { code: 0,   reason: "ok"    } —— 全部通过
//   { code: N,   reason: "assert"} —— 断言失败（该测试文件的退出码）
//   { code: -1,  reason: "spawn" } —— 进程启动失败（spawn 失败/被信号杀死）
// 【关键】reason="spawn" 绝不能当作"变异被拦截"，必须记为 BAD。
function runTest() {
  for (const f of testFiles) {
    const r = spawnSync(process.execPath, [f], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    if (r.error) return { code: -1, reason: "spawn", file: f };
    const code = r.status === null ? -1 : r.status;
    if (code === -1) return { code: -1, reason: "spawn", file: f };
    if (code !== 0) return { code: code, reason: "assert", file: f };
  }
  return { code: 0, reason: "ok", file: null };
}

const mutations = [
  {
    name: "M1 去掉代次号检查（串行队列仍在，应仍正确）",
    target: "bg",
    from: "if (gen !== applyGeneration) return null;",
    to: "",
    expectFail: false
  },
  {
    name: "M2 绕过串行队列（applyProxySerial 改为 applyProxy）",
    target: "bg",
    from: "applyProxySerial();",
    to: "applyProxy();",
    expectFail: true
  },
  {
    // 第四轮起，"对比期间不得被重新下发"由【排他队列】保证（见 M10），
    // 原先这条"去掉 suspendDepth++"的变异已不再产生可观测差异 —— 那是修复的正常结果
    // （职责被更强的机制接管），不是护栏失效。这里改为覆盖本轮新增的【落实校验】。
    name: "M3 去掉下发后的实际模式校验（R3-07 回归：绿着但直连）",
    target: "bg",
    from: "  if (actualMode && actualMode !== \"fixed_servers\") {",
    to: "  if (false) {",
    expectFail: true
  },
  {
    // 这条对应上一轮的 N1 缺陷：暂停标志退出时未递减，导致下发被永久跳过。
    // 若并发测试用例有效，去掉递减后它必须变红。
    name: "M7 暂停计数器退出时不递减（模拟 N1 泄漏）",
    target: "bg",
    from: "    suspendDepth--;\n    if (suspendDepth < 0) suspendDepth = 0;   // 防御性归零，避免异常路径下变负",
    to: "    if (suspendDepth < 0) suspendDepth = 0;   // 防御性归零，避免异常路径下变负",
    expectFail: true
  },
  {
    name: "M8 去掉测试并发互斥（testInFlight 判断失效）",
    target: "bg",
    from: "  if (testInFlight) {\n",
    to: "  if (false) {\n",
    expectFail: true
  },
  {
    name: "M9 暂停期间的存储变化不再记脏（接管时丢失待下发标记）",
    target: "bg",
    from: "  if (touched) {\n    if (suspendDepth > 0) suspendDirty = true;\n    applyProxySerial();\n  }",
    to: "  if (touched) {\n    applyProxySerial();\n  }",
    expectFail: true
  },
  {
    // 第四轮 R3-01 根因之一：对比窗口必须整体排入同一条串行队列。
    // 去掉排他入队后，窗口会与普通下发交错，ownership 用例必须变红。
    name: "M10 对比窗口不再排他入队（R3-01 回归：双所有权）",
    target: "bg",
    from: "    await applyProxyExclusive(function () {\n      return runCompareWindow(result);\n    });",
    to: "    await runCompareWindow(result);",
    expectFail: true
  },
  {
    // 第四轮 R3-01 根因之三：窗口收尾必须按【最新 settings】提交。
    // 去掉收尾提交后，代理会停留在被清除的直连状态，ownership 用例必须变红。
    name: "M11 窗口收尾不再提交（R3-01 回归：清除后不恢复）",
    target: "bg",
    from: "      await applyProxyCore();\n      suspendDirty = false;",
    to: "      if (false) { suspendDirty = false; }",
    expectFail: true
  },
  {
    // 第四轮 R3-04 根因：控制权未知（缺 levelOfControl）不得判 applied。
    name: "M12 控制权白名单放宽为恒真（R3-04 回归：失败开放）",
    target: "bg",
    from: "function isControllableByUs(level) {\n  return level === \"controlled_by_this_extension\" ||\n         level === \"controllable_by_this_extension\";\n}",
    to: "function isControllableByUs(level) { return true; }",
    expectFail: true
  },
  {
    // 第四轮 R3-07：窗口一开始必须主动产生可观测的进行中状态。
    name: "M13 窗口不再主动写 suspended 状态（R3-07 回归）",
    target: "bg",
    from: "    writeState({ status: \"suspended\", at: Date.now() });\n    updateIcon(\"suspended\");",
    to: "",
    expectFail: true
  },
  {
    name: "M4 去掉 CIDR 分段数校验",
    target: "set",
    from: "if (parts.length !== 4) return false;",
    to: "",
    expectFail: true
  },
  {
    name: "M5 去掉 CIDR 段值上限校验",
    target: "set",
    from: "if (Number(p) > 255) return false;",
    to: "",
    expectFail: true
  },
  {
    name: "M6 去掉 resolveBypassList 的 local 回退",
    target: "set",
    from: "if (typeof localValue === 'string') return localValue;",
    to: "if (false) return localValue;",
    expectFail: true
  }
];

// 基线校验（R3-06）：
//   若基线本身已经失败，runTest() 在【每个】变异下都会返回非 0，
//   于是「所有变异都被拦截」这一结论完全虚假 —— 门禁会静默变成永远放行。
//   因此基线非 0 必须立即中止，约定退出码 3。
const baseline = runTest();
if (baseline.reason === "spawn") {
  console.error("基线（未变异）：测试进程启动失败（" + baseline.file + "），无法执行变异测试。");
  console.error("请先确认 node 可用且 tests/ 下的测试文件存在。立即中止。");
  process.exit(3);
}
if (baseline.code !== 0) {
  console.error("基线（未变异）：退出码 = " + baseline.code + "（" + baseline.file + " 已失败）。");
  console.error("基线失败时每个变异都会呈现为「已被拦截」，变异结果无意义。立即中止。");
  process.exit(3);
}
console.log("基线（未变异）：退出码 = 0（测试全绿，变异结果可信）");
console.log("");

const rows = [];
let ok = 0, miss = 0, bad = 0, injectFail = 0;

try {
  for (const m of mutations) {
    const file = targets[m.target];
    const orig = originals[m.target];
    // 在 LF 归一化的文本上做替换，确保 CRLF 检出时同样能命中
    const mutatedLf = norm[m.target].split(m.from).join(m.to);

    if (mutatedLf === norm[m.target]) {
      rows.push([m.name, m.expectFail ? "应拦截" : "应放行", "注入失败", false, true]);
      injectFail++;
      continue;
    }

    fs.writeFileSync(file, restoreEol(mutatedLf, eol[m.target]));
    let res;
    try { res = runTest(); }
    finally { fs.writeFileSync(file, orig); }

    // 判据 = 基线绿 + 注入成功 + 变异被拦截（或按预期放行）
    // 进程启动失败一律 BAD：它既不是"被拦截"，也不是"没被拦截"，而是门禁自身失效。
    if (res.reason === "spawn") {
      rows.push([m.name, m.expectFail ? "应拦截" : "应放行",
        "启动失败(" + res.file + ")", false, true]);
      bad++;
      continue;
    }

    const blocked = res.code !== 0;
    const hit = m.expectFail ? blocked : !blocked;
    if (hit) ok++; else miss++;
    rows.push([m.name, m.expectFail ? "应拦截" : "应放行",
      blocked ? "已被拦截" : "未被拦截", hit, false]);
  }
} finally {
  fs.writeFileSync(targets.bg, originals.bg);
  fs.writeFileSync(targets.set, originals.set);
}

console.log("变异测试结果：");
for (const r of rows) {
  const tag = r[4] ? "BAD " : (r[3] ? "OK  " : "MISS");
  console.log("  [" + tag + "] " + r[0]);
  console.log("           预期 " + r[1] + " / 实际 " + r[2]);
}

const restored = fs.readFileSync(targets.bg, "utf8") === originals.bg &&
                 fs.readFileSync(targets.set, "utf8") === originals.set;
console.log("");
console.log("达标 " + ok + " 项，未达标 " + miss + " 项，注入失败 " + injectFail + " 项，" +
  "门禁自身失效(BAD) " + bad + " 项");
console.log("原文件已恢复：" + (restored ? "是" : "否"));
process.exit((miss > 0 || injectFail > 0 || bad > 0 || !restored) ? 1 : 0);
