# 架构说明（ARCHITECTURE）

本文面向维护者，说明 `background.js` 的状态机、并发设计、三条存储区的契约，以及「遮蔽现场」防线的分工。读完本文再改核心判据，请同时阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 的门禁约定。

## 1. 三层结构与职责边界

| 文件 | 职责 | 禁止 |
| --- | --- | --- |
| `settings.js` | 默认值、归一化、校验、纯函数工具（唯一来源） | 依赖任何 `chrome.*` |
| `background.js` | 代理下发状态机、事件监听、对比测试、自愈 | 直接操作 DOM |
| `popup.js` | 表单渲染、行内校验、结果展示、读写存储 | 绕过 background 做下发决策 |

取值规则（如 `resolveBypassList`）、判据（如 `isLegacyShadowPair`）一律收敛在 `settings.js` 单一实现，popup 与 background 共用 —— **同一业务判据出现第二份实现就是缺陷**（G3/S1 的教训）。

## 2. 下发状态机（`applyProxyCore`）

状态机只有一个入口 `applyProxyCore`，产出互斥的终态：

```
readSettings/readBypassText ──失败──▶ error(reason:"read_failed")     【绝无写操作】
        │
        ├─ enableProxy=false ──▶ clearProxyScope("regular") ──▶ direct
        │
        ├─ validateSettings 失败 ──▶ saved_not_applied（不下发）
        │
        ├─ 控制权回读失败（有界重试后） ──▶ error(reason:"control_unknown")【不写】
        │
        ├─ 控制权属外部 ──▶ overridden（不夺权，不清脏）
        │
        └─ setProxy(fixed_servers) ──▶ 回读 ──┬─ 回读失败 ──▶ error
                                              ├─ level 非白名单 ──▶ overridden
                                              ├─ 实际 mode ≠ fixed_servers ──▶ error
                                              └─ 一致 ──▶ applied
```

核心不变量：**「读不到 ≠ 没有」**。任何读取失败都显式上报 `error` 并终止，绝不归一成默认值后继续走写分支（R7-01 的教训）。

## 3. 并发设计三件套

| 机制 | 实现 | 防什么 |
| --- | --- | --- |
| 串行队列 | `applyChain`：所有会写 `chrome.proxy` 的复合操作排入同一条链 | 两条写路径交错（旧配置覆盖新配置，A1/R3-01） |
| 代次号 | `applyGeneration`：排队期间有更新请求则旧请求过时跳过 | 较早发起但较慢的旧下发覆盖新意图 |
| 暂停计数器 | `suspendDepth`（可重入）+ `suspendDirty`（记脏） | 对比窗口期间的下发请求被静默丢弃；布尔标志在并发下失配（N1） |

对比窗口（`runCompareWindow`）整体作为**排他任务**入队：窗口前排队请求过期、窗口中到达的请求记脏、收尾按**最新 settings**提交、`finally` 里递减计数器并清除恢复意图标记（S2）。

**恢复意图持久化（S2）**：窗口清除代理之前把 `pendingRestore` 写入 `storage.session`；SW 在窗口中途被回收时标记残留，冷启动 `reconcilePendingRestore()` 消费标记 → 如实上报 `reason:"restore_interrupted"` → 立即按最新 settings 重新下发。

## 4. 三条存储区的契约

| 区 | 内容 | 规则 |
| --- | --- | --- |
| `sync` | 代理配置（`CONFIG_KEYS`）；`bypassList` 为空串 = 「已降级到 local」的正常占位 | 跨设备同步；单键上限 8192 字节 |
| `local` | 超长绕过列表的降级副本 | **用户的唯一副本，任何自动逻辑绝不写它**（清空只发生在：用户明确保存短列表 / 明确恢复默认） |
| `session` | `lastState` / `lastTest` / `pendingRestore`（见 SECURITY.md 键清单） | 浏览器会话结束即清 |

取值规则：`resolveBypassList` = 「sync 非空优先，为空回退 local」。popup 显示与实际下发必须走同一函数。

## 5. 遮蔽现场（shadow scene）防线分工

历史缺陷曾把「内置默认列表」写进 `sync.bypassList`，而用户真实长列表只剩 `local` 一份。防线按「写不写数据」分层：

| 层 | 判据 | 判据强度 | 动作 |
| --- | --- | --- | --- |
| 后台自愈 `reconcileLegacyBypass`（`isLegacyShadowed`） | 逐字符相等 | **保守**（要写 sync，误判伤数据） | 把 sync 恢复为空串占位，让 local 重新生效 |
| 前台确认门（`isLegacyShadowPair`） | 逐字符相等 + 「默认列表+编辑」形态 | 放宽（只触发一次确认，不写数据） | `loadedShadowed=true`：保存走遮蔽分支（不写 local）+ 行内二次确认 |
| 纵深防御（`clearLocalBypassIfAny`） | 保存值=默认列表 **或** `formWasShadowed` | 双条件任一命中即拒写 | 不产生任何 local 写入 |

两个判据刻意**不同名、不同文件、语义各自写清**（见 `settings.js` 注释）——不要把它们"统一"成一份而把保守侧悄悄放宽。

## 6. 测试与门禁的对应关系

| 护栏 | 文件 |
| --- | --- |
| 7 套功能测试（852 项断言，`tests/run-all.js` 统一入口，README 数值有 G1 运行期自检守卫） | `tests/*.test.js` |
| 真实浏览器 E2E 冒烟（22 项断言，opt-in `npm run e2e`；Playwright 驱动真实 Chromium 加载**打包产物**，覆盖「启用 → applied」「禁用 → 未残留 + 回到基线」「外部接管 → overridden 且不夺权」三条主干。刻意与 `npm test` / CI 门禁解耦：需要可选依赖 `playwright-core` 与 Chromium 二进制，属于发布前人工门禁而非零依赖门禁） | `tests/e2e-smoke.js` + `tests/e2e/fixtures/interloper/` |
| 变异门禁（34 项：每个修复点被故意破坏后护栏必须变红；S-1 加固后任何退出路径（含信号与未捕获异常）均幂等还原源文件，并以运行前后工作区快照比对判定污染；B-3 起改写源文件前落哨兵 `.mutation-in-progress`，`tools/package.js` 见到即拒绝打包 —— 例外仅在「显式 `selfCheck` + 目标位于系统临时目录」两条件同时满足时生效，发布 CLI 永不满足） | `tests/mutation-check.js` |
| 文档一致性（断言数/变异数声明 vs 实际） | `tests/g1-consistency.js` + `tests/manifest.test.js` |
| CI（lint → 7 套测试 → 变异 → 工作区洁净核验） | `.github/workflows/ci.yml` |

## 7. 缺陷 / 修复编号索引（L-6）

源码与测试里散布着形如 `【X-NN】` / `【XNN】` 的注释标注，用来把某段代码与「它是在修哪个缺陷」绑在一起。此前这些编号**没有集中登记**：`X` 是哪一族、到哪一号、有没有冲突，全靠人工记忆，跨文件引用无法机械定位。

**编号规则（重要）**：编号是**分轮次（审计批次）作用域的，不跨轮唯一**。同一个符号在不同轮次完全可能指不同的缺陷 —— 例如 `M-1` 在 v2.10.0 一轮指「表单重绘丢失焦点」，在 v2.13.0 一轮指「缺 `.gitattributes` 导致产物不可复现」。因此：

- 解读编号必须**连轮次一起读**；本仓库的约定是在标注里带来源后缀。已用过的后缀：`·审计修复`（v2.13.0 一轮的 `M-1…M-3` / `L-1…L-8`）、`·工作区报告修复`（v2.15.0 一轮的 `L-1…L-4`，来源是**工作区级**审计报告，其 `H-1` / `M-1` 两项发现落在**仓库之外**、因此代码里没有对应标注）。同一个 `L-1` 在这两轮分别指「`estimateBytes` 的不可达 `catch`」与「`popup.html` 里未转义的 `<local>`」—— 字面同号、含义无关。
- **`M` 族与变异编号同符号但不同域**：`tests/mutation-check.js` 的变异体名叫 `M1`…`M34`（裸写，不带 `【】`），而 `【M-1】`…`【M-7】` 是审计「中」级缺陷编号。二者语义无关，勿混。

编号族（机械校验用，勿删）：A · B · C · G · L · M · R · S · V · W

| 族 | 含义 | 典型编号 | 主要出处 |
| --- | --- | --- | --- |
| **A** | 代码审计 / 整改条目（早期轮次） | A-1…A-6、A1…A6 | `background.js`、`popup.js`、`popup.html`、`ci.yml` |
| **B** | 上线准入整改条目 | B-2…B-5 | `tools/package.js`、`tests/manifest.test.js`、`tests/mutation-check.js` |
| **C** | 并发 / 契约（存储与所有权）整改条目 | C-1…C-3 | `settings.js`、`background.js` |
| **G** | 门禁与文档一致性自检编号（G1 = 文档声明数自检） | G1…G6 | `tests/*.test.js`、`popup.js`、`background.js` |
| **L** | 审计「低」级问题（含 `L-05` 与 `L-5` 两种写法并存） | L-01…L-12、L-1…L-8 | 全仓 |
| **M** | 审计「中」级问题（**与变异编号 M1…M34 同名不同域**） | M-1…M-7 | 全仓 |
| **R** | 各轮复审缺陷编号（数字即轮次：R6/R7/R8/R9） | R6-01…R9-05 | `background.js`、`popup.js` |
| **S** | 场景 / 步骤编号（S1 存量编辑形态、S2 冷启动对账） | S1、S2、S-1、S-2 | `background.js`、`tests/*.test.js` |
| **V** | 验证 / 变异构造编号 | V-01…V-05 | `popup.js`、`tests/*.test.js` |
| **W** | 警示 / 待办编号 | W-01…W-03 | `popup.js`、`tests/popup.test.js` |

**已知的历史遗留（如实记录，不假装整洁）**：① 序号 0 填充不一致（`L-05` 与 `L-5` 并存）；② 族内序号存在跳号（如 L 族无 L-09/L-10 的 `L-1x` 标注）；③ 同一轮内不同族可能撞号。这些不影响可读性，但**新增标注请务必带来源后缀**，并优先复用既有族。

> `tests/manifest.test.js` 会解析上面那行「编号族（机械校验用，勿删）」并与全仓实际出现的族比对：新增一个族却忘了登记，CI 即变红。
