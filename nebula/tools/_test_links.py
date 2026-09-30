# -*- coding: utf-8 -*-
"""_test_links.py —— **统一链接模型**（短链 `/f/` + 分享 `/s/`）的集成测试。

背景（用户报障原话）：
    「网盘里面自带的分享也纳入一起，采用短链的方式分享。管理纳入一起。」

原先短链与分享各一套存储 ⇒ ① `/s/` 的地址比 `/f/` 长一截
② 删文件时只清了分享、没清短链（死链残留）③ 管理要开两个地方。

本测试盯的就是这三条，外加**迁移**（老库必须能原地升上来）。

★ 一条重要的方法论 ★
  「迁移」这类一次性逻辑**必须有测试**：它只会在真实库上跑一次，
  跑错了现场就没了。所以本文件**先手工造一个 v1 老库**，
  再 import app 让它自己迁，最后逐列核对。

运行：
  python -m tools._test_links            （在 nebula/ 下）
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

# ---------------------------------------------------------------------------
# 0. 造环境 —— ★ 必须在 import app 之前 ★（settings 是 import 期读的）
# ---------------------------------------------------------------------------
_TMP = Path(tempfile.mkdtemp(prefix="nebula-links-test-"))
_DIR = _TMP / "drive"
_DIR.mkdir(parents=True, exist_ok=True)
(_DIR / "hello.txt").write_text("hello nebula\n", encoding="utf-8")
(_DIR / "evil.bat").write_text("@echo off\necho pwned\n", encoding="utf-8")
(_DIR / "victim.txt").write_text("to be deleted\n", encoding="utf-8")
# 目录：用来验证「目录不能签直链」
(_DIR / "sub").mkdir(exist_ok=True)

_DATA = _TMP / "data"
_DATA.mkdir(parents=True, exist_ok=True)

os.environ.setdefault("NEBULA_DATA_DIR", str(_DATA))
os.environ["NEBULA_MOUNTS"] = f"共享|{_DIR}|*"
os.environ["NEBULA_ADMIN_USER"] = "admin"
os.environ["NEBULA_ADMIN_PASSWORD"] = "TestPass@2026"
os.environ.setdefault("NEBULA_JWT_SECRET", "test-secret-do-not-use-in-prod")

# ---- 造一个 v1 老库：links 只有 7 列、另有独立的 shares 表 ----
_LEGACY_FILE_TOKEN = "legacyFile01"      # 12 字符（与旧实现一致）
_LEGACY_SHARE_TOKEN = "L" * 32           # 32 字符（旧分享 token 规格）

_db = sqlite3.connect(str(_DATA / "nebula.db"))
_db.executescript("""
CREATE TABLE links (
    token       TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    mount       TEXT NOT NULL,
    path        TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_links_target ON links(owner, mount, path);
CREATE INDEX idx_links_owner ON links(owner, created_at DESC);

CREATE TABLE shares (
    token       TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    mount       TEXT NOT NULL,
    path        TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    is_dir      INTEGER NOT NULL DEFAULT 0,
    password    TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL DEFAULT 0,
    max_visits  INTEGER NOT NULL DEFAULT 0,
    visits      INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_shares_owner ON shares(owner, created_at DESC);
""")
_db.execute(
    "INSERT INTO links (token, owner, mount, path, name, created_at, hits)"
    " VALUES (?,?,?,?,?,?,?)",
    (_LEGACY_FILE_TOKEN, "admin", "共享", "/hello.txt", "hello.txt", 1700000000, 7),
)
_db.execute(
    "INSERT INTO shares (token, owner, mount, path, name, is_dir, password,"
    " created_at, expires_at, max_visits, visits, note)"
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    (_LEGACY_SHARE_TOKEN, "admin", "共享", "/hello.txt", "hello.txt", 0, "",
     1700000001, 0, 0, 3, "老库留档"),
)
_db.commit()
_db.close()

from fastapi.testclient import TestClient  # noqa: E402

from app import shortlink, shares, users  # noqa: E402
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


def _login(cli, user="admin", pw="TestPass@2026"):
    return cli.post("/api/login", data={"username": user, "password": pw})


def main() -> int:
    users.init_db()
    shares.init_db()          # ← 兼容壳，内部会触发 shortlink 的惰性迁移

    print("\n[1] ★ 老库迁移（v1 links + 独立 shares 表 → 统一 links）")
    with sqlite3.connect(str(_DATA / "nebula.db")) as c:
        c.row_factory = sqlite3.Row
        cols = {r[1] for r in c.execute("PRAGMA table_info(links)")}
        for need in ("kind", "is_dir", "password", "expires_at", "max_visits",
                     "visits", "note", "last_access_at"):
            ok(need in cols, f"links 补上了新列 {need}")
        rows = {r["token"]: r for r in c.execute("SELECT * FROM links")}
        ok(_LEGACY_FILE_TOKEN in rows, "老的直链行没丢")
        ok(rows[_LEGACY_FILE_TOKEN]["kind"] == "file", "老行被判为 kind='file'")
        ok(rows[_LEGACY_FILE_TOKEN]["hits"] == 7, "老的 hits 保留",
           rows[_LEGACY_FILE_TOKEN]["hits"])
        ok(_LEGACY_SHARE_TOKEN in rows, "老的分享行已并入 links")
        if _LEGACY_SHARE_TOKEN in rows:
            r = rows[_LEGACY_SHARE_TOKEN]
            ok(r["kind"] == "share", "老分享的 kind='share'")
            ok(r["visits"] == 3, "老分享的 visits 保留", r["visits"])
            ok(r["note"] == "老库留档", "老分享的 note 保留", repr(r["note"]))
        names = {r[0] for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        ok("shares" not in names, "旧 shares 表已改名（不再叫 shares）")
        ok(any(n.startswith("shares_migrated") for n in names),
           "旧表留档为 shares_migrated*（不 DROP，可回捞）", sorted(names))
        idx = {r[0]: r[1] for r in c.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index'"
            " AND name LIKE 'idx_links%'")}
        ok("idx_links_target" not in idx, "v1 的全表唯一索引已删除")
        ok(any("kind = 'file'" in (v or "") for v in idx.values()),
           "改成了只约束 file 的部分唯一索引", idx)

    ok(shares.get(_LEGACY_SHARE_TOKEN) is not None, "兼容壳能取到迁移过来的分享")
    ok(shares.get(_LEGACY_FILE_TOKEN) is None,
       "★ 兼容壳取直链 token 必须返回 None（kind 隔离）★")

    with TestClient(app) as cli:
        users.create("bob", "BobPass@2026")
        ok(_login(cli).status_code == 200, "管理员登录")

        print("\n[2] 签发：token 规格与幂等")
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/hello.txt"})
        ok(r.status_code == 200, "签发直链成功", r.text[:200])
        j = r.json()
        ftok = j.get("token")
        ok(len(ftok or "") == 12, "直链 token 是 12 字符", f"len={len(ftok or '')}")
        ok((j.get("url") or "").endswith(f"/f/{ftok}"), "地址是 /f/<token>", j.get("url"))
        ok(len(j.get("url") or "") <= 60, "整条地址足够短", f"{len(j.get('url') or '')} 字符")

        r2 = cli.post("/api/shortlink", data={"mount": "共享", "path": "/hello.txt"})
        ok(r2.json().get("token") == ftok, "同一文件重复签发 → 同一个 token（幂等）")

        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/sub"})
        ok(r.status_code == 400, "目录不能签直链（引导用分享）", f"HTTP {r.status_code}")

        print("\n[3] ★ 直链与分享可以共存于同一路径（部分唯一索引）★")
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                         "ttl_days": 7})
        ok(r.status_code == 200, "同一路径仍可创建分享",
           f"HTTP {r.status_code} {r.text[:200]}")
        stok = (r.json().get("share") or {}).get("token")
        ok(len(stok or "") == 12, "分享 token 也是 12 字符", f"len={len(stok or '')}")
        ok(stok != ftok, "分享 token 与直链 token 不同（各是一条记录）")
        ok(shares.get(ftok) is None, "★ 分享接口拿直链 token 取不到 ★")
        ok(shortlink.get_kind(stok, "file") is None, "★ 直链通道拿分享 token 取不到 ★")

        print("\n[4] /f/<token> 落地端")
        with TestClient(app) as guest:          # ★ 全新 client = 未登录 ★
            r = guest.get(f"/f/{ftok}")
            ok(r.status_code == 200, "免登录直取成功", f"HTTP {r.status_code}")
            # ⚠️ 别拿原始字节比：Windows 上 write_text 会把 \n 落成 \r\n
            ok(r.text.strip() == "hello nebula", "字节内容正确", repr(r.content[:40]))
            ok("location" not in {k.lower() for k in r.headers},
               "是吐字节而不是 302（地址栏不会变回长链）",
               dict(r.headers))
            ok(r.headers.get("cache-control") == "no-store", "响应带 no-store")

            r = guest.get(f"/f/{ftok}", params={"dl": "1"})
            ok("attachment" in (r.headers.get("content-disposition") or ""),
               "?dl=1 → attachment", r.headers.get("content-disposition"))

            r = guest.get("/f/NOT-A-REAL-TOKEN")
            ok(r.status_code == 404, "伪造 token → 404", f"HTTP {r.status_code}")

        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/evil.bat"})
        etok = (r.json() or {}).get("token")
        with TestClient(app) as guest:
            r = guest.get(f"/f/{etok}")
            ok("attachment" in (r.headers.get("content-disposition") or ""),
               "★ 危险扩展名（.bat）即使不传 dl 也强制 attachment ★",
               r.headers.get("content-disposition"))

        print("\n[5] ★ 死链惰性自清（/f 命中 404 时删掉那一行）★")
        ghost = _DIR / "ghost.txt"
        ghost.write_text("ghost\n", encoding="utf-8")
        gtok = cli.post("/api/shortlink", data={"mount": "共享", "path": "/ghost.txt"}
                        ).json()["token"]
        ghost.unlink()          # ★ 绕过 /api/delete（模拟在插件之外被删）★
        with TestClient(app) as guest:
            ok(guest.get(f"/f/{gtok}").status_code == 404, "文件没了 → /f 404")
        after = [i["token"] for i in cli.get("/api/links").json()["items"]]
        ok(gtok not in after, "该条已从管理列表里消失（不再挂死链）")

        print("\n[6] 统一列表 /api/links")
        with TestClient(app) as guest:
            ok(guest.get("/api/links").status_code == 401,
               "未登录不能列链接", "未登录应 401")
        r = cli.get("/api/links")
        ok(r.status_code == 200, "登录后可列链接", r.text[:200])
        j = r.json()
        items = j.get("items") or []
        kinds = {i["kind"] for i in items}
        ok(kinds >= {"file", "share"}, f"一个列表里同时有直链与分享（{kinds}）")
        ok(j.get("files", 0) >= 1 and j.get("shares", 0) >= 1,
           f"计数正确 files={j.get('files')} shares={j.get('shares')}")
        ok(all("password" not in i for i in items), "列表里绝不出现 password 字段")
        furls = [i["url"] for i in items if i["kind"] == "file"]
        surls = [i["url"] for i in items if i["kind"] == "share"]
        ok(furls and all("/f/" in u for u in furls), "file 类给的是 /f/ 地址")
        ok(surls and all("/s/" in u for u in surls), "share 类给的是 /s/ 地址")

        print("\n[7] 统一撤销 /api/links/revoke")
        with TestClient(app) as bob:
            _login(bob, "bob", "BobPass@2026")
            ok(bob.post("/api/links/revoke", data={"token": ftok}).status_code == 404,
               "★ 非 owner 撤销被拒 ★")
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                         "ttl_days": 7})
        kill_share = (r.json().get("share") or {}).get("token")
        ok(cli.post("/api/links/revoke", data={"token": kill_share}).status_code == 200,
           "统一入口能撤销**分享**")
        ok(cli.post("/api/links/revoke", data={"token": ftok}).status_code == 200,
           "统一入口能撤销**直链**")
        with TestClient(app) as guest:
            ok(guest.get(f"/f/{ftok}").status_code == 404, "撤销后直链立即失效")
            ok(guest.get(f"/s/{kill_share}").status_code == 404, "撤销后分享页立即失效")
        ok(cli.post("/api/links/revoke", data={"token": ""}).status_code == 400,
           "空 token → 400")

        print("\n[8] 旧入口 /api/shortlink/revoke 仍兼容")
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/victim.txt"})
        old_tok = (r.json() or {}).get("token")
        ok(cli.post("/api/shortlink/revoke",
                    data={"token": old_tok}).status_code == 200,
           "旧撤销入口可用")
        with TestClient(app) as guest:
            ok(guest.get(f"/f/{old_tok}").status_code == 404, "旧入口撤销也真的生效")

        print("\n[9] /api/links/update 只对分享有意义")
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                         "ttl_days": 7, "note": "改前"})
        utok = (r.json().get("share") or {}).get("token")
        r = cli.post("/api/links/update",
                     data={"token": utok, "ttl_days": 30, "note": "改后"})
        ok(r.status_code == 200, "改分享有效", r.text[:200])
        upd = (r.json().get("link") or {})
        ok(upd.get("note") == "改后", "备注改成功", upd.get("note"))
        ok(upd.get("expiresAt", 0) > 0, "有效期仍有效")
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/hello.txt"})
        r = cli.post("/api/links/update", data={"token": r.json()["token"],
                                                "ttl_days": 1})
        ok(r.status_code == 400, "对直链改有效期 → 400（直链没有这个维度）",
           f"HTTP {r.status_code}")

        print("\n[10] /api/links/revoke-dead 一键清失效分享")
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                         "ttl_days": -1})       # 永久
        alive_tok = (r.json().get("share") or {}).get("token")
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                         "ttl_days": 7, "max_visits": 1})
        dead_tok = (r.json().get("share") or {}).get("token")
        with TestClient(app) as guest:      # 用掉唯一一次访问 ⇒ 变"次数用尽"
            guest.get(f"/api/s/{dead_tok}/raw", params={"path": ""})
        r = cli.post("/api/links/revoke-dead")
        ok(r.status_code == 200 and r.json().get("revoked", 0) >= 1,
           "清理了失效分享", r.text[:160])
        left = {i["token"] for i in cli.get("/api/links").json()["items"]}
        ok(dead_tok not in left, "次数用尽的那条已删除")
        ok(alive_tok in left, "仍有效的分享**没有**被误删")

        print("\n[11] ★★ fileops 联动：删文件同时清掉直链 + 分享 ★★")
        # 这是合并成一张表最直接的收益：fileops 只调了 shares.revoke_under_path，
        # 但因为它现在走统一存储，直链也一起清了。
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/victim.txt"})
        v_tok = r.json()["token"]
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/victim.txt",
                                         "ttl_days": 7})
        v_stok = (r.json().get("share") or {}).get("token")
        r = cli.post("/api/delete", data={"mount": "共享", "path": "/victim.txt"})
        ok(r.status_code == 200, "删除文件成功", r.text[:160])
        ok((r.json() or {}).get("sharesRevoked", 0) >= 2,
           "★ 报告失效条数 ≥ 2（分享 + 直链都算上）★", r.text[:160])
        with TestClient(app) as guest:
            ok(guest.get(f"/f/{v_tok}").status_code == 404, "旧直链已失效")
            ok(guest.get(f"/s/{v_stok}").status_code == 404, "旧分享已失效")

    print(f"\n结果：{pass_n} 通过 / {fail_n} 失败\n")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
