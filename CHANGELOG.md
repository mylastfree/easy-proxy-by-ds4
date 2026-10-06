# 变更记录

本文件记录本扩展的所有重要变更。

## [2.15.0] - 2026-10-06

关闭对 **工作区**（`D:\chrome-extensions`，基线 v2.13.0）的审计报告中的全部 6 项（H-1 / M-1 / L-1 / L-2 / L-3 / L-4）。该轮审计的范围**大于**本仓库：工作区根目录同时存在本项目、一份更早的克隆与两个未纳入版本控制的遗留目录，因此它的两项「高 / 中」级发现在**仓库之外**（凭据与遗留副本的处置），仓库内只有 4 项「低」级。测试断言数 839 → **852**（`manifest.test.js` 98 → 110、`ownership.test.js` 309 → 310，其余五套不变），变异门禁维持 **34** 项。按仓库惯例升 minor：本版**改变了 `npm run package` 的可观察行为**（打包成功后清理 `dist/` 中的同前缀旧版目录，见 L-2）。

### 清理（高 / 中，均发生在仓库之外）

- **H-1 未加密的私钥与配套打包文件散落在工作区根目录**：`D:\chrome-extensions\easyproxyBYcursorAI.pem`（1704 B，`-----BEGIN PRIVATE KEY-----`，即**未加密**的 PKCS#8 私钥）与 `easyproxyBYcursorAI.crx`（12165 B）直接躺在工作区根。**证据核对**：① 该目录**不是 git 仓库**（根目录无 `.git`），因此没有任何版本控制记录会泄露它，同时也意味着**没有任何备份**；② 在主仓库全量历史里检索 `git log --all --diff-filter=A --name-only | grep -iE '\.(pem|crx)$'` → **空**，即这两个文件**从未进过本仓库**。结论：残余风险只在**云同步 / 备份 / 目录分享**这一侧（OneDrive 正在同步该盘），而既然**无法证明这把私钥从未被上传**，正确的处置是**废除**（在 Chrome 开发者后台删除对应条目或重新生成密钥对），而不是「加密保存」—— 加密只保护静态文件，救不回已经外流过的密钥。**本次处置**：两者**移入回收站**（可回滚，用户选定），并在本记录中显式声明「已废除为宜」。本仓库对此的动作是**不做动作**（无需 `.gitignore` —— 它们本就不在仓库内），仅登记事实与证据。
- **M-1 两个遗留目录**：`easyproxyBYcursorAI/`（25 K，6 个文件，是扩展的早期手工副本）与 `_v220b/`（411 K）。**风险评估不对称**：① 前者**不在任何 git 仓库内**，是**唯一副本**，删除即永久丢失其内容；② 后者经 `git remote -v` 核实为**本仓库的旧克隆**（`origin = https://github.com/mylastfree/easy-proxy-by-ds4.git`，分支 `main`）⇒ 内容可从 GitHub 完整复现，**信息损失为零**。两者**移入回收站**（用户选定「都移入回收站」），保留可回滚性；磁盘空间只有在清空回收站后才真正释放。

### 修复（低）

- **L-1 `popup.html` 帮助面板里的 `<local>` 被当成标签**：帮助面板用 `<pre>` 展示「支持哪些写法」，其中一行是「不含点的主机名（如 `http://nas`），用 `<local>` 表示」—— 但 `<local>` 写成了**裸标签**。它会被 HTML 解析器当作**未知元素**吃掉（不显示），用户看到的是「用  表示」这样的信息缺失；更糟的是它与**紧邻的字面量行 `.local  .lan`** 形态相似，维护者极易误判「这行本来就是文本」。修复：改写为转义实体 `&lt;local&gt;`；**刻意不动**相邻的 `.local` / `.lan` 行（它们是字面量、本身无需转义，过度转义会让用户看到 `&amp;lt;`）。`manifest.test.js` 新增 5 项断言：先证明帮助面板可定位且非空（**防止本组断言恒真的假绿** —— 本项目已多次踩到），再要求「转义形式存在」「全文不存在未转义的 `<local>`」「`.local`/`.lan` 仍是字面量且未被过度转义」三者同时成立（只断言「没有裸标签」是不够的：删掉整行也能让它变绿），最后**把「对齐」也变成机器判据**（见下）。
  - **本修复第一版就是错的，且只有机器判据抓住了它**：转义会把该行的**源码列数**撑大 5 列，而 `<pre>` 的对齐是按**解码后**的列计算的（`&lt;local&gt;` 只占 7 列）。第一版照源码列数把行尾补空格从 12 个减到 7 个，注释里还写着「保持列对齐」—— 实测解码后该行说明文字落在第 **19** 列、其余写法行落在第 **20** 列，视觉上是错的。因此新增第 5 项断言的判据是「解码后，本行的说明列 === 相邻写法行的说明列」，并做了红绿双向证明（补空格改回 11 个 → 18 vs 19，断言红）。这正是本项目既有教训的又一次复现：**「人工复查看不出对齐差一列」**，而 padding 这类数字一旦没有断言就会被静默改回。刻意只比对「本行 vs 相邻行」，不做全表启发式 —— 新增示例行不该让本组变红。
- **L-2 打包后 `dist/` 并存多个版本，使用者可能选中旧代码**：`npm run package` 只产出 `dist/easy-proxy-by-ds4-<版本>/`，**从不清理上一次的产物**。实测 `dist/` 里同时存在 `2.11.0` / `2.13.0` / `2.14.0` 三个目录，而「加载已解压的扩展程序」需要用户**手动选目录** —— 这是一个由**目录并存**直接导致的误操作面（装了一个旧版本，回读行为全是旧的，排查成本极高）。修复：`tools/package.js` 新增 `cleanStaleArtifacts(destRoot, keepDir)`，在 **CLI 成功路径**（复制与逐字节自校验都通过之后）清理「同前缀 + 严格版本号形态」的兄弟目录。四条刻意的边界：① **只在成功后清理** —— 打包失败时一个字节都不动，避免毁掉上一次可用的产物；② **只清 `^easy-proxy-by-ds4-\d+\.\d+\.\d+`** —— 当前版本目录、同名非版本目录（如 `…-backup`）、无关目录一律保留；③ **清理归属 CLI 层，`pack()` 本身不清理** —— 产物生成逻辑必须保持「纯复制」以便被测试与复用；④ **删除失败只记尽力而为**（`try/catch` 不抛），清理是便利性而非正确性前提 —— 某个旧目录可能正被占用或权限不足，正确行为是「跳过它、继续清其余、整次打包照常成功」。`manifest.test.js` 新增 **7 项**断言，覆盖上述四条边界 + 幂等（连续两次打包不会自删当前版本）+ 目录不存在时返回 `[]` + **故障注入**（临时替换 `fs.statSync` 让某个旧目录抛错，证明单点失败既不中断清理也不让打包失败 —— 并为 `tools/package.js` 保住 100% 行覆盖）。
- **L-3 端点的 CORS 要求被归因给了错误的执行者**：`settings.js` 的 `TEST_ENDPOINTS` 上写着「必须支持 CORS，否则 popup 读取不到结果」。**归因错误**：全库检索 `fetch(` 只出现在 `background.js`（`fetchExit`），**popup 从不发起任何请求**，它只是通过消息通道消费结果。后果描述是对的（CORS 确实会导致读不到结果），但把机制记在了错误的文件上 —— 后来者按注释去 popup 里找请求逻辑会一无所获，进而可能把端点配置改到错误的位置。**这是一条纯注释修复，行为零改动**：改写为指明「请求由 MV3 Service Worker 发起（见 `background.js` 的 `fetchExit`）」并保留原结论。之所以单列一项：注释是**后来者的唯一导航**，错误归因与错误代码同样昂贵。
- **L-4 三处 error 路径漏落 `pendingResubmit`，且真正承重的是第三处**：`lastState` 的 `pendingResubmit` 字段语义是「**暂停期间的配置变更仍未下发**」，是冷启动对账与用户判断的唯一持久线索。审计指出收尾（`windowFinalizeCommit`）的两条 error 路径只写 `status`/`message`，于是该事实**只剩内存里的 `suspendDirty`**，SW 一旦被回收即永久丢失（用户以为「已保存」，实际从未下发）。修复时按「先红后绿」验证，得到两个超出报告本身的发现：① 只改收尾那两处**断言仍然红**（`pendingResubmit === undefined`）；② `grep` 全部 `writeState({` 调用点后定位到**真正承重的一处是 `applyProxyCore` 自身的 set 失败 `catch`** —— 第四步的兜底重放会**再次调用** `applyProxyCore`，而重放发生在收尾**写状态之后**，因此它内部这条写入会**覆盖**掉刚才那条更完整的状态。三处（抛异常 / 未达终态 / `overridden`）现写法一致，`ownership.test.js` 的 R6-01 用例（该用例已天然同时具备「窗口内记脏」与「收尾真实失败」两个前提）新增 1 项断言把末次状态钉住。**教训**：这类「同一事实被多处写入」的缺陷，**必须从全部写入点反向确认谁是最后一次写**，只改报告点名的那一处会得到「代码改了、行为没变」的假修复。

### 工程与文档

- **编号族不需要新增**：本轮标注统一为 `【L-N·工作区报告修复】`，`L` 族已在 `ARCHITECTURE.md` §7 登记（新增未登记的族会让 CI 直接变红 —— 这正是 L-6 门禁的设计意图）。但同一符号在本轮与 v2.13.0 一轮**指不同的缺陷**（`L-1` 在 v2.13.0 指 `estimateBytes` 的不可达 `catch`，在本轮指 `popup.html` 的裸 `<local>`），因此 §7 的「编号分轮次作用域」说明里补登了本轮后缀 `·工作区报告修复`，与既有 `·审计修复` 并列。
- **文档同步**：README（表格断言数、合计 839 → 852、覆盖率段实测值、`当前版本` → 2.15.0）、CONTRIBUTING（852）、ARCHITECTURE（852 + §7 轮次后缀）。

### 验证

- `npx eslint .` → 0（无新增告警）
- `npm test` → 七套 **852 项全绿**（110 + 111 + 46 + 19 + 40 + 310 + 216），G1 文档一致性自检全部通过
- `npm run coverage` → c8 门禁通过（阈值：行/语句 85、函数 95、分支 74）。实测行覆盖 **background 97.2% / settings 100% / popup 96.3% / tools/package.js 100%**，分支覆盖 **background 86.0% / settings 95.7% / popup 84.3% / tools/package.js 76.8%**（新增的「尽力而为」分支带故障注入用例，使 `tools/package.js` 保住 100% 行覆盖、分支覆盖由 68.3% 升到 76.8%），函数覆盖 100%；合计行 97.5% / 分支 87.1%
- `npm run package` → 打包前 `dist/` 中并存 `easy-proxy-by-ds4-2.11.0` / `…-2.13.0`，执行后仅剩 `dist/easy-proxy-by-ds4-2.15.0`（逐字节自校验通过）—— **同一命令顺带清掉两个旧版目录**，即 L-2 的端到端证据（不靠人工删除、不靠单测桩）
- `npm run e2e` → **22/22 通过**（退出码 0）：真实 Chromium（`chromium-1243`）加载**本版打包产物** `easy-proxy-by-ds4-2.15.0`，三条主干（启用 → `applied` / 禁用 → 未残留且回到基线 / 外部接管 → `overridden` 且不夺权）全部实测，popup 与夹具页面均无未捕获异常。**这是 per-item 修复可依次验证的一环**：v2.15.0 改了 `popup.html`（帮助面板）与 `background.js`（error 路径状态字段），二者都参与 E2E 的驱动路径与状态回读，因此本轮的 E2E 不是走过场。
- **变异门禁 34 项**：本机执行环境仍带「单轮批量删除配额」安全策略（`CODEBUDDY_SAFE_DELETE_BULK_*`），34 项 × 7 套测试累计远超配额 ⇒ 基线中止，**属环境限制、非仓库缺陷**（同 v2.13.0 / v2.14.0 的如实声明）。本机完成的替代核验：34 条变异锚点在改完 `popup.html` / `settings.js` / `background.js` 后**逐条比对 `from` 串仍唯一命中**（脚本比对命中数，当前树与 `0cec123` 基线全部一致，含既有的非唯一锚点 `M2`=13 / `M4`=2 也一致；锚点失配会被门禁判为「注入失败」= 门禁自身故障，最容易与「变异被拦截」混淆）；最终以 CI（干净 Linux runner）为准。

## [2.14.0] - 2026-10-06

关闭对 v2.13.0（`d5fb18b`）的全维度代码审计（评分：阻塞 0 / 严重 0 / 一般 3 / 低 8）中的**全部 11 项**。三类性质：① **上线流程未闭环**（M-3：真实浏览器 E2E 从未执行 —— 审计明确把它列为**唯一的上线前置条件**，在它完成前不应打 tag）；② **声明与机制脱节**（M-1 的「逐字节可复现」跨平台不成立）；③ **可维护性与可观测性缺口**（M-2 超大函数、L-1…L-8）。测试断言数 788 → **839**（`manifest.test.js` 81 → 98、`settings.test.js` 110 → 111、`background.test.js` 38 → 46、`popup.test.js` 191 → 216；`ownership` 309 / `fix-safety` 19 / `concurrency` 40 不变），变异门禁维持 **34** 项。**新增真实浏览器 E2E 冒烟**（`tests/e2e-smoke.js`，22 项断言，opt-in `npm run e2e`）。按仓库惯例升 minor：本版新增**用户可见契约**（L-7 状态条严重度符号）、新增 devDependency（`playwright-core`，仅 E2E 使用）、新增 npm script 与 `.gitattributes`。

### 修复（中）

- **M-1「逐字节可复现」的声明跨平台不成立（缺 `.gitattributes`）**：`tools/package.js` 一直声称「任何人在**任意机器**上对同一提交执行本脚本都得到**逐字节相同**的产物」，而仓库没有 `.gitattributes`，工作树行尾只能依赖各人的 `core.autocrlf`（**本机配置、不随仓库分发**）—— 实测 `git ls-files --eol background.js` 为 `i/lf w/crlf`：**索引存 LF、工作树为 CRLF**，于是同一提交在 Windows 打包出的 `.js/.html/.json` 与 Linux CI 的字节不同；而 `pack()` 的逐字节自校验只比对**同一工作树内**的源文件与产物，结构上不可能发现跨平台差异。`.editorconfig` 声明的 `end_of_line = lf` 同样从未被实际检出遵守。修复：新增 `.gitattributes`（`* text=auto eol=lf` + `*.png binary`），用 `git add --renormalize .` 把工作树行尾统一回 LF，`tools/package.js` 的文件头声明显式引用 `.gitattributes`（声明与机制挂钩）；`manifest.test.js` 新增 4 项断言把「属性文件存在」「行尾钉死为 LF」「`.png` 显式二进制」「声明引用机制」固化 —— 否则该文件日后被删或改宽，那条声明会再次变成一句无支撑的承诺。
- **M-2 超大函数集中（`applyProxyCore` 263 行、`renderTest` 140 行）**：审计给出两项证据 —— `background.js` 76 个与 `popup.js` 86 个未覆盖行**全部**落在这几个巨型函数内，且变异粒度被迫停在「整个函数」层级（这已是连续三个版本 A3 → L-10 → M-2 未处置的同一项）。修复：**逐字搬移式**拆解，不改任何控制流与判据 —— `background.js` 抽出 `judgeApplyOutcome` / `judgeCompareEntry` / `applyEnabledSettings` / `ensureControlBeforeApply` / `buildProxyConfig` / `windowClearAndSampleDirect` / `windowFinalizeCommit` / `applyDisabledSettings`，`applyProxyCore` 退化为「读配置 + 二选一」；`popup.js` 抽出 `buildTestHeader` / `classifyTestResult` / `prepareSave` / `handleSaveFailure` / `saveShadowBranch` / `saveGenericBranch`。结果：最大函数 263 → **103 行**（纯代码行最大 73），且 `classifyTestResult` 被抽成**不碰 DOM 的纯函数**后可被直接单测（同时解掉 L-5）。**硬约束**：变异门禁的 34 条注入锚点是**逐字节字符串**，搬移必须保持原文与**原缩进**，否则锚点失配会被判定为「注入失败」= 门禁自身故障；因此部分被抽出的函数体刻意保留 4 空格缩进，并在注释里写明理由（与 `judgeApplyOutcome` / `windowFinalizeCommit` 同款说明）。搬移后逐条核对：34 条锚点**全部仍唯一命中**（脚本比对 `from` 串，命中数 0 失配）。
- **M-3 真实浏览器 E2E 未自动化（审计的唯一上线前置条件）**：788 项断言全部跑在 Node 里的 `chrome.*` **替身**之上 —— 它们能证明「我们的逻辑按预期处理了给定的回读结果」，但证明不了「Chrome 会给出我们所假设的回读结果」，而这正是本项目缺陷密度最高的地方。修复：新增 `tests/e2e-smoke.js`（opt-in `npm run e2e`），用 Playwright 驱动**真实 Chromium** 加载**打包产物**，按审计指定的三条主干覆盖 **22 项断言**：① 启用 → 回读 `levelOfControl === controlled_by_this_extension` 且 `mode === fixed_servers` 且 `singleProxy` 与设置逐字段一致；② 禁用 → 回读确认**未**残留本扩展的 `fixed_servers`、签名**完全回到测试前基线**、`lastState.status === direct`、实际模式非 `direct` 时如实上报 `systemProxy`；③ **外部接管** → 第二个夹具扩展（`tests/e2e/fixtures/interloper/`）写入自己的 `fixed_servers` 后状态落 **`overridden` 而非 `applied`**，且本扩展**不夺权**（生效配置仍是接管者的 `127.0.0.1:19999`，不是本扩展的 `10808`）。四条**实测得来的**技术结论已写进代码注释，避免后来者重踩：① MV3 的 Service Worker **无法给自己** `sendMessage`（实测 `Could not establish connection. Receiving end does not exist.`），驱动必须来自扩展页面（用产品自己的 `popup.html`，顺带覆盖真实消息通道与 `sender.id` 来源校验）；② 用 `{action:"reapply"}` 的**返回值**作为下发完成信号，不用任何固定 `sleep`；③ 禁用后回读的真实模式在本机是 **`system` 而不是 `direct`**（`clear()` 只清我方槽位、下层系统代理重新显现）—— 因此「未残留」的判据做成**与测试前基线逐字段比对**，硬编码 `direct` 会让这条断言在 Linux（direct）与 Windows（system）上二选一必红；④ 夹具扩展 ID 由 Chromium **随机分配**，只能通过每个 SW 的 `chrome.runtime.getManifest().name` 反查，不能硬编码扩展页面 URL。**刻意 opt-in**：不并入 `npm test`、不进 CI 门禁（它需要可选依赖与 Chromium 二进制，并入门禁会让「测试必须环境无关」这条硬约束失效）；退出码语义为 `0` 通过 / `1` 断言失败（真实缺陷）/ `2` 环境未就绪（缺依赖、缺浏览器或变异哨兵在位，**不计为失败**）。本机实测 **22/22 通过**（有头与无头各一次，退出码 0），环境未就绪路径实测退出码 2。

### 修复（低）

- **L-1 `estimateBytes` 的 `catch` 不可达**：`JSON.stringify` 对普通对象不抛、`TextEncoder` 对字符串不抛 ⇒ 该分支既不可达也不可覆盖（`settings.js` 仅有的未覆盖行）。审计给了两个选项（加注释声明不可达 / 去掉 `try` 让异常冒泡）。**本版显式偏离两者**，取第三条路：保留 `try` 并让该分支被**真实用例覆盖**。理由：`estimateBytes` 的结果会被拿去与 8192 字节上限比较大小，一旦序列化真抛（循环引用对象、`BigInt`）而异常冒泡，会直接打断 popup 的保存流程；返回 `Number.MAX_SAFE_INTEGER` 则让「超长」判定成立并走既有的**降级保存**路径（写 `local` + `sync` 空串占位），是更安全的失败方向 —— 这是**防御性分支本身有价值**，而不是可以删掉的死代码。新增 1 项断言：用循环引用对象真实验证该分支（`settings.test.js` 110 → 111）。非循环输入的行为一字未变。
- **L-2 打包脚本自身的失败路径零覆盖**：`.c8rc.json` 的 `exclude` 含 `**/tools/**`，而 CLI 逻辑直接写在 `main()` 里并调用 `process.exit` ⇒ 「发布产物的唯一来源」这个脚本的失败分支（`process.exit(1)`）**从未被执行过**。一旦复制失败被静默吞掉（例如错误地 `return` 而非 `exit(1)`），发布流水线会「成功」地交出**残缺产物**而无人察觉。修复：把 CLI 入口收成**可注入的 `runCli(opts)`**（返回退出码而不结束进程），`pack(destRoot, opts)` 支持 `opts.root` 以注入夹具目录；`.c8rc.json` 改为**包含** `tools/package.js`（去掉对 `tools/**` 的排除）。`manifest.test.js` 新增 **10 项**断言：`runCli` 成功（退出码 0 / 无错误日志 / 确实产出 `<名>-<版本>` 目录 / 目录名进入 log）与失败（退出码 1 / 错误写入 `logErr` 且以 `错误：` 开头）两条路径、`pack` 的三条失败分支（清单遗漏引用、源文件缺失、产物逐字节自校验不一致）与「检出不一致后**删除**已产出目录」。**关键手法**：触发「产物不一致」用**故障注入**（临时替换 `fs.copyFileSync`，让复制出的 `popup.js` 内容与源不同）而非真实并发（真实并发无法稳定复现）；刻意**不引入 `Buffer`** —— 测试环境的 globals 白名单里没有它，用它会直接被 `no-undef` 拦下。结果：`tools/package.js` 行覆盖 **0% → 100%**；打包 CLI 对用户可见的部分（stdout 文案、退出码）一字未改。
- **L-3 `applyProxyCore` 的失败分支无正向用例**：`!details` / `!levelOfControl` / `overridden` 三条分支恰是 **R3-04「失败开放」修复的承重分支**，此前只有变异**间接**保证，没有任何正向断言。修复：`background.test.js` 新增 `proxyGet` 注入式用例，分别构造「回读返回 `null`」「回读缺 `levelOfControl`」「回读 `controlled_by_other_extensions`」三种载荷，断言各自落到 `error` / `error` / `overridden`，并且在这三种情形下**都没有写回代理** —— 即「失败开放」确实被挡住，而不是只靠变异体提示。
- **L-4 两处「读取失败即跳过」的保守分支未覆盖**：`background.js` 的存量污染自愈（sync 读失败）与待恢复对账（session 读失败）两条「宁可不动也不误写」的路径从未被执行。修复：各注入一次 `lastError`，断言「未发生任何写入 + 如实告警 + 终态与无失败时一致」。两处细节：① sync 那处用**调用计数器**只让**第一次** sync 读失败，否则会把后续所有 sync 读一并关掉，测到的就不是目标分支了；② 断言对象是**终态**（`session.lastState`）而不是某一刻的中间值。**稳定性教训（重要）**：这三条断言最初反复假红，根因不是缺陷 —— 是并发跑的覆盖率进程把 CPU 占满，而用例里用的是**固定 `sleep()`**。改为 `waitFor(谓词)` 轮询（5 ms 间隔、5 s 上限、默认 5000 ms）后隔离重跑 3/3 全绿。这正是仓库既有教训（「点击 → 固定 sleep → 断言异步」是假红来源）在 E2E 之外的又一次复现：**凡是断言异步结果，一律等完成信号或轮询谓词，不许 sleep**。
- **L-5 `renderTest` 的结论渲染分支未覆盖**：出口检测的 `verdict`/`kind` 判定与 DOM 渲染混在一个 140 行函数里，而这是**用户唯一看到的结论面**（历次修复文案 —— 第 6 条 `overriddenDuringRestore`、R6-01 的 `activeMode` 判定、`stateSuperseded` —— 全在此），却没有任何渲染断言。修复：按审计建议把「`result` → `verdict`/`kind`」抽成**不碰 DOM 的纯函数 `classifyTestResult`** 并直接单测 **20 组**组合（覆盖各结论档与降级档），同时把测试头渲染抽成 `buildTestHeader`（一并缓解 M-2）。
- **L-6 注释编号无索引**：全仓约 92 处 `【X-NN】` 跨 9 个前缀族，**无集中登记**，新增编号只能靠人工避免冲突、跨文件引用无法机械定位。修复：`ARCHITECTURE.md` 第 7 节新增「缺陷 / 修复编号索引」，写清**编号规则**（编号是**分轮次作用域**的、**不跨轮唯一** —— 同一个 `M-1` 在 v2.10.0 一轮指「表单重绘丢失焦点」、在 v2.13.0 一轮指「缺 `.gitattributes`」，解读必须连轮次一起读；并显式点明 `M` 族与变异编号 `M1…M34` **同符号不同域**），登记 10 个族及其主要出处，并留下一行「编号族（机械校验用，勿删）」供机械校验。`manifest.test.js` 新增 **3 项**断言：解析该行、确认扫描**确实命中 ≥ 8 族**（防正则失效导致断言恒真 —— 这是本项目反复踩过的假绿形态）、实际出现的族集合 === 登记集合（**新增族却忘了登记即 CI 变红**）。刻意只做**族级**登记：逐条列 139 个编号既不可维护、也会立刻漂移。同时把历史遗留如实写进文档（`L-05` 与 `L-5` 并存、族内跳号、同轮跨族撞号），不假装整洁。
- **L-7 状态呈现仅靠颜色区分**：v2.13.0 已给 `#statusBar` / `#hint` / `#testResult` 补了 `role="status" aria-live="polite"`，但红/绿图标与状态条**仍只靠颜色**区分「已生效 / 错误」—— 色觉障碍用户与灰度截图下无法分辨关键状态。修复：状态条文案**前置严重度符号**（`✓` 已生效 / `⚠` 提示或待处理 / `✗` 故障 / `·` 中性未启用），使两种呈现面（图标字形 + 状态条符号）口径一致；严重度查表在 `renderStatus` 内声明，避免引入前向引用（该函数被测试用源码切片加载）。README 的图例补充「颜色 + 符号」双编码说明。`popup.test.js` 新增 4 项断言（**每种严重度都必须带对应符号**，退回只靠颜色即变红），并同步更新 3 条既有断言的期望字符串（其文本包含状态条正文）。**这是本版唯一的用户可见界面变化**，也是按 minor 升版的直接依据之一。
- **L-8 依赖升级债长期挂起（`eslint` 9→10、`actions/checkout` 4→7、`actions/setup-node` 4→7）**：3 个 dependabot **跨大版本** PR 长期未处置。修复（按审计建议的「排一个版本专做升级」）：`eslint` 升到 **10.12.0** —— 先单独升级并处理规则变更，实测在既有规则集下 `npx eslint .` **零改动通过**（无需调整任何规则）；两个 action 一次性升到 v7 系（`checkout` → `3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`、`setup-node` → `820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`），**仍固定到 commit SHA**（供应链最小信任），注释同步写成**实际 tag** 以免出现「注释写 v4、SHA 已是 v7」的名实不符；升级前先核实本仓库用到的输入（`node-version`、`cache`）在 v7 中仍受支持。`npm audit --audit-level=high` → **0 漏洞**。`eslint` 10 的 `engines` 要求 `^20.19 || ^22.13 || >=24`，与 CI 矩阵 `20 / 22 / 24` 兼容。`ci.yml` 中「devDependencies 仅含 eslint 与 c8」的陈述同步更正。**同时显式声明**：本轮按 SHA 手工升级三者，因此对应 dependabot PR 可直接关闭；`MEMORY.md` 中「不要合并 dependabot 跨大版本 PR」的旧结论在本轮被**有证据地**取代（不是绕过，是先核实再手改）。

### 工程与文档

- **`.gitattributes` 与 `.editorconfig` 的关系**：后者的 `end_of_line = lf` 只约束**支持它的编辑器**，不约束 git 检出；真正决定检出与打包字节的是 `.gitattributes`。两者现在一致。
- **`tests/e2e/fixtures/interloper/`** 是**仅用于 E2E** 的第二扩展夹具（权限只有 `proxy`，SW 只做一行存在性心跳、**不写任何代理配置** —— 接管动作由测试在夹具页面的上下文中显式发起，使「何时接管」完全可控可断言）。它在打包时被排除，不进入发布产物。
- **文档同步**：README（表格断言数、合计 788 → 839、覆盖率段、新增 `npm run e2e` 说明与三条主干验收表、`当前版本` 更正为 2.14.0 —— 该字段此前停留在 2.12.0 且无任何门禁把守）、CONTRIBUTING（devDependencies 逐名声明、839、E2E 自检项与新增第 4 条门禁约定）、ARCHITECTURE（§6 新增 E2E 护栏行）。

### 验证

- `npx eslint .` → 0（eslint 10.12.0）
- `npm test` → 七套 **839 项全绿**（G1 文档一致性自检全部通过）
- `npm run coverage` → c8 门禁通过（阈值：行/语句 85、函数 95、分支 74）。实测行覆盖 **background 97.2% / settings 100% / popup 96.3% / tools/package.js 100%**，分支覆盖 **background 86.0% / settings 95.7% / popup 84.4% / tools/package.js 68.3%**，函数覆盖 100%，合计行 97.5% / 分支 86.9% —— 相比 v2.13.0（行 94.61% / 分支 85.58%）整体上升，主因是 L-3/L-4/L-5/L-7 的新用例恰好打在全套未覆盖行最集中的那几个巨型函数上（M-2 的直接收益），以及 `tools/package.js` 从被排除变为纳入并达 100% 行覆盖。
- `npm run e2e` → **22/22 通过**（真实 Chromium 加载打包产物；有头与无头各实测一次）
- `npm run package` → `dist/easy-proxy-by-ds4-2.14.0`（14 个运行文件，逐字节自校验通过）
- **变异门禁 34 项**：本机执行环境仍带「单轮批量删除配额」安全策略（`CODEBUDDY_SAFE_DELETE_BULK_*`），34 项 × 7 套测试累计远超配额 ⇒ 基线中止，**属环境限制、非仓库缺陷**（同 v2.13.0 的如实声明）。本机完成的替代核验：34 条变异锚点在全部拆解后**逐条比对仍唯一命中**（若锚点失配，门禁会判为「注入失败」而非「被拦截」—— 这是本轮 M-2 拆解最需要自证的一点）；最终以 CI（干净 Linux runner）为准。

## [2.13.0] - 2026-10-05

关闭对 v2.12.0（`db6ae0c`）的全维度代码审计（评分：阻塞 0 / 严重 0 / 一般 3 / 低 15）中的 3 项「一般」与 10 项「低」，均为「既有修复的残留面」「文档与实现不一致」或「工程配置/可观测性」三类，不涉及并发设计与存储契约。测试断言数 755 → **788**（`manifest.test.js` 75 → 81、`settings.test.js` 101 → 110、`ownership.test.js` 307 → 309、`popup.test.js` 175 → 191），变异门禁 33 → **34** 项（新增 M34，证明诊断快照的脱敏断言承重）。新增可观察契约（`direct` 状态新增 `readFailed` 的前台呈现档 `direct_unverified`、`error` 状态新增消费 `reason:"restore_interrupted"`；`updateIcon` 的 `direct` 档按来源分三档标题），按仓库惯例升 minor。

### 修复（一般）

- **M-1 第 4 条「`clear()` ≠ 强制直连」只落了一半 —— 图标标题仍在宣称直连**：v2.12.0 第 4 条把**状态条文案**按 `systemProxy` 分了档，但两个呈现面没跟上：① `updateIcon("direct")` 的**悬停标题**被固定写成「未启用代理（直连）」，而 README 的图例（红·直＝直连）本身也是一次独立断言 —— 于是「不得宣称直连」这个验收要点只落在状态条上，悬停提示与状态条正文在同一条信息里自相矛盾；② `directState.readFailed`（禁用态「clear 成功但回读实际模式失败」）**前台零消费**（`popup.js` 只认 `systemProxy`），该档落到「未启用代理（直连）」这一句上，与紧随其后的 message「无法确证当前实际生效的模式」直接矛盾。修复：`updateIcon` 的 `direct` 档按**三个语义来源**分档取标题（`direct`＝唯一可宣称直连；`read_failed`＝「已停用本扩展代理，但无法确证当前实际生效的模式」；其它非 `direct` 模式名＝「未启用本扩展代理（当前沿用 〈mode〉）」），禁用分支与 `onChange` 回读路径两处调用点同步传入回读结果；`popup.js` 新增 `direct_unverified` 文案档并消费 `state.readFailed`。
- **M-2 `resetDefaults()` 没跟 `save()` 的「按阶段分辨失败」**：第 2/3 条的失败分期只修了 `save()` 一条路径，「恢复默认」仍把 `storage.local` 清理失败与「设置根本没恢复」混为一谈（sync 已成功恢复却报「恢复失败」，与事实相反），也**完全不消费**重下发结果。修复：抽出 `reportApplyOutcome(resp, prefix)` 阶梯供两处共用；`resetDefaults()` 增加 `restored` 标记区分「设置未恢复」与「已恢复、后续步骤失败」，并在清理失败文案中**如实说明**：`resetDefaults` 写入 sync 的正是**内置默认列表**，一旦本机另存有一份旧列表，「sync＝默认列表 + local 非空」这一组合同样命中后台的存量污染自愈判据（逐字符相等），自愈会把 sync 清成空占位、本机旧列表重新成为生效值 —— 即用户刚执行的「恢复默认」可能并未真正生效。文案不承诺「不受影响」，只指向唯一可行动作（重试到本机副本被真正清掉），与 SECURITY.md 第 6 条披露的组合同源。
- **M-3 覆盖率只报告不拦截，且披露不对称**：`.c8rc.json` 无 `check-coverage` ⇒ `npm run coverage` 无论掉到多少都退出 0；README 又只声明行覆盖（`popup ~91%`，实测 89.91%）而**从未披露分支覆盖**（popup 仅 75.52%）。于是断言数漂移会红、覆盖率退化不会 —— 不对称。修复：`.c8rc.json` 开启 `check-coverage` 并落四条门槛（行/语句 85、函数 95、分支 74，留出小幅余量）；README 的覆盖率说明改为**同时给出行覆盖与分支覆盖**。`manifest.test.js` 新增 2 项断言把「门禁开关开启 + 四条阈值齐备」与「README 双披露」固化。

### 修复（低）

- **L-01（承接审计建议 A6）CI/CD 配置缺口**：`package.json` 增 `engines.node >= 20`、新增 `.nvmrc`（`22`）、`ci.yml` 增 `concurrency: { group: <workflow>-<ref>, cancel-in-progress: true }` 与 `setup-node` 的 `cache: npm`。成本证据为实测：因缺 `concurrency`，同一时段两次 push 触发两次 full CI（`37294230923` @10:04 与 `37296007019` @10:20），前一次仍跑满约 23 分钟才结束。`group` 带 `ref` 使 tag 触发的运行独立成组，不会被分支上的 push 取消。
- **L-02 `SECURITY.md` 第 7 条「只留痕、不做降级」已过期**：M-5 早已实现「250 ms 有界重试 → 仍失败则写 `storage.local` 的 `stateWriteFailed` → 弹窗提示『状态可能过期』」三级降级，同文键表也已写明。更正为如实描述该降级，并**补上它自身的两个边界**：① 降级是「提示」而非「补写」，界面仍显示上一次成功写入的状态结论；② 重试与降级标记都挂在 250 ms 定时器上，SW 恰在该窗口内被回收时二者都不会发生，此时只剩控制台一条告警。
- **L-03 出口响应「有效的 `ip` 字段」与实现不符**：`SECURITY.md` / `PRIVACY.md` 一直声称响应必须含「有效的 `ip` 字段」，而 `normalizeExitPayload` 此前只判「非空 + 长度 ≤45 + 无空白」—— `"not-an-ip"` 会一路通过，界面把无意义文本当作出口 IP 展示、并据「拿到了 ip」判为「出口检测成功」。修复：`settings.js` 新增 `isIpLiteral`（IPv6：仅十六进制/冒号/点且必含冒号；IPv4：恰好 4 段十进制 0–255；判据刻意宽松、不为难合法写法，不做可达性判定），`normalizeExitPayload` 收敛到它，两份文档措辞与实现对齐。**本版选择收紧实现而非放宽文档**——与「如实上报」的项目基调一致。
- **L-04 `PRIVACY.md` 摘要「不上传到任何服务器」与同文第 3 节自相矛盾**：摘要称不上传到**任何**服务器，正文却承认 `storage.sync` 经浏览器账号同步。修复：摘要限定为「不上传到**我们自己的**服务器」，并说明 `storage.sync` 的同步由**浏览器厂商的同步服务**完成、本扩展无法读取；键表末句同步更正。
- **L-05 状态/`reason` 取值无单一事实来源**：两套取值只以字面量散落在 `background.js`（写入方）与 `popup.js`（渲染方），无任何机制保证一致 —— 实测缺口是 `reason:"restore_interrupted"`（对比窗口恢复被 SW 回收打断）在 popup 无文案，落到泛化的「代理异常，流量可能已回退直连」，而该情形的语义**恰恰相反**（扩展没坏、且已按最新设置重新下发）。修复：`settings.js` 新增 `STATUS` / `REASON` 两张常量表作为唯一事实来源，`manifest.test.js` 双向核对（① `background.js` 实际写出的字面量集合必须等于清单；② `popup.js` 必须为每个 status 提供 `STATUS_TEXT` 键、为每个 reason 提供 `error_<reason>` 键），`popup.js` 补 `error_restore_interrupted` 文案并新增消费分支。
- **L-06 两个经典脚本无严格模式**：`background.js`（classic service worker）与 `popup.js` 均未声明 `'use strict'`，隐式全局赋值、静默失败的写入、`this` 装箱都无法被静态规则拦住。补上，与 `settings.js` 一致。
- **L-08 可观测性（28 处 `console.*`、无诊断导出）**：新增「导出诊断信息」按钮 + 后台 `getDiagnostics` 消息，把 `lastState` / `lastTest` / `pendingRestore` / `suspendDepth` / `suspendDirty` / 版本一次性渲染成可复制的纯文本，排障不必再手工翻 SW 控制台。**脱敏是硬要求**（快照会被用户直接复制进公开 issue）：不含出口 IP（只保留「是否拿到出口 / 是否变化」等结构性信息）、不含代理地址与端口（只保留状态结论里已有的模式名）。渲染用 `textContent` 而非 `innerHTML`，读取失败同样如实上报（`ok:false` + `error`），并补 `.catch` 防止异常留在 `Uncaught (in promise)`。
  - **该功能在首跑用例时当场抓出一个真缺陷**：`exportDiagnostics()` **没有 `return`**，而调用点写的是 `exportDiagnostics().catch(renderTestError)`（与 `runTest` 同一契约）—— 于是每次点击都同步抛 `TypeError: Cannot read properties of undefined (reading 'catch')`，按钮永久停在 disabled、结果区停在「正在收集…」，正是 R7-08 要消灭的「异常路径卡死」形态。已补 `return`。**这条缺陷是被 L-08 新增的用例（按钮必须复位）抓出来的，不是靠人工复查** —— 新增功能必须同时补断言，否则缺陷只会用户在真机上遇到。
  - 用例 8 项（`L-08-a`…`-h`：渲染与版本号、脱敏（不得含出口 IP 原文）、按文本渲染（存储里的 HTML 不成为真实节点）、按钮复位、后台无响应如实、通道异常如实、session 读取失败 `ok:false`+`error`），并新增变异 **M34** 把「脱敏」钉死（`summarizeTest` 一旦顺手带上 `exit.ip`，`L-08-b` 必然变红）。
- **L-11 界面无 `aria-*`**：`#statusBar` / `#hint` / `#testResult` 三处动态文本区补 `role="status" aria-live="polite"` —— 它们都由脚本异步改写，此前屏幕阅读器用户完全感知不到「保存后状态变了」「测试完成了」。
- **L-12 `isCidr` 不校验 IPv4 前缀长度**：此前只查 `Number(tail) > 128`（IPv6 上限），IPv4 分支通过后不再校验 —— `192.168.0.0/33` 被判成「网段」原样保留并下发，而 Chrome 对无效前缀**静默忽略**，于是「配了规则却一条都没生效」。修复：补 `Number(tail) > 32 → 非 CIDR`，斜杠照常被当作路径分隔符剥掉，得到一条显式主机规则而非被静默忽略的网段（与 M-6/M-7 消除静默失效的取向一致）。

### 其他

- 版本 2.12.0 → 2.13.0（manifest / package / lock / 三个源文件头 / README / CHANGELOG 同步）；断言数与变异数同步至 README、CONTRIBUTING、ARCHITECTURE、ci.yml 四处。
- **更正一处自 v2.12.0 起就已失真的注释**（本轮新发现，不在审计清单内）：`background.js` 的 `reapply` 分支写着「本分支在产品代码中**没有**任何调用方（popup 从不发送）」—— 自 v2.12.0 的 `confirmApplied()` 起即已不成立，本版 `resetDefaults()` 又新增一处调用。注释已按事实改写（列出两处真实调用方与三点用途）。这类「注释断言与代码事实相反」的漂移与 L-02 / L-03 / L-04 同型，说明**每次新增调用点时都应回头 grep 一遍该函数被写进哪几处注释/文档**。
- **哨兵守卫的提示硬化**（本轮新发现，不在审计清单内）：`tests/mutation-check.js` 的启动守卫此前对任何残留哨兵都按「源文件仍停留在变异态」报告，并直接建议 `git checkout -- background.js settings.js popup.js` —— 这个建议在**有未提交真实改动的开发树上是有破坏性的**（会把真实修复连同变异体一起丢弃），与 `MEMORY.md` / `CONTRIBUTING.md` 反复强调的「不要在不洁工作树上 `git checkout`」自相矛盾。现在按哨兵**载荷**区分两个来源：真实变异运行写 `{ pid: <真实进程号>, at: <时间戳> }`，而 `tests/manifest.test.js` 的 B-3 自检探针恒为 `{ "pid":0,"at":0 }`（该探针**从不改写源文件**）。后者会明确说明「不代表源文件被污染」，恢复步骤也改为「先跑一次功能测试确认 → 再判断是否需要 checkout」，并显式警告 `git checkout --` 会丢弃这三个文件里的**全部**未提交改动。
- **如实声明：本版未在本机跑完变异门禁，最终以 CI 为准。** 本机执行环境带有「单轮批量删除配额」安全策略（`CODEBUDDY_SAFE_DELETE_BULK_*`，超配额即拒绝删除并要求确认）。而变异门禁的每一轮都要删除临时目录与哨兵，34 项 × 7 套测试累计远超配额 ⇒ 子进程里的 `fs.rmSync` 被拒 ⇒ `manifest.test.js` 的 B-3 断言与「严格还原现场」失败 ⇒ **门禁基线失败而中止**。经核实这是**环境限制，不是仓库缺陷**：同一命令在干净环境（沙箱绕过 / CI）下基线全绿、七套 788 项全过；已按规范**不去绕过该安全策略**。因此本机完成的门禁项为：`npx eslint .` = 0、七套功能测试 **788 项全绿**、覆盖率门禁通过（行 94.61% / 分支 85.58% / 函数 100%）、打包 `dist/easy-proxy-by-ds4-2.13.0`；**变异门禁 34 项交由 CI（干净 Linux runner）核验**。新增的 M34 已静态核对：注入锚点在 `background.js` 中唯一，且 `summarizeTest` 一旦带出 `exit.ip`，`L-08-b`（快照不得含出口 IP 原文）必然变红。
- **测试稳定性修复（非功能变更，不改变断言数与断言语义）**：`tests/popup.test.js` 中三处「点击 → 固定 `settle(N)` → 断言异步结果」的写法实测处于预算边缘 —— 第二次点击后的链路含一次真实下发往返（`reapply` → `applyProxy`，其中逐条清理遗留作用域 = 十余次 `setTimeout(0)` 跳），在 Node 里实测完成时间 **166–270 ms**，而预算分别是 150 / 240 / 260 ms，机器负载高时偶发假红（本机 10 次采样中复现 2 次）。改为等待**完成信号**（G6 / M-2-d 等提示被替换、第 1 条等提示进入终态），既不预设结果文本（各断言保持独立且仍可被变异门禁证伪），也不再受负载漂移影响；连跑 10 次 popup、4 次全套均全绿。
- 未处置并明确留待后续：**L-07** 注释编号无索引（254 处 / 9 个前缀族）、**L-09**（已随 L-02 如实写入文档，代码未改）、**L-10** `applyProxyCore` 超大函数、**L-13** host 白名单含 `_` 未实测、**L-14** `tools/package.js` 的 `main()` 与 G1 的 skip 分支无覆盖、**L-15** 真实浏览器 E2E 冒烟（因 `ERR_BLOCKED_BY_CLIENT` 未完成，`docs/E2E-SMOKE.md` 手工清单不变 —— **仍是打 tag 的前置条件**）。
- 上一版（v2.12.0）遗留的其它审计建议（A2 / A3 / A5 / A7 等）不在本版范围。

## [2.12.0] - 2026-10-05

关闭一份独立外部安全审查报告（针对 `c1c8054` / v2.11.0）指出的 6 条缺陷 —— 全部落在「代理恢复、配置保存、状态误报」三类，该报告本身确认无后门 / RCE / 提权 / XSS。项目方逐条核验后判定 **6/6 成立**；其中第 1 条的关键前提（Chromium 对「写入值与库中原值完全相同」的 `storage.set` 既不派发 `onChanged`、也不写盘）已用 Chromium 一手源码 `components/value_store/leveldb_value_store.cc` 的 `LeveldbValueStore::AddToBatch()` 证实（生成 changes 前先做 `*old_value != value` 比对，相同则跳过 push 并跳过 `batch->Put`）。测试断言数 727 → **755**（`ownership.test.js` 293 → 307、`popup.test.js` 161 → 175），变异门禁 25 → **33** 项（新增 M26–M33，逐条证明新护栏承重）。新增可观察契约（`systemProxy` / `readFailed` / `overriddenDuringRestore`，以及保存后按**实际结果**分级的诚实文案），按仓库惯例升 minor。

### 修复（一般）

- **第 1 条 保存后不确认代理是否真的生效**：后台唯一的下发驱动源是 `storage.onChanged`，而 Chromium 在写入值与库中原值**完全相同时不产生任何 change** —— 于是「按提示重新保存一次相同配置」永远不会触发下发，界面却一律显示「设置已保存」。修复：`popup.js` 新增 `settingsSignature()` 记录本次加载的配置指纹，`confirmApplied()` 在写入落盘后判定 —— 指纹变了等 storage 事件驱动；**没变则显式发一次 `reapply`**，并按其结果分档给诚实文案（`applied` / `direct` / `suspended` / `overridden`，其余一律「已保存，但代理未能生效：〈原因〉」）。信息密度更高的「遮蔽现场」告知走 silent 模式，不被覆盖。
- **第 2 条 本机旧绕过列表清理失败被报成「设置已保存」**：`clearLocalBypassIfAny` 用 `.then(resolve, resolve)` 把 `storage.local` 写入失败映射到与成功**同一个出口**，失败被彻底吞掉。而取值规则是「sync 非空优先，为空则回退 local」—— 用户**清空**列表时 sync 是空串，此刻 local 清不掉 ⇒ 实际生效的仍是旧列表（用户本想取消直连的站点仍绕过代理），界面却宣称保存成功。修复：写失败改为 reject（带 `phase="local_cleanup"`），`save()` 按「本次是否清空列表」给两档准确文案（清空场景明确说出「旧列表仍生效、刚清空的规则可能仍绕过代理」）；同时**保留**「读取失败」路径的有意保守放过 —— 它没有产生任何副作用，与写失败必须区别对待。
- **第 3 条 超长列表保存失败可能丢失旧规则**：原顺序是「先写 sync 空串占位、再写 local」，其安全性**只对「local 里本来就有一份旧列表」成立**；而常见情形恰恰相反 —— 列表短到能直接存 sync 时 local 是空的，此时 local 写入失败 ⇒ sync 已被写成 `""`、local 仍为空 ⇒ `resolveBypassList("", undefined)` 得空串，**原有直连规则凭空消失**（一次失败保存改变了路由）。修复：改为 **local 先落地 → 回读确证新值确实可读回 → 才写 sync 占位**，三个失败点（local 写失败 / 回读确证失败 / sync 占位失败）都保留旧 sync。**如实记录不可两全**：两次写入无法原子化，中间态客观存在；本次目标不是消灭中间态，而是保证**任何中间态下的生效值都不为空**（这是丢数据的充要条件）。
- **第 4 条 `clear()` 不等于强制直连**：`chrome.proxy.settings.clear()` 只移除**本扩展自己**的偏好设置，使**下层设置重新生效**（Chrome 文档 Scope / Precedence）—— 下层可能是操作系统代理、`pac_script`、`auto_detect` 或其它扩展。因此在禁用分支 `clear` 成功后无条件写 `status:"direct"`、宣称「未启用代理（直连）」的结论可能**与事实相反**，还会污染后续「直连出口」对比的基准（把系统代理的出口当成直连出口）。修复：三处陈述点全部改为**回读实际 mode 后再陈述** —— ① 禁用分支：`mode !== "direct"` 时写入 `systemProxy` 并说明「并非直连」；**回读失败也如实标记 `readFailed`**（「读不到 ≠ 是直连」，与 R7-01 同一原则）。② `onChange` 回读路径：`!isFixed` 涵盖 `direct` / `system` / `pac_script` / `auto_detect`，只有第一种才是直连。③ 对比窗口在取样前记录 `afterClearMode`，交给前台据实标注「直连出口」这一行。**本条同时吸收上一轮审计建议 A1**（「禁用路径缺下发后回读校验，与启用路径不对称」，与第 4 条同源）。**如实记录与 A1 原判据的偏离**：A1 建议「回读到的不是 `fixed_servers` 就落 `error`」，本实现改为「`status` 仍为 `direct`（本扩展确实已停用）+ 如实写入 `systemProxy` + 文案说明并非直连」—— 调用方是**用户主动关闭开关**，此时报 `error` / 红图标会把一次正确的停用说成故障，同样属「状态 ≠ 事实」。验收要点是「**不得宣称直连**」，已由 `ownership` 第 4 条 a–h 覆盖，含 A1 指定的「clear 回调成功但回读仍返回 `fixed_servers`」场景。
- **第 5 条 旧状态的重试覆盖新状态**：`writeState` 一次失败会排入 250ms 有界重试；若期间发生了更新的真实状态（例如 `onProxyError` 写下 `lastState=error`），那次重试会把**过期的 `applied`** 盖回去 —— 图标已按 error 变红、状态条却回到「代理已生效」，自相矛盾。下发路径早有 `applyGeneration` 防同类问题，状态写入路径没有，属设计盲区。修复：新增按**键**的代次号 `stateWriteGeneration`，`superseded()` 让旧代次的（含其重试）**一律主动放弃**，由最新那次写入负责上报成功或失败；同时 `clearStateWriteFailMark(ownerKey)` 改为**按键**清标记 —— 另一键（`lastTest`）写入成功不得把 `lastState` 的「状态可能过期」告警一并抹掉（那会让用户失明）。
- **第 6 条 恢复期被接管仍显示成功**：对比窗口收尾（第三阶段）被外部接管时，后台已按设计放弃写回并返回 `overriddenDuringRestore`，但**前台没有任何分支消费它**（该标识符在 `popup.js` 中零命中）—— 渲染链继续下落命中 `ipChanged` 的成功文案，同一屏上「被外部接管」与「✓ 代理确实生效」并存。修复：前台在 **IP 比较之前**新增消费分支，并明确区分「取样那一刻的出口」与「收尾写回后的实际状态」（出口比较只对取样那一刻成立，不能据此认为本扩展的代理目前仍生效）。

### 其他

- 版本 2.11.0 → 2.12.0（manifest / package / lock / 三个源文件头 / README / CHANGELOG 同步）；断言数与变异数同步至 README、CONTRIBUTING、ARCHITECTURE、ci.yml 四处。
- 测试方法增量：`popup.test.js` 夹具新增 `setDrop`（**写入回调成功但值未落地**）—— 原有的 `setFilter` 只会「失败」，覆盖不到第 3 条新增的「回读确证」层；有它之后 M28 才有处可拦（否则该层无任何用例能证伪）。`ci.yml` 的 job 超时上限与时长声明按实测修正（本机 33 项变异约 36 分钟；GitHub 上 25 项时 14–15 分钟、33 项实测 23 分钟；`timeout-minutes` 30 → 45）。
- **本版补上了外部报告「未计入通过」的两项**：其变异门禁在 600s 超时未完成 —— 本版完整跑完 **33 项，全数被拦、注入失败 0、门禁自身失效 0、工作区污染 0、源文件已恢复**；真实浏览器 E2E 因 `ERR_BLOCKED_BY_CLIENT` 未完成 —— 仍为已知缺口，`docs/E2E-SMOKE.md` 的手工清单不变。

## [2.11.0] - 2026-10-05

关闭 v2.10.0 全维度生产上线前审计（评分 88.6/100，阻塞 0 / 严重 0 / 一般 3 / 建议 8）的 3 项「一般」问题（M1 / M2 / M3）——均为既有修复的残留面或文档漂移，不涉及并发设计与存储契约。测试断言数 709 → **727**（`settings.test.js` 89 → 101、`manifest.test.js` 69 → 75），变异门禁 23 → **25** 项（新增 M24 / M25）。新增可观察契约（保存前校验新增两类拒绝：方括号滥用、主机无有效字符），按仓库惯例升 minor。

### 修复（一般）

- **M1（P2）主机名校验缺口 —— M-6 的残留面**：`hasInvalidHostChar` 把 `[` 与 `]` **无条件**列入合法字符白名单，而「必须是 IPv6 字面量」的判定（`isIpV6Shape`）只在 host **含冒号**时触发 —— 于是方括号只在与冒号共存时才受约束，残留下一整类漏放。探针实测：`a[b].com` / `[]` / `[abc]` / `foo]bar` / `[a]b` / `.` / `..` 在修复前**全部通过**保存前校验，错误被推迟到 `chrome.proxy.settings.set` 阶段并被归因为「代理异常」，把用户引去排查代理软件；其中 `[]` 经 `stripBrackets` 还会归一成**空串 host** 下发。修复：`settings.js` 新增两条独立判据 —— ① `hasInvalidBracketUse`：含括号时要求括号配对，且括号内必须是**含冒号**的 IPv6 形状（`[abc]` 必须靠「含冒号」区分，因为 `isIpV6Shape('abc')` 返回真：a / b / c 都是十六进制字符）；② `hasNoHostLabel`：host 至少含一个字母或数字。两条判据的拒绝文案各自如实说明成因（刻意不把 `.` 报成「方括号用法错误」，避免指向错误的排障方向）。防误伤底线：`::1` / `fe80::1` / `[::1]` / `[fe80::1]` / `2001:db8::1` 与全部常规主机名继续零错误。新增 12 项断言（`settings.test.js` M-7 段）并纳入变异门禁 —— M24 覆盖方括号判据、**M25 覆盖无标签判据（后者非冗余：`.` 不含方括号，M24 覆盖不到）**。
- **M2（P2）README 隐私段端点披露不完整**：README「隐私说明」段只写了主端点 `ipinfo.io`，漏掉 v2.9.0 C-3 引入的两个备用端点（`ipapi.co` / `api.ipify.org`），与 `PRIVACY.md` / `SECURITY.md` / `settings.js` 四处不一致（同一 README 的「安全」段反而是对的）。商店审核要求如实披露全部数据接收方，隐私摘要与实际网络行为不符属硬性风险。修复：README 改为与 `PRIVACY.md` 一致的多端点表述。**根因治理**：`manifest.test.js` 新增 4 项断言，以 `settings.js` 的 `TEST_ENDPOINTS` 为唯一事实来源**反向校验** README / PRIVACY.md / SECURITY.md 三份文档，此后端点清单漂移 CI 直接变红。
- **M3（P3）CONTRIBUTING 的 devDependencies 陈述漂移**：`CONTRIBUTING.md` 写「devDependencies 只允许开发工具（当前仅 ESLint）」，而 M-4 已引入 `c8` —— 与 S-2 同型的文档漂移，且 G1 守卫只覆盖断言数 / 变异数，**拦不住「依赖清单」这类陈述**。修复：更正为「当前：ESLint 静态检查、c8 覆盖率」；`manifest.test.js` 新增 2 项断言，以 `package.json` 的 `devDependencies` 为事实来源要求 CONTRIBUTING 逐名声明。

### 其他

- 版本 2.10.0 → 2.11.0（manifest / package / lock / 三个源文件头 / README / CHANGELOG 同步）；断言数与变异数同步至 README、CONTRIBUTING、ARCHITECTURE、ci.yml 四处。
- 本轮由一份独立的全维度上线前审计驱动；该审计的 8 项「建议」（禁用路径缺下发后回读校验、注释编号无索引、超大函数拆分、E2E 未自动化、可观测性、`engines`/CI 并发与缓存、无障碍 live region、文档时长声明）**未在本版处置**。

## [2.10.0] - 2026-10-05

关闭 v2.9.0 独立生产上线前复审的全部问题：2 项严重（S-1 / S-2）、5 项一般（M-1 / M-2 / M-3 / M-4 / M-5）、6 项建议（A-1 – A-6）。测试从 683 项断言扩至 **709 项**（变异门禁 23 项，全部拦截）；新增 c8 覆盖率门禁（`npm run coverage`）与真实浏览器 E2E 冒烟清单（`docs/E2E-SMOKE.md`）。新增可观察契约（未启用分支新增 `reason:"control_unknown"` 与被接管时的 `status:"overridden"` 上报；出口测试在启用代理时渲染第三方出口知情提示），按仓库惯例升 minor。

### 修复（严重）

- **S-1（P0）变异脚本非信号安全**：`tests/mutation-check.js` 此前只靠 `try/finally` 还原被变异的源文件，进程被 SIGINT/SIGTERM/kill 或未捕获异常打断时还原不执行 —— 实测复现过 `background.js` 停留在变异体上，后续全部测试跑在被污染代码上（若此时打包会把变异代码发出去）。修复：还原动作抽成幂等函数并注册到 `exit` / `SIGINT` / `SIGTERM` / `uncaughtException` / `unhandledRejection` 五类出口；启动时快照 `git status --porcelain`，结束时任何【新增】工作区改动判为变异污染并以非 0 退出（既有改动的开发树仍可运行，不阻断「提交前先跑变异」流程）。
- **S-2（P0）质量数字文档漂移**：`CONTRIBUTING.md` / `ARCHITECTURE.md` 写 616 项断言 / 19 项变异、`ci.yml` 注释写 18 个变异，实际为 683 / 23。根因是 G1 一致性门禁只解析 README。修复：数值全部按实测同步，并把 CONTRIBUTING / ARCHITECTURE / ci.yml 的同类声明纳入 `manifest.test.js` 的 G1 扩展守卫 —— 此后再漂移 CI 直接变红。

### 修复（一般）

- **M-1（P1）禁用路径缺写前控制权确证**：未启用分支此前不做任何控制权检查就清除 `regular` 并宣称 `direct`；外部接管 + 未启用时构成夺权式写入且状态与事实相反。修复：与启用分支 R9-02 同一基调 —— 控制权未知（有界重试后仍读不到 `levelOfControl`）报 `error/reason:"control_unknown"` 并放弃清除；已确证被接管报 `status:"overridden"` 并如实记录控制方，绝不清除。新增 6 项断言（ownership M-1 段）。
- **M-2（P2）打包脚本零测试、CI 不跑打包**：`tools/package.js` 是发布产物唯一来源却零护栏。修复：重构为可 require 的纯函数（`missingFromManifest` / `pack`，`require.main` 守卫零副作用），`manifest.test.js` 新增 8 项断言（清单覆盖、注入检出、临时目录产物逐文件比对、A3 排除契约、manifest/popup 逐字节保真）；CI 新增「打包脚本自检」步骤。
- **M-3（P2）超长列表保存非原子**：先写 `local` 再写 sync 占位，sync 失败会留下「sync 旧值遮蔽 local 新列表」的不一致中间态（后续保存可能经 `clearLocalBypassIfAny` 演变为数据丢失）。修复：有序写入改为「先写 sync 空串占位、后写 local」—— 两个失败模式都收敛为「如实报错、生效值回退旧 local」，不再产生遮蔽中间态。
- **M-4（P2）无覆盖率度量、无真实浏览器 E2E**：新增 `c8` 覆盖率门禁（`npm run coverage`，CI 仅 Node 22 跑一次）：`background.js` 94.5% / `settings.js` 99.4% / `popup.js` 91.1% 行覆盖（函数 100%）。测试以 `vm.runInContext` 注入源码时统一补 `filename` 参数，使 V8 覆盖块可映射回源文件；`npm test` 收敛到 `tests/run-all.js` 统一入口（修复 c8 在 Windows 上无法包装 npm.cmd 的问题）。新增 `docs/E2E-SMOKE.md` 发布前人工冒烟清单。
- **M-5（P2）CI 用 `npm install` 与可复现声明不一致**：改为 `npm ci`，lockfile 不同步时快速失败。

### 修复（建议）

- **A-1** install 分支补缺时同步清洗非法 `proxyType`（与 update 分支同一防线）。
- **A-2** update 补缺写回的 `chrome.runtime.lastError` 由静默吞掉改为 `console.warn` 留痕。
- **A-3** `escapeHtml` 补转义单引号（按最坏属性上下文假设的纵深防御）。
- **A-4** `popup.html` 清除最后两处残留内联 style（`btns.tight` / `test-result` 类）。
- **A-5** 清理已合并的残留 worktree `fix-round5-p2` / `fix-round6-p1` 及对应分支。
- **A-6** 第三方出口知情提示前移到 UI：出口测试在启用代理时如实说明「流量经该代理服务器出去、其运营方可见目标地址」。

### 其他

- 版本 2.9.0 → 2.10.0（manifest / package / lock / README 同步）；测试断言数 702、覆盖率与 E2E 冒烟清单见 README「开发与测试」。

### 上线准入收尾（提审前第三次审计）

发布物本身未变（2.10.0 尚未发布、未打 tag），以下均为**发布治理**层面的修复，不涉及运行时行为、不新增可观察契约、不改存储键：

- **B-2 假绿门禁**：`CONTRIBUTING.md` 声明「三个源文件头（`[vX.Y.Z]`）由 `tests/manifest.test.js` 与 G1 自检拦截」，但实测该断言**根本不存在** —— 2.10.0 提交里 `background.js` / `popup.js` / `settings.js` 的文件头仍停在 `[v2.9.0]`，CI 却一路全绿。修复：文件头对齐至 `2.10.0`；`manifest.test.js` 新增 4 条断言（逐文件比对 + 「正则必须匹配到每个文件」防格式漂移静默通过）。
- **C-1 根因（发布产物被变异污染）**：`dist/easy-proxy-by-ds4-2.10.0/popup.js` 中曾残留 M22 变异体（`activeEditableId` 被改成恒返回 `null`，与 `tests/mutation-check.js` 的 `to` 串逐字节一致）—— 打包动作跑在变异运行期间，把故意破坏的代码复制进了发布产物。修复：`tests/mutation-check.js` 在改写源文件前落哨兵 `.mutation-in-progress`（与 `restoreAll` 同生共死，五类退出路径均清除）；`tools/package.js` 见哨兵即拒绝打包，并在复制完成后逐字节自校验产物（覆盖「打包中途源文件被改写」的竞态），不一致即删除产物并报错。`manifest.test.js` 新增 2 条断言固化该互斥。
- **C-3 依赖漏洞门禁缺失**：`dependabot.yml` 只覆盖 `github-actions`，CI 又以 `--no-audit` 关闭审计，npm 侧（eslint / c8 及传递依赖）无任何持续防线。修复：dependabot 增加 npm 生态（weekly）；CI 新增 `npm audit --audit-level=high` 步骤。
- **B-5 变异门禁被自己的哨兵误伤（假红，由 CI 抓出）**：`manifest.test.js` 里两条断言与哨兵机制自相矛盾，导致门禁在**每条**变异下都变红 —— 等价变异体 M1（`expectFail:false`，预期放行）被误判为「已被拦截」，成绩从 23/23 掉到 22/23（CI run `37290295856` 三个 Node 版本全红）。两处成因：① 产物可复现性断言直接 `pack(tmp)`，而门禁运行期间哨兵必然在位，`tools/package.js` 按设计拒绝打包，6 条断言必然失败；② 「断言结束后哨兵已清除」写成了硬编码的 `!existsSync`，与紧邻的「严格还原现场」（原本有哨兵就写回）互相矛盾。修复：`pack` 新增**双重收紧**的自检例外（须显式传 `{selfCheck:true}` **且**目标位于系统临时目录，发布 CLI 永不满足），并补 1 条断言把「非临时目录 + `selfCheck:true` 仍须拒绝」钉死，防止日后被改成无条件放行；哨兵断言改为校验「断言前后状态一致」这一真正的不变式。**值得记录**：这次是设计为「预期放行」的等价变异体抓出了测试自身缺陷 —— 若当初嫌 M1 麻烦而删掉它，这类缺陷将永远不会被发现。

测试断言数 702 → **709**（`manifest.test.js` 62 → 69），变异门禁仍 23 项。

## [2.9.0] - 2026-10-05

关闭第二轮生产上线前审计的全部「严重」与「一般」问题：3 项严重（C-1 / C-2 / C-3）、6 项一般（M-1 – M-6）。新增可观察契约（`storage.local` 新键 `stateWriteFailed`、direct 状态新增 `legacyClearFailed` 字段、出口检测新增备用端点 `TEST_ENDPOINTS`），按仓库惯例升 minor。测试从 616 项断言扩至 **683 项**，变异门禁从 19 项扩至 **23 项**。

### 修复（严重）

- **C-1（P0）禁用路径不清理旧版遗留代理作用域**：`LEGACY_SCOPES`（`regular_only` / `incognito_persistent` / `incognito_session_only`）此前只在启用分支清理；老版本升级而来的安装若在遗留作用域上残留代理配置，关闭开关后仅清除 `regular` 就无条件写 `status:"direct"` —— 隐身（或受限）流量仍在走代理，界面却宣称直连，与「状态≠事实」缺陷族同型。修复：未启用分支同样遍历清理遗留作用域（尽力而为）；清理失败时状态仍如实为 `direct`（`regular` 已确证清干净），但必须附上说明（"隐身窗口……可能仍走旧代理"）并带 `legacyClearFailed` 字段留痕，绝不静默隐瞒残留。新增 9 项断言（含失败注入降级路径）并纳入变异门禁（M21）。
- **C-2（P1）`onProxyError` 监听器零测试覆盖**：全部测试环境的 `chrome.proxy.onProxyError` 桩都是空 `addListener`，监听器从未被驱动 —— `fatal` 透传这一最重要的代理错误告警没有任何断言，也不在变异门禁中。修复：测试环境捕获并真实驱动该监听器（`fireProxyError`），覆盖 fatal / 非 fatal / 缺省字段三条路径（状态、`fatal` 标记、消息、`detail`、图标共 9 项断言），并新增变异 M20 证明护栏承重。
- **C-3（P1）出口检测单点依赖 `ipinfo.io`**：无备用端点、无响应 schema 校验 —— 端点不可用时出口检测整体失效（可用性单点），端点返回异常结构时会产出 `{ok:true, ip:''}` 的伪造「成功」（信任单点）。修复：①端点改为有序列表 `TEST_ENDPOINTS`（主端点 `ipinfo.io` 不变，备用 `ipapi.co` / `api.ipify.org`，均支持 CORS、始终无需 host 权限），主端点 HTTP 错误 / schema 不符 / 网络拒绝时依次重试；②新增 `normalizeExitPayload` schema 校验（`ip` 必须为非空白、≤45 字符的字符串，其余字段安全置空），不合格响应按端点失败处理；③超时（AbortError）不重试备用端点，对比窗口直连取样额外锁定单端点（`maxEndpoints=1`）—— G5 的「代理已清除」暴露窗口硬上限不被容错机制放大。新增 15 项断言（含超时语义，补上 M-2 的零覆盖）。

### 修复（一般）

- **M-1（P1）popup 的 `storage.onChanged → load()` 整体重绘覆盖用户正在输入的内容**：后台自愈写 `sync.bypassList=''` 或多设备同步都会触发全量 `renderForm`，焦点字段中未保存的输入凭空消失。修复：`renderForm` 增加焦点保护 —— 焦点所在的可编辑字段（开关 / 类型 / 地址 / 端口 / 绕过列表）保持用户输入，其余字段照常刷新；失焦后恢复全量刷新，「界面与存储一致」语义不变。新增 5 项断言并纳入变异门禁（M22）。
- **M-2（P2）出口检测超时 / AbortError 分支零覆盖**：随 C-3 的 fetchExit 重构补齐 —— 超时如实报「请求超时（N 秒）」、不重试备用端点、按时返回不放大等待（3 项断言）。
- **M-3（P2）`onStartup` 监听器从未被驱动**：测试环境该桩为空，冷启动对齐路径零覆盖。修复：捕获并真实驱动 `onStartup`，断言按存储设置真实下发、状态判 `applied`、图标转绿（4 项断言）。
- **M-4（P2）`escapeHtml` 零显式断言、无 XSS 回归用例**：补齐转义契约断言（尖括号 / `&` / 双引号 / `null` / 数字共 5 项）+ 端到端回归（恶意出口 IP 与代理配置字段经真实测试渲染路径注入，断言产物中无可执行原始标签，2 项）。
- **M-5（P3）状态写入失败仅 console 留痕，前台无感知**：`session.set` 失败会让 popup 长期停留在过期结论上而用户毫无察觉。修复三级处置：①失败后有界重试一次（250ms，绝不在上报路径上无限等待）；②重试仍失败则把失败事实写入 `storage.local` 新键 `stateWriteFailed`（独立于 session 的存储区），popup 的 `local.onChanged` 捕获后显示「状态记录写入失败：当前显示的代理状态可能过期」警示；③任一次写入成功即清除标记。后台新增 5 项断言（含故障注入与恢复清除），popup 侧 3 项（警示呈现与防误报）。
- **M-6（P2）`looksLikeHostPort` 放行 Chrome 必拒写法**：`example.com:8080:90`（多冒号）、`user:pass@host`、`host:abc`、`a,b.com` 均能通过保存前校验，错误被推迟到 set 阶段并归因为「代理异常」，误导排障方向。修复：`validateSettings` 新增三层拦截 —— `@` 字符拒绝（提示在代理软件侧配置认证）、host 合法字符白名单（字母 / 数字 / 点 / 连字符 / 下划线，IPv6 额外允许冒号与方括号）、含冒号 host 必须整体形如 IPv6 字面量（仅 `[0-9a-fA-F:.]`，允许 `[]` 包裹）。防误伤底线：全部 IPv6 形态（`::1` / `fe80::1` / `[::1]` / `2001:db8::1`）与下划线主机名零错误；全 hex 串（如 `beef:cafe`）无法与 IPv6 区分刻意放行，Chrome 在 set 阶段拒绝并如实报 error，不构成静默失效。新增 10 项断言并纳入变异门禁（M23）。

### 文档

- SECURITY.md：出口检测端点说明更新为多端点容错语义；补充 `storage.local` 新键 `stateWriteFailed` 的用途与生命周期。
- README：测试断言数与变异门禁数同步（683 项 / 23 项）。

## [2.8.0] - 2026-10-05

关闭生产上线前审计（基准 `7e5731c`）的全部问题：2 项严重（S1 / S2）、6 项一般（G1–G6）、6 项建议（A1–A6）。本版新增可观察契约（`chrome.storage.session` 新键 `pendingRestore`、状态子类型 `reason:"restore_interrupted"`、对比测试早退原因 `compareSkipped:"sampling_unstable"`、popup 状态条新档「无法与后台通信」、清单新增 `author` / `homepage_url`），按仓库惯例升 minor。公开发布准入的前置条件（S1 + S2 + 文档纠偏）在本版全部关闭。

### 修复（严重）

- **S1（P1）存量「默认列表 + 编辑」污染现场保存会静默清空 `local` 唯一副本**：2.7.1 的三处生效判据（`popup.js` 的 `loadedShadowed` 内联判据、`clearLocalBypassIfAny` 的守卫、`background.js` 的自愈判据）全部只认「逐字符相等」，对升级前 V-01 缺陷留下的「sync = 内置默认列表整段 + 用户编辑」形态完全失明 —— 用户在该现场点一次保存，`local` 里的用户规则唯一副本即被静默清空（不可逆、无任何 `lastError`，探针实测复现）。修复：①`popup.js` 的 `load()` 判据收敛到 `settings.js` 的唯一实现 `isLegacyShadowPair`（同时覆盖「逐字符相等」与「默认列表 + 编辑」两种形态，V-01-a…k 共 11 条断言护住语义）；②`clearLocalBypassIfAny` 增加纵深防御第二层（传入 `formWasShadowed`，遮蔽现场绝不写 `local`）；③后台自愈判据刻意保持保守（逐字符相等）不动 —— 它要执行写操作，放宽会误伤用户自写列表，前台确认门放宽即可。新增 S1 门禁用例（存量编辑形态 → 两次点击保存后 `local` 逐字符未变、`local.set` 序列为空）并纳入变异门禁（M19）。
- **S2（P1）对比窗口期间 Service Worker 被回收，代理停留在「已清除（直连）」且不恢复**：`runCompareWindow` 在清除与恢复之间存在真实的异步区间，而 `suspendDepth` / `suspendDirty` 都是模块级内存变量，SW 在「清除之后、恢复之前」被回收（关弹窗、崩溃、重载、休眠唤醒）后代理停留直连、无人恢复 —— 用户以为在走代理实际全部直连，属静默隐私暴露。修复（持久化「待恢复意图」+ 冷启动对账）：①清除之前把意图写入 `chrome.storage.session`（新键 `pendingRestore`，同一浏览器会话内跨 SW 重启存活）；②窗口收尾（含早退）清除标记；③SW 冷启动发现残留标记 = 上一次恢复未完成：消费标记、如实上报 `reason:"restore_interrupted"`、并立即按最新 settings 重新下发。新增 S2 门禁用例（用永不回调的 get 桩把窗口真实挂起在恢复之前 → 新 SW 实例带残留标记冷启动 → 断言 1 秒内重新下发、状态如实标记、标记被消费）与反向对照（正常收尾无标记残留）。

### 修复（一般）

- **G1（P2）文档事实漂移根治**：README 的版本号（2.7.0 → 实际）、断言总数（534 → 实测）、变异数（16 → 实测）与 CHANGELOG 的 576（实为 577）均已按实测纠偏；并把「文档漂移」变成可拦截的缺陷 —— 每个测试文件结尾新增 **G1 运行期自检**（`tests/g1-consistency.js`：README 中本套件声明的断言数 ≠ 实际通过数即红），`manifest.test.js` 新增「合计 = 各行之和」「变异数与 mutation-check.js 实际定义数一致」两条断言。
- **G2（P2）消息通道失败不再静默**：`send()` 此前用 `void chrome.runtime.lastError` 吞掉通道错误并 `resolve(null)`，`refreshStatus()` 在无响应时直接 return —— SW 崩溃 / 扩展重载后状态条永久停留在「读取状态中…」。现在 `send()` 在 `lastError` 存在时 reject，`refreshStatus()` 为「通道 reject」与「后台无响应」两条路径统一渲染新档文案「状态未知：无法与后台通信，代理可能仍在生效（可尝试关闭后重新打开弹窗）」（warn 档，不谎报直连）。
- **G3（P2）遮蔽现场判据三处重复实现收敛**：popup 的内联「逐字符相等」判据删除，一律调用 `S.isLegacyShadowPair`（G3 正是 S1 的成因）；`manifest.test.js` 新增结构断言（popup 必须调用共享判据）。background 保留语义独立的 `isLegacyShadowed`（后台自愈，刻意保守），分工由 `settings.js` 注释声明。
- **G4（P2）对比测试前置取样与配置变化互斥**：直连出口的取样发生在 `before` 回读与窗口之间，期间配置若被修改（用户、多设备同步、外部接管），取样基准不可信且会误报「代理很可能未生效」。现在取样完成后复核一次「控制权 + 实际配置签名」（`proxySignature`，比对 levelOfControl / mode / scheme / host / port），不一致即标记 `samplingUnstable`、以 `compareSkipped:"sampling_unstable"` 早退并如实提示「请重测」，绝不给出无依据的结论。既有注入型用例的 get 序号已适配新回读序列。
- **G5（P3）对比窗口直连取样改用独立短超时**：新增 `S.COMPARE_EXIT_TIMEOUT_MS = 4000`（全局 12 秒仅用于「代理仍在生效」的普通检测）——「代理已被清除」的区间最坏持有时长从 12 秒降到 4 秒，同时缩小 S2 的暴露窗口；README 承诺改为区间表述。
- **G6（P3）`resetDefaults()` 移除 `window.confirm`**：与 V-01 同一反模式的最后残留（popup 失焦即销毁，原生对话框返回值永远回不来）。改为与 `save()` 一致的行内二次确认：第一次点击零写入、按钮文案变「确认恢复默认」、提示如实说明「将清空本机保存的绕过列表」；遮蔽现场下追加「本机还保存着你自己的绕过规则（可能是唯一副本），恢复默认将把它一并清空」的知情说明。确认态随表单重载复位，不跨操作残留。

### 新增（建议项 A1–A6）

- **A1**：新增 `package.json`（零运行时依赖不变，`npm test` / `npm run mutation` / `npm run package` 一键命令）与 ESLint 配置（`eslint.config.mjs`，8 条核心规则），lint 纳入 CI 首个失败点。
- **A2**：`.github/workflows/ci.yml` 的两个 Actions 由可变标签固定到 commit SHA（供应链最小信任）；新增 `.github/dependabot.yml`（github-actions 生态每周核查）。
- **A3**：新增 `tools/package.js` 可复现打包脚本：从清单读取版本，仅复制运行时文件（manifest / 三源码 / popup.html / 图标）到 `dist/easy-proxy-by-ds4-<version>/`，显式排除 `tests/`、`.github/`、`.editorconfig`、`CHANGELOG.md` 等非运行文件并打印产物清单。
- **A4**：`background.js` 的 `reapply` 消息分支补充「保留用途声明」：产品代码无调用方，仅用于来源校验测试与 Service Worker 控制台诊断，非死代码。
- **A5**：清单补齐 `author` 与 `homepage_url`（公开发布后用户可追溯来源与提 Issue）；popup.js 中 4 处内联色值改为 `popup.html` 定义的 `.t-muted` / `.t-error` 样式类，消除样式双轨。
- **A6**：新增 `ARCHITECTURE.md`（状态机、串行队列 / 代次号 / 暂停计数器、三存储区契约、遮蔽现场防线）与 `CONTRIBUTING.md`（含「改判据必须同步门禁用例 + 变异项」约定）。

### 测试

- 断言总数 **577 → 616**（新增 39 条，既有断言除 4 处 get 序号适配外零删除零改写）：`popup` 124 → **146**（S1 三条前置 + 五条核心、G2 五条、G6 九条）、`ownership` 234 → **247**（S2 六条 + 反向对照两条、G4 四条）、`manifest` 45 → **49**（G1 三条 + G3 两条；tag 一致性断言移出 pass 计数，另各文件结尾的 G1 自检按失败计，不计入通过数）。
- 变异门禁 **18 → 19 项**：新增 **M19**（`loadedShadowed` 标记退化为恒假 —— S1 的守门者；注入后 S1 / R9-01 系列零写入断言必须变红）。
- 四个后台测试桩（`background` / `fix-safety` / `concurrency` / `ownership`）与 popup 联动桩补齐 `storage.area.remove`（S2 的 `clearPendingRestore` 需要；缺桩会使窗口 finally 抛错、暂停计数泄漏）；`ownership` 桩新增 `seedSession` / `seedSync` 选项（模拟「SW 死亡后冷启动」的存储预置）。

## [2.7.1] - 2026-10-05

修复第九轮 03 独立验收（基准 `3b6ebce`，判定**不通过**）留下的缺陷：**V-02**（P2，验收判定的唯一阻塞项）与 V-01 / V-03 / V-04 / V-05 / V-06 / V-07（P3），并补齐 6 条残余风险的逐条处置。本版不改动存储键集合与取值规则（`S.DEFAULTS` / `CONFIG_KEYS` / `resolveBypassList` 一字未动），按仓库惯例升 patch。

### 修复

- **V-02（P2）遮蔽现场守卫前移到 `save()` 公共入口，覆盖 oversize 分支**：R9-01 的 `formWasShadowed` 守卫此前只挂在**短列表**分支的清理动作上，于是「遮蔽现场（云端是内置默认列表、本机存着用户规则）→ 用户粘贴一份超过 `MAX_SYNC_BYTES_PER_ITEM`（8192 字节）的列表 → 保存」这条路径会直接 `setStorage("local", {bypassList: 表单值})`，**覆盖用户规则的唯一副本**（`local` 没有第二份副本，不可逆），界面却只报「绕过列表较长，已存于本地」——与事实相反，且无任何 `lastError`。现在守卫挂在**分支判定之前**，并区分两层：①遮蔽现场 + 超长 → **零写入并拒绝保存**（`local` 是唯一副本不可覆盖，而 `sync` 的单键上限装不下这份列表，唯一安全的动作是写入前就拒绝），提示如实说明「未保存」与「本机规则仍完整」；②遮蔽现场 + 可容纳 → 只写 `sync`、绝不写 `local`，提示如实说明「当前生效的仍可能是这一份表单内容」。正常用户的两条路径（短列表清理 `local`、超长列表降级存 `local`）行为一字未变。
- **V-01（P3）遮蔽现场「改字后保存」改为行内二次确认**：遮蔽现场下用户改一个字再保存，会把「默认列表 + 改动」写进 `sync`，此后后台自愈判据（逐字符等于默认列表）**永久失效**——用户真实规则长期不生效且无可恢复路径，`popup` 的冲突提示也随之消失。现在这种情况**首次点击不写入任何存储**：按钮文案变为「确认保存（会用此内容替换当前生效的绕过列表）」并给出说明；再点一次才真正写入（仍不碰 `local`）。任何一个存储变化（含保存成功后自己触发的那次）都会复位确认态，不留残留。判据用新增纯函数 `S.looksLikeShadowEdit`（「默认列表 + 编辑」形态）；逐字符等于默认列表是 R9-01 主场景，既有守卫已能安全处理，不打断用户。**未采用 `window.confirm`**：popup 一旦失焦就会被销毁，原生对话框的返回值永远回不来，会让保存变成「点了没反应」。
- **V-04（P3）首次安装不再无条件覆盖云端配置**：`onInstalled` 的 `install` 分支此前无条件 `chrome.storage.sync.set(S.DEFAULTS, ...)`，前提是「全新安装 → `sync` 必然是空的」。该前提在同一 Google 账号**卸载后重装**时不成立（`sync` 键值随账号保留在云端、`local` 已随卸载清空），会把用户云端的代理地址、端口与绕过列表**全键覆盖**为默认值。现改为与 `update` 分支相同的「只补空缺」语义：先读，仅对**确实不存在**（键缺失或值为空串）的键补默认值；读取失败一律不补写。`bypassList` 的三态判据与 `update` 分支完全一致。
- **V-06（P3）与残余风险 R-1/R-2/R-3/R-4/R-5 写入文档**：`SECURITY.md` 新增 4 条已知限制（代理控制权检查与下发之间的 TOCTOU 窗口、绕过列表「降级到本机 / 跨设备同步」缺来源标记导致旧规则可能复活、`session` 状态写入失败只留痕不降级、异常档图标不可区分），`README.md` 的「已知边界」补一条指向它们。

### 测试

- 断言总数 **534 → 577**（新增 42 条，**删除或改写既有断言 0 条**，见 `git diff 3b6ebce..HEAD -- tests/` 的 `-  t(` 行数为 0）：`popup` 104 → **124**（遮蔽现场超长列表的 11 条 + 行内二次确认的 9 条）、`settings` 66 → **77**（新增纯函数的 11 条边界断言）、`ownership` 230 → **234**（首次安装的 3 条 + 1 条下发断言）、`concurrency` 33 → **40**（窗口期间配置落地的 2 条 + M9 语义的 2 条 + 在途下发顺序不变量的 3 条）。（数值经 2.8.0 审计实测纠偏：原记 576，实测为 577。）
- **`popup.js` 首次纳入变异门禁**：此前 `tests/mutation-check.js` 的 `targets` 只有 `background.js` 与 `settings.js`，`popup.js` 的守卫无法被自动验证（只能靠人工确认「改回恒假会红」）。现新增 `targets.popup`、变异 **M17**（遮蔽现场超长拒绝层恒假）与 **M18**（遮蔽现场入口守卫恒假），并同步扩展 `originals`/`norm`/`eol`/`finally` 还原与 `restored` 核验。门禁 **16 → 18** 项，实测 **18/0/0/0**、`原文件已恢复：是`、退出码 0。
- **`concurrency.test.js` 的桩补三项纯新增能力**（默认值下不进任何分支，既有 33 条断言行为一字未变）：`holdPort`（命中端口的 set 在显式放行前不完成，使「在途下发」成为受控状态）、`fetchLog`、`releaseHeldSets()`；另让控制权回读的 `levelOfControl` 可被用例切换，用于构造「窗口期间被外部接管」。
- **护栏归属澄清（V-03/V-05）**：M10 的唯一守门者仍是 `ownership` 的 `R3-01-R3 核心（确定性）`，现已在 `concurrency` 增加同语义**冗余**护栏（实测在 M10 下变红）。**如实记录的归属事实**：M9（删掉 `suspendDirty = true`）的守门者是 `ownership` 侧的 `pendingResubmit` 断言与 `concurrency` 新增的 `V-03b`（实测在 M9 下变红）；M11（窗口收尾不再提交）的守门者是 `concurrency` 的 `V-03-A2`（实测在 M11 下变红）。`concurrency` 侧新增的 `V-03-A2` **在 M9 下不变红**——本版不把它写成 M9 的守门者（那会是误导），其注释已写明这一事实。
- 缺陷探针先红后绿（V-02）：新增用例在修复前 `R9-01-F3`/`F4`/`F7`/`F5`/`F6` 五项红（`local` 被写入 16091 字节、提示谎报「已存于本地」），修复后全绿。
- **门禁自身的一处挂钟竞态已消除（W-03，本轮实施中新发现）**：`tests/popup.test.js` 的 `R8-04-C` 段有一句 `C-前置：全新安装、后台还没写下任何状态时，界面显示的是「直连」兜底`，它靠"抢在后台把 `lastState` 写进 `session` 之前读状态条"——那是一条**挂钟竞态**：后台先写完就会读到 `applied`，断言随机变红。**该竞态在基线 `3b6ebce` 上就存在**（同环境实测 3/20 命中，与本次改动无关），但它会在 CI 的变异门禁里把**基线**判成失败（`退出码 = 3`，门禁随即中止），从而**阻塞发布**。同类缺陷在 `concurrency` 侧也已被第九轮 03 判为 P3（R9-03 即"确定性重写"）。现改为**受控构造**：先 `waitUntil` 后台的状态写入确实落地，再显式把 `session` 清成"后台还没写下任何状态"，由 `onChanged` 驱动界面重读——**同一语义，不再依赖时序**。断言文本一字未改（`git diff` 中 `-  t(` 行数为 0）。修复后：Linux/Node 20 同环境实测 **20/20 全绿**（修前 5/20 失败）；变异自查证明该断言仍承重（把 `renderStatus` 的兜底改成恒 `applied` 后该断言变红）。
- **真机验证（真实 Chrome 136.0.7103.93，headless=new + CDP，独立临时 profile）**：12 项断言全 PASS。关键证据：①遮蔽现场（`sync`=116 字节默认列表 / `local`=11891 字节用户 500 条规则）在真机上被**稳定固定**（方法见下），且确认自愈写入确实发生过并被阻断 ≥1 次；②在此现场粘贴 16091 字节列表并保存（含二次确认）后，`local` **逐字符仍是用户的 500 条规则**（11891 字节），`sync` **未被写入该列表**（真实 `chrome.storage.sync` 单键上限 8192），提示为「未保存：…」；③遮蔽现场 + 「默认列表 + 编辑」形态：首次点击只进入确认态（按钮文案变「确认保存」，`sync`/`local` 零写入），二次点击后 `sync` 写入表单内容、`local` 仍逐字符未变。
  - **真机固定"遮蔽现场"的方法（首次跑真机时踩到的坑，记录以免复现）**：在 popup 页面里写 `chrome.storage` 会**唤醒 SW 并触发 R9-01 自愈**，遮蔽现场在几十毫秒内就被修好——"先写污染、再点保存"在真机上**永远抢不到窗口**（第一次实测表单显示的是用户自己的 500 条规则、`loadedShadowed=false`）。本次改为在 SW 上下文里把 `chrome.storage.sync.set` 包一层，只丢弃「单键 `bypassList:''`」这一类自愈写入（正常回调，其余写入照常）——与仓库测试桩的 `setFilter` 同型，**除被阻断的这一类写入外产品行为完全真实**。证据等级须据此如实标注：本项是「真机 + 受控注入」，不是"原生时序下自然发生"。
- **远端 CI 已实测通过**：`a4d2038`（含 W-03 修复）在 GitHub Actions 的 `测试与校验` 任务上 **Node 20 / 22 / 24 三个矩阵全部 success**（9m41s / 9m28s / 9m32s），远小于新增的 `timeout-minutes: 30` 护栏。此前 `8eccb49` 的 Node 20 矩阵曾因上述 `C-前置` 竞态在变异步骤判基线失败（exit 3）——该失败已定位并修复，不是本版功能缺陷。
- **门禁与洁净**：完整变异门禁 **18 达标 / 0 未达标 / 0 注入失败 / 0 BAD**，`原文件已恢复：是`，退出码 0（本机 13.4 分钟）；门禁后 `git status --porcelain --untracked-files=all` **为空**。
- **既有断言零削弱（可复核）**：`git diff 3b6ebce..HEAD -- tests/` 中 **`-  t(` 行数为 0**（没有任何断言被删除或改写），`+  t(` 新增 35 条。唯一改动的既有用例动作是 `R9-01` 段与 `R9-01-F9/F10` 的**点击次数**（两次点击），断言文本一字未改。

### 已知未关闭

- **R-1/R-2/R-3/R-4/R-5 按已知限制处理，未在本版消除**：跨设备清空后 `local` 旧副本复活（需引入来源标记键 `bypassSrc`，会改动 `CONFIG_KEYS` 与全部契约面，属独立变更面）、TOCTOU 窗口（平台无原子 CAS）、`session` 状态写入失败只留痕不降级、异常档图标不可区分、逐字符相等仍是后台自愈的唯一污染判据。**V-01 的判据盲区同理**：本版是把它的后果收窄为「用户知情后的一次确认」，根因（用值相等识别来源）不消除。
- **V-01 的二次确认门只覆盖「默认列表 + 编辑」形态（真机实测，如实记录）**：判据 `looksLikeShadowEdit` 要求表单值以内置默认列表的整行序列**开头**再追加内容（见 `V-01-k`：宁漏勿误伤，避免把用户自己精简过的列表误判成污染）。因此若用户在遮蔽现场把表单**整体替换**成另一份完全不同的列表（不保留默认列表前缀），确认门**不触发**，一次点击即写入 `sync`——此时后台自愈判据同样永久失效，用户规则长期不生效（**无数据丢失**：`local` 仍受守卫保护、逐字符未被改动）。真机实测该形态：一次点击后 `sync` 从 152 字节变为 34 字节、`local` 未被本段写入。**这是本版明确保留的取舍**，不是未发现的缺陷：收紧判据会把用户自写的正常列表也拖进确认流程，代价更高。
- **`resetDefaults()` 在遮蔽现场的行为未改**：它在用户明确确认后清空 `local`，属用户要求的结果；但其 `window.confirm` 与 V-01 处有同样的 popup 失焦风险，且测试桩从未提供 `confirm`（既有用例不点 `resetButton` 才未暴露）。留待后续版本。
- **未验证（不得由本版推断）**：真实 Chrome Stable/Beta/最低支持版 102 上本版新增交互的完整矩阵、真实企业策略与多扩展优先级、`storage.sync` 真实配额耗尽、跨设备真实同步、Chrome Web Store 签名与审核。**已做的真机验证**见下节「测试」。

## [2.7.0] - 2026-10-04

修复第九轮生产上线评估（基准 `7dcfe64`，报告见 `E:\pi-desktop-tools\docs\easy-proxy-by-ds4-第九轮-01-生产上线评估报告.md`）的 R9-01 / R9-02 / R9-05。本版新增可观察契约（`status:"error"` 的新子类型 `reason:"control_unknown"`、对应图标标题与 popup 状态条文案，以及遮蔽现场的 popup 提示），与 2.6.0 中 R7-01-F 新增 `reason:"read_failed"` 属同类变更，按仓库惯例升 minor。

### 修复

- **R9-01（P1）存量绕过列表污染：自愈前移 + 遮蔽现场守卫**：更早版本的升级补缺会把【内置默认列表】写进 `sync.bypassList`，而用户真实的长列表（超长降级保存）只剩 `local` 一份，取值规则「sync 非空优先」让默认 6 条遮蔽用户规则；此时 `clearLocalBypassIfAny()` 的唯一判据是「保存值是否逐字符等于内置默认列表」，用户**只要编辑一次再保存**，判据即失效并把 `local` 写空——`local` 没有第二份副本，长列表不可逆丢失，而界面只报「设置已保存」。修复分两层：①`background.js` 把原先只在 `onInstalled(update)` 执行一次的自愈抽成幂等函数 `reconcileLegacyBypass()`，在冷启动与每次 `storage` 变化时都执行，只写 `sync.bypassList` 空串占位、绝不触碰 `local`，读取失败即跳过本轮；这覆盖了原先覆盖不到的两条到达路径——升级瞬间 `storage.local.get` 失败使自愈被跳过（`onInstalled` 只在换版本时触发一次、之后不重试），以及另一台设备点「恢复默认」把默认列表经 `storage.sync` 同步过来（**不触发 `onInstalled`**）。②`popup.js` 在 `load()` 记录 `loadedShadowed`、在 `save()` **发起写入之前**快照为 `formWasShadowed`，遮蔽现场保存时不删除 `local`，并在界面显式提示冲突。快照必须在写入前做：写入 sync 会触发 `storage.onChanged`，popup 自身监听会重跑 `load()` 并把标记按新值重算，守卫会被自己的写入冲掉。
- **R9-02（P2）控制权回读失败改为拒绝下发**：前置控制权检查用 `readProxyDetails()`，该函数在回读失败时 resolve `null`（把「读不到」退化成「没有信息」），而调用点判据是 `if (preLevel && !isControllableByUs(preLevel))`，`null` 时整段被跳过 → 直接下发；于是「一次瞬时回读失败 + 外部确实已接管」＝我方夺权写入，与同文件内对比窗口两次复查的「未确证即拒绝」自相矛盾。现在新增 `readProxyDetailsWithRetry()`（3 次、退避 25/50ms、总上限 75ms；健康路径首次即成功、零额外延迟），仍无法确证则**放弃写入**，状态记 `error` + `reason:"control_unknown"`，图标标题与 popup 状态条统一为「无法确证代理控制权，本次未改动代理」，不再沿用与事实相反的「代理异常，流量可能已回退直连」。
- **R9-05（P3）状态写入失败不再静默**：`writeState()` / `writeTest()` 的 `session.set` 失败此前一律 `void chrome.runtime.lastError` 抑制，前端可能长期停留在过期结论（真实已是 `error`、界面仍显示上一次的 `applied`）且无任何日志。现改为 `console.warn` 留痕；控制流不变。

### 测试

- 缺陷修复提交本身未增删断言（保持 **527 项**）；随后为 R9-01 补上门禁用例（+5）、为 R9-03 补上确定性断言（+2），总数 **534 项**。3 条把「污染仍然存在」当作**前置事实**的断言改写为断言新契约「污染不会持续存在、自愈后下发/显示的是用户真值」：`ownership` 的 R8-02-A 两条、`popup` 的 B-1 一条。这三条新断言已被变异验证（把后台自愈改成空操作后，`ownership` 失败 2 项、`popup` 失败 1 项）。
- `concurrency` 的 R3-04a 等待窗口由 `sleep(300)` 放宽到 `sleep(700)`，**断言一字未改**，仅容纳控制权回读的有界重试后状态落盘。
- `mutation-check.js` 的 M9 锚点随 `onChanged` 处理函数新增自愈调用而更新，**变异语义不变**（仍只删 `suspendDirty = true` 那一行）。修复前后该变异一度退化为「注入失败 1 项」（锚点失配即变异未落地，此状态下门禁结果不可解读），锚点更新后恢复「已被拦截」，完整门禁回到 **达标 16 / 未达标 0 / 注入失败 0 / BAD 0**、`MUTATION_INNER_EXIT=0`。
- 修复提交的验证证据：七套 527 通过 / 0 失败；完整变异门禁 16/0/0/0 且退出码 0、原文件已恢复；新守卫变异自查 3/3 被拦截（移除 popup 守卫→探针红；自愈改空操作→仓库测试红；控制权恢复 fail-open→探针红）；缺陷探针先红后绿（基线 4/6 → 修复后 6/6）。

- 新增 **R9-01 门禁用例**（`tests/popup.test.js`，5 项）：把「sync=内置默认列表 + local=用户 500 条规则」的污染现场用**定向失败注入**固定住（只阻断后台自愈写下的 `{bypassList:""}`，其余写入照常，失败契约与真实一致：不写存储、不派 `onChanged`、`lastError` 仅在回调期间存在），再让用户在**被遮蔽的表单上编辑一个字后保存**，断言 `local` 未被写成空串、且 `local.set` 序列中不存在空串写入。该用例不含任何时序竞争，并已做变异自查：移除 `formWasShadowed` 守卫后 `R9-01-C` / `R9-01-D` 立即变红（local 条数 1 ≠ 500、出现 `[0]` 写入），套件退出码 1 —— 修补了「新守卫只由外部探针拦截、未进入仓库门禁」这一缺口。

- **R9-03（P3）M10 护栏确定性重写（本版关闭）**：R3-01-R3 此前用 `fetchDelay: 500` 与 `slowMs: 850` 两个**互相独立的挂钟定时器**赛跑，靠裕度而非构造保证拦截（第八轮的记录本身就写明「本次未取得先红后绿的 RED 证据」）。现改为：给 `buildEnv` 增加 `holdPort` / `releaseHeldSets()` —— 命中该端口的下发在测试显式放行前**不完成**，于是「在途下发」成为受控状态而非竞态；断言对象也从「取样是否被污染」改为**顺序不变量**「在途下发未收尾之前，对比窗口不得执行 `clear:regular`」。确定性证据：对 `background.js` 施加 M10（去掉排他入队）后重复运行 `ownership` 套件 **20 次，新断言 20/20 命中 RED、非零退出 20/20、失败签名逐次完全一致**（`新增清除 = ["regular","regular_only","incognito_persistent","incognito_session_only"]`），且每次仅此一条断言失败；同一构造下旧时序断言 0/20 —— 在途写被挂起、不落地，旧断言已不具备检出能力，这也说明新断言不是"多一条冗余"，而是该不变量**唯一**的守门者。`ownership` 断言数 228 → **230**。

### 已知未关闭

- **R9-03（P3）M10 变异护栏仍依赖两个独立挂钟定时器 —— 本版已关闭**（确定性重写与 20/20 证据见「测试」节）；以下为关闭前的状态记录：本版把 `fetchDelay` / `slowMs` 的裕度保留在第八轮的加宽值，实测本机 38/38 拦截、完整门禁达标，但**仍无原参数下的 RED 证据**，护栏本质仍是「余量加宽」而非「确定性构造」。确定化改造（由测试桩显式控制「在途 set 尚未回调」，改为断言顺序不变量）需改动 `ownership.test.js` 的 `buildEnv` 桩，属独立变更面，**未包含在本版**，将在后续独立提交中处理。
- **R9-04（P3）主工作树两份未跟踪审计材料**：属仓库卫生，需由主控决定归档或删除，本版不代为处理。
- 远端 CI 已实测：`8b64982`（发布 2.7.0）与 `e477e94`（R9-01 门禁用例）在 GitHub Actions 的 `测试与校验` 任务上 **Node 20 / 22 / 24 全部 success**；`24405bf` 无 check-run（当时仅存在于分支、未作为推送头，故未触发）。审计报告「远端 CI 三 Node 矩阵未运行」一项据此关闭。
- **未验证（不得由本版推断）**：真实 Chrome Stable/Beta/最低支持版 102、真实代理服务器与流量、企业策略与多扩展真实优先级、MV3 Service Worker 强杀恢复、`storage.sync` 真实配额与跨设备交错、Chrome Web Store 签名与审核。

## [2.6.0] - 2026-10-04

修复第六轮审计遗留的 R6-01 / R6-03 / R6-04，以及第七轮复审的 R7-01 / R7-02 / R7-03 / R7-04 / R7-05 / R7-07 / R7-08。本版改变了可观察契约（状态与图标分支、对比测试早退路径、popup 失败文案），按仓库惯例升 minor。

### 修复

- **R6-01（P1）对比收尾必须消费 `applyProxyCore()` 的返回值**：真实 `chrome.proxy.settings.set` 失败走 callback `lastError`，被转成 `{ok:false, status:"error"}` **正常 resolve**，而收尾只 catch 异常（throw），于是把「恢复失败」当成「恢复成功」并顺手清掉脏标记，兜底重放的条件因而恒不成立。现在收尾显式消费返回值：非成功终态即记 `restoreFailed` 并保留脏标记，前台不再给出与状态条相反的绿色结论。
- **R6-03（P2）脏标记只在确认终态消费**：仅在 `ok === true` 且 `status !== "overridden"` 时清除。此前「返回对象式失败」与「确认成功」两条路径都会清零，使「接管期间记脏、解除后重放成功」这条链把脏标记一路留给后续窗口，一次用户根本没改配置的对比测试会误报「有配置变更待下发」。同时清除前接管分支补上 `pendingResubmit`，不再丢弃待下发标记。
- **R6-04（P2）注册 `chrome.proxy.settings.onChange` 只读回查**：企业策略或其它扩展接管 / 释放后状态与图标及时对齐。回查严格只读，不写回、不夺权（`set` / `clear` 零调用）。
- **R7-01（P1）存储读取失败改为显式失败**：`readSettings` / `readBypassText` 此前只抑制 `lastError` 而不产生分支，读取失败被归一成默认配置（`enableProxy:false`），`applyProxyCore` 便在「未启用」分支真清除仍在生效的代理，状态写 `direct`、图标转红、标题报「未启用代理（直连）」。现在读取失败直接写 `status:error` + 非空 `message`，绝不调用 `setProxy` / `clearProxyScope`，绝不写 `direct` / `applied`。
- **R7-01-F 读取失败的前台与图标文案**：新增 `reason:"read_failed"` 子类型（`status` 仍为 `error`，既有契约不变），图标标题与状态条改用「无法读取配置，本次未改动代理」，不再声称「流量可能已回退直连」；真实代理故障仍保留原文案。
- **R7-02（P1）对比测试入口绑定实际生效配置**：窗口的第一步就是 `clearProxyScope("regular")`，而收尾的 `applyProxyCore` 会因校验失败直接返回 `saved_not_applied`、一次 `set` 都不发，于是「清除」与「恢复」严重不对称——仍在工作的旧代理被清掉且永不写回。现在进入窗口前同时确认「配置本身有效」与「回读到的实际生效模式确为 `fixed_servers`」，任一不满足即早退并如实报 `compareSkipped` / `compareSkippedReason`，且不写状态、不改图标、不清脏。
- **R7-03（P1）升级补缺按有效来源判断绕过列表**：超长列表保存时 `sync.bypassList` 被写成空串占位、真值在 `local`，而 `onInstalled` 的 update 分支把占位空串当成「用户没配」并写入默认 6 条，造成遮蔽（长列表失效）、误改（用户主动清空后被改回默认）、永久删除（再点一次保存即触发 `clearLocalBypassIfAny()` 清掉唯一副本）。现在按与 `resolveBypassList` 同源的判据、以【原始键是否存在】而非归一化结果区分四态；`local` 读取失败时宁可不补写也不覆盖用户数据。
- **R7-05（P2）回声抑制先过控制权检查**：外部扩展以【相同】mode/host/port 接管时值比对同样成立，回调被当成我方回声直接 return，session 仍写 `applied` / 图标留绿，而真实控制权已是 `controlled_by_other_extensions`。改为 `isControllableByUs(level) && isOwnLastIntent(...)`，两条合法回声路径的抑制语义不变。
- **R7-07 拒绝非 ASCII 代理主机名**：Chrome 要求 `singleProxy.host` 必须是 ASCII（Punycode），IDNA 不受支持。新增 `isAsciiHost` 作为校验链最后一个分支（不改动任何既有分支的顺序与文案），非 ASCII 时给出转 Punycode 的可执行提示；IPv4、主机名、IPv6 字面量与已是 Punycode 的输入继续零错误。
- **R7-08 popup 异常路径必须复位测试按钮**：`runTest` 里 `await` 之后的两行复位在抛错时永不执行，两个测试按钮停在 `disabled=true`，用户只能关掉重开 popup，其中一种情形还会留下 `Uncaught (in promise)`。改为 `try/catch/finally`，按钮复位放进 `finally`；新增 `renderTestError` 让异常与「后台返回 `{ok:false}`」走同一档失败文案并如实带出原因；两个 click 调用点补 `.catch()`。

### 文档

- **R7-06 版本一致性**：`manifest.json`、三个源文件头（`settings.js` / `popup.js` / `background.js`）、`README.md` 与本文档统一为 2.6.0。
- **R7-09 README 与事实对齐**：隐私说明补上「绕过列表超过单项 8 KB 时改存 `storage.local`、不跨设备同步」这一例外；测试表补 `concurrency` / `ownership` / `popup` 三行并修正各行为实测断言数，变异行 6 → 16；命令块补全全部功能测试；版本号与套数表述同步。

### 测试

- 新增 `tests/popup.test.js`（28 项）：popup.js 此前无任何测试覆盖。断言对象一律是 popup 自身函数运行后 DOM 元素的真实 `disabled` / `innerHTML`，点击通过真实监听器派发；A/B 为异常路径 RED 断言，C/C2/D 为既有语义防回归，E 为调用点契约。
- 功能测试断言数由 **220 项增至 418 项**（v2.5.0 六组实测 220：manifest 44 / settings 48 / background 38 / fix-safety 19 / concurrency 29 / ownership 42；本版七组 418：manifest 44 / settings 66 / background 38 / fix-safety 19 / concurrency 33 / ownership 190 / popup 28）。
- **R7-04（P1）变异门禁锚点失效**：M11 的原 `from` 串在 R6-01 改动后命中 0 次，脚本会以 `injectFail=1` 退出 1，CI 一旦推送即红。现按改动后的文本改写锚点，并把变异数由 **13 项增至 16 项**：新增 M14（窗口收尾恒真清脏）、M15（普通成功路径不再清脏）、M16（只读回查里发生夺权式写回）。
- `tests/popup.test.js` 接入 CI（`.github/workflows/ci.yml`）与变异脚本的 `testFiles`。
- **M10 时序裕度加宽（第八轮遗留项）**：`R3-01-R3` 的污染检测要求「在途慢写的落地」落在「窗口完成清除」与「直连取样快照」之间，而这两个时刻由互相独立的定时器决定，原参数 `fetchDelay: 100` / `slowMs: 200` 给出的裕度约为 100ms 对 100ms；负载抖动下在途写可能落到快照之后，3 条断言便同时通过、M10 漏检。现加宽为 `fetchDelay: 500` / `slowMs: 850`（裕度提高约 4 倍）。**本次未取得「先红后绿」的 RED 证据**：在当前候选与第八轮基准上各复跑完整门禁一次、M10 单点 10 次、隔离用例 60 次，均未复现漏检，故本改动是依据根因分析的余量加宽，不是可复现回归的修复。断言条数与断言文本未变（`ownership` 仍 228 项），仅调整该用例的桩计时参数。

### 验证边界

以上结论均来自零依赖的 Node 桩测试与变异门禁，**未做真实 Chrome 端到端验证**：Service Worker 被强杀、企业策略（`levelOfControl` 为 `controlled_by_other_extensions` 的真实下发结果）、`chrome.storage.sync` 的真实配额与跨设备同步行为，均只按 API 契约在桩上模拟。

## [2.5.0] - 2026-10-03

修复第五轮评估的 P2。2.4.0 只存在于本地候选提交，没有 tag，也没有推送。

### 修复

- R5-01：对比是否开始只由 isControllableByUs 决定。缺 levelOfControl 不进入对比，也不清除代理。
- R5-02：出口 IP 相同只作为测试结论。代理配置仍在时，不再把状态和图标改成异常。
- R5-03：CI 在变异测试之前单独运行 tests/ownership.test.js。
- R5-04：暂停期间的存储变化立即记脏。成功下发、确认直连或确认外部接管后清除脏标记。

## [2.4.0] - 2026-10-03

修复第四次代码审计发现的缺陷。其中 **R3-01 仍是上线阻断项，且本轮查明它在修复后仍有一条逃逸路径**：对比测试的「清除 → 取直连出口 → 恢复」与普通下发是**两条并行的写路径**，恢复期间保存的新配置会被旧配置反向覆盖；暂停标记还会在恢复**之前**就被释放。

### 修复

- **R3-01（高危 · 上线阻断）恢复与在途下发共享排他所有权**
  - 新增 `applyProxyExclusive(task)`：把一段会改动 `chrome.proxy` 的**复合操作整体**排入与普通下发**同一条** `applyChain`。对比窗口（清除 → 取样 → 恢复）现在是一个排他任务：
    - 窗口**之前**排队的旧请求在任务开始时过期；
    - 窗口**期间**到达的更新请求只排队、不执行；
    - 窗口**收尾**按最新设置提交，排队请求随后幂等重放。
    此前窗口内的 `clear`、恢复 `setProxy(backup)`、失败重放 `applyProxy()`、脏标记重放 `applyProxy()` **全部绕过队列**，这才是"旧配置长期覆盖新配置"的根因。
  - **暂停贯穿收尾**：`suspendDepth--` 从恢复**之前**移到 `finally` 的**最末尾**，恢复与重放全部完成之后才释放。此前它先于恢复执行，窗口内的保存因而走正常下发路径并抢先落地，随后被慢速的旧 backup 覆盖。
  - **收尾按最新设置提交，不再写回旧 backup**：`applyProxy` 拆分为 `applyProxyCore`（不含暂停检查的下发实现）+ `applyProxy`（暂停检查）。窗口收尾直接调用 `applyProxyCore()`，它**读最新的 settings** 并下发。于是「改端口 → 下发新端口」「关代理 → 清除代理」「没改 → 语义等价」三者同时成立，旧 backup 不再有任何写回路径。此前是"先写旧 backup、再赌一次重放"，而恢复写回成为在途慢操作时这次重放根本来不及。
  - **接管时不再丢弃待下发的配置**（本轮新查明的逃逸面）：接管分支原本无条件执行 `suspendDirty = false` 且自身不重放，导致"对比窗口内发生外部接管"时，用户在暂停期改的端口/关闭代理会被**永久丢弃且无任何提示** —— 与原始缺陷完全同型。现在该分支**不清空**脏标记，并把它作为 `pendingResubmit` 如实汇报。
- **R3-04（中）控制权判定从"失败开放"改为"白名单"**
  - 回读结果**缺少 `levelOfControl`** 时不再判 `applied`：此前 `if (level && level !== 'controlled_by_this_extension')` 在 `level === undefined` 时短路为假、直接落入 `applied`，在"无法确认控制权"的情况下宣称"已生效"。现在只有确证 `controlled_by_this_extension` 才算成功，缺字段判 `error`。
  - 窗口收尾的控制权复核改为**白名单放行**（`isControllableByUs`）：只有"本扩展控制"或"当前无人控制、可被我方接管"才允许提交；**回读失败、返回缺字段、已被外部接管一律不写回**。此前控制权未知（读失败 → `null`）被当成"没人接管"而默认写回旧 backup，会把外部扩展刚建立的配置覆盖掉。
  - 新增**对比清除前的控制权复核**，修掉一处 check-then-act TOCTOU：`controlledByUs` 由早先的 `before` 回读算出，而 `clearProxyScope` 在此之后才执行；两者之间发生的接管会被我方清除**破坏且无人恢复**（实测：外部配置 `external:9090` 生效后被我方清成直连，最终 `actual=null`）。现在清除前若控制权已非我方，直接放弃对比并标记 `control_changed_before_clear`。
  - 正常下发路径增加**不夺权前置保护**：确证已被外部接管时跳过下发并记 `overridden`（回读失败不阻断，避免代理故障期间扩展不可用）。
- **R3-07（中）状态与实际配置强制一致**
  - 新增**落实校验**：`set` 的回调成功 ≠ 配置真的生效。下发的是 `fixed_servers` 而回读实际 `mode` 不是 `fixed_servers` 时判 `error`。这修掉一处真实缺陷：对比开始时若读到 `before.value.mode === "direct"`，旧实现会把 `{mode:"direct"}` 当作 backup 写回 —— `set` 成功但代理根本没挂上，状态却仍写 `applied`（界面"已生效"、实际在直连）。
  - **窗口开始主动写 `suspended` 状态与图标**：此前 `suspended` 只在"暂停期间恰好收到一次 apply 请求"时才产生，正常的对比测试（用户没动设置）全程没有任何可观测的状态变化，界面停留在测试前的旧结论上，而实际此刻代理已被清除。
  - **旧测试结论不得覆盖更权威的结论**：窗口内发生接管时写下的 `overridden` 表达的是"我们已放弃控制权"，此前会被测试结束时的"出口相同 → error"改写，把用户引去排查代理，而真正要处理的是企业策略或其它扩展。现在该情形只标记 `stateSuperseded`，不覆盖状态。
- **R3-06（中）变异门禁不再把"进程启动失败"当成"变异被拦截"**
  - `runTest()` 返回结构化结果 `{code, reason}`，`reason ∈ {ok, assert, spawn}`；**`spawn` 一律记 `BAD`**（门禁自身失效），不计入"达标"。
  - 判据收紧为「**基线绿 + 注入成功 + 变异被拦截**」三者同时成立；存在 `MISS`/`注入失败`/`BAD`/未恢复时退出码为 1。
  - 此前 `const failed = code !== 0;` 会把 `-1`（spawn 失败）当成"测试失败 = 变异被拦截"：**全部 spawn 都失败时门禁会打印"达标 9 项，未达标 0 项"并以 exit 0 放行**，整个护栏体系静默失效。已用内存 harness 复现并验证修复。

### 新增

- `tests/ownership.test.js`（30 项）：**所有权与竞态护栏**。断言对象一律是【实际下发给 `chrome.proxy` 的配置】或【取样时刻的真实状态】，绝不是内部变量或存储值 —— 本项目 A1、N1、R3-01 三次缺陷的共同特征都是"存储一直正确、浏览器实际失效"。覆盖：
  - 对比期间的保存必须最终生效（不依赖任何注入钩子，纯时序；在修复前的基线实现上实跑为**红**）；
  - 恢复窗口在途时保存新端口 / 关闭代理 → 结束实际配置必须为新值；
  - 下发在途时启动对比 → 直连取样不得被污染，且不得回退旧值；
  - 外部接管时不夺权但也不丢弃待下发配置；
  - 缺 `levelOfControl` 不判 `applied`；收尾回读失败不写回；清除前接管不执行破坏性清除；
  - 恢复后实际配置与状态一致；下发后实际模式不符时不得判 applied；窗口开始产生可观测的进行中状态。
- `tests/mutation-check.js` 新增 **M10**（对比窗口不再排他入队）、**M11**（窗口收尾不再提交）、**M12**（控制权白名单放宽为恒真）、**M13**（窗口不再主动写 suspended 状态）四个变异点，覆盖本轮全部新护栏。
- 变异测试纳入 `ownership.test.js`（此前遗漏该文件会让护栏写在它里面时变异门禁形同虚设）。

### 测试规模

六组功能测试共 **201 项断言**（上一版 170 项：manifest 41→42、新增 ownership 30 项），变异测试 **12 项**。

## [2.3.0] - 2026-10-03

修复第三次代码审计发现的缺陷。其中 **R3-01 为高危且是上线阻断项**：直连对比测试期间保存的新配置被**静默丢弃**。

### 修复

- **R3-01（高危 · 上线阻断）对比测试期间保存的新配置从不下发**：`suspendDepth > 0` 时 `applyProxy` 直接 `return {ok:true, status:"suspended"}` —— 既不记脏也不重放；而测试的 `finally` 只把**测试前的旧 backup** 写回去。于是测试期间用户改的端口、乃至**关闭代理**的操作，都会被旧配置反向覆盖：界面与存储显示新值，浏览器实际仍在用旧配置，且**没有任何报错**，此后也不再有变化事件来纠正。
  - 暂停期间改为**记脏**（`suspendDirty`）：计数器只保证"以后还能下发"，不保证"被跳过的更新会被补上"，这两件事必须分开记录。
  - 测试退出时，在恢复 backup **之后**按**最新 settings** 重新下发一次，把暂停期间被丢弃的变更补上。
  - 恢复阶段先复核控制权：若对比期间代理已被企业策略或其它扩展接管，**直接放弃写回**（写回旧 backup 等于夺权），只如实记录 `overridden` 状态。
  - 新增两条**行为断言**（断言下发给 `chrome.proxy` 的实际配置，而非存储值）：测试期保存 7777 → 结束后实际生效必为 7777；测试期关闭代理 → 结束后实际必为直连。
- **R3-04（中）错误被静默吞掉、回读失败仍亮绿灯**：`clearProxyScope` 无论成败都 `resolve`；`readProxyDetails` 失败返回 `null` 时，`if (level && level !== ...)` 短路为假，直接落入 `applied` —— 在**未证实控制权**的情况下显示"代理已生效"。
  - `clearProxyScope` 检测 `lastError` 后 `reject`；关闭代理时的清除失败返回明确错误，不再假装已直连。
  - 回读失败（`details` 为 `null`）一律判为 `error` 并写明"无法确认代理是否已生效"，不再判 `applied`。
  - 对比测试中清除代理失败时标记 `directClearFailed`，避免把不可信的"直连出口"当成结论。
  - 遗留作用域清理失败降级为**有记录**（`console.warn`），不再完全静默。
- **R3-03（中）并发拒绝被误报成"出口检测失败"**：后台返回的 `{ok:false, skipped:"in_flight"}` 本意是"已有测试在跑"，前台却因为从未判断 `result.ok`/`skipped`，一路落到"出口检测失败"，把用户引去排查代理。
  - `renderTest` 判定链最前面插入：带 `skipped` 的拒绝 → "已有测试在进行中"；其余 `ok:false` → 显示明确错误。
  - 同时补上 `overriddenDuringTest` / `directClearFailed` 两类新增结果的文案。
- **R3-07（中）`suspended` 状态没有产生链路**：只 `return` 不写状态、不更新图标，`updateIcon` 的标题映射表也没有 `suspended` 键（即使写了状态，标题也会退化成兜底的"代理设置"）。
  - 暂停期间写入 `suspended` 状态并 `updateIcon("suspended")`；标题表补 `suspended` 文案。
- **R3-05（轻）内部消息未校验来源**：`onMessage` 的 `sender` 形参在整个函数体内零引用。
  - 入口校验 `sender.id === chrome.runtime.id`，来源不明或缺失一律拒绝并返回 `unauthorized_sender`。
  - 说明：跨扩展通信走 `onMessageExternal`（本项目未注册），普通网页也无法进入内部通道，**当前不存在已证的利用链**，本次是按纵深防御补齐。

### 新增

- `tests/concurrency.test.js` 新增 **19 项**断言（5 → 24 项）：R3-01 两条最终落地行为断言、R3-01b 关闭代理断言、R3-04a/04b 故障注入断言、R3-07 状态链路断言、R3-05 来源校验断言、R3-03 真实 `renderTest` 渲染断言（含"真正的出口失败仍显示网络故障"对照组）。
- 变异测试新增 **M9**（去掉暂停期脏标记重放），确认 R3-01 的新护栏真的会拦截回归。
- `tests/manifest.test.js` 新增 2 项：`manifest.version` 与 `CHANGELOG` 首条版本必须一致。

### 门禁加固

- `tests/mutation-check.js`：**基线非 0 立即中止**（退出码 3）。此前基线失败时只打印一行就继续跑，而 `runTest()` 在基线已失败的情况下会让**每一个变异都呈现"已被拦截"** —— 门禁会静默变成永远放行。现同时区分"断言失败"、"进程启动失败（-1）"与"注入失败"。

### 测试规模

五组功能测试共 **170 项断言**（上一版 149 项：manifest 39→41、concurrency 5→24，其余不变），变异测试 **9 项**全部达标。

### 关于 tag v2.2.1

`v2.2.1` 与 `v2.2.0` 之间**只有测试文件变化**（`tests/mutation-check.js`，25 增 2 删），运行代码完全一致，因此 **`v2.2.1` 是仅测试修复标签，不作为扩展发布版本**。按 Chrome 的版本比较语义（以 `manifest.version` 的 1~4 段整数比较，Git tag 不参与），把它当作 2.2.1 发布不会让用户收到任何更新。该 tag 保持原样、不移动、不删除；本次运行修复统一以 **2.3.0** 发布。

## [2.2.0] - 2026-10-03

修复第二次代码审计发现的缺陷。其中 N1 为**高危**，且由 2.1.0 的修复自身引入。

### 修复

- **N1（高危）并发连接测试导致自动下发永久失效**：`testConnection` 用「保存布尔标志再恢复」的方式暂停下发，两个测试并发时后一个会读到前一个已置位的值，恢复后仍为 `true`，此后**所有代理下发被静默跳过** —— 改设置、保存均无效，且 `applyProxy` 仍返回成功，只有重载扩展才能恢复。
  - 改为**计数器** `suspendDepth`（进入 +1 / 退出 -1），天然可重入，无论怎样交错都必然归零。
  - 移除 `applySuspended` 布尔标志与其保存-恢复逻辑。
- **N2（中）连接测试无并发互斥**：两个测试同时跑会互相干扰，一个在恢复代理、另一个正在取直连出口，导致直连出口被代理出口污染，给出错误结论。
  - 新增 `testInFlight` 互斥，并发的第二次直接返回 `skipped: "in_flight"`，界面提示「已有测试在进行中」。
- **N3（中）IPv6 代理地址被误拒**：原校验用「含冒号即拒绝」来拦 `1.2.3.4:8080` 这类误写，但 IPv6 地址本身含冒号，`::1`、`fe80::1`、`[::1]` 全被误判。
  - 改为 `looksLikeHostPort()` 精确识别（恰好一个冒号 + 不以 `[` 开头 + 冒号后全数字）。
  - 新增 `stripBrackets()`，下发前把 `[::1]` 归一化为 `::1`。
- **N4（中）全角分隔符不被识别**：绕过列表中全角逗号 `，`、分号 `；`、顿号 `、` 不被当作分隔符，整串会作为一个条目下发而被 Chrome 忽略，表现为「配了多条规则却一条都没生效」的静默失效。中文输入法下极易带入。
  - 分隔符正则扩展为 `[,;，；、]`。
- **N5（轻）`suspended` 状态无文案**：弹窗此前显示灰色「状态未知」，已补「连接测试进行中，暂缓下发」。

### 新增

- `tests/concurrency.test.js`：并发护栏测试（5 项），用**行为断言**捕捉 N1 —— 断言「并发测试后改设置，`setProxy` 确实被调用过」，直接观测失效后果而非内部变量。
- 变异测试新增 2 个变异点：M7（模拟 N1 泄漏）、M8（去掉并发互斥），并**改为运行全部测试文件** —— 此前只跑 `background.test.js`，导致护栏写在别的文件时变异门禁形同虚设。
- `background.test.js` 新增 IPv6 与全角分隔符用例（15 项）。
- `manifest.test.js` 新增 background 图标引用校验（11 项）。

### 测试规模

六套测试共 **149 项断言**（上一版 96 项），变异测试 8 项全部达标。

## [2.1.2] - 2026-10-03

图标语义改进。**不改变扩展的运行行为**。

### 变更

- **两态改用不同字形区分**：红色图标改为 **「直」**（表示直连／未启用代理），绿色图标保留 **「代」**（表示走代理）。
  - 此前两态只有颜色差别（同一「代」字），在色觉异常、灰度显示或屏幕反光的情况下难以分辨；现在**看字形即可判断状态**。
  - 两个字各自按字形包围盒居中，「直」与「代」的视觉重心保持一致，切换时不会跳动。
- 悬停提示（`setTitle`）在两态下分别显示「代理已生效」与「未启用代理（直连）」，与字形语义一致。

## [2.1.1] - 2026-10-03

工程化补充与图标规范化。**不改变扩展的运行行为**，但修正了清单层面的资源问题。

### 修复

- **图标尺寸非标准（审计 C5）**：原先 `icon-red.png` 为 136×133、`icon-green.png` 为 135×133，均非 Chrome 推荐尺寸，且两枚尺寸不一致，导致任务栏与扩展页中显示模糊、状态切换时轻微跳动。
  - 重新制作为标准的 **16 / 32 / 48 / 128** 四档，红绿两态同源同尺寸，清单按尺寸分别引用，Chrome 可挑选最合适的一档而无需缩放。
  - 同时重新设计为「实心圆角块 + 反白字」：原「白底描边」在小尺寸下边框会挤压字形，实心方案在 16px 下对比度最高、最清晰。
  - 消除了原图携带的第三方水印（约 3–4% 像素为低饱和浅灰的素材站水印）。
  - 红绿两态配色统一为 Material 标准色（`#D32F2F` / `#43A047`），原两图连笔画颜色都不一致（红图为红字、绿图为黑字）。
- **版本号与 git tag 对齐**：`manifest.json` 的 `version` 由 `2.1.0` 提升为 `2.1.1`，与 tag `v2.1.1` 对应。

### 新增

- `SECURITY.md`：漏洞私密报告渠道、支持范围、权限与网络请求的安全设计说明、已知固有风险。
- `.github/ISSUE_TEMPLATE/`：缺陷报告与功能建议两个表单模板，外加选择器配置。缺陷模板针对本项目特点设置了必填项（扩展版本、Chrome 版本与渠道、操作系统、复现步骤、预期、实际）与可选项（代理软件、连接测试结果、控制台日志）。
- `LICENSE`（MIT）。
- `.github/workflows/ci.yml`：在 Node 20 / 22 / 24 上自动运行全部测试，并核验变异测试后工作区未被污染。
- `.editorconfig`：统一 LF 与缩进，避免跨平台换行漂移。
- `tests/manifest.test.js`（28 项）：把原先手工做的清单检查自动化——版本格式、权限最小化、引用文件存在性、HTML 与 JS 的元素 ID 一致性。

## [2.1.0] - 2026-10-03

针对 v2.0.0 的代码审计结果做的修复版本。审计发现的问题均为**条件性触发的竞态**，不影响日常单次使用，但失败方向是「显示与真实状态不符」，与本项目要解决的核心问题同类，故予修复。

### 修复

- **并发下发竞态（严重）**：`applyProxy` 含多个 `await` 且无串行化，多个调用点并发时，较早发起但较慢的旧配置会覆盖新配置，导致存储为新值而浏览器实际生效为旧值。
  - 引入 `applyProxySerial()`：串行队列 + 代次号（generation）。排队期间若有更新请求进来，过时请求直接跳过。
  - 全部 9 处调用点改为走串行入口。
- **连接测试竞态（严重）**：`testConnection` 的「清除代理 → 取直连出口 → 恢复」流程期间，若发生任何存储变化会触发重新下发，使「直连出口」实测为代理出口，最终误报「代理很可能未生效」。
  - 引入 `applySuspended` 暂停标志，测试期间暂停自动下发，并在 `finally` 中复位。
- **测试结论与状态不一致**：测试判定代理未生效时，顶部状态条仍显示「已生效」。现在会同步更新状态与图标。
- **取值不一致（中等）**：`popup.load` 先用 `normalizeSettings` 填补缺失值再判断是否回退 `storage.local`，导致回退分支永不执行，界面显示与实际下发可能取到不同列表。
  - 新增 `resolveBypassList(syncValue, localValue)` 并导出，popup 与 background 共用同一规则。
- **冗余写入（中等）**：`save()` 无条件写 `local.bypassList = ""`，当 local 原本有值时会产生一次真实变化并触发多余下发。改为仅在确有内容时清空。
- **CIDR 误判（轻微）**：`isCidr` 仅按字符集判断，会把 `beef.cafe/12` 这类纯 hex 域名误判为网段而不剥离路径。改为要求斜杠前必须是真正的 IP 字面量（IPv6 含冒号；IPv4 恰好 4 段且每段 ≤ 255）。
- **对比测试的越权风险（轻微）**：compare 分支会把 `chrome.proxy.settings.get` 返回的当前值当作自己的配置写回。现在仅在 `levelOfControl` 为本扩展时才执行对比，否则跳过并在界面说明。

### 新增

- `tests/background.test.js`：异步逻辑测试（23 项），用 mock `chrome.*` 环境真实驱动。
- `tests/fix-safety.test.js`：修复安全性测试（19 项），重点验证暂停标志必然复位。
- `tests/mutation-check.js`：变异测试（6 项），确认护栏测试真的能拦截回归。

### 说明

- 行为对用户可见的变化：图标与状态条在「测试判定未生效」时会转为错误状态；被外部接管的场景下对比测试会跳过并说明原因。
- 升级不会覆盖已有设置（`onInstalled` 的 update 分支仍只补空缺、不改动启用状态）。

## [2.0.0] - 2026-10-03

相对旧项目 `easyproxyBYcursorAI` 的重构版本。

### 新增 / 变更

- 改用原生 `chrome.proxy` 的 `fixed_servers` 下发，不再生成 PAC 脚本。
  - 根除旧版的 HTTP 模式静默失效：旧代码把界面值 `http` 大写后当 PAC 关键字，生成 Chromium 无法识别的 `HTTP host:port`，解析失败后静默回退直连。
- 默认值开箱即用：`socks5` + `127.0.0.1:10808`。
- 默认绕过列表内置 RFC 1918 三个私有网段与内网域名后缀，实现「局域网直连」。
- 新增出口检测：查看当前出口 IP，并可与直连出口对比以验证代理是否真的生效。
- 状态可见化：图标绿色表示**真实下发成功**，而非「开关被勾选」。
- 代理类型只保留 SOCKS5 与 HTTPS。
- 新增 `settings.js` 作为设置模型的唯一来源（纯函数，零 `chrome.*` 依赖）。
- 新增 `tests/settings.test.js`（48 项）。

### 已知边界（非缺陷，系 Chromium 既定行为）

- IP 网段绕过规则只对 IP 字面量生效；内网域名需用 `.local` / `.lan` 等后缀规则。
- 回环地址被 Chrome 隐式直连。
- SOCKS5 仅代理 TCP，且不支持认证。
