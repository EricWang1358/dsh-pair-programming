# dsh-pair-programming

**一行 Agile，零红构建交付。**

> AI 代理写代码像一个才华横溢却独来独往的黑客：快、自信、而且*没人看着*——没有评审、没有测试、没有门禁。`dsh-pair-programming` 把任意 [DeepSeek Harness](https://github.com/deepseek-ai) 会话变成一个**迷你敏捷团队**：每一行代码都必须经过提案评审、先失败的测试、和一道判定 DONE 的质量门禁。

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

```
/pair 实现用户登录接口，要求 JWT + 刷新令牌
```

就这样。你刚刚成为结对团队的 **Captain（队长）**——之后每一次改动都要走完资深敏捷工程组织的全部纪律：*提案 → 评审 → 测试先行 → 独立验证 → 风险攻击 → 质量门禁*。

---

## 为什么：独狼代理的四个老毛病

让单个代理"直接把功能写了"，就是加了速的瀑布流：

- **UAT 前没人评审**——缺陷流入生产后的修复成本最高可达创建时拦截的 **100 倍**（而代理会心安理得地报告"完成"，尽管一行测试都没跑）。
- **测试后置等于没有测试**——没有一个先失败的测试在前面领路，代码会一路漂离用户的真实需求。
- **Bus factor = 1**——全部知识锁在一个脑袋（或一个上下文窗口）里，"完成了 90%"在一行可运行的软件都没有时毫无意义。
- **假敏捷**——"Sprint 1 需求、Sprint 5 测试"是穿了马甲的瀑布。真敏捷要求**每个循环交付被验证过的可工作增量**。

极限编程（XP）、结对编程、TDD、用户故事、复盘——这些实践本就是为了杀死以上失败模式而发明的。它们在代理团队上同样有效，而且**代理比疲惫的人类执行纪律更不走样**。

## 你得到什么：一支敏捷团队，不是一个聊天机器人

| 角色 | 是谁 | 职责 | 硬规则 |
|---|---|---|---|
| **Captain** | *你自己*的会话 | 仲裁、规划、对用户负责 | 按证据裁决、可逆决策 70% 即拍板；亲手不写实现 |
| **Driver** | 派生子代理 | 手：唯一允许修改生产/工作区文件的代理 | 没有批准的提案就不许动手（I1、I3） |
| **Navigator** | 派生子代理 | 独立标准：仅能在预留 oracle 目录写入验收工件，并在任何方案出现之前仅凭需求冻结验收 oracle；此后以**计算出的**判决收口每个循环 | ACCEPT 无法靠声称获得——工具会重跑冻结的 oracle（I4、I6、I8） |
| **Challenger** | 派生子代理（遗留，仅 `full` 模式） | 红队：用失败模式攻击方案 | P0 风险阻塞当前循环，P1 阻塞任务完成（I5） |

八条协议不变量由**工具层强制执行**，不是求模型自觉：

> **I1** 单写者 · **I2** 小步快走 · **I3** 先提案后动手（小步自动 GO） · **I4** 完成需过门禁 · **I5** 风险不过夜——阻塞票只能靠可执行产物关闭；**验收仪器（oracle/量具）的 P0 只阻塞验证，不阻塞开发**，量具在修不会连带把被测代码一起停 · **I6** 证据是一次重跑，不是一句话 · **I7** 测试先行 · **I8** oracle 先行 · **I9** 一个未验收的循环 = 一次未结账——新提案要先等上一环的裁决

没有 `pair_gate_check` 通过记录，任务在工具层**根本标记不了 completed**——而且门禁会**亲自重跑冻结的 oracle**，不采信任何关于它的说法。通过凭证同时绑定该 oracle 和当时的工作树；二者任一在通过后发生变化，完成会以 `GATE_STALE` 被拒绝，必须重跑门禁。空泛的拒绝意见（"感觉不太对"）会被消息 schema 直接拒收；改动你正被其评判的那份验收测试，会改变它的摘要并被自动判为 REJECT。你可以跟 AI 讲道理，但工具不讲情面。

**谁能写什么。** 只有 Driver 可修改生产/工作区文件。Navigator 和 Challenger 不仅没有通用文件编辑器，`pwsh` / `bash` / `Bash` 也会被拒绝，因为通用 Shell 本身就是写入能力。Navigator 只可通过 `pair_oracle_write` 创建独立验收工件，原生路径校验仅允许 `.pair-oracles/<task_id>/…`，不能触及生产路径。冻结 oracle 与质量门禁由插件自身执行，因此移除 Navigator 的 Shell 不会取消计算验收。

### 为什么是 oracle，而不是再加一个评审者

在真实 SWE-bench 题面上跑满八轮的对照测量显示：v2 协议与单个代理独干**在正确性上零分离**——逐位相同的通过/失败序列、一处字节级同一的补丁、一处字节级同一的失败渲染。原因是结构性的，不是不够努力：每一次"验证"都封闭在写代码时所用的同一前提里。Navigator 依据的是团队自己按自己的理解写下的验收标准；RED 测试由 Driver 在同一理解下写成；门禁只数证据字符串。同一模型、同一上下文、同一种读法 ⇒ 相关性错误。

v3 修的是信息问题，而不是加席位：验收标准**仅凭需求、在方案出现之前**由一个没见过方案的角色推导出来，封存进摘要；此后每一次判决都是一次重新执行。完整推导与测量见 `dsh-pair-programming-design/01-design/REDESIGN-v3.md`。

### v3.1——让循环自己转起来

v3 落地后回放了两次完整会话。机制在被调用时都工作，但**没有东西让它们被调用**：一次会话里 Captain 发了 **151 条"现在该谁做什么"的散文指令**，**28 次提案对 0 次验证**——评审席位一整场只上了 2 turn，Driver 上了 50 turn，35 次 GREEN 没人验。Captain 变成了调度器。五处修正：

- **看板自己写谁的回合。** 每条协议消息与 `pair_status` 都附一行 `[PAIR:NEXT] <谁> 欠 <工具>(<id>) —— <原因>`，从看板派生。回合次序读看板，不靠转述。
- **回压（I9）。** 一个任务尚有未裁决的循环时，`pair_propose` 会拒绝新循环。v3 只在"完成"处把关验证，不在"继续"处把关——这个洞补上了。
- **会话阶段真的会动。** 首次提案 `PLANNING → CYCLING`；门禁通过 `CYCLING → TASK_GATE`；完成后回退。此前 `pair_status` 无论跑到哪里都写 `PLANNING`，甚至任务 3/3 已完成时也一样。
- **Oracle 不再有静默豁免。** `type=spike` 曾被默默豁免；现在要么冻结 oracle、要么必须在 `no_oracle_reason` 里写清理由，并记录到循环上。`trivial` 仍然直接豁免。
- **Oracle 触达评估。** 一个只断言"某个探针文件是否存在"的 oracle 会冻结为红、翻绿、对被测代码毫无侦测能力。冻结时会评估触达并给出 `SELF-CONTAINED` 警告——出现在 status、看板摘要与复盘里。

### v3.2——oracle 不再无限递归

一次实测 2h 16min 的 v3 会话**产出 0 个被接受的增量**：单个 oracle 被反复冻结六次以上，每次修正都对，合起来发散——协议没有"够用就发，未解决的臂具名声明"这样的出口。四处修正：

- **风险作用域。** `pair_risk` 支持 `scope: instrument`。**产品**类 P0 照旧阻塞新循环；**仪器**类 P0 阻塞的是验证与门禁，不阻塞实现——量具不可信不是停下写代码的理由。两者仍都阻塞任务完成。
- **oracle 非判定臂。** `pair_oracle` 支持 `non_gating_arms[]` + 必填 `non_gating_reason`。声明为"已知红、暂不判定"的臂照跑照打印，但不参与 verdict，交由它真正成立的那张卡兜底。oracle 可以在带瑕疵的情况下冻结，不必被那些不属于本任务的红臂无限拖住。
- **仲裁归属。** 未命名任务的裁决曾"什么都不花"；一位 Captain 靠"故意不写 task_id"在 2/任务 的额度下签了 18 条裁决。现在未命名裁决自动归属到"当前 claim 的任务"。
- **冻结预算与逃生门。** `oracleForkBudget`（默认 3）超出后需要一句 `captain_override`。不是硬墙，是摩擦：第 1 次之后的每次冻结都会在摘要里显示 `freeze #N`，递归看得见就避免得开。

## 工作流

### 会话级——每个故事任务用增量说话

```
pair_start ──► PLANNING ──────► CYCLING ◄──── TASK_GATE ──► 绿构建 ──► RETRO ──► pair_stop
             用户故事 +                 (可配置的       全量测试      keep/try
             INVEST 校验              Definition      不过不许      行动项
             + spike/triage 每改动     of Done)        "回家")        自动带入
             70% 规则仲裁                                                  ▼
                                                                    下一会话的 PLANNING
```

### 循环级——TDD 不是建议，是状态机（`tddMode=enforce`，默认）

```
Navigator 写入 + SPEC-FORK ──► Driver [PROPOSE] ──► GO ──► GREEN ──► VERIFY ──► GATE
(pair_oracle_write +       （小步 = 单文件、      让冻结的   计算得出：   门禁亲自
 pair_oracle：
 对需求给出 >=2 种读法、    <=80 净行，直接开在   oracle     重算摘要 +   重跑冻结的
 选定其一、写明隐藏验收      GO）                  变绿的     重跑命令，    oracle
 可能如何与之分歧，                                最小实现   而非声称
 仅能写入 .pair-oracles/<task_id>/，
 再封存进摘要；它记录
 的失败就是本循环的 RED）
```

四步、两个席位，且每个席位在每个循环后由看板摘要重新派生，而不是背着整段对话——v2 实测中，单个 Driver 席位就吃掉了 710 万输入 token，而单代理完成同一题只花了 13.8 万。

每条评审意见都按**建设性反馈三段式**走——*观察 → 影响 → 改进方向*——敏捷团队教材里的格式，在这里由 schema 校验。REJECT 自动分类（`invest_violation` / `test_first_violation` / `risk_hit` / `quality`）并进入复盘统计，因为**复盘胜过验尸**：在项目还能受益时持续改进，而不是结束后写一份没人看的报告。

进度只汇报**被验收的可工作增量**——永远不是代码行数、不是工时百分比。可工作的软件是进度的唯一度量。

## 实际长什么样

```
/pair 给订单服务加一个退款接口，要求幂等 --light
/pair migrate the payment webhook to the new provider --tdd=enforce --style=ping-pong
```

Captain 把需求拆成用户故事（*"作为财务专员，我希望退款调用是幂等的，以便客户绝不会遭遇二次扣款"*——写成"作为一个用户"或者让 benefit 同义复述 goal，会被工具**直接拒绝**并给出可操作的修改指引）。Navigator 对每个循环出具裁决。Challenger 负责攻击：*"P0：幂等检查非原子时，同一 id 的重放会退款两次——改用条件更新"*。只有全部循环 ACCEPT、无阻塞风险、测试先行链完整、DoD 清单全过——任务才允许宣告完成。

**结对风格**（真实的 XP，适配到代理）：
- `traditional`——一人打字一人看前方，Captain 定期轮换角色，让知识不淤积在单点（拉高 **bus factor**）。
- `strong`——"一个想法要进入电脑，必须先经过搭档的脑子"：想法持有者口述，Driver 只做手。新人上手最快的模式。
- `ping-pong`——失败测试的作者与实现者逐循环交换归属。

**仪式感按任务定档**：调研型工作自动变成 **Spike**（2 循环小时间盒，交付物是 go/no-go 决策不是代码）；typo 级任务打上 `trivial=true` 走短链。敏捷知道什么时候*不该*结对，这个插件也知道。

## 模式、配置与成本控制

| 配置（cordis.patch.yml / profile） | 默认 | 含义 |
|---|---|---|
| `tddMode` | `enforce` | `enforce` 工具强制 RED→GREEN→REFACTOR · `coach` 推荐不强制 · `off` 旧模式 |
| `pairStyle` | `traditional` | `traditional` \| `strong` \| `ping-pong` |
| `dod` | 协议默认 | DoD 门禁项（逗号分隔）：`all_accepted,no_blocking_risks,verify_evidence,decisions_documented,test_first,oracle_precedes_impl,oracle_replay,spike_outcome` |
| `greenBuildOnStop` | `true` | 有落地改动时，`pair_stop` 必须附新鲜的全量测试通过证据 |
| `maxCyclesPerTask` / `spikeMaxCycles` | `12` / `2` | 硬预算——协议不空转，token 不白烧 |
| `maxOpenRisks` | `15` | 全队 OPEN 非 P0 风险票上限；P0 提票不受此限 |
| `planningMaxArbitrations` | `2` | 任务进入规划期时可裁决的争议上限；任务已有 cycle 即豁免 |
| `defaultMode` | `light` | `light`（Driver + Navigator）或 `full`（另加遗留的 Challenger 席位） |
| `oracleFirst` | `true` | 任务未冻结验收 oracle 时，`pair_propose` 直接拒绝（spike 若跳过必须写 `no_oracle_reason`，落在循环记录上） |
| `oracleForkBudget` | `3` | 每任务允许的冻结次数上限，超出需 `captain_override`。软预算：可见化重复冻结循环，不阻断真实推进 |
| `memberLifetime` | `cycle` | `cycle` 每个循环由看板摘要重派席位；`session` 保留每角色一个常驻席位 |
| `heartbeatMs` | `60000` | 停摆邮箱的存活巡检周期；`0` 关闭。仅 YAML——巡检定时器在启动时装配，因此刻意不出现在运行时设置面里 |

协议开销是**工程压下来的，不是嘴上说说的**：事件驱动监控（无 busy-poll）、粒度自适应控制器（连过 3 环→放大步幅、两连拒→强制拆小）、三层缓存（落盘协议状态、按 `gitHead+path+mtime` 键控的 L2 仓库证据缓存、逐字稳定版本化的角色 persona 以吃满 LLM 供应商的 prompt 缓存），外加循环预算兜底。每一枚 token 花在哪，复盘报告里都有。

### 不碰 YAML 的运行时覆盖（敏捷不是人人都要全套）

上表中的热更字段同时注册为宿主 **settings 命名空间**（`pair-programming`，走 `dsh-settings`）。在 `~/.dsh/settings.yaml` 里写一段覆盖——或通过设置 API 写入——它叠加在 profile 合成值之上，**下一次工具调用即生效**，并保留"重置回合成值"语义：

```yaml
# ~/.dsh/settings.yaml
pair-programming:
  tddMode: coach        # 放宽：TDD 步骤可用，不再强制
  maxCyclesPerTask: 8   # 探索性工作用更轻的预算
```

没有 settings provider 的启动完全不受影响（插件严格按合成配置工作）。`stateDir`、`slashCommand`、成员派生选项等启动期字段有意只留在 profile YAML。上述字段同时提供 **Settings → Plugins 图形卡片**：草稿式编辑、每字段"已覆盖"徽标（显示组合基线并可一键恢复）、带 revision fence 的保存/放弃——全程不必碰 YAML。

## 安装

```sh
dsh plugin --profile web add @ericwang1358/dsh-pair-programming
dsh web
```

回滚：`dsh plugin --profile web remove @ericwang1358/dsh-pair-programming`（之后重启应用）。开发期用本地路径安装，命令等价。

或本地 checkout 开发（`link:` 安装，流程见 [docs](docs/README.md)）。双通道激活——`/pair` 斜杠命令 + 纯文本手势边界——覆盖 Web UI、headless CLI 与 API 会话。

**降级先声明。** 平台能力缺失时会话自动降级（纯 prompt 模式、无状态模式）而不是崩掉，且每次会话开头明示当前模式。降级优于报错，证据优于意见。

## 工程质量

```sh
npm test          # 15 个套件 397 条断言，纯逻辑，离线可跑
npm run verify    # 导入门禁 · 启动门禁 · 包门禁 · 类型检查 —— 全绿
```

v3.1/v3.2 的每一处修正都由一条"能复现被修失败"的回归钉住：`tests/wake.test.mjs`（O3 停摆）、`tests/oracle.test.mjs`（SPEC-FORK / 计算判决 / 篡改 / 触达 / 非判定臂 / spike 豁免）、`tests/obligation.test.mjs`（28 vs 0 的提案/验证失衡、阶段推进、spike 豁免）、`tests/scope.test.mjs`（风险作用域、非判定臂、冻结计数可见化）。

零第三方插件依赖：自带运行时（团队状态、任务图、JSONL 邮箱、调度器），直接构建在 DSH 宿主原语上。部分并发/持久化模式复刻自 [`@nanmicoder/dsh-agent-teams`](https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams)（MIT）。完整设计论证、不变量与验收测试（T1–T14）在 [`docs/`](docs/README.md)。

## 凭什么可信

这里的每一条实践都来自让敏捷真正生效的那套手册——Kent Beck 的 XP、敏捷宣言的价值观、Scrum 的工件与仪式——而它们从未遇到过比代理团队更好的土壤：代理在 strong 结对里**没有自尊要护**，在角色轮换里**没有疲劳**，在门禁面前**没有把任务标成完成的动机**。独狼式开发的失败模式不会因 AI 而消失——只是键盘更大了。

**别再演代码评审。开始交付验收标准早于代码落笔的增量。**

## 许可

MIT.
