# VSA PR #9 Runner 兼容性与错误分类最终审计报告

## 1. 仓库真实基线

- 工作分支：`vsa-reliability`
- 本轮代码提交：`d4d8197`，父提交为 `8144672`
- `origin/main`：`d3ea933`
- PR #9：OPEN，目标为 `main`，远端地址为 https://github.com/Souitou-iop/venerax-configs-enhanced/pull/9
- 本轮没有修改 `index.json`、正式漫画源 JS、订阅地址或工作流。
- 工作区原有未跟踪目录和文件已保留，未纳入本轮提交。

历史 SHA 关系已经由 `git log` 核实。`5ba79a3`、`a5a1f5a`、`cf18358` 均位于 `8144672` 之前，`8144672` 是本轮前远端 HEAD，`d4d8197` 是本轮代码修复后的本地 HEAD。

## 2. 复现清单

| 问题 | 修改前实际表现 | 本轮结果 |
| :-- | :-- | :-- |
| ehentai 探索 | `explore page 0 is not supported by runner` | 已消除。Runner 可执行 `loadNext`，真实复测继续到 pages 阶段，最终因该条目返回空图片列表而 `FAIL/SOURCE_PAGES_ERROR` |
| 合法分页接口 | Runner 只分支 `loadPage` 与 `loadMultiPart` | `search.loadNext`、`explore.loadNext`、`explore.loadMixed` 已加入通用分支 |
| Runner 能力缺口 | 错误文本没有责任来源，Python 可能按源错误归因 | 结构化 `error_origin=runner`、`RUNNER_UNSUPPORTED_CAPABILITY` 会归 `ERROR` |
| 动态图片回调 | `getImageLoadingConfig` 抛错后继续下载 | 回调异常或无效 headers 在下载前返回 `IMAGE_CONFIG_ERROR` |
| 跨阶段 JS 状态 | 每阶段启动独立 Runner，状态是否复用未验证 | `vsa_stateful` Fixture 实测为 search PASS、info FAIL，证明当前策略不复用 JS 内存状态 |

## 3. Venera 接口能力矩阵

| 接口 | 实际 SDK 契约 | Runner 状态 | Fixture |
| :-- | :-- | :-- | :-- |
| `search.load` | `(keyword, options, page)`，返回 `{comics, maxPage}` | 支持 | 既有 `vsa_fixture` |
| `search.loadNext` | `(keyword, next, options)`，返回 `{comics, next}`，首个游标为 `null` | 支持 | `vsa_paginated` |
| `explore.load` | `(page)`，返回 `{comics, maxPage}` | 支持 | 既有源与 Fixture |
| `explore.loadNext` | `(next)`，返回 `{comics, next}`，`next=null` 表示结束 | 支持 | `vsa_paginated` |
| `explore.loadMultiPart` | 返回多个 `ExplorePagePart` | 支持 | 既有源与 Fixture |
| `explore.loadMixed` | `(index)`，返回 `data`，元素可为漫画列表或 `ExplorePagePart` | 支持 | `vsa_mixed` |

页码型接口使用 1 起始页码。`loadMixed` 使用 SDK 的 0 基索引。游标由 Runner JSON 的 `subData` 传出，调用方负责终止和重复游标控制。本轮没有引入无限翻页。

## 4. 代码改动

- `scripts/vsa_dart/bin/vsa_runner.dart` 增加 search/explore 的 `loadNext`、`loadMixed` 适配，保留 `loadPage` 与 `loadMultiPart`，并输出结构化错误字段。
- `scripts/vsa_dart/bin/vsa_runner.dart` 为 Runner 能力错误、协议错误和源阶段错误提供不同错误码与来源。图片配置回调失败会在实抓前结束。
- `scripts/vsa/chain.py` 优先读取 Runner payload 的 `error_origin`、`error_code`，Runner 错误统一归 `ERROR`，源错误保持 `FAIL`。
- `scripts/vsa/fixture.py` 增加分页、混合返回、动态图片配置失败和跨阶段状态 Fixture。
- `scripts/source_assurance.py` 增加结构化 Runner 能力错误、游标终止和新增 Fixture 的自动计数。
- `docs/vsa.md` 补充实际 SDK 能力矩阵、错误语义和稳定错误码。

SDK 当前会为缺失的 `loadEp` 生成包装函数，因此调用结果是源侧 `TypeError`。该情况实测为 `FAIL/SOURCE_PAGES_ERROR`，没有被误报成 Runner 能力缺口。

## 5. 错误分类对照

| 实际来源 | 错误码示例 | 最终状态 |
| :-- | :-- | :-- |
| Runner 未实现合法协议能力 | `RUNNER_UNSUPPORTED_CAPABILITY` | `ERROR` |
| Runner 输出畸形或 JSON 无法解析 | `RUNNER_PROTOCOL_ERROR` | `ERROR` |
| Runner 内部异常或超时 | `RUNNER_EXCEPTION`、`RUNNER_TIMEOUT` | `ERROR` |
| 源 JS 或解析阶段错误 | `SOURCE_SEARCH_ERROR`、`SOURCE_INFO_ERROR`、`SOURCE_PAGES_ERROR` | `FAIL` |
| 动态图片配置回调抛错或类型错误 | `IMAGE_CONFIG_ERROR` | `FAIL` |
| 有声明且观察到对应 HTTP 状态 | `NETWORK_STATUS_BLOCKED` | `BLOCKED` |

Runner 错误文本包含 `403` 或“需要登录”时仍按 `error_origin=runner` 归 `ERROR`，不会被 `blocked_patterns` 覆盖。

## 6. 测试矩阵

最终本地自动自检报告为 `/Volumes/SanDisk/Projects/venerax-configs-enhanced/work/vsa/reports/vsa-offline-20261115-131816.json`，自动统计 **25/25 通过**。覆盖内容包括：

- 既有完整链路、HTML 伪图片、损坏字节、404、截断 JPEG、第二张失败、SSRF、样本不足、AVIF 未解码和声明式 BLOCKED。
- JS 语法错误、搜索错误、详情错误、声明式限制与 JS 错误同时出现。
- `search.loadNext`、`explore.loadNext` 首页和终止游标、`explore.loadMixed`。
- `RUNNER_UNSUPPORTED_CAPABILITY`、Runner 缺失、Runner 畸形输出和运行时缺失。
- `onImageLoad` 抛错不得 PASS。
- 跨阶段状态不复用的可复现 Fixture。

`python scripts/source_assurance.py --check-coverage` 的结果为正式源 46 个、已纳管 46 个、豁免 0 个、问题 0 个。Dart Runner 已通过真实 `dart build cli` 重编译。`python -m py_compile scripts/source_assurance.py scripts/vsa/*.py` 与 `git diff --check` 均通过。Dart analyze 仅保留仓库原有 `pubspec.yaml` 的 git dependency 发布警告，没有本次代码错误。

## 7. Live 结果

### ehentai

最终本地报告为 `/Volumes/SanDisk/Projects/venerax-configs-enhanced/work/vsa/reports/live-ehentai/vsa-live-20261115-132752.json`。

- load：PASS
- metadata：PASS
- explore：PASS，25 条结果
- info：PASS
- pages：FAIL，`SOURCE_PAGES_ERROR`，实际条目返回空图片列表

本次真实结果中没有 `explore page 0 is not supported by runner`，所以原先的 Runner 能力缺口已被消除。该源仍不能因为本次网络返回空图片而宣称 PASS。

### manben

最终本地报告为 `/Volumes/SanDisk/Projects/venerax-configs-enhanced/work/vsa/reports/live-manben-final/vsa-live-20261115-132848.json`。

- load、metadata、search、info、pages：PASS
- image：PASS，2/2 张真实图片字节验证通过，2 张完整解码
- 最终状态：PASS，`runtime_image_decoded`

## 8. CI 记录

PR #9 当前仍为 OPEN。GitHub 上最近一次远端检查属于本轮提交前的远端 SHA，`PR Source Validate` 与版本检查成功，`enable-auto-merge` 检查失败。`d4d8197` 尚未推送，因此没有最终 SHA 对应的 GitHub Actions 运行和 Artifact 证据。本地确定性门槛已经通过，远端最终检查需要在该提交进入 PR 后重新运行。

## 9. 安全边界与残余技术债

本轮继续复用现有 URL/DNS/TLS 护栏、手动重定向和跨 Origin 敏感头清理。新增列表接口只调用 `venera_core` 的既有网络桥，没有另建未保护的网络客户端。现有 DNS TOCTOU、JS 网络桥内部重定向逐跳复核不足和缺少进程级出站沙箱的边界仍保留，文档没有将 Runner 描述成任意社区 JS 的完全安全执行环境。

## 10. 合并建议

**本地代码层面可合并。** 25/25 离线自检、46/46 覆盖率、Runner 重编译、ehentai 能力缺口复现消除和 manben 回归均有真实执行证据。

**PR 当前不应直接宣称已完成最终合并门槛。** `d4d8197` 尚未推送，远端 CI 还没有针对最终 SHA 重跑。推送后应确认确定性 PR 检查、Runner 构建和最终报告 Artifact，再由维护者决定合并。未执行自动合并。

## 11. 下一阶段建议

PR #9 经维护者审核并完成最终 CI 复核后，再启动 `docs/vsa-diagnose-rfc.md` 规划的 Diagnose MVP。第一批工作应是脱敏历史结果持久化、按运行时/源文件/配置哈希做变化检测，以及生成指出证据位置的诊断摘要。本轮不实现自动修复、自动提交 PR 或 Dashboard。

## 结论摘要

本次修改已经消除了“合法源接口不受支持被误判为 FAIL”的风险。可复现证据是 `vsa_paginated`、`vsa_mixed` 的 25/25 离线自检，以及真实 `ehentai` 已从原先的 unsupported 文本推进到实际 pages 结果。

本次修改已经消除了“动态图片回调失败仍被判 PASS”的风险。可复现证据是 `vsa_image_config_failure` 在公开图片 URL 可用的情况下仍得到 `FAIL/IMAGE_CONFIG_ERROR`，且下载不会继续。

本地代码可以进入 PR 审核，但 PR #9 目前还不能称为已完成最终合并验证，因为 `d4d8197` 尚未推送并缺少该 SHA 对应的远端 CI 结果。
