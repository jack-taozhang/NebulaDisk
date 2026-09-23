"""分享的**访客侧**：落地页、解锁、列表、取流、预览（全程无登录态）"""

from __future__ import annotations

import hashlib
import hmac
import time
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from .. import files, integrations, shares, users
from ..config import route_of, settings
from ..webutil import _origin, _internal_origin, _stream_file
from ..share_web import _load_live_share, _share_unlocked, _set_share_cookie, _render_share_page


router = APIRouter()

@router.get("/api/s/{token}", response_class=HTMLResponse)
async def api_share_page(token: str, request: Request):
    """分享落地页（HTML）。未解锁时渲染密码框。"""
    sh = _load_live_share(token)
    unlocked = _share_unlocked(request, token)
    # 无密码 或 已解锁 → 渲染文件浏览页；否则密码页
    html = _render_share_page(sh, request, unlocked=unlocked)
    return HTMLResponse(html)


@router.post("/api/s/{token}/unlock")
async def api_share_unlock(
    token: str, request: Request, password: str = Form(""),
):
    sh = _load_live_share(token)
    if not shares.verify_password(token, password):
        users.audit("guest", "share-unlock-fail", token[:12])
        raise HTTPException(403, "提取码不正确")
    resp = JSONResponse({"ok": True})
    _set_share_cookie(resp, token)
    return resp


@router.get("/api/s/{token}/list")
async def api_share_list(token: str, request: Request, path: str = ""):
    """访客列目录（只读）。path 是相对分享根目录的子路径。"""
    sh = _load_live_share(token)
    if not _share_unlocked(request, token):
        raise HTTPException(403, "需要提取码")

    m = _mount_for_share(sh)

    # ★ 关键：把「分享内的相对路径」拼到「分享根路径」上，再交给同一个 resolve 校验 ★
    #   绝不能让访客传一个 ../.. 跳出分享根 —— resolve() 会挡住，
    #   但这里还要额外确认结果**仍在分享根之下**（见 _inside_share）。
    base = sh.path
    sub = (path or "").strip().lstrip("/")
    full = base if not sub else (base.rstrip("/") + "/" + sub)
    p = files.resolve(m, full)
    if not _inside_share(m, p, sh):
        raise HTTPException(403, "越出分享范围")

    if p.is_file():
        # 分享单个文件时，list 返回它自己（前端统一处理）
        # ★ stat_of 返回的就是 entry 字段本身（有 name/isDir/size/... ），
        #   没有嵌套的 "entry" 键 —— 这里曾误写成 .get("entry") 导致空对象。
        item = files.stat_of(m, full)
        item.setdefault("name", p.name)
        return {"ok": True, "share": sh.as_dict(), "path": sub,
                "entries": [item], "single": True}

    data = files.list_dir(m, full, sh.owner)
    return {"ok": True, "share": sh.as_dict(), "path": sub,
            "entries": data.get("entries", []), "single": False}


def _mount_for_share(sh: shares.Share):
    """取分享对应的映射。

    ★ 这里用 owner 作为可见性上下文 ★
      分享在创建时已按 owner 权限校验过；访问时用 owner 的身份取映射，
      保证「A 分享的内容只有 A 能看到的那些」这条一致性。
    """
    try:
        return files.get_mount(sh.mount, sh.owner)
    except files.FileError as e:
        raise HTTPException(e.code, e.message) from e


def _inside_share(m, target: Path, sh: shares.Share) -> bool:
    """确认 target 仍在分享根之下（目录分享）或就是分享的那个文件。"""
    try:
        root = files.resolve(m, sh.path)
    except files.FileError:
        return False
    if sh.is_dir:
        try:
            return target == root or target.is_relative_to(root)
        except AttributeError:  # Python < 3.9
            return target == root or root in target.parents
    return target == root


@router.get("/api/s/{token}/raw")
async def api_share_raw(token: str, request: Request, path: str = "", download: bool = False):
    """访客取流（预览 / 下载）。"""
    sh = _load_live_share(token)
    if not _share_unlocked(request, token):
        raise HTTPException(403, "需要提取码")

    m = _mount_for_share(sh)
    base = sh.path
    sub = (path or "").strip().lstrip("/")
    full = base if not sub else (base.rstrip("/") + "/" + sub)
    p = files.resolve(m, full)
    if not _inside_share(m, p, sh):
        raise HTTPException(403, "越出分享范围")
    if p.is_dir():
        raise HTTPException(400, "目录不能直接下载")

    if not sh.is_dir:
        # 单文件分享：第一次取流算一次访问
        shares.bump_visit(token)
    return _stream_file(p, download=download)


@router.get("/api/s/{token}/preview")
async def api_share_preview(token: str, request: Request, path: str = ""):
    """访客预览地址（kkFileView / OnlyOffice 二选一，按扩展名路由）。"""
    sh = _load_live_share(token)
    if not _share_unlocked(request, token):
        raise HTTPException(403, "需要提取码")

    m = _mount_for_share(sh)
    base = sh.path
    sub = (path or "").strip().lstrip("/")
    full = base if not sub else (base.rstrip("/") + "/" + sub)
    p = files.resolve(m, full)
    if not _inside_share(m, p, sh):
        raise HTTPException(403, "越出分享范围")
    if p.is_dir():
        raise HTTPException(400, "目录不支持预览")

    # ★ 预览通道的鉴权走 make_share_raw_url（签名里带 token，短期有效）★
    #   不能复用登录态的 make_raw_url —— 那是给登录用户签的，
    #   而访客没有会话，签名里必须体现"是这条分享"。
    raw = make_share_raw_url(sh, sub, ttl=3600)
    route = route_of(p.name)

    if route == "onlyoffice" and settings.oo_enabled:
        st = p.stat()
        cb = f"{_internal_origin()}/api/s/{sh.token}/oo-callback?" + urlencode({"path": sub})
        cfg = integrations.build_editor_config(
            file_key=f"share-{sh.token[:16]}-{int(st.st_mtime)}-{st.st_size}",
            title=p.name,
            doc_url=raw,
            callback_url=cb,
            mode="view",              # ★ 访客一律只读 ★
            user_id="guest",
            user_name="访客",
        )
        # apiJs 必须是「浏览器可达」的地址（与桌面端 /api/oo/config 同源逻辑）
        return {
            "ok": True, "route": "onlyoffice", "config": cfg,
            "apiJs": f"{integrations.oo_public_base(_origin(request))}"
                     "/web-apps/apps/api/documents/api.js",
        }

    inner = integrations.kk_preview_url("", raw)
    return {"ok": True, "route": "kkfileview", "url": f"{settings.preview_public}{inner}", "raw": raw}

    inner = integrations.kk_preview_url("", raw)
    return {"ok": True, "route": "kkfileview", "url": f"{settings.preview_public}{inner}", "raw": raw}


def make_share_raw_url(sh: shares.Share, sub: str, ttl: int = 3600) -> str:
    """给访客预览/下载用的**签名 URL**。

    ★ 为什么要单独一套 ★
      OnlyOffice / kkFileView 是**服务端**来取文件的，带不了浏览器 Cookie，
      所以必须用签名 URL。而登录态的 make_raw_url 签的是"用户会话"，
      访客没有会话 —— 签名里必须体现"这条分享 + 这个子路径"。
      签名内容 = token + sub + exp，用 jwt_secret 做 HMAC。
      这样链接短期有效、且只对这条分享的这一个子路径有效。
    """
    exp = int(time.time()) + ttl
    raw = f"share\n{sh.token}\n{sub}\n{exp}"
    import hmac as _hmac
    sig = _hmac.new(settings.jwt_secret.encode(), raw.encode(), hashlib.sha256).hexdigest()
    q = urlencode({"token": sh.token, "path": sub, "exp": exp, "sig": sig})
    tail = PurePosixPath(sub).name or (sh.name or "file.bin")
    return f"{_internal_origin()}/api/s/{sh.token}/sraw/{quote(tail)}?{q}"


@router.get("/api/s/{token}/sraw/{filename}")
async def api_share_sraw(filename: str, token: str, path: str = "", exp: int = 0, sig: str = ""):
    """签名取流（免 Cookie）。仅供 OnlyOffice / kkFileView 服务端回拉。"""
    import hmac as _hmac
    if exp and exp < int(time.time()):
        raise HTTPException(403, "链接已过期")
    raw = f"share\n{token}\n{path}\n{exp}"
    expect = _hmac.new(settings.jwt_secret.encode(), raw.encode(), hashlib.sha256).hexdigest()
    if not _hmac.compare_digest(expect, sig):
        raise HTTPException(403, "签名校验失败")

    sh = _load_live_share(token)
    m = _mount_for_share(sh)
    base = sh.path
    sub = (path or "").strip().lstrip("/")
    full = base if not sub else (base.rstrip("/") + "/" + sub)
    p = files.resolve(m, full)
    if not _inside_share(m, p, sh):
        raise HTTPException(403, "越出分享范围")
    return _stream_file(p, download=False)


@router.post("/api/s/{token}/oo-callback")
async def api_share_oo_callback(token: str):
    """分享场景的 OnlyOffice 回调。

    ★ 一律返回 error=0 但**不落盘** ★
      访客以 view 模式打开，OnlyOffice 理论上不会发保存回调；
      但真实环境里（用户误点、客户端行为差异）偶尔还是会发。
      这里显式拒绝写入：分享是只读的，绝不能让访客通过编辑器改到原文件。
      返回 {"error":0} 是为了让 OnlyOffice 正常关闭编辑器，不弹错误框。
    """
    users.audit("guest", "share-oo-callback-blocked", token[:12])
    return {"error": 0}
