# -*- coding: utf-8 -*-
"""
NebulaDisk —— 文件/目录分享

需求（原文）：
    「增加文件分享的功能。」

设计要点（都是踩过坑才定下来的，改之前先读）：

  1. **分享 = 一条数据库记录 + 一个签名 token**
     记录里有 `token`（随机 32 字节），但**对外只出现 token，不出现自增 id** ——
     自增 id 可枚举（/s/1、/s/2 顺着试），token 不可枚举。
     token 用 secrets.token_urlsafe，落库前只存 sha256 摘要？

     ★ 不，这里**存明文 token**。理由：
       token 本身就是"分享凭证"，它不像密码那样需要防"库被拖后看到原文就能反推
       用户的其它密码"。而且分享页每次访问都要拿 token 去查库，
       存摘要意味着要么额外带 id（可枚举），要么全表扫 sha256（O(n)）。
       NAS 上分享条目通常几十条，全表扫也够快；但为了简单可靠，
       本项目选择**存明文 token + 唯一索引**。文档在此，知情选择。

  2. **权限继承**：分享不绕过映射可见性。
     创建时校验 (mount, path) 在创建者权限内；
     访问时**不再校验用户**（因为访客可能未登录），但分享记录里记着 `owner`，
     且 `mount` 必须在「该 owner 可见」的映射里 —— 防止 A 分享 B 的私密目录。

  3. **目录分享**：允许。访客可以像浏览一样逐层进（只读，不能写/删/上传）。
     这样"分享一个文件夹"才真正有用。

  4. **过期与次数**：
     - `expires_at = 0` 表示永不过期（默认给 7 天，见 DEFAULT_TTL）
     - `max_visits = 0` 表示不限次数
     - 每次成功访问计数 +1

  5. **密码**：可选。访客需先输入密码才看到内容。
     密码用 bcrypt（复用 users.hash_password），**不像 token 那样存明文**。
     校验通过后发一个 HttpOnly Cookie `nebula_share_<token前12位>`，
     避免每次翻页都要重输。
"""

from __future__ import annotations

import hmac
import secrets
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from . import users
from .config import settings

# 默认有效期：7 天。0 = 永不
DEFAULT_TTL_SECONDS = 7 * 24 * 3600

# 单次访问计数上限（防止恶意刷数）
MAX_TOKEN_LEN = 128


# ---------------------------------------------------------------------------
# 建表（并入 users.SCHEMA 之外的独立 SCHEMA，由 init_db 一起执行）
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS shares (
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
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner, created_at DESC);
"""


def init_db() -> None:
    """建分享表。幂等。"""
    with users._DB_LOCK:  # 复用同一把锁，避免两个 init 并发建表
        c = users.conn()
        try:
            c.executescript(SCHEMA)
            c.commit()
        finally:
            c.close()


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------
@dataclass
class Share:
    token: str
    owner: str
    mount: str
    path: str
    name: str
    is_dir: bool
    created_at: int
    expires_at: int
    max_visits: int
    visits: int
    note: str
    has_password: bool

    @property
    def expired(self) -> bool:
        return self.expires_at > 0 and self.expires_at < int(time.time())

    @property
    def exhausted(self) -> bool:
        return self.max_visits > 0 and self.visits >= self.max_visits

    @property
    def alive(self) -> bool:
        return not self.expired and not self.exhausted

    def as_dict(self, *, origin: str = "") -> dict[str, Any]:
        """对外表示。★ 绝不返回 password 字段 ★"""
        d = {
            "token": self.token,
            "owner": self.owner,
            "mount": self.mount,
            "path": self.path,
            "name": self.name,
            "isDir": self.is_dir,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
            "maxVisits": self.max_visits,
            "visits": self.visits,
            "note": self.note,
            "hasPassword": self.has_password,
            "expired": self.expired,
            "exhausted": self.exhausted,
            "alive": self.alive,
        }
        if origin:
            d["url"] = f"{origin}/s/{self.token}"
        return d


def _row_to_share(r: sqlite3.Row) -> Share:
    return Share(
        token=r["token"],
        owner=r["owner"],
        mount=r["mount"],
        path=r["path"],
        name=r["name"],
        is_dir=bool(r["is_dir"]),
        created_at=int(r["created_at"]),
        expires_at=int(r["expires_at"]),
        max_visits=int(r["max_visits"]),
        visits=int(r["visits"]),
        note=r["note"],
        has_password=bool(r["password"]),
    )


# ---------------------------------------------------------------------------
# 创建
# ---------------------------------------------------------------------------
def create(
    owner: str,
    mount: str,
    path: str,
    *,
    name: str = "",
    is_dir: bool = False,
    ttl: int = DEFAULT_TTL_SECONDS,
    max_visits: int = 0,
    password: str = "",
    note: str = "",
) -> Share:
    """新建分享。ttl<=0 表示永不过期。"""
    token = secrets.token_urlsafe(24)  # 32 字符，够短可贴、够长不可猜
    now = int(time.time())
    expires_at = 0 if ttl <= 0 else now + int(ttl)

    pw_hash = users.hash_password(password) if password else ""

    with users._DB_LOCK:
        c = users.conn()
        try:
            c.execute(
                "INSERT INTO shares (token, owner, mount, path, name, is_dir, password,"
                " created_at, expires_at, max_visits, visits, note)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,0,?)",
                (token, owner, mount, path, name, 1 if is_dir else 0, pw_hash,
                 now, expires_at, int(max_visits or 0), note),
            )
            c.commit()
        finally:
            c.close()

    return Share(
        token=token, owner=owner, mount=mount, path=path, name=name, is_dir=is_dir,
        created_at=now, expires_at=expires_at, max_visits=int(max_visits or 0),
        visits=0, note=note, has_password=bool(pw_hash),
    )


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------
def get(token: str) -> Share | None:
    if not token or len(token) > MAX_TOKEN_LEN:
        return None
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute("SELECT * FROM shares WHERE token = ?", (token,)).fetchone()
        finally:
            c.close()
    return _row_to_share(r) if r else None


def list_by_owner(owner: str) -> list[Share]:
    with users._DB_LOCK:
        c = users.conn()
        try:
            rows = c.execute(
                "SELECT * FROM shares WHERE owner = ? ORDER BY created_at DESC", (owner,)
            ).fetchall()
        finally:
            c.close()
    return [_row_to_share(r) for r in rows]


def list_all() -> list[Share]:
    """管理员视图：所有用户的分享。"""
    with users._DB_LOCK:
        c = users.conn()
        try:
            rows = c.execute("SELECT * FROM shares ORDER BY created_at DESC").fetchall()
        finally:
            c.close()
    return [_row_to_share(r) for r in rows]


def password_hash(token: str) -> str:
    """单独取密码哈希（不放进 Share 数据类，避免误序列化出去）。"""
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute("SELECT password FROM shares WHERE token = ?", (token,)).fetchone()
        finally:
            c.close()
    return str(r["password"]) if r else ""


def verify_password(token: str, plain: str) -> bool:
    h = password_hash(token)
    if not h:
        return True  # 无密码分享：恒通过
    try:
        return users.verify_password(plain, h)
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# 计数与撤销
# ---------------------------------------------------------------------------
def bump_visit(token: str) -> None:
    with users._DB_LOCK:
        c = users.conn()
        try:
            c.execute("UPDATE shares SET visits = visits + 1 WHERE token = ?", (token,))
            c.commit()
        finally:
            c.close()


def revoke(token: str, requester: str, is_admin: bool = False) -> bool:
    """撤销分享。只有 owner 或管理员可以。返回是否真的删掉了。"""
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute("SELECT owner FROM shares WHERE token = ?", (token,)).fetchone()
            if not r:
                return False
            if not is_admin and r["owner"] != requester:
                return False
            c.execute("DELETE FROM shares WHERE token = ?", (token,))
            c.commit()
            return True
        finally:
            c.close()


def revoke_by_path(owner: str, mount: str, path: str) -> int:
    """当文件/目录被删除或移动时，顺手清掉指向它的分享（否则会留下死链）。

    返回清掉的数量。★ 这是必需的：用户删了文件却还能通过旧链接下载，
    是明显的安全/体验问题。★
    """
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(
                "DELETE FROM shares WHERE owner = ? AND mount = ? AND path = ?",
                (owner, mount, path),
            )
            c.commit()
            return cur.rowcount or 0
        finally:
            c.close()


def revoke_under_path(owner: str, mount: str, path: str) -> int:
    """删除**目录**时，清掉它自己以及它之下所有路径的分享。

    为什么需要单独一个：revoke_by_path 只匹配精确相同的 path，
    而"分享过 目录/sub/file.txt"在删除 目录 时也必须一并失效。
    用 prefix + '/' 匹配（注意加 '/' 以免 `a/b` 命中 `a/bc`）。
    """
    pref = path.rstrip("/")
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(
                "DELETE FROM shares WHERE owner = ? AND mount = ?"
                " AND (path = ? OR path LIKE ?)",
                (owner, mount, pref, pref + "/%"),
            )
            c.commit()
            return cur.rowcount or 0
        finally:
            c.close()


def update(
    token: str,
    *,
    note: str | None = None,
    ttl_days: float | None = None,
    max_visits: int | None = None,
    password: str | None = None,
) -> bool:
    """局部更新。None = 不改。ttl_days<=0 → 永不过期。"""
    sets: list[str] = []
    args: list[Any] = []

    if note is not None:
        sets.append("note = ?"); args.append(note)
    if ttl_days is not None:
        if ttl_days <= 0:
            sets.append("expires_at = 0")
        else:
            sets.append("expires_at = ?")
            args.append(int(time.time()) + int(ttl_days * 86400))
    if max_visits is not None:
        sets.append("max_visits = ?"); args.append(int(max_visits))
    if password is not None:
        # 空字符串 = 取消密码
        sets.append("password = ?")
        args.append(users.hash_password(password) if password else "")

    if not sets:
        return False

    args.append(token)
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(f"UPDATE shares SET {', '.join(sets)} WHERE token = ?", args)
            c.commit()
            return (cur.rowcount or 0) > 0
        finally:
            c.close()
