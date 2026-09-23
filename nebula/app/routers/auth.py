"""登录 / 登出 / 当前用户 / 改密码"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import JSONResponse
from .. import auth, files, users
from ..config import settings


router = APIRouter()

@router.post("/api/login")
async def login(request: Request, username: str = Form(...), password: str = Form(...)):
    u = users.get(username)
    if not u or not users.verify_password(password, u["password"]):
        users.audit(username, "login_fail", detail=request.client.host if request.client else "")
        raise HTTPException(401, "用户名或密码错误")

    users.touch_login(username)
    users.audit(username, "login", detail=request.client.host if request.client else "")

    token = auth.issue_session(username, bool(u["is_admin"]))
    resp = JSONResponse({
        "ok": True,
        "username": username,
        "display": u["display"] or username,
        "isAdmin": bool(u["is_admin"]),
        # ---- 会话 token 一并回给调用方 ----
        # ★ 为什么必须放在响应体里 ★
        #   Cookie 是本服务的**同源前端**在用的会话载体，浏览器会自动带上。
        #   但跨域调用方（思源插件、第三方脚本）拿不到这个 Cookie：
        #     · 本服务的 CORS **不开** allow_credentials（开了就等于全员 CSRF），
        #       所以浏览器不会把 Set-Cookie 存下来、也不会回传；
        #     · 即便存下，JS 也读不到（HttpOnly，防 XSS 是故意的）。
        #   所以跨域调用必须走 `Authorization: Bearer <token>` ——
        #   auth._extract_token 已支持这条路径，这里把 token 交出去即可。
        #
        # 安全性：token 放在响应体里会不会更容易被偷？
        #   不会。它会进入发起登录的那个页面的 JS 内存，而那个页面本来就是
        #   用户自己选的、并且已经拿到了用户名密码。真正的风险面没变大。
        #   服务端也不记录它（只签不存），日志里也不会出现。
        "token": token,
        "expiresIn": settings.session_hours * 3600,
    })
    resp.set_cookie(
        auth.COOKIE_NAME,
        token,
        max_age=settings.session_hours * 3600,
        httponly=True,      # 防 XSS 读取
        samesite="lax",     # 防 CSRF（lax 允许顶级导航，够用）
        path="/",
    )
    return resp


@router.post("/api/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE_NAME, path="/")
    return resp


@router.get("/api/me")
async def me(user: dict = Depends(auth.current_user)):
    mounts = [
        {"label": m.label, "writable": m.exists}
        for m in files.visible_mounts(user["username"])
    ]
    return {
        "username": user["username"],
        "isAdmin": user["is_admin"],
        "title": settings.title,
        "mounts": mounts,
        "onlyoffice": settings.oo_enabled,
        "cad": settings.cad_enabled,
        "disk": files.disk_usage(),
    }


@router.post("/api/password")
async def change_password(
    old: str = Form(...),
    new: str = Form(...),
    user: dict = Depends(auth.current_user),
):
    u = users.get(user["username"])
    if not u or not users.verify_password(old, u["password"]):
        raise HTTPException(400, "原密码错误")
    ok, msg = users.set_password(user["username"], new)
    if not ok:
        raise HTTPException(400, msg)
    users.audit(user["username"], "password_change")
    return {"ok": True, "message": msg}


# ===========================================================================
# 用户管理（仅管理员）
#
# 需求（原文）：「用户管理设置 放到 关于本机 按钮前面」＋「可以设置」。
# 之前这个界面是**只读**的：前端只有一段「请在容器环境变量里配」的提示，
# 因为后端根本没暴露 /api/users*。这里补齐 CRUD，前端才有得可调。
#
# ★ 三道自锁防线（都是「一次误点把自己锁在门外」的场景）★
#   1. 不能删除内置管理员（users.delete 里判）
#   2. 不能降级内置管理员（users.update 里判）
#   3. 不能删掉最后一个管理员（users.delete 里判）
# 另外改自己密码走 /api/password（要验原密码），管理员重置他人密码走
# /api/users/password（不需要原密码）—— 两条路分开，权限语义更清楚。
# ===========================================================================
