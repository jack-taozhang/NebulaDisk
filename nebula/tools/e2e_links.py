# -*- coding: utf-8 -*-
"""e2e_links.py —— 对**运行中的** NebulaDisk 跑一遍「统一链接」真机端到端。

和 `tools/_test_links.py` 的分工（别混）：
  · `_test_links.py`  用 FastAPI TestClient **在进程内**跑，快、可离线；
  · 本文件           打**真实 HTTP**（默认 http://127.0.0.1:8089），
                     验证的是"镜像真的部署上去了、容器真的在跑新代码"。

它回答的是那几个 TestClient **答不了**的问题：
  · 容器里跑的到底是 1.2.1 还是 1.2.2？
  · `/f/<token>` 的免登录取流在**真网络路径**上通不通（含 Content-Disposition）？
  · 前端文件（APP_VERSION）有没有跟着镜像更新？

★ 别碰用户数据 ★
  全程只在一个**新建的临时目录**里操作（`<挂载根>/nb-e2e-<时间戳>/`），
  结束时删掉目录、并回读确认它真的没了。

用法：
  python tools/e2e_links.py
  NB_URL=http://127.0.0.1:8089 NB_USER=tao_zhang NB_PASS=... python tools/e2e_links.py
  # 挂载名可指定；不指定就取 /api/me 里的第一个映射
  NB_MOUNT=D盘 python tools/e2e_links.py

★ 为什么不用 requests ★
  本机 httpx 走系统代理会 RemoteProtocolError（见 MEMORY-infra §四.5），
  所以这里显式 `trust_env=False`，绕开代理环境变量。
"""

from __future__ import annotations

import os
import secrets
import sys
import time
from typing import Any

try:
    import httpx
except ImportError:
    sys.exit("需要 httpx：pip install httpx")

BASE = os.environ.get("NB_URL", "http://127.0.0.1:8089").rstrip("/")
USER = os.environ.get("NB_USER", "tao_zhang")
PASS = os.environ.get("NB_PASS", "Redmaple@123")
WANT_MOUNT = os.environ.get("NB_MOUNT", "")

# trust_env=False：别让系统代理劫持 127.0.0.1（本机实测会 502 / RemoteProtocolError）
CLI = httpx.Client(base_url=BASE, timeout=20.0, trust_env=False, follow_redirects=False)

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
    print(f"目标：{BASE}\n")

    print("[1] 服务信息与版本")
    r = CLI.get("/healthz")
    ok(r.status_code == 200, "/healthz 200", f"HTTP {r.status_code}")
    j = {}
    try:
        j = r.json()
    except Exception:  # noqa: BLE001
        pass
    ver = j.get("version") or j.get("appVersion") or ""
    if ver:
        ok(ver.startswith("1.2."), f"后端自报版本 {ver}", ver)
    else:
        print(f"  ~ /healthz 未含版本字段，响应键：{sorted(j)[:8]}")

    r = CLI.get("/")
    ok(r.status_code == 200, "首页 200", f"HTTP {r.status_code}")

    print("\n[2] 登录")
    r = CLI.post("/api/login", data={"username": USER, "password": PASS})
    ok(r.status_code == 200, f"{USER} 登录成功", f"HTTP {r.status_code} {r.text[:160]}")
    if r.status_code != 200:
        print("\n⚠️ 登录失败，后续用例无法继续（检查 NB_USER / NB_PASS）")
        return 1
    me = CLI.get("/api/me").json()
    mounts = me.get("mounts") or []
    ok(bool(mounts), f"拿到 {len(mounts)} 个映射")
    writable = [m for m in mounts if m.get("writable")]
    ok(bool(writable), "至少一个可写映射", str([m.get("label") for m in mounts]))
    m = None
    for it in writable:
        if WANT_MOUNT and it.get("label") != WANT_MOUNT:
            continue
        m = it
        break
    if not m:
        m = writable[0] if writable else None
    if not m:
        print("\n⚠️ 没有可写映射，无法造测试文件")
        return 1
    label = m["label"]
    print(f"     使用映射：{label}")

    # ------------------------------------------------------------------
    # 造一个隔离的临时目录，全程只在它里面玩
    # ------------------------------------------------------------------
    print("\n[3] 造测试文件（隔离目录，结束会删）")
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    # ★ 目录名必须是**单层**的 ★ files._validate_name 明确拒绝含 "/" 的名字
    #   （所以不能一次 mkdir "Temp/xx"）。直接建在挂载根下，删起来也干净。
    base_dir = f"nb-e2e-{stamp}"
    r = CLI.post("/api/mkdir", data={"mount": label, "path": "", "name": base_dir})
    ok(r.status_code == 200, f"创建临时目录 /{base_dir}", r.text[:160])

    files = {"plain.txt": "hello nebula e2e\n", "evil.bat": "@echo off\necho pwned\n"}
    for fn, content in files.items():
        r = CLI.post("/api/upload", data={"mount": label, "path": "/" + base_dir},
                     files={"file": (fn, content.encode("utf-8"), "text/plain")})
        ok(r.status_code == 200, f"上传 {fn}", f"HTTP {r.status_code} {r.text[:160]}")

    plain_rel = f"/{base_dir}/plain.txt"

    try:
        print("\n[4] 签发直链 + 免登录取流")
        r = CLI.post("/api/shortlink", data={"mount": label, "path": plain_rel})
        ok(r.status_code == 200, "签发直链成功", f"HTTP {r.status_code} {r.text[:200]}")
        j = r.json()
        tok, url = j.get("token"), j.get("url")
        ok(len(tok or "") == 12, "token 12 字符", f"len={len(tok or '')}")
        ok(bool(url) and url.endswith(f"/f/{tok}"), "地址形如 <host>/f/<token>", url)
        ok(len(url or "") <= len(BASE) + 20, f"整条地址很短（{len(url or '')} 字符）", url)
        path_only = url.replace(BASE, "") if url and url.startswith(BASE) else f"/f/{tok}"

        # ★ 全新 client，不带任何 Cookie ⇒ 真·免登录 ★
        with httpx.Client(base_url=BASE, timeout=20.0, trust_env=False,
                          follow_redirects=False) as guest:
            g = guest.get(path_only)
            ok(g.status_code == 200, "访客（无 Cookie）能取到", f"HTTP {g.status_code}")
            ok(g.text.strip() == "hello nebula e2e", "字节内容正确", repr(g.content[:40]))
            ok("location" not in {k.lower() for k in g.headers},
               "是吐字节不是 302（地址栏不会变回长链）", dict(g.headers))
            ok(g.headers.get("cache-control") == "no-store", "带 no-store")

            g = guest.get(path_only, params={"dl": "1"})
            ok("attachment" in (g.headers.get("content-disposition") or ""),
               "?dl=1 → attachment", g.headers.get("content-disposition"))

        # 幂等
        r2 = CLI.post("/api/shortlink", data={"mount": label, "path": plain_rel})
        ok(r2.json().get("token") == tok, "同一文件重复签发 → 同一个 token（幂等）")

        # 危险扩展名
        r = CLI.post("/api/shortlink",
                     data={"mount": label, "path": f"/{base_dir}/evil.bat"})
        etok = (r.json() or {}).get("token")
        with httpx.Client(base_url=BASE, timeout=20.0, trust_env=False,
                          follow_redirects=False) as guest:
            g = guest.get(f"/f/{etok}")
            ok("attachment" in (g.headers.get("content-disposition") or ""),
               "常驻危险扩展名（.bat）强制 attachment",
               g.headers.get("content-disposition"))

        print("\n[5] 分享（/s/）与统一列表")
        r = CLI.post("/api/shares", data={"mount": label, "path": plain_rel,
                                          "ttl_days": 1, "note": "e2e"})
        ok(r.status_code == 200, "创建分享成功", r.text[:200])
        stok = (r.json().get("share") or {}).get("token")
        ok(len(stok or "") == 12, "分享 token 也是 12 字符（地址同样短）",
           f"len={len(stok or '')}")
        with httpx.Client(base_url=BASE, timeout=20.0, trust_env=False,
                          follow_redirects=False) as guest:
            g = guest.get(f"/s/{stok}")
            ok(g.status_code == 200, "访客能打开分享落地页", f"HTTP {g.status_code}")

        r = CLI.get("/api/links")
        ok(r.status_code == 200, "统一列表 200", r.text[:160])
        items = r.json().get("items") or []
        kinds = {i["kind"] for i in items}
        ok(kinds >= {"file", "share"}, f"一个列表同时含两类（{kinds}）")
        ok(all("password" not in i for i in items), "列表里绝不含 password 字段")
        mine = [i for i in items if i["path"] == plain_rel]
        ok(len(mine) == 2, f"同一路径下有 2 条（直链 + 分享）：{len(mine)}")

        with httpx.Client(base_url=BASE, timeout=20.0, trust_env=False,
                          follow_redirects=False) as guest:
            ok(guest.get("/api/links").status_code == 401, "未登录不能列链接")
            ok(guest.get("/api/shortlink", params={"mount": label, "path": plain_rel})
               .status_code in (401, 403, 405), "未登录不能签发")

        print("\n[6] 统一撤销")
        ok(CLI.post("/api/links/revoke", data={"token": stok}).status_code == 200,
           "撤销分享")
        ok(CLI.post("/api/links/revoke", data={"token": tok}).status_code == 200,
           "撤销直链")
        with httpx.Client(base_url=BASE, timeout=20.0, trust_env=False,
                          follow_redirects=False) as guest:
            ok(guest.get(f"/s/{stok}").status_code == 404, "分享页立即失效")
            ok(guest.get(f"/f/{tok}").status_code == 404, "直链立即失效")

        print("\n[7] ★ 删文件 → 分享 + 直链一起失效（合并成一张表的收益）★")
        r = CLI.post("/api/shortlink", data={"mount": label, "path": plain_rel})
        t1 = r.json()["token"]
        r = CLI.post("/api/shares", data={"mount": label, "path": plain_rel,
                                          "ttl_days": 1})
        t2 = (r.json().get("share") or {}).get("token")
        r = CLI.post("/api/delete", data={"mount": label, "path": plain_rel})
        ok(r.status_code == 200, "删除文件成功", r.text[:160])
        ok((r.json() or {}).get("sharesRevoked", 0) >= 2,
           "★ 报告失效条数 >= 2（分享 + 直链都算）★", r.text[:160])
        with httpx.Client(base_url=BASE, timeout=20.0, trust_env=False,
                          follow_redirects=False) as guest:
            ok(guest.get(f"/f/{t1}").status_code == 404, "旧直链随之失效")
            ok(guest.get(f"/s/{t2}").status_code == 404, "旧分享随之失效")

    finally:
        # ------------------------------------------------------------------
        # 清理：删临时目录 → 回读确认 404
        # ------------------------------------------------------------------
        print("\n[8] 清理")
        r = CLI.post("/api/delete", data={"mount": label, "path": "/" + base_dir})
        ok(r.status_code == 200, f"删除临时目录 /{base_dir}", r.text[:160])
        # /api/stat 是 **GET**（query 参数），别写成 POST
        r = CLI.get("/api/stat", params={"mount": label, "path": "/" + base_dir})
        gone = r.status_code != 200
        ok(gone, "回读确认临时目录已不存在", f"HTTP {r.status_code} {r.text[:120]}")
        # 顺手把残留的链接也清掉（万一上面某步失败留下了）
        try:
            for it in (CLI.get("/api/links").json().get("items") or []):
                if base_dir in (it.get("path") or ""):
                    CLI.post("/api/links/revoke", data={"token": it["token"]})
        except Exception:  # noqa: BLE001
            pass

    print(f"\n结果：{pass_n} 通过 / {fail_n} 失败\n")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
