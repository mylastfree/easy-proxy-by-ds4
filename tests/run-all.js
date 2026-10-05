// tests/run-all.js —— 依序运行全部功能测试，任一失败立即以非 0 退出。
// 运行：node tests/run-all.js（npm test / npm run coverage 统一入口）
//
// 【M-4·审计修复】c8 覆盖率需要包装被测进程；但 c8 在 Windows 上无法可靠
//   包装 `npm`（npm.cmd 无法被无 shell 的 spawn 直接启动，覆盖率静默为 0）。
//   因此把测试清单收敛到这个 node 脚本：`c8 node tests/run-all.js` 包装的是
//   node 进程本身，三平台行为一致；NODE_V8_COVERAGE 环境变量会被子进程
//   自然继承，覆盖率照常汇总。
//   清单顺序与 CI 各步骤一致；新增测试文件时须同步此清单与 CI。
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const files = [
  "manifest.test.js",
  "settings.test.js",
  "background.test.js",
  "fix-safety.test.js",
  "concurrency.test.js",
  "ownership.test.js",
  "popup.test.js"
];

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    console.error("测试失败：" + f + (r.error ? "（" + r.error.message + "）" : ""));
    process.exit(1);
  }
}
console.log("");
console.log("全部 " + files.length + " 套功能测试通过");
