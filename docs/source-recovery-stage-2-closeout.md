# VSA 第二阶段收尾报告

## 一句话结论

第二阶段完成了失效源分诊、`manwaba` 源级修复和 Batch 2 候选调查。`manwaba` 已修复并合并，`ehentai` 与 `comic_walker` 均完成了可复现调查，当前证据不足以安全修改源代码，两个源转入持续观察。第二阶段可以收尾，第三阶段 Dashboard 可以开始规划。

## 修复成果

### 漫蛙漫画 `manwaba`

章节页参数中的 Base64 内容包含 JavaScript 字符串转义。源代码直接把 `\u002b` 和 `\/` 交给 Base64 解码，AES 解密后的 JSON 无法完整解析，VSA 在 pages 阶段得到 `SOURCE_PAGES_ERROR`。

修复将 JavaScript 字符串转义还原放到 Base64 解码之前，版本从 `2.0.4` 升级到 `2.0.5`，并同步更新 `index.json` 和 README。修复前后的结果来自同一源的真实 VSA 链路，修复前 FAIL，修复后 PASS，图片 2/2 获取并解码通过。

- 修复前报告：`work/vsa/recovery/manwaba-before/vsa-live-20261115-162742.json`
- 修复后报告：`work/vsa/recovery/manwaba-after/vsa-live-20261115-163207.json`
- Fixture：`tests/fixtures/manwaba_chapter_params.html`
- 测试：`node tests/test_manwaba_source.cjs`
- 合并提交：`6f6b390`

## Batch 2 调查结果

### `ehentai`

本轮真实 VSA 可以完成 `explore.loadNext`、详情和章节阶段，失败发生在 pages 阶段，错误码为 `SOURCE_PAGES_ERROR`，表现为选中的画廊返回空图片列表。

复测中抽样到的画廊会发生变化。不同运行选中的画廊不同，空列表也随样本变化。当前没有稳定的同一画廊解析异常，也没有证据证明 `loadNext`、详情 ID 传递或通用章节解析逻辑损坏。此前的 Runner `loadNext` 能力缺口已经在 PR #9 中解决，本轮没有重新归因给 Runner。

处理决定是保留真实 FAIL，暂不修改 `ehentai.js`。后续若要继续，需要固定一个公开且确认存在图片的画廊与章节，再与一个稳定空列表的画廊做同环境对照。

报告路径：`work/vsa/recovery/ehentai-after/vsa-live-20261115-163234.json`

### `comic_walker`

完整 VSA 复测在第 59 话出现空图片列表，错误码为 `SOURCE_PAGES_ERROR`。同一版本、同一作品和同一章节通过独立 Runner `pages` 命令可以返回真实图片 URL。

这个差异说明问题可能与完整流程中的临时 token、会话状态、请求时序或站点瞬时响应有关。它没有形成稳定的源 JS 解析错误。源代码中的 `loadEp` 能够正确解析 viewer 返回的 manuscripts，单独 pages 验证也能得到图片 URL。

处理决定是暂不修改 `comic_walker.js`。修改请求参数、增加固定等待或嵌入临时 token 都会把间歇性环境问题固化成源代码行为。后续观察应固定同一作品、同一章节，连续进行少量有间隔的完整流程与单阶段流程对照。

报告路径：`work/vsa/recovery/comic-walker-after/vsa-live-20261115-163234.json`

## 其余失效源分类

最新 Live 报告中的 13 个 FAIL 和 1 个 BLOCKED 已完成分组：

- `manga_dex`、`shonen_jump_plus`：搜索得到 HTML/挑战页，属于出口环境或风控限制。
- `baozi`、`rawkuma`、`goda`、`ykmh`：HTTP 403 或 Cloudflare/出口限制。
- `picacg`、`baihehui`：需要登录。
- `rumanhua`：图片阶段已结构化为 `BLOCKED/NETWORK_STATUS_BLOCKED`。
- `ikmmh`、`ccc`：证据不足以支持源代码修改。
- `manwaba`：已修复并通过真实验证。
- `ehentai`、`comic_walker`：完成调查，当前保留观察。

这些状态不应通过放宽图片验证、扩大 `blocked_patterns`、调整样本到容易通过的章节或修改 CI 退出语义来消除。

## 验收证据

- 正式源覆盖：46/46，0 个豁免。
- VSA 离线自检：25/25。
- Diagnose、探针和源修复单元测试：13/13。
- `node tests/test_manwaba_source.cjs`：通过。
- `python scripts/source_assurance.py --check-coverage`：通过。
- `node scripts/validate-pr-versions.js origin/main`：通过。
- Python 编译和 `git diff --check`：通过。
- PR #13：已合并。
- 当前 main：`8c6a312`。

本阶段没有进行 VeneraX 图形客户端实测。VSA 通过表示真实 JS Runner 完成了当前验收链路，不代表已经完成客户端 UI 阅读验证。

## 第二阶段结论

第二阶段达到收尾条件：

1. 已完成最新异常源分诊。
2. 已修复一个有稳定根因和修复前后真实对照证据的源级 Bug。
3. `ehentai` 和 `comic_walker` 已完成针对性调查，保留了可复现报告和不修改源的理由。
4. 覆盖率、离线自检、版本校验和远端 PR 检查通过。
5. 其余异常已按源代码问题、环境限制、鉴权限制、样本问题和证据不足分类。

## 第三阶段入口

第二阶段不再继续扩大源修复范围。第三阶段可以开始 Dashboard 规划，优先展示 VSA Diagnose 的每日摘要、源状态变化、失败阶段、错误码、证据链接和持续观察项。`ehentai` 与 `comic_walker` 继续作为观察对象，后续出现稳定同源复现证据后再单独处理。
