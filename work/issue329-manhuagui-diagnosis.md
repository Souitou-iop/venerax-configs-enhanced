# Issue #329：漫画柜故障诊断

- 诊断日期：2026-09-23（北京时间，UTC+08:00）
- 结论：**未发现可安全证明的 `manhuagui.js` 解析修复；本次不改源码。现有证据指向探针出口到图片 CDN 的网络传输故障，而不是章节解析故障。**
- 范围：只检查正式大写 key `ManHuaGui`、已知小写 key `manhuagui`、现有探针日志和必要的只读请求。未修改 `README.md`、`index.json`、`manga_dex.js` 或探针代码；未提交、未推送。

## Issue 信息

2026-09-23 只读核对 `venera-app/venera-configs#329`：标题为“漫画柜网站失效”，Issue 正文为空，没有评论或复现步骤。因此 Issue 本身没有说明受影响网络、客户端、失败 URL 或 HTTP/TLS 错误，不能据标题断定是站点宕机或解析器回归。

## 源代码链路与大小写实现对比

正式源 `/Volumes/SanDisk/Projects/venerax-configs-enhanced/manhuagui.js`：

- key / version：`ManHuaGui` / `1.2.3`；当前文件 SHA-256：`8c5b9c522d2d4fa6ad08bd5b0a7e7bd050e0d0f994d7d12b25159da54914f6f6`。
- 站点入口：`https://www.manhuagui.com`。
- `getHtml()` 发起页面请求；非 HTTP 200 会在构造 `HtmlDocument` 前抛错。
- `loadInfo()` 请求 `/comic/{id}/`，解析详情及章节目录。
- `loadEp()` 请求 `/comic/{comicId}/{epId}.html`，定位章节 packer 脚本，解包 `files/path/sl` 后生成 `https://us.hamreus.com` 图片 URL。
- `onImageLoad()` 为图片请求设置漫画柜站点 Referer。

小写候选 `/Volumes/SanDisk/Projects/venerax-configs-enhanced/TMP/pending-source-tests/YHQY-Dev_venera-sources/manhuagui.js`：key/version 为 `manhuagui` / `1.2.2`，与正式源不是同一个索引项。两者使用相同主站和图片 CDN；抽取比对确认 `getHtml()` 与 `onImageLoad()` 实现相同。其他差异包括索引元数据、列表处理和章节数据解码实现，不能将两个 key 当成同一份源码。

## 证据时间线

### 2026-09-23 12:42:54–12:44:32：最新 GitHub Actions 内容探针

- Workflow run：`35819449393`，执行源码提交 `f3ff7c2af5ca9339203a720e863428a8e1e160cc`。该提交内 `manhuagui.js` 的 SHA-256 与当前工作区相同，因此结果对应当前正式源文件。
- 日志：`ManHuaGui ERROR (-1ms)：章节数据解包成功(23 张图), 但图片 CDN 从当前网络不可达`。
- 探针实现会依次请求首页、详情、章节页；这些阶段任一 HTTP 状态不是 200 就会提前返回。日志能到“解包出 23 张图”，因此本次运行已走过首页、详情、章节页，并成功解出图片清单。它没有记录这三跳的独立状态行，但控制流证明它们均通过了 200 检查。
- 图片阶段尝试 `us.hamreus.com` 和备用域 `i.hamreus.com`，并带 `https://www.manhuagui.com/` Referer。汇总结果为 `ERR` / `-1ms`，不是一个已知的 HTTP 403。由于 Actions 汇总没有保留逐 CDN 请求的异常文本/独立状态，**无法据此进一步区分 DNS、连接超时或 TLS 握手故障，也不能声称 CDN 返回了 403**。
- 探针结论：解析成功；失败发生在图片传输阶段，且限定于该次 GitHub-hosted 探针网络出口。

### 2026-09-23 16:45:53 与 17:03：已有候选源实测记录

- 16:45:53：待测记录使用的是 `TMP/pending-source-tests/senran-N_venera-configs/manhuagui.js`（key 为大写 `ManHuaGui`，版本 `2.0.0`），不是当前正式文件。记录为 Dio `HandshakeException: Connection terminated during handshake`，未得到 HTTP 状态，亦未进入可确认的详情/章节/图片阶段。它证明该次客户端请求遇到 TLS 握手失败，**不能作为当前正式源解析失败的证据**。
- 17:03:00：小写实现的已有记录 `PASS_IMAGE`。图片来自 `us.hamreus.com`，HTTP 200，6,414 字节，识别为 WebP，579×839。文件已存在：`/Volumes/SanDisk/Projects/venerax-configs-enhanced/TMP/pending-source-tests/results/manhuagui__new/page-01.webp`；SHA-256：`eb82c16461e279d29b0d63be066986b9724689c356e202dc30c123e53c227bfc`。记录包含章节及生成的图片 URL，但没有单独保存搜索、详情、章节页的 HTTP 状态；不能把缺失状态补写成实测状态。

### 2026-09-23 18:48–18:53：本执行环境的只读 HTTP 请求

所有响应体均写入 `/dev/null`，没有新增漫画文件。TLS 证书验证结果为成功（curl `ssl_verify_result=0`）。

| 请求上下文 | 域名/阶段 | HTTP 结果 | 观察 |
|---|---|---:|---|
| 默认 curl 请求头 | `www.manhuagui.com` 首页、详情、章节 | 403，各响应 153 字节 | 返回 `nginx/1.26.3` 的 403 HTML。不能用缺少漫画柜源请求头的 curl 结果代表源代码请求。 |
| 与正式 `getHtml()` 相同的请求头（不显式提供 User-Agent） | `www.manhuagui.com` 首页 | 200，162,773 字节 | 对应 2026-09-23 18:53 左右请求；证明此环境下源所用头集合可通过首页。 |
| 源风格浏览器请求头 | `www.manhuagui.com` 详情页 | 200，27,139 字节 | 约 18:51 请求。 |
| 源风格浏览器请求头 | `www.manhuagui.com` 章节页 | 200，6,525 字节 | 约 18:51 请求。 |
| 不带站点 Referer | `us.hamreus.com` 图片 | 403 | 与源代码的图片请求头不同，属于不可直接与源行为等同的测试。 |
| 带正式源 `onImageLoad()` 所设 Referer | `us.hamreus.com` 图片 | 200，6,414 字节 | 与已有 WebP 样本大小一致，图片响应本身在本执行环境可达。 |

本执行环境 DNS 将相关主机解析到 `198.18.0.0/15` 地址段；该地址不是目标站点可据以定位的公网源站 IP。因此上述结果只代表当前执行环境的请求路径，不能单独用来推断漫画柜全球状态或某个国家/地区的普遍可达性。默认 curl 的 403 与带源风格头后的 200，说明请求上下文会影响响应；正确 Referer 下的 CDN 图片请求为 200。

### 历史网络证据（2026-09-16，阿里云探针）

此前留存的只读 VPS 诊断记录显示：当时阿里云出口连接 `www.manhuagui.com` 的 TCP 80/443 超时，而 `us.hamreus.com`、`i.hamreus.com` 返回 HTTP 200。这是历史、特定出口的网络证据，不代表 2026-09-23 的实时状态；它进一步说明主站和图片 CDN 的可达性需分开判断。

## 判定与后续

1. **解析故障：未复现。** 最新正式内容探针已成功解包 23 张图片信息；同一主站/图片域的小写实现已有真实 WebP 下载记录。当前正式源中的章节解码实现与小写候选不同，但本次没有观测到它出错。
2. **HTTP 403：有条件出现，不应误判。** 无源风格头的首页/详情/章节请求及不带 Referer 的图片请求返回 403；正式源设置页面请求头和图片 Referer 后，本执行环境对应请求返回 200。不能把裸 curl 的 403 作为正式源失效根因。
3. **网络/TLS/区域出口：是当前证据更支持的方向。** 最新 Actions 探针完成了解析，但图片请求结果为网络异常 `ERR`，没有 HTTP 状态；历史阿里云出口也曾无法连接主站，而图片域可达。由于不同出口表现不同，不能通过改解析器或盲换 CDN 域名修复。
4. **代码决策：不改 `manhuagui.js`。** 没有已复现且可由最小源码改动解决的解析根因。若要继续定位，应从同一次失败探针保留 `us.hamreus.com` 与 `i.hamreus.com` 各自的异常类型（DNS、TLS、连接超时或真实 HTTP 状态）；在拿到该证据前，不应把网络不可达伪装成解析修复。

## 验证记录

- `node --check /Volumes/SanDisk/Projects/venerax-configs-enhanced/manhuagui.js`：通过（退出码 0）。
- 本次未提交、未推送。
