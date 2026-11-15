"""Sanitized history snapshots and idempotent local history storage."""
from __future__ import annotations

import json
import time
from pathlib import Path

from .diagnose import DIAGNOSE_HISTORY_SCHEMA_VERSION, DiagnoseInputError, normalize_report


def snapshot_report(report: dict, run_id: str | None = None) -> dict:
    normalized = normalize_report(report)
    meta = normalized["context"]
    run_id = run_id or normalized["report_hash"][:24]
    return {
        "diagnose_history_schema_version": DIAGNOSE_HISTORY_SCHEMA_VERSION,
        "run_id": run_id,
        "report_hash": normalized["report_hash"],
        "captured_at": normalized["time"],
        "context": meta,
        "complete": normalized["complete"],
        "source_count": len(normalized["sources"]),
        "sources": list(normalized["sources"].values()),
    }


def write_snapshot(snapshot: dict, history_dir: Path) -> Path:
    history_dir.mkdir(parents=True, exist_ok=True)
    run_id = str(snapshot.get("run_id", ""))
    if not run_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in run_id):
        raise DiagnoseInputError("run_id 含有非法字符")
    path = history_dir / f"{run_id}.json"
    encoded = json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") != encoded:
        raise DiagnoseInputError(f"相同 run_id 已存在不同快照: {run_id}")
    path.write_text(encoded, encoding="utf-8")
    return path


def load_history(history_dir: Path) -> list[dict]:
    if not history_dir.exists():
        return []
    records = []
    for path in sorted(history_dir.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("diagnose_history_schema_version") != DIAGNOSE_HISTORY_SCHEMA_VERSION:
                continue
            if isinstance(record.get("sources"), list) and isinstance(record.get("context"), dict):
                records.append(record)
        except (OSError, json.JSONDecodeError):
            continue
    return records


def prune_history(history_dir: Path, days: int = 90) -> int:
    cutoff = time.time() - days * 86400
    removed = 0
    if not history_dir.exists():
        return removed
    for path in history_dir.glob("*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def history_as_report(record: dict) -> dict:
    return {
        "schema_version": 2,
        "meta": record.get("context") or {},
        "results": record.get("sources") or [],
    }


def select_baseline(current_report: dict, history: list[dict]) -> dict | None:
    current = normalize_report(current_report)
    current_context = current["context"]
    candidates = []
    for record in history:
        context = record.get("context") or {}
        if context.get("mode") != current_context.get("mode"):
            continue
        if context.get("runtime_build_id") != current_context.get("runtime_build_id"):
            continue
        if context.get("config_hash") != current_context.get("config_hash"):
            continue
        if context.get("platform") != current_context.get("platform"):
            continue
        candidates.append(record)
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item.get("captured_at") or "", item.get("run_id") or ""), reverse=True)
    record = candidates[0]
    return history_as_report(record)
