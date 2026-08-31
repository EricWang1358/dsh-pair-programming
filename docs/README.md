# dsh-pair-programming 插件设计方案

> 版本：v1.0 ｜ 日期：2026-08-31 ｜ 状态：待实现
> 作者：插件设计 / 架构方案
> 目标读者：下一个 session 的实现者（你只需读 `03-prompts/PROMPT.md` 即可开工）

## 这是什么

`dsh-pair-programming` 是一个 DSH（DeepSeek Harness）插件，把 **Agile 结对编程（Pair Programming）** 固化为一套可重复、可审计、有质量门禁的多 Agent 协作协议。**零第三方插件依赖**：自带独立的结对运行时（团队状态、任务图、邮箱、事件驱动调度器），直接构建在 DSH 宿主原语之上；成熟模式（串行锁、原子写、邮箱、能力令牌）从 agent-teams 源码复刻适配（MIT）。

核心理念：**三线程并行去最优** —— 不让单一 Agent 一路写到底陷入局部最优，而是用三个持续在线的角色互相质疑、即时纠偏：

| 角色 | 职责 | 类比 |
|---|---|---|
| **Driver（驾驶员）** | 唯一能改代码的 Agent；小步快走，每步先报方案再动手 | 握键盘的人 |
| **Navigator（领航员）** | 持续审阅 Driver 的每一步，拥有"验收/驳回"权，不直接写实现 | 看地图、抓错的人 |
| **Challenger（挑战者）** | 独立提出替代方案、攻击面、失败模式；与 Navigator 并行，不重复实现 | 红队 / 魔鬼代言人 |
| **Captain（队长，即当前会话）** | 仲裁分歧、基于仓库证据选最优路径、对用户负责 | Scrum Master / Tech Lead |

## 文件夹结构

```
dsh-pair-programming-design/
├── README.md                    ← 你在这里（总览 + 索引）
├── 01-design/
│   └── DESIGN.md                ← 总体设计：角色协议、状态机、质量门禁、缓存、性能、兼容性
├── 02-architecture/
│   └── ARCHITECTURE.md          ← 技术架构：模块划分、数据流、API、宿主原语集成点
├── 03-prompts/
│   └── PROMPT.md                ← ★ 实现启动 prompt，复制粘贴到新 session 即可开工
├── 04-acceptance/
│   └── ACCEPTANCE.md            ← 验收标准、测试计划、Definition of Done
└── 05-reference/
    └── AGENT_TEAMS_API.md       ← agent-teams 成熟实现调研（复刻模式的来源与参考）
```

## 快速开始（给实现者）

1. 打开一个新的 ZCode session，工作目录设为你要存放插件源码的位置。
2. 把 `03-prompts/PROMPT.md` 的完整内容粘贴进去，发送。
3. 实现者会按 prompt 里的阶段清单逐步实现、自测、交付。

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
