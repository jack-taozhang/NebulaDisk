# -*- coding: utf-8 -*-
"""目录 → ZIP 的**流式**打包（给「文件夹分享」的打包下载用）。

为什么单独一个模块：这件事有两个独立、都容易写错的点，混在路由里必然漂移。

  一、★ 必须流式，而不是"先打成临时文件再发" ★
     分享的目录经常是几个 GB（样张里就有一个 75MB 的 PDF、
     一个 33MB 的 DWG）。落到 /tmp 再发：
       · NAS 上多占一份等量磁盘；
       · 用户要等"整包打完"才开始下载（几十秒的假死）；
       · 中途失败还得清理垃圾。
     所以直接边压边发。

  二、★ 上限必须在"开始发字节之前"判掉 ★
     HTTP 响应头一发出去就不能反悔了 —— 发送途中才发现超限，
     只能在半个 ZIP 后面接一段错误文本，用户拿到的是**坏包**却看不出原因。
     所以 plan_*() + total_of() 先把计划走一遍（只读元数据，NAS 上很快），
     超限直接返回 413，一个字节都不发。

  三、★ 符号链接一律跳过 ★
     链接可以指向分享范围之外（甚至 /etc）。打进包里等于把范围外的东西
     送给了访客 —— 那就是越权，和 path=../../ 是同一类问题。
     分享的路径校验只管到"根"，管不到树里面的链接，只能在遍历时挡。
"""

from __future__ import annotations

import queue
import threading
import zipfile
from collections.abc import Iterator
from pathlib import Path

# ---------------------------------------------------------------------------
# 上限：与 files.py 里「解压」那边的护栏同一尺度（家用 NAS 的合理值）
#   条目 5 万 / 总量 20GB —— 再大就更该让人自己分目录，
#   而且超限时给的是**明确报错**，不是半个包。
# ---------------------------------------------------------------------------
MAX_ENTRIES = 50000
MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024
# 队列深度：worker 线程比消费者最多领先这么多块，内存占用因此有上界
#   （zipfile 每块 8KB，64 块 ≈ 512KB，与目录大小无关）。
_QUEUE_DEPTH = 64


class ZipLimitExceeded(Exception):
    """目录超出打包上限。由调用方翻译成 HTTP 状态码（413）。"""


def _walk_files(root: Path) -> Iterator[Path]:
    """按名字序深度优先列出 root 下的所有**普通文件**（跳过符号链接）。"""
    try:
        entries = sorted(root.iterdir(), key=lambda x: x.name)
    except OSError:
        # 目录读不动（权限/被删）：当作空目录，不让整个打包失败
        return
    for e in entries:
        if e.is_symlink():
            continue                      # 见模块头「三」
        if e.is_dir():
            yield from _walk_files(e)
        elif e.is_file():
            yield e


# ---------------------------------------------------------------------------
# ★ 打包计划（plan）★
#   打"整个目录"和打"用户勾选的那几项"是同一件事的两副面孔：
#   都是「一组 (真实路径, 包内路径)」。所以先把两种输入都归约成一张**计划表**，
#   后面三条腿（预检上限 / 流式建包 / 空包判断）就只认这一种结构，
#   不会再出现"整目录那条路加了护栏、选择集那条路忘了加"这种漏。
# ---------------------------------------------------------------------------
Plan = list[tuple[Path, str]]


def plan_dir(root: Path, arc_prefix: str = "") -> Plan:
    """整个目录 → 计划：每条目为 `<arc_prefix>/<相对路径>`。"""
    prefix = arc_prefix.strip("/")
    out: Plan = []
    for f in _walk_files(root):
        rel = f.relative_to(root).as_posix()
        out.append((f, f"{prefix}/{rel}" if prefix else rel))
    return out


def plan_items(entries: list[tuple[Path, str]]) -> Plan:
    """勾选项 → 计划：目录项展开成它下面的所有文件，文件项原样收下。

    ★ 勾选的项直接落在包**根**（不套外层目录）★
      用户点的是"这几项"，解压出来就该正好是这几项。
      只勾一个文件夹时，它会以自己为名落在根上 —— 也正确。
    """
    out: Plan = []
    for p, arc in entries:
        name = (arc or "").strip("/")
        if not name:
            continue
        if p.is_dir():
            for f in _walk_files(p):
                out.append((f, f"{name}/{f.relative_to(p).as_posix()}"))
        elif p.is_file():
            out.append((p, name))
    return out


def total_of(plan: Plan) -> tuple[int, int]:
    """预检：返回 (文件数, 总字节)。超限抛 ZipLimitExceeded。

    ★ 只 stat 不读内容 ★ 所以在 NAS 上扫几十 GB 的计划也是毫秒级。
    """
    n = 0
    total = 0
    for p, _arc in plan:
        try:
            st = p.stat()
        except OSError:
            continue                      # 扫描期间被删掉的文件，忽略
        n += 1
        total += st.st_size
        if n > MAX_ENTRIES:
            raise ZipLimitExceeded(f"条目数超过上限（{MAX_ENTRIES}）")
        if total > MAX_TOTAL_BYTES:
            raise ZipLimitExceeded(
                f"总大小超过上限（{MAX_TOTAL_BYTES // (1024 ** 3)} GB）")
    return n, total


class _QueueWriter:
    """塞进队列的"可写文件"。

    ★ 刻意**不实现 tell()** ★
      zipfile 在建包时会 `fp.tell()` 探测能不能回退改字节；探测不到就切到
      「不可 seek」模式，改用 data descriptor 把长度写在每个条目**之后**。
      我们这里根本没有可回退的目标（数据已经发到浏览器了），
      所以"探测失败"正是我们想要的结果 —— 提供一个假的 tell() 会让 zipfile
      按可 seek 处理，然后在结束时要 seek 回去改中央目录偏移量，
      轻则包损坏，重则抛异常。
    """

    __slots__ = ("_q",)

    def __init__(self, q: "queue.Queue[tuple[str, object]]") -> None:
        self._q = q

    def write(self, b) -> int:
        if b:
            self._q.put(("data", bytes(b)))      # 队列满则阻塞 ⇒ 反压
        return len(b)

    def flush(self) -> None:
        return None


def iter_zip(plan: Plan) -> Iterator[bytes]:
    """按计划流式产出 ZIP 字节块。

    实现是「worker 线程建包 + 生成器消费队列」：
      · zipfile 只会写文件对象，没法直接 yield；
      · 若改成"写进内存缓冲、条目之间再 yield"，单个大文件就会把整包
        压缩结果憋在内存里（样张里那个 75MB 的 PDF 解压后就 75MB）；
      · 队列 + 反压让内存恒定在几十个块，且**边压边发**。
    """
    q: "queue.Queue[tuple[str, object]]" = queue.Queue(maxsize=_QUEUE_DEPTH)
    q_writer = _QueueWriter(q)

    def _work() -> None:
        try:
            # compresslevel=1：NAS 的 CPU 是瓶颈，而这些分享目录里
            # 大量是已压缩过的图纸/PDF/图片，压缩级别拉高换不来体积、
            # 只换来更长的等待。
            with zipfile.ZipFile(q_writer, "w", zipfile.ZIP_DEFLATED,
                                 allowZip64=True, compresslevel=1) as zf:
                for p, arc in plan:
                    try:
                        zf.write(p, arc)
                    except OSError:
                        # 单个文件读不到（打包途中被删/无权限）不该毁掉整包，
                        # 少一个条目总好过什么都没拿到。
                        continue
        except Exception as e:                     # noqa: BLE001 —— 转交主线程再抛
            q.put(("err", e))
        finally:
            q.put(("end", None))

    th = threading.Thread(target=_work, name="nebula-zip", daemon=True)
    th.start()

    try:
        while True:
            kind, data = q.get()
            if kind == "end":
                break
            if kind == "err":
                raise data
            yield data                                 # type: ignore[misc]
    finally:
        # 消费者提前退出（客户端断开 / 上层不再迭代）：
        # 把队列抽干，让 worker 有机会跑完并自己退出，
        # 而不是永久堵在一个满队列上。worker 是 daemon，
        # 万一它还堵着也不会拖住进程退出。
        while True:
            try:
                q.get_nowait()
            except queue.Empty:
                break
        th.join(timeout=5)
