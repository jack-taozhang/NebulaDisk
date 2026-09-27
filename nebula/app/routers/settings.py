# -*- coding: utf-8 -*-
"""管理员设置 API —— 目录映射、OnlyOffice、kkFileView、CAD 查看器等。

只有管理员可以读取和修改。
修改后写入 settings.json，下次启动也会生效。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Form, HTTPException
from typing import Optional

from .. import users
from ..auth import require_admin
from ..config import settings, save_settings_to_json, reload_settings, Mount, _resolve_ext_sets

router = APIRouter(tags=["settings"])


# ---------------------------------------------------------------------------
# 读取设置
# ---------------------------------------------------------------------------

@router.get("/api/admin/settings")
async def api_get_settings(user: dict = Depends(require_admin)):
    """获取当前服务器设置（仅管理员）。

    返回内容：
      - mounts: 目录映射列表
      - oo_url / oo_secret / oo_public: OnlyOffice 配置
      - preview_url / preview_public: kkFileView 配置
      - cad_url / cad_probe: CAD 查看器配置
      - title / max_upload_mb / base_url / cors_origins / session_hours: 基本设置
    """
    # 格式列表：返回实际生效的完整列表（逗号分隔），方便用户直接编辑
    def _fmt_ext(s):
        return ", ".join(sorted(s))

    return {
        "mounts": [
            {
                "label": m.label,
                "path": m.path,
                "users": sorted(m.users),
                "writable": m.writable,
            }
            for m in settings.mounts
        ],
        "oo_url": settings.oo_url,
        "oo_secret": settings.oo_secret,
        "oo_public": settings.oo_public,
        "oo_callback_url": settings.oo_callback_url,
        "oo_enabled": settings.oo_enabled,
        "oo_ext": _fmt_ext(settings._oo_ext_set),
        "preview_url": settings.preview_url,
        "preview_public": settings.preview_public,
        "kk_ext": _fmt_ext(settings._kk_ext_set),
        "cad_url": settings.cad_url,
        "cad_probe": settings.cad_probe,
        "cad_enabled": settings.cad_enabled,
        "cad_ext": _fmt_ext(settings._cad_ext_set),
        "title": settings.title,
        "max_upload_mb": settings.max_upload_mb,
        "base_url": settings.base_url,
        "cors_origins": settings.cors_origins,
        "session_hours": settings.session_hours,
        "data_dir": settings.data_dir,
    }


# ---------------------------------------------------------------------------
# 保存设置
# ---------------------------------------------------------------------------

@router.post("/api/admin/settings")
async def api_save_settings(
    # --- 基本设置 ---
    title: Optional[str] = Form(None),
    max_upload_mb: Optional[str] = Form(None),
    base_url: Optional[str] = Form(None),
    cors_origins: Optional[str] = Form(None),
    session_hours: Optional[str] = Form(None),

    # --- OnlyOffice ---
    oo_url: Optional[str] = Form(None),
    oo_secret: Optional[str] = Form(None),
    oo_public: Optional[str] = Form(None),
    oo_callback_url: Optional[str] = Form(None),

    # --- kkFileView ---
    preview_url: Optional[str] = Form(None),
    preview_public: Optional[str] = Form(None),

    # --- CAD 查看器 ---
    cad_url: Optional[str] = Form(None),
    cad_probe: Optional[str] = Form(None),

    # --- 文件格式（逗号/空格/换行分隔的扩展名列表）---
    oo_ext: Optional[str] = Form(None),
    kk_ext: Optional[str] = Form(None),
    cad_ext: Optional[str] = Form(None),

    # --- 目录映射（JSON 字符串，因为是列表结构）---
    mounts: Optional[str] = Form(None),

    user: dict = Depends(require_admin),
):
    """保存服务器设置（仅管理员）。

    所有字段都是可选的：传了就更新，没传就保留原值。
    mounts 字段是 JSON 字符串，格式：
      [{"label": "文档", "path": "/mnt/docs", "users": ["*"], "writable": true}, ...]

    保存后立即写入 settings.json 并刷新内存中的单例。
    """
    import json

    s = settings  # 当前内存中的设置

    # ---- 基本设置 ----
    if title is not None:
        s.title = title.strip() or "NebulaDisk"
    if max_upload_mb is not None:
        try:
            s.max_upload_mb = max(1, int(max_upload_mb))
        except (ValueError, TypeError):
            raise HTTPException(400, "max_upload_mb 必须是正整数")
    if base_url is not None:
        s.base_url = base_url.strip().rstrip("/")
    if cors_origins is not None:
        s.cors_origins = cors_origins.strip()
    if session_hours is not None:
        try:
            s.session_hours = max(1, int(session_hours))
        except (ValueError, TypeError):
            raise HTTPException(400, "session_hours 必须是正整数")

    # ---- OnlyOffice ----
    if oo_url is not None:
        s.oo_url = oo_url.strip().rstrip("/")
        s.oo_enabled = bool(s.oo_url)
    if oo_secret is not None:
        s.oo_secret = oo_secret
    if oo_public is not None:
        s.oo_public = oo_public.strip().rstrip("/")
    if oo_callback_url is not None:
        s.oo_callback_url = oo_callback_url.strip().rstrip("/")

    # ---- kkFileView ----
    if preview_url is not None:
        s.preview_url = preview_url.strip().rstrip("/")
    if preview_public is not None:
        s.preview_public = preview_public.strip().rstrip("/")

    # ---- CAD 查看器 ----
    if cad_url is not None:
        s.cad_url = cad_url.strip().rstrip("/")
        s.cad_enabled = bool(s.cad_url)
    if cad_probe is not None:
        s.cad_probe = cad_probe.strip().rstrip("/")
    if s.cad_enabled and not s.cad_probe:
        s.cad_probe = s.cad_url

    # ---- 目录映射 ----
    if mounts is not None:
        try:
            mounts_data = json.loads(mounts) if isinstance(mounts, str) else mounts
        except json.JSONDecodeError:
            raise HTTPException(400, "mounts 不是有效的 JSON")
        if not isinstance(mounts_data, list):
            raise HTTPException(400, "mounts 必须是数组")

        new_mounts = []
        for i, m in enumerate(mounts_data):
            if not isinstance(m, dict):
                raise HTTPException(400, f"第 {i+1} 个映射格式错误")
            path = (m.get("path") or "").strip()
            if not path:
                raise HTTPException(400, f"第 {i+1} 个映射路径不能为空")
            label = (m.get("label") or "").strip()
            if not label:
                # 没填显示名就用路径最后一段
                import os
                cleaned = path.replace("\\", "/").rstrip("/")
                label = os.path.basename(cleaned) or path

            users_raw = m.get("users") or ["*"]
            if isinstance(users_raw, str):
                users_set = {u.strip() for u in users_raw.split(",") if u.strip()}
            else:
                users_set = {str(u).strip() for u in users_raw if str(u).strip()}
            if not users_set:
                users_set = {"*"}

            writable = bool(m.get("writable", True))
            new_mounts.append(Mount(label=label, path=path, users=users_set, writable=writable))

        s.mounts = new_mounts

    # --- 文件格式 ---
    if oo_ext is not None:
        s.oo_ext = oo_ext.strip()
    if kk_ext is not None:
        s.kk_ext = kk_ext.strip()
    if cad_ext is not None:
        s.cad_ext = cad_ext.strip()

    # 重新解析格式集合（立即生效）
    _resolve_ext_sets(s)

    # 写入 JSON 文件
    saved_path = save_settings_to_json()

    # 审计
    users.audit(user["username"], "admin-settings", "saved")

    return {"ok": True, "saved_to": saved_path}
