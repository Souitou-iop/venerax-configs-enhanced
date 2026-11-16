"""Venera Source Assurance (VSA) — 真实 JS 漫画源验收系统。

Layer 2: live 路径通过基于官方 venera_core 的薄 Dart runner(内部 QuickJS 运行时)
加载并执行仓库中的真实漫画源 JS, 完成 搜索/探索→详情→章节→图片字节 的端到端验收;
PR 自检使用固定 commit 的 venera_cli。与 Layer 1(Python 网站健康探针,
scripts/e2e_health_check.py)互相独立、互不继承结果。
"""

__version__ = "0.1.0"
