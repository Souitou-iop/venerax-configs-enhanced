"""VSA 验收链路: 加载→元数据→搜索/探索→详情→章节→图片字节, 六态分类。

状态: PASS / FAIL / BLOCKED / SKIP / UNVERIFIED / ERROR
验证分级(verification_level, 与六态正交):
  metadata_only         仅验证 JS 加载与元数据
  source_chain          通过真实 JS 走完搜索/详情/章节(拿到图片 URL)
  image_header          仅静态请求头读取图片头(弱验证, 不得宣传为完整阅读验证)
  runtime_image_bytes   经运行时(onImageLoad 动态头)取得真实图片字节
  runtime_image_decoded 经运行时取得且完整解码成功
严格模式(strict)下, 完整 PASS 至少需要 runtime_image_bytes; Runner 缺失/协议异常
一律 ERROR, 不降级为静态头 PASS。

BLOCKED 判定原则(P0-2):
  - 先保留事实(逐阶段执行结果/原始错误), 再做环境归因;
  - JS 层错误(SyntaxError/JSON 解析/空数据)一律 FAIL, 不套用地区限制;
  - 认证类错误(401/Not logged in/登录) → BLOCKED(AUTH_REQUIRED);
  - HTTP 状态类错误仅在声明模式(status:N)命中时 → BLOCKED(NETWORK_STATUS_BLOCKED);
  - 异常文本命中声明模式 → BLOCKED(DECLARED_ENV_BLOCKED);
  - 入口/搜索阶段 JS 解析失败时, 对源站点首页做一次性挑战页证据探测,
    探测到挑战特征 → BLOCKED(CHALLENGE_PAGE), 否则 FAIL;
  - 无任何证据支撑的失败 → FAIL。
"""
from __future__ import annotations

import json
import re
import ssl
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .config import SourceTestConfig, VsaConfig, js_field
from .runtime import RUNTIME_UA, VeneraRuntime

STATE_PASS = "PASS"
STATE_FAIL = "FAIL"
STATE_BLOCKED = "BLOCKED"
STATE_SKIP = "SKIP"
STATE_UNVERIFIED = "UNVERIFIED"
STATE_ERROR = "ERROR"

LEVEL_METADATA = "metadata_only"
LEVEL_SOURCE_CHAIN = "source_chain"
LEVEL_IMAGE_HEADER = "image_header"
LEVEL_RUNTIME_BYTES = "runtime_image_bytes"
LEVEL_RUNTIME_DECODED = "runtime_image_decoded"

STAGE_ORDER = ["load", "metadata", "search", "info", "pages", "image"]

MAGIC_CHECKS = [
    (b"\xff\xd8\xff", "JPEG"),
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"RIFF", "WebP"),
    (b"GIF8", "GIF"),
]

# JS 层错误标志: 命中即 FAIL, 不套用环境受限(优先级最高)
JS_ERROR_MARKERS = [
    "syntaxerror",
    "unexpected token",
    "json parse",
    "failed to parse",
    "解析失败",
    "章节数据缺失",
    "no images",
    "空数据",
    "详情页解析失败",
    "无结果或结构异常",
    "章节为空",
]
# 认证类标志 → BLOCKED(AUTH_REQUIRED)
AUTH_MARKERS = [
    "not logged in",
    "401",
    "需要登录",
    "需登录",
    "登录",
    "login required",
    "unauthorized",
]


def identify_image(head: bytes) -> str:
    if head[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WebP"
    if head[:4] == b"GIF8":
        return "GIF"
    # ISOBMFF ftyp box — AVIF/HEIF 容器
    if len(head) >= 8 and head[4:8] == b"ftyp":
        return "AVIF"
    if b"<html" in head[:200].lower() or b"<!doctype" in head[:200].lower():
        return "HTML(非图片)"
    return f"未知({head[:8].hex()})"


def _sanitize_url(url: str, limit: int = 100) -> str:
    """报告中的 URL: 去 query/fragment/userinfo, 截断; 不泄漏签名与凭据。"""
    u = url.split("?", 1)[0].split("#", 1)[0]
    if "@" in u.split("://", 1)[-1]:
        parts = u.split("://", 1)
        host_part = parts[1].split("@", 1)[-1]
        u = parts[0] + "://" + host_part
    return u[:limit]


@dataclass
class Stage:
    name: str
    state: str
    detail: str = ""
    elapsed_ms: int = 0
    error_code: str = ""
    evidence: dict = field(default_factory=dict)


@dataclass
class SourceResult:
    key: str
    file_name: str
    name: str = ""
    version: str = ""
    js_sha256: str = ""
    state: str = STATE_UNVERIFIED
    stages: list = field(default_factory=list)
    error_code: str = ""
    detail: str = ""
    verification_level: str = LEVEL_METADATA
    evidence: dict = field(default_factory=dict)

    def add(self, stage: str, state: str, detail: str = "", elapsed_ms: int = 0,
            error_code: str = "", evidence: dict | None = None):
        self.stages.append(Stage(stage, state, detail, elapsed_ms, error_code, evidence or {}))


# ---------------------------------------------------------------------------
# BLOCKED 类型化规则: {status: 403} / {err: "文本"} / {body: "标记"}; 旧式裸字符串:
#   纯数字 → status, 其余 → err
# ---------------------------------------------------------------------------
def _norm_patterns(patterns: list) -> list:
    out = []
    for p in patterns or []:
        if isinstance(p, dict):
            for kind, value in p.items():
                if kind in ("status", "err", "body"):
                    out.append((kind, str(value)))
        else:
            s = str(p).strip()
            if s.isdigit():
                out.append(("status", s))
            else:
                out.append(("err", s))
    return out


def _match_typed(patterns: list, stderr: str, body_head: bytes | None) -> tuple | None:
    """返回命中的 (kind, value), 未命中返回 None。"""
    for kind, value in _norm_patterns(patterns):
        if kind == "status" and value in stderr:
            return (kind, value)
        if kind == "err" and value.lower() in stderr.lower():
            return (kind, value)
        if kind == "body" and body_head and value.lower() in body_head.lower():
            return (kind, value)
    return None


def _is_js_error(stderr: str) -> bool:
    low = (stderr or "").lower()
    return any(marker in low for marker in JS_ERROR_MARKERS)


def _is_auth_error(stderr: str) -> bool:
    low = (stderr or "").lower()
    return any(marker in low for marker in AUTH_MARKERS)


def probe_site_challenge(base_url: str, timeout: int = 15) -> dict:
    """对源站点首页做一次性挑战页证据探测(诊断用途, 与验收结果分开记录)。

    返回 {"kind": ..., "marker": ...} 或 {}。不改变阶段状态本身, 只提供归因证据。
    """
    if not base_url.startswith("http"):
        return {}
    guard = guard_url(base_url)
    if guard:
        return {"kind": "URL_GUARD", "marker": guard}
    markers = [
        ("challenge", "just a moment"),
        ("challenge", "cf-browser-verification"),
        ("challenge", "checking your browser"),
        ("challenge", "attention required"),
        ("challenge", "challenge-platform"),
        ("captcha", "captcha"),
        ("rate_limit", "访问过于频繁"),
        ("rate_limit", "环境异常"),
    ]
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(
            base_url, headers={"User-Agent": RUNTIME_UA})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read(4096).decode("utf-8", "ignore").lower()
            status = resp.status
    except urllib.error.HTTPError as e:
        try:
            body = e.read(4096).decode("utf-8", "ignore").lower()
        except Exception:
            body = ""
        status = e.code
    except Exception as e:
        return {"kind": "PROBE_ERROR", "marker": str(e)[:80], "status": None}
    for kind, marker in markers:
        if marker in body:
            return {"kind": kind, "marker": marker, "status": status}
    return {"kind": "NO_CHALLENGE", "marker": "", "status": status}


def guard_url(url: str, allow_local: bool = False) -> str | None:
    """URL 安全护栏: 仅允许 http/https 公网目标; 阻止内网/环回/云元数据(SSRF)。"""
    try:
        uri = urllib.parse.urlparse(url)
    except Exception:
        return "URL 无法解析"
    if uri.scheme not in ("http", "https"):
        return f"非 http/https 协议: {uri.scheme}"
    host = (uri.hostname or "").lower()
    if not host:
        return "URL 缺少主机名"
    is_local = host in ("localhost", "::1") or host.endswith(".local")
    try:
        import ipaddress
        addr = ipaddress.ip_address(host)
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_unspecified:
            is_local = True
    except ValueError:
        pass
    if is_local and not allow_local:
        return f"拒绝访问本地/私网地址: {host}"
    if host == "169.254.169.254" or host == "metadata.google.internal":
        return "拒绝访问云元数据地址"
    return None


def classify_failure(stage: str, stderr: str, patterns: list,
                     challenge_evidence: dict | None = None) -> tuple[str, str, dict]:
    """按 P0-2 原则归因失败: 返回 (state, error_code, evidence)。"""
    stderr = stderr or ""
    # 1. 认证类 → BLOCKED(AUTH_REQUIRED)
    if _is_auth_error(stderr):
        marker = next((m for m in AUTH_MARKERS if m in stderr.lower()), "")
        return STATE_BLOCKED, "AUTH_REQUIRED", {"evidence_type": "auth", "marker": marker}
    # 2. JS 层错误 → FAIL(挑战页证据探测在调用方先行完成, 命中则走 3)
    if _is_js_error(stderr):
        if challenge_evidence and challenge_evidence.get("kind") in ("challenge", "captcha"):
            return STATE_BLOCKED, "CHALLENGE_PAGE", {
                "evidence_type": "challenge_page",
                "marker": challenge_evidence.get("marker", ""),
                "probe": "site_homepage",
            }
        return STATE_FAIL, _stage_error_code(stage, kind="parse"), {"evidence_type": "js_error"}
    # 3. 类型化声明模式
    hit = _match_typed(patterns, stderr, None)
    if hit:
        kind, value = hit
        if kind == "status":
            return STATE_BLOCKED, "NETWORK_STATUS_BLOCKED", {
                "evidence_type": "http_status", "status": value}
        return STATE_BLOCKED, "DECLARED_ENV_BLOCKED", {
            "evidence_type": "stderr_pattern", "marker": value}
    # 4. 传输层故障(超时/拒连)无声明 → UNVERIFIED
    if any(k in stderr.lower() for k in ("timed out", "timeout", "connection refused", "errno 111")):
        return STATE_UNVERIFIED, "NETWORK_TIMEOUT", {"evidence_type": "network"}
    # 5. 其余 → FAIL
    return STATE_FAIL, _stage_error_code(stage, kind="other"), {"evidence_type": "stderr"}


def _stage_error_code(stage: str, kind: str = "other") -> str:
    codes = {
        ("load", "parse"): "SOURCE_LOAD_ERROR",
        ("metadata", "other"): "SOURCE_METADATA_MISMATCH",
        ("search", "parse"): "SOURCE_SEARCH_PARSE_ERROR",
        ("search", "other"): "SOURCE_SEARCH_ERROR",
        ("info", "parse"): "SOURCE_INFO_ERROR",
        ("info", "other"): "SOURCE_INFO_ERROR",
        ("pages", "parse"): "SOURCE_PAGES_EMPTY",
        ("pages", "other"): "SOURCE_PAGES_ERROR",
        ("image", "other"): "IMAGE_HTTP_ERROR",
    }
    return codes.get((stage, kind), f"{stage.upper()}_ERROR")


def _download_head(url: str, headers: dict, timeout: int, allow_local: bool = False) -> tuple[int, bytes, str]:
    """静态头诊断探针(弱验证, 仅 limited 模式/诊断用): 证书校验开启, SSRF 护栏。"""
    guard = guard_url(url, allow_local=allow_local)
    if guard:
        return "BLOCKED", b"", guard
    headers = dict(headers or {})
    headers.setdefault("User-Agent", RUNTIME_UA)
    req_headers = headers
    try:
        req_url = urllib.parse.quote(url, safe=":/%?#=&;@,+$~'!()*[]'") \
            if any(ord(c) > 127 for c in url) else url
        req = urllib.request.Request(req_url, headers=req_headers)
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            head = resp.read(64)
            return resp.status, head, ""
    except urllib.error.HTTPError as e:
        try:
            body = e.read(64)
        except Exception:
            body = b""
        return e.code, body, f"HTTP {e.code}"
    except Exception as e:
        return "ERR", b"", str(e)[:120]


def verify_images_via_runner(runner: Path, js_path: Path, key: str, comic_id: str, ep_id: str,
                             data_dir: Path, count: int, timeout: int,
                             allow_local: bool = False) -> dict:
    """通过薄 Dart runner 在运行时内取图: 调源自身 loadEp + onImageLoad 动态头后实抓字节。"""
    import subprocess as sp
    try:
        proc = sp.run(
            [str(runner), "--data", str(data_dir), "--load", str(js_path),
             "--key", key, "--comic-id", str(comic_id), "--ep-id", str(ep_id),
             "--count", str(count)] + (["--allow-local"] if allow_local else []),
            capture_output=True, text=True, timeout=timeout,
        )
    except sp.TimeoutExpired:
        return {"ok": False, "error": f"runner timeout after {timeout}s", "error_code": "NETWORK_TIMEOUT"}
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return {"ok": False, "error": f"runner 输出异常: {proc.stdout[:100]!r} {proc.stderr[:120]!r}",
                "error_code": "RUNNER_PROTOCOL_ERROR"}
    if not payload.get("ok"):
        payload.setdefault("error_code", "RUNNER_FAILED")
        return payload
    return payload


@dataclass
class RunnerContext:
    binary: Path | None = None
    data_dir: Path | None = None
    strict: bool = True


def run_source(rt: VeneraRuntime, js_path: Path, cfg: SourceTestConfig,
               vsa_cfg: VsaConfig, index_meta: dict | None,
               runner: RunnerContext | None = None) -> SourceResult:
    """对单个源执行完整验收链路。P0-2: 先执行全部可执行阶段并保留事实, 末端归因。"""
    runner = runner or RunnerContext()
    res = SourceResult(
        key=cfg.key,
        file_name=js_path.name,
        name=js_field(js_path, "name") or "",
        version=js_field(js_path, "version") or "",
        js_sha256=VeneraRuntime.js_sha256(js_path),
    )
    base_url = ""
    m = re.search(r'baseUrl\s*=\s*"([^"]+)"', js_path.read_text(encoding="utf-8", errors="replace"))
    if m:
        base_url = m.group(1).rstrip("/")
    patterns = cfg.blocked_patterns

    def finish_failed(stage: str, r, extra: str = ""):
        challenge = {}
        if stage in ("search",) and _is_js_error(r.stderr or "") and base_url:
            challenge = probe_site_challenge(base_url + "/")
            res.evidence["challenge_probe"] = challenge
        state, code, evidence = classify_failure(stage, r.stderr or "", patterns, challenge)
        detail = (r.err_brief + extra)[:200]
        res.add(stage, state, detail, r.elapsed_ms, error_code=code, evidence=evidence)
        res.state = state
        res.error_code = code
        res.evidence.update(evidence)
        return res

    # ---- load ----
    r = rt.load_source(js_path)
    if not r.ok:
        res.add("load", STATE_FAIL, r.err_brief, r.elapsed_ms,
                error_code="SOURCE_LOAD_ERROR", evidence={"evidence_type": "js_error"})
        res.state = STATE_FAIL
        res.error_code = "SOURCE_LOAD_ERROR"
        return res
    res.add("load", STATE_PASS, "加载成功", r.elapsed_ms)

    # ---- metadata 与 index.json 对齐 ----
    meta = rt.parse_loaded(r)
    if not meta:
        res.add("metadata", STATE_FAIL, "无法从加载输出解析 key/name/version",
                error_code="SOURCE_METADATA_MISMATCH")
        res.state = STATE_FAIL
        res.error_code = "SOURCE_METADATA_MISMATCH"
        return res
    problems = []
    if index_meta:
        if meta["key"] != index_meta.get("key"):
            problems.append(f"key 不一致: JS={meta['key']} index={index_meta.get('key')}")
        if meta["version"] != str(index_meta.get("version")):
            problems.append(f"version 不一致: JS={meta['version']} index={index_meta.get('version')}")
    if problems:
        res.add("metadata", STATE_FAIL, "; ".join(problems),
                error_code="SOURCE_METADATA_MISMATCH", evidence={"evidence_type": "index_mismatch"})
        res.state = STATE_FAIL
        res.error_code = "SOURCE_METADATA_MISMATCH"
        return res
    res.add("metadata", STATE_PASS, f"{meta['key']} v{meta['version']} 与索引一致")
    res.verification_level = LEVEL_METADATA

    # ---- search(或 explore 入口) ----
    if cfg.entry == "explore":
        r = rt.explore(cfg.key, cfg.explore_index, vsa_cfg.timeout_stage)
        stage = "search"
        label = f"explore[{cfg.explore_index}]"
    else:
        r = rt.search(cfg.key, cfg.keyword, cfg.max_page, vsa_cfg.timeout_stage)
        stage = "search"
        label = f"search '{cfg.keyword}'"
    if not r.ok:
        return finish_failed(stage, r, f" [{label}]")
    payload = r.json
    comics = (payload or {}).get("data") or []
    # 兼容 multiPartPage explore 结构: data = [{title, comics: [...]}, ...]
    if comics and isinstance(comics[0], dict) and "comics" in comics[0]:
        flat = []
        for section in comics:
            flat.extend(section.get("comics") or [])
        comics = flat
    if not isinstance(comics, list) or not comics:
        return finish_failed(stage, r, f" [{label} 无结果或结构异常]")
    idx = min(cfg.result_index, len(comics) - 1)
    target = comics[idx]
    comic_id = str(target.get("id", ""))
    if not comic_id:
        res.add(stage, STATE_FAIL, f"{label} 结果第 {idx} 条缺 id", r.elapsed_ms,
                error_code="SOURCE_SEARCH_PARSE_ERROR", evidence={"evidence_type": "js_error"})
        res.state = STATE_FAIL
        res.error_code = "SOURCE_SEARCH_PARSE_ERROR"
        return res
    res.add(stage, STATE_PASS,
            f"{label} {len(comics)} 条结果, 取[{idx}] {str(target.get('title', ''))[:40]} (id={comic_id[:40]})",
            r.elapsed_ms)
    res.verification_level = LEVEL_SOURCE_CHAIN

    # 条目候选(条目方差时 info 空章节可换下一条目重试)
    alt_candidates = []
    for j, item in enumerate(comics):
        if j == idx:
            continue
        cid2 = str(item.get("id", ""))
        if cid2 and cid2 != comic_id:
            alt_candidates.append((cid2, str(item.get("title", ""))[:30]))
    alt_candidates = alt_candidates[:2]

    # ---- info(空章节自动换条目重试) ----
    info_attempts = [(comic_id, str(target.get("title", ""))[:30])] + alt_candidates
    r = None
    payload = None
    data = None
    chapters = None
    info_detail_parts = []
    for cand_id, cand_title in info_attempts:
        r = rt.info(cfg.key, cand_id, vsa_cfg.timeout_stage)
        if not r.ok:
            info_detail_parts.append(f"{cand_title}: {r.err_brief[:50]}")
            continue
        payload = r.json
        data = (payload or {}).get("data") or {}
        chapters = data.get("chapters") or {}
        if isinstance(chapters, dict) and chapters:
            comic_id = cand_id
            break
        info_detail_parts.append(f"{cand_title}: 章节为空")
        chapters = None
    if r is None or chapters is None or not isinstance(chapters, dict) or not chapters:
        state, code, evidence = classify_failure("info", (r.stderr if r else "") or "章节数据缺失", patterns)
        detail = "; ".join(info_detail_parts) or f"章节数据缺失: {str(payload)[:100]}"
        res.add("info", state, detail, r.elapsed_ms if r else 0, error_code=code, evidence=evidence)
        res.state = state
        res.error_code = code
        res.evidence.update(evidence)
        return res

    # 章节模型兼容: 平铺 {epId: 名} 与分组 {组名: {epId: 名}} 两种 Venera 形态
    def _iter_candidates(chs, pref):
        nested = any(isinstance(v, dict) for v in chs.values())
        if nested:
            for group, eps in chs.items():
                if not isinstance(eps, dict):
                    continue
                items = list(eps.items())
                if not items:
                    continue
                k, name = items[-1] if pref == "last" else items[0]
                yield k, f"{group}/{name}"
        else:
            items = list(chs.items())
            if items:
                k, name = items[-1] if pref == "last" else items[0]
                yield k, str(name)

    candidates = []
    seen_ids = set()
    total_eps = 0
    for k, lab in _iter_candidates(chapters, cfg.ep):
        total_eps += 1
        if k not in seen_ids and len(candidates) < 3:
            seen_ids.add(k)
            candidates.append((k, lab))
    if not candidates:
        res.add("info", STATE_FAIL, f"章节候选为空: {str(payload)[:100]}",
                r.elapsed_ms, error_code="SOURCE_INFO_ERROR")
        res.state = STATE_FAIL
        res.error_code = "SOURCE_INFO_ERROR"
        return res
    res.add("info", STATE_PASS,
            f"《{str(data.get('title', ''))[:40]}》 {total_eps} 章, 取 {str(candidates[0][1])[:30]}",
            r.elapsed_ms)

    # ---- pages(候选章节依次回退, 最多 3 个) ----
    r = None
    images = []
    attempts = []
    used_ep_id = None
    for cand_id, cand_label in candidates:
        r = rt.pages(cfg.key, comic_id, str(cand_id), vsa_cfg.timeout_stage)
        if r.ok:
            payload = r.json
            imgs = (payload or {}).get("data") or []
            images = [u for u in imgs if isinstance(u, str) and u.startswith("http")]
            if images:
                used_ep_id = cand_id
                break
            attempts.append(f"{cand_label}: 空图片列表")
        else:
            attempts.append(f"{cand_label}: {r.err_brief[:60]}")
    if not r or not images:
        state, code, evidence = classify_failure("pages", (r.stderr if r else "") or "; ".join(attempts), patterns)
        detail = "; ".join(attempts) or "pages 未执行"
        res.add("pages", state, detail, r.elapsed_ms if r else 0, error_code=code, evidence=evidence)
        res.state = state
        res.error_code = code
        res.evidence.update(evidence)
        return res
    suffix = f" (候选回退: {attempts})" if attempts else ""
    res.add("pages", STATE_PASS, f"{len(images)} 张图 (首图 {_sanitize_url(images[0])}){suffix}", r.elapsed_ms)

    # ---- image 字节抽样 ----
    # 严格模式: 必须经 Dart runner(runtime_image_bytes+); runner 缺失/协议异常 → ERROR 不降级。
    # limited 模式(--allow-degraded): runner 不可用时回退静态头诊断(image_header), 不得宣传为完整验收。
    allow_local = getattr(vsa_cfg, "allow_local", False)
    requested = max(1, cfg.image_count)
    runner_ok = runner.binary is not None and runner.binary.exists()
    if not runner_ok and runner.strict:
        res.add("image", STATE_ERROR,
                f"严格模式下 Runner 缺失: {runner.binary}",
                error_code="RUNNER_MISSING",
                evidence={"evidence_type": "runner"})
        res.state = STATE_ERROR
        res.error_code = "RUNNER_MISSING"
        return res

    runner_payload = None
    if runner_ok:
        runner_payload = verify_images_via_runner(
            runner.binary, js_path, cfg.key, comic_id, str(used_ep_id),
            runner.data_dir or Path("/tmp/vsa_data"), requested, vsa_cfg.timeout_image + 60,
            allow_local=allow_local)
        if runner_payload.get("error_code") in ("RUNNER_PROTOCOL_ERROR", "RUNNER_EXCEPTION", "NETWORK_TIMEOUT"):
            if runner.strict:
                res.add("image", STATE_ERROR,
                        f"Runner 协议/执行异常: {runner_payload.get('error', '')[:120]}",
                        error_code=runner_payload.get("error_code", "RUNNER_PROTOCOL_ERROR"),
                        evidence={"evidence_type": "runner"})
                res.state = STATE_ERROR
                res.error_code = runner_payload.get("error_code", "RUNNER_PROTOCOL_ERROR")
                return res
            runner_payload = None  # limited: 降级静态诊断

    if runner_payload is not None:
        counts = {
            "images_requested": requested,
            "images_available": runner_payload.get("available_image_count", 0),
            "images_attempted": runner_payload.get("attempted_image_count", 0),
            "images_verified": runner_payload.get("verified_image_count", 0),
        }
        if not runner_payload.get("ok"):
            err_code = runner_payload.get("error_code") or "IMAGE_HTTP_ERROR"
            first_bad = next((s for s in runner_payload.get("samples", []) if not s.get("verified")), {})
            detail = (f"样本{first_bad.get('index', 0) + 1}: HTTP {first_bad.get('status')} "
                      f"{first_bad.get('magic')} {first_bad.get('error', runner_payload.get('error', ''))}")
            res.add("image", STATE_FAIL, detail[:200], error_code=err_code,
                    evidence={"evidence_type": "image", "counts": counts})
            res.state = STATE_FAIL
            res.error_code = err_code
            res.evidence.update({"counts": counts})
            return res
        if counts["images_verified"] < counts["images_attempted"]:
            res.add("image", STATE_FAIL,
                    f"样本验证不完整: {counts}", error_code="IMAGE_COUNT_MISMATCH",
                    evidence={"evidence_type": "image", "counts": counts})
            res.state = STATE_FAIL
            res.error_code = "IMAGE_COUNT_MISMATCH"
            return res
        first = (runner_payload.get("samples") or [{}])[0]
        decoded = first.get("decoded") is True
        level = LEVEL_RUNTIME_DECODED if decoded else LEVEL_RUNTIME_BYTES
        note = ""
        if counts["images_available"] < counts["images_requested"]:
            note = f"; 样本不足(可用 {counts['images_available']} < 请求 {counts['images_requested']})"
        res.add("image", STATE_PASS,
                f"{counts['images_verified']}/{counts['images_requested']} 张验证通过 "
                f"(解码 {counts.get('decoded_image_count', 0)}, "
                f"动态头: {','.join(first.get('headers_used', []))[:50]}){note}",
                error_code="", evidence={"evidence_type": "image", "counts": counts})
        res.state = STATE_PASS
        res.verification_level = level
        if res.state == STATE_PASS:
            res.detail = "端到端通过(运行时动态头 + 真实图片字节)"
        return res

    # limited 模式静态诊断(弱验证)
    img_details = []
    for i, url in enumerate(images[: requested]):
        code, head, err = _download_head(url, cfg.image_headers, vsa_cfg.timeout_image,
                                         allow_local=allow_local)
        kind = identify_image(head)
        ok = code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF")
        img_details.append(f"图{i + 1}: HTTP {code} {kind}" + (f" ({err})" if err else ""))
        if not ok:
            res.add("image", STATE_FAIL, "; ".join(img_details),
                    error_code="IMAGE_HTTP_ERROR", evidence={"evidence_type": "image_header"})
            res.state = STATE_FAIL
            res.error_code = "IMAGE_HTTP_ERROR"
            return res
        time.sleep(0.5)
    res.add("image", STATE_PASS, "; ".join(img_details) + " [静态头诊断, 非完整验收]",
            error_code="", evidence={"evidence_type": "image_header"})
    res.state = STATE_PASS
    res.verification_level = LEVEL_IMAGE_HEADER
    res.detail = "端到端通过(静态头弱验证, limited 模式)"
    return res
