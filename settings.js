// settings.js —— 默认值、归一化、校验、纯函数工具  [v2.8.0]
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

  // 出口检测端点：必须支持 CORS，否则 popup 读取不到结果。
  // ipinfo.io 返回 Access-Control-Allow-Origin: *，故无需申请任何 host 权限。
  var TEST_ENDPOINT = 'https://ipinfo.io/json';
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

  root.EasyProxy = {
    DEFAULTS: DEFAULTS,
    PROXY_TYPES: PROXY_TYPES,
    MAX_SYNC_BYTES_PER_ITEM: MAX_SYNC_BYTES_PER_ITEM,
    TEST_ENDPOINT: TEST_ENDPOINT,
    TEST_TIMEOUT_MS: TEST_TIMEOUT_MS,
    COMPARE_EXIT_TIMEOUT_MS: COMPARE_EXIT_TIMEOUT_MS,
    normalizeSettings: normalizeSettings,
    parseBypassList: parseBypassList,
    resolveBypassList: resolveBypassList,
    validateSettings: validateSettings,
    stripBrackets: stripBrackets,
    estimateBytes: estimateBytes,
    looksLikeShadowEdit: looksLikeShadowEdit,
    isLegacyShadowPair: isLegacyShadowPair
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
