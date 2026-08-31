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
| **Driver** | 派生子代理 | 手：唯一允许修改文件的代理 | 没有批准的提案就不许动手（I1、I3） |
| **Navigator** | 派生子代理 | 眼：逐步评审，独立复跑验证 | ACCEPT 不许转述 Driver 的报告（I4、I6） |
| **Challenger** | 派生子代理 | 红队：用失败模式攻击方案 | P0 风险阻塞当前循环，P1 阻塞任务完成（I5） |

八条协议不变量由**工具层强制执行**，不是求模型自觉：

> **I1** 单写者 · **I2** 小步快走 · **I3** 先提案后动手 · **I4** 完成需过门禁 · **I5** 风险不过夜 · **I6** 证据优先 · **I7** 测试先行 · **I8** 反馈必须结构化

没有 `pair_gate_check` 通过记录，任务在工具层**根本标记不了 completed**；空泛的拒绝意见（"感觉不太对"）会被消息 schema 直接拒收；生产代码没有先行的失败测试，会卡在 Definition of Done 上。你可以跟 AI 讲道理，但工具不讲情面。

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
Driver [PROPOSE] ──► Navigator [GO] ──► RED      先写失败的测试
                                       （不存在的 API 编译失败也算 RED）
                                       ──► GREEN   最小实现让它变绿
                                       ──► REFACTOR 在绿态保护下清理
                                       ──► Navigator VERIFY（自己复跑一切）
                                       ──► Challenger RISK_CHECK ──► GATE
```

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
| `dod` | 协议默认 | DoD 门禁项（逗号分隔）：`all_accepted,no_blocking_risks,verify_evidence,decisions_documented,test_first,spike_outcome` |
| `greenBuildOnStop` | `true` | 有落地改动时，`pair_stop` 必须附新鲜的全量测试通过证据 |
| `maxCyclesPerTask` / `spikeMaxCycles` | `12` / `2` | 硬预算——协议不空转，token 不白烧 |
| `defaultMode` | `full` | `full`（3 代理）或 `light`（2 代理快线） |

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

或本地 checkout 开发（`link:` 安装，流程见 [docs](docs/README.md)）。双通道激活——`/pair` 斜杠命令 + 纯文本手势边界——覆盖 Web UI、headless CLI 与 API 会话。

**降级先声明。** 平台能力缺失时会话自动降级（纯 prompt 模式、无状态模式）而不是崩掉，且每次会话开头明示当前模式。降级优于报错，证据优于意见。

## 工程质量

```sh
npm test          # 4 个套件 102 条断言，纯逻辑，离线可跑
npm run verify    # 导入门禁 · 启动门禁 · 包门禁 · 类型检查 —— 全绿
```

零第三方插件依赖：自带运行时（团队状态、任务图、JSONL 邮箱、调度器），直接构建在 DSH 宿主原语上。部分并发/持久化模式复刻自 [`@nanmicoder/dsh-agent-teams`](https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams)（MIT）。完整设计论证、不变量与验收测试（T1–T14）在 [`docs/`](docs/README.md)。

## 凭什么可信

这里的每一条实践都来自让敏捷真正生效的那套手册——Kent Beck 的 XP、敏捷宣言的价值观、Scrum 的工件与仪式——而它们从未遇到过比代理团队更好的土壤：代理在 strong 结对里**没有自尊要护**，在角色轮换里**没有疲劳**，在门禁面前**没有把任务标成完成的动机**。独狼式开发的失败模式不会因 AI 而消失——只是键盘更大了。

**别再演代码评审。开始交付被验证过的增量。**

## 许可

MIT.
