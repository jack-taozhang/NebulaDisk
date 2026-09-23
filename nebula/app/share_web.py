"""分享的 Web 层公共件：解锁 Cookie、分享装载与解锁判定、落地页渲染"""

from __future__ import annotations

import hashlib
import hmac

from fastapi import HTTPException, Request
from fastapi.responses import Response
from . import shares
from .webutil import WEB_DIR# ---- 分享解锁 Cookie 的名字前缀 ----
#   （访客侧要读写它；/cad 反代也要把它剔掉，不外传给第三方引擎）
_SHARE_COOKIE_PREFIX = "nebula_share_"


def _load_live_share(token: str) -> shares.Share:
    sh = shares.get(token)
    if not sh:
        raise HTTPException(404, "分享不存在或已被撤销")
    if sh.expired:
        raise HTTPException(410, "分享已过期")
    if sh.exhausted:
        raise HTTPException(410, "分享访问次数已用完")
    return sh


def _share_unlocked(request: Request, token: str) -> bool:
    """本请求是否已通过该分享的密码校验。无密码分享恒 True。"""
    if not shares.password_hash(token):
        return True
    want = shares.password_hash(token)
    got = request.cookies.get(_SHARE_COOKIE_PREFIX + token[:16]) or ""
    if not got:
        return False
    # Cookie 里存的是 password_hash 的短摘要，不是明文密码。
    # 这样即使 Cookie 泄漏，也拿不到密码本身，只是"解锁凭证"。
    expect = hashlib.sha256((want + token).encode()).hexdigest()
    return hmac.compare_digest(got, expect)


def _set_share_cookie(resp: Response, token: str) -> None:
    want = shares.password_hash(token)
    val = hashlib.sha256((want + token).encode()).hexdigest()
    resp.set_cookie(
        _SHARE_COOKIE_PREFIX + token[:16], val,
        max_age=7 * 24 * 3600, httponly=True, samesite="lax", path="/",
    )




def _render_share_page(sh: shares.Share, request: Request, *, unlocked: bool) -> str:
    """渲染分享落地页。轻量、自包含（不依赖 SPA 的 js）。"""
    page = WEB_DIR / "share.html"
    if not page.exists():
        return "<h1>分享页缺失</h1>"
    html = page.read_text(encoding="utf-8")
    import json as _json
    boot = _json.dumps({
        "token": sh.token,
        "name": sh.name,
        "isDir": sh.is_dir,
        "unlocked": unlocked,
        "hasPassword": sh.has_password,
        "expiresAt": sh.expires_at,
        "owner": sh.owner,
    }, ensure_ascii=False)
    return html.replace("__SHARE_BOOT__", boot)


# ===========================================================================
# 前端
# ===========================================================================
