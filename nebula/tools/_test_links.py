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

import builtins
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

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
# ★ 2026-10-01 新增两个：老库**允许**同一路径有多条分享（当时就是这个行为），
#   而新规则是一个目标只留一条 ⇒ 迁移必须「**先去重、再建唯一索引**」。
#   ① 同 owner 同路径、创建得更晚 → 必须被删（保留最早那条）
#   ② 换成 bob               → **必须保留**（唯一性是 owner 级的，不是全局的）
_DUP_SHARE_TOKEN = "D" * 32
_OTHER_OWNER_SHARE_TOKEN = "O" * 32

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
# 重复项（更晚创建，同 owner）→ 迁移时应被删掉，且**不能**让迁移整体失败
_db.execute(
    "INSERT INTO shares (token, owner, mount, path, name, is_dir, password,"
    " created_at, expires_at, max_visits, visits, note)"
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    (_DUP_SHARE_TOKEN, "admin", "共享", "/hello.txt", "hello.txt", 0, "",
     1700000002, 0, 0, 0, "重复分享"),
)
# 同路径但**另一个 owner** → 必须原样保留（唯一性按 owner 分）
_db.execute(
    "INSERT INTO shares (token, owner, mount, path, name, is_dir, password,"
    " created_at, expires_at, max_visits, visits, note)"
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    (_OTHER_OWNER_SHARE_TOKEN, "bob", "共享", "/hello.txt", "hello.txt", 0, "",
     1700000003, 0, 0, 0, "别人的分享"),
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
        # ★★ 2026-10-01：分享侧也要「一个目标一条」★★
        #   用户报障原文：「同一个文件目前可以分享多个路径，这样调整为同一个
        #   文件只能分享一个路径，直连一个路径。」
        ok("idx_links_target_share" in idx,
           "★ 新增分享的部分唯一索引 idx_links_target_share ★", sorted(idx))
        ok(any("kind = 'share'" in (v or "") for v in idx.values()),
           "它是只约束 share 的**部分**索引（file 那条由另一个索引管）", idx)
        # ★ 去重必须发生在建索引**之前**：重复行还在时 CREATE UNIQUE INDEX
        #   会直接报错 ⇒ 整个迁移失败、所有老库都升不上来。
        #   这里的两条断言正好夹住这个顺序。
        ok(_DUP_SHARE_TOKEN not in rows,
           "★ 同 owner 同路径的**重复分享已被去重**（否则上面那条索引建不出来）★",
           f"存活 {len(rows)} 行")
        ok(_LEGACY_SHARE_TOKEN in rows,
           "…保留的是**最早创建**的那条（误点产生的重复里它最可能已发出去）")
        ok(_OTHER_OWNER_SHARE_TOKEN in rows,
           "★ 另一个 owner 对**同一路径**的分享没被误删（唯一性是 owner 级的）★")

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
        ok(ftok == _LEGACY_FILE_TOKEN, "复用 v1 老库留下的那条直链（幂等）", ftok)
        # ★ 历史遗留的直链 expires_at=0（永久）⇒ 不该被"新规则"改小 ★
        #   把已经发出去的链接有效期缩短，是会坑到用户的。
        ok((j.get("expiresAt") or 0) == 0,
           "★ 老库里的永久直链保持永久（不擅自改小已发出的链接）★",
           f"expiresAt={j.get('expiresAt')}")

        # 全新文件 → 走新规则：★ 用户要求「直链 默认 也按7天来」★
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/victim.txt"})
        j = r.json()
        ok(r.status_code == 200, "为全新文件签发直链", r.text[:160])
        exp = j.get("expiresAt") or 0
        ok(exp > time.time(), "新直链有有效期（不再是永久）", f"expiresAt={exp}")
        left = exp - time.time()
        ok(7 * 86400 - 120 <= left <= 7 * 86400 + 120,
           "★ 直链默认有效期 = 7 天 ★", f"剩余 {left / 86400:.2f} 天")
        # ttl_days 显式覆盖
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/victim.txt",
                                             "ttl_days": 0})
        ok((r.json().get("expiresAt") or 0) == 0, "ttl_days=0 → 永久（显式要求才算）")
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/victim.txt"})
        ok((r.json().get("expiresAt") or 0) == 0,
           "已存在的直链不会被无参调用改回 7 天（幂等优先）")

        r2 = cli.post("/api/shortlink", data={"mount": "共享", "path": "/hello.txt"})
        ok(r2.json().get("token") == ftok, "同一文件重复签发 → 同一个 token（幂等）")

        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/sub"})
        ok(r.status_code == 400, "目录不能签直链（引导用分享）", f"HTTP {r.status_code}")

        print("\n[3] ★ 直链与分享可以共存于同一路径（部分唯一索引）★")
        # ⚠️ 2026-10-01 规则反转后，这一段的行为**变了**，必须看清：
        #   /hello.txt 上**已经**有一条老库迁过来的 admin 分享
        #   （`_LEGACY_SHARE_TOKEN`，32 字符的老规格），
        #   而新规则是「一个目标只留一条、再创建就是**原地更新**」
        #   ⇒ 这次调用必然**复用**那条老分享（token 不变、reused=true），
        #     拿到的当然不是新建的 12 字符 token。
        #   "新建 token 是 12 字符"因此挪到 [16]（那里是真正全新的目标）去验，
        #   免得把"复用了老分享"误判成"token 长度不对"。
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                         "ttl_days": 7})
        ok(r.status_code == 200, "同一路径仍可创建分享",
           f"HTTP {r.status_code} {r.text[:200]}")
        _rj3 = r.json() or {}
        stok = (_rj3.get("share") or {}).get("token")
        ok(stok == _LEGACY_SHARE_TOKEN,
           "★ 与老库那条分享**是同一把地址**（同目标只留一条，不再签第二条）★",
           f"{_LEGACY_SHARE_TOKEN} -> {stok}")
        ok(_rj3.get("reused") is True, "响应里 reused=true", str(_rj3.get("reused")))
        ok(stok != ftok, "分享 token 与直链 token 不同（各是一条记录）")
        ok(shares.get(ftok) is None, "★ 分享接口拿直链 token 取不到 ★")
        ok(shortlink.get_kind(stok, "file") is None, "★ 直链通道拿分享 token 取不到 ★")
        # 共存的正面判据：同一路径上两条记录都在，且 kind 各就各位
        _r3map = {i["token"]: i for i in cli.get("/api/links").json()["items"]}
        ok(_r3map.get(ftok, {}).get("kind") == "file"
           and _r3map.get(stok, {}).get("kind") == "share",
           "★ 同一路径上「直链(kind=file) + 分享(kind=share)」并存 ★",
           f"file={_r3map.get(ftok, {}).get('kind')} "
           f"share={_r3map.get(stok, {}).get('kind')}")

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

        print("\n[9] /api/links/update：备注与有效期两类都行，次数/提取码只对分享")
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
        _ftok_for_ttl = r.json()["token"]
        r = cli.post("/api/links/update", data={"token": _ftok_for_ttl, "ttl_days": 1})
        ok(r.status_code == 200, "★ 直链也能改有效期（续期）★", f"HTTP {r.status_code} {r.text[:120]}")
        _newleft = (r.json().get("link") or {}).get("expiresAt", 0) - time.time()
        ok(0 < _newleft <= 86400 + 120, "改成 1 天后确实是 1 天", f"{_newleft / 86400:.2f} 天")
        r = cli.post("/api/links/update", data={"token": _ftok_for_ttl, "ttl_days": 0})
        ok((r.json().get("link") or {}).get("expiresAt") == 0,
           "直链也能改为永久有效（ttl_days=0）")
        r = cli.post("/api/links/update", data={"token": _ftok_for_ttl, "max_visits": 5})
        ok(r.status_code == 400, "★ 直链改次数上限仍 → 400（那是分享特有的）★",
           f"HTTP {r.status_code}")

        print("\n[10] /api/links/revoke-dead 一键清失效链接（过期 / 超次）")
        # ★ 两条分享必须落在**不同路径**上（2026-10-01 起一个目标只留一条）★
        #   原先两条都建在 /hello.txt 上：当时的语义是"同一文件多条分享"，
        #   第二条会覆盖第一条，于是 alive_tok == dead_tok，
        #   "仍有效的分享没有被误删"就变成了一句自相矛盾的断言。
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/sub",
                                         "ttl_days": -1})       # 永久
        alive_tok = (r.json().get("share") or {}).get("token")
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                         "ttl_days": 7, "max_visits": 1})
        dead_tok = (r.json().get("share") or {}).get("token")
        ok(bool(alive_tok) and bool(dead_tok) and alive_tok != dead_tok,
           "两条分享落在不同路径上，token 不同（同目标才会复用）",
           f"{alive_tok} / {dead_tok}")
        with TestClient(app) as guest:      # 用掉唯一一次访问 ⇒ 变"次数用尽"
            guest.get(f"/api/s/{dead_tok}/raw", params={"path": ""})
        r = cli.post("/api/links/revoke-dead")
        ok(r.status_code == 200 and r.json().get("revoked", 0) >= 1,
           "清理了失效分享", r.text[:160])
        left = {i["token"] for i in cli.get("/api/links").json()["items"]}
        ok(dead_tok not in left, "次数用尽的那条已删除")
        ok(alive_tok in left, "仍有效的分享**没有**被误删")

        # ★ 直链现在也会过期 ⇒ 也要被清掉（同时不能误伤没过期的直链）★
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/hello.txt"})
        f_expired = r.json()["token"]
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/evil.bat"})
        f_alive = r.json()["token"]
        _c2 = sqlite3.connect(str(_DATA / "nebula.db"))
        _c2.execute("UPDATE links SET expires_at = 1 WHERE token = ?", (f_expired,))
        _c2.commit()
        _c2.close()
        r = cli.post("/api/links/revoke-dead")
        ok(r.status_code == 200, "清理接口可用", r.text[:120])
        left2 = {i["token"] for i in cli.get("/api/links").json()["items"]}
        ok(f_expired not in left2, "★ 过期的**直链**也被清掉 ★")
        ok(f_alive in left2, "没过期的直链没被误删")

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

        print("\n[12] ★ 换一条地址（rotate）★")
        # 分享：带提取码 + 次数上限 + 备注，rotate 后这些参数必须**原样继承**
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                          "ttl_days": 7, "max_visits": 5,
                                          "password": "4321", "note": "给张工的"})
        o = (r.json().get("share") or {})
        otok = o.get("token")
        r = cli.post("/api/links/rotate", data={"token": otok})
        ok(r.status_code == 200, "分享换地址成功", r.text[:200])
        n = (r.json().get("link") or {})
        ntok = n.get("token")
        ok(bool(ntok) and ntok != otok, "拿到了**不同**的新 token",
           f"{otok} -> {ntok}")
        ok(n.get("kind") == "share", "类型仍是 share")
        ok(n.get("hasPassword") is True, "提取码被继承（hasPassword）")
        ok(n.get("maxVisits") == 5, "次数上限被继承", n.get("maxVisits"))
        ok(n.get("note") == "给张工的", "备注被继承", repr(n.get("note")))
        delta = (n.get("expiresAt") or 0) - (o.get("expiresAt") or 0)
        ok(abs(delta) <= 5, "有效期继承的是**剩余**时间（不凭空延长）",
           f"expiresAt 差 {delta}s")
        # 旧提取码必须继续可用（哈希是原样带过去的）
        with TestClient(app) as guest:
            g = guest.get(f"/api/s/{ntok}/list", params={"path": ""})
            ok(g.status_code == 403, "新分享仍要求提取码")
            ok(guest.post(f"/api/s/{ntok}/unlock",
                          data={"password": "4321"}).status_code == 200,
               "原提取码在新地址上有效")
        with TestClient(app) as guest:
            ok(guest.get(f"/s/{otok}").status_code == 404, "★ 旧分享地址立刻失效 ★")
            ok(guest.get(f"/s/{ntok}").status_code == 200, "★ 新分享地址可用 ★")

        # 永久分享 → rotate 后仍永久
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                          "ttl_days": -1})
        ptok = (r.json().get("share") or {}).get("token")
        r = cli.post("/api/links/rotate", data={"token": ptok})
        ok((r.json().get("link") or {}).get("expiresAt") == 0,
           "永久分享换地址后仍永久")

        # 已过期的分享 → rotate 要给一个可用的新有效期（否则出来就是死的）
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/hello.txt",
                                          "ttl_days": 7})
        etok2 = (r.json().get("share") or {}).get("token")
        _c = sqlite3.connect(str(_DATA / "nebula.db"))
        _c.execute("UPDATE links SET expires_at = 1 WHERE token = ?", (etok2,))
        _c.commit()
        _c.close()
        r = cli.post("/api/links/rotate", data={"token": etok2})
        nl = r.json().get("link") or {}
        ok(r.status_code == 200 and nl.get("expiresAt", 0) > time.time(),
           "★ 已过期的分享换地址后重新可用（给了默认 7 天）★", r.text[:160])
        ok(nl.get("alive") is True, "新链接状态为有效")

        # 直链
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/hello.txt"})
        f_old = r.json()["token"]
        r = cli.post("/api/links/rotate", data={"token": f_old})
        ok(r.status_code == 200, "直链换地址成功", r.text[:160])
        f_new = (r.json().get("link") or {}).get("token")
        ok(f_new and f_new != f_old, "直链拿到新 token", f"{f_old} -> {f_new}")
        with TestClient(app) as guest:
            ok(guest.get(f"/f/{f_old}").status_code == 404, "旧直链失效")
            ok(guest.get(f"/f/{f_new}").status_code == 200, "新直链可用")

        # 权限与边界
        with TestClient(app) as bob:
            _login(bob, "bob", "BobPass@2026")
            ok(bob.post("/api/links/rotate", data={"token": f_new}).status_code == 404,
               "★ 非 owner 换地址被拒 ★")
        ok(cli.post("/api/links/rotate", data={"token": ""}).status_code == 400,
           "空 token → 400")
        ok(cli.post("/api/links/rotate", data={"token": "NOPE-xxxx"}).status_code == 404,
           "不存在的 token → 404")

        print("\n[13] 备注：两类都能改，其余参数只对分享开放")
        r = cli.post("/api/links/update", data={"token": f_new, "note": "直链也能标注"})
        ok(r.status_code == 200, "★ 直链可改备注（本轮新增）★", r.text[:160])
        ok((r.json().get("link") or {}).get("note") == "直链也能标注", "备注写进去了")
        r = cli.post("/api/links/update", data={"token": f_new, "ttl_days": 1})
        ok(r.status_code == 200, "★ 直链也能改有效期 ★", f"HTTP {r.status_code}")
        r = cli.post("/api/links/update", data={"token": f_new, "max_visits": 3})
        ok(r.status_code == 400, "直链改次数上限 → 400（那是分享特有的）",
           f"HTTP {r.status_code}")

        print("\n[14] ★ 直链过期后的行为 ★")
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/evil.bat"})
        xtok = r.json()["token"]
        with TestClient(app) as guest:
            ok(guest.get(f"/f/{xtok}").status_code == 200, "过期前 /f 可用")
        _c3 = sqlite3.connect(str(_DATA / "nebula.db"))
        _c3.execute("UPDATE links SET expires_at = 1 WHERE token = ?", (xtok,))
        _c3.commit()
        _c3.close()
        with TestClient(app) as guest:
            rr = guest.get(f"/f/{xtok}")
            ok(rr.status_code == 410, "★ 过期后 /f → 410（不再吐字节）★",
               f"HTTP {rr.status_code}")
            ok("过期" in rr.text, "提示里说清是过期（可去续期）", rr.text[:120])
        # ★ 行必须留着，否则面板里看不到它、也就没法续期 ★
        still = {i["token"] for i in cli.get("/api/links").json()["items"]}
        ok(xtok in still, "过期的直链**仍留在列表里**（可续期，不是被偷偷删掉）")
        # 幂等签发：命中已过期的行时要自动续期，否则用户拿到的是一条死链
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/evil.bat"})
        ok(r.json()["token"] == xtok, "重新签发仍是同一条地址（幂等，token 不变）")
        ok((r.json().get("expiresAt") or 0) > time.time() + 6.5 * 86400,
           "★ 命中已过期的直链时自动续期（否则拿到的是死链）★",
           f"expiresAt={r.json().get('expiresAt')}")
        with TestClient(app) as guest:
            ok(guest.get(f"/f/{xtok}").status_code == 200, "续期后 /f 又能用了")

        print("\n[15] ★★ 文件「读不出内容」⇒ 必须明确报错，不能发 200 + 0 字节 ★★")
        # 背景（用户报障原话）：「目前本机OO 打开文件有问题。排查一下」
        #   真因是 Windows 上的**云端占位文件**（OneDrive / Nextcloud 按需同步）：
        #     stat 报出真实大小，read 却只拿到 0 字节（WSL 的 drvfs/9p 挂载上尤其明显）。
        #   不设防的后果实测：FileResponse 先发 Content-Length，再发 0 字节 ⇒
        #     OnlyOffice 转圈约 20 秒后「下载文件失败」，服务端只留一条 ASGI 层的
        #     `RuntimeError: Response content shorter than Content-Length`。
        #   所以 webutil.probe_readable() 先探 1 字节，读不到就 503 + 人话。
        (_DIR / "ghost.bin").write_bytes(b"x" * 2048)
        r = cli.post("/api/shortlink", data={"mount": "共享", "path": "/ghost.bin"})
        gtok = r.json()["token"]
        with TestClient(app) as guest:
            _g = guest.get(f"/f/{gtok}")
            ok(_g.status_code == 200 and _g.content == b"x" * 2048,
               "能读的文件照旧 200 + 正确字节", f"HTTP {_g.status_code}")

        _real_open = builtins.open

        def _zeros_open(file, *a, **kw):
            """只对 ghost.bin 生效：模拟「open 成功、read 出来 0 字节」的占位文件。"""
            if str(file).endswith("ghost.bin"):
                import io
                return io.BytesIO(b"")
            return _real_open(file, *a, **kw)

        with mock.patch("builtins.open", _zeros_open):
            with TestClient(app) as guest:
                _r = guest.get(f"/f/{gtok}")
                ok(_r.status_code == 503,
                   "★ 读到 0 字节 → 503（而不是 200 + 0 字节）★",
                   f"HTTP {_r.status_code} {_r.text[:100]}")
                ok("不可读" in _r.text and "云" in _r.text,
                   "提示里说清是「内容不可读」并给了可能原因", _r.text[:160])

        def _eio_open(file, *a, **kw):
            """模拟 EIO（脱机 / 云盘客户端没跑时的典型报错）。"""
            if str(file).endswith("ghost.bin"):
                raise OSError(5, "Input/output error")
            return _real_open(file, *a, **kw)

        with mock.patch("builtins.open", _eio_open):
            with TestClient(app) as guest:
                _r = guest.get(f"/f/{gtok}")
                ok(_r.status_code == 503, "★ OSError(EIO) 也是 503 ★",
                   f"HTTP {_r.status_code}")

        # ★ 两个关键副作用，都必须守住 ★
        _items = {i["token"]: i for i in cli.get("/api/links").json()["items"]}
        ok(gtok in _items,
           "★ 503 **不是** 404 ⇒ 链接没被惰性自清误删（读不出来 ≠ 文件没了）★")
        ok(_items.get(gtok, {}).get("hits") == 1,
           "★ 探测在 touch() 之前 ⇒ 失败的那几次没白烧访问次数 ★",
           f"hits={_items.get(gtok, {}).get('hits')}")

        # =================================================================
        print("\n[16] ★★ 一个目标只有一条分享（2026-10-01 用户要求）★★")
        # =================================================================
        # 需求原文（附截图：同一个 .dwg 在链接管理里并排出现两条 /s/…）：
        #   「同一个文件目前可以分享多个路径，这样调整为同一个文件只能分享
        #     一个路径，直连一个路径。」
        #
        # ★ 这一节验的是**数据/接口层** ★
        #   交互层（已有分享时对话框不再给「创建链接」）由 SPA 真机脚本守：
        #   verify-spa-fixes.mjs 的 [4]。两层都要有 ——
        #   只做数据层去重的话，界面上照样摆着"再建一条"的按钮。
        (_DIR / "once.txt").write_text("once\n", encoding="utf-8")
        r1 = cli.post("/api/shares", data={"mount": "共享", "path": "/once.txt",
                                          "ttl_days": 7})
        j1 = r1.json()
        t1 = (j1.get("share") or {}).get("token")
        ok(r1.status_code == 200 and bool(t1), "第一次创建分享", r1.text[:160])
        # 新地址的规格：12 字符（从 [3] 挪过来 —— 那里命中的是老库 32 字符的旧分享）
        ok(len(t1 or "") == 12, "★ 新建分享的 token 是 12 字符（新地址规格）★",
           f"len={len(t1 or '')} tok={t1}")
        ok(j1.get("reused") is False, "第一次是**新建**（reused=false）",
           str(j1.get("reused")))

        r2 = cli.post("/api/shares", data={"mount": "共享", "path": "/once.txt",
                                          "ttl_days": 30, "max_visits": 5,
                                          "password": "8888", "note": "第二遍"})
        j2 = r2.json()
        t2 = (j2.get("share") or {}).get("token")
        s2 = j2.get("share") or {}
        ok(t2 == t1, "★ 第二次创建 → **同一个 token**（不会再签一条地址）★",
           f"{t1} → {t2}")
        ok(j2.get("reused") is True, "★ 响应里 reused=true（前端据此换文案）★",
           str(j2.get("reused")))
        ok(s2.get("maxVisits") == 5, "这次传的次数上限**写进去了**",
           str(s2.get("maxVisits")))
        ok(s2.get("note") == "第二遍", "备注写进去了", repr(s2.get("note")))
        ok(s2.get("hasPassword") is True, "提取码写进去了", str(s2.get("hasPassword")))
        left_once = [i for i in cli.get("/api/links").json()["items"]
                     if i["kind"] == "share" and i["mount"] == "共享"
                     and i["path"].strip("/") == "once.txt"]
        ok(len(left_once) == 1, "★ 库里这个路径**只有一条分享** ★",
           f"{len(left_once)} 条")
        with TestClient(app) as guest:
            ok(guest.get(f"/api/s/{t1}/list",
                         params={"path": ""}).status_code == 403,
               "改过提取码后**旧地址继续有效**（只是要多输提取码）")
            ok(guest.post(f"/api/s/{t1}/unlock",
                          data={"password": "8888"}).status_code == 200,
               "新提取码在**同一个地址**上生效（地址没变 ⇒ 已发出去的链接不作废）")

        # 目录同理：复用 [10] 里那条 /sub 的分享
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/sub",
                                         "ttl_days": 7})
        ok((r.json().get("share") or {}).get("token") == alive_tok,
           "目录也一样复用（拿到的是 [10] 那条 /sub 的分享）",
           f"{(r.json().get('share') or {}).get('token')} vs {alive_tok}")

        # ★ 已经死掉的那条要**换掉**，不能原样返回 ★
        #   原样返回的后果：用户重新分享一次，拿到一条**打不开**的链接，
        #   而且界面上完全看不出来（这正是旧实现的毛病）。
        (_DIR / "dead.txt").write_text("dead\n", encoding="utf-8")
        _rj = cli.post("/api/shares", data={"mount": "共享", "path": "/dead.txt",
                                           "ttl_days": 7}).json()
        dtok = (_rj.get("share") or {}).get("token")
        _c4 = sqlite3.connect(str(_DATA / "nebula.db"))
        _c4.execute("UPDATE links SET expires_at = 1 WHERE token = ?", (dtok,))
        _c4.commit()
        _c4.close()
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/dead.txt",
                                          "ttl_days": 7})
        nd = (r.json().get("share") or {}).get("token")
        ok(bool(nd) and nd != dtok,
           "★ 命中**已过期**的那条 → 换一条新的（不是把死链还给他）★",
           f"{dtok} → {nd}")
        ok(r.json().get("reused") is False, "换掉之后 reused=false（确实是新的）")
        with TestClient(app) as guest:
            ok(guest.get(f"/api/s/{nd}").status_code == 200, "新地址当场可用")
            ok(guest.get(f"/api/s/{dtok}").status_code == 404, "旧的那条已经清掉")
        left_dead = [i for i in cli.get("/api/links").json()["items"]
                     if i["kind"] == "share" and i["mount"] == "共享"
                     and i["path"].strip("/") == "dead.txt"]
        ok(len(left_dead) == 1,
           "换掉之后仍然只有一条（不是「换一条留一条」）", f"{len(left_dead)} 条")

        # 次数用尽同理
        (_DIR / "used.txt").write_text("used\n", encoding="utf-8")
        _ru = cli.post("/api/shares", data={"mount": "共享", "path": "/used.txt",
                                           "ttl_days": 7, "max_visits": 1}).json()
        utok = (_ru.get("share") or {}).get("token")
        with TestClient(app) as guest:
            guest.get(f"/api/s/{utok}/raw", params={"path": ""})
        r = cli.post("/api/shares", data={"mount": "共享", "path": "/used.txt",
                                          "ttl_days": 7})
        nu = (r.json().get("share") or {}).get("token")
        ok(bool(nu) and nu != utok,
           "★ 次数用尽的那条也会被换掉（否则拿到的是一条 410）★",
           f"{utok} → {nu}")
        with TestClient(app) as guest:
            ok(guest.get(f"/api/s/{nu}/raw",
                         params={"path": ""}).status_code == 200,
               "新地址能正常取流")

        # ★ 幂等**不等于**把别人的分享也合掉：唯一性按 owner 分 ★
        with TestClient(app) as bob:
            _login(bob, "bob", "BobPass@2026")
            rb = bob.post("/api/shares", data={"mount": "共享", "path": "/once.txt",
                                               "ttl_days": 7})
            btok = (rb.json().get("share") or {}).get("token")
            ok(bool(btok) and btok != t1,
               "★ bob 对**同一个文件**能建自己的分享（不与 admin 的那条合并）★",
               f"bob={btok} admin={t1}")
            ok(rb.json().get("reused") is False, "对 bob 来说这是新建")
        adm_tokens = {i["token"] for i in cli.get("/api/links").json()["items"]}
        ok(t1 in adm_tokens and btok not in adm_tokens,
           "admin 的列表里看得到自己的、看不到 bob 的（owner 隔离仍成立）")

        # ★ 老库迁移留下的那条 32 字符 token 也还认（别的 owner）★
        ok(shortlink.get(_OTHER_OWNER_SHARE_TOKEN) is not None,
           "迁移保留下来的那条跨 owner 分享仍然可查")

    print(f"\n结果：{pass_n} 通过 / {fail_n} 失败\n")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(main())
