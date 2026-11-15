# VSA Diagnose MVP 中文交付报告

## 给维护者看的结果

从下一次可信的每日 VSA 运行开始，系统会在保存原始 VSA 报告的同时生成一份 Diagnose 摘要。摘要会告诉维护者哪些源是第一次观察、哪些源新失败、哪些源持续失败、哪些源恢复、哪些结果受环境限制，以及哪些结果来自测试基础设施异常。

维护者优先查看 GitHub Actions Summary 中的 `VSA 每日诊断`，再根据摘要中的源、阶段、错误码和证据路径查看原始 VSA Artifact。源级 FAIL 仍然保留原有严格验收语义，Diagnose 只增加历史比较和排查提示。

本地可以使用一份 VSA JSON 直接生成诊断：

```bash
python scripts/source_assurance.py --diagnose \
  --report path/to/current-vsa.json \
  --against path/to/baseline-vsa.json \
  --output work/vsa/diagnose
```

也可以使用历史目录自动选择基线：

```bash
python scripts/source_assurance.py --diagnose \
  --report path/to/current-vsa.json \
  --history-dir work/vsa/history/snapshots \
  --run-id local-run-001 \
  --prune-history-days 90 \
  --output work/vsa/diagnose
```

## 已实现功能

- 读取真实 VSA `schema_version: 2` 报告，使用实际字段 `js_sha256`、`runtime_build_id`、`runner_build_id`、`error_code`、`evidence` 和 `verification_level`。
- 生成 `diagnose_history_schema_version: 1` 的脱敏快照。
- 使用独立历史目录接口，支持首次观察、重复 run ID 幂等和 90 天清理。
- 选择相同模式、Runtime、配置和执行平台的历史基线。
- 源提交 SHA 变化和 Runner 构建标识变化只作为线索记录，不自动阻止比较。
- Runtime、模式、配置或执行环境变化时输出 `NOT_COMPARABLE`。
- 支持 `FIRST_OBSERVATION`、`NEW_FAILURE`、`PERSISTENT_FAILURE`、`RECOVERED`、`INTERMITTENT`、`ENVIRONMENT_BLOCKED`、`INFRASTRUCTURE_ERROR`、`NOT_COMPARABLE`、`STATE_CHANGED`、`NO_CHANGE` 和 `SOURCE_REMOVED`。
- 从同一个诊断结果生成 JSON 和 Markdown，避免摘要数字与机器结果不一致。
- 在 Live VSA 返回非零时继续读取有效 JSON，生成诊断和快照。
- 将历史写入拆到独立 Actions job。执行社区漫画源 JS 的 job 只具备 `contents: read`，历史归档 job 才具备有限的 `contents: write`。

## 实际验证

执行了以下检查：

- `python -m unittest discover -s tests -v`，12/12 通过。
- `python -m py_compile scripts/source_assurance.py scripts/vsa/*.py`，通过。
- 读取真实脱敏 Live Artifact `/Volumes/SanDisk/Projects/venerax-configs-enhanced/work/vsa/ci-43682958463/vsa-live-20261115-055336.json`，46 个源全部生成首次观察结果。
- 使用同一真实报告第二次比较，得到 32 个 `NO_CHANGE`、13 个 `PERSISTENT_FAILURE`、1 个 `ENVIRONMENT_BLOCKED`。
- 历史快照重复写入和相同 run ID 冲突校验通过。
- GitHub Actions YAML 解析和 `git diff --check` 通过。

## 代码和文档

- `scripts/vsa/diagnose.py` 负责报告校验、上下文比较、事件计算和确定性归类。
- `scripts/vsa/diagnose_history.py` 负责脱敏快照、历史读取、幂等写入和保留清理。
- `scripts/vsa/diagnose_report.py` 负责 JSON 和 Markdown 输出。
- `scripts/source_assurance.py` 增加 `--diagnose`、`--report`、`--against`、`--history-dir`、`--run-id` 和 `--prune-history-days`。
- `.github/workflows/source-assurance.yml` 增加非零验收后的 Diagnose 续行、Artifact 上传和隔离归档 job。
- `tests/test_vsa_diagnose.py` 覆盖基线、可比较性、状态变化、间歇问题、源移除、错误输入和快照幂等。
- `docs/vsa-diagnose.md` 记录日常使用、事件语义、权限边界和数据安全规则。
- `docs/vsa-diagnose-plan.md` 保留实施决策和范围边界。
- PR #11 已创建，PR Source Validate 和 PR Version Check 已通过，地址为 https://github.com/Souitou-iop/venerax-configs-enhanced/pull/11。

## 已知限制

- 当前只实现确定性规则，暂不接入 Layer 1 的自动交叉归因。
- 第一次运行只有 `FIRST_OBSERVATION`，无法判断新增故障。
- 远端手动运行已验证完整链路。Run [43690014115](https://github.com/Souitou-iop/venerax-configs-enhanced/actions/runs/43690014115) 的 Live 失败后，Diagnose job 成功生成 46 条 `FIRST_OBSERVATION`，archive-history job 成功写入 `vsa-history`。远端快照为 `snapshots/43690014115.json`，历史提交为 `5e73764a77729db4705d5c5a0b9ba027f8655a6f`。
- 现有 VSA 的跨阶段 JS 内存状态、DNS TOCTOU 和出站隔离边界保持原样。
- 归因证据不足时会输出低置信度或 UNKNOWN，摘要不会把假设写成事实。

本轮没有修改漫画源、Runner、`index.json` 或 VSA 原始状态语义，也没有开发 Dashboard、LLM 自动修复、Issue 或 PR 自动化。
