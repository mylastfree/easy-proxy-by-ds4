// tests/settings.test.js —— settings.js 纯函数断言
// 运行：node tests/settings.test.js
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const settingsPath = path.join(__dirname, '..', 'settings.js');
const sandbox = { TextEncoder: TextEncoder, console: console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(settingsPath, 'utf8'), sandbox);
const S = sandbox.EasyProxy;

let pass = 0;
let fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

console.log("== 默认值 ==");
const d = S.normalizeSettings({});
t("默认类型为 socks5", d.proxyType === "socks5", d.proxyType);
t("默认地址 127.0.0.1", d.proxyHost === "127.0.0.1", d.proxyHost);
t("默认端口 10808", d.proxyPort === "10808", d.proxyPort);
t("默认不启用代理", d.enableProxy === false);
t("已移除的 http 收敛为 socks5", S.normalizeSettings({ proxyType: "http" }).proxyType === "socks5");
t("https 类型保留", S.normalizeSettings({ proxyType: "https" }).proxyType === "https");
t("非法类型被收敛", S.normalizeSettings({ proxyType: "quic" }).proxyType === "socks5");
t("非布尔值不视为启用", S.normalizeSettings({ enableProxy: "yes" }).enableProxy === false);
t("地址被 trim", S.normalizeSettings({ proxyHost: "  1.2.3.4  " }).proxyHost === "1.2.3.4");
t("null 输入不崩溃", typeof S.normalizeSettings(null).proxyHost === "string");

console.log("== 绕过列表解析（核心需求：局域网网段必须完整保留）==");
const b = S.parseBypassList(S.DEFAULTS.bypassList);
t("192.168.0.0/16 未被截断", b.indexOf("192.168.0.0/16") >= 0, JSON.stringify(b));
t("10.0.0.0/8 未被截断", b.indexOf("10.0.0.0/8") >= 0);
t("172.16.0.0/12 未被截断", b.indexOf("172.16.0.0/12") >= 0);
t("含 .local", b.indexOf(".local") >= 0);
t("含 .lan", b.indexOf(".lan") >= 0);
t("含 <local>", b.indexOf("<local>") >= 0);
t("注释行已剔除", !b.some(function (x) { return x.charAt(0) === "#"; }));
t("无空项", !b.some(function (x) { return x === ""; }));
t("逗号分隔", JSON.stringify(S.parseBypassList("a.com, b.com")) === JSON.stringify(["a.com", "b.com"]));
t("分号分隔", JSON.stringify(S.parseBypassList("a.com; b.com")) === JSON.stringify(["a.com", "b.com"]));
t("换行分隔", JSON.stringify(S.parseBypassList("a.com\nb.com")) === JSON.stringify(["a.com", "b.com"]));
t("剥离协议头", S.parseBypassList("https://x.com")[0] === "x.com");
t("剥离路径", S.parseBypassList("example.com/path")[0] === "example.com");
t("剥离查询", S.parseBypassList("example.com/path?q=1")[0] === "example.com");
t("CIDR 后带查询仍保留网段", S.parseBypassList("192.168.0.0/16?x")[0] === "192.168.0.0/16");
t("IPv6 CIDR 保留", S.parseBypassList("fe80::/10")[0] === "fe80::/10");
t("通配子域保留", S.parseBypassList("*.example.com")[0] === "*.example.com");
t("带端口保留", S.parseBypassList("example.com:8080")[0] === "example.com:8080");
t("去重且保序", JSON.stringify(S.parseBypassList("b.com\na.com\nb.com")) === JSON.stringify(["b.com", "a.com"]));
t("空输入返回空数组", S.parseBypassList("").length === 0);
t("null 输入返回空数组", S.parseBypassList(null).length === 0);

console.log("== 设置校验 ==");
const ok = S.normalizeSettings({ enableProxy: true });
t("合法配置无错误", S.validateSettings(ok).length === 0, JSON.stringify(S.validateSettings(ok)));
t("未启用时跳过校验", S.validateSettings(S.normalizeSettings({ enableProxy: false, proxyHost: "" })).length === 0);
t("缺地址报错", S.validateSettings(Object.assign({}, ok, { proxyHost: "" })).length > 0);
t("地址含空格报错", S.validateSettings(Object.assign({}, ok, { proxyHost: "1.2 3.4" })).length > 0);
t("地址含协议报错", S.validateSettings(Object.assign({}, ok, { proxyHost: "http://1.2.3.4" })).length > 0);
t("地址含端口报错", S.validateSettings(Object.assign({}, ok, { proxyHost: "1.2.3.4:8080" })).length > 0);
t("缺端口报错", S.validateSettings(Object.assign({}, ok, { proxyPort: "" })).length > 0);
t("端口 99999 报错", S.validateSettings(Object.assign({}, ok, { proxyPort: "99999" })).length > 0);
t("端口 0 报错", S.validateSettings(Object.assign({}, ok, { proxyPort: "0" })).length > 0);
t("端口 abc 报错", S.validateSettings(Object.assign({}, ok, { proxyPort: "abc" })).length > 0);
t("端口 -1 报错", S.validateSettings(Object.assign({}, ok, { proxyPort: "-1" })).length > 0);
t("端口 80.5 报错", S.validateSettings(Object.assign({}, ok, { proxyPort: "80.5" })).length > 0);
t("端口 65535 合法", S.validateSettings(Object.assign({}, ok, { proxyPort: "65535" })).length === 0);
t("端口 1 合法", S.validateSettings(Object.assign({}, ok, { proxyPort: "1" })).length === 0);

console.log("== 代理地址 ASCII / Punycode 校验（R7-07）==");
// Chromium extensions/common/api/proxy.json 对 host 的要求原文：
//   "Hostnames must be in ASCII (in Punycode format). IDNA is not supported, yet."
// 非 ASCII 主机名会被 chrome.proxy.settings.set 拒绝，代理下发失败并落 error 状态。
const NON_ASCII_HOSTS = ["例子.中国", "münchen.de", "Пример.рф", "foo\u3000bar.com"];
NON_ASCII_HOSTS.forEach(function (h) {
  const errs = S.validateSettings(Object.assign({}, ok, { proxyHost: h }));
  t("R7-07-1 非 ASCII 地址被拒：" + h, errs.length > 0, JSON.stringify(errs));
});
const punyErrs = S.validateSettings(Object.assign({}, ok, { proxyHost: "例子.中国" }));
t("R7-07-1 拒绝文案含 Punycode 转换指引",
  punyErrs.some(function (m) { return m.indexOf("Punycode") >= 0; }), JSON.stringify(punyErrs));

// 防误伤：以下主机名必须继续零错误（IPv4 / 主机名 / IPv6 字面量 / 已是 Punycode）
const ASCII_HOSTS = ["127.0.0.1", "localhost", "192.168.1.1", "::1", "[::1]", "fe80::1",
  "proxy.example.com", "xn--fsqu00a.xn--fiqs8s"];
ASCII_HOSTS.forEach(function (h) {
  const errs = S.validateSettings(Object.assign({}, ok, { proxyHost: h }));
  t("R7-07-2 合法地址零错误：" + h, errs.length === 0, JSON.stringify(errs));
});

// 防回归：既有拒绝项的行为与文案不得改变或放宽
const REGRESS = [
  ["", "请填写代理地址"],
  ["1.2 3.4", "代理地址不能包含空格"],
  ["http://1.2.3.4", "代理地址只填主机名或 IP，不要带协议或路径"],
  ["example.com/path", "代理地址只填主机名或 IP，不要带协议或路径"],
  ["1.2.3.4:8080", "端口请填在独立的端口输入框中"]
];
REGRESS.forEach(function (c) {
  const errs = S.validateSettings(Object.assign({}, ok, { proxyHost: c[0] }));
  t("R7-07-3 既有拒绝项文案不变：" + JSON.stringify(c[0]), errs.indexOf(c[1]) >= 0, JSON.stringify(errs));
});

console.log("== 容量估算 ==");
t("估算值为正", S.estimateBytes({ bypassList: "abc" }) > 0);
t("超 8192 可被识别", S.estimateBytes({ bypassList: "x".repeat(9000) }) > S.MAX_SYNC_BYTES_PER_ITEM);
t("默认绕过列表未超配额", S.estimateBytes({ bypassList: S.DEFAULTS.bypassList }) < S.MAX_SYNC_BYTES_PER_ITEM);

console.log("");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
