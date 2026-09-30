# -*- coding: utf-8 -*-
"""NebulaDisk —— **统一的「链接」存储**：短链 `/f/<token>` 与分享 `/s/<token>` 同表。

## 为什么把两者合并（2026-09-30）

原先它们各有一套：

  · `shortlink.py` —— `/f/<token>`，给「在浏览器中打开」/「复制直链」用。
    token 12 字符、免登录、永久有效、只能取字节。
  · `shares.py`    —— `/s/<token>`，给「分享」用。token 32 字符、
    有落地页、可设有效期 / 提取码 / 访问次数。

两者的**语义差异是真的**（一个直达字节、一个要落地页），但**存储与生命周期
完全同构**：都是「一个随机 token → 一条 (owner, mount, path) 映射」，
都有撤销、计数、都必须在文件被删/改名/移动时一起失效。

各写一套的直接代价（用户报障原话：「网盘里面自带的分享也纳入一起，
采用短链的方式分享。管理纳入一起。」）：

  1. **`/s/` 的地址太长**（32 字符 token ⇒ 整条 60+ 字符），
     而 `/f/` 只有 41 字符 —— 同一个产品里两种地址长度，用户会问「为什么不一样」；
  2. **删除文件时只清了分享、没清短链**（`fileops.py` 只调了
     `shares.revoke_under_path()`）⇒ 留下死链；
  3. **管理要开两个地方**才看得全；撤销也要调两套接口。

⇒ 本轮合并成**一张 `links` 表**，`kind` 区分两种语义：

| | `kind='file'` | `kind='share'` |
|---|---|---|
| 落地端 | `GET /f/<token>` 直取字节 | `GET /s/<token>` 落地页 |
| token | 12 字符 | **12 字符（本轮从 32 缩到 12）** |
| 幂等 | **有**（同 (owner,mount,path) 恒同一条） | 无（同一文件可多条，各自带参数） |
| 有效期 | 无（长期有效） | `expires_at`（0=永久） |
| 提取码 | 无 | `password`（bcrypt） |
| 次数上限 | 无 | `max_visits`（0=不限） |
| 危险扩展名 | **强制 attachment** | 落地页本身不吐字节 |

## ★ 对外 API 一个都没改 ★

`app/shares.py` 变成**这层之上的兼容壳**（`Share` 数据类、`create/get/list_*/
revoke*/update/password_hash/verify_password/bump_visit` 全部保留原签名与语义）。
于是 `share_guest.py` / `share_web.py` / `shares_admin.py` / `fileops.py`
**一行都不用动**，而 `fileops.py` 原有的 `shares.revoke_under_path()` 现在
**顺手把 file 短链也清了** —— 上面第 2 条毛病自动消失。

## ★ 安全模型（能力型 URL，刻意免登录）★

  · token = `secrets.token_urlsafe(9)` = **12 字符 / 72 bit** ⇒ 不可枚举、不可猜
  · `/f/<token>` **不要求登录** —— 谁拿到链接谁能看（用户明确要的语义：
    「免登录，链接即凭证 …… 可直接发同事」）
  · **危险扩展名**（exe/bat/js/ps1… 见 `config.DANGEROUS_EXT`）在 `/f` 里
    一律强制 `attachment`，绝不 inline
  · 映射可见性仍按链接的 `owner` 复核 ⇒ owner 已看不到该映射时，链接同步失效
  · 收回手段：① 删/改名/移动文件时由 `revoke_by_path` / `revoke_under_path`
    一并清掉 ② 显式撤销（`POST /api/links/revoke`）
  · ⚠️ 别把短链贴到不受控的地方：它免登录、且（file 类）永久有效

## 建表为什么是惰性 + 幂等

`main.py` 的 startup 只调了 `users.init_db()` 与 `shares.init_db()`。
本模块**不新增启动钩子**（少一处漂移），改成第一次真正用到时才
`_ensure()`：建表 + 补列 + 迁移旧 `shares` 表，全部幂等。
`shares.init_db()`（兼容壳）也会调它，所以启动时其实已经跑过一遍。
"""

from __future__ import annotations

import secrets
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from . import users

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
KIND_FILE = "file"
KIND_SHARE = "share"

# 9 字节 → token_urlsafe 出 12 个字符。够短（整条 URL 才几十字符），
# 也够长（2^72 ≈ 4.7e21，暴力枚举不现实）。
TOKEN_BYTES = 9

# 查询侧的长度闸门：超长 token 直接当不存在，免得拿畸形输入去查库。
# ★ 取 64 而不是 12：迁移进来的历史 token 是 32 字符，必须继续认。
MAX_TOKEN_LEN = 64

# 分享默认有效期：7 天。0 = 永不
DEFAULT_TTL_SECONDS = 7 * 24 * 3600

# 建表（新库直接是这个形状；老库由 _ensure 补列）
SCHEMA = """
CREATE TABLE IF NOT EXISTS links (
    token          TEXT PRIMARY KEY,
    owner          TEXT NOT NULL,
    mount          TEXT NOT NULL,
    path           TEXT NOT NULL,
    name           TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    hits           INTEGER NOT NULL DEFAULT 0,
    kind           TEXT NOT NULL DEFAULT 'file',
    is_dir         INTEGER NOT NULL DEFAULT 0,
    password       TEXT NOT NULL DEFAULT '',
    expires_at     INTEGER NOT NULL DEFAULT 0,
    max_visits     INTEGER NOT NULL DEFAULT 0,
    visits         INTEGER NOT NULL DEFAULT 0,
    note           TEXT NOT NULL DEFAULT '',
    last_access_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_links_owner ON links(owner, created_at DESC);
"""

# v1（只有 file 短链）→ v2 需要补的列
_V2_COLUMNS = (
    ("kind", "TEXT NOT NULL DEFAULT 'file'"),
    ("is_dir", "INTEGER NOT NULL DEFAULT 0"),
    ("password", "TEXT NOT NULL DEFAULT ''"),
    ("expires_at", "INTEGER NOT NULL DEFAULT 0"),
    ("max_visits", "INTEGER NOT NULL DEFAULT 0"),
    ("visits", "INTEGER NOT NULL DEFAULT 0"),
    ("note", "TEXT NOT NULL DEFAULT ''"),
    ("last_access_at", "INTEGER NOT NULL DEFAULT 0"),
)

# 惰性迁移只做一次（进程级）
_ready = False


def _ensure() -> None:
    """惰性 + 幂等：建表 / 补列 / 重建索引 / 迁移旧 shares 表。"""
    global _ready
    if _ready:
        return
    with users._DB_LOCK:  # 复用同一把锁，避免与 users/shares 的 init 并发
        c = users.conn()
        try:
            _migrate(c)
            c.commit()
        finally:
            c.close()
    _ready = True


# 公开别名（shares.init_db 用）
ensure = _ensure


def _migrate(c: sqlite3.Connection) -> None:
    c.executescript(SCHEMA)

    # ① 老库补列
    cols = {str(r[1]) for r in c.execute("PRAGMA table_info(links)")}
    for name, ddl in _V2_COLUMNS:
        if name not in cols:
            c.execute(f"ALTER TABLE links ADD COLUMN {name} {ddl}")

    # ② ★ 索引必须换成「只约束 file 类」的部分索引 ★
    #    v1 的 idx_links_target 是 (owner,mount,path) **全表唯一** ——
    #    合并后它会挡住「同一个文件的分享」（同一 (owner,mount,path) 再来一条
    #    kind='share'）⇒ 用户点「分享」直接 IntegrityError。
    c.execute("DROP INDEX IF EXISTS idx_links_target")
    c.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_links_target_file"
        " ON links(owner, mount, path) WHERE kind = 'file'"
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_links_owner ON links(owner, created_at DESC)"
    )

    # ③ 旧 shares 表并入（只在它还叫 shares 时跑一次）
    _migrate_legacy_shares(c)


def _migrate_legacy_shares(c: sqlite3.Connection) -> None:
    row = c.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='shares'"
    ).fetchone()
    if not row:
        return

    moved = 0
    try:
        cur = c.execute(
            "INSERT OR IGNORE INTO links"
            " (token, owner, mount, path, name, created_at, hits, kind, is_dir,"
            "  password, expires_at, max_visits, visits, note, last_access_at)"
            " SELECT token, owner, mount, path, name, created_at, visits, 'share', is_dir,"
            "        password, expires_at, max_visits, visits, note, 0"
            " FROM shares"
        )
        moved = cur.rowcount or 0
    except sqlite3.OperationalError as e:  # 老表结构意外 → 不阻断启动
        print(f"[shortlink] ⚠️ 迁移 shares 表失败（跳过）：{e}")

    # ★ 改名留档而不是 DROP ★
    #   万一迁错还能捞回来；且改名后本函数不会再跑（表名不再叫 shares）。
    target = "shares_migrated_v2"
    try:
        if c.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (target,),
        ).fetchone():
            target = f"shares_migrated_v2_{int(time.time())}"
        c.execute(f"ALTER TABLE shares RENAME TO {target}")
    except sqlite3.OperationalError as e:  # noqa: BLE001
        print(f"[shortlink] ⚠️ 旧 shares 表改名失败（保留原名）：{e}")
        return
    print(f"[shortlink] 旧 shares 表已并入 links（{moved} 条），原表留档为 {target}")


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------
@dataclass
class Link:
    token: str
    owner: str
    mount: str
    path: str
    name: str
    created_at: int
    hits: int
    kind: str
    is_dir: bool
    expires_at: int
    max_visits: int
    visits: int
    note: str
    last_access_at: int
    has_password: bool

    # ---- 状态 ----
    # ★ 有效期对**两类都适用**（2026-09-30 起直链默认也是 7 天）★
    #   早先这里写成 `self.kind == KIND_SHARE and ...` —— 直链当年是永久的，
    #   现在那么写会让过期的直链被误判成"有效"（/f 照发字节）。
    @property
    def expired(self) -> bool:
        return self.expires_at > 0 and self.expires_at < int(time.time())

    @property
    def exhausted(self) -> bool:
        # 直链的 max_visits 恒为 0 ⇒ 天然不成立，不必再按 kind 判
        return self.max_visits > 0 and self.visits >= self.max_visits

    @property
    def alive(self) -> bool:
        return not self.expired and not self.exhausted

    def as_dict(self, *, origin: str = "") -> dict[str, Any]:
        """对外表示。★ 绝不返回 password 字段 ★

        字段是**两种历史形状的并集**（`hits` 来自短链、`visits/expiresAt/...`
        来自分享），这样新旧前端都不需要改取值方式。
        """
        d: dict[str, Any] = {
            "token": self.token,
            "kind": self.kind,
            "owner": self.owner,
            "mount": self.mount,
            "path": self.path,
            "name": self.name,
            "createdAt": self.created_at,
            "hits": self.hits,
            "isDir": self.is_dir,
            "expiresAt": self.expires_at,
            "maxVisits": self.max_visits,
            "visits": self.visits,
            "note": self.note,
            "hasPassword": self.has_password,
            "lastAccessAt": self.last_access_at,
            "expired": self.expired,
            "exhausted": self.exhausted,
            "alive": self.alive,
        }
        if origin:
            d["url"] = url_for(self.token, origin, self.kind)
        return d


def _row(r: sqlite3.Row) -> Link:
    keys = set(r.keys())
    return Link(
        token=str(r["token"]),
        owner=str(r["owner"]),
        mount=str(r["mount"]),
        path=str(r["path"]),
        name=str(r["name"] or ""),
        created_at=int(r["created_at"]),
        hits=int(r["hits"] or 0),
        kind=str(r["kind"] or KIND_FILE) if "kind" in keys else KIND_FILE,
        is_dir=bool(r["is_dir"]) if "is_dir" in keys else False,
        expires_at=int(r["expires_at"] or 0) if "expires_at" in keys else 0,
        max_visits=int(r["max_visits"] or 0) if "max_visits" in keys else 0,
        visits=int(r["visits"] or 0) if "visits" in keys else 0,
        note=str(r["note"] or "") if "note" in keys else "",
        last_access_at=int(r["last_access_at"] or 0) if "last_access_at" in keys else 0,
        has_password=bool(r["password"]) if "password" in keys else False,
    )


def url_for(token: str, origin: str = "", kind: str = KIND_FILE) -> str:
    """链接的对外形态。origin 传空则返回站内相对路径。"""
    tail = f"/s/{token}" if kind == KIND_SHARE else f"/f/{token}"
    return f"{origin.rstrip('/')}{tail}" if origin else tail


# ---------------------------------------------------------------------------
# 签发
# ---------------------------------------------------------------------------
def _new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def get_or_create(owner: str, mount: str, path: str, name: str = "",
                  ttl: int | None = None) -> Link:
    """取该 (owner, mount, path) 已有的 **file 直链**；没有就签一条。

    ★ 为什么幂等 ★
      用户在浏览器里连点几次「在浏览器里打开」/「复制直链」，若每次都新签一条，
      库里会堆出一串等价 token，撤销时也搞不清该撤哪条。
      部分唯一索引 `idx_links_target_file` 从数据层保证「一个文件一条直链」。
      ⚠️ 分享（kind='share'）**不在此列**：同一文件可以有多条不同参数的分享。

    ★★ 有效期：直链**不再永久**（2026-09-30 起）★★
      用户要求（原话）：「直链 默认 也按7天来。」
      ⇒ 与分享同一个默认值 `DEFAULT_TTL_SECONDS`（7 天）。要永久就显式传 `ttl=0`。
      ⚠️ 库里**历史遗留**的直链 `expires_at` 仍是 0（永久）—— 它们不动：
        这条规则只约束**新签发的**直链，把已发出的链接有效期改小本身就不该做。

    ★ `ttl` 的三态（别简化成一个默认值）★
      · `ttl is None`（**不传**）：新签 → 用默认 7 天；
        已存在且没过期 → **原样返回，不动它的有效期**。
        为什么不动：前端「复制直链」每点一次都会走这里，
        如果每次都把到期时间往后推，那"7 天有效"就永远到不了期 —— 等于没有期限。
      · `ttl` 是整数（**显式传**，含 0）：调用方明确要了这个期限 ⇒ 就按它设置。
        含"已存在"的情况（比如界面里选「改为永久有效」）。
      · `ttl <= 0`：永久。

    ★ 命中「已过期」的行时**自动续期**，而不是返回一条死链 ★
      本函数是幂等的（同一路径恒同一条），但"同一条"如果已经过期，
      用户点「复制直链」拿到就是个打不开的地址，而且**界面上什么都看不出来**。
      ⇒ 这时把到期时间往后推一个 ttl（token 不变，地址也就不变）。

    ★★ 锁：**绝不能**在持 `users._DB_LOCK` 时调 `_refresh_expiry` ★★
      它是普通 `threading.Lock`（不可重入）⇒ 会**当场死锁**，而且是静默的
      （进程卡住、无异常、无日志）。第一版就是这么写的，被集成测试卡死抓出来。
      ⇒ 结构固定为「加锁只做一件事」：
          ① 加锁读一行 → 放锁
          ② 需要续期 → 在锁外调（它自己会加锁）
          ③ 需要插入 → 重新加锁，并在锁内重查一次（防并发重复插入）
    """
    _ensure()

    # ---- ① 先查（只在锁内做读）----
    found = None
    with users._DB_LOCK:
        c = users.conn()
        try:
            found = c.execute(
                "SELECT * FROM links WHERE owner = ? AND mount = ? AND path = ?"
                " AND kind = ?",
                (owner, mount, path, KIND_FILE),
            ).fetchone()
        finally:
            c.close()

    # ---- ② 命中：已过期就续期；显式给了 ttl 也照设（★ 在锁外调用 ★）----
    if found is not None:
        lk = _row(found)
        if lk.expired:
            return _refresh_expiry(lk.token, ttl if ttl is not None
                                   else DEFAULT_TTL_SECONDS) or lk
        if ttl is not None:
            return _refresh_expiry(lk.token, ttl) or lk
        return lk

    # ---- ③ 没有：插入（锁内再查一次，处理并发）----
    now = int(time.time())
    eff = DEFAULT_TTL_SECONDS if ttl is None else ttl
    expires_at = 0 if eff <= 0 else now + int(eff)
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute(
                "SELECT * FROM links WHERE owner = ? AND mount = ? AND path = ?"
                " AND kind = ?",
                (owner, mount, path, KIND_FILE),
            ).fetchone()
            if r:
                lk = _row(r)
                if not lk.expired and ttl is None:
                    return lk
                # 过期了、或调用方显式给了 ttl ⇒ 需要改有效期。
                # ⚠️ 锁内不能调 _refresh_expiry（它会再取同一把锁 ⇒ 死锁）⇒
                #    只能在锁外处理：这里先把 token 记下，出锁后再续期。
                pending = (lk.token, ttl if ttl is not None else DEFAULT_TTL_SECONDS)
                c.close()
                return _refresh_expiry(pending[0], pending[1]) or lk

            for _ in range(5):
                tok = _new_token()
                try:
                    c.execute(
                        "INSERT INTO links"
                        " (token, owner, mount, path, name, created_at, hits, kind,"
                        "  expires_at)"
                        " VALUES (?,?,?,?,?,?,0,?,?)",
                        (tok, owner, mount, path, name, now, KIND_FILE, expires_at),
                    )
                    c.commit()
                    return Link(
                        token=tok, owner=owner, mount=mount, path=path, name=name,
                        created_at=now, hits=0, kind=KIND_FILE, is_dir=False,
                        expires_at=expires_at, max_visits=0, visits=0, note="",
                        last_access_at=0, has_password=False,
                    )
                except sqlite3.IntegrityError:
                    # ① token 撞车（概率极低）② 并发下同路径刚被别人插进去
                    c.rollback()
                    r = c.execute(
                        "SELECT * FROM links WHERE owner = ? AND mount = ? AND path = ?"
                        " AND kind = ?",
                        (owner, mount, path, KIND_FILE),
                    ).fetchone()
                    if r:
                        return _row(r)
            raise RuntimeError("短链 token 连续 5 次冲突，放弃")
        finally:
            c.close()


def _refresh_expiry(token: str, ttl: int) -> Link | None:
    """把一条链接的到期时间改成 now+ttl（ttl<=0 → 永久）。返回更新后的 Link。

    ⚠️ **绝对不能**在持有 `users._DB_LOCK` 时调用本函数
      —— 它自己会取锁，而那是不可重入的 `threading.Lock`，
      结果是**静默死锁**（进程卡住、无异常、无日志）。
    """
    exp = 0 if ttl <= 0 else int(time.time()) + int(ttl)
    with users._DB_LOCK:
        c = users.conn()
        try:
            c.execute("UPDATE links SET expires_at = ? WHERE token = ?", (exp, token))
            c.commit()
        finally:
            c.close()
    return get(token)


def _inherit_ttl(lk: "Link") -> int:
    """rotate 用：算新链接该给多长有效期。

      · 老的是永久的（expires_at=0） → 新的也永久（别把一个永久链接降级成 7 天）
      · 老的是限时且**未过期**      → 沿用**剩余**时间（不凭空延长）
      · 老的是限时且**已过期**      → 给默认 7 天
        （否则"换地址"出来的新品当场又是死的，等于没换成）
    """
    if lk.expires_at <= 0:
        return 0
    remain = int(lk.expires_at) - int(time.time())
    return remain if remain > 0 else DEFAULT_TTL_SECONDS


def create_share(
    owner: str,
    mount: str,
    path: str,
    *,
    name: str = "",
    is_dir: bool = False,
    ttl: int = DEFAULT_TTL_SECONDS,
    max_visits: int = 0,
    password_hash: str = "",
    note: str = "",
) -> Link:
    """新建一条**分享**链接（`kind='share'`）。

    ttl<=0 表示永不过期。★ token 与短链同规格 = 12 字符 ★
    """
    _ensure()
    now = int(time.time())
    expires_at = 0 if ttl <= 0 else now + int(ttl)

    with users._DB_LOCK:
        c = users.conn()
        try:
            for _ in range(5):
                tok = _new_token()
                try:
                    c.execute(
                        "INSERT INTO links"
                        " (token, owner, mount, path, name, created_at, hits, kind,"
                        "  is_dir, password, expires_at, max_visits, visits, note,"
                        "  last_access_at)"
                        " VALUES (?,?,?,?,?,?,0,?,?,?,?,?,0,?,0)",
                        (tok, owner, mount, path, name, now, KIND_SHARE,
                         1 if is_dir else 0, password_hash, expires_at,
                         int(max_visits or 0), note),
                    )
                    c.commit()
                    return Link(
                        token=tok, owner=owner, mount=mount, path=path, name=name,
                        created_at=now, hits=0, kind=KIND_SHARE, is_dir=is_dir,
                        expires_at=expires_at, max_visits=int(max_visits or 0),
                        visits=0, note=note, last_access_at=0,
                        has_password=bool(password_hash),
                    )
                except sqlite3.IntegrityError:
                    c.rollback()  # 只可能是 token 撞车 → 换一个再来
            raise RuntimeError("分享 token 连续 5 次冲突，放弃")
        finally:
            c.close()


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------
def get(token: str) -> Link | None:
    if not token or len(token) > MAX_TOKEN_LEN:
        return None
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute("SELECT * FROM links WHERE token = ?", (token,)).fetchone()
        finally:
            c.close()
    return _row(r) if r else None


def get_kind(token: str, kind: str) -> Link | None:
    lk = get(token)
    return lk if (lk and lk.kind == kind) else None


def list_by_owner(owner: str, kind: str | None = None) -> list[Link]:
    _ensure()
    sql = "SELECT * FROM links WHERE owner = ?"
    args: list[Any] = [owner]
    if kind:
        sql += " AND kind = ?"
        args.append(kind)
    sql += " ORDER BY created_at DESC"
    with users._DB_LOCK:
        c = users.conn()
        try:
            rows = c.execute(sql, args).fetchall()
        finally:
            c.close()
    return [_row(r) for r in rows]


def list_all(kind: str | None = None) -> list[Link]:
    """管理员视图：所有用户的链接。"""
    _ensure()
    sql = "SELECT * FROM links"
    args: list[Any] = []
    if kind:
        sql += " WHERE kind = ?"
        args.append(kind)
    sql += " ORDER BY created_at DESC"
    with users._DB_LOCK:
        c = users.conn()
        try:
            rows = c.execute(sql, args).fetchall()
        finally:
            c.close()
    return [_row(r) for r in rows]


def password_hash(token: str) -> str:
    """单独取提取码哈希（不放进 Link，避免误序列化出去）。"""
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute(
                "SELECT password FROM links WHERE token = ?", (token,)
            ).fetchone()
        finally:
            c.close()
    return str(r["password"]) if r else ""


# ---------------------------------------------------------------------------
# 计数
# ---------------------------------------------------------------------------
def touch(token: str, *, visit: bool = False) -> None:
    """记一次访问。纯统计用途，失败不影响取流，所以吞掉异常。

    visit=True 表示「一次真实访问」（分享的清单/取流），会同时 +visits；
    visit=False 表示「打开了一次链接」（file 短链），只 +hits。
    两者都更新 last_access_at ⇒ 用户才看得出「哪条最近被人看过」。
    """
    try:
        with users._DB_LOCK:
            c = users.conn()
            try:
                now = int(time.time())
                if visit:
                    c.execute(
                        "UPDATE links SET hits = hits + 1, visits = visits + 1,"
                        " last_access_at = ? WHERE token = ?",
                        (now, token),
                    )
                else:
                    c.execute(
                        "UPDATE links SET hits = hits + 1, last_access_at = ?"
                        " WHERE token = ?",
                        (now, token),
                    )
                c.commit()
            finally:
                c.close()
    except Exception:  # noqa: BLE001
        pass


# 旧名（短链侧一直在用）
bump = touch


# ---------------------------------------------------------------------------
# 修改 / 撤销
# ---------------------------------------------------------------------------
def update(
    token: str,
    *,
    note: str | None = None,
    ttl_days: float | None = None,
    max_visits: int | None = None,
    password_hash: str | None = None,
) -> bool:
    """局部更新。None = 不改。ttl_days<=0 → 永不过期。

    ★ 只对分享类有意义 ★（file 短链没有有效期/提取码这些维度）
    """
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
    if password_hash is not None:
        # 空字符串 = 取消提取码
        sets.append("password = ?"); args.append(password_hash)

    if not sets:
        return False

    args.append(token)
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(
                f"UPDATE links SET {', '.join(sets)} WHERE token = ?", args
            )
            c.commit()
            return (cur.rowcount or 0) > 0
        finally:
            c.close()


def revoke(token: str, requester: str, is_admin: bool = False,
           kind: str | None = None) -> bool:
    """撤销一条链接（不分类型）。只有 owner 或管理员可以。"""
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute(
                "SELECT owner, kind FROM links WHERE token = ?", (token,)
            ).fetchone()
            if not r:
                return False
            if kind and str(r["kind"]) != kind:
                return False
            if not is_admin and str(r["owner"]) != requester:
                return False
            c.execute("DELETE FROM links WHERE token = ?", (token,))
            c.commit()
            return True
        finally:
            c.close()


def revoke_by_path(owner: str, mount: str, path: str) -> int:
    """文件被删除/改名/移动时，清掉指向它的链接（否则留下死链）。

    ★ 两种类型一起清 ★ —— 这正是合并成一张表后自动得到的好处。
    """
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(
                "DELETE FROM links WHERE owner = ? AND mount = ? AND path = ?",
                (owner, mount, path),
            )
            c.commit()
            return cur.rowcount or 0
        finally:
            c.close()


def revoke_under_path(owner: str, mount: str, path: str) -> int:
    """删除**目录**时，连同其下所有路径的链接一起清掉。

    用 prefix + '/' 匹配（加 '/' 是为了让 `a/b` 不会命中 `a/bc`）。
    """
    _ensure()
    pref = path.rstrip("/")
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(
                "DELETE FROM links WHERE owner = ? AND mount = ?"
                " AND (path = ? OR path LIKE ?)",
                (owner, mount, pref, pref + "/%"),
            )
            c.commit()
            return cur.rowcount or 0
        finally:
            c.close()


def revoke_dead(owner: str) -> int:
    """一键清理「已经失效」的链接：**过期**（两类都可能）或**次数用尽**（只有分享）。

    ★ 还剩下什么不清 ★
      直链指向的文件被删除时它只是"打不开"，记录仍会在（还没到过期时间）。
      那种情况由 `/f/<token>` 命中「文件真的不存在」时**惰性自清**
      （见 `pages.py` 的 short_open）—— 不在批量清理里做，
      因为判断"文件真没了"要真去解析路径，映射抖动时会误删好链接。
    """
    _ensure()
    now = int(time.time())
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(
                "DELETE FROM links WHERE owner = ?"
                " AND ((expires_at > 0 AND expires_at < ?)"
                "      OR (max_visits > 0 AND visits >= max_visits))",
                (owner, now),
            )
            c.commit()
            return cur.rowcount or 0
        finally:
            c.close()


def rotate(token: str, requester: str, is_admin: bool = False) -> Link | None:
    """**换一条地址**：撤销旧链接，并立刻按同样的目标与参数签一条新的。

    ★ 为什么需要它 ★
      短链是「链接即凭证」——发出去就收不回。真出了泄漏，
      光撤销只是把这个文件对外**关掉**；用户真正想要的往往是
      「换一条地址继续用」。手动做要两步（撤销 + 重新创建），
      而且分享那一步还得把提取码 / 有效期 / 次数原样再填一遍。
      这里一次做完，参数与目标完全不变，**只有地址变了**。

    ★ 有效期怎么算（别想当然）★
      · 原先是永久的（`expires_at == 0`） → 新链接也**永久**
      · 原先是限时的、**还没过期**      → 沿用**剩余**时间（不凭空延长）
      · 原先是限时的、**已经过期**      → 给默认 7 天
        （否则"换地址"出来的新品当场又是死的，等于没换成）

    ★ 提取码 / 次数上限 / 备注 / 目录标记 全部原样继承 ★
      提取码要**先读哈希再撤销**，否则撤销后就取不到了。

    返回新 Link；token 不存在或无权操作 → None。
    """
    lk = get(token)
    if not lk:
        return None
    if not is_admin and lk.owner != requester:
        return None

    ttl = _inherit_ttl(lk)
    pw_hash = password_hash(token)      # ★ 必须在 revoke 之前取 ★

    # 撤销：file 类必须真正删掉，否则部分唯一索引会让我们只能拿到同一条
    if not revoke(token, requester, is_admin=True):
        return None

    if lk.kind == KIND_FILE:
        return get_or_create(lk.owner, lk.mount, lk.path, lk.name, ttl=ttl)

    return create_share(
        lk.owner, lk.mount, lk.path,
        name=lk.name,
        is_dir=lk.is_dir,
        ttl=ttl,
        max_visits=lk.max_visits,
        password_hash=pw_hash,
        note=lk.note,
    )
