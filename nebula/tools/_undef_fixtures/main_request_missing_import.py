"""坏例②：main.py 的异常处理器用了 Request 但没 import。

当前靠 `from __future__ import annotations`（PEP 563）侥幸不炸，
但一旦有人对 handler 调 get_type_hints / 关掉 PEP 563 就炸。
"""
from __future__ import annotations

from fastapi import FastAPI

app = FastAPI()


@app.exception_handler(Exception)
async def _h(request: Request, exc: Exception):
    return None
