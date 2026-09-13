#!/usr/bin/env python3
"""
VeneraX E2E (Content-Level) Health Check — 端到端内容级探针（新一代，试用版）

与 scripts/hybrid_health_check.py（现行 CI 探针）的核心区别：
  现行探针只验证「服务器有响应」（读 512 字节 + 403/429/210 也算成功），
  本脚本验证「真的能读到漫画」：搜索 → 详情 → 章节列表 → 图片 URL → 下载图片字节 → 校验 magic bytes。

判定等级（诚实分类，403/429/210/配额耗尽一律不给绿灯）：
  OK_CONTENT      🟢 端到端正常 —— 真实下载到图片字节并校验通过（content 级）
  OK_DATA         🟢 数据接口正常 —— 业务接口返回可解析数据（data 级）
  OK_CONN         🟢 可连通 —— 仅状态码连通性验证（conn 级）
  RISK_CONTROL    🟠 风控/限频 —— 210 限频、每日图片配额耗尽等（服务活着但读不了内容）
  LOGIN_REQUIRED  🟡 需登录 —— 接口正常但内容需要账号
  BLOCKED         🔴 被拦截 —— 403/429 等（现行探针会把这些亮绿灯，本脚本修复）
  DOWN            ❌ 无法直连
  ERROR           ⚠️ 探测异常（结构变化、解析失败等，需要维护者关注）

大陆一列复用 hybrid 的双引擎（SSH 私有探针 → Globalping 故障转移），本脚本不重复实现。

输出（默认写入 work/e2e_run/，绝不修改真实 README.md）：
  results.json                 全量探测明细
  README_section_preview.md    若采纳本方案，README 将被替换成的新区块预览（含起止标记）
  step_summary.md              等同 GITHUB_STEP_SUMMARY 的内容
  has_alert.txt / health_check_alert.md  告警产物（与现有 workflow 告警步骤对接）

正式接入 GitHub Actions 时：把 workflow 里 `python scripts/hybrid_health_check.py`
换成 `python scripts/e2e_health_check.py`，并让 update_readme 真写 README（当前注释保留）。
"""

import json
import os
import re
import struct
import sys
import time
import base64
import hashlib
import hmac as hmac_mod
import importlib.util
import random
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.environ.get('E2E_OUT_DIR') or os.path.join(ROOT, 'work', 'e2e_run')

UA_BROWSER = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

# 载入现行 hybrid 探针模块：复用其 PROBES 配置、pica 签名、双时间、Globalping 大陆引擎
_spec = importlib.util.spec_from_file_location("hhc", os.path.join(ROOT, 'scripts', 'hybrid_health_check.py'))
hhc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hhc)

# ---------------------------------------------------------------- 基础工具

def http_req(url, headers=None, data=None, method="GET", timeout=12, max_bytes=12 * 1024 * 1024):
    """返回 (status, body_bytes, elapsed_ms)；网络异常时 status='ERR'。"""
    h = {"User-Agent": UA_BROWSER}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(max_bytes)
            return resp.status, body, int((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(4096)
        except Exception:
            body = b""
        return e.code, body, int((time.time() - t0) * 1000)
    except Exception as e:
        return "ERR", str(e).encode(), int((time.time() - t0) * 1000)


def img_magic(body):
    """识别图片 magic bytes（含 AVIF/HEIC 容器）。"""
    if len(body) < 12:
        return None
    if body[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if body[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "WebP"
    if body[:4] == b"GIF8":
        return "GIF"
    if body[4:8] == b"ftyp" and body[8:12] in (b"avif", b"avis", b"mif1", b"heic"):
        return "AVIF"
    if body[:2] == b"\x1f\x8b":
        return "GZIP(非图片)"
    head = body[:300].lower()
    if b"<html" in head or b"<!doctype" in head:
        return "HTML(非图片)"
    return None


def json_body(body):
    try:
        return json.loads(body.decode("utf-8", "ignore"))
    except Exception:
        return None


def result(verdict, tier, latency=-1, code=None, detail="", steps=None):
    return {"verdict": verdict, "tier": tier, "latency_ms": latency, "code": code,
            "detail": detail, "steps": steps or []}


def get_dual_time_str(include_seconds=False):
    return hhc.get_dual_time_str(include_seconds)

# ---------------------------------------------------------------- 判定徽章（修复版）

VERDICT_BADGE = {
    'OK_CONTENT':     '🟢 **端到端正常**',
    'OK_DATA':        '🟢 **数据接口正常**',
    'OK_CONN':        '🟢 **可连通**',
    'RISK_CONTROL':   '🟠 **风控/限频**',
    'LOGIN_REQUIRED': '🟡 **需登录**',
    'BLOCKED':        '🔴 **被拦截**',
    'DOWN':           '❌ **无法直连**',
    'ERROR':          '⚠️ **探测异常**',
    'NOT_IMPLEMENTED':'⚪ **内容级待接入**',
}


def mainland_badge(latency_ms, code):
    """现行 format_badge 的修复版：403/429/210 不再给绿灯。"""
    if code in ['ERR', None] or latency_ms < 0:
        return '❌ **无法直连** (阻断)'
    if code in (401,):
        return f'🟡 **需登录** (`~{latency_ms}ms`)'
    if code in (403, 429, 210):
        return f'🔴 **被拦截/限频** (`HTTP {code}`)'
    if latency_ms < 500:
        return f'🟢 **秒开** (`~{latency_ms}ms`)'
    if latency_ms <= 1500:
        return f'🟢 **良好** (`~{latency_ms}ms`)'
    if latency_ms <= 3500:
        return f'🟡 **偏慢** (`~{latency_ms}ms`)'
    return f'🟡 **高延迟** (`~{latency_ms}ms`)'

# ---------------------------------------------------------------- 内容级 E2E 探针

COPY_ENDPOINTS = [
    'https://api.copy2000.online',
    'https://api.copy-manga.com',
    'https://api.mangacopy.com',
    'https://api.copy202601.com',
]


def load_copy_device_identity(out_dir):
    """拷贝漫画稳定设备身份：随首次运行生成并固定复用。
    之前实测教训：每次随机设备 ID 高频探测会触发 210 风控，固定身份 + 低频探测才能长期稳定。"""
    path = os.path.join(out_dir, 'copy_device.json')
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    alnum = letters + "0123456789" + letters.lower()
    ident = {
        "device": (''.join(random.choice(letters + "0123456789") for _ in range(3)) + "." +
                   ''.join(random.choice("0123456789") for _ in range(6)) + "." +
                   ''.join(random.choice("0123456789") for _ in range(3))),
        "pseudoid": ''.join(random.choice(alnum) for _ in range(16)),
        "deviceinfo": f"{random.randint(1000000, 9999999)}V-{random.randint(1000, 9999)}",
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(ident, f)
    return ident


def full_copy_headers(ident):
    now = datetime.now()
    dt = f"{now.year}.{now.month:02d}.{now.day:02d}"
    ts = str(int(now.timestamp()))
    secret = base64.b64decode("M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM=")
    sig = hmac_mod.new(secret, ts.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "User-Agent": "COPY/3.0.9", "source": "copyApp", "deviceinfo": ident["deviceinfo"],
        "dt": dt, "platform": "3", "referer": "com.copymanga.app-3.0.9", "version": "3.0.9",
        "device": ident["device"], "pseudoid": ident["pseudoid"],
        "Accept": "application/json", "region": "0", "authorization": "Token",
        "umstring": "b4c89ca4104ea9a97750314d791520ac",
        "x-auth-timestamp": ts, "x-auth-signature": sig,
    }


def copy_image_headers():
    now = datetime.now()
    return {"User-Agent": "COPY/3.0.9", "referer": "com.copymanga.app-3.0.9",
            "dt": f"{now.year}.{now.month:02d}.{now.day:02d}"}


def e2e_copy_manga(out_dir):
    """拷贝漫画：列表 → 详情(分组) → 章节 → 章节图片 → 下载图片字节。"""
    steps, headers = [], full_copy_headers(load_copy_device_identity(out_dir))

    base, list_data, got_210 = None, None, False
    for ep in COPY_ENDPOINTS:
        code, body, ms = http_req(f"{ep}/api/v3/comics?limit=1", headers=headers, timeout=10)
        steps.append(f"列表 {ep} → HTTP {code} ({ms}ms)")
        if code == 200 and json_body(body):
            base, list_data = ep, json_body(body)
            break
        if code == 210:
            got_210 = True
            steps.append(f"  210 风控: {body[:100]}")
    if not base:
        return result('RISK_CONTROL' if got_210 else 'DOWN', 'content',
                      detail='全部 API 端点风控/不可达', steps=steps)

    try:
        path_word = list_data["results"]["list"][0]["path_word"]
    except Exception:
        return result('ERROR', 'content', detail=f"列表结构异常: {str(list_data)[:150]}", steps=steps)
    steps.append(f"path_word = {path_word}")

    t0 = time.time()
    code, body, ms = http_req(f"{base}/api/v3/comic2/{path_word}?in_mainland=false&platform=3",
                              headers=headers, timeout=10)
    steps.append(f"详情 → HTTP {code} ({ms}ms)")
    if code == 210:
        msg = (json_body(body) or {}).get('message', '')
        return result('RISK_CONTROL', 'content', code=210,
                      detail=f"列表正常但详情接口被风控拦截: {msg}", steps=steps)
    # 分组字典在 results 顶层 (results.groups), 与 copy_manga.js 的 data.groups 一致
    group_path, group_count = "default", None
    if code == 200:
        d = json_body(body)
        try:
            groups = (d.get("results") or {}).get("groups") or {}
            if groups:
                first = list(groups.values())[0]
                group_path = first["path_word"]
                group_count = first.get("count")
        except Exception:
            pass
    steps.append(f"分组 = {group_path}" + (f" (应含 {group_count} 话)" if group_count else ""))

    code, body, ms = http_req(
        f"{base}/api/v3/comic/{path_word}/group/{group_path}/chapters?limit=100&offset=0&in_mainland=false",
        headers=headers, timeout=10)
    steps.append(f"章节列表 → HTTP {code} ({ms}ms)")
    if code == 210:
        return result('RISK_CONTROL', 'content', code=210,
                      detail="章节接口被 210 风控拦截（阅读路径不可用，而列表接口仍 200 —— 现行探针的盲区）", steps=steps)
    uuid_ = None
    if code == 200:
        d = json_body(body)
        items = []
        try:
            r = d.get("results") or {}
            items = r.get("list") or r.get("chapters") or []
            if items:
                uuid_ = items[0]["uuid"]
        except Exception:
            pass
        if not uuid_:
            # 200 但列表为空: 与 groups.count 矛盾, 是 210 软风控的另一种形态
            hint = f"分组计数 {group_count} 话" if group_count else "分组非空"
            return result('RISK_CONTROL', 'content', code=200,
                          detail=f"章节接口返回空列表 ({hint}却 total=0) —— 软风控特征，列表接口仍 200", steps=steps)
    if not uuid_:
        return result('ERROR', 'content', code=code,
                      detail=f"章节接口异常响应 (HTTP {code})", steps=steps)

    code, body, ms = http_req(f"{base}/api/v3/comic/{path_word}/chapter2/{uuid_}?in_mainland=false",
                              headers=headers, timeout=10)
    steps.append(f"章节图片接口 → HTTP {code} ({ms}ms)")
    if code == 210:
        return result('RISK_CONTROL', 'content', code=210, detail="章节图片接口 210 风控", steps=steps)
    first_url = None
    if code == 200:
        d = json_body(body)
        try:
            ch = d["results"]["chapter"]
            urls = [c["url"] for c in ch["contents"]]
            words = ch.get("words", [])
            first_url = urls[0]
            if len(words) == len(urls):
                reordered = [None] * len(urls)
                for i, w in enumerate(words):
                    reordered[w] = urls[i]
                first_url = reordered[0]
        except Exception:
            pass
    if not first_url:
        return result('ERROR', 'content', detail="拿不到图片 URL", steps=steps)
    steps.append(f"图片域名 = {first_url.split('/')[2] if '://' in first_url else '?'}")

    code, body, ms = http_req(first_url, headers=copy_image_headers(), timeout=12)
    kind = img_magic(body)
    steps.append(f"下载图片 → HTTP {code}, {len(body)} 字节 ({ms}ms), 识别 {kind or '非图片'}")
    if code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF"):
        return result('OK_CONTENT', 'content', latency=ms, code=200,
                      detail=f"端到端成功: {len(body)} 字节 {kind}", steps=steps)
    return result('ERROR', 'content', code=code,
                  detail=f"API 可达但图片链路失败 ({kind or code}) —— 现行探针看不到的盲区", steps=steps)


KOMIIC_GQL = "https://komiic.com/api/query"


def komiic_gql(op, variables, query):
    payload = json.dumps({"operationName": op, "variables": variables, "query": query}).encode("utf-8")
    return http_req(KOMIIC_GQL,
                    headers={"User-Agent": UA_BROWSER, "Referer": "https://komiic.com/",
                             "Content-Type": "application/json"},
                    data=payload, method="POST", timeout=15)


def e2e_komiic():
    """Komiic：GraphQL 热门 → 章节(取最后一章省配额) → 图片 ticket → 下载图片字节。
    注意: GraphQL ID 必须是字符串; 每日图片配额 300/IP, 耗尽时 data=null + errors。"""
    steps = []
    code, body, ms = komiic_gql("hotComics",
        {"pagination": {"limit": 1, "offset": 0, "orderBy": "DATE_UPDATED", "status": "", "asc": True}},
        "query hotComics($pagination: Pagination!) {\n  hotComics(pagination: $pagination) {\n    id\n    title\n    __typename\n  }\n}")
    steps.append(f"热门漫画 GraphQL → HTTP {code} ({ms}ms)")
    if code != 200:
        return result('DOWN' if code == 'ERR' else 'BLOCKED', 'content', code=code, steps=steps)
    d = json_body(body)
    try:
        comic = d["data"]["hotComics"][0]
        comic_id, title = str(comic["id"]), comic["title"]
    except Exception:
        return result('ERROR', 'content', detail=f"GraphQL 结构异常: {str(d)[:150]}", steps=steps)
    steps.append(f"漫画: {title} (id={comic_id})")

    code, body, ms = komiic_gql("chapterByComicId", {"comicId": comic_id},
        "query chapterByComicId($comicId: ID!) {\n  chaptersByComicId(comicId: $comicId) {\n    id\n    serial\n    type\n    __typename\n  }\n}")
    steps.append(f"章节列表 → HTTP {code} ({ms}ms)")
    chapter_id = None
    if code == 200:
        d = json_body(body)
        try:
            chapters = [c for c in d["data"]["chaptersByComicId"] if c["type"] != "book"]
            if chapters:
                chapter_id = str(chapters[-1]["id"])
        except Exception:
            pass
    if not chapter_id:
        return result('ERROR', 'content', detail="拿不到章节", steps=steps)

    code, body, ms = komiic_gql("imageTicketsByChapterId", {"chapterId": chapter_id},
        "query imageTicketsByChapterId($chapterId: ID!) {\n  imageTicketsByChapterId(chapterId: $chapterId) {\n    url\n    ticket\n    kid\n    width\n    height\n  }\n}")
    steps.append(f"图片 ticket → HTTP {code} ({ms}ms)")
    first, n_pages = None, 0
    if code == 200:
        d = json_body(body) or {}
        tickets = (d.get("data") or {}).get("imageTicketsByChapterId")
        if tickets:
            first, n_pages = tickets[0], len(tickets)
        else:
            errs = d.get("errors") or []
            if any("quota" in (e.get("message") or "").lower() for e in errs):
                return result('RISK_CONTROL', 'content', code=200,
                              detail="每日图片配额耗尽 (QUOTA_EXCEEDED) —— API 全 200 但实际无图可看", steps=steps)
    if not first:
        return result('ERROR', 'content', detail="拿不到图片 ticket", steps=steps)
    steps.append(f"本章 {n_pages} 张图, 图片域 = {first['url'].split('/')[2] if '://' in first['url'] else '?'}")

    code, body, ms = http_req(first["url"],
                              headers={"User-Agent": UA_BROWSER, "Referer": "https://komiic.com/",
                                       "X-Image-Ticket": first.get("ticket", "")},
                              timeout=15)
    kind = img_magic(body)
    steps.append(f"下载图片 → HTTP {code}, {len(body)} 字节 ({ms}ms), 识别 {kind or '非图片'}")
    if code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF"):
        return result('OK_CONTENT', 'content', latency=ms, code=200,
                      detail=f"端到端成功: {len(body)} 字节 {kind}", steps=steps)
    return result('ERROR', 'content', code=code, detail=f"图片链路失败 ({kind or code})", steps=steps)


def e2e_mangadex():
    """MangaDex：列表 → 章节-feed → at-home 图片服务器 → 下载图片字节。
    feed 不限翻译语言（探针只关心有无真实页面），依次尝试前 3 本漫画防止单本无章节。"""
    steps = []
    ua = {"User-Agent": "VeneraX-e2e-health-check/1.0"}
    code, body, ms = http_req("https://api.mangadex.org/manga?limit=3&hasAvailableChapters=true",
                              headers=ua, timeout=12)
    steps.append(f"漫画列表 → HTTP {code} ({ms}ms)")
    if code != 200:
        return result('DOWN' if code == 'ERR' else 'BLOCKED', 'content', code=code, steps=steps)
    try:
        manga_ids = [m["id"] for m in json_body(body)["data"][:3]]
    except Exception:
        return result('ERROR', 'content', detail="列表结构异常", steps=steps)

    chapter_id = None
    for manga_id in manga_ids:
        code, body, ms = http_req(
            f"https://api.mangadex.org/manga/{manga_id}/feed?limit=1&order[chapter]=desc",
            headers=ua, timeout=12)
        steps.append(f"章节列表 ({manga_id[:8]}…) → HTTP {code} ({ms}ms)")
        if code == 200:
            d = json_body(body)
            try:
                if d["data"]:
                    chapter_id = d["data"][0]["id"]
                    break
            except Exception:
                pass
    if not chapter_id:
        return result('ERROR', 'content', detail="前 3 本漫画均拿不到章节", steps=steps)

    code, body, ms = http_req(f"https://api.mangadex.org/at-home/server/{chapter_id}", headers=ua, timeout=12)
    steps.append(f"图片服务器分配 → HTTP {code} ({ms}ms)")
    if code != 200:
        return result('ERROR', 'content', code=code, steps=steps)
    try:
        d = json_body(body)
        img_url = f"{d['baseUrl']}/data/{d['chapter']['hash']}/{d['chapter']['data'][0]}"
    except Exception:
        return result('ERROR', 'content', detail="at-home 结构异常", steps=steps)

    code, body, ms = http_req(img_url, headers=ua, timeout=15)
    kind = img_magic(body)
    steps.append(f"下载图片 → HTTP {code}, {len(body)} 字节 ({ms}ms), 识别 {kind or '非图片'}")
    if code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF"):
        return result('OK_CONTENT', 'content', latency=ms, code=200,
                      detail=f"端到端成功: {len(body)} 字节 {kind}", steps=steps)
    return result('ERROR', 'content', code=code, detail=f"图片链路失败 ({kind or code})", steps=steps)


def e2e_nhentai():
    """nhentai：v2 搜索 → 画廊详情 → i3.nhentai.net 真实图片字节。
    CF 拦截(403/429)时诚实给出 BLOCKED —— 现行探针会把它亮绿灯。"""
    steps = []
    h = {"User-Agent": UA_BROWSER, "Accept": "application/json",
         "Referer": "https://nhentai.net/", "Accept-Language": "en-US,en;q=0.9"}
    code, body, ms = http_req("https://nhentai.net/api/v2/search?query=chinese&page=1&sort=date",
                              headers=h, timeout=12)
    steps.append(f"v2 搜索 → HTTP {code} ({ms}ms)")
    if code == 403 or code == 429:
        return result('BLOCKED', 'content', code=code,
                      detail=f"Cloudflare 拦截 (HTTP {code}) —— 现行探针对此亮绿灯", steps=steps)
    if code != 200:
        return result('DOWN' if code == 'ERR' else 'ERROR', 'content', code=code, steps=steps)
    d = json_body(body)
    try:
        item = d["result"][0]
        gid = item["id"]
    except Exception:
        return result('ERROR', 'content', detail=f"搜索结构异常: {str(d)[:150]}", steps=steps)

    code, body, ms = http_req(f"https://nhentai.net/api/v2/galleries/{gid}", headers=h, timeout=12)
    steps.append(f"画廊详情 → HTTP {code} ({ms}ms)")
    img_url = None
    if code == 200:
        d = json_body(body)
        try:
            pages = d.get("pages") or d.get("images", {}).get("pages")
            if pages:
                img_url = "https://i3.nhentai.net/" + pages[0]["path"].lstrip("/")
        except Exception:
            pass
    if not img_url:
        return result('ERROR', 'content', detail="拿不到图片 path", steps=steps)

    code, body, ms = http_req(img_url, headers={"User-Agent": UA_BROWSER, "Referer": "https://nhentai.net/"},
                              timeout=15)
    kind = img_magic(body)
    steps.append(f"下载图片 → HTTP {code}, {len(body)} 字节 ({ms}ms), 识别 {kind or '非图片'}")
    if code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF"):
        return result('OK_CONTENT', 'content', latency=ms, code=200,
                      detail=f"端到端成功: {len(body)} 字节 {kind}", steps=steps)
    return result('ERROR', 'content', code=code, detail=f"图片链路失败 ({kind or code})", steps=steps)


def e2e_ehentai():
    """E-Hentai：首页(带 nw=1 穿过漫游页) → 任一画廊 → gdata API → ehgt.org 缩略图字节。"""
    steps = []
    h = {"User-Agent": UA_BROWSER, "Cookie": "nw=1", "Accept-Language": "en-US,en;q=0.9"}
    code, body, ms = http_req("https://e-hentai.org/", headers=h, timeout=15)
    steps.append(f"首页 → HTTP {code} ({ms}ms)")
    if code != 200:
        return result('DOWN' if code == 'ERR' else 'BLOCKED', 'content', code=code, steps=steps)
    m = re.search(rb'href="https://e-hentai\.org/g/(\d+)/([0-9a-f]{10})/"', body)
    if not m:
        return result('ERROR', 'content', detail="首页无画廊链接（可能被 CF/漫游页拦截）", steps=steps)
    gid, token = m.group(1).decode(), m.group(2).decode()
    steps.append(f"取到画廊 gid={gid}")

    payload = json.dumps({"method": "gdata", "gidlist": [[int(gid), token]], "namespace": 1}).encode("utf-8")
    code, body, ms = http_req("https://api.e-hentai.org/api.php",
                              headers={"User-Agent": UA_BROWSER, "Content-Type": "application/json"},
                              data=payload, method="POST", timeout=15)
    steps.append(f"gdata API → HTTP {code} ({ms}ms)")
    thumb = None
    if code == 200:
        d = json_body(body)
        try:
            g = d["gmetadata"][0]
            thumb = g.get("thumb") or g.get("thumb_url")
        except Exception:
            pass
    if not thumb:
        return result('ERROR', 'content', detail="gdata 无 thumb_url", steps=steps)

    code, body, ms = http_req(thumb, headers={"User-Agent": UA_BROWSER, "Referer": "https://e-hentai.org/"},
                              timeout=15)
    kind = img_magic(body)
    steps.append(f"下载缩略图 → HTTP {code}, {len(body)} 字节 ({ms}ms), 识别 {kind or '非图片'}")
    if code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF"):
        return result('OK_CONTENT', 'content', latency=ms, code=200,
                      detail=f"端到端成功: {len(body)} 字节 {kind} (ehgt.org 图片域)", steps=steps)
    return result('ERROR', 'content', code=code, detail=f"图片链路失败 ({kind or code})", steps=steps)


def hitomi_load_gg():
    """运行时抓取 gg.js 并移植为 Python：m(g)=命中 case 表→0 否则 1; s(h)=int(h[-1]+h[-3:-1],16) 十进制; b=日期目录前缀。"""
    code, body, ms = http_req("https://ltn.gold-usergeneratedcontent.net/gg.js",
                              headers={"User-Agent": UA_BROWSER, "Referer": "https://hitomi.la/"}, timeout=12)
    if code != 200:
        return None
    text = body.decode("utf-8", "ignore")
    zero_cases = set(int(x) for x in re.findall(r"case (\d+):", text))
    mb = re.search(r"b:\s*'([^']+)'", text)
    if not mb:
        return None
    return {
        "m": lambda g: 0 if g in zero_cases else 1,
        "s": lambda h: str(int(h[-1] + h[-3:-1], 16)),
        "b": mb.group(1),
    }


def e2e_hitomi():
    """hitomi.la：index-all.nozomi（二进制画廊 id 列表, 首条为最新）→ ltn galleries/{gid}.js
    → 按 gg.js 算法拼图片 URL → 下载字节；失败时回退缩略图 URL（无需 gg.js）。"""
    steps = []
    gg = hitomi_load_gg()
    steps.append("gg.js 拉取/移植: " + ("成功 (b=%s)" % gg["b"][:24] if gg else "失败"))

    h = {"User-Agent": UA_BROWSER, "Referer": "https://hitomi.la/"}
    code, body, ms = http_req("https://ltn.gold-usergeneratedcontent.net/index-all.nozomi",
                              headers=h, timeout=20)
    steps.append(f"index-all.nozomi → HTTP {code}, {len(body)} 字节 ({ms}ms)")
    if code != 200 or len(body) < 4:
        return result('DOWN' if code == 'ERR' else 'ERROR', 'content', code=code, steps=steps)
    gid = struct.unpack('>I', body[:4])[0]

    code, body, ms = http_req(f"https://ltn.gold-usergeneratedcontent.net/galleries/{gid}.js",
                              headers=h, timeout=15)
    steps.append(f"galleries/{gid}.js → HTTP {code} ({ms}ms)")
    ghash = None
    if code == 200:
        text = body.decode("utf-8", "ignore")
        j = re.search(r"galleryinfo\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
        if j:
            try:
                info = json.loads(j.group(1))
                files = info.get("files") or []
                if files:
                    ghash = files[0].get("hash")
            except Exception:
                pass
    if not ghash:
        return result('ERROR', 'content', detail="拿不到图片 hash（ltn 域可能被拦截）", steps=steps)

    candidates = []
    if gg:
        g = int(ghash[-1] + ghash[-3:-1], 16)
        sub = "a" + str(1 + gg["m"](g))
        candidates.append(f"https://{sub}.gold-usergeneratedcontent.net/{gg['b']}{gg['s'](ghash)}/{ghash}.avif")
    candidates.append(f"https://atn.gold-usergeneratedcontent.net/avifsmalltn/{ghash[-1]}/{ghash[-3:-1]}/{ghash}.avif")

    for url in candidates:
        code, body, ms = http_req(url, headers=h, timeout=15)
        kind = img_magic(body)
        steps.append(f"下载 {url.split('/')[2]} → HTTP {code}, {len(body)} 字节 ({ms}ms), 识别 {kind or '非图片'}")
        if code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF"):
            return result('OK_CONTENT', 'content', latency=ms, code=200,
                          detail=f"端到端成功: {len(body)} 字节 {kind} (gg.js 算法拼图成功)", steps=steps)
    return result('ERROR', 'content', detail="图片 CDN 全部失败（数据域正常）", steps=steps)


def e2e_wnacg():
    """紳士漫畫：首页 → 相册 aid → 相册信息页封面图（t*.qy0.ru 域）→ 下载字节。
    实测: 正图域对非浏览器客户端一律 403, 封面域可取到真实图片字节。"""
    steps = []
    h = {"User-Agent": UA_BROWSER, "Referer": "https://www.wnacg.com/"}
    code, body, ms = http_req("https://www.wnacg.com/", headers=h, timeout=15)
    steps.append(f"首页 → HTTP {code} ({ms}ms)")
    if code != 200:
        return result('DOWN' if code == 'ERR' else 'BLOCKED', 'content', code=code, steps=steps)
    m = re.search(rb'photos-index-aid-(\d+)\.html', body)
    if not m:
        return result('ERROR', 'content', detail="首页无相册链接", steps=steps)
    aid = m.group(1).decode()

    code, body, ms = http_req(f"https://www.wnacg.com/photos-index-page-1-aid-{aid}.html",
                              headers=h, timeout=15)
    steps.append(f"相册信息页 aid={aid} → HTTP {code} ({ms}ms)")
    img_url = None
    if code == 200:
        m2 = re.search(rb'src="(//[^"]+\.(?:jpg|jpeg|png|webp))"', body, re.I)
        if m2:
            img_url = "https://" + m2.group(1).decode().lstrip('/')
    if not img_url:
        return result('ERROR', 'content', detail="相册信息页无图片链接", steps=steps)

    code, body, ms = http_req(img_url, headers=h, timeout=15)
    kind = img_magic(body)
    steps.append(f"下载 {img_url.split('/')[2]} → HTTP {code}, {len(body)} 字节 ({ms}ms), 识别 {kind or '非图片'}")
    if code == 200 and kind in ("JPEG", "PNG", "WebP", "GIF", "AVIF"):
        return result('OK_CONTENT', 'content', latency=ms, code=200,
                      detail=f"端到端成功: {len(body)} 字节 {kind} (图片域真实字节; 正图域对非浏览器 403)", steps=steps)
    return result('ERROR', 'content', code=code, detail=f"图片链路失败 ({kind or code})", steps=steps)


def e2e_picacg():
    """哔咔：HMAC 签名访问 init 接口（匿名）。能到数据级；取图需账号 → LOGIN_REQUIRED。"""
    steps = []
    code, body, ms = http_req("https://picaapi.picacomic.com/init",
                              headers=hhc.get_pica_headers(), timeout=12)
    steps.append(f"init (HMAC 签名) → HTTP {code} ({ms}ms)")
    if code == 200:
        d = json_body(body)
        if d and d.get("status") == "ok":
            return result('OK_DATA', 'data', latency=ms, code=200,
                          detail="签名接口正常; 图片需登录账号, 未验证到图（无 403 假绿）", steps=steps)
        return result('OK_DATA', 'data', latency=ms, code=200, detail="接口可达但响应异常", steps=steps)
    if code == 401:
        return result('LOGIN_REQUIRED', 'data', code=401, detail="需登录账号", steps=steps)
    if code in (403, 429):
        return result('BLOCKED', 'data', code=code, detail=f"HTTP {code}", steps=steps)
    return result('DOWN' if code == 'ERR' else 'ERROR', 'data', code=code, steps=steps)

# ---------------------------------------------------------------- 连通级兜底探针（复用 hybrid PROBES 配置）

def conn_probe(key):
    p = hhc.PROBES[key]
    headers = p.get('headers')
    if headers is None and key == 'picacg':
        headers = hhc.get_pica_headers()
    if headers is None:
        headers = {'User-Agent': UA_BROWSER}
    code, body, ms = http_req(p['url'], headers=headers, data=p.get('data'),
                              method=p.get('method', 'GET'), timeout=10)
    steps = [f"{p['url']} → HTTP {code} ({ms}ms)"]
    if code in (200, 201, 206):
        return result('OK_CONN', 'conn', latency=ms, code=code,
                      detail=f"连通正常; 未接入内容级探测（仅状态码）", steps=steps)
    if code == 401:
        return result('LOGIN_REQUIRED', 'conn', code=code, steps=steps)
    if code in (403, 429):
        return result('BLOCKED', 'conn', code=code, detail=f"HTTP {code} —— 现行探针对此亮绿灯", steps=steps)
    if code == 210:
        return result('RISK_CONTROL', 'conn', code=code, steps=steps)
    if code == 'ERR':
        return result('DOWN', 'conn', code=code, steps=steps)
    return result('ERROR', 'conn', code=code, steps=steps)


CONTENT_PROBES = {
    'copy_manga': lambda: e2e_copy_manga(OUT_DIR),
    'Komiic': e2e_komiic,
    'manga_dex': e2e_mangadex,
    'nhentai': e2e_nhentai,
    'ehentai': e2e_ehentai,
    'hitomi': e2e_hitomi,
    'wnacg': e2e_wnacg,
}
DATA_PROBES = {'picacg': e2e_picacg}


def run_overseas():
    print("\n🌍 [海外列] 端到端内容级探测（搜索→详情→章节→真实图片字节）...")
    results = {}
    for key, p in hhc.PROBES.items():
        name = p['name']
        try:
            if key in CONTENT_PROBES:
                res = CONTENT_PROBES[key]()
            elif key in DATA_PROBES:
                res = DATA_PROBES[key]()
            else:
                res = conn_probe(key)
        except Exception as e:
            res = result('ERROR', 'conn', detail=f"探针自身异常: {e}")
        results[key] = res
        print(f"  [{key:16}] {res['verdict']:14} ({res['latency_ms']}ms) {res['detail'][:70]}")
        time.sleep(0.3)
    return results

# ---------------------------------------------------------------- 大陆列（复用 hybrid 双引擎）

def run_mainland():
    ssh_key = os.environ.get('PROBE_SSH_KEY')
    ssh_host = os.environ.get('PROBE_HOST')
    ssh_user = os.environ.get('PROBE_USER', 'probe-runner')
    data, engine = None, None
    if ssh_key and ssh_host:
        data, engine = hhc.probe_mainland_primary_ssh(ssh_host, ssh_key, ssh_user)
    if not data:
        data, engine = hhc.probe_mainland_fallback_globalping()
    return data, engine

# ---------------------------------------------------------------- 输出产物

TIER_LABEL = {'content': '`内容级` (真实下载图片字节)', 'data': '`数据级` (业务接口校验)',
              'conn': '`连通级` (仅状态码)', 'none': '—'}


def build_readme_section(overseas, mainland, engine_name):
    dual_time = get_dual_time_str(False)
    start_marker = "## 🧭 各漫画源最佳线路与网络推荐指南 (Recommended Lines)"
    end_marker = "## 🛠️ 重点修复与更新日志 (Changelog)"

    md = f"""{start_marker}

> 🕒 **实测数据更新时间**：{dual_time}  
> 🌐 **双网络实测节点**：**中国大陆直连**（{engine_name}） vs **海外代理网络**（GitHub Actions Runner）  
> 🔬 **探测深度**：`内容级` = 真实走完 搜索→详情→章节→下载图片字节 并校验图片格式；`数据级` = 业务接口返回可解析数据；`连通级` = 仅状态码  
> 🚦 **判定口径（诚实版）**：🟢 端到端正常/数据正常/可连通 ｜ 🟠 风控·限频·配额耗尽 ｜ 🟡 需登录 ｜ 🔴 被拦截 (403/429/210，**不再亮绿灯**) ｜ ❌ 无法直连

| 漫画源 | 线路 / 分流选项 | 探测深度 | 大陆骨干直连实测 | 海外代理实测 (端到端判定) | 实测说明 |
| :--- | :--- | :---: | :---: | :---: | :--- |
"""
    for key, p in hhc.PROBES.items():
        ov = overseas.get(key) or result('NOT_IMPLEMENTED', 'none')
        cn = mainland.get(key, {'latency': -1, 'code': 'ERR'}) if mainland else {'latency': -1, 'code': 'ERR'}
        lat = f" (~{ov['latency_ms']}ms)" if ov['latency_ms'] and ov['latency_ms'] > 0 else ""
        badge = f"{VERDICT_BADGE[ov['verdict']]}{lat}"
        note = ov['detail'] or '—'
        md += (f"| **{p['name']}** | {p['line_opts']} | {TIER_LABEL[ov['tier']]} | "
               f"{mainland_badge(cn['latency'], cn['code'])} | {badge} | {note} |\n")
    md += f"\n---\n\n{end_marker}\n"
    return md


def build_step_summary(overseas, mainland, engine_name, alert_msg=None):
    md = "# 🩺 VeneraX 漫画源端到端探活报告 (E2E)\n\n"
    md += f"- **测速时间**：{get_dual_time_str(True)}\n"
    md += f"- **大陆直连引擎**：`{engine_name or '全部失效 (已报警)'}`\n"
    md += f"- **海外探测方式**：`GitHub Actions Runner 端到端 (搜索→章节→真实图片字节)`\n\n"
    if alert_msg:
        md += f"### 🚨 异常告警提醒\n> {alert_msg}\n\n"
    md += "| 漫画源 | 探测深度 | 判定 | 海外实测 | 大陆连通 |\n| :--- | :---: | :--- | :---: | :---: |\n"
    for key, p in hhc.PROBES.items():
        ov = overseas.get(key) or result('NOT_IMPLEMENTED', 'none')
        cn = mainland.get(key, {'latency': -1, 'code': 'ERR'}) if mainland else {'latency': -1, 'code': 'ERR'}
        ov_code = ov['code'] if ov['code'] is not None else '-'
        md += (f"| **{p['name']}** | {ov['tier']} | {VERDICT_BADGE[ov['verdict']]} | "
               f"`{ov_code}` ({ov['latency_ms']}ms) | `{cn['code']}` ({cn['latency']}ms) |\n")
    return md


def build_alert_body(overseas, mainland, engine_name, content_bad, conn_core_bad):
    body = f"## 🚨 [VeneraX 端到端探活告警] 内容级探测发现真实异常\n\n"
    body += f"- **检测时间**：{get_dual_time_str(True)}\n"
    body += f"- **大陆直连引擎**：`{engine_name or '全部失效 (已报警)'}`\n\n"
    if not mainland:
        body += "### ❗ 大陆双探活引擎失效\n私有 SSH 探针连接失败，且 Globalping 备用公共探针无响应。请检查探针服务器或 Secrets 配置。\n\n"
    if content_bad:
        body += "### 📉 内容级异常（API 连通但实际读不到漫画，现行探针无法发现此类故障）\n\n"
        body += "| 漫画源 | 判定 | 详情 |\n| :--- | :--- | :--- |\n"
        for k in content_bad:
            ov = overseas[k]
            body += f"| **{hhc.PROBES[k]['name']}** | {VERDICT_BADGE[ov['verdict']]} | {ov['detail']} |\n"
        body += "\n"
    if conn_core_bad:
        names = "、".join(hhc.PROBES[k]['name'] for k in conn_core_bad)
        body += f"### ❗ 主力源连通级异常\n以下主力源双端均无法连接：**{names}**\n"
    return body

# ---------------------------------------------------------------- 主流程（模拟 GitHub workflow 步骤）

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    started = time.time()
    print("=" * 66)
    print("VeneraX E2E Health Check — 本地完整流程演练 (模拟 GitHub Actions)")
    print("=" * 66)

    # Step 1: 验证索引（对应 workflow "Validate indexed source files"）
    sources = json.loads(open(os.path.join(ROOT, 'index.json'), encoding='utf-8').read())
    for s in sources:
        assert os.path.isfile(os.path.join(ROOT, s['fileName'])), f"Missing indexed source file: {s['fileName']}"
    print(f"[Step 1] 索引校验通过: {len(sources)} 个源文件齐全")

    # Step 2: 海外端到端探测（对应 "Run Hybrid Health Check" 海外列）
    overseas = run_overseas()

    # Step 3: 大陆双引擎探测（SSH 优先 → Globalping 故障转移；本地无 SSH Secret, 演练故障转移路径）
    mainland, engine_name = run_mainland()

    # Step 4: 判定汇总 + 告警规则
    content_bad = [k for k, v in overseas.items()
                   if v['tier'] == 'content' and v['verdict'] in ('DOWN', 'BLOCKED', 'RISK_CONTROL')]
    conn_core_bad = []
    if mainland:
        for core_key in ('copy_manga', 'Komiic', 'baozi'):
            if overseas.get(core_key, {}).get('latency_ms', -1) < 0 and mainland.get(core_key, {}).get('latency', -1) < 0:
                conn_core_bad.append(core_key)
    engine_failed = mainland is None

    has_alert = engine_failed or bool(content_bad) or bool(conn_core_bad)
    alert_msg = None
    if has_alert:
        alert_msg = "内容级探测发现真实异常" if (content_bad or conn_core_bad) else "大陆双探活引擎失效"
        alert_body = build_alert_body(overseas, mainland, engine_name, content_bad, conn_core_bad)
        with open(os.path.join(OUT_DIR, 'health_check_alert.md'), 'w', encoding='utf-8') as f:
            f.write(alert_body)
        print(f"\n🚨 告警成立: {alert_msg} → {OUT_DIR}/health_check_alert.md")

    # Step 5: 产物输出（全部写入 work/e2e_run/, 不触碰真实 README.md）
    with open(os.path.join(OUT_DIR, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump({"generated_at": datetime.now(timezone.utc).isoformat(),
                   "engine_mainland": engine_name, "has_alert": has_alert,
                   "overseas": overseas, "mainland": mainland}, f, ensure_ascii=False, indent=2)

    readme_section = build_readme_section(overseas, mainland, engine_name)
    with open(os.path.join(OUT_DIR, 'README_section_preview.md'), 'w', encoding='utf-8') as f:
        f.write(readme_section)
    print(f"[Step 5] README 区块预览 → {OUT_DIR}/README_section_preview.md (真实 README 未改动)")

    summary = build_step_summary(overseas, mainland, engine_name, alert_msg)
    with open(os.path.join(OUT_DIR, 'step_summary.md'), 'w', encoding='utf-8') as f:
        f.write(summary)
    gh_summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if gh_summary:
        with open(gh_summary, 'a', encoding='utf-8') as f:
            f.write(summary)
    with open(os.path.join(OUT_DIR, 'has_alert.txt'), 'w') as f:
        f.write('true' if has_alert else 'false')

    # 汇总打印
    print("\n" + "=" * 66)
    print(f"{'漫画源':<12} {'深度':<8} {'判定':<16} 延迟")
    print("-" * 66)
    for key, p in hhc.PROBES.items():
        ov = overseas[key]
        print(f"{p['name']:<12} {ov['tier']:<8} {ov['verdict']:<16} {ov['latency_ms']}ms")
    print("-" * 66)
    n_ok = sum(1 for v in overseas.values() if v['verdict'].startswith('OK'))
    print(f"内容级 {sum(1 for v in overseas.values() if v['tier']=='content')} 个 | "
          f"端到端通过 {sum(1 for v in overseas.values() if v['verdict']=='OK_CONTENT')} 个 | "
          f"总耗时 {time.time()-started:.0f}s | 产物目录: {OUT_DIR}")

    # 模拟 workflow 的 Propagate Final Status（引擎失效才整体失败, 与现行 main() 行为一致）
    if engine_failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
