# -*- coding: utf-8 -*-
"""
NebulaDisk —— 会话与鉴权

两个独立的 JWT 体系，不要混：
  1. 自有会话 token  —— 云盘登录用，HS256，密钥 NEBULA_JWT_SECRET，
                        放在 HttpOnly Cookie 里（防 XSS 窃取）。
  2. OnlyOffice token —— 调 OnlyOffice 时签名用，密钥 NEBULA_OO_SECRET，
                        由 integrations.py 负责。两者密钥通常不同！
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

from fastapi import HTTPException, Request, status

from .config import settings


# ---------------------------------------------------------------------------
# 极简 HS256 JWT 实现
# ---------------------------------------------------------------------------
# 为什么不用 PyJWT：OnlyOffice 要求的 token 就是一个标准 HS256 JWT，
# 自己实现 30 行就够，少一个依赖，NAS 上装包更快、更少踩版本坑。
# 但要严格遵守：
#   - 必须用 hmac.compare_digest 做恒定时间比较，防时序攻击
#   - 必须校验 exp
#   - header/payload 的 base64 用 urlsafe 且去掉 padding（JWT 规范）
# ---------------------------------------------------------------------------

def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def jwt_encode(payload: dict[str, Any], secret: str, header: dict | None = None) -> str:
    h = header or {"alg": "HS256", "typ": "JWT"}
    segs = [
        _b64e(json.dumps(h, separators=(",", ":")).encode("utf-8")),
        _b64e(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")),
    ]
    signing_input = ".".join(segs).encode("ascii")
    sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    segs.append(_b64e(sig))
    return ".".join(segs)


def jwt_decode(token: str, secret: str) -> dict[str, Any]:
    """解析并验签。任何异常统一抛 ValueError，由调用方翻译成 HTTP 错误。"""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("token 格式非法")

    signing_input = f"{parts[0]}.{parts[1]}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()

    try:
        actual = _b64d(parts[2])
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"签名段无法解码: {e}") from e

    if not hmac.compare_digest(expected, actual):
        raise ValueError("签名校验失败")

    try:
        payload = json.loads(_b64d(parts[1]))
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"载荷无法解析: {e}") from e

    exp = payload.get("exp")
    if exp is not None and int(exp) < int(time.time()):
        raise ValueError("会话已过期")

    return payload


# ---------------------------------------------------------------------------
# 会话 token
# ---------------------------------------------------------------------------
COOKIE_NAME = "nebula_session"


def issue_session(username: str, is_admin: bool = False) -> str:
    now = int(time.time())
    return jwt_encode(
        {
            "sub": username,
            "adm": bool(is_admin),
            "iat": now,
            "exp": now + settings.session_hours * 3600,
            "iss": "nebuladisk",
        },
        settings.jwt_secret,
    )


def read_session(token: str | None) -> dict | None:
    """返回 {'username':..., 'is_admin':...}，无效则 None。"""
    if not token:
        return None
    try:
        p = jwt_decode(token, settings.jwt_secret)
    except ValueError:
        return None
    if p.get("iss") != "nebuladisk":
        return None
    sub = p.get("sub")
    if not sub:
        return None
    return {"username": str(sub), "is_admin": bool(p.get("adm"))}


# ---------------------------------------------------------------------------
# FastAPI 依赖
# ---------------------------------------------------------------------------
def _extract_token(request: Request) -> str | None:
    """优先 Cookie；同时支持 Authorization: Bearer，便于脚本调用/调试。"""
    tok = request.cookies.get(COOKIE_NAME)
    if tok:
        return tok
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def current_user(request: Request) -> dict:
    """要求已登录，否则 401。"""
    sess = read_session(_extract_token(request))
    if not sess:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未登录或会话已过期",
        )
    return sess


def require_admin(request: Request) -> dict:
    sess = current_user(request)
    if not sess.get("is_admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return sess
