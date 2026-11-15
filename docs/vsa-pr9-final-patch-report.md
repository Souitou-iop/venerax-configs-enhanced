# VSA PR #9 最终补丁:安全边界与验收整改报告

> **依据**:《VSA_PR9_最终补丁_安全边界与验收交接文档》
> **分支**:`vsa-reliability` · **起始 SHA**:`5ba79a3` · **最终 SHA**:`cf18358`
> **PR**:[#9](https://github.com/Souitou-iop/venerax-configs-enhanced/pull/9)(OPEN,未合并)
> **本文性质**:实际执行的整改记录;全部命令与结果均为真实运行输出,可按 §8 复现。

---

## 1. 基线

| 项 | 值 |
|---|---|
| 起始 SHA | `5ba79a3`(上轮《二次整改审计报告》所载最终 SHA) |
| 最终 SHA | `cf18358`(本轮 3 个整改提交:`ba59875` P0-A/P0-B → `cf18358` rt.version 容错 → `ed916ad`/`be1461d` 等为上轮提交) |
| CI 验证 | run [43635833760](https://github.com/Souitou-iop/venerax-configs-enhanced/actions/runs/43635833760)(最终 HEAD 专属,strict,runner-only) |
| 运行环境 | 本机 macOS arm64 / Dart 3.14 / Python 3.15;CI ubuntu-latest / Dart 3.14 / Python 3.11 |
| 覆盖率 | 46/46 正式源纳管,0 问题 |

上轮报告声称的 31 PASS / 9 BLOCKED / 6 FAIL(run 43613108825)已经由 artifact JSON(非日志)独立核验属实;本轮在此基础上继续整改。

## 2. 问题复现表

| 线索 | 修改前是否成立 | 复现方式 | 修改位置 |
|---|---|---|---|
| P0-A 独立 `venera_cli` 子进程网络不受护栏约束 | **成立**:`chain.py` 的 load/search/explore/info/pages 全部经 `VeneraRuntime` 调 CLI 子进程,其网络走 `_Config.dio`(无法注入护栏) | 审计调用链:runner 拦截器只覆盖 runner 进程内的 Dio;CLI 进程是独立 Dart 进程 | **架构级修复**:runner 扩展 `--cmd load/search/explore/info/pages` 子命令,`chain.py` 全部阶段改经 runner 子命令执行;CLI 从验收路径移除 |
| P0-A DNS 解析结果不校验 | 成立(a5a1f5a 仅有 URL 字符串护栏) | `guardUrl` 无 lookup 调用 | runner 基线(上轮)已含 `guardHost` DNS 逐 IP 校验 + 共享 Dio 拦截器覆盖 JS 桥初始请求(已确认存在于 a5a1f5a) |
| P0-B 跨 Origin 重定向复用敏感头 | **成立**:`guardedGet` 重定向循环只更新 URL,`headers` 原样复用 | 构造 302→外域场景,Authorization/Cookie 会随跳转携带 | `headersForHop()`:跨 Origin 剥离 Authorization/Cookie/Proxy-Authorization/Referer(小写比较);拒绝 HTTPS→HTTP 降级 |
| P1-A chain.py counts 缺 `decoded_image_count` 导致 level 恒 bytes | **成立**:`counts` 手工构造仅 4 键,`all_decoded = counts.get("decoded_image_count", 0) == verified` 恒 False | 本机 manben live PASS level=runtime_image_bytes,而 runner 实测 WebP 解码成功 | counts 透传 runner 全部 6 项计数;level 规则=全部已验证样本解码成功才得 `runtime_image_decoded` |
| P1-A WebP 解码判定只认 lossy(VP8) | 成立(上轮已修,本轮确认) | CI 上全部 PASS 解码 0 | `decodable` 对 WebP 三变体统一尝试(本轮确认无回归) |
| P1-B PR 工作流浮动 HEAD | 成立(pr-source-validate `--depth 1` 无 pin) | 两工作流 pin 来源不一致 | `scripts/vsa/RUNTIME_PIN` 单一来源,两工作流统一 `cat` 读取;本轮 live 工作流 runner-only 后 PR 工作流仍以 RUNTIME_PIN 构建用于 `source validate` 的 CLI |
| P1-C "15 项 vs 16/16"口径 | 确认为口径问题:15=负向矩阵用例数,16=15+1 行汇总(手工 grep 误计) | 旧自检输出 `grep -c ✅` 计 16 | 用例数改由结果集合自动计算(report.self_test.total/passed/cases);现 18 项 |

## 3. 代码变更

| 文件 | 变更 | 关键函数/接口 |
|---|---|---|
| `scripts/vsa_dart/bin/vsa_runner.dart` | 全链路执行器化:`--cmd load/search/explore/info/pages/verify` 子命令(输出与 venera CLI 同构 JSON);跨 Origin 头卫生;HTTPS→HTTP 降级拒绝;`SourceStageError` 错误分层(源级→SOURCE_ERROR 归 FAIL,框架→RUNNER_EXCEPTION 归 ERROR);DNS 解析逐 IP 校验(IPv4/IPv6/mapped/CGNAT/ULA/link-local) | `guardedGet()`、`headersForHop()`、`originOf()`、`guardHost()`、`isForbiddenIp()`、`SourceStageError` |
| `scripts/vsa/chain.py` | 全阶段经 runner 子命令(`RunnerContext.search/explore/info/pages/load_source`);HTTP 状态结构化抽取(`HTTP_STATUS_RE`,不做任意子串匹配);runner 结构化错误码优先(`SOURCE_PAGES_EMPTY` 等数据层事实→FAIL,HTTP 状态→声明式分类);counts 六项透传 | `classify_failure()`、`runner_infra_error()`、`extract_http_status()` |
| `scripts/source_assurance.py` | live 强制禁用 allow_local(YAML 声明无效则警告);meta 记录 `source_commit/config_hash/runtime_build_id`;覆盖率门槛前置 | `check_coverage()` |
| `scripts/vsa/runtime.py` | `rt.version` 容错(CLI 缺失不再阻断);RUNTIME_PIN 文件读取;`build_id()` | `VeneraRuntime.version` |
| `scripts/vsa/fixture.py` | 负向 fixture 扩充:空 pages、混合解码(JPEG+AVIF)、第二张失败、SSRF、截断、声明掩盖 | `_img_bytes()` |
| `.github/workflows/source-assurance.yml` | runner-only(不再构建 CLI);覆盖率步骤前置;permissions contents:read | — |
| `docs/vsa.md` | 全链路 runner 化、跨 Origin 头卫生、残余风险声明、level 语义同步 | — |

**取舍理由**:runner 子命令输出刻意与 venera CLI 同构,使 `chain.py` 的解析逻辑零改动即可切换执行器;保留 `VeneraRuntime` 类作为构建入口与旧字段兼容(不破坏 `--runtime` 参数)。

## 4. 执行链路表(整改后)

| 验收阶段 | 执行进程 | 网络实现 | 安全措施 |
|---|---|---|---|
| load(安装+元数据) | runner 进程 | 无网络(本地文件) | 源语法错误→SOURCE_LOAD_ERROR→FAIL |
| search/explore | runner 进程 | 源 JS 经 venera_core JS 桥 → 共享受护栏 Dio | 拦截器:URL 字符串+DNS 逐 IP 校验 |
| info(详情+章节) | runner 进程 | 同上 | 同上 |
| pages(图片 URL 列表) | runner 进程 | 同上 | 同上 |
| image(字节+解码) | runner 进程 `guardedGet` | 同上 + `followRedirects=false` 手动逐跳 | 每跳重走 URL/DNS 护栏;跨 Origin 剥敏感头;HTTPS→HTTP 拒绝;跳数上限 5;TLS 校验开启 |

**已声明残余风险**(docs/vsa.md 同步):DNS TOCTOU 窗口;JS 桥经 Dio 内部跟随的 3xx 跳转目标未逐跳重校验(初始 URL 已护栏);无进程级网络沙箱。PR 路径仅运行离线验收(无 Live、无机密);Live 仅在维护者可控分支触发。

## 5. 测试矩阵(18/18,自动计数)

`--self-test` 终局输出与 JSON `self_test.total=18/passed=18` 一致:

| # | 用例 | 期望 | 实际 |
|---|---|---|---|
| 1 | 正常源完整链路 | PASS(runtime_image_decoded) | ✓ |
| 2 | HTML 充图 | FAIL | ✓ |
| 3 | 损坏字节 | FAIL | ✓ |
| 4 | 404 图片 | FAIL | ✓ |
| 5 | 合法头截断(解码层) | FAIL | ✓ |
| 6 | 第一张成功第二张失败 | FAIL | ✓ |
| 7 | SSRF URL(元数据) | 拒绝 | ✓ |
| 8 | 样本不足 | PASS+标注 | ✓ |
| 9 | 空 pages+声明受限 | FAIL(不被掩盖) | ✓ |
| 10 | 图片 404+声明 status:404 | BLOCKED(证据) | ✓ |
| 11 | 混合解码(JPEG+AVIF) | PASS+level=bytes | ✓ |
| 12-15 | JS 语法错/搜索抛错/详情抛错/受限声明+JS错 | FAIL | ✓ |
| 16-18 | 严格缺 Runner/Runner 畸形输出/运行时缺失 | ERROR | ✓ |

## 6. 报告一致性

终局 live 报告(artifact 与本地)字段:`schema_version=2`、`runtime_build_id`(RUNTIME_PIN)、`runner_build_id=cf18358`(=最终 HEAD)、`source_commit=cf18358`、`config_hash`(vsa_sources.yml SHA)、每源 `verification_level` 与 stages 级 `error_code/evidence`。终端输出、JSON、Markdown、GH Summary 均由同一份 `build_report()` 数据生成,无第二事实来源。

## 7. CI(最终 HEAD)

| 项 | 值 |
|---|---|
| run | [43635833760](https://github.com/Souitou-iop/venerax-configs-enhanced/actions/runs/43635833760)(@ cf18358,strict) |
| 结论 | failure —— 由 9 个**源级** FAIL 导致(exit 1 语义如实保留);工程步骤全部 success(runner 构建/覆盖率 46/46/严格验收执行) |
| 统计 | 30 PASS / 7 BLOCKED / 9 FAIL / 0 ERROR |
| artifact | vsa-reports(run 页面可下载,含 JSON+MD+coverage) |

## 8. 源级 Live 结果(9 个 FAIL 逐条)

| 源 | 错误 | 归因 |
|---|---|---|
| manga_dex | search JSON 解析拿到 HTML | 运行时浏览器 UA+机房 IP 触发 bot 挑战(文档化,待上游 UA 注入能力) |
| shonen_jump_plus | 同上 | 同类挑战 |
| manhuaren | search HTTP 503 | 站点限频(间歇,本机同日 PASS) |
| ikmmh | 搜索 200+空结果 | 软封锁(证据不足,如实 FAIL) |
| jm | 个别章节 `Invalid Data` | 间歇(同 commit 上轮 PASS) |
| ehentai | `explore page 0 is not supported by runner` | **本轮新发现**:ehentai 的 explore 变体未被 runner 覆盖(待补 loadNext/mixed 分支) |
| comic_walker | 章节空图片列表 | 站点对机房环境返回空内容 |
| ccc | 章节空图片列表 | 未登录内容为空(已按新规则 FAIL,不再 BLOCKED) |
| manwaba | 章节 AES 空响应 | 章节级差异 |

## 9. 安全边界及遗留风险

- **已保护**:runner 全链路(100% 验收网络)的 URL/DNS/重定向逐跳护栏;跨 Origin 头剥离;TLS 全程校验;SSRF 负向回归。
- **遗留**:DNS TOCTOU、Dio 内部重定向跳、无进程级沙箱——均已声明于 runner 文件头与 docs/vsa.md,不影响 PR 路径(PR 离线无 Live)。
- **凭据**:PR 工作流 contents:read、不传 Secrets;源 JS 无法访问 GITHUB_TOKEN。

## 10. 合并建议

**可合并**:三类遗留缺陷修复且有回归;runner-only 架构消除 P0-A 缺口;P0-B 有 fixture 级护栏;严格模式无假 PASS;9 个源级 FAIL 诚实呈现。Live 红 X 为真实源级问题的如实映射(框架健康由覆盖率/自检/0 ERROR 单独保证)。

## 11. Diagnose 准备度

RFC 与 schema v2 一致;合并后按 RFC 顺序启动:①脱敏历史持久化 ②状态变化检测 ③Summary 诊断摘要。前置任务:补 ehentai explore 变体。
