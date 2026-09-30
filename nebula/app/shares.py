# -*- coding: utf-8 -*-
"""NebulaDisk —— 文件/目录**分享**（`/s/<token>`）。

## 这个文件现在是什么

★ **它是 `shortlink.py` 之上的一层兼容壳**（2026-09-30 统一链接模型）★

分享与短链原先各有一套存储。用户在报障里点名要合并：

    「网盘里面自带的分享也纳入一起，采用短链的方式分享。管理纳入一起。」

于是**数据层合并**成 `links` 一张表（`kind='file'|'share'`，见 `shortlink.py`），
而**这一层的对外 API 一个字符都没改** —— 于是：

  · `routers/share_guest.py`（访客落地页 / 列表 / 取流 / 预览）**零改动**
  · `share_web.py`（解锁 Cookie / 落地页渲染）**零改动**
  · `routers/shares_admin.py`（创建 / 撤销 / 修改 / 列表）**零改动**
  · `routers/fileops.py`（删/改名/移动时失效旧链接）**零改动**，
    而且它原有的 `shares.revoke_under_path()` 现在**顺手把 file 短链也清了**
    —— 原先「删了文件、分享清了、短链没清」的死链问题自动消失。

**顺带的收益**：分享 token 从 32 字符缩到 **12 字符**（与短链同规格）
⇒ `/s/xxxxxxxxxxxx` 只有 15 个字符，分享出去的地址也一样短了。

## 语义（自 2026-09-23 起未变，改之前先读）

  1. **分享 = 一条数据库记录 + 一个随机 token**
     对外只出现 token，不出现自增 id（id 可枚举，/s/1、/s/2 顺着试）。
     token 存**明文**（它是「分享凭证」，不像密码需要防库被拖后反推；
     且每次访问都要拿 token 查库，存摘要意味着要么带 id、要么全表扫）。
     知情选择，文档在此。

  2. **权限继承**：分享不绕过映射可见性。
     创建时校验 (mount, path) 在创建者权限内；
     访问时不再校验用户（访客可能未登录），但记录里记着 `owner`，
     且 `mount` 必须在「该 owner 可见」的映射里 —— 防止 A 分享 B 的私密目录。

  3. **目录分享**：允许。访客可以像浏览一样逐层进（只读，不能写/删/上传）。

  4. **过期与次数**：`expires_at = 0` 表示永不过期（默认 7 天）；
     `max_visits = 0` 表示不限次数；每次成功访问计数 +1。

  5. **提取码**：可选。密码用 bcrypt（复用 `users.hash_password`），
     **不像 token 那样存明文**。校验通过后发 HttpOnly Cookie
     `nebula_share_<token前16位>`，避免每次翻页都要重输。

  6. **★ 一个目标一条分享 ★**（2026-10-01 新增，见 `shortlink.py` 顶部）
     用户报障原话：「同一个文件目前可以分享多个路径，这样调整为同一个文件
     只能分享一个路径，直连一个路径。」（附截图：同一个 `.dwg` 并排两条 `/s/…`）
     ⇒ 同一个 (owner, mount, path) 至多一条分享 + 一条直链
       （两个部分唯一索引各管一半；老库重复行由迁移去重）。
     ⇒ `create()` 因此**同时是"创建"和"更新"**：
       命中已有的、仍然有效的那条 → 原地写参数，**token 不变**；
       命中已经死掉的那条（过期 / 超次）→ 撤销后新建（否则返回的是死链）。
       想知道这次是"新建"还是"复用"，看路由返回的 `reused` 字段
       （`routers/shares_admin.py` 用 `shortlink.find_share()` 判定）。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from . import shortlink, users

# 默认有效期：7 天。0 = 永不
DEFAULT_TTL_SECONDS = shortlink.DEFAULT_TTL_SECONDS

# 查询侧的长度闸门（沿用 shortlink 的：历史 token 是 32 字符，别缩）
MAX_TOKEN_LEN = shortlink.MAX_TOKEN_LEN

_KIND = shortlink.KIND_SHARE


# ---------------------------------------------------------------------------
# 建表：交给统一存储（保持原函数名，main.py 的 startup 不用改）
# ---------------------------------------------------------------------------
def init_db() -> None:
    """建表（含把历史 `shares` 表并进 `links`）。幂等。"""
    shortlink.ensure()


# ---------------------------------------------------------------------------
# 数据模型：对外形状与合并前**完全一致**
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
        d: dict[str, Any] = {
            "token": self.token,
            "kind": _KIND,
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
            d["url"] = f"{origin.rstrip('/')}/s/{self.token}"
        return d


def _to_share(lk: shortlink.Link) -> Share:
    return Share(
        token=lk.token,
        owner=lk.owner,
        mount=lk.mount,
        path=lk.path,
        name=lk.name,
        is_dir=lk.is_dir,
        created_at=lk.created_at,
        expires_at=lk.expires_at,
        max_visits=lk.max_visits,
        visits=lk.visits,
        note=lk.note,
        has_password=lk.has_password,
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
    """创建分享。ttl<=0 表示永不过期。

    ★ 幂等：同一个 (owner, mount, path) 只会有**一条**分享（2026-10-01 起）★
      命中已经存在且仍然有效的那条 → **原地更新参数并返回同一条**（token 不变）；
      命中已经死掉的那条（过期 / 超次）→ 撤销后新建。
      详见 `shortlink.create_share()` 与 `shares.py` 顶部第 6 条。
    """
    lk = shortlink.create_share(
        owner, mount, path,
        name=name,
        is_dir=is_dir,
        ttl=ttl,
        max_visits=max_visits,
        password_hash=users.hash_password(password) if password else "",
        note=note,
    )
    return _to_share(lk)


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------
def get(token: str) -> Share | None:
    """按 token 取分享。★ 只认 `kind='share'` ★

    否则 `/s/<一条 file 短链的 token>` 也能渲染出分享落地页 ——
    两种语义就被打通了，那正是合并时要避免的事。
    """
    lk = shortlink.get_kind(token, _KIND)
    return _to_share(lk) if lk else None


def list_by_owner(owner: str) -> list[Share]:
    return [_to_share(lk) for lk in shortlink.list_by_owner(owner, _KIND)]


def find_by_target(owner: str, mount: str, path: str) -> Share | None:
    """这个目标上已有的那条分享（没有 → None）。

    给「重复创建时告诉调用方这是已有链接」用（路由的 `reused` 字段）。
    """
    lk = shortlink.find_share(owner, mount, path)
    return _to_share(lk) if lk else None


def list_all() -> list[Share]:
    """管理员视图：所有用户的分享。"""
    return [_to_share(lk) for lk in shortlink.list_all(_KIND)]


def password_hash(token: str) -> str:
    """单独取提取码哈希（不放进 Share 数据类，避免误序列化出去）。"""
    return shortlink.password_hash(token)


def verify_password(token: str, plain: str) -> bool:
    h = password_hash(token)
    if not h:
        return True  # 无提取码：恒通过
    try:
        return users.verify_password(plain, h)
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# 计数与撤销
# ---------------------------------------------------------------------------
def bump_visit(token: str) -> None:
    shortlink.touch(token, visit=True)


def revoke(token: str, requester: str, is_admin: bool = False) -> bool:
    """撤销分享。只有 owner 或管理员可以。返回是否真的删掉了。

    ★ 限定 kind='share' ★ —— `POST /api/shares/revoke` 不该能删掉一条直链
    （撤销直链请走统一的 `POST /api/links/revoke`）。
    """
    return shortlink.revoke(token, requester, is_admin=is_admin, kind=_KIND)


def revoke_by_path(owner: str, mount: str, path: str) -> int:
    """文件/目录被删除或移动时，清掉指向它的链接（否则留下死链）。

    ★ 这里**两种类型一起清**（短链 + 分享）★
      调用方是 `fileops.py` 的 delete/rename/move，它的意图就是
      「这个路径不再指向原来的东西了，指向它的链接都该失效」——
      把直链留着就是信息泄漏。返回的是清掉的总条数。
    """
    return shortlink.revoke_by_path(owner, mount, path)


def revoke_under_path(owner: str, mount: str, path: str) -> int:
    """删除**目录**时，清掉它自己以及它之下所有路径的链接。

    为什么需要单独一个：revoke_by_path 只匹配精确相同的 path，
    而「分享过 目录/sub/file.txt」在删除 目录 时也必须一并失效。
    用 prefix + '/' 匹配（注意加 '/' 以免 `a/b` 命中 `a/bc`）。
    """
    return shortlink.revoke_under_path(owner, mount, path)


def update(
    token: str,
    *,
    note: str | None = None,
    ttl_days: float | None = None,
    max_visits: int | None = None,
    password: str | None = None,
) -> bool:
    """局部更新。None = 不改。ttl_days<=0 → 永不过期。"""
    return shortlink.update(
        token,
        note=note,
        ttl_days=ttl_days,
        max_visits=max_visits,
        password_hash=None if password is None
        else (users.hash_password(password) if password else ""),
    )
