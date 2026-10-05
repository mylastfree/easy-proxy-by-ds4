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
  set: path.join(rootDir, "settings.js"),
  // 【V-02】popup.js 此前不是变异目标：R9-01 的守卫（formWasShadowed）与本轮 V-02 的
  //   修复都落在 popup.js；若不纳入变异，新增用例只能靠人工确认「改回恒假会红」。
  //   纳入后 M17/M18 会在每次门禁运行中自动证明那两条用例是承重的。
  popup: path.join(rootDir, "popup.js")
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
  "ownership.test.js",
  "popup.test.js"
].map(function (f) { return path.join(__dirname, f); });

// 换行符处理：
//   变异用的 from/to 片段统一按 LF 书写，但仓库在 Windows 检出时可能是 CRLF。
//   若直接拿含 \n 的片段去匹配 CRLF 文件，会注入失败 —— 这在 CI（Linux）与
//   本地（Windows）之间表现不一致，属于可移植性缺陷。
//   这里读取时把 CRLF 归一为 LF 做匹配，写回时再还原成原文件的风格。
function detectEol(s) { return s.indexOf("\r\n") >= 0 ? "\r\n" : "\n"; }
function toLf(s) { return s.split("\r\n").join("\n"); }
function restoreEol(s, eol) { return eol === "\n" ? s : s.split("\n").join(eol); }

// 【S-1·审计修复】工作区污染判定：变异脚本允许在有未提交改动的开发树上运行
//   （CONTRIBUTING 的提交前自检流程本来就是「先跑变异、后提交」），因此不硬性
//   拒绝脏工作区；但启动时快照 git status，运行结束时若三个变异目标文件
//   （background.js / settings.js / popup.js）出现【启动时没有】的改动行，
//   只可能是变异未还原造成的污染 —— 直接判 BAD 并以非 0 退出。
//   判定刻意只看这三个文件：门禁运行期间维护者对其它文件（文档等）的正常
//   编辑与本门禁无关，不构成污染，也不得因此误报。
//   git 不可用（个别 CI 沙箱）时跳过该核验，不阻塞门禁。
const MUTATION_TARGET_PATHS = ["background.js", "settings.js", "popup.js"];
function mutationTargetSnapshot() {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: rootDir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8"
  });
  if (r.error || r.status !== 0) return null;
  const dirty = new Set();
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    if (line.length > 3 && MUTATION_TARGET_PATHS.indexOf(line.slice(3)) >= 0) {
      dirty.add(line.slice(3));
    }
  }
  return dirty;
}
const dirtyAtStart = mutationTargetSnapshot();
if (dirtyAtStart && dirtyAtStart.size) {
  console.log("提示：变异目标文件存在既有改动（" + dirtyAtStart.size + " 个，已快照）。" +
    "门禁结束时若出现【新增】的目标文件改动，将被判定为变异污染并失败。");
  console.log("");
}

// 【B-3·上线准入修复】变异运行哨兵。
//   事故背景：dist/easy-proxy-by-ds4-2.10.0/popup.js 曾被写入 M22 的变异体
//   （`function activeEditableId() {\n  return null;\n  ...`，与 mutations 里 M22
//   的 to 串逐字节一致）—— 说明打包动作发生在变异运行期间，把变异体复制进了
//   发布产物。一旦这样的产物上传商店，用户拿到的是被故意破坏的代码。
//   处置：开始改写源文件之前落一个哨兵文件，还原时一并清除（挂在同一个幂等函数
//   上，避免「源文件已还原但哨兵仍在」的假锁定）；tools/package.js 见到哨兵即
//   拒绝打包。一个写、一个拒，构成互斥。
const SENTINEL = path.join(rootDir, ".mutation-in-progress");
function removeSentinel() {
  try { fs.rmSync(SENTINEL, { force: true }); } catch (e) { /* 尽力而为 */ }
}

// 【B-4·上线准入修复】残留哨兵守卫 —— 位置必须在 originals 读取【之前】。
//   实测（Windows / Git Bash）：kill -INT 无法触发 Node 的 process.on("SIGINT")
//   处理器，进程退出时五类出口钩子一个都没执行 —— 源文件停留在变异体上、哨兵一并
//   残留。也就是说 S-1 的「信号安全还原」在 Windows 本地开发场景下【实际不生效】，
//   而这一点在 Linux/CI 上永远不会暴露。
//   真正的危险在于：若此时直接重跑，下面的 originals 读到的就是【污染后的内容】，
//   此后所有「还原」都还原成污染体，整个门禁建立在错误基线上，且完全静默。
//   因此启动即拒绝，并给出确切的恢复命令。
//   刻意【不自动 checkout】：工作区可能同时存在维护者的真实未提交改动，
//   静默丢弃不可接受；由人来判断并执行恢复命令，符合本项目「显式失败」的基调。
if (fs.existsSync(SENTINEL)) {
  let info = "";
  try { info = fs.readFileSync(SENTINEL, "utf8").trim(); } catch (e) { /* 尽力而为 */ }
  console.error("检测到残留的变异哨兵：" + SENTINEL + (info ? "（" + info + "）" : ""));
  console.error("这说明上一次变异测试被异常中断，源文件很可能仍停留在变异态。");
  console.error("若在此状态下继续运行，本门禁会把污染内容当作基线。请先恢复现场：");
  console.error("  git checkout -- background.js settings.js popup.js");
  console.error("  rm -f .mutation-in-progress");
  process.exit(1);
}

const originals = {
  bg: fs.readFileSync(targets.bg, "utf8"),
  set: fs.readFileSync(targets.set, "utf8"),
  popup: fs.readFileSync(targets.popup, "utf8")
};

// 匹配用（LF 归一），写回用（原风格）
const norm = {
  bg: toLf(originals.bg),
  set: toLf(originals.set),
  popup: toLf(originals.popup)
};
const eol = {
  bg: detectEol(originals.bg),
  set: detectEol(originals.set),
  popup: detectEol(originals.popup)
};

// 【S-1·审计修复】信号安全还原。此前还原只靠 try/finally：
//   进程被 SIGINT/SIGTERM/kill 或未捕获异常打断时 finally 可能根本不执行 ——
//   实测复现过：background.js 停留在变异体上（`} else if (true) {`），
//   后续所有测试都跑在被污染代码上。现在把还原抽成幂等函数，并注册到
//   exit / SIGINT / SIGTERM / uncaughtException / unhandledRejection 五类出口，
//   任何一条路径退出都会先还原。幂等性：内容与原始一致就跳过写入，
//   重复触发（如 SIGINT 处理器之后再触发 exit）无副作用。
// 【B-3/B-4】哨兵常量与「残留哨兵守卫」定义在文件上方 ——
//   守卫必须早于 originals 读取执行，理由见那一段的注释。
function restoreAll() {
  for (const key of Object.keys(targets)) {
    try {
      if (fs.readFileSync(targets[key], "utf8") !== originals[key]) {
        fs.writeFileSync(targets[key], originals[key]);
      }
    } catch (e) {
      // 还原失败只能尽力而为：exit 钩子里抛错会掩盖原始退出码。
      // 正常路径下的还原结果由结尾的 readback 校验（restored）兜底核验。
    }
  }
  // 【B-3】哨兵与源文件还原同生共死：挂在同一个幂等函数上，
  //   五类退出路径（exit / SIGINT / SIGTERM / uncaughtException /
  //   unhandledRejection）都会走到这里，因此不会留下假锁定。
  removeSentinel();
}
process.on("exit", restoreAll);
process.on("SIGINT", function () { restoreAll(); process.exit(130); });
process.on("SIGTERM", function () { restoreAll(); process.exit(143); });
process.on("uncaughtException", function (err) {
  restoreAll();
  console.error("变异测试自身抛出未捕获异常，已还原源文件：" + ((err && err.stack) || err));
  process.exit(1);
});
process.on("unhandledRejection", function (err) {
  restoreAll();
  console.error("变异测试自身出现未处理的 Promise 拒绝，已还原源文件：" + ((err && err.stack) || err));
  process.exit(1);
});

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
    // 【R9-01】锚点随 onChanged 处理函数新增自愈调用而更新：变异语义不变，
    //   仍然是「暂停期间的存储变化不再记脏」，只删掉 suspendDirty = true 这一行。
    from: "    if (suspendDepth > 0) suspendDirty = true;\n    // 【R9-01】同步（含另一台设备）带来的",
    to: "    // 【R9-01】同步（含另一台设备）带来的",
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
    from: "      core = await applyProxyCore();",
    to: "      if (false) { core = await applyProxyCore(); }",
    expectFail: true
  },
  {
    // 第六轮 R6-01：窗口收尾必须真正【消费 applyProxyCore 的返回值】，并显式排除 overridden。
    //   恒真清脏会把 error / saved_not_applied / 被接管 一并当成"恢复成功"：
    //   既丢掉"恢复未完成"的如实上报，也丢掉待下发标记。
    name: "M14 窗口收尾恒真清脏（R6-01 回归：不消费返回值、不排除 overridden）",
    target: "bg",
    from: "    } else if (!result.restoreFailed && core && core.ok === true && core.status !== \"overridden\") {",
    to: "    } else if (true) {",
    expectFail: true
  },
  {
    // 第六轮 R6-03：普通成功下发路径同样必须【消费脏标记】。
    //   否则"接管期间记脏、接管解除后重放成功"这条链会把 dirty 一路留给后续窗口，
    //   使一次用户根本没改配置的对比测试误报"有配置变更待下发"。
    name: "M15 普通成功路径不再清脏（R6-03 回归：脏标记跨窗口遗留）",
    target: "bg",
    from: "  if (core && core.ok === true && core.status !== \"overridden\") {",
    to: "  if (false) {",
    expectFail: true
  },
  {
    // 第六轮 D-2：chrome.proxy.settings.onChange 的回查必须是【只读】的 ——
    //   外部接管/释放时只能刷新状态，绝不能顺手把我们的配置写回去夺权。
    //   这里在"每次回查都会经过"的回调顶部注入一次真实写回，
    //   ownership 的「不得发生我方夺权式写回」断言必须变红。
    //   【选点说明 · 实测依据】写回的捕获断言全部由 fireProxyChange 驱动，而现有用例
    //   都不给回查挂 get 钩子，因此"回读失败"分支(this 块内 if (!d))恒不可达 ——
    //   把写回塞进那个分支等于注入了一段死代码，变异会假性放行(MISS)，护栏形同虚设。
    name: "M16 只读回查里发生夺权式写回（D-2 回归：外部接管被我方覆盖）",
    target: "bg",
    from: "  readProxyDetails().then(function (d) {",
    to: "  readProxyDetails().then(function (d) {\n    setProxy({ mode: \"fixed_servers\", rules: { singleProxy: { scheme: \"socks5\", host: \"127.0.0.1\", port: \"10808\" } } }).catch(function () {});",
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
  },
  {
    // 【V-02 第 1 层】把「遮蔽现场 + 超长 → 零写入拒绝」改成恒假：
    //   代码会掉进 formWasShadowed 分支，把【超长的表单值】写进 sync —— 在真实
    //   Chrome 上那是必然 lastError 失败、用户却看到「已保存」。
    //   R9-01-F7（零写入）必须变红。
    name: "M17 遮蔽现场超长拒绝层恒假（V-02 回归：超长值被写进 sync）",
    target: "popup",
    from: "  if (formWasShadowed && oversize) {",
    to: "  if (false) {",
    expectFail: true
  },
  {
    // 【V-02 第 2 层】入口分支判定退化为恒假 —— 等价于 R9-01 修复前的状态：
    //   超长值走 oversize 分支，直接 setStorage("local", {bypassList: 表单值})，
    //   覆盖用户唯一副本。R9-01-F3 / R9-01-F4 必须变红。
    //
    //   【2.8.0（S1）锚点更新 · 如实记录】S1 给 clearLocalBypassIfAny 增加了
    //   纵深防御第二层（传入 formWasShadowed 快照，遮蔽现场绝不写 local）。
    //   该层与「chain 的 formWasShadowed 分支」互为冗余 —— 冗余意味着【单点】
    //   变异（只改 chain 分支）会被另一层接住而不再产生可观测危害，原 M18 锚点
    //   因此失效（2.8.0 门禁实测 MISS）。这里改变异【快照点】本身：
    //   var formWasShadowed = loadedShadowed  →  false。它是两层防线的共同输入，
    //   击穿它 = 两层同时失效 = 完整回到 R9-01 修复前的数据丢失路径。
    name: "M18 遮蔽现场快照退化为恒假（V-02 回归：oversize 分支覆盖 local 唯一副本）",
    target: "popup",
    from: "  var formWasShadowed = loadedShadowed;",
    to: "  var formWasShadowed = false;",
    expectFail: true
  },
  {
    // 【S1】load() 里的遮蔽现场标记（loadedShadowed）是「存量编辑形态不清空 local」
    //   的守门者：判据已收敛到 S.isLegacyShadowPair（同时覆盖「逐字符相等」与
    //   「默认列表+编辑」两种形态）。把它变异成恒假 = 退回 2.7.1 的失明状态：
    //   存量污染现场（sync = 默认列表+编辑、local = 用户唯一副本）下用户点一次
    //   保存就会经 clearLocalBypassIfAny 把 local 写空（不可逆数据丢失）。
    //   popup 的 S1 用例（含 R9-01-F3/F4 零写入断言）必须变红。
    name: "M19 遮蔽现场标记退化为恒假（S1 回归：存量编辑形态保存清空 local 唯一副本）",
    target: "popup",
    from: "      loadedShadowed = shadowed;",
    to: "      loadedShadowed = false;",
    expectFail: true
  },
  {
    // 【C-2】onProxyError 的处理体被架空：代理运行时错误（含 fatal 透传）不再上报。
    //   此前 5 套测试环境的该监听器桩全是空 addListener，监听器从未被驱动，
    //   这条变异在旧护栏下完全 MISS。ownership 的新 C-2 段（fireProxyError 驱动）
    //   是它的主守门者。
    name: "M20 onProxyError 处理体失效（C-2 回归：代理错误不再上报）",
    target: "bg",
    from: "chrome.proxy.onProxyError.addListener(function (details) {",
    to: "chrome.proxy.onProxyError.addListener(function (details) {\n  return;",
    expectFail: true
  },
  {
    // 【C-1】禁用路径不再清理旧版遗留作用域：老版本升级来的安装关闭开关后，
    //   incognito_persistent / regular_only 的残留继续压制流量而界面宣称直连。
    //   ownership 的 C-1 段（clearCalls 作用域序列断言）是它的主守门者。
    name: "M21 禁用路径不再清理遗留作用域（C-1 回归：状态≠事实）",
    target: "bg",
    from: "        await clearProxyScope(LEGACY_SCOPES[li]);",
    to: "        ;",
    expectFail: true
  },
  {
    // 【M-1】表单重绘的焦点保护失效：storage 变化触发的 load() 会整体重绘表单，
    //   覆盖用户正在输入的内容（后台自愈写 sync.bypassList='' 即触发）。
    //   popup 的 M-1 段（activeElement 焦点保护断言）是它的主守门者。
    name: "M22 表单重绘焦点保护失效（M-1 回归：覆盖用户输入）",
    target: "popup",
    from: "function activeEditableId() {\n  var ae = document.activeElement;",
    to: "function activeEditableId() {\n  return null;\n  var ae = document.activeElement;",
    expectFail: true
  },
  {
    // 【M-6】含冒号 host 的 IPv6 形态校验失效：example.com:8080:90、host:abc 等
    //   Chrome 必拒写法重新漏到 set 阶段并被归因为「代理异常」。
    //   settings 的 M-6 段（validateSettings 拒绝断言）是它的主守门者。
    name: "M23 含冒号 host 的 IPv6 形态校验失效（M-6 回归：必拒写法漏放）",
    target: "set",
    from: "    } else if (s.proxyHost.indexOf(':') >= 0 && !isIpV6Shape(s.proxyHost)) {",
    to: "    } else if (false) {",
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

// 【B-3】进入变异循环前落哨兵，让并发进行的打包动作立刻失败。
//   写不进去就中止门禁：宁可这次不跑变异，也不能在「无法声明自己正在变异」
//   的状态下改写源文件 —— 那正是事故发生时无人察觉的窗口。
try {
  fs.writeFileSync(SENTINEL, JSON.stringify({ pid: process.pid, at: Date.now() }));
} catch (e) {
  console.error("无法写入变异哨兵文件（" + SENTINEL + "），" +
    "为避免产出被污染的发布包，门禁中止：" + ((e && e.message) || e));
  process.exit(1);
}

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
  restoreAll();
}

console.log("变异测试结果：");
for (const r of rows) {
  const tag = r[4] ? "BAD " : (r[3] ? "OK  " : "MISS");
  console.log("  [" + tag + "] " + r[0]);
  console.log("           预期 " + r[1] + " / 实际 " + r[2]);
}

const restored = fs.readFileSync(targets.bg, "utf8") === originals.bg &&
                 fs.readFileSync(targets.set, "utf8") === originals.set &&
                 fs.readFileSync(targets.popup, "utf8") === originals.popup;

// 【S-1】工作区污染终检：与启动快照比对，变异目标文件的任何新增改动都判为污染。
const dirtyAtEnd = mutationTargetSnapshot();
let newDirty = [];
if (dirtyAtStart && dirtyAtEnd) {
  newDirty = [...dirtyAtEnd].filter(function (f) { return !dirtyAtStart.has(f); });
  console.log("变异目标文件新增改动（污染判定）：" +
    (newDirty.length ? JSON.stringify(newDirty) : "无"));
}
console.log("");
console.log("达标 " + ok + " 项，未达标 " + miss + " 项，注入失败 " + injectFail + " 项，" +
  "门禁自身失效(BAD) " + bad + " 项");
console.log("原文件已恢复：" + (restored ? "是" : "否"));
process.exit((miss > 0 || injectFail > 0 || bad > 0 || !restored || newDirty.length > 0) ? 1 : 0);
