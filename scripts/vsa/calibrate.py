#!/usr/bin/env python3
"""VSA 入口/关键词校准工具(一次性开发工具, 也可用于新源接入时快速定位可用入口)。

对索引中的每个源, 依次尝试候选入口(explore[0..2] 与若干候选关键词),
找到第一个返回非空结果的组合, 生成 vsa_sources.yml 的 sources 段。

用法: python scripts/vsa/calibrate.py [--only key1,key2] [--output scripts/vsa_sources.yml]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from vsa.config import SourceTestConfig, VsaConfig, js_field, load_config  # noqa: E402
from vsa.runtime import VeneraRuntime  # noqa: E402

# 分语种/分站型的候选关键词池
KEYWORD_POOL = [
    "斗罗大陆", "海贼王", "妖神记", "斗破苍穹", "一拳超人",
    "百合", "chinese", "one piece", "同人", "咒术回战",
]

# 已知入口(人工确认过或探针验证过): key -> (entry, keyword)
KNOWN = {
    "copy_manga": ("search", "斗罗大陆"),
    "ManHuaGui": ("search", "斗罗大陆"),
    "manben": ("search", "山海逆战"),
    "manga_dex": ("search", "one piece"),
    "manga51": ("search", "百合"),
    "manhuaren": ("search", "海贼王"),
    "shonen_jump_plus": ("search", "SPY×FAMILY"),
    "nhentai": ("search", "chinese"),
    "zymk": ("explore", ""),
    "rumanhua": ("explore", ""),
    "jisu": ("search", "一拳超人"),
    "dm5": ("search", "山海逆战"),
    "ykmh": ("search", "斗罗大陆"),
    "mhkan": ("search", "斗罗"),
    "rawkuma": ("explore", ""),
    "jcomic": ("explore", ""),
    "remenmanhua": ("explore", ""),
    "manhuapi": ("explore", ""),
}

# 声明式受限源: 不做入口探测, 直接按声明输出
DECLARED_BLOCKED = {
    "picacg": ("需登录: 签名接口 401, 登录态不属于 CLI 验收范围", ["401"]),
    "baihehui": ("搜索需登录, 登录态不属于 CLI 验收范围", []),
    "ccc": ("章节需验证码登录; search 阶段可验证后按声明归类", []),
    "ikmmh": ("站点拦截海外/机房网络(403), 仅大陆网络可用", ["403"]),
    "goda": ("主站搜索被 Cloudflare 拦截, 应用内依赖 WebView 过盾", ["403", "cloudflare"]),
}


def probe_source(rt: VeneraRuntime, key: str, cfg_timeout: int) -> tuple[str, str, str]:
    """返回 (entry, keyword, detail)。找不到可用入口时 entry='none'。"""
    attempts = []
    # 1. explore[0..2]
    for idx in (0, 1, 2):
        r = rt.explore(key, idx, cfg_timeout)
        if r.ok:
            comics = (r.json or {}).get("data") or []
            if comics:
                return "explore", str(idx), f"explore[{idx}] {len(comics)} 条"
            attempts.append(f"explore[{idx}]: 空")
        else:
            attempts.append(f"explore[{idx}]: {r.err_brief[:40]}")
    # 2. 关键词池
    for kw in KEYWORD_POOL:
        r = rt.search(key, kw, 1, cfg_timeout)
        if r.ok:
            comics = (r.json or {}).get("data") or []
            if comics:
                return "search", kw, f"search '{kw}' {len(comics)} 条"
            attempts.append(f"'{kw}': 空")
        else:
            attempts.append(f"'{kw}': {r.err_brief[:40]}")
    return "none", "", " | ".join(attempts[:6])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="逗号分隔的源 key, 只校准这些")
    ap.add_argument("--output", default=str(REPO_ROOT / "scripts/vsa_sources.yml"))
    ap.add_argument("--timeout", type=int, default=45)
    args = ap.parse_args()

    import json
    index = {it["key"]: it for it in json.loads((REPO_ROOT / "index.json").read_text(encoding="utf-8"))}
    cfg: VsaConfig = load_config(Path(args.output))

    rt = VeneraRuntime()
    rt.ensure()
    print(f"运行时: {rt.version}", flush=True)

    # 先把全部源加载进运行时(校准的 explore/search 命令需要源已注册)
    print("加载源...", flush=True)
    for key in index:
        js_path = REPO_ROOT / index[key]["fileName"]
        r = rt.load_source(js_path, timeout=60)
        if not r.ok:
            print(f"  [{key}] 加载失败: {r.err_brief[:60]}", flush=True)
    print("加载完成", flush=True)

    only = set(args.only.split(",")) if args.only else None
    lines = [
        "# Venera Source Assurance (VSA) 每源测试配置",
        "# 由 scripts/vsa/calibrate.py 校准生成 + 人工维护(受限于声明式受限源与特殊请求头)",
        "",
        "defaults:",
        "  timeout_stage: 120",
        "  timeout_image: 60",
        "  delay_between_sources: 3.0",
        "",
        "sources:",
    ]

    keys = list(index.keys())
    for i, key in enumerate(keys):
        meta = index[key]
        js_path = REPO_ROOT / meta["fileName"]
        name = js_field(js_path, "name") or key
        if only and key not in only:
            # 保留已有配置
            if key in cfg.sources:
                lines += _emit(key, name, cfg.sources[key], "")
            continue
        if key in DECLARED_BLOCKED:
            reason, patterns = DECLARED_BLOCKED[key]
            sc = SourceTestConfig(key=key, expect="blocked", blocked_reason=reason,
                                  blocked_patterns=patterns,
                                  keyword=(cfg.sources.get(key).keyword if key in cfg.sources else ""))
            lines += _emit(key, name, sc, "声明式受限")
            print(f"  [{key:16}] BLOCKED(声明) {reason[:50]}", flush=True)
            continue
        if key in KNOWN:
            entry, kw = KNOWN[key]
            sc = SourceTestConfig(key=key, entry=entry, keyword=kw)
            lines += _emit(key, name, sc, "")
            print(f"  [{key:16}] {entry} '{kw}' (已知/探针验证)", flush=True)
            if key in cfg.sources and cfg.sources[key].image_headers:
                sc.image_headers = cfg.sources[key].image_headers
            if i < len(keys) - 1:
                time.sleep(1)
            continue
        # 探测
        entry, kw, detail = probe_source(rt, key, args.timeout)
        if entry == "none":
            sc = SourceTestConfig(key=key, expect="blocked",
                                  blocked_reason=f"校准未找到可用入口: {detail[:120]}",
                                  blocked_patterns=[])
            lines += _emit(key, name, sc, "校准失败→声明受限待人工复核")
            print(f"  [{key:16}] ❌ {detail[:80]}", flush=True)
        else:
            sc = SourceTestConfig(key=key, entry=entry, keyword=kw,
                                  explore_index=int(kw) if entry == "explore" else 0)
            lines += _emit(key, name, sc, "")
            print(f"  [{key:16}] {entry} '{kw}' — {detail}", flush=True)
        time.sleep(2)

    Path(args.output).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n已写入 {args.output}")


def _emit(key: str, name: str, sc: SourceTestConfig, note: str) -> list[str]:
    out = [f"  {key}:"]
    if sc.entry == "explore":
        out.append(f"    entry: explore")
        out.append(f"    explore_index: {sc.explore_index}")
    else:
        out.append(f"    keyword: \"{sc.keyword}\"")
    if sc.expect == "blocked":
        out.append("    expect: blocked")
        reason = sc.blocked_reason.replace("\n", " ")
        out.append(f"    blocked_reason: >-")
        out.append(f"      {reason}")
        if sc.blocked_patterns:
            out.append("    blocked_patterns:")
            for p in sc.blocked_patterns:
                out.append(f"      - \"{p}\"")
    if sc.image_headers:
        out.append("    image_headers:")
        for k, v in sc.image_headers.items():
            out.append(f"      {k}: \"{v}\"")
    if note:
        out.append(f"    # {note}")
    out.append("")
    return out


if __name__ == "__main__":
    main()
