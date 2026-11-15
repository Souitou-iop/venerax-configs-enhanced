# VSA 第二阶段首批源修复报告

## 执行基线

- 开发基线：`main`，提交 `ece21d1`
- 最新 Live 报告：`work/vsa/ci-43690014115/vsa-live-20261115-072813.json`
- 远端 Run：<https://github.com/Souitou-iop/venerax-configs-enhanced/actions/runs/43690014115>
- 开发分支：`codex/vsa-source-recovery-batch-1`
- 运行时：Venera CLI 1.0.0，Runner 使用当前仓库构建产物

## 首批修复结果

### `manwaba` — 漫蛙漫画

- 原始症状：第 120 话进入 pages 阶段时失败。
- 失败阶段及错误码：`pages`，`SOURCE_PAGES_ERROR`。
- 修复前真实验收：`FAIL`，报告为 `work/vsa/recovery/manwaba-before/vsa-live-20261115-162742.json`。
- 根因证据：章节 HTML 的 `params` JavaScript 字符串把 Base64 中的 `+` 写成 `\u002b`，把 `/` 写成 `\/`。源代码直接把正则捕获值交给 Base64 解码，解密后的 JSON 不完整，`JSON.parse` 报 `Unexpected end of JSON input`。同一源的多个章节均可复现该错误。
- 修改文件和版本：`manwaba.js`，`v2.0.4 → v2.0.5`，同步更新 `index.json` 和 README 版本说明。
- 修复方案：新增 `decodeJsStringEscapes`，在 Base64 解码前还原 Unicode、十六进制、斜杠和反斜杠转义。
- 离线回归：`node tests/test_manwaba_source.js` 通过，使用脱敏章节 HTML Fixture 验证 `\u002b` 与 `\/` 的还原。
- 修复后真实验收：`PASS`，报告为 `work/vsa/recovery/manwaba-after/vsa-live-20261115-163207.json`，图片 2/2 获取并解码通过。
- VeneraX 客户端实测：未进行图形客户端实测。
- 仍存在的限制：当前证据覆盖公开章节参数解析和 VSA 严格链路，尚未覆盖登录态或其他域名配置。

## 本轮调查但没有修改的源

### `ehentai`

最新和本轮复测都能完成 explore、info，失败集中在选中画廊返回空图片列表。不同运行会选中不同画廊，且当前没有证据证明是通用解析器或 `loadNext` 逻辑错误。保留 `FAIL/SOURCE_PAGES_ERROR`，后续需要对照有图片的画廊样本再判断。

### `comic_walker`

完整 VSA 复测仍可能在第 59 话得到空图片列表，但同一版本、同一章节的底层 `pages` Runner 命令可以返回真实图片 URL。这个差异指向动态 token、请求时序或环境波动，尚无安全源 JS 根因。没有修改正式源，避免把间歇环境问题固化成代码变更。

## 继续观察的源

以下源在最新 Live 中有明确环境或鉴权证据，当前不应通过修改 JS 处理：

- `manga_dex`、`shonen_jump_plus`：搜索返回 HTML/挑战页。
- `baozi`、`rawkuma`、`goda`、`ykmh`：HTTP 403 或 Cloudflare/出口限制。
- `picacg`、`baihehui`：需要登录。
- `rumanhua`：图片阶段已结构化为 `BLOCKED/NETWORK_STATUS_BLOCKED`。
- `ikmmh`、`ccc`：当前证据不足以支持安全的源代码修改。

## 回归证据

- `python -m unittest discover -s tests -v`：13/13 通过。
- `node tests/test_manwaba_source.js`：通过。
- `python -m py_compile scripts/e2e_health_check.py scripts/source_assurance.py scripts/vsa/*.py`：通过。
- `node scripts/validate-pr-versions.js origin/main`：版本规则通过。
- `python scripts/source_assurance.py --check-coverage`：46/46 纳管，0 个豁免。
- 既有 VSA 离线自检和 Diagnose 测试在本分支继续通过。

## 结论

本批完成 1 个真实源级缺陷修复。修复前后使用同一源和同一公开验收链路，结果从 pages FAIL 变为 runtime image decoded PASS。其余候选保留证据和下一步，不把环境限制、授权限制或样本空内容伪装成代码修复。
