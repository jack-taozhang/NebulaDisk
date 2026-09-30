# -*- coding: utf-8 -*-
"""_test_search_async.py —— /api/search 不许把事件循环占死（回归闸门）

★ 为什么要单写这一套（2026-10-01 真实事故）★★

  用户点一下「搜索」，**整个网盘全挂**：
    · 浏览器里所有页面转圈，别人的目录也打不开
    · `curl /healthz` 从 Windows / WSL / 容器内**三处**都返回 000
    · `docker ps` 显示 `nebula Up 8 minutes (unhealthy)`
    · `docker restart` 后能好 15~20 秒，一搜索立刻复现 —— 100% 可重现

  py-spy 抓到的栈（唯一证据，值得抄在测试里）：

      Thread 9 (idle): "MainThread"
          stat (pathlib.py:842)
          is_dir (pathlib.py:877)
          api_search (app/routers/fileops.py:386)

  ⇒ `api_search` 是 `async def`，却在里面**同步**跑 `os.walk` + 逐个
    `Path.is_dir()`。本进程是**单 worker 的 uvicorn**（见
    deploy/nebula-entrypoint.sh 的启动行，没有 --workers），
    于是「一次遍历」= 「整个事件循环借出去」，连纯内存的 /healthz 都排不上队。
    这和 preview.py 里记的「压缩包自愈把单 worker 交给一次解压」是同一类故障。

★ 本闸门怎么证明「不再占死」★

  量具是一个 **ticker 协程**：每 10ms 跳一次，数「搜索期间事件循环还能被调度几次」。

    [B] 量具自检：**故意**同步调用扫描内核 → ticker 必须一次都跑不动
        （如果有人把 ticker 写坏成"恒真"，本项立刻变红 ⇒ 量具本身也被守着）
    [C] 正题：`await api_search(...)` → ticker 必须照常跳
    [D] 并发：4 个搜索同时跑 → 仍然照常跳（证明是线程池，不是"只把同步挪了个位置"）
    [E] 静态兜底：`api_search` 的源码里**不许**再出现 os.walk

  A 段同时守住第 5 条功能本身（后缀名 + 子目录递归），
  免得「为了跑得快」把功能改没了。

运行：
  python nebula/tools/_test_search_async.py
退出码：0 = 全绿
"""

from __future__ import annotations

import asyncio
import ast
import inspect
import os
import sys
import tempfile
import textwrap
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

# ---- 必须在 import app 之前把环境设好（settings 是 import 期读的）----
_TMP = Path(tempfile.mkdtemp(prefix="nebula-search-async-"))
_MP = _TMP / "盘"
_MP.mkdir(parents=True, exist_ok=True)

_SUBDIRS = 6
_INNER_PER_DIR = 3
for i in range(_SUBDIRS):
    d = _MP / f"子目录{i}"
    d.mkdir(parents=True, exist_ok=True)
    for j in range(_INNER_PER_DIR):
        (d / f"内层{i}_{j}.txt").write_text("x\n", encoding="utf-8")
    (d / f"图{i}.PNG").write_bytes(b"\x89PNG\r\n\x1a\n")
(_MP / "顶层.txt").write_text("t\n", encoding="utf-8")
(_MP / "手记.md").write_text("m\n", encoding="utf-8")

os.environ.setdefault("NEBULA_DATA_DIR", str(_TMP / "data"))
os.environ["NEBULA_MOUNTS"] = f"盘|{_MP}|*"
os.environ["NEBULA_ADMIN_USER"] = "admin"
os.environ["NEBULA_ADMIN_PASSWORD"] = "TestPass@2026"
os.environ.setdefault("NEBULA_JWT_SECRET", "test-secret-do-not-use-in-prod")

from app import files, users  # noqa: E402
from app.routers import fileops as fo  # noqa: E402

pass_n = 0
fail_n = 0


def ok(cond, name, extra=""):
    """★ 参数序固定为 ok(条件, 说明) ★
    本仓库另一套脚手架（.verify/verify-share-route.mjs）用的是 ok(说明, 条件)，
    把两套的参数序搞混过一次，结果 10 条断言全"通过"却打印的是 true。
    这里显式写明，改的人别改序。
    """
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \u2705 {name}")
    else:
        fail_n += 1
        print(f"  \u274c {name}" + (f"  \u2192 {extra}" if extra else ""))


def _code_only(fn) -> str:
    """取 fn 的源码，**剥掉注释与文档字符串**，只留真正的代码。

    ★ 为什么非剥不可（[E] 的负向自检抓到的假绿）★
      第一版写的是 `"run_in_threadpool" in inspect.getsource(fn)`。
      负向自检时把调用改成同步、却留着注释里那句说明 —— 断言**照样绿**。
      注释里出现过的名字证明不了任何事。
      ast.unparse 天然丢弃注释、docstring 也能显式摘掉，比正则可靠。
    """
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    _strip_docstrings(tree)
    return ast.unparse(tree)


_SCOPES = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def _strip_docstrings(node) -> None:
    """就地摘掉 node 树里所有「作用域节点」的第一条字符串语句（docstring）。

    ★ 用显式递归 + list(...) 快照，不用 ast.walk ★
      ast.walk 是惰性生成器，边遍历边从 body 里 pop 会漏掉节点。
    """
    if isinstance(node, _SCOPES):
        body = node.body
        if body and isinstance(body[0], ast.Expr) \
                and isinstance(body[0].value, ast.Constant) \
                and isinstance(body[0].value.value, str):
            body.pop(0)
    for child in list(ast.iter_child_nodes(node)):
        _strip_docstrings(child)


# ---------------------------------------------------------------------------
# 慢速 os.walk 替身
# ---------------------------------------------------------------------------
REAL_WALK = os.walk
SLOW_DIRS = 12       # 假遍历最多吐多少个目录
SLOW_DELAY = 0.03    # 每个目录睡多久 ⇒ 总计约 0.36s

_walk_calls = 0


def slow_walk(top, *a, **kw):
    """真遍历 + 每个目录 sleep 一会儿。

    需求很简单：**让扫描足够久**，久到"如果它占着事件循环，ticker 一跳都跑不动"。
    0.36s vs ticker 的 10ms 一跳 ⇒ 不阻塞时应有 ~35 跳，阻塞时 0~1 跳，
    两个数量级的差距，不靠运气。
    """
    global _walk_calls
    _walk_calls += 1
    n = 0
    for item in REAL_WALK(top, *a, **kw):
        time.sleep(SLOW_DELAY)
        n += 1
        yield item
        if n >= SLOW_DIRS:
            return


async def measure(fn, *args, **kwargs):
    """跑 `await fn(*args, **kwargs)`，返回 (结果, ticker 跳数)。

    ticker 跳数 = 在这次调用期间事件循环还能调度多少次。
      · 同步就地阻塞 → 0 或 1（阻塞结束后定时器才一次性补上）
      · 卸载到线程池 → 与耗时成正比（本测试里 ≥ 10）
    """
    ticks = 0
    stop = False

    async def ticker():
        nonlocal ticks
        while not stop:
            await asyncio.sleep(0.01)
            ticks += 1

    t = asyncio.create_task(ticker())
    await asyncio.sleep(0)   # 让 ticker 先跑到自己的第一个 await
    try:
        res = await fn(*args, **kwargs)
    finally:
        stop = True
        await asyncio.sleep(0)
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
    return res, ticks


def main() -> int:
    # ★ 必须声明 global ★
    #   否则 main 里那句 `_walk_calls = 0` 会把 _walk_calls 变成 main 的**局部**
    #   变量，而 slow_walk 递增的是模块级那个 —— 断言永远读到 0，必红。
    global _walk_calls

    users.init_db()

    mount = files.get_mount("盘", "admin")
    root = files._resolve_root(mount)
    base_dir = files.resolve(mount, "")
    user = {"username": "admin"}

    # =======================================================================
    print("\n[A] 前置：第 5 条功能本身还得是对的（后缀名 + 子目录）")
    # =======================================================================
    res = asyncio.run(fo.api_search(mount="盘", q="*.txt", user=user))
    ok(res.get("ok") is True, "api_search 正常返回 ok=True")
    hits = res.get("hits") or []
    names = [h["name"] for h in hits]
    expect = _SUBDIRS * _INNER_PER_DIR + 1      # 18 个内层 + 1 个顶层
    ok(len(names) >= expect,
       f"递归到子目录里去了（期望 ≥{expect} 条 .txt）", f"实际 {len(names)}")
    ok(any(str(h["path"]).startswith("/子目录") for h in hits),
       "命中项自带**子目录**相对路径（不是只有根级）")
    ok(all(n.lower().endswith(".txt") for n in names),
       "«*.txt» 只回 .txt —— 后缀过滤真的生效", f"实际 {names[:5]}")

    res_png = asyncio.run(fo.api_search(mount="盘", q=".png", user=user))
    ok(len(res_png["hits"]) == _SUBDIRS,
       f"«.png» 等价于 «*.png»（期望 {_SUBDIRS} 条）", f"实际 {len(res_png['hits'])}")

    res_pdf = asyncio.run(fo.api_search(mount="盘", q="pdf", user=user))
    ok(len(res_pdf["hits"]) == 0, "负向对照：盘上确实没有 pdf，不能凭空给结果")

    res_kw = asyncio.run(fo.api_search(mount="盘", q="内层", user=user))
    ok(len(res_kw["hits"]) >= expect - 1, "关键词子串搜索仍然可用")

    # =======================================================================
    print("\n[B] 量具自检：同步扫描时 ticker 必须**一次都跑不动**")
    # =======================================================================
    # 这一段是**常驻的负向自检**：如果有人把 measure/ticker 写坏
    # （比如 ticker 不真的 await，或者 measure 没把任务挂上去），
    # [B] 就会红 —— 那么 [C] 的"全绿"也就没有意义。
    # 反过来，只要 [B] 是绿的，[C] 的"ticker 照常跳"就确实是"事件循环没被占"。
    terms = fo._search_terms("txt")
    cap, off = 500, 0

    async def blocking_case():
        # 故意**同步就地**调用扫描内核 —— 这正是 2026-10-01 那一版的写法
        return fo._search_scan(base_dir, root, terms, cap, off, "盘")

    _walk_calls = 0
    _saved = fo.os.walk
    fo.os.walk = slow_walk
    try:
        _bres, bticks = asyncio.run(measure(blocking_case))
    finally:
        fo.os.walk = _saved

    ok(_walk_calls > 0, "（量具自检）慢速 walk 确实被调用了，不是空跑")
    ok(bticks <= 2,
       "（量具自检）同步扫描期间 ticker 几乎不动 ⇒ 量具真的能测出「占死事件循环」",
       f"ticker 跳了 {bticks} 次（期望 ≤2）")

    # =======================================================================
    print("\n[C] 正题：await api_search(...) 期间 ticker 必须照常跳")
    # =======================================================================
    _walk_calls = 0
    _saved = fo.os.walk
    fo.os.walk = slow_walk
    try:
        res2, ticks = asyncio.run(measure(fo.api_search, mount="盘", q="txt", user=user))
    finally:
        fo.os.walk = _saved

    ok(_walk_calls > 0, "（正题）慢速 walk 确实被调用了")
    ok(ticks >= 10,
       "搜索期间事件循环**照常被调度** ⇒ 扫描确实离开了事件循环",
       f"ticker 跳了 {ticks} 次（期望 ≥10；同步阻塞时只有 ≤2）")
    ok(ticks > bticks * 5,
       "「线程池」与「同步阻塞」拉开数量级（不是碰巧快了一点）",
       f"线程池 {ticks} vs 同步 {bticks}")
    ok((res2.get("hits") or []) and res2.get("ok") is True,
       "卸载到线程池后结果依然是完整的（没有为了不阻塞把活干丢）")

    # =======================================================================
    print("\n[D] 并发：4 个搜索同时跑，事件循环仍然不被占死")
    # =======================================================================
    _walk_calls = 0
    _saved = fo.os.walk
    fo.os.walk = slow_walk
    try:
        async def four():
            return await asyncio.gather(
                fo.api_search(mount="盘", q="txt", user=user),
                fo.api_search(mount="盘", q="png", user=user),
                fo.api_search(mount="盘", q="md", user=user),
                fo.api_search(mount="盘", q="内层", user=user),
            )

        _cres, cticks = asyncio.run(measure(four))
    finally:
        fo.os.walk = _saved

    ok(len(_cres) == 4, "4 个并发搜索都返回了")
    ok(all(r.get("ok") is True for r in _cres), "4 个并发搜索的结果都 ok")
    ok(cticks >= 10, "并发搜索期间事件循环照常被调度（线程池真的在并发干活）",
       f"ticker 跳了 {cticks} 次")

    # =======================================================================
    print("\n[E] 静态兜底：api_search 的源码里不许再出现 os.walk")
    # =======================================================================
    # 为什么还要静态查一遍：
    #   时间断言会受机器负载影响（极慢的机器上可能偶发假红）。
    #   这一条是**确定性**的：只要有人把遍历挪回 async 函数体，它必红。
    #   两条一起守着 —— 一条防"改错"，一条防"改回去"。
    src = _code_only(fo.api_search)
    ok("os.walk(" not in src,
       "api_search（async）里没有 os.walk —— 遍历不在事件循环上")
    ok("run_in_threadpool" in src,
       "api_search 通过 run_in_threadpool 外派扫描")
    ok("os.walk(" in _code_only(fo._search_scan),
       "真正的遍历在 _search_scan（同步内核）里")

    print(f"\n结果：{pass_n} 通过 / {fail_n} 失败\n")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
