# AGENT_TEAMS_API.md — 底层 dsh-agent-teams 能力速查

> 来源：本机已安装的 `@nanmicoder/dsh-agent-teams@0.1.13`
> 路径：`C:\Users\Eric1\.dsh\profiles\web\node_modules\@nanmicoder\dsh-agent-teams`
> ⏳ **v3 注（历史参考）**：agent-teams 从来只是 MIT 复刻来源，运行期零依赖（v1.1 起自带运行时）。下文是 v1 时期从其源码提取的对接速查，保留为出处记录；新实现不照此对接，改协议先读 REDESIGN-v3。
>
> 本文是实现 `dsh-pair-programming` 时对接底座的权威参考（从 package.json、lib/*.d.ts、lib/*.js 源码提取）。（v1 口径，历史）

## 1. 挂载机制（bundle patch）

插件通过 profile 的 bundle 层挂载。agent-teams 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: agent-teams
      name: '@nanmicoder/dsh-agent-teams'   # 必须与 package.json name 一致
      config:
        stateDir: .agent-teams               # 状态目录：<workspace>/<stateDir>/<teamId>/
        memberProvider: spawn                # ctx.subagents provider：spawn 或 fork
```

安装命令：`dsh plugin --profile <name> add <pkg-or-path>`。`dsh plugin` 转发 pnpm 安装并把 bundle 加入 profile 的 `dsh.profile.bundles`。我们插件照此模式。

## 2. 插件入口契约（cordis）

```ts
export declare const name = "agent-teams";
export declare const inject: string[];                 // 依赖注入声明
export interface Config { stateDir?, memberProvider?, memberModel?, memberMaxDepth?, maxMembers?, promptSectionOrder?, slashCommand? }
export declare const Config: z<Config>;                // schemastery
export declare function apply(ctx: Context, config: Config): void;
```

`apply` 内做三件事（我们插件同构）：
1. 注册 `agent_teams_*` 工具进共享 `tools` 注册表；
2. `ctx.systemPrompt.section({ name: 'agent-teams:usage', order: 117, text })` 注入使用策略；
3. 注册 `/agent-teams` slash command + `agent/pre-step` 手势边界。

## 3. 模型-facing 工具（10 个）

| 工具 | 关键参数 | 要点 |
|---|---|---|
| `agent_teams_create` | name, description? | 调用者成为 captain；一人同时只带一队 |
| `agent_teams_add_member` | name, role?, provider?, model?, reasoning_effort? | **role 文本会拼进成员 persona**（关键集成点）。默认快照 captain 的 provider/model/effort；改路由则自动用目标模型默认 effort |
| `agent_teams_remove_member` | name | 安全移除：撤销 attempts、任务回池、中断当前 turn |
| `agent_teams_create_task` | subject, description?, dependencies?, assignee? | 依赖全部 completed 才可认领 |
| `agent_teams_reassign_task` | task_id, assignee(成员名或"captain"), reason? | 原子重试/转派/队长接管；撤销旧 attempt 防过期写入 |
| `agent_teams_claim_task` | task_id, assignee? | 返回 **attempt_id**（能力令牌），后续 update 必须携带；成员同时只能拥有一个未完成任务 |
| `agent_teams_update_task` | task_id, status(in_progress/completed/failed/cancelled), output?, attempt_id | 过期 attempt 被拒绝；终态不可变 |
| `agent_teams_send_message` | to("captain"或成员名), content, from? | 邮箱直发；captain 在线时 live steer 送达，成员被唤醒为新 turn。返回 delivered: live/wake/mailbox |
| `agent_teams_status` | — | 团队快照：成员活动 + 任务状态 + captain 可见全部邮箱 |
| `agent_teams_delete` | — | 中断全员、删除状态目录 |

## 4. 成员 persona 机制（角色化注入点）

`memberPersona(team, member, stateDir)` 生成成员系统提示，**整段替换**部署 persona。其中包含：

```
You are ${member.name}, a member of the multi-agent team "${team.name}" ...
with the role: ${member.role}     ← add_member 的 role 参数原样进入
```

外加固定工作规则（claim→work→update with attempt_id→report 的纪律）。

**对本插件的意义**：`pair_start` 调 `add_member` 时，把完整的角色协议（Driver/Navigator/Challenger 的职责、不变量、消息 DSL、输出模板）渲染进 `role` 字段，即可零修改底座实现深度角色化。注意 role 文本会成为成员系统提示的一部分 → 纳入 L3 稳定前缀管理（版本化、逐字稳定）。

成员是 **durable continuable subagent**：跨 turn、跨 harness 重启保持会话；captain 用消息唤醒它工作一个完整 turn。

## 5. 状态与并发模型

- 状态目录：`<workspace>/.agent-teams/<teamId>/`：`team.json` + `inbox/<agentKey>.jsonl`（每 agent 一个 JSONL 邮箱，仿 Claude Code AgentTeams）。
- 所有变更经 **per-team 串行队列**（`withTeamLock(key, fn)`）串行化 read-modify-write。
- `sanitizeKey(name)`：Unicode 字母数字保留，其余折叠为 `-`；纯符号名用 digest；超长截断+digest。我们的成员名（driver/navigator/challenger）是 ASCII，无此问题。
- 任务状态机：`TASK_TRANSITIONS` 定义合法迁移；终态无出边。`transitionError(current, next)` 校验。
- attempt 能力：`activateTaskAttempt` / `beginTaskAttempt` / `invalidateTaskAttempt`——撤销即旧 attempt_id 失效，防止"迟到写入覆盖新主人"。

## 6. 事件机制（Web UI 集成）

- 每次团队状态变更向 **captain 的 Session** 追加一条事件（即使操作者是成员），类型如 `AgentTeamsTeamCreated / MemberAdded / TaskCreated / TaskUpdated / MessageSent / TeamDeleted`。
- Web 客户端用 Conversation Node 机制从 session 日志确定性地折叠出任务树面板（与 `tool-workflow` 同机制）。
- `event-types.ts` 零 import 设计：宿主与浏览器程序都能加载类型。
- `appendTeamEvent(ctx, session, type, data)`：追加事件且容错（事件损坏不阻断工具执行）。
- **对本插件的意义**：我们用同款模式追加 `pair/*` 协议事件到 captain session，Web UI 即可获得协议时间线；`captainSessionOf(ctx, captainSessionId, fallback)` 可复刻用于解析 captain 的 live session。

## 7. 快照（activity panel）

`snapshot.js` 服务端组装面板数据：读落盘团队文件（真相源）+ 丰富 live subagent 活动。视觉任务状态：`blocked | open | running | completed`。即使模型跳过工具"仪式"（如忘调 update_task），面板仍反映盘上真实状态——**我们插件的 pair_status 也应以落盘状态为准**。

## 8. 激活双通道（slash + 手势）

`command.js`：
1. `ctx.commands.register('agent-teams', ...)`：web GUI slash 菜单列出；执行时把用户原始行 replay 为普通 follow-up（保持聊天可见），手势边界再注入激活指令。
2. `agent/pre-step` 监听：识别**用户消息开头**的 `/agent-teams` token（`source.kind === 'user'` 才扫描，注入/外部文本无法伪造）；句中提及不触发。覆盖 headless/API/粘贴文本。
3. `buildActivationDirective(goal)`：激活指令只负责"开启协议 + 携带 goal"，完整协议在 system prompt section。

我们插件的 `/pair` 完全复刻此模式（改命令名与指令文本）。

## 9. 队长被即时唤醒

`steerCaptainReport(captain, from, content)`：`Agent.steer()` 在 captain 运行中 targeting 下一步、空闲时唤醒新 turn，aborted activity 会被重分类为 next-turn——报告不必等 captain 整个编排 turn 结束。**这是"交流频繁"的底层保障**，我们的协议消息通知 Captain 时走同一路径（send_message 的 live 投递已内置）。

## 10. 配置默认值（对齐用）

- `memberMaxDepth` 默认 1（成员可再委托一层；0 禁止）
- `maxMembers` 默认 8（我们只用 3，余量充足）
- `promptSectionOrder` 默认 117（我们用 118，紧随其后）
- Node 引擎：`^22.19.0 || >=24`
