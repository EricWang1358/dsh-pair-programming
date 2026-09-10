# 判决分类、范围与环境输入

> 版本：0.14.1 ｜ 日期：2026-09-10 ｜ PROTOCOL_VERSION=8
> 配套：[WORKFLOW.md](WORKFLOW.md)（功能总表）、[LIFECYCLE.md](LIFECYCLE.md)、[FRAGILITY.md](FRAGILITY.md)
>
> 本文回答六件在 **SG-career 双驱动实测会话（2026-09-10）** 里各付过一次代价的事。
> 每件都给出**机判点**（违反时由工具拒绝的位置）与**失败模式**（静默失效时盘面长什么样）。
> 与代码冲突时以代码为准。

---

## 1. 一套 scope 语义（issue #11）

**问题**：同一个问题"这个任务能写哪些文件"曾有三份答案——提案层、写守卫、集成层各写一份。

**实测**：探针 `scratch/regression/pool-link-guard.mjs` 在提案层合法、在守卫层合法，集成层却拒绝（`Candidate escapes declared write scope`）。团队唯一出路是把探针搬出仓库——它自己的回归腿。

**现在**：`lib/protocol/scope.js` 的 `allowedWriteSet(task, cycles)` 是唯一答案，三层共用：

| 输入 | 规则 |
|---|---|
| `task.scope.writes` 非空 | 它是任务的**写包线**，胜出；提案与写入都不得越出 |
| `scope.writes` 为空 | 由该任务**全部** cycle 的 `proposal.files` 并集界定（只读最新一圈会重新制造上面那个分歧） |
| `task.oracle.files` | **永远允许**：Navigator 经 `pair_oracle_write` 写入、摘要封存，候选带上它们不该被拒 |

`scope.declared` **不是**写规则——它是并行准入标志（`claimEligibility` 用它串行化两个 Driver）。把"声明了几个数组"当成"能写哪里"正是三层分叉的成因。

- 机判点：`scope.js:88`；提案层 `proposalScopeError`、写守卫 `runtime/board-guard.js`、集成 `tools/integrate.js` 三处调用它。
- 目录声明**包含**其后代（`scratch/regression` 收 `scratch/regression/x.mjs`），匹配按路径分段而非字符串前缀。
- `pair_status` 现在直接打印每个任务的 effective scope（`lifecycle.js:381`），差异在开 cycle **之前**就可见。

## 2. 卡片 scope 的显式扩展（issue #12）

**问题**：`pair_task_amend` 没有 `write_paths`，而有 cycle 的卡片不可变。于是"实现中发现需要一个回归腿"——最普通的事——没有合法表达。

**现在**：`pair_task_amend({ task_id, write_paths, reason })` 在**首个 cycle 之前**可扩展，并且：

- 扩展落进卡片的 amend 轨迹（reason + 改了哪些字段 + 结果写集），**显式可见**；
- 扩展移动 gate 指纹（scope 属于卡片字段），因此基于旧 scope 的凭证**自动失效**，而不是悄悄继续有效；
- 与另一位 Driver 在飞 scope 重叠时**拒绝**（`SCOPE_CONFLICT`，点名是哪张卡）；
- 什么都不改的 amend 被拒（审计噪声）。

## 3. 退出码的分类学（issue #9）

**问题**：("它失败了" vs "测量失败了") 只有约定，没有一等公民。

**实测两侧**：(a) 一个**合法**的 oracle 脚本读不到自己的 fixture，打印 `ENOENT: no such file or directory`，被 `notRunnableEvidence` 判成"程序起不来"，冻结直接被拒（`VERIFICATION_INFRASTRUCTURE`）；(b) `pair_integrate` 把任何非 0 退出当作候选失败——包括团队自己规定为"仪器失败、不产生产品判决"的 `exit 2`。

**现在**：

| 类别 | 判据 |
|---|---|
| 成功 | exit 0 |
| 进程创建失败（程序根本没跑起来） | `exit === 'error'` spawn 失败；`126/127/9009`；shell 自己**点名程序**的 not recognized / not found 句子；以及"输出以引号包住程序名开头"的跨语言结构 |
| 仪器失败（跑了，测量坏了） | **由冻结的执行契约声明**：`pair_oracle({ instrument_exit_codes: [2] })`、proposal 的 verify plan、部署级 DoD/integration/green 命令。声明以外，非 0 一律仍是产品失败 |
| 断言失败 | 非 0 且未被声明为仪器失败 |
| 取消 / 超时 | 单独类别，不算任何一方的结果 |

关键设计：**`exit 2` 没有被全局重定义为"环境"**——在多数工具上 2 就是普通失败，静默重分类会丢掉真实的红。声明才是入口，且 `0` 不可声明（成功不可被重定义）。

- 机判点：`protocol/command-shape.js` 的 `notRunnableEvidence` / `classifyRun` / `instrumentFailure` / `exitSemantics`；分类只在一个地方做，freeze / verify / gate / integrate / stop 五条路径共用（`tools/oracle-exec.js:166`、`arbitrate.js:320`、`integrate.js`、`gate-exec.js`）。
- `pair_status` 打印每个 oracle 的"退出码 → 语义"映射（`lifecycle.js:382`），团队不必再各自发明约定。
- 仪器失败**不产生产品判决、不计失败计数、给可重试提示**。

## 4. 凭证新鲜度的失效矩阵（issue #8、#16）

**问题**："final ACCEPT 之后任何板面写入都作废凭据"是自伤规则。

**实测**：一次会话 2 次 `GATE_STALE`，每次都要重开 cycle + 重出 final ACCEPT（3 个不改变任何产品字节的 cycle）。触发写入包括**板上强制要求的披露裁决**（`d-1b044190`、`d-5772aca2`）与**别的卡片**的 amend。

**现在**：指纹是**矩阵**而非"板面动过"：

| 输入 | 是否移动指纹 |
|---|---|
| 卡片的需求/验收/交付物字段 | **是** |
| 公共契约（`taskDesignContext`：本卡持有的 UC 标准 + 已冻结的用例设计） | **是** |
| 新 cycle、候选变化 | **是** |
| 任何 P0/P1 风险（风险登记表**无任务归属**，别的卡上发现的阻塞同样是本卡的阻塞输入） | **是** |
| 只为关闭已声明披露而写的裁决（bookkeeping） | **否** |
| 时间戳、成员活动、live status、attempt 身份、凭证自身 | **否**（本来就不在） |

**诊断**：`GATE_STALE` / `INTEGRATION_STALE` 现在给出**逐项 diff 与 id**（`decisions: added d-feeaee89`），而不是让机长读插件源码反推——实测那次为了定位做了 5 次源码阅读。

- 机判点：`protocol/gate.js` 的 `gateStatePayload` / `gateStateFingerprint` / `gateStateBreakdown` / `gateBindingDiff`（`gate.js:110/125/197`）；`flow.js` 的 `pair_task_update` 与 `arbitrate.js` 的 `pair_gate_check` 都打印 diff。
- 兼容性：只带旧记录的板面**逐字节**产生与 0.14.0 相同的摘要（有 golden 断言），升级不会作废任何在用凭证。
- 已知边界（如实记录）：风险的**状态移动**（如 P0 被关闭）同样会移动指纹。指纹在 8 个模块里按**相等**比较，"新增阻塞使失效、关闭阻塞不使失效"是一个**方向性绑定**而非指纹，需要与尚不存在的消费方一起设计。这不是遗漏，是边界。

## 5. 披露关闭的计费规则（issue #13）

**问题**：`pair_arbitrate(closes_disclosure=…)` 按**披露主体任务**的规划仲裁额度计费，而板面又强制要求这条裁决——等于让板面挡住它自己要求的文书。

**实测**：连续 5 次被拒（`task "t-1" used 2 of 2 planning arbitrations`），只能等另一位 Driver 开新 cycle 让该任务脱离 planning。

**现在**：裁决分两种计费，记录里写明是哪一种（`pair_status` 的残留清单打印它）：

| 计费 | 判据 | 后果 |
|---|---|---|
| `bookkeeping` | 只为关闭一条**已声明**披露而写 | 不被拒、不计入任何任务额度 |
| `dispute` | 还裁决了别的事（点名了另一张卡，或机长显式声明 `new_dispute`） | 照旧计入该任务额度 |
| `unspecified` | 规则出现之前写的旧记录 | **仍然计数**——说不清自己是什么的记录，不能被当成免费 |

- 机判点：`protocol/disclosure.js` 的 `rulingBilling` / `isBookkeepingRuling`；拒绝点在 `tools/arbitrate.js:148`，计数器在 `protocol/machine.js:247`（同一个谓词，计数与拒绝不可能再分歧）。

## 6. 唤醒边与环境输入（issue #14、#7）

### 6.1 丢失的唤醒边（B6）

**结论口径**：**不要**把"写板面是唯一唤醒源"当事实——运行时早就有投递唤醒、idle 边沿、心跳三条路。真正坏的是**丢边**：

`coalesceDelivery` 在"同一席位的上一跳还在飞"时返回 `{busy:true}` 并**丢弃**第二次请求，而三个调用方都丢弃了返回值。净效应：一个 idle 席位、信箱 `pending=1`，没有任何东西再去读盘——这就是 M16' 的机制。

**现在**：唤醒请求**延迟到该跳结束时重跑**（`coalesceWake`，`mail-delivery.js:164`；一次到达一次重跑，永不排队），重跑读**新鲜盘面**。因此：重复 nudge 在同一盘面修订下**只产生一个模型回合**；唤醒不写板面、不产生裁决、不消耗额度、不移动 gate 指纹。

### 6.2 被阻塞的集成不该冻住全队（B5）

**实测**：机长名下有一条**结构上无法完成**的 `pair_integrate`（集成环境缺数据），而就绪的独立 scope 任务 `t-4` 无人可领，四个席位全 idle。

**现在**：
- 机长的义务与成员的就绪 claim **可以同时出现在前沿**（除非任务间判定为 scope 冲突）；
- `pair_yield(tool, task_id, reason)` 让机长**显式让出**一条它无法执行的义务（记录原因、幂等地拒绝重复让出、不移动被点名卡片的 gate 指纹）；让出后其它就绪工作被派发，且**卡片一动，让出即过期**，因此它不能永久隐藏义务；
- stall 报告带 `blocking_cause`：谁欠哪个调用、被什么挡住、哪张就绪卡被谁占着，以及建议动作（`obligation.js:306`、`stall.js` 的 `stallEscalation`）。`pair_status` 打印同一份判断。

**已知边界（必须一起读）**：当**在飞卡片完全没有声明 scope** 时，`runtime/parallel-tasks.js` 的 `claimEligibility` 会以"scope 冲突"否决其它一切认领。这条路径仍然可达；现在它会被 `blocking_cause` **点名**，而不是表现为"大家都 idle"。放宽它是一个决定（冻结候选后释放、或要求认领时声明 scope），不是一次机械编辑，故保持显式记录而非静默修改。

### 6.3 运行期数据不是被跟踪文件（A3）

**实测**：`pair_integrate` 在一次性 worktree 里跑 oracle 与整机命令，而 worktree 只物化**被跟踪**文件；应用把 `data/` 放进 `.gitignore` ⇒ 合并树不是完整运行环境 ⇒ oracle 报 PREREQ、整机命令报仪器失败 ⇒ **被读成候选失败**。

**现在**：`pair_start({ integration_runtime_paths: [...] })` 显式声明这一次运行需要的运行期输入（字面相对路径，经 `pathName` 校验），只有**声明的**会被复制，且发生在 merge 之后、verify 之前。

| 规则 | 理由 |
|---|---|
| 不声明 ⇒ **什么都不复制** | 扫描整个 ignored 集合会把密钥、真实用户数据、过期结果带进一个没人审过的树 |
| 合并树里已存在的路径**不覆盖** | 候选自带的被跟踪文件是"被验证的树"的一部分；种入是环境输入，不是覆盖 |
| 只复制**常规文件**，链接一律跳过 | `git worktree remove --force` **会穿透 Windows 目录 junction 删除**——实测：junction 指向的源目录被清空，退出码 0。用 copy，永不用 link |
| 声明了但源工作区没有 ⇒ **环境诊断** | 报 `INTEGRATION_ENVIRONMENT: declared runtime input(s) absent…`，而不是让读者以为代码坏了 |

- 机判点：`runtime/worktrees.js` 的 `runtimePathsOf`（:38）与 `seedRuntimeInputs`（:191），报告随集成回执落到盘面（`runtimeSeed`）。
- junction 的完整实测矩阵见 issue #20；探针脚本未进仓库，结论以本节为准。

## 7. 跨宿主重启的恢复路径（D1，未实测）

**现状**：已有实现与定向测试覆盖"新 Captain 显式接管"（`pair_start(resume_team, resume_from_captain)` + 只读发现 `pair_status(list_runs=true)`），但**真实运行盘的"活队跨宿主重启冷恢复"尚未实测**。

**口径要求**（勿混为一谈）：
1. **原会话恢复**（旧 Captain/成员自然 resume）与
2. **新 Captain 接管**（显式 adopt 已有板面）

必须**分别验收**。在真机重启并回填结果之前，任何文档、PR 或 Release 说明都不得声称冷恢复"已验证"；这是 issue #19 的验收标准，不是本批的交付项。
