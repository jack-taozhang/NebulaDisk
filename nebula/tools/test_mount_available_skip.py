# -*- coding: utf-8 -*-
"""回归测试：`settings.py` 里「可用挂载点」的排除规则 `_is_skipped()`。

背景（2026-09-27 连踩两次的坑）
------------------------------------------------------------------
`GET /api/admin/mounts/available` 会把容器内真实挂载点列给前端的「新建映射」下拉框。
它必须把系统目录和程序自身目录排除掉，否则 kkFileView 的转换产物目录
（`/opt/kkFileView-5.0.2/file`）和日志目录会混进候选列表。

排除规则对 `/opt/kkFileView*` 失败过两次：
  ① 精确匹配 `/opt/kkFileView/file` —— 容器里的实际挂载点带版本号，拦不住；
  ② 「前缀 + /」即 `/opt/kkFileView/` —— **同样拦不住**！
     因为实际路径是 `/opt/kkFileView-5.0.2/file`，中间的 `-5.0.2` 让
     `startswith("/opt/kkFileView/")` 为 False。
  ⇒ 最终用「三段式」：精确 / 前缀+「/」/ 前缀+「-」。

为什么用"抽源码 exec"而不是 import
------------------------------------------------------------------
本脚本**从源文件里正则抠出 `_SKIP_PREFIX` 与 `_is_skipped` 再 exec**，
而不是手抄一份同样的逻辑 —— 手抄会与实现漂移，测过了也不代表实现是对的。
同时也避免 import 整个 app 包（会拉起 FastAPI、读配置、写日志）。

运行：
    python3 nebula/tools/test_mount_available_skip.py
"""
from __future__ import annotations

import pathlib
import re
import sys

SRC = pathlib.Path(__file__).resolve().parents[1] / "app" / "routers" / "settings.py"


def load_matcher():
    text = SRC.read_text(encoding="utf-8")

    m = re.search(r"^_SKIP_PREFIX = \(.*?^\)\n", text, re.S | re.M)
    if not m:
        raise SystemExit("没能从 %s 里定位 _SKIP_PREFIX" % SRC)
    block = m.group(0)

    m2 = re.search(
        r"^def _is_skipped\(norm: str\) -> bool:\n(?:.*?\n)*?    return False\n",
        text,
        re.M,
    )
    if not m2:
        raise SystemExit("没能从 %s 里定位 _is_skipped" % SRC)
    block += "\n" + m2.group(0)

    ns: dict = {}
    exec(compile(block, "<extracted>", "exec"), ns)  # noqa: S102 — 只 exec 本仓库自己的源码
    return ns["_is_skipped"], ns["_SKIP_PREFIX"]


# (容器内路径, 期望是否被排除)
# 前两条取自容器内 /proc/mounts 的真实观测值；带 ❌ 的是反例哨兵。
CASES = [
    # —— 应当保留（用户可映射的盘）——
    ("/mnt/d", False),
    ("/mnt/e", False),
    ("/mnt/photos", False),
    ("/mnt/private", False),
    ("/mnt/share", False),
    # —— 必须排除：kkFileView（★ 本条是本测试存在的理由）——
    ("/opt/kkFileView-5.0.2/file", True),
    ("/opt/kkFileView-5.0.2/log", True),
    ("/opt/kkFileView/file", True),          # 软链形态 / 无版本号
    ("/opt/kkFileView/log", True),
    # —— 必须排除：网盘自身 ——
    ("/opt/nebula", True),
    ("/var/lib/nebula", True),
    ("/opt/nebula-old-backup", True),
    # —— 必须排除：系统目录 ——
    ("/proc/acpi", True),
    ("/etc/hosts", True),
    ("/dev/shm", True),
    ("/run/lock", True),
    ("/tmp", True),
    ("/bin", True),
    # —— ❌ 反例哨兵：不能误伤相邻名字的普通目录 ——
    #    用裸 startswith(p) 会把这两个误杀，所以实现里必须带分隔符。
    ("/binfoo", False),
    ("/etcetera", False),
    ("/opt/other", False),
]


def main() -> int:
    _is_skipped, skip_prefix = load_matcher()
    print("已从 %s 抽出 _SKIP_PREFIX（%d 项）" % (SRC.name, len(skip_prefix)))

    failed = 0
    for path, want in CASES:
        got = _is_skipped(path)
        ok = got == want
        failed += 0 if ok else 1
        print("%-4s %-30s 期望=%-5s 实际=%-5s" % ("OK" if ok else "FAIL", path, want, got))

    print("-" * 62)
    if failed:
        print("失败 %d / %d" % (failed, len(CASES)))
        return 1
    print("全部 %d 条通过" % len(CASES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
