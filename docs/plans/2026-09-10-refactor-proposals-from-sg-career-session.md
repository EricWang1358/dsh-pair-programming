# 重构建议：来自 SG-career 双驱动实测会话（2026-09-10）

> **执行状态：已恢复开工（2026-09-10，用户指令「按顺序提 issue，然后完成修复 + PR + merge」）。** 本文仍是统一入口。A–E 的现场证据与提案一律按各自的“复核注记”口径执行；F–I 为执行与发布口径。
>
> **工单总表（GitHub `EricWang1358/dsh-pair-programming`，按优先级顺序）**：
>
> | 项 | issue | 状态 | 项 | issue | 状态 |
> |---|---|---|---|---|---|
> | A1 | #5 | ✅ 已核对并关闭（残余转 #21） | B4 | #12 | 修复中 |
> | A2 | #6 | 修复中 | B2 | #13 | 修复中 |
> | A3 | #7 | 修复中 | B6 | #14 | 修复中 |
> | B1 | #8 | 修复中 | B8 | #15 | 修复中 |
> | B7 | #9 | 修复中 | C1 | #16 | 修复中 |
> | B5 | #10 | 修复中 | C2 | #17 | 待文档批次 |
> | B3 | #11 | 修复中 | C3 | #18 | 待集成批次 |
> | D2 | #20 | ✅ 已实测并关闭（结论并入 A3） | D1 | #19 | 待真机冷恢复实测（本轮无法执行） |
>
> **核对/实测副产**：A1 的核对结论（枚举面 `ctx.tools.schemas()` 是全局视图、校验面 `restrict()` 走 `restrictableNames`）见 #5 评论，残余的 preset 平面 fail-open 登记为 #21；D2 的接线矩阵见 #20 评论，其中 `git worktree remove --force` **会穿透 junction 删除源目录内容**（实测静默、退出码 0）已升格为 A3 的硬性实现约束：种入只复制常规文件、跳过一切 link/junction。
>
> **读法**：A–E 保留原始会话的证据与提案，不能把其中的因果判断、优先级或 `[patched locally]` 当成已验证的通用结论。下方新增的“复核注记”及 F–I 为后续执行口径；行号来自现场，执行时按函数名定位。单项目观测不等于全宿主结论。
>
> **Session ledger** (the reason this list is worth reading): 1 product increment
> (~200 net lines: `public/pool.mjs` + app.js/index.html/style.css) cost **6 cycles**
> (3 with no product change), **26 card amendments**, **26 captain rulings**, **5 risks**,
> **446 KB of protocol mail**, **309 KB board**, **2 gate failures** (both pure binding
> timing), **1 scheduling deadlock/stall ×2**, **2 plugin patches**, **2 host restarts**,
> and **0 Navigator NO_GO / 0 REJECT** (5 challenger attacks).

---

## 优先级总表

| # | 项 | 类型 | 本会话代价 | 建议优先级 |
|---|---|---|---|---|
| A1 | 未注册工具名进 deny 列表 → 成员 spawn 失败 | 运行时缺陷 | 会话无法启动 | **P0** |
| A2 | `childCtx.agent` 无 inject 必抛 → dual-driver 恒不可用 | 运行时缺陷 | 放弃 2 Driver | **P0** [patched] |
| A3 | 一次性集成 worktree 只物化被跟踪文件 → 缺运行期数据 | 运行时缺陷 | 集成被硬件式拦死 | **P0** [patched] |
| B1 | final ACCEPT 之后任何板面写入都作废凭据 | 协议设计 | 2 次 gate 失败 + 3 个空 cycle | **P0** |
| B7 | "仪器失败"只有约定、没有一等公民 | 协议设计 | 1 次冻结被误拒 + 集成误判风险 | **P0** |
| B5 | 调度串行 + captain 欠步 = 死锁 | 协议设计 | 2 次 stall、~8 分钟空转 | **P1** |
| B3 | 三套不一致的 scope 语义 | 协议设计 | 探针被迫搬出仓库 | **P1** |
| B4 | scope 创建后不可扩展，而工作流需要扩展 | 协议设计 | 同上（只能靠搬走工件绕过） | **P1** |
| B2 | 披露关闭按主体任务规划额度计费 | 协议设计 | 5 轮循环才关掉一条披露 | **P1** |
| B6 | 没有"唤醒"原语 | 工具缺口 | 3 次靠"发裁决"当唤醒 | **P1** |
| B8 | 协议邮件体积 | 体验/成本 | 446 KB | **P2** |
| C1–C3 | 可观测性与文档 | 体验 | 诊断全靠读插件源码（5 次） | **P1/P2** |
| D1–D2 | 未验证项 | 待测 | — | 待测 |

---

## A. 运行时缺陷

### A1 — `tools.restrict()` 的 deny 列表含宿主未注册的工具名 ⇒ 成员 spawn 必然失败 【P0】
**复核注记（2026-09-10）**：本项目 AGENTS.md 已记录 `toolDenyListFor(role, knownTools)` 过滤及失败清理闭环，当前源码也已有该入口。禁止按历史结论再实现一次或靠解析报错串替代能力 API。待办仅是核对本次现场加载的包/版本和隔离路径的注册作用域；“A1 仍开放”尚未成立。
**症状**：`pair_start` 在 win32 宿主上抛 `ToolCallError: tools.restrict() names unknown global tools …`；Driver 先 spawn 成功（泄漏孤儿），Navigator/Challenger 组合直接失败，captain 未注册 ⇒ 后续所有 `pair_*` 报 "you do not belong to any pair-programming team"。
**根因**：`lib/runtime/members.js` 的 `NON_DRIVER_DENIED_TOOLS` 硬编码 5 个 Claude 系写工具名（`str_replace_editor/write_file/create_file/edit_file/apply_patch`）进 deny；宿主 `tools.restrict()` 对**未注册**的名字也会校验并抛错（deny 也一样）。
**建议**：把 deny 候选定义为 `['write','edit'] ∪ CLAUDE_NAMES`，再按宿主已注册工具名集合过滤（同文件 `isolatedDriverDenyList(knownTools)` 已是这个形状）。无枚举 API 时可用 `ctx.tools` 的注册表或从 restrict 报错串解析 "known global tools:" 全集。
**测试**：单测——只注册 `write/edit` 的宿主上 spawn 全部三种角色不抛；生成 deny 交集而非并集。
**状态**：**[patched locally]**

### A2 — `childCtx.agent` 在无 inject 的宿主上抛错 ⇒ dual-driver 恒不可用 【P0】
**复核注记（2026-09-10）**：工作区 `lib/runtime/isolated-members.js` 有另一会话的未提交补丁。本轮未覆盖、未纳入提交。发布前需在真实 Cordis 服务作用域下验证“策略准确应用一次”，不能只断言不抛异常，也不能外推所有宿主都不可用。
**症状**：`pair_start({drivers:2})` 抛 `cannot get property "agent" without inject`；`drivers:1` 立即成功 ⇒ 只有 isolated 路径坏。
**根因**：`lib/runtime/isolated-members.js:37` 裸读 `childCtx.agent.session`；而 `captureDelegatedPolicyOverrides(captain)` 在**任何有 approval 服务**的宿主上都返回对象（`approvalPolicy:'never'`），所以 `if (policies)` 分支**必然执行** ⇒ 该宿主上 dual-driver 从未成功过（此前 session 全在 1 Driver 下跑）。
**建议**：安全访问 + 兜底：
```js
function applyDelegatedPolicies(childCtx, policies) {
  const candidates = [];
  try { candidates.push(childCtx.agent?.session); } catch { /* not injected */ }
  try { candidates.push(childCtx.get?.('agent')?.session); } catch {}
  const session = candidates.find(Boolean);
  if (!session) return false;              // caller retries after create
  appendDelegatedPolicyOverrides(session, policies);
  return true;
}
```
并在 `ctx.agents.create(...)` 之后用 `handle.agent.session` 兜底一次（同一对象，文件下方已在用 `handle.agent.id`）。
**测试**：单测传一个**不含** `agent` 的 childCtx，断言不抛且策略最终被应用；再加一个"policies 恒真"的宿主 stub（有 approval 服务）跑双 Driver 冒烟。
**状态**：**[patched locally]**

### A3 — 一次性集成 worktree 只物化被跟踪文件 ⇒ 被忽略的运行期数据缺席 【P0】
**复核注记（2026-09-10）**：工作区 `lib/runtime/worktrees.js` 有另一会话新增的 `seedRuntimeData`，尚未审定发布。硬编码复制 `data/`、跟随 `stat` 指向的链接、静默吞错均不能直接成为通用设计。后续应采用任务/项目显式声明的验收环境输入或确定性准备命令；禁止自动复制整个 ignored 集合，防止带入密钥、真实用户数据或旧结果。失败归入环境诊断；源输入摘要、复制目标边界和候选自带文件的优先级必须可核验。环境输入变了不能继续声称验的是同一环境。
**症状**：`pair_integrate(t-1)` 抛 `INTEGRATION_ORACLE_FAILED`，oracle 打印
`PREREQ: the pool could not be read in THIS workspace … data/jobs.json could not provide one`；
即便只跟踪 jobs.json，整机命令仍会因 leg-b 的 `[INSTRUMENT] data/notes.json missing → exit 2` 触发 `INTEGRATION_REGRESSION_FAILED`（`tools/integrate.js:83` 对任何非 0 都判失败）。
**根因**：`integrateCandidate`（`lib/runtime/worktrees.js:151-158`）`git worktree add --detach` 后直接 merge + verify：worktree 只检出**被跟踪**文件，而 `data/` 被 `.gitignore` 忽略 ⇒ 合并树不是完整运行环境。
**建议**：merge 之后、`verify` 之前种入运行期数据（**复制**，绝不用 junction —— 该 worktree 之后会被 `git worktree remove --force`，junction 有被递归删除的风险）；已存在（被跟踪/已被合并）的文件不覆盖；失败静默留给 oracle 报。可选：把源路径做成 config（`integrationRuntimePaths`，默认 `['data']`）。
**测试**：fixture 仓库把 `data/jobs.json` 写进 `.gitignore`，跑一次双驱动集成应通过；再加"候选自身携带被跟踪 data 文件"的用例，断言不冲突（种入在 merge 之后是关键）。
**状态**：**[patched locally]**

---

## B. 协议机制（本会话摩擦的主产地）

### B1 — "final ACCEPT 之后的任何板面写入都作废凭据"是自伤规则 【P0】
**复核注记（2026-09-10）**：这是现场归因，尚未逐项证明“任何写入”都失效。不能直接排除所有 `closesDisclosure` 裁决，也不能无条件自动重绑；裁决可能改变接受条件。先按真实语义建立失效矩阵：纯显示/耗时/成员路由元数据不应污染产品证据，需求、公共契约、验收、相关风险和候选变化仍须复核。仅证明候选及审阅输入未变的元数据修订可走显式刷新，保留旧凭证与刷新原因。现有 RETRO 内重新验收/补 gate 能力须复用，不另造旁路。
**症状**：本会话 2 次 `GATE_STALE`，每次都需要**重开 cycle + 重出 final ACCEPT**（累计 3 个空 cycle）。触发写入包括：**对该 cycle 披露的裁决**（`d-1b044190`、`d-5772aca2` —— 而这些裁决本身是板上强制要求的）、以及**别的任务卡的 amend**。
**根因**：`protocol/gate.js:24-46` 的 `gateStateFingerprint` 把 `task`、`cycles(taskId)`、`risks(P0/P1 全局)`、`decisions(taskId)` 全部纳入；`reviewStateFingerprint` 再复制一份。于是"按板面要求做的记账动作"会否定它服务的那个判定。
**建议**（按代价排序）：
1. **指纹 diff 化**：`GATE_STALE` / `INTEGRATION_STALE` 的错误里直接给出变了哪个输入、哪个 id（现在 captain 只能读插件源码反推，本会话做了 5 次）。
2. **披露裁决不参与指纹**：披露是"必须被裁决"的记账项，把 `decision.closesDisclosure` 命中的条目从 fingerprint 里排除（或裁决后自动重绑该 cycle 的 binding）。
3. **提供显式重绑**：`pair_verify(cycle, stage='rebind')` 或在 `pair_status.gate_credentials` 里给 `refresh_hint`，让"候选未变、只有板面记账变了"这种情况不必开新 cycle。
**证据**：本会话 `gateFails=2`；`c-t-1-2-2 → c-t-1-3-3 → c-t-1-4-4 → c-t-1-5-5 → c-t-1-6-6` 中最后三个 cycle 无产品改动。
**同日两次追加实测（决定了修复的优先级）**：
- **"同候选重绑"这条路被工具关闭**：在 `c-t-4-1-1` 拿到 final ACCEPT、之后又落了一条披露裁决的情况下，重跑 `pair_verify(cycle_id=c-t-4-1-1, stage='final')` 返回 `cycle is already completed; its final verdict is immutable`。⇒ 一个已有 final verdict 的 cycle **无法**重新验证，绑定只能靠**新 cycle** 前移；被拒调用本身不留产品判决、不动板面（代价就是一次调用）。
- **"披露裁决落在 ACCEPT 之后"确实会作废绑定**（t-4 上重现）：`:beyond` 裁决之后 driver 的 `pair_gate_check(t-4)` 得到 GATE_STALE，于是开出 no-op refresh cycle `c-t-4-2-2`。⇒ 在现规则下，**每一个被接受的特性 cycle 都要再付一个 refresh cycle**（t-1 付了 3 次，t-4 正在付第 1 次）。这把上面第 2、3 条建议从"优化"升级为"记在关键路径上的税"：只要 `beyond_request` 必填（它的价值见 E 节）与"ACCEPT 后任何板面写入都作废指纹"同时成立，这笔税就不可避免。

### B7 — "仪器失败"只是约定，不是一等公民 【P0】
**复核注记（2026-09-10）**：`exit 2` 不是所有测试工具通用的“环境失败”。不能全局把 2 变成不计失败。应给每个冻结的执行契约声明退出码映射/结构化结果协议，保留普通命令非零失败的默认语义；进程创建失败、测试基础设施失败、断言失败、取消和超时分开。分类在 oracle freeze / verify / gate / integrate / stop 共用。脚本输出中出现 ENOENT 不足以证明解释器启动失败。
**症状**：(a) `notRunnableEvidence()` 把 oracle **合法**的 ENOENT 文本判成"程序起不来"，直接拒了一次 oracle 冻结（`VERIFICATION_INFRASTRUCTURE`）；(b) `tools/integrate.js:83` 对 oracle/整机命令的**任何**非 0（含 `exit 2`）都判候选失败；而团队自己的类别规则是"exit 2 = 仪器失败、不产生产品判决"。
**根因**：错误分类依赖"输出尾部短语匹配"（`protocol/command-shape.js:137`），且各工具没有统一的 `exit 2` 语义入口。
**建议**：
1. 分类器改成**形态判定**：解释器不可运行的特征是 `exit 126/127`、`ENOENT` 指向**可执行文件/解释器**、或 shell 的 `not recognized as an internal or external command`；不要把"脚本内部读文件失败"也算进来（那正是本案）。
2. 正式承认 `0/1/2` 约定并在 gate / verify / integrate **三处一致**：`2` ⇒ 不产生产品 verdict、不计失败、给出可重试提示。
3. `pair_status` 里对每个 cycle 显示其 oracle 的"退出码 → 语义"映射，避免各队各自发明。
**证据**：本会话 Navigator 首次冻结被误拒；`d-4a797289`/`d-c4a797289` 是为把该约定写进卡面而发的两条裁决；`r-3-mtvdovsk`（P2，instrument）即此。

### B5 — 调度串行 + captain 欠步 = 死锁 【P1】
**症状**：`[PAIR:STALL] … 299s without board progress`（两次）。captain 名下有一条**结构上无法完成**的义务（`pair_integrate`，因为集成环境缺数据），而新任务 `t-4`（scope 独立、就绪）**无人领取**；四个席位全 idle。
**根因**：`protocol/obligation.js:171-184` 本应对"独立 scope 的就绪任务"发 `pair_task_claim` 义务，但前沿被 captain 的义务占住时不派发 ⇒ 无成员被唤醒；而 captain 的义务又依赖"先完成 t-4"（循环）。
**建议**：
1. **并行下发**：captain 的义务与成员的 claim 义务同时出现在前沿（除非任务间判定为冲突 scope）。
2. **`pair_yield(tool)`**：captain 可显式让出（记录原因）无法执行的义务，让调度派发其它就绪工作；`pair_status` 里显示"已让出的义务"。
3. **stall 报告升级**：带 `blocking_cause`（哪个义务、被什么挡住、建议动作），而不是只报 idle。
**证据**：本会话用"发一条裁决"唤醒全队 3 次（板面写入是唯一可靠唤醒源）；`t-4` 至今 pending 未领。

### B3 — 三套不一致的 scope 语义 【P1】
**症状**：探针文件 `scratch/regression/pool-link-guard.mjs` 在**提案层**合法（`scope.declared=false` 时用 `cycle.proposal.files`）、在 guard 层也合法（`board-guard.js:137` 同前），但**集成层**被拒：`Candidate escapes declared write scope`（`integrate.js:49-51` = `task.scope.writes ∪ task.oracle.files`）。结果：为过集成，团队不得不把探针搬出仓库、塞进被排除的状态目录。
**根因**：三个位置各写一份"允许集"。
**建议**：抽出单一 `allowedWriteSet(task)`（并明确"提案声明的文件是否算数"），三处共用；`pair_status` 为每个任务打印 **effective scope**，让差异在开 cycle 之前就可见。

### B4 — scope 创建后不可扩展，而工作流需要扩展 【P1】
**症状**：`pair_task_amend` **没有** `write_paths` 参数（实测返回 `needs at least one replacement field`）；且有 cycle 之后卡面不可变。于是"实现中发现需要一个回归腿/探针"这类**正常**事件只能靠绕（搬工件、或另开任务——而另开任务在死锁下不可领）。
**建议**：(1) `pair_task_amend` 支持 `write_paths`（至少在首 cycle 之前）；(2) 或新增 `pair_task_scope(task_id, add:[...], reason)`，**显式**扩展并把该事件纳入 gate 指纹（可见而非静默）；(3) 或允许 `write_paths` 声明目录，让目录内的新文件不必逐条声明。
**证据**：`integrate.js:49-51` 与 `worktrees.js:115-128`；本会话 `d-058716f2`（搬迁探针）整条裁决都是这个缺口的产物。

### B2 — 披露关闭按"主体任务的规划额度"计费 ⇒ 合规关闭不可执行 【P1】
**症状**：`pair_arbitrate(closes_disclosure=…)` 被拒 5 次，理由
`task "t-1" used 2 of 2 planning arbitrations … spec is not frozen yet`；即使把 `task_id` 改成别的任务、或干脆不传 `task_id`，仍按披露的**主体任务**计费。而板上同时把该裁决列为**必须完成**的义务 ⇒ 只能等 `driver2` 开新 cycle 让该任务豁免后才关掉。
**建议**：披露关闭不计规划额度（它是记账义务，不是争议）；若必须计费，则只统计"新增分歧"的裁定。
**证据**：本会话 `oracle:t-1:…:non-gating`、`cycle:c-t-1-2-2:deviation`、`:beyond`、`:tuned` 四条披露，全部在"该 cycle 有 final ACCEPT ⇒ 任务脱离 planning"之后才关得掉，形成 5 轮循环。

### B6 — 没有"唤醒"原语 【P1】
**复核注记（2026-09-10）**：不要据此把“写板面是唯一唤醒源”写成当前文档事实；运行时已有 scheduler kick、宿主状态事件与消息投递。先复现丢失的唤醒边。若仍需 nudge，应复用当前义务与背压，不创建裁决、不改变验收指纹；重复 nudge 不得增加重复模型回合。
**症状**：三次 stall 都靠"发一条裁决（板面写入）"把四个席位从 idle 唤醒；`pair_interrupt` 只能取消当前轮、不能唤醒。
**建议**：新增 `pair_nudge(member, reason)`（不写板面、不消耗额度），或在 `pair_interrupt(discard_queued=false)` 之后触发一次 re-kick；同时在文档里写明"板面写入是唤醒源"。

### B8 — 协议邮件体积 【P2】
**症状**：单会话 446 KB 协议邮件（driver2 149K / navigator 122K / challenger 75K / driver 75K / captain 25K），大量是同一义务的重复陈述。
**建议**：按 obligation debt key 去重；同一义务 N 分钟内不重复投递；长报告截断为"摘要 + 引用 id"（`pair_mailbox_read` 已支持分页，可在投递侧就用上）。

---

## C. 可观测性与文档

- **C1**：所有 `*_STALE` / `*_FAILED` / `BUDGET_*` 错误携带**指纹 diff**（输入名 + 变更 id）。本会话为定位这些做了 5 次源码阅读。
- **C2** 文档补齐：三套 scope 语义（B3）、披露关闭的计费规则（B2）、`exit 2` 约定（B7）、"板面写入是唯一唤醒源"（B6）、**活队跨宿主重启的恢复路径**（D1）、以及"运行期数据被忽略 ⇒ 集成检出缺它"这一类环境陷阱（A3）。
- **C3**：`pair_status` 增字段：`effective_scope(task)`、`blocking_cause`、`gate_refresh_hint`。

---

## D. 待测 / 未验证

- **D1（本会话即将实测）**：**活队跨宿主重启的冷恢复**。此前每次都只遇到"旧队 ABORTED → 新开一队"，而这次要在 `t-1 in_progress`、四个成员在册的状态下重启宿主。插件有冷恢复路径（`isolated-members.js` 的 `ctx.agents.resume`）。结果（成功/失败与症状）应回填本节并据此决定是否需要 `pair_resume_check` 之类的只读诊断工具。
  **更新**：原会话恢复与新 Captain 接管必须分别验收。新 Captain 显式接管已有本地实现和定向测试，见 F2；用户真实运行盘尚未做重启接管实测。不要把“即将实测”当作实测完成，也不要为此重建任务或重跑全部产品实现。
  **实测结果（同一会话/同一 Captain，2026-09-10 19:16–19:17，sg-career-workbench-r3）**：在 `t-1 in_progress`、四个成员在册、且 t-1 持有一张 `board_state_current=true` 的 gate 凭据时重启宿主（旧 PID 41540 → 新 PID 5652）。重启后：`pair_status` 立刻返回同一支队伍与同一板面（`c-t-1-6-6 VERIFIED`、t-1 `in_progress@driver2`）；t-1 的凭据仍然 `current=true`；driver2 自行恢复为 `working`；**紧随其后的 `pair_integrate(t-1)` 一次通过**（合并提交 `11f7221`，候选 diff 恰为 4 个 public 文件 + oracle 文件，canonical 工作树保持干净）。⇒ **原会话恢复在"运行中队伍 + 在飞任务 + 活凭据"的最难组合下可用**；"新 Captain 接管"仍按上文留作未验收。运维提醒：重启后宿主绑定 3080 需要 ~20s 以上，脚本自身的 8s 自检会误报 `WARN 3080 not listening yet`，自检窗口应放宽到 30s。
- **D2**：Windows 上 `junction` 与被跟踪文件组合的行为（`git add` 是否穿过 junction、`core.symlinks=false` 下的检出形态）。本会话靠"不跟踪运行期数据"绕开了它，但 A3 的通用修法仍需覆盖。

---

## E. 明确**不建议**改的部分（本会话证明有效）

- **冻结 oracle 先于实现**：t-1 的 oracle 在冻结时确实为红，注入池判别臂把"逐三元组 vs 按记录""NFKC 先行 vs 原始串"等读法差异全部钉死；没有它，口径链会以"自洽但错"的 1134/662 落地。
- **I1 的物理强制**：captain 的 `.gitignore` 写入被守卫当场拒绝（`refused edit … I1 gives every workspace write to the Driver alone`）——这是本会话唯一**不可绕过**的不变量，也正是它让"captain 顺手实现"没有发生。
- **`beyond_request` / `preexisting_at_risk` 必填**：正是前者产出了 r-5（"绿对绿不算证据"）这条本会话最有价值的评审。
- **封存 oracle 的重放**：leg-a 用前序会话的封存标准跑真实 HTTP，是唯一"非本队自造"的回归证据。
- **裁决/证据留痕**：26 条裁决 + 5 张风险票让这次会话的每一步都可追溯（包括错误的 FNV 常量与其根因），这是能写出本文档的前提。

---

## F. 当前实现快照与剩余收尾

### F1 — 保存点、权限与费用约束

- 仓库：`D:/A/1NUS/1Sem/dsh-better-pairprograming/dsh-pair-programming`。
- 当前分支：`fix/delivery-recovery-and-progress`；本地 HEAD：`5233242`，内容为面板 HTTP 405 修复。本轮未新增 commit、push、tag、PR 或 GitHub Release。
- 最后一次远端只读查询：`origin/main=43b0c78`；GitHub 最新 Release 为 `v0.14.0`；当前分支没有开放 PR。以上仅是查询时快照，恢复发布时重新读取。
- `package.json` 当前仍为 `0.14.0`。本批修复拟发布 `v0.14.1`，v0.15.0 留给专家工作流；版本号尚未修改，发布前排除冲突并检查兼容性。
- 实际本机 SDK 为 **DSH 0.1.5-rc.1 / Cordis 4.0.2**，不能报告已验证最终 0.1.5。宿主地址 `http://127.0.0.1:3080/`，web profile 链接本地插件；未重启正在工作的宿主。
- 用户要求正确率优先，接受耗时，但昂贵完整 DSH 模型测试只在必要最终验收使用。默认本地确定性测试、原生 SDK 边界测试、必要浏览器验收；不启动全员对照跑，不用大量临时子代理进行自身开发。
- 用户此前授权 PR + merge + GitHub Release；**最新指令暂停开工与发布**。恢复执行前等待用户重新启动任务，不因旧授权自动继续。

### F2 — 已实现但不能重复宣称“已上线”的项目

| 项目 | 当前状态/代码入口 | 仍须完成 |
|---|---|---|
| 面板无法读取运行盘 | `5233242` 已本地提交；`panel-rpc.js` 走认证的共享 `/api` Fetch carrier；客户端仅 404/405 才回退旧通道 | 发布候选验证；用户空闲时重启加载后只读核实实际面板，不重建产品团队 |
| DSH 新附件输入 | 未提交；`command.js` 增 `attachments:true`，保留旧 images；原生附件存储测试 | 同发布候选验收；SDK 版本声明保持准确 |
| 跨运行验收目录隔离 | 未提交；`state/artifacts.js`、`oracle-exec.js`、`oracle.js`；新 team 持久化 UUID 命名空间 | 检查冻结/导入/双 Driver 集成路径均使用返回的根目录；旧看板不迁移冻结文件 |
| 临时文件布局 | 新 persona 指引 `.pair-work/<UUID>/`；`pair_status` 返回 `scratch_root` | 这是路径约定，不是文件系统沙箱。临时文件仍遵循 I1、scope 和集成规则；结合 B3/B4 统一处理 |
| 无关项目继承污染 | 新 start 默认不读工作区 lessons；显式 `inherit_lessons:true` 才继承 | 检查所有启动入口文案；接管保留原板 lessons |
| 新对话接管旧进度 | 未提交；新增 `tools/resume.js`，复用 `pair_start(resume_team,resume_from_captain)`，只读发现 `pair_status(list_runs:true)` | 原生冷恢复最终验收、失败/取消/并发边界检查；见 F3 |
| 面板接管历史 | `panel-rpc.js` 允许旧 Captain 从 handoffs 历史继续只读查看同一看板 | 新/旧对话显示同一进度、无关对话不串板；历史查看不恢复工具操作权 |
| 活跃团队冲突 | start/resume 共享 workspace-start 锁，拒绝另一已加载团队占用同一 checkout | 仅进程内锁，不能宣称跨宿主安全；旧会话重新加载与新团队的竞争仍需单独检查 |
| 目录交付物、RETRO 补凭证、fixed 序列化、细粒度进度、Git checkpoint 提示 | 先前修复已存在于提交历史/工作树，不重新立“从零实现”工单 | 在最终候选上验证回归，确认发布说明覆盖。ETAs 样本不足显示未知，不虚构精确时间 |
| 稳定成员生命周期与双 Driver 回收隔离 | 已有 session 默认、bounded seat history、双 Driver 不自动逐 cycle 回收 | v0.15.0 继承此约束，禁止通过专家角色退回频繁重建 |

命名空间的实际布局是 `.pair-oracles/<UUID>/<task-id>/` 与 `.pair-work/<UUID>/`。看板原本就按 `<stateDir>/<teamId>/` 存放，不应把共享父目录误判为所有团队共用一张看板。旧无 UUID 的看板沿用 `.pair-oracles/<task-id>/`，其历史路径冲突风险不能通过搬文件偷偷修复。无关项目并行必须使用不同业务工作目录；同一团队双 Driver 用保留的独立 worktree。

### F3 — 接管验收矩阵（复用已有实现，不新建平行恢复机制）

新 Captain 先发现并核对 goal、team_id、captain，再显式接管；不能因同 cwd 就认定同一项目。接管保留 team ID、需求/设计、任务/attempt ID、风险/裁决、冻结 oracle、验收历史、phase、双 Driver slot 与 integration 状态。只重新建立有效席位，未完成 cycle 的 owner 更新到新成员，已 ACCEPT/checkpoint 的 owner 与签名不改。

| 场景 | 已有证据 | 剩余检查 / 期望 |
|---|---|---|
| 新对话只查历史 | handler 测试通过 | 不创建成员、不触发模型；损坏看板给可读诊断，不吞掉整个列表 |
| 旧 Captain/成员仍 loaded（含 idle） | 拒绝 `PAIR_RESUME_LIVE` 已测 | 保持冷接管边界，不能以“暂时 idle”推断无排队工作 |
| 旧 Captain 身份不匹配 | `PAIR_RESUME_STALE` 已测 | 不覆盖另一交接；精确 ID 非 name 模糊匹配 |
| 中途成员 spawn 失败 | 原 team.json 字节不变，新孤儿被清理已测 | 增补取消、写盘失败、失败清理本身失败的诊断；不能误退休旧成员 |
| 两个接管请求竞争 | 只成功一次、只建一套新成员已测 | 多宿主不是此锁的保证；重启中断的半创建窗口需写明确恢复策略 |
| 双 Driver | 原生隔离创建 helper 保持两个 cwd、slot 状态已测 | 真实 worktree 分支/HEAD、路由与未集成候选保留；缺树明确拒绝，不自动重建覆盖 |
| 有 pending integration | 创建前拒绝已测 | 提供现有集成恢复入口，不清空事务来“解锁” |
| 已完成卡与 RETRO | 状态、gate 输入指纹不因换 Captain 改变已测 | 继续正常凭证新鲜度检查；不把接管当放行 |
| 旧/新 Captain 面板 | 进度一致、无关会话不可见已测 | 用户实际宿主重启后只读验证；不宣称已在线确认 |
| 旧会话自然 resume | 当前调度按落盘 Captain/member ID 查询 | 核对旧 generation 不重获权；旧队休眠时启动无关新队，随后旧会话加载的竞争不得遗漏 |
| 遗留团队 ID / 目录 | 校验改为安全单路径段，避免重复 sanitize 长 ID | 增补长名称、中文、路径穿越测试；不改已有文件路径 |

当 source 未加载时，现有接管在持锁期间 spawn 并原子写板。仍需分析宿主突然退出、旧会话恰好在最后一次检查后加载的窗口；本地回归不能代替这类时序论证。若需要增加持久化 handoff intent/epoch，只做最小补偿协议，不动产品凭证来记录纯运行时事务。

### F4 — 已跑验证与发布候选缺口

- 第一组定向回归：**354 passed / 0 failed**，含 lifecycle、oracle、protocol、host-contract、lifecycle-output、panel、isolated-members。
- 最后一组定向回归：**418 passed / 0 failed**，10 suites：lifecycle 81、oracle 82、protocol 85、lifecycle-output 19、panel 27、board-guard 29、parallel-tasks 6、delivery 56、command 17、settings-host 16。
- `verify-runtime-imports` 通过；`verify-startup` 在原生 SDK 上通过，注册 26 个工具与 `/pair`；`git diff --check` 通过。
- 中途一次测试命令错写不存在的 `recycle.test.mjs`，runner 因 module-not-found 中止；后来改为实际 delivery 套件并得到上面的 418 全绿。不可把该中止当代码故障或当一次完整成功。
- 所有上述检查 **未调用模型、未操作用户生产看板**。它们验证的是当时工作树，**不是最终发布 commit 的完整验证**。
- 最终候选须在干净、隔离检出中执行项目 `npm run verify`（本地确定性完整链路，不是完整模型团队）。变更后只重跑受影响项，发布前做一次完整候选验证。不要默认用用户活跃会话当测试环境。

### F5 — 未提交工作与其他会话补丁的归属

本轮自己的待保存文件包括：`lib/state/artifacts.js`、`lib/tools/resume.js`、lifecycle/oracle/personas/board-guard/panel-rpc、对应 lifecycle/oracle/protocol/panel 输出测试、README 双语、CHANGELOG；另有先前本轮的 DSH 附件兼容 `command.js`、package cohort、command/events/host-contract 测试及 `docs/diagnostics/2026-09-10-dsh-0.1.5-compatibility.md`。

`lib/runtime/isolated-members.js`（A2）与 `lib/runtime/worktrees.js`（A3）有**另一会话的工作中补丁**。不得 `git add .` 扫入，也不得 reset/覆盖。恢复时重新读 diff、确认归属；如要完成 A2/A3，一并审查其最终设计与真实 SDK/环境测试后显式纳入，否则发布说明精确列出延期项。不要用带这些补丁的工作树全绿去证明不含补丁的 release commit 全绿。

---

## G. 统一执行顺序（恢复任务后）

| 顺序 | 工作包 | 关联原单 | 完成标准 |
|---|---|---|---|
| G1 / P0 | 核实发布候选边界；完成 DSH 作用域与运行盘兼容修复 | A1/A2、F2 面板 | 当前实际 SDK 下原生服务注册、权限策略准确、面板认证/读取/卸载可复现；不复诊已结案旧工具名问题 |
| G2 / P0 | 验收环境与结果分类统一 | A3/B7 | 环境输入显式声明、可追溯且不覆盖候选；基础设施错误不伪造产品 verdict；普通非零默认仍失败 |
| G3 / P0 | 有边界的凭证刷新 | B1/B2、C1 | 相关语义变化才失效、错误列出 changed inputs；闭披露不耗新增规划争议额度；有证据的刷新不要求空 cycle |
| G4 / P1 | 统一 scope + 安全扩展 + 独立工作继续推进 | B3/B4/B5/B6 | propose/guard/integrate 共用允许集；扩展先检查双 Driver 冲突并提升修订号；被挡的集成不阻塞不相关就绪卡；nudge 幂等且受背压 |
| G5 / P1 | 运行隔离与冷接管闭环 | F2/F3、D1 | 上述矩阵通过；旧凭证/候选完整，失败不丢板，旧会话不复活越权；真实宿主只做一次必要冷恢复验收 |
| G6 / P1-P2 | 状态可读性与邮件减量 | B8/C1-C3 | 状态显示 effective scope、blocking cause、refresh hint；义务按修订/席位 generation 去重，长报告摘要+引用，停止重复唤醒 |
| G7 | 干净候选验证与 GitHub 发布 | F4、H | 精确 commit 验证、PR 合并、Release 与 tag 指向同一已验证提交，公布剩余限制 |
| G8 | v0.15.0 专家工作流 | I | 先做路由/上下文/契约地基，保持双 Driver 兼容与现有开关；不把未测的模型分工包装成能力排名 |

G1–G6 可按真实依赖并行开发，但不能以“专家工作流稍后会解决”为由把当前协议死结下放给模型。遇到新需求先登记观察、重要性与用户价值，更新 backlog 优先级，再选择最小垂直增量；不为贯彻 agile 无限扩大发布范围。安全、误放行、无法收尾优先于视觉打磨及专家数量。

---

## H. GitHub 发布清单（当前暂停）

1. 重新核对分支、远端 main、开放 PR、最新 tag/Release 与全部 diff。保留用户其他会话改动；确定 G1–G6 哪些是本次必修、哪些有明确限制与延期，不把局部补丁说成通用修复。
2. 选定版本（暂拟 `v0.14.1`，最终以实际兼容性和远端为准），更新 package / CHANGELOG / 文档一致性。v0.15.0 规划可随文档提交，不能把未实现能力写进当前发布功能。
3. 显式文件列表提交，创建干净候选检出；验证其 exact HEAD，构建客户端及发布包，运行 `npm run verify`。包中须包含新增 runtime 模块，不能依赖仅本地存在的文件。
4. 原生 DSH 低费用验收：只验证必要的路由/工具继续执行/恢复边界，复用用户已说明的 Muse 路由信息，准确核实宿主实际 provider/model。配置 resolve 不等于模型调用成功。无新增预算时保留为限制，不偷跑多模型对照。
5. 重新检查 PR 及远端状态，push 功能分支，开 PR；审阅最终 diff、检查/评论与合并条件。用户原本允许 PR + merge，但最新暂停指令解除前不执行。不得强推、不为发布丢弃未完成改动。
6. PR 合并后验证 merge SHA 与已测试候选树一致，再创建 tag/GitHub Release；如果 merge 引入内容变化，重新跑受影响验证。Release 说明列出 SDK 实测为 rc.1、冷接管边界、目录迁移策略、双 Driver 实验性与未做的付费实测。
7. 反查远端 tag、Release、main 指向与 URL，再报告发布完成。**GitHub Release 不等于 npm 已发布**；当前请求仅 GitHub，不擅自 npm publish。

本轮 GitHub 只读查询在沙箱内因代理 `127.0.0.1:9` 被拒，使用授权的沙箱外调用后成功；这是环境边界，勿再当 GitHub 登录失效重复排查。未发生任何外部写操作。

---

## I. v0.15.0：按需专家、可配置路由与可验证交接

### I1 — 产品目标与非目标

用户附件是**设计提案**，不是模型排名或已验证能力。目标是在最终正确率不下降的前提下，通过更好的产品/架构分工减少 Driver 碰壁、返工和无效上下文；不能以讨论轮数、意见数量或测试数量评价成功。

保留 solo 与现有 light/full；新增可选 specialist 工作流。薄需求/架构基线之后按垂直增量推进，普通实现问题直接由 Driver + 独立验收闭环解决。Analyst/Architect 只在对应问题出现时被唤醒。代码控制流程和版本，模型判断内容，Captain 做统筹与有审计的争议裁定，不能凭口头完成越过 Gate。

非目标：通用 Agent 平台、默认强制四模型开会、更多生产写作者、自动路由学习、未经声明的费用升级、重新造 Kanban、用 fresh context 名义每轮重建专家。

### I2 — 角色与模型分离

| 职责 | 附件的初始候选路由标签（未验证） | 产物与权限边界 |
|---|---|---|
| Analyst / 产品协调 | Qwen 3.8 Flash | 原始需求→UC/业务规则/非目标/AC 草案；标出用户事实与假设，发现新需求按价值和风险排序；不能擅自扩大目标或放行 |
| Architect / 技术负责人 | GLM 5.3 Flash | 模块边界、公共契约、状态/不变量、ADR、依赖和任务草案；不直接改生产代码、不改产品需求 |
| Driver / 实现 | DeepSeek V4.1-Flash | 任务所有权下的实现、开发者测试、调试；保有内部实现选择权；公共契约变化提交变更请求 |
| Oracle Author / SPEC | Muse Spark 1.3 | 实现前从原始需求与已批准公共契约生成独立验收，冻结后不可由 Driver 修改 |
| Reviewer | Muse Spark 1.3 | 冻结后查候选与反例；区分可复现缺陷、未证风险和非阻塞建议；无生产写权 |

同一模型可承担 SPEC 和 Reviewer，但同任务的两个上下文必须分离。角色名称不等于常驻会话数。候选品牌仅配置示例，实际保存宿主注册的 provider/model/reasoningEffort；此前记录的 Muse 完整路由为 `opencode-go-muse/muse-spark-1.3-contributor`，恢复时核实实际配置，不把显示名等同于路由或声称其他模型可用。

### I3 — 路由与生命周期：先修接线，避免悄悄改变费用

已读 `runtime/members.js:seatModelRequest`：当前仅 Navigator/SPEC 使用专用覆盖，其他角色返回 `{}`；`memberModel` 声明是否真的贯穿创建/回收/恢复需补回归确认。不要把配置存在当成路由生效。

拟议优先级：明确批准的任务覆盖 → 角色配置 → 兼容旧 Navigator 配置 → 宿主继承。旧 `memberModel` 的迁移必须显式展示，不能让过去未生效字段突然开始收费。统一的 route selection 应被初始创建、回收、配额恢复、Captain 接管及双 Driver 两席共同调用；回退状态按 team/seat 存储，不能使用全局状态污染其他团队。

拟议配置：`workflowPreset: specialist`、`roleRoutes`（analyst/architect/driver/oracleAuthor/reviewer）、`roleLifetimes`。Driver 默认 session，专家按需复用可兼容的受限上下文；SPEC 与 Reviewer 不混用。附件中 task 生命周期只是初稿，**不得覆盖用户减少缓存未命中的约束**：用角色、契约修订和上下文暴露集合判断是否必须换代，同一有效版本不重复创建。设置、persona、运行时从同一策略投影，复核“默认 session，但文案仍称每 accepted cycle 重建”的漂移。

路由恢复与专家升级分别记录：前者是服务暂不可用，后者是职责上需要补需求/设计。若 Reviewer 回退为 Driver 同模型，记录实际来源与异构性丢失，按显式策略允许或暂停，不能继续显示原模型验收。配置解析测试不收费；一次工具调用及结果返回后继续执行的真实能力 smoke 有费用，须单独预算。

### I4 — 规划与版本化产物，不新增第二张真相表

可选 `pair_plan(goal)` 产生需求/设计/任务草案、未决问题和批准状态；`pair_start(plan_id)` 只导入有效已批准快照。现有 `pair_start(use_cases=...)` 仍可直接用。不能在已经冻结 UC 的 start 之后再让 Analyst 无约束重写“正式需求”。

规划产物拟议字段：`artifact_id/type`、`revision`、`source_request_refs`、`base_commit`（非 Git 时明确替代基线摘要）、`author_role/route`、`supersedes`、`approval_state`、`affected_task_ids`。继续投影到现有 design、UC/联合 AC、依赖与 gate 指纹；Markdown/Activity Diagram 只是展示，不维护另一份漂移真相。

批准层次明确：用户决定目标/范围及不可逆取舍；Captain 在已授权范围内批准例行设计选择；SPEC/Reviewer 不被要求“找够问题”。风险性变更需证据，普通修复无需每轮向用户确认。需求或接口更新失效相关消费者，统计/换路由不自动失效全部产品凭证。

交接 token 绑定 run namespace、contract revision、task/attempt、seat generation 与候选基线。专家提交带 idempotency key；迟到、被替换成员或过期修订结果不能覆盖现值，保留审计且给出可重试原因。复用现有 verification boundary 与接管 epoch，不能另造互不相认的 token。

### I5 — 上下文投影必须贯穿所有入口

| 层次 | 内容 | 允许的消费者 |
|---|---|---|
| 原始需求 + 公共契约 | 原文、来源→AC 映射、可观察行为、公共接口、非目标、必要环境事实 | 所有相关职责；SPEC 必须直接看到原始需求，避免只验 Analyst 漏项后的缩水规范 |
| 实现设计 | 内部模块、算法建议、状态结构 | Architect、Driver；不要自动注入 SPEC |
| 候选与执行证据 | 固定候选代码/diff/测试结果 | 冻结后 Reviewer；不能流回同任务 SPEC 制定上下文 |

统一上下文构建入口覆盖 persona、`taskDesignContext`、board digest、pair_status、邮箱、自动唤醒、重试/恢复、面板/API 与附件引用。只禁文件工具不够，必须防止候选经状态或邮件绕入 SPEC；必要公开签名和测试入口又必须可用。SPEC 若要修 oracle，必须使用受控修订流程，不能把 Reviewer 已看过候选的会话改名成“独立 SPEC”。

### I6 — 升级、敏捷发现与双 Driver 兼容

| 触发 | 接收职责 | 调度行为 |
|---|---|---|
| 普通代码错误/断言失败 | Driver | 继续当前增量，不唤醒全部专家 |
| 公共接口缺口/依赖不可实现/模块冲突 | Architect | 提交最小设计修订，标记受影响任务 |
| 需求矛盾/遗漏/新范围 | Analyst，必要时用户 | 新需求进入当前 backlog，按价值、风险、依赖排序；未批准范围不派发 |
| oracle 无法执行/期望歧义 | Oracle Author，必要时 Analyst | 区分环境修复与验收语义变更，保留原封印和追溯 |
| 配额/连接/适配器故障 | 运行时 | 有界回退/背压，记录实际路由，不制造产品失败 |

双 Driver 共享契约版本，保留各自 worktree、任务所有权、范围租约和候选凭证。设计修订若影响两席公共接口，应阻止相关新领取/集成，明确受影响集合，允许不相关任务推进；不能让两位 Driver 各自接受不同版本。专家不得成为第三个生产写者。专家唤醒按义务/修订/generation 去重，控制类更正使旧派活失效，长邮件摘要+引用，不把更多角色直接塞进同一个无限 FIFO。

### I7 — 增量实现及验收

| 增量 | 范围 | 核心验收 |
|---|---|---|
| U1 | 统一角色路由、旧配置迁移、team/seat 回退状态、生命周期投影 | 创建/恢复/回收/两 Driver 使用一致解析；故障不污染其他团队；不得静默费用变化 |
| U2 | 职责上下文与信息暴露测试 | SPEC 经文件/状态/邮箱/摘要均拿不到候选；能获得执行测试所需公共事实；Reviewer 绑定正确候选 |
| U3 | 可选规划入口、版本化产物、批准/导入 | 一个垂直需求形成可导入计划；未批准/过期/有阻塞未决项不能派发；不重建看板 |
| U4 | 按需升级、迟到拒绝、消息去重与双 Driver 协调 | 重复事件不重复开专家；旧结果不可覆盖；相关修订阻止错版本集成，不相关任务继续 |
| U5 | 面板与收益记录 | 看得到实际角色/模型/回退、当前契约修订、交接阻塞；指标含失败尝试，不虚构缓存命中或 ETA |

以上是实现单元，不要求五个同时开放的 PR，也不预设新工具数量。先完成单 Driver 专家垂直闭环，同时持续跑双 Driver 边界回归；不以新增并行模型数作为 v0.15.0 的前置条件。

必须保持：结构化 REJECT 不被 oracle 绿色抹掉；专家无生产写权限；验收绑定实际候选而非口头版本；Captain 可以处理元数据/重试/调度，不能伪造通过凭证。

### I8 — 价值验证与未决设计

少量有费用的真实任务对比 B（Driver + 独立验收）与 C（按需 Analyst/Architect + 同样的 Driver/验收），使用相同原始目标、基线、预算、验收方式。优先测最终外部测试、误放行、漏需求、有效反例、返工及总费用/耗时；计入失败与空转。记录 token/cache 数据仅在宿主实际提供时，缺失标未知。小样本只判断流程问题，不能给四个模型定排名；普通回归不跑完整 B/C。

恢复实施时先通过代码解决的未决项：产物批准/撤回状态的最小形状；与现有 task amendment/spec-fork 的唯一入口；角色受限上下文是否能由宿主原生权限保证；Experts 生命周期何时真正需要新 session；冷接管和设计修订是否共用 generation；环境输入与候选 fingerprint 如何区分；哪些 UI 信息只读显示就足够。无法从代码决定的产品取舍再逐项问用户，避免一次抛出大量配置问题。

本计划不增加论文/模型能力结论。后续若要外部研究，针对上述具体缺口查原始论文/官方 SDK，并把结论与代码验收对应，避免“多模型通常更好”式无证据论断。
