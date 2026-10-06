// tests/manifest.test.js —— 扩展清单与文件引用完整性校验
// 运行：node tests/manifest.test.js
//
// 覆盖 Chrome 扩展最常见的加载失败原因：清单字段缺失、引用了不存在的文件、
// 权限过度申请、HTML 与 JS 之间的元素 ID 不一致。
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}
function exists(rel) { return fs.existsSync(path.join(rootDir, rel)); }
function read(rel) { return fs.readFileSync(path.join(rootDir, rel), "utf8"); }

console.log("== manifest.json 结构 ==");
let mf = null;
try {
  mf = JSON.parse(read("manifest.json"));
  t("是合法 JSON", true);
} catch (e) {
  t("是合法 JSON", false, e.message);
  console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(1);
}

t("manifest_version 为 3", mf.manifest_version === 3, String(mf.manifest_version));
t("name 是非空字符串", typeof mf.name === "string" && mf.name.length > 0);
t("version 符合 Chrome 版本格式",
  typeof mf.version === "string" && /^\d+(\.\d+){0,3}$/.test(mf.version), String(mf.version));
t("description 非空且不超过 132 字符",
  typeof mf.description === "string" && mf.description.length > 0 && mf.description.length <= 132,
  "长度 " + (mf.description ? mf.description.length : "无"));
t("声明了 minimum_chrome_version", typeof mf.minimum_chrome_version === "string");

console.log("");
console.log("== 发布一致性：manifest.version 与 CHANGELOG 首条必须对齐 ==");
{
  // R3-02：tag v2.2.1 与 manifest 2.2.0 错位的教训 —— 发布标签、清单版本与
  // 变更记录三者不一致时，追溯和"用户到底装到哪个版本"都会失真。
  // 这里只校验可机读的两端（清单 vs 变更记录）；Git tag 语义由发布流程把关。
  const changelog = read("CHANGELOG.md");
  const firstEntry = (changelog.match(/^## \[([^\]]+)\]/m) || [])[1] || "";
  t("CHANGELOG 首条版本号符合 X.Y.Z 格式",
    /^\d+\.\d+\.\d+$/.test(firstEntry), "首条 = " + JSON.stringify(firstEntry));
  t("manifest.version 与 CHANGELOG 首条版本一致",
    firstEntry === mf.version, "manifest=" + mf.version + " / CHANGELOG=" + firstEntry);
}

console.log("");
console.log("== 发布一致性：三个源文件头 [vX.Y.Z] 必须与 manifest.version 对齐 ==");
{
  // 【B-2·审计修复】CONTRIBUTING.md 声明「版本号必须四处同步：manifest.json、
  //   三个源文件头（[vX.Y.Z]）、README.md、CHANGELOG.md 首条 —— tests/manifest.test.js
  //   与各文件的 G1 自检会拦截不一致」。
  //   但实测这条断言此前【根本不存在】：2.10.0 提交里 background.js / popup.js /
  //   settings.js 的文件头仍停留在 [v2.9.0]（提交改了 background.js 50 行、
  //   popup.js 28 行，唯独第 1 行版本号没碰），CI 却一路全绿 ——
  //   文档承诺的门禁是【假的】。这里补上，让声明变成事实。
  //
  //   额外一条「正则必须匹配到每个文件」是必需的：若只做逐文件比对，
  //   一旦文件头格式漂移（例如去掉 [vX.Y.Z] 标记），match 返回 null，
  //   比对会因 undefined === undefined 之外的情形而静默通过 —— 重演同一个坑。
  const SRC_FILES = ["background.js", "popup.js", "settings.js"];
  const headerVersion = (src) => {
    const m = src.match(/^\/\/[^\n]*\[v(\d+\.\d+\.\d+)\]/m);
    return m ? m[1] : null;
  };
  const declared = SRC_FILES.map((f) => headerVersion(read(f)));
  t("三个源文件都能解析出版本头 [vX.Y.Z]（防格式漂移导致静默通过）",
    declared.every((v) => v !== null),
    SRC_FILES.map((f, i) => f + "=" + JSON.stringify(declared[i])).join("；"));
  SRC_FILES.forEach((f, i) => {
    t(f + " 文件头版本与 manifest.version 一致",
      declared[i] === mf.version,
      f + "=" + declared[i] + " / manifest=" + mf.version);
  });
}

console.log("");
console.log("== 权限最小化 ==");
const perms = (mf.permissions || []).slice().sort();
t("权限恰为 proxy + storage",
  JSON.stringify(perms) === JSON.stringify(["proxy", "storage"]), JSON.stringify(perms));
t("未申请 host_permissions", !mf.host_permissions,
  mf.host_permissions ? JSON.stringify(mf.host_permissions) : "");
t("未申请 optional_permissions", !mf.optional_permissions);

console.log("");
console.log("== 清单引用的文件必须存在 ==");
t("action.default_popup 指向的文件存在",
  !!mf.action && exists(mf.action.default_popup), mf.action && mf.action.default_popup);
t("background.service_worker 指向的文件存在",
  !!mf.background && exists(mf.background.service_worker),
  mf.background && mf.background.service_worker);

const iconKeys = Object.keys(mf.icons || {});
t("icons 至少声明一种尺寸", iconKeys.length > 0);
for (const size of iconKeys) {
  t("icons[" + size + "] 文件存在", exists(mf.icons[size]), mf.icons[size]);
}
const actIconKeys = Object.keys((mf.action && mf.action.default_icon) || {});
for (const size of actIconKeys) {
  t("default_icon[" + size + "] 文件存在", exists(mf.action.default_icon[size]),
    mf.action.default_icon[size]);
}

console.log("");
console.log("== HTML / JS 交叉引用 ==");
const html = read("popup.html");
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
t("popup.html 至少引用一个脚本", scripts.length > 0);
for (const s of scripts) t("popup.html 引用的 " + s + " 存在", exists(s));
t("popup.html 设置了 lang 属性", /<html[^>]*lang="[^"]+"/.test(html));
t("popup.html 设置了 charset", /charset=["']?utf-8/i.test(html));

// 【L-1·工作区报告修复】帮助面板用 <pre> 展示「支持哪些写法」，其中 <local> 是**字面量**而非标签。
//   未转义时 HTML 解析器把它当成未知元素，那一行的写法示例直接不显示 —— 用户看不到
//   「不含点的主机名」怎么写，而这一行正是该写法唯一的说明。
//   反向错误同样要拦：把同段的 .local / .lan 一并「顺手转义」会让用户看到 &lt; 之类的乱码，
//   所以这里同时钉住「该转义的转了」与「不该动的没动」。
const helpPre = (html.match(/<pre>([\s\S]*?)<\/pre>/) || [])[1] || "";
t("popup.html 帮助面板可定位且非空（防止本组断言恒真）", helpPre.length > 0);
t("帮助面板中的 <local> 写成转义形式", helpPre.includes("&lt;local&gt;"));
t("popup.html 全文不含未转义的 <local>（会被解析为未知元素）", !/<local[\s>]/.test(html));
t("帮助面板中的 .local / .lan 仍是字面量（未被过度转义）",
  helpPre.includes(".local") && helpPre.includes(".lan") && !helpPre.includes("&amp;lt;"));

const bg = read("background.js");
const imports = [...bg.matchAll(/importScripts\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
t("background.js 至少 importScripts 一个文件", imports.length > 0);
for (const i of imports) t("importScripts 引用的 " + i + " 存在", exists(i));

// background.js 与 popup.html 都必须能拿到 settings.js 暴露的命名空间
const settingsJs = read("settings.js");
t("settings.js 暴露 EasyProxy 命名空间", /root\.EasyProxy\s*=/.test(settingsJs));

// background.js 会在运行时 setIcon，其引用的图标也必须真实存在。
// 这类图标不必出现在 manifest 的 icons 里（setIcon 可指定任意已打包文件），
// 但文件缺失会导致状态切换时图标不更新，因此单独校验。
const bgIconRefs = [...new Set((bg.match(/icon-(?:red|green)-\d+\.png/g) || []))];
t("background.js 至少引用一个图标", bgIconRefs.length > 0);
for (const f of bgIconRefs) {
  t("background.js 引用的 " + f + " 存在", exists(f), f);
}

console.log("");
console.log("== popup.js 引用的元素 ID 都存在于 popup.html ==");
const popupJs = read("popup.js");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const usedIds = [...popupJs.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]);
t("popup.js 有引用元素", usedIds.length > 0);
const missingIds = usedIds.filter(id => !htmlIds.has(id));
t("无悬空引用（引用的 ID 全部存在）", missingIds.length === 0,
  missingIds.length ? "缺失: " + missingIds.join(", ") : "");

console.log("");
console.log("== CI 必须先跑所有权测试，再跑变异 ==");
{
  const ci = read(".github/workflows/ci.yml");
  const ownAt = ci.indexOf("node tests/ownership.test.js");
  const mutAt = ci.indexOf("node tests/mutation-check.js");
  t("CI 含独立的 ownership 步骤", ownAt >= 0);
  t("ownership 步骤位于变异步骤之前", ownAt >= 0 && mutAt > ownAt,
    "ownership=" + ownAt + " mutation=" + mutAt);
}

console.log("");
console.log("== 发布 tag 与 manifest.version 一致性（R3-02）==");
{
  // 说明：门禁【只校验】，不创建也不移动任何 tag —— 创建正式 tag 属于发布动作。
  //   触发条件为 tag push 时，CI 另有一步硬断言；这里做本地软校验：
  //   git 不可用或当前提交没有 tag 时不计失败（避免日常开发误报），
  //   但只要存在指向 HEAD 的 tag，它就必须等于 v{version}。
  let tagAtHead = null, gitAvailable = true;
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("git", ["tag", "--points-at", "HEAD"], {
      cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
    tagAtHead = out ? out.split(/\r?\n/).filter(Boolean) : [];
  } catch (e) { gitAvailable = false; }

  const version = read("manifest.json") && JSON.parse(read("manifest.json")).version;
  if (!gitAvailable) {
    console.log("  SKIP  git 不可用，跳过发布 tag 一致性校验");
  } else if (tagAtHead === null || tagAtHead.length === 0) {
    console.log("  SKIP  当前提交没有 tag（候选提交），跳过发布 tag 一致性校验");
  } else {
    for (const tag of tagAtHead) {
      // 【G1 计数稳定性】本断言只在「tag 触发」的运行里出现，若计入 pass，
      //   同一份代码在候选提交（无 tag）与发布提交（有 tag）上的通过数会差 1，
      //   README 的声明数就无法同时匹配两者。因此不计入 pass 计数：
      //   失败照常 fail++（CI 变红），成功只打印日志。
      if (tag === "v" + version) {
        console.log("  PASS  指向 HEAD 的 tag " + tag + " 与 manifest.version 一致（v" + version + "）");
      } else {
        fail++;
        console.log("  FAIL  指向 HEAD 的 tag " + tag + " 与 manifest.version 不一致（应为 v" + version + "）  -> tag=" + tag + " version=" + version);
      }
    }
  }
  t("manifest.json 能读出 version", typeof version === "string" && version.length > 0, String(version));
}

console.log("");
console.log("== 文档声明数一致性（G1：合计 = 各行之和；变异数与脚本一致）==");
{
  // 【G1】README 的「合计 N 项断言」必须等于其表格各行声明数之和 ——
  //   每行的数值是否与实际一致由各测试文件结尾的 G1 运行期自检把守，
  //   这里守的是「行与合计之间」的算术一致性，两层合起来文档漂移必然红。
  const readme = read("README.md");
  const rows = [...readme.matchAll(/tests\/[\w-]+\.test\.js[^\n]*?（(\d+) 项）/g)].map(m => Number(m[1]));
  t("README 测试表能解析出 7 行断言数声明", rows.length === 7, "解析到 " + rows.length + " 行");
  const total = (readme.match(/合计 \*\*(\d+) 项断言\*\*/) || [])[1];
  t("README 的合计断言数 = 各行声明数之和",
    !!total && Number(total) === rows.reduce((a, b) => a + b, 0),
    "合计=" + total + "；各行=" + JSON.stringify(rows) + "；和=" + rows.reduce((a, b) => a + b, 0));

  // 【M-3·审计修复】覆盖率此前是唯一「只报告、不拦截」的质量数字：
  //   断言数漂移会让 CI 变红，覆盖率退化却什么都不发生 —— 门禁全绿但护栏变稀。
  //   两条断言把机制钉住，且**刻意不读取 coverage/lcov.info**：那份报告只在
  //   `npm run coverage`（c8 包装）下才存在，用它做断言会让测试依赖环境，
  //   与本仓库「测试必须环境无关」的硬约束冲突（读不到就跳过的写法同样不可接受，
  //   那等于在 CI 里静默失效）。因此只做静态契约校验。
  const c8rc = JSON.parse(read(".c8rc.json"));
  t("覆盖率门禁已开启且四类门槛齐全（check-coverage + lines/statements/functions/branches）",
    c8rc["check-coverage"] === true &&
    ["lines", "statements", "functions", "branches"].every(k => typeof c8rc[k] === "number"),
    JSON.stringify(c8rc));
  t("README 的覆盖率声明同时给出行覆盖与分支覆盖（防止只报好看的那一个数）",
    readme.indexOf("行覆盖") >= 0 && readme.indexOf("分支覆盖") >= 0,
    "README 覆盖率段缺失行覆盖或分支覆盖");

  // 【L-05·审计修复】status / reason 取值的双向一致性契约。
  //   事实来源 = settings.js 的 STATUS / REASON 清单。两侧都必须与它一致：
  //     ① 写入方（background.js）实际写出的字面量集合；
  //     ② 渲染方（popup.js）提供的文案键集合（status 用本身，reason 用 error_<reason>）。
  //   实测缺口即由此暴露：reason:"restore_interrupted" 此前在 popup 无文案，
  //   落到泛化的 error 档「代理异常，流量可能已回退直连」——语义恰好相反。
  //   刻意做静态检查（不读 coverage 之类环境产物），保证测试环境无关。
  const settingsForStates = read("settings.js");
  const declaredStatus = [...((settingsForStates.match(/var STATUS = \[([^\]]*)\]/) || [])[1] || "")
    .matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  const declaredReason = [...((settingsForStates.match(/var REASON = \[([^\]]*)\]/) || [])[1] || "")
    .matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  const bgForStates = read("background.js");
  const writtenStatus = [...new Set([...bgForStates.matchAll(/status:\s*"([a-z_]+)"/g)].map(m => m[1]))].sort();
  const writtenReason = [...new Set([...bgForStates.matchAll(/reason:\s*"([a-z_]+)"/g)].map(m => m[1]))].sort();
  t("L-05-a background.js 写出的 status 集合 = settings.js 的 STATUS 清单",
    declaredStatus.length > 0 && declaredStatus.join(",") === writtenStatus.join(","),
    "声明=" + JSON.stringify(declaredStatus) + "；实际写出=" + JSON.stringify(writtenStatus));
  t("L-05-b background.js 写出的 reason 集合 = settings.js 的 REASON 清单",
    declaredReason.length > 0 && declaredReason.join(",") === writtenReason.join(","),
    "声明=" + JSON.stringify(declaredReason) + "；实际写出=" + JSON.stringify(writtenReason));

  const popupForStates = read("popup.js");
  const statusTextBlock = (popupForStates.match(/var STATUS_TEXT = \{([\s\S]*?)\n\};/) || [])[1] || "";
  const textKeys = [...statusTextBlock.matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1]);
  const missingStatusText = declaredStatus.filter(s => textKeys.indexOf(s) < 0);
  t("L-05-c popup 为每个 status 提供 STATUS_TEXT 文案（否则静默落兜底「状态未知」）",
    textKeys.length > 0 && missingStatusText.length === 0,
    "缺=" + JSON.stringify(missingStatusText) + "；已有键=" + JSON.stringify(textKeys));
  const missingReasonText = declaredReason.filter(r => textKeys.indexOf("error_" + r) < 0);
  t("L-05-d popup 为每个 reason 提供 error_<reason> 文案",
    missingReasonText.length === 0, "缺=" + JSON.stringify(missingReasonText));

  // 【G1】变异数同理：README 声明的变异数必须与 tests/mutation-check.js 实际定义数一致
  const mutationSrc = read("tests/mutation-check.js");
  const mutationCount = (mutationSrc.match(/expectFail:/g) || []).length;
  const declaredMut = (readme.match(/（(\d+) 项变异）/) || [])[1] ||
                      (readme.match(/(\d+) 项变异全部被拦截/) || [])[1];
  t("README 声明的变异数与 mutation-check.js 实际定义数一致",
    !!declaredMut && Number(declaredMut) === mutationCount,
    "README=" + (declaredMut || "未声明") + "；实际=" + mutationCount);

  // 【S-2·审计修复】G1 扩展：CONTRIBUTING.md / ARCHITECTURE.md / ci.yml 里的同类
  //   数值声明此前只靠人工维护，已经漂移过一次（文档写 616/19/18，实际 683/23）。
  //   现在与 README 同规则把守：凡出现数值声明，必须与实际一致，漂移即 CI 变红。
  const totalAsserts = rows.reduce((a, b) => a + b, 0);
  const contrib = read("CONTRIBUTING.md");
  const arch = read("ARCHITECTURE.md");
  const ciSrc = read(".github/workflows/ci.yml");
  const contribAsserts = (contrib.match(/功能测试（(\d+) 项断言/) || [])[1];
  t("CONTRIBUTING.md 声明的断言数与实际一致",
    !!contribAsserts && Number(contribAsserts) === totalAsserts,
    "CONTRIBUTING=" + (contribAsserts || "未声明") + "；实际=" + totalAsserts);
  const contribMut = (contrib.match(/变异门禁（(\d+) 项/) || [])[1];
  t("CONTRIBUTING.md 声明的变异数与实际一致",
    !!contribMut && Number(contribMut) === mutationCount,
    "CONTRIBUTING=" + (contribMut || "未声明") + "；实际=" + mutationCount);
  const archAsserts = (arch.match(/功能测试（(\d+) 项断言/) || [])[1];
  t("ARCHITECTURE.md 声明的断言数与实际一致",
    !!archAsserts && Number(archAsserts) === totalAsserts,
    "ARCHITECTURE=" + (archAsserts || "未声明") + "；实际=" + totalAsserts);
  const archMut = (arch.match(/变异门禁（(\d+) 项/) || [])[1];
  t("ARCHITECTURE.md 声明的变异数与实际一致",
    !!archMut && Number(archMut) === mutationCount,
    "ARCHITECTURE=" + (archMut || "未声明") + "；实际=" + mutationCount);
  const ciMut = (ciSrc.match(/完整变异门禁（(\d+) 个变异）/) || [])[1];
  t("ci.yml 注释中的变异数与实际一致",
    !!ciMut && Number(ciMut) === mutationCount,
    "ci.yml=" + (ciMut || "未声明") + "；实际=" + mutationCount);
}

console.log("");
console.log("== 打包脚本（M-2：发布产物的唯一来源必须有测试护栏）==");
{
  const os = require("node:os");
  const { RUNTIME_FILES, missingFromManifest, pack } = require("../tools/package.js");

  t("真实 manifest.json 的全部引用都在打包清单中",
    missingFromManifest(mf).length === 0,
    JSON.stringify(missingFromManifest(mf)));

  // 注入一个清单未收录的引用，必须被逐名检出（护栏有效性自证）
  const fake = JSON.parse(JSON.stringify(mf));
  fake.action.default_popup = "popup2.html";
  t("清单遗漏 manifest 引用会被检出",
    JSON.stringify(missingFromManifest(fake)) === JSON.stringify(["popup2.html"]),
    JSON.stringify(missingFromManifest(fake)));

  // 打包到临时目录做产物断言，不污染仓库工作区
  // 【B-5】传 selfCheck:true：本组断言必须在【变异门禁运行期间】同样通过，否则
  //   门禁下这 6 条产物断言必然失败，等价变异体 M1 会被误判成「被拦截」。
  //   该例外受两重约束（显式声明 + 目标在系统临时目录），见 tools/package.js。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "easy-proxy-pack-"));
  try {
    const { dest, version, copied } = pack(tmp, { selfCheck: true });
    t("pack 返回的复制清单与 RUNTIME_FILES 一致",
      JSON.stringify([...copied].sort()) === JSON.stringify([...RUNTIME_FILES].sort()),
      JSON.stringify(copied));
    const produced = fs.readdirSync(dest).sort();
    t("产物目录内容与打包清单完全一致（无多余、无遗漏）",
      JSON.stringify(produced) === JSON.stringify([...RUNTIME_FILES].sort()),
      JSON.stringify(produced));
    t("产物目录名与 manifest.version 一致",
      path.basename(dest) === "easy-proxy-by-ds4-" + version,
      path.basename(dest));
    t("产物不含 tests/ 与 node_modules/（A3 排除契约）",
      !fs.existsSync(path.join(dest, "tests")) &&
      !fs.existsSync(path.join(dest, "node_modules")));
    t("产物 manifest.json 与源文件逐字节一致",
      fs.readFileSync(path.join(dest, "manifest.json"))
        .equals(fs.readFileSync(path.join(rootDir, "manifest.json"))));
    t("产物 popup.js 与源文件逐字节一致",
      fs.readFileSync(path.join(dest, "popup.js"))
        .equals(fs.readFileSync(path.join(rootDir, "popup.js"))));

    // 【B-3】变异哨兵互斥：哨兵在位时打包必须失败。
    //   事故背景：dist/ 里曾出现 M22 变异体（packaging 跑在变异运行期间）。
    //   这条断言证明「打包脚本自己拦得住」，而不是靠人记得不要并发。
    // 【B-5】注意本组断言在两种环境下都必须通过：
    //   · 常规运行（无哨兵）：本块自己写入哨兵，触发拒绝；
    //   · 变异门禁运行（门禁已落哨兵）：哨兵本就在位，同样触发拒绝。
    //   因此本块自己写入哨兵后必须【严格还原现场】——原本有就写回原内容，
    //   原本没有才删除。下方最后一条断言校验的正是这个「还原」不变式。
    {
      const sentinel = path.join(rootDir, ".mutation-in-progress");
      const existed = fs.existsSync(sentinel);
      const backup = existed ? fs.readFileSync(sentinel, "utf8") : null;
      try {
        fs.writeFileSync(sentinel, JSON.stringify({ pid: 0, at: 0 }));
        let threw = null;
        try { pack(tmp); } catch (e) { threw = e; }
        t("变异哨兵在位时 pack 必须拒绝打包（B-3：防止产物含变异体）",
          !!threw && /变异测试正在运行/.test(threw.message),
          threw ? threw.message : "未抛错（护栏失效）");

        // 【B-5】自检例外的边界：非系统临时目录即便声明 selfCheck 也必须拒绝，
        //   否则 selfCheck 就退化成「绕过哨兵」的后门。探针目录若被误创建则删除。
        const probe = path.join(rootDir, ".pack-abuse-probe");
        let probeErr = null;
        try { pack(probe, { selfCheck: true }); } catch (e) { probeErr = e; }
        fs.rmSync(probe, { recursive: true, force: true });
        t("自检例外只对系统临时目录生效（selfCheck 不能成为绕过哨兵的通道）",
          !!probeErr && /变异测试正在运行/.test(probeErr.message),
          probeErr ? probeErr.message : "未抛错（例外被滥用）");
      } finally {
        // 严格还原现场：原本没有哨兵就必须删掉，避免在仓库根留下残留文件。
        if (existed && backup !== null) fs.writeFileSync(sentinel, backup);
        else fs.rmSync(sentinel, { force: true });
      }
      // 【B-5】此前这里写的是 `!fs.existsSync(sentinel)` —— 那与上面「严格还原现场」
      //   自相矛盾：门禁运行时哨兵本就该在，被还原后依然存在，断言必然为假，
      //   于是门禁里每条变异都因这一条而「被拦截」（假红，M1 误判的直接成因）。
      //   正确的不变式是「断言前后的哨兵状态一致」，两种环境都成立。
      t("B-3 断言结束后哨兵状态与断言前一致（严格还原现场，不污染工作区）",
        fs.existsSync(sentinel) === existed &&
          (!existed || fs.readFileSync(sentinel, "utf8") === backup),
        "断言前 existed=" + existed + "；断言后 exists=" + fs.existsSync(sentinel));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("");
console.log("== 跨平台产物字节一致性（M-1：行尾属性必须随仓库分发）==");
{
  // 【M-1·审计修复】tools/package.js 声明「任何人在任意机器上对同一提交执行本脚本
  //   都得到逐字节相同的产物」。该声明此前是假的：仓库没有 .gitattributes，工作树
  //   行尾只能依赖各人的 core.autocrlf（本机配置、不随仓库分发）—— 实测 Windows 为
  //   CRLF、Linux CI 为 LF，同一提交打包出的 .js/.html/.json 字节不同；而 pack() 的
  //   逐字节自校验只比对【同一工作树内】的源文件与产物，结构上不可能发现跨平台差异。
  //   这里把「属性文件存在且把行尾钉死为 LF」变成断言，防止它日后被删掉或改宽，
  //   让那条声明重新变成一句无支撑的承诺。
  const ga = read(".gitattributes");
  t(".gitattributes 存在（行尾属性的单一事实来源必须随仓库分发）", ga.length > 0);
  t(".gitattributes 把文本文件行尾钉死为 LF（优先于 core.autocrlf）",
    /^\*[ \t]+text=auto[ \t]+eol=lf[ \t]*$/m.test(ga),
    "未找到 '* text=auto eol=lf' 规则");
  t(".gitattributes 显式声明 .png 为二进制（避免行尾转换损坏图标字节）",
    /^\*\.png[ \t]+binary[ \t]*$/m.test(ga));
  // 声明与机制必须互相引用：否则「可复现」这句注释会再次与实现脱节（S-2 同型）。
  t("tools/package.js 的产物可复现声明引用 .gitattributes（声明与机制挂钩）",
    /\.gitattributes/.test(read("tools/package.js")));
}

console.log("");
console.log("== 打包脚本 CLI 入口（L-2：发布产物唯一来源的退出码路径必须有测试）==");
{
  // 【L-2·审计修复】tools/package.js 此前把 CLI 逻辑直接写在 main() 里并调用
  //   process.exit，而 .c8rc.json 又把 tools/** 整个排除在覆盖率之外 —— 结果是
  //   「发布产物的唯一来源」这个脚本自身零测试：失败分支（process.exit(1)）从未
  //   被执行过。一旦复制失败被静默吞掉（例如错误地 `return` 而非 `exit(1)`），
  //   发布流水线会「成功」地交出残缺产物而无人察觉。
  //   现在入口收成可注入的 runCli(opts)（见 tools/package.js）：返回退出码而不结束
  //   进程，成功/失败两条路径都可以被直接断言。本组断言同时校验：
  //     ① 成功 → 退出码 0、有产物目录、无错误日志；
  //     ② 失败 → 退出码 1、错误被写入 logErr（绝不静默）。
  //   【双环境稳定】失败路径刻意不依赖某个具体错误来源：常规运行下 pack 因
  //   destRoot 的父路径是普通文件而抛 ENOTDIR；变异门禁下哨兵在位，pack 会先抛
  //   「变异测试正在运行」。两者都走 runCli 的同一 catch 分支，断言（退出码 1 +
  //   错误被记录）在两种环境下都成立，与「测试必须环境无关」的硬约束一致。
  const os2 = require("node:os");
  const { runCli } = require("../tools/package.js");
  const cliVersion = JSON.parse(read("manifest.json")).version;

  // ---- 成功路径：注入临时 destRoot，收集日志 ----
  const cliTmp = fs.mkdtempSync(path.join(os2.tmpdir(), "easy-proxy-cli-"));
  try {
    const logs = [], errs = [];
    const code = runCli({
      destRoot: cliTmp,
      packOpts: { selfCheck: true }, // 与 B-5 同源：仅对系统临时目录生效
      log: (m) => logs.push(String(m)),
      logErr: (m) => errs.push(String(m))
    });
    t("runCli 成功路径返回退出码 0", code === 0, "code=" + code);
    t("runCli 成功路径不写任何错误日志", errs.length === 0, errs.join(" | "));
    t("runCli 成功路径确实产出 <名>-<版本> 目录",
      fs.existsSync(path.join(cliTmp, "easy-proxy-by-ds4-" + cliVersion)),
      fs.readdirSync(cliTmp).join(", "));
    t("runCli 成功路径把产物目录打印到 log（CLI 行为未因可测化而改变）",
      logs.some((l) => l.indexOf("easy-proxy-by-ds4-" + cliVersion) >= 0),
      logs.join(" | "));
  } finally {
    fs.rmSync(cliTmp, { recursive: true, force: true });
  }

  // ---- 失败路径：destRoot 的父路径是普通文件 → pack 无法建目录 ----
  //   用一个「占位文件」当父目录，保证失败是确定性的（不依赖权限/磁盘状态）。
  const cliBlocker = path.join(os2.tmpdir(), "easy-proxy-cli-blocker-" + process.pid);
  fs.writeFileSync(cliBlocker, "");
  try {
    const logs = [], errs = [];
    const code = runCli({
      destRoot: path.join(cliBlocker, "sub"),
      packOpts: { selfCheck: true },
      log: (m) => logs.push(String(m)),
      logErr: (m) => errs.push(String(m))
    });
    t("runCli 失败路径返回退出码 1（发布失败必须非零退出，否则流水线假成功）",
      code === 1, "code=" + code);
    t("runCli 失败路径把错误写入 logErr（不静默吞掉）",
      errs.length === 1 && /^错误：/.test(errs[0]), JSON.stringify(errs));
  } finally {
    fs.rmSync(cliBlocker, { force: true });
  }

  // ---- pack 自身的两条错误分支：用夹具目录注入 root，确定性触发 ----
  //   （【L-2·审计修复】此前这两条分支连一次都不会被执行 —— missingFromManifest
  //     的遗漏检出、以及清单文件缺失时的中止，都只在「有人把仓库改坏」时才走到。）
  const { pack } = require("../tools/package.js");
  const fixture = fs.mkdtempSync(path.join(os2.tmpdir(), "easy-proxy-fixture-"));
  try {
    // (a) manifest 引用了一个不在 RUNTIME_FILES 里的文件 → 必须在复制前中止。
    fs.writeFileSync(path.join(fixture, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "fixture", version: "9.9.9",
      background: { service_worker: "background.js" },
      action: { default_popup: "popup.html" },
      icons: { "16": "icon-unlisted.png" } // 刻意不在 RUNTIME_FILES 内
    }));
    let eMissingRef = null;
    try { pack(fixture, { root: fixture, selfCheck: true }); } catch (e) { eMissingRef = e; }
    t("pack 检出「manifest 引用的文件不在打包清单中」（加文件忘同步清单即中止）",
      !!eMissingRef && /未包含在打包清单中/.test(eMissingRef.message),
      eMissingRef ? eMissingRef.message : "未抛错（清单校验失效）");

    // (b) 清单文件缺失 → 必须在复制到一半时中止，绝不产出残缺包。
    fs.writeFileSync(path.join(fixture, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "fixture", version: "9.9.9",
      background: { service_worker: "background.js" },
      action: { default_popup: "popup.html" },
      icons: { "16": "icon-red-16.png" } // 全部在清单内；但夹具里没有这些文件
    }));
    let eMissingSrc = null;
    try { pack(fixture, { root: fixture, selfCheck: true }); } catch (e) { eMissingSrc = e; }
    t("pack 在源文件缺失时中止并点名文件（不产出残缺产物）",
      !!eMissingSrc && /清单中的文件不存在/.test(eMissingSrc.message),
      eMissingSrc ? eMissingSrc.message : "未抛错（残缺产物被放行）");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  // ---- pack 的最后一道网：产物自校验（B-3）----
  //   这一层覆盖「复制动作本身出错 / 源文件在打包中途被并发改写」。它此前
  //   从未被执行过。这里刻意用「故障注入」而非真实并发：临时把 fs.copyFileSync
  //   换成「复制后把目标写坏」，从而确定性地触发不一致检出（真实并发无法稳定复现）。
  const corruptTmp = fs.mkdtempSync(path.join(os2.tmpdir(), "easy-proxy-corrupt-"));
  const corruptDest = path.join(corruptTmp, "easy-proxy-by-ds4-" + cliVersion);
  const realCopyFileSync = fs.copyFileSync;
  let eCorrupt = null;
  try {
    fs.copyFileSync = function (s, d) {
      realCopyFileSync(s, d);
      // 只破坏一个文件，足以让自校验逐字节比对发现差异。
      //   刻意不引入 Buffer（测试环境的 globals 白名单里没有它，用它会直接被
      //   no-undef 拦下）——写一段普通字符串即可产生不同的字节序列。
      if (path.basename(d) === "popup.js") fs.writeFileSync(d, "// corrupted by test\n");
    };
    try { pack(corruptTmp, { selfCheck: true }); } catch (e) { eCorrupt = e; }
  } finally {
    fs.copyFileSync = realCopyFileSync; // 必须还原：跨测试共享同一 fs 对象
  }
  try {
    t("pack 检出产物与源文件不一致并中止（B-3 最后一道网：防止产物含污染字节）",
      !!eCorrupt && /产物与源文件不一致/.test(eCorrupt.message),
      eCorrupt ? eCorrupt.message : "未抛错（自校验失效）");
    t("pack 检出不一致后删除已产出的目录（绝不留下「看似就绪」的污染产物）",
      !fs.existsSync(corruptDest));
  } finally {
    fs.rmSync(corruptTmp, { recursive: true, force: true });
  }
}

console.log("");
console.log("== 打包后清理旧版产物（L-2：dist/ 里并存旧版本会让使用者选中旧代码）==");
{
  // 【L-2·工作区报告修复】dist/ 下曾长期并存 easy-proxy-by-ds4-2.11.0 与 …-2.13.0，
  //   而源码已推进到更高版本 —— 使用者按习惯直接加载 / 上传 dist/ 下的目录时会选中旧版本。
  //   README 的警示只能提醒，消除不了诱因（旧产物还在那儿）。
  //   清理放在 runCli 里、且只在 pack 成功之后，因此本组断言同时钉住四件事：
  //     ① 成功后才清 —— 失败时保住上一次可用产物，不许越修越坏；
  //     ② 只清「同前缀 + 版本号形态」的目录 —— 不误伤 easy-proxy-by-ds4-backup 这类同名目录；
  //     ③ 幂等 —— 连续两次打包不能把上一次的发布包删掉；
  //     ④ 清理不进 pack() —— 产物生成逻辑必须保持「只写自己那一个目录」的纯粹性。
  const os3 = require("node:os");
  const { runCli: runCliPkg, pack: packPkg, cleanStaleArtifacts } = require("../tools/package.js");
  const pkgVersion = JSON.parse(read("manifest.json")).version;
  const curDir = "easy-proxy-by-ds4-" + pkgVersion;

  const dTmp = fs.mkdtempSync(path.join(os3.tmpdir(), "easy-proxy-dist-"));
  try {
    // 四种干扰：两个旧版产物 + 一个同名非版本目录 + 一个无关目录
    fs.mkdirSync(path.join(dTmp, "easy-proxy-by-ds4-1.0.0"));
    fs.mkdirSync(path.join(dTmp, "easy-proxy-by-ds4-2.0.0"));
    fs.mkdirSync(path.join(dTmp, "easy-proxy-by-ds4-backup"));
    fs.mkdirSync(path.join(dTmp, "unrelated"));
    runCliPkg({ destRoot: dTmp, packOpts: { selfCheck: true }, log: () => {}, logErr: () => {} });
    t("打包成功后清理同前缀旧版产物目录",
      !fs.existsSync(path.join(dTmp, "easy-proxy-by-ds4-1.0.0")) &&
      !fs.existsSync(path.join(dTmp, "easy-proxy-by-ds4-2.0.0")),
      fs.readdirSync(dTmp).join(", "));
    t("只清「同前缀 + 版本号形态」：当前版本 / 同名非版本 / 无关目录一律保留",
      fs.existsSync(path.join(dTmp, curDir)) &&
      fs.existsSync(path.join(dTmp, "easy-proxy-by-ds4-backup")) &&
      fs.existsSync(path.join(dTmp, "unrelated")),
      fs.readdirSync(dTmp).join(", "));
    runCliPkg({ destRoot: dTmp, packOpts: { selfCheck: true }, log: () => {}, logErr: () => {} });
    t("连续两次打包幂等（当前版本产物不会自我删除）",
      fs.existsSync(path.join(dTmp, curDir)), fs.readdirSync(dTmp).join(", "));
  } finally {
    fs.rmSync(dTmp, { recursive: true, force: true });
  }

  // 失败路径：夹具让 pack 必然抛错（manifest 引用了不存在的源文件），
  //   此时既有旧产物必须原样保留 —— 这是约束 ① 的机器证明。
  const dTmp2 = fs.mkdtempSync(path.join(os3.tmpdir(), "easy-proxy-distfail-"));
  const dFix = fs.mkdtempSync(path.join(os3.tmpdir(), "easy-proxy-distfix-"));
  try {
    fs.writeFileSync(path.join(dFix, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: "fixture", version: "9.9.9",
      background: { service_worker: "background.js" },
      action: { default_popup: "popup.html" },
      icons: { "16": "icon-red-16.png" } // 全部在清单内，但夹具里没有这些文件
    }));
    fs.mkdirSync(path.join(dTmp2, "easy-proxy-by-ds4-1.0.0"));
    const codeFail = runCliPkg({
      destRoot: dTmp2, packOpts: { root: dFix, selfCheck: true },
      log: () => {}, logErr: () => {}
    });
    t("打包失败时不清理任何旧产物（不得毁掉上一次可用产物）",
      codeFail === 1 && fs.existsSync(path.join(dTmp2, "easy-proxy-by-ds4-1.0.0")),
      "code=" + codeFail + " 剩余=" + fs.readdirSync(dTmp2).join(", "));

    let packThrew = false;
    try { packPkg(dTmp2, { root: dFix, selfCheck: true }); } catch (e) { packThrew = true; }
    t("直接调用 pack() 不清理任何目录（清理归属 CLI 层，不进产物生成逻辑）",
      packThrew && fs.existsSync(path.join(dTmp2, "easy-proxy-by-ds4-1.0.0")),
      "抛错=" + packThrew + " 剩余=" + fs.readdirSync(dTmp2).join(", "));

    t("cleanStaleArtifacts 对不存在的 destRoot 返回空数组且不抛错",
      Array.isArray(cleanStaleArtifacts(path.join(dTmp2, "no-such-dir"), "")));
  } finally {
    fs.rmSync(dTmp2, { recursive: true, force: true });
    fs.rmSync(dFix, { recursive: true, force: true });
  }

  // 【L-2·工作区报告修复】最后一条分支：单个旧产物处理失败时必须「尽力而为」。
  //   理由是这条 catch 不是装饰 —— 清理属于**便利性**而非正确性前提：某个旧目录
  //   可能正被占用（Windows 下目录被资源管理器/杀软持有）或权限不足，此时正确行为是
  //   「跳过它、继续清其余、并让整次打包照常成功」，而不是抛错把已经成功的发布搞成失败。
  //   用**故障注入**（临时替换 fs.statSync，让某一个旧目录抛错）而不是伪造权限：
  //   伪造权限无法稳定复现，且在不同 CI runner 上表现不一致。
  const dTmp3 = fs.mkdtempSync(path.join(os3.tmpdir(), "easy-proxy-distbusy-"));
  const busy = "easy-proxy-by-ds4-3.0.0";
  const free = "easy-proxy-by-ds4-4.0.0";
  let removedDebris = null;
  try {
    fs.mkdirSync(path.join(dTmp3, busy));
    fs.mkdirSync(path.join(dTmp3, free));
    const origStatSync = fs.statSync;
    try {
      fs.statSync = function (p, ...rest) {
        if (String(p).indexOf(busy) >= 0) throw new Error("injected stat failure");
        return origStatSync.call(fs, p, ...rest);
      };
      removedDebris = cleanStaleArtifacts(dTmp3, path.join(dTmp3, curDir));
    } finally {
      fs.statSync = origStatSync;
    }
    t("单个旧产物处理失败时不抛错、其余旧产物照常清理（清理是尽力而为，不得反过来搞坏打包）",
      Array.isArray(removedDebris) && removedDebris.indexOf(free) >= 0 && removedDebris.indexOf(busy) < 0 &&
      fs.existsSync(path.join(dTmp3, busy)) && !fs.existsSync(path.join(dTmp3, free)) &&
      fs.statSync === origStatSync,
      "removed=" + JSON.stringify(removedDebris) + " 剩余=" + fs.readdirSync(dTmp3).join(", "));
  } finally {
    fs.rmSync(dTmp3, { recursive: true, force: true });
  }
}

console.log("");
console.log("== 判据单一实现（G3：遮蔽现场判据收敛到 settings.js）==");
{
  // 【G3 成因记录】同一业务判据曾有三处独立实现（settings / background / popup），
  //   且发生实质漂移 —— 那正是 S1（存量编辑形态保存清空 local）的直接成因。
  //   修复后 popup 一律调用 S.isLegacyShadowPair（前台确认门，可放宽）；
  //   background 保留语义独立的 isLegacyShadowed（后台自愈，刻意保守），
  //   两者的分工由 settings.js 注释声明。这里断言 popup 不再携带内联判据副本。
  t("popup.js 调用共享判据 isLegacyShadowPair（G3：单一实现）",
    /S\.isLegacyShadowPair\s*\(/.test(popupJs),
    "popup.js 中未找到 S.isLegacyShadowPair 调用");
  t("settings.js 同时导出 looksLikeShadowEdit 与 isLegacyShadowPair",
    /looksLikeShadowEdit/.test(settingsJs) && /isLegacyShadowPair/.test(settingsJs));
}

console.log("");
console.log("== 缺陷/修复编号索引（L-6：编号族必须集中登记，新增族未登记即变红）==");
{
  // 【L-6·审计修复】全仓 100+ 处 【X-NN】 标注此前无集中登记：哪一族、到哪一号、
  //   有无冲突全靠人工避重，跨文件引用无法机械定位。这里只做「族级」登记校验 ——
  //   逐条列 139 个编号既不可维护、也会立刻漂移；族级校验已足以拦住「引入新族却
  //   不登记」。索引正文见 ARCHITECTURE.md 第 7 节。
  const archSrc = read("ARCHITECTURE.md");
  const declaredFams = ((archSrc.match(/编号族（机械校验用，勿删）：([^\n]+)/) || [])[1] || "")
    .match(/[A-Z]+/g) || [];
  t("ARCHITECTURE.md 含编号族登记行且能解析出 ≥ 8 个族（防止索引被删或改残）",
    declaredFams.length >= 8, JSON.stringify(declaredFams));

  // 扫描范围与索引「主要出处」一致：根目录 + tools/ + tests/ + docs/ + CI 工作流。
  // 刻意不扫 .json（manifest 无标注、package-lock 体积大且无标注）。
  const scanDirs = [".", "tools", "tests", "docs", ".github/workflows"];
  const scanned = [];
  for (const d of scanDirs) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(rootDir, d)); } catch (e) { continue; }
    for (const e of ents) {
      if (!/\.(js|html|md|yml)$/.test(e)) continue;
      const rel = d === "." ? e : d + "/" + e;
      try { if (fs.statSync(path.join(rootDir, rel)).isFile()) scanned.push(rel); } catch (e) { /* 跳过 */ }
    }
  }
  const actualSet = new Set();
  for (const f of scanned) {
    for (const m of read(f).matchAll(/【([A-Za-z]+)-?\d/g)) actualSet.add(m[1]);
  }
  const actualFams = [...actualSet].sort();
  t("扫描确实命中编号标注（≥ 8 族，防止正则失效使本组断言恒真）",
    actualFams.length >= 8, "扫描 " + scanned.length + " 个文件，命中 " + JSON.stringify(actualFams));
  t("全仓实际出现的编号族集合 = 索引登记的族集合（新增族未登记即变红）",
    declaredFams.slice().sort().join(",") === actualFams.join(","),
    "索引=" + JSON.stringify(declaredFams.slice().sort()) + "；实际=" + JSON.stringify(actualFams));
}

console.log("");
console.log("== 文档声明一致性扩展（M-2/M-3：出口端点清单与 devDependencies 白名单）==");
{
  // 【M-2·审计修复】出口检测端点清单必须与实现一致地出现在所有对外文档里。
  //   成因：README 隐私段只写了主端点 ipinfo.io、漏掉两个备用端点，与 PRIVACY.md /
  //   SECURITY.md / settings.js 四处不一致（同一 README 的「安全」段却是对的）。
  //   商店审核要求如实披露全部数据接收方，隐私摘要与实际网络行为不符属硬性风险。
  //   事实来源取 settings.js 的 TEST_ENDPOINTS 数组字面量（静态解析，不引入运行时依赖）。
  const block = (settingsJs.match(/var TEST_ENDPOINTS = \[([\s\S]*?)\];/) || [])[1] || "";
  const endpoints = [...block.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => m[1]);
  t("能从 settings.js 解析出 TEST_ENDPOINTS 端点清单（≥2）",
    endpoints.length >= 2, JSON.stringify(endpoints));
  for (const doc of ["README.md", "PRIVACY.md", "SECURITY.md"]) {
    const src = read(doc);
    const missing = endpoints.filter((u) => src.indexOf(u) < 0);
    t(doc + " 完整披露全部出口检测端点（防止端点清单漂移）",
      missing.length === 0, missing.length ? "缺少: " + missing.join(", ") : "");
  }

  // 【M-3·审计修复】CONTRIBUTING 的 devDependencies 陈述必须与实际依赖一致。
  //   成因：CONTRIBUTING 曾写「当前仅 ESLint」，而 M-4 已引入 c8；G1 守卫只覆盖
  //   断言数/变异数，拦不住「依赖清单」这类陈述的漂移（S-2 同型缺陷）。
  //   事实来源取 package.json，要求 CONTRIBUTING 逐名出现（大小写不敏感）。
  const pkg = JSON.parse(read("package.json"));
  const devDeps = Object.keys(pkg.devDependencies || {});
  t("package.json 声明了 devDependencies", devDeps.length > 0, JSON.stringify(devDeps));
  const contribLower = read("CONTRIBUTING.md").toLowerCase();
  const missingDeps = devDeps.filter((d) => contribLower.indexOf(d.toLowerCase()) < 0);
  t("CONTRIBUTING 逐名声明全部 devDependencies（防止依赖清单陈述漂移）",
    devDeps.length > 0 && missingDeps.length === 0,
    missingDeps.length ? "未声明: " + missingDeps.join(", ") : "devDeps=" + JSON.stringify(devDeps));
}

console.log("");
// 【G1】文档一致性自检：README 声明的本套件断言数必须与实际通过数一致
{
  const g1 = require("./g1-consistency.js").g1ConsistencyCheck("tests/manifest.test.js", pass);
  if (!g1.skipped && g1.declared !== pass) {
    fail++;
    console.log("  FAIL  G1 文档一致性：README 声明 " + g1.declared + " 项，实际通过 " + pass + " 项（改测试后请同步 README 对应行与合计）");
  }
}
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
