# 隐私政策（Privacy Policy）

**适用产品**：Easy Proxy by DS4（Chrome 扩展）
**生效日期**：2026-10-05
**最近更新**：2026-10-05

---

## 一句话摘要

本扩展**不收集、不上传、不存储**任何关于你的数据到**我们自己的**服务器；它没有自建服务器，也不包含任何分析、埋点或崩溃上报组件。你填写的代理配置只保存在你自己的浏览器里 —— 其中 `chrome.storage.sync` 里的配置，若你登录了浏览器账号并开启了同步，会由**浏览器自身的同步机制**在你的设备之间同步；那是浏览器厂商的同步服务，不是我们的服务器，我们无法读取。

---

## 1. 我们不收集的信息

本扩展**不**收集、**不**读取、**不**传输下列任何信息：

- 你访问的网页内容、网址（URL）或域名
- 你的浏览历史、书签或下载记录
- 你的 Cookie、登录状态或表单数据
- 你的账号、邮箱、姓名或任何个人身份信息
- 你的设备标识、IP 归属画像或位置轨迹
- 你在扩展界面中填写的代理地址、端口或绕过列表（这些数据只写入浏览器本地存储，见第 3 节）

**技术依据**：本扩展仅申请 `proxy` 与 `storage` 两项权限，**未申请任何 `host_permissions`**，因此从权限层面就无法读取任何网页内容、浏览历史或 Cookie。

---

## 2. 唯一的对外网络请求

本扩展**唯一**的对外网络请求发生在你**主动点击**「测试当前出口」或「对比直连出口」按钮时。不点击就**不会**发生任何对外请求。

- **请求目的**：获取当前流量的出口 IP 与大致位置，用于向你展示代理是否真的生效。
- **请求目标**（按顺序尝试，主端点失败时才尝试备用端点）：
  1. `https://ipinfo.io/json`
  2. `https://ipapi.co/json/`
  3. `https://api.ipify.org?format=json`
- **发送内容**：一个普通的 HTTPS GET 请求。**不携带**任何用户标识、Cookie、账号信息或你填写的任何配置。请求由浏览器发出，因此这些服务会看到你的出口 IP —— 这与你直接用浏览器访问它们没有区别。
- **响应处理**：响应必须通过结构校验 —— `ip` 字段须为 IPv4 / IPv6 字面量形态（由 `settings.js` 的 `isIpLiteral` 判定），否则按端点失败处理并如实提示，不会产出伪造的检测结果。
- **不共享给第三方作其他用途**：除上述出口检测外，本扩展不向任何第三方发送数据，也不存在"出售/共享用户数据"的行为。

> 「对比直连出口」功能会在数秒内临时把浏览器切换为直连，取一次直连出口后自动恢复原有代理配置。该功能仅修改你的浏览器代理设置，不涉及任何数据传输。

---

## 3. 数据存储位置与生命周期

所有配置与运行状态都保存在**你本机的浏览器存储**中，不经过我们的服务器：

| 存储区 | 内容 | 生命周期 |
| --- | --- | --- |
| `chrome.storage.sync` | 代理类型、代理地址、代理端口、不使用代理的网址列表 | 随你的浏览器账号同步（若已登录并开启同步）；卸载扩展即清除 |
| `chrome.storage.local` | 超长绕过列表的副本；以及「状态记录写入失败」的标记文本 | 只留在本机，不跨设备同步；卸载扩展即清除 |
| `chrome.storage.session` | 最近一次的代理状态结论、连接测试结果、待恢复标记 | 浏览器会话结束即自动清除 |

以上存储内容**不会**被本扩展上传到我们的服务器。其中 `chrome.storage.sync` 的内容由浏览器账号的同步机制负责跨设备同步（若你已登录并开启同步），`chrome.storage.local` 与 `chrome.storage.session` 只留在本机。

---

## 4. 我们不需要的权限，就不申请

| 权限 | 用途 |
| --- | --- |
| `proxy` | 读取与写入 Chrome 的代理设置（本扩展的核心功能） |
| `storage` | 保存你填写的代理地址、端口与不使用代理的网址列表 |

**未申请的权限**包括但不限于：`host_permissions`、`tabs`、`webRequest`、`cookies`、`history`、`bookmarks`、`downloads`、`clipboardRead` 等一切可读取浏览内容的权限。

---

## 5. 儿童隐私

本扩展不面向儿童，也不会有意收集儿童的个人信息（事实上它不收集任何人的个人信息）。

---

## 6. 政策变更

本政策如有变更，将同步更新本文件与扩展仓库中的版本记录，并相应更新文首的"最近更新"日期。由于本扩展不收集任何数据，预期不会发生实质性变更。

---

## 7. 联系方式

如对本隐私政策或数据处理方式有疑问：

- 提交 Issue：<https://github.com/mylastfree/easy-proxy-by-ds4/issues>
- 安全问题请走仓库的 [私密漏洞报告渠道](SECURITY.md)，不要开公开 Issue。

---

## English Summary

**Easy Proxy by DS4** does not collect, transmit, or store any personal data on any server. It has no backend server, no analytics, and no crash reporting.

- **Permissions**: only `proxy` and `storage`. **No `host_permissions`** are requested, so the extension cannot read page content, browsing history, or cookies.
- **Only outbound request**: when you click the exit-IP test button, the extension performs a plain HTTPS GET to one of `ipinfo.io`, `ipapi.co`, or `api.ipify.org` to read your exit IP. No identifiers, cookies, or configuration values are sent. No request occurs unless you click.
- **Local storage only**: proxy settings, bypass list, and runtime status are kept in `chrome.storage` on your own device and are never uploaded.
- **No third-party sharing** beyond the exit-IP endpoints described above, and no sale of user data.

Contact: <https://github.com/mylastfree/easy-proxy-by-ds4/issues>
