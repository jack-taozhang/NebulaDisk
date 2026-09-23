"""kkFileView 同源反代（/preview/*），绕开 iframe 跨域"""

from __future__ import annotations

import re

import httpx

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from .. import auth, files, integrations
from ..config import settings
from ..webutil import _origin, _internal_origin, _mount, make_raw_url


router = APIRouter()

# 判「假值」的取值集合（与 rawlink.py 的 _DL_FALSE_VALUES 保持一致）
_DL_FALSE_VALUES = {"", "0", "false", "off", "no", "n"}


def _truthy(v) -> bool:
    return str(v).strip().lower() not in _DL_FALSE_VALUES


@router.get("/api/preview")
async def api_preview(
    mount: str = "", path: str = "", download: str = "",
    user: dict = Depends(auth.current_user),
):
    """返回 kkFileView 预览地址（同源反代路径）。

    ★ 为什么 mount/path 给默认空串而不是让 FastAPI 报 422 ★
      原先签名是 `mount: str, path: str`（必填）。调用方一旦漏参，
      FastAPI 直接回 422 + 一段机器可读的 detail 数组，前端只能看到
      「缺少字段」这种开发者向文案，用户并不知道该填什么。
      改成显式校验后，返回与其他接口统一的 {"error": "..."} 结构，
      前端一处提示逻辑就能覆盖所有失败分支，排查也直观。
    """
    if not mount:
        raise HTTPException(400, "缺少参数：mount（网盘名称）")
    if not path:
        raise HTTPException(400, "缺少参数：path（文件路径）")

    m = _mount(user["username"], mount)
    p = files.resolve(m, path)  # 校验存在性与权限
    # 目录不该走预览：kkFileView 对目录没有意义，而且会把目录当作可下载资源。
    # 这里必须显式拦掉 —— 早先漏了这个判断，目录也能拿到预览地址。
    if p.is_dir():
        raise HTTPException(400, "目录不支持预览")

    # ★ download（任务⑱，2026-09-23）★
    #   raw（签名直链）按需求分成两种：
    #     · download 假 ⇒ inline，右键菜单「复制直链」用的就是它（**打开**语义）
    #     · download 真 ⇒ attachment，预览栏「复制直链」用（**下载**语义）
    #   ★ 但上面的 url（kkFileView 预览地址）永远用 inline 版 ★
    #     它是被 iframe 内嵌去渲染文件的；一旦变成 attachment，
    #     kk 的取流会走下载分支，预览直接坏掉 —— 这是"下载"与"预览"必须分开的根因。
    want_dl = _truthy(download)
    raw_inline = make_raw_url(mount, path, ttl=3600)
    raw = make_raw_url(mount, path, ttl=3600, download=True) if want_dl else raw_inline
    # 反代走同源 /preview/，避免 iframe 跨域与 cookie 问题。
    # kk_preview_url("") 返回的是 "/onlinePreview?url=..."，前面补上反代前缀。
    inner = integrations.kk_preview_url("", raw_inline)
    return {"ok": True, "url": f"{settings.preview_public}{inner}", "raw": raw}


@router.api_route("/preview/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"])
async def proxy_preview(rest: str, request: Request):
    """把 /preview/* 反代到 kkFileView。

    为什么要自己反代而不是让前端直连 8012：
      - 同源 → iframe 不被跨域策略拦
      - 只需暴露一个端口，NAS 上防火墙规则简单
      - 可以注入 X-Base-Url，保证 kkFileView 生成的静态资源地址含正确端口

    ★ 压缩包内文件的预览（kkCompressfileKey）为什么需要单独处理 ★

    现象（用户原文）：
        「在压缩文件里面预览文件，预览不了，报错：
          The remote server refused to fulfill the request.
          (CORS request failed.)」

    根因（已在本机复现，见服务端日志）：
      compress.ftl 用 `${baseUrl}` 拼出**压缩包内成员**的地址，
      而这个地址 kkFileView 是**在服务端**去 GET 的
      （OnlinePreviewController.getCorsFile → HttpRequestUtils）：

          GET http://127.0.0.1:8089/preview/00-Q3-1250.zip_/00-Q3-1250.stp
          → Connect to http://127.0.0.1:8089 failed: Connection refused

      `${baseUrl}` 来自我们注入的 X-Base-Url，值 = 「浏览器访问源 + /preview」
      （例如 http://127.0.0.1:8089/preview）。这对**浏览器**是对的，
      但 kkFileView 是**容器内**的进程：容器里 127.0.0.1:8089 根本没人监听
      （容器内它自己是 8012，而 8089 只是宿主机映射端口）。
      于是服务端回拉自己失败 → 前端表现为 CORS / refused。

      对照实验（同一容器内）：
          http://127.0.0.1:8089/healthz  → 000 连接被拒
          http://nebula:8088/healthz     → 200 正常

    修法（两处配合）：
      1) 模板侧：compress.ftl 的 buildPreviewUrl 把「服务端回拉用的 base」
         与「浏览器加载 iframe 用的 base」拆成两个变量，
         服务端那个用占位符 __SERVER_BASE_URL__。
      2) 网关侧：本函数在渲染出的 HTML 上把 __SERVER_BASE_URL__ 替换成
         容器内可达地址（NEBULA_BASE_URL，如 http://nebula:8088/preview/）。
      X-Base-Url 仍保持「浏览器源」不变 —— 它服务于 js/css/iframe 加载。

    ★ 顺带修掉文件名含 `#` 的崩溃 ★
      原实现把 treeNode.id 原样拼进 URL，遇到 `1.2.14.TFDF-6# F向.zip`
      这种名字会抛：
          java.net.URISyntaxException: Illegal character in fragment at index 44
      `#` 在 URL 里是 fragment 起点，未编码时整条 URL 被截断。
      模板侧已改为 encodeMemberPath()（encodeURI + 补编码 # ? 空格），
      这里再对 query 里的 kkCompressfilepath / urlPath 做一次兜底编码。
    """
    raw_qs = request.url.query or ""

    # 判断是不是「压缩包成员预览」：compress.ftl 会带上 kkCompressfileKey
    is_compress_member = "kkCompressfileKey=" in raw_qs

    # 兜底编码：query 里散落的裸 `#` 转成 %23。
    # 只在压缩包成员预览时处理这两个参数，避免影响其它请求。
    if is_compress_member:
        for pname in ("kkCompressfilepath", "urlPath"):
            m = re.search(rf"({pname}=)([^&]*)", raw_qs)
            if m and "#" in m.group(2):
                fixed = m.group(1) + m.group(2).replace("#", "%23")
                raw_qs = raw_qs.replace(m.group(0), fixed)

    target = f"{settings.preview_url}/{rest}"
    if raw_qs:
        target += f"?{raw_qs}"

    fwd_headers: dict[str, str] = {}
    for k in ("accept", "accept-language", "content-type", "range", "user-agent"):
        v = request.headers.get(k)
        if v:
            fwd_headers[k] = v

    origin = _origin(request)
    # ⚠️ 必须带上端口。kkFileView 用 X-Base-Url 拼静态资源地址，
    #    丢了端口会让浏览器去 80 端口拿 js/css → 预览页白屏（服务端日志全是 200）。
    #
    # ★ 这里必须始终给「浏览器源」，不能给内网地址 ★
    #   因为这个 baseUrl 主要是给**浏览器**加载 js/css/iframe 用的。
    #   而压缩包那个「服务端回拉」的场景，由模板里的 __SERVER_BASE_URL__
    #   占位符单独处理（见下方响应体替换）—— 两者职责分开，互不干扰。
    host_raw = request.headers.get("host") or request.url.netloc

    fwd_headers["X-Base-Url"] = f"{origin}/preview"
    fwd_headers["Host"] = host_raw
    fwd_headers["X-Forwarded-Host"] = host_raw
    fwd_headers["X-Forwarded-Proto"] = "https" if origin.startswith("https") else "http"

    body = await request.body()

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0), follow_redirects=False) as cli:
            r = await cli.request(
                request.method, target, headers=fwd_headers, content=body or None,
            )
    except httpx.HTTPError as e:
        return HTMLResponse(
            f"<h3>预览服务不可达</h3><p>{type(e).__name__}: {e}</p>"
            f"<p>目标: {target}</p>",
            status_code=502,
        )

    # 逐个 header 过滤：不要原样透传 content-encoding（httpx 已解压）
    out_headers = {}
    for k, v in r.headers.items():
        lk = k.lower()
        if lk in ("content-encoding", "content-length", "transfer-encoding", "connection"):
            continue
        if lk in ("x-frame-options", "content-security-policy"):
            continue  # 反代场景下这两个会把 iframe 拦掉
        out_headers[k] = v

    content = r.content
    media_type = r.headers.get("content-type")

    # ★ 压缩包预览页：注入「kkFileView 自己」的根地址 ★
    #
    #   模板 compress.ftl 里 buildPreviewUrl 拼出的「压缩包成员地址」是给
    #   kkFileView 自己用的（成员文件由 kkFileView 的 WebConfig 把 /** 映射
    #   到 fileDir 当静态资源服务）。所以这里必须填 **kkFileView 的根地址**，
    #   而不是网关地址。
    #
    #   ⚠️ 曾经填的是 f"{_internal_origin()}/preview/"（网关地址），实测：
    #        00-Q3-1250.zip          → 200 ✅
    #        1.2.14.TFDF-6# F向.zip  → 404 ❌  ← 用户报的「一个能、一个不能」
    #      改成 kkFileView 根地址后两者都 200。
    #      原因：网关的 /preview/ 不是 kkFileView 的路由（被当普通路径段），
    #      且多经一轮解析后 `#` 会被截断。
    #   settings.preview_url 形如 http://127.0.0.1:8012，末尾补一个 `/`。
    if media_type and "html" in media_type.lower() and b"__SERVER_BASE_URL__" in content:
        internal = settings.preview_url.rstrip("/") + "/"
        content = content.replace(b"__SERVER_BASE_URL__", internal.encode())
        out_headers.pop("content-length", None)

    # ★★★ 曾在这里做过「压缩包成员 404 自愈」，2026-09-20 已整体移除 ★★★
    #
    #   背景：kkFileView 的 CompressFilePreviewImpl 用**进程内缓存**（cache.type=jdk）
    #   记「这个压缩包已解压」，key 只有文件名，且**不校验解压产物目录是否还在**：
    #
    #       if (forceUpdatedCache || !hasText(getConvertedFile(fileName)) || !isCacheEnabled()) {
    #           fileTree = compressFileReader.unRar(filePath, ...);      // 解压
    #           fileHandlerService.addConvertedFile(fileName, fileTree); // 记缓存
    #       } else {
    #           fileTree = getConvertedFile(fileName);                   // 吃缓存，跳过 unRar
    #       }
    #
    #   于是「缓存说已解压、磁盘上目录却没了」时，成员地址会 404。
    #   当时的应对是在这一层加「探测 + 强制重解压」的自愈。
    #
    #   ❌ 为什么把它删掉（用户实测反馈 + 根因确认）❌
    #
    #     本进程是**单 worker 的 uvicorn**（见 supervisord 里 uvicorn 启动参数，
    #     没有 --workers）。自愈里的两次 httpx 都是**同步阻塞**的：
    #         · /directory 探测            最长 15s
    #         · 强制重解压 /onlinePreview  最长 300s
    #     直接放在本响应路径上，就等于把单 worker 交给一次几十秒的解压。
    #     用户的真实体验：
    #         「预览压缩包时，整个系统变得非常慢，各个服务变成『检查中』」
    #     —— /healthz 是纯内存接口，它变慢只可能是事件循环被占死。
    #     连 docker 健康检查都拿不到响应 → 容器被判 unhealthy。
    #
    #     换句话说：这是**我们为了修一个边角问题，亲手引入的整机故障**。
    #     收益（一个缓存错位场景）远小于风险（单点冻结全站），删除是正解。
    #
    #   ✅ 如果将来还要处理这个缓存错位，正确的位置在**部署侧**，不在请求路径：
    #      · 容器启动时清一次解压产物目录（cache 与磁盘一起从零开始，天然一致）
    #      · 或让 kkFileView 用外部缓存（redis），与磁盘同生命周期
    #      · 或在 compose 里给 uvicorn 加 workers（先把并发能力补上再谈自愈）
    #
    #   注意：本文件的 /preview 反代**其余部分不受影响** —— 尤其是下面那些
    #   真实修复（__SERVER_BASE_URL__ 替换、压缩包路径里 `#` 的编码兜底），
    #   它们才是「一个能、一个不能」的真正解法，必须保留。

    return Response(
        content=content,
        status_code=r.status_code,
        headers=out_headers,
        media_type=media_type,
    )



# ===========================================================================
# /website/* —— 给 Online 3D Viewer 兜底的「根路径」静态资源
# ===========================================================================
#
# ★ 为什么需要这个看起来多余的别名路由 ★
#
#   kkFileView 的 3D 预览（Online 3D Viewer / o3dv）内部把静态资源地址
#   **硬编码成「根路径」**：
#
#       let baseUrl = window.location.origin;
#       let n = baseUrl + "/website/libs/";
#       fetch(n + "occt-import-js-worker.js")   ...
#
#   也就是说它假定自己挂在网站的 `/` 下。带它去加载 WASM 导入器
#   （step/iges/brep 全靠它）。
#
#   但我们是把它放在**反代前缀 `/preview/`** 下供 iframe 内嵌的，
#   真实地址是 `/preview/website/libs/...`。于是 o3dv 去请求
#   `/website/libs/occt-import-js-worker.js` → **404** →
#   页面弹「Failed to import model / Failed to load occt-import-js」。
#
#   实测对照（本机 8089）：
#       /website/libs/occt-import-js-worker.js          → 404
#       /preview/website/libs/occt-import-js-worker.js  → 200
#
#   两种改法：改 o3dv 的压缩产物（升级即丢，不可取），或在网关上把
#   根路径的 /website/* 映射到 /preview/website/*（这里采用）。
#   注意 kkFileView 自身**不自带** /website 这个顶层路径，所以这个别名
#   不会和它已有的路由冲突。
@router.api_route("/website/{rest:path}", methods=["GET", "HEAD"])
async def proxy_website_root(rest: str, request: Request):
    """把根路径的 /website/* 转给 kkFileView 的预览静态资源。

    仅供 o3dv 内部按「根路径」拼出来的资源地址使用，
    等价于 /preview/website/*。
    """
    target = f"{settings.preview_url}/website/{rest}"
    if request.url.query:
        target += f"?{request.url.query}"

    fwd_headers: dict[str, str] = {}
    for k in ("accept", "accept-language", "content-type", "range", "user-agent"):
        v = request.headers.get(k)
        if v:
            fwd_headers[k] = v

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0), follow_redirects=False) as cli:
            r = await cli.request(request.method, target, headers=fwd_headers)
    except httpx.HTTPError:
        return Response(status_code=502)

    out_headers = {}
    for k, v in r.headers.items():
        lk = k.lower()
        if lk in ("content-encoding", "content-length", "transfer-encoding", "connection"):
            continue
        if lk in ("x-frame-options", "content-security-policy"):
            continue
        out_headers[k] = v

    return Response(
        content=r.content,
        status_code=r.status_code,
        headers=out_headers,
        media_type=r.headers.get("content-type"),
    )


# ===========================================================================
# CAD 预览深链
# ===========================================================================
