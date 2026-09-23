"""正例：类作用域 / 推导式 / try-except / with / 海象 / 参数默认值
都不能被误报。护栏一旦有假红就会被绕过，所以这个文件是必需的对照。"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

LIMIT = 3


class C:
    MULT = 2

    def f(self, a: int, b: Optional[str] = None) -> str:
        xs = [x for x in range(a) if x < LIMIT]
        neg = [-x for x in xs]
        mapping = {k: v for k, v in zip(xs, neg)}
        try:
            with open("f") as fh:
                data = fh.read()
        except OSError:
            data = ""
        total = (acc := len(xs)) + acc + len(mapping)
        return os.path.join(str(Path(data)), str(total * self.MULT), b or "")

    @staticmethod
    def g():
        async def inner(q):
            return q
        return inner
