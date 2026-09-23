"""坏例①：R2 拆分 main.py 时的真实 bug —— make_raw_url 没 import。

后果：OnlyOffice / kkFileView / CAD **三条预览链路全 500**，
而单测与 selfcheck 全绿（只查路由存在，不查处理器能否执行）。
"""
from __future__ import annotations

from ..webutil import _origin


def api_oo_config(mount: str, path: str):
    doc_url = make_raw_url(mount, path, ttl=3600)
    return {"url": doc_url}
