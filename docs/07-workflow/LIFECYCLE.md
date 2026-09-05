# 一个任务的完整时序

> 版本：0.13.2 ｜ 日期：2026-09-05
> 配套：[WORKFLOW.md](WORKFLOW.md)（按能力组织）、[FRAGILITY.md](FRAGILITY.md)（脆弱点）
>
> WORKFLOW 按**能力**组织，本文按**时间**组织：一个需求从进门到签发回执，
> 每一步谁在动、什么被写进看板、哪个门在此刻会拒绝你。

---

## 阶段 0｜激活

两条入口，语义相同：

| 入口 | 形态 | 备注 |
|---|---|---|
| `/pair <goal>` | 宿主 slash 命令 | 接受图片附件（`input.images: true`），文本在前、图片在后 |
| 自然语言手势 | `agent/pre-step` 边界 | "用结对编程完成…" |

命令处理器把原样的激活行作为普通用户消息投回会话；手势边界注入激活指令并唤醒队长。**两条路最终都落到同一句话进会话**，因为看板匹配的是那一行。

---

## 阶段 1｜PLANNING

### 1.1 `pair_start`

```
输入：goal, use_cases[], mode?, tdd_mode?, style?, name?
```

| 顺序 | 动作 | 此刻会拒绝你的门 |
|---|---|---|
| 1 | 归一化 use_cases，冻结 `UC-N` / `UC-N.AC-N` id | 需求没展开成可观察条目 → 编码无法开始 |
| 2 | 队长锁：一个队长一个活团队 | 已带队 → 拒绝 |
| 3 | team id 唯一性 | id 被占 → 拒绝 |
| 4 | 记录 worktree 基线指纹 | — |
| 5 | 载入上一会话 retro 的 keep/try | 只载入**通过入库门槛**的条目 |
| 6 | 按 mode 派席位 | 见下 |
| 7 | 团队进 heartbeat 扫描列表 | 首个 kick 前就卡住也可恢复 |

**mode 决定谁被派出来**：

| mode | 席位 | 说明 |
|---|---|---|
| `solo`（默认） | 一个短命 SPEC | 它写 oracle 然后退休；实现由调用者自己做 |
| `light` | Driver + Navigator | v3 常驻席位，仍受支持 |
| `full` | 再加 Challenger | 同上 |

> 派席位时若工具注册表读不出来，**组队直接失败**——不能退化成"发了个没约束的 deny list"。

### 1.2 `pair_task_create`

```
输入：subject, description?, story?, acceptance_refs[], deliverables[], dependencies[], type?
```

- `acceptance_refs` 必须引用 1.1 冻结的 id
- `deliverables[]` 声明这张卡**必须产出的东西**（补丁、报告、产物）——绿 oracle 证明行为，不证明交付
- `type: 'spike'` 走独立小时间盒（`spikeMaxCycles`，默认 2），且以决策而非代码收尾

### 1.3 `pair_task_amend`（可选，仅首个循环之前）

改动 story / 验收分配 / 交付物 / 依赖 / 标题 / 描述。

| 改动类别 | 后果 |
|---|---|
| 触及验收语义 | **作废已冻结的 oracle**，必须重新冻结 |
| 仅排期 / 交付物 | oracle 保留 |
| 任意 | 原子撤销进行中的 attempt，留修订轨 |

---

## 阶段 2｜SPEC-FORK（冻结验收）

### 2.1 `pair_oracle_write`（SPEC 席位写文件）

SPEC 席位此刻**只有** `pair_oracle_write` / `pair_oracle` / `pair_status`。没有 reader、没有 shell、没有搜索。

> 这不是纪律，是沙箱属性。"仅凭需求推导"如果只是指令，模型在长上下文里会忘；把工具拿走，它就忘不了。

### 2.2 `pair_oracle`（冻结）

```
输入：task_id, readings[], chosen_reading, divergence_candidates[],
      oracle_files[], oracle_cmd, non_gating[]?, non_gating_reason?
```

冻结按**这个顺序**校验，顺序本身有意义：

| 序 | 检查 | 拒绝理由 |
|---|---|---|
| 1 | `forkProblems` | 少于 2 种读法 / 无选定 / 无分歧候选 |
| 2 | **`commandShapeError(oracle_cmd)`** | 散文不是命令。**必须在跑之前**——见下方框 |
| 3 | `assertTaskOracleFiles` | 文件集非法 |
| 4 | `digestOracleFiles` | 先算摘要，后跑命令：封印描述的是**产生 RED 的那批字节** |
| 5 | 执行 `oracle_cmd` | — |
| 6 | `redProblem(run)` | exit 0 = 什么都没断言；timeout = 判决不能建立在跑不完的命令上；**not-found / spawn 失败 = 这根本不是一次结果** |
| 7 | `assessOracleReach` | 触及面警告 |
| 8 | 冻结预算 | 超 `oracleForkBudget` 需队长覆盖 |

> **为什么第 2 步和第 6 步必须都在。**
> 冻结门禁要求命令**失败**——这正是 RED 的定义。所以它天然**奖励跑不起来的命令**：
> - 散文 `1) npm test must stay green…` → 失败 → 通过 RED 检查
> - 打错的 `npn test` → 失败 → 通过 RED 检查
>
> 两者都会封进任务契约，然后在此后**每一次**判决里稳定失败，看板读作"实现始终不达标"。
> 形状检查（第 2 步）抓散文；退出码/输出检查（第 6 步）抓打错的程序名。
> 形状检查**抓不到** `npn test`——它是一条完全合法的命令行；只有运行才知道，且只能看它**怎么**失败。

冻结成功后：文件集被封在一个摘要下，**它就是本任务每个循环的 RED**。任何后续对这些文件的编辑，都会在验证时被摘要比对抓到。

---

## 阶段 3｜DEVELOPING（Pair Cycle）

一个循环的合法步进链取决于它自己**被开时盖的章**：

| 链 | 步骤 | 何时用 |
|---|---|---|
| `CHAIN_ORACLE` | PROPOSED → GO → GREEN → VERIFIED | 循环带 `oracleSha`（**优先于一切**） |
| `CHAIN_TRIVIAL` | PROPOSED → GO → IMPLEMENTED → VERIFIED → CLOSED | trivial 任务 |
| `CHAIN_TDD` | PROPOSED → GO → RED → GREEN → REFACTOR → VERIFIED → RISK_CHECKED → CLOSED | `tddMode: enforce` |
| `CHAIN_OFF` | 旧式报告链 | `tddMode: off` |

> **oracle 检查必须先于 trivial 捷径**，否则一个"trivial + 有 oracle"的循环会落到没有 GREEN 步的链上，无法前进。这是已修的搁浅点。
>
> oracle 链把 **REFACTOR 折叠进 GREEN**：八轮实测里没有一次独立 refactor 轮改动过要紧的字节，而它每轮多花一次席位唤醒。

### 3.1 `pair_task_claim`

返回 `attempt_id` 能力令牌。此后本 attempt 的每次 `pair_task_update` 都要带它——过期即拒，这让被放弃的 attempt 的迟到写入**响亮失败**而不是悄悄落地。

### 3.2 `pair_propose`

```
输入：task_id, intent, files[], verify_plan, net_lines?, why_not_split?,
      no_oracle_reason?, acceptance_criteria_ref?, uncertainty?
```

| 序 | 检查 |
|---|---|
| 1 | **`commandShapeError(verify_plan)`** — 在错误发生的地方拒绝，而不是两步之后 |
| 2 | 角色：只有 Driver 能开圈 |
| 3 | 产品 P0 阻断实现（仪器 P0 不阻断） |
| 4 | `backPressure`：一个任务同时只能有一个未决循环 |
| 5 | 循环预算 |
| 6 | 无 oracle 且非 trivial → 必须给 `no_oracle_reason`（记录并进披露轨） |
| 7 | `files[]` 声明先于触碰——门禁会拿真实 diff 对质 |

**小步快车道（R4）**：单文件且 ≤80 净行 → 直接开在 GO，跳过评审轮。
> 依据：GO 轮在五个实测样本里 **0 次 NO_GO**，样本补丁全是单文件。它对真正的大步保留（"拆开"是真反馈），在小步上只花两次席位唤醒且不区分任何东西。Navigator 没有失去权威——REJECT 仍在验证处落地，而验证现在是重跑而非意见。

### 3.3 `pair_review`（仅大步需要）

`go` / `no_go`。NO_GO 必须是结构化建设性反馈（observation → impact → way_forward），否则拒绝。

### 3.4 `pair_green`

```
输入：cycle_id, diff_summary, test_results, tuned_for_oracle?
```

`tuned_for_oracle` 是 Goodhart 那条线：**为了让 oracle 过而调的东西**在这里自陈，进披露轨。

### 3.5 `pair_verify`

两个 stage：

| stage | 跑什么 | 产出 |
|---|---|---|
| `final`（默认） | 重算封印摘要 + 重跑**封存的 oracle 命令** | ACCEPT / REJECT |
| `checkpoint` | 重算封印摘要 + 跑**本圈预声明的 verify_plan** | CHECKPOINT / REJECT |

判决计算顺序（`computeVerdict`）：

1. **摘要漂移 outranks 一切** —— oracle 文件被改，无论它现在打印什么，都不是任何东西的证据 → 自动 REJECT
2. checkpoint：先 `commandShapeError` 再执行。**形状不合法 → 抛工具错误，不产出判决**
3. 执行，按退出码判

> **第 2 条是本轮修复的核心。** 此前散文 verify_plan 会被执行 → 非零退出 → `verdict: 'reject'`。
> 那是一个**用声明缺陷制造出来的机器判决**：它计入 `stats.reject`、烧掉本圈拒绝预算、把圈退出 GO、并向 Driver 投递一份关于其代码的结构化反馈——而代码从来不是问题。
> 这个协议的全部主张是"判决是重跑不是表态"；伪 REJECT 从另一侧击穿同一主张。
> 现在拒绝的是**调用**，圈保住步骤与预算。

**ACCEPT 还需要范围阅读**：`beyond_request` + `preexisting_at_risk` 缺一不可。
> 重跑证明**被请求的行为**，对**没人请求的行为**完全失明。实测有一次逗号修复静默改写了既有 list/tuple 契约——oracle 与 18 条回归测试全绿。这个缺口不是靠再加一条 oracle 臂关掉的，是靠一个人说出他看见了什么。

**REJECT 的回退**：

| 情况 | 回退到 |
|---|---|
| 自动 GO 的圈（小步） | `GO`（它本来就没有过评审轮，回 PROPOSED 会搁浅） |
| 评审过的圈 | `PROPOSED` |

### 3.6 循环粒度信号

每次循环收尾算一次 `granularitySignal`，非 steady 时投递给队长——步子太大或太碎，是**过程**问题，不是代码问题。

---

## 阶段 4｜任务门禁

### `pair_gate_check`

按可配置 DoD 逐项检查（默认全开）：

| DoD 项 | 检查 |
|---|---|
| `all_accepted` | 每个循环都已结算，且**至少一次 final ACCEPT**（checkpoint 不算） |
| `no_blocking_risks` | 无 OPEN P0/P1 |
| `verify_evidence` | ACCEPT 必须是记录在案的**重跑**；无 oracle 时退回荣誉制并明说 |
| `decisions_documented` | 仲裁有据 |
| `test_first` | `tddMode: enforce` 时才咬 |
| `spike_outcome` | spike 必须记 go/no-go |
| `deliverables_present` | 声明的产物存在且非空 |
| `scope_declared` | 真实 diff 未触及无人声明的文件 |
| `goal_criteria_traced` | 卡上的验收 id 都有可执行 oracle 用例 |
| **CE 加载窗口** | 窗口内出现写车道技能 → 拒签；**账本读不出也判失败** |

门禁**亲自重放 oracle**（重算摘要、重跑命令），不信任任何关于它的声称。

通过后签发 `gate_pass_id`，绑定：

```
worktreeSha + gateStateSha(看板指纹) + oracleSha + gateCommand/exit/outputSha
```

**相同重放复用同一 id**（幂等）；任何实质变化让它变陈旧。

### `pair_task_update(status='completed', gate_pass_id=…)`

无凭证拒绝。凭证与卡片不匹配拒绝。

---

## 阶段 5｜披露裁决

任务终态后，每个声明过的盲点必须有人裁决。

**盲点来源（自动收集）**：

| 来源 | ref 形态 |
|---|---|
| 非门禁 oracle 臂 | `oracle:<task>:<seal>:non-gating` |
| 为 oracle 调参 | `cycle:<id>:tuned` |
| 偏离批准方案 | `cycle:<id>:deviation` |
| 超出请求的行为 | `cycle:<id>:beyond` |
| 无 oracle 例外 | `cycle:<id>:no-oracle` |

> ref 里含 oracle 封印，所以重新冻结引入的新盲点，不会被旧裁决顺手关掉。

**`pair_arbitrate(closes_disclosure=…)` 必须声明处置**：

| disposition | 额外要求 |
|---|---|
| `fixed` | 无（证据就是记录） |
| `accepted` | `sink` + `sink_ref` |
| `deferred` | `sink` + `sink_ref` |

> 实测那条裁决原文是"accept visual arm as backlog"——而那块看板**没有 backlog**。裁决读作已结，残留只活在一段转写记录里。现在没有 sink 就不许关。

---

## 阶段 6｜RETRO

### `pair_retro`

**两个去处**：

| 去处 | 收什么 | 成本 |
|---|---|---|
| `retro.md` | 全部 | 以后不花钱 |
| 跨会话存储 | 通过门槛的条目 | **每个未来会话、每个重派席位都要重读** |

入库门槛（缺一不可）：

- `counterfactual` — 删掉它会复发什么 / 要重查什么
- `reuse_trigger` — 未来会话在做什么时需要它
- `evidence[]` — 循环 / 风险 / 文件 / 命令
- 不可 `rederivable_from` 仓库现状

超出 `maxCarriedLessons`（默认 3）→ **拒绝并列出候选**，让队长排序。静默截断等于替他做了判断还不告诉他。

---

## 阶段 7｜终态

### `pair_stop(outcome='complete')`

硬门，逐条：

| 序 | 条件 |
|---|---|
| 1 | 每个任务 completed（failed/cancelled 是 abort，不是 complete） |
| 2 | 每张完成卡带**匹配且未陈旧**的凭证（对看板 + 对最终 worktree 双向） |
| 3 | 无 OPEN P0/P1 |
| 4 | 目标覆盖 100%（已分配 / 可执行 / 已完成三列） |
| 5 | 无未裁决披露 |
| 6 | CE 账本窗口干净且**可读** |
| 7 | phase 已是 RETRO |
| 8 | **插件亲自跑绿构建命令**并观察 exit 0（命令形状先校验） |

全过 → 签发 `completion_receipt`，绑定卡片、凭证、覆盖行、绿构建证据、retro 时间、**非 fixed 残留清单**。

### `pair_stop(outcome='aborted')`

记录诚实的非成功终态，**永不签发回执**。

---

## 贯穿全程的机制

| 机制 | 何时动 | 证据 |
|---|---|---|
| AttentionSet | 每次唤醒重算：阻断风险 → 陈旧凭证 → 截断席位 → 欠债 → 披露 → 无处残留 | `attention.js` |
| 事件驱动调度 | `agent/status` idle 边沿 + 任务图变更 | `scheduler.js` |
| heartbeat 兜底 | 默认 120s，只在恢复路径失败时才起作用 | `scheduler.js` |
| 停滞升级 | 一段安静只报一次，附**每个席位被拒的原因** | `stall.js` |
| 有界续跑 | token 截断的席位按"欠债+看板版本"计预算，默认 2 次 | `attention.js` |
| 席位重派 | 每个被接纳的循环后，用看板摘要重建席位 | `recycle.js` |
| 看板写守卫 | `tools/pre-execute`，任何时刻 | `board-guard.js` |
| CE 加载记账 | 任何 provider 的 `skill` 调用 | `ce-watch.js` |
