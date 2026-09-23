"""OnlyOffice 编辑器配置 / 保存回调 + 各引擎健康检查"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from .. import auth, files, integrations, users
from ..config import settings
from ..webutil import _origin, _internal_origin, _mount, make_raw_url


router = APIRouter()

@router.post("/api/oo/config")
async def api_oo_config(
    request: Request,
    mount: str = Form(""), path: str = Form(""),
    user: dict = Depends(auth.current_user),
):
    # ★ 参数改默认空串 + 显式校验：理由同 /api/preview（避免裸 422）★
    if not mount:
        raise HTTPException(400, "缺少参数：mount（网盘名称）")
    if not path:
        raise HTTPException(400, "缺少参数：path（文件路径）")

    if not settings.oo_enabled:
        raise HTTPException(400, "OnlyOffice 未配置")
    if not settings.oo_secret:
        raise HTTPException(500, "OnlyOffice 密钥未配置，无法签名")

    m = _mount(user["username"], mount)
    p = files.resolve(m, path)
    if p.is_dir():
        raise HTTPException(400, "目录不能用 OnlyOffice 打开")

    st = p.stat()

    # 只读挂载 / 无写权限 → 以 view 模式打开（编辑了也存不回去，不如直接只读）
    mode = "edit" if os.access(p, os.W_OK) else "view"

    doc_url = make_raw_url(mount, path, ttl=3600)

    # 回调地址里的 mount/path 是给服务端自己回填用的，用标准 urlencode
    from urllib.parse import urlencode
    cb = f"{_internal_origin()}/api/oo/callback?" + urlencode({"mount": mount, "path": path})

    cfg = integrations.build_editor_config(
        file_key=integrations.file_key(mount, path, int(st.st_mtime), st.st_size),
        title=p.name,
        doc_url=doc_url,
        callback_url=cb,
        mode=mode,
        user_id=user["username"],
        user_name=user["username"],
    )

    users.audit(user["username"], "oo_open", f"{mount}:{path}", mode)

    return {
        "ok": True,
        "config": cfg,
        # 浏览器要加载的 api.js 地址（OnlyOffice 对外地址）
        "apiJs": f"{integrations.oo_public_base(_origin(request))}/web-apps/apps/api/documents/api.js",
        "mode": mode,
        "title": p.name,
    }


@router.post("/api/oo/callback")
async def api_oo_callback(mount: str, path: str, request: Request):
    """OnlyOffice 保存回调。

    status 语义：
      1 = 文档被打开并进入编辑
      2 = 文档已就绪可保存（**有新内容**）→ 下载并覆盖
      3 = 保存出错
      4 = 无改动关闭
      6 = 强制保存（forcesave）→ **有新内容**，同样要下载
      7 = 强制保存出错
    """
    body = await request.json()

    # ---- 验签 ----
    tok = body.get("token")
    if settings.oo_secret:
        if not tok:
            raise HTTPException(403, "回调缺少 token")
        try:
            auth.jwt_decode(tok, settings.oo_secret)
        except ValueError as e:
            raise HTTPException(403, f"回调验签失败: {e}") from e

    status = int(body.get("status", 0))
    url = body.get("url")
    key = body.get("key", "")
    print(f"[onlyoffice] callback status={status} key={key} url={'有' if url else '无'}",
          file=sys.stderr)

    if status in (1, 4):
        return {"error": 0}

    if status in (2, 6) and url:
        target = None
        for m in settings.mounts:
            if m.label == mount:
                target = m
                break
        if target is None:
            return {"error": 1}

        try:
            dest = files.resolve(target, path)
            size = await integrations.fetch_edited(url, str(dest))
            users.audit("onlyoffice", "oo_save", f"{mount}:{path}", f"{size}B")
            print(f"[onlyoffice] 已写回 {dest} ({size} 字节)", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"[onlyoffice] 写回失败: {e}", file=sys.stderr)
            return {"error": 1}

    return {"error": 0}


@router.get("/api/oo/health")
async def api_oo_health():
    return await integrations.check_oo_health()


@router.get("/api/kk/health")
async def api_kk_health():
    """kkFileView 探活，前端据此显示「在线 / 离线」。"""
    return await integrations.check_kk_health()


@router.get("/api/cad/health")
async def api_cad_health():
    """CAD 查看器探活，前端据此显示「在线 / 离线」。"""
    return await integrations.check_cad_health()


# ===========================================================================
# kkFileView 预览
# ===========================================================================
