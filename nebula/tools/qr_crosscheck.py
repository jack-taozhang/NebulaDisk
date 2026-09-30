# -*- coding: utf-8 -*-
"""qr_crosscheck.py —— 把 `web/js/qr.js` 的矩阵与 Python `qrcode` 参考实现**逐模块比对**。

★ 为什么必须有这个判据 ★
  二维码是"错了也照样渲染出来"的东西 —— 肉眼看不出对错，只有真机扫一下才知道。
  手写编码器最容易错在三处：Reed-Solomon 生成多项式 / 分块与交错 /
  功能图案（定位、时序、校正、格式与版本信息）的坐标。
  这三处都不适合"看着像对的就上线"。

  ⇒ 拿一个**独立实现**当判据：同一内容、同一版本、同一纠错等级、同一掩码，
     两边矩阵必须**一个模块都不差**。

★ 掩码为什么要显式指定 ★
  两边都会用标准罚分自动挑最优掩码，但"平手时取谁"这类细节不保证一致。
  强开 0~7 逐个比，才能把「掩码选择」与「编码器本身」两件事分开。
  本脚本另比一次"自动选择"的结果，不一致只提示（任何掩码都合法可扫）。

★ 方向为什么是 Python → Node ★
  本机沙箱里 **Node 的 spawnSync 一律 EBUSY**（见 tools/nbssh.py 头部注释）；
  Python 的 subprocess 正常。所以由本脚本调 `node tools/qr_dump.mjs`，
  而不是反过来。

用法：
  python tools/qr_crosscheck.py
  PY_NODE=/path/to/node python tools/qr_crosscheck.py   # 指定 node

退出码 0 = 全绿。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

pass_n = 0
fail_n = 0


def ok(cond, name, extra=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  ✅ {name}")
    else:
        fail_n += 1
        print(f"  ❌ {name}" + (f"  → {extra}" if extra else ""))


def js_dump() -> dict:
    node = os.environ.get("PY_NODE") or shutil.which("node")
    if not node:
        sys.exit("找不到 node（可用 PY_NODE 指定）")
    r = subprocess.run([node, str(HERE / "qr_dump.mjs")],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        sys.exit(f"qr_dump.mjs 失败：\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")
    return json.loads(r.stdout)


def py_matrix(text: str, ecl: str, version: int, mask: int) -> list[str]:
    """用 Python qrcode 算同一张矩阵，返回 [''.join('0'/'1')] 行。"""
    import qrcode
    from qrcode.util import MODE_8BIT_BYTE, QRData

    level = {
        "L": qrcode.constants.ERROR_CORRECT_L,
        "M": qrcode.constants.ERROR_CORRECT_M,
        "Q": qrcode.constants.ERROR_CORRECT_Q,
        "H": qrcode.constants.ERROR_CORRECT_H,
    }[ecl]
    qr = qrcode.QRCode(version=version, error_correction=level,
                       box_size=1, border=0, mask_pattern=mask)
    # ★ 显式指定字节模式 ★ qrcode 默认会做模式优化，小写字母的 URL 虽然
    #   落不进字母数字集，但显式指定才能保证"比的是同一件事"。
    qr.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE))
    qr.make(fit=False)
    return ["".join("1" if c else "0" for c in row) for row in qr.get_matrix()]


def diff(mine: list[str], ref: list[str]) -> str:
    if len(mine) != len(ref):
        return f"尺寸不同 {len(mine)} vs {len(ref)}"
    bad = []
    for y in range(len(ref)):
        if mine[y] != ref[y]:
            for x in range(min(len(mine[y]), len(ref[y]))):
                if mine[y][x] != ref[y][x]:
                    bad.append(f"({x},{y})")
    if not bad:
        return ""
    return f"{len(bad)} 个模块不符，前几个 {' '.join(bad[:5])}"


def main() -> int:
    try:
        import qrcode  # noqa: F401
    except ImportError:
        sys.exit("缺少 Python qrcode（pip install qrcode）—— 它是本检查的参考实现")

    dump = js_dump()
    ecl = dump["ecl"]
    print(f"参考实现：Python qrcode   JS 实现：web/js/qr.js   纠错等级：{ecl}\n")

    for case in dump["cases"]:
        text = case["text"]
        label = text if len(text) <= 46 else text[:46] + "…"
        print(f"[{label}]  JS 选中 v{case['version']} size={case['size']} "
              f"mask={case['autoMask']}")

        for k in range(8):
            ref = py_matrix(text, ecl, case["version"], k)
            d = diff(case["masks"][k], ref)
            ok(not d, f"mask {k} 与参考实现逐模块一致", d)

        ref_auto = py_matrix(text, ecl, case["version"], case["autoMask"])
        d = diff(case["auto"], ref_auto)
        ok(not d, f"自动掩码 {case['autoMask']} 亦与参考一致", d)

        # 版本选择也必须一致：参考实现按容量自选版本
        import qrcode
        from qrcode.util import MODE_8BIT_BYTE, QRData
        qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,
                           box_size=1, border=0)
        qr.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE))
        qr.make(fit=True)
        ok(qr.version == case["version"],
           f"版本选择一致（参考 v{qr.version} / JS v{case['version']}）")

    print(f"\n结果：{pass_n} 通过 / {fail_n} 失败\n")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
