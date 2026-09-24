"""CAD 图纸查看器的同源反代（/cad/*）与预览地址"""

from __future__ import annotations

from urllib.parse import urlencode, urlsplit

import httpx

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from .. import auth, files
from ..config import settings
from ..webutil import _origin, _internal_origin, _mount, make_raw_url


router = APIRouter()

# ============================================================================
# ★ 一次性「解污染」脚本（nb-cad-unpoison v1）★
# ----------------------------------------------------------------------------
# 为什么需要它（这是一次真实返工留下的尾巴）：
#
#   /lite 外壳页曾经（v4/v5）用「往 localStorage 播种 isShowXxx=false」的方式
#   把嵌入块的 CAD 工具条收掉。功能上生效，但 localStorage 是 **per-origin** 的，
#   而 /lite 与 /cad/ **同源**（都是 :8089）⇒ 播种把「页签里直连的 /cad/」和
#   「系统浏览器里打开的 /cad/」也一起改了，**而且是持久化的**。
#
#   已改成纯 CSS 注入（pages.py 的 _LITE_HIDE["cad"]），不再写 localStorage。
#   但**已经写进用户浏览器的那份脏值不会自己消失** —— 删掉播种代码只能止住
#   新的污染，止不住旧的。用户会看到「页签/浏览器打开还是被收掉的样子」。
#
#   ⇒ 由本反代在 /cad/ 的 **HTML 里注入一段一次性清理脚本**。
#     放在 /cad/ 上而不是 /lite 上，是因为页签与浏览器直连打开的是 /cad/，
#     这两条路径都会经过这里；放在 /lite 上则「先开页签、还没进过嵌入块」时修不到。
#
#   ★ 它做什么 ★
#     只把**我们当初强行改过的那 8 个键**从存储对象里 **删掉**（不是写 true），
#     从而回落到查看器自己的默认值 —— 也就是「完整 UI」。
#     其它键（字体映射 / 捕捉模式 / 主题 …）一律不碰。
#
#   ★ 为什么用「删」而不是「写回 true」★
#     ① 不知道查看器各版本的默认值，删掉 = 用它的默认，最稳。
#     ② isShowEntityInfo / isShowStats 的默认本来就是 false，写 true 反而会
#        凭空多出「图元信息 / 性能面板」两块面板。
#
#   ★ 只跑一次 ★
#     localStorage 里留 `nb.cad.unpoison.v1` 作闸；否则用户以后自己在查看器里
#     把工具条关掉，也会被每次加载时清回来（那就是新的 bug）。
#
#   ★ 时机 ★
#     注入在 </body> 前，是**解析期同步执行**的内联脚本；
#     而查看器的入口 main-*.js 是 type="module"（__client.js 是 defer），
#     两者都在解析完成后才执行 ⇒ 一定先于查看器读取设置。实测确认过。
#
#   ★ 何时可以删掉这段 ★
#     等所有用过的浏览器都至少加载过一次新版 /cad/（脏值清干净）之后，
#     整段 _CAD_UNPOISON_JS 与下面 proxy_cad 里的改写都可以移除。
# ============================================================================
_CAD_UNPOISON_MARK = "nb-cad-unpoison"

_CAD_UNPOISON_JS = """<script id="%s">
/* %s v1 — 一次性清除 v4/v5 播种残留的 isShowXxx=false，见后端正则注释 */
(function(){
  try{
    var GUARD = "nb.cad.unpoison.v1";
    var ls = window.localStorage;
    if(ls.getItem(GUARD)) return;
    var KEY = "mlightcad.settings.cad-viewer";
    var KEYS = ["isShowStats","isShowCommandLine","isShowEntityInfo","isShowRibbon",
                "isShowToolbar","isShowShortCutToolbar","isShowCoordinate",
                "isShowLanguageSelector"];
    var raw = ls.getItem(KEY), n = 0;
    if(raw){
      var o = null;
      try{ o = JSON.parse(raw); }catch(e){ o = null; }
      if(o && typeof o === "object" && Object.prototype.toString.call(o) === "[object Object]"){
        for(var i=0;i<KEYS.length;i++){
          var k = KEYS[i];
          if(Object.prototype.hasOwnProperty.call(o,k) && o[k] === false){
            try{ delete o[k]; n++; }catch(e){}
          }
        }
        if(n) ls.setItem(KEY, JSON.stringify(o));
      }
    }
    ls.setItem(GUARD, String(n));
  }catch(e){}
})();
</script>""" % (_CAD_UNPOISON_MARK, _CAD_UNPOISON_MARK)


def _inject_unpoison(content: bytes, content_type: str) -> bytes:
    """只对 HTML 且含 </body> 且尚未注入过的响应做一次幂等改写。"""
    if "text/html" not in (content_type or "").lower():
        return content
    if b"</body>" not in content:
        return content
    if _CAD_UNPOISON_MARK.encode() in content:
        return content
    return content.replace(b"</body>", _CAD_UNPOISON_JS.encode("utf-8") + b"</body>", 1)


@router.get("/api/cad/preview")
async def api_cad_preview(
    request: Request,
    mount: str = "", path: str = "", user: dict = Depends(auth.current_user),
):
    """返回 cad-viewer 的深链地址（同源反代路径）。

    cad-viewer 的约定（见其 server.cjs / cad-client.js）：
        ?open=<图纸的可下载 URL>&name=<文件名>
    它会自己 fetch 这个 URL 拿字节，喂给 WASM 渲染器。

    ★ open 里的地址必须是**浏览器可达**的 ★
      cad-viewer 的渲染发生在浏览器里（WASM），fetch 由浏览器发起。
      所以这里必须用 _origin(request) 拼地址，绝不能用 NEBULA_BASE_URL
      （那是 http://nebula:8088，浏览器解析不了 → 页面报 "Failed to fetch"）。
      这和当初 kkFileView 的 X-Base-Url 是同一类坑。

    ★ 参数改默认空串 + 显式校验：理由同 /api/preview ★
    """
    if not mount:
        raise HTTPException(400, "缺少参数：mount（网盘名称）")
    if not path:
        raise HTTPException(400, "缺少参数：path（文件路径）")

    m = _mount(user["username"], mount)
    p = files.resolve(m, path)
    if p.is_dir():
        raise HTTPException(400, "目录不支持预览")

    if not settings.cad_enabled:
        raise HTTPException(503, "未配置 CAD 查看器（NEBULA_CAD_URL）")

    # ★ 给浏览器用的图纸直链，必须把 Host 换成**浏览器侧**的地址 ★
    #
    # make_raw_url() 返回的是 {_internal_origin()}/api/raw/...，即
    #   http://nebula:8088/api/raw/xxx.dwg?...
    # 这个地址是给 OnlyOffice / kkFileView 这类「同网络的容器」回拉用的。
    # 而 cad-viewer 的取流发生在**浏览器**里（WASM 渲染器自己 fetch），
    # 浏览器解析不了 nebula 这个 docker 内部名字 → 图纸页报 "Failed to fetch"。
    #
    # 所以这里只保留 raw 的**路径与查询串**，host 换成 _origin(request)。
    # 不能用 settings.base_url，也绝不能原样透传 —— 这正是
    # 「服务端正常、浏览器打不开」这类 bug 的经典成因。
    internal = urlsplit(make_raw_url(mount, path, ttl=3600))
    public_raw = f"{_origin(request)}{internal.path}"
    if internal.query:
        public_raw += f"?{internal.query}"

    q = urlencode({"open": public_raw, "name": p.name})
    # 深链走**同源反代**前缀 /cad，避免暴露 cad-viewer 的独立端口、
    # 也顺带绕开跨域与混合内容问题。
    url = f"/cad/?{q}"
    return {"ok": True, "url": url, "raw": public_raw}


@router.api_route("/cad/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"])
async def proxy_cad(rest: str, request: Request):
    """把 /cad/* 反代到 cad-viewer。

    和 /preview 反代同理：同源 iframe 不被跨域策略拦，只暴露一个端口。

    ★ 与「纯透传」的唯一差别 ★
      对 text/html 的响应会注入一段一次性「解污染」内联脚本（见文首长注释）。
      其余字节仍是逐字透传。
    """
    base = settings.cad_probe or settings.cad_url
    if not base or base.startswith("/"):
        return HTMLResponse(
            "<h3>CAD 查看器未配置</h3>"
            "<p>请设置 NEBULA_CAD_URL（浏览器地址）与 NEBULA_CAD_PROBE（容器地址）</p>",
            status_code=503,
        )

    target = f"{base.rstrip('/')}/{rest}"
    if request.url.query:
        target += f"?{request.url.query}"

    fwd_headers: dict[str, str] = {}
    for k in ("accept", "accept-language", "content-type", "range", "user-agent"):
        v = request.headers.get(k)
        if v:
            fwd_headers[k] = v

    body = await request.body()

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0), follow_redirects=False) as cli:
            r = await cli.request(
                request.method, target, headers=fwd_headers, content=body or None,
            )
    except httpx.HTTPError as e:
        return HTMLResponse(
            f"<h3>CAD 查看器不可达</h3><p>{type(e).__name__}: {e}</p>"
            f"<p>目标: {target}</p>",
            status_code=502,
        )

    out_headers = {}
    for k, v in r.headers.items():
        lk = k.lower()
        if lk in ("content-encoding", "content-length", "transfer-encoding", "connection"):
            continue
        if lk in ("x-frame-options", "content-security-policy"):
            continue  # 反代场景下这两个会把 iframe 拦掉
        out_headers[k] = v

    # ★ 只在 200 + HTML 时改写；改写是幂等的，注入过就不再注入 ★
    #   content-length 已在上面被剔除，Starlette 会按新长度重算，不会错位。
    content = r.content
    if r.status_code == 200:
        try:
            content = _inject_unpoison(content, r.headers.get("content-type", ""))
        except Exception:
            content = r.content  # 注入失败也要保证页面能打开

    return Response(
        content=content,
        status_code=r.status_code,
        headers=out_headers,
        media_type=r.headers.get("content-type"),
    )
