# Venera Source Assurance (VSA) 使用文档

VSA 是 Layer 2 **真实漫画源 JS 验收系统**:通过官方 [venera_cli](https://github.com/venera-app/venera_cli)(QuickJS 运行时)加载并执行仓库中的**原始漫画源 JS 文件**,走完 加载 → 元数据核对 → 搜索 → 详情 → 章节 → **真实图片字节抽样下载** 全链路,产出结构化验收报告。

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

# 构建运行时(产物在 work/vsa/runtime/bundle/bin/venera)
python scripts/source_assurance.py --build --self-test

# 验收单个源
python scripts/source_assurance.py --source manben

# 验收全部已配置源
python scripts/source_assurance.py --all

# 离线确定性测试(零第三方网络, 走本地 fixture)
python scripts/source_assurance.py --mode offline

# 框架自检(负向用例: 断言框架能抓到每类故障)
python scripts/source_assurance.py --self-test

# 指定输出目录与运行时
python scripts/source_assurance.py --all --output reports/ --runtime /tmp/venera/bundle/bin/venera
```

退出码:`0` 无 FAIL/ERROR;`1` 存在 FAIL;`2` 框架/运行时 ERROR。

## 六态判定

| 状态 | 含义 |
|---|---|
| 🟢 PASS | 实际执行且全链路满足验收(含真实图片 magic bytes) |
| 🔴 FAIL | 已执行但某阶段失败(附阶段与错误摘要) |
| 🟠 BLOCKED | 登录/风控/UA 差异等外部条件无法验证(仅显式声明或声明式模式命中, 不伪造) |
| ⚪ SKIP | 未配置测试配置 / 索引中无此源 |
| ⚪ UNVERIFIED | 未执行或证据不足 |
| 💥 ERROR | 框架或运行时自身异常(绝不记 PASS) |

运行时缺失、命令超时、源被跳过均**不得**计入通过数量;`--self-test` 会强制验证这些负向判定路径。

## 为新源添加验收配置

在 `scripts/vsa_sources.yml` 追加条目即可:

```yaml
sources:
  my_source:
    keyword: "斗罗大陆"          # 每源单独配置, 避免通用关键词误判
    result_index: 0              # 取搜索结果第几条(默认 0)
    ep: last                     # 取章节策略 first|last
    image_headers:               # 图片下载附加请求头
      Referer: "https://example.com/"
    image_count: 2               # 抽样下载数
    blocked_patterns:            # 命中即归 BLOCKED 的错误模式(声明式受限)
      - "Expected available in"
```

章节模型支持两种 Venera 形态, 驱动自动兼容并按候选回退(最多 3 个):
平铺 `{epId: 标题}` 与分组 `{组名: {epId: 标题}}`(如漫画柜的 单话/单行本/番外篇)。

## 报告

- JSON(机器可读):`work/vsa/reports/vsa-<mode>-<时间戳>.json`,含每源 JS SHA-256、运行时版本、逐阶段耗时/状态/摘要;
- Markdown(人类可读):同名 `.md`;GitHub Actions 中自动写入 Job Summary;
- 报告中的图片 URL 去除签名 query, 不泄漏令牌;不记录 Cookie/账号信息。

## CI 集成

| 工作流 | 触发 | 内容 |
|---|---|---|
| `source-assurance.yml` | 每日 03:30 UTC + 手动 | 全部已配置源 live 验收, 产物留存 14 天, Summary 展示 |
| `pr-source-validate.yml` | Pull Request | 原有加载级校验之外, 新增 **VSA 离线回归**(fixture 走真实运行时, 零第三方网络, 作为确定性合并门槛) |

## 已知边界(如实声明)

1. **图片请求头差异**:CLI `pages` 只返回图片 URL,不含源内 `onImageLoad` 的动态请求头;驱动按 per-source 配置的静态头下载。绝大多数源仅需 Referer/UA;如未来出现依赖动态签名的源,需薄 Dart runner 在运行时内取图(已预留方案)。
2. **运行时 UA**:venera 运行时默认 Chrome/120 UA(`venera_core/_Config.userAgent`),个别站点(如 mangadex)对"浏览器 UA + 机房 IP"弹 bot 挑战,此类源以 `expect: blocked` 声明,真实客户端不受影响。
3. **登录/付费**:需要账号态的源(禁漫/哔咔/百合会等)不在 VSA 范围内,登录后链路仍以真机验收为准。
4. **运行时版本**:CI 每次构建 venera_cli main 分支(未固定 commit);本地可固定版本后传 `--runtime`。
