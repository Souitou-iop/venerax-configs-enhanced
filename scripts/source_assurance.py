#!/usr/bin/env python3
"""Venera Source Assurance (VSA) — 真实 JS 漫画源验收系统入口。

通过官方 venera_cli(QuickJS 运行时)执行仓库中的真实漫画源 JS,
完成 加载→元数据→搜索→详情→章节→图片字节 的端到端验收。

用法:
  # 单源
  python scripts/source_assurance.py --source copy_manga
  # 多源 / 全部已配置源
  python scripts/source_assurance.py --sources copy_manga,manhuagui
  python scripts/source_assurance.py --all
  # 离线确定性测试(本地 fixture, 无第三方网络)
  python scripts/source_assurance.py --mode offline
  # 框架自检(负向用例: 断言框架能抓到每类故障)
  python scripts/source_assurance.py --self-test
  # 指定输出目录 / 运行时
  python scripts/source_assurance.py --source copy_manga --output reports/ --runtime /path/venera

退出码: 0=无 FAIL/ERROR; 1=存在 FAIL; 2=框架/运行时 ERROR。
"""
from __future__ import annotations

import argparse
import datetime
import json
import platform
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from vsa.chain import (  # noqa: E402
    STATE_ERROR,
    STATE_FAIL,
    STATE_PASS,
    STATE_SKIP,
    SourceResult,
    run_source,
)
from vsa.config import SourceTestConfig, VsaConfig, load_config  # noqa: E402
from vsa.fixture import FixtureServer, generate_fixture_sources  # noqa: E402
from vsa.report import build_report, write_json, write_markdown  # noqa: E402
from vsa.runtime import (  # noqa: E402
    DEFAULT_DATA_DIR,
    DEFAULT_RUNNER,
    DEFAULT_RUNTIME,
    VeneraRuntime,
    VsaRuntimeError,
)

DEFAULT_CONFIG = REPO_ROOT / "scripts/vsa_sources.yml"
DEFAULT_OUTPUT = REPO_ROOT / "work/vsa/reports"
DEFAULT_FIXTURES = REPO_ROOT / "work/vsa/fixtures"


def load_index(path: Path) -> dict:
    items = json.loads(path.read_text(encoding="utf-8"))
    return {it["key"]: it for it in items}


def select_sources(args, cfg: VsaConfig, index: dict) -> list[str]:
    if args.all:
        return list(cfg.sources.keys())
    if args.sources:
        requested = [s.strip() for s in args.sources.split(",") if s.strip()]
    elif args.source:
        requested = [args.source]
    else:
        print("未指定 --source/--sources/--all", file=sys.stderr)
        sys.exit(2)
    return requested


def resolve_js_path(key: str, index: dict, offline_dir: Path | None) -> Path | None:
    if offline_dir is not None:
        candidate = offline_dir / f"{key}.js"
        return candidate if candidate.exists() else None
    meta = index.get(key)
    if not meta:
        return None
    p = REPO_ROOT / meta["fileName"]
    return p if p.exists() else None


def run_live(args, rt: VeneraRuntime, cfg: VsaConfig, index: dict,
             runner_binary, data_dir) -> list[SourceResult]:
    keys = select_sources(args, cfg, index)
    results: list[SourceResult] = []
    for i, key in enumerate(keys):
        scfg = cfg.get(key)
        js_path = resolve_js_path(key, index, None)
        if scfg is None or js_path is None:
            r = SourceResult(key=key, file_name=(index.get(key, {}) or {}).get("fileName", ""))
            r.state = STATE_SKIP
            r.detail = "未配置测试配置" if scfg is None else "索引中无此源或文件缺失"
            results.append(r)
            print(f"  [{key:14}] SKIP ({r.detail})", flush=True)
            continue
        print(f"  [{key:14}] 验收中...", flush=True)
        try:
            res = run_source(rt, js_path, scfg, cfg, index.get(key),
                             runner_binary=runner_binary, data_dir=data_dir)
        except VsaRuntimeError as e:
            res = SourceResult(key=key, file_name=js_path.name)
            res.state = STATE_ERROR
            res.error_class = "runtime"
            res.detail = str(e)
        except Exception as e:  # 框架异常不得记 PASS
            res = SourceResult(key=key, file_name=js_path.name)
            res.state = STATE_ERROR
            res.error_class = type(e).__name__
            res.detail = f"{type(e).__name__}: {e}"
        results.append(res)
        mark = {"PASS": "🟢", "FAIL": "🔴", "BLOCKED": "🟠", "SKIP": "⚪", "UNVERIFIED": "⚪", "ERROR": "💥"}.get(res.state, res.state)
        tail = res.stages[-1].detail if res.stages else res.detail
        print(f"  [{key:14}] {mark} {res.state} ({tail[:70]})", flush=True)
        if i < len(keys) - 1:
            time.sleep(cfg.delay_between_sources)
    return results


def run_offline(rt: VeneraRuntime) -> tuple[list[SourceResult], list[dict]]:
    """离线 fixture 验收: 返回 (结果列表, 自检断言列表)。"""
    server = FixtureServer()
    server.start()
    results: list[SourceResult] = []
    checks: list[dict] = []
    try:
        files = generate_fixture_sources(DEFAULT_FIXTURES, server.base_url)
        offline_cfg = VsaConfig(sources={}, timeout_stage=15, timeout_image=15, delay_between_sources=0)

        def cfg_for(key, **kw):
            return SourceTestConfig(key=key, **kw)

        cases = [
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=0), STATE_PASS, "ok"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=1), STATE_FAIL, "neg-html: 200+HTML 图片须判 FAIL"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=2), STATE_FAIL, "neg-corrupt: 损坏字节须判 FAIL"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=3), STATE_FAIL, "neg-404: 404 图片须判 FAIL"),
            ("vsa_broken", cfg_for("vsa_broken", keyword="vsa"), STATE_FAIL, "语法错误须加载失败"),
            ("vsa_badsearch", cfg_for("vsa_badsearch", keyword="vsa"), STATE_FAIL, "search 抛异常须 FAIL"),
            ("vsa_throwinfo", cfg_for("vsa_throwinfo", keyword="vsa"), STATE_FAIL, "info 抛异常须 FAIL"),
        ]
        for key, scfg, expect_state, desc in cases:
            js_path = files[key]
            try:
                res = run_source(rt, js_path, scfg, offline_cfg, None)
            except Exception as e:
                res = SourceResult(key=key, file_name=js_path.name)
                res.state = STATE_ERROR
                res.error_class = type(e).__name__
                res.detail = f"{type(e).__name__}: {e}"
            results.append(res)
            ok = res.state == expect_state
            checks.append({"case": desc, "expect": expect_state, "actual": res.state, "ok": ok})
            mark = "✅" if ok else "❌"
            print(f"  {mark} [{key}#{scfg.result_index or ''}] 期望 {expect_state}, 实际 {res.state} — {desc}", flush=True)

        # 运行时缺失 → 必须 ERROR(不得 PASS)
        try:
            missing = VeneraRuntime(binary=DEFAULT_RUNTIME.parent / "definitely-missing-venera", auto_build=False)
            missing.ensure()
            ok = False
            err = "运行时缺失未触发 VsaRuntimeError"
        except VsaRuntimeError:
            ok = True
            err = ""
        checks.append({"case": "运行时缺失须 ERROR", "expect": "VsaRuntimeError", "actual": "VsaRuntimeError" if ok else "no-raise", "ok": ok})
        print(f"  {'✅' if ok else '❌'} [runtime-missing] 运行时缺失正确触发框架异常", flush=True)
    finally:
        server.stop()
    return results, checks


def write_github_summary(md_path: Path):
    summary_path = __import__("os").environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        try:
            with open(summary_path, "a", encoding="utf-8") as f:
                f.write(md_path.read_text(encoding="utf-8") + "\n\n")
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser(description="Venera Source Assurance (VSA)")
    ap.add_argument("--source", help="单个源 key")
    ap.add_argument("--sources", help="逗号分隔多个源 key")
    ap.add_argument("--all", action="store_true", help="全部已配置源")
    ap.add_argument("--mode", choices=["live", "offline"], default="live")
    ap.add_argument("--self-test", action="store_true", help="离线负向自检(框架判定路径)")
    ap.add_argument("--output", default=str(DEFAULT_OUTPUT), help="报告输出目录")
    ap.add_argument("--runtime", default=str(DEFAULT_RUNTIME), help="venera 运行时路径")
    ap.add_argument("--runner", default=str(DEFAULT_RUNNER), help="VSA Dart runner 路径(运行时内取图)")
    ap.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR), help="runner 数据目录(cookie 持久化)")
    ap.add_argument("--build", action="store_true", help="运行时缺失时自动构建(需 Dart)")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG), help="每源测试配置")
    ap.add_argument("--index", default=str(REPO_ROOT / "index.json"))
    args = ap.parse_args()

    out_dir = Path(args.output)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    mode = "offline" if (args.mode == "offline" or args.self_test) else "live"

    results: list[SourceResult] = []
    checks: list[dict] = []
    try:
        rt = VeneraRuntime(binary=Path(args.runtime), auto_build=args.build)
        rt.ensure()
        runner = Path(args.runner)
        if not runner.exists() and args.build and Path(args.runtime).exists():
            # CLI 已存在而 runner 缺失时, 只补建 runner
            from vsa.runtime import VeneraRuntime as _R
            _R(Path(args.runtime), auto_build=False).build_runner()
        data_dir = Path(args.data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        print(f"运行时: {rt.version} @ {rt.binary}", flush=True)
        print(f"runner: {'可用' if runner.exists() else '不可用(回退静态头下载)'} @ {runner}", flush=True)

        if mode == "offline":
            results, checks = run_offline(rt)
        else:
            cfg = load_config(Path(args.config))
            index = load_index(Path(args.index))
            results = run_live(args, rt, cfg, index, runner, data_dir)
    except VsaRuntimeError as e:
        print(f"💥 框架 ERROR: {e}", file=sys.stderr)
        meta = {"time": datetime.datetime.now().isoformat(), "mode": mode, "platform": platform.platform(),
                "runtime": str(args.runtime), "framework_error": str(e)}
        report = build_report(meta, results)
        report["self_test"] = checks
        write_json(report, out_dir / f"vsa-{mode}-{ts}.json")
        sys.exit(2)

    self_test_failed = args.self_test and any(not c["ok"] for c in checks)
    meta = {
        "time": datetime.datetime.now().isoformat(),
        "mode": mode,
        "platform": platform.platform(),
        "runtime": rt.version,
        "runtime_path": str(rt.binary),
    }
    report = build_report(meta, results)
    if checks:
        report["self_test"] = checks
        report["self_test_passed"] = all(c["ok"] for c in checks)
    json_path = write_json(report, out_dir / f"vsa-{mode}-{ts}.json")
    md_path = write_markdown(report, out_dir / f"vsa-{mode}-{ts}.md")
    write_github_summary(md_path)
    print(f"\n报告: {json_path}\n      {md_path}")

    if args.self_test:
        # 自检模式下退出码只反映判定路径正确性(负向用例的 FAIL 是预期产物)
        if self_test_failed:
            print("❌ 自检存在未通过的判定路径", file=sys.stderr)
            sys.exit(1)
        print("✅ 自检全部判定路径符合预期")
        sys.exit(0)

    summary = report["summary"]
    if summary.get(STATE_ERROR, 0) > 0:
        sys.exit(2)
    if summary.get(STATE_FAIL, 0) > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
