"""Venera Source Assurance (VSA) — 真实 JS 漫画源验收系统。

Layer 2: 通过官方 venera_cli(QuickJS 运行时)加载并执行仓库中的真实漫画源 JS,
完成 搜索→详情→章节→图片字节 的端到端验收;与 Layer 1(Python 网站健康探针,
scripts/e2e_health_check.py)互相独立、互不继承结果。
"""

__version__ = "0.1.0"
