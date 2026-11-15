import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("e2e_health_check", ROOT / "scripts/e2e_health_check.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


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


if __name__ == "__main__":
    unittest.main()
