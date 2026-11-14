"""venera_cli 运行时管理: 构建、加载源、执行命令。

退出码契约(实测 2026-11-14):
  - 命令成功: exit 0, JSON 在 stdout
  - 链路 JS 异常: exit 1, 错误信息在 stderr
  - source load 语法错误: exit 1
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_RUNTIME = REPO_ROOT / "work/vsa/runtime/bundle/bin/venera"
CLI_SRC = REPO_ROOT / "work/vsa/venera_cli_src"
CLI_REPO = "https://github.com/venera-app/venera_cli.git"

# 与 venera_core _Config.userAgent 保持一致的浏览器 UA(图片下载默认头)
RUNTIME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


@dataclass
class CmdResult:
    ok: bool
    exit_code: int
    stdout: str
    stderr: str
    elapsed_ms: int

    @property
    def json(self):
        try:
            return json.loads(self.stdout)
        except (json.JSONDecodeError, ValueError):
            return None

    @property
    def err_brief(self) -> str:
        """取 stderr 中最有信息量的一行(优先含 Error/异常关键字的行, 过滤纯栈帧行)。"""
        lines = [l.strip() for l in self.stderr.strip().splitlines() if l.strip()]
        if not lines:
            return ""
        for line in lines:
            if not line.startswith("at ") and (
                "Error" in line or "error" in line or "at load" not in line
            ):
                return line[:200]
        return lines[0][:200]


class VsaRuntimeError(Exception):
    """运行时缺失/构建失败等框架级异常(→ ERROR, 不得记 PASS)。"""


class VeneraRuntime:
    def __init__(self, binary: Path | None = None, auto_build: bool = False):
        self.binary = Path(binary or DEFAULT_RUNTIME)
        self.auto_build = auto_build
        self._version: str | None = None

    def ensure(self) -> Path:
        if self.binary.exists():
            return self.binary
        if self.auto_build:
            self.build()
            return self.binary
        raise VsaRuntimeError(
            f"venera 运行时不存在: {self.binary} (先用 --build 构建或 Dart 手动构建)"
        )

    def build(self) -> Path:
        """克隆(如缺)并构建 venera_cli; 需要 PATH 中有 dart。"""
        if shutil.which("dart") is None:
            raise VsaRuntimeError("构建需要 Dart SDK (PATH 中找不到 dart)")
        if not CLI_SRC.exists():
            CLI_SRC.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["git", "clone", "--depth", "1", CLI_REPO, str(CLI_SRC)],
                check=True, capture_output=True,
            )
        subprocess.run(["dart", "pub", "get"], cwd=CLI_SRC, check=True, capture_output=True)
        out_dir = self.binary.parent.parent.parent  # .../runtime
        subprocess.run(
            ["dart", "build", "cli", "--target", "bin/venera.dart", "--output", str(out_dir)],
            cwd=CLI_SRC, check=True, capture_output=True,
        )
        if not self.binary.exists():
            raise VsaRuntimeError(f"构建完成但未找到产物: {self.binary}")
        return self.binary

    @property
    def version(self) -> str:
        if self._version is None:
            r = self.run(["-v"], timeout=30)
            self._version = r.stdout.strip() or "unknown"
        return self._version

    def run(self, args: list[str], timeout: int = 120) -> CmdResult:
        import time
        binary = self.ensure()
        t0 = time.time()
        try:
            proc = subprocess.run(
                [str(binary), *args],
                capture_output=True, text=True, timeout=timeout,
            )
            return CmdResult(
                ok=proc.returncode == 0,
                exit_code=proc.returncode,
                stdout=proc.stdout,
                stderr=proc.stderr,
                elapsed_ms=int((time.time() - t0) * 1000),
            )
        except subprocess.TimeoutExpired:
            return CmdResult(ok=False, exit_code=124, stdout="", stderr=f"timeout after {timeout}s",
                             elapsed_ms=int(timeout * 1000))

    # ---- 高层操作 ----

    def load_source(self, js_path: Path, timeout: int = 60) -> CmdResult:
        r = self.run(["source", "load", "-f", str(js_path)], timeout=timeout)
        return r

    def parse_loaded(self, r: CmdResult) -> dict | None:
        """从 `Loaded <key> (<name>) <version>` 输出提取元数据。"""
        m = re.search(r"Loaded (\S+) \((.+?)\) (\S+)", r.stdout)
        if not m:
            return None
        return {"key": m.group(1), "name": m.group(2), "version": m.group(3)}

    def search(self, key: str, keyword: str, page: int = 1, timeout: int = 120) -> CmdResult:
        return self.run([key, "search", "--page", str(page), keyword], timeout=timeout)

    def info(self, key: str, comic_id: str, timeout: int = 120) -> CmdResult:
        return self.run([key, "info", comic_id], timeout=timeout)

    def pages(self, key: str, comic_id: str, ep_id: str, timeout: int = 120) -> CmdResult:
        return self.run([key, "pages", "--ep", ep_id, comic_id], timeout=timeout)

    @staticmethod
    def js_sha256(js_path: Path) -> str:
        return hashlib.sha256(js_path.read_bytes()).hexdigest()
