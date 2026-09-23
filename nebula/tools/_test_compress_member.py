#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""_test_compress_member.py —— 压缩包内成员预览的回归测试

═══════════════════════════════════════════════════════════════════════════════
背景（用户原文，两轮都在报同一个问题）
═══════════════════════════════════════════════════════════════════════════════

    第一轮：「压缩文件夹里面 预览文件 目前提示为：
             The remote server refused to fulfill the request.
             Check if the url is correct, and make sure that CORS requests
             are allowed on the remote server」

    第二轮：「一个压缩包能预览，一个不能预览这个问题还没有修复。」

为什么「一个能、一个不能」——本轮终于定死
──────────────────────────────────────────────────────────────────────────────

关键在于 compress.ftl 拼出的「压缩包成员地址」用的是哪个 base。

成员文件解压后落在：
    <fileDir>/<压缩包名>_/<包内路径>
       例：/opt/kkFileView-5.0.2/file/00-Q3-1250.zip_/00-Q3-1250.stp

而 kkFileView 的 WebConfig 把 `/**` 映射到 "file:" + fileDir，
也就是说这些文件**由 kkFileView 自己当静态资源**服务。

实测（两个压缩包 × 三种 base，2026-09-20）：

    base                         00-Q3-1250.zip     1.2.14.TFDF-6# F向.zip
    ---------------------------------------------------------------------
    http://nebula:8088/preview/  200 ✅ 48,996,086B  404 ❌
    http://127.0.0.1:8012/       200 ✅ 48,996,086B  200 ✅  3,709,570B
    http://nebula:8088/          404 ❌              404 ❌

⇒ 网关地址 /preview/ 对**不含特殊字符**的压缩包侥幸能用，
  对含 `#` 的压缩包必然 404 —— 正是用户说的「一个能、一个不能」。
⇒ 只有 kkFileView **自己的根地址**（127.0.0.1:8012）两个都成功。

根因：网关的 /preview/ 前缀不是 kkFileView 的路由（被当普通路径段），
且多经一轮解析后 `#` 会被截断。

本测试锁定的不变量
──────────────────────────────────────────────────────────────────────────────
  1. compress 页面里 serverBase 指向 **kkFileView 自身**，不含 /preview
  2. 占位符 __SERVER_BASE_URL__ 已被网关替换（不留残迹）
  3. buildPreviewUrl 里预览 iframe 的地址仍用**浏览器源**（不能被改成内网）
  4. 含 `#` 与不含 `#` 的压缩包，成员都能取到真实字节（核心断言）
  5. 不再出现 URISyntaxException / Connection refused

用法：
    NEBULA_BASE=http://127.0.0.1:8089 \
    NEBULA_TEST_USER=admin \
    NEBULA_TEST_PASSWORD='dev-pass-not-real' \
    python _test_compress_member.py
═══════════════════════════════════════════════════════════════════════════════
"""
import base64
import os
import re
import sys
import time
import urllib.parse

import requests

BASE = os.environ.get("NEBULA_BASE", "http://127.0.0.1:8089").rstrip("/")
USER = os.environ.get("NEBULA_TEST_USER", "admin")
PWD = os.environ.get("NEBULA_TEST_PASSWORD", "dev-pass-not-real")
MOUNT = os.environ.get("NEBULA_TEST_MOUNT", "共享")

# (压缩包名, 包内成员名) —— 第二项特意含 `#` 与空格，覆盖用户报的坏例子
CASES = [
    ("00-Q3-1250.zip", "00-Q3-1250.stp"),
    ("1.2.14.TFDF-6# F向.zip", "1.2.14.TFDF-6# F向.STEP"),
]

PASS, FAIL = 0, 0


def ok(cond, name, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}" + (f"  -> {extra}" if extra else ""))


def main():
    s = requests.Session()
    r = s.post(f"{BASE}/api/login", data={"username": USER, "password": PWD}, timeout=20)
    if r.status_code != 200:
        print(f"登录失败：{r.status_code} {r.text[:200]}")
        return 2
    print(f"[setup] 登录成功 {BASE}\n")

    # ---------------------------------------------------------------- 1
    print("=== 1. compress 页面渲染与 serverBase ===")
    arch, member = CASES[0]
    raw = (f"{BASE}/api/raw/{urllib.parse.quote(arch)}"
           f"?mount={urllib.parse.quote(MOUNT)}&path=/{urllib.parse.quote(arch)}")
    inner = "/onlinePreview?url=" + urllib.parse.quote(base64.b64encode(raw.encode()).decode())
    #
    #   ⚠️ 冷缓存时首次访问会拿到「正在转换」的过渡页（无 buildPreviewUrl），
    #   等解压/转换完成后才会是真正的 compress 模板。所以这里必须重试，
    #   直到页面里出现 buildPreviewUrl 为止（最多 ~40s）。
    page = ""
    r = None
    for _ in range(25):
        r = s.get(f"{BASE}/preview{inner}", timeout=120)
        page = r.text
        if "buildPreviewUrl" in page:
            break
        time.sleep(1.5)
    ok(r.status_code == 200, "compress 页面 HTTP 200", str(r.status_code))
    ok("buildPreviewUrl" in page, "页面含 buildPreviewUrl（确实是 compress 模板）")

    m = re.search(r"var serverBase\s*=\s*'([^']*)'", page)
    server_base = m.group(1) if m else ""
    ok(bool(server_base), "serverBase 已赋值", repr(server_base))
    ok("__SERVER_BASE_URL__" not in page,
       "占位符 __SERVER_BASE_URL__ 已被网关替换（无残迹）")
    ok("/preview" not in server_base,
       "serverBase **不含** /preview 前缀（这是本轮修复的核心）", repr(server_base))
    ok(bool(re.search(r":\d+/?$|^/$", server_base)),
       "serverBase 指向 kkFileView 自身根地址（带端口或同源 /）", repr(server_base))

    # ---------------------------------------------------------------- 2
    print("\n=== 2. 预览 iframe 地址必须用浏览器源 ===")
    m = re.search(r'var previewUrl = "([^"]*)"', page)
    preview_base = m.group(1) if m else ""
    ok(BASE.split("//")[-1].split(":")[0] in preview_base or preview_base.startswith("/"),
       "previewUrl 用浏览器可达的源（不是内网 127.0.0.1:8012）", repr(preview_base[:70]))

    # ---------------------------------------------------------------- 3
    print("\n=== 3. 成员字节可取（核心：含 # 与不含 # 都要成功）===")
    #
    #   ⚠️ 顺序很关键 ⚠️
    #   成员的解压产物是「按需生成」的：必须先让 kkFileView 打开一次该压缩包
    #   （触发 unRar 落地到 <fileDir>/<包名>_/），成员地址才取得到字节。
    #   直接打成员地址会 404 —— 这不是 bug，是测试顺序写错了。
    #   所以这里对每个用例先访问一次 compress 页面「预热」。
    for arch, member in CASES:
        key = arch + "_"
        rel = key + "/" + member

        # --- 预热：先打开压缩包预览页，让它把成员解压出来 ---
        #
        #   ⚠️ 必须走产品的 /api/preview 拿地址，不能自己拼 /api/raw ⚠️
        #   /api/preview 返回的 raw 是**容器内可达**的 http://nebula:8088/...
        #   而测试进程若自己拼 http://127.0.0.1:8089/api/raw/...，
        #   那个地址交给容器里的 kkFileView 去下载必然 Connection refused，
        #   于是根本没解压 → 后面取成员 404。
        #   （这个坑真实存在过：第一版测试就是这么写的，误报了两轮。）
        #
        #   ⚠️ 解压是**异步**的：compress 页面返回 ≠ 成员已落盘。
        #   48MB 的 stp 解压要几十秒，必须**同步等**到解压目录真的出现内容，
        #   否则会稳定假报 404（本测试前几轮就栽在这上面）。
        #   最可靠的同步点：问 kkFileView 的 /directory，看 children 是否非空。
        #   （网关层曾有过一段「看到 children 为空就强制重新解压」的自愈逻辑，
        #     已于 2026-09-20 整体移除 —— 它是同步阻塞的，会冻死单 worker 的
        #     网关、导致整站变慢和健康检查失败。详见 app/main.py 的说明。）
        try:
            pr = s.get(f"{BASE}/api/preview",
                       params={"mount": MOUNT, "path": "/" + arch}, timeout=30)
            if pr.status_code == 200:
                page = s.get(BASE + pr.json()["url"], timeout=300).text
                tm = re.search(r"var url = \"http://\" \+ '([^']*)'", page)
                tree = tm.group(1) if tm else ""
                if tree:
                    b64 = base64.b64encode(("http://" + tree).encode()).decode()
                    dq = f"{BASE}/preview/directory?urls=" + urllib.parse.quote(b64)
                    for _ in range(40):          # 最多等 ~60s
                        d = s.get(dq, timeout=60)
                        try:
                            ch = d.json()[0].get("children")
                        except Exception:
                            ch = None
                        if ch:
                            break
                        # 目录还没内容 → 再打一次页面，逼它继续解压
                        s.get(BASE + pr.json()["url"], timeout=300)
                        time.sleep(1.5)
        except Exception:
            pass

        # --- 用「kkFileView 根地址」拼成员 URL —— 与产品的 serverBase 语义一致 ---
        member_url = f"http://127.0.0.1:8012/{urllib.parse.quote(rel, safe='/')}?" + urllib.parse.urlencode({
            "kkCompressfileKey": key,
            "kkCompressfilepath": rel,
            "fullfilename": member,
        })
        gq = (f"{BASE}/preview/getCorsFile?urlPath="
              + urllib.parse.quote(base64.b64encode(member_url.encode()).decode())
              + "&fullfilename=" + urllib.parse.quote(member))
        try:
            rr = None
            # 最多等 ~30s：解压大包不是瞬时的
            for _ in range(20):
                rr = s.get(gq, timeout=180)
                if rr.status_code == 200 and len(rr.content) > 1000:
                    break
                time.sleep(1.5)
            body_head = rr.content[:120].decode("utf-8", "replace")
            is_err = body_head.lstrip().startswith("{")
            ok(rr.status_code == 200 and not is_err and len(rr.content) > 1000,
               f"取到成员字节：{arch} :: {member}",
               f"status={rr.status_code} bytes={len(rr.content)} head={body_head[:80]!r}")
        except Exception as e:
            ok(False, f"取到成员字节：{arch} :: {member}", f"{type(e).__name__}: {e}")

    # ---------------------------------------------------------------- 4
    print("\n=== 4. 页面无真实异常栈 ===")
    #
    #   ⚠️ 别拿「某个报错字符串是否出现」当判据 ⚠️
    #   `Connection refused` / `URISyntaxException` 这些字**本来就会**
    #   出现在结果里 —— 因为 compress.ftl 的注释里为了说明历史 bug
    #   原文引用了那两句报错。拿它们做断言会 100% 误报
    #   （本测试第一版就踩了，白报了两轮失败）。
    #   正确的判据是「有没有真正的 Java 异常栈」：真实崩溃才会出现
    #   `at java.` / `at org.springframework.` 这类栈帧行。
    ok("at java." not in page, "页面无 java.* 栈帧（无真实崩溃）")
    ok("at org.springframework." not in page, "页面无 spring 栈帧（无真实崩溃）")
    ok('encodeMemberPath' in page, "encodeMemberPath 已定义（# 安全编码）")
    ok('<div class="container">' not in page,
       "页面不是 kkFileView 的错误页（错误页有 .container 结构）")

    # ---------------------------------------------------------------- 5
    print("\n=== 5. 关于本机：括号及内容已去除 ===")
    #
    #   用户原文：
    #     「关于界面：映射目录 3个，把后面括号及里面的内容去掉。」
    #     「CAD查看器 在线，把后面括号及里面的内容去掉。」
    #   app.js 是前端静态资源，直接取原始文件做**源码级**断言
    #   （比渲染后抓 DOM 更稳，也不依赖浏览器）。
    try:
        # ⚠️ 前端静态资源挂在 /static/ 下，不是 /js/（探测过：/js/app.js → 404）
        js = s.get(f"{BASE}/static/js/app.js", timeout=30).text
        ok("映射目录" in js, "取到 app.js（关于面板所在文件）")
        # 映射目录行：只应有「N 个」，不应再拼 (…) 括号
        ok(not re.search(r"\$\{\(me\.mounts \|\| \[\]\)\.length\} 个\$\{", js),
           "映射目录行不再拼接括号内容（旧写法已移除）")
        ok("'（' + (me.mounts" not in js,
           "映射目录行不再 map(label) 拼括号")
        # CAD 行：不应再拼（已运行 …）
        ok("（已运行 ${fmtUptime(h.uptime)}）" not in js,
           "CAD 查看器不再显示（已运行 …）括号")
    except Exception as e:
        ok(False, "关于本机括号断言", f"{type(e).__name__}: {e}")

    print(f"\n结果：{PASS} 通过 / {FAIL} 失败\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
