# 贡献指南（CONTRIBUTING）

## 基本约定

- **运行时零依赖、零构建**：源码保持纯 JavaScript（MV3），不引入框架或打包工具。devDependencies 只允许开发工具（当前：ESLint 静态检查、c8 覆盖率、playwright-core 供 opt-in 的真实浏览器 E2E。**注意**：`playwright-core` 只被 `tests/e2e-smoke.js` 使用，不进 `npm test`、不进 CI 门禁，因此不影响「测试零依赖」这条约束本身）。
- **单一实现原则**：业务判据与取值规则只允许在 `settings.js` 存在一份实现，popup 与 background 共用。发现第二份内联实现 = 缺陷。
- **「读不到 ≠ 没有」**：任何 `chrome.storage` / `chrome.proxy.settings.get` 读取失败都必须显式分支上报，绝不归一成默认值继续走写路径。
- **绝不写 `local` 的唯一副本**：自动逻辑不得触碰 `storage.local.bypassList`；清空只能发生在用户明确知情并确认的操作里。

## 改动分级与版本号

| 改动 | 版本 | 例 |
| --- | --- | --- |
| 只改测试/文档，不碰运行行为 | patch（或仅测试修复标签） | 2.2.1 |
| 修缺陷，不新增可观察契约、不改存储键 | patch | 2.7.1 |
| 新增/改变可观察契约（新状态、新 session 键、新提示档、清单字段） | **minor** | 2.8.0 |

版本号必须**六处**同步：`manifest.json`、`package.json`、`package-lock.json`（顶层 `version` 与 `packages[""] .version` 各一处）、三个源文件头（`[vX.Y.Z]`）、`README.md` 的「当前版本」、`CHANGELOG.md` 首条。

> ⚠️ **这六处并非都有门禁，升版时必须逐处核对，不要假设漏掉会变红。**
>
> - **有断言把守**：`manifest.version` ↔ `CHANGELOG.md` 首条、三个源文件头 ↔ `manifest.version`
>   —— 均由 `tests/manifest.test.js` 的发布一致性断言直接拦截，漏改即 `npm test` 变红。
> - **无断言把守**：`package.json`、`package-lock.json`、`README.md` 的「当前版本」。
>   实测确认过：`tests/` 里读 `package.json` 的地方**只取 `devDependencies`**，
>   没有任何测试读这三个位置（搜索 `当前版本` 命中的两处只是断言名里含这四个字）。
>   这是**如实留白**：补门禁会改变断言数，连带需要同步 README 表格与「合计」/
>   CONTRIBUTING / ARCHITECTURE / CHANGELOG 四处文档，故留作一次独立改动。

## 门禁约定（硬性）

1. **改判据必须同步门禁用例**：修改 `settings.js` 的任何判据/守卫时，必须：
   - 补/改对应的测试断言（先红后绿：在旧实现上验证断言确实会失败）；
   - 评估是否需要新增变异项（`tests/mutation-check.js`）证明该断言承重。
2. **改测试必须同步 README**：每个测试文件结尾有 G1 运行期自检，README 表格中声明的断言数与实际通过数不一致时 CI 直接变红；合计与变异数由 `tests/manifest.test.js` 把守。
3. **改 storage.session 键集必须同步 SECURITY.md** 的键清单表格。
4. **改了「下发 / 回读 / 控制权」相关行为要过一遍 E2E**：`npm run e2e` 是唯一在真实 Chromium 里验证 `chrome.proxy.settings` 语义的护栏。新增一条主干（例如新的控制权取值、新的禁用态模式）时，同步在 `tests/e2e-smoke.js` 补一条流程；只改内部结构（拆函数、改注释）则不需要——E2E 断言的是**可观察行为**，不是实现形状。
   - E2E 的断言数**不进** README 的套件表格与合计（G1 的运行期自检只覆盖七套零依赖套件），但它**另有静态门禁**：`tests/manifest.test.js` 会扫描 `tests/e2e-smoke.js` 里行首的 `t(` 并与 **README / CONTRIBUTING / ARCHITECTURE / docs/E2E-SMOKE.md 四处**声明的数字逐一比对，不一致即红。因此改 E2E 断言数时，这四处必须同改。
   - 该门禁的前提是「E2E 的断言**全部行首无条件调用**」：写在 `if` 里的断言在健康路径上不执行，会让静态计数永远大于运行时计数（实测踩过 42 vs 41）。需要诊断信息时把它塞进抛出的 `Error`，不要写成条件断言。

## 提交前自检

```powershell
npm run lint        # ESLint（CI 首个失败点）
npm test            # 七套功能测试（869 项断言，tests/run-all.js 统一入口）
npm run coverage    # 可选：c8 覆盖率报告
npm audit --audit-level=high   # 依赖漏洞门禁（CI 有此步，阈值 high；新增高危及以上 CVE 即变红）
npm run mutation    # 变异门禁（34 项，本机约 36 分钟）
npm run package     # 可选：验证打包清单（成功后自动清理 dist/ 里同前缀的旧版产物，失败时一个字节都不动）
npm run e2e         # 发布前必跑：真实浏览器冒烟（opt-in，45 项；退出码 2 = 环境未就绪，不计失败）
```

> ⚠️ **`npm test` ≠ 完整门禁。** 它只跑七套零依赖套件（869 项断言），**不含**变异门禁（`npm run mutation`，34 项，另由 CI 单独执行），也不含 E2E（另需可选依赖与浏览器）。「测试全绿」只说明断言通过，不说明断言有效——后者由变异门禁证明。提交/发布前两条都必须单独跑过。

发布前另须完成 `docs/E2E-SMOKE.md` 的**人工**冒烟残余项——`npm run e2e` 已把其中六条主干脚本化（启用 / 禁用 / 外部接管的状态回读与控制权归属、真实流量归属、存储配额降级、含下划线主机名），但**真实外网出口 IP 与 HTTPS/CONNECT 隧道、安装与升级路径、隐身窗口**仍只有人工清单能兜底。

全部通过且 `git status --porcelain` 为空后再提交（变异脚本会临时改写源文件，CI 会核验工作区洁净）。

> ⚠️ **Windows 上中断变异门禁会留下污染，必须手动恢复。**
> 实测：Windows / Git Bash 下 `Ctrl-C`（`kill -INT`）**无法触发** Node 的 `process.on("SIGINT")`
> 处理器，进程直接退出，`background.js` / `settings.js` / `popup.js` 会停留在变异体上，
> 并残留哨兵文件 `.mutation-in-progress`（即「信号安全还原」在 Windows 本地不生效，
> 该问题在 Linux/CI 上不会出现）。此时重新运行本门禁会被**启动守卫拒绝**——这是有意设计，
> 因为带着污染继续跑会把污染内容当作基线。按提示恢复即可：
>
> ```bash
> git checkout -- background.js settings.js popup.js
> rm -f .mutation-in-progress
> ```
>
> ⚠️ **`git checkout --` 会把这三个文件里所有未提交的改动一并丢弃**，不只是变异体。
> 若你当时手头有**未提交的修复**（变异门禁常在「改完还没提交」时跑），请先确认
> `git stash push -m before-recover -- background.js settings.js popup.js` 或先提交，
> 再用上面的命令；否则恢复动作本身会变成数据丢失。
> 若只想丢掉变异体、保留自己的改动，可**按变异项的 `from` / `to` 串反向替换**——
> 变异体是确定性注入的，反替换可精确复原（`tests/mutation-check.js` 的每项都写了 `from` 与 `to`）。
>
> 打包动作同样被哨兵拦住（`tools/package.js` 见到哨兵即拒绝），因此被中断时**不会**产出
> 含变异体的发布包。若不慎把污染代码提交了出去，CI 的「工作区洁净核验」与
> `manifest.test.js` 的逐字节比对会兜底拦截。

## 报告问题

缺陷报告请用仓库的 Issue 模板；**安全问题一律走 [SECURITY.md](SECURITY.md) 的私密渠道**，不要开公开 Issue。
