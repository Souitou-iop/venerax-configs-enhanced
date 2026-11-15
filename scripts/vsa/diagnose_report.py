"""Markdown and JSON output for Diagnose results."""
from __future__ import annotations

import html
import json
from pathlib import Path


def write_json(result: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def write_markdown(result: dict, path: Path, report_path: str = "") -> Path:
    summary = result.get("summary") or {}
    events = result.get("events") or []
    priority = [item for item in events if item.get("event") not in ("NO_CHANGE", "FIRST_OBSERVATION")]
    lines = ["# VSA 每日诊断", "", f"- 当前报告哈希: `{result.get('report_hash', '')}`",
             f"- 可比较: `{result.get('comparison', {}).get('comparable', False)}`",
             f"- 比较说明: {html.escape(str(result.get('comparison', {}).get('reason', '')))}",
             f"- 事件总数: {summary.get('total', 0)}", ""]
    if report_path:
        lines.append(f"- 原始报告: `{html.escape(report_path)}`")
    lines += ["", "## 优先关注", ""]
    if not priority:
        lines.append("没有需要优先关注的状态变化。")
    for item in priority[:10]:
        observed = item.get("observed") or {}
        diagnosis = item.get("diagnosis") or {}
        key = html.escape(str(item.get("source_key", "")))
        lines.append(f"- **{key}** `{item.get('event', '')}`，状态 `{observed.get('state', '')}`，"
                     f"阶段 `{observed.get('stage') or '无'}`，错误码 `{observed.get('error_code') or '无'}`。")
        if diagnosis.get("hypothesis"):
            lines.append(f"  可能原因（{diagnosis.get('confidence', 'unknown')}）: {html.escape(str(diagnosis['hypothesis']))}")
        evidence = json.dumps(observed.get("evidence") or {}, ensure_ascii=False, separators=(",", ":"))
        lines.append(f"  证据: `{html.escape(evidence[:400])}`")
        for check in diagnosis.get("next_checks") or []:
            lines.append(f"  建议检查: {html.escape(str(check))}")
    lines += ["", "## 事件统计", "", "| 事件 | 数量 |", "| :-- | --: |"]
    for event, count in sorted((summary.get("events") or {}).items()):
        lines.append(f"| `{html.escape(str(event))}` | {count} |")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
