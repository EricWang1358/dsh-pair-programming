# 双 Driver、需求发现与 QA：设计与验收记录

更新：2026-09-09。分支 `feat/isolated-dual-drivers`；当前为本地开发版本，未发布。目标是提高正确率，并减少错误交接、无效审查、路径猜测和等待；不是单纯增加代理数量。

## 判断与取舍

这个项目仍有价值，前提是把“多角色聊天”变成可恢复、可验证的开发协议。便宜模型和频繁审阅本身不构成优势。真正值得保留的是：独立验收标准、明确所有权、可复跑证据，以及协调失败时能恢复且不篡改历史的流程。

本次沿用[论文调研及适用边界](../research/2026-09-07-correctness-first-agents.md)。MAST 的错位/终止分类对应任务身份与恢复测试；Agent Systems 的可分解性结果对应按依赖和共享资源准入；SEDA 对应有界通知；自纠错与辩论研究对应“外部证据优先、允许 clean pass”。这些是设计依据，不是本插件性能提升的实验结果。

## 分工和工作流

| 责任 | 执行者 | 交付物与边界 |
|---|---|---|
| 发现需求 | 任意现役成员或 Captain | 观察、用户价值、证据、可观察验收条件；发现不授予写权 |
| 产品经理 | Captain | 判定范围、now/later/dismiss、优先级和理由；不替 Driver 分析实现 |
| QA | 共享 Navigator | 根据需求独立冻结 oracle；复跑验收、审阅差异和回归影响；真实反例可否决绿测试 |
| 实现 | Driver / 可选 Driver2 | 各自任务、分支、工作区；先领取，再 oracle，再提案和 GO，再实现 |
| 集成 | Captain + 工具执行 | 串行合并候选，在临时合并树重跑目标/既有 oracle 和整个回归命令 |

不额外启动每轮都发言的 PM 或 QA 席位。职责通过工具、状态和验收产物落实；角色名称本身不能保证判断质量。

## 双贡献者隔离

使用 `pair_start` 的 `drivers: 2`、`mode: "light"` 和必填 `integration_command` 开启。原来的单 Driver 默认保持兼容。入口要求干净、有提交的 Git 仓库根目录。

每张卡声明 `write_paths`、`read_paths`、`resources`。只有无依赖阻塞、无共享读写/资源冲突的工作才并行。依赖未完成且未集成时不能领取；未声明范围和关键清单、接口、迁移等变更保守排队。优先级不能越过这些约束，也不抢占已在进行的任务。

每个 Driver 使用原生 DSH Agent、单独 cwd 和分支。隔离席位仅保留实现、测试、检索、图像检查及必要协议工具，移除自审、另起代理和额外工作流编排入口；单席工具面不受此选项影响。中央 board/mailbox 保留唯一任务状态；修改和证据绑定 task、owner、attempt、cycle 和候选摘要。领取回执包含工作目录及声明的文件路径；重复领取返回同一份路径与能力信息。协议工具可能通过 `run_code` 的 `tools.pair_*` 调用，不应因它们不是单独工具 schema 就认定不存在。

编辑工具检查领取、当前周期许可、写范围、保留目录和真实路径。未领取、未获 GO、旧 attempt、跨工作区、路径中的 `..` 均拒绝。Shell 不是操作系统沙箱；故意用 shell 绕开编辑工具仍属已知限制。最终 gate 和集成会检查实际候选，不能把任意写入算成已验收交付。

候选提交通过私有 Git index/commit-tree 建立，不改写 Driver 已审阅的工作区、index 或 HEAD。集成在临时工作树验证后，仅在 canonical 分支干净且未漂移时推进。文本冲突、组合回归失败或摘要变化时保留候选和根目录。完成必须有集成回执；最终完成检查在 canonical 树重新认证各任务。

Windows 的 `core.autocrlf=true` 曾把冻结的 LF oracle 变成 CRLF，造成合并后摘要不符。本插件自己的 checkout/reset/merge 操作使用 `core.autocrlf=input`，不修改用户配置，也不放宽摘要校验。显式 `.gitattributes` 强制转换的冲突仍拒绝。

## Agile 需求发现与排序

`pair_backlog(action="discover")` 接收 observation、user_value、evidence、acceptance_criteria、scope；source_task_id 仅填写已经存在的 t-* 卡号，发现先于建卡时省略。相同观察与来源去重，最多保留 20 条未分诊发现，避免信箱变成意见洪水。

Captain 根据用户价值和证据分诊：1 表示阻塞用户结果，2 表示有价值的下一增量，3 表示可选改善。记录理由；缺少理由的优先级不被接受。正确性或安全阻塞仍走 risk，不被产品优先级降级。

- 本轮执行：先用 discovery_id 建立真实故事草稿，逐条保留发现的验收条件并分配 goal acceptance_refs；草稿不可领取/提案/写 oracle。再 triage now 激活并排序。
- 延后或不做：在创建迭代卡之前 triage later/dismiss，保留在产品账本。已经分配迭代卡的发现不能通过延期藏掉未交付工作。
- 超出目标：scope=needs_user_decision，不能自动纳入当前迭代。需要用户的范围决定，不用“发现需求”偷偷扩张目标。

未分诊发现会成为 Captain 的明确下一步，并阻塞成功结束；已延期的发现保留在收尾记录，不伪装成交付。`pair_status` 默认仅展示 20 条发现，未分诊优先，支持 product_offset/product_limit 翻页，完整历史仍在 team.json。调度先筛选可运行任务再按优先级排序。

首周期前允许改卡。单席维持已有撤销语义；双席保留准备好的工作区和 owner，撤销旧 attempt，记录当时文件摘要，然后按新依赖/范围重新领取。重新领取前若文件变化则拒绝；若 canonical 已推进，只允许 Git 快进带入新增依赖，保留本地验收文件，冲突时拒绝覆盖。不 hard reset/clean 文件，也不把无效旧凭证重新启用。已存在周期的卡仍不可悄悄改写。

## 用例设计与跨用例协作：在派工前解决

分工单位应当是一段能独立交付、能验收的用户行为。按文件分工只能降低文本冲突；它不会解决两个用例对状态、错误语义或事务边界理解不一致的问题。因此增加可选的设计契约，复用已有的冻结需求、任务依赖和 oracle，不另设常驻架构师或多轮审批。

`pair_start.use_cases[].design` 描述 responsibility、approach、invariants[]、failure_behavior、tradeoffs。若选择 pattern，必须提供 pattern_reason；直接组合也可以，不需要凑模式。已声明但未解决的 open_questions 会在成员启动前被拒绝。这里记录职责和协作决策，不规定 Driver 必须照抄的补丁。探索尚未收敛时，先做有时间上限的 spike，得到决定后再建立执行团队的冻结契约。

跨用例调用放入同一用例的 interactions[]。每项包含上述设计字段，另加 target（如 UC-2）、requires（被调用用例的 AC ids）、contract（输入、结果与错误约定）和 acceptance_criteria[]。例如提交用例调用执行用例，contract 应回答超时如何返回、谁提交最终状态、重试是否幂等、取消与结果回调竞态如何处理，而不是只写“调用 executor”。

插件保留原 AC 编号，把交互验收追加为新的 UC-N.AC-N，并记录 interactionId。调用方任务必须完整拥有该交互的一组验收；所依赖的被调用方 AC 必须由同一卡或其依赖祖先负责。先建立提供方任务再建立调用方；耦合过强、需要一个原子不变量的工作，合成一个纵向切片，不能靠循环依赖伪装成并行。创建、改卡、领取、开始周期、终局检查共享这一约束；修改提供方卡也会重查现有调用方，失败不写盘、不唤醒成员。

例如：UC-1 原有一个提交验收，新增“执行超时只产生一个终态”和“重复回调不会重复提交”两个交互验收后，编号为 UC-1.AC-2/3。提供方 t-1 拥有 UC-2.AC-1；调用方 t-2 拥有 UC-1.AC-1/2/3 并依赖 t-1。漏分配 AC-2/3 无法开始实现；只测提交与执行的各自正常路径无法冻结 t-2 oracle；删掉 t-2 对 t-1 的依赖或移走 t-1 的提供方 AC 都会被拒绝。

Driver 领取回执带本任务的设计及有关的双向调用契约，被调用方也能提前知道调用方的约定。QA 用 `pair_status(design_task_id="t-2")` 读取同一契约，独立编写可执行验收；普通状态查询不重复输出整份设计。冻结 oracle 仍须在生产修改前实际 RED，之后保持摘要不可变。设计契约也绑定 gate 摘要，变更不能沿用旧凭证。相互作用验收最终在串行集成后的系统中复跑。

### 按问题选择模式

| 具体问题 | 适用模式与本插件的选择 | 要验证的失败路径 |
|---|---|---|
| DSH 原生 Agent 与插件角色/工作区不一致 | Adapter：集中在原生成员适配层转换身份、cwd、恢复与工具权限 | 冷恢复保留身份；退役后不继续执行；spawn 失败清理 |
| 一个用例协调任务、验收和集成 | Application Service / Facade：工具处理器组织顺序，纯协议函数判定资格；Driver 不直接改共享 board | 旧 attempt、过期凭证、跨任务动作被拒绝 |
| 多个 Driver 更新同一版本线 | Unit of Work 的本地提交边界：候选快照、隔离验证、串行发布；Git 与 board 的恢复状态显式记录 | 验证失败不推进 canonical；HEAD 变化拒绝旧候选；恢复不重复集成 |
| 同一任务多阶段及失败恢复 | State + 有审计的补偿步骤：只修执行计划，保留 oracle、预算与失败历史，重新 GREEN | 重复恢复、旧周期、终态周期不能重写历史 |
| 至少一次投递带来的重复处理 | Inbox claim/ack/release 与 attempt 身份检查；成功才确认；已送达修复消息不再无条件全队唤醒 | 投递失败释放；陈旧消息不能操作新任务 |
| 跨外部服务且不能事务回滚 | 只有真实需求出现时才引入 Saga 与补偿；本次不增加通用 Saga 框架 | 部分成功、幂等重试、补偿失败及可恢复记录 |

### Agile 发现与设计边界

PM 先判断发现项的用户价值和重要性，再判断是否改变当前契约。在现有目标内、未开始的卡可以通过草稿、分诊和改卡进入本轮；已开周期的契约不能悄悄变化。新目标或新的跨用例契约需要明确的新执行范围，保留现有成果与证据。QA 负责指出缺失的可观察行为；Captain 负责把设计问题解决到 Driver 可以实施的程度，而非让 QA 反复要求“再检查一下”。

这是结构校验，不是自动架构证明。旧团队无 design/interactions 时继续兼容；未声明的调用关系、模糊但非空的文字、测试断言质量仍要靠设计分析与独立 QA。依赖图不能表示的并发事务应由一个任务负责交互，不能用两个局部绿测试冒充系统正确。此次不增加模型轮次来证明这些纯协议规则，使用离线真实任务处理器、状态输出与领取回执回归。

## Windows verify_plan 死锁的恢复

`verify_plan` 是周期检查命令；冻结 oracle 是最终验收标准。两者不同。若实现已完成，可直接走现有 `pair_verify(stage="final")`，让工具重跑完整 oracle；这不是旁路放行。

若仍需修正周期命令，使用新增 `pair_repair_verify_plan`。Captain 或 Navigator 提交 cycle_id、新的可执行 verify_plan、reason 和非空 evidence。推荐运行已有脚本文件，避免 `node -e` 嵌套引号。插件不会仅凭“脚本文件”四个字认定命令正确，修复后必须实际重跑。

该操作仅允许当前活跃任务的最新未最终接受周期。它验证冻结 oracle 摘要不变，追加旧命令、失败/审阅/报告和修复证据，清除当前 GREEN/report/verify 与旧 gate 绑定，回到 GO 或 PROPOSED。原 rejection/cycle 预算和历史不被抹去；必须取得新 GREEN，最终仍重跑原 oracle。无须编造 oracle 缺陷、删依赖、失败重建或开新周期绕背压。

用户报告的 `c-t-3-1-22` 所在 HOLD board 未在本工作区定位到，本次没有替它改盘或宣称已解锁。加载新版本后，在原 Captain/QA 会话先读状态，核对该周期及冻结文件；若已完成则走完整 final，否则用实际存在的检查脚本和真实错误证据修复该周期。已最终 ACCEPT/CLOSED 或失效 attempt 会被拒绝。

## 调度、生命周期与证据

领取、gate 和完成事件立即通知下一责任人；修复消息已成功投递时不再无条件唤醒全队。旧任务/attempt 的动作拒绝后要读当前状态。没有进展的重复通知仍受已有去重/背压限制；不会声称“保证零空转”。

DSH session/cwd/composition 可持久化后冷恢复，成员退役后拒绝继续投递。结束时退役代理，但保留 worktree、分支、候选引用和审计盘供检查恢复；这会占磁盘，目前没有自动 GC。依赖要在各工作区准备，不共享一个可写 node_modules 来冒充隔离。

| 验证 | 记录 | 结论 |
|---|---|---|
| 原生双席生命周期 | [native-dual-lifecycle.json](evidence/native-dual-lifecycle.json) | 两席不同 cwd/session、并行轮次、恢复与退役 |
| 两个 DSH 进程之间恢复 | [create](evidence/native-dual-restart-create.json) / [resume](evidence/native-dual-restart-resume.json) | 相同成员身份与 cwd 恢复 |
| 双任务真实开发收尾 | [native-dual-workflow.json](evidence/native-dual-workflow.json) | 两任务集成、完成、canonical 认证、RETRO/DONE；保留模型误用工具记录 |
| Windows 同周期命令恢复 | [native-checkpoint-repair.json](evidence/native-checkpoint-repair.json) | 真实 DSH Agent 与工具执行管线，10 次工具调用；坏命令拒绝→修复→跳过新 GREEN 被拒→新 GREEN→checkpoint→原 oracle 最终 ACCEPT。无模型轮次，不是模型自主恢复的证明 |
| PM/QA 模型流程试跑 | [失败记录](evidence/native-dual-pm-failures.json) / [按成本约束停止的记录](evidence/native-dual-pm-stopped.json) | 需求发现/分诊、双席准备和部分集成已有观察；本轮完整 PM 双任务收尾未获稳定通过，不宣称已完成该项验收 |

以上原生运行使用 `pair-dev`、`opencode-go-muse/muse-spark-1.3-contributor`。workflow3 因关机中断，无成功结论；workflow4 超时暴露调用入口误判/过早写入；workflow5 暴露改卡后工作区失效，已停止避免重复消耗。失败也属于验收证据。workflow7 两席完成各自验收，但模型跳过了要求的故障注入，Captain 随后被该遗漏拖住，因此不能把它算成故障恢复通过。workflow8 按用户的成本约束停止；后续不再自动启动完整 DSH 试跑。

最终固定版本离线验收为 **1438 passed / 0 failed，45 suites**，语法、依赖、构建、打包（85 文件）和 26 工具 SDK 启动检查全部通过。测试使用原 runner 的临时副本，仅添加套件进度输出；临时副本已移除。此前一次全量运行期间发生编辑，旧模块缓存与新断言错位，该次不计为通过。最终日志为本地 verify-design-frozen.log，可移交摘要见 [offline-design-verification.json](evidence/offline-design-verification.json)。验证针对当前工作区，用户原有 disclosure.js 修改保留且未纳入本次提交。

### 后续验收的成本约束

默认先做代码分析与离线定向回归。只有涉及宿主工具接线、session/cwd 恢复或调度行为且离线无法证明时，才运行一个有明确退出条件的最小原生探针；不要把完整 DSH 团队当日常测试循环。模型流程验收应先明确任务、预算和唯一待证假设，不再反复跑整轮期待偶然成功。

`scripts/dsh-verification-repair-probe.mjs` 是无模型轮次的原生管线探针；`scripts/dsh-smoke-runner.mjs` 才会运行真实模型，默认本轮不再调用。两者都用临时独立目录和明确输出文件，不指向用户的 HOLD 工作区。

## 后续评估与恢复入口

有价值的下一步是固定一组有隐藏验收的真实任务，对单 Driver 和双 Driver 同预算重复测量：最终正确率、逃逸缺陷、独立需求覆盖、返工次数、无效调用数、总 token 和墙钟。按可并行程度分层，不把一项简单烟测的通过率当成普遍提效。更激进的自动角色增减、预占和自动清理均不在本次默认开启。

本次设计与修复已交付，但双 Driver 仍是可选开发功能，不能根据现有证据升级为默认稳定模式。本地加载通过已链接插件；现有 DSH 进程有 ESM 缓存，需要在适当时机重启才会加载新代码。不要为本次验收强行重启用户的 HOLD 团队。未执行 push、发版或真实 HOLD board 迁移。
