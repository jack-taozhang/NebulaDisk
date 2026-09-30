"""分享的**访客侧**：落地页、解锁、列表、取流、预览（全程无登录态）"""

from __future__ import annotations

import hashlib
import hmac
import time
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlencode, urlsplit

from fastapi import APIRouter, Form, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from .. import files, integrations, shares, users, zipstream
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
    p, sub, full = _resolve_in_share(m, sh, path)

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


def _resolve_in_share(m, sh: shares.Share, path: str) -> tuple[Path, str]:
    """把「分享内的相对子路径」解析成真实路径，并确认它没越出分享根。

    ★ 为什么把这一步收成公共函数 ★
      list / raw / preview 三个取数入口都要做同一件事：
        拼相对路径 → resolve() → 断言仍在分享根之下。
      这是一条**安全边界**（`../` 逃逸分享范围），三处各抄一遍迟早会漂移
      —— 而漂移的那一份就是漏洞。规则只留一条，改也只改这里。

    返回 (真实路径, 规范化后的子路径, 拼好的完整相对路径)。
    子路径用于分享内的签名与显示，必须是 lstrip('/') 之后的相对形式
    （签名里带它，写歪了签名就对不上）；完整相对路径给 files 层用。
    """
    base = sh.path
    sub = (path or "").strip().lstrip("/")
    full = base if not sub else (base.rstrip("/") + "/" + sub)
    p = files.resolve(m, full)
    if not _inside_share(m, p, sh):
        raise HTTPException(403, "越出分享范围")
    return p, sub, full


@router.get("/api/s/{token}/raw")
async def api_share_raw(token: str, request: Request, path: str = "", download: bool = False):
    """访客取流（预览 / 下载）。"""
    sh = _load_live_share(token)
    if not _share_unlocked(request, token):
        raise HTTPException(403, "需要提取码")

    m = _mount_for_share(sh)
    p, _sub, _full = _resolve_in_share(m, sh, path)
    if p.is_dir():
        raise HTTPException(400, "目录不能直接下载")

    if not sh.is_dir:
        # 单文件分享：第一次取流算一次访问
        shares.bump_visit(token)
    return _stream_file(p, download=download)


@router.get("/api/s/{token}/zip")
async def api_share_zip(
    token: str,
    request: Request,                         # _share_unlocked 要读 Cookie
    path: str = "",
    item: list[str] = Query(default=[]),      # noqa: B008 —— FastAPI 的写法
):
    """访客**打包下载**：把当前文件夹、或访客**勾选的那几项**打成 ZIP 流式发出去。

    ★ 两种语义（由 item 是否为空区分）★
      · 不带 item            → 打**当前所在的那一层**，包内套一层同名目录
                               （否则解压出来一堆散文件，直接糊在用户当前目录里）。
      · 带 item（可重复多个） → 只打**勾选的那几项**，且直接落在包**根**：
                               用户点的是"这几项"，解压出来就该正好是这几项。

    ★ 为什么要有「选择集」（2026-09-30 用户追加需求）★
      用户原话：「应该可以 根据 选择 然后打包下载」。
      只给"整目录打包"是不够的 —— 常见的诉求是"这一个目录里我只要这几个文件"。
      逐个文件单独下会得到一堆散包，整目录打包又太重。

    ★ 越权边界与 list / raw / preview **完全同源** ★
      每个勾选项都过一遍同一个 _resolve_in_share()：
      拼到当前子路径后面 → resolve() → 断言仍在分享根之下。
      另外先挡掉名字里带 `/` 或 `..` 的项（正常前端不会发，但接口是公开的）。

    ★ 为什么流式、为什么先预检 ★ 见 app/zipstream.py 的模块头。
    """
    sh = _load_live_share(token)
    if not _share_unlocked(request, token):
        raise HTTPException(403, "需要提取码")

    m = _mount_for_share(sh)
    p, sub, _full = _resolve_in_share(m, sh, path)

    # ---- 决定"打什么" ----------------------------------------------------
    if item:
        if not p.is_dir():
            raise HTTPException(400, "只有文件夹才能按选择打包")
        picked: list[tuple[Path, str]] = []
        seen: set[str] = set()
        for raw_name in item:
            name = (raw_name or "").strip().replace("\\", "/")
            # ★ 选择项只能是"当前目录下的一个名字" ★
            #   带 / 或 .. 的一律拒 —— 真正的边界由 _resolve_in_share 兜底，
            #   这里先挡是为了让报错**可读**（否则访客只会看到一个 403）。
            if not name or "/" in name or name in (".", "..") or "\x00" in name:
                raise HTTPException(400, "非法的选择项")
            if name in seen:
                continue
            seen.add(name)
            rel = f"{sub}/{name}" if sub else name
            ip, _s, _f = _resolve_in_share(m, sh, rel)
            picked.append((ip, name))
        if not picked:
            raise HTTPException(400, "没有选中任何项")
        plan = zipstream.plan_items(picked)
        n_sel = len(picked)
    else:
        if not p.is_dir():
            raise HTTPException(400, "只有文件夹才能打包下载")
        n_sel = 0
        # ★ 包里套一层同名目录 ★（见 docstring）
        plan = zipstream.plan_dir(p, p.name or "share")

    # ★ 先把计划走一遍再决定发不发 ★
    #   响应头一旦发出去就收不回 —— 发到一半才发现超限，
    #   只能在半个 ZIP 后面接一段错误文本，用户拿到的是**打不开的坏包**，
    #   而且看不出为什么。所以超限必须在**发第一个字节之前**判掉。
    try:
        n, total = zipstream.total_of(plan)
    except zipstream.ZipLimitExceeded as e:
        raise HTTPException(413, str(e)) from e

    # 包名：整目录 → 目录名；勾一项 → 那一项的名字；勾多项 → 目录名-选中N项
    if n_sel == 1:
        base_name = item[0]
    elif n_sel > 1:
        base_name = f"{p.name or 'share'}-选中{n_sel}项"
    else:
        base_name = p.name or "share"
    headers = {
        "Content-Disposition":
            f"attachment; filename*=UTF-8''{quote(base_name)}.zip",
        "Cache-Control": "private, max-age=0, no-cache",
        # 让浏览器/代理知道这是可能很大的流，不要试图整体缓冲
        "X-Nebula-Zip-Entries": str(n),
        "X-Nebula-Zip-Bytes": str(total),
        "X-Nebula-Zip-Selected": str(n_sel),
    }
    users.audit("guest", "share-zip", token[:12],
                f"{sub or '/'} {'选中%d项' % n_sel if n_sel else '整目录'} ({n} 文件)")
    return StreamingResponse(
        zipstream.iter_zip(plan),
        media_type="application/zip",
        headers=headers,
    )


@router.get("/api/s/{token}/preview")
async def api_share_preview(token: str, request: Request, path: str = ""):
    """访客预览地址 —— 路由规则与**网盘完全一致**（cad / onlyoffice / kkfileview）。

    ★★ 为什么必须一致（2026-09-30 用户报障）★★
      用户原话：「/s/页面上的预览路由和网盘的路由不一致，需要调整为一样」。
      网盘的预览是 web/js/viewer.js 的 open()，优先级：
          cad → onlyoffice → 原生(图片/视频/音频/文本) → kkfileview → 下载
      而本接口原来**只认 onlyoffice**，其余一律丢给 kkFileView
      ⇒ 同一个 DWG：网盘里由 cad-viewer（WASM）渲染，分享页却被 kkFileView 打开。
      这里补上 cad 分支；原生类型（图片/视频/音频/文本）不入库，
      由前端直接取 /api/s/<token>/raw —— 与网盘「原生优先、零转换」同一条腿。

    ★ 三方一致性由静态闸门守着 ★
      tools/check_preview_route_parity.py 会比对
      config.route_of() / web/js/viewer.js / web/js/share.js 三处的引擎优先级。
      route_of 的返回词表就是本接口的契约：cad / onlyoffice / kkfileview / download。
    """
    sh = _load_live_share(token)
    if not _share_unlocked(request, token):
        raise HTTPException(403, "需要提取码")

    m = _mount_for_share(sh)
    p, sub, _full = _resolve_in_share(m, sh, path)
    if p.is_dir():
        raise HTTPException(400, "目录不支持预览")

    # ★ 预览通道的鉴权走 make_share_raw_url（签名里带 token，短期有效）★
    #   不能复用登录态的 make_raw_url —— 那是给登录用户签的，
    #   而访客没有会话，签名里必须体现"是这条分享"。
    raw = make_share_raw_url(sh, sub, ttl=3600)
    route = route_of(p.name)

    # ① CAD 图纸 → cad-viewer 深链（与网盘 /api/cad/preview 同一条腿）
    if route == "cad" and settings.cad_enabled:
        public_raw = _browser_reachable_url(raw, request)
        q = urlencode({"open": public_raw, "name": p.name})
        inner = f"/cad/?{q}"
        # ★ 与网盘一样，再包一层 /lite 外壳 ⇒「页面嵌入块」形态 ★
        #   直接给 /cad/ 是**一整台 CAD 程序**（功能区/右侧工具条/命令行/状态栏），
        #   分享页的读者多半在手机或微信里，那套 UI 既点不准又占地方。
        #   —— 这正是思源插件嵌入块早就解决过的问题，复用同一个外壳页。
        return {"ok": True, "route": "cad",
                "url": integrations.lite_shell_url("cad", inner, p.name),
                "inner": inner, "raw": public_raw}

    # ② Office / PDF → OnlyOffice（访客一律只读）
    if route == "onlyoffice" and settings.oo_enabled:
        st = p.stat()
        cb_base = settings.oo_callback_url or _internal_origin()
        cb = f"{cb_base}/api/s/{sh.token}/oo-callback?" + urlencode({"path": sub})
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

    # ③ 其余交给 kkFileView（只读预览）
    if route == "kkfileview":
        inner = integrations.kk_preview_url("", raw)
        return {"ok": True, "route": "kkfileview",
                "url": f"{settings.preview_public}{inner}", "raw": raw}

    # ④ 没有任何在线预览能力 → 只给下载出口。
    #    ★ 与网盘 viewer.js 的「⑤ 兜底：询问是否下载」一一对应 ★
    #      以前这里不管三七二十一都回一个 kkFileView 地址（连 .exe 也回），
    #      前端拿到地址就去 iframe，结果 kk 报一堆"不支持"的错误页，
    #      而网盘是干脆给「下载」按钮 —— 同一份文件两种表现。
    return {"ok": True, "route": "download", "raw": raw}


def _browser_reachable_url(raw: str, request: Request) -> str:
    """把签名直链的 host 换成**浏览器可达**的地址（路径与查询串原样保留）。

    ★ 为什么必须换 ★
      make_share_raw_url() 返回的是 _internal_origin()，即容器内地址
      （形如 http://nebula:8088/api/s/...），那是给 OnlyOffice / kkFileView
      这类「同网络容器回拉」用的，浏览器解析不了 `nebula` 这个名字。

      而 cad-viewer 的取流发生在**浏览器**里 —— 是 WASM 渲染器自己 fetch
      那个 `open=` 地址 ⇒ 必须换成 _origin(request)（浏览器眼里的本站地址）。
      这与 app/routers/cad.py 的 api_cad_preview 是同一个坑、同一套解法：
      **只保留 path + query，host 换成请求方origin**。
      签名本身与 host 无关（签的是 token + sub + exp），所以换 host 不影响校验。
    """
    parts = urlsplit(raw)
    out = f"{_origin(request)}{parts.path}"
    if parts.query:
        out += f"?{parts.query}"
    return out


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
