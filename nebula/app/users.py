# -*- coding: utf-8 -*-
"""
NebulaDisk —— 用户存储（SQLite）

设计取舍：
  - 用 SQLite 而不是 JSON 文件：并发写更安全，NAS 上单文件也好备份。
  - bcrypt 用 passlib 或原生 bcrypt 包；这里直接用 bcrypt 包，少一层封装。
  - 密码哈希失败/空密码的处理要明确：空密码用户禁止登录，而不是放行。

首次启动时按 NEBULA_ADMIN_USER / NEBULA_ADMIN_PASSWORD 建管理员。
如果没配 NEBULA_ADMIN_PASSWORD，会随机生成一个强密码并打到日志里
—— 比给个默认弱口令强得多，NAS 上暴露到公网时尤其重要。
"""

from __future__ import annotations

import secrets
import sqlite3
import sys
import time
from pathlib import Path
from threading import Lock

import bcrypt

from .config import settings

_DB_LOCK = Lock()
_DB_PATH: Path | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username     TEXT PRIMARY KEY,
    password     TEXT NOT NULL,
    display      TEXT NOT NULL DEFAULT '',
    is_admin     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    last_login   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    username     TEXT NOT NULL,
    action       TEXT NOT NULL,
    target       TEXT NOT NULL DEFAULT '',
    detail       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
"""


def db_path() -> Path:
    global _DB_PATH
    if _DB_PATH is None:
        d = Path(settings.data_dir)
        d.mkdir(parents=True, exist_ok=True)
        _DB_PATH = d / "nebula.db"
    return _DB_PATH


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(db_path()), timeout=15)
    c.row_factory = sqlite3.Row
    # WAL 模式：读写并发友好，NAS 上突然断电也更不容易损坏
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    return c


def init_db() -> None:
    """建表 + 按需创建管理员。幂等，可反复调用。"""
    with _DB_LOCK:
        c = conn()
        try:
            c.executescript(SCHEMA)
            c.commit()
            row = c.execute("SELECT COUNT(*) AS n FROM users").fetchone()
            if row["n"] == 0:
                _seed_admin(c)
        finally:
            c.close()


def _seed_admin(c: sqlite3.Connection) -> None:
    username = settings.admin_user or "admin"
    password = settings.admin_password

    generated = False
    if not password:
        password = secrets.token_urlsafe(12)
        generated = True

    c.execute(
        "INSERT INTO users (username, password, display, is_admin, created_at) "
        "VALUES (?,?,?,1,?)",
        (username, hash_password(password), "管理员", int(time.time())),
    )
    c.commit()

    print("=" * 64, file=sys.stderr)
    print(f"[init] 已创建管理员账号: {username}", file=sys.stderr)
    if generated:
        print(f"[init] 随机初始密码: {password}", file=sys.stderr)
        print("[init] 请立即登录后修改；设置 NEBULA_ADMIN_PASSWORD 可指定固定密码。",
              file=sys.stderr)
    print("=" * 64, file=sys.stderr)


# ---------------------------------------------------------------------------
# 密码
# ---------------------------------------------------------------------------
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))
    except (ValueError, TypeError):
        # 哈希串损坏时视为验证失败，不要让异常冒到上层
        return False


# ---------------------------------------------------------------------------
# 用户 CRUD
# ---------------------------------------------------------------------------
def get(username: str) -> dict | None:
    c = conn()
    try:
        row = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return dict(row) if row else None
    finally:
        c.close()


def list_all() -> list[dict]:
    c = conn()
    try:
        rows = c.execute(
            "SELECT username, display, is_admin, created_at, last_login "
            "FROM users ORDER BY is_admin DESC, username"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        c.close()


def create(username: str, password: str, display: str = "", is_admin: bool = False) -> tuple[bool, str]:
    username = (username or "").strip()
    if not username:
        return False, "用户名不能为空"
    if len(username) > 32:
        return False, "用户名过长（最多 32 字符）"
    if not password or len(password) < 6:
        return False, "密码至少 6 位"

    with _DB_LOCK:
        c = conn()
        try:
            exists = c.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone()
            if exists:
                return False, "用户已存在"
            c.execute(
                "INSERT INTO users (username, password, display, is_admin, created_at) "
                "VALUES (?,?,?,?,?)",
                (username, hash_password(password), display or username,
                 1 if is_admin else 0, int(time.time())),
            )
            c.commit()
            return True, "创建成功"
        finally:
            c.close()


def delete(username: str) -> tuple[bool, str]:
    if username == settings.admin_user:
        return False, "不能删除内置管理员"
    # 不能把最后一个管理员删掉 —— 否则没人能再进用户管理
    row = get(username)
    if row and row.get("is_admin") and count_admins() <= 1:
        return False, "这是最后一个管理员，不能删除"
    with _DB_LOCK:
        c = conn()
        try:
            cur = c.execute("DELETE FROM users WHERE username=?", (username,))
            c.commit()
            if cur.rowcount == 0:
                return False, "用户不存在"
            return True, "已删除"
        finally:
            c.close()


def set_password(username: str, new_password: str) -> tuple[bool, str]:
    if not new_password or len(new_password) < 6:
        return False, "密码至少 6 位"
    with _DB_LOCK:
        c = conn()
        try:
            cur = c.execute(
                "UPDATE users SET password=? WHERE username=?",
                (hash_password(new_password), username),
            )
            c.commit()
            if cur.rowcount == 0:
                return False, "用户不存在"
            return True, "密码已更新"
        finally:
            c.close()


def update(username: str, display: str | None = None,
           is_admin: bool | None = None) -> tuple[bool, str]:
    """改显示名 / 管理员标志。

    ★ 内置管理员不允许被降级 ★
      否则一次误点就能把唯一的管理员变成普通用户，而系统里再没有别的
      管理员能把他改回来 —— 只能进容器改 SQLite，等于把自己锁在门外。
      改名（display）不涉及权限，允许。
    """
    if username == settings.admin_user and is_admin is False:
        return False, "不能降级内置管理员"

    sets, args = [], []
    if display is not None:
        d = display.strip()
        if not d:
            return False, "显示名不能为空"
        if len(d) > 64:
            return False, "显示名过长（最多 64 字符）"
        sets.append("display=?")
        args.append(d)
    if is_admin is not None:
        sets.append("is_admin=?")
        args.append(1 if is_admin else 0)

    if not sets:
        return False, "没有需要修改的字段"

    args.append(username)
    with _DB_LOCK:
        c = conn()
        try:
            cur = c.execute(f"UPDATE users SET {', '.join(sets)} WHERE username=?", args)
            c.commit()
            if cur.rowcount == 0:
                return False, "用户不存在"
            return True, "已更新"
        finally:
            c.close()


def rename(old_username: str, new_username: str) -> tuple[bool, str]:
    """修改用户名（登录名）。

    用户需求（原文）：「用户编辑可以编辑用户的用户名（登录名）」

    ★ 为什么要单独一个函数，而不塞进 update() ★
      update() 用 `WHERE username=?` 定位行，改的永远是其它列；
      改**主键本身**需要「先校验新名可用，再 UPDATE username」，
      而且失败时绝不能留下半改状态。单独成函数边界最清晰。

    ★ 内置管理员不允许改名 ★
      与「不能降级内置管理员」同一个理由：settings.admin_user 是配置项，
      登录时按它比对；一旦把库里那行改名，配置与数据就对不上了，
      下次重启会因找不到该账户而重建或直接登录失败 —— 把自己锁在门外。
    """
    new_username = (new_username or "").strip()
    if not new_username:
        return False, "用户名不能为空"
    if len(new_username) > 32:
        return False, "用户名过长（最多 32 字符）"
    # 用户名会进 URL / SQL / 审计日志，限制成保守字符集最省心
    if not all(ch.isalnum() or ch in "._-@" for ch in new_username):
        return False, "用户名只能包含字母、数字与 . _ - @"
    if old_username == settings.admin_user:
        return False, "内置管理员不能改名"
    if new_username == old_username:
        return True, "未变更"

    with _DB_LOCK:
        c = conn()
        try:
            if not c.execute("SELECT 1 FROM users WHERE username=?", (old_username,)).fetchone():
                return False, "用户不存在"
            if c.execute("SELECT 1 FROM users WHERE username=?", (new_username,)).fetchone():
                return False, "该用户名已被占用"
            # display 若原本与旧名相同（创建时的默认值），跟着一起改，
            # 否则界面上会留一个显示不出来的旧名字。
            row = c.execute("SELECT display FROM users WHERE username=?",
                            (old_username,)).fetchone()
            sets = ["username=?"]
            args: list = [new_username]
            if row and (row["display"] or "") == old_username:
                sets.append("display=?")
                args.append(new_username)
            args.append(old_username)
            cur = c.execute(f"UPDATE users SET {', '.join(sets)} WHERE username=?", args)
            c.commit()
            if cur.rowcount == 0:
                return False, "用户不存在"
            return True, "用户名已更新"
        finally:
            c.close()


def count_admins() -> int:
    """当前管理员数量 —— 删号/降级前用来判断「这是不是最后一个管理员」。"""
    c = conn()
    try:
        row = c.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin=1").fetchone()
        return int(row["n"]) if row else 0
    finally:
        c.close()
def touch_login(username: str) -> None:
    with _DB_LOCK:
        c = conn()
        try:
            c.execute("UPDATE users SET last_login=? WHERE username=?",
                      (int(time.time()), username))
            c.commit()
        finally:
            c.close()


# ---------------------------------------------------------------------------
# 审计日志
# ---------------------------------------------------------------------------
def audit(username: str, action: str, target: str = "", detail: str = "") -> None:
    """记录关键操作。写日志失败不应影响主流程。"""
    try:
        with _DB_LOCK:
            c = conn()
            try:
                c.execute(
                    "INSERT INTO audit (ts, username, action, target, detail) VALUES (?,?,?,?,?)",
                    (int(time.time()), username, action, target, detail[:500]),
                )
                # 只保留最近 5000 条，防止 NAS 上长期运行把磁盘写满
                c.execute(
                    "DELETE FROM audit WHERE id NOT IN "
                    "(SELECT id FROM audit ORDER BY id DESC LIMIT 5000)"
                )
                c.commit()
            finally:
                c.close()
    except Exception as e:  # noqa: BLE001
        print(f"[audit] 写入失败（已忽略）: {e}", file=sys.stderr)


def recent_audit(limit: int = 200) -> list[dict]:
    c = conn()
    try:
        rows = c.execute(
            "SELECT ts, username, action, target, detail FROM audit ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        c.close()
