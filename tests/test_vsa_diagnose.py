import json
import tempfile
import unittest
from pathlib import Path

from scripts.vsa.diagnose import DiagnoseInputError, diagnose, load_report
from scripts.vsa.diagnose_history import (
    load_history,
    select_baseline,
    snapshot_report,
    write_snapshot,
)


def report(state="PASS", error_code="", stage="", level="runtime_image_decoded",
           runtime="runtime-1", runner="runner-1", source_commit="commit-a",
           config="config-1", platform="ubuntu"):
    stages = [{"stage": "load", "state": "PASS", "error_code": "", "evidence": {}}]
    if stage:
        stages.append({"stage": stage, "state": state, "error_code": error_code,
                       "evidence": {"evidence_type": "http_status", "http_status": 403}})
    return {
        "schema_version": 2,
        "meta": {"time": "2026-11-15T00:00:00Z", "mode": "live", "strict": True,
                  "runtime_build_id": runtime, "runner_build_id": runner,
                  "source_commit": source_commit, "config_hash": config,
                  "platform": platform},
        "summary": {"PASS": 1 if state == "PASS" else 0, "FAIL": 1 if state == "FAIL" else 0,
                     "BLOCKED": 1 if state == "BLOCKED" else 0, "ERROR": 1 if state == "ERROR" else 0},
        "results": [{"key": "demo", "name": "Demo", "version": "1.0.0", "file": "demo.js",
                      "js_sha256": "sha-demo", "state": state, "error_code": error_code,
                      "verification_level": level, "evidence": {}, "stages": stages}],
    }


class DiagnoseTests(unittest.TestCase):
    def test_first_observation(self):
        result = diagnose(report())
        self.assertEqual(result["events"][0]["event"], "FIRST_OBSERVATION")

    def test_new_failure_with_source_commit_change_is_comparable(self):
        current = report(state="FAIL", error_code="SOURCE_SEARCH_PARSE_ERROR", stage="search",
                         source_commit="commit-b")
        result = diagnose(current, report())
        self.assertEqual(result["events"][0]["event"], "NEW_FAILURE")
        self.assertTrue(result["comparison"]["comparable"])
        self.assertTrue(result["comparison"]["source_commit_changed"])

    def test_runner_build_change_is_a_clue_not_a_block(self):
        current = report(state="FAIL", error_code="SOURCE_INFO_ERROR", stage="info", runner="runner-2")
        result = diagnose(current, report())
        self.assertEqual(result["events"][0]["event"], "NEW_FAILURE")
        self.assertTrue(result["events"][0]["diff"]["runner_changed"])

    def test_runtime_change_is_not_comparable(self):
        result = diagnose(report(state="FAIL", error_code="SOURCE_INFO_ERROR", stage="info", runtime="runtime-2"), report())
        self.assertEqual(result["events"][0]["event"], "NOT_COMPARABLE")
        self.assertTrue(result["events"][0]["diff"]["runtime_changed"])

    def test_runner_kernel_update_keeps_comparison(self):
        current = report(state="FAIL", error_code="IMAGE_HTTP_ERROR", stage="image",
                         platform="Linux-7.0.0-1016-aws-x86_64-with-glibc2.43")
        baseline = report(platform="Linux-7.0.0-1019-azure-x86_64-with-glibc2.43")
        result = diagnose(current, baseline)
        self.assertTrue(result["comparison"]["comparable"])
        self.assertTrue(result["comparison"]["platform_changed"])
        self.assertEqual(result["events"][0]["event"], "NEW_FAILURE")
        self.assertTrue(result["events"][0]["diff"]["platform_changed"])

    def test_platform_family_change_is_not_comparable(self):
        current = report(platform="macOS-27.3-arm64-arm-64bit-Mach-O")
        baseline = report(platform="Linux-7.0.0-1019-azure-x86_64-with-glibc2.43")
        result = diagnose(current, baseline)
        self.assertFalse(result["comparison"]["comparable"])
        self.assertIn("platform_family", result["comparison"]["reason"])

    def test_history_baseline_ignores_kernel_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            baseline = report(platform="Linux-7.0.0-1019-azure-x86_64-with-glibc2.43")
            write_snapshot(snapshot_report(baseline, "run-1"), path)
            current = report(
                state="FAIL",
                error_code="IMAGE_HTTP_ERROR",
                stage="image",
                platform="Linux-7.0.0-1016-aws-x86_64-with-glibc2.43",
            )
            selected = select_baseline(current, load_history(path))
            self.assertIsNotNone(selected)
            result = diagnose(current, selected)
            self.assertTrue(result["comparison"]["comparable"])

    def test_history_baseline_skips_current_report(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            current = report(state="FAIL", error_code="IMAGE_HTTP_ERROR", stage="image")
            write_snapshot(snapshot_report(current, "run-current"), path)
            self.assertIsNone(select_baseline(current, load_history(path)))

    def test_recovered_requires_strict_image_level(self):
        current = report(state="PASS", level="runtime_image_bytes")
        result = diagnose(current, report(state="FAIL", error_code="IMAGE_HTTP_ERROR", stage="image"))
        self.assertEqual(result["events"][0]["event"], "RECOVERED")

    def test_persistent_failure_and_stage_change_are_visible(self):
        current = report(state="FAIL", error_code="IMAGE_HTTP_ERROR", stage="image")
        result = diagnose(current, report(state="FAIL", error_code="SOURCE_SEARCH_ERROR", stage="search"))
        event = result["events"][0]
        self.assertEqual(event["event"], "PERSISTENT_FAILURE")
        self.assertEqual(event["diff"]["from_stage"], "search")
        self.assertEqual(event["diff"]["to_stage"], "image")

    def test_error_is_infrastructure(self):
        result = diagnose(report(state="ERROR", error_code="RUNNER_PROTOCOL_ERROR", stage="search"), report())
        self.assertEqual(result["events"][0]["event"], "INFRASTRUCTURE_ERROR")
        self.assertEqual(result["events"][0]["diagnosis"]["category"], "RUNTIME_OR_RUNNER")

    def test_blocked_is_environment_event(self):
        result = diagnose(report(state="BLOCKED", error_code="NETWORK_STATUS_BLOCKED", stage="image"), report())
        self.assertEqual(result["events"][0]["event"], "ENVIRONMENT_BLOCKED")

    def test_snapshot_is_sanitized_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            snapshot = snapshot_report(report(), "run-1")
            written = write_snapshot(snapshot, path)
            self.assertEqual(len(load_history(path)), 1)
            self.assertEqual(json.loads(written.read_text())["run_id"], "run-1")
            write_snapshot(snapshot, path)
            written.write_text(
                json.dumps(snapshot, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                encoding="utf-8",
            )
            write_snapshot(snapshot, path)
            with self.assertRaises(DiagnoseInputError):
                changed = dict(snapshot)
                changed["report_hash"] = "different"
                write_snapshot(changed, path)

    def test_snapshot_evidence_keys_are_sorted(self):
        current = report()
        current["results"][0]["evidence"] = {
            "http_status": 403,
            "evidence_type": "http_status",
            "marker": "challenge",
        }
        snapshot = snapshot_report(current, "run-1")
        evidence = snapshot["sources"][0]["evidence"]
        self.assertEqual(list(evidence), sorted(evidence))

    def test_intermittent_requires_multiple_history_records(self):
        history = []
        for state in ("PASS", "FAIL", "PASS"):
            history.append({"sources": [{"key": "demo", "state": state}]})
        result = diagnose(report(state="FAIL", error_code="SOURCE_INFO_ERROR", stage="info"),
                          report(state="PASS"), history=history)
        self.assertEqual(result["events"][0]["event"], "INTERMITTENT")

    def test_removed_source_is_explicit(self):
        current = report()
        current["results"] = []
        result = diagnose(current, report())
        self.assertEqual(result["events"][0]["event"], "SOURCE_REMOVED")

    def test_invalid_report_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.json"
            path.write_text("{bad", encoding="utf-8")
            with self.assertRaises(DiagnoseInputError):
                load_report(path)


if __name__ == "__main__":
    unittest.main()
