"""VSA 每源测试配置加载(scripts/vsa_sources.yml)。

每个源声明如何被验收:
  sources:
    <key>:
      keyword: 搜索关键词(必填; 各源单独配置, 避免通用关键词误判)
      result_index: 取搜索结果第几条(默认 0)
      ep: 取章节策略 first|last(默认 last, 即最新一话)
      image_headers: 图片下载附加请求头(如 Referer; 默认带运行时同款浏览器 UA)
      image_count: 抽样下载数(默认 2)
      max_page: 搜索页码(默认 1)
      expect: pass|blocked — 声明已知受限的源(风控/UA 差异等), blocked 须给 reason
      blocked_patterns: 命中即归为 BLOCKED 的错误模式(声明式受限匹配)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError as e:  # pragma: no cover
    raise ImportError("VSA 需要 PyYAML: pip install pyyaml") from e


@dataclass
class SourceTestConfig:
    key: str
    keyword: str = ""
    result_index: int = 0
    ep: str = "last"  # first | last
    entry: str = "search"  # search | explore(搜索接口失效/无搜索的源用探索页)
    explore_index: int = 0  # 探索页第几个 tab
    image_headers: dict = field(default_factory=dict)
    image_count: int = 2
    max_page: int = 1
    expect: str = "pass"  # pass | blocked
    blocked_reason: str = ""
    blocked_patterns: list = field(default_factory=list)


@dataclass
class VsaConfig:
    sources: dict  # key -> SourceTestConfig
    timeout_stage: int = 120
    timeout_image: int = 60
    delay_between_sources: float = 2.0

    def get(self, key: str) -> SourceTestConfig | None:
        return self.sources.get(key)


def load_config(path: Path) -> VsaConfig:
    cfg = VsaConfig(sources={})
    if not path.exists():
        return cfg
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    defaults = raw.get("defaults") or {}
    cfg.timeout_stage = int(defaults.get("timeout_stage", 120))
    cfg.timeout_image = int(defaults.get("timeout_image", 60))
    cfg.delay_between_sources = float(defaults.get("delay_between_sources", 2.0))
    for key, item in (raw.get("sources") or {}).items():
        item = item or {}
        cfg.sources[key] = SourceTestConfig(
            key=key,
            keyword=str(item.get("keyword", "")),
            result_index=int(item.get("result_index", 0)),
            ep=str(item.get("ep", "last")),
            entry=str(item.get("entry", "search")),
            explore_index=int(item.get("explore_index", 0)),
            image_headers=dict(item.get("image_headers") or {}),
            image_count=int(item.get("image_count", 2)),
            max_page=int(item.get("max_page", 1)),
            expect=str(item.get("expect", "pass")),
            blocked_reason=str(item.get("blocked_reason", "")),
            blocked_patterns=list(item.get("blocked_patterns") or []),
        )
    return cfg


def js_field(js_path: Path, field_name: str) -> str | None:
    """从源 JS 文件中提取顶层字段第一处赋值(name/version/key)。"""
    try:
        text = js_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    m = re.search(rf"(?m)^\s*{field_name}\s*=\s*\"([^\"]+)\"", text)
    return m.group(1) if m else None
