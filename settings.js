// settings.js —— 默认值、归一化、校验、纯函数工具  [v2.15.3]
// 刻意不依赖任何 chrome.* API，使 popup 与 Service Worker 可共用同一套逻辑。
(function (root) {
  'use strict';

  // 内置默认绕过列表：局域网直连
  // RFC 1918 私有网段 + 常见内网域名后缀 + 简单主机名
  var DEFAULT_BYPASS = [
    '# 局域网私有网段（RFC 1918）',
    '192.168.0.0/16',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '',
    '# 常见内网域名后缀',
    '.local',
    '.lan',
    '',
    '# 不含点的主机名（如 http://nas）',
    '<local>'
].join('\n');

  // 默认代理：本机 sing-box mixed 入站（同端口同时提供 SOCKS5 与 HTTP）
  var DEFAULTS = {
    enableProxy: false,
    proxyType: 'socks5',
    proxyHost: '127.0.0.1',
    proxyPort: '10808',
    bypassList: DEFAULT_BYPASS
  };

  // 只暴露 SOCKS5 与 HTTPS；取值须与 chrome.proxy 的 Scheme 枚举完全一致
  var PROXY_TYPES = [
    { value: 'socks5', label: 'SOCKS5 代理' },
    { value: 'https', label: 'HTTPS 代理（到代理的连接经 TLS 加密）' }
  ];

  var MAX_SYNC_BYTES_PER_ITEM = 8192;

  // 出口检测端点：必须支持 CORS —— 请求由 MV3 Service Worker 发起（见 background.js 的
  //   fetchExit）。SW 在未申请任何 host 权限时，跨源 fetch 同样受 CORS 约束：端点若不返回
  //   Access-Control-Allow-Origin，后台就拿不到响应，前台最终也拿不到出口检测结果。
  //   【L-3·工作区报告修复】此前这句写作「否则 popup 读取不到结果」，把机制归给了 popup ——
  //   全库 fetch 只出现在 background.js，popup 不发请求。后果描述是对的，归因是错的；
  //   本项目以「文档-实现一致」为质量前提，归因错的注释比没有注释更危险（会把人引向错处排查）。
  // 【C-3】此前单点依赖 ipinfo.io：该端点不可用（区域阻断 / 故障 / 政策变更）时
  //   出口检测整体失效，用户会得到「出口检测失败」却无从判断是代理问题还是检测端点问题。
  //   现改为【有序端点列表】：主端点失败（HTTP 错误 / 响应 schema 不符 / 网络拒绝）时
  //   依次尝试备用端点；超时（AbortError）不重试备用端点 —— 同一网络环境下其它端点
  //   大概率同样不可达，且对比窗口的直连取样对总时长有硬上限（G5），不允许把
  //   「代理已清除」的暴露窗口放大 N 倍。各端点均返回 Access-Control-Allow-Origin: *，
  //   因此始终无需申请任何 host 权限。
  //   兼容性说明：TEST_ENDPOINT 保留为主端点（既有引用与文档语义不变），
  //   fetchExit 的实际遍历顺序以 TEST_ENDPOINTS 为准。
  var TEST_ENDPOINT = 'https://ipinfo.io/json';
  var TEST_ENDPOINTS = [
    'https://ipinfo.io/json',
    'https://ipapi.co/json/',
    'https://api.ipify.org?format=json'
  ];
  var TEST_TIMEOUT_MS = 12000;
  // 【G5】对比窗口内「取直连出口」的独立短超时。
  //   该请求发生在「代理已被清除（直连）」的区间内，超时越长 = 用户处于真实直连的
  //   时间越长，也直接放大 S2（SW 回收）的暴露窗口。全局 TEST_TIMEOUT_MS（12 秒）
  //   适用于「代理仍在生效」的普通出口检测；对比窗口内必须用更短的独立上限（4 秒），
  //   使「代理已清除」的最坏持有时长从 12 秒降到 4 秒量级。端点不可达时按既有
  //   失败契约返回 {ok:false}，对比测试如实报「直连出口获取失败」，不再苦等。
  var COMPARE_EXIT_TIMEOUT_MS = 4000;

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function normalizeSettings(raw) {
    var s = Object.assign({}, DEFAULTS, raw || {});
    var allowed = PROXY_TYPES.map(function (t) { return t.value; });
    return {
      enableProxy: s.enableProxy === true,
      proxyType: allowed.indexOf(s.proxyType) >= 0 ? s.proxyType : DEFAULTS.proxyType,
      proxyHost: str(s.proxyHost).trim(),
      proxyPort: str(s.proxyPort).trim(),
      bypassList: str(s.bypassList)
    };
  }

  // 解析绕过列表：兼容换行/逗号/分号分隔，# 开头视为注释。
  // 剥离协议头与路径，去重且保持顺序。
  function parseBypassList(text) {
    var seen = Object.create(null);
    var out = [];
    str(text)
      // 除半角 , 与 ; 外，也识别常见全角标点：，；、
      // 中文输入法与从网页复制的内容很容易带入全角标点；
      // 若不识别，整串会被当成一个条目下发，Chrome 视为无效而忽略，
      // 表现为「配了多条规则却一条都没生效」的静默失效。
      .replace(/[,;\uff0c\uff1b\u3001]/g, '\n')
      .split('\n')
      .forEach(function (piece) {
        var item = piece.trim();
        if (!item || item.charAt(0) === '#') return;

        var schemeAt = item.indexOf('://');
        if (schemeAt > 0) item = item.slice(schemeAt + 3);

        // 剥离路径/查询/锚点。
        // 注意：CIDR 写法（192.168.0.0/16、fe80::/10）里的斜杠不是路径分隔符，
        // 必须保留，否则网段规则会被截断而失效。
        var cut = item.length;
        ['?', '#'].forEach(function (ch) {
          var at = item.indexOf(ch);
          if (at >= 0 && at < cut) cut = at;
        });

        // 必须先按 ? / # 截断，再做 CIDR 判断：
        // 否则 192.168.0.0/16?x 的前缀会含查询串，被误判为「非 CIDR」而截断。
        var head = item.slice(0, cut);
        var slashAt = head.indexOf('/');
        if (slashAt >= 0 && !isCidr(head)) {
          cut = slashAt;
        }
        item = item.slice(0, cut).trim();

        if (!item || seen[item]) return;
        seen[item] = true;
        out.push(item);
      });
    return out;
  }

  // 不用正则，避免转义问题；覆盖空格、制表符与换行
  function hasWhitespace(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) return true;
    }
    return false;
  }

  // Chrome 要求代理主机名必须是 ASCII（Punycode 形式）。Chromium
  // extensions/common/api/proxy.json 对 host 字段的原文说明：
  //   "Hostnames must be in ASCII (in Punycode format). IDNA is not supported, yet."
  // 非 ASCII 主机名（中文、带音标、Cyrillic 域名，以及 U+3000 全角空格这类
  // Unicode 空白）能通过旧校验并保存成功，但下发 chrome.proxy.settings.set 时
  // 会被直接拒绝，代理下发失败、状态最终落 error。
  //
  // 判据：host 中每个 UTF-16 码元都 ≤ 0x7F。Punycode（xn--…）本身即 ASCII，
  // 不受影响；IPv6 字面量（::1、[::1]、fe80::1）也全部落在 ASCII 区间。
  function isAsciiHost(s) {
    for (var i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 127) return false;
    }
    return true;
  }

  function isAllDigits(s) {
    if (!s.length) return false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    return true;
  }

  // 判断是否为 CIDR 写法（如 192.168.0.0/16、fe80::/10）。
  // 用于把「网段」与「域名+路径」（如 example.com/path）区分开。
  //
  // 注意：不能只用「斜杠前仅含 [0-9a-fA-F.:]」来判断——域名也由字母组成，
  // beef.cafe/12、abcdef.abc/16 这类纯 hex 域名会被误判为网段而不剥离路径。
  // 因此这里要求斜杠前必须是真正的 IP 字面量形态：
  //   · IPv6：含冒号
  //   · IPv4：恰好 4 段点分十进制，每段 0-255
  function isCidr(s) {
    var slash = s.indexOf('/');
    if (slash <= 0) return false;
    var head = s.slice(0, slash);
    var tail = s.slice(slash + 1);
    if (!tail.length || !isAllDigits(tail)) return false;
    if (Number(tail) > 128) return false;

    // IPv6 字面量必然含冒号
    if (head.indexOf(':') >= 0) return true;

    // 【L-12·审计修复】IPv4 前缀长度上限 32。
    //   此前只查 `Number(tail) > 128`（IPv6 上限），IPv4 分支通过后不再校验 ——
    //   `192.168.0.0/33` 会被判成「网段」原样保留并下发，而 Chrome 对无效前缀
    //   静默忽略，于是「配了规则却一条都没生效」。这正是 M-6/M-7 想要消除的
    //   静默失效形态（程度较轻：是保留而非截断）。现在按「非 CIDR」处理，
    //   斜杠照常被当作路径分隔符剥掉，得到显式的主机规则而不是一条被静默忽略的网段。
    if (Number(tail) > 32) return false;

    // IPv4 字面量：恰好 4 段、全数字、每段不超过 255
    var parts = head.split('.');
    if (parts.length !== 4) return false;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p.length || p.length > 3 || !isAllDigits(p)) return false;
      if (Number(p) > 255) return false;
    }
    return true;
  }

  // 判断是否为「主机:端口」的误写（如 1.2.3.4:8080）。
  //
  // 不能用「含冒号即拒绝」来判断 —— IPv6 地址本身就含冒号，
  // ::1、fe80::1、[::1] 都会被误判为「写了端口」而拒收。
  // 这里只识别真正形如 host:port 的写法：
  //   · 恰好一个冒号（IPv6 有多个）
  //   · 不以 [ 开头（那是 [::1] 这类 IPv6 字面量）
  //   · 冒号之后全是数字（端口）
  var COLON = String.fromCharCode(58);
  function looksLikeHostPort(s) {
    var first = s.indexOf(COLON);
    if (first < 0) return false;
    if (first !== s.lastIndexOf(COLON)) return false;
    if (s.charAt(0) === '[') return false;
    var tail = s.slice(first + 1);
    return tail.length > 0 && isAllDigits(tail);
  }

  // IPv6 字面量下发给 chrome.proxy 时不应带方括号（host 字段直接用 ::1 形式）
  function stripBrackets(host) {
    if (host.length >= 2 && host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') {
      return host.slice(1, -1);
    }
    return host;
  }

  // 【M-6】host 合法字符白名单：字母、数字、点、连字符、下划线；
  //   IPv6 字面量额外允许冒号与方括号（见 isIpV6Shape 的独立判定）。
  //   此前 user:pass@host、a,b.com 这类 Chrome 必然拒绝的写法能通过保存前校验，
  //   错误被推迟到 set 阶段并归因为「代理异常」，误导排障方向 —— 现在提前拦截。
  //
  // 【L-13】下划线曾被列为「待实测」：DNS 主机名不允许 `_`，**若** Chrome 的
  //   chrome.proxy.settings.set 拒绝它，那么白名单含 `_` 就会复现 M-6 那条
  //   「保存通过 → 下发失败 → 归因为代理异常」的误导路径。2026-10-06 在真实
  //   Chromium 1243 里逐项测定（探针只调 set 再回读，不改仓库任何文件），
  //   结论是 **Chrome 全部接受**，且回读原样保留 host：
  //     a_b.com / my_proxy.local / _proxy.com / 10.0.0.1（对照）
  //     bypassList 里的 a_b.com 同样被接受
  //   —— 8 项探针无一被拒。原因是 Chrome 的代理 host 字段只做字符串透传，
  //   不做 DNS 可解析性校验（net::ProxyServer 只在含 scheme/port 时做 URI 解析）。
  //   故【保留 `_` 是正确行为】：删掉它反而成为**过度拒绝**（my_proxy.local 这类
  //   内网/NAS 命名是真实用法，会被挡在保存之前——正是 M-6 想消除的那类误伤）。
  //   该结论由两侧把守：tests/settings.test.js 钉「不误拒」，tests/e2e-smoke.js
  //   的第 ⑥ 条主干钉「保存通过 → 下发 applied → 回读逐字一致」。
  function hasInvalidHostChar(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          c === '.' || c === '-' || c === '_' || c === ':' || c === '[' || c === ']') {
        continue;
      }
      return true;
    }
    return false;
  }

  // 【M-7】主机「形态」收口 · 判据一：方括号只能用于包裹 IPv6 地址。
  //
  //   成因（M-6 的残留面，探针实测复现）：hasInvalidHostChar 把 [ 与 ] **无条件**列入
  //   白名单，而「必须是 IPv6 字面量」的判定（isIpV6Shape）只在 host **含冒号**时触发
  //   —— 于是方括号只在与冒号共存时才受约束，残留下一整类漏放。修复前以下写法全部
  //   通过保存前校验：
  //     a[b].com / foo]bar / [a]b → 括号未配对（stripBrackets 不剥取），Chrome 必拒
  //     []                       → 剥括号后为空串，会被当作空 host 下发
  //     [abc]                    → 剥括号后是纯字母，不是 IPv6。注意不能只靠
  //                                isIpV6Shape 判定：它对 'abc' 返回真（a/b/c 都是
  //                               十六进制字符），必须再要求括号内**含冒号**才能区分
  //     . / ..                   → 纯分隔符串，任何合法主机形态都不可能长这样
  //   与 M-6 同一目标：把 Chrome 必拒写法拦在保存之前，而不是推迟到 set 阶段被拒后
  //   归因为「代理异常」，把用户引去排查代理软件。
  //
  //   防误伤底线：::1 / fe80::1 / [::1] / [fe80::1] / 2001:db8::1 与全部常规主机名
  //   必须继续零错误（settings.test.js 的 M-6 / M-7 段把守）。
  function hasInvalidBracketUse(s) {
    if (s.indexOf('[') < 0 && s.indexOf(']') < 0) return false;
    var bare = stripBrackets(s);
    // 有括号但未配对（stripBrackets 原样返回）→ 非法：a[b].com / foo]bar / [a]b
    if (bare === s) return true;
    // [] → 剥括号后为空串；[abc] → 剥括号后不含冒号（IPv6 字面量必然含冒号）
    if (!bare || bare.indexOf(':') < 0) return true;
    // 括号内必须是真正的 IPv6 形状（仅 [0-9a-fA-F:.]）
    return !isIpV6Shape(bare);
  }

  // 【M-7】主机「形态」收口 · 判据二：至少含一个字母或数字。
  //   覆盖无方括号的纯分隔符串：`.` / `..` / `---` 不是任何合法主机形态（Chrome 必拒）。
  //   与判据一拆成两条，是为了让拒绝文案如实说明各自原因 —— 把 `.` 报成「方括号用法错误」
  //   会指向错误的排障方向，与本项目「如实上报」的基调相悖。
  function hasNoHostLabel(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return false;
    }
    return true;
  }

  // 【M-6】含冒号的 host 必须整体形如 IPv6 字面量（仅 [0-9a-fA-F:.]，允许 [] 包裹）。
  //   looksLikeHostPort 只识别「单冒号 + 全数字端口」，拦不住 example.com:8080:90
  //   （两个冒号）与 host:abc（冒号后非数字）—— 这些写法此前一路漏到 set 阶段才失败。
  //   注意「宁漏勿误伤」的边界：beef:cafe 这类全 hex 串无法与 IPv6 区分，会放行
  //   （Chrome 在 set 阶段拒绝并如实报 error，不构成静默失效）。
  function isIpV6Shape(host) {
    var bare = stripBrackets(host);
    for (var i = 0; i < bare.length; i++) {
      var c = bare.charAt(i);
      if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') ||
          c === ':' || c === '.') {
        continue;
      }
      return false;
    }
    return true;
  }

  // 【L-03】`ip` 字段的形态校验（出口检测响应）。
  //   背景：SECURITY.md / PRIVACY.md 一直声称响应必须包含「有效的 ip 字段」，而
  //   background.js 的 normalizeExitPayload 此前只检查「非空 + 长度 ≤45 + 无空白」——
  //   "not-an-ip" 这类字符串会一路通过，于是无意义的文本被当成出口 IP 展示，
  //   并据「拿到了 ip」被判为「出口检测成功」。文档与实现必须一致，
  //   而收紧实现比改文档更符合本项目「如实上报」的基调。
  //   判据刻意宽松（只排除明显非 IP 的形态，不做完整 RFC 校验，也不做可达性判定）：
  //     · IPv6：仅十六进制字符、冒号与点（点用于 ::ffff:1.2.3.4 这类内嵌 IPv4），且至少含一个冒号
  //     · IPv4：恰好 4 段十进制，每段 0-255
  //   「宁漏勿误伤」：判据不为难合法写法（含前导零、大写十六进制、IPv4 内嵌形式一律放行）。
  function isIpLiteral(v) {
    if (typeof v !== 'string' || !v.length || v.length > 45) return false;
    if (hasWhitespace(v)) return false;
    if (v.indexOf(':') >= 0) {
      var hasColon = false;
      for (var i = 0; i < v.length; i++) {
        var c = v.charAt(i);
        if (c === ':') { hasColon = true; continue; }
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
            (c >= 'A' && c <= 'F') || c === '.') continue;
        return false;
      }
      return hasColon;
    }
    var parts = v.split('.');
    if (parts.length !== 4) return false;
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      if (!p.length || p.length > 3 || !isAllDigits(p) || Number(p) > 255) return false;
    }
    return true;
  }

  function validateSettings(s) {
    var errors = [];
    if (!s.enableProxy) return errors;

    if (!s.proxyHost) {
      errors.push('请填写代理地址');
    } else if (hasWhitespace(s.proxyHost)) {
      errors.push('代理地址不能包含空格');
    } else if (s.proxyHost.indexOf('://') >= 0 || s.proxyHost.indexOf('/') >= 0) {
      errors.push('代理地址只填主机名或 IP，不要带协议或路径');
    } else if (looksLikeHostPort(s.proxyHost)) {
      errors.push('端口请填在独立的端口输入框中');
    } else if (!isAsciiHost(s.proxyHost)) {
      errors.push('代理地址只能使用 ASCII 字符；中文等非 ASCII 域名请先转换为 Punycode（如 例子.中国 → xn--fsqu00a.xn--fiqs8s）再填写');
    } else if (s.proxyHost.indexOf('@') >= 0) {
      // 【M-6】Chrome 的代理 host 不支持 user:pass@host 形式（认证需在代理软件侧配置），
      //   此前这类写法漏到 set 阶段才被拒绝并报「代理异常」。
      errors.push('代理地址不能包含 @；如代理需要认证，请在代理软件中配置用户名密码');
    } else if (hasInvalidHostChar(s.proxyHost)) {
      // 【M-6】合法字符白名单：字母、数字、点、连字符、下划线（IPv6 另见下一条）。
      errors.push('代理地址包含无效字符，只允许字母、数字、点、连字符（IPv6 可含冒号与方括号）');
    } else if (hasInvalidBracketUse(s.proxyHost)) {
      // 【M-7】方括号只能包裹 IPv6 地址（如 [::1]）。
      //   必须在 hasInvalidHostChar 之后、冒号判定之前：前者只判「字符合法性」，
      //   本判据才判「形态合法性」；放在冒号之前才能覆盖「无冒号」的方括号漏放面。
      errors.push('代理地址无效：方括号只能用于包裹 IPv6 地址（如 [::1]）；请检查是否误写了 a[b].com 这类形式');
    } else if (hasNoHostLabel(s.proxyHost)) {
      // 【M-7】至少含一个字母或数字：`.`、`..`、`---` 这类纯分隔符串不是合法主机
      //   （Chrome 必拒）。文案如实说明原因，不得复用方括号那条。
      errors.push('代理地址无效：至少需要包含一个字母或数字');
    } else if (s.proxyHost.indexOf(':') >= 0 && !isIpV6Shape(s.proxyHost)) {
      // 【M-6】含冒号但不是 IPv6 字面量：example.com:8080:90、host:abc 等
      //   Chrome 必拒写法在此拦截（注意必须放在 isAsciiHost 之后，且合法 IPv6 不得误伤）。
      errors.push('代理地址含冒号时只能是 IPv6 地址字面量（如 ::1、fe80::1）；请检查是否误写了 host:port');
    }

    var portNum = Number(s.proxyPort);
    if (!s.proxyPort) {
      errors.push('请填写代理端口');
    } else if (!isAllDigits(s.proxyPort) || portNum < 1 || portNum > 65535) {
      errors.push('端口须为 1 至 65535 之间的整数');
    }
    return errors;
  }

  // 绕过列表的取值来源解析：sync 优先，为空则回退 local。
  // popup 与 background 共用此函数——此前两处各写一套判断，
  // 导致「界面显示」与「实际下发」可能取到不同的值。
  function resolveBypassList(syncValue, localValue) {
    if (typeof syncValue === 'string' && syncValue) return syncValue;
    if (typeof localValue === 'string') return localValue;
    return '';
  }

  function estimateBytes(obj) {
    try {
      return new TextEncoder().encode(JSON.stringify(obj)).length;
    } catch (e) {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  // 【V-01 / W-02】遮蔽现场（shadow 现场）的识别。
  //
  // 与 background.js 的 isLegacyShadowed 的关系：
  //   · 那个是【后台自愈的判据】，必须保守 —— 它要执行写操作（把 sync 清成空串），
  //     误判会真的改动用户数据，因此只认【逐字符相等】；
  //   · 这里是【前台确认门的判据】，代价只是一次确认（用户再点一次即继续），
  //     不写任何数据。因此可以放宽到「sync 里带着内置默认列表的整段痕迹」，
  //     用来覆盖 V-01 那一格（用户在被遮蔽的表单上改字后保存）。
  //   两个判据刻意【不同名、不同文件、语义各自写清】，避免未来被"统一"成一份
  //   而把保守的那一侧悄悄放宽。
  //
  // 判据：把 sync 文本按行规整（去首尾空白、丢空行），若它【以默认列表的整行序列开头】
  //   且默认列表之后【还有内容】（说明被追加/编辑过），则判为遮蔽现场。
  //   逐字符相等的情形由 isLegacyShadowPair 单独处理，不在这里重复。
  function looksLikeShadowEdit(syncListText) {
    if (typeof syncListText !== 'string' || !syncListText) return false;
    var normLines = function (t) {
      return str(t).split('\n').map(function (l) { return l.trim(); })
        .filter(function (l) { return l.length > 0; });
    };
    var syncLines = normLines(syncListText);
    var defLines = normLines(DEFAULTS.bypassList);
    if (!defLines.length || syncLines.length <= defLines.length) return false;
    for (var i = 0; i < defLines.length; i++) {
      if (syncLines[i] !== defLines[i]) return false;
    }
    return true;
  }

  // 遮蔽现场 = sync 是「内置默认列表原样或带编辑」且 local 里躺着一份不同的用户列表。
  //   local 为空时不存在"唯一副本"，任何判据都不成立 —— 这是「不误伤」的底线。
  function isLegacyShadowPair(syncRaw, localRaw) {
    if (typeof localRaw !== 'string' || !localRaw) return false;
    if (localRaw === DEFAULTS.bypassList) return false;
    if (typeof syncRaw !== 'string' || !syncRaw) return false;
    if (syncRaw === DEFAULTS.bypassList) return true;
    return looksLikeShadowEdit(syncRaw);
  }

  // 【L-05】状态（status）与子类型（reason）取值的唯一事实来源。
  //
  //   背景：这两个取值集合此前只以字面量形式散落在 background.js（写入方）与
  //   popup.js（渲染方）两处，没有任何机制保证两侧一致。实测缺口：
  //   `reason:"restore_interrupted"`（对比窗口恢复被 SW 回收打断）在 popup 没有对应
  //   文案，会落到泛化的 error 档「代理异常，流量可能已回退直连」—— 而该情形的语义
  //   恰恰相反：扩展没有故障，且已按最新设置重新下发。这正是「新增状态却忘了配文案」
  //   会静默降级为错误陈述的路径。
  //
  //   机制（刻意【不】重写 background.js 的调用点，以免破坏变异锚点）：
  //   本清单是事实来源，由 tests/manifest.test.js 双向核对 ——
  //     ① background.js 实际写出的 status / reason 字面量集合必须恰好等于本清单；
  //     ② popup.js 必须为每个 status 提供 STATUS_TEXT 键，为每个 reason 提供
  //        `error_<reason>` 键。
  //   于是「新增一个状态但漏配文案」在 CI 里必然变红，而不是静默落兜底。
  //   新增取值时三处同步：本清单 → background 的写入点 → popup 的文案。
  var STATUS = ['applied', 'direct', 'saved_not_applied', 'overridden', 'suspended', 'error'];
  var REASON = ['read_failed', 'control_unknown', 'restore_interrupted'];

  root.EasyProxy = {
    DEFAULTS: DEFAULTS,
    PROXY_TYPES: PROXY_TYPES,
    MAX_SYNC_BYTES_PER_ITEM: MAX_SYNC_BYTES_PER_ITEM,
    TEST_ENDPOINT: TEST_ENDPOINT,
    TEST_ENDPOINTS: TEST_ENDPOINTS,
    TEST_TIMEOUT_MS: TEST_TIMEOUT_MS,
    COMPARE_EXIT_TIMEOUT_MS: COMPARE_EXIT_TIMEOUT_MS,
    STATUS: STATUS,
    REASON: REASON,
    normalizeSettings: normalizeSettings,
    parseBypassList: parseBypassList,
    resolveBypassList: resolveBypassList,
    validateSettings: validateSettings,
    isIpLiteral: isIpLiteral,
    stripBrackets: stripBrackets,
    estimateBytes: estimateBytes,
    looksLikeShadowEdit: looksLikeShadowEdit,
    isLegacyShadowPair: isLegacyShadowPair
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
