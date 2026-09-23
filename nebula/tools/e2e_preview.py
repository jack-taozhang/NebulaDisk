#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NebulaDisk 真实预览链路验证（Python 版）

为什么不用 bash + curl：
  curl 8.21.0 (Windows) 在 Git Bash 下**不把 HttpOnly cookie 写进 jar**
  （服务端 set-cookie 完全正常，jar 里就是 0 行），导致后续请求全部 401，
  看起来像鉴权坏了。同一份逻辑用 httpx 跑就完全正常。
  所以测试端统一改走 Python，避免被工具链坑。

链路：
  登录 → /api/preview 拿同源地址 → /preview/... 反代到 kkFileView → 校验响应
  另外校验 /api/raw 免登录直链（OnlyOffice / kkFileView 服务端回拉要用）

用法：
  python tools/e2e_preview.py
  BASE=http://127.0.0.1:8899 python tools/e2e_preview.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

# 注意：兼容两套环境变量命名 —— NEBULA_BASE 用于容器（:8089），
# BASE 用于本地 devserver（:8899）。谁设了用谁。
BASE = os.environ.get("NEBULA_BASE") or os.environ.get("BASE", "http://127.0.0.1:8899")
KK = os.environ.get("KK", "http://127.0.0.1:8012")
USER = os.environ.get("NEBULA_TEST_USER") or os.environ.get("NEBULA_USER", "admin")
PASSWORD = (os.environ.get("NEBULA_TEST_PASSWORD")
            or os.environ.get("NEBULA_PASS", "admin123"))
# ★ 挂载名留空则从 /api/me 自动取第一个 ★
#   写死「文档」会在用 共享/照片/私密 的部署上全套假红（看起来像预览坏了）。
MOUNT = os.environ.get("NEBULA_TEST_MOUNT", "")

# 文件清单默认自动从挂载目录里探测：写死文件名会在换环境时必然失败
# （dev 环境叫 readme.md，容器示例目录也叫 readme.md，但用户自己的 NAS
#  目录里显然不会长这样）。显式指定用 NEBULA_TEST_FILES=a,b,c。
_env_files = os.environ.get("NEBULA_TEST_FILES", "")
FILES = [f for f in _env_files.split(",") if f] if _env_files else []


def discover_files(client) -> list[str]:
    """从目标挂载根目录挑几个真实存在的文件用于预览测试。"""
    r = client.get("/api/list", params={"mount": MOUNT, "path": "/"})
    if r.status_code != 200:
        return []
    out = []
    for item in r.json().get("entries", []):
        if item.get("isDir"):
            continue
        out.append(item["name"])
        if len(out) >= 5:
            break
    return out

PASS = 0
FAIL = 0
MSGS: list[str] = []


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"  [OK  ] {msg}")


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    print(f"  [FAIL] {msg}")


def info(msg: str) -> None:
    print(f"  [INFO] {msg}")


# kkFileView 预览失败时返回的是 200 + 一张「不支持/失败」的 HTML 页，
# 而不是 4xx/5xx。只断言状态码会把失败当成功，所以必须识别正文特征。
_KK_ERR_MARKERS = (
    "系统暂不支持在线预览",
    "系统还不支持该格式文件的在线预览",
    "文件不存在",
    "获取文件失败",
    "下载文件失败",
    "预览失败",
    "抱歉，您访问的页面不存在",
)


def _kk_error_text(html: str) -> str:
    """把错误页正文抽出来，便于打印可读信息。"""
    import re

    txt = re.sub(r"<style.*?</style>", " ", html, flags=re.S | re.I)
    txt = re.sub(r"<script.*?</script>", " ", txt, flags=re.S | re.I)
    txt = re.sub(r"<[^>]+>", " ", txt)
    return re.sub(r"\s+", " ", txt).strip()


def _is_kk_error_page(html: str) -> bool:
    if "<html" not in html.lower():
        return False
    txt = _kk_error_text(html)
    return any(m in txt for m in _KK_ERR_MARKERS)


print("=" * 70)
print(f"NebulaDisk 预览链路验证  目标: {BASE}")
print("=" * 70)

# ------------------------------------------------------------------ 登录
print("\n[1] 登录并确认 kkFileView 可达")
with httpx.Client(base_url=BASE, timeout=60, follow_redirects=False) as c:
    r = c.post("/api/login", data={"username": USER, "password": PASSWORD})
    if r.status_code == 200:
        ok(f"登录成功（{r.json().get('display', USER)}）")
    else:
        bad(f"登录失败 {r.status_code}: {r.text[:200]}")
        sys.exit(1)

    jar = [k for k in c.cookies.keys()]
    if "nebula_session" in jar:
        ok(f"会话 cookie 已建立：{jar}")
    else:
        bad(f"未收到会话 cookie，只有 {jar}")
        sys.exit(1)

    r = c.get("/api/me")
    if r.status_code == 200:
        me = r.json()
        ok(f"会话有效，可见映射 {len(me.get('mounts', []))} 个")
        # 未显式指定挂载名 → 自动用第一个，避免因部署差异整套假红
        # （这段在模块级作用域，直接赋值即可，不能写 global）
        if not MOUNT:
            labels = [m["label"] for m in me.get("mounts", [])]
            MOUNT = labels[0] if labels else ""
            info(f"未指定 NEBULA_TEST_MOUNT，自动选用第一个映射：{MOUNT!r}")
    else:
        bad(f"/api/me 返回 {r.status_code}")
        sys.exit(1)

    try:
        rr = httpx.get(KK + "/", timeout=6)
        (ok if rr.status_code == 200 else bad)(f"kkFileView :8012 在线（{rr.status_code}）")
        if rr.status_code != 200:
            sys.exit(1)
    except Exception as e:  # noqa: BLE001
        bad(f"kkFileView 不可达：{e}")
        sys.exit(1)

    # ------------------------------------------- 拿真实文件的预览地址
    print("\n[2] 获取预览地址（真实文件）")
    targets = FILES or discover_files(c)
    if not targets:
        bad(f"挂载 [{MOUNT}] 根目录下没有可用于预览测试的文件")
    else:
        info(f"本轮测试文件：{targets}")
    for target in targets:
        r = c.get("/api/preview", params={"mount": MOUNT, "path": "/" + target})
        if r.status_code != 200:
            bad(f"{target} 预览接口返回 {r.status_code}: {r.text[:120]}")
            continue
        d = r.json()
        url = d.get("url", "")
        raw = d.get("raw", "")
        if not url:
            bad(f"{target} 未返回预览地址")
            continue
        ok(f"{target} 获得预览地址")

        # raw 直链：免登录，供 OnlyOffice/kkFileView 服务端回拉
        if raw:
            # raw 里的 host 可能是容器内地址（如 http://127.0.0.1:8088），
            # 与测试端的 BASE 端口不一定相同，所以只取 path+query 再拼 BASE。
            from urllib.parse import urlsplit

            sp = urlsplit(raw)
            rp = sp.path + (("?" + sp.query) if sp.query else "")
            try:
                rr = httpx.get(BASE + rp, timeout=15)
                if rr.status_code == 200 and len(rr.content) > 0:
                    ok(f"  raw 直链免登录可读（{len(rr.content)} 字节）")
                else:
                    bad(f"  raw 直链返回 {rr.status_code}，{len(rr.content)} 字节")
            except Exception as e:  # noqa: BLE001
                bad(f"  raw 直链请求异常：{e}")

        # 反代预览
        rp = url
        if rp.startswith("http"):
            from urllib.parse import urlsplit

            sp = urlsplit(rp)
            rp = sp.path + (("?" + sp.query) if sp.query else "")
        try:
            rr = c.get(rp, timeout=60)
            head = rr.content[:400].lstrip().lower()
            kind = "pdf" if head.startswith(b"%pdf") else ("html" if b"<" in head[:40] else "其它")
            if rr.status_code != 200 and rr.status_code not in (302, 303):
                bad(f"  反代预览 → {rr.status_code}")
            elif rr.status_code in (302, 303):
                ok(f"  反代预览 → {rr.status_code}（重定向，符合 kkFileView 行为）")
            elif _is_kk_error_page(rr.text):
                # ★ 关键：kkFileView 在「无法预览」时也返回 200 + 一个错误页。
                #   只断言 200 会把这个错误当成通过（早期就是这样漏掉了一个
                #   raw 链接缺扩展名导致全部预览失败的 bug）。必须识别错误页。
                bad(f"  反代预览 → 200 但内容是 kkFileView 错误页：{_kk_error_text(rr.text)[:80]}")
            else:
                ok(f"  反代预览 → 200（{kind}，{len(rr.content)} 字节）")
        except Exception as e:  # noqa: BLE001
            bad(f"  反代预览异常：{e}")

    # ------------------------------------------------- 错误处理
    print("\n[3] 错误处理")
    r = c.get("/api/preview", params={"mount": MOUNT, "path": "/不存在的文件.txt"})
    (ok if r.status_code == 404 else bad)(f"预览不存在的文件 → {r.status_code}（期望 404）")

    # 目录不能下载：挑一个真实存在的目录来测（写死名字换环境就失效）
    d = c.get("/api/list", params={"mount": MOUNT, "path": "/"})
    dirs = [i["name"] for i in d.json().get("items", []) if i.get("isDir")] \
        if d.status_code == 200 else []
    if dirs:
        r = c.get("/api/download", params={"mount": MOUNT, "path": "/" + dirs[0]})
        (ok if r.status_code in (400, 404) else bad)(
            f"下载目录被拒 → {r.status_code}（期望 400/404）")
    else:
        info("挂载根目录下没有子目录，跳过「下载目录被拒」检查")

    r = c.get("/api/preview", params={"mount": "不存在的映射", "path": "/x.txt"})
    (ok if r.status_code == 404 else bad)(
        f"访问未授权映射 → {r.status_code}（期望 404，防目录探测）")

    r = c.get("/api/preview", params={"mount": MOUNT, "path": "/../../etc/passwd"})
    (ok if r.status_code in (400, 403, 404) else bad)(
        f"路径穿越被拒 → {r.status_code}")

# 未登录
print("\n[4] 未登录行为")
with httpx.Client(base_url=BASE, timeout=11) as c2:
    r = c2.get("/api/preview", params={"mount": MOUNT, "path": "/readme.md"})
    (ok if r.status_code == 401 else bad)(f"未登录获取预览地址 → {r.status_code}（期望 401）")
    r = c2.get("/api/me")
    (ok if r.status_code == 401 else bad)(f"未登录 /api/me → {r.status_code}（期望 401）")

print()
print("=" * 70)
print(f"结果：通过 {PASS} 项，失败 {FAIL} 项")
print("=" * 70)
sys.exit(0 if FAIL == 0 else 1)
