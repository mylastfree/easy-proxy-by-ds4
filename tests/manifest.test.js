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
