# 贡献指南（CONTRIBUTING）

## 基本约定

- **运行时零依赖、零构建**：源码保持纯 JavaScript（MV3），不引入框架或打包工具。devDependencies 只允许开发工具（当前仅 ESLint）。
- **单一实现原则**：业务判据与取值规则只允许在 `settings.js` 存在一份实现，popup 与 background 共用。发现第二份内联实现 = 缺陷。
- **「读不到 ≠ 没有」**：任何 `chrome.storage` / `chrome.proxy.settings.get` 读取失败都必须显式分支上报，绝不归一成默认值继续走写路径。
- **绝不写 `local` 的唯一副本**：自动逻辑不得触碰 `storage.local.bypassList`；清空只能发生在用户明确知情并确认的操作里。

## 改动分级与版本号

| 改动 | 版本 | 例 |
| --- | --- | --- |
| 只改测试/文档，不碰运行行为 | patch（或仅测试修复标签） | 2.2.1 |
| 修缺陷，不新增可观察契约、不改存储键 | patch | 2.7.1 |
| 新增/改变可观察契约（新状态、新 session 键、新提示档、清单字段） | **minor** | 2.8.0 |

版本号必须四处同步：`manifest.json`、三个源文件头（`[vX.Y.Z]`）、`README.md`、`CHANGELOG.md` 首条 —— `tests/manifest.test.js` 与各文件的 G1 自检会拦截不一致。

## 门禁约定（硬性）

1. **改判据必须同步门禁用例**：修改 `settings.js` 的任何判据/守卫时，必须：
   - 补/改对应的测试断言（先红后绿：在旧实现上验证断言确实会失败）；
   - 评估是否需要新增变异项（`tests/mutation-check.js`）证明该断言承重。
2. **改测试必须同步 README**：每个测试文件结尾有 G1 运行期自检，README 表格中声明的断言数与实际通过数不一致时 CI 直接变红；合计与变异数由 `tests/manifest.test.js` 把守。
3. **改 storage.session 键集必须同步 SECURITY.md** 的键清单表格。

## 提交前自检

```powershell
npm run lint        # ESLint（CI 首个失败点）
npm test            # 七套功能测试（708 项断言，tests/run-all.js 统一入口）
npm run coverage    # 可选：c8 覆盖率报告
npm run mutation    # 变异门禁（23 项，本机约 15 分钟）
npm run package     # 可选：验证打包清单
```

发布前另须完成 `docs/E2E-SMOKE.md` 的真实浏览器冒烟清单。

全部通过且 `git status --porcelain` 为空后再提交（变异脚本会临时改写源文件，CI 会核验工作区洁净）。

## 报告问题

缺陷报告请用仓库的 Issue 模板；**安全问题一律走 [SECURITY.md](SECURITY.md) 的私密渠道**，不要开公开 Issue。
