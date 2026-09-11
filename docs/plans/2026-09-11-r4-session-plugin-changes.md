# r4 结对会话：对插件的实际改动记录（2026-09-11 08:00 +08:00 盘点）

本文件回答一个问题：**本次 sg-career-workbench-r4 结对会话到底改动了插件什么**。全部结论都有可复核的命令与读数，未凭记忆。

## 0. 盘点对象与当时的仓库状态

- 插件开发仓库：`D:\A\1NUS\1Sem\dsh-better-pairprograming\dsh-pair-programming`（npm 名 `@ericwang1358/dsh-pair-programming`）；宿主经 **junction** 装载，所以「改 workspace = 改运行副本」。
- 盘点时刻：`HEAD = f008075`（Merge PR #25 · `fix/tree-fingerprint-bound`，2026-09-11 07:49）；`git status --porcelain` = **空（CLEAN）**。
  - 复核：`cd <repo>; git rev-parse --short HEAD; git status --porcelain=v1`

## 1. 结论（一句话）

**本会话没有留下任何插件源码改动**：工作树干净、没有未提交修改；我在仓库内唯一的编辑是**文档追加**，而那份文档随后被并行的另一个会话用**它自己的版本**提交（`16397c0`），我的追加**已不在当前文件里**。

## 2. 我在仓库内的编辑（文档，非源码）

| 文件 | 我做了什么 | 现状 |
|---|---|---|
| `docs/plans/2026-09-10-refactor-proposals-from-sg-career-session.md` | 追加了 G11 段（『实现完成后的 oracle 无法再改进：RED 门槛没有终局出口』）以及一段『被拒的 pair_oracle 会自动把文件还原成封印字节（拒绝即原子），但写入未冻结不会自愈』 | **已被覆盖**：当前文件对我的锚点 `G11` / `拒绝即原子` 命中 **0**；该文件现由 `16397c0`（2026-09-11 02:13，+19 行，提交信息 *record the parallel r4 session's seven measured findings*）承载，内容是另一会话的版本 |

复核：`git grep -n -E "G11|拒绝即原子" -- docs/plans/2026-09-10-refactor-proposals-from-sg-career-session.md` ⇒ 无输出。

## 3. 仓库外的临时记录（未纳入版本库）

- `D:\A\1NUS\1Sem\dsh-better-pairprograming\retro-entries-r4.md` —— 父目录**不是 git 仓库**，该文件是我为 `pair_retro` 攒的素材。**我的追加全部在**，例如：
  - `## 关闭工件的作者归属必须写『哪个会话/哪支队』，不是写位置`（:106）
  - `## SPEC-FORK 必须严格先于实现（每个任务的验收标准是一次性的）`（:90）
  - `## 当标准里已发现缺陷但尚未重冻：只实现『不使命令变绿』的那一半，用 checkpoint 结束 in-flight`（:82）
  - `## 测量器扫『全量元素集合』时会数到已脱离的节点`（:150）
  - 另有『实现完成后的 oracle 无法再改进』『收尾清单』等段。

## 4. 仓库里与本会话工作流重叠、但**不能**归因于本会话的代码提交

| 提交 | 时间 | 改动 | 与本会话的关系 |
|---|---|---|---|
| `ec26e96` | 2026-09-01 13:18 | `fix(runtime): filter write-tool deny candidates against the host registry` | **9 天前**，不是本会话（这条正是 `~/.dsh/AGENTS.md` 记载的 `tools.restrict()` 未知工具名修复；现由 `lib/runtime/members.js:140 isolatedDriverDenyList(knownTools)` / `:151 toolDenyListFor(role, knownTools)` 承载） |
| `9f3103e` | 2026-09-10 19:21 | `fix: namespace run artifacts, cold handoff, panel reads on DSH 0.1.5` | 与本会话的并行时段重叠 |
| `4f35c9d` | 2026-09-10 19:21 | `wip: carry isolated-spawn policy and integration runtime-data patches`（`lib/runtime/isolated-members.js` +42/−3、`lib/runtime/worktrees.js` +30） | 本会话压缩前那段『双 Driver / integration runtime data』工作的产物，**由你那个会话带着提交** |
| `2c56e92` | 2026-09-10 20:08 | `fix: seed only the runtime inputs a run declares, and stop the isolated spawn reading agent blind`（即 `integration_runtime_paths`） | 同上，双 Driver 集成缺运行期数据（gitignored `data/`）问题的修复 |
| `16397c0` | 2026-09-11 02:13 | 文档：r4 会话的七条实测发现 | 覆盖了我在同一文件上的追加 |
| `071c653` / `f008075` | 2026-09-11 07:40 / 07:49 | `fix(boundary): a non-Git workspace froze every cycle step on a whole-tree byte hash`（`lib/tools/oracle-exec.js`、`lib/tools/verification-boundary.js`） | 距盘点仅 9–18 分钟，属**并行会话**的改动 |

**归因说明（诚实边界）**：这些提交都署你的 git 身份，我**无法**仅凭日志证明作者，只能给出时间与内容；能确证的是工作树干净 ⇒ 我没有留下未提交的代码改动。

## 5. 本会话我的写入实际落在哪里

- **工作区**（`D:\A\1NUS\resume-workshop\SG-career`）：由结对席位按协议写入（`public/pool.mjs`、`public/app.js`、`scratch/regression/*`、`.pair-oracles/**`）。**我不写产品/工作区文件**（I1 单写者不变量）；我在工作区内的动作仅限：跑 `node --check`/oracle/整机命令、只读核对字节与 digest、以及板面裁决。
- **插件仓库**：只有上面第 2 节的文档追加（已被覆盖），以及本文件。
- **仓库外**：第 3 节的 RETRO 素材文件。

## 6. 本会话**只读**使用过的插件内部（用于判断机制，未改动）

`lib/tools/oracle.js`（:108-125 重冻守卫：accepted 锁、in-flight 门、reject 豁免）、`lib/tools/oracle-exec.js`（:79-91 封印 digest 公式）、`lib/protocol/oracle.js`（:75-90 `redProblem`）、`lib/protocol/obligation.js`（:46/:58-71 准备窗口）、`lib/tools/command-shape.js`（:130-187 未运行判定）、`lib/tools/gate.js`（:78-82/:101 凭据与披露计费）、`lib/tools/oracle.js:30-36 assertPreparationWindow`、`tools/oracle.js:161-169/:139/:176`。

## 7. 与并行会话的协作约定（避免互相覆盖）

- 你在同一仓库里有活跃会话且刚刚提交过（07:40/07:49）；因此本会话**不碰源码、不改动你正在编辑的文档**，只新增本文件供你取舍（可提交、可删除）。
- 我在同一目录里对 `2026-09-10-refactor-proposals-…md` 的追加被你的版本覆盖过 ⇒ 若你希望保留 G11 那条（『实现完成后的 oracle 无法再改进』），它目前只存在于 RETRO 素材与本文件的描述里，可以从那里回填。