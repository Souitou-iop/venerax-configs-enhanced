#!/usr/bin/env python3
"""Venera Source Assurance (VSA) — 真实 JS 漫画源验收系统入口。

通过官方 venera_cli(QuickJS 运行时)执行仓库中的真实漫画源 JS,
完成 加载→元数据→搜索→详情→章节→图片字节 的端到端验收。

用法:
  # 覆盖率检查(离线, 确定性; PR 合并门槛)
  python scripts/source_assurance.py --check-coverage
  # 单源 / 多源 / 全部(严格模式: 缺 Runner 不产生完整 PASS)
  python scripts/source_assurance.py --source copy_manga
  python scripts/source_assurance.py --sources copy_manga,manhuagui
  python scripts/source_assurance.py --all
  # 离线确定性测试(本地 fixture, 无第三方网络)
  python scripts/source_assurance.py --mode offline
  # 框架自检(负向用例矩阵)
  python scripts/source_assurance.py --self-test
  # 诊断降级模式: runner 不可用时允许静态头弱验证(结果标记 image_header, 不与完整验收混用)
  python scripts/source_assurance.py --all --allow-degraded
  # 指定输出目录 / 运行时
  python scripts/source_assurance.py --all --output reports/ --runtime /path/venera --runner /path/vsa_runner

退出码: 0=无 FAIL/ERROR(含声明式 BLOCKED); 1=存在 FAIL 或覆盖率缺口; 2=框架/运行时 ERROR。
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
    STATE_UNVERIFIED,
    RunnerContext,
    SourceResult,
    run_source,
)
from vsa.config import SourceTestConfig, VsaConfig, js_field, load_config  # noqa: E402
from vsa.fixture import FixtureServer, generate_fixture_sources  # noqa: E402
from vsa.report import build_report, write_json, write_markdown  # noqa: E402
from vsa.runtime import (  # noqa: E402
    CLI_SRC,
    DEFAULT_DATA_DIR,
    DEFAULT_RUNNER,
    DEFAULT_RUNTIME,
    RUNNER_SRC,
    VeneraRuntime,
    VsaRuntimeError,
)

DEFAULT_CONFIG = REPO_ROOT / "scripts/vsa_sources.yml"
DEFAULT_OUTPUT = REPO_ROOT / "work/vsa/reports"
DEFAULT_FIXTURES = REPO_ROOT / "work/vsa/fixtures"


def load_index(path: Path) -> dict:
    items = json.loads(path.read_text(encoding="utf-8"))
    return {it["key"]: it for it in items}


def check_coverage(index: dict, cfg: VsaConfig, repo_root: Path) -> tuple[list[dict], bool]:
    """P0-3: 全源纳管检查(离线确定性)。返回 (问题列表, 是否通过)。

    检查: 索引源缺配置且未豁免 / 配置指向索引外源 / 文件缺失 / key-version 元数据不一致 /
    豁免缺理由。豁免源计入"已纳管但未验收", 不计入已验收。
    """
    problems = []
    for key, meta in index.items():
        sc = cfg.get(key)
        if sc is None:
            problems.append({"code": "CONFIG_COVERAGE_MISSING", "key": key,
                             "detail": "index.json 中的正式源缺少 VSA 测试配置(或未豁免)"})
            continue
        if sc.exempt:
            if not sc.exempt_reason:
                problems.append({"code": "EXEMPT_NO_REASON", "key": key,
                                 "detail": "豁免必须给出 exempt_reason"})
            continue
        js_path = repo_root / meta["fileName"]
        if not js_path.exists():
            problems.append({"code": "SOURCE_FILE_MISSING", "key": key,
                             "detail": f"文件缺失: {meta['fileName']}"})
            continue
        js_key = js_field(js_path, "key")
        js_version = js_field(js_path, "version")
        if js_key != key:
            problems.append({"code": "SOURCE_METADATA_MISMATCH", "key": key,
                             "detail": f"JS key={js_key} 与索引不一致"})
        if js_version != str(meta.get("version")):
            problems.append({"code": "SOURCE_METADATA_MISMATCH", "key": key,
                             "detail": f"JS version={js_version} 与索引 {meta.get('version')} 不一致"})
    for key in cfg.sources:
        if key not in index:
            problems.append({"code": "STALE_CONFIG", "key": key,
                             "detail": "配置指向 index.json 中不存在的源(已下线或 key 变更)"})
    return problems, not problems


def coverage_report_markdown(problems: list[dict], index_count: int, exempt_count: int) -> str:
    lines = [
        "# VSA 覆盖率检查",
        "",
        f"- 正式源总数(index.json): {index_count}",
        f"- 已纳管(有测试配置): {index_count - exempt_count - len([p for p in problems if p['code'] == 'CONFIG_COVERAGE_MISSING'])}",
        f"- 豁免(已纳管未验收): {exempt_count}",
        f"- 问题数: {len(problems)}",
        "",
    ]
    if problems:
        lines += ["| 问题码 | 源 | 说明 |", "| :-- | :-- | :-- |"]
        for p in problems:
            lines.append(f"| {p['code']} | {p['key']} | {p['detail']} |")
    else:
        lines.append("✅ 全部正式源已纳管, 无静默漏测。")
    return "\n".join(lines) + "\n"


def select_sources(args, cfg: VsaConfig, index: dict) -> list[str]:
    # P0-3: --all 以 index.json 为唯一权威, 对每个正式源产出结果
    if args.all:
        return list(index.keys())
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
             runner_ctx: RunnerContext) -> list[SourceResult]:
    keys = select_sources(args, cfg, index)
    results: list[SourceResult] = []
    for i, key in enumerate(keys):
        scfg = cfg.get(key)
        js_path = resolve_js_path(key, index, None)
        if scfg is None or js_path is None:
            # 覆盖率检查应已拦截; 此处如实记录为未验证, 不静默跳过
            r = SourceResult(key=key, file_name=(index.get(key, {}) or {}).get("fileName", ""))
            r.state = STATE_UNVERIFIED
            r.error_code = "CONFIG_COVERAGE_MISSING" if scfg is None else "SOURCE_FILE_MISSING"
            r.detail = "正式源缺少测试配置(运行 --check-coverage 定位)" if scfg is None else "索引中文件缺失"
            results.append(r)
            print(f"  [{key:16}] ⚪ {r.state} ({r.detail[:60]})", flush=True)
            continue
        if scfg.exempt:
            r = SourceResult(key=key, file_name=js_path.name,
                             name=js_field(js_path, "name") or "",
                             version=js_field(js_path, "version") or "")
            r.state = STATE_SKIP
            r.detail = f"豁免(已纳管未验收): {scfg.exempt_reason}"
            results.append(r)
            print(f"  [{key:16}] ⚪ SKIP ({scfg.exempt_reason[:50]})", flush=True)
            continue
        print(f"  [{key:16}] 验收中...", flush=True)
        try:
            res = run_source(rt, js_path, scfg, cfg, index.get(key), runner=runner_ctx)
        except VsaRuntimeError as e:
            res = SourceResult(key=key, file_name=js_path.name)
            res.state = STATE_ERROR
            res.error_class = "runtime"
            res.error_code = "RUNTIME_MISSING"
            res.detail = str(e)
        except Exception as e:  # 框架异常不得记 PASS
            res = SourceResult(key=key, file_name=js_path.name)
            res.state = STATE_ERROR
            res.error_class = type(e).__name__
            res.error_code = "FRAMEWORK_ERROR"
            res.detail = f"{type(e).__name__}: {e}"
        results.append(res)
        mark = {"PASS": "🟢", "FAIL": "🔴", "BLOCKED": "🟠", "SKIP": "⚪", "UNVERIFIED": "⚪", "ERROR": "💥"}.get(res.state, res.state)
        tail = res.stages[-1].detail if res.stages else res.detail
        print(f"  [{key:16}] {mark} {res.state} ({tail[:70]})", flush=True)
        if i < len(keys) - 1:
            time.sleep(cfg.delay_between_sources)
    return results


def run_offline(rt: VeneraRuntime, runner_ctx: RunnerContext) -> tuple[list[SourceResult], list[dict]]:
    """离线 fixture 验收: 返回 (结果列表, 自检断言列表)。"""
    server = FixtureServer()
    server.start()
    results: list[SourceResult] = []
    checks: list[dict] = []
    try:
        files = generate_fixture_sources(DEFAULT_FIXTURES, server.base_url)
        offline_cfg = VsaConfig(sources={}, timeout_stage=45, timeout_image=45,
                                delay_between_sources=0, allow_local=True)

        def cfg_for(key, expect_state=None, **kw):
            # expect_state 仅用于描述断言, 不影响运行
            return SourceTestConfig(key=key, **kw)

        cases = [
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=0), STATE_PASS,
             "ok: 完整运行时链路(真实字节+解码)"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=1), STATE_FAIL,
             "neg-html: 200+HTML 图片须判 FAIL"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=2), STATE_FAIL,
             "neg-corrupt: 损坏字节须判 FAIL"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=3), STATE_FAIL,
             "neg-404: 404 图片须判 FAIL"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=4, image_count=1), STATE_FAIL,
             "neg-truncate: 合法 JPEG 头但截断须判 FAIL(解码验证)"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=5), STATE_FAIL,
             "neg-second: 第一张正常第二张失败须 FAIL(image_count 生效)"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=6), STATE_FAIL,
             "neg-ssrf: 返回内网/元数据 URL 须被护栏拒绝"),
            ("vsa_fixture", cfg_for("vsa_fixture", keyword="vsa", result_index=7), STATE_PASS,
             "count-mismatch: 可用样本少于请求时如实标注"),
            ("vsa_broken", cfg_for("vsa_broken", keyword="vsa"), STATE_FAIL,
             "语法错误须加载失败"),
            ("vsa_badsearch", cfg_for("vsa_badsearch", keyword="vsa"), STATE_FAIL,
             "search 抛异常须 FAIL(JS 错误优先于受限声明)"),
            ("vsa_throwinfo", cfg_for("vsa_throwinfo", keyword="vsa"), STATE_FAIL,
             "info 抛异常须 FAIL"),
            ("vsa_declared_broken", cfg_for("vsa_declared_broken", keyword="vsa",
                                            expect="blocked", blocked_patterns=["403"]), STATE_FAIL,
             "受限声明 + JS 错误 → FAIL(不被 BLOCKED 掩盖)"),
        ]
        for key, scfg, expect_state, desc in cases:
            js_path = files[key]
            try:
                res = run_source(rt, js_path, scfg, offline_cfg, None, runner=runner_ctx)
            except Exception as e:
                res = SourceResult(key=key, file_name=js_path.name)
                res.state = STATE_ERROR
                res.error_class = type(e).__name__
                res.error_code = "FRAMEWORK_ERROR"
                res.detail = f"{type(e).__name__}: {e}"
            results.append(res)
            ok = res.state == expect_state
            checks.append({"case": desc, "expect": expect_state, "actual": res.state, "ok": ok})
            mark = "✅" if ok else "❌"
            print(f"  {mark} [{key}#{scfg.result_index}] 期望 {expect_state}, 实际 {res.state} — {desc}", flush=True)

        # 严格模式: Runner 缺失 → ERROR, 不得降级 PASS
        missing_runner = RunnerContext(binary=Path("/nonexistent/vsa_runner"),
                                       data_dir=Path("/tmp/vsa_missing"), strict=True)
        try:
            res = run_source(rt, files["vsa_fixture"], cfg_for("vsa_fixture", keyword="vsa", result_index=0),
                             offline_cfg, None, runner=missing_runner)
            actual = res.state
        except Exception as e:
            actual = f"EXC:{type(e).__name__}"
        ok = actual == STATE_ERROR
        checks.append({"case": "严格模式 Runner 缺失须 ERROR(不得 PASS)", "expect": STATE_ERROR,
                       "actual": actual, "ok": ok})
        print(f"  {'✅' if ok else '❌'} [strict-runner-missing] 期望 {STATE_ERROR}, 实际 {actual}", flush=True)

        # Runner 协议异常(二进制输出非 JSON)→ ERROR, 不得被静态回退掩盖
        fake_runner = DEFAULT_FIXTURES / "fake_runner.sh"
        DEFAULT_FIXTURES.mkdir(parents=True, exist_ok=True)
        fake_runner.write_text("#!/bin/sh\necho 'not json at all'\nexit 0\n")
        fake_runner.chmod(0o755)
        bad_runner = RunnerContext(binary=fake_runner, data_dir=Path("/tmp/vsa_missing"), strict=True)
        try:
            res = run_source(rt, files["vsa_fixture"], cfg_for("vsa_fixture", keyword="vsa", result_index=0),
                             offline_cfg, None, runner=bad_runner)
            actual = res.state
        except Exception as e:
            actual = f"EXC:{type(e).__name__}"
        ok = actual == STATE_ERROR
        checks.append({"case": "Runner 畸形输出须 ERROR(不得静态回退成 PASS)", "expect": STATE_ERROR,
                       "actual": actual, "ok": ok})
        print(f"  {'✅' if ok else '❌'} [runner-protocol] 期望 {STATE_ERROR}, 实际 {actual}", flush=True)

        # 运行时缺失 → 必须 ERROR(不得 PASS)
        try:
            missing = VeneraRuntime(binary=DEFAULT_RUNTIME.parent / "definitely-missing-venera", auto_build=False)
            missing.ensure()
            ok = False
        except VsaRuntimeError:
            ok = True
        checks.append({"case": "运行时缺失须 ERROR", "expect": "VsaRuntimeError",
                       "actual": "VsaRuntimeError" if ok else "no-raise", "ok": ok})
        print(f"  {'✅' if ok else '❌'} [runtime-missing] 运行时缺失正确触发框架异常", flush=True)
    finally:
        server.stop()
    return results, checks


def write_github_summary(md_path: Path):
    import os
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
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
    ap.add_argument("--all", action="store_true", help="全部正式源(index.json 为准)")
    ap.add_argument("--check-coverage", action="store_true",
                    help="离线覆盖率检查: 正式源与测试配置/豁免的一致性(PR 门槛)")
    ap.add_argument("--mode", choices=["live", "offline"], default="live")
    ap.add_argument("--allow-degraded", action="store_true",
                    help="诊断降级模式: runner 不可用时允许静态头弱验证(标记 image_header)")
    ap.add_argument("--self-test", action="store_true", help="离线负向自检(判定路径矩阵)")
    ap.add_argument("--output", default=str(DEFAULT_OUTPUT), help="报告输出目录")
    ap.add_argument("--runtime", default=str(DEFAULT_RUNTIME), help="venera 运行时路径")
    ap.add_argument("--runner", default=str(DEFAULT_RUNNER), help="VSA Dart runner 路径(严格模式必需)")
    ap.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR), help="runner 数据目录(cookie 持久化)")
    ap.add_argument("--build", action="store_true", help="运行时缺失时自动构建(需 Dart)")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG), help="每源测试配置")
    ap.add_argument("--index", default=str(REPO_ROOT / "index.json"))
    args = ap.parse_args()

    out_dir = Path(args.output)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    mode = "offline" if (args.mode == "offline" or args.self_test) else "live"

    # ---- 覆盖率检查(离线确定性) ----
    if args.check_coverage:
        cfg = load_config(Path(args.config))
        index = load_index(Path(args.index))
        problems, ok = check_coverage(index, cfg, REPO_ROOT)
        exempt_count = sum(1 for k in index if cfg.get(k) and cfg.get(k).exempt)
        md = coverage_report_markdown(problems, len(index), exempt_count)
        print(md)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"vsa-coverage-{ts}.md").write_text(md, encoding="utf-8")
        if args.check_coverage and problems:
            sys.exit(1)
        sys.exit(0)

    results: list[SourceResult] = []
    checks: list[dict] = []
    # 严格模式: live 验收默认 strict(--allow-degraded 为诊断降级);
    # offline 自检固定诊断模式(strict 语义由显式的 runner 缺失合成用例覆盖)
    strict = (not args.allow_degraded) and mode == "live"
    try:
        # 离线 fixture 使用独立 CLI 数据目录(仅 5 个 fixture 源, 启动快且确定性;
        # live 共享 cli_home 以持久化 cookie/设备身份)
        home_dir = Path(args.data_dir) / ("cli_home_offline" if mode == "offline" else "cli_home")
        rt = VeneraRuntime(binary=Path(args.runtime), auto_build=args.build,
                           home_dir=home_dir)
        rt.ensure()
        runner_binary = Path(args.runner)
        if not runner_binary.exists() and args.build and Path(args.runtime).exists():
            from vsa.runtime import VeneraRuntime as _R
            _R(Path(args.runtime), auto_build=False).build_runner()
        runner_ctx = RunnerContext(binary=runner_binary if runner_binary.exists() else None,
                                   data_dir=Path(args.data_dir), strict=strict)
        runner_ctx.data_dir.mkdir(parents=True, exist_ok=True)
        print(f"运行时: {rt.version} @ {rt.binary}", flush=True)
        print(f"runner: {'可用' if runner_ctx.binary else ('缺失' if strict else '缺失(诊断降级)')} @ {runner_binary} "
              f"| 模式: {'strict' if strict else 'limited'}", flush=True)

        if mode == "offline":
            results, checks = run_offline(rt, runner_ctx)
        else:
            cfg = load_config(Path(args.config))
            index = load_index(Path(args.index))
            # 严格模式先做覆盖率门槛(静默漏测必须先暴露)
            problems, ok = check_coverage(index, cfg, REPO_ROOT)
            if not ok:
                print("❌ 覆盖率检查未通过(--check-coverage 查看详情):", flush=True)
                for p in problems[:8]:
                    print(f"   {p['code']} {p['key']}: {p['detail']}", flush=True)
                if strict:
                    sys.exit(1)
            results = run_live(args, rt, cfg, index, runner_ctx)
    except VsaRuntimeError as e:
        print(f"💥 框架 ERROR: {e}", file=sys.stderr)
        meta = {"time": datetime.datetime.now().isoformat(), "mode": mode, "platform": platform.platform(),
                "runtime": str(args.runtime), "framework_error": str(e), "schema_version": 2}
        report = build_report(meta, results)
        report["self_test"] = checks
        write_json(report, out_dir / f"vsa-{mode}-{ts}.json")
        sys.exit(2)

    self_test_failed = args.self_test and any(not c["ok"] for c in checks)
    meta = {
        "schema_version": 2,
        "time": datetime.datetime.now().isoformat(),
        "mode": mode,
        "platform": platform.platform(),
        "runtime": rt.version,
        "runtime_path": str(rt.binary),
        "runtime_build_id": VeneraRuntime.build_id(CLI_SRC) if CLI_SRC.exists() else "prebuilt",
        "runner_build_id": VeneraRuntime.build_id(RUNNER_SRC),
        "runner_path": str(args.runner),
        "strict": strict,
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
