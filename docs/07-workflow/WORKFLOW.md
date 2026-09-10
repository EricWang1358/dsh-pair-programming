# 功能工作流总表

> 版本：0.14.1 ｜ 日期：2026-09-10 ｜ PROTOCOL_VERSION=8
> 配套：[FRAGILITY.md](FRAGILITY.md)（架构脆弱点）、[LIFECYCLE.md](LIFECYCLE.md)（一个任务的完整时序）、[ENVIRONMENT-AND-VERDICTS.md](ENVIRONMENT-AND-VERDICTS.md)（判决分类 / 范围语义 / 环境输入 / 凭证新鲜度）
>
> 本表按 **Epic → User Story → Sub-feature** 三层展开插件的全部功能面。
> 与代码冲突时以代码为准；本表回答的是"这条能力靠什么强制"，不是复述实现。

---

## 0. 怎么读这张表

### 0.1 列的含义

| 列 | 含义 |
|---|---|
| **Sub-feature** | 一条可以单独失效的能力 |
| **机判点** | 违反时**由工具拒绝**的位置。**空白 = 仅靠提示词，不是不变量** |
| **失败模式** | 这条能力静默失效时，看板会呈现成什么样 |
| **证据** | 代码落点，`file:line` |

### 0.2 这张表的核心判据

> **一项能力如果没有机判点，它就不是不变量，只是习惯。**

本表刻意用空白列把这件事暴露出来，而不是让读者以为凡是写下来的都被强制。八轮双臂对照的教训是：靠提示词维持的纪律，在长上下文里会安静地消失，而看板照样显示一切正常。

### 0.3 三种强制强度

| 强度 | 形态 | 例 |
|---|---|---|
| **物理** | 席位根本没有那个工具 | SPEC 无 reader/shell；非 Driver 无 write |
| **机判** | 工具在调用时计算后拒绝 | oracle 摘要漂移 = 自动 REJECT |
| **记账** | 不阻断，但落成不可否认的记录 | CE 加载账本、披露轨、残留清单 |

设计偏好按此顺序：**能物理隔离的不用机判，能机判的不用记账，能记账的不用提示词。**

---

## Epic 1｜验收先行（Oracle-first）

> **主张**：验收标准在任何实现存在之前、仅凭需求推导并封存。此后每一次判决都是一次重新执行，而不是一次表态。
>
> **为什么**：v1/v2 假设"三个角色并行互相质疑就能更少犯错"。八轮 SWE-bench 双臂对照证伪了它——正确性零分离、评审通道零拦截、一次 45 分钟死锁交出 0 字节补丁。同一模型、同一上下文、同一种读法，错误是**相关**的。独立性不是靠换个名字产生的，是靠**在实现不存在的时刻写下标准**产生的。时间上的不对称可以机械强制，角色上的不对称不能。

### US 1.1 — 让验收标准在实现出现之前被冻结

| Sub-feature | 机判点 | 失败模式 | 证据 |
|---|---|---|---|
| SPEC 席位零仓库工具 | `toolDenyListFor('spec')` 按**白名单**剥夺一切非 oracle 工具 | 若失效：oracle 会被写成"复述现有实现"，从此永远通过 | `members.js:136` |
| 工具注册表读不到时**拒绝组队** | `unenforceableSpecIsolation()` 抛错 | 若降级：隔离变成约定，看不出来 | `members.js:141` |
| 至少两种互异读法 | `forkProblems` 必填校验（`MIN_READINGS=2`） | 单一读法 = 把第一个想法当需求 | `oracle.js:42` |
| 分歧候选必填 | 同上（`MIN_DIVERGENCES=1`） | 这是收编 Challenger 的那一项 | `oracle.js:42` |
| 冻结命令**今天必须失败** | `redProblem(run)` | 已通过的 oracle 什么都没断言 | `oracle.js:74` |
| **命令必须真的能跑** | `notRunnableEvidence` → `redProblem` | 打错程序名会"失败"→ 通过 RED 检查 → 永远失败 | `command-shape.js:106` |
| **命令必须是命令不是散文** | `commandShapeError('oracle_cmd')`，在 RED 运行**之前** | 散文同样"失败"，同样封存 | `oracle.js:129` |
| 无 oracle 不得开循环 | `pair_propose` 在 `oracleFirst` 下拒绝 | | `flow.js` propose |
| 冻结预算 | `oracleForkBudget`（默认 3），超出需队长覆盖 | 实测有会话 2h16min 重复冻结同一 oracle 6+ 次 | `config.js` |
| 非门禁臂必须记原因 | `nonGatingProblems` | 未记 = 静默缩小验收面 | `oracle.js:142` |

> **本轮新增的两行是同一个洞的两半。** 冻结门禁要求命令**失败**——所以它天然奖励"跑不起来的命令"。散文失败、打错的程序名也失败，两者都能通过 RED 检查、封进任务契约，然后在此后每一次判决里稳定失败，看板读作"实现始终不达标"。形状检查抓散文，退出码/输出检查抓打错的名字，两者缺一不可。

### US 1.2 — 让"通过"是重跑出来的，不是声称出来的

| Sub-feature | 机判点 | 失败模式 | 证据 |
|---|---|---|---|
| 最终判决重算摘要 + 重跑封存命令 | `computeVerdict` | | `oracle.js:90` |
| oracle 文件被编辑 = 自动 REJECT | `digestOracleFiles` 比对，`tampered` outranks the run | 改测试让它过，是最容易的作弊 | `flow.js` verify |
| ACCEPT 必须附范围阅读 | 缺 `beyond_request` 或 `preexisting_at_risk` 即拒 | 重跑证明"被请求的行为"，对"没人请求的行为"完全失明——实测有一次逗号修复静默改写了既有 list/tuple 契约，oracle 与 18 条回归测试全绿 | `flow.js` verify |
| **checkpoint 的 verify_plan 必须可执行** | `commandShapeError`，声明时 + 执行前**双重** | 散文 → 非零退出 → **伪 REJECT** | `flow.js` propose/verify |
| 判决不可由声明缺陷制造 | 执行前拒绝的是**调用**，不产出判决 | 圈保住步骤与拒绝预算 | `flow.js` verify |

> 最后两行是 0.13.1 修复项，详见 [FRAGILITY.md#f1](FRAGILITY.md#f1--已修复判决可被声明缺陷伪造)。

### US 1.3 — 让分步交付不假装成完整验收

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| `stage="checkpoint"` 执行本圈预声明的 verify_plan | 需要冻结 oracle 才允许 checkpoint | `flow.js` verify |
| checkpoint 不计作最终 ACCEPT | 门禁要求至少一次 final ACCEPT | `gate.js` `all_accepted` |
| checkpoint 仍校验 oracle 摘要 | 摘要漂移优先于一切 | `flow.js` verify |

---

## Epic 2｜单写者纪律

> **主张**：一个 worktree 上只能有一个写调度器。
>
> **为什么**：并发写产生冲突与半提交状态；更隐蔽的是，第二个循环会让"凭证绑定的 worktree 状态"描述一个没人拥有的状态。

### US 2.1 — 只有 Driver 能改产品代码

| Sub-feature | 机判点 | 失败模式 | 证据 |
|---|---|---|---|
| 非 Driver 物理剥夺写工具 | `toolDenyListFor` | | `members.js:134` |
| 按**形状**分类而非名单 | `isWriteCapability`：编辑器/补丁/文件写/shell | 实测一个 Challenger 通过名为 `Pwsh` 的 shell 写了三个文件——名单法在没预料到的名字上**失败开放** | `members.js:152` |
| 注册表不可读 = 拒绝组队 | `unenforceableI1` | 降级即 I1 变约定 | `members.js:148` |
| 看板写守卫 | `tools/pre-execute` 拦截对状态目录的写 | 队长自己改看板 = 绕过全部门禁 | `board-guard.js` |
| 队长可变工具集另立名单 | `CAPTAIN_MUTATION_TOOLS` | 队长与成员规则不同 | `board-guard.js` |

### US 2.2 — 不产生第二个写调度器

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| CE 写车道技能在团队存活时**不供给** | `entriesFor({teamLive})` | `ce-catalog.js` |
| 状态目录读不出时**往窄了错** | `makeLaneResolver` catch → 假定团队存活 | `ce-provider.js` |
| 任何 provider 的加载都记账 | `tools/pre-execute` 监听 `skill` 工具 | `ce-watch.js` |
| 窗口内出现写车道 = 拒签任务凭证 | `writeLaneViolation` → `runGate` | `ce-ledger.js:98` |
| 团队窗口内出现 = 拒签最终回执 | 同 → `completionReadiness` | `completion.js` |
| 账本读不出 = 判失败 | fail-closed，"没看成"≠"没发生" | `gate.js` |

### US 2.3 — 角色轮换（**未实现**）

| Sub-feature | 状态 | 证据 |
|---|---|---|
| `pair_rotate` | ⛔ **整体拒绝**：能力在 spawn 时绑定，轮换会让新 Driver 缺写权、旧 Driver 留写权 | `lifecycle.js:535` |
| 缓解路径 | 拒绝文案自陈：`pair_stop` 后按目标角色重开 | 同上 |

> 这是开放项 **M2'**，不是已实现能力。它还让另一条防线**不可达**（轮换时的 toolFilter 处理永远走不到）。见 [FRAGILITY.md#f4](FRAGILITY.md#f4--角色轮换整体停用能力缺口而非缺陷)。

---

## Epic 3｜完成必须被挣得

### US 3.1 — "完成"绑定到具体证据

| Sub-feature | 机判点 | 失败模式 | 证据 |
|---|---|---|---|
| 任务完成需 `gate_pass_id` | `pair_task_update` 无凭证拒绝 | | `flow.js` task_update |
| 凭证绑定看板指纹 | `gateStateFingerprint` | 看板动了凭证就该失效 | `gate.js:23` |
| 凭证绑定 worktree | `binding.worktreeSha` | 代码动了凭证就该失效 | `gate.js` |
| 相同重放复用同一凭证 id | 幂等，不制造新凭证 | | `arbitrate.js` gate_check |
| 凭证失效可见 | `staleCredentials` 进 attention set | 不可见 = 到 stop 才炸 | `attention.js:109` |
| 门禁**亲自重放** oracle | 不信任任何关于它的声称 | | `arbitrate.js` gate_check |
| 声明的交付物必须存在且非空 | `checkDeliverables` | 绿 oracle 证明行为，不证明交付 | `gate-exec.js` |
| diff 不得超出声明文件范围 | `checkScope` | 越界改动 = 没人决定过的扩张 | `gate-exec.js` |
| 最终回执绑定卡片/覆盖率/绿构建 | `makeCompletionReceipt` | | `completion.js:57` |
| 绿构建由插件**亲自执行** | `pair_stop` 跑命令 | 粘贴文本永远不算证据 | `lifecycle.js` stop |
| **绿构建命令必须可执行** | `commandShapeError('green_build_command')` | 散文会读作"套件是红的" | `lifecycle.js` stop |
| **dodCommand 必须可执行** | `settingsValueError` | 同上，且每次门禁都错 | `settings.js` |

### US 3.2 — 让"披露"变成"处理"

> **为什么**：一次实测会话把雨渲染成白方块、水洼没有反射、基座轮廓被抹掉——每一项**都被诚实地写下来了**，然后被路由到一个没有工具、没有清单、没有验收文件的"视觉最终检查"。看板读作 9/9 和 56/56。**披露 ≠ 处理。**

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| 五类盲点自动进 open disclosures | `openDisclosures`：非门禁臂 / 为 oracle 调参 / 偏离批准方案 / 超出请求的行为 / 无 oracle 例外 | `disclosure.js` |
| ref 含 oracle 封印 | 重新冻结后旧裁决不能关掉新盲点 | `disclosure.js` |
| 未裁决的披露阻断成功停止 | `completionReadiness` | `completion.js` |
| 裁决必须声明处置 | `dispositionError`：fixed / accepted / deferred | `disclosure.js` |
| 非 fixed 必须给 durable sink + ref | board / issue / document / pr | `disclosure.js` |
| 残留进最终回执 | `makeCompletionReceipt.residuals` | `completion.js:67` |
| 历史无处置记录仅显形不阻断 | `unsunkResiduals` 进 attention set | `attention.js` |

### US 3.3 — 让目标覆盖可计算

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| 需求展开成 UC-N.AC-N 后才可编码 | `pair_start` 冻结 id | `coverage.js` |
| 每条准则必须挂到任务卡 | `missingAllocation` 阻断完成 | `coverage.js` |
| 每条准则必须有可执行 oracle 用例 | `missingOracle` 阻断完成 | `coverage.js` |
| 覆盖矩阵是进度唯一来源 | `goalCoverage` 进 pair_status | `lifecycle.js` |

---

## Epic 4｜活性与注意力

### US 4.1 — 看板永远说得出"现在谁欠什么"

| Sub-feature | 机判点 | 失败模式 | 证据 |
|---|---|---|---|
| 单一投影 AttentionSet | 五类条目按紧急度排序 | 三个 reader 各读各的会漂移 | `attention.js:138` |
| 三处同源消费 | pair_status / 看板摘要 / 停滞升级 | 曾出现"状态说 A、停止时因 B 被拒" | `lifecycle.js`/`digest.js`/`scheduler.js` |
| 单一下一步义务 | `nextObligation` | | `obligation.js` |
| 第二人称义务行 | 收件人即欠债人时说"YOU owe" | 第三人称会被读成"关于别人的状态报告"然后结束回合 | `obligation.js` |
| 背压：一任务一未决圈 | `backPressure` | 实测 28 次 propose / 35 次 green / **0 次 verify** | `obligation.js` |

### US 4.2 — 席位真的被唤醒

| Sub-feature | 机判点 | 失败模式 | 证据 |
|---|---|---|---|
| 唤醒走真实原语 `ctx.subagents.sendMessage` | 幻影 API 存在性扫描 | `followup` 是幻影 → 全部唤醒静默失败 → 被误记为"协议设计问题" | `members.js`、`host-contract.test.mjs` |
| 回执 messageId 进结果 | 落没落地有据可查 | | `members.js` |
| 退休席位拒收 | `installRetiredInboxGuard` | 跨团队僵尸 | `members.js:39` |
| 冷恢复重建墓碑 | `agent/session-start` 读持久 deny-list | 重启后僵尸复活 | `members.js:46` |
| token 截断有界续跑 | `maxTokenResumes`（默认 2） | 截断回合**正常结束**，去重键不变 → 唯一能重启它的消息被自己抑制 | `attention.js:35` |
| 预算按"欠债 + 看板版本"计 | 看板真动过才退还 | 长输出不是进展 | `attention.js:79` |
| 停滞诊断区分活着/有进展 | `stallDiagnosis` | | `stall.js` |
| 工作席位租约 | `workingLeaseMs`，长回合有新事件即续租 | | `stall.js` |
| 每次拒绝都记原因 | `lastDecline` 进升级文案 | 曾经是四个裸 `return` | `scheduler.js` |

### US 4.3 — 席位上下文不单调增长

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| 按循环重派席位 | `memberLifetime: 'cycle'` | `recycle.js` |
| 重派只带看板摘要 | `boardDigest`，预算 8000 字符 | `digest.js` |
| 摘要按优先级截断并声明 | 任务与 oracle 永远保留 | `digest.js:135` |

> 实测：一个常驻 Driver 五次唤醒消耗 **7.10M** 输入 token，同任务单代理 138k。代价从来不是 persona（约 1.1k 且前缀缓存），是**转写记录**。

---

## Epic 5｜Compound Engineering 接入

### US 5.1 — 不结对时方便用，结对时自动收窄

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| 车道随看板自动切换 | `entriesFor({teamLive})` | `ce-catalog.js` |
| 读不出状态时往窄了错 | resolver catch → 假定存活 | `ce-provider.js` |
| `get()` 绕过 TTL 缓存 | 团队在 5s 内开起来不能被服务 solo 正文 | `ce-provider.js` |
| 白名单闭集（12 + 9 + 12 = 33） | 测试断言三表求和 = 评审版本技能数 | `ce.test.mjs` |
| 升级不自动扩面 | `reviewNeeded` 标记版本/数量漂移 | `ce-probe.js` |
| rank 700 永不遮蔽本地 | 数值大 = 更弱 | `ce-catalog.js` |
| 结对期正文加归属边界 | `boundaryPreamble`，仅 pair 车道 | `ce-provider.js` |
| 描述自撰非转发 | 33 条 ≈ CE 原文 40% | `ce-catalog.js` |
| 探测只读 | 不下载、不 clone、不写 skill 根 | `ce-probe.js` |
| 指纹绑定路径+版本+commit+白名单摘要 | 任一漂移即失效 | `ce-probe.js` |

### US 5.2 — 按阶段推送（lane `full`）

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| 仅 Driver、仅 post-green 相位 | `pushTargetFor` | `ce-push.js` |
| 正文按 commit 缓存 | 每轮重派不重读 | `ce-push.js` |
| 预算 2400 字符且声明截断 | | `ce-push.js` |
| 走同一 provider | 同白名单、同边界、同账本 | `index.js` |

---

## Epic 6｜知识沉淀有门槛

### US 6.1 — 跨会话存储只装值得装的

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| 入库需反事实 | 删掉它会复发什么 | `lessons.js:66` |
| 入库需复用触发点 | 未来会话在做什么时需要它 | 同上 |
| 入库需证据 | 循环/风险/文件/命令 | 同上 |
| 可从仓库重推导者不入库 | `rederivable_from` | 同上 |
| 携带条数上限强制排序 | `overflowRefusal`，拒绝而非静默截断 | `lessons.js:114` |
| 未达标进归档不丢失 | retro.md 收全部 | `lessons.js:88` |

---

## Epic 7｜自身可验证性

> 这一 Epic 不面向用户，面向**这个插件自己**。它存在的原因是两次事故：幻影 API 让唤醒静默失败，缺 `provider` 字段让 CE 目录死了四个版本——两次都在 893 条测试全绿的情况下发生。

| Sub-feature | 机判点 | 证据 |
|---|---|---|
| 穿透真实宿主服务 | 真实 Cordis + ToolRuntime/CommandRuntime/SkillRegistry/SystemPrompt | `host-contract.test.mjs` |
| 22 个工具 schema 由宿主校验 | | 同上 |
| `/pair` 描述符由宿主校验 | 含 `input.images` | 同上 |
| CE provider 走真实 registry | 并把坏形状钉成回归 | `ce-registry.test.mjs` |
| 幻影 API 存在性扫描 | 扫 `lib/` 的 `ctx.subagents.<method>` 对宿主 `.d.ts` | `host-contract.test.mjs` |
| 会话事件守卫钉死 | 防止"顺手修好"毁掉会话恢复 | `events.test.mjs` |
| 设置字段无静默丢失 | schema ↔ entry ↔ runtime 三向交叉核对 | `settings.test.mjs` |

---

## 覆盖缺口（刻意留白）

| 面 | 状态 | 已付代价 |
|---|---|---|
| `llm` / `agents` / `subagents` **行为** | 无独立挂载，仅实跑覆盖 | 幻影 API 事故 |
| 请求**形状**（非方法存在性） | 未校验 | — |
| 浏览器卡片 ↔ 真实 web shell | vm + 手写 stub | 卡片位置问题未验证 |
| `pair_rotate` | 能力未实现（M2'） | 轮换防线不可达 |
