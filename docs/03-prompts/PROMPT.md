# PROMPT.md — 实现启动 Prompt

> **⚠️ 历史文档（v1.0）**：本 prompt 已完成其使命，插件已实现于 `../dsh-pair-programming/`。其中关于 `@nanmicoder/dsh-agent-teams` 作为**前置依赖/桥接对象**的表述已过时——v1.1 起插件自带独立结对运行时（仅从 agent-teams 的 MIT 源码复刻模式，运行零依赖）。v1.2 起协议为 PROTOCOL_VERSION=2：Pair Cycle 增加 Test-First（RED→GREEN→REFACTOR）与任务用户故事/INVEST 校验、结构化反馈三段式、可配置 DoD 门禁、绿构建、strong/ping-pong 风格、spike/trivial。当前权威描述见 `../01-design/DESIGN.md` §12、`04-acceptance/ACCEPTANCE.md`（T1–T14）与插件 README。v3 起协议为 PROTOCOL_VERSION=3（oracle-first：SPEC-FORK 冻结验收、计算判决、门禁亲跑命令）——v2 的"三常驻席位、Driver 自写 RED、数证据字符串的门禁"已被取代，推导见设计侧 `01-design/REDESIGN-v3.md`；两处冲突以代码与 REDESIGN-v3 为准。

> 使用方法：打开一个新 session，把下面「=== PROMPT 开始 ===」到「=== PROMPT 结束 ===」之间的**全部内容**复制粘贴发送。
> 前置条件（v1.0 原文，已由 v1.1 取代）：目标机器已装 `@deepseek-ai/dsh`；不再要求安装 `@nanmicoder/dsh-agent-teams`。
> 设计文档位置：`D:\A\1NUS\1Sem\dsh-better-pairprograming\dsh-pair-programming-design\`（实现时可随时查阅）。

=== PROMPT 开始 ===

# 任务：实现 DSH 插件 dsh-pair-programming（Agile 结对编程协议层）

你是一名资深 DSH 插件架构师。请完整实现一个名为 `dsh-pair-programming` 的 DSH 插件，把 Agile 结对编程固化为有质量门禁的多 Agent 协作协议。设计已完成，你的职责是**忠实实现设计、补齐工程细节、自测交付**。

## 0. 必读材料（按顺序）

设计文档在 `D:\A\1NUS\1Sem\dsh-better-pairprograming\dsh-pair-programming-design\`：

1. `README.md` — 总览与角色概念
2. `01-design/DESIGN.md` — 总体设计：角色不变量、Pair Cycle 协议、门禁、状态机、缓存、性能、兼容性、降级。**这是需求权威来源**
3. `02-architecture/ARCHITECTURE.md` — 技术架构：模块划分、工具 API 契约、集成点、数据流。**这是实现蓝图**
4. `05-reference/AGENT_TEAMS_API.md` — 底层 agent-teams 能力速查（从本机已安装源码提取的权威参考）
5. `04-acceptance/ACCEPTANCE.md` — 验收标准。**完成定义 = T1–T10 全过**

底层插件源码（可读，**禁止修改**）：`C:\Users\Eric1\.dsh\profiles\web\node_modules\@nanmicoder\dsh-agent-teams`。重点参考：`lib/index.js`（apply 装配模式）、`lib/command.js`（slash + 手势边界）、`lib/members.js` 的 `memberPersona`（role 注入点）、`lib/state.js`（withTeamLock 串行写模式）、`lib/events.js`（session 事件追加）。

## 1. 核心需求摘要（设计的灵魂，不可丢失）

1. **四角色**：Captain（当前会话，仲裁者）、Driver（唯一写代码者）、Navigator（审阅+门禁）、Challenger（对抗性风险挖掘，light 模式可省）。
2. **Pair Cycle 闭环**：每个小变更必须走 PROPOSE → REVIEW(GO/NO_GO) → IMPLEMENT → REPORT → VERIFY(ACCEPT/REJECT) → RISK_CHECK → GATE。协议消息以 `[PAIR:<TYPE>]` 开头的 DSL 承载，走 agent-teams 邮箱。
3. **工具强制门禁**：任务 completed 前必须有 `pair_gate_check` 出具的 GATE_PASS；检查清单：全部循环有 ACCEPT、无 OPEN 的 P0/P1 风险、验证命令最近通过、决策日志已更新。
4. **单写者纪律**：只有 Driver 改文件；Navigator/Challenger 的建议以提案形式交给 Driver 落地。这消除了合并冲突，是性能优势而非限制。
5. **缓存三层**：L1 协议状态（内存+写穿落盘，per-team 串行队列）；L2 仓库证据缓存（key=sha256(gitHead+path+mtime)，落盘 `.pair-programming/cache/`）；L3 prompt 缓存友好（角色前缀逐字稳定+版本化，动态内容只追加）。
6. **功能独立**：独立 npm 包 + 独立 cordis.patch.yml + 独立状态目录 `.pair-programming/`；不 import、不修改 agent-teams 内部模块，只调用其 `agent_teams_*` 公开工具与事件机制。
7. **兼容与降级**：启动能力探测；agent-teams 不可用→纯 prompt 模式；文件系统不可写→无状态模式；降级在会话开头明示。slash command + 手势边界双通道激活（覆盖 web/headless/SDK）。
8. **交流频繁但受控**：循环粒度自适应（3 连过→可放大；打回 2 次→强制缩小）；每任务 12 循环硬上限，超限 Captain 向用户请示；Captain 事件驱动监控，禁止 busy-poll。

## 2. 交付物

在你选择的工作目录创建插件仓库（建议 `dsh-pair-programming/`），结构按 ARCHITECTURE.md §2：

- `package.json`（name 建议 `@ericwang1358/dsh-pair-programming`，type: module，engines 对齐 `^22.19.0 || >=24`，exports 含 `./cordis.patch.yml`）
- `cordis.patch.yml`（insert 一行 bundle 记录，config 含 stateDir/maxCyclesPerTask/defaultMode/evidenceCache）
- `lib/` 全部源码（ESM JavaScript 或构建后的 JS + .d.ts；若用 TypeScript 需自带构建脚本并提交构建产物）
- `README.md`（安装、使用、模式说明、降级说明）

## 3. 实现阶段（按序执行，每阶段自测后再推进）

**阶段 A — 骨架与挂载**
1. 创建包骨架；写 `cordis.patch.yml`。
2. `lib/index.js` 实现 `apply(ctx, config)`：注册工具、systemPrompt section（order 118）、slash command + 手势边界。先空实现工具体。
3. 本地安装验证：`dsh plugin --profile web add <插件目录>`，`dsh web` 启动无报错，`/pair` 出现在 slash 菜单。

**阶段 B — 状态层**
4. `state/layout.js`：`.pair-programming/<teamId>/` 目录布局（state.json、cache/、retro.md、decisions.md）。
5. `state/store.js`：L1 状态模型（PairSessionState/CycleState，见 ARCHITECTURE §3.6）+ per-team 串行队列写穿（复刻 agent-teams `withTeamLock` 模式）+ 原子写（tmp+rename）。
6. `state/evidence-cache.js`：L2 缓存（sha256 key、单文件单条、LRU 500、原子写）。
7. 单测：状态读写、串行并发、缓存命中/失效（mtime 变化）、前缀稳定性（同一角色两次渲染逐字一致）。

**阶段 C — 协议层（纯逻辑，不依赖 cordis）**
8. `protocol/messages.js`：`[PAIR:*]` DSL 编解码 + schema 校验 + 宽松解析（提取头部 + 容错 JSON，失败按纯文本转发并提示重述）。
9. `protocol/personas.js`：四角色模板（含职责、不变量 I1–I6、输出模板、消息格式），带版本号常量。
10. `protocol/machine.js` + `cycle.js`：会话状态机与循环编排。
11. `protocol/gate.js` + `risks.js`：门禁清单执行器、风险单生命周期。
12. 单测：状态机迁移、门禁通过/失败路径、风险升级、DSL 容错解析。

**阶段 D — 工具层与桥接**
13. `bridge/agent-teams.js`：封装 `agent_teams_*` 调用 + 能力探测（probe）。
14. 实现全部 `pair_*` 工具（契约见 ARCHITECTURE §4），薄壳委托 protocol/state/bridge。
15. `bridge/events.js`：协议事件追加到 captain session（复刻 agent-teams 事件模式，类型前缀 `pair/`）。

**阶段 E — 集成与端到端**
16. `pair_start` 全流程：探测→建队→三成员（role 注入完整角色协议）→PLANNING 首消息。
17. 门禁强制链路：`pair_report`/`pair_gate_check` 与 Captain 协议 prompt 的配合（ARCHITECTURE §3.4）。
18. 降级路径：探测失败→纯 prompt 模式；状态目录不可写→无状态模式；会话开头明示当前模式。
19. RETRO 报告生成（协议统计 + 缓存命中率 + 成本估计）。

**阶段 F — 验收**
20. 按 ACCEPTANCE.md 执行 T1–T10，逐项记录结果；修复直至全过。
21. 卸载测试：remove 后 agent-teams 正常。

## 4. 工程纪律

- **先读后写**：动手前读完必读材料；对 agent-teams 源码只读不改。
- **小步提交**：每阶段完成后 `git init`（若未初始化）并 commit，信息含阶段号。
- **不臆造 API**：对 cordis/dsh 的 API 不确定时，读本机已装包的源码/类型定义确认（dsh 本体在 `D:\Program Files\nodejs\node_global\node_modules\@deepseek-ai\dsh`，agent-teams 路径如上）；禁止凭记忆编造。
- **Windows 环境**：路径一律 `path` 模块处理；shell 是 Git Bash。
- **遇到设计空白**：设计文档未覆盖的细节，按"降级优于报错、证据优于意见、组合优于重造"的哲学自行决断，并在交付说明中记录决策。
- **禁止事项**：不修改 agent-teams 任何文件；不在插件里内置特定语言/框架的测试知识（验证命令在 PLANNING 阶段按仓库现状探测）；不引入 busy-poll。

## 5. 交付说明（最后输出）

完成时输出：
1. 插件目录绝对路径与安装命令；
2. T1–T10 逐项结果（通过/未过+证据）；
3. 与设计文档的偏差清单及理由；
4. 已知限制与后续建议。

现在开始。先读必读材料，然后从阶段 A 开工。

=== PROMPT 结束 ===
