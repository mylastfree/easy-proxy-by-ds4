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
