"""VSA 报告生成: 机器可读 JSON + 人类可读 Markdown。"""
from __future__ import annotations

import datetime
import json
from pathlib import Path

from .chain import (
    STATE_BLOCKED,
    STATE_ERROR,
    STATE_FAIL,
    STATE_PASS,
    STATE_SKIP,
    STATE_UNVERIFIED,
    SourceResult,
)

STATE_ICONS = {
    STATE_PASS: "🟢",
    STATE_FAIL: "🔴",
    STATE_BLOCKED: "🟠",
    STATE_SKIP: "⚪",
    STATE_UNVERIFIED: "⚪",
    STATE_ERROR: "💥",
}


def build_report(meta: dict, results: list[SourceResult],
                 checks: list[dict] | None = None) -> dict:
    summary = {s: 0 for s in (STATE_PASS, STATE_FAIL, STATE_BLOCKED, STATE_SKIP, STATE_UNVERIFIED, STATE_ERROR)}
    for r in results:
        summary[r.state] = summary.get(r.state, 0) + 1
    report = {
        "schema_version": 2,
        "meta": meta,
        "summary": summary,
        "results": [
            {
                "key": r.key,
                "name": r.name,
                "version": r.version,
                "file": r.file_name,
                "js_sha256": r.js_sha256,
                "state": r.state,
                "detail": r.detail,
                "error_code": r.error_code,
                "verification_level": r.verification_level,
                "evidence": r.evidence,
                "stages": [
                    {"stage": s.name, "state": s.state, "detail": s.detail,
                     "elapsed_ms": s.elapsed_ms, "error_code": s.error_code,
                     "evidence": s.evidence}
                    for s in r.stages
                ],
            }
            for r in results
        ],
    }
    if checks is not None:
        # P1-C: 用例数由结果集合自动计算, 禁止手工猜测
        report["self_test"] = {
            "total": len(checks),
            "passed": sum(1 for c in checks if c.get("ok")),
            "failed": sum(1 for c in checks if not c.get("ok")),
            "cases": checks,
        }
    return report


def write_json(report: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_markdown(report: dict, path: Path) -> Path:
    meta = report["meta"]
    summary = report["summary"]
    lines = [
        "# 🧪 Venera Source Assurance 验收报告",
        "",
        f"- 时间: {meta.get('time', '')}",
        f"- 运行时: {meta.get('runtime', '')} ({meta.get('platform', '')})",
        f"- 模式: {meta.get('mode', '')}",
        f"- 汇总: 🟢 PASS {summary.get(STATE_PASS, 0)} · 🔴 FAIL {summary.get(STATE_FAIL, 0)} · "
        f"🟠 BLOCKED {summary.get(STATE_BLOCKED, 0)} · ⚪ SKIP {summary.get(STATE_SKIP, 0)} · "
        f"💥 ERROR {summary.get(STATE_ERROR, 0)}",
        "",
        *( [
            f"- 自检: {report['self_test']['passed']}/{report['self_test']['total']} 用例通过(自动计数)"
        ] if "self_test" in report else [] ),
        "",
        "| 漫画源 | 版本 | 状态 | 阶段结果 |",
        "| :-- | :-- | :-- | :-- |",
    ]
    for r in report["results"]:
        stages = " → ".join(f"{s['stage']}:{STATE_ICONS.get(s['state'], s['state'])}" for s in r["stages"]) or "-"
        detail = r.get("detail") or ""
        line_detail = ""
        last_stage = r["stages"][-1] if r["stages"] else None
        if last_stage and last_stage.get("detail"):
            line_detail = last_stage["detail"][:80]
        lines.append(
            f"| **{r['name'] or r['key']}**<br>`{r['key']}` | v{r['version']} | "
            f"{STATE_ICONS.get(r['state'], '')} {r['state']}{(' — ' + detail[:60]) if detail else ''} | "
            f"{stages}<br>{line_detail} |"
        )
    lines.append("")
    lines.append(f"*报告生成于 {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}; "
                 "PASS 表示真实 JS 在官方运行时中走完搜索→详情→章节→图片字节全链路。*")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
