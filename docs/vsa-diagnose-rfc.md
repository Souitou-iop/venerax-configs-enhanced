# VSA Diagnose RFC(下一阶段设计文档 · 未实现)

> 状态:RFC — 依赖 P0/P1 整改完成后评估启动门槛;本文档只是设计,不是已上线能力。
> 日期:2026-11-14

## 1. 目标

Diagnose 不是"大模型猜网站为什么坏了",而是基于**有结构、有证据、有历史基线**的验收数据做可解释归因:为每个 FAIL/BLOCKED 输出确定性归类、历史差异、脱敏诊断摘要与复现命令。

## 2. 启动门槛(全部满足才开始编码)

1. 全部正式源纳管,无静默漏测(`--check-coverage` 通过)。
2. 严格模式下 Runner 缺失不产生假 PASS(已由 `RUNNER_MISSING` 用例覆盖)。
3. 已知误判 BLOCKED 的离线用例全部通过(声明受限 + JS 错误 → FAIL)。
4. 图片抽样、真实字节与验证等级可信(`runtime_image_bytes/decoded`)。
5. Runtime/Runner 版本固定,能本地复现核心测试(`VSA_CLI_PIN` + lock)。
6. 至少一次完整 Live 运行产生可核查报告;允许真实站点失败,框架不能假通过。

## 3. MVP 范围(只做三件事)

### 3.1 故障归类(确定性规则,不用大模型)

输入:单源结果(stage 状态、`error_code`、HTTP 特征、异常摘要、challenge probe 结论)。
输出:归类 + 置信度:

| 归类 | 依据(全部来自已落盘证据) |
|---|---|
| JS 解析/站点改版 | `SOURCE_*_PARSE_ERROR` + challenge probe 为 NO_CHALLENGE |
| 上游 API 故障 | 同域名 Layer1 探针亦不可达 + Layer2 HTTP 5xx |
| 图片/CDN 限制 | 链路 PASS 而 `IMAGE_HTTP_ERROR`(403/拒连),历史同一环境曾 PASS |
| 鉴权 | `AUTH_REQUIRED`(401/登录类文本) |
| 地区/环境限制 | `NETWORK_STATUS_BLOCKED`/`CHALLENGE_PAGE` + probe 结论 |
| 运行时环境 | `RUNNER_MISSING`/`RUNNER_PROTOCOL_ERROR`/`RUNTIME_MISSING`/大面积同时 ERROR |
| 测试配置 | `CONFIG_COVERAGE_MISSING`/`SOURCE_METADATA_MISMATCH` |

### 3.2 历史差异

与同源上一份**同 runtime_build_id + 同 runner_build_id** 的报告逐阶段比较:

```
同一源旧基线 PASS → 新报告 FAIL,运行时与环境相同
  → 优先检查该源 JS diff(source_sha256 变化)

所有源同轮大面积 ERROR 且 runner 构建失败
  → 基础设施问题, 不批量标源失效

Layer1 可达 + Layer2 搜索解析失败
  → 优先查 JS 解析器与站点响应结构变更
```

差异结果输出为 `diff: {stage, from, to, source_sha_changed, runtime_changed}`。

### 3.3 诊断摘要(脱敏)

为维护者生成 Markdown:每源一段 — 归类、证据(error_code/evidence 字段)、与上一基线的差异、复现命令(`python scripts/source_assurance.py --source <key> --runtime ... --runner ...`)、明确标注为**假设**的可能原因。所有假设带置信标签(hypothesis),不写成事实。

## 4. 数据依赖

依赖报告 `schema_version: 2` 的字段:`error_code`、`evidence`、`verification_level`、`meta.runtime_build_id/runner_build_id`、`source_sha256`。历史基线 = `work/vsa/reports/` 或 CI artifacts 中同模式最近一份报告(基线可信性 = runtime/runner build_id 相同)。

## 5. 非目标

- 自动修复源 JS / 自动开 Issue(先人工审核)。
- 调用大模型归因(初期确定性规则已够)。
- 全量响应体差异分析(泄密与体积风险;只做最小化结构对比,后续可选)。

## 6. 实现顺序建议

1. `scripts/vsa/diagnose.py`:读两份 JSON → 输出差异与归类(纯函数,可离线单测)。
2. 三个历史差异 Fixture(构造旧/新报告对)+ 对应诊断断言。
3. CLI:`--diagnose --against <baseline.json>`。
