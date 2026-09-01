# ARCHITECTURE.md — dsh-pair-programming 技术架构

> 本文回答"怎么实现"。模块划分、数据流、API 契约、与 DSH 宿主原语的集成点。
> **v1.1 修订**：零第三方插件依赖。插件自带完整结对运行时（团队状态、任务图、邮箱、事件驱动调度器），直接构建在 DSH 宿主原语上。成熟模式从 agent-teams 源码复刻适配（见 `05-reference/AGENT_TEAMS_API.md`，记录每个模式的出处）。

## 1. 总体分层

```
┌────────────────────────────────────────────────────────────┐
│ 用户面                                                      │
│  /pair slash command · 手势边界（消息开头 /pair）· 自然语言   │
├────────────────────────────────────────────────────────────┤
│ 协议层（本插件核心资产）                                      │
│  PairProtocol 状态机 · 角色 persona 模板 · 消息 DSL 解析     │
│  质量门禁 Gate · 风险单管理 · 决策日志 · 粒度控制器           │
├────────────────────────────────────────────────────────────┤
│ 工具层（注册进共享 tools 注册表）                             │
│  pair_start · pair_propose · pair_review · pair_report      │
│  pair_verify · pair_risk · pair_arbitrate · pair_gate_check │
│  pair_task_update · pair_rotate · pair_status · pair_stop   │
├────────────────────────────────────────────────────────────┤
│ 运行时层（自含，复刻 agent-teams 成熟模式）                   │
│  members: continuable 子 Agent 派生/唤醒/persona 注入        │
│  scheduler: agent/status 事件驱动的任务认领与邮箱投递         │
│  mailbox: JSONL 邮箱（append/unread/ack/claim/release）      │
├────────────────────────────────────────────────────────────┤
│ 状态层                                                      │
│  L1 协议状态（内存 + 写穿落盘，per-team 串行队列）            │
│  L2 证据缓存（落盘，sha256 key）· 决策日志/复盘报告           │
├────────────────────────────────────────────────────────────┤
│ 宿主原语（DSH base bundle，非第三方插件）                     │
│  ctx.subagents · ctx.tools · ctx.systemPrompt · ctx.agents  │
│  ctx.commands（可选懒加载）· ctx.llm · agent/status ·        │
│  agent/pre-step · session.append · Agent.steer              │
└────────────────────────────────────────────────────────────┘
```

## 2. 包结构与模块划分

```
@ericwang1358/dsh-pair-programming/
├── package.json
├── cordis.patch.yml              # bundle 挂载：insert 一行插件记录
├── lib/
│   ├── index.js                  # apply(ctx, config)：装配一切
│   ├── config.js                 # Config schema（schemastery）
│   ├── command.js                # /pair slash command + 手势边界
│   ├── prompt.js                 # systemPrompt section：协议使用策略（稳定前缀）
│   ├── protocol/
│   │   ├── machine.js            # 会话级状态机
│   │   ├── cycle.js              # Pair Cycle 编排
│   │   ├── messages.js           # [PAIR:*] DSL 编解码 + 校验
│   │   ├── gate.js               # 门禁检查清单执行器
│   │   ├── risks.js              # 风险单生命周期
│   │   └── personas.js           # 四角色模板（版本化）
│   ├── runtime/
│   │   ├── members.js            # 子 Agent 派生/唤醒/persona（复刻 agent-teams members.js）
│   │   ├── scheduler.js          # 事件驱动调度器（复刻 agent-teams scheduler.js）
│   │   └── mailbox.js            # JSONL 邮箱（复刻 agent-teams state.js 邮箱部分）
│   ├── state/
│   │   ├── lock.js               # withLock 串行队列 + sanitizeKey（复刻）
│   │   ├── atomic.js             # Windows 兼容原子写（复刻 replaceFileAtomicOrDirect）
│   │   ├── store.js              # L1 团队+协议状态读写、状态机校验、attempt 令牌
│   │   ├── evidence-cache.js     # L2 证据缓存
│   │   └── layout.js             # .pair-programming/ 目录布局
│   ├── tools/
│   │   ├── index.js              # 注册全部 pair_* 工具
│   │   ├── lifecycle.js          # pair_start / pair_stop / pair_rotate / pair_status
│   │   ├── flow.js               # pair_propose / pair_review / pair_report / pair_verify
│   │   ├── risk.js               # pair_risk
│   │   └── arbitrate.js          # pair_arbitrate / pair_gate_check / pair_task_update
│   ├── events.js                 # session 事件追加（复刻 agent-teams events.js 的容错模式）
│   └── types/
│       └── index.d.ts
└── README.md
```

**模块依赖规则**：`protocol/` 纯逻辑，不 import `runtime/`、`tools/`、cordis（可单测）；`state/` 不 import cordis；`runtime/` 依赖 `state/` + 宿主原语；`tools/` 是薄壳。

## 3. 关键集成点（与 DSH 宿主的接线）

### 3.1 挂载（cordis.patch.yml）

```yaml
- insert:
    - id: pair-programming
      name: '@ericwang1358/dsh-pair-programming'
      config:
        stateDir: .pair-programming
        maxCyclesPerTask: 12
        defaultMode: full        # full | light
        evidenceCache: true
        memberProvider: spawn    # ctx.subagents provider
        maxMembers: 4
```

安装：`dsh plugin --profile web add <path-or-name>`。`dsh plugin` 会 pnpm 安装并把 bundle reconciled 进 profile 的 `dsh.profile.bundles`。

### 3.2 插件入口（index.js）

```js
export const name = 'pair-programming';
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'];
// commands 用 ctx.inject(['commands'], ...) 懒加载（可选服务）

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  // 1. 安装成员模型选择桥（registerContinuableSetup）
  const selections = installMemberSelectionRuntime(ctx, resolved.stateDir);
  // 2. 安装事件驱动调度器（agent/status 监听）
  const scheduler = installPairScheduler(ctx, resolved);
  // 3. 注册全部 pair_* 工具
  registerPairTools(ctx, resolved, { selections, scheduler });
  // 4. 注入 systemPrompt section（order 可配，默认 118）
  ctx.systemPrompt.section({ name: 'pair-programming:usage', order: resolved.promptSectionOrder, text: usageSectionText() });
  // 5. /pair slash command（懒加载）+ 手势边界
  if (resolved.slashCommand ?? true) {
    ctx.inject(['commands'], (commandCtx) => registerPairCommand(commandCtx));
    installPairGestureBoundary(ctx);
  }
}
```

### 3.3 团队创建流程（pair_start 内部）

```
pair_start(goal, mode)
  ├─ 能力探测：ctx.subagents.getProvider(config.memberProvider)
  │    检查 prepareContinuable / capabilities.persona / capabilities.toolFilter
  │    缺失 → 明确报错（宿主 profile 缺陷，提示挂载 base bundle）
  ├─ 状态初始化：store.createTeam({ goal, mode, captainSessionId }) 落盘
  ├─ 派生成员（continuable 子 Agent，persona 注入角色协议）：
  │    spawnMember("driver")     — toolFilter 允许写工具
  │    spawnMember("navigator")  — toolFilter 拒绝写工具（只读+验证）
  │    spawnMember("challenger") — 同 navigator（light 模式跳过）
  ├─ L1 初始化 + 落盘
  └─ 进入 PLANNING：给 Challenger 发首条邮箱消息并唤醒（产出候选方案）
```

角色纪律的注入点：`startContinuable({ request: { persona: <角色协议全文>, toolFilter, ... } })`。persona 成为成员系统提示（整段替换部署 persona）——这是角色化的关键，且属于 L3 稳定前缀。

**toolFilter 实现单写者纪律的硬约束**：navigator/challenger 的 `toolFilter.deny` 包含文件写工具（`str_replace_editor`、`write_file`、`bash` 视配置），从宿主层物理阻断非 Driver 写文件——比纯 prompt 纪律强。

### 3.4 消息流转

- 协议消息 = 邮箱消息的 content，以 `[PAIR:<TYPE>]` 开头 + JSON 体。
- 发送：写入接收方 JSONL 邮箱（落盘，真相源）→ 若接收方是成员，经 `subagents.followup(captain, childId, ...)` 唤醒为新 turn；若接收方是 captain 且 live，经 `captain.steer(...)` 在最近模型步送达。
- 接收方成员被唤醒后，其 persona 指示它：用 messages.js 解析消息，按状态机响应，回复走同一 DSL。
- 每条协议消息同时追加为 captain session 事件（`session.append('pair/message-sent', ...)`，容错：harness 不认识该事件类型则跳过，见 events.js 模式），Web UI 可折叠协议时间线。

### 3.5 门禁强制（硬门禁，非 prompt 祈求）

任务系统是本插件自有的，`pair_task_update` 工具有效执行完成前在工具层校验：

```js
// pair_task_update(task_id, status, output?, gate_pass_id?)
if (status === 'completed') {
  const gate = store.latestGatePass(task_id);
  if (!gate || gate.id !== gate_pass_id || gate.stale) {
    throw new Error('GATE_FAIL: task cannot complete without a valid pair_gate_check pass — run pair_gate_check first');
  }
}
```

成员 persona 与队长 systemPrompt 都写明此纪律作为第二道防线；工具层是第一道。

### 3.6 证据缓存（L2）实现

```ts
interface EvidenceCache {
  getFileDigest(absPath: string): Promise<FileDigest | undefined>
  // key = sha256(gitHead + relPath + mtimeMs)；未命中时计算并写盘
  getTestBaseline(cmd: string): Promise<TestBaseline | undefined>
  // key = sha256(cmd + gitHead)
}
```

- 存储：`.pair-programming/cache/<key>.json`，单文件单条。
- 失效：key 内含 mtime/HEAD，天然精确失效；LRU 上限 500 条。
- 写入走 `atomic.js` 的原子写（Windows 兼容 rename 重试 + 直接写降级）。

### 3.7 L1 状态模型

```ts
interface PairTeamState {           // 落盘 team.json
  id: string; name: string;
  goal: string; mode: 'full' | 'light';
  captainSessionId: string;
  createdAt: number;
  members: PairMember[];            // { id, name, role, provider?, model?, status }
  tasks: PairTask[];                // 自含任务图（含 attemptId 能力令牌）
  taskSeq: number;
  protocol: PairProtocolState;      // 见下
}

interface PairProtocolState {
  phase: 'FORMING'|'PLANNING'|'CYCLING'|'TASK_GATE'|'RETRO'|'DONE';
  currentTaskId?: string;
  cycles: CycleRecord[];
  risks: RiskRecord[];              // OPEN/MITIGATED/CLOSED/WONTFIX
  decisions: DecisionRecord[];      // ARBITRATE 日志
  gatePasses: GatePassRecord[];     // gate_pass_id → 校验凭据
  stats: { noGo, reject, attacks, cacheHits, cacheMiss };
}
```

落盘：`.pair-programming/<teamId>/team.json`，每次 mutation 经 per-team 串行队列写穿（`lock.js`，复刻 `withTeamLock`）。

## 4. 工具 API 契约（model-facing）

全部经 `ctx.tools.register(defineTool({...}))` 注册，`defineTool` 来自 `@deepseek-ai/dsh-tools`。执行签名 `async execute(args, exec)`，`exec.agent` 是调用者 Agent，`exec.signal` 是取消信号。

| 工具 | 调用者 | 参数（要点） | 副作用 |
|---|---|---|---|
| `pair_start` | Captain(用户会话) | goal, mode? | 建团队+派生成员+L1 初始化，进入 PLANNING |
| `pair_propose` | Driver | task_id, intent, files[], verify_plan, uncertainty | 状态→PROPOSED；邮箱+唤醒 Navigator |
| `pair_review` | Navigator | cycle_id, verdict(go/no_go), evidence[], conditions?/required_changes? | 状态→GO 或回退；邮箱+唤醒 Driver |
| `pair_report` | Driver | cycle_id, diff_summary, test_results, deviations | 状态→IMPLEMENTED；邮箱+唤醒 Navigator |
| `pair_verify` | Navigator | cycle_id, verdict(accept/reject), evidence[] | 状态→VERIFIED；触发 Challenger 风险检查 |
| `pair_risk` | Challenger | action(raise/clear), severity, scenario, trigger, suggestion, ref? | 风险单变更；P0 即时 steer Captain |
| `pair_arbitrate` | Captain | conflict_ref, decision, evidence[], rationale | 决策日志落盘；通知相关方 |
| `pair_gate_check` | Driver/Captain | task_id | 跑门禁清单，通过则出具 gate_pass_id（落盘） |
| `pair_task_update` | Driver | task_id, status, output?, attempt_id, gate_pass_id? | 任务状态迁移；completed 需有效 gate_pass_id（硬校验） |
| `pair_rotate` | Captain | new_driver, handoff_note | 成员角色互换（更新 toolFilter 与 persona 提示） |
| `pair_status` | 任何人 | — | 协议快照（phase/cycle/risks/stats/邮箱预览） |
| `pair_stop` | Captain | reason? | RETRO 报告 + 中断成员 + 清理 |

任务认领：`pair_task_claim(task_id)` 返回 `attempt_id`（能力令牌），后续 `pair_task_update` 必须携带；reassign/rotate 撤销旧令牌防过期写入（复刻 agent-teams attempt 模式）。

## 5. Prompt 装配（L3 缓存命中高的关键）

### 5.1 稳定前缀原则

每个成员的系统提示 = `固定协议前缀（版本化常量，逐字不变）` + `角色模板（版本化）` + `动态尾部（当前任务/循环/新消息，只追加）`。

- 前缀与角色模板只在插件版本升级时变化 → 同版本内所有会话共享 provider 端 prompt cache。
- 动态内容由 continuable member 机制天然追加在会话尾部。

### 5.2 队长的使用策略 section

`ctx.systemPrompt.section({ name: 'pair-programming:usage', order: 118 })`：何时触发、pair_start 流程、门禁纪律（completed 需 gate_pass_id）、与用户插话的处理、降级行为。

### 5.3 激活双通道（复刻 agent-teams command.js）

- **slash command**：`ctx.inject(['commands'], c => c.commands.register({ name:'pair', handler }))`；handler 把用户原始行 replay 为 follow-up（`source.kind='user'`），手势边界再注入激活指令。
- **手势边界**：`ctx.on('agent/pre-step', ...)` 识别用户消息开头 `/pair` token（只扫 `source.kind==='user'`，防伪造），注入同一激活指令。覆盖 web/headless/SDK/粘贴文本。
- 激活指令只负责"切换到结对协议 + 携带 goal"，完整协议在 system prompt section。

## 6. 数据流（一个完整循环）

```
Driver Agent                    Navigator Agent                 Challenger Agent
     │ pair_propose ──────────►  │（邮箱+followup 唤醒）            │
     │                           │ pair_review(GO, evidence)       │
     │ ◄──────────────────────── │                               │（并行）
     │ 实现（唯一写者，toolFilter  │                               │ pair_risk(raise P1)
     │  保证只有它能写）           │                               │
     │ pair_report ───────────►  │ pair_verify(accept, evidence)   │
     │                           │ ──触发风险检查──►                │ pair_risk(clear P1)
     │ pair_gate_check ──► gate_pass_id                           │
     │ pair_task_update(completed, gate_pass_id) ✓ 硬校验通过       │
     ▼                            ▼                               ▼
  所有协议消息 → events.js → captain session 事件流 → Web UI 协议时间线
  所有状态变更 → state/store（写穿落盘）→ 崩溃恢复源
  成员 idle 边沿 → scheduler → 认领下一就绪任务 + 唤醒
```

## 7. 从 agent-teams 复刻的模式清单（MIT 许可，注明出处）

| 模式 | 出处（agent-teams 源文件） | 适配点 |
|---|---|---|
| per-key 串行 promise 队列 | state.js `withTeamLock` | `state/lock.js` 泛化为任意 key |
| Unicode 安全路径 key | state.js `sanitizeKey` | 直接复用 |
| Windows 原子写（rename 重试 + 直接写降级） | state.js `replaceFileAtomicOrDirect` / `atomicWriteText` | `state/atomic.js` |
| JSONL 邮箱（append/read/unread/claim/release/ack，delivery lease） | state.js `appendMailbox` 等 | `runtime/mailbox.js` |
| 任务状态机 + 迁移校验 | state.js `TASK_TRANSITIONS` / `transitionError` | `state/store.js`，状态集加 gate 相关 |
| attempt 能力令牌（activate/begin/invalidate） | state.js | `state/store.js` |
| continuable 成员派生 + persona + toolFilter | members.js `spawnMember` / `memberPersona` | `runtime/members.js` |
| 成员模型路由解析（同路由继承 effort） | members.js `resolveMemberLlmSelection` | `runtime/members.js` |
| 冷恢复模型选择桥（registerContinuableSetup + pending map） | members.js `installMemberSelectionRuntime` | `runtime/members.js` |
| 事件驱动调度（agent/status idle 边沿 + 原子认领 + 失败回滚） | scheduler.js 全文 | `runtime/scheduler.js` |
| 成员→队长 steer 即时报告 | tools.js `steerCaptainReport` | `runtime/members.js` |
| 双通道激活（command register + agent/pre-step 手势边界） | command.js 全文 | `command.js` |
| session 事件容错追加（未知类型跳过） | events.js `appendTeamEvent` | `events.js` |

## 8. 性能与缓存的工程落实

| 设计目标 | 工程手段 | 验证方式 |
|---|---|---|
| 交流频繁但不烧 token | 循环粒度控制器（3 连过→提示放大；打回 2 次→强制缩小）；每任务 12 循环硬上限 | ACCEPTANCE T6 |
| L1 写穿不丢状态 | per-team 串行队列 + 原子写 | 崩溃恢复测试 T9 |
| L2 命中 ≥90% | key 含 mtime+HEAD | retro.md 输出命中率 |
| L3 前缀命中 | 前缀逐字稳定 + 只追加；persona 模板带版本号 | 单测断言前缀一致 |
| 无 busy-poll | 事件驱动（agent/status + steer） | 代码审查 + 协议日志断言 |
| 单写者零冲突 | toolFilter 物理阻断非 Driver 写工具 | T2 测试 |

## 9. 兼容性落实清单

- [ ] 仅用 DSH 宿主原语：`subagents`、`tools`、`systemPrompt`、`agents`、`llm`、`commands`（可选）、session 事件
- [ ] 不 import 任何第三方插件（仅 `@deepseek-ai/*` 宿主包，作为 peerDependencies optional）
- [ ] 能力探测：`getProvider` + `prepareContinuable` + `capabilities.persona/toolFilter`；缺失报错提示挂载 base bundle
- [ ] 降级：状态目录不可写 → 无状态内存模式（门禁仍强制）；明示用户
- [ ] Node 引擎：`^22.19.0 || >=24`（与宿主对齐）
- [ ] Windows/Unix 路径兼容（`path` 模块；原子写已处理 Windows EPERM）

## 10. 风险与对策（架构级）

| 风险 | 对策 |
|---|---|
| 宿主 API 变动 | 只用 base bundle 稳定面；能力探测失败即明确报错，不静默坏 |
| 成员不遵守 DSL（模型自由发挥） | messages.js 宽松解析（提取 `[PAIR:*]` 头 + 容错 JSON）；失败按纯文本转发并提示重述 |
| 协议死锁（互等） | 每循环超时升级：N 步无进展→Captain 仲裁；gate 连续 3 次 FAIL→强制仲裁 |
| 状态文件损坏 | 从 session 事件流重放重建（事件 append-only） |
| token 成本超预期 | light 模式 + 循环上限 + RETRO 成本报告 |
| 非 Driver 成员违规写文件 | toolFilter 物理阻断（第一道）+ persona 纪律（第二道） |
