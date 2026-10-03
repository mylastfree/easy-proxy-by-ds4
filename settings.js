// settings.js —— 设置模型的唯一来源  [v2.1.2]
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
      .replace(/[,;]/g, '\n')
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

  function validateSettings(s) {
    var errors = [];
    if (!s.enableProxy) return errors;

    if (!s.proxyHost) {
      errors.push('请填写代理地址');
    } else if (hasWhitespace(s.proxyHost)) {
      errors.push('代理地址不能包含空格');
    } else if (s.proxyHost.indexOf('://') >= 0 || s.proxyHost.indexOf('/') >= 0) {
      errors.push('代理地址只填主机名或 IP，不要带协议或路径');
    } else if (s.proxyHost.indexOf(':') >= 0) {
      errors.push('端口请填在独立的端口输入框中');
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

  root.EasyProxy = {
    DEFAULTS: DEFAULTS,
    PROXY_TYPES: PROXY_TYPES,
    MAX_SYNC_BYTES_PER_ITEM: MAX_SYNC_BYTES_PER_ITEM,
    TEST_ENDPOINT: TEST_ENDPOINT,
    TEST_TIMEOUT_MS: TEST_TIMEOUT_MS,
    normalizeSettings: normalizeSettings,
    parseBypassList: parseBypassList,
    resolveBypassList: resolveBypassList,
    validateSettings: validateSettings,
    estimateBytes: estimateBytes
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
