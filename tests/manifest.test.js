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
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
