# Refactoring 课程驱动的 Backlog Delta —— v0.2.2 基线修订版

> 来源：SWE5006 课程学习材料 "05 Refactoring v2.0.pdf" 的结对复习卡（32 题：Fowler 定义 /
> TDD 循环 / smell→cure 对照表 / Movie Rental 重构阶梯 / OCP-Strategy）。
> 基线：**main@5aa3f1e（v0.2.2）**，工作树 clean，239 断言 / 8 suites。
> 本文所有行号均为 v0.2.2 工作树当场实测（本会话首轮阅读发生在树前进**之前**，旧行号已作废，
> 见 §1.3 对照表——"读过文件≠读过锚点"的又一实例）。
> 编号说明：AGENTS.md §2.1.3 已占用 **M11'**（appendPairEvent 审计整体哑火），
> 故本 delta 从 **M12'** 起编。

## 0. 一句话

课程对插件有三种用法：①为已定案的 0.3.0 机制包（M1'–M7'、攻击质量门禁）提供理论出处和落地细节；
②把 smell→cure 方法反向用于插件自身代码（dogfooding 重构包 R1–R8，全部带实锤行号）；
③ Movie Rental 案例本身就是重启后最佳的真团队 smoke + 验收练习（§5）。

## 1. 与上一稿（v0.2.1 树）的差异 —— 本次更新的原因

### 1.1 编号平移
旧稿提议的 M11'–M15' **全部重编号为 M12'–M16'**：M11' 已被 0.2.2 期的审计哑火实锤占用
（`events.js:22-29`，KNOWN_SESSION_EVENT_TYPES 不含任何 pair/* → 8+1 个审计点 debug-once-then-drop）。

### 1.2 排期修正
- 旧稿"先动手：死码清理 + published-interface + granularity 修一行" **作废**。
  0.2.3 已定案为**纯债版本**（测试债 mitigate/close/wontfix handler、shared.js wake 覆盖、
  types/index.d.ts 11↔16 漂移、M10'、M11' 修法设计、粒度税记录）——新机制一律不进 0.2.3。
- 新机制首发货全部挂 **0.3.0**（已定包：攻击质量门禁 P0/P1 必挂 AC-id/file:line + M1'–M7'），
  次发货 0.3.x。
- `pair_rotate` 后的不可达块（`lifecycle.js:350-374`，throw 在 :349）**不再按课程 Purist 口径
  "Delete the code" 单独删**——它是 M2'（动态写权 guard）要**替换**的脚手架，所有权归 M2' 工单。
  这恰好是课程 Q3 Pragmatic view 的活教材：smell 是"看一眼"的线索，看一眼之后的正解是看归属，
  不是看表格。

### 1.3 行号重锚表（旧 → 新，均为 v0.2.2 实测）
| 主张 | 旧稿引用 | v0.2.2 实测 |
|---|---|---|
| gate 零执行 TODO + 空串检查 | gate.js:66/67-75 | gate.js:66/67-75（未变；CHANGELOG "M7'-M11' unchanged" 佐证） |
| granularity 计一切 attacks | machine.js:169 | machine.js:169（未变，machine.js 现为 223 行，F3 函数在 :197-:222） |
| pair_rotate 死码 | lifecycle.js:309 throw / 310-333 | **lifecycle.js:349 throw / 350-374**（文件因 F1 pair_interrupt 前移） |
| flow.js 样板九连 | flow.js:47-52 等 | `stateRootFor` 仍在 :48/:85/:138/:190/:238/:271/:305/:346/:390 |
| report 镜像写 | flow.js:311-315 vs 355-358 | **flow.js:314 vs :358**（enforce 守卫在 :354） |
| accepted 派生查询散落 5 处 | gate.js:48/68/91, lifecycle.js:170/268 | gate.js:48/68/91, **lifecycle.js:171/308** |
| parrot 散文约束 | personas.js:156 | personas.js:156（未变） |
| green-build 荣誉制 | lifecycle.js:219-224 | **lifecycle.js:226-231** |
| F2/F3 预算（新地基） | —— | config.js:22（maxOpenRisks=15）、:23（planningMaxArbitrations=2）；risk.js:47-50；arbitrate.js:40-44；machine.js:197(namesTask)/213(planBudgetExhausted)/220(specFrozen) |

## 2. 新增机制工单 M12'–M16'（v0.2.2 重述版）

### M12'｜REFACTOR 步"行为保持"机判 ——（并入 M7' 执行器，不单列 dod 项）
- 课程依据：MQ1/Q4，重构的定义 = **外部行为不变**，唯一证明 = 自动化测试前后都绿。
- 现状证据：`pair_refactor`（flow.js:289-331）只收 `test_results` 自由文本；gate 从不复跑
  （gate.js:66 TODO）。
- 修法：随 M7' 的 dodCommand 执行器落两条派生检查——
  (a) REFACTOR 步 diff 不得触碰测试文件（git diff 路径集，evidence-cache 已有 gitHead+mtime 基建）；
  (b) 通过测试数 ≥ 本 cycle GREEN 步（防"改弱测试凑绿"）。
- 设计约束：**折进现有 `verify_evidence`/`test_first` 检查内部实现**，不新增具名 dod 项——
  ⑪ 已量化粒度税（12 check 折 7），别再给 check 清单扩员。
- 建议批次：0.3.0（与 M7' 同工单）。规模：~40 行含测试。

### M13'｜published-interface 变更自动挂 P1 风险
- 课程依据：slide[100] "不要重构已发布接口"。
- 现状证据：插件的"已发布接口"= pair_* 工具参数面（lib/tools/*）、personas 模板
  （personas.js:4-8 自述为 L3 prompt-cache 前缀契约，PROTOCOL_VERSION 在 :23）、对外文档。
  pair_propose 已收 `files[]`（flow.js:126-133），判定成本≈零。
- 修法：proposal files 命中内置常量 pattern（`lib/tools/**`、`lib/protocol/personas.js`、
  `README*.md`、`lib/types/**`）→ 自动 openRisk(P1, raisedBy='system')。
- 与 0.2.2 地基的交互（必须写进工单）：
  1. **注册表满（maxOpenRisks=15，risk.js:47-50）时自动票会被拒** → 自动挂票失败不得阻塞
     propose，降级为 retro 的 unexamined 记录（与 M6'"观测非配额"同族）；
  2. **去重**：同 pattern 已有 OPEN 票时不重复挂（否则一次大 PR 刷爆 F2 预算，挤掉人工票）；
  3. pattern 用内置常量，**不加 config 热字段**——⑨ 实测新热字段必带 settings.test fixture
     涟漪，且 types/index.d.ts 11↔16 漂移债就在 0.2.3 单上。
- 建议批次：0.3.x（第二梯队）。规模：~30 行含去重与测试。

### M14'｜攻击计量口径按 Pragmatic view 修正 ——（并入 0.3.0 攻击质量门禁，同单两款）
- 课程依据：Q3 Pragmatic——smell/攻击是线索不是缺陷；按 severity 权衡，不按存在计数。
- 现状证据：`machine.js:169` clean-cycle 判据 `(c.attacks ?? 0) === 0`——**任何**攻击（含 P2）
  挡住 enlarge 信号 → 反向激励 Challenger 憋 P2 刷存在感，恰是 M3'/M4' 要拆的动机。
- 修法：enlarge 判据只计 severity∈{P0,P1} 且 raisedBy≠system 的攻击票；P2 只进 RETRO 统计。
- 归并：0.3.0 已定"攻击质量门禁（P0/P1 必挂 AC-id/file:line）"管**提出侧**，本款管**计量侧**，
  同一张票两个 clause，别开两张。
- 建议批次：0.3.0。规模：<15 行含测试。

### M15'｜ACCEPT 独立性机判（"复述报告"从散文升为工具边界）
- 课程依据：Duplicate Code——"最 pervasive and pungent 的味"移植到证据文本：复述 = 证据重复。
- 现状证据：约束只在散文（personas.js:154/156 "Do NOT merely restate / parroting … grounds for
  the Captain to audit you"），无任何机械检查——正是 2.1.2 定案的"实现了语法没实现语义内核"。
- 修法：`pair_verify`（flow.js:385+）写入前，对 `verify.evidence[]` 与本 cycle
  Driver 已记录的 evidence 文本（red/green/report）算重合度，高重合 → throw
  "ACCEPT evidence not independent"。**tokenizer 现成**：story.js 的 `tokensOf`+Jaccard/containment
  （story.js:42-75）直接导出复用——同族机制首次吃自己的狗粮。
- 设计约束：失败=handler 报错，绝不依赖 appendPairEvent 断言（M11' 哑火）；阈值给 false-positive
  留逃生口（附 `independence_note` 非必填字段？先不做，按 §4"不确定取严"，报错文案里说明如何措辞
  才能通过：引用**自己跑出的**命令输出/文件行号天然不重合）。
- 建议批次：0.3.0（M1' 实质严格家族，与验收实体化同审）。规模：~50 行含测试（取严版）。

### M16'｜RETRO 的 Rule-of-Three 扫描
- 课程依据：slide[96] 重构时机 #1"三次 repetition 就该重构"。
- 修法：pair_retro 汇总时扫 cycles 的 verify_plan/test_results 模式，结构重复 ≥3 → 自动写入
  "Try next session"栏（如 "3 cycles ran `node --test tests/runtime*` after touching X——consider
  one R-package cycle on X"）。纯读派生，无新状态面。
- 建议批次：0.3.x。规模：~25 行。

## 3. 课程 → 已有工单映射（不重复工单，仅补论据/细节）

| 课程知识点 | 已有工单 | 补丁式细化 |
|---|---|---|
| TDD 循环外层两步（前后绿） | **M7'** | M12' 的两条派生检查即其实现细节 |
| Q4 自动化测试=行为不变唯一证明 | **M1'** | AC→机判用例矩阵 + ACCEPT trace（M15' 保证 trace 的证据是真证据） |
| Pragmatic view / incessant tinkering | **M3'/M4'/M5'/M6'** | M14' 修 machine.js:169 残留的 Purist 实现；⑪粒度税数据= M4' 降档的反向论据已记 0.2.3 |
| "必须改就 pair 着改"（deadline） | F3/spec-freeze、trivial 通道 | captain 文案补一句：用户催办 → 降档（full→light、enforce→coach），不是跳过审阅 |
| published interface 恐惧 | ——（→新单 M13'） | —— |
| M2' guard | rotate 死码 | R1 所有权移交，见 §4 |

## 4. Dogfooding 重构包 R1–R8（课程方法 → 插件自身，无新协议语义，239 断言绿网下推进）

| # | 课程 smell（实锤） | 证据（v0.2.2 行号） | 课程 cure |
|---|---|---|---|
| R1 | Dead Code（受控保留） | `lifecycle.js:349` 无条件 throw，:350-374 不可达（含 :360 role 互换、:368 HANDOFF 投递） | **不删**——M2' 落地时整体替换；工单挂 M2' 名下，防他人误删 |
| R2 | Duplicate Code（最大块） | flow.js 九个 execute 头部同一段 5 行样板（`requireAgent → stateRootFor → requireParticipantTeam → withLock → readTeam → throw`）：:47-53、:84-90、:134-146、:186-201、:234-242、:267-275、:301-309、:342-350、:386-402 | Extract Method：`withFreshTeamLock(exec, cb)` 收编；预计净减 60+ 行。按 §4 预算纪律拆 2-3 个 cycle（先立 helper+测试并迁 2 个工具，再分批迁移，最后清尾） |
| R3 | Duplicate Code | `cycle.report = {…}` 镜像块 flow.js:314 vs :358（仅差 refactor_evidence 一字段） | 同一 recordReport helper 带 step 参 |
| R4 | 派生查询散落（Temp→Query 反面） | `verify?.verdict==='accept'` 五处：gate.js:48/:68/:91、lifecycle.js:171/:308 | machine.js 导出 `isAccepted(cycle)` / `acceptedCycles(protocol)`，工具层与 gate 共用 |
| R5 | Long Method + Conditional Complexity | `runGate`（gate.js:37-111）六段 `if (enabled.has(...))` —— 课程 `statement()` 案例的克隆 | Extract Method → 检查函数注册表 → **DoD 策略化**（新增 check=注册一个函数，不改 runGate——OCP） |
| R6 | Conditional Complexity + OCP | `cycleChains` 字符串分支（machine.js:102-108）、`styleNote` 三分支（personas.js:66-74）、`invariants(tddMode)`（:32-44）与 personas 全篇 `tddMode==='enforce' ?` 三元 | tddMode/style 策略对象化 `{chains, gateChecks, personaFragments}` 按名注册——新增 mode 从"改 3 文件"降为"加 1 文件"（课程 Q32 收益的插件版） |
| R7 | Data Clumps | `(ctx, config, agent, stateRoot, team)` 五件套同行贯穿 flow/lifecycle | Introduce Parameter Object（TeamContext）；P2，最后做，涟漪最大 |
| R8 | Docstring 诚实度（pragmatic 线索级） | `config.js:23` planningMaxArbitrations 是唯一无 `/** */` 注释的字段（:22 有）；顺手补 | P3 微瑕，搭任意 cycle 携带 |

执行载体：R2–R6 **不要单开"重构冲刺"**，用 §5 的练习阶梯当真实 cycle 顺路做——每步都天然满足
I2（≤80 行）、可被既有 239 断言当场验证，正合课程"重构嵌在正常流里"（slide 96：code review 时、
学到新东西时）。

## 5. Movie Rental 练习阶梯（重启宿主后的首个真实团队任务 = 全链路 smoke + 验收机制试金石）

起点：落盘课程 Q21 的原始 `statement()`（Java 或转写为 JS）+ 黄金输出测试（Q20 定价数字即数据源）。

| 步 | cycle（各 ≤80 行） | 演练到的机制 |
|---|---|---|
| 1 | Extract `getPrice(Rental)`（Q22） | RED/GREEN 证据链、I7 |
| 2 | Move Method → `Rental.getPrice()`（MQ24：参数消失、`each.getPrice()`） | AC-trace（M1'）、gate |
| 3-4 | Replace Temp with Query：`getTotalAmount()`、`getFrequentRenterPoints()`（Q25/26） | R4 同族手艺；REFACTOR 步顺带吃 M12' |
| 5 | 新增 `htmlStatement()` 复用两个查询方法（Q27 收益 3） | "重构买来的可复用性"以新特性 cycle 呈现——working software 是唯一进度度量 |
| 6 | Strategy 家族：`IRentalPriceComputer` + 3 实现（Q30/31） | R5/R6 的 OCP 直觉预演 |
| 7 | 加 `ThreeDReleasePriceComputer`，**断言 `Rental` 类 diff = 0 行**（Q32） | 把"符合 OCP"变成一条可跑测试——M1' 机判用例清单的最佳示范样本 |

**0.2.2 新机制的硬约束（立项前必读，全部实测）：**
- `specFrozen`：任务一开 cycle 即冻结 spec（machine.js:220，按 task 粒度）→ 方案仲裁必须全部
  发生在建卡前；
- 规划预算 `planningMaxArbitrations=2/task`（arbitrate.js:41-43，无 0-kill-switch）→ 每任务最多
  2 次规划期仲裁，Challenger 多方案评审要在预算内收敛，余论转风险票；
- 风险注册表全队 15 上限（risk.js:48-50，P0 免检）→ 练习中 P2 票节制；
- **测试禁断言审计事件**（M11'：`pair/*` 事件在本 cohort 整体哑火，events.js:22-29）→ 一切验收
  只能断言返回值与 team.json 盘面；
- M9' 未修：停过的 team 名不可复用 → 直接用默认时间戳名，勿传 `--name`。

产出即 README/quickstart 示例 + M1'/M7' 落地后的回归载体。

## 6. 批次建议（最终版）

| 批次 | 内容 |
|---|---|
| 0.2.3（不变） | 纯债版本：既有债单照单全收，**不夹带**本 delta 任何新项 |
| 0.3.0（已定包 + 并入） | M1'–M7' 机制包、攻击质量门禁 ＋ **M12'（折进 M7'）、M14'（折进门禁单）、M15'（M1' 家族）**；R1 随 M2' |
| 0.3.x | **M13'、M16'**；R2–R6 借 §5 练习阶梯由真实 pair 团队按 cycle 消化；R7 视收益 |
