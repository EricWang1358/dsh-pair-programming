# PLUGIN-READINESS-GATES.md — DSH 插件准入流程

> 来源：本次 `dsh-pair-programming` 事故复盘。根因不是代码 bug，而是**准入纪律**——
> 一个仍处于开发态的插件被放进了日常 `web` profile 的 `bundles`。
> 只要"能被日常 profile 自动加载"，就等同于"可发布准入"；DSH 必然尝试加载它，加载失败即拖垮整个 profile。
> 本节为**所有**个人 DSH 插件（pair-programming / chat-mindmap / 未来项目）定义的通用门槛。

## 0. 核心原则

> **"能被日常 profile 自动加载" = 可发布准入。** 在达到 Stable 前，开发插件**绝不**进入 `web` profile 的 `bundles`（即使 `disabled: true` 也只是止血，不是准入）。开发只在专用 profile 里进行。

## 1. 阶段与准入条件

| 阶段 | 准入条件（必须全部满足才能进入下一阶段） | 禁止事项 |
|---|---|---|
| **Draft** | 本地源码 + 独立开发 profile（如 `pair-dev`）加载本地 link | ❌ 加入日常 `web` profile |
| **Alpha** | `typecheck` + `test` + `build` + `verify:package`（干净 pack）全过；运行时 import 依赖检查过 | ❌ 默认启用 |
| **Beta** | 与目标 DSH SDK cohort 的**真实 profile 启动冒烟**通过（`verify:startup` / `dsh --profile pair-dev`） | ❌ 把运行时依赖只写在 `devDependencies` 或标 `optional` |
| **Stable** | 真实日常 profile 启动 + 回归通过 | ❌ 用本地 `link:` 代替发布（tarball 安装）验证 |

## 2. 准入硬门禁（启用进任何日常 profile 前必跑）

```text
node scripts/setup-peers.mjs          # 解析插件真实路径下的 @deepseek-ai/* peer
node scripts/typecheck.mjs            # 全部源文件语法/可解析
node tests/run.mjs                    # 纯逻辑单测（协议/状态/门禁）
node scripts/verify-runtime-imports.mjs   # ← 门禁①：运行时 import 依赖检查
node scripts/build.mjs                # 产物入口/exports/patch 存在
node scripts/verify-package.mjs       # 干净 pack 的 tarball manifest 校验
node scripts/verify-startup.mjs       # ← 门禁②：真实 SDK 下 import 入口 + apply() 装配
```

对应 `pnpm verify`（已串成一条命令，任一失败即 nonzero）。

### 门禁①：运行时 import 依赖检查（`verify-runtime-imports.mjs`）
扫描产物中所有**非 type-only** 的 `@deepseek-ai/*` 值导入，要求每一项都被 `dependencies` 或**必需** peer 覆盖。
教训：`@deepseek-ai/schemastery` 被 `config.js` 实际 import，却标成 `optional` peer —— 这是错误建模，
profile 组合期不报错，真实 `dsh` 启动 `apply()` 时才 `ERR_MODULE_NOT_FOUND`。

### 门禁②：profile 启动冒烟（`verify-startup.mjs`）
按真实 SDK 组合加载一次：动态 import 入口、运行 `apply()`、断言
①无 `ERR_MODULE_NOT_FOUND`；②插件运行时用到的每个 SDK 导出（`defineTool`、`installModelSelection`、
`foldSubagentDescriptor`、`ReasoningEffortId`、`KNOWN_SESSION_EVENT_TYPES` …）都真实存在。
SDK 升级若删改这些导出 → 本门禁失败 → **阻止启用**，必须先完成 API 迁移。
（等价手动验证：`dsh --profile pair-dev`，能存活而非秒退即通过。）

## 3. link: 插件的 peer 解析陷阱（关键工程事实）

`dsh plugin --profile X add <本地目录>` 用 **pnpm `link:`**，插件真实路径在工程外。
Node ESM 从**真实路径**向上找 `node_modules`，**不会借用 profile 或 DSH 全局的 `@deepseek-ai/*`**。
所以链接态插件要能启动，必须让 `plugin/node_modules/@deepseek-ai` 可解析。两条正解：

- **首选（发布/安装态）**：`pnpm install` 让 peer 落成真实副本 —— 前提是这些包可单独拉取。
- **离线兜底（本仓库采用）**：`setup-peers.mjs` 把 `plugin/node_modules/@deepseek-ai` 做成
  junction，指向 DSH 安装内置的同一份 `@deepseek-ai`（与 `dsh-base` **同物理实例**，保持
  `defineTool`/brand 的单例语义）。由 `postinstall` 自动执行，幂等。

`prepare` 钩子会在 `npm pack` 时运行并污染 `pack --json` 输出 → **必须**用 `postinstall`（仅安装时跑，pack 时不跑）。

## 4. SDK cohort 锁定

在 `package.json` 的 `dsh.sdk` 显式声明 tested cohort 与支持范围：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "sdk": { "testedCohort": "@deepseek-ai/dsh@0.1.2-alpha.2 (cordis 4.0.1)",
           "supportedDsh": ">=0.1.2-alpha <0.2" }
}
```

peer 用区间（如 `>=0.1.0-rc <2`），与 `@ericwang1358/dsh-chat-mindmap` 对齐。
**升级 DSH 到新版后**：先跑 `verify:startup`，完成任何 API 迁移，再允许在 `web` profile 启用。

## 5. 命名规范

- 个人插件一律 `@ericwang1358/...`（与 `dsh-chat-mindmap` 一致），**不用** `@dsh-community`。
- 包名来自 `package.json` 的 `name`，DSH 按 npm 包名加载，与本地路径无关。
- 改名的权威落点（改任一被 `dsh plugin add` 还原的地方都无效）：
  1. `package.json` 的 `name`
  2. 本插件 `cordis.patch.yml` 里 bundle 行的 `name`
  3. 日常 profile 的 `dependencies` 键 + `dsh.profile.bundles` + `cordis.patch.yml` 的 stanza
  4. README、`publishConfig`、本地 link
- 改名要在**插件禁用/移除态**下做（本次即在 web remove 后迁移）。

## 6. profile 卫生检查表（每次准备启用进 `web` 前）

- [ ] `dsh --profile web --dump-config` 里**没有**该插件，或明确 `disabled: true`（Stable 前应为前者）
- [ ] `verify` 链（含两道门禁）全绿
- [ ] 若改过 `name`/`bundles`/`cordis.patch.yml`：`dsh plugin --profile web add/remove` 走正式路径，未手改 `node_modules`
- [ ] 升级过 DSH：针对新 cohort 重跑 `verify:startup`
- [ ] profile 的 `node_modules/@deepseek-ai` 或悬空 `file:`/`link:` 目标存在（避免拖垮全量 `pnpm install`）

## 7. 本次事故的因果链（留档）

1. 设计文档把依赖写成"调用 agent-teams 公开工具" → 隐含硬依赖 → 已改为**自含运行时 + 零第三方插件依赖**。
2. 开发态插件被 `dsh plugin --profile web add` 进了日常 profile 的 `bundles` → DSH 必然加载 → 根因。
3. `@dsh-community` 命名不符个人规范 → 迁 `@ericwang1358`。
4. `schemastery` 等运行时导入误标 `optional` peer → 加**门禁①**扫描堵死。
5. `link:` 从真实路径解析 peer 失败 → `setup-peers` + **门禁②**真实启动冒烟堵死。
6. `output.schema` 缺 `additionalProperties`、`npm pack` 触发 `prepare` 污染 JSON → 由 `verify:package` 捕获。

修复后：`web` 已彻底不含该插件；`pair-dev` 是唯一加载本地 link 的开发 profile；`pnpm verify` 全绿；
`dsh --profile pair-dev` 真实启动通过。
