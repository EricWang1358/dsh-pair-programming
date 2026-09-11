# Pair Programming · 功能 UML 图集

实现快照：`408196b`，编制日期 2026-09-11。六张 Mermaid UML 图，中文说明配英文实现名称，适合架构讲解及功能汇报。

**读法：** 当前项目以 ES modules、函数和普通对象实现。类图中的 `<<module>>` 是模块的逻辑接口视图，`<<record>>` 是持久化数据结构，`<<runtime>>` 是运行时对象；不意味着源码定义了同名 JavaScript class。实线箭头表示关联，虚线箭头表示依赖，实心菱形表示记录中的组成关系。角色是运行席位，不通过继承关系表达。为可读性省略非关键字段、锁细节和消息；时序图展示主要合法路线，不是逐调用日志。

## 01 · 类图：插件如何组织运行

**讲解重点：** 工具处理用户和角色请求，协议模块推导规则，调度器通过宿主与信箱交付工作，状态存储承载事实。

```mermaid
classDiagram
direction LR
class Plugin {
  <<module>>
  +apply(ctx, config)
}
class PairTools {
  <<module>>
  +registerLifecycleTools()
  +registerFlowTools()
  +registerTaskTools()
  +registerIntegrationTools()
}
class Protocol {
  <<module>>
  +obligationFrontier(team)
  +gateStateFingerprint(team, taskId)
  +advancePhase(protocol, phase)
}
class Scheduler {
  <<runtime>>
  +trackTeam(workspace, teamId)
  +kickTeam(workspace, teamId)
  +kickMember(workspace, teamId, member)
  +heartbeat()
}
class TeamStore {
  <<module>>
  +readTeam(root, id)
  +writeTeam(root, team)
  +inspectTeams(root)
}
class MailDelivery {
  <<module>>
  +prepareMailboxDelivery()
  +finishMailboxDelivery()
  +coalesceWake()
}
class DshHost {
  <<external>>
  tools
  agents
  subagents
  skills
}
Plugin ..> PairTools : 注册工具
Plugin ..> Scheduler : 安装调度
Plugin ..> DshHost : 注入服务
PairTools ..> Protocol : 校验与推导
PairTools ..> TeamStore : 读取和提交状态
PairTools ..> Scheduler : 请求推进
PairTools ..> MailDelivery : 协议消息
Scheduler ..> Protocol : 推导下一步义务
Scheduler ..> TeamStore : 读取最新看板
Scheduler ..> MailDelivery : 选取并确认投递
Scheduler ..> DshHost : 唤醒运行席位
MailDelivery ..> DshHost : 实际消息交付
note for Protocol "规则推导和宿主操作分开；组合视图包含多个 protocol 模块。"
note for TeamStore "看板与信箱是持久记录；内存中没有成员不等于没有未结束团队。"
```

实现依据：`lib/index.js`、`lib/tools/shared.js`、`lib/runtime/scheduler.js`、`lib/runtime/mail-delivery.js`、`lib/state/store.js`。

## 02 · 类图：任务、周期与完成证据

**讲解重点：** Task 完成、Cycle 验收和团队 DONE 是三个不同层次。Task 通过 ID 引用凭证；Cycle 和 GatePass 实际保存在 ProtocolState 中。

```mermaid
classDiagram
direction TB
class Team {
  <<record>>
  id
  captainSessionId
  mode
  artifactNamespace
}
class Member {
  <<record>>
  id
  name
  role
  status
}
class Task {
  <<record>>
  id
  status
  assignee
  attemptId
  workspace
  acceptanceRefs
  gatePassId
}
class Oracle {
  <<record>>
  files
  cmd
  sha
  frozenAt
}
class ProtocolState {
  <<record>>
  phase
  risks
  decisions
}
class Cycle {
  <<record>>
  id
  taskId
  step
  owner
  proposal
  green
  report
  verify
}
class GatePass {
  <<record>>
  id
  taskId
  binding
}
class ParallelState {
  <<record>>
  baseHead
  verificationCommand
  runtimePaths
  pending
}
class WorktreeSlot {
  <<record>>
  path
}
class IntegrationRecord {
  <<record>>
  candidate
  head
  checks
  at
}
Team "1" *-- "0..*" Member : members
Team "1" *-- "0..*" Task : tasks
Team "1" *-- "1" ProtocolState : protocol
Task "1" *-- "0..1" Oracle : oracle
ProtocolState "1" *-- "0..*" Cycle : cycles
ProtocolState "1" *-- "0..*" GatePass : gatePasses
Cycle "0..*" --> "1" Task : taskId
Task "0..*" --> "0..1" Member : assignee 指向 name
Task "0..1" --> "0..1" GatePass : 当前 gatePassId
Team "1" *-- "0..1" ParallelState : parallel
ParallelState "1" *-- "2" WorktreeSlot : 双 Driver slots
ParallelState "1" *-- "0..*" IntegrationRecord : integrations
IntegrationRecord "0..1" --> "1" Task : 按 taskId 存储
note for Task "Solo 情况可由 Captain 担任执行者；并非所有 assignee 都对应 members 中的一席。"
note for GatePass "binding 关联候选及任务上下文；历史凭证存在，不代表当前仍有效。"
note for ParallelState "仅双 Driver 团队存在。物理隔离不代替组合行为验收。"
```

实现依据：`lib/protocol/machine.js`、`lib/tools/task.js`、`lib/protocol/gate.js`、`lib/runtime/worktrees.js`、`lib/tools/integrate.js`。关联基数表达正常运行记录，不替代存量数据校验规则。

## 03 · 类图：当前 CE 集成边界

**讲解重点：** 现有 CE 是可选技能目录、加载记录及窄范围推送；尚不是计划 L 中可替换的通用审查结果接口。

```mermaid
classDiagram
direction LR
class CeProvider {
  <<runtime>>
  +list(options)
  +get(candidate, options)
}
class CeCatalog {
  <<module>>
  CE_SKILLS
  +entriesFor(options)
}
class CeCheckout {
  <<external>>
  skills
  version
  commitSha
}
class CeLedger {
  <<module>>
  +appendCeLoad(root, entry)
  +readCeLoads(root, since)
}
class CeWatch {
  <<module>>
  +installCeLoadWatch(ctx)
}
class CePush {
  <<module>>
  +pushPhaseOf(team)
  +cePushAppendix(deps)
}
class MemberRecycle {
  <<module>>
  +recycleMember()
}
class GateCheck {
  <<module>>
  ceLoads
}
CeProvider ..> CeCatalog : 能力白名单
CeProvider ..> CeCheckout : 读取正文
CeProvider ..> CeLedger : onLoad 接线记账
CeWatch ..> CeLedger : 观察宿主 skill 加载
MemberRecycle ..> CePush : 组合 persona
CePush ..> CeProvider : 经 runtime.ce.load
GateCheck ..> CeLedger : 读取加载与违规信息
note for CePush "只在 full 档、Driver、post-green 等条件下推送；不是每个角色的阶段审查接口。"
note for GateCheck "加载记录不等于完成审查。新 Skill 结果契约尚待实现。"
```

实现依据：`lib/integrations/ce-provider.js`、`ce-catalog.js`、`ce-push.js`、`ce-watch.js`、`ce-ledger.js`、`lib/runtime/recycle.js`、`lib/tools/arbitrate.js`。

## 04 · 时序图：单 Driver 的验收优先循环

**场景：** light 模式，一位 Driver 与一位 Navigator；采用先领取、再冻结 oracle 的合法路线。单工作区也允许在受约束的窗口提前准备验收。

```mermaid
sequenceDiagram
autonumber
actor C as Captain
participant T as Pair 工具
participant B as 看板与信箱
participant D as Driver
participant N as Navigator
participant X as 验证命令执行器
C->>T: pair_start(use_cases)
T->>B: 保存团队与初始协议
C->>T: pair_task_create(AC、依赖、范围)
T->>B: 保存任务
D->>T: pair_task_claim(task_id)
T->>B: 记录 assignee 与 attempt
N->>T: pair_oracle_write / pair_oracle
T->>X: 执行基线验收命令
X-->>T: 基线失败及输出
T->>B: 冻结 oracle 文件摘要与契约
loop 一个或多个实现增量
  D->>T: pair_propose(files, verify_plan)
  alt 满足小步 auto-GO 条件
    T->>B: 记录自动 GO
  else 需要显式审查
    N->>T: pair_review
    Note over N,T: 只有 GO 才进入后续实现；NO_GO 留待处理
  end
  D->>D: 修改代码并执行相关检查
  D->>T: pair_green(证据, diff_summary)
  T->>B: 保存 GREEN 与折叠报告
  N->>N: 独立检查实际改动与原有行为
  N->>T: pair_verify(stage)
  T->>X: checkpoint 命令或 final 冻结 oracle
  X-->>T: 执行结果
  alt 有效产品结果为 REJECT 或存在反例
    T->>B: 记录拒绝及证据
    Note over D,N: 同一周期修复，再提交 GREEN 和验证
  else checkpoint 通过
    T->>B: 记录增量验证
    Note over D,N: 可进入下一增量，但不能代替 final
  else final ACCEPT
    T->>B: 保存候选绑定的最终接受
  end
end
D->>T: pair_gate_check(task_id)
T->>X: 重放验收及配置的 DoD 检查
T->>B: 满足条件后签发 gate_pass_id
D->>T: pair_task_update(completed, gate_pass_id)
T->>B: 保存任务完成
C->>T: 处理披露、必要的重新认证、pair_retro
C->>T: pair_stop(complete, green_build_command)
T->>X: 实际执行团队完成命令
alt 全部终局条件满足且命令成功
  T->>B: 保存 DONE 和 completion_receipt
  T-->>C: 完成回执
else 仍有缺口或命令失败
  T-->>C: 拒绝签发成功回执
end
```

边界：取消、候选漂移、基础设施错误可能直接拒绝验证调用，不应当作产品 REJECT；oracle-first 的 GREEN 已携带报告，不强制再走单独 REFACTOR。消息由调度/投递层交付，此图省略每一次唤醒。

## 05 · 时序图：双 Driver 并行与串行集成

**讲解重点：** 实现可并行；共享 Navigator 的审阅与 Captain 的集成不是两个同时运行的独立席位。任一任务就绪即可请求集成，不强制等待另一席。

```mermaid
sequenceDiagram
autonumber
actor C as Captain
participant T as Pair 工具
participant A as Driver A / worktree A
participant D as Driver B / worktree B
participant N as 共享 Navigator
participant W as Git worktree 运行模块
participant B as 持久看板
C->>T: pair_start(drivers=2, integration_command)
T->>W: 从干净 Git checkpoint 创建两个工作区
T->>B: 保存 slots、baseHead 与任务范围
A->>T: 领取独立任务 A
D->>T: 领取独立任务 B
N->>T: 在 A 的工作区冻结 oracle A
N->>T: 在 B 的工作区冻结 oracle B
Note over A,N: 各提案先获得 GO；共享审阅席位可排队
par 独立实现 A
  A->>A: 修改 A 工作区并检查
  A->>T: pair_green(A)
and 独立实现 B
  D->>D: 修改 B 工作区并检查
  D->>T: pair_green(B)
end
N->>T: pair_verify(A, final)
A->>T: pair_gate_check(A)
T-->>C: A 已有有效 gate，可以集成
C->>T: pair_integrate(A)
T->>T: 获取团队集成锁，检查候选绑定
T->>W: snapshotCandidate / integrateCandidate
W->>W: 在临时工作区合并候选
W->>T: verify(临时组合树)
T->>T: 重放相关 oracle 与 integration_command
alt 冲突、漂移或检查失败
  T-->>C: 拒绝集成，不返回成功回执
  Note over W,B: 冲突或验证失败不推进 canonical；保留可诊断记录
else 组合验证成功
  T-->>W: 验证完成
  W->>W: 检查条件并推进 canonical
  W-->>T: 合并结果
  T->>B: 保存 integration record
  T-->>A: 集成回执，可完成任务 A
  A->>T: pair_task_update(A, completed)
end
N->>T: pair_verify(B, final)
D->>T: pair_gate_check(B)
C->>T: pair_integrate(B)
Note over T,W: 同一集成锁串行执行；组合检查包含先前已集成验收
Note over C,B: 两项分别完成后，再做最终树认证、复盘和团队 stop
```

这是 A 先就绪的一种调度顺序，B 可以先集成。低层文件操作与看板持久化仍有各自失败边界，此图不宣称跨 Git 与 JSON 存储存在数据库式原子事务。

## 06 · 时序图：新会话冷接管已有团队

**讲解重点：** 接管保留工作成果，替换运行成员身份；不是重新建项目。仅演示显式 `resume_team`，原 Captain 的自然恢复是另一条入口。

```mermaid
sequenceDiagram
autonumber
actor C as 新 Captain 会话
participant T as pair_start / resumeTeam
participant B as 持久看板
participant H as DSH 宿主
participant S as Scheduler
C->>T: pair_status(list_runs=true)
T->>B: 查找已有团队
T-->>C: team_id、旧 Captain、阶段与进度
C->>T: pair_start(resume_team, resume_from_captain)
T->>T: 锁定工作区启动与目标团队
T->>B: 严格读取目标团队
T->>H: 检查旧 Captain / 成员是否仍加载
T->>B: 检查其他团队占用
alt 团队终态、旧席位仍加载或其他前置条件不满足
  T-->>C: 拒绝接管，说明原因
else 满足冷接管条件
  Note over T,B: 双 Driver 还检查原工作区、slots 和待处理集成
  T->>T: 克隆原看板并设置新 Captain
  loop 每个未移除的成员
    T->>H: 解析路由并创建新席位
    H-->>T: 新成员身份
    T->>T: 迁移匹配的未结周期 owner
  end
  alt 创建失败或身份无效
    T->>H: 清理本次已创建成员
    T-->>C: 接管失败，原看板不被替换
  else 创建成功且再次检查通过
    T->>B: 写入新成员与 handoff 记录
    T->>H: 退休原成员
    T->>S: trackTeam(workspace, teamId)
    T-->>C: 返回原进度，要求读取当前状态
    S->>B: 读取当前义务
    Note over C,S: 从已有状态继续；不重建任务和 oracle
  end
end
```

恢复只迁移符合当前 task / attempt 条件的未结周期拥有者；已接受的历史证据保留。旧会话失权和实际宿主兼容性需要相应验收，图示不能替代运行证据。

## 展示范围与当前限制

- 图 01、02、04、05 用于介绍主要功能；图 03、06 用于解释扩展边界与恢复语义。
- 新 Skill 的通用结果契约、来源替换和阶段触发仍属于计划 L，不画成已实现功能。
- 本轮此前审查发现的暂停心跳竞态、损坏看板占用扫描、根目录运行数据复制问题，不能由这些功能图推定已修复；修复状态需另行核对。
- 这里展示的是当前实现，不是经过重新设计的理想架构。后续重构时应更新关系和失败分支，不能只更新版本文字。
