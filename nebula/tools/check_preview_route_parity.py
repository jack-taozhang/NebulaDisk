# -*- coding: utf-8 -*-
"""check_preview_route_parity.py —— 静态闸门：预览路由「三方一致」

★★ 为什么要有它（2026-09-30 用户报障）★★
   用户原话：「/s/页面上的预览路由和网盘的路由不一致，需要调整为一样」。

   同一个文件在三个地方会被判定「用哪个引擎打开」，而它们**各写各的**：

     ① 后端 app/config.py 的 route_of()      —— 唯一真相来源（list/stat 的 entry.route）
     ② 网盘 web/js/viewer.js 的 kindOf()     —— 桌面端 open() 的决策树
     ③ 分享页 web/js/share.js 的 kindOf()    —— /s/ 落地页的决策树

   事故现场：③ 原来只做了「图片 / 其它」两分，其余全丢给 kkFileView
   ⇒ 同一个 DWG 在网盘里由 cad-viewer 渲染，在分享页却被 kkFileView 打开；
     视频/音频/纯文本也从「浏览器原生、零转换」退化成 kk 的转换预览。
   这类漂移**不会报错**，只会让两个页面表现不同 —— 靠人工比对必然复发。

判据（只读源码，四条，全部是「相等」这种不可能误判的关系）：
  [1] nativeKind 的四个扩展名表：viewer.js 与 share.js **逐项相同**
  [2] kindOf 的判定**顺序**：viewer.js 与 share.js 相同
      （顺序 = 引擎优先级，顺序变了就等于换了引擎：csv 归 OnlyOffice，
        若把 native 提到 onlyoffice 前面，csv 就变成纯文本预览了）
  [3] 上述顺序与后端 route_of() 的返回顺序不矛盾
  [4] 分享预览接口（share_guest.py）认得的 route 词表
      与 route_of() 的返回值集合一致
      （漏一个 = 该类型在分享页静默退化成 kk，正是本次事故的形态）

  ★ 只看 AST/正则，不执行 JS，也不起服务 ★
    所以它能进 run_static_checks.sh，在没有 docker、没有网络的机器上跑。

用法：
  python tools/check_preview_route_parity.py              # 扫仓库
  python tools/check_preview_route_parity.py --selftest   # 自检（临时夹具，断言恰好报出预期问题）
  python tools/check_preview_route_parity.py --root DIR   # 指定一个含 web/js + app/ 的目录
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                      # nebula/

KINDS = ("image", "video", "audio", "text")
ROUTES = ("cad", "onlyoffice", "kkfileview", "download")

# `if ([...].includes(ext)) return 'image';` —— 允许 if 与 return 跨行
RE_KIND_LIST = re.compile(
    r"""if\s*\(\s*\[([^\]]*)\]\s*\.includes\(\s*ext\s*\)\s*\)\s*return\s*
        ['"](image|video|audio|text)['"]""",
    re.VERBOSE,
)
RE_QUOTED = re.compile(r"""['"]([^'"]+)['"]""")

# kindOf 里的判定点（顺序即优先级）：`xxx.route === 'cad'` / `nativeKind(ext)`
RE_ORDER_MARK = re.compile(
    r"""\.route\s*===\s*['"](cad|onlyoffice|kkfileview)['"]|\bnativeKind\s*\("""
)

# 后端：route_of() 里的 `return "cad"`
RE_PY_RETURN = re.compile(r"""return\s+['"](cad|onlyoffice|kkfileview|download)['"]""")


# ---------------------------------------------------------------------------
# 取函数体（花括号配对；先剥注释，避免注释里的 { } 干扰）
# ---------------------------------------------------------------------------
def _strip_js_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    # 行注释：只在「行首到 // 之间没有引号」时才是注释 —— 简化处理：
    # 目标函数里不存在带 // 的字符串字面量（没有 URL），直接剥即可。
    src = re.sub(r"(?m)^\s*//.*$", "", src)
    src = re.sub(r"(?m)(?<=[;{}])\s*//[^\n]*$", "", src)
    return src


def js_function_body(src: str, name: str) -> str:
    """取出 `function name(...) { ... }` 的函数体（不含签名）。"""
    m = re.search(r"function\s+%s\s*\(" % re.escape(name), src)
    if not m:
        raise LookupError("找不到函数 %s()" % name)
    i = src.index("{", m.end() - 1)
    depth = 0
    for j in range(i, len(src)):
        c = src[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[i + 1:j]
    raise LookupError("函数 %s() 的花括号不配对" % name)


def parse_ext_tables(js_path: Path) -> dict:
    """{kind: frozenset(ext...)}"""
    body = js_function_body(_strip_js_comments(js_path.read_text(encoding="utf-8")),
                            "nativeKind")
    out = {}
    for m in RE_KIND_LIST.finditer(body):
        exts = frozenset(e.lower() for e in RE_QUOTED.findall(m.group(1)))
        out[m.group(2)] = exts
    return out


def parse_route_order(js_path: Path) -> list:
    """kindOf() 里的判定顺序，规范成 ['cad','onlyoffice','native','kkfileview']"""
    body = js_function_body(_strip_js_comments(js_path.read_text(encoding="utf-8")),
                            "kindOf")
    marks = []
    for m in RE_ORDER_MARK.finditer(body):
        marks.append(m.group(1) or "native")
    # 去掉重复（同一判定可能因 if/else 出现两次）
    dedup = []
    for x in marks:
        if not dedup or dedup[-1] != x:
            dedup.append(x)
    return dedup


def parse_route_of(py_path: Path) -> list:
    """config.py 的 route_of() 返回顺序。"""
    src = py_path.read_text(encoding="utf-8")
    m = re.search(r"def\s+route_of\s*\(", src)
    if not m:
        raise LookupError("找不到 route_of()")
    body = _py_function_body(src, m.start())
    out = []
    for x in RE_PY_RETURN.findall(body):
        if x not in out:
            out.append(x)
    return out


def _py_function_body(src: str, start: int) -> str:
    """Python 版函数体截取：从 def 行到下一个顶层的 def/class（够用即可）。

    ★ 下游只在里面找「字面量」★
      多截进来的常量块（如 route_of 后面的 DANGEROUS_EXT）不影响判定，
      因为判据是 `return "cad"` 这种精确形状 / 四个 route 词。
    """
    lines = src[start:].splitlines()
    body = [lines[0]]
    for ln in lines[1:]:
        if re.match(r"^(async\s+)?def\s|^class\s", ln):
            break
        body.append(ln)
    return "\n".join(body)


def parse_share_routes(py_path: Path) -> set:
    """share_guest.py 的分享预览接口认得哪些 route。"""
    src = py_path.read_text(encoding="utf-8")
    m = re.search(r"async\s+def\s+api_share_preview\s*\(", src)
    if not m:
        raise LookupError("找不到 api_share_preview()")
    body = _py_function_body(src, m.start())
    return {r for r in ROUTES if re.search(r"""['"]%s['"]""" % r, body)}


# ---------------------------------------------------------------------------
# 检查
# ---------------------------------------------------------------------------
def check(root: Path) -> list:
    """返回问题列表（人类可读）。空列表 = 通过。"""
    problems = []
    viewer = root / "web" / "js" / "viewer.js"
    share = root / "web" / "js" / "share.js"
    config = root / "app" / "config.py"
    guest = root / "app" / "routers" / "share_guest.py"
    for f in (viewer, share, config, guest):
        if not f.exists():
            problems.append("缺少文件：%s" % f)
    if problems:
        return problems

    # [1] 扩展名表
    t_viewer = parse_ext_tables(viewer)
    t_share = parse_ext_tables(share)
    for k in KINDS:
        a, b = t_viewer.get(k, frozenset()), t_share.get(k, frozenset())
        if not a:
            problems.append("viewer.js 的 nativeKind() 里没有 '%s' 这一组" % k)
        if not b:
            problems.append("share.js 的 nativeKind() 里没有 '%s' 这一组" % k)
        if a != b:
            problems.append(
                "nativeKind 的 '%s' 表不一致：viewer 独有 %s；share 独有 %s"
                % (k, sorted(a - b) or "无", sorted(b - a) or "无"))

    # [2] 判定顺序
    o_viewer = parse_route_order(viewer)
    o_share = parse_route_order(share)
    if o_viewer != o_share:
        problems.append("kindOf 的判定顺序不一致：viewer=%s，share=%s"
                        % (" → ".join(o_viewer) or "空",
                           " → ".join(o_share) or "空"))
    if "native" not in o_share or "kkfileview" not in o_share:
        problems.append("share.js 的 kindOf() 没把「原生类型」放在 kkfileview 之前"
                        "（少了 native 或 kkfileview 判定）")

    # [3] 与后端 route_of 的顺序不矛盾
    o_backend = parse_route_of(config)
    js_routes = [x for x in o_share if x in ROUTES]
    common = [r for r in o_backend if r in js_routes]
    if common != js_routes:
        problems.append("后端 route_of 的顺序 %s 与前端 kindOf 的顺序 %s 矛盾"
                        % (" → ".join(o_backend) or "空", " → ".join(js_routes) or "空"))

    # [4] 分享预览接口的 route 词表
    got = parse_share_routes(guest)
    expect = set(o_backend)
    if got != expect:
        problems.append("share_guest.py 的预览接口 route 词表 %s 与 route_of 的返回值 %s 不一致"
                        % (sorted(got) or "空", sorted(expect) or "空"))
    return problems


def report(root: Path) -> int:
    print("  扫描根：%s" % root)
    try:
        t_viewer = parse_ext_tables(root / "web" / "js" / "viewer.js")
        t_share = parse_ext_tables(root / "web" / "js" / "share.js")
        o_viewer = parse_route_order(root / "web" / "js" / "viewer.js")
        o_share = parse_route_order(root / "web" / "js" / "share.js")
        o_backend = parse_route_of(root / "app" / "config.py")
        got = parse_share_routes(root / "app" / "routers" / "share_guest.py")
    except (LookupError, OSError) as e:
        print("    ❌ 解析失败：%s" % e)
        return 1

    print("    [1] nativeKind 扩展名表")
    for k in KINDS:
        a, b = t_viewer.get(k, frozenset()), t_share.get(k, frozenset())
        flag = "✅" if a and a == b else "❌"
        print("        %-6s viewer %2d 项 / share %2d 项 %s" % (k, len(a), len(b), flag))
    print("    [2] kindOf 优先级")
    print("        viewer.js : %s" % (" → ".join(o_viewer) or "空"))
    print("        share.js  : %s %s" % (" → ".join(o_share) or "空",
                                        "✅" if o_viewer == o_share else "❌"))
    print("    [3] 后端 config.route_of()")
    print("        %s" % (" → ".join(o_backend) or "空"))
    print("    [4] 分享预览接口 route 词表")
    print("        %s %s" % (", ".join(sorted(got)) or "空",
                            "✅" if got == set(o_backend) else "❌"))

    problems = check(root)
    if problems:
        print()
        for p in problems:
            print("    ❌ %s" % p)
        return 1
    return 0


def selftest() -> int:
    """拿夹具跑一遍：必须**恰好**报出预期的问题，正例不许被误伤。"""
    tmp = Path(tempfile.mkdtemp(prefix="routeparity-"))
    ok = True
    try:
        base = tmp / "good"
        (base / "web" / "js").mkdir(parents=True)
        (base / "app" / "routers").mkdir(parents=True)

        # —— 正例：三处完全对齐 ——
        (base / "web" / "js" / "viewer.js").write_text(
            "function nativeKind(ext) {\n"
            "  if (['jpg','png'].includes(ext)) return 'image';\n"
            "  if (['mp4'].includes(ext)) return 'video';\n"
            "  if (['mp3'].includes(ext)) return 'audio';\n"
            "  if (['txt'].includes(ext)) return 'text';\n"
            "  return null;\n"
            "}\n"
            "function kindOf(entry, path) {\n"
            "  if (entry.route === 'cad') return 'cad';\n"
            "  if (entry.route === 'onlyoffice') return 'onlyoffice';\n"
            "  const n = nativeKind(ext);\n"
            "  if (n) return n;\n"
            "  if (entry.route === 'kkfileview') return 'kkfileview';\n"
            "  return null;\n"
            "}\n", encoding="utf-8")
        (base / "web" / "js" / "share.js").write_text(
            "function nativeKind(ext) {\n"
            "  if (['png','jpg'].includes(ext)) return 'image';\n"
            "  if (['mp4'].includes(ext)) return 'video';\n"
            "  if (['mp3'].includes(ext)) return 'audio';\n"
            "  if (['txt'].includes(ext)) return 'text';\n"
            "  return null;\n"
            "}\n"
            "function kindOf(e) {\n"
            "  if (e.route === 'cad') return 'cad';\n"
            "  if (e.route === 'onlyoffice') return 'onlyoffice';\n"
            "  const native = nativeKind(ext);\n"
            "  if (native) return native;\n"
            "  if (e.route === 'kkfileview') return 'kkfileview';\n"
            "  return null;\n"
            "}\n", encoding="utf-8")
        (base / "app" / "config.py").write_text(
            "def route_of(name):\n"
            "    if cad: return \"cad\"\n"
            "    if oo:  return \"onlyoffice\"\n"
            "    if kk:  return \"kkfileview\"\n"
            "    return \"download\"\n"
            "def other():\n", encoding="utf-8")
        (base / "app" / "routers" / "share_guest.py").write_text(
            "async def api_share_preview(token):\n"
            "    if r == \"cad\": pass\n"
            "    if r == \"onlyoffice\": pass\n"
            "    if r == \"kkfileview\": pass\n"
            "    return {\"route\": \"download\"}\n"
            "async def other():\n", encoding="utf-8")

        good = check(base)
        if good:
            print("    ❌ 正例被误报（假红）：%s" % good)
            ok = False
        else:
            print("    ✅ 正例（三处对齐）无误报")

        # —— 坏例 A：share.js 少一个扩展名 + 优先级错位 ——
        badA = tmp / "bad_a"
        shutil.copytree(base, badA)
        (badA / "web" / "js" / "share.js").write_text(
            "function nativeKind(ext) {\n"
            "  if (['jpg','png'].includes(ext)) return 'image';\n"
            "  if (['mp4'].includes(ext)) return 'video';\n"
            "  if (['mp3','wav'].includes(ext)) return 'audio';\n"     # wav 是多的
            "  if (['txt'].includes(ext)) return 'text';\n"
            "  return null;\n"
            "}\n"
            "function kindOf(e) {\n"
            "  if (e.route === 'cad') return 'cad';\n"
            "  const native = nativeKind(ext);\n"                      # native 跑到 oo 前面
            "  if (native) return native;\n"
            "  if (e.route === 'onlyoffice') return 'onlyoffice';\n"
            "  if (e.route === 'kkfileview') return 'kkfileview';\n"
            "  return null;\n"
            "}\n", encoding="utf-8")
        pa = check(badA)
        n_audio = any("'audio' 表不一致" in p for p in pa)
        n_order = any("kindOf 的判定顺序不一致" in p for p in pa)
        if n_audio and n_order:
            print("    ✅ 坏例 A 被抓到（扩展名表 + 优先级，共 %d 处）" % len(pa))
        else:
            print("    ❌ 坏例 A 漏检（表=%s 顺序=%s）：%s" % (n_audio, n_order, pa))
            ok = False

        # —— 坏例 B：分享预览接口漏了 cad ——
        badB = tmp / "bad_b"
        shutil.copytree(base, badB)
        (badB / "app" / "routers" / "share_guest.py").write_text(
            "async def api_share_preview(token):\n"
            "    if r == \"onlyoffice\": pass\n"
            "    if r == \"kkfileview\": pass\n"
            "    return {\"route\": \"download\"}\n", encoding="utf-8")
        pb = check(badB)
        if any("route 词表" in p and "cad" in p for p in pb):
            print("    ✅ 坏例 B 被抓到（分享接口漏 cad）")
        else:
            print("    ❌ 坏例 B 漏检：%s" % pb)
            ok = False

        # —— 坏例 C：viewer.js 函数被改名（护栏自己别假装通过）——
        badC = tmp / "bad_c"
        shutil.copytree(base, badC)
        (badC / "web" / "js" / "viewer.js").write_text(
            "function nativeKind2(ext) { return null; }\n", encoding="utf-8")
        try:
            check(badC)
            print("    ❌ 坏例 C：解析不到函数却返回了结果（护栏失效）")
            ok = False
        except LookupError:
            print("    ✅ 坏例 C：解析不到函数时明确报错（不假装通过）")

        return 0 if ok else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--root", default=None, help="仓库根（含 web/js 与 app/）")
    args = ap.parse_args()

    if args.selftest:
        print("  ── 自检（临时夹具）──")
        rc = selftest()
        print("  " + ("✅ 自检通过" if rc == 0 else "❌ 自检未通过"))
        return rc

    root = Path(args.root).resolve() if args.root else ROOT
    rc = report(root)
    print("  " + ("✅ 预览路由三方一致" if rc == 0 else "❌ 预览路由存在不一致"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
