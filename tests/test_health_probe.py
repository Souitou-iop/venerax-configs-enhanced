import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("e2e_health_check", ROOT / "scripts/e2e_health_check.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

TLS_TIMEOUT = b"<urlopen error _ssl.c:1001: The handshake operation timed out>"


class _ProbeStub:
    """临时替换 PROBES[wmanhua] 与 http_req, 避免真实联网。"""

    def __init__(self, key, responses, cross_check=None):
        self.key = key
        self.responses = list(responses)
        self.cross_check = cross_check
        self.calls = []

    def __enter__(self):
        self.original_probe = MODULE.hhc.PROBES.get(self.key)
        self.original_request = MODULE.http_req
        self.original_cross_check = MODULE.globalping_https_check
        MODULE.hhc.PROBES[self.key] = {
            "url": "https://www.wmanhua.com/",
            "headers": {},
            "method": "GET",
            "data": None,
        }
        MODULE.http_req = self._fake_request
        MODULE.globalping_https_check = self._fake_cross_check
        return self

    def _fake_request(self, url, **kwargs):
        self.calls.append(url)
        if not self.responses:
            raise AssertionError(f"unexpected extra request: {url}")
        return self.responses.pop(0)

    def _fake_cross_check(self, url):
        if self.cross_check is None:
            raise AssertionError(f"cross check should not run: {url}")
        return self.cross_check

    def __exit__(self, *exc):
        MODULE.http_req = self.original_request
        MODULE.globalping_https_check = self.original_cross_check
        if self.original_probe is None:
            MODULE.hhc.PROBES.pop(self.key, None)
        else:
            MODULE.hhc.PROBES[self.key] = self.original_probe
        return False


class HealthProbeTests(unittest.TestCase):
    def test_ykmh_cloudflare_is_environment_restriction(self):
        original_probe = MODULE.hhc.PROBES.get("ykmh")
        original_request = MODULE.http_req
        try:
            MODULE.hhc.PROBES["ykmh"] = {
                "url": "https://www.ykmh.net/",
                "headers": {},
                "method": "GET",
                "data": None,
            }
            MODULE.http_req = lambda *args, **kwargs: (403, b"<html><title>Just a moment...</title></html>", 120)
            result = MODULE.conn_probe("ykmh")
            self.assertEqual(result["verdict"], "BLOCKED")
            self.assertIn("Cloudflare", result["detail"])
            self.assertNotIn("亮绿灯", result["detail"])
            self.assertIn("ykmh", MODULE.KNOWN_RESTRICTED_SOURCES)
        finally:
            MODULE.http_req = original_request
            if original_probe is None:
                MODULE.hhc.PROBES.pop("ykmh", None)
            else:
                MODULE.hhc.PROBES["ykmh"] = original_probe

    def test_tls_interrupt_retries_then_succeeds(self):
        """一次握手超时后重试成功, 不应判 DOWN(本次 Issue #14 的直接成因)。"""
        with _ProbeStub("wmanhua", [("ERR", TLS_TIMEOUT, 10000),
                                    (200, b"<html>ok</html>", 800)]) as stub:
            res = MODULE.conn_probe("wmanhua")
        self.assertEqual(res["verdict"], "OK_CONN")
        self.assertFalse(res["env_limited"])
        self.assertEqual(len(stub.calls), 2)
        self.assertTrue(any("重试记录" in step for step in res["steps"]))

    def test_tls_interrupt_confirmed_by_independent_network_is_environment_limit(self):
        """三次握手都超时, 但独立网络 HTTPS 可达: 站点在线, 归为出口网络限制而非站点故障。"""
        cross = {"ok": True, "code": 200, "evidence": ["JP/Tokyo (Oracle) → HTTP 200"], "error": None}
        with _ProbeStub("wmanhua", [("ERR", TLS_TIMEOUT, 10000)] * MODULE.CONN_ATTEMPTS,
                        cross_check=cross):
            res = MODULE.conn_probe("wmanhua")
        self.assertEqual(res["verdict"], "OK_CONN")
        self.assertTrue(res["env_limited"])
        self.assertIn("非站点故障", res["detail"])
        self.assertEqual(res["code"], 200)
        self.assertTrue(any("独立网络复核" in step for step in res["steps"]))

    def test_tls_interrupt_without_independent_evidence_stays_down(self):
        """握手超时且独立网络也拿不到结果时仍判 DOWN —— 复核失败不能变成漏报通道。"""
        cross = {"ok": False, "code": None, "evidence": [], "error": "globalping submit failed: 503"}
        with _ProbeStub("wmanhua", [("ERR", TLS_TIMEOUT, 10000)] * MODULE.CONN_ATTEMPTS,
                        cross_check=cross):
            res = MODULE.conn_probe("wmanhua")
        self.assertEqual(res["verdict"], "DOWN")
        self.assertFalse(res["env_limited"])
        self.assertIn("3 次尝试", res["detail"])

    def test_tls_interrupt_with_failing_independent_network_stays_down(self):
        """独立网络同样无响应时, 说明站点或线路真的有问题, 必须照常告警。"""
        cross = {"ok": False, "code": None,
                 "evidence": ["US/Buffalo (Cogent) → 无响应"], "error": None}
        with _ProbeStub("wmanhua", [("ERR", TLS_TIMEOUT, 10000)] * MODULE.CONN_ATTEMPTS,
                        cross_check=cross):
            res = MODULE.conn_probe("wmanhua")
        self.assertEqual(res["verdict"], "DOWN")
        self.assertFalse(res["env_limited"])

    def test_http_status_is_not_retried(self):
        """403 是站点明确答复, 不该重试也不该被改写成环境限制。"""
        with _ProbeStub("wmanhua", [(403, b"<html>forbidden</html>", 300)]) as stub:
            res = MODULE.conn_probe("wmanhua")
        self.assertEqual(res["verdict"], "BLOCKED")
        self.assertEqual(len(stub.calls), 1)
        self.assertFalse(res["env_limited"])

    def test_probe_sends_chinese_accept_language(self):
        """热门漫画缺中文语言头会返回 404, 探针必须带上 Accept-Language 才不误判。"""
        sent = {}
        original_request = MODULE.http_req

        def _capture(url, headers=None, **kwargs):
            sent.update(headers or {})
            return 200, b"<html>ok</html>", 500

        try:
            MODULE.http_req = _capture
            MODULE.conn_probe("remenmanhua")
        finally:
            MODULE.http_req = original_request
        self.assertEqual(sent.get("Accept-Language"), MODULE.ACCEPT_LANGUAGE_ZH)
        self.assertIn("zh", sent.get("Accept-Language", ""))

    def test_env_limited_source_does_not_enter_alert_state(self):
        """env_limited 不应累计连续异常; 已在告警态的源应在本轮恢复销单。"""
        with tempfile.TemporaryDirectory() as tmp:
            original_out = MODULE.OUT_DIR
            MODULE.OUT_DIR = Path(tmp)
            try:
                MODULE.save_probe_state(
                    {"wmanhua": {"consecutive_bad": 2, "alerted": True, "last_verdict": "DOWN"}})
                res = MODULE.result("OK_CONN", "conn", latency=1900, code=200, detail="ok")
                res["env_limited"] = True
                decision = MODULE.update_alert_state({"wmanhua": res}, {}, False, [])
                self.assertEqual(decision["recovered"], ["wmanhua"])
                self.assertEqual(decision["outstanding"], [])
                self.assertFalse(decision["should_alert"])
                self.assertEqual(MODULE.load_probe_state()["wmanhua"]["consecutive_bad"], 0)
            finally:
                MODULE.OUT_DIR = original_out

    def test_cross_check_ignores_cloud_networks_as_evidence(self):
        """复核结果只来自云厂商出口时不能当作独立证据, 否则等于自己证明自己。"""
        measurement = {
            "status": "finished",
            "results": [
                {"probe": {"country": "US", "city": "Des Moines", "network": "Microsoft"},
                 "result": {"statusCode": 200}},
                {"probe": {"country": "NL", "city": "Amsterdam", "network": "Microsoft"},
                 "result": {"statusCode": None, "rawOutput": "TLS handshake timed out"}},
            ],
        }
        original_urlopen = MODULE.urllib.request.urlopen
        original_sleep = MODULE.time.sleep

        class _Resp:
            def __init__(self, payload):
                self._payload = payload

            def read(self):
                return self._payload

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def _fake_urlopen(req, timeout=None):
            url = getattr(req, 'full_url', req)
            if isinstance(url, str) and url.endswith('/v1/measurements'):
                return _Resp(b'{"id": "abc"}')
            return _Resp(json.dumps(measurement).encode())

        try:
            MODULE.urllib.request.urlopen = _fake_urlopen
            MODULE.time.sleep = lambda *_: None
            result = MODULE.globalping_https_check("https://www.wmanhua.com/")
        finally:
            MODULE.urllib.request.urlopen = original_urlopen
            MODULE.time.sleep = original_sleep
        self.assertFalse(result["ok"])
        self.assertEqual(result["evidence"], [])
        self.assertIn("cloud-vendor", result["error"])


if __name__ == "__main__":
    unittest.main()
