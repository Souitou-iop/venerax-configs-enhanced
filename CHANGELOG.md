# 更新日志

本文件记录 VeneraX 漫画源配置增强库的源脚本、验收体系与自动化变更。README 仅保留更新日志入口；完整历史、验证证据和已知限制以本文件为准。

## 版本与 Tag 说明

- 本仓库没有整库版本号；每个漫画源的版本以 `index.json` 中的 `version` 为准。
- `v1.1.3`–`v1.1.7` 是 Komiic 单源版本 Tag，用于不可变 jsDelivr 直链，不对应 GitHub Release。
- 不要移动或删除这些 Tag；Komiic 的订阅直链依赖其不可变性。
- GitHub Releases 仅用于阶段性里程碑公告，不替代本文件。

## 2026-11-24

- **探针连通级重试与云出口 TLS 掐断识别 (`scripts/e2e_health_check.py`)**：Issue #14 中 W漫画被判「无法直连」，实为 GitHub Actions 的 Azure 网段对 `www.wmanhua.com` 间歇性丢弃 TLS 握手（Globalping 的 Azure 节点 4 次里 3 次 `Request timed out during the TLS handshake`，而同期 US/JP/DE/SG/GB 非云厂商节点稳定 200）。连通级探测改为握手类异常最多重试 3 次；三次仍失败则用 Globalping 从 5 个非云厂商网络复测同一 HTTPS 地址，若拿到 2xx/3xx 则判 `OK_CONN` 并标记 `env_limited`（出口网络限制），不计入连续异常与告警状态机；复核拿不到证据或独立网络同样不可达时仍判 `DOWN`，复核失败不会成为漏报通道。403/429 等站点明确答复不重试、不降级。新增 7 项离线单测（含“只取到云厂商节点不算独立证据”的负向对照），`tests/` 全量 25 项通过，本地全量演练中 W漫画恢复 `OK_CONN`。

## 2026-11-21

- **新增 次元漫画 (`cycomic.js` v1.0.0)**：移植 YHQY-Dev/venera-sources 同名源并入库；最近更新/人气榜列表、实时搜索 API（POST `/api/front/index/search`，无分页）、`#book` 详情与 `#img-box` 章节直链图。2026-11-21 海外代理内容级实测全链路通过（搜索 15 命中、403 章、37 图，图域 `tuer.justpic01pt.com:666` JPEG 字节落地）；runner 分级实测 load/search/explore/info/pages 全 PASS。图域对突发请求按 IP 短窗限流（握手期掐连、约 1 分钟恢复、单次请求正常），CI 机房命中即归 BLOCKED。
- **新增 肉漫屋 (`roum27.js` v1.1.1)**：基于 2026-11-21 SSR 改版实测重写（上游 coldnighten v1.1.0 解析已失效）。修复上游搜索参数（服务端只认 `term`，上游 `keyword` 恒空页）；章节图提取改为签名 URL 内嵌 base64 载荷（`s3://rouman/images/...`，站点剥离了 base64 padding 需补齐后解码），按载荷前缀过滤广告图（`advertiser-assets`/`adcs`）；识别站点对自动化客户端的降级页（200 但截断、仅广告无正文图）并重试一次，仍未恢复则声明 `SITE_DEGRADED` 环境受限。真实设备网络（dart:io 单请求全量页 + 68 张 WebP 内容图提取）已验证。
- **VSA 纳管**：`cycomic`/`roum27` 进入 `index.json`（46→48 源）与 `scripts/vsa_sources.yml` 测试配置（含环境受限声明）；`--check-coverage` 全源纳管通过，Diagnose 单测 17/17 通过。

## 2026-11-18

- **漫画看 (`mhkan.js` v1.0.1)**：阅读页只采集 `reader-image`/`lazy` 正文图，跳过 `data-mint-comic-cover` 隐藏封面元数据；将 `coldpic.sfacg.com` 的 `.webp` 地址归一到实际 `.jpg`，避免把代理封面或错误扩展名当成正文图并在 404 时误报 `IMAGE_HTTP_ERROR`；详情标题改用 `#mintWorkTitle`，不再显示“作品详情”。本机 VSA 全链路 PASS（2/2 解码）。
- **布卡漫画 VSA 配置**：探索入口由“最新”切到“热门”，避免最新列表头部新作章节为空导致全链路样本不稳定；本机 VSA 全链路 PASS（2/2 解码）。
- **VSA Diagnose 基线**：执行平台比较归一为 OS + CPU 架构，忽略 GitHub runner 内核/glibc 版本轮换；修复今日报告因 `Linux-...-aws` 与 `Linux-...-azure` 不一致而退化为 `FIRST_OBSERVATION` 的问题；历史快照证据键固定排序，避免同一 `run_id` 因 JSON 键序漂移被判冲突；Diagnose 单测 17/17 通过。

## 2026-11-15

- **漫蛙漫画 (`manwaba.js` v2.0.5)**：章节页参数在 Base64 解码前还原 JavaScript 字符串转义（`\uXXXX`、`\xXX`、`\/`、`\\`），修复 AES 解密后的 JSON 解析失败与 `SOURCE_PAGES_ERROR`；本机与远端检查通过，VSA 修复前 FAIL、修复后 PASS，图片 2/2 解码通过。
- **VSA Diagnose MVP**：每日 VSA 增加历史对比与诊断摘要，覆盖首次观察、新失败、持续失败、恢复、环境受限和基础设施异常等事件；历史快照由独立归档 job 写入，原始 VSA 严格判定不变；相关单测 12/12 通过。
- **VSA Runner 兼容性与错误归类**：支持 Venera 列表变体并完善 Runner 错误分类；最终 Live VSA 为 32 PASS / 13 FAIL / 1 BLOCKED / 0 ERROR / 0 UNVERIFIED，源级 FAIL 仍如实保留。
- **优酷漫画探针 (`ykmh`)**：将 Cloudflare 403 归类为环境限制并修正探针告警文案；离线测试与 PR 检查通过（Issue #10）。
- **第二阶段收尾**：`ehentai`、`comic_walker` 完成复现调查，证据不足以安全修改源代码，保留 FAIL 并转入持续观察；收尾报告已入库。

## 2026-11-14 VSA 可靠性整改(P0/P1)

按可靠性整改指南完成 P0/P1:严格模式(缺 Runner/协议异常一律 ERROR, 静态头检查降级为诊断模式并标记 `image_header`)、BLOCKED 证据化分类(JS 错误优先于受限声明、认证/状态/挑战页三类证据、移除早退)、`--check-coverage` 全源纳管门槛(新增源未配测试或豁免 PR 直接失败)、移除 TLS 校验关闭 + SSRF 护栏(源 JS 返回的 URL 视为不可信)、`image_count` 真实透传 runner + 逐张解码验证(截断/伪图被解码层抓出)、离线负向矩阵扩至 15 项全过、venera_cli 固定 commit(`VSA_CLI_PIN`)与 runner 构建来源进报告。Komiic 由声明受限转完整 PASS(runner 动态 Token 解决 401);MangaDex 按证据标准如实 FAIL(挑战页探针无法复现运行时头指纹, 人工 curl 证据记录于文档)。详见 [docs/vsa.md](docs/vsa.md) 与 [Diagnose RFC](docs/vsa-diagnose-rfc.md)。

## 2026-11-14 VSA 全量 46 源接入、薄 Dart runner 与首次 CI 验证

- **全源配置**：`scripts/vsa/calibrate.py` 批量校准后 46 源全部纳入 VSA——探索页入口 24 源（Komiic/禁漫/E-Hentai/hitomi/紳士漫畫/カドコミ/mangabz/看漫画/comick/H-Comic/热辣/漫蛙/漫小肆/X漫画/思思/布卡/嬉皮/神奇/漫客栈 等）、搜索入口 15 源、声明式受限 7 源（哔咔/百合会/CCC/爱看漫/GoDa/包子/Komiic）。
- **薄 Dart runner（`scripts/vsa_dart/`）**：基于 venera_core 在运行时内调用源自身 `onImageLoad` 动态请求头抓取图片字节，补齐 CLI `pages` 只返回 URL 的缺口；漫画人/51漫画/mangabz/X漫画/comick/漫画柜/漫本/动漫屋/极速/hitomi 十源的图片 403 由此全部翻绿。
- **再次捕获两个站点改版**：动漫啦 `v1.0.2`（Tailwind 模板：列表/搜索改用通用 detail 锚点、详情章节网格）与 W漫画 `v1.0.5`（首页卡片、搜索 `a.book`、章节走 POST API 且响应无 `code` 字段、阅读器 `imgBaseUrl` 字符串拼接公式）——均为 VSA 全量跑出的真实 FAIL,修复后复验 PASS。
- **首次 CI 端到端验证（run 43583103787）**：构建→46 源逐源执行→报告/Summary/Artifacts 全部工作，18 PASS / 7 BLOCKED / 21 FAIL 起步；FAIL 中 16 个为机房 IP 拦截类（本机同源 PASS）,已按爱看漫先例归类声明式 BLOCKED（命中 `blocked_patterns` 归 BLOCKED,通过仍 PASS）;其余真实 FAIL（E-Hentai 部分画廊空列表、布卡 runner 环境章节空、漫蛙章节 AES 空响应、嬉皮第二图偶发空字节、hitomi 子域按出口 IP 推导）记录在报告中待逐源处理。
- 健壮性增强：multiPartPage 探索分组展平、空章节自动换条目重试、分组章节（单行本/单话/番外篇）候选回退、AVIF/ftyp 识别。

## 2026-11-14 VSA 真实源 JS 验收系统上线

新增 **Venera Source Assurance (VSA)** 第二层验收基础设施（[docs/vsa.md](docs/vsa.md)）：通过官方 `venera_cli`（QuickJS 运行时）执行仓库原始源 JS 走完 搜索→详情→章节→图片字节 全链路，解决"Python 探针正常但真实源不可用"的验收盲区。包含：`scripts/source_assurance.py` 驱动与 `scripts/vsa/` 模块包、离线 fixture 正负向自检（8/8 判定路径）、每日 live 验收工作流与 PR 离线回归门槛、JSON/Markdown 双报告。

上线即捕获真实问题：**manben 搜索解析 bug**（搜索页锚点无前导斜杠 + 图卡/标题锚点分离，`v1.0.0 → v1.0.1` 修复并经 VSA 复验 PASS）；记录 manga_dex 运行时 UA 兼容性差异（浏览器 UA + 机房 IP 触发 bot challenge，真实客户端不受影响）；copy_manga 设备反盗版风控在机房环境的声明式 BLOCKED 归类。

## 2026-11-14 同步上游 5 源修复并新增 11 个已验证漫画源

根据社区源巡检 Issue #1 评论，同步 `senran-N/venera-configs` 的 5 个版本更新（全部保留本仓库更新地址）：紳士漫畫 `v2.0.2`（站点已对移动 UA 只出移动模板，旧版解析为空；新增移动版/排行榜解析与翻页修复）、E-Hentai `v1.2.5`（igneous 过滤丢返回值致 exhentai 登录态失效、cookie 解析死循环）、禁漫天堂 `v1.4.4`（分流 JSON 解析崩溃、旧章节散列截断致图片错位）、hitomi.la `v2.0.1`（分类翻页缓存跨类串数据）、Picacg `v1.0.9`（base_url 清空拼 undefined URL）。合并后 5 源均经端到端复验。

**新增 11 个源**（全部按真实章节图片字节验收，索引共 46 个源）：

- **漫本 (`manben.js` v1.0.0)**：dm5 族；实测阅读页已壳化，逆向 `chapterfun.ashx` packer 两段解包与拼图公式，JS 侧 Node 端到端复现 577KB JPEG。
- **漫画看 (`mhkan.js` v1.0.0)**：实测阅读页 `location.replace` 跳 `reader.hqread.cc`，手动跟随跳转后解析 `reader-image` 签名 WebP；详情页 DOM 有条目差异已做兜底。
- **热门漫画 (`remenmanhua.js` v1.0.0)**：首页列表 + 章节隐藏域 API；图域 `static.998876.xyz`（协议相对 URL 补 https:）；站内搜索接口不稳已在源内注明。
- **漫画皮 (`manhuapi.js` v1.0.0)**：`jhc-data` 图片属性 + 菜单页完整目录；搜索空结果自动回退列表。
- **动漫屋 (`dm5.js` v1.0.0) / 极速漫画 (`jisu.js` v1.0.0)**：dm5 族双站；极速漫画实现 DM5_VIEWSIGN 签名 `chapterfun.ashx` 单次整章（Node 端到端复现 269KB JPEG）。
- **知音漫客 (`zymk.js` v1.0.0)**：正版国漫；排序列表浏览 + mhpic 整章图片公式（第 1/2/3/31 页逐页验证）；关键词搜索接口失效已注明。
- **Rawkuma (`rawkuma.js` v1.0.0)**：WP REST 列表 + admin-ajax 章节 + cdn 直链图（504KB WebP）。
- **JComic (`jcomic.js` v1.0.0)**：单本画廊；`data-locked` 反转 base64 解码（391/391 全解出），S3 预签名短时效需即时下载（实测确认时效窗口）。
- **GoDa漫画 (`goda.js` v1.2.1) / 优酷漫画 (`ykmh.js` v1.0.0)**：采用社区维护版本并核对本机验证链路；goda 主站搜索被 CF 拦（应用内依赖 WebView 过盾），ykmh 短时高频会触发 IP 403（内置低频使用）。

**暂缓发布源条款移除**：Zero搬运网的注册页异常已持续约两个月（无法建号 → 登录/VIP 章节永远无法验收），且脚本从未入库，不再在 README 保留占位条款；如站点修复注册可重新评估。

## 2026-10-04 CCC追漫台维护记录（已恢复）

官方公告维护窗口为 `2026-10-03 10:00` 至 `2026-10-04 18:00`（UTC+8）。维护结束后于 `2026-10-04 19:37`（UTC+8）复测：官网返回 HTTP 200，`api.creative-comic.tw/public/home_v2` 返回 HTTP 200、业务 `code=0`，恢复为数据级正常；本次未修改 `ccc.js`。

## 2026-10-02 Picacg 升级至 v1.0.8

按维护者授权同步 Picacg `v1.0.8`，更新脚本和索引的版本及本仓库更新地址；修正首页专题 `collections` 接口、搜索分类筛选、评论签名路径，补齐章节图片请求的 401 重登录，并改善错误提示和空数据处理。

本次验证覆盖 JS 语法、Venera 源加载及相关逻辑回归；尚未取得有效登录态，因此登录后章节与正文图片仍未完成真实验收，不标记为内容级通过。

## 2026-10-02 整合通过正文验收的社区源

- **更新 4 个源**：如漫画 `v1.1.0`、再漫画 `v1.0.3`、漫画人 `v2.0.1`、漫画柜 `v2.0.0`。
- **新增 16 个源**：漫客栈、动漫啦、Mangabz、看漫画、百合会、comick、H-Comic、热辣漫画、漫蛙漫画、漫小肆、X漫画、思思漫画、布卡漫画、嬉皮漫画、W漫画、神奇漫画；索引共 35 个源。
- **验收范围**：执行正式源脚本的搜索或探索、详情、章节及必要解密，下载实际章节图片，完整解码并检查格式、尺寸和正文内容；不把预告、人设或单纯 HTTP 200 作为正文验收。
- **更新地址**：本批源的脚本与索引统一使用本仓库更新地址；漫蛙漫画按已验证脚本实际版本 `v2.0.5` 收录，社区索引中的 `v2.0.1` 已滞后；Hitomi 索引对齐现有脚本 `v2.0.0`，未改动 Hitomi 源码。
- **保留限制**：如漫画搜索尚未实现；看漫画仅在排行榜内过滤搜索；百合会搜索需登录；comick 单字符搜索受限；思思漫画和布卡漫画的探索分页待复核。漫画柜正文及内容探针本机复测通过，历史海外异常仍需新的 CI 运行确认。
- **探针修正**：漫画柜请求头与正式源对齐，图片 URL 中的中文路径先编码再发送，修正请求尚未发出就被误记为 CDN 不可达的问题；AES HTML 探针排除预告、人设等样本并抽取章节中段图片。
- **后续项**：Picacg 已按后续授权更新至 `v1.0.8`，登录后正文仍待验证；热门漫画、漫画皮、漫本、动漫屋存在待处理的搜索、分页或章节问题；重复别名、自托管和未取得正文的候选不收录。
- **自动巡检**：四个更新源继续使用内容级探针，16 个新增源先接入明确标注的连通级监测；大陆节点未覆盖的源显示“未测”，不伪装成无法直连。

## 2026-09-23 社区反馈源复核

对再漫画、包子漫画和紳士漫畫进行了完整的章节图片复核，并对禁漫天堂的 EPID 边界进行了源码与现有图片证据核验；再漫画的空结果属于特定关键词未命中，禁漫天堂的边界在当前版本已正确处理，未发现需要继续修改的源码缺陷。

## 2026-09-23 MangaDex 功能维护与漫画柜故障定位

- **MangaDex (`manga_dex.js` v1.2.1)**：增加章节语言偏好设置；默认保持全部语言，选择具体语言后通过 MangaDex Feed 的 `translatedLanguage[]` 参数过滤章节。
- **漫画柜 (`ManHuaGui`)**：完成漫画柜可用性故障诊断。现有证据显示章节数据可正常解包，故障集中在部分探针网络出口到图片 CDN 的传输阶段，暂未发现可安全证明的解析器修复，因此不盲目修改正式源。

## 2026-09-23 社区版本更新与内容级验证

根据社区源巡检 Issue #1 的最新结果，从 `senran-N/venera-configs` 同步并验证以下 4 个更新候选：

- **Hitomi.la (`hitomi.js` v1.2.3)**
- **禁漫天堂 (`jm.js` v1.4.3)**
- **nhentai (`nhentai.js` v2.0.0)**
- **紳士漫畫 (`wnacg.js` v2.0.0)**

以上源均通过 Venera CLI 的搜索、详情、章节和真实图片下载链路验证；本次验收以实际图片字节、图片类型和尺寸为准，不以单纯 HTTP 200 或 JSON 返回作为通过标准。

## 2026-09-21 新增已验证漫画源与探针接入

- **51漫画 (`manga51.js` v1.1.0)**：加入源索引与双网络内容级探针；使用搜索入口完成搜索→详情→章节→真实 WebP 图片验证，公开内容免登录可读。
- **如漫画 (`rumanhua.js` v1.0.0)**：加入源索引与双网络内容级探针；使用分类入口完成章节 AES 解密与真实 WebP 图片验证；站点搜索接口当前返回空，README 已注明使用分类/更新入口。
- **Zero搬运网 (`zerobyw33.js`) 暂缓发布**：匿名公开图片链路已验证，但注册页存在脚本路径/字段绑定异常，登录、VIP 与受限章节未完成验证，因此未加入 `index.json`。
- **探针接入**：`scripts/e2e_health_check.py` 新增 51漫画与如漫画的 AES 章节解密、真实图片下载和格式校验；`scripts/hybrid_health_check.py` 同步补齐双网络线路元数据。

## 2026-09-18 社区源升级与内容级验证

本批更新不以接口连通或 JSON 返回作为验收标准，均通过 Venera CLI 实际走完搜索/详情/章节链路并成功下载、识别漫画图片。

- **包子漫画 (`baozi.js` v1.1.9)**：补齐浏览器 UA/Referer 请求头与搜索关键词 URI 编码，修正章节主机及图片地址拼接；实测输出 640×551 WebP。
- **E-Hentai (`ehentai.js` v1.2.4)**：补全分类页、高级搜索、标签跳转和登录过期识别，强化 API Key 空值保护与 token 翻页；实测输出 1280×960 WebP。
- **MangaDex (`manga_dex.js` v1.2.0)**：同步官方 1.2.0，支持章节 Feed 全量分页、语言分组与论坛评论；图片地址固定使用稳定的 `uploads.mangadex.org`，避免部分临时 `*.mangadex.network` 节点返回 404；实测输出 1079×1599 PNG。
- **少年ジャンプ＋ (`shonen_jump_plus.js` v1.1.4)**：补全排行榜、动态分区、限时免费与搜索分页，并使用 `X-Giga-Page-Image-Auth` 完成正文图片鉴权；实测输出 764×1200 JPEG。
- **Picacg 暂缓升级**：候选 v1.0.8 需要有效登录态才能完成正文图片验收，本次继续保留已发布的 v1.0.6。

## 2026-08-23 源风控降级与鉴权加固更新

### 1. Komiic (`komiic.js` v1.1.1)
- **修复登录 Token 提取与鉴权缺失**：修复官方 `/api/login` 响应体为空导致 `JSON.parse` 无法提取 Token 的 Bug；重构为从 `Set-Cookie: komiic-access-token` 提取并同步注入 `Authorization: Bearer` 与 `Cookie`。
- **解决「每日图片配额超限 (`Daily image quota exceeded`)」**：登录态成功生效后突破匿名访客 300 张/日硬性限制，并增加配额不足提示。
- **正文图片请求补齐鉴权**：在 `onImageLoad` 中同步注入用户登录态与凭证。

### 2. 拷贝漫画 (`copy_manga.js` v1.6.0)
- **保留登录态**：HTTP 210 不再静默删除用户 Token，也不再通过随机设备信息掩盖账号/设备风控。
- **区分限频与账号风控**：仅对带有 `Expected available in X seconds` 的短期限频做有限等待；长等待和账号风控直接返回明确错误，避免 30 秒阅读器超时与镜像重试放大封禁。
- **降低请求突发**：详情请求与收藏状态查询改为串行，多分组目录继续采用平滑排队。
- **补齐正文图片 App 请求头**：在 `onImageLoad` 中注入 `COPY/3.0.9` 官方客户端请求头。

## 2026-08-22

### 1. E-Hentai (`ehentai.js` v1.2.3) & nhentai (`nhentai.js` v1.1.3)
- **E-Hentai (v1.2.3)**：修复非标准 DOM（如部分模板省略 `tbody`）导致的画廊空列表与解析崩溃；重构 `taglist` 正则匹配与 `options[0]` 空指针安全防护；全链路统一注入防封浏览器 UA 与 Referer。
- **nhentai (v1.1.3)**：适配官方 v2 API 新版嵌套 JSON 数据结构（兼容 `title.pretty` / `cover.path`）；显式注入 `comic.chapters` 单本画廊章节结构，解决阅读器切章异常；增加 60 秒搜索缓存防止 429 限频拦截。

### 2. 官方生肉与台漫源批量加固 (`shonen_jump_plus.js` v1.1.3 / `comic_walker.js` v1.1.0 / `ccc.js` v1.0.3)
- **少年Jump+ (v1.1.3)**：引入 Apple iTunes API 动态同步 App 最新版本特征；将系列详情与章节列表优化为 `Promise.all` 并发拉取，提升翻页加载速度。
- **カドコミ (v1.1.0)**：客户端请求特征保持官方 1.6.0+ 兼容；E2E 探针已升级至 `BookWalkerApp/1.7.0`，并增加注册失败原因记录、免费专区为空时的新着/推荐专区回退，以及传输层异常重试；同时补充 `onTagSuggestionSelected` 根级占位，避免框架回调报错。
- **CCC追漫台 (v1.0.3)**：修复分类与搜索 `options` 为空时的异常崩溃；搜索关键词增加 `encodeURIComponent` 编码防护。

### 3. 紳士漫畫 (`wnacg.js` v1.0.11)、漫画柜 (`manhuagui.js` v1.2.3) 与 爱看漫 (`ikmmh.js` v1.0.6)
- **紳士漫畫 (v1.0.11)**：修复移动端 UA 访问时因模板切换导致的选择器匹配失效与排序异常。
- **漫画柜 (v1.2.3)**：逆向新版 LZString + splic 章节解密混淆，解决新章节解密失败与图片白屏。
- **爱看漫 (v1.0.6)**：漫画详情与章节目录改为并发拉取，新增探索页 5 分钟轻量缓存。

### 4. 拷贝漫画 (`copy_manga.js` v1.5.0) & Komiic (`komiic.js` v1.1.0)
- **拷贝漫画 (v1.5.0)**：修复切下一话报 Network error 崩溃的内存污染 Bug；将 40s 长等待优化为 1.5~3s 微抖动退避重试消除 30s 阅读器超时；特征升级至 3.0.9，支持动态设备自愈与 3 组镜像自动容灾。
- **Komiic (v1.1.0)**：适配官方最新 `imageTicketsByChapterId` 签名鉴权与 `X-Image-Ticket` 请求头，解决正文图片报 HTTP 402 无法加载问题。
- **禁漫天堂 (v1.4.2) & Hitomi.la (v1.2.2)**：禁漫天堂支持官方 5 条分流线路自动故障转移；Hitomi.la 集成 galleryblock/nozomi LRU 缓存与 B-tree 搜索去重加速。
