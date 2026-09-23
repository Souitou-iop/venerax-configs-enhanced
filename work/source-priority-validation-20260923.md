# 社区反馈优先级源复核记录

日期：2026-09-23（北京时间）

本记录只保留源级复现结论，不绑定外部仓库的 Issue 编号。完整通过标准为：搜索/探索 → 详情 → 章节 → 实际图片下载，并检查图片文件类型与尺寸；仅做边界核验的源会单独注明。

## 再漫画

- 当前版本：`zaimanhua` `v1.0.2`
- 结论：未发现源码缺陷，不升版本。
- 搜索接口：通用查询返回 16 条；特定查询返回 0 条，属于关键词无结果。
- 探索接口：两页均返回 20 条，分页首项不同。
- 详情：HTTP 200，返回 236 个章节。
- 章节：HTTP 200，返回 17 个图片 URL。
- 图片：JPEG，356177 bytes，1121×1600。
- 图片证据：`/Volumes/SanDisk/Projects/venerax-configs-enhanced/TMP/zaimanhua-image/page-01.jpg`

## 禁漫天堂

- 当前版本：`jm` `v1.4.3`
- 结论：边界判断已修复，不修改源文件，不升版本。
- `421925` 使用 `% 10` 分支；`421926` 使用 `% 8` 分支。
- 当前表达式为 `epId < 421926 ? 10 : 8`，相等值已进入新算法。
- 已有 WebP 原图可解码，尺寸 1280×1791；该材料未保留完整原始图片名，因此只作为边界和解码辅助证据，不冒充像素级还原验收。
- 图片证据：`/Volumes/SanDisk/Projects/venerax-configs-enhanced/TMP/jm-boundary/ep-421926-00001-raw.webp`

## 包子漫画

- 当前版本：`baozi` `v1.1.9`
- 结论：当前实现未复现正文源码缺陷，不修改源文件，不升版本。
- Venera CLI 走完探索、详情、章节和图片 URL 获取。
- 图片：HTTP 200，WebP，67056 bytes。
- 图片证据：`/Volumes/SanDisk/Projects/venerax-configs-enhanced/TMP/baozi-image/page-01`
- 本地 Python 下载时遇到证书链问题，使用源级请求结果和仅针对本机证书链的 TLS 校验绕过保存图片；这不作为站点证书正常性的结论。

## 紳士漫畫

- 当前版本：`wnacg` `v2.0.0`
- 结论：当前实现未复现正文源码缺陷，不修改源文件，不升版本。
- Venera CLI 走完探索、详情、章节和图片 URL 获取。
- 图片：HTTP 200，WebP，429080 bytes，2400×3382。
- 图片证据：`/Volumes/SanDisk/Projects/venerax-configs-enhanced/TMP/wnacg-image/page-01`
- 其他出口可能出现图片 CDN 或正图域限制，不能据此把网络问题写成解析器修复。

## 统一验证

- `node --check`：四个源均通过。
- `venera source validate`：四个源均通过。
- 再漫画、包子漫画和紳士漫畫完成了完整图片链路；禁漫天堂本次只做边界和已有图片证据核验，未重新请求站点。
- 本次未修改 `zaimanhua.js`、`jm.js`、`baozi.js`、`wnacg.js`。
- 本次未修改 `index.json` 的版本号。
