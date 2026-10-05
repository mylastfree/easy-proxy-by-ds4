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
| 7 套功能测试（727 项断言，`tests/run-all.js` 统一入口，README 数值有 G1 运行期自检守卫） | `tests/*.test.js` |
| 变异门禁（25 项：每个修复点被故意破坏后护栏必须变红；S-1 加固后任何退出路径（含信号与未捕获异常）均幂等还原源文件，并以运行前后工作区快照比对判定污染；B-3 起改写源文件前落哨兵 `.mutation-in-progress`，`tools/package.js` 见到即拒绝打包 —— 例外仅在「显式 `selfCheck` + 目标位于系统临时目录」两条件同时满足时生效，发布 CLI 永不满足） | `tests/mutation-check.js` |
| 文档一致性（断言数/变异数声明 vs 实际） | `tests/g1-consistency.js` + `tests/manifest.test.js` |
| CI（lint → 7 套测试 → 变异 → 工作区洁净核验） | `.github/workflows/ci.yml` |
