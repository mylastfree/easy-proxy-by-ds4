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
//   【M-1·审计修复】这句此前是假的：仓库当时没有 .gitattributes，工作树行尾只能依赖
//   各人的 core.autocrlf（一个本机配置、不随仓库分发）—— 实测 Windows 检出为 CRLF、
//   Linux CI 为 LF，同一提交打包出的 .js/.html/.json 字节因此不同；而下面的产物自校验
//   只比对【同一工作树内】的源文件与产物，结构上不可能发现跨平台差异。
//   现在行尾由仓库内的 .gitattributes（`* text=auto eol=lf`）钉死 —— 属性优先于
//   core.autocrlf，本声明才成立。tests/manifest.test.js 对该文件有断言，
//   删掉它或放宽该规则即门禁变红。
//
// 【M-2·审计修复】本脚本是发布产物的唯一来源，此前零测试、CI 不跑打包。
//   现在把「清单校验」与「复制动作」抽成可注入 destRoot 的纯函数并导出，
//   tests/manifest.test.js 直接对它们断言（产物清单、排除契约、逐字节保真）；
//   脚本本体仅在直接执行时调用 runCli()，被 require 时零副作用。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");

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
const MUTATION_SENTINEL = path.join(REPO_ROOT, ".mutation-in-progress");

// 【B-5】destRoot 是否落在系统临时目录内（两侧都取 realpath，防软链绕过）。
function isInsideOsTmp(p) {
  try {
    const tmp = fs.realpathSync(os.tmpdir());
    const dest = fs.realpathSync(p);
    const rel = path.relative(tmp, dest);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch (e) {
    return false;
  }
}

function assertNoMutationInProgress(destRoot, opts) {
  if (!fs.existsSync(MUTATION_SENTINEL)) return;

  // 【B-5·自检例外】tests/manifest.test.js 需要在变异门禁运行期间照常验证
  //   「打包可复现性」，而门禁的哨兵此时必然在位。若一律拒绝，那 6 条产物断言
  //   在门禁里必然失败 —— 后果是把【等价变异体 M1（expectFail:false）】误判成
  //   「被拦截」，门禁从 23/23 掉到 22/23（实测：CI run 37290295856 三 Node 全红）。
  //   例外被两重条件同时收紧，不构成绕过通道：
  //     ① 调用方必须显式传 { selfCheck: true } —— 发布 CLI（main）永不传；
  //     ② 目标目录必须落在系统临时目录内 —— 临时目录里的产物不可能被发布。
  //   tests/manifest.test.js 同时断言「非临时目录 + selfCheck:true 仍然拒绝」，
  //   把这条边界钉死在测试里，防止日后被改成无条件放行。
  if (opts && opts.selfCheck === true && isInsideOsTmp(destRoot)) return;

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
// opts.selfCheck=true 仅供测试自检使用，且仅在 destRoot 位于系统临时目录时生效
// （见 assertNoMutationInProgress 的说明）；发布路径永远不传它。
// opts.root 可覆盖「源文件根目录」（默认仓库根）—— 仅供测试注入一个夹具目录，
//   使「清单遗漏 / 源文件缺失 / 产物不一致」三条错误分支都能被确定性地触发与断言
//   （【L-2·审计修复】：此前这些分支连一次都不会被执行）。发布路径永远不传它。
function pack(destRoot, opts) {
  assertNoMutationInProgress(destRoot, opts);

  const o = opts || {};
  const srcRoot = o.root || REPO_ROOT;
  const manifest = JSON.parse(fs.readFileSync(path.join(srcRoot, "manifest.json"), "utf8"));
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
    const src = path.join(srcRoot, f);
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
    const srcBuf = fs.readFileSync(path.join(srcRoot, f));
    const outBuf = fs.readFileSync(path.join(dest, f));
    if (!srcBuf.equals(outBuf)) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new Error("产物与源文件不一致（" + f + "）：源文件在打包过程中被改动，" +
        "产物已删除。请确认没有其它进程（如变异测试）在改写源文件后重试。");
    }
  }

  return { dest, version, copied };
}

// 【L-2·工作区报告修复】清理同前缀的旧版产物目录。
//   背景：dist/ 下曾长期并存 easy-proxy-by-ds4-2.11.0 与 …-2.13.0，而源码已推进到更高版本
//   —— 使用者按习惯直接加载 / 上传 dist/ 下的目录时会选中旧版本。「旧产物还在那儿」本身
//   就是诱因（README 的警示只能提醒，不能消除诱因）。
//   三条约束（均由 tests/manifest.test.js 断言把守）：
//     ① 只在【打包成功之后】由 runCli 调用 —— 打包失败时不得动任何既有产物，
//        否则会把「上一次可用的产物」也毁掉，越修越坏；
//     ② 不删刚生成的 keepDir；且只删【同前缀 + 版本号形态】的目录 ——
//        避免误伤 `easy-proxy-by-ds4-backup` 这类同名但非版本的目录；
//     ③ 位于 pack() 之外 —— pack() 的产物字节是发布契约（有逐字节断言把守），
//        目录级清理是 CLI 的副作用，不该混进产物生成逻辑。
const VERSION_DIR_RE = /^easy-proxy-by-ds4-\d+\.\d+\.\d+/;

// 返回被删除的目录名数组（纯副作用函数，失败不抛错 —— 清理失败不该影响打包结果）。
function cleanStaleArtifacts(destRoot, keepDir) {
  const removed = [];
  let names;
  try {
    names = fs.readdirSync(destRoot);
  } catch (e) {
    return removed; // destRoot 不存在等：无可清理
  }
  for (const n of names) {
    if (!VERSION_DIR_RE.test(n)) continue;
    const full = path.join(destRoot, n);
    if (path.resolve(full) === path.resolve(keepDir)) continue;
    try {
      if (fs.statSync(full).isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(n);
      }
    } catch (e) {
      /* 尽力而为 */
    }
  }
  return removed;
}

// CLI 入口的可注入实现（【L-2·审计修复】）。
//   此前这些逻辑直接写在 main() 里并调用 process.exit，而 .c8rc.json 又把 tools/**
//   整个排除在覆盖率统计之外 —— 结果是「发布产物的唯一来源」这个脚本自身零覆盖，
//   连失败分支都从没被执行过（审计据此判定 L-2）。
//   现在把入口收成 runCli()：副作用（打印/失败的退出码）都可注入，
//   函数体返回退出码而不结束进程，因此成功与失败两条路径都能被测试覆盖。
//   直接执行时的行为逐字保持不变（仍然是同步打包 + 同样的退出码）。
function runCli(opts) {
  const o = opts || {};
  const packOpts = o.packOpts;
  const srcRoot = (packOpts && packOpts.root) || REPO_ROOT;
  const destRoot = o.destRoot || path.join(REPO_ROOT, "dist");
  const log = o.log || console.log;
  const logErr = o.logErr || console.error;
  try {
    const { dest, version, copied } = pack(destRoot, packOpts);
    log("打包 easy-proxy-by-ds4 v" + version + " -> " + path.relative(srcRoot, dest));
    for (const f of copied) {
      log("  + " + f + "  (" + fs.statSync(path.join(srcRoot, f)).size + " B)");
    }
    log("");
    log("已排除非运行文件：tests/、.github/、docs、元文件与依赖目录。");
    // 【L-2·工作区报告修复】打包成功后才清理旧版产物（约束 ①：失败时不动既有产物）。
    const stale = cleanStaleArtifacts(destRoot, dest);
    if (stale.length) log("已清理旧版产物：" + stale.join("、"));
    log("产物就绪：" + path.relative(srcRoot, dest));
    return 0;
  } catch (e) {
    logErr("错误：" + (e && e.message || e));
    return 1;
  }
}

if (require.main === module) process.exit(runCli());

module.exports = { RUNTIME_FILES, missingFromManifest, pack, runCli, cleanStaleArtifacts };
