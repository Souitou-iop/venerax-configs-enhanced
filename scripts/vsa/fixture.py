"""VSA 离线 Fixture: 本地 HTTP 服务 + 动态生成 fixture 漫画源 + 负向测试矩阵。

fixture 服务模拟一个漫画站的全部链路面, 并提供确定的故障端点(P1-2 矩阵):
  - 200 + HTML 充当图片 → FAIL
  - 200 + 损坏字节 → FAIL
  - 200 + 合法 JPEG 头但截断 → FAIL(解码验证)
  - 第一张正常 + 第二张失败 → FAIL(image_count 生效)
  - 404 图片 → FAIL
  - 内网/云元数据 URL → SSRF 护栏拒绝(安全回归)
  - 可用样本少于请求数 → 如实标注(不偷换 1/2)
  - 慢响应 → 超时不得记 PASS
  - 声明受限 + JS 错误 → FAIL(不被 BLOCKED 掩盖)

fixture 漫画源 JS 由本模块动态生成(占位符 @BASE@ 替换, 避免与 JS 花括号混淆),
经真实 venera 运行时加载执行, 在零外部网络依赖下验证 VSA 框架自身的判定路径。
"""
from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# 1×1 像素真实 JPEG(43 字节, magic 与解码均有效)
_TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="
)
# 合法 JPEG 头但内容截断(解码必须失败)
_TRUNCATED_JPEG = _TINY_JPEG[:20]
_HTML_BODY = b"<html><body>Just a moment... cf-browser-verification</body></html>"
_CORRUPT_BODY = b"\x00\x01\x02\x03not-an-image-at-all"

COMICS = [
    {"id": "ok", "title": "VSA Fixture Comic"},
    {"id": "neg-html", "title": "VSA Negative HTML Image"},
    {"id": "neg-corrupt", "title": "VSA Negative Corrupt Image"},
    {"id": "neg-404", "title": "VSA Negative 404 Image"},
    {"id": "neg-truncate", "title": "VSA Negative Truncated JPEG"},
    {"id": "neg-second", "title": "VSA Negative Second Image"},
    {"id": "neg-ssrf", "title": "VSA Negative SSRF URL"},
    {"id": "cm-1img", "title": "VSA Count Mismatch (1 available)"},
]


def _img_bytes(cid: str, page: str) -> tuple[int, bytes] | None:
    """按 (comic, 页码) 返回 (HTTP 状态, 字节); None 表示 404。"""
    if cid == "neg-html":
        return 200, _HTML_BODY
    if cid == "neg-corrupt":
        return 200, _CORRUPT_BODY
    if cid == "neg-404":
        return None
    if cid == "neg-truncate":
        return 200, _TRUNCATED_JPEG
    if cid == "neg-second":
        return (200, _TINY_JPEG) if page == "1.jpg" else (200, _HTML_BODY)
    if cid == "neg-ssrf":
        return None
    return 200, _TINY_JPEG


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默访问日志
        pass

    def _send(self, code: int, body: bytes, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        if path == "/search":
            self._send(200, json.dumps({"data": COMICS, "subData": 1}, ensure_ascii=False).encode())
            return
        parts = path.strip("/").split("/")
        if path.startswith("/info/") and len(parts) == 2:
            cid = parts[1]
            if any(c["id"] == cid for c in COMICS):
                self._send(200, json.dumps({
                    "data": {"title": cid, "chapters": {"ep1": "第1话", "ep2": "第2话"}}
                }, ensure_ascii=False).encode())
            else:
                self._send(404, b'{"error":"unknown comic"}')
            return
        if path.startswith("/pages/") and len(parts) == 3:
            cid, _ep = parts[1], parts[2]
            if cid == "neg-slow":
                import time
                time.sleep(8)
            base = f"http://127.0.0.1:{self.server.server_address[1]}"
            if cid == "cm-1img":
                imgs = [f"{base}/img/{cid}/1.jpg"]
            elif cid == "neg-ssrf":
                # 内网与云元数据地址: SSRF 护栏必须拒绝
                imgs = ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:9/x.jpg"]
            else:
                imgs = [f"{base}/img/{cid}/1.jpg", f"{base}/img/{cid}/2.jpg"]
            self._send(200, json.dumps({"data": imgs}).encode())
            return
        if path.startswith("/img/") and len(parts) == 3:
            cid, page = parts[1], parts[2]
            result = _img_bytes(cid, page)
            if result is None:
                self._send(404, b"not found", "text/plain")
                return
            code, body = result
            self._send(code, body, "image/jpeg")
            return
        self._send(404, b"not found", "text/plain")


class FixtureServer:
    def __init__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.server.server_address[1]
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self.server.shutdown()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


FIXTURE_TEMPLATE = """\
/** VSA fixture 漫画源(动态生成, 面向本地 fixture 服务) */
class VsaFixture extends ComicSource {
  name = "VSA Fixture";
  key = "vsa_fixture";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "@BASE@/";

  static headers = { "User-Agent": "VSA-Fixture/1.0" };

  search = {
    load: async (keyword, options, page) => {
      let res = await Network.get(`@BASE@/search?kw=${encodeURIComponent(keyword || "vsa")}`, VsaFixture.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let payload = JSON.parse(res.body);
      let comics = payload.data.map((it) => new Comic({ id: it.id, title: it.title, cover: "" }));
      return { comics, maxPage: 1 };
    },
    optionList: [],
  };

  comic = {
    loadInfo: async (id) => {
      let res = await Network.get(`@BASE@/info/${id}`, VsaFixture.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let payload = JSON.parse(res.body);
      let chapters = new Map();
      for (let [ep, name] of Object.entries(payload.data.chapters)) chapters.set(ep, name);
      return new ComicDetails({ title: payload.data.title, cover: "", tags: {}, chapters });
    },
    loadEp: async (comicId, epId) => {
      let res = await Network.get(`@BASE@/pages/${comicId}/${epId}`, VsaFixture.headers);
      if (res.status !== 200) throw `Invalid status: ${res.status}`;
      let payload = JSON.parse(res.body);
      if (!Array.isArray(payload.data) || payload.data.length < 1) throw "No images";
      return { images: payload.data };
    },
    onImageLoad: (url) => ({ headers: { Referer: "@BASE@/" } }),
  };
}
"""


BROKEN_SYNTAX_JS = """\
class VsaBrokenSyntax extends ComicSource {
  name = "VSA Broken Syntax"
  key = "vsa_broken"
  version = "1.0.0"
  this is not valid javascript {(
"""

BAD_SEARCH_JS_TEMPLATE = """\
/** VSA 负向: search 阶段抛异常 */
class VsaBadSearch extends ComicSource {
  name = "VSA Bad Search";
  key = "vsa_badsearch";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "@BASE@/";
  search = {
    load: async (keyword, options, page) => {
      throw new Error("fixture: search failure");
    },
  };
  comic = {
    loadInfo: async (id) => new ComicDetails({ title: id, cover: "", tags: {}, chapters: new Map() }),
    loadEp: async () => ({ images: [] }),
  };
}
"""

THROW_INFO_JS_TEMPLATE = """\
/** VSA 负向: info 阶段抛异常 */
class VsaThrowInfo extends ComicSource {
  name = "VSA Throw Info";
  key = "vsa_throwinfo";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "@BASE@/";
  search = {
    load: async (keyword, options, page) => {
      let res = await Network.get(`@BASE@/search?kw=x`, {});
      let payload = JSON.parse(res.body);
      return { comics: payload.data.map((it) => new Comic({ id: it.id, title: it.title, cover: "" })), maxPage: 1 };
    },
  };
  comic = {
    loadInfo: async (id) => {
      throw new Error("fixture: info failure");
    },
    loadEp: async () => ({ images: [] }),
  };
}
"""

DECLARED_BROKEN_JS = """\
/** VSA 负向: 声明受限(blocked_patterns 命中 403)但实际是 JS 解析错误 → 必须 FAIL */
class VsaDeclaredBroken extends ComicSource {
  name = "VSA Declared Broken";
  key = "vsa_declared_broken";
  version = "1.0.0";
  minAppVersion = "1.0.0";
  url = "@BASE@/";
  search = {
    load: async (keyword, options, page) => {
      // 模拟"站点改版导致 JSON 解析拿到 HTML": JS 层错误优先于受限声明
      let res = await Network.get(`@BASE@/search?kw=x`, {});
      let payload = JSON.parse(res.body.replace("{", "<html>"));
      return { comics: [], maxPage: 1 };
    },
  };
  comic = {
    loadInfo: async (id) => new ComicDetails({ title: id, cover: "", tags: {}, chapters: new Map() }),
    loadEp: async () => ({ images: [] }),
  };
}
"""


def generate_fixture_sources(out_dir, base_url: str) -> dict:
    """生成 fixture 源文件, 返回 key -> 文件路径。占位符 @BASE@ 避免与 JS 花括号混淆。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "vsa_fixture": out_dir / "vsa_fixture.js",
        "vsa_broken": out_dir / "vsa_broken_syntax.js",
        "vsa_badsearch": out_dir / "vsa_badsearch.js",
        "vsa_throwinfo": out_dir / "vsa_throwinfo.js",
        "vsa_declared_broken": out_dir / "vsa_declared_broken.js",
    }
    files["vsa_fixture"].write_text(FIXTURE_TEMPLATE.replace("@BASE@", base_url), encoding="utf-8")
    files["vsa_broken"].write_text(BROKEN_SYNTAX_JS, encoding="utf-8")
    files["vsa_badsearch"].write_text(BAD_SEARCH_JS_TEMPLATE.replace("@BASE@", base_url), encoding="utf-8")
    files["vsa_throwinfo"].write_text(THROW_INFO_JS_TEMPLATE.replace("@BASE@", base_url), encoding="utf-8")
    files["vsa_declared_broken"].write_text(DECLARED_BROKEN_JS.replace("@BASE@", base_url), encoding="utf-8")
    return files
