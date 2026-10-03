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
  [5] CAD 深链的**形态**：cad.py 与 share_guest.py 给出的地址必须同形
      —— **默认都不带 `&embed=1`（= 完整界面）**，
         且**都不许再套 /lite 外壳**。
      2026-10-03 事故：网盘那条已去掉 /lite（飞牛 App 的 WebView 在两层 iframe
      的内层里**不执行脚本** ⇒ CAD 一直转圈），分享页那条忘了改
      ⇒ 同一个图纸「网盘能开、分享页打不开」。
      这类漂移同样**不会报错**，只会在换设备/换入口时暴露。
      ★ 2026-10-04 契约反转（用户要求「CAD viewer 显示完整界面，包含菜单，
        工具条」）：embed=1 从「默认拼接」改为「**显式可选**」——
        判据随之换成三条，缺一不可：
          (a) 两边都**不许无条件**拼 &embed=1（否则又变成看不到菜单/工具条）；
          (b) cad.py 必须保留**条件拼接**（`inner + "&embed=1" if <cond>`）；
          (c) cad.py 的 /cad/ 代理必须仍认显式 `embed=1`（收 UI 的机制别删）。
  [6] 视频「能播」入口的**覆盖率**：所有会把视频字节直接交给浏览器的入口，
      都必须接入 H.265 探测/转码（即出现 `_detect_vcodec`）。
      目前三个入口：网盘 /api/play、分享页 /api/s/{t}/play、直链 /f/{t}。
      2026-10-03 事故：只给网盘那条腿接了转码，**分享页和直链都漏了**
      ⇒ 同一个 HEVC 视频「网盘能播、分享页/直链打不开」。
      （飞牛 App 的 Android WebView 不解 H.265；同一个文件电脑 Chrome 正常。）
      这是**语义性**检查（有没有接），参数是否一致靠「共用同一个函数」来保证。

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


# CAD 深链形态的判据（★ 2026-10-04 随契约反转重写 ★）
#   旧契约：默认拼 `&embed=1`（收 UI）。新契约：默认**完整界面**，
#   embed=1 只在调用方显式要求时才拼 —— 所以判据也换了一套：
#
#   `inner + "&embed=1" if <cond> else …` 这种**带条件**的拼接 = 新形态 ✅
#   `embed_inner = inner + "&embed=1"`    这种**无条件**的拼接 = 旧形态 ❌
#     （无条件 = 用户永远看不到 CAD 的菜单/工具条）
RE_EMBED_APPEND = re.compile(r"""\+\s*["']&embed=1["']""")
#   /cad/ 代理里对「显式要求收 UI」的判据：`"embed=1" in (request.url.query or "")`
#   机制被删掉时这条会转红（防止有人顺手把「收 UI」能力清空）。
RE_EMBED_OPTIN = re.compile(r"""["']embed=1["']\s+in\b""")
#   `lite_shell_url("cad", ...)` —— 一旦出现就说明又套回两层 iframe 了
RE_LITE_CAD = re.compile(r"""lite_shell_url\s*\(\s*["']cad["']""")
#   同一行里既拼了 &embed=1 又带 if ⇒ 是「条件拼接」（新形态）
RE_EMBED_COND_LINE = re.compile(r"""["']&embed=1["'][^\n]*\bif\b""")


def parse_cad_deeplink(py_path: Path) -> dict:
    """CAD 深链的形态（只扫**代码行**，跳过注释行）。

    返回：
      lite          又套了 /lite 外壳（❌）
      embed_uncond  **无条件**拼了 &embed=1（❌ 会让 CAD 看不到菜单/工具条）
      embed_cond    有条件地拼 &embed=1（✅ 新形态，仅 cad.py 期望为 True）
      embed_optin   /cad/ 代理仍认显式 embed=1（✅ 机制保留）
    """
    src = py_path.read_text(encoding="utf-8")
    # 只跳过整行注释：本项目里这几处注释都在独立行上，足够。
    code = "\n".join(ln for ln in src.splitlines()
                     if not ln.lstrip().startswith("#"))
    uncond = cond = False
    for ln in code.splitlines():
        if not RE_EMBED_APPEND.search(ln):
            continue
        if RE_EMBED_COND_LINE.search(ln):
            cond = True
        else:
            uncond = True
    return {
        "lite": bool(RE_LITE_CAD.search(code)),
        "embed_uncond": uncond,
        "embed_cond": cond,
        "embed_optin": bool(RE_EMBED_OPTIN.search(code)),
    }


# 视频「能播」的浏览器取流入口。
#   (相对路径, 说明) —— 每个文件里都应出现 `_detect_vcodec`（转码探测的调用点）。
#   ⚠️ 新增取流入口时**必须**加到这里，否则闸门不会替你看住它。
PLAY_ENTRY_FILES = [
    ("app/routers/fileops.py", "网盘 /api/play"),
    ("app/routers/share_guest.py", "分享页 /api/s/{token}/play"),
    # ★ 直链 `/f/{token}` **已从本清单移除**（2026-10-04）★
    #   它自 2026-10-04 起「只有一种行为 = 下载」（恒 `Content-Disposition:
    #   attachment`，没有 `dl` 参数、也没有内联预览分支）⇒ 它**不再把视频字节
    #   交给浏览器内联播放** ⇒ 不需要转码。反过来说：给下载链路转码 = **数据损坏**
    #   （用户下载到的就不是他上传的那个文件）。
    #   ⇒ 所以这里**不能**再加回来。判据原文见 app/routers/pages.py 的
    #     `short_open()`（搜「只有一种行为」）。
]
PLAY_MARKER = re.compile(r"\b_detect_vcodec\b")
# ★ 判据用「词边界」而不是「裸子串」或「必须带括号」★
#   这条判据在负向自检里被改了两次，两个错都值得记：
#     ① 裸子串 `"_detect_vcodec" in code` —— 把调用改名成
#        `_detect_vcodec_BROKEN(` **仍包含该子串** ⇒ 显示 ✅（**假绿**）。
#     ② 必须带左括号 `\b_detect_vcodec\s*\(` —— 但真实代码是把函数**当参数**
#        传给线程池的：`run_in_threadpool(fileops._detect_vcodec, p, st)`
#        **没有左括号** ⇒ 三处全部误报（**假红**）。
#   `\b_detect_vcodec\b`：`_detect_vcodec,` 能匹配（`,` 是非 word 字符），
#   而 `_detect_vcodec_BROKEN` 匹配不上（`e` 与 `_` 之间没有词边界）。
#   ⇒ 判据本身也要做**正反两向**的自检，只做一向必错。


def parse_play_coverage(root: Path) -> list:
    """返回 [(说明, 是否接入)] —— 逐个取流入口检查有没有接入转码探测。"""
    out = []
    for rel, label in PLAY_ENTRY_FILES:
        try:
            code = (root / rel).read_text(encoding="utf-8")
        except OSError:
            out.append((label, False))
            continue
        out.append((label, bool(PLAY_MARKER.search(code))))
    return out


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

    # [5] CAD 深链形态：cad.py（网盘）与 share_guest.py（分享页）必须同形
    cad_py = root / "app" / "routers" / "cad.py"
    if not cad_py.exists():
        problems.append("缺少文件：%s" % cad_py)
        return problems
    netdisk = parse_cad_deeplink(cad_py)
    share_dl = parse_cad_deeplink(guest)
    # (a) 两边都不许再套 /lite 外壳（老事故，与 embed 无关，继续守）
    if netdisk["lite"] or share_dl["lite"]:
        problems.append(
            "CAD 深链又套回了 /lite 外壳（两层 iframe 在手机 WebView 里不执行脚本）"
            "：cad.py=%s，share_guest.py=%s" % (netdisk["lite"], share_dl["lite"]))
    # (b) 两边都不许**无条件**拼 embed=1 —— 否则用户看不到 CAD 的菜单/工具条
    if netdisk["embed_uncond"] or share_dl["embed_uncond"]:
        problems.append(
            "CAD 深链**无条件**拼了 &embed=1 ⇒ CAD 会看不到菜单/工具条"
            "（2026-10-04 用户要求默认完整界面；要收 UI 必须改成显式可选）"
            "：cad.py=%s，share_guest.py=%s"
            % (netdisk["embed_uncond"], share_dl["embed_uncond"]))
    # (c) cad.py 必须保留「显式要求才收 UI」的能力：条件拼接 + 代理认 embed=1
    if not netdisk["embed_cond"]:
        problems.append(
            "cad.py 缺少「显式请求才收 UI」的条件拼接"
            "（应为 `inner + \"&embed=1\" if <条件> else inner`）")
    if not netdisk["embed_optin"]:
        problems.append(
            "cad.py 的 /cad/ 代理不再认 `embed=1`（收 UI 的开关被删了）")

    # [6] 视频「能播」入口覆盖
    for label, ok in parse_play_coverage(root):
        if not ok:
            problems.append(
                "取流入口未接入视频转码探测（%s）—— H.265 在该入口会打不开；"
                "请像其它入口一样调用 fileops._detect_vcodec / _transcode_h264" % label)
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
    try:
        dl_net = parse_cad_deeplink(root / "app" / "routers" / "cad.py")
        dl_share = parse_cad_deeplink(root / "app" / "routers" / "share_guest.py")
    except OSError as e:
        print("    [5] CAD 深链形态 ❌ 解析失败：%s" % e)
    else:
        # 新契约：默认完整界面（不无条件拼 embed）；机制（条件拼接 + 代理开关）必须还在
        ok5 = ((not dl_net["lite"]) and (not dl_share["lite"])
               and (not dl_net["embed_uncond"]) and (not dl_share["embed_uncond"])
               and dl_net["embed_cond"] and dl_net["embed_optin"])
        print("    [5] CAD 深链形态（默认完整界面 / embed 显式可选 / 不套 /lite）")
        print("        无条件拼 embed：网盘 %s / 分享 %s（都应为 False）"
              % (dl_net["embed_uncond"], dl_share["embed_uncond"]))
        print("        条件拼接 %s ；代理认 embed=1 %s（cad.py 都应为 True）"
              % (dl_net["embed_cond"], dl_net["embed_optin"]))
        print("        套 /lite：网盘 %s / 分享 %s（都应为 False）   %s"
              % (dl_net["lite"], dl_share["lite"], "✅" if ok5 else "❌"))
    print("    [6] 视频「能播」入口覆盖（H.265 转码）")
    for label, ok in parse_play_coverage(root):
        print("        %-52s %s" % (label, "✅" if ok else "❌ 未接入"))

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
            "    if r == \"cad\":\n"
            "        inner = \"/cad/?open=x\"\n"
            "        return {\"route\": \"cad\", \"url\": inner, \"embed\": False}\n"
            "    if r == \"onlyoffice\": pass\n"
            "    if r == \"kkfileview\": pass\n"
            "    return {\"route\": \"download\"}\n"
            "async def other():\n", encoding="utf-8")
        # ★ 第 [5] 条判据（CAD 深链形态，2026-10-04 新契约）要求存在 cad.py，
        #   且里面同时有：① 条件拼接 ② 代理认 embed=1。
        #   夹具必须**照新契约**给，否则会变成假红。★
        (base / "app" / "routers" / "cad.py").write_text(
            "def api_cad_preview(embed=\"\"):\n"
            "    inner = \"/cad/?open=x\"\n"
            "    want_embed = embed == \"1\"\n"
            "    url = inner + \"&embed=1\" if want_embed else inner\n"
            "    if \"embed=1\" in (q or \"\"):\n"
            "        pass\n"
            "    return {\"url\": url}\n", encoding="utf-8")

        # ★ 判据 [6]（视频「能播」入口覆盖）要求三个取流入口都出现
        #   `_detect_vcodec(` 调用 —— 正例夹具必须补齐，否则会**假红**。★
        for _rel in ("app/routers/fileops.py", "app/routers/share_guest.py",
                     "app/routers/pages.py"):
            _f = base / _rel
            _prev = _f.read_text(encoding="utf-8") if _f.exists() else ""
            _f.write_text(_prev + "\n    codec = fileops._detect_vcodec(p, st)\n",
                          encoding="utf-8")

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

        # —— 坏例 D：分享页的 CAD 深链又套回 /lite 外壳（第 [5] 条判据）——
        badD = tmp / "bad_d"
        shutil.copytree(base, badD)
        (badD / "app" / "routers" / "share_guest.py").write_text(
            "async def api_share_preview(token):\n"
            "    if r == \"cad\":\n"
            "        return {\"route\": \"cad\","
            " \"url\": lite_shell_url(\"cad\", inner, name)}\n"
            "    if r == \"onlyoffice\": pass\n"
            "    if r == \"kkfileview\": pass\n"
            "    return {\"route\": \"download\"}\n"
            "async def other():\n"
            # 保留判据 [6] 的接入点：坏例 D 只想验「深链形态」，
            # 别让它顺带触发「未接入转码」，否则坏例语义就不纯了。
            "    codec = fileops._detect_vcodec(p, st)\n", encoding="utf-8")
        probsD = check(badD)
        if any("/lite 外壳" in x for x in probsD):
            print("    \u2705 坏例 D 被抓到（分享页 CAD 又套 /lite）")
        else:
            print("    \u274c 坏例 D 漏检：%s" % (probsD or "没有任何问题被报出"))
            ok = False

        # —— 坏例 F：CAD 深链又变成「无条件拼 embed=1」（= 用户看不到菜单/工具条）——
        #   这是 2026-10-04 契约反转之后**最该被看住**的那种回退：
        #   代码照样能跑、页面照样能开，只是 CAD 的菜单与工具条又没了。
        badF = tmp / "bad_f"
        shutil.copytree(base, badF)
        (badF / "app" / "routers" / "cad.py").write_text(
            "def api_cad_preview(embed=\"\"):\n"
            "    inner = \"/cad/?open=x\"\n"
            "    embed_inner = inner + \"&embed=1\"\n"
            "    if \"embed=1\" in (q or \"\"):\n"
            "        pass\n"
            "    return {\"url\": embed_inner}\n", encoding="utf-8")
        probsF = check(badF)
        if any("无条件" in x for x in probsF):
            print("    \u2705 坏例 F 被抓到（CAD 深链又无条件拼 embed=1）")
        else:
            print("    \u274c 坏例 F 漏检：%s" % (probsF or "没有任何问题被报出"))
            ok = False

        # —— 坏例 G：把「收 UI」的开关整个删掉（能力退化的另一种形态）——
        badG = tmp / "bad_g"
        shutil.copytree(base, badG)
        (badG / "app" / "routers" / "cad.py").write_text(
            "def api_cad_preview(embed=\"\"):\n"
            "    inner = \"/cad/?open=x\"\n"
            "    return {\"url\": inner}\n", encoding="utf-8")
        probsG = check(badG)
        if any("条件拼接" in x or "embed=1" in x for x in probsG):
            print("    \u2705 坏例 G 被抓到（收 UI 的能力被删）")
        else:
            print("    \u274c 坏例 G 漏检：%s" % (probsG or "没有任何问题被报出"))
            ok = False

        # —— 坏例 E：某个取流入口没接 H.265 转码（第 [6] 条判据）——
        #   ★ 这个坏例是**负向自检抓出来的**：第一版判据用裸子串
        #     `"_detect_vcodec" in code`，把调用改名成 `_detect_vcodec_BROKEN(`
        #     仍然包含该子串 ⇒ 显示 ✅（假绿）。改成带括号的正则后才真正生效。
        badE = tmp / "bad_e"
        shutil.copytree(base, badE)
        _sg = badE / "app" / "routers" / "share_guest.py"
        _sg.write_text(
            _sg.read_text(encoding="utf-8").replace("_detect_vcodec(", "REMOVED("),
            encoding="utf-8")
        probsE = check(badE)
        if any("未接入视频转码探测" in x for x in probsE):
            print("    \u2705 坏例 E 被抓到（取流入口未接转码）")
        else:
            print("    \u274c 坏例 E 漏检：%s" % (probsE or "没有任何问题被报出"))
            ok = False
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
