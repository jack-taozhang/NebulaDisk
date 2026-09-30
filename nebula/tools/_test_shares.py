# -*- coding: utf-8 -*-
"""_test_shares.py —— 分享功能的本地集成测试（不需要 Docker）

为什么要单独写：分享是**免登录可达**的面，任何越权/穿透都是严重问题。
本测试用 FastAPI TestClient 直接把整条链路跑一遍，重点在**安全边界**：

  1. 创建分享后，访客（无 Cookie）能列目录 / 取流
  2. 提取码：错码拒绝、对码放行（并种 Cookie）
  3. ★ 越权：访客不能通过 path=../.. 跳出分享根 ★
  4. ★ 越权：非 owner 不能撤销别人的分享 ★
  5. 过期 / 超次：相应状态码
  6. 删除源文件 → 分享自动失效（死链不残留）
  7. token 不可枚举：随机 24 字节；错 token → 404
  8. 密码字段绝不通过任何 API 泄漏

运行：
  NEBULA_DATA_DIR=<tmp> python -m tools._test_shares
"""

from __future__ import annotations

import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

# ---- 必须在 import app 之前设好环境（settings 是 import 期读的）----
_TMP = Path(tempfile.mkdtemp(prefix="nebula-share-test-"))
_SHARE_DIR = _TMP / "share"
_SHARE_DIR.mkdir(parents=True, exist_ok=True)
(_SHARE_DIR / "hello.txt").write_text("hello nebula\n", encoding="utf-8")
(_SHARE_DIR / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
# ★ 2026-10-01 新增两个 ★
#   「一个目标只留一条分享」之后，原本挤在同一个 /hello.txt 上的两条
#   （"永久"和"限 1 次"）会互相覆盖 ⇒ 各给一个文件，测的才是各自的性质。
(_SHARE_DIR / "visits-a.txt").write_text("永久那条\n", encoding="utf-8")
(_SHARE_DIR / "visits-b.txt").write_text("限次那条\n", encoding="utf-8")
# 目录分享的根：/share/sub，下面再有一层 inner/，用来测「逐层进」
_sub = _SHARE_DIR / "sub"
_sub.mkdir(exist_ok=True)
(_sub / "inner.txt").write_text("inner\n", encoding="utf-8")
_inner = _sub / "inner"
_inner.mkdir(exist_ok=True)
(_inner / "deep.txt").write_text("deep\n", encoding="utf-8")

os.environ.setdefault("NEBULA_DATA_DIR", str(_TMP / "data"))
os.environ["NEBULA_MOUNTS"] = f"共享|{_SHARE_DIR}|*"
os.environ["NEBULA_ADMIN_USER"] = "admin"
os.environ["NEBULA_ADMIN_PASSWORD"] = "TestPass@2026"
os.environ.setdefault("NEBULA_JWT_SECRET", "test-secret-do-not-use-in-prod")
# ★ 必须配了 CAD 才能测到 cad 分支 ★
#   不配时 route_of() 会把 dwg/dxf 降级成 kkfileview（那是设计好的降级），
#   于是「dwg → route=cad」这条断言会变成**假红**（测的是配置，不是代码）。
#   这里用假地址：只影响 route_of 的判定，不会真的去连。
os.environ.setdefault("NEBULA_CAD_URL", "http://cad-test:8080")

from fastapi.testclient import TestClient  # noqa: E402

from app import shares, users  # noqa: E402
from app.main import app  # noqa: E402

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


def main() -> int:
    users.init_db()
    shares.init_db()

    with TestClient(app) as cli:
        # 建第二个用户，用来测「不能撤销别人的分享」
        users.create("bob", "BobPass@2026")
        users.create("carol", "CarolPass@2026")

        print("\n[1] 登录与创建分享")
        r = cli.post("/api/login", data={"username": "admin", "password": "TestPass@2026"})
        ok(r.status_code == 200, "管理员登录成功", f"HTTP {r.status_code}")

        r = cli.post("/api/shares", data={
            "mount": "共享", "path": "/hello.txt", "ttl_days": 7, "max_visits": 0, "password": "",
        })
        ok(r.status_code == 200, "创建文件分享成功", r.text[:200])
        sh = (r.json().get("share") or {})
        tok = sh.get("token")
        ok(bool(tok) and len(tok) == 12, "token 是 12 字符（与短链同规格，地址更短）",
           f"len={len(tok or '')}")
        ok(bool(sh.get("url")) and tok in (sh.get("url") or ""), "返回了完整链接")
        ok(sh.get("url", "").startswith("/s/") or "/s/" in sh.get("url", ""),
           "分享链接走 /s/<token>", sh.get("url"))
        ok(not sh.get("hasPassword"), "无密码分享 hasPassword=False")
        ok("password" not in sh, "响应里没有 password 字段（不泄漏）")

        # 目录分享
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/sub", "ttl_days": 1})
        ok(r.status_code == 200, "创建目录分享成功", r.text[:200])
        dtok = (r.json().get("share") or {}).get("token")

        # 带密码
        r = cli.post("/api/shares", data={
            "mount": "共享", "path": "/secret.txt", "ttl_days": 7, "password": "1234",
        })
        ok(r.status_code == 200, "创建带提取码的分享成功", r.text[:200])
        ptok = (r.json().get("share") or {}).get("token")
        ok((r.json().get("share") or {}).get("hasPassword") is True, "hasPassword=True")

        print("\n[2] 访客（无登录 Cookie）访问")
        # ★ 关键：用一个全新的 client，不带任何会话 ★
        with TestClient(app) as guest:
            r = guest.get(f"/api/s/{tok}/list", params={"path": ""})
            ok(r.status_code == 200, "访客可列单文件分享", f"HTTP {r.status_code} {r.text[:160]}")
            j = r.json()
            ok(j.get("single") is True, "单文件分享 single=True")
            ok(len(j.get("entries") or []) == 1, "返回 1 个条目")

            r = guest.get(f"/api/s/{dtok}/list", params={"path": ""})
            ok(r.status_code == 200, "访客可列目录分享", f"HTTP {r.status_code}")
            names = [e.get("name") for e in (r.json().get("entries") or [])]
            ok("inner.txt" in names and "inner" in names,
               f"目录里能看到子文件与子目录（{names}）")

            # 逐层进：/share/sub 分享根 → 子路径 'inner' → 里面有 deep.txt
            r = guest.get(f"/api/s/{dtok}/list", params={"path": "inner"})
            ok(r.status_code == 200, "访客可进入子目录", f"HTTP {r.status_code} {r.text[:160]}")
            deep = [e.get("name") for e in (r.json().get("entries") or [])]
            ok("deep.txt" in deep, f"子目录里能看到 deep.txt（{deep}）")

            # 取流
            r = guest.get(f"/api/s/{tok}/raw", params={"path": ""})
            ok(r.status_code == 200 and "hello nebula" in r.text, "访客可取流（文件内容正确）")

        print("\n[3] ★ 提取码 ★")
        with TestClient(app) as guest:
            r = guest.get(f"/api/s/{ptok}/list", params={"path": ""})
            ok(r.status_code == 403, "未解锁时列出被拒（403）", f"HTTP {r.status_code}")

            r = guest.post(f"/api/s/{ptok}/unlock", data={"password": "wrong"})
            ok(r.status_code == 403, "错误提取码被拒（403）", f"HTTP {r.status_code}")

            r = guest.post(f"/api/s/{ptok}/unlock", data={"password": "1234"})
            ok(r.status_code == 200, "正确提取码通过", f"HTTP {r.status_code} {r.text[:160]}")
            # TestClient 会把 set-cookie 保留在同一 client 上
            r = guest.get(f"/api/s/{ptok}/list", params={"path": ""})
            ok(r.status_code == 200, "解锁后可列出", f"HTTP {r.status_code}")

        print("\n[4] ★★ 越权：跳出分享根 ★★")
        with TestClient(app) as guest:
            # 目录分享，尝试用 ../secret.txt 读到分享根之外的文件
            for bad in ("../secret.txt", "..%2Fsecret.txt", "sub/../../secret.txt",
                        "/../secret.txt", "....//secret.txt"):
                r = guest.get(f"/api/s/{dtok}/list", params={"path": bad})
                leaked = "TOP SECRET" in r.text
                ok(r.status_code >= 400 and not leaked,
                   f"拒绝穿越路径 {bad!r}", f"HTTP {r.status_code} leaked={leaked}")
            # raw 通道同样要挡
            r = guest.get(f"/api/s/{dtok}/raw", params={"path": "../secret.txt"})
            ok(r.status_code >= 400 and "TOP SECRET" not in r.text,
               "raw 通道也拒绝穿越", f"HTTP {r.status_code}")

        print("\n[5] 无效 token")
        with TestClient(app) as guest:
            r = guest.get("/api/s/NOT-A-REAL-TOKEN/list", params={"path": ""})
            ok(r.status_code == 404, "伪造 token → 404", f"HTTP {r.status_code}")
            r = guest.get("/s/NOT-A-REAL-TOKEN")
            ok(r.status_code == 404, "伪造 token 的分享页 → 404", f"HTTP {r.status_code}")

        print("\n[6] ★ 越权：撤销别人的分享 ★")
        # bob 登录，尝试撤销 admin 的分享
        with TestClient(app) as bob:
            r = bob.post("/api/login", data={"username": "bob", "password": "BobPass@2026"})
            ok(r.status_code == 200, "bob 登录成功", f"HTTP {r.status_code}")
            r = bob.post("/api/shares/revoke", data={"token": tok})
            ok(r.status_code == 404, "bob 撤销 admin 的分享被拒", f"HTTP {r.status_code}")
            # 且原分享仍可用
        with TestClient(app) as guest:
            r = guest.get(f"/api/s/{tok}/list", params={"path": ""})
            ok(r.status_code == 200, "被拒后原分享仍然有效（没被误删）")

        print("\n[7] 过期与超次")
        # ⚠️ 这两条**必须落在不同文件上**（2026-10-01「一个目标只留一条分享」）：
        #    挤在同一个路径上时，第二条会把第一条的参数覆盖掉，
        #    「永久」和「限 1 次」就变成了同一条分享的两种说法。
        r = cli.post("/api/shares", data={
            "mount": "共享", "path": "/visits-a.txt", "ttl_days": -1, "max_visits": 0,
        })
        # ttl_days<=0 → 永久
        ptok2 = (r.json().get("share") or {}).get("token")
        ok((r.json().get("share") or {}).get("expiresAt") == 0, "ttl_days=-1 → 永久有效")

        r = cli.post("/api/shares", data={
            "mount": "共享", "path": "/visits-b.txt", "ttl_days": 7, "max_visits": 1,
        })
        vtok = (r.json().get("share") or {}).get("token")
        ok(bool(vtok) and vtok != ptok2, "限次那条是独立的一条（不同文件不互相覆盖）",
           f"{ptok2} / {vtok}")
        with TestClient(app) as guest:
            r1 = guest.get(f"/api/s/{vtok}/raw", params={"path": ""})
            r2 = guest.get(f"/api/s/{vtok}/raw", params={"path": ""})
            ok(r1.status_code == 200, "第 1 次访问成功")
            ok(r2.status_code == 410, "超过次数上限 → 410", f"HTTP {r2.status_code}")

        print("\n[8] 删除源文件 → 分享自动失效")
        # 先造一个临时文件并分享
        victim = _SHARE_DIR / "victim.txt"
        victim.write_text("to be deleted\n", encoding="utf-8")
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/victim.txt", "ttl_days": 7})
        wtok = (r.json().get("share") or {}).get("token")
        with TestClient(app) as guest:
            ok(guest.get(f"/api/s/{wtok}/raw", params={"path": ""}).status_code == 200,
               "删除前分享可用")
        r = cli.post("/api/delete", data={"mount": "共享", "path": "/victim.txt"})
        ok(r.status_code == 200, "删除文件成功", r.text[:160])
        ok((r.json() or {}).get("sharesRevoked", 0) >= 1, "删除时联带失效了分享")
        with TestClient(app) as guest:
            rr = guest.get(f"/api/s/{wtok}/raw", params={"path": ""})
            ok(rr.status_code == 404, "删除后旧分享链接失效（404）", f"HTTP {rr.status_code}")

        print("\n[9] 分享列表与去重")
        r = cli.get("/api/shares")
        ok(r.status_code == 200, "可列出我的分享")
        mine = r.json().get("shares") or []
        ok(len(mine) >= 3, f"至少 3 条分享（实际 {len(mine)}）")
        ok(all("password" not in s for s in mine), "列表里也不含 password 字段")
        # carol 不应看到 admin 的分享
        with TestClient(app) as carol:
            carol.post("/api/login", data={"username": "carol", "password": "CarolPass@2026"})
            r = carol.get("/api/shares")
            ok(len(r.json().get("shares") or []) == 0, "carol 看不到 admin 的分享（按 owner 隔离）")

        print("\n[10] 分享页渲染")
        with TestClient(app) as guest:
            r = guest.get(f"/s/{tok}")
            ok(r.status_code == 200, "分享落地页 200")
            ok("__SHARE__" in r.text, "注入了启动数据 __SHARE__")
            ok("__SHARE_BOOT__" not in r.text, "占位符已被替换（没有残留）")
            ok(tok in r.text, "页面里含 token")
            r = guest.get(f"/s/{ptok}")
            ok(r.status_code == 200 and '"unlocked": false' in r.text.replace(" ", " "),
               "带密码的分享页首屏是未解锁态", r.text[:0])

        print("\n[10b] ★ share.js 引用的每个 DOM id 都必须在 share.html 里存在 ★")
        # 为什么单列这一条：share.js 是 IIFE，模块顶层就 `const x = $('id')`。
        #   一旦 html 里少了个 id，`$()` 返回 null，随后任何 `x.hidden = ...`
        #   都会抛 TypeError ⇒ **整页白屏**（而且只在浏览器里看得见，接口全 200）。
        #   这次把页脚控件搬到顶部导航条就动了这些 id，所以钉一条闸门。
        _html = (ROOT / "web" / "share.html").read_text(encoding="utf-8")
        _js = (ROOT / "web" / "js" / "share.js").read_text(encoding="utf-8")
        ids = sorted(set(re.findall(r"""\$\(\s*['"]([\w-]+)['"]\s*\)""", _js)))
        ok(len(ids) >= 5, f"从 share.js 解出 {len(ids)} 个 DOM id", str(ids))
        # ★ 有的 id 是 JS 自己**造**出来的（密码框、预览浮层里的按钮…），
        #   那些当然不在 html 里 —— 先从"必须存在"里刨掉，否则是假红。
        created = set(re.findall(r"""id=["']([\w-]+)["']""", _js))
        missing = [i for i in ids
                   if i not in created and f'id="{i}"' not in _html]
        ok(not missing, "share.js 引用的 id 在 share.html 里都存在", f"缺失：{missing}")
        # 反向也查一遍：html 里声明了 id 却没被 JS 用到，多半是搬迁后忘删的
        # 僵尸元素。（share-app / share-boot 是 CSS 钩子与脚本标签，不算。）
        html_ids = set(re.findall(r"""id=["']([\w-]+)["']""", _html))
        unused = sorted(html_ids - set(ids) - {"share-app", "share-boot"})
        ok(not unused, "share.html 里没有僵尸 id（声明了但 JS 从不引用）", str(unused))

        print("\n[11] ★ 预览路由：/s/ 页必须与网盘一致 ★")
        # 造几个真文件：DWG（cad-viewer）/ ZIP（kkFileView）/ BIN（没引擎能开）
        #   ★ 在用例内创建、用例内删除 ★
        #     放模块级创建会改变目录条目 → 干扰前面「列目录」的断言。
        #   ★ 用 .bin 而不是 .exe ★
        #     造一个 MZ 开头的 .exe 会被 Windows Defender 盯上（可能被隔离/扫描），
        #     而要件只是「没有任何引擎能开的类型」，.bin 同样落在 download 分支。
        made = []
        for nm, head in (("route-test.dwg", b"AC1032"),
                         ("route-test.zip", b"PK\x03\x04"),
                         ("route-test.bin", b"\x00\x01\x02")):
            f = _SHARE_DIR / nm
            f.write_bytes(head + b"\x00" * 64)
            made.append(f)
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/", "ttl_days": 7})
        rtok = (r.json().get("share") or {}).get("token")
        ok(bool(rtok), "创建目录分享（用于预览路由）", r.text[:160])

        with TestClient(app) as guest:
            # ① CAD：与网盘 /api/cad/preview 同一条腿 —— /cad/ 深链 + 浏览器可达的 open
            d = guest.get(f"/api/s/{rtok}/preview", params={"path": "route-test.dwg"}).json()
            ok(d.get("route") == "cad",
               "dwg → route=cad（不再落 kkFileView）", str(d)[:180])
            url = str(d.get("url") or "")
            # ★ CAD 走 /lite 外壳（"页面嵌入块"形态）★
            #   2026-09-30 用户要求「DWG预览 应该用 页面嵌入块的预览模式」：
            #   直接开 /cad/ 是一整台 CAD 程序（功能区/右侧工具条/命令行/状态栏），
            #   嵌入预览只要图纸本身 —— 由 /lite 的 CSS 把那些块收掉。
            ok(url.startswith("/lite?"), "dwg → 走 /lite 外壳（页面嵌入块模式）", url[:140])
            lq = parse_qs(urlsplit(url).query)
            ok((lq.get("kind") or [""])[0] == "cad",
               "/lite 的 kind=cad（决定收起 CAD 的哪几块 UI）", str(lq)[:140])
            # ★ 分层理解这三层编码，否则断言必然写错 ★
            #   ① public_raw    = http://host/api/s/<tok>/sraw/x.dwg?sig=..&exp=..
            #   ② inner          = /cad/?open=<urlencode(public_raw)>      ← 一次编码
            #   ③ url            = /lite?kind=cad&target=<urlencode(inner)> ← 二次编码
            #
            #   parse_qs() 会**自己解一层**：所以 (lq["target"])[0] 恰好就是 ②（inner）。
            #   之前这里多写了一次 unquote() ⇒ 拿到 ② 的明文形态，于是
            #     · 与 d["inner"]（②形态）比 → 不等；
            #     · 明文里当然含 `//`、`:` → 结构断言误报；
            #     · parse_qs 在明文的 `&` 处断开 → 解析出假参数。
            #   三条"失败"全是这一个多余 unquote 引起的，不是产品缺陷。
            inner = (lq.get("target") or [""])[0]          # ②：parse_qs 已解一层
            ok(inner.startswith("/cad/?open="), "/lite 里包的是 /cad/ 深链", inner[:140])
            ok(inner == str(d.get("inner") or ""),
               "返回的 inner 与 /lite 的 target 一字不差（前端可原样引用）",
               str(d.get("inner"))[:100])
            #   ★ 这条不是形式主义：/lite 的 lite_shell() 会拒绝任何
            #     带字面 `//`、`:`、`\` 的 target —— 一旦某天二次编码丢了，
            #     外壳会直接返回 400「无效的 target」，用户看到的是白页，
            #     而"路由正确"的断言全绿。在这里先把坑堵住。
            #     （检查的是 ② 这次编码形态，不是明文。）
            ok("/" * 2 not in inner and ":" not in inner and "\\" not in inner,
               "/lite 的 target 不含字面 // : \\（否则外壳会 400）", inner[:140])
            #   ★ 再真取一次外壳页：确认它真的把 /cad/ 嵌进去了 ★
            #     外壳返回的 HTML 里 target 会被 urlencode 写进 src，
            #     所以这里先 unquote 一次再找 /cad/ 深链。
            shell = guest.get(url)
            ok(shell.status_code == 200 and "/cad/?open=" in unquote(shell.text),
               "/lite 外壳可访问且真的嵌了 CAD 深链",
               f"HTTP {shell.status_code}")
            # ★ 断言要落在 open= 的**值**上 ★
            #   ② 的 query 是 `open=http%3A%2F%2F…`（`&` 已编码成 %26），
            #   所以 parse_qs 能干净地切出一个 open 参数，且**只需再解一层**。
            qs = parse_qs(urlsplit(inner).query)
            opened = (qs.get("open") or [""])[0]
            ok("/api/s/" in opened and "/sraw/" in opened,
               "open 指向分享签名取流（免 Cookie）", opened[:180])
            ok(opened.startswith("http://testserver/"),
               "open 的 host 是请求侧 origin（不能是容器内的 http://nebula:8088）",
               opened[:180])
            ok("nebula:8088" not in opened, "open 里没有容器内主机名", opened[:180])
            ok("sig=" in opened and "exp=" in opened, "open 是签名直链（短期有效）", opened[:180])

            # ② 压缩包：kkFileView（与网盘 /api/preview 同前缀）
            z = guest.get(f"/api/s/{rtok}/preview", params={"path": "route-test.zip"}).json()
            ok(z.get("route") == "kkfileview", "zip → route=kkfileview", str(z)[:160])
            ok(str(z.get("url") or "").startswith("/preview/onlinePreview"),
               "zip → kk 同源反代地址", str(z.get("url"))[:140])

            # ③ 没引擎能开的类型：与网盘的「下载兜底」一致，不再硬塞一个 kk 地址
            b = guest.get(f"/api/s/{rtok}/preview", params={"path": "route-test.bin"}).json()
            ok(b.get("route") == "download",
               "bin → route=download（对齐网盘 viewer.js 的下载兜底）", str(b)[:160])
            ok(not b.get("url"), "download 路由不给任何预览地址", str(b)[:160])

            # ④ 错误分支
            ok(guest.get(f"/api/s/{rtok}/preview", params={"path": "sub"}).status_code == 400,
               "目录不支持预览 → 400")
            rq = guest.get(f"/api/s/{rtok}/preview", params={"path": "nope.dwg"})
            ok(rq.status_code >= 400, "不存在的文件 → 4xx", f"HTTP {rq.status_code}")

        # ⑤ ★ 越权：把路径解析抽成公共 _resolve_in_share() 之后，边界必须仍在 ★
        #    （list / raw / preview 三个入口现在共用同一段判定）
        with TestClient(app) as guest:
            for bad in ("../secret.txt", "sub/../../secret.txt", "/../secret.txt"):
                rq = guest.get(f"/api/s/{dtok}/preview", params={"path": bad})
                ok(rq.status_code >= 400 and "TOP SECRET" not in rq.text,
                   f"preview 通道拒绝穿越 {bad!r}", f"HTTP {rq.status_code}")

        for f in made:
            f.unlink(missing_ok=True)

        print("\n[12] ★ 目录分享的「打包下载」★")
        # 需求（原文）：「文件夹分享 没有看到下载按钮」——
        #   目录分享此前只有「逐个点开文件看」，访客拿不走整个目录。
        made2 = []
        zdir = _SHARE_DIR / "zip-me"
        (zdir / "内层").mkdir(parents=True, exist_ok=True)
        # ★ 用 write_bytes 而不是 write_text ★
        #   Windows 上 write_text 会把 \n 翻成 \r\n，于是"内容一致"这条断言
        #   会在本机红、在 Linux 绿 —— 测的成了平台而不是产品。
        for rel, data in (("top.txt", b"top hello\n"),
                          ("内层/深一层的.md", "深一层的\u6d4b\u8bd5\n".encode("utf-8")),
                          ("内层/中英文名字.pdf", b"%PDF-1.4\n")):
            f = zdir / rel
            f.write_bytes(data)
            made2.append(f)
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/zip-me", "ttl_days": 7})
        ztok = (r.json().get("share") or {}).get("token")
        ok(bool(ztok), "创建目录分享（用于打包下载）", r.text[:160])

        with TestClient(app) as guest:
            r = guest.get(f"/api/s/{ztok}/zip")
            ok(r.status_code == 200, f"目录 → 打包下载 200（实际 {r.status_code}）", r.text[:120])
            ok(r.headers.get("content-type", "").startswith("application/zip"),
               "响应的 content-type 是 application/zip", r.headers.get("content-type", ""))
            cd = r.headers.get("content-disposition", "")
            ok("attachment" in cd.lower() and ".zip" in unquote(cd),
               "带 attachment + .zip 文件名（浏览器会存成 zip）", cd[:120])
            # ★ 真解一遍，确保发出去的是**能打开**的包，而不是字节流看着像 zip ★
            try:
                zf = zipfile.ZipFile(io.BytesIO(r.content))
                names = sorted(zf.namelist())
                bad = zf.testzip()
            except Exception as e:            # noqa: BLE001
                zf, names, bad = None, [], f"打不开：{e}"
            ok(zf is not None and bad is None, "响应体是合法的 ZIP", str(bad))
            # 包内必须套一层同名目录（否则解压会把散文件糊在用户当前目录）
            ok(names == ["zip-me/top.txt", "zip-me/\u5185\u5c42/\u4e2d\u82f1\u6587\u540d\u5b57.pdf",
                         "zip-me/\u5185\u5c42/\u6df1\u4e00\u5c42\u7684.md"],
               "包内条目为 <目录>/<相对路径>（含中文名）", str(names))
            if zf is not None:
                ok(zf.read("zip-me/\u5185\u5c42/\u6df1\u4e00\u5c42\u7684.md")
                   == "深一层的\u6d4b\u8bd5\n".encode("utf-8"),
                   "包内内容与源文件一致（UTF-8 中文）")

            # 单文件分享：不该给 zip（有 /raw 直接下原文件）
            ok(guest.get(f"/api/s/{ztok}/zip", params={"path": "top.txt"}).status_code == 400,
               "单文件（非目录）→ 400，不硬压一遍")

            # ---------------- ★ 选择集：只打勾选的那几项 ★ ----------------
            #   需求原文：「应该可以 根据 选择 然后打包下载」
            def znames(resp):
                try:
                    return sorted(zipfile.ZipFile(io.BytesIO(resp.content)).namelist())
                except Exception:                     # noqa: BLE001
                    return []

            r2 = guest.get(f"/api/s/{ztok}/zip",
                           params=[("item", "top.txt"), ("item", "内层")])
            ok(r2.status_code == 200, f"勾选 2 项 → 200（实际 {r2.status_code}）", r2.text[:120])
            ok(znames(r2) == ["top.txt", "内层/中英文名字.pdf", "内层/深一层的.md"],
               "勾 2 项 → 包内**只有**这 2 项，且直接落在包根（不套外层目录）",
               str(znames(r2)))
            ok(not any(n.startswith("zip-me/") for n in znames(r2)),
               "勾选模式下不带外层目录前缀（解压出来正好是勾的那些）", str(znames(r2)))

            r3 = guest.get(f"/api/s/{ztok}/zip", params=[("item", "top.txt")])
            ok(znames(r3) == ["top.txt"], "勾 1 个文件 → 包里就这一个文件", str(znames(r3)))
            # 勾 1 项时包名跟着那一项走（免得下载下来叫 zip-me.zip 分不清）
            c3 = unquote(r3.headers.get("content-disposition", ""))
            ok("top.txt.zip" in c3, "勾 1 项时包名 = 那一项的名字", c3[:120])

            r4 = guest.get(f"/api/s/{ztok}/zip", params=[("item", "内层")])
            ok(znames(r4) == ["内层/中英文名字.pdf", "内层/深一层的.md"],
               "勾一个目录 → 目录整棵打进来", str(znames(r4)))

            # ---------------- ★ 2026-10-01 放宽：item 允许是「相对分享根」的路径 ★ ----------------
            #   为什么放宽：左侧文件树是**跨目录**勾选的（展开 内层/ 勾一个、
            #   根层再勾一个），一个「当前目录」表达不了这样的选择集。
            #   于是 item 统一按分享根解释，仍然逐个过 _resolve_in_share 做越权校验。
            r5 = guest.get(f"/api/s/{ztok}/zip",
                           params=[("item", "top.txt"), ("item", "内层/深一层的.md")])
            ok(znames(r5) == ["top.txt", "内层/深一层的.md"],
               "跨目录勾选：根层一个 + 子目录一个，包内保留目录层级（不互相覆盖）",
               f"HTTP {r5.status_code} {znames(r5)}")

            r6 = guest.get(f"/api/s/{ztok}/zip", params=[("item", "内层/深一层的.md")])
            c6 = unquote(r6.headers.get("content-disposition", ""))
            ok("深一层的.md.zip" in c6,
               "勾 1 个**深层**文件 → 包名取末段（不是整条路径）", c6[:140])

            ok(znames(guest.get(f"/api/s/{ztok}/zip", params=[("item", "/内层/")])) ==
               ["内层/中英文名字.pdf", "内层/深一层的.md"],
               "item 允许带前导 / 与尾随 /（拼路径时很常见，归一后再解析）")

            # 同一项写两遍（归一后同一条路径）→ 只打一次，不重复入包
            rd = guest.get(f"/api/s/{ztok}/zip",
                           params=[("item", "top.txt"), ("item", "./top.txt"), ("item", "/top.txt")])
            ok(znames(rd) == ["top.txt"], "重复/等价的 item 去重（不会把同一文件打两遍）",
               str(znames(rd)))

            # 没有勾任何项 → 整层（与不带 item 等价）
            ok(znames(guest.get(f"/api/s/{ztok}/zip")) ==
               ["zip-me/top.txt", "zip-me/内层/中英文名字.pdf", "zip-me/内层/深一层的.md"],
               "不勾任何项 → 回到「整层打包」，包内套同名目录")

            # ---- 选择项的越权/非法输入 ----
            #   ★ 接口是公开的，前端不发不代表别人不发 ★
            #   ⚠️ 这里**不能**再放 `内层/深一层的.md` 这种"带 / 的名字"——
            #      那是本次刻意放开的合法形式（见上面的跨目录用例）。
            #      判断标准从"长得像不像一个名字"变成了"解析后是否在分享根内"。
            for bad_item in ("../secret.txt", "内层/../../secret.txt", "..", ".", "",
                             "/etc/passwd", "内层/../..", "top.txt/../../secret.txt"):
                rq = guest.get(f"/api/s/{ztok}/zip", params=[("item", bad_item)])
                ok(rq.status_code >= 400 and b"TOP SECRET" not in rq.content,
                   f"非法选择项 {bad_item!r} 被拒", f"HTTP {rq.status_code}")
                rq = guest.get(f"/api/s/{ztok}/zip",
                               params=[("item", "top.txt"), ("item", bad_item)])
                ok(rq.status_code >= 400,
                   f"混入一个非法项 {bad_item!r} → 整单拒绝（不做部分成功）",
                   f"HTTP {rq.status_code}")
            rq = guest.get(f"/api/s/{ztok}/zip", params=[("item", "不存在.txt")])
            ok(rq.status_code >= 400, "勾了不存在的项 → 4xx", f"HTTP {rq.status_code}")

            # ★ 越权边界必须与 raw/list 一样严（共用 _resolve_in_share）★
            for bad_p in ("../secret.txt", "内层/../../secret.txt"):
                rq = guest.get(f"/api/s/{ztok}/zip", params={"path": bad_p})
                ok(rq.status_code >= 400 and b"TOP SECRET" not in rq.content,
                   f"zip 通道拒绝穿越 {bad_p!r}", f"HTTP {rq.status_code}")

            # 未解锁的分享不能拿包
            rq = guest.get(f"/api/s/{ptok}/zip")
            ok(rq.status_code == 403, "带提取码的分享未解锁 → 403", f"HTTP {rq.status_code}")

        for f in made2:
            f.unlink(missing_ok=True)
        try:
            (zdir / "内层").rmdir()
            zdir.rmdir()
        except OSError:
            pass

        print("\n[16] ★ 分享网页版式（2026-10-01 第四次：去掉顶栏 + 左侧抽屉文件树）★")
        # 用户这一轮的原话（a~f 逐条，下面每个小节对应一条）：
        #   a、最上面那个整条去掉，包括网盘 logo 都去掉；
        #   b、预览窗口铺满整个页面；
        #   c、每行右边显示 文件大小和下载图标，不显示日期；
        #   d、文件树显示在左边，自动隐藏（不要太宽），鼠标靠边面板就可以从左边
        #      显示出来，宽度可以手动调整；
        #   e、多选下载按钮 也放到左边的面板上；
        #   f、有固定图标，固定后就固定在边上，如果没有固定，点击预览窗口，
        #      那文件树就自动隐藏。
        #
        # ★ 钉的是**结构性契约**（有没有常驻横带、谁叠在谁上面、控件归属哪一块、
        #   默认是否收起），不是配色/间距这类美术偏好 —— 那些改了不该让测试红。
        # ★ 为什么不用"截图比对"当判据：截图能过而东西是坏的（见仓库备忘里
        #   DWG 那次 66/0 全绿却还在转圈的教训），静态契约才是能长期守住的。
        _html = (ROOT / "web" / "share.html").read_text(encoding="utf-8")
        _css = (ROOT / "web" / "css" / "share.css").read_text(encoding="utf-8")
        # ★ 匹配规则前先**剥掉注释** ★
        #   本文件顶部有一段专门讲 `hidden` 的注释，里面就写着
        #   「`.sh-float { display: flex; }`」这句示例 —— 不剥注释的话
        #   `re.search(r"\.sh-float\s*\{[^}]*\}")` 会**先命中注释**，
        #   拿到的是那句示例而不是真规则（实测：报了
        #   `→ .sh-float { display: flex; }`，而真规则里明明有 right/bottom）。
        #   这就是"脚本自己在读空气"的典型 —— 判据必须落在**真规则**上。
        _css_nc = re.sub(r"/\*.*?\*/", "", _css, flags=re.S)
        _js = (ROOT / "web" / "js" / "share.js").read_text(encoding="utf-8")

        # ================= a：最上面那条整条（含 logo）必须消失 ================
        # 前两版都栽在"有一条常驻横带"上：第 1 版品牌栏+导航条+裸表格三条，
        # 第 2 版压成两条但**顶栏仍在**。用户的结论是"整条去掉"——
        # 问题不在横带里放了什么，而在"有一条常驻横带"本身（它把内容往下推，
        # 预览就永远不可能铺满整页）。
        ok(not re.search(r"<header\b", _html, re.I),
           "share.html 里没有 <header>（顶栏整条去掉）")
        ok(not re.search(r"\bsh-top\b", _html + _css + _js),
           "旧的 sticky 顶栏 .sh-top 已彻底移除")
        ok(not re.search(r"\bsh-brand\b|\bsh-logo\b|\bclass=\"logo", _html + _css),
           "没有品牌栏 / 网盘 logo（a 条明确点名了 logo）")
        ok(not re.search(r"\bsh-foot\b", _html + _css + _js),
           "更早一轮的页脚导航 .sh-foot 也没有回来（上一级不再钉在右下角）")
        # 页面里不许再有 .sh-head 信息卡：它的内容已并进左面板头部
        ok(not re.search(r"\bsh-head\b", _html + _css + _js),
           "信息卡 .sh-head 已并入左面板头部（页面上不再有第二块横带）")
        ok(not re.search(r"position\s*:\s*sticky", _css),
           "整个 share.css 里没有任何 sticky —— 常驻横带才是问题本身")

        # ================= b：预览铺满整个页面 ================================
        app_rule = re.search(r"#share-app\s*\{([^}]*)\}", _css)
        ok(bool(app_rule) and "fixed" in app_rule.group(1) and "inset" in app_rule.group(1),
           "#share-app 铺满视口（position:fixed + inset）")
        main_rule = re.search(r"\.sh-main\s*\{([^}]*)\}", _css)
        ok(bool(main_rule), "share.css 里有 .sh-main 规则")
        if main_rule:
            mb = main_rule.group(1)
            ok("position" in mb and "absolute" in mb,
               ".sh-main 是 absolute（浮层式布局：左面板滑出不会让它重排、iframe 不闪白）")
            ok(bool(re.search(r"inset\s*:\s*0", mb)),
               ".sh-main inset:0 —— 真的铺满整页")
            ok(not re.search(r"\bmargin\s*:", mb) and not re.search(r"\bpadding\s*:", mb),
               ".sh-main 自身没有 margin/padding 留白（留白会破坏「铺满」）")
        ok(bool(re.search(r'<main[^>]*class="sh-main"', _html)),
           "share.html 里有 <main class=\"sh-main\">")
        ok(bool(re.search(r"\.sh-main\s*>\s*iframe\s*\{[^}]*width\s*:\s*100%", _css)),
           "预览 iframe 撑满主区（width/height 都 100%）")
        ok(bool(re.search(r"html\s*,\s*body\s*\{[^}]*overflow\s*:\s*hidden", _css)),
           "页面自身不滚动（滚动交给主区/面板内部，避免出现第二条滚动条）")

        # ================= c：行右侧 = 大小 + 下载，且不显示日期 ================
        ok(bool(re.search(r"\.sh-node\s+\.sz\s*\{", _css)), "树行有 .sz（文件大小）")
        ok(bool(re.search(r"\.sh-node\s+\.sh-row-dl\s*\{", _css)),
           "树行有 .sh-row-dl（下载图标）")
        ok(bool(re.search(r"\.sh-node:hover\s+\.sh-row-dl\s*\{[^}]*opacity\s*:\s*1", _css)),
           "下载图标 hover 变实（默认 .55 常显 —— 不会像纯 hover 那样让人找不到）")
        row_tpl = re.search(r"function nodeRow\(.*?\n  \}", _js, re.S)
        ok(bool(row_tpl), "share.js 里有 nodeRow()（树行的唯一产出点）")
        if row_tpl:
            rt = row_tpl.group(0)
            ok("sh-row-dl" in rt, "行模板里带了下载按钮")
            ok('class="sz"' in rt, "行模板里带了文件大小")
            # ⚠️ token 表要够宽：第一版只写了「日期|mtime|toLocaleDateString」，
            #    结果塞一个 `<span class="date">…</span>` 进来照样全绿
            #    （负向自检当场抓出来的）。日期列落到代码里无非这几种写法。
            ok(not re.search(r"日期|date|Date|time|Time|mtime|ctime|toLocale", rt),
               "行模板里**没有日期**（用户明确要求不显示日期）", rt[:200])
        ok("fmtSize" in _js, "大小有格式化（fmtSize，不是裸字节数）")

        # ================= d / f：左侧抽屉树：默认收起、不太宽、靠边滑出、可拖宽 ======
        tree_rule = re.search(r"\.sh-tree\s*\{([^}]*)\}", _css)
        ok(bool(tree_rule), "share.css 里有 .sh-tree 规则")
        if tree_rule:
            tb_ = tree_rule.group(1)
            ok("position" in tb_ and "absolute" in tb_ and "left" in tb_,
               ".sh-tree 是浮层（absolute + left:0），不挤压预览")
            ok("translateX(-100%)" in tb_.replace(" ", ""),
               "默认 translateX(-100%) 收起（用 transform 不用 display：不引发重排、iframe 不闪）")
            ok("width" in tb_ and "var(--sh-tree-w)" in tb_,
               "面板宽度走 --sh-tree-w 变量（d：宽度可手动调整）")
            ok(bool(re.search(r"max-width\s*:", tb_)),
               "面板有 max-width（窄屏保护，不许盖满整页）")
        ok(bool(re.search(r'\.sh-tree\[data-open="true"\]\s*\{\s*transform\s*:\s*translateX\(0\)', _css)),
           "data-open=true 时滑出（收起/滑出由同一个 transform 过渡）")
        tw = re.search(r"--sh-tree-w\s*:\s*(\d+)px", _css)
        ok(bool(tw) and int(tw.group(1)) <= 320,
           "默认宽度 ≤320px（用户要求「不要太宽」）",
           (tw.group(1) + "px") if tw else "没找到 --sh-tree-w 默认值")
        ok(bool(re.search(r"\.sh-edge\s*\{", _css)), "有左边缘热区 .sh-edge（鼠标靠边呼出）")
        edge_rule = re.search(r"\.sh-edge\s*\{([^}]*)\}", _css)
        if edge_rule and tree_rule:
            ez = re.search(r"z-index\s*:\s*(\d+)", edge_rule.group(1))
            tz = re.search(r"z-index\s*:\s*(\d+)", tree_rule.group(1))
            ok(bool(ez) and bool(tz) and int(ez.group(1)) > 0,
               "热区有正 z-index（必须高于预览，否则鼠标落在 iframe 上时拉不出面板）")
            ok(bool(ez) and bool(tz) and int(ez.group(1)) < int(tz.group(1)),
               "热区 z-index 低于面板（两者重叠时由面板接管点击）")
        # ⚠️ `~` 只向后找兄弟节点：`.sh-tree[data-open] ~ .sh-edge` 成立的前提是
        #    .sh-edge 排在 </aside> **之后**。排反了这条规则永远不命中
        #    （面板打开时提示条还挂着），而且是**静默**的 —— 所以钉一条。
        # ⚠️ 必须先**去掉 HTML 注释**再比：`</aside>` 这个字样本身也出现在
        #    热区那段注释文案里（"必须排在 </aside> 之后"），用裸 index()
        #    比会被自己写的注释骗过 —— 第一版就是这么假绿的
        #    （负向自检把 sh-edge 挪到 aside 前面，闸门居然全绿）。
        _html_nc = re.sub(r"<!--.*?-->", "", _html, flags=re.S)
        ok(_html_nc.index('id="sh-edge"') > _html_nc.index("</aside>"),
           "热区排在 </aside> 之后（否则 `.sh-tree ~ .sh-edge` 兄弟选择器不生效）")
        ok("edgeEl.addEventListener('mouseenter', openTree)" in _js,
           "鼠标靠到左边缘 → 呼出面板")
        ok(bool(re.search(r"\.sh-grip\s*\{[^}]*cursor\s*:\s*col-resize", _css)),
           "右缘手柄 .sh-grip 是 col-resize（看得出能拖）")
        ok("setPointerCapture" in _js,
           "拖宽用 setPointerCapture（指针滑进 iframe 也不会卡住/松手还在拖）")
        ok("--sh-tree-w" in _js and "setProperty" in _js,
           "拖动写的是 --sh-tree-w（d：宽度真的能手动调整）")
        ok(bool(re.search(r"if\s*\(pinned\)\s*return;", _js)),
           "固定后 closeTree() 直接返回（f：固定了就固定在边上）")
        ok(bool(re.search(r"main\.addEventListener\('mousedown',\s*\(\)\s*=>\s*closeTree\(\)\)", _js)),
           "点预览区（main）→ 文件树自动收起（f：未固定时）")
        ok("setPinned" in _js and "aria-pressed" in _js,
           "固定图标切 aria-pressed（视觉与可访问性同一个状态源）")
        ok(bool(re.search(r'\.sh-pin\[aria-pressed="true"\]\s*\{', _css)),
           "固定态有独立样式（看得出现在是钉住的）")
        ok("localStorage" in _js and "shareTreePin" in _js,
           "固定状态记在 localStorage（刷新/换页后还在）")
        ok(bool(re.search(r'id="sh-pin"', _html)), "share.html 里有固定图标 #sh-pin")

        # ================= e：多选下载按钮在**左面板**里 ======================
        aside_m = re.search(r'<aside[^>]*class="sh-tree"[^>]*>(.*?)</aside>', _html, re.S)
        ok(bool(aside_m), "share.html 里有左面板 <aside class=\"sh-tree\">")
        if aside_m:
            am = aside_m.group(1)
            ok('id="sh-zip"' in am and 'id="sh-selall"' in am,
               "「打包下载 / 全选」在左面板**内部**（e：多选下载按钮放到左边面板上）")
            ok('id="sh-pin"' in am, "固定图标在面板头部（f）")
            ok('id="sh-tree-body"' in am, "树本体也在面板里")
        ok("zipUrl" in _js and "append('item'" in _js,
           "打包下载用重复的 item 参数传**根相对路径**（跨目录勾选才有意义）")

        # ================= 不能破的既有约定 ==================================
        ok("mountPreview" in _js,
           "单文件与「目录里点开文件」共用同一个 mountPreview（不做两套预览逻辑）")
        ok(not re.search(r"\bid=[\"']sh-open[\"']", _html) and "sh-open" not in _js,
           "没有「预览 / 下载」的中间卡片（旧版让访客多点一次的那一步）")
        # 类型着色：靠 k-<类型> class（没有它树里就是一列灰方块）
        for k in ("k-dir", "k-image", "k-video", "k-audio", "k-text",
                  "k-doc", "k-pdf", "k-cad", "k-archive", "k-file"):
            ok(f".sh-ico.{k}" in _css, f"share.css 定义了类型色 .sh-ico.{k}")
        # 「无法在线预览」那条提示必须会**自己消失**（切到下一个文件还挂着会挡内容）
        ok(bool(re.search(r"setTimeout\(\s*\(\)\s*=>\s*\{\s*t\.hidden\s*=\s*true", _js)),
           "toast 有自动消失（不会一直挂在屏幕上）")
        # `hidden` 属性必须真的隐藏（作者样式里的 display: 会盖掉 UA 的 display:none）
        ok(bool(re.search(r"\[hidden\]\s*\{\s*display\s*:\s*none\s*!important", _css)),
           "[hidden] 用 !important 兜住（否则 .sh-float 的 display:flex 会让它照样显示）")

        # ★★ 单文件分享的「文件名 + 下载」必须在**显示区右下角** ★★        #   用户原话：「所有单文件分享界面 文件名 和 下载按钮 放到显示区域的
        #              右下角。包括OO」
        #   ⚠️ 判据必须是**定位属性本身**，不能只查"这枚浮动条还在" ——
        #      上一版它就在（top:12px; left:12px），"存在"这个判据在改动前后
        #      都是绿的，等于没守。钉 right/bottom，并禁止再出现 top/left 定位。
        _flm = re.search(r"\.sh-float\s*\{[^}]*\}", _css_nc)
        _flrule = _flm.group(0) if _flm else ""
        ok(bool(_flrule), "share.css 里有 .sh-float 规则", _flrule[:80])
        ok(bool(re.search(r"right\s*:\s*\d+px", _flrule))
           and bool(re.search(r"bottom\s*:\s*\d+px", _flrule)),
           "★ 浮动条用 right + bottom 定位（显示区右下角）★", _flrule[:220])
        ok(not re.search(r"(?:^|[;{\s])(?:top|left)\s*:", _flrule),
           "★ 规则里不再有 top / left 定位（否则会贴回左上角）★", _flrule[:220])
        # ★ 「包括OO」：单文件分支里不许因为预览类型把浮动条藏起来 ★
        #   实机判据在 verify-share-route.mjs 的 [5c]（OO 下必须可见且在右下角），
        #   这里只做一条静态兜底：单文件分支里只有 `hidden = false`，没有 `= true`。
        _si = _js.find("if (isSingle) {")
        _sb = _js[_si:_si + 1600] if _si >= 0 else ""
        if "return;" in _sb:
            _sb = _sb[:_sb.find("return;") + 7]
        ok("floatBar.hidden = false" in _sb,
           "单文件分支里**显式**把浮动条显示出来", _sb[:0] or "isSingle 分支")
        ok("floatBar.hidden = true" not in _sb,
           "★ 单文件分支里没有把它藏起来（对 OO 也一样）★", "「包括OO」")

        # =================================================================
        print("\n[17] ★★ 一个目标只有一条分享（2026-10-01 用户要求）★★")
        # =================================================================
        # 需求原文（附截图：同一个 .dwg 在链接管理里并排两条 /s/…）：
        #   「同一个文件目前可以分享多个路径，这样调整为同一个文件只能分享
        #     一个路径，直连一个路径。」
        #
        # ★ 与 _test_links.py 的 [16] 的分工 ★
        #   那边走 **HTTP 接口**（含 reused 字段、已死那条被换掉）；
        #   这边走 **compat 壳的 Python API** 并加一条**全局不变式**检查 ——
        #   「库里任何 (owner, mount, path) 都不许出现两条 share」。
        #   不变式比逐例断言强：它不挑路径，任何角落漏出一条重复都会被抓住。
        (_SHARE_DIR / "once.txt").write_text("once\n", encoding="utf-8")
        s1 = shares.create("admin", "共享", "/once.txt", name="once.txt",
                           is_dir=False, ttl=7 * 86400)
        ok(bool(s1.token) and len(s1.token) == 12, "compat 壳建分享", s1.token)
        ok(shares.find_by_target("admin", "共享", "/once.txt").token == s1.token,
           "shares.find_by_target 能按目标找到那条（路由的 reused 就靠它）")
        s2 = shares.create("admin", "共享", "/once.txt", name="once.txt",
                           is_dir=False, ttl=30 * 86400, max_visits=9, note="改过")
        ok(s2.token == s1.token, "★ 同一目标再建 → **同一个 token** ★",
           f"{s1.token} → {s2.token}")
        ok(s2.max_visits == 9 and s2.note == "改过",
           "参数被原地写进去了（创建即更新）", f"{s2.max_visits} / {s2.note!r}")

        _c = sqlite3.connect(str(_TMP / "data" / "nebula.db"))
        _c.row_factory = sqlite3.Row
        _dup = [dict(r) for r in _c.execute(
            "SELECT owner, mount, path, COUNT(*) n FROM links WHERE kind='share'"
            " GROUP BY owner, mount, path HAVING n > 1")]
        _n_share = _c.execute(
            "SELECT COUNT(*) FROM links WHERE kind='share'").fetchone()[0]
        _c.close()
        ok(not _dup,
           "★ 全局不变式：库里没有任何 (owner,mount,path) 有两条 share ★",
           json.dumps(_dup, ensure_ascii=False))
        ok(_n_share >= 4,
           "分享确实建了不少（这条不变式不是空库上跑出来的）", f"{_n_share} 条")

        # 面板层：接口给出来的清单里也不许有重复目标
        r = cli.get("/api/shares")
        _keys = [(x["owner"], x["mount"], x["path"]) for x in r.json()["shares"]]
        ok(len(_keys) == len(set(_keys)),
           "★ /api/shares 的清单里没有重复目标（链接管理不会再并排显示两条）★",
           f"{len(_keys)} 条 / {len(set(_keys))} 个唯一目标")

    print(f"\n结果：{pass_n} 通过 / {fail_n} 失败\n")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
