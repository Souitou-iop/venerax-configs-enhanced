# Venera Source Assurance (VSA) 使用文档

VSA 是 Layer 2 **真实漫画源 JS 验收系统**:通过官方 [venera_cli](https://github.com/venera-app/venera_cli)(QuickJS 运行时)加载并执行仓库中的**原始漫画源 JS 文件**,走完 加载 → 元数据核对 → 搜索/探索 → 详情 → 章节 → **真实图片字节抽样下载** 全链路,产出结构化验收报告。

它解决的是 Layer 1(Python 网站健康探针)无法覆盖的问题:**探针正常,但真实源 JS 不可用**。两者互相独立、互不继承结果。

## 与现有体系的关系(两层架构)

| 层 | 工具 | 验证对象 | 回答的问题 |
|---|---|---|---|
| Layer 1 | `scripts/e2e_health_check.py`(定时 cron) | 网站 API 与请求链路(Python 移植) | 站点现在健康吗? |
| Layer 2 | `scripts/source_assurance.py`(VSA) | 仓库里的真实 JS 配置 | 仓库里的源脚本本身能跑通吗? |

已知两者结论不同的实例(2026-11-14 实测):
- **MangaDex**:Layer 1 内容级绿灯(真实图片字节),Layer 2 失败——运行时默认浏览器 UA 触发 mangadex bot challenge;
- **manben**:Layer 1 只验探索页绿灯,Layer 2 搜索阶段抓到解析 bug(已修复)。

## 快速开始

```bash
# 依赖: Python 3.10+ / PyYAML / Dart SDK(构建运行时)
pip install pyyaml

# 构建运行时与 Dart runner(产物在 work/vsa/runtime/)
python scripts/source_assurance.py --build --self-test

# 覆盖率检查(离线确定性; PR 合并门槛)
python scripts/source_assurance.py --check-coverage

# 验收单个源 / 多源 / 全部正式源
python scripts/source_assurance.py --source manben
python scripts/source_assurance.py --sources copy_manga,manhuagui
python scripts/source_assurance.py --all

# 离线确定性测试(本地 fixture + 负向矩阵, 零第三方网络)
python scripts/source_assurance.py --mode offline

# 框架自检(判定路径矩阵)
python scripts/source_assurance.py --self-test

# 诊断降级模式(runner 不可用时允许静态头弱验证, 结果标记 image_header)
python scripts/source_assurance.py --all --allow-degraded
```

退出码:`0` 无 FAIL/ERROR;`1` 存在 FAIL 或覆盖率缺口;`2` 框架/运行时 ERROR。

## 六态判定与验证分级

六态与验证分级正交;严格模式(live 默认)下完整 `PASS` 至少需要 `runtime_image_bytes`。

| 状态 | 含义 |
|---|---|
| 🟢 PASS | 实际执行且全链路满足验收(含真实图片字节) |
| 🔴 FAIL | 已执行但某阶段失败(附阶段/错误码/证据) |
| 🟠 BLOCKED | 有外部限制证据(认证/挑战页/声明式状态命中),见"BLOCKED 证据标准" |
| ⚪ SKIP | 明确豁免(已纳管未验收, 须给 reason) |
| ⚪ UNVERIFIED | 未执行或证据不足(如无声明的网络超时/拒连) |
| 💥 ERROR | 框架或运行时自身异常(绝不记 PASS) |

| verification_level | 含义 |
|---|---|
| `metadata_only` | 仅 JS 加载与元数据 |
| `source_chain` | 真实 JS 走完搜索/详情/章节(取得图片 URL) |
| `image_header` | 静态请求头读取图片头(仅 `--allow-degraded` 诊断模式; 不是完整阅读验证) |
| `runtime_image_bytes` | 经运行时 onImageLoad 动态头取得真实图片字节(严格 PASS 门槛) |
| `runtime_image_decoded` | 取得且完整解码成功(最高等级) |

## BLOCKED 证据标准(P0-2)

BLOCKED 必须基于可观察的外部限制证据, 不是疑难故障的垃圾桶:

1. **事实先行**:先执行全部可执行阶段并保留逐阶段结果, 再做归因;`expect: blocked` 只是先验标注, 不是"任何失败都返回 BLOCKED"的指令。
2. **JS 错误优先**:SyntaxError/JSON 解析失败/空数据等 JS 层错误一律 FAIL, 不套用地区限制(有独立挑战页证据时除外)。
3. **认证证据**:401 / "Not logged in" / 登录类错误 → `AUTH_REQUIRED`。
4. **状态证据**:HTTP 403/429 仅在该源声明 `blocked_patterns: [{status: 403}]` 命中时 → `NETWORK_STATUS_BLOCKED`;证据是可观察的 HTTP 状态。
5. **挑战页证据**:入口/搜索阶段 JS 解析失败时, 对源站点首页做一次性挑战特征探测(Just a moment / cf-browser-verification 等), 命中 → `CHALLENGE_PAGE`;探测不到 → 如实 FAIL。注意:探测请求的头指纹与运行时不同, 无法复现挑战时按 FAIL 处理(如 MangaDex)。
6. **无证据的失败** → FAIL 或 UNVERIFIED(网络超时/拒连未声明时), 不会变成 BLOCKED。

稳定错误码(`error_code`, 便于聚合与历史比较):`SOURCE_LOAD_ERROR`、`SOURCE_METADATA_MISMATCH`、`SOURCE_SEARCH_PARSE_ERROR`、`SOURCE_INFO_ERROR`、`SOURCE_PAGES_EMPTY`、`IMAGE_HTTP_ERROR`、`IMAGE_HTML_INSTEAD_OF_IMAGE`、`IMAGE_DECODE_FAILED`、`IMAGE_COUNT_MISMATCH`、`RUNTIME_MISSING`、`RUNNER_MISSING`、`RUNNER_PROTOCOL_ERROR`、`NETWORK_TIMEOUT`、`NETWORK_STATUS_BLOCKED`、`AUTH_REQUIRED`、`CONFIG_COVERAGE_MISSING`。

## 全源覆盖(P0-3)

`index.json` 是正式源唯一清单;`--all` 对**每个正式源**产出一条结果:

- 有测试配置 → 完整验收;
- 配置 `exempt: true` + `exempt_reason` → SKIP(已纳管未验收, 不计入通过数);
- 缺配置 → `UNVERIFIED`(CONFIG_COVERAGE_MISSING), 且严格模式直接失败。

`--check-coverage` 离线检查:索引有但配置没有、配置指向已下线源、文件缺失、JS key/version 与索引不一致、豁免缺理由——任一命中即失败。**新增源未配测试或豁免, PR 会被拒绝。**

两个指标分开报告:`纳管覆盖率`(有配置或豁免的正式源比例)与 `完整验收成功率`(runtime_image_bytes+ 的 PASS 数 / 实际完整验收数), 不混成一个数字。

## 图片验证与安全(P0-1/P0-4)

- 图片阶段优先走薄 Dart runner(`scripts/vsa_dart/`):运行时内调用源自身 `loadComicPages` 与 `getImageLoadingConfig`(JS `onImageLoad`)获取**动态请求头**,再实抓样本字节。这覆盖了 Referer/随机头/Token 等静态配置无法满足的源(manhuaren/manga51/Komiic/comick 等实测翻绿)。
- `image_count` 每源可配并真实透传到 runner;报告输出 `requested/available/attempted/verified` 四个计数, 样本不足如实标注, 不偷换。
- 抽样图片逐张做 magic bytes + 完整解码(JPEG/PNG/WebP/GIF 经 `package:image`;AVIF 记录"字节可信但未解码", 不声称 decoded)。
- **URL 安全护栏**:源 JS 返回的 URL 视为不可信输入——仅允许 http/https 公网目标, 拒绝环回/私网/云元数据地址(SSRF);Python 静态诊断路径证书校验全程开启(不再有 CERT_NONE)。
- Runner 缺失/协议异常/输出畸形在严格模式一律 ERROR, 不被静态回退掩盖成 PASS;静态头检查仅在 `--allow-degraded` 诊断模式可用且标记 `image_header`。

## 离线 Fixture 负向矩阵(P1-2)

`--self-test` 用本地 HTTP 服务 + 动态生成 fixture 源, 经**真实运行时**验证判定路径(不访问第三方网站):正常链路 PASS、HTML 充图 FAIL、损坏字节 FAIL、404 FAIL、合法头截断 FAIL(解码)、第一张成功第二张失败 FAIL、SSRF URL 拒绝、样本不足如实标注、JS 语法错误加载 FAIL、搜索/详情抛异常 FAIL、**受限声明 + JS 错误 → FAIL(不被 BLOCKED 掩盖)**、严格模式 Runner 缺失 ERROR、Runner 畸形输出 ERROR、运行时缺失 ERROR。

## CI 集成(P1-3)

| 工作流 | 触发 | 内容 |
|---|---|---|
| `source-assurance.yml` | 每日 03:30 UTC + 手动 | 固定 commit 构建 venera_cli(`VSA_CLI_PIN`)+ 构建 Dart runner + 覆盖率门槛 + 严格模式全量验收;报告/artifact 留存 14 天 |
| `pr-source-validate.yml` | Pull Request | 加载级校验 + **覆盖率门槛** + 离线负向回归(确定性, 不依赖第三方站点);权限 contents:read, 不向源 JS 暴露 Secrets |

运行时/runner 构建来源 commit 写入报告 meta(`runtime_build_id`/`runner_build_id`), 保证结果可复现。升级 venera_cli 时人工更新 `VSA_CLI_PIN` 并核对上游 CHANGELOG。

## 为新源添加验收配置

在 `scripts/vsa_sources.yml` 追加条目(或用 `scripts/vsa/calibrate.py --only <key>` 自动校准入口):

```yaml
sources:
  my_source:
    keyword: "斗罗大陆"          # 或 entry: explore + explore_index
    result_index: 0
    ep: last
    image_headers: {}            # 常规源不需要(runner 走 onImageLoad 动态头)
    image_count: 2
    blocked_patterns:            # 声明式受限(证据化): {status: 403} / {err: x} / {body: x}
      - status: 403
    # exempt: true               # 明确豁免须给 reason
    # exempt_reason: "..."
```

章节模型支持平铺与分组(单行本/单话/番外篇)两种 Venera 形态, 驱动自动兼容并按候选回退。

## 已知边界(如实声明)

1. **运行时 UA**:venera 运行时默认 Chrome/120 UA(`venera_core/_Config.userAgent`);MangaDex 等对"浏览器 UA + 机房 IP"弹 bot 挑战。自动挑战探测无法复现运行时头指纹, 因此 MangaDex 以 FAIL 呈现(人工已用 curl 复核挑战页证据, 记录于此);待上游支持按源注入 UA 后转完整验收。
2. **机房网络限制**:cdndm5 图域、部分站点对 GitHub runner/机房 IP 拦截(403/拒连/超时)。这些源声明了 `blocked_patterns`, 在受限环境归 BLOCKED, 在可达环境仍可 PASS——环境限制不替源码背锅, 证据始终可见。
3. **登录/付费**:需账号态的源(哔咔/百合会/CCC 等)以 `AUTH_REQUIRED` BLOCKED 呈现, 登录后链路仍以真机验收为准。
4. **运行时版本**:CI 固定 venera_cli commit(`VSA_CLI_PIN`);venera_core 由 `scripts/vsa_dart/pubspec.lock` 锁定。升级为人工流程。

## 设计问答(为什么这样设计)

- **什么证据让系统有资格给出"全链路 PASS"?** 严格模式下必须:真实 JS 走完搜索/详情/章节, 且经运行时 onImageLoad 动态头取得样本图片字节(magic 可信, 解码成功则升为 decoded)。仅拿到 URL、仅 HTTP 200、仅静态头, 都不够。
- **Runner 不可用时为何不能让 HTTP 头检查代替全链路?** 静态头不含源内动态鉴权, 拿到字节 ≠ 用户能读到图;混用会让 PASS 语义漂移。降级结果必须单独标记 `image_header` 且不进严格统计。
- **如何在不泄漏敏感内容的情况下证明 BLOCKED?** 证据字段只含:HTTP 状态码、命中的模式/标记(短字符串)、探针结论种类;URL 去签名 query, 不记录 Cookie/Token/响应全文。
- **新增源未配测试, 系统如何让维护者注意到?** `--check-coverage` 与严格 live 的覆盖率门槛都会失败((CONFIG_COVERAGE_MISSING)), PR 无法合并。
- **上游 Runtime 更新导致大面积 FAIL 时如何判断?** 报告记录 `runtime_build_id`;若上一基线同 commit 同环境而大面积翻转 → 疑似站点集体故障;若 commit 变更 → 先查上游回归(见 Diagnose RFC)。
- **Magic Bytes 与完整解码在用户价值上的差别?** magic 只证明"响应像是图片";解码证明"这张图能真的显示"。截断/伪图只有解码能抓出来。
- **覆盖率与打扰第三方的取舍?** 覆盖率检查是纯离线的;live 抽样默认 1-2 张、源间隔 3s、阶段超时受限, 不做整章下载。
