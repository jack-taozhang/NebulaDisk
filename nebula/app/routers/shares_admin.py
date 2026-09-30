"""分享管理（登录侧）：创建 / 撤销 / 修改 / 列表"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from .. import auth, files, shares, users
from ..webutil import _origin, _mount


router = APIRouter()

# ===========================================================================
# 分享（登录侧：创建 / 列出 / 撤销）
# ===========================================================================
# 需求（原文）：「增加文件分享的功能。」
#
# 设计（详见 app/shares.py 顶部注释）：
#   - 对外只暴露随机 token（/s/<token>），不暴露自增 id（可枚举）
#   - 分享不绕过映射可见性：创建时按【创建者】的权限校验
#   - 目录可分享，访客只读地逐层浏览
#   - 可选密码（bcrypt）+ 过期时间 + 访问次数上限
#
# ★ 一个必须守住的点 ★
#   创建分享时校验 (mount, path) 存在且**在创建者权限内**。
#   否则 A 可以分享 B 的私密目录，且通过免登录的分享页把内容读出去 ——
#   那就绕过了整个权限体系。见 _mount() / files.resolve()。


@router.get("/api/shares")
async def api_shares(user: dict = Depends(auth.current_user)):
    """列出当前用户的分享（管理员加 ?all=1 看全部）。"""
    items = shares.list_all() if user["is_admin"] else shares.list_by_owner(user["username"])
    return {"shares": [s.as_dict() for s in items]}


@router.post("/api/shares")
async def api_share_create(
    request: Request,
    mount: str = Form(...),
    path: str = Form(...),
    ttl_days: float = Form(7),
    max_visits: int = Form(0),
    password: str = Form(""),
    note: str = Form(""),
    user: dict = Depends(auth.current_user),
):
    """创建分享。

    ttl_days: 0 或负数 → 永不过期；默认 7 天。
    max_visits: 0 → 不限次数。

    ★ 目标是**一个文件一条分享**（2026-10-01 用户要求）★
      同一个 (owner, mount, path) 只会有一条：命中已存在且仍然有效的那条时，
      参数被原地更新、**token 不变**（地址不变），响应里 `reused=True`。
      命中已死掉的（过期 / 超次）则由 `shares.create` 撤销后新建 —— 那时
      `reused=False`，因为返回的确实是一条新地址。
      ⚠️ 前端据此决定文案：别对用户说"已创建"，他看到的是一条老链接。
    """
    m = _mount(user["username"], mount)
    p = files.resolve(m, path)          # 存在性 + 穿越校验 + 映射可见性

    is_dir = p.is_dir()
    name = p.name or mount

    # ★ 先记下"之前有没有"：create 之后无法区分（同一条会被原地更新）★
    before = shares.find_by_target(user["username"], mount, path)

    ttl = 0 if ttl_days <= 0 else int(ttl_days * 86400)
    sh = shares.create(
        owner=user["username"],
        mount=mount,
        path=path,
        name=name,
        is_dir=is_dir,
        ttl=ttl,
        max_visits=max_visits,
        password=password,
        note=note,
    )
    reused = bool(before and before.token == sh.token)
    users.audit(user["username"], "share", f"{mount}:{path}",
                f"ttl={ttl}s visits={max_visits} pw={'yes' if password else 'no'}"
                f" reused={'yes' if reused else 'no'}")
    return {"ok": True, "reused": reused, "share": sh.as_dict(origin=_origin(request))}


@router.post("/api/shares/revoke")
async def api_share_revoke(
    token: str = Form(...), user: dict = Depends(auth.current_user),
):
    ok = shares.revoke(token, user["username"], is_admin=user.get("is_admin", False))
    if not ok:
        raise HTTPException(404, "分享不存在或无权撤销")
    users.audit(user["username"], "share-revoke", token[:12])
    return {"ok": True}


@router.post("/api/shares/update")
async def api_share_update(
    token: str = Form(...),
    note: str = Form(None),
    ttl_days: float = Form(None),
    max_visits: int = Form(None),
    user: dict = Depends(auth.current_user),
):
    """改备注 / 有效期 / 次数。只允许 owner 或管理员。"""
    sh = shares.get(token)
    if not sh:
        raise HTTPException(404, "分享不存在")
    if not user.get("is_admin") and sh.owner != user["username"]:
        raise HTTPException(403, "无权修改该分享")
    shares.update(token, note=note, ttl_days=ttl_days, max_visits=max_visits)
    fresh = shares.get(token)
    return {"ok": True, "share": fresh.as_dict() if fresh else None}


# ===========================================================================
# 分享（访客侧：免登录）
# ===========================================================================
# ★ 这一组接口**不挂 current_user 依赖**，靠 token 鉴权 ★
#   它们必须自己把权限关：token 有效 + 未过期 + 未超次 + （有密码则已解锁）。
