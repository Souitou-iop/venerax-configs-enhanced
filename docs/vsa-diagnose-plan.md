# VSA Diagnose MVP 实施计划

## 1. 目标和边界

Diagnose 读取现有 VSA `schema_version: 2` JSON，生成脱敏历史快照，选择可比较的历史基线，计算确定性状态变化，并输出 JSON 与 Markdown 摘要。

本阶段覆盖历史快照、基线选择、状态变化、证据归类、离线测试和每日 Actions 集成。VSA Runner、Venera Core、46 个正式源和 Layer 1 探针保持现有边界。初版不接入 LLM，不自动修改源、不自动创建 Issue 或 PR、不建设 Dashboard。

## 2. 当前实际数据和接口

当前报告由 `scripts/vsa/report.py::build_report` 生成，顶层字段为：

- `schema_version`
- `meta`
- `summary`
- `results`
- 离线自检报告还包含 `self_test`

当前 `meta` 实际包含 `time`、`mode`、`runtime`、`runtime_path`、`runtime_build_id`、`runner_build_id`、`runner_path`、`source_commit`、`config_hash`、`strict` 和平台信息。

每个 `results[]` 实际包含 `key`、`name`、`version`、`file`、`js_sha256`、`state`、`detail`、`error_code`、`verification_level`、`evidence` 和 `stages`。每个阶段包含 `stage`、`state`、`detail`、`elapsed_ms`、`error_code`、`evidence`。

Diagnose 将真实字段 `js_sha256` 映射为历史快照中的 `source_sha256`，保留 `vsa_report_schema_version` 与独立的 `diagnose_history_schema_version`，避免把 RFC 示例字段误认为当前实现。

当前 Live 工作流位于 `.github/workflows/source-assurance.yml`。它保留严格 VSA 的非零退出语义，并使用 `if: always()` 上传 `/tmp/vsa_out/`。Diagnose 集成会把诊断步骤放入后续 job，确保 VSA 非零时仍可读取有效报告并生成摘要。

## 3. 历史存储方案比较

### 方案 A：独立 `vsa-history` 分支

每天只写入脱敏、精简的 JSON 快照，按日期或运行 ID 保存。Live job 使用 `contents: read`，归档 job 下载和校验 Artifact 后获得最小范围的 `contents: write`。历史分支与 `main` 的源代码变更隔离，适合长期基线查询，也能通过 Git 保留审计轨迹。

风险是需要处理并发写入、重复运行和首次创建分支。计划用 workflow concurrency、基于远端最新提交的重试和 `run_id` 幂等键处理。

### 方案 B：仅使用 GitHub Actions Artifact

实现简单，原始报告已经上传，Diagnose 可以读取近期 Artifact。

Artifact 保留期有限，历史基线会自然消失，无法满足跨运行长期比较，因此只作为短期人工核查和归档失败时的兜底产物。

### 最终选择

选择方案 A。历史分支保存最近 90 天的脱敏快照，超出期限的快照在归档 job 中清理。原始 VSA Artifact 继续按现有保留策略上传，诊断 Artifact 与摘要单独上传。首次没有 `vsa-history` 分支时创建基线快照，所有源输出 `FIRST_OBSERVATION`。

## 4. 历史快照格式

历史快照定义 `diagnose_history_schema_version: 1`，每次 VSA 运行保存一个文件，至少包含：

- `run_id`、UTC 时间、报告内容哈希、仓库提交 SHA。
- `mode`、`strict`、`runtime_build_id`、`runner_build_id`、`config_hash`、测试策略版本和可取得的环境标识。
- 每个源的 key、源版本、`js_sha256`、状态、验证等级、总体错误码、首个失败阶段、阶段错误码。
- 经白名单过滤的结构化证据，例如 HTTP 状态码、证据类型、challenge probe 结论、计数和置信度。
- 源数量、完整性、缺失字段和报告是否完整生成。

历史快照不保存 Cookie、Authorization、Token、签名 URL、完整 headers、完整 HTML、响应正文、堆栈全文或用户数据。字符串摘要限制长度，URL 只保留脱敏后的 origin/path，所有 Markdown 输出进行转义。

历史写入前执行严格校验。未知 VSA schema、损坏 JSON、缺少关键元数据时保留归档失败证据，并输出无法比较结果，不覆盖上一份健康基线。

## 5. 基线和差异规则

基线选择按源 key 独立执行，优先寻找最近一条满足以下条件的记录：

1. 相同 source key 和测试模式。
2. 相同 `runtime_build_id` 与 `runner_build_id`。
3. 环境标识相同或缺失但没有冲突证据。
4. 测试配置和样本策略相同，或者差异已被记录为低置信度。
5. 报告完整且该源确实执行过。

`js_sha256` 变化记录为源文件变化线索，不阻止比较，也不单独证明故障由源代码引起。环境、运行时、Runner 或测试策略变化时输出 `NOT_COMPARABLE`，并保留原因。

事件集合为 `FIRST_OBSERVATION`、`NEW_FAILURE`、`PERSISTENT_FAILURE`、`RECOVERED`、`INTERMITTENT`、`ENVIRONMENT_BLOCKED`、`INFRASTRUCTURE_ERROR`、`NOT_COMPARABLE`、`STATE_CHANGED` 和 `NO_CHANGE`。

`PASS -> FAIL` 只在可比较基线为 PASS、当前结果为 FAIL 时输出 `NEW_FAILURE`。`FAIL -> PASS` 需要当前验证等级达到严格验收门槛才输出 `RECOVERED`。`BLOCKED`、`UNVERIFIED`、`ERROR` 的转换保留原状态和新状态，使用 `STATE_CHANGED` 或专门的受限事件表达。

同时比较总体状态、首个失败阶段、错误码、验证等级、源 SHA、运行时和 Runner 版本。阶段从 search 变化到 image 时必须在 diff 中显示。

历史不足时不输出 `INTERMITTENT`。建议至少需要 4 次可比较记录并且存在两次状态反转，才标记间歇问题。

## 6. 诊断归类

归类只读取实际报告字段和结构化证据。每个诊断条目包含：

- `observed`，事实上的状态、阶段、错误码和证据。
- `hypothesis`，有条件的可能原因，可以为空。
- `confidence`，`high`、`medium`、`low` 或 `unknown`。
- `next_checks`，最多三项具体排查动作。

初版覆盖以下规则：

- `RUNNER_*`、`RUNTIME_MISSING` 和同轮大面积 `ERROR` 归基础设施问题。
- `AUTH_REQUIRED` 归鉴权限制。
- 已有 `NETWORK_STATUS_BLOCKED`、`CHALLENGE_PAGE` 及对应证据时归环境限制。
- `SOURCE_*_PARSE_ERROR` 且没有挑战证据时提示源解析或站点响应变化，假设置信度为 low/medium。
- 阶段通过后图片阶段 HTTP、HTML、解码错误归图片链路问题，保留实际错误码。
- 5xx 只陈述上游 HTTP 事实。没有 Layer 1 证据时不升级为上游服务根因。
- 配置覆盖和元数据问题归测试配置。
- 证据不足、字段矛盾或无法归类时输出 `UNKNOWN`。

同一轮大量 ERROR 时摘要置顶基础设施异常，并抑制批量 `NEW_FAILURE`。源级 FAIL 继续保留原始 VSA 结果。

## 7. CLI 与模块边界

优先扩展 `scripts/source_assurance.py`，增加：

```bash
python scripts/source_assurance.py --diagnose \
  --report path/to/current.json \
  --against path/to/baseline.json \
  --output work/vsa/diagnose/

python scripts/source_assurance.py --diagnose \
  --report path/to/current.json \
  --history-dir path/to/history \
  --output work/vsa/diagnose/
```

实际参数以实现为准，但必须支持离线两报告比较和历史目录自动选基线。退出码定义为：

- `0`，诊断完成，输入有效，无系统错误。报告中的源级 FAIL 不改变该退出码。
- `1`，输入校验失败、schema 不兼容或无法读取当前报告。
- `2`，历史归档、文件系统或系统级错误。

计划新增以下模块：

- `scripts/vsa/diagnose.py`，纯规则、基线选择、可比较性和事件计算。
- `scripts/vsa/diagnose_history.py`，快照脱敏、校验、幂等和历史目录接口。
- `scripts/vsa/diagnose_report.py`，从同一个诊断结果生成 JSON 和 Markdown。
- `scripts/vsa/diagnose_fixture.py`，离线历史样本。
- `docs/vsa-diagnose.md`，使用方法、事件语义、退出码和安全边界。

现有 `chain.py`、Dart Runner、漫画源 JS、`index.json` 和源配置不重构。

## 8. CI 数据流与权限

每日工作流拆为四个逻辑阶段：

1. Live VSA job 使用现有 `contents: read`，构建 Runner，执行覆盖率和严格 Live，保留原退出码。
2. Artifact job 使用 `if: always()` 保存原始报告和 VSA 退出状态。
3. Diagnose job 只在有效 JSON 存在时执行，写入 `$GITHUB_STEP_SUMMARY`，上传 `diagnose.json`、`diagnose.md` 和快照候选文件。没有有效报告时明确输出无法诊断。
4. History archive job 只在可信 schedule 或手动 workflow 运行，并在完成脱敏校验后使用有限 `contents: write` 更新 `vsa-history`。PR workflow 不执行写入。

工作流使用 concurrency 防止每日任务并发覆盖。归档以 `run_id` 为幂等键，冲突时重新拉取远端分支、合并新快照、重试写入。写入失败保留所有短期 Artifact，并在 Summary 标记历史归档失败。

源 JS 执行进程不获得写权限、Secrets 或历史分支凭据。源名、错误文本和路径写入 Markdown 前统一转义和截断。

## 9. 离线验收矩阵

Phase 1 至少覆盖：

- 无历史的 `FIRST_OBSERVATION`。
- PASS → FAIL 的 `NEW_FAILURE`。
- FAIL → PASS 的 `RECOVERED`。
- 相同阶段和错误码的持续失败。
- 阶段或错误码变化。
- 多轮状态交替和历史不足。
- Runtime/Runner、环境和策略变化导致 `NOT_COMPARABLE`。
- 新增、下线、同名不同 key、单源 SHA 变化。
- BLOCKED、UNVERIFIED、ERROR 的转换。
- 多源同时 ERROR 的基础设施优先级。
- 损坏、重复、乱序、不兼容历史文件。
- Cookie、Token、签名 URL、HTML、堆栈和恶意 Markdown 的脱敏与转义。
- VSA 有效 JSON 伴随非零退出码时仍能诊断，无 JSON 时安全失败。
- 相同 run_id 重试、并发归档和冲突重试。

测试同时断言 JSON 事件、摘要计数、证据和 Markdown 内容一致。使用纯 Fixture，并加入一组已脱敏的真实 VSA 报告样本。

## 10. 实施阶段

### Phase 0：审查与计划

本计划完成后再进入编码。当前已确认报告 schema、工作流退出语义、权限边界和现有 VSA 数据路径。

### Phase 1：离线核心

实现两报告比较、历史目录读取、确定性分类、JSON/Markdown 输出和 Fixture。验收重点是可比较性和事实/假设分离。

### Phase 2：历史持久化

实现脱敏快照、`vsa-history` 分支接口、首次运行、幂等键、保留策略和归档失败处理。

### Phase 3：CI 集成

拆分诊断与归档流程，确保 Live 源级 FAIL 仍生成诊断，PR workflow 不具备历史写权限。

### Phase 4：交付

更新中文使用文档、实际命令和输出示例，执行离线测试、脱敏真实样本演示和可控的 GitHub Actions 验证。

## 11. 不在本轮处理的事项

- VSA Runner 的跨阶段持久会话。
- DNS TOCTOU、进程级出站隔离等既有技术债。
- 46 个漫画源的重构或路径迁移。
- Layer 1 强耦合归因。
- LLM、自动修复、自动 Issue/PR、Dashboard。

## 12. 计划阶段完成标准

- 已核实当前 VSA 报告字段和真实报告样本。
- 已明确独立历史分支与 Artifact 的权衡。
- 已明确 CLI、模块、快照、基线和事件语义。
- 已明确 Live、Diagnose、归档三个权限边界。
- 已列出离线测试和安全测试范围。
- 尚未实现 Diagnose 代码或修改 GitHub Actions。
