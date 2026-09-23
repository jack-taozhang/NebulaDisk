"""用户管理（管理员）：增删改、改密、审计日志"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Form, HTTPException
from .. import auth, users
from ..config import settings


router = APIRouter()

def _user_row(u: dict) -> dict:
    """把库里的行转成前端要的形状（去掉 password 哈希，别外泄）。"""
    return {
        "username": u.get("username", ""),
        "display": u.get("display") or u.get("username", ""),
        "isAdmin": bool(u.get("is_admin")),
        "createdAt": u.get("created_at") or 0,
        "lastLogin": u.get("last_login") or 0,
        "builtin": u.get("username") == settings.admin_user,
    }


@router.get("/api/users")
async def api_users_list(user: dict = Depends(auth.require_admin)):
    return {
        "ok": True,
        "users": [_user_row(u) for u in users.list_all()],
        "current": user["username"],
    }


@router.post("/api/users/create")
async def api_users_create(
    username: str = Form(...),
    password: str = Form(...),
    display: str = Form(""),
    is_admin: str = Form("false"),
    user: dict = Depends(auth.require_admin),
):
    ok, msg = users.create(
        username, password, display, is_admin.lower() in ("1", "true", "yes", "on"),
    )
    if not ok:
        raise HTTPException(400, msg)
    users.audit(user["username"], "user_create", username,
                f"admin={is_admin}")
    return {"ok": True, "message": msg}


@router.post("/api/users/update")
async def api_users_update(
    username: str = Form(...),
    display: str = Form(None),
    is_admin: str = Form(None),
    user: dict = Depends(auth.require_admin),
):
    adm = None
    if is_admin is not None:
        adm = is_admin.lower() in ("1", "true", "yes", "on")
    ok, msg = users.update(username, display, adm)
    if not ok:
        raise HTTPException(400, msg)
    users.audit(user["username"], "user_update", username,
                f"display={display} admin={adm}")
    return {"ok": True, "message": msg}


@router.post("/api/users/rename")
async def api_users_rename(
    username: str = Form(...),
    new_username: str = Form(...),
    user: dict = Depends(auth.require_admin),
):
    """修改用户名（登录名）。

    用户需求（原文）：「用户编辑可以编辑用户的用户名（登录名）」

    ★ 为什么要单独一个接口而不是扩展 users/update ★
      update 用 username 当 WHERE 条件，改的不是 username 本身。
      改登录名属于改主键，单独成接口语义清楚，也方便审计区分。
    """
    ok, msg = users.rename(username, new_username)
    if not ok:
        raise HTTPException(400, msg)
    users.audit(user["username"], "user_rename", f"{username} -> {new_username}")
    return {"ok": True, "message": msg, "username": new_username.strip()}


@router.post("/api/users/password")
async def api_users_password(
    username: str = Form(...),
    password: str = Form(...),
    user: dict = Depends(auth.require_admin),
):
    ok, msg = users.set_password(username, password)
    if not ok:
        raise HTTPException(400, msg)
    users.audit(user["username"], "user_password", username)
    return {"ok": True, "message": msg}


@router.post("/api/users/delete")
async def api_users_delete(
    username: str = Form(...),
    user: dict = Depends(auth.require_admin),
):
    if username == user["username"]:
        raise HTTPException(400, "不能删除当前登录的账户")
    ok, msg = users.delete(username)
    if not ok:
        raise HTTPException(400, msg)
    users.audit(user["username"], "user_delete", username)
    return {"ok": True, "message": msg}


@router.get("/api/users/audit")
async def api_users_audit(
    limit: int = 200,
    user: dict = Depends(auth.require_admin),
):
    return {"ok": True, "items": users.recent_audit(max(1, min(1000, limit)))}


# ===========================================================================
# 文件操作
# ===========================================================================
