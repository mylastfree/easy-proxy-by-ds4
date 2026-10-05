#!/usr/bin/env node
// tools/package.js —— 可复现的发布打包脚本（A3）
// 运行：node tools/package.js
//
// 背景：此前直接把整个仓库目录当扩展加载/打包，tests/（约 300 KB，含 child_process
//   用法）、.github/、CHANGELOG.md 等非运行文件会一并进入发布产物，扩大包体与攻击面。
// 本脚本从 manifest.json 读取版本号，把【仅运行时需要的文件】复制到
//   dist/easy-proxy-by-ds4-<version>/，并打印产物清单供人工核对。
// 可复现性：产物内容完全由文件清单决定，清单与 manifest.version 进 git，任何人在
//   任意机器上对同一提交执行本脚本都得到逐字节相同的产物（纯复制，无构建步骤）。
//
// 【M-2·审计修复】本脚本是发布产物的唯一来源，此前零测试、CI 不跑打包。
//   现在把「清单校验」与「复制动作」抽成可注入 destRoot 的纯函数并导出，
//   tests/manifest.test.js 直接对它们断言（产物清单、排除契约、逐字节保真）；
//   脚本本体仅在直接执行时进入 main()，被 require 时零副作用。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

// 运行时文件清单 = manifest 直接或间接引用的文件 + manifest 自身。
// 新增源文件时必须同步此清单（清单缺失会在 missingFromManifest / pack 中报错）。
const RUNTIME_FILES = [
  "manifest.json",
  "settings.js",
  "background.js",
  "popup.html",
  "popup.js",
  "icon-red-16.png",
  "icon-red-32.png",
  "icon-red-48.png",
  "icon-red-128.png",
  "icon-green-16.png",
  "icon-green-32.png",
  "icon-green-48.png",
  "icon-green-128.png"
];

// 校验：manifest 引用到的每个文件都必须在清单里（防止加文件忘了同步）。
// 纯函数：不读盘、不退出进程，返回缺失文件数组（空数组 = 通过）。
function missingFromManifest(manifest, files) {
  const list = files || RUNTIME_FILES;
  const referenced = new Set();
  referenced.add(manifest.background && manifest.background.service_worker);
  referenced.add(manifest.action && manifest.action.default_popup);
  for (const k of Object.keys(manifest.icons || {})) referenced.add(manifest.icons[k]);
  for (const k of Object.keys((manifest.action && manifest.action.default_icon) || {})) {
    referenced.add(manifest.action.default_icon[k]);
  }
  return [...referenced].filter(f => f && !list.includes(f));
}

// 【B-3·上线准入修复】与 tests/mutation-check.js 的哨兵互斥。
//   事故背景：dist/easy-proxy-by-ds4-2.10.0/popup.js 曾被写入 M22 的变异体
//   （activeEditableId 被改成恒返回 null，即「焦点保护失效」）—— 打包动作
//   发生在变异运行期间，把故意破坏的代码复制进了发布产物。若当时上传商店，
//   用户拿到的就是被破坏的版本。本脚本是发布产物的唯一来源，必须自己拦住它。
const MUTATION_SENTINEL = path.join(root, ".mutation-in-progress");

function assertNoMutationInProgress() {
  if (!fs.existsSync(MUTATION_SENTINEL)) return;
  let info = "";
  try { info = fs.readFileSync(MUTATION_SENTINEL, "utf8").trim(); } catch (e) { /* 尽力而为 */ }
  throw new Error(
    "检测到变异测试正在运行（哨兵 " + path.basename(MUTATION_SENTINEL) + " 存在" +
    (info ? "：" + info : "") + "）。变异期间源文件处于被改写状态，" +
    "打包会把变异体写入发布产物。请等变异结束（它会自动清除哨兵）后重试；" +
    "若确认变异进程已不在运行，手动删除该文件即可。"
  );
}

// 打包到 <destRoot>/easy-proxy-by-ds4-<version>/，返回 { dest, version, copied }。
// 纯复制，无构建步骤；发现清单缺失或源文件不存在时抛错（由调用方决定如何呈现）。
function pack(destRoot) {
  assertNoMutationInProgress();

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const version = manifest.version;
  const missing = missingFromManifest(manifest);
  if (missing.length) {
    throw new Error("manifest 引用的文件未包含在打包清单中：" + missing.join(", "));
  }
  const dest = path.join(destRoot, "easy-proxy-by-ds4-" + version);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const f of RUNTIME_FILES) {
    const src = path.join(root, f);
    if (!fs.existsSync(src)) {
      throw new Error("清单中的文件不存在：" + f);
    }
    fs.copyFileSync(src, path.join(dest, f));
    copied.push(f);
  }

  // 【B-3】产物自校验：复制完成后，产物必须与源文件逐字节一致。
  //   哨兵那层覆盖「变异已在运行」，这一层覆盖「打包过程中源文件被并发改写」
  //   （含变异恰好在打包中途开始）。两层互补，缺一层就会漏。
  //   检出即删除产物目录，绝不留下「看起来已就绪」的污染产物。
  for (const f of RUNTIME_FILES) {
    const srcBuf = fs.readFileSync(path.join(root, f));
    const outBuf = fs.readFileSync(path.join(dest, f));
    if (!srcBuf.equals(outBuf)) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new Error("产物与源文件不一致（" + f + "）：源文件在打包过程中被改动，" +
        "产物已删除。请确认没有其它进程（如变异测试）在改写源文件后重试。");
    }
  }

  return { dest, version, copied };
}

function main() {
  try {
    const { dest, version, copied } = pack(path.join(root, "dist"));
    console.log("打包 easy-proxy-by-ds4 v" + version + " -> " + path.relative(root, dest));
    for (const f of copied) {
      console.log("  + " + f + "  (" + fs.statSync(path.join(root, f)).size + " B)");
    }
    console.log("");
    console.log("已排除非运行文件：tests/、.github/、docs、元文件与依赖目录。");
    console.log("产物就绪：" + path.relative(root, dest));
  } catch (e) {
    console.error("错误：" + (e && e.message || e));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { RUNTIME_FILES, missingFromManifest, pack };
