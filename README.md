# Easy Proxy by DS4

[![CI](https://github.com/mylastfree/easy-proxy-by-ds4/actions/workflows/ci.yml/badge.svg)](https://github.com/mylastfree/easy-proxy-by-ds4/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个「装上即用」的 Chrome 代理切换扩展：一键让浏览器走本地代理，局域网自动直连，并内置**出口检测**来验证代理是否真的生效。

## 特性

- **开箱即用**：默认代理 `127.0.0.1:10808`（本机 sing-box mixed 入站），装上不用改任何设置。
- **局域网直连**：默认绕过 RFC 1918 三个私有网段与常见内网域名后缀。
- **两种代理类型**：SOCKS5（默认）与 HTTPS。
- **出口检测**：一键查看流量实际从哪里出去，并可对比直连出口来判断代理是否真的生效。
- **状态可见**：图标绿色表示**真实下发成功**，而不是「开关被勾选」。
- **零依赖、零构建**：纯 JavaScript（MV3），不引入任何框架或打包工具。

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本项目目录。
3. （注意）本机存在 Chrome Beta 与稳定版两个通道，请确认当前操作的是你要用的那个。

## 默认设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 启用代理 | 关闭 | 不擅自改变你的网络行为，需手动勾选 |
| 代理类型 | SOCKS5 | Chrome 的 SOCKS5 始终在代理侧解析域名，更私密 |
| 代理地址 | `127.0.0.1` | |
| 代理端口 | `10808` | sing-box mixed 入站，同端口同时提供 SOCKS5 与 HTTP |

### 默认绕过列表

```text
# 局域网私有网段（RFC 1918）
192.168.0.0/16
10.0.0.0/8
172.16.0.0/12

# 常见内网域名后缀
.local
.lan

# 不含点的主机名（如 http://nas）
<local>
```

> `172.16.0.0/12` 不是 `/16`——写成 `/16` 会漏掉 172.17～172.31，而 172.17 常被 Docker 占用。

## 绕过列表写法

| 写法 | 含义 |
| --- | --- |
| `192.168.0.0/16` | 该网段内的 IP 直连（**仅对 IP 字面量生效**） |
| `.local`、`.lan` | 以该后缀结尾的域名直连（如 `nas.local`） |
| `*.example.com` | 匹配全部子域（**不含** `example.com` 本身） |
| `.example.com` | 等价于 `*.example.com` |
| `example.com` | 精确匹配该主机 |
| `example.com:8080` | 仅该端口的请求直连 |
| `<local>` | 不含点的主机名（如 `http://nas`） |

支持换行、逗号或分号分隔；`#` 开头视为注释。

## 连接测试

点击「**测试当前出口**」：显示当前流量的出口 IP、位置与运营商。

点击「**对比直连出口**」：先记录当前出口，然后临时清除代理取一次直连出口，再恢复原配置。两次结果不同即证明代理确实生效。

> 对比期间会**短暂切换为直连**（约一两秒），完成后自动恢复原代理配置。若恢复失败，界面会明确提示，重新保存一次设置即可恢复。

## 状态说明

| 状态 | 含义 | 图标 |
| --- | --- | --- |
| 代理已生效 | 下发成功且由本扩展控制 | **绿 · 代** |
| 未启用代理（直连） | 开关未勾选 | **红 · 直** |
| 已保存，但尚未生效 | 配置不合法（如缺地址或端口） | **红 · 直** |
| 设置被企业策略或其它扩展接管 | `levelOfControl` 非本扩展 | **红 · 直** |
| 代理异常，流量可能已回退直连 | 收到 `onProxyError` | **红 · 直** |

> 两种状态用了**不同的字形**而不只是不同的颜色：**红·直** 表示直连，**绿·代** 表示走代理。
> 这样即使在色觉异常或灰度显示下，也能从字形本身判断当前状态。
> 鼠标悬停在图标上还会显示对应文字提示。

## 已知边界

这些是 Chromium 的既定行为，不是本扩展的缺陷：

1. **网段规则只对 IP 字面量生效**。访问 `http://192.168.31.1` 会直连，但访问解析到同一内网 IP 的**域名**仍会走代理。这是 Chrome 的代理判定发生在 DNS 解析之前导致的，官方文档明确说明只能靠 PAC 脚本解决。
   - 应对：内网域名请用 `.local` / `.lan` 这类**后缀规则**，它们在解析前即可匹配。
2. **不代理回环地址**。`127.0.0.1`、`localhost`、`169.254.x.x` 被 Chrome 隐式直连，且出于安全考虑不建议改动，因此无需写入绕过列表。
3. **SOCKS5 仅代理 TCP**。Chrome 的 SOCKS 不转发 UDP，QUIC/HTTP3 会回退到 TCP。
4. **SOCKS5 不支持认证**。Chrome 未提供 SOCKS5 的用户名密码支持。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 扩展清单（MV3，权限仅 `proxy` + `storage`） |
| `settings.js` | 默认值、归一化、校验（**纯函数，不依赖任何 `chrome.*`**） |
| `background.js` | 代理下发、状态维护、错误监听、出口检测 |
| `popup.js` | 表单渲染、行内校验、测试结果展示 |
| `popup.html` | 界面结构与样式 |
| `icon-{red,green}-{16,32,48,128}.png` | 状态图标，四档标准尺寸。**红·直** = 直连（未启用）／**绿·代** = 走代理（已启用） |

## 隐私说明

- 扩展**不收集、不上传**任何用户数据，没有自己的服务器。
- 唯一的对外请求是「连接测试」功能访问 `https://ipinfo.io/json` 以获取出口 IP，**仅在你主动点击测试按钮时发生**。
- 该端点返回 `Access-Control-Allow-Origin: *`，因此扩展**无需申请任何 host 权限**即可读取结果。
- 代理地址、端口与绕过列表仅保存在 Chrome 的 `storage.sync`（由你的 Google 账号同步，若已登录）。**例外**：绕过列表超过单项 8 KB 上限时会改存 `storage.local`（只留在本机、不跨设备同步），此时 `sync` 里的绕过列表写为空串占位，读取时 local 优先补位。

## 开发与测试

七套功能测试 + 一个变异脚本，全部零依赖，直接 `node` 运行（退出码 0 表示通过）：

| 测试 | 覆盖内容 |
| --- | --- |
| `tests/manifest.test.js` | 清单完整性：版本格式、权限最小化、引用文件存在、HTML/JS 元素 ID 一致（44 项） |
| `tests/settings.test.js` | 纯函数：默认值、类型收敛、绕过列表解析、输入校验、容量估算、主机名 ASCII 判定（66 项） |
| `tests/background.test.js` | 异步逻辑：并发下发的最终一致性、测试期暂停机制、取值一致性、CIDR 判定（38 项） |
| `tests/fix-safety.test.js` | 修复安全性：暂停标志必然复位、串行队列不累积、收紧判定未误伤合法输入（19 项） |
| `tests/concurrency.test.js` | 并发护栏（N1/N2）：暂停计数不泄漏、测试互斥生效（33 项） |
| `tests/ownership.test.js` | 所有权护栏：断言实际生效配置而非存储值，外部接管不夺权也不丢配置（190 项） |
| `tests/popup.test.js` | popup 交互：异常时按钮必须复位，且如实显示失败原因（28 项） |
| `tests/mutation-check.js` | 变异测试：故意破坏每个修复点，确认护栏测试真的会失败（16 项变异） |

七套功能测试合计 **418 项断言**。

```powershell
node tests\manifest.test.js
node tests\settings.test.js
node tests\background.test.js
node tests\fix-safety.test.js
node tests\concurrency.test.js
node tests\ownership.test.js
node tests\popup.test.js
node tests\mutation-check.js   # 运行后会自动还原被变异文件
```

这些测试在 CI 上自动运行（Node 20 / 22 / 24 三个版本），见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

**为什么需要后五套**：纯函数好测所以容易覆盖，异步流程难测所以容易被漏掉——而真正难查的问题（并发、时序）恰好都在异步里。`background.test.js` 用 mock 的 `chrome.*` 环境真实驱动 `background.js`，按「完成时刻」而非「发起时刻」判断最终生效的配置。

**变异测试的意义**：测试通过不等于测试有效。`mutation-check.js` 会逐个破坏修复点，若某项破坏后测试仍然通过，说明那条护栏是「假绿」，需要补用例。当前 16 项变异全部被拦截。

> 两个被测试专门守住的易错点：
> 1. `parseBypassList` 中 CIDR 的斜杠（`192.168.0.0/16`）不能被当作 URL 路径剥离，否则网段规则静默失效；
> 2. `applyProxy` 必须串行化，否则较早发起但较慢的旧配置会覆盖新配置。

## 版本历史

详见 [CHANGELOG.md](CHANGELOG.md)。当前版本 `2.6.0`。

## 安全

权限仅 `proxy` + `storage`，**不申请任何 host 权限**，因此无法读取网页内容、浏览历史或 Cookie。唯一的对外请求是你在点击「连接测试」时访问 `ipinfo.io`。详见 [SECURITY.md](SECURITY.md)。

发现漏洞请走 [私密报告渠道](SECURITY.md)，不要开公开 Issue。

## 许可证

[MIT](LICENSE) © 2026 mylastfree
