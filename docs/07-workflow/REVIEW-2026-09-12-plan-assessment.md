# 缺陷审查计划的评估 —— 对 HANDOFF-2026-09-12"新版本缺陷审查+修复批次"的复核

> 复核对象：`docs/07-workflow/HANDOFF-2026-09-12.md` 之后的缺陷清单与批 A–F 修复计划
> （23 条缺陷 + 6 个批次）。复核时间 2026-09-12 晚，只读 + 纯函数探针，另跑过
> `node tests/run.mjs --only panel,client`（91 passed / 0 failed）。
> 结论先行：**方向基本合理，但计划写于代码之前——批 A 已经合并，批 B 已在工作区未提交，
> 照计划原样施工会重复劳动；另有 4 处诊断与实际代码不符。**
>
> ## 追加：施工后的状态（同日更晚）
>
> | 批次 | 状态 | 证据 |
> |---|---|---|
> | A（1、4、5、6、7 + 2、3） | 已合并 | PR #159 / `6e084e3` |
> | B（8–13） | **已合并** | `3b77aa9` "fix(panel): one number per question, and one event per pushback"，PR #160 / `1c49198`（并行会话落的，同时把本评估 §2-5 的圆环/标签同源修掉了） |
> | 本评估 §2-5（圆环与标签两套分母） | **已修** | `lib/client/panel.js`：`scored` 不可用时百分比改由 `completed/total` 重算；`tests/panel.test.mjs` 断言旧宿主回退渲染 `--pair-p:38` 而非 `59.5` |
> | C / D / E | 进行中 | 三个隔离工作树：`fix/plan-batch-c-oracle-first-seal`、`fix/plan-batch-d-risk-scope`、`fix/plan-batch-e-pause-semantics` |
> | F（21、22、23） | 待做 | 依赖 C 落定后同步 `REST = 6445` |
>
> 本地为什么跑不动全量：本沙箱禁止带管道 stdio 的孙进程（`spawn EPERM`），`--parallel` 必失败、
> 只能串行。CI 已就位（`.github/workflows/verify.yml`）：PR 跑 `node tests/run.mjs --parallel 4`，
> main 跑 `npm run verify`；七个 `@deepseek-ai` peer 包实测都在公共 npm 上，runner 上无需宿主安装。

## 0. 复核时的仓库实况（与计划的假设不符）

| 事实 | 证据 |
|---|---|
| `main` HEAD = `11423b2`，已包含 **批 A 全部内容**（PR #159 / `6e084e3` "fix(exposure): close the remaining candidate bypasses and harden pair_correction (plan batch A)"） | `git log --oneline`；`git show 6e084e3 --stat` = digest/disclosure/exposure/recycle/flow/lifecycle + lifecycle-output.test |
| **批 B 已在工作区、未提交**（panel-model / panel-progress / panel-value / panel.js / panel.css / client.js / panel.test.mjs，+128 −27） | `git status --porcelain`；`git diff` |
| 计划里"未提交改动（#153 pair_correction、#155 current_cycle 投影、#156 disclosure 文本）"已被 `7fcb2a1` 提交，不再是未提交态 | `git log 40fc7ba..11423b2` |
| 缺陷 2/3/4/5/6/7 的修复**已经在 HEAD 上**，不是待办 | 见下表逐条 |

**这决定了计划的施工顺序必须改写**：批 A 只剩"补一条断言"，批 B 只剩"提交 + 补漏项"，
真正的待办是 C/D/E/F。

## 1. 逐批裁定

### 批 A（1、4、5、6、7 + 2、3）—— ✅ 方向正确，**已合并**，只剩收尾

| # | 计划诊断 | 实际代码（HEAD） | 裁定 |
|---|---|---|---|
| 1 | `summaryFor` 按元素过滤，整个 `[PAIR:ATTENTION]` 块被删 | 已改为**逐行**过滤：`exposure.js:113-121`（`flatMap(line => String(line).split(nl))`）；`test/lifecycle-output.test.mjs:200` 新增负向断言 | ✅ 修复正确。**复核探针实证**：单个多行元素里夹一行 disclosure，spec 席只丢掉那一行，`pair_oracle(t-1)` 与 `pair_risk` 两行存活 |
| 4 | `Oracle bypasses` 打印 Driver 的 `noOracleReason` | `lifecycle.js:381` 已按 `exposeCandidate` 分支为 "(reason withheld)" | ✅ |
| 5 | 只有 tuned 类被过滤 | `disclosure.js:86-91` `disclosureSummary(team,{quoted})`；`lifecycle.js:388` 传 `{quoted: exposeCandidate}` | ✅ 比正则白名单更结实（按字段而不是按文本形状） |
| 6 | `risks`/`open_risks`/`product` 原样返回 | `lifecycle.js:440-441` risks 已白名单（id/severity/scope/status）；**`:433-436` product 仍用 `{...product}` 展开**，只是把 discoveries 逐条缩成 `{id,status}` | ⚠️ **部分落地**，见 §2-① |
| 7 | `boardDigest` 未传 `candidateVisible`，`recycle.js` 无 role 过滤 | `digest.js:59` 已接受并透传；`recycle.js:68` 传 `seesCandidate(member.role)` | ⚠️ **只补了一半**，见 §2-② |
| 2 | solo 下队长即实现者，不变量不可执行 | `flow.js:551-556` solo 无 `captain_override` 直接拒 | ⚠️ 落地了，但见 §2-③（它是"要求声明"而非"禁止"，且现成的绕过键就写在错误文案里） |
| 3 | 只调 `requireCycle` | `flow.js:569-576`：DONE/ABORTED 拒绝 + `requireLiveEvidenceTarget(..., {closure:true})` + 锁内 fresh 复核席位 | ✅ 三点都到位；顺序瑕疵见 §2-④ |

### 批 B（8–13）—— ✅ 方向正确，**工作区已实现**，但有 2 处没做完

| # | 计划做法 | 工作区实际 | 裁定 |
|---|---|---|---|
| 8 | 去重键统一 | `panel-model.js:60` 用同一映射把 no_go review 发射成 `noGo` | ✅ 修法正确（`shown` 键与 pushback 查找同源） |
| 9 | 补 `event.noGo` 词条 + `.pair-event-noGo` 颜色 | `panel.js:55,98`、`panel.css:197`；新测试还断言 `pairRhythmGroup('noGo')==='fail'` | ✅ 三处自洽（时间线色 / 泳道 / 计数） |
| 10 | 探针改判本批新字段 | `panel.js:180` 改判 `'scored' in progress` | ✅ 探针改对了；**但旧宿主的回退值把两套口径混在一起**，见 §2-⑤ |
| 11 | 终止卡分母四处统一 | `panel.js:436` 引入 `scored`，用于 hero(`:473`)、milestones(`:477`)、metrics(`:478`)。第 4 处"指标条"就是 metrics 的第二格，**计划数的"四处"实际是三处 + 百分比** | ⚠️ **百分比没并入**，见 §2-⑤ |
| 12 | `undatedPushbacks` 把判决当集合 | `panel-value.js:55-64` `liveVerdicts` 数组 + 逐条减 | ✅ 修法与诊断一致（含"无时间戳的记录不该两头都不显示"） |
| 13 | 吞吐分母只取 live 卡时间戳 | `panel-model.js:109-111` + `panel-progress.js:69` | ✅ 分子分母同集，逻辑自洽 |

### 批 C（15、16、17）—— ⚠️ 15 拆法有语义问题，16 的补丁方向对但会互锁

- **15（`firstFrozenAt`）**：状态确认为真。`oracle.js:145` 仍是 `prior === undefined ? frozenAt : prior.firstFrozenAt`，
  而 `:163` 的 `...(firstFrozenAt === undefined ? {} : {firstFrozenAt})` 意味着**旧板面首次重封后该字段被静默丢弃**，
  再重封一次也拿不回来。**但计划给的修法（`?? prior.frozenAt`）与代码自己的注释冲突**：`:142-144` 明写
  "inferring one would read a late re-freeze as an early seal"，而 `gate.js:432-435` 也明写
  "this arm does not retroactively forgive them"。见 §3 裁决。
- **16（sealingGreen × 首封继承）**：诊断成立。`oracle.js:220` `sealingGreen` 只要求"不是首封"，
  `firstFrozenAt` 无条件继承 ⇒ 实现完成后照实现重封一份今晚就绿的"标准"，三条臂全绿。
  `record.sealedGreen`（`:240`）**只写进 task.oracle，全库零门禁消费者**（只有 oracle 工具回执和它自己的测试读它），
  所以"它说了出来"不等于"有人会拦"。计划要求"严格加强（新封为旧封超集）或 captain_override"方向对，
  但"超集"这个判据本身需要机判定义（files 是超集？cmd 是超集？），**这是本计划里最含糊的一处实现要求**。
- **17（`oracleTightenedAfterImpl` 条件）**：诊断成立。`gate.js:441` 只比 `frozenAt > firstFrozenAt`。
  计划加 `firstOpened < frozenAt` 正确，但**只改这一处会让 17 与 16 打架**：16 若允许"重封即绿"，
  而 17 的审计标记又要求它可被发现——两个改动必须同一刀落地，且要说明审计标记的消费者是谁（目前无人读）。

### 批 D（14、19、18）—— ✅ 方向正确，一条要先做取舍

- **14（仪器域 P0 × `taskId` 过滤）**：诊断成立。`risks.js:215-217` 的 `blocksVerification` 走
  `blocksCard(risk, taskId)`，`blocksImplementation`(`:206-208`) 同样。**注意不对称**：`blocksImplementation`
  已按 `scopeOf(r)==='product'` 过滤，`blocksVerification` 故意"任何 P0"——计划只说"仪器风险应忽略 taskId"，
  没说未被归属（`taskId === undefined`）的仪器票怎么算。修法成立，**补一句"仪器域 = scope==='instrument' ⇒ blocksCard 恒真"**即可。
- **19（MITIGATED 的出口文案）**：诊断成立且**容易修**。`risks.js:155` 的 `wontfixRisk` 已允许
  `['OPEN','MITIGATED']`（#127），但 `attention.js:186` 的 MITIGATED 行仍然只给
  `pair_risk(action="close", closing_cmd=…)` 一条路——正是文档 §6-6 "报错里给出的出路要有测试证明它存在" 的同类。
  计划"同时给出 wontfix/defer"正确；注意**风险状态机里没有 `deferred`**，要么用 WONTFIX+rationale，要么先加状态。
- **18（`gateBoundRisk` 去 status ⇒ 旧凭证全失效）**：**诊断的前提成立**——`197b1d2`（#131）确实把 status
  从整对象哈希改成 `BOUND_RISK_FIELDS` 白名单，所以带任何 P0/P1 的旧板面 `gateStateSha` 会变。
  **但"给 binding 加 digestVersion、旧版本按旧算法校验一次再迁移"是 6 条里最重、收益最不确定的一条**，见 §3 裁决。

### 批 E（20）—— ✅ 诊断成立，修法一行，**但描述修改是重点**

`scheduler.js:609` `await runtime.kickMember(workspace, located.id, member.name);` —— 无 `{background:true}`，
而 `kickMember` 第一件事就是 `:353 trackTeam(...)`，`trackTeam` 在非 background 时 `:164` **删掉暂停位**。
暂停由 `untrackTeam`（`:195-199`）设置，语义是"整队暂停"（`pair_interrupt` 调它）。所以：
**任何席位的一次回合结束（idle 边沿）都会解除暂停**，与工具描述"until you speak"不符。
⚠️ 计划只写"在 idle 边沿传 `{background:true}`"——**这修的是不该解除的情形，但会让"回合结束需要重新被唤醒"的正常路径也变成不免打扰**：
idle 边沿的 kick 正是 M16'/recycle 的唤醒路径，加了 background 后它只在未暂停时才生效（这正是想要的）。
**结论：修法一行成立，但必须同时改工具描述，并补一条"暂停后成员回合结束仍不恢复扫描"的测试**，否则下一个人会把它当成 bug 改回去。

### 批 F（21、22、23）—— ✅ 全部成立，成本已知

- 21 `prompt.js:94` 工具清单实测 **26 条**，缺 `pair_correction`/`pair_yield`/`pair_cleanup` 三条（宿主契约是 29 条）；陷阱属实：
  `tests/prompt-budget.test.mjs:22 REST = 6445` 且 `:35` 断言**等式**，改清单必须同步常数（这是有意设计，不是缺陷）。
- 22 `personas.js` 通篇无 `pair_correction`（grep 0 命中）——真空白。
- 23 `tests/host-contract.test.mjs:75` 已断言 `=== 29`（且已把 `pair_correction` 列进 must-exist），
  **所以 23 现在只剩"消息里的 28 与代码里的 29 不一致"这一条文案**，不是断言错误。

## 2. 计划没覆盖的 5 处（复核新增）

1. **`boardDigest` 的 `candidateVisible` 只关了 attention 块，其余节仍然带候选文本**。
   `digest.js:87-95`（`cycle.proposal.intent`、`proposal.files`、`cycle.review.conditions`、`cycle.verify.category`）与
   `:97-103`（blocker 的 `r.scenario`）都**不看 `opts.candidateVisible`**。所以缺陷 7 只补了一半：
   一个不能看候选的席位，欢迎语里仍然能读到本轮改了哪些文件、被退回了什么条件、风险票说的什么症状。
   与 `lifecycle.js` 里刚做完的 U2 投影（cycles 走 cycleExposure、risks 走白名单）**口径不一致**。
2. **`product` 投影是展开而非白名单**（`lifecycle.js:433-436`）。discoveries 被缩成 `{id,status}` 是加在
   `{...product}` 之上，`product` 自身字段（`untriaged/deferred/scheduled` 无害，但若将来加
   `lastObservation` 之类就自动泄露）。同文件的风险投影用的是白名单——两套口径并存，下一处就漏在这里。
3. **solo 的 `captain_override` 是"任意非空字符串"**：`flow.js:551` 判 `override === ''`，
   `'x'` 即通过，并且**这句话就写在拒绝文案里**（`:555`）。所以缺陷 2 的不变量在 solo 下仍是荣誉制——
   计划描述为"拒绝，或要求 captain_override + 理由"是准确的，但落地的是后者，**账面不要记成"已堵死"**。
4. **`pair_correction` 的守序**：solo 守卫在读锁前的 `team` 上判（`:551`），DONE 判在锁内 fresh 上（`:569`）。
   一个已解散的 solo 队会先得到"pass captain_override"的错误指路，而不是"board is DONE"。另外 `override` 的
   长度上限、是否允许在 20 条 corrections 之后再追加，都没有界。
5. **旧宿主回退把两套分母混在一起（计划 10/11 的残留）**。见 §1 批 B 第 10/11 行：
   `scored` 回退到 `c.total`（全部卡），而 `percent` 仍直接取旧宿主发来的 `progress.percent`（旧宿主分母含终止卡）。
   两个读数会互相矛盾。**实证**（`scripts/panel-fixture.mjs` 的 demoBoard，取消 1 张后手工删 `scored`）：
   新宿主是 `percent = 59.5 / scored = 7`；删掉 `scored` 之后页面渲染成 `percent = 59.5` 配 `scored = 8`（真值 7）——圆环按「7 张在飞」给百分比，标签却除以 8。
   修法：`percent` 与 `scored` 必须同源——要么都回退到 `c.total` 并重算 percent，要么 `scored` 不可用时
   整块概览走 legacyHint 的分支直接不渲染百分比。**这条是必须补的，否则"统一分母"只统一了标签、没统一圆环。**

## 3. 两处我建议**否决计划原方案**的地方

### 3.1 缺陷 15：不要用 `?? prior.frozenAt` 回填

计划要 `firstFrozenAt = prior.firstFrozenAt ?? prior.frozenAt`。这与两处现存注释直接冲突：
`oracle.js:142-144`（"a board written before this field would otherwise get 'the first seal is now', which reads as a
late seal and re-creates the deadlock"）与 `gate.js:432-435`（"this arm does not retroactively forgive them"）。
回填会把"某次晚期重封"当成首封，**让 15 想救的那类板面反而通过了 N1**——用一个假事实换一条不再报错的路径。

**建议**：保留"不可测就是不可测"，把 deadlock 消解在判据上——`gate.js:438-440` 当
`firstFrozenAt === undefined && prior 存在` 时把 `oraclePrecedesImpl` 记为 "unmeasurable" 并**不判失败**
（与 `:432-435` 的注释一致：这些卡不再是陷阱），但`checklist` 里保留 `oracleFirstSealUnmeasurable`。
这样 #125 的死锁对旧板面不再复发，也没有伪造首封时间。（`gate.js:438` 已经在做 `?? oracle.frozenAt` 的回退，
所以真正要改的是 `oracle.js:145` + gate 的判失败条件。）

### 3.2 缺陷 18：`digestVersion` + 双算法校验，收益/风险比不划算（建议降级）

赞成不动它：`gateStateFingerprint` 有 9 个消费方（attention/completion/arbitrate/panel-model/flow×2/integrate/lifecycle/obligation），
任何"同时支持两种算法"的迁移都会在这 9 处各长一个分支，而它换来的是**一次升级风暴的避免**——
且风暴本身是**正确**的：旧凭证确实没有按新定义判过这块板面。
更关键的是，"旧版本按旧算法校验一次再迁移"会新增一条**只在升级路径可达**的代码，那正是历史上最容易腐烂的一类路径。

**建议降级为 P2，并改做三件便宜的事**：
1. 让 `gateBindingDiff` 在摘要定义变更时能**说出来**（现在 `itemDiff` 只能报"risks: input changed"，会把人引向
   去查一张根本没动过的票——这正是 18 的实害）；
2. 在 CHANGELOG/升级说明里写明"#131 之后首个 gate 需要重跑一次"，把它当**已发布的迁移成本**记录；
3. 在 RETRO/error 文案里指明恢复路径就是 `pair_status` 的 `recovery_actions` + 重跑 gate（工具链已有）。

## 4. 对"验证"一节的复核

- 命令形状可用：`node tests/run.mjs --only <套件> --parallel 2` 与实现一致；
  **但计划写的套件名与实际不完全对得上**（计划批 C 写 `oracle,gate,gate-binding`；仓库里是 `verification.test.mjs`、
  `gate-binding.test.mjs`、`oracle.test.mjs`，`--only` 需要确认是按文件还是按套件名匹配，建议先 `--list`）。
- "面板改动需 `scripts/build-client.mjs` 后再跑"正确（`panel.test.mjs:47` 断言 `lib/client.js` 与源文件逐字节一致）。
- "1、8、10、11 各自补一条断言"**部分已做**：8/10/12/13 的新断言已经在工作区的 `panel.test.mjs`（+68 行）里；
  1 的断言在 `6e084e3` 里（`:200`）；**11 的新断言只覆盖了 `scored` 的三处标签，没覆盖百分比与标签同源**（见 §2-5）。

## 5. 一句话结论

**这批判定是可信的、绝大多数修法是正确的，问题不在"方向合理不合理"，而在计划的时间戳**：
它描述的是"批 A 未提交、批 B 未实现"的世界，而现在是"批 A 已合并、批 B 已改完待提交"。
按现状施工应该改成：**批 A 只剩补断言 → 批 B 补 §2-5 的百分比同源 + 提交 → 批 C 先按 §3.1 裁定 15 →
批 D 把 18 降级并改做"让摘要变更说得出来" → 批 E 一行 + 改描述 + 补测试 → 批 F 三处文案。**

**四条必须回答的问题**（本评估不替计划回答）：
1. 15 用回填还是用"不可测不判失败"？（§3.1 建议后者）
2. 16 的"严格加强"如何机判？谁是 `sealedGreen` 的消费者？（现状零消费者）
3. 17 的审计标记谁读？（现状零消费者；零消费者的审计字段等于没有）
4. 18 是否接受"降级为迁移说明"？（§3.2）
