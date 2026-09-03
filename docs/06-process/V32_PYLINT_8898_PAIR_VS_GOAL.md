# v3.2 验证记录：pylint-dev__pylint-8898（pair vs goal-only）

日期：2026-09-04。该记录只覆盖冻结验证的第 1 题；`sphinx-11510` 与
`sphinx-10614` 未运行，因此不能据此宣布三题预注册判据的整体 PASS。

## 执行设置

- 两臂均通过 DSH 的本地浏览器入口运行，模型锁定为 **Muse Spark 1.3
  Contributor / Xhigh**。
- `repo-pair` 使用 `/pair`；`repo-goal` 明确禁止 pair 工具和多代理协作。
- 两臂都先读取冻结的 `VALIDATION.md` 和该题 `SPEC.md`，只修改各自的
  `pylint/config/argument.py`。
- 评分在新的副本中进行：对副本应用 sealed `test.patch`，使用冻结 venv、
  `PYTHONPATH=sitecustomize;<repo>`、`PYTHONDONTWRITEBYTECODE=1` 及指定
  `TMP/TEMP`。工作臂的 repo 未被评分测试修改。

## 评分结果

| 臂 | F2P | P2P | 产物 | 结论 |
| --- | --- | --- | --- | --- |
| pair | 0/1 | 18/18* | 缺 `patch.diff`、`self-report.json` | 正确性失败，且交付不完整 |
| goal-only | 1/1 | 18/18* | `repo`、`patch.diff`、`self-report.json` 齐全 | 本题通过 |

F2P 是 `tests/config/test_config.py::test_csv_regex_error`。pair 在应用评分
测试后以 `DID NOT RAISE` 失败；goal-only 通过。两臂在 P2P 的 18 条上均
通过。

\* sealed manifest 的第 11 个 P2P node-id 被截断为
`test_csv_regex_comma_in_quantifier[foo,`，按原样执行会让 pytest 在收集阶段
报 `not found`，两臂都会得到 exit 4。评分副本的 collect-only 结果显示唯一
对应参数化条目为 `test_csv_regex_comma_in_quantifier[foo, bar-expected2]`；以
这条替代截断值后，两臂均为 `18 passed`。原 manifest 的 node-id 是独立的
冻结评分缺陷，应修复后再用于后续轮次。

## 协议观察

- pair 的界面日志显示 Navigator 执行了标记为 `Pwsh` 的 “Confirm oracle
  RED with correct env” 动作。这与“非 Driver 被物理剥夺 Shell 写能力”的
  设计目标不符（除非界面角色标注错误），应视为 P0 回归候选。
- pair 创建了三个子代理，冻结 oracle 后报告 GREEN 和 13 项对照通过，但
  所有子代理随后空闲。人工发送“继续？”后它完成到 21 轮、71 步，但仍未
  写出 `patch.diff` 或 `self-report.json`。这不是瞬时中断，而是收尾产物
  协议没有可靠闭合。
- 模型面板的最终自报成本：pair 为约 5.5M 输入 token、31K 输出 token、LLM
  9 分 28 秒；goal-only 为约 4.0M 输入 token、31.6K 输出 token、LLM
  9 分 31 秒。pair 最终并未节省 token 或 LLM 时间，且本题 F2P 失败。

## 实现质量对比

- **pair 的优点**：`_split_regex_csv` 还保护 `[]`、`()` 和反斜杠转义，因而
  能处理字符类、分组或转义逗号中的字面逗号；相比只保护量词，这个方向对
  通用正则 CSV 更完整。
- **pair 的缺点（实测回归）**：原 `_check_csv` 的契约支持 `list`/`tuple`。
  pair 新 splitter 直接遍历该容器，`['foo', 'bar']` 被拼成一个模式
  `['foobar']`；goal-only 的显式 list/tuple 分支正确保持
  `['foo', 'bar']`。这会影响结构化/TOML 配置入口，当前 P2P 清单没有覆盖。
- **goal-only 的优点**：只改变本题的花括号分隔语义，并保留结构化输入契约；
  F2P 与完整 P2P 均通过，改动范围较小。
- **goal-only 的局限**：不保护 `[]`、`()` 或已转义逗号，因此未解决这些更广
  的嵌入逗号情形；它是更保守的、针对本题的实现，而非完整通用解析器。

## 后续优先级

1. 修复并做自动化回归：Navigator/Challenger 不能获得 `pwsh`、`bash` 或
   `Bash`；测试应以实际工具注册和调用结果断言，而非只检查策略文本。
2. 为 pair 的终止状态建立 watchdog：当 Driver、Navigator、Challenger 都
   空闲且已有 GREEN/GO 状态时，必须要么完成 gate、写出三项产物，要么明确
   失败，不得静默悬置。
3. 修正 sealed manifest 的截断 P2P node-id，再继续另外两题的预注册验证。
