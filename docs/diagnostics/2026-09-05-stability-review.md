# DSH 插件质量诊断与局部重构方案

日期：2026-09-05。对象：dsh-pair-programming 当前工作树，package 0.13.6。

本文分两部分：上半为诊断稿（写于修复之前，保留原判断与原始证据），下半为「实施结果」（同日收尾，记录已落地的修复、验证与基线测量）。两处结论不一致时以下半部为准——其中一处正是被实测推翻的。

结论：协议层已有可用基础，但异常恢复链仍存在数据损坏、跨团队故障传播和孤儿席位风险。建议先修复三个已复现的 P1，再收敛运行时接口；目前证据不足以将它评为长期无人值守稳定服务。无需先重写协议状态机，也无需先修改 DSH 官方仓库。

## 诊断范围与证据边界

- HEAD：24f61020b3e4e7aafa20fb493cc98db3fa88ae96；存在未提交修改及未跟踪模块，结论针对本次读取的工作树，并非该提交单独内容。tracked diff 实测 39 files / 2229 insertions / 130 deletions，不含未跟踪文件。
- 只新增本报告及同目录诊断探针，未修改插件生产代码、宿主配置、发布版本或现有业务状态。
- 实跑 `node tests/run.mjs`：1077 passed, 0 failed across 32 suites。
- 实跑 `node scripts/verify-startup.mjs`：成功注册 22 tools、/pair、gesture boundary、scheduler observer。此脚本用真实 SDK 导入和模拟 ctx 装配；不是 live DSH 重启/冷恢复端到端测试。
- 实跑 `node scripts/verify-runtime-imports.mjs`：RUNTIME-IMPORT GATE PASSED。
- 未运行完整 npm run verify、打包发布、真实模型调用、生产重启或长时负载。没有可声称的可用率、MTTR、吞吐量和成本改善数字。
- 诊断脚本 `docs/diagnostics/2026-09-05-probes.mjs` 已先通过 node --check，再执行成功。脚本使用临时目录和模拟宿主；退出 0 表示当前缺陷得到复现，不能将它当成产品回归测试通过。

## 保留的质量资产

状态机、attempt capability、冻结 oracle、gate 亲跑命令、mailbox claim/ack/release 和现有宿主契约测试应保留。它们已将大量散文约束变成可执行边界。

遵循既有账本：不重开已结案的 pair_start 工具名问题；不删除 M11' 事件兼容守卫；不解禁 rotate；M10' 的 spawn 错误分类和类型声明漂移继续归原债单，不另立重复缺陷。后续优先级按恢复风险，而不是意见数量或测试计数决定。

## 已验证问题

| 编号 | 优先级 | 触发、影响与证据 | 建议 |
|---|---|---|---|
| Q1 | P1 | `lib/state/atomic.js:61` rename 失败后直接覆盖正式文件；`:65` 即便覆盖失败也删除完整临时副本。探针注入 EPERM 和截断后写入失败，得到正式文件 `{`、临时副本消失。锁外 readTeam 还可能看到覆盖中间态。 | 对 team/mailbox/retired 等关键状态禁止破坏性降级；有界重试失败保留最后完整版本与恢复材料，返回明确持久化失败。 |
| Q2 | P1 | `lib/runtime/scheduler.js:185` 对 activeTeams 串行遍历，异常只在整个定时回调外捕获。探针将首队 JSON 损坏，连续两轮 heartbeat 都失败，后续健康队获得 0 次 kick。 | 每团队隔离错误；损坏团队停止自动变更并上报，其他团队继续；每轮增加防重入，单队操作设截止时间。 |
| Q3 | P1 | `lib/runtime/recycle.js:104` 新席位 spawn 后才提交；锁内只按 name 找席位，不核对原 id、代次和团队终态；目标消失时直接 return，外层仍退休旧席并返回 recycled=true。探针在 spawn 中模拟 ABORTED/removed，产生不在 board 上、未被 interrupt 的 replacement。 | 提交前比较 oldId + generation + live phase；提交失败或条件过期时退休 replacement；返回值必须反映是否真正换席成功。 |

复现原始输出：

```text
F1 reproduced: canonical JSON damaged; complete temp copy removed.
F2 reproduced: two sweeps failed; healthy team received zero kicks.
F3 reproduced: reports recycled=true, replacement absent from board and never interrupted; old live tombstone absent.
```

以上是确定性故障注入，不表示本次观察到了生产事故；它证明代码在这些输入和交错下没有所需恢复保证。Q1 可导致 Q2，形成“单次写入故障影响整个工作区调度”的故障链。

## 静态确认的局部缺口

**Q4 / P2：回收与停止使用不同退休流程。** `recycle.js:116` 只写 durable tombstone、interrupt；没有调用 `markMemberRetired` 或清空 live Agent 队列。相比之下 `tools/lifecycle.js:49` 的 `retireSpawnedMembers` 已执行这些步骤。探针也确认回收后旧席在当前 ctx 的 `isMemberRetired` 仍为 false。结合 `members.js:38` 的 inbox guard，这意味着 live tombstone 防线没有生效；实际再次唤醒的效果需补 live 集成测试，不把它描述为已经观测到的生产越权。

**Q5 / P2：清理调用接错对象。** `recycle.js:124` 调 `runtime.releaseTeamSeats?.()`，而 scheduler 两个调用点（`:513`、`:569`）传入的是 `hosts`，由 `index.js` 提供 `{selections, ce}`。实际清理函数在 scheduler 返回的 runtime 上。因此回收时可选链静默跳过清理。应改成明确、必需的生命周期接口，并对“通过真实 scheduler 回收后确实清理”写行为断言。现有 wake.test 的“方法可调用且不抛错”不能证明这条调用链。

**Q6 / P2：SDK 与文档基线不一致。** package.json 声明 testedCohort alpha.5，本地 dsh-subagent 为 0.1.2-rc.1；架构文档仍提到旧协议与 20 工具，当前 personas PROTOCOL_VERSION='5'，装配实测 22 工具。`lib/types/index.d.ts` 缺 CE 配置等新增字段。此为版本/声明漂移，当前导入和装配通过，不应误报成 SDK 已不兼容。

## 需要测量后再决定的优化

1. **邮箱增长。** `state/mailbox.js` 每次 append 先读整个文件再重写，claim/ack 同样处理全文件。连续追加 N 条会累计处理二次增长的数据量。这是复杂度结论，尚无本机时延实测。先采集 mailbox bytes、队列最老年龄、读写耗时，再在已确认消息达到阈值时归档压缩；保留 pending 和租约中消息。
2. **团队查询。** `state/store.js:160/178/206` 扫描并读取团队；单个损坏归档会导致相关查询抛错。涉及身份授权的查询不得简单 catch 后假装无团队，否则可能绕过写权 guard。应返回“完整/不完整/损坏”结果，对受影响身份拒绝操作；性能索引必须保留失效与重建机制。
3. **重启恢复。** activeTeams 为进程内 Map，靠 start/kick 登记。本轮未验证“宿主重启后无人发消息”的恢复场景。增加针对已知 workspace 的恢复集成测试，再决定在 session-start 做受限扫描，避免全盘扫描。
4. **告警可靠性。** scheduler 在 wake 成功前写 lastStallReport，失败后同一 quiet stretch 可能不再尝试通知。将 attempt 与 delivered 分开，按有界退避重试；不能每轮刷状态消息。
5. **验证缓存。** gate-exec 缓存键主要是 command + workspace digest，未代表解释器、环境变量或外部服务。涉及环境状态的检查建议不缓存；确定性检查再考虑加入 SDK/运行时/锁文件等上下文指纹。先定义保证范围，不把所有检查统一提速。

## 官方 DSH 对照

本次只读核对官方仓库，默认分支 master，观察到的提交为 [d347e703908d0406b7a7ef80e3a0e594d86b2215](https://github.com/deepseek-ai/deepseek-harness/commit/d347e703908d0406b7a7ef80e3a0e594d86b2215)。[官方 README](https://github.com/deepseek-ai/deepseek-harness) 明示 developer preview、快速迭代与破坏性兼容变更。

本机安装包 `node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts:122` 明确 sendMessage 对 idle target 启动 turn，对 absent direct child 支持 cold resume；插件 `members.js:394` 正在使用该接口。没有理由恢复早先不存在的 service.followup，也不将官方 master 等同于本机已安装版本。

建议发布基线记录：插件源码/包哈希、实际宿主及关键 peer 版本、测试结果与运行环境；每次 SDK 升级用独立 profile 做真实 start → sendMessage → idle → 冷恢复 → stop 验证后再切换。当前 findings 位于插件自身状态和生命周期边界，不依赖先 fork 官方仓库。

## 分阶段实施方案

### 第一批：恢复完整性，三个小改动组

**A：严格持久化。** 修改 atomic.js 与 state 调用边界；先把 Q1 探针转换成“失败仍保存完整旧状态”的 RED，再实现有界 rename 重试和保留恢复副本。临时文件仅在成功提交或确认不再需要时清理。不要在重启时不加验证地采用最新 tmp；恢复必须检查完整 JSON、team id、schema 和版本。验收覆盖 EPERM 重试成功、重试耗尽、写入中断和锁外读者；所有结果都是完整旧版/新版或可解释的失败，不能是半个 JSON。

**B：隔离调度故障。** heartbeat 每队 try/catch；错误记录带 workspace/team id，不能据损坏记录执行团队动作。整轮只允许运行一个实例，并处理卡住的操作，避免 setInterval 叠加无限待办。验收：坏队在前健康队仍能运行；慢队有界让出；连续 tick 不堆叠；dispose 后无新 sweep；健康队处理时延只受设定预算影响。

**C：让回收具备提交和补偿。** 抽出运行时级 `retireSeat`，被 stop、start rollback、recycle 共用；回收先预留代次，锁外 spawn，锁内核验并提交，失败时清理新席，成功才退休旧席。明确传入 scheduler 清理回调，移除无声跳过的可选方法。验收交错矩阵：正常换席、spawn 拒绝、stop 同时发生、重复 idle/error 回收、提交失败、退休记录失败；每种情况 board 至多指向一个当前席，未提交 replacement 被清理或进入可见重试清单。

顺序 A → B → C；每组独立回归与完整 verify，避免一次混入协议修改。涉及新持久化字段时保留缺省迁移语义并声明回滚限制。

### 第二批：只抽取三个承重边界

| 边界 | 职责 | 重构范围与约束 |
|---|---|---|
| StateRepository | schema 验证、版本/代次、事务提交、损坏状态报告 | 先包住现有 JSON 存储；保留现有路径，不直接迁移数据库。跨进程同时写同一根目录目前未由 in-process lock 保护，应先限制单写者部署；若实际需要多宿主，再设计 OS 锁/数据库事务。 |
| SeatLifecycle | spawn/commit/retire/补偿及路由元数据 | 从 tools/lifecycle 下沉通用退出逻辑；把性能回收与配额故障恢复区分，避免 memberLifetime='session' 顺带禁用必要恢复。对该分支先补行为测试。 |
| HostAdapter | sendMessage、startContinuable、interrupt、错误分类 | SDK 调用集中到少量接口；contract tests 钉真实 SDK，mock 仅用于故障注入；protocol 保持纯逻辑。 |

gate/oracle 的进程执行器暂列下一批候选：统一超时、输出上限和基础设施错误分类有价值，但 Windows 子进程树终止效果须在独立测试中验证，不能只把 error.killed 当成所有后代都退出。

### 第三批：可测的长期运行优化

先记录基线，再做邮箱压缩与查询优化。建议观察：pending 最大年龄、投递尝试/接受/实际 turn-start 数、孤儿席位数、重启恢复耗时、持久化失败数、每团队 sweep 时间、归档大小和进程内 Map 条目数。accepted 不等于 completed，应在产品状态中明确。

建议验收实验（目标，不是本轮结果）：100 次 start/stop、100 次回收、重启恢复、持续拒绝唤醒、坏队与健康队并存、较大历史邮箱；操作完成后无未归属席位，队列和 Map 在归档/停止后有界。时间指标先测当前基线，再定 p95 和最大恢复时间，不编造 99.9% SLA。

### 发布与回滚

先整理当前工作树为可识别基线，再按组提交。候选版本完成完整 verify 与真实宿主恢复测试后，在独立 profile 试运行；产出版本清单和健康观察记录，再切换日常 profile。回滚恢复已验证插件/SDK组合；持久化 schema 若升级，必须使用兼容读取或配套快照，不能仅退代码。

不建议首批增加 reviewer 配额、自动大转向、多层规划或动态 rotate。这些会增加交错面，对本次三个已复现故障没有直接帮助。

---

# 实施结果（同日收尾）

上文是诊断稿。以下是按第一批/第二批方案实际落地后的状态、验证与基线测量。范围仍限于本工作树，未发布、未在真实宿主长时运行。

## 已落地的修复

| 编号 | 结果 | 改动位置 | 钉住它的用例 |
|---|---|---|---|
| Q1 严格持久化 | 已修 | `lib/state/atomic.js` —— 删除直写降级；`rename` 有界重试（3 次 / 50 ms），耗尽后抛 `PAIR_STATE_COMMIT_FAILED`，正式文件保持上一版完整状态，完整临时副本保留在 `recoveryPath` | `rename exhaustion preserves canonical and recovery copy without direct overwrite`、`transient rename failure retries and commits` |
| Q2 调度故障隔离 | 已修 | 新 `lib/runtime/heartbeat.js` —— 每队 try/catch、每队截止时间（默认 10 s）、整轮单实例（重入合并）、坏队不入队于卡住的 I/O 之后、dispose 后不再产生新工作 | `bad team does not block healthy teams in successive sweeps`、`overlapping sweeps coalesce and dispose prevents new work`、`hung team yields to healthy team without duplicate work or post-dispose escalation` |
| Q3 回收提交语义 | 已修 | 新 `store.commitMemberReplacement()` —— 锁内比对 `id + joinedAt + role + 团队终态`，任一不符即不提交；`recycle.js` 提交失败时退休的是新席而非旧席，返回值反映真实结果 | `recycle transaction:` 八个交错场景（normal / stop / terminal-only / replacement / missing / spawn-fail / persist-fail / session-force）、`concurrent replacement commits choose one generation`、`repository commit write failure preserves original valid board` |
| Q4 退休流程统一 | 已修 | 新 `lib/runtime/retire.js` —— stop、start 回滚、recycle 共用；先 `markMemberRetired` + 清 live 队列 + interrupt，再写 durable tombstone | 上述 recycle 用例断言 `isMemberRetired(ctx,'old') === true` 与 `cancelled === ['old']` |
| Q5 清理接线错误 | 已修 | `recycleMember` 现在要求 `runtime.releaseTeamSeats` 为函数，缺失即抛错；scheduler 两个调用点显式传入自己的 `releaseTeamSeats` | recycle 用例断言 `released === ['old']`；基线测量 §4 直接验证 100 次回收后进程内表为 0 |
| Q7 无 session 的席位 | 已修（本次新增） | `members.spawnMember()` 现在校验宿主返回的 `childId` 为非空字符串，否则抛错走既有失败路径 | `a host that returns no child id cannot seat a sessionless member`（先验证移除守卫后该用例为 RED） |

Q6（SDK / 文档基线漂移）未在本轮处理，仍留在原债单。

## 验证

`npm run verify` 全链路通过：

```text
typecheck OK: 96 files parse clean.
1095 passed, 0 failed across 33 suites.
RUNTIME-IMPORT GATE PASSED
build OK: main=lib/index.js, types=lib/types/index.d.ts, patch=./cordis.patch.yml
verify:package OK: @ericwang1358/dsh-pair-programming@0.13.6 tarball (64 files)
verify:startup OK: 22 tools + /pair + gesture boundary + scheduler observer install
```

诊断稿里三条故障注入输出（F1/F2/F3）现在都由 `tests/stability.test.mjs` 的十八个常驻用例覆盖；每条都先在移除修复的情况下确认为 RED，再在修复下转 GREEN。

相应地，原探针 `docs/diagnostics/2026-09-05-probes.mjs` 现在会在第一条断言处退出 1——它断言的是修复前的行为。脚本保留为「缺陷确实存在」的证据，文件头已标注作废；活的守卫在 `tests/stability.test.mjs`。

## 基线测量

harness：`docs/diagnostics/2026-09-05-bench.mjs`（临时目录 + 内存桩宿主，无模型调用，退出码恒为 0——它是基线工具，不是回归门禁）。以下为 node v22.22.3 / win32 单次运行结果；毫秒数受本机磁盘与杀软影响，趋势比绝对值可信。

**1. 邮箱追加（读全文 + 原子重写）**

| 条数 | 追加总耗时 | 每条 | 文件 | 累计重写字节 | 未读扫描 | claim+ack |
|---|---|---|---|---|---|---|
| 100 | 551.5 ms | 5.5 ms | 16.1 KiB | 812.8 KiB | 1.9 ms | 9.4 ms |
| 250 | 1557.8 ms | 6.2 ms | 40.4 KiB | 5064.2 KiB | 1.2 ms | 8.2 ms |
| 500 | 3180.2 ms | 6.4 ms | 80.9 KiB | 20255.4 KiB | 2.2 ms | 21.0 ms |
| 1000 | 7856.9 ms | 7.9 ms | 162.0 KiB | 81033.2 KiB | 6.0 ms | 14.1 ms |

**2. 团队看板随 cycle 历史增长**：0 / 25 / 100 / 400 cycles → 0.6 / 5.6 / 20.9 / 82.7 KiB，写 2.9 / 2.6 / 3.1 / 3.4 ms，读 0.8 / 0.8 / 1.1 / 1.3 ms。基本平坦，不是成本来源。

**3. 冷恢复（session-start 重新登记）**：10 / 50 / 200 个团队（其中 1 个 JSON 损坏）→ 10.4 / 42.2 / 207.0 ms，登记 9 / 49 / 199 个。线性，约 1 ms/团队；损坏团队被跳过并告警，不影响其余。

**4. 单队 100 次回收**：100/100 成功，1033.2 ms（每次 10.3 ms）；结束时看板上恰好 1 个 live 席位，100 次 interrupt，0 次告警；进程内 `nudges / activity / parked` 均为 **0**；无遗留 `.tmp`。这是 Q3/Q5 验收条件的直接测量。

**5. 100 次建/停团队**：1441.1 ms（每次 14.4 ms），状态根目录残留 0 项。

**6. 退休 deny-list（唯一无压缩的持久结构）**：100 / 500 / 2000 / 8000 条 → 1.3 / 6.7 / 28.2 / 116.1 KiB，单次写 4.8 / 6.4 / 5.5 / 7.6 ms，全量读 0.7 / 1.3 / 1.2 / 2.9 ms。8000 条（即 8000 次已接受 cycle）仍在 10 ms 内，近期无需压缩；建议把 8000 条 / 128 KiB 作为复查阈值而不是现在动手。

**7. 一次追加的时间去向**（160 KiB 文件，200 次操作）：读全文 1.2 ms，原子重写 3.5 ms，等价的 O(1) `appendFile` 1.5 ms。

## 一处结论修正

诊断稿把"邮箱压缩"列为第三批第 1 项。测量推翻了这个排序：**主导成本是原子重写本身（约 3.5 ms，占单次追加的七成以上），不是被重写的数据量**。把 162 KiB 的邮箱压缩成 16 KiB，省下的是那 1.2 ms 的读，动不了 3.5 ms 的写。真正有量级差别的是给 `appendMailbox` 一条 O(1) 追加路径（JSONL 本来就适合追加），把原子重写留给必须原地改写的 `claim/ack/release`。

（**后续：这一项已在 0.13.7 落地，见文末「第二轮：把记下来的债还掉」**。）代价必须一起说清楚，所以 0.13.6 没有顺手改：`appendFile` 不保证崩溃时不产生半行。当前 `readMailbox` 已经跳过畸形行，所以最坏结果从"整个邮箱不可读"降级为"丢最后一条消息"——但这是 durability 语义的改变，按方案自己的顺序要求（每组独立回归、不与恢复修复混在同一批），应作为单独一批带自己的崩溃注入用例落地。在那之前，邮箱压缩与查询索引都不建议先做。

## 对照方案：三批各走到哪里

| 批次 | 状态 | 说明 |
|---|---|---|
| 第一批 A 严格持久化 | **完成** | Q1；`atomic.js` 无降级路径，失败即显式报错并保留恢复材料 |
| 第一批 B 隔离调度故障 | **完成** | Q2；`heartbeat.js` 承担每队隔离、截止时间、单实例、dispose 止血 |
| 第一批 C 回收提交与补偿 | **完成** | Q3 + Q4 + Q5；八个交错场景 + 并发提交用例 |
| 第二批 StateRepository | **部分** | 只落地了事务提交这一条边（`commitMemberReplacement`）。schema 版本化、损坏状态的结构化上报、跨进程写者保护都没做；单写者假设未变 |
| 第二批 SeatLifecycle | **部分** | 退出侧已收敛到 `retire.js` 并被三处共用；spawn/commit 侧仍散在 `recycle.js` 与 `tools/lifecycle.js`，没有统一入口 |
| 第二批 HostAdapter | **未做** | SDK 调用仍直接散落在 `members.js` / `shared.js`；错误分类（配额、拒绝、基础设施）也还没有集中判据 |
| 第三批 可测优化 | **只做了测量** | 基线已采集，见上；据此推翻了邮箱压缩的优先级，未实施任何优化 |

也就是说：**恢复完整性这一层是完整的，承重边界的收敛只走了三分之一。** 把它当成"三个 P1 已闭环、结构性重构才开头"来读，比当成"重构完成"准确。

## 顺带修正的文档漂移

`docs/02-architecture/ARCHITECTURE.md` 有两处在描述已被 0.13.6 删除的行为——"Windows 兼容 rename 重试 + **直接写降级**"（正文与能力对照表各一处）。按本项目账本自己的规矩，带可执行含义的陈述比"状态过期"危险：照着它去理解失败语义的人会以为写入失败时系统会替他兜底。已就地改成"有界重试、无降级"，并写明失败时的正式文件与恢复副本各自处于什么状态。模块树也补上了 `heartbeat.js` / `retire.js` / `integrations/` 与三个新的 protocol 纯逻辑模块。

## 仍未做与残留风险

- **未验证**：真实宿主重启后的端到端冷恢复、真实模型调用、长时（小时级）负载、发布流程。没有可声称的可用率、MTTR 或成本数字。
- **`.tmp` 恢复副本不会自动回收**。这是 Q1 的刻意取舍：自动清理正是当初造成数据丢失的行为。持续提交失败会在团队目录里累积恢复副本；它不影响读取路径（所有读都按确定文件名），但需要人工处理，且失败本身会以 `PAIR_STATE_COMMIT_FAILED` 显式抛出。
- **`recoveryScans` 按 workspace 记忆化**（上限 256）。同一进程内，某团队在扫描后转入 DONE 又发生 session-start 时，可能被按旧快照短暂重新登记；下一轮 sweep 的 `settledQuiet` 会取消登记，属自愈，但确实是一处已知的陈旧读。
- **单写者假设未变**。跨进程同时写同一状态根仍不受进程内锁保护；第二批的 StateRepository 边界是这条限制的落点，本轮未动。
- **Q6 漂移仍在**：`testedCohort` 与本地 `dsh-subagent` 版本、架构文档中的工具数与协议版本仍需对齐。
- **心跳的 pending 保护是有意的悬挂**：超时的团队操作在 settle 前不会被重新调度。若宿主调用永不返回，该团队会停止被 sweep，`diagnostics().heartbeat.pending` 是观察它的地方。

---

# 第二轮：把记下来的债还掉（0.13.7）

上一节列的"仍未做"里，凡是**有明确依据、且现在做是安全的**都已落地；结构性重构与需要真实 provider 才能验证的部分明确不做，理由随条列出。

## 已还

| 债 | 处置 | 依据 |
|---|---|---|
| 邮箱读全文重写 | 改为 O(1) `appendFile`；`mutateMailbox`（claim/ack/release）仍走原子重写，因为它要原地改记录 | 见下方实测 |
| `.tmp` 恢复副本无界增长 | 只在**同一 target 的后续提交成功**时回收——那一刻它持有的版本才算被取代；兄弟文件的副本、以及一分钟内的副本一律不动 | 与 0.13.5 处理进程内 Map 用的是同一条"by construction 无界"标准 |
| `recoveryScans` 陈旧读 | 记忆化加 5 s TTL；足够合并宿主启动时的 session-start 洪峰，短到不会把已离开的 phase 交给下一次 resume | 已知缺陷，自愈但确实存在 |
| `testedCohort` 写 alpha.5 | 改为 rc.1（本机六个包全是 rc.1，`verify:startup` 一直是对着它过的） | 事实性错误 |
| ARCHITECTURE 两处"20 个工具" | 改为 22 | 模块里静态可数出 22 个 `pair_*` |
| ARCHITECTURE "PROTOCOL_VERSION=4"、`runtime/mailbox.js` | 改为 5、`state/mailbox.js` | personas 实为 `'5'`；文件在 `state/` |

新增 `tests/drift.test.mjs`：把上面这类"活在代码之外的断言"里可机械推导的几条钉住——tested cohort 对实装版本、config schema 对已发布类型、架构文档的工具数与协议版本对模块、CHANGELOG 最新标题对 package 版本。只钉可推导的，不镜像每一句话，否则这个套件本身就变成第二个真相源。

测试从 33 套 1095 条增加到 34 套 1113 条，全绿。新增的行为守卫都先在移除修复的情况下确认为 RED：邮箱两条、恢复副本回收一条、扫描 TTL 一条、cohort 漂移一条。

## 邮箱改动的实测

同一次运行内的两条写路径对比（160 KiB 文件，200 次操作）：

| 路径 | 耗时 |
|---|---|
| 读全文 | 0.4 ms |
| 原子重写（`mutateMailbox` 仍在用） | 1.4 ms |
| O(1) `appendFile`（`appendMailbox` 现在用） | 0.6 ms |

按邮箱规模的每条追加成本，改动前后（**注意两次运行的机器负载不同，跨运行的绝对毫秒数不可比**）：

| 条数 | 改动前每条 | 改动后每条 | 实际写入字节 | 旧路径会重写 |
|---|---|---|---|---|
| 100 | 5.5 ms | 1.5 ms | 16.1 KiB | 812.8 KiB |
| 250 | 6.2 ms | 1.5 ms | 40.4 KiB | 5064.2 KiB |
| 500 | 6.4 ms | 1.6 ms | 80.9 KiB | 20255.4 KiB |
| 1000 | 7.9 ms | 1.6 ms | 162.0 KiB | 81033.2 KiB |

跨运行的毫秒数只能看趋势，但有两个结论不受机器影响：**每条成本从随邮箱增长（5.5→7.9）变成平的（1.5→1.6）**；**投递 1000 条消息的磁盘写入从 81 MiB 降到 162 KiB**，因为后者只写它真正存下来的字节。

durability 的账要算清楚：原子重写买到的是"文件里永远没有半行"，它**没有**买到消息不丢——崩在 rename 之前，新记录同样没落盘。所以代价只是文件里可能留下一条残缺的**末**行，而 `readMailbox` 本来就跳过畸形行，边界检查也不让下一条记录粘上去。换来的是反面：已提交的记录不再被重写，被打断的追加伤不到历史；旧路径每追加一条都把整个邮箱置于风险中。

顺带消掉一个隐患：四十次并发追加同一邮箱，旧路径会丢记录（read-modify-write 自己和自己竞争）。调用方本来就在团队锁里串行，所以这不是生产中可达的缺陷，是一把上了膛的枪——现在退了膛。

## 明确不还，以及为什么

- **HostAdapter / StateRepository / SeatLifecycle 的完整抽取**：背后没有任何已复现缺陷。刚落地恢复修复就重做承重边界，正好扩大评审自己警告的交错面，而且拿不出可测的收益。
- **配额与限流的错误分类**：`isQuotaError` 现在匹配文本。SDK 给的是 `LlmErrorOptions.status` 而不是配额专用 code，改成按状态码判定意味着要替它决定 402 与 429 是不是都算"耗尽"——判错会让席位在一次瞬时限流后**永久**降级到队长模型。这在这里无法对真实 provider 验证，猜不如不动。
- **跨进程写者锁**：这是部署约束不是缺陷，OS 级锁是独立工程。单写者假设仍然成立且仍需遵守。
- **真实宿主冷恢复、长时负载、真实模型调用**：在这里跑不了。`docs/diagnostics/` 里每个数字都来自临时目录 + 内存桩宿主，不支持任何可用率或 MTTR 结论。
