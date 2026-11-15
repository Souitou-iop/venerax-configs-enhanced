"""Deterministic comparison and evidence-based diagnosis for VSA reports."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .chain import (
    LEVEL_RUNTIME_BYTES,
    LEVEL_RUNTIME_DECODED,
    STATE_BLOCKED,
    STATE_ERROR,
    STATE_FAIL,
    STATE_PASS,
    STATE_UNVERIFIED,
)

DIAGNOSE_HISTORY_SCHEMA_VERSION = 1
DIAGNOSE_SCHEMA_VERSION = 1
PASS_LEVELS = {LEVEL_RUNTIME_BYTES, LEVEL_RUNTIME_DECODED}


class DiagnoseInputError(ValueError):
    """The report cannot be safely interpreted."""


@dataclass(frozen=True)
class Comparison:
    comparable: bool
    reason: str
    runner_changed: bool = False
    source_commit_changed: bool = False
    runtime_changed: bool = False


def _short(value: Any, limit: int = 240) -> str:
    text = str(value or "")
    return text[:limit]


def _safe_evidence(value: Any) -> dict:
    if not isinstance(value, dict):
        return {}
    allowed = {
        "evidence_type", "http_status", "marker", "kind", "probe", "confidence",
        "suspected_cause", "expected_environment_constraint", "counts", "capability",
        "error_origin",
    }
    result = {}
    for key in allowed:
        if key not in value:
            continue
        item = value[key]
        if isinstance(item, dict):
            result[key] = {str(k): _short(v, 120) for k, v in item.items() if str(k)[:40]}
        elif isinstance(item, (bool, int, float)) or item is None:
            result[key] = item
        else:
            result[key] = _short(item)
    return result


def _safe_stage(stage: dict) -> dict:
    return {
        "stage": _short(stage.get("stage"), 40),
        "state": _short(stage.get("state"), 30),
        "error_code": _short(stage.get("error_code"), 80),
        "evidence": _safe_evidence(stage.get("evidence")),
    }


def load_report(path: Path) -> dict:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DiagnoseInputError(f"无法读取 VSA 报告: {path}: {exc}") from exc
    if not isinstance(report, dict) or report.get("schema_version") != 2:
        raise DiagnoseInputError("VSA 报告必须是 schema_version=2 的对象")
    if not isinstance(report.get("meta"), dict) or not isinstance(report.get("results"), list):
        raise DiagnoseInputError("VSA 报告缺少 meta 或 results")
    return report


def report_hash(report: dict) -> str:
    payload = json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _first_failed_stage(result: dict) -> dict | None:
    for stage in result.get("stages") or []:
        if stage.get("state") not in (STATE_PASS,):
            return stage
    return None


def normalize_source(result: dict) -> dict:
    first_failed = _first_failed_stage(result)
    return {
        "key": _short(result.get("key"), 100),
        "name": _short(result.get("name"), 160),
        "version": _short(result.get("version"), 80),
        "source_sha256": _short(result.get("js_sha256"), 128),
        "state": _short(result.get("state"), 30),
        "error_code": _short(result.get("error_code"), 100),
        "verification_level": _short(result.get("verification_level"), 60),
        "evidence": _safe_evidence(result.get("evidence")),
        "first_failed_stage": _short(first_failed.get("stage"), 40) if first_failed else "",
        "stages": [_safe_stage(s) for s in result.get("stages") or [] if isinstance(s, dict)],
    }


def normalize_context(report: dict) -> dict:
    meta = report.get("meta") or {}
    return {
        "mode": _short(meta.get("mode"), 30),
        "strict": bool(meta.get("strict")),
        "runtime_build_id": _short(meta.get("runtime_build_id"), 160),
        "runner_build_id": _short(meta.get("runner_build_id"), 160),
        "config_hash": _short(meta.get("config_hash"), 160),
        "platform": _short(meta.get("platform"), 160),
        "environment_id": _short(meta.get("environment_id"), 160),
        "source_commit": _short(meta.get("source_commit"), 160),
    }


def normalize_report(report: dict) -> dict:
    sources = [normalize_source(r) for r in report.get("results") or [] if isinstance(r, dict)]
    return {
        "vsa_report_schema_version": 2,
        "report_hash": report_hash(report),
        "time": _short((report.get("meta") or {}).get("time"), 80),
        "context": normalize_context(report),
        "sources": {source["key"]: source for source in sources if source["key"]},
        "summary": report.get("summary") if isinstance(report.get("summary"), dict) else {},
        "complete": bool(sources) and len(sources) == len(report.get("results") or []),
    }


def compare_context(current: dict, baseline: dict) -> Comparison:
    current_context = current.get("context") or {}
    baseline_context = baseline.get("context") or {}
    for field in ("mode", "strict", "runtime_build_id", "config_hash", "platform"):
        if current_context.get(field) != baseline_context.get(field):
            return Comparison(False, f"{field} 不一致", source_commit_changed=(
                current_context.get("source_commit") != baseline_context.get("source_commit")),
                runtime_changed=field == "runtime_build_id")
    current_runner = current_context.get("runner_build_id")
    baseline_runner = baseline_context.get("runner_build_id")
    current_source = current_context.get("source_commit")
    baseline_source = baseline_context.get("source_commit")
    return Comparison(
        True,
        "runtime、模式、配置和执行环境一致",
        runner_changed=bool(current_runner and baseline_runner and current_runner != baseline_runner),
        source_commit_changed=current_source != baseline_source,
    )


def _signature(source: dict) -> tuple:
    return (source.get("state"), source.get("first_failed_stage"), source.get("error_code"),
            source.get("verification_level"))


def _strict_pass(source: dict) -> bool:
    return source.get("state") == STATE_PASS and source.get("verification_level") in PASS_LEVELS


def _diagnosis(source: dict) -> dict:
    state = source.get("state")
    code = source.get("error_code") or ""
    stage = source.get("first_failed_stage") or ""
    evidence = source.get("evidence") or {}
    if state == STATE_ERROR or code.startswith("RUNNER_") or code.startswith("RUNTIME_"):
        return {"category": "RUNTIME_OR_RUNNER", "hypothesis": "验收基础设施异常", "confidence": "high",
                "next_checks": ["检查 Runner 构建和协议输出", "确认本轮是否有多个源同时 ERROR"]}
    if state == STATE_BLOCKED or code in {"AUTH_REQUIRED", "CHALLENGE_PAGE", "NETWORK_STATUS_BLOCKED"}:
        return {"category": "ENVIRONMENT_OR_AUTH", "hypothesis": "登录、风控或出口环境限制", "confidence": "medium",
                "next_checks": ["查看原始 evidence 和 HTTP 状态", "确认当前执行环境与上一轮一致"]}
    if code.startswith("CONFIG_") or code == "SOURCE_METADATA_MISMATCH":
        return {"category": "TEST_CONFIGURATION", "hypothesis": "测试配置或源元数据需要检查", "confidence": "high",
                "next_checks": ["检查 index.json 与源文件版本", "运行 --check-coverage"]}
    if state == STATE_UNVERIFIED:
        return {"category": "UNKNOWN", "hypothesis": "证据不足，暂时无法判断", "confidence": "unknown",
                "next_checks": ["查看原始报告是否完整", "确认网络阶段是否超时"]}
    if stage == "image" or code.startswith("IMAGE_"):
        return {"category": "IMAGE_OR_CDN", "hypothesis": "图片请求、CDN 或图片解码链路出现问题", "confidence": "low",
                "next_checks": ["检查图片阶段 HTTP 状态和 evidence", "手动复现一张样本图片"]}
    if "PARSE" in code or code in {"SOURCE_SEARCH_ERROR", "SOURCE_INFO_ERROR", "SOURCE_PAGES_ERROR"}:
        return {"category": "SOURCE_RESPONSE_OR_PARSER", "hypothesis": "源返回结构或解析逻辑可能发生变化", "confidence": "low",
                "next_checks": ["比较源 JS 和错误阶段的原始证据", "手动检查站点响应结构"]}
    if state == STATE_FAIL:
        return {"category": "SOURCE_FAILURE", "hypothesis": "源链路存在已观察到的失败", "confidence": "unknown",
                "next_checks": ["查看失败阶段和 error_code", "运行该源的有界验收"]}
    return {"category": "NONE", "hypothesis": "", "confidence": "unknown", "next_checks": []}


def _event(current: dict, previous: dict | None, comparison: Comparison) -> tuple[str, str]:
    if previous is None:
        return "FIRST_OBSERVATION", "没有可用历史基线"
    if not comparison.comparable:
        return "NOT_COMPARABLE", comparison.reason
    old_state = previous.get("state")
    new_state = current.get("state")
    if old_state == STATE_PASS and new_state == STATE_FAIL:
        return "NEW_FAILURE", "上一条可比较记录为 PASS"
    if old_state == STATE_FAIL and _strict_pass(current):
        return "RECOVERED", "上一条可比较记录为 FAIL，当前达到严格图片验证等级"
    if new_state == STATE_ERROR:
        return "INFRASTRUCTURE_ERROR", "当前源结果属于 ERROR"
    if new_state == STATE_BLOCKED:
        return "ENVIRONMENT_BLOCKED", "当前结果包含受限状态或证据"
    if old_state == STATE_FAIL and new_state == STATE_FAIL:
        return "PERSISTENT_FAILURE", "当前与上一条记录均为 FAIL"
    if _signature(current) == _signature(previous):
        return "NO_CHANGE", "状态和关键阶段特征未变化"
    return "STATE_CHANGED", "状态或关键阶段特征发生变化"


def _is_intermittent(current: dict, history: list[dict] | None) -> bool:
    if not history:
        return False
    states = []
    for record in history:
        source = next((item for item in record.get("sources", [])
                       if item.get("key") == current.get("key")), None)
        if source and source.get("state") in (STATE_PASS, STATE_FAIL):
            states.append(source["state"])
    states.append(current.get("state"))
    return len(states) >= 4 and states.count(STATE_PASS) >= 2 and states.count(STATE_FAIL) >= 2


def diagnose(current_report: dict, baseline: dict | None = None,
             history: list[dict] | None = None) -> dict:
    current = normalize_report(current_report)
    if baseline and baseline.get("schema_version") == 2:
        baseline = normalize_report(baseline)
    comparison = compare_context(current, baseline) if baseline else Comparison(False, "没有历史基线")
    baseline_sources = (baseline or {}).get("sources") or {}
    events = []
    for key, source in current["sources"].items():
        previous = baseline_sources.get(key)
        event, reason = _event(source, previous, comparison)
        if event not in ("FIRST_OBSERVATION", "NOT_COMPARABLE") and _is_intermittent(source, history):
            event = "INTERMITTENT"
            reason = "至少四次历史记录中出现多次 PASS 与 FAIL"
        diagnosis = _diagnosis(source)
        if event == "NO_CHANGE" and source.get("state") == STATE_PASS:
            diagnosis = {"category": "NONE", "hypothesis": "", "confidence": "high", "next_checks": []}
        events.append({
            "source_key": key,
            "source_name": source.get("name", ""),
            "event": event,
            "comparable": comparison.comparable if previous else False,
            "comparison_reason": reason,
            "observed": {
                "state": source.get("state"),
                "stage": source.get("first_failed_stage"),
                "error_code": source.get("error_code"),
                "verification_level": source.get("verification_level"),
                "evidence": source.get("evidence", {}),
            },
            "diagnosis": diagnosis,
            "diff": {
                "from": previous.get("state") if previous else None,
                "to": source.get("state"),
                "from_stage": previous.get("first_failed_stage") if previous else None,
                "to_stage": source.get("first_failed_stage"),
                "from_error_code": previous.get("error_code") if previous else None,
                "to_error_code": source.get("error_code"),
                "source_sha_changed": bool(previous and previous.get("source_sha256") != source.get("source_sha256")),
                "runtime_changed": comparison.runtime_changed,
                "runner_changed": comparison.runner_changed,
            },
        })
    for key, previous in baseline_sources.items():
        if key in current["sources"]:
            continue
        events.append({
            "source_key": key,
            "source_name": previous.get("name", ""),
            "event": "SOURCE_REMOVED",
            "comparable": comparison.comparable,
            "comparison_reason": "历史记录中存在，当前报告没有该源",
            "observed": {"state": "REMOVED", "stage": "", "error_code": "",
                         "verification_level": "", "evidence": {}},
            "diagnosis": {"category": "SOURCE_CATALOG", "hypothesis": "源可能已下线或从当前测试集合移除",
                          "confidence": "medium", "next_checks": ["检查 index.json 和测试配置"]},
            "diff": {"from": previous.get("state"), "to": None,
                     "from_stage": previous.get("first_failed_stage"), "to_stage": None,
                     "from_error_code": previous.get("error_code"), "to_error_code": None,
                     "source_sha_changed": False, "runtime_changed": comparison.runtime_changed,
                     "runner_changed": comparison.runner_changed},
        })
    counts = {}
    for item in events:
        counts[item["event"]] = counts.get(item["event"], 0) + 1
    return {
        "diagnose_schema_version": DIAGNOSE_SCHEMA_VERSION,
        "vsa_report_schema_version": 2,
        "generated_at": current.get("time"),
        "report_hash": current.get("report_hash"),
        "context": current.get("context"),
        "comparison": {
            "available": baseline is not None,
            "comparable": comparison.comparable,
            "reason": comparison.reason,
            "runner_changed": comparison.runner_changed,
            "runtime_changed": comparison.runtime_changed,
            "source_commit_changed": comparison.source_commit_changed,
        },
        "summary": {"total": len(events), "events": counts},
        "events": events,
    }
