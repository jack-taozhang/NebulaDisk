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

import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

# ---- 必须在 import app 之前设好环境（settings 是 import 期读的）----
_TMP = Path(tempfile.mkdtemp(prefix="nebula-share-test-"))
_SHARE_DIR = _TMP / "share"
_SHARE_DIR.mkdir(parents=True, exist_ok=True)
(_SHARE_DIR / "hello.txt").write_text("hello nebula\n", encoding="utf-8")
(_SHARE_DIR / "secret.txt").write_text("TOP SECRET\n", encoding="utf-8")
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
        ok(bool(tok) and len(tok) >= 24, "token 足够长（不可枚举）", f"len={len(tok or '')}")
        ok(bool(sh.get("url")) and tok in (sh.get("url") or ""), "返回了完整链接")
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
        r = cli.post("/api/shares", data={
            "mount": "共享", "path": "/hello.txt", "ttl_days": -1, "max_visits": 0,
        })
        # ttl_days<=0 → 永久
        ptok2 = (r.json().get("share") or {}).get("token")
        ok((r.json().get("share") or {}).get("expiresAt") == 0, "ttl_days=-1 → 永久有效")

        r = cli.post("/api/shares", data={
            "mount": "共享", "path": "/hello.txt", "ttl_days": 7, "max_visits": 1,
        })
        vtok = (r.json().get("share") or {}).get("token")
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

    print(f"\n结果：{pass_n} 通过 / {fail_n} 失败\n")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
