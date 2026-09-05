# dsh-pair-programming 插件设计方案

> 版本：v4 ｜ PROTOCOL_VERSION=4 ｜ 日期：2026-09-04 ｜ 状态：已实现（`@ericwang1358/dsh-pair-programming@0.4.0`）
> 口吻说明：本目录是设计存档，v1/v2 正文保留为历史，头顶各有一节 v3 导读。v4 的增量（solo 默认、需求覆盖矩阵、机判终态与 completion_receipt、机长写守卫、看板事件唤醒）以插件 `README.md` 与 `CHANGELOG.md` 为准。
> 新设计只看三处：插件 `README.md`（中英双语）→ `01-design/DESIGN.md`（v3 正文）→ `01-design/REDESIGN-v3.md`（八轮实测推导，英文）。

## 这是什么

`dsh-pair-programming` 是一个 DSH（DeepSeek Harness）插件，把 **Agile 结对编程（Pair Programming）** 固化为一套可重复、可审计、有质量门禁的多 Agent 协作协议。**零第三方插件依赖**：自带独立的结对运行时（团队状态、任务图、邮箱、事件驱动调度器），直接构建在 DSH 宿主原语之上；成熟模式（串行锁、原子写、邮箱、能力令牌）从 agent-teams 源码复刻适配（MIT）。

核心理念：**验收先行（oracle-first）** —— 验收标准在任何实现存在之前、仅凭需求推导并封存进摘要，此后每一次判决都是一次重新执行，而不是一次表态。

v1/v2"三个角色并行互相质疑就能更少犯错"的假设，在八轮 SWE-bench 双臂对照里被证伪了：正确性零分离、评审通道零拦截、一次 45 分钟死锁交出 0 字节补丁。同一模型、同一上下文、同一种读法，错误是相关的——加席位只加成本，不加信息。推导全文见 `01-design/REDESIGN-v3.md`。

| 角色 | 职责 | 类比 |
|---|---|---|
| **你（solo 模式，默认）** | 拆需求、写代码、跑门禁；但**无法验收自己的工作**——判词是封存命令的重跑结果 | 握键盘的人，兼队长 |
| **SPEC** | 短命子代理：仅凭需求写下验收测试并冻结，然后退休；无 reader、无 shell、无搜索 | 出题人，考完就走 |
| **Driver / Navigator（遗留 `light` 模式）** | 仍然可用，但成本已被实测：评审席位八轮零 NO_GO、零 REJECT | 留档的多席位制 |
| **Challenger（遗留，仅 `full` 模式）** | 同上；它的有效贡献已收编为 SPEC-FORK 的必填项 | 红队，进了存档 |

## 文件夹结构

```
dsh-pair-programming-design/
├── README.md                    ← 你在这里（总览 + 索引）
├── 01-design/
│   └── DESIGN.md                ← 总体设计：角色协议、状态机、质量门禁、缓存、性能、兼容性
├── 02-architecture/
│   └── ARCHITECTURE.md          ← 技术架构：模块划分、数据流、API、宿主原语集成点
├── 03-prompts/
│   └── PROMPT.md                ← 历史文档，已退役（头顶有 v3 说明，不再用于开新实现会话）
├── 04-acceptance/
│   └── ACCEPTANCE.md            ← 验收标准、测试计划、Definition of Done
├── 05-reference/
│   └── AGENT_TEAMS_API.md       ← agent-teams 成熟实现调研（复刻模式的来源与参考）
└── 07-workflow/
    ├── WORKFLOW.md              ← 功能表：Epic → User Story → Sub-feature，每项标机判点与失败模式
    ├── LIFECYCLE.md             ← 一个任务的完整时序：阶段 0→7，每步的门与拒绝理由
    └── FRAGILITY.md             ← 架构脆弱点（🟠）与解决方案，附优先级
```

## 快速开始（给实现者）

历史章节：插件已实现到 v0.3.0，`03-prompts/PROMPT.md` 已退役。改协议前先读 `01-design/REDESIGN-v3.md`（为什么是现在这样）和各文档头顶的 v3 导读；新机制先声明它还哪笔债，说不出就不收。

## 快速开始（给使用者，实现完成后）

```
dsh plugin --profile web add <插件路径或包名>
```

然后在 DSH Web UI 里：

```
/pair 实现用户登录接口，要求 JWT + 刷新令牌
```

或自然语言："用结对编程完成这个需求：……"

## 设计目标（用户原始需求 → 设计响应）

| 用户需求 | 设计响应 | 详见 |
|---|---|---|
| 功能独立 | 独立 npm 包、独立 cordis patch、独立状态目录 `.pair-programming/`、自含运行时；零第三方插件依赖，只依赖 DSH 宿主原语 | DESIGN §8 |
| 兼容性强 | 仅依赖 DSH 标准 base bundle（web/headless/sdk 均含）；commands 服务懒加载可选；不依赖特定 LLM provider、不依赖任何第三方插件 | DESIGN §9 |
| 交流频繁 | 每个微步骤强制"提案→审阅→实现→验证→接纳"闭环；消息走自建 JSONL 邮箱直送 + 队长 steer 即时唤醒 + 事件驱动调度 | DESIGN §3 |
| 性能强 | 增量上下文注入、角色上下文裁剪、避免重复读盘；单写者纪律消除冲突重试 | DESIGN §6 |
| 缓存命中高 | 三层缓存：协议状态缓存、仓库证据缓存（按 git HEAD + 文件 mtime 失效）、prompt 前缀稳定化（最大化 LLM provider 端 prompt cache 命中） | DESIGN §7 |
