# DESIGN.md — dsh-pair-programming 总体设计

> 本文回答"做什么、为什么这么做"。技术实现细节见 `02-architecture/ARCHITECTURE.md`。

> ⚠️ **v1.1 修订（关键架构决策）**：本插件**不再依赖** `@nanmicoder/dsh-agent-teams`。用户可能没装它。插件**自带独立的结对运行时**（自己的团队状态、任务图、邮箱、事件驱动调度器），直接构建在 DSH 宿主原语（`ctx.subagents` / `ctx.tools` / `ctx.systemPrompt` / `ctx.commands` / `ctx.agents` / `agent/status` 与 `agent/pre-step` 事件）之上——这些正是 agent-teams 自己使用的同一批宿主原语，属于标准 profile 的 base bundle。成熟代码（串行锁、Windows 原子写、JSONL 邮箱、attempt 能力令牌、调度器）从 agent-teams 源码复刻并适配（MIT 许可）。agent-teams 若恰好存在，仅做可选互操作（共享会话事件面板），不存在时功能完整。

> **v1.2 修订（课程理念层，协议 PROTOCOL_VERSION=2）**：把 SWE5006 Mod3 Day-1 的 Agile/XP 理念固化为协议机制——Test-First 循环（I7/RED-GREEN-REFACTOR）、用户故事+INVEST 机器校验、结构化建设性反馈（I8）、可配置 DoD 门禁、绿构建收尾、strong/ping-pong 结对风格、Spike 小时间盒、trivial 快速通道、四象限攻击面、70% 仲裁规则、RETRO keep/try 跨会话继承。详见 §12。

## 1. 问题定义

### 1.1 宿主底座（DSH）能做什么

DSH 标准 profile 的 base bundle 提供（不依赖任何第三方插件）：

- `ctx.subagents.startContinuable / followup / interrupt`：派生**可续聊子 Agent**，跨重启保持会话，支持 persona 注入与 toolFilter 工具限制；
- `ctx.tools.register(defineTool({...}))`：注册模型可调用的工具；
- `ctx.systemPrompt.section({ name, order, text })`：向全局系统提示注入使用策略；
- `ctx.commands.register({ name, handler })` + `agent/pre-step` 事件：slash 命令 + 手势边界双通道激活；
- `ctx.agents.get(id)` + `agent/status` 事件：live agent 注册表与 idle/running 状态边沿（事件驱动调度的基础）；
- `session.append(type, data)`：会话事件流（Web UI 面板的数据源）。

这些由 `dsh-base` bundle 保证存在（web/headless/sdk profile 都含），其中 `commands` 用 `ctx.inject(['commands'], ...)` 懒加载以兼容最小组合。

### 1.2 原始 Agent 模式缺什么（本插件要补的）

单 Agent 直写模式（或用户手动用 subagent）缺的是**结对编程的纪律**。缺失的正是 Agile Pair Programming 的灵魂：

| 缺失 | 后果（真实会发生） |
|---|---|
| 没有角色纪律 | 三个 Agent 都去写代码，互相覆盖，或都等别人先动 |
| 没有反馈回合强制 | Driver 一口气写完直接宣布完成，Navigator 形同虚设 |
| 没有完成门禁 | 任务标记 completed 不需要任何人确认，质量靠自觉 |
| 没有写入权约束 | 多 Agent 并发改同一文件，冲突、半提交状态 |
| 没有方案比较记录 | "为什么选 A 不选 B" 散落在消息里，无法审计 |
| 没有节奏控制 | 要么粒度太大（一次写 500 行无法审），要么粒度太小（每行都开会，token 烧穿） |

### 1.3 设计哲学

1. **协议 > 工具**：结对编程的价值在"纪律"，不在"能不能发消息"。本插件的核心资产是一套状态机 + 门禁规则 + 角色 prompt，工具只是执行手段。
2. **复刻 > 重造**：凡是 agent-teams 已验证的成熟模式（串行锁、Windows 原子写、JSONL 邮箱、attempt 能力令牌、事件驱动调度、双通道激活），从其源码复刻并适配进本插件（MIT 许可），而不是重新发明；本插件的增量是结对协议层。
3. **降级 > 报错**：任何增强能力（如文件锁、证据缓存）失效时，协议必须退化为纯 prompt 纪律继续运转，而不是瘫痪。
4. **证据 > 意见**：所有仲裁（队长选方案、Navigator 驳回）必须引用仓库证据（文件、测试输出、diff），不允许"我觉得"。

## 2. 角色模型

### 2.1 四个角色

```
用户
  │  /pair <goal>
  ▼
Captain（当前会话，队长）
  ├── Driver     —— 唯一写入者（write authority）
  ├── Navigator  —— 审阅者 + 门禁执行者（gatekeeper）
  └── Challenger —— 对抗者 + 方案探索者（red team）
```

**Captain** 不是旁观者：它是仲裁者和整合者。当 Navigator 与 Challenger 意见冲突、或 Driver 与 Navigator 僵持超过 2 个回合时，Captain 必须基于仓库证据做出裁决，并把裁决理由写入决策日志。

### 2.2 角色不变量（invariants，协议硬约束）

| # | 不变量 | 违反时的处理 |
|---|---|---|
| I1 | **单写者**：同一时刻只有 Driver 能修改工作区文件 | Navigator/Challenger 的代码建议必须以"提案文本/diff 片段"形式发给 Driver，由 Driver 落地 |
| I2 | **小步快走**：一个循环（cycle）= 一个可独立验证的小变更（默认 ≤ 1 个关注点、建议 ≤ 80 行净改动） | Driver 提案超出粒度时 Navigator 应要求拆分 |
| I3 | **先提案后动手**：Driver 每个循环必须先发 Proposal，收到 Navigator 的 GO 才能实现 | 无 GO 的实现视为无效，Navigator 可要求回滚 |
| I4 | **完成需确认**：Driver 自报完成后，必须经 Navigator 验收（ACCEPT）且 Challenger 无未解决的高风险项（P0/P1），任务才可标记 completed | 门禁由工具强制（见 §4），不靠自觉 |
| I5 | **挑战不过夜**：Challenger 的 P0（正确性/安全）风险必须在当前循环解决；P1（边界/回归）必须在任务完成前解决；P2（风格/优化）可转入 backlog | 门禁检查未解决风险清单 |
| I6 | **证据引用**：GO / NO-GO / ACCEPT / REJECT / 仲裁，都必须附至少一条证据（文件路径+行号、测试命令+结果、diff 摘要） | 缺证据的裁决无效，接收方应要求补充 |
| I7 | **测试先行（TDD，v1.2，`tddMode=enforce` 时生效）**：先落失败测试并记录 RED 证据（编译错误也算 RED），再做最小 GREEN 实现，最后在绿态下 REFACTOR | 无 RED→GREEN 证据链的已验收循环会使 `pair_gate_check` 失败；`pair_report` 被工具拒绝并引导走 pair_red/pair_green/pair_refactor |
| I8 | **反馈必须结构化（v1.2）**：NO_GO / REJECT 必须是 观察→影响→改进方向（observation/impact/way_forward）三段，且非空泛 | 消息 schema 校验（`feedbackProblems`），不合规的裁决被工具拒绝 |

### 2.3 角色人格要点（写入各成员 persona）

- **Driver**：务实、透明。每个循环输出固定格式：`意图 → 拟改文件 → 验证方式 → 不确定性`。不确定就说不确定，禁止硬撑。v1.2：TDD 模式下工作循环为 PROPOSE→RED→GREEN→REFACTOR。
- **Navigator**：挑剔但可执行。反馈必须是"可操作的下一步"，禁止空泛批评（"代码不够好"是非法反馈；"第 42 行未处理空数组，建议 …"才是）。v1.2 起该要求升格为消息 schema 硬校验（观察→影响→改进方向三段）；另带 YAGNI 透镜（拒绝今日测试不需要的投机设计）与测试象限意识（Q1/Q2 自动化进循环，Q3/Q4 转 Challenger）。
- **Challenger**：对抗性思维。默认假设当前方案会失败，任务是找到"怎么失败"。必须给出风险等级（P0/P1/P2）和触发条件。v1.2：攻击面显式覆盖探索性/可用性/性能/安全等自动化循环测不到的象限。
- **Captain**：证据驱动的裁判。裁决模板：`观察 → 证据 → 选择 → 理由 → 被否方案的可保留部分`。v1.2：PLANNING 用用户故事拆解任务（具体角色 + 真价值 + 验收标准，INVEST 机器校验兜底）；可逆决策按 70% 证据即拍板（Bezos 规则）；收尾跑绿构建检查 + pair_retro（keep/try 行动项写入 lessons.json 供下一会话继承）。

## 3. 协作协议：Pair Cycle

### 3.1 一个循环的生命周期

```
        ┌─────────────────────────────────────────────────────┐
        │                    PAIR CYCLE n                      │
        │                                                       │
 Driver │  1. PROPOSE: 意图/拟改文件/验证方式/不确定性           │
   ──►  │     ──► Navigator                                    │
        │                                                       │
 Nav.   │  2. REVIEW: GO（附证据/条件）或 NO-GO（附可执行修改）  │
   ──►  │     ──► Driver                                       │
        │        （并行）Challenger 可随时 ATTACK 当前方向       │
 Driver │  3. IMPLEMENT: 落地改动（唯一写者）                    │
   ──►  │     ──► 报告 diff 摘要 + 测试结果 + 偏差说明           │
        │                                                       │
 Nav.   │  4. VERIFY: 独立验证（跑测试/读代码/查边界）           │
   ──►  │     ACCEPT 或 REJECT（附证据）                        │
        │                                                       │
 Chall. │  5. RISK CHECK: 有无未解决 P0/P1？                    │
   ──►  │     CLEAR 或 RAISE（风险单）                          │
        │                                                       │
 Gate   │  6. GATE: ACCEPT + CLEAR → 循环关闭，进入下一循环      │
        │     否则回到对应步骤                                   │
        └─────────────────────────────────────────────────────┘
```

> **v1.2 TDD 化（`tddMode=enforce`，默认）**：步骤 3 展开为强制的三小步——
> `RED`（先写失败测试并记录失败运行证据，编译失败也算 RED）→
> `GREEN`（最小实现使其通过，记录通过证据）→
> `REFACTOR`（绿态下清理重复/命名，复跑保持绿，兼作 REPORT）。
> 循环 step 链：`PROPOSED→GO→RED→GREEN→REFACTOR→VERIFIED→RISK_CHECKED→CLOSED`。
> `coach` = 两条链（TDD 链与传统 REPORT 链）都允许，仅 prompt 推荐；`off` = 旧链。
> `trivial=true` 的任务走短链（免 RED/GREEN 拆分、免 RISK_CHECK 步）。
> 风格语义：`traditional` 稳定 Driver 定期轮换（提高 bus factor）；`strong` 想法持有者口述、Driver 只做手；`ping-pong` RED 与 GREEN 的构思归属跨循环交替（I1 单写者不变，所有权经由提案文本交接）。

### 3.2 循环粒度控制（性能与质量的平衡阀）

- **默认粒度**：一个循环解决一个关注点（如"新增校验函数"而非"完成整个接口"）。
- **自适应**：连续 3 个循环一次通过（无 NO-GO、无 REJECT、无新风险）→ 协议提示可适当放大粒度；任一循环被打回 ≥ 2 次 → 强制缩小粒度。
- **预算护栏**：每个任务默认最多 12 个循环；超过后 Captain 必须向用户汇报并请求指示（继续 / 简化需求 / 人工接管）。防止协议空转烧 token。**Spike 例外（v1.2）**：研究型任务有独立的小时间盒（默认 2 循环，`spikeMaxCycles`），其交付物是 go/no-go 决策或估算结论（门禁要求 `task.output` 记录结论），不产出生产代码。

### 3.3 消息类型词汇表（协议 DSL）

所有协议消息以 `[PAIR:<TYPE>]` 开头，便于工具解析、UI 渲染、日志检索：

| 类型 | 发送者 → 接收者 | 必填字段 |
|---|---|---|
| `PROPOSE` | Driver → Navigator | cycle_id, intent, files[], verify_plan, uncertainty, acceptance_criteria_ref?（对应故事验收条款） |
| `GO` / `NO_GO` | Navigator → Driver | cycle_id, evidence[]；NO_GO 另需 feedback{observation, impact, way_forward}（v1.2 硬校验） |
| `RED` / `GREEN` / `REFACTOR` | Driver → Navigator（v1.2，TDD 模式） | RED: test_files[], red_evidence[]（失败运行输出）；GREEN: green_evidence[]；REFACTOR: diff_summary, test_results, refactor_evidence[]? |
| `ATTACK` | Challenger → Driver+Navigator | risk_id, severity(P0/P1/P2), scenario, trigger, suggestion |
| `REPORT` | Driver → Navigator（传统/coach 模式） | cycle_id, diff_summary, test_results, deviations |
| `ACCEPT` / `REJECT` | Navigator → Driver | cycle_id, evidence[]；REJECT 另需 feedback 三段 + reason_category（invest_violation / test_first_violation / risk_hit / quality / other，喂给 RETRO 统计） |
| `RAISE` / `CLEAR` | Challenger → Captain(抄送 Nav) | risk_id 引用 |
| `ARBITRATE` | Captain → 全员 | conflict_ref, decision, evidence[], rationale |
| `GATE_PASS` / `GATE_FAIL` | 工具（自动）→ Captain | cycle_id, checklist 结果 |

## 4. 质量门禁（Gate）设计

### 4.1 门禁是工具强制的，不是 prompt 祈求的

关键设计：**任务完成状态由本插件自己的任务系统把关**（插件自含任务图，不用 agent-teams 的）。Driver 调 `pair_task_update(status=completed)` 之前，必须先通过 `pair_gate_check`；工具层直接校验——没有对应 GATE_PASS 记录的 completed 调用被拒绝。这是真正的硬门禁，不靠 prompt 自觉。

### 4.2 门禁检查清单（每个任务完成前，v1.2 起为可配置的 Definition of Done）

清单不再是写死四项，而是按 `config.dod` 启用的 DoD 条目（默认全开）：

```
[ ] all_accepted         所有循环都有对应的 ACCEPT 记录
[ ] no_blocking_risks    无 OPEN 状态的 P0/P1 风险单
[ ] verify_evidence      验证命令（测试/构建/lint）最近一次执行为通过
[ ] decisions_documented 决策日志已更新（本任务内的 ARBITRATE 均已记录理由）
[ ] test_first           (tddMode=enforce) 已验收循环都有 RED 失败证据且早于 GREEN；trivial 循环豁免
[ ] spike_outcome        (type=spike) 任务完成前必须记录 go/no-go 决策或估算结论
```

会话收尾另有**绿构建规则**（green-build，v1.2）：本轮有过被验收的改动时，`pair_stop` 必须附新鲜的全量测试通过证据（或用户显式确认后 force）。"没有人带着坏构建回家"——防止队友第二天检出红代码库。

### 4.3 门禁失败的行为

- 返回结构化的 `GATE_FAIL`，逐项列出未满足条件与修复建议；
- 任务保持 in_progress，Driver 继续工作；
- 连续 3 次 GATE_FAIL → 自动升级给 Captain 仲裁，避免死锁。

## 5. 状态机

### 5.1 会话级状态机

```
IDLE ──/pair──► FORMING ──成员就位──► PLANNING ──方案确认──► CYCLING
                                                            │   ▲
                                                            ▼   │ 下一任务
                                                       TASK_GATE ─┘
                                                            │ 全部任务完成
                                                            ▼
                                                        RETRO（复盘）──► DONE ──► 团队解散或保留
```

- **FORMING**：创建团队、按角色模板生成三个成员及其 persona。
- **PLANNING**：Challenger 主导产出 2~3 个候选方案 + 攻击面分析；Navigator 评估可验证性；Captain 裁决选定方案并拆任务（带依赖）。产出物：`plan.md` + 任务图。
- **CYCLING**：逐任务执行 Pair Cycle（§3）。
- **RETRO**：产出复盘报告（哪些循环被打回、哪些风险被漏掉、粒度是否合适），写入 `.pair-programming/<session>/retro.md`；这是插件自我改进的数据源。
- 任何阶段用户可 `/pair pause` / `/pair resume` / `/pair abort`。

### 5.2 风险单生命周期

```
OPEN ──Driver 修复+证据──► MITIGATED ──Navigator 确认──► CLOSED
  │                         ▲
  └──Captain 裁决为误报─────┘（标记 WONTFIX + 理由）
```

## 6. 性能设计

### 6.1 上下文预算（token 是最大的性能成本）

| 手段 | 说明 |
|---|---|
| **角色上下文裁剪** | Driver 的每轮注入只含：当前任务、当前循环、最近 2 个循环摘要、未解决风险；不含完整历史消息。Navigator 额外含当前 diff；Challenger 额外含方案空间 |
| **增量 diff 传递** | REPORT 只传 diff 摘要（文件+增删行数+关键 hunk），完整 diff 落盘，需要时按引用读取 |
| **邮箱即真相** | 协议消息走插件自建的 JSONL 邮箱（复刻 agent-teams 邮箱模式），成员续聊时只需重放未读消息，不重放全部历史 |
| **并行非阻塞** | Challenger 的 ATTACK 与 Navigator 的 REVIEW 并行；Driver 在等待 GO 期间可同时准备下一循环的提案草稿（预取式流水线） |

### 6.2 调度效率

- 插件自含事件驱动调度器（复刻 agent-teams scheduler）：`agent/status` idle 边沿 + 任务图变更触发一次原子认领并唤醒成员，无需队长轮询。
- 队长监控事件驱动（收到 REPORT/风险 steer 通知时才查 `pair_status`），**禁止 busy-poll**。
- 成员唤醒走 `steer`（运行中队长在最近模型步收到）+ 邮箱唤醒（空闲成员），延迟为一个模型步而非一个轮询周期。

### 6.3 冲突成本归零

单写者纪律（I1）从设计上消除了多 Agent 并发写冲突，因此**不需要**合并/重试机制——这是相对"多 Agent 自由协作"最大的性能优势。

## 7. 缓存设计（缓存命中高）

### 7.1 三层缓存

```
L1 协议状态缓存（内存 + 落盘）
   key: team_id          内容: 当前阶段、当前循环、风险单表、决策日志索引
   失效: 每次协议消息写入时同步更新（写穿）

L2 仓库证据缓存（落盘，.pair-programming/cache/）
   key: sha256(git_head + 文件相对路径 + 文件mtime)
   内容: 文件结构摘要（导出符号、导入关系、测试覆盖映射）、历史测试结果
   失效: git HEAD 变化或文件 mtime 变化 → 精确失效单条；任务结束保留，跨任务复用

L3 LLM prompt 缓存友好化（provider 端命中）
   - 每个成员的 persona 与协议规则作为系统提示**稳定前缀**，逐字不变（最大化 Anthropic/DeepSeek 等 provider 的 prompt cache 命中）
   - 变化内容（当前循环、新消息）永远追加在末尾，绝不插入到前缀中间
   - 角色模板版本化：模板变更才换前缀，会话内不换
```

### 7.2 命中率目标与度量

- L2：同一任务内重复读取同一文件的摘要，命中率应 ≥ 90%（文件未变时）。
- L3：同一循环内成员的连续轮次，前缀命中率 ≈ 100%（前缀不动）；跨循环前缀命中率 ≥ 80%（仅追加）。
- 插件在 RETRO 阶段输出缓存统计（L2 命中/未命中次数），写入 retro.md，供调优。

## 8. 功能独立性

- **独立包**：`@ericwang1358/dsh-pair-programming`（名字实现时可定），独立 `package.json`、独立 `cordis.patch.yml`、独立版本号。
- **独立状态**：`<workspace>/.pair-programming/`（自己拥有全部格式；若 agent-teams 恰好存在，两者目录平级、互不读写）。
- **零第三方插件依赖**：只依赖 DSH 宿主原语（dsh-base 提供）。不 import、不调用任何第三方插件的代码或工具。
- **可独立卸载**：`dsh plugin --profile web remove <pkg>` 后无残留影响，遗留的 `.pair-programming/` 目录只是普通文件。

## 9. 兼容性设计

### 9.1 版本兼容矩阵

| 依赖 | 要求 | 说明 |
|---|---|---|
| DSH base bundle | 标准 profile | 提供 `subagents`（continuable + persona + toolFilter）、`tools`、`systemPrompt`、`agents`、`llm.resolveCallConfig`；web/headless/sdk 均含 |
| DSH commands 服务 | 可选 | 缺失时只失去 slash 菜单，手势边界仍可用（`ctx.inject(['commands'], ...)` 懒加载） |
| 第三方插件 | 无 | 不依赖 agent-teams 或任何其他插件 |

启动时做**能力探测**：检查 `ctx.subagents` provider 是否支持 continuable + persona + toolFilter；不满足 → 明确报错并提示当前 profile 缺 base bundle（这是宿主缺陷，不可降级绕过——没有子 Agent 就没有结对）。

### 9.2 宿主面兼容

- **web / headless / sdk / acp profile 均可运行**：slash command 走 `ctx.commands.register`（web 有菜单，懒加载）；headless/SDK 无菜单时走"手势边界"（消息开头 `/pair` token 识别）。
- **不依赖特定 LLM provider**：成员模型路由快照队长当前路由（复刻 agent-teams 的 `resolveMemberLlmSelection` 语义：同路由继承 effort，改路由用目标默认）；协议不假设任何 provider 特有能力。

### 9.3 优雅降级阶梯

```
完整模式：工具门禁 + 证据缓存 + 事件面板
   │（文件系统不可写）
降级 1：无状态模式 —— 无缓存无日志，仅当次会话内存协议；门禁仍由工具强制执行（内存态）

（子 Agent 能力缺失不属于降级场景：那是宿主 profile 缺陷，直接报错并提示。）
```

每一级降级都在会话开头向用户明示当前模式及影响。

## 10. 用户未明说但必须覆盖的点（设计发掘）

1. **中途换 Driver（ping-pong pairing）**：Agile 结对有"换手机制"。协议支持 Captain 发起 `/pair rotate`：当前 Driver 交出上下文摘要（handoff note），由 Navigator 或新成员接任 Driver。handoff note 模板：当前进度 / 未解决风险 / 下一步建议 / 易错点。
2. **用户随时插话**：用户消息优先于协议流程；Captain 负责把用户意图翻译为协议动作（调整方案 / 跳过循环 / 提前收尾），并通知全员。
3. **多任务并行与依赖**：PLANNING 阶段拆出的任务图允许无依赖任务并行（如"写测试"与"写文档"），但同一文件的改动必须串行（单写者纪律的扩展：文件级所有权队列）。
4. **协议开销可视化**：RETRO 报告包含 token/时间开销估计与"协议拦截次数"（NO_GO/REJECT/ATTACK 计数），让用户判断结对模式是否值得用于此类任务。
5. **小任务快速通道**：用户可加 `--light`（或说"轻量结对"）：双人模式（Driver+Navigator，无 Challenger）、循环上限 4、跳过 RETRO。避免"改个 typo 也开三人会"。
6. **可审计性**：所有协议消息、门禁结果、决策日志落盘于 `.pair-programming/<session>/`，用户事后可完整回放"谁在哪一步做了什么决定、依据什么"。
7. **防共谋/防敷衍**：Navigator 的 ACCEPT 必须附独立验证证据（自己跑的测试/读的代码），不允许仅复述 Driver 的 REPORT；工具层检测"证据与 REPORT 文本重合度过高"时提示 Captain 抽查。
8. **失败恢复**：会话崩溃/重启后，从 `.pair-programming/` 状态恢复：成员是 continuable 的（宿主 dsh-subagent 保证，可从持久 Session 冷恢复），协议状态从 L1 落盘记录重建，未关闭循环重新进入 REVIEW 步骤。

## 11. 非目标（明确不做）

- **不做真人多人协作**（共享光标/编辑器/语音）——那是 Live Share 类插件的领域。
- **不重新发明已验证的并发/持久化模式**——从 agent-teams 源码复刻（MIT），而非另写一套未经实战的。
- **不做自动代码合并**——单写者纪律下无需合并。
- **不绑定特定语言/框架的测试工具**——验证命令由 PLANNING 阶段按仓库现状探测生成（如检测到 package.json 用 `npm test`），插件不内置语言知识。

## 12. v1.2 课程理念层：SWE5006 Mod3 Day-1 → 协议机制映射

| 课件理念（出处） | 落成的机制 | 强制层 |
|---|---|---|
| TDD「Test First / clean code that works」、编译失败也算 Red（1.6 Q8/Q9、1.7 Q6） | 不变量 I7；`pair_red`→`pair_green`→`pair_refactor` 工具步骤；REPORT 在 enforce 下被拒并引导 | 工具+门禁 |
| Red-Green-Refactor 三阶段（1.6 Q16） | TDD step 链 `GO→RED→GREEN→REFACTOR→VERIFIED` | 状态机 |
| 用户故事与 3C、禁用泛化 "As a user"、so-that 不得同义复述（1.5 Q1-Q5/Q12） | `pair_task_create` 故事字段 + `protocol/story.js` INVEST 校验（泛化角色/字面同义复述/缺验收标准直接拒绝） | 工具 |
| Spike：缺技术/领域知识时的固定小时间盒（1.5 Q9） | `type=spike` 任务：默认 2 循环预算；门禁 `spike_outcome` 要求记录 go/no-go 决策 | 工具+门禁 |
| 建设性反馈三段式：观察→影响→改进方向（1.1 Q16）；"模糊反馈非法" | 不变量 I8；NO_GO/REJECT 消息 schema `feedbackProblems` 硬校验（含空泛 wish 正则） | 消息 schema |
| Definition of Done（1.2 Q21） | 门禁清单改为可配置 `config.dod`（DEFAULT_DOD 六项） | 门禁 |
| 绿构建规则：没有人带着红构建回家（1.3 Q3） | `pair_stop` 要求新鲜全量验证证据（可 force，需用户确认） | 工具 |
| 三种结对风格 traditional/strong/ping-pong（1.4 Q10）；30 分钟轮换（1.4 Q8） | `pair_start --style` / `pair_rotate --style`；styleNote 注入 persona；ping-pong 以提案文本交接所有权、维持 I1 | prompt 语义+记录 |
| 何时不该结对（1.4 Q12） | `trivial=true` 任务走短链、免 test-first | 状态机+门禁 |
| 敏捷测试四象限：Q1/Q2 自动化进循环、Q3/Q4 专项（1.6 Q5） | Navigator verify_plan 期待 + Challenger 攻击面职责（quadrants 3/4） | prompt 语义 |
| 生产率不以 LOC 计、working software 是唯一进度指标（1.2 Q13、1.4 误区5） | `pair_status` 汇报"已验收增量数 / 已完成任务数"，不再展示行数类指标 | 工具输出 |
| 数据驱动 + Bezos 70% 规则（1.1 Q6/Q15） | Captain 仲裁职责 + `pair_arbitrate` 描述：可逆决策 70% 证据即拍板 | prompt 语义 |
| 复盘优于事后总结（1.2 Q14）；检视产品+检视过程双线（1.1 Q13） | 新工具 `pair_retro`：分类统计（no_go/reject/reasons/attacks/cache）+ keep/try 写入 `retro.md` 与 `lessons.json`，下一会话 `pair_start` 自动继承 | 工具+状态 |
| 心理安全、fail fast learn fast（1.1 Q18/Q20） | PSYCHE_SAFETY 措辞规范入 persona；措辞只批评代码不批评人 | prompt 语义 |

### 12.1 P2 Backlog（本轮未实现）

1. **每任务微复盘**：任务连续失败 N 次即触发 mini-RETRO，而非只在会话尾复盘。
2. **复盘信号回灌粒度控制器**：`stats.reasons` 分类分布作为 enlarge/shrink 的附加信号（当前仅 ACCEPT/ATTACK 计数）。
3. **truck factor / 知识传递度量**：strong 风格下的交接学习记录，量化"单点知识"消除进度。
4. **MVP 发布顺序提示**：PLANNING 建议首个可交付增量的故事子集（"够客户端到端用起来"）。
5. **探测不到测试框架时自动降 `coach`**：PLANNING 验证命令探测结果驱动模式降级并在会话开头明示（当前由 Captain 人工判断）。

### 12.2 兼容与降级说明（v1.2）

- 旧会话持久化的 cycle 无 `tddMode` 戳 → 视为 `off` 链，自然走完旧步骤（读旧写新，不炸状态）。
- `tddMode=coach` 机器上等价双链（TDD 步与传统 REPORT 都可走），差别只在 prompt 推荐语。
- 文档一致性：`03-prompts/PROMPT.md`、`04-acceptance/ACCEPTANCE.md` 中的 agent-teams 前置依赖表述系 v1.0 遗留，已按 v1.1 自含运行时 + v1.2 课程层修订。
