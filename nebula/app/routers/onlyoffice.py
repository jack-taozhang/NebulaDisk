"""OnlyOffice 编辑器配置 / 保存回调 + 各引擎健康检查 + **OnlyOffice 同源反代**"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlencode, urlsplit

import httpx
import websockets

from fastapi import APIRouter, Depends, Form, HTTPException, Request, WebSocket
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from .. import auth, files, integrations, users
from ..config import settings
from ..webutil import _origin, _internal_origin, _mount, make_raw_url


router = APIRouter()

@router.post("/api/oo/config")
async def api_oo_config(
    request: Request,
    mount: str = Form(""), path: str = Form(""),
    embed: str = Form(""),
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
    cb_base = settings.oo_callback_url or _internal_origin()
    cb = f"{cb_base}/api/oo/callback?" + urlencode({"mount": mount, "path": path})

    # ★ embed=1 ⇒ 嵌入块精简版：签名**之前**隐藏顶部工具栏/侧栏（2026-09-24）★
    #   插件嵌入块一直传 embed=1，但此前后端没有这个形参、直接忽略，
    #   导致嵌入块里 OO 工具栏收不掉。前端改 config 会让 JWT 签名失效，
    #   所以只能在签名前做（见 integrations.build_editor_config）。
    want_embed = str(embed).strip().lower() in ("1", "true", "yes", "on")

    # ★★ 编辑器布局一律用 `desktop`（2026-10-03 实测后回退 mobile）★★
    #
    #  试过按 UA 给移动端传 `type="mobile"`，**结果是更早就失败**，原因：
    #  OO 的 mobile 版是**给官方移动 App 的 webview 专用**的 ——
    #    · `apps/spreadsheeteditor/mobile/index.html` 里用
    #      `window.native?.editorConfig?.theme?.type` 读**宿主 App 注入的原生桥**；
    #    · 手机上加载它时只请求了 index.html(3.7KB) + 一张光标图，
    #      **`dist/js/app.js`(1.8MB) 这条 `<script defer>` 压根没被请求**，
    #      1 秒后 OO 就报 -4；而 desktop 版能走到加载完 378 个 UI 资源那一步。
    #  ⇒ 第三方 webview（飞牛 App）里必须用桌面版。
    #
    #  留一个环境变量是为了以后真要试时不用再改代码/重新走一轮部署。
    editor_type = (os.environ.get("NEBULA_OO_EDITOR_TYPE") or "desktop").strip().lower()
    if editor_type not in ("desktop", "mobile"):
        editor_type = "desktop"

    cfg = integrations.build_editor_config(
        file_key=integrations.file_key(mount, path, int(st.st_mtime), st.st_size),
        title=p.name,
        doc_url=doc_url,
        callback_url=cb,
        mode=mode,
        user_id=user["username"],
        user_name=user["username"],
        embed=want_embed,
        editor_type=editor_type,
    )

    users.audit(user["username"], "oo_open", f"{mount}:{path}", mode)

    return {
        "ok": True,
        "config": cfg,
        # 浏览器要加载的 api.js 地址。
        # ★ 同源：oo_public 留空 ⇒ oo_public_base() 回退到 request_origin，
        #   于是这里是 {当前访问源}/web-apps/...，由下面的反代承接。
        "apiJs": f"{integrations.oo_public_base(_origin(request))}/web-apps/apps/api/documents/api.js",
        "mode": mode,
        "title": p.name,
        # 排查用：一眼看出本次给移动端还是桌面端布局
        "editorType": editor_type,
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
# ★★ OnlyOffice 同源反代（HTTP + WebSocket）★★
# ===========================================================================
#
# 为什么要做（2026-10-03）
# ---------------------------------------------------------------------------
# 浏览器加载的 api.js 地址是 `{oo_public}/web-apps/apps/api/documents/api.js`，
# 而 `oo_public` 是个**绝对地址**（部署时写死成 http://<某个具体IP>:8082）。后果：
#   · 客户端只要不是从那个地址访问 NAS，就加载不到
#     ⇒ 报「**无法加载 OO 接口脚本**」；
#   · 手机走 https://fnos.net/...（FN Connect）时页面是 HTTPS、而它是 HTTP
#     ⇒ 再叠一层**混合内容拦截**，必挂。
#
# 对照：`/preview`（kkFileView）与 `/cad`（cad-viewer）**早就**反代到自己名下了
# （`NEBULA_PREVIEW_PUBLIC="/preview"` 是相对路径）。**OnlyOffice 是唯一漏掉的。**
#
# ★ 为什么必须挂在**根路径**上，而不是 /oo-static 这种子路径 ★
#   OO 在 HTML/JS 内部大量使用**根级绝对路径**（/web-apps/...、/sdkjs/...），
#   编辑器页打开协作用 WebSocket 时也是连 `ws://<编辑器页所在源>/doc/<key>/c/...`。
#   挂在子路径下要么得改 HTML（脆），要么 WS 连不上。挂在根路径 ⇒ 天然命中。
#   代价是网盘根命名空间多出几个前缀 —— 都取了 OO 特有的名字，不会撞网盘自己的路由。
#
# ★ 为什么必须自己写 WebSocket 转发 ★
#   OO 编辑器**没有 WS 就起不来**。httpx 是纯 HTTP，转发不了 WS；
#   而本应用的 uvicorn 原生支持 WS，`websockets` 库也在镜像里（实测 17.1）。
#
# 配好之后：把 `oo_public` 设为**空**（设置页里清掉即可）。
# 于是 `oo_public_base()` 回退到 `request_origin` ⇒ api.js 变成
# `{当前访问源}/web-apps/...` —— 同源、跟着访问地址走，HTTP/HTTPS 都成立。
# ⚠️ 这还需要配合修 integrations.oo_public_base() 的回退次序（见那个函数）。
# ===========================================================================

# 这些响应头会让反代失效、或让 iframe 被拦，必须剥掉
#
# ★ 2026-10-03 重大修正：**不能再剥掉 content-encoding / content-length** ★
#   原来是 `content=r.content`（httpx 已解压）+ 剥掉这两个头 ⇒ 浏览器拿到的是
#   **未压缩**的裸字节。实测 OO 的编辑器资源：
#       sdkjs/word/sdk-all.js       直连 gzip ~5MB   → 经反代 **28.8MB 裸传**
#       sdkjs/word/sdk-all-min.js   直连 gzip 644KB  → 经反代 **3.5MB 裸传**
#   整套编辑器资源从 ~8MB 膨胀到 40MB+ ⇒ 跨 ZeroTier 直接超时，OO 弹
#       「The connection is too slow, some of the components could not be loaded」
#   ⇒ 现在改成**流式 + 原样透传压缩字节**（见下面 _oo_proxy_http），
#     所以这两个头必须**保留**。
_OO_STRIP_HEADERS = frozenset({
    "transfer-encoding", "connection",
    "x-frame-options", "content-security-policy",
})

# 转发给 OnlyOffice 的请求头
# ★ accept-encoding 一定要转发 ★
#   不转发的话 httpx 会塞自己的 `gzip, deflate, br, zstd`：
#     · 我们用 aiter_raw() 透传原始字节 ⇒ 客户端没要 gzip 也会收到 gzip，坏客户端；
#     · 转发之后由**浏览器和 OO 自己协商**，语义才正确。
#   （缺省时 `_oo_proxy_http` 会补 `identity`。）
_OO_FWD_HEADERS = (
    "accept", "accept-language", "accept-encoding", "content-type", "range",
    "user-agent", "cookie",
)

# OO 浏览器侧会用到的顶层路径。
# ★ 只列 OO 特有的名字，避免吞掉网盘自己的路由 ★
_OO_PREFIXES = (
    "web-apps", "sdkjs", "sdkjs-plugins", "fonts", "themes", "cache",
    "coauthoring", "doc", "downloadas", "internalapi", "hosting",
    "integration", "spellchecker",
)


def _oo_base() -> str:
    """OnlyOffice 的容器内地址（如 http://onlyoffice:80）。"""
    return (settings.oo_url or "").rstrip("/")


# ★★ 复用同一个 httpx 客户端（2026-10-03 性能修复）★★
#
# 病症：编辑器能打开但**非常慢**，WSL 和 NAS 一样慢（所以不是网络问题）。
# 实测（15 个小文件，顺序 keep-alive）：
#     经反代 0.486s   vs   直连 OO 0.013s   ⇒ 慢 37 倍
#   而大文件（sdk-all.js 4.7MB gzip）只慢 21ms ⇒ 是**每请求固定开销**，不是带宽。
#
# 根因：原来每处理一个请求就 `httpx.AsyncClient(...)` 新建一个客户端，
#   ⇒ 每次都要重新做 **DNS 解析（onlyoffice）+ 建 TCP 连接**，
#   在 Docker 里那套嵌入式 DNS 上约 30ms/次。
#   OO 编辑器冷启动要发 **200~300 个请求** ⇒ 光这层就白烧 8 秒以上。
#
# 修法：模块级单例 + keep-alive 连接池。**不要**在请求结束时关掉它。
_OO_CLIENT: httpx.AsyncClient | None = None


def _oo_client() -> httpx.AsyncClient:
    global _OO_CLIENT
    if _OO_CLIENT is None:
        _OO_CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(120.0),
            follow_redirects=False,
            limits=httpx.Limits(
                max_connections=64,
                max_keepalive_connections=32,
                keepalive_expiry=60.0,
            ),
        )
    return _OO_CLIENT


# ★★ 给「不可变资源」加一层服务端缓存（2026-10-03 性能修复之二）★★
#
# 背景：OO 编辑器冷启动要发 **200~300 个请求**（sdk-all.js 就有 4.7MB gzip）。
#   只靠浏览器缓存不够 —— 换设备 / 换浏览器 / 缓存被清 / 隐私模式，全都要重搬一遍，
#   跨 ZeroTier 就非常慢。这一层让"第二个人、第二次、任何设备"都能秒开。
#
# 为什么**可以安全缓存**：OO 给带版本前缀的路径（/9.4.0-<build hash>/…）发的头是
#     `Cache-Control: public, max-age=31536000, immutable`
#   —— 路径里已经烧进了构建哈希，内容永不改变。**只缓存带 immutable 的响应**，
#   其余（/doc/、/cache/files/、api/oo/… 这类动态内容）一律不缓存。
#
# 容量：单条上限 12MB、总量上限 64MB，LRU 淘汰。（sdk-all.js 约 4.7MB，装得下。）
import re as _re
from collections import OrderedDict as _OrderedDict

_OO_CACHE: "_OrderedDict[str, tuple[bytes, dict]]" = _OrderedDict()
_OO_CACHE_BYTES = 0
_OO_CACHE_MAX_BYTES = 64 * 1024 * 1024
_OO_CACHE_ITEM_MAX = 12 * 1024 * 1024
_OO_CACHEABLE_RE = _re.compile(r"immutable", _re.I)


def _oo_cache_put(key: str, body: bytes, headers: dict) -> None:
    global _OO_CACHE_BYTES
    n = len(body)
    if n > _OO_CACHE_ITEM_MAX or n == 0:
        return
    old = _OO_CACHE.pop(key, None)
    if old is not None:
        _OO_CACHE_BYTES -= len(old[0])
    _OO_CACHE[key] = (body, headers)
    _OO_CACHE_BYTES += n
    while _OO_CACHE_BYTES > _OO_CACHE_MAX_BYTES and _OO_CACHE:
        _, (b, _h) = _OO_CACHE.popitem(last=False)
        _OO_CACHE_BYTES -= len(b)


async def _oo_proxy_http(prefix: str, rest: str, request: Request):
    """把 /<prefix>/* 反代到 OnlyOffice（HTTP 部分）。"""
    base = _oo_base()
    if not base:
        return HTMLResponse(
            "<h3>OnlyOffice 未配置</h3>"
            "<p>请设置 NEBULA_OO_URL（容器内地址，如 http://onlyoffice:80）</p>",
            status_code=503,
        )

    target = f"{base}/{prefix}/{rest}" if rest else f"{base}/{prefix}/"
    if not prefix:
        # /oo-ver/<原始带版本前缀的路径> ⇒ 原样转给 OO（不做任何删改）
        target = f"{base}/{rest}" if rest else f"{base}/"
    if request.url.query:
        target += f"?{request.url.query}"

    fwd: dict[str, str] = {}
    for k in _OO_FWD_HEADERS:
        v = request.headers.get(k)
        if v:
            fwd[k] = v
    # 客户端没带 accept-encoding 时显式声明 identity：
    # 这样"透传原始字节"才不会把 gzip 塞给不接受它的客户端。
    fwd.setdefault("accept-encoding", "identity")

    # ★★ 必须把「浏览器看到的 Host / 协议」透传给 OO（2026-10-03 实测）★★
    #
    # 症状：编辑器界面都出来了，却弹「错误 / 下载失败」；浏览器控制台里是
    #     net::ERR_FAILED [XHR]
    #     http://onlyoffice/cache/files/data/<key>/Editor.bin/Editor.bin?md5=...
    #   —— 浏览器在向 **OO 容器的内部主机名**要 Editor.bin，当然解析不了。
    #
    # 根因：转发时 httpx 会按目标 URL 自动把 Host 写成 `onlyoffice`，
    #   OO 于是拿这个 Host 去拼**绝对 URL**（文档二进制、保存回调、静态资源），
    #   浏览器拿到的就是 `http://onlyoffice/...` ⇒ 必挂。
    #
    # 为什么"直连 8082"时没事：那时 Host 本来就是 `<主机>:8082`，OO 拼出来的
    #   绝对 URL 浏览器能解析 ⇒ 所以这个坑**只在走反代时出现**。
    #
    # 修法：把原始的 Host 一起转发（并补上 X-Forwarded-*）⇒ OO 拼出来的
    #   绝对 URL 指回我们自己的源（`/cache/...` 本来就在代理前缀表里）⇒ 通。
    #   这也是 OO 官方反代文档要求的 `proxy_set_header Host $host;` 那一条。
    orig_host = request.headers.get("host") or ""
    if orig_host:
        fwd["host"] = orig_host
        fwd["x-forwarded-host"] = orig_host
    fwd["x-forwarded-proto"] = request.url.scheme

    # ★ 服务端缓存命中就直接回（只对无 Range 的 GET）★
    cache_key = None
    if request.method == "GET" and not fwd.get("range"):
        cache_key = target
        hit = _OO_CACHE.get(cache_key)
        if hit is not None:
            _OO_CACHE.move_to_end(cache_key)
            data, hdrs = hit
            hdrs = dict(hdrs)
            # 诊断头：让"有没有命中"变成肉眼可见的，不用靠计时猜
            hdrs["x-nebula-oo-cache"] = "HIT"
            return Response(
                content=data, status_code=200, headers=hdrs,
                media_type=hdrs.get("content-type"),
            )

    body = await request.body()

    # ★ 必须 stream=True + aiter_raw() ★
    #   `cli.request(...)` 默认会把整个响应读进内存并**自动解压**；
    #   我们要的是"原样转发 OO 吐出来的压缩字节"，所以：
    #     · send(..., stream=True) 不预读
    #     · aiter_raw() 拿到的是**未解码**的原始分块
    #   配合保留 content-encoding / content-length ⇒ 浏览器自己解压。
    #   收益实测：编辑器资源 40MB+ → ~8MB（sdk-all.js 28.8MB → 约 5MB）。
    # 复用长连接客户端（见 _oo_client 的注释：每请求新建 = 每请求重做 DNS+TCP）
    cli = _oo_client()
    try:
        req = cli.build_request(request.method, target, headers=fwd, content=body or None)
        r = await cli.send(req, stream=True)
    except httpx.HTTPError as e:
        return HTMLResponse(
            f"<h3>OnlyOffice 不可达</h3><p>{type(e).__name__}: {e}</p><p>目标: {target}</p>",
            status_code=502,
        )

    out_headers = {k: v for k, v in r.headers.items() if k.lower() not in _OO_STRIP_HEADERS}

    # ★ 302 的 Location 可能指向根级路径 ★
    #   OO 的文档服务器会把 index.html 重定向到 index_loader.html 之类。
    #   如果它给的是根级绝对路径，而我们挂在根路径上 ⇒ 本来就对得上，无需改写。
    #   但若给的是带自身前缀的路径，也要保证仍然落在我们的前缀下。
    #   这里做一次保守兜底：只把"指向 OO 自己的绝对 URL"换回相对。
    for hk in ("location", "Location"):
        if hk in out_headers:
            loc = out_headers[hk]
            try:
                sp = urlsplit(loc)
                if sp.scheme and sp.netloc:
                    out_headers[hk] = sp.path + (f"?{sp.query}" if sp.query else "")
            except ValueError:
                pass
            break

    # 只缓存"真正不可变"的响应（带 immutable 的静态资源）；动态内容一律不缓存
    do_cache = bool(cache_key) and r.status_code == 200 and bool(
        _OO_CACHEABLE_RE.search(r.headers.get("cache-control") or "")
    )
    buf = bytearray() if do_cache else None
    out_headers["x-nebula-oo-cache"] = "MISS" if do_cache else "BYPASS"

    async def _body_iter():
        """逐块透传原始字节。

        ⚠️ 只关响应，**绝不要关 `cli`** —— 它是模块级共享的长连接池，
        关掉就退回"每请求重建 DNS+TCP"，性能会立刻掉回 37 倍慢。
        """
        finished = False
        try:
            async for chunk in r.aiter_raw():
                if buf is not None:
                    buf.extend(chunk)
                yield chunk
            finished = True
        finally:
            await r.aclose()
            # ★ 只有**完整读完**才入缓存 ★
            #   客户端中途断开也会走到 finally ⇒ 不加这个标志就会把
            #   半截的 JS 缓存下来，之后所有人拿到损坏的文件、还很难查。
            if buf is not None and finished:
                _oo_cache_put(cache_key, bytes(buf), out_headers)

    return StreamingResponse(
        _body_iter(),
        status_code=r.status_code,
        headers=out_headers,
        media_type=r.headers.get("content-type"),
    )


async def _oo_proxy_ws(prefix: str, rest: str, websocket: WebSocket):
    """把 /<prefix>/* 的 WebSocket 反代到 OnlyOffice。

    OO 编辑器打开文档后会连 `ws://<源>/doc/<key>/c/<session>`；
    没有这条通道，编辑器页面能起来但**连不上、等于打不开**。
    """
    base = _oo_base()
    if not base:
        await websocket.close(code=1011, reason="OnlyOffice 未配置")
        return

    # http(s)://host:port → ws(s)://host:port
    sp = urlsplit(base)
    ws_scheme = "wss" if sp.scheme == "https" else "ws"
    ws_base = f"{ws_scheme}://{sp.netloc}"

    query = websocket.url.query
    target = f"{ws_base}/{prefix}/{rest}" if prefix else f"{ws_base}/{rest}"
    if query:
        target += f"?{query}"

    # 子协议要透传：OO 会带 sec-websocket-protocol
    subprotocols = [
        p.strip()
        for p in (websocket.headers.get("sec-websocket-protocol") or "").split(",")
        if p.strip()
    ]

    # ★ WS 这一腿同样要带原始 Host ★
    #   OO 的协作会话（socket.io 的 open 包）里也会给出文档二进制的绝对地址；
    #   不带 Host 一样会拼成 `http://onlyoffice/...` ⇒ 浏览器取不到 Editor.bin。
    ws_host = websocket.headers.get("host") or ""
    extra: dict[str, str] = {
        "X-Forwarded-Proto": "https" if websocket.url.scheme == "https" else "http",
    }
    if ws_host:
        extra["Host"] = ws_host
        extra["X-Forwarded-Host"] = ws_host

    conn_kw = dict(
        subprotocols=subprotocols or None,
        max_size=None,          # OO 会发大帧（文档快照），不设上限
        ping_interval=None,     # 心跳交给 OO 自己，别让客户端库插一脚
        open_timeout=20,
    )

    # 头参数名在 websockets 13 前后改过（extra_headers → additional_headers），
    # 两个镜像的版本不一定一样 ⇒ 用工厂函数兜一下，别写死。
    def _connect():
        try:
            return websockets.connect(target, additional_headers=extra, **conn_kw)
        except TypeError:
            return websockets.connect(target, extra_headers=extra, **conn_kw)

    await websocket.accept(subprotocol=subprotocols[0] if subprotocols else None)

    try:
        async with _connect() as up:
            import asyncio

            async def c2s():
                try:
                    while True:
                        msg = await websocket.receive()
                        t = msg.get("type")
                        if t == "websocket.disconnect":
                            break
                        if msg.get("text") is not None:
                            await up.send(msg["text"])
                        elif msg.get("bytes") is not None:
                            await up.send(msg["bytes"])
                except Exception:
                    pass

            async def s2c():
                try:
                    async for m in up:
                        if isinstance(m, bytes):
                            await websocket.send_bytes(m)
                        else:
                            await websocket.send_text(m)
                except Exception:
                    pass

            t1 = asyncio.create_task(c2s())
            t2 = asyncio.create_task(s2c())
            _, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception as e:  # noqa: BLE001
        print(f"[onlyoffice] WS 反代失败 {target}: {type(e).__name__}: {e}", file=sys.stderr)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 注册：每个 OO 顶层前缀都同时挂 HTTP 与 WebSocket
# ---------------------------------------------------------------------------
def _mk_http(prefix: str):
    async def _h(rest: str, request: Request):
        return await _oo_proxy_http(prefix, rest, request)

    _h.__name__ = f"oo_http_{prefix.replace('-', '_')}"
    return _h


def _mk_ws(prefix: str):
    """构造某个前缀的 WebSocket 处理器。

    ★ 为什么 rest 要从 path_params 里取，而不是写成形参 ★
      2026-10-03 实测踩到：写成 `_w(websocket: WebSocket, rest: str)` 时，
      FastAPI 的 `add_websocket_route` 会走**依赖注入**（不像 Starlette 的
      `websocket_route` 那样把路径参数直接塞进形参），于是报
          TypeError: _w() missing 1 required positional argument: 'rest'
      → 握手阶段直接 500。
      HTTP 那边（add_api_route）没这个问题，路径参数能正常注入。
    """

    async def _w(websocket: WebSocket):
        rest = (websocket.path_params or {}).get("rest", "")
        await _oo_proxy_ws(prefix, rest, websocket)

    _w.__name__ = f"oo_ws_{prefix.replace('-', '_')}"
    return _w


for _p in _OO_PREFIXES:
    router.add_api_route(
        f"/{_p}/{{rest:path}}",
        _mk_http(_p),
        methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
        include_in_schema=False,
    )
    router.add_websocket_route(f"/{_p}/{{rest:path}}", _mk_ws(_p))


# ---------------------------------------------------------------------------
# ★ 版本前缀入口（空前缀 ⇒ 原样转发）★
#
#   OO 会把静态资源 302 到 `/<版本号-构建哈希>/web-apps/…` 这种带前缀的地址，
#   而那个地址在 OO 自己的 URL 空间里是**真实有效**的（实测 api.js → 200）。
#   main.py 的中间件把这种路径改写成 `/oo-ver/<原路径>`，这里原样转给 OO。
#
#   ⚠️ 中间件只能「改写」，不能「删掉」前缀 —— 删掉会让
#      /web-apps/x → 302 到 /<ver>/web-apps/x → 又被删成 /web-apps/x
#      变成**重定向死循环**。
# ---------------------------------------------------------------------------
router.add_api_route(
    "/oo-ver/{rest:path}",
    _mk_http(""),
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
router.add_websocket_route("/oo-ver/{rest:path}", _mk_ws(""))


# ===========================================================================
# kkFileView 预览
# ===========================================================================
