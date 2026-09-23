"""含 `import *` 的文件无法静态判定 —— 护栏必须**明说跳过**而不是假装通过。"""
from __future__ import annotations

from os.path import *   # noqa: F403


def use(x):
    return exists(x)
