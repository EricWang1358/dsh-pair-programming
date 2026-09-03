# ACCEPTANCE.md — 验收标准与测试计划

> ⏳ **v3 导读（2026-09-03，PROTOCOL_VERSION=3）**：下文 T1–T14 是 v1/v2 验收，保留为历史，不再是完成定义。
> 当前完成定义见设计侧 `04-acceptance/ACCEPTANCE.md`（v3 正文，T1–T20，自动化项标注覆盖套件）：验收标准先于实现冻结，每一次判决都是一次重新执行；
> 在 v3 对三个已封存失败实例重跑之前，不宣称正确性提升，只宣称关掉了那些失败经由的机制。
>
> 实现完成 = 本文件全部勾选项通过。（v1/v2 口径，历史）
> **v1.1 修订**：插件自带结对运行时，**不再依赖** `@nanmicoder/dsh-agent-teams`；测试在装有 `@deepseek-ai/dsh` 的 profile 上进行即可（agent-teams 若存在仅作共存检查）。
> **v1.2 修订**：新增课程理念层验收项 T11–T14（Test-First 循环、INVEST 故事、结构化反馈、绿构建+复盘继承）。

## 1. Definition of Done

- [ ] `dsh plugin --profile web add <本地路径>` 安装成功，`dsh web` 启动无报错
- [ ] `/pair <goal>` 在 Web UI slash 菜单可见、可执行；纯文本开头输入 `/pair ...` 也能激活（手势边界）
- [ ] 全部 `pair_*` 工具（18 个）出现在工具注册表且参数校验工作
- [ ] 下方 T1–T14 测试全部通过
- [ ] 卸载插件后其他插件（含 agent-teams，若装有）功能不受影响

## 2. 功能测试

### T1 完整结对流程（happy path）
给一个真实小需求（如"给这个 Express 应用加一个 /health 端点，带测试"）。
- [ ] 自动创建团队 + 3 个成员（driver/navigator/challenger），各自 persona 含角色协议（PROTOCOL_VERSION=2）
- [ ] PLANNING 阶段以用户故事建任务；产出 ≥2 个候选方案与攻击面分析，Captain 裁决并记录理由
- [ ] 至少经历 3 个完整 Pair Cycle，每个循环可见 PROPOSE→GO→RED→GREEN→REFACTOR→ACCEPT 记录（tddMode=enforce）
- [ ] 任务 completed 前存在对应 GATE_PASS 记录
- [ ] pair_retro 产出 retro.md（含协议统计：no_go/reject/attack 计数、拒绝原因分类、缓存命中率）与 keep/try 行动项

### T2 门禁强制
- [ ] 构造 Driver 未获 GO 就实现的场景 → Navigator 可判无效并要求回滚，协议日志有记录
- [ ] 构造存在 OPEN P1 风险时尝试完成任务 → pair_gate_check 返回 GATE_FAIL 且逐项列明
- [ ] 连续 3 次 GATE_FAIL → 自动升级 Captain 仲裁

### T3 风险单生命周期
- [ ] Challenger 发起 P0 → Captain 即时收到通知
- [ ] Driver 修复 + Navigator 确认 → 风险 CLOSED
- [ ] Captain 可裁决误报 → WONTFIX + 理由落盘

### T4 轻量模式
- [ ] `/pair --light <goal>` 或"轻量结对"：只建 driver+navigator；RETRO 按需（可用 pair_retro 手动补）

### T5 中途轮换（rotate）与风格
- [ ] `pair_rotate` 后新 Driver 收到 handoff note（进度/风险/下一步/易错点），原 Driver 交还写入角色
- [ ] `--style=strong|ping-pong` 时成员 persona 含对应风格语义（口述-执行 / 交替所有权），I1 单写者不被破坏

### T6 粒度自适应与预算护栏
- [ ] 连续 3 个循环一次通过 → 协议提示可放大粒度（日志可见）
- [ ] 单任务达 12 循环 → Captain 暂停并向用户请示（继续/简化/接管）
- [ ] spike 任务超 `spikeMaxCycles`（默认 2）→ 预算拒绝，完成需门禁 `spike_outcome` 记录决策

### T7 用户插话
- [ ] CYCLING 中途用户提新约束 → Captain 翻译为协议动作并通知全员，流程不崩

### T8 多任务依赖
- [ ] PLANNING 拆出带依赖的任务图；依赖未完成时后继任务不可认领（插件自含任务图语义）

## 3. 韧性测试

### T9 崩溃恢复
- [ ] CYCLING 中途杀掉 DSH 进程并重启 → 团队状态从 `.pair-programming/` 恢复，未关闭循环回到 REVIEW 步骤，成员可续聊
- [ ] 人为损坏 state.json → 能从 session 事件流重放重建（或明确降级并提示）

### T10 降级
- [ ] 宿主子代理原语不可用（模拟 spawn 失败）→ 插件进入纯 prompt 模式并在会话开头明示
- [ ] `.pair-programming/` 不可写 → 无状态模式，功能可继续（无缓存无日志）
- [ ] 旧版持久化状态（cycle 无 tddMode 戳、NO_GO 携带 legacy required_changes）→ 可继续读取与走完旧链（向后兼容）

## 4. v1.2 课程理念层验收

### T11 Test-First 强制（I7）
- [ ] enforce 模式下 `pair_report` 在 GO 之后直接调用被工具拒绝并提示走 RED→GREEN→REFACTOR
- [ ] `pair_red` 必须在 `pair_green` 之前；证据链（red.at ≤ green.at）缺失的已验收循环导致 `pair_gate_check` 的 `test_first` 项失败
- [ ] `tddMode=coach` 双链皆可走通；`tddMode=off` 保持旧行为；trivial 任务走短链且免 test-first 检查

### T12 INVEST 故事校验
- [ ] `pair_task_create` 角色写 "user"/"用户" → 拒绝并给出可操作错误
- [ ] benefit 为 intent 的字面同义复述（含中文 bigram 用例）→ 拒绝
- [ ] 无 acceptance_criteria → 拒绝（Testable）
- [ ] `legacy=true` 逃生门可建非故事维护任务

### T13 结构化反馈（I8）
- [ ] NO_GO / REJECT 缺三段任一（observation/impact/way_forward）或为 "make it better" 式空话 → 工具拒绝
- [ ] REJECT 记录 reason_category，`pair_status` 的 stats.reasons 聚合可见

### T14 绿构建与复盘继承
- [ ] 有被验收改动时 `pair_stop` 无 `green_build_evidence` → 拒绝；`force=true` 可过
- [ ] `pair_retro` 的 keep/try 写入 `lessons.json`；下一次 `pair_start` 返回值携带 carried_lessons 并入 PLANNING 职责

## 5. 性能与缓存验收

| 指标 | 目标 | 测量方式 |
|---|---|---|
| L2 证据缓存命中率（单任务内重复摘要） | ≥ 90% | retro.md 统计输出 |
| 成员系统提示前缀稳定性 | 同版本同角色同模式逐字一致 | 单测：两次渲染 persona 前缀 diff 为空（per-mode 稳定） |
| Captain 监控 | 无 busy-poll（仅事件驱动 status） | 协议日志中 status 调用均由消息事件触发 |
| 单循环协议开销 | 可观测 | retro.md 输出每任务循环数与估计 token |

## 6. 兼容性验收

- [ ] web profile 全流程可用
- [ ] headless profile（`dsh --profile headless "/pair ..."`）可运行（手势边界激活）
- [ ] Windows 路径下状态目录读写正常（本机 win32 验证）
- [ ] 零第三方插件依赖：运行时 import 全部为宿主 base bundle 原语——由 `scripts/verify-runtime-imports.mjs` 门禁确认
