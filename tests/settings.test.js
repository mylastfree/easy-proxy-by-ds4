// tests/settings.test.js —— settings.js 纯函数断言
// 运行：node tests/settings.test.js
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const settingsPath = path.join(__dirname, '..', 'settings.js');
const sandbox = { TextEncoder: TextEncoder, console: console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(settingsPath, 'utf8'), sandbox, { filename: settingsPath });
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

console.log("== M-6：保存前校验收紧 —— Chrome 必拒写法提前拦截 ==");
// 此前 example.com:8080:90（多冒号）、user:pass@host、host:abc、a,b.com 都能通过
// 保存前校验，错误被推迟到 set 阶段并归因为「代理异常」，误导排障方向。
const M6_REJECT = ["example.com:8080:90", "user:pass@host", "host:abc", "a,b.com"];
M6_REJECT.forEach(function (h) {
  const errs = S.validateSettings(Object.assign({}, ok, { proxyHost: h }));
  t("M-6 拒绝：" + h, errs.length > 0, JSON.stringify(errs));
});
// 防误伤：合法写法（全部 IPv6 形态与下划线主机名）必须零错误
const M6_ALLOW = ["::1", "fe80::1", "[::1]", "2001:db8::1", "proxy.example.com", "my_server.local"];
M6_ALLOW.forEach(function (h) {
  const errs = S.validateSettings(Object.assign({}, ok, { proxyHost: h }));
  t("M-6 防误伤：" + h, errs.length === 0, JSON.stringify(errs));
});

console.log("== M-7：方括号用法与主机形态收口（M-6 的残留面）==");
// M-6 把 [ 与 ] 无条件列入合法字符白名单，而 isIpV6Shape 只在 host 含冒号时触发 ——
// 于是「无冒号的方括号」整类漏放（探针实测：修复前以下写法全部通过保存前校验），
// 错误被推迟到 set 阶段并归因为「代理异常」，把用户引去排查代理软件。
const M7_BRACKET_REJECT = ["a[b].com", "[]", "[abc]", "foo]bar", "[a]b"];
M7_BRACKET_REJECT.forEach(function (h) {
  const errs = S.validateSettings(Object.assign({}, ok, { proxyHost: h }));
  t("M-7 方括号滥用被拒：" + JSON.stringify(h), errs.length > 0, JSON.stringify(errs));
});
// 纯分隔符串（无方括号）：同样必须拒绝 —— [] 之外的第二种「无有效字符」形态
const M7_LABELLESS = [".", ".."];
M7_LABELLESS.forEach(function (h) {
  const errs = S.validateSettings(Object.assign({}, ok, { proxyHost: h }));
  t("M-7 无有效字符的主机被拒：" + JSON.stringify(h), errs.length > 0, JSON.stringify(errs));
});
// 防误伤：合法 IPv6 的带括号形态必须继续零错误（收口不得把 IPv6 一起打掉）
const M7_ALLOW = ["[::1]", "[fe80::1]", "[2001:db8::1]"];
M7_ALLOW.forEach(function (h) {
  const errs = S.validateSettings(Object.assign({}, ok, { proxyHost: h }));
  t("M-7 防误伤（带括号 IPv6）：" + h, errs.length === 0, JSON.stringify(errs));
});
t("M-7 方括号类拒绝文案指向方括号用法",
  S.validateSettings(Object.assign({}, ok, { proxyHost: "a[b].com" }))
    .some(function (m) { return m.indexOf("方括号") >= 0; }));
t("M-7 无标签类拒绝文案不得复用方括号说明（如实上报成因）",
  S.validateSettings(Object.assign({}, ok, { proxyHost: "." }))
    .some(function (m) { return m.indexOf("方括号") < 0 && m.indexOf("字母或数字") >= 0; }));

console.log("== C-3：出口检测端点容错配置 ==");
t("TEST_ENDPOINTS 为多端点数组（≥2）",
  Array.isArray(S.TEST_ENDPOINTS) && S.TEST_ENDPOINTS.length >= 2, JSON.stringify(S.TEST_ENDPOINTS));
t("TEST_ENDPOINT 保留为主端点（首个）",
  S.TEST_ENDPOINTS[0] === S.TEST_ENDPOINT, String(S.TEST_ENDPOINTS[0]));

console.log("== 容量估算 ==");
t("估算值为正", S.estimateBytes({ bypassList: "abc" }) > 0);
t("超 8192 可被识别", S.estimateBytes({ bypassList: "x".repeat(9000) }) > S.MAX_SYNC_BYTES_PER_ITEM);
t("默认绕过列表未超配额", S.estimateBytes({ bypassList: S.DEFAULTS.bypassList }) < S.MAX_SYNC_BYTES_PER_ITEM);


console.log("");
console.log("== V-01：遮蔽现场「编辑后保存」的识别（纯函数）==");
{
  const DEF = S.DEFAULTS.bypassList;
  const NL = "\n";

  // 形态 1：逐字符等于默认列表 → 是污染现场（既有语义，不能退）
  t("V-01-a 逐字符等于默认列表 → 判为污染现场",
    S.isLegacyShadowPair(DEF, "my-own.internal") === true);

  // 形态 2：默认列表 + 用户编辑 → 【同样】是污染现场（这正是 V-01 漏掉的那一格）
  t("V-01-b 默认列表加一行编辑 → 仍判为污染现场（V-01 的核心）",
    S.isLegacyShadowPair(DEF + NL + "edited-by-user.internal", "my-own.internal") === true);

  // 形态 3：用户自己写的列表（与默认列表无包含关系）→ 不是污染现场
  t("V-01-c 用户自写的列表 → 不得判为污染现场（否则会误伤）",
    S.isLegacyShadowPair("only-my-rule.internal", "my-own.internal") === false);

  // 形态 4：默认列表 + 用户追加的规则（常见真实用法）→ 判为污染现场
  //   这是本判据的已知取舍：代价是一次确认（用户点第二次即继续），
  //   收益是不再静默失效。
  t("V-01-d 默认列表加用户追加的规则 → 判为污染现场（保守方向，代价是一次确认）",
    S.isLegacyShadowPair(DEF + NL + "-my-extra.internal", "my-own.internal") === true);

  // 形态 5：local 为空 → 不存在唯一副本，任何判据都不成立
  t("V-01-e local 为空 → 一律不判为污染现场",
    S.isLegacyShadowPair(DEF, "") === false && S.isLegacyShadowPair(DEF + NL + "x", "") === false);

  // 形态 6：非字符串（读不到 / 类型异常）→ 一律不判为污染现场（宁可不确认，不可误判）
  t("V-01-f 非字符串输入 → 一律不判为污染现场",
    S.isLegacyShadowPair(undefined, "x") === false &&
    S.isLegacyShadowPair(DEF, undefined) === false &&
    S.isLegacyShadowPair(null, null) === false);

  // 形态 7：反向 —— sync 为空串占位（正常降级形态）→ 不是污染现场
  t("V-01-g sync 为空串占位（正常降级形态）→ 不判为污染现场",
    S.isLegacyShadowPair("", "my-own.internal") === false);

  // looksLikeShadowEdit：识别「这串文本 = 内置默认列表 + 用户的编辑」。
  //   刻意【不】把「逐字符等于默认列表」算进来：那正是 R9-01 的主场景
  //   （用户什么都没改就保存），既有守卫已能安全处理，不该再打断用户一次。
  //   逐字符相等的情形由 isLegacyShadowPair 单独覆盖（见 V-01-a/V-01-g）。
  t("V-01-h 逐字符等于默认列表 → looksLikeShadowEdit 为假（R9-01 主场景不被打断）",
    S.looksLikeShadowEdit(DEF) === false);
  t("V-01-i 默认列表 + 一行编辑 → looksLikeShadowEdit 为真（V-01 的核心）",
    S.looksLikeShadowEdit(DEF + NL + "edited.internal") === true);
  t("V-01-j 用户自写列表 → looksLikeShadowEdit 为假",
    S.looksLikeShadowEdit("only-my-rule.internal") === false);

  // 形态 8：默认列表在前但被删掉若干行（用户删了内网规则）→ 不是「前缀」形态
  //   宁可漏过（退回既有行为），也不把"用户自己精简过的列表"误判成污染。
  t("V-01-k 默认列表被删行后（不再是前缀）→ 不判为污染现场（宁漏勿误伤）",
    S.looksLikeShadowEdit(DEF.split(NL).slice(1).join(NL)) === false);
}

console.log("== L-03：出口检测 ip 字段的形态校验 ==");
// 文档（SECURITY.md / PRIVACY.md）声称响应必须包含「有效的 ip 字段」，
// 而旧判据只查「非空 + 长度 ≤45 + 无空白」—— "not-an-ip" 会通过并被当成出口 IP 展示。
// 判据收敛到 settings.js 的 isIpLiteral，示例即文档与实现的同一事实来源。
t("L-03-a 合法 IPv4 通过", S.isIpLiteral("203.0.113.7") === true);
t("L-03-b 合法 IPv6 通过", S.isIpLiteral("2001:db8::1") === true);
t("L-03-c IPv4 内嵌 IPv6 形式通过（::ffff:1.2.3.4）",
  S.isIpLiteral("::ffff:192.0.2.1") === true);
t("L-03-d 非 IP 文本被拒（旧判据会放行 not-an-ip）",
  S.isIpLiteral("not-an-ip") === false);
t("L-03-e 越界 IPv4 被拒", S.isIpLiteral("256.1.1.1") === false);
t("L-03-f 段数不足被拒", S.isIpLiteral("1.2.3") === false);
t("L-03-g 含非十六进制字符的冒号串被拒", S.isIpLiteral("gggg::1") === false);
t("L-03-h 空串 / 带空白 / 超长一律被拒",
  S.isIpLiteral("") === false && S.isIpLiteral(" 1.2.3.4 ") === false &&
  S.isIpLiteral("a".repeat(46)) === false);
t("L-03-i 非字符串输入不崩溃", S.isIpLiteral(null) === false && S.isIpLiteral(12345) === false);
console.log("");
// 【G1】文档一致性自检：README 声明的本套件断言数必须与实际通过数一致
{
  const g1 = require("./g1-consistency.js").g1ConsistencyCheck("tests/settings.test.js", pass);
  if (!g1.skipped && g1.declared !== pass) {
    fail++;
    console.log("  FAIL  G1 文档一致性：README 声明 " + g1.declared + " 项，实际通过 " + pass + " 项（改测试后请同步 README 对应行与合计）");
  }
}
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
