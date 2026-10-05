// tests/g1-consistency.js —— G1 文档一致性自检助手（被各测试文件在结尾调用）
// 运行：无独立入口；由 tests/*.test.js require 后调用。
//
// 【G1 背景】README 是用户与审计者的第一入口，其声明的「每套件断言数」此前靠人工
//   维护，已经漂移过一次（2.7.0 期间 README 写 534 项、实测 577 项）。文档漂移
//   会直接削弱「用数字证明质量」的可信度，因此把它变成可拦截的缺陷：
//   每个测试文件在结束时核对 README 中本套件声明的断言数与本次实际通过数，
//   不一致即 fail（CI 变红），提示维护者同步 README 的对应行与合计。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * 核对 README 中 testFileName 所在表格行声明的断言数。
 * @param {string} testFileName 形如 "tests/settings.test.js"（与 README 表格首列一致）
 * @param {number} passCount 本套件本次运行实际通过的断言数
 * @returns {{skipped: boolean, declared: number|null}}
 *   skipped=true 表示 README 缺失该行或不可读（自检跳过，不阻塞功能测试结论）；
 *   skipped=false 且 declared !== passCount 时，调用方应 fail++ 并打印说明。
 */
function g1ConsistencyCheck(testFileName, passCount) {
  let readme;
  try {
    readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  } catch (e) {
    console.log("  WARN  G1 自检跳过：README.md 不可读（" + (e && e.message) + "）");
    return { skipped: true, declared: null };
  }
  const escaped = testFileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = readme.match(new RegExp(escaped + "[^\\n]*?（(\\d+) 项）"));
  if (!row) {
    console.log("  WARN  G1 自检跳过：README 中未找到 " + testFileName + " 的断言数声明行");
    return { skipped: true, declared: null };
  }
  return { skipped: false, declared: Number(row[1]) };
}

module.exports = { g1ConsistencyCheck };
