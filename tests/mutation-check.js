// tests/mutation-check.js —— 变异测试
// 目的：故意破坏每一个修复点，确认护栏测试会失败（退出码非 0）。
// 若某变异未被拦截，说明该修复点缺少有效护栏 —— 属于测试漏洞，需补用例。
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
  "concurrency.test.js"
].map(function (f) { return path.join(__dirname, f); });

const originals = {
  bg: fs.readFileSync(targets.bg, "utf8"),
  set: fs.readFileSync(targets.set, "utf8")
};

// 只要有一个测试文件失败，就认为变异被拦截
function runTest() {
  for (const f of testFiles) {
    const r = spawnSync(process.execPath, [f], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    const code = r.status === null ? -1 : r.status;
    if (code !== 0) return code;
  }
  return 0;
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
    name: "M3 关闭测试期暂停（suspendDepth++ 改为不递增）",
    target: "bg",
    from: "    suspendDepth++;\n",
    to: "",
    expectFail: true
  },
  {
    // 这条对应上一轮的 N1 缺陷：暂停标志退出时未递减，导致下发被永久跳过。
    // 若并发测试用例有效，去掉递减后它必须变红。
    name: "M7 暂停计数器退出时不递减（模拟 N1 泄漏）",
    target: "bg",
    from: "      suspendDepth--;\n",
    to: "",
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
    from: "if (typeof localValue === \u0027string\u0027) return localValue;",
    to: "if (false) return localValue;",
    expectFail: true
  }
];

console.log("基线（未变异）：退出码 = " + runTest());
console.log("");

const rows = [];
let ok = 0, miss = 0, bad = 0;

try {
  for (const m of mutations) {
    const file = targets[m.target];
    const orig = originals[m.target];
    const mutated = orig.split(m.from).join(m.to);

    if (mutated === orig) {
      rows.push([m.name, "注入失败", "-", false, true]);
      bad++;
      continue;
    }

    fs.writeFileSync(file, mutated);
    let code = -1;
    try { code = runTest(); }
    finally { fs.writeFileSync(file, orig); }

    const failed = code !== 0;
    const hit = m.expectFail ? failed : !failed;
    if (hit) ok++; else miss++;
    rows.push([m.name, m.expectFail ? "应拦截" : "应放行",
      failed ? "已被拦截" : "未被拦截", hit, false]);
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
console.log("达标 " + ok + " 项，未达标 " + miss + " 项，注入失败 " + bad + " 项");
console.log("原文件已恢复：" + (restored ? "是" : "否"));
process.exit((miss > 0 || bad > 0 || !restored) ? 1 : 0);
