# VSA 第二阶段失效源分诊表

## 证据基线

- Live 报告：`work/vsa/ci-43690014115/vsa-live-20261115-072813.json`
- GitHub Run：<https://github.com/Souitou-iop/venerax-configs-enhanced/actions/runs/43690014115>
- 报告结果：32 PASS、13 FAIL、1 BLOCKED、0 ERROR、0 UNVERIFIED
- 当前正式源：46 个，覆盖率检查已通过
- 本表只根据该次 `schema_version: 2` 报告分诊。旧报告用于背景，不作为当前状态替代。

## 分诊表

| Source Key | 状态/阶段/错误码 | 证据与复现条件 | 分类和置信度 | 影响范围 | 修复决定 | 下一步 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `manga_dex` | FAIL，search，`SOURCE_SEARCH_ERROR` | 搜索 `one piece` 得到 HTML，`SyntaxError: unexpected token: '<'` | 环境风控或挑战页，high | GitHub 出口搜索不可用 | 观察 | 保留挑战证据，不改 JS |
| `baozi` | FAIL，search，`SOURCE_SEARCH_ERROR` | 搜索阶段 HTTP 403 | 环境限制，high | GitHub 出口搜索不可用 | 观察 | 不用 JS 修 403 |
| `ikmmh` | FAIL，search，`SOURCE_SEARCH_ERROR` | 搜索空结果，当前配置关键词为空 | 证据不足，low | 搜索链路 | 观察 | 需要公开可复现关键词或其他网络证据 |
| `picacg` | FAIL，search，`SOURCE_SEARCH_ERROR` | `Error: Not logged in` | 鉴权限制，high | 未登录搜索不可用 | 不修 JS | 需要合法账号态验证 |
| `ehentai` | FAIL，pages，`SOURCE_PAGES_ERROR` | explore、info 通过，样本条目章节图片列表为空 | 源/样本选择待核实，medium | 选中条目图片阶段 | 本轮调查 | 对照其他 explore 条目和章节数据 |
| `shonen_jump_plus` | FAIL，search，`SOURCE_SEARCH_ERROR` | 搜索 `SPY×FAMILY` 得到 HTML，`SyntaxError: unexpected token: '<'` | 环境风控或挑战页，high | GitHub 出口搜索不可用 | 观察 | 不改 JS 绕过挑战 |
| `comic_walker` | FAIL，pages，`SOURCE_PAGES_ERROR` | 搜索、详情通过，第 59 话为空图片列表 | 源接口/样本待核实，medium | 特定章节或图片接口 | 本轮调查 | 对照其他章节及当前 API 响应 |
| `ccc` | FAIL，pages，`SOURCE_PAGES_ERROR` | 搜索、详情通过，第 291 话为空图片列表 | 权限或章节数据待核实，low | 选中章节 | 观察 | 不把空列表直接当 JS Bug |
| `rumanhua` | BLOCKED，image，`NETWORK_STATUS_BLOCKED` | 图片样本 HTTP 403，配置声明了状态限制 | 环境限制，medium | 图片出口 | 观察 | 保留 BLOCKED 证据 |
| `baihehui` | FAIL，search，`SOURCE_SEARCH_ERROR` | 搜索需要登录 yamibo 账号 | 鉴权限制，high | 未登录搜索不可用 | 不修 JS | 需要合法账号态验证 |
| `manwaba` | FAIL，pages，`SOURCE_PAGES_EMPTY` | 第 120 话返回 `SyntaxError: Unexpected end of JSON input` | 源解析或上游响应异常，medium | 特定章节 | 首批调查 | 固定章节复现并检查解密/JSON 输入 |
| `rawkuma` | FAIL，explore，`SOURCE_EXPLORE_ERROR` | explore 阶段 HTTP 403 | 环境限制，high | GitHub 出口探索不可用 | 观察 | 不改 JS 修 403 |
| `goda` | FAIL，search，`SOURCE_SEARCH_ERROR` | 搜索阶段 HTTP 403 | 环境限制，high | 主站搜索不可用 | 观察 | API 正文链路另行保留现状 |
| `ykmh` | FAIL，search，`SOURCE_SEARCH_ERROR` | 搜索 `斗罗大陆` HTTP 403 | Cloudflare/出口限制，high | 主站搜索不可用 | 观察 | Issue #10 已修复探活分类，源 JS 不改 |

## 首批候选

1. `manwaba`。错误发生在章节阶段，前面的搜索和详情已经通过，具备稳定、局部、可复现的源链路特征。需要确认响应确实是合法公开接口返回的截断/格式变化，再决定是否修改解析逻辑。
2. `ehentai`。前面的 explore 和 info 已通过，失败集中在图片章节列表。当前选中的 AI 条目可能是样本问题，先尝试同一 explore 的其他条目和章节，避免把空内容误修成源 Bug。
3. `comic_walker`。搜索和详情通过，单个章节为空。需要对照其他章节和源 JS 的章节 API 返回，再判断是站点数据、权限还是解析问题。

`ccc` 暂列观察。它与 `comic_walker` 都是空图片列表，但当前证据不足以支持修改源 JS。其余源本轮有明确的 Cloudflare、HTTP 403 或登录证据，暂不纳入源代码修复。
