# -*- coding: utf-8 -*-
"""
NebulaDisk —— FastAPI 应用（**只负责组装**）

路由实现按 URL 面拆在 `app/routers/` 下，本文件只做四件事：
  1. 建 app（关掉 docs/openapi —— 内网服务，不暴露接口文档）
  2. 挂启动钩子与全局异常处理
  3. 按**固定顺序** include 各路由（顺序影响匹配，见下）
  4. 挂静态资源

路由总览（按注册顺序）：
  routers/auth.py          POST /api/login · /api/logout · /api/password · GET /api/me
  routers/users.py         GET/POST /api/users*（管理员）
  routers/fileops.py       GET /api/list · /api/stat · /api/download；POST mkdir/rename/…
  routers/rawlink.py       GET  /api/raw/{filename}    给外部引擎取流的**签名直链**
  routers/onlyoffice.py    POST /api/oo/config · /api/oo/callback；GET /api/{oo,kk,cad}/health
  routers/preview.py       GET  /api/preview · /preview/* · /website/*   kkFileView 同源反代
  routers/cad.py           GET  /api/cad/preview · /cad/*                CAD 同源反代
  routers/shares_admin.py  GET/POST /api/shares*                         分享管理（登录侧）
  routers/share_guest.py   GET/POST /api/s/{token}*                      分享**访客侧**
  routers/pages.py         GET  / · /s/{token} · /healthz

★ include 顺序不能随意调 ★
  FastAPI 按注册顺序匹配。本文件里的顺序 = 重构前 main.py 里的定义顺序；
  其中 `/preview/{rest:path}`、`/website/{rest:path}`、`/cad/{rest:path}` 是通配，
  提前注册会把后面的具体路径一起吞掉。改动前先确认没有通配冲突。

★ 路由模块一律用 `*_routes` 别名 ★
  routers/auth.py 与 routers/users.py 和**数据层**的 `app.auth` / `app.users` 同名。
  若不取别名，`from .routers import users` 会把数据层的 `users` 遮住 ——
  启动钩子里那句 `users.init_db()` 就会打到路由模块上，报
      AttributeError: module 'app.routers.users' has no attribute 'init_db'
  （这是真踩过的坑，见下。）
"""

from __future__ import annotations

import sys

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import files, shares, users
from .config import parse_cors_origins, settings
from .routers import auth as auth_routes
from .routers import cad as cad_routes
from .routers import fileops as fileops_routes
from .routers import onlyoffice as onlyoffice_routes
from .routers import pages as pages_routes
from .routers import preview as preview_routes
from .routers import rawlink as rawlink_routes
from .routers import share_guest as share_guest_routes
from .routers import shares_admin as shares_admin_routes
from .routers import users as users_routes
from .webutil import WEB_DIR

app = FastAPI(title=settings.title, docs_url=None, redoc_url=None, openapi_url=None)


# ---------------------------------------------------------------------------
# 跨域（CORS）
# ---------------------------------------------------------------------------
# 背景：本服务的正常前端与 API **同源**，所以起初一个 CORS 头都没发。
# 但外部集成方（思源笔记插件等）的页面在另一个 origin，
# 浏览器会先发 OPTIONS 预检，服务端不回 CORS 头就一律被拦。
#
# ★ 为什么不开 allow_credentials ★
#   CORS 规范明令：Allow-Origin 为 "*" 时**不允许**同时 Allow-Credentials: true。
#   而且一旦开了凭据，任何网站都能借用户浏览器里的 Cookie 打本服务，
#   等于把所有写操作暴露成 CSRF。
#   所以这里**始终** allow_credentials=False：
#     · 跨域调用方自己用 `Authorization: Bearer <会话 token>`（auth.py 已支持）
#     · 同源的云盘前端照常用 Cookie（CORS 中间件不影响同源请求）
#   这样"允许跨域读取"和"不泄漏凭据"两件事就分开了。
#
# ★ 白名单模式下的来源回显 ★
#   配了显式白名单时，CORSMiddleware 会回显命中的那个来源（而不是 "*"），
#   这同样是规范要求：多个来源时不能统一回 "*"，否则浏览器拒收。
_cors = parse_cors_origins(settings.cors_origins)
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
        # 允许的自定义头：Authorization 是跨域调用的鉴权主路径；
        # Content-Type 上传/表单要用；* 部分旧浏览器不支持，显式列出更稳。
        allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
        # ★ 让 JS 能读到这些响应头 ★
        #   Content-Disposition 里有文件名，前端下载时要用它命名；
        #   不 expose 的话跨域下 JS 一律读不到（安全默认行为）。
        expose_headers=["Content-Disposition", "Content-Length"],
        max_age=600,  # 预检结果缓存 10 分钟，少打一半 OPTIONS
    )


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------
@app.on_event("startup")
def _startup() -> None:
    users.init_db()
    shares.init_db()
    print("=" * 64, file=sys.stderr)
    print(f"[nebula] {settings.title} 启动", file=sys.stderr)
    print(f"[nebula] 映射目录 {len(settings.mounts)} 个:", file=sys.stderr)
    for m in settings.mounts:
        flag = "OK " if m.exists else "缺失"
        who = "*" if m.public else ",".join(sorted(m.users))
        print(f"[nebula]   [{flag}] {m.label} -> {m.path}  可见: {who}", file=sys.stderr)
    print(f"[nebula] OnlyOffice: {settings.oo_url or '未配置'}", file=sys.stderr)
    print(f"[nebula] kkFileView: {settings.preview_url}", file=sys.stderr)
    print(f"[nebula] CORS: {', '.join(_cors) if _cors else '未开启（仅同源）'}",
          file=sys.stderr)
    print("=" * 64, file=sys.stderr)


# ---------------------------------------------------------------------------
# 统一异常
# ---------------------------------------------------------------------------
# 项目里有两种错误来源，历史上返回体格式不一致：
#   · FileError      → {"error": "..."}     （业务层，由下面第一个处理器处理）
#   · HTTPException  → {"detail": "..."}    （FastAPI 默认处理器）
#   · 参数校验失败    → {"detail": [ {...} ]}（FastAPI 默认处理器）
#
# 实测影响（2026-09-22，思源插件对接时发现）：
#   调用方（含插件、分享页、第三方脚本）要同时兼容 error / detail / 数组三种
#   形态才能正确显示错误，否则用户只看到一句无意义的兜底文案。
#   实测踩过：缺参数时抛出的是 FastAPI 的 422，detail 是一个**对象数组**，
#   看起来完全不像"缺了个参数"，排查成本很高。
#
# 这里统一成 {"error": "..."}。注意**不能**改变状态码 ——
#   分享页与插件都按状态码做分支（404/403/401），只统一正文形态。
# 数组型 detail（校验错误）会拍平成人类可读的一句话。
# ---------------------------------------------------------------------------
@app.exception_handler(files.FileError)
async def _file_error_handler(request: Request, exc: files.FileError):
    return JSONResponse({"error": exc.message}, status_code=exc.code)


@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException):
    """把 FastAPI 的 HTTPException 也统一成 {"error": ...}。

    ★ 同时保留 "detail" 字段 ★
      前端（web/js/api.js）读的是 `data.error || data.detail || data.message`，
      第三方调用方可能只认 detail。两个键都给，谁也不破坏。
    """
    msg = exc.detail
    if isinstance(msg, list):
        # 校验错误的 detail 形如
        #   [{"type":"missing","loc":["query","mount"],"msg":"Field required"}]
        # 翻译成人看得懂的一句话，比原样透出好得多。
        parts = []
        for item in msg:
            if isinstance(item, dict):
                loc = item.get("loc") or []
                field = loc[-1] if loc else "参数"
                parts.append(f"{field}: {item.get('msg', '无效')}")
            else:
                parts.append(str(item))
        msg = "；".join(parts) or "请求参数不正确"
    return JSONResponse(
        {"error": str(msg), "detail": str(msg)}, status_code=exc.status_code
    )


# ---------------------------------------------------------------------------
# 路由注册
#
# ★ 顺序即匹配优先级，必须与重构前 main.py 里的定义顺序一致 ★
#   通配路径（/preview/{rest:path}、/website/{rest:path}、/cad/{rest:path}）
#   注册在哪一组里，决定了它们会不会吞掉后面的具体路径。
# ---------------------------------------------------------------------------
for _r in (auth_routes, users_routes, fileops_routes, rawlink_routes,
           onlyoffice_routes, preview_routes, cad_routes,
           shares_admin_routes, share_guest_routes, pages_routes):
    app.include_router(_r.router)


# ---------------------------------------------------------------------------
# 静态资源（前端 SPA 就在 web/ 下，没有构建步骤）
# ---------------------------------------------------------------------------
if WEB_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")
