"""VSA 验收链路: 加载→搜索→详情→章节→图片字节, 六态分类。

状态: PASS / FAIL / BLOCKED / SKIP / UNVERIFIED / ERROR
  - PASS       实际执行且所有阶段满足验收条件(含真实图片字节)
  - FAIL       已执行但某阶段失败
  - BLOCKED    外部条件(登录/风控/区域/UA 差异)导致无法验证; 仅显式声明或声明式模式命中
  - SKIP       配置明确跳过(未配置的源)
  - UNVERIFIED 未执行或证据不足
  - ERROR      框架/运行时自身异常(不得记 PASS)
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
import ssl
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

STAGE_ORDER = ["load", "metadata", "search", "info", "pages", "image"]

MAGIC_CHECKS = [
    (b"\xff\xd8\xff", "JPEG"),
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"RIFF", "WebP"),  # 配合 [8:12]==WEBP
    (b"GIF8", "GIF"),
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
    if head[:4] in (b"\x00\x00\x00\x1c", b"\x00\x00\x00\x20", b"\x00\x00\x00\x18", b"\x00\x00\x00\x20"):
        return "AVIF"
    # ISOBMFF ftyp box: [size(4)][ftyp(4)] — AVIF/HEIF 容器
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "AVIF"
    if b"<html" in head[:200].lower() or b"<!doctype" in head[:200].lower():
        return "HTML(非图片)"
    return f"未知({head[:8].hex()})"


@dataclass
class Stage:
    name: str
    state: str
    detail: str = ""
    elapsed_ms: int = 0


@dataclass
class SourceResult:
    key: str
    file_name: str
    name: str = ""
    version: str = ""
    js_sha256: str = ""
    state: str = STATE_UNVERIFIED
    stages: list = field(default_factory=list)
    error_class: str = ""
    detail: str = ""

    def add(self, stage: str, state: str, detail: str = "", elapsed_ms: int = 0):
        self.stages.append(Stage(stage, state, detail, elapsed_ms))


def _sanitize_url(url: str, limit: int = 100) -> str:
    """报告中的图片 URL 去除签名 query, 防止泄漏签名/令牌。"""
    u = url.split("?")[0]
    return u[:limit]


def verify_images_via_runner(runner: Path, js_path: Path, key: str, comic_id: str, ep_id: str,
                             data_dir: Path, count: int, timeout: int) -> dict:
    """通过薄 Dart runner 在运行时内取图: 调源自身 loadEp + onImageLoad 动态头后实抓字节。"""
    import subprocess as sp
    try:
        proc = sp.run(
            [str(runner), "--data", str(data_dir), "--load", str(js_path),
             "--key", key, "--comic-id", str(comic_id), "--ep-id", str(ep_id)],
            capture_output=True, text=True, timeout=timeout,
        )
    except sp.TimeoutExpired:
        return {"ok": False, "error": f"runner timeout after {timeout}s"}
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return {"ok": False, "error": f"runner 输出异常: {proc.stdout[:100]!r} {proc.stderr[:120]!r}"}
    if not payload.get("ok"):
        return {"ok": False, "error": payload.get("error", "runner failed")}
    return payload


def _download_head(url: str, headers: dict, timeout: int) -> tuple[int, bytes, str]:
    """下载图片头部字节并识别格式。中文路径自动百分号编码。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req_headers = {"User-Agent": RUNTIME_UA}
    req_headers.update(headers or {})
    # 路径含非 ASCII 时编码(保留结构字符)
    safe = ":/%?#=&;@,+$~'!()*[]'"
    request_url = urllib.parse.quote(url, safe=safe) if any(ord(c) > 127 for c in url) else url
    req = urllib.request.Request(request_url, headers=req_headers)
    try:
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


def run_source(rt: VeneraRuntime, js_path: Path, cfg: SourceTestConfig,
               vsa_cfg: VsaConfig, index_meta: dict | None,
               runner_binary: Path | None = None, data_dir: Path | None = None) -> SourceResult:
    """对单个源执行完整验收链路。任何阶段失败立即定态返回。"""
    res = SourceResult(
        key=cfg.key,
        file_name=js_path.name,
        name=js_field(js_path, "name") or "",
        version=js_field(js_path, "version") or "",
        js_sha256=VeneraRuntime.js_sha256(js_path),
    )

    # 显式声明受限的源: 执行 load+search 两个确定性阶段后按声明返回 BLOCKED
    if cfg.expect == "blocked":
        r = rt.load_source(js_path)
        if not r.ok:
            res.add("load", STATE_FAIL, r.err_brief, r.elapsed_ms)
            res.state = STATE_FAIL
            return res
        res.add("load", STATE_PASS, "加载成功", r.elapsed_ms)
        r2 = rt.search(cfg.key, cfg.keyword, cfg.max_page, vsa_cfg.timeout_stage)
        if r2.ok:
            res.add("search", STATE_PASS, "搜索可执行(受限声明下不继续深入)", r2.elapsed_ms)
        else:
            res.add("search", STATE_BLOCKED, r2.err_brief or "搜索失败", r2.elapsed_ms)
        res.state = STATE_BLOCKED
        res.detail = cfg.blocked_reason
        return res

    # ---- load ----
    r = rt.load_source(js_path)
    if not r.ok:
        res.add("load", STATE_FAIL, r.err_brief, r.elapsed_ms)
        res.state = STATE_FAIL
        return res
    res.add("load", STATE_PASS, "加载成功", r.elapsed_ms)

    # ---- metadata 与 index.json 对齐 ----
    meta = rt.parse_loaded(r)
    if not meta:
        res.add("metadata", STATE_FAIL, "无法从加载输出解析 key/name/version")
        res.state = STATE_FAIL
        return res
    problems = []
    if index_meta:
        if meta["key"] != index_meta.get("key"):
            problems.append(f"key 不一致: JS={meta['key']} index={index_meta.get('key')}")
        if meta["version"] != str(index_meta.get("version")):
            problems.append(f"version 不一致: JS={meta['version']} index={index_meta.get('version')}")
    if problems:
        res.add("metadata", STATE_FAIL, "; ".join(problems))
        res.state = STATE_FAIL
        return res
    res.add("metadata", STATE_PASS, f"{meta['key']} v{meta['version']} 与索引一致")

    # ---- search(或 explore 入口: 搜索接口失效/无搜索的源) ----
    if cfg.entry == "explore":
        r = rt.explore(cfg.key, cfg.explore_index, vsa_cfg.timeout_stage)
        stage = "search"  # 链路语义相同: 列表入口产出漫画条目
        label = f"explore[{cfg.explore_index}]"
    else:
        r = rt.search(cfg.key, cfg.keyword, cfg.max_page, vsa_cfg.timeout_stage)
        stage = "search"
        label = f"search '{cfg.keyword}'"
    if not r.ok:
        state = STATE_FAIL
        detail = r.err_brief
        for pat in cfg.blocked_patterns:
            if pat.lower() in r.stderr.lower():
                state = STATE_BLOCKED
                detail = f"命中声明式受限模式 '{pat}': {detail}"
                break
        res.add(stage, state, f"{label}: {detail}", r.elapsed_ms)
        res.state = state
        return res
    payload = r.json
    comics = (payload or {}).get("data") or []
    # 兼容 multiPartPage explore 结构: data = [{title, comics: [...]}, ...]
    if comics and isinstance(comics[0], dict) and "comics" in comics[0]:
        flat = []
        for section in comics:
            flat.extend(section.get("comics") or [])
        comics = flat
    if not isinstance(comics, list) or not comics:
        res.add(stage, STATE_FAIL, f"{label} 无结果或结构异常: {str(payload)[:120]}", r.elapsed_ms)
        res.state = STATE_FAIL
        return res
    idx = min(cfg.result_index, len(comics) - 1)
    target = comics[idx]
    comic_id = str(target.get("id", ""))
    if not comic_id:
        res.add(stage, STATE_FAIL, f"结果第 {idx} 条缺 id", r.elapsed_ms)
        res.state = STATE_FAIL
        return res
    res.add(stage, STATE_PASS,
            f"{label} {len(comics)} 条结果, 取[{idx}] {str(target.get('title', ''))[:40]} (id={comic_id[:40]})",
            r.elapsed_ms)

    # 记录候选条目(条目方差时 info 空章节可换下一条目重试)
    alt_candidates = []
    for j, item in enumerate(comics):
        if j == idx:
            continue
        cid2 = str(item.get("id", ""))
        if cid2 and cid2 != comic_id:
            alt_candidates.append((cid2, str(item.get("title", ""))[:30]))
    alt_candidates = alt_candidates[:2]

    # ---- info ----
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
        state = STATE_FAIL
        detail = "; ".join(info_detail_parts) or f"章节数据缺失: {str(payload)[:100]}"
        if r is not None:
            for pat in cfg.blocked_patterns:
                if pat.lower() in r.stderr.lower():
                    state = STATE_BLOCKED
                    detail = f"命中声明式受限模式 '{pat}': {detail}"
                    break
        res.add("info", state, detail, r.elapsed_ms if r else 0)
        res.state = state
        return res
    payload = r.json
    data = (payload or {}).get("data") or {}
    chapters = data.get("chapters") or {}
    if not isinstance(chapters, dict) or not chapters:
        res.add("info", STATE_FAIL, f"章节数据缺失或为空: {str(payload)[:120]}", r.elapsed_ms)
        res.state = STATE_FAIL
        return res
    # 章节模型兼容: 平铺 {epId: 名} 与分组 {组名: {epId: 名}} 两种 Venera 形态
    def _iter_candidates(chs, pref):
        """产出 (ep_id, 标签) 候选序列。"""
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
    first_label = ""
    for k, label in _iter_candidates(chapters, cfg.ep):
        total_eps += 1
        if not first_label:
            first_label = label
        if k not in seen_ids and len(candidates) < 3:
            seen_ids.add(k)
            candidates.append((k, label))
    if not candidates:
        res.add("info", STATE_FAIL, f"章节数据缺失或为空: {str(payload)[:120]}", r.elapsed_ms)
        res.state = STATE_FAIL
        return res
    res.add("info", STATE_PASS,
            f"《{str(data.get('title', ''))[:40]}》 {total_eps} 章, 取 {str(candidates[0][1])[:30]}",
            r.elapsed_ms)

    # ---- pages ----
    # 候选章节依次回退(分卷/单行本/特殊 id 场景), 最多尝试 3 个
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
        state = STATE_FAIL
        detail = "; ".join(attempts) or "pages 未执行"
        if r is not None:
            for pat in cfg.blocked_patterns:
                if pat.lower() in r.stderr.lower():
                    state = STATE_BLOCKED
                    detail = f"命中声明式受限模式 '{pat}': {detail}"
                    break
        res.add("pages", state, detail, r.elapsed_ms if r else 0)
        res.state = state
        return res
    suffix = f" (候选回退: {attempts})" if attempts else ""
    res.add("pages", STATE_PASS, f"{len(images)} 张图 (首图 {_sanitize_url(images[0])}){suffix}", r.elapsed_ms)

    # ---- image 字节抽样 ----
    # 优先薄 Dart runner(运行时内 onImageLoad 动态头); 不可用则回退静态头下载
    img_state = STATE_PASS
    img_details = []
    runner_payload = None
    if runner_binary is not None and runner_binary.exists():
        runner_payload = verify_images_via_runner(
            runner_binary, js_path, cfg.key, comic_id, str(used_ep_id),
            data_dir or (Path("/tmp") / "vsa_data"), 1, vsa_cfg.timeout_image + 60)
        if runner_payload.get("ok") and runner_payload.get("verify", {}).get("status") == 200:
            v = runner_payload["verify"]
            magic = v.get("magic", "")
            if "HTML" in magic or magic.startswith("未知"):
                img_details.append(f"图1: HTTP 200 {magic} ({v.get('size')}B)")
                img_state = STATE_FAIL
            else:
                img_details.append(f"图1: HTTP 200 {magic} ({v.get('size')}B, onImageLoad 动态头: {','.join(v.get('headers_used', []))[:60]})")
        elif runner_payload.get("ok"):
            v = runner_payload["verify"]
            img_details.append(f"图1: HTTP {v.get('status')} {v.get('magic')}")
            img_state = STATE_FAIL
        else:
            # runner 失败(含 loadEp 阶段) → 记录并回退静态头
            img_details.append(f"runner: {runner_payload.get('error', '')[:80]}")
            img_state = STATE_FAIL

    if img_state == STATE_PASS and not img_details:
        for i, url in enumerate(images[: cfg.image_count]):
            code, head, err = _download_head(url, cfg.image_headers, vsa_cfg.timeout_image)
            kind = identify_image(head)
            ok = code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF")
            img_details.append(f"图{i + 1}: HTTP {code} {kind}" + (f" ({err})" if err else ""))
            if not ok:
                img_state = STATE_FAIL
                break
            time.sleep(0.5)
    res.add("image", img_state, "; ".join(img_details))
    res.state = STATE_PASS if img_state == STATE_PASS else STATE_FAIL
    if res.state == STATE_PASS:
        res.detail = f"端到端通过: 真实 {img_details[-1].split()[-1] if img_details else ''} 图片字节"
    return res
