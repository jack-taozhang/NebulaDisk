"""页面与元信息：首页、分享短链、错误页、健康检查"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from .. import shares
from ..config import settings
from ..webutil import WEB_DIR
from ..share_web import _share_unlocked, _render_share_page


router = APIRouter()

@router.get("/", response_class=HTMLResponse)
async def index():
    idx = WEB_DIR / "index.html"
    if not idx.exists():
        return HTMLResponse("<h1>NebulaDisk</h1><p>前端文件缺失</p>", status_code=500)
    return HTMLResponse(idx.read_text(encoding="utf-8"))


@router.get("/s/{token}", response_class=HTMLResponse)
async def share_landing(token: str, request: Request):
    """分享短链：/s/<token> —— 对外给的就是这个（好记、不可枚举）。"""
    sh = shares.get(token)
    if not sh:
        return HTMLResponse(_render_share_error("分享不存在或已被撤销"), status_code=404)
    if sh.expired:
        return HTMLResponse(_render_share_error("分享已过期"), status_code=410)
    if sh.exhausted:
        return HTMLResponse(_render_share_error("分享访问次数已用完"), status_code=410)
    unlocked = _share_unlocked(request, token)
    return HTMLResponse(_render_share_page(sh, request, unlocked=unlocked))


def _render_share_error(msg: str) -> str:
    page = WEB_DIR / "share.html"
    if not page.exists():
        return f"<h1>{msg}</h1>"
    html = page.read_text(encoding="utf-8")
    import json as _json
    boot = _json.dumps({"error": msg}, ensure_ascii=False)
    return html.replace("__SHARE_BOOT__", boot)



# ===== LITE SHELL (task3/5) BEGIN =====
#
# 轻量外壳页 /lite —— 任务③（隐藏菜单栏）/ 任务⑤（中键不穿透）的正确解法。
#
# 为什么不能在前端（思源插件）里做：
#   插件用 blob: 造宿主页，继承的是思源 origin (:6806)，
#   而预览页在 NebulaDisk (:8089)，**跨源** ⇒ contentDocument === null
#   ⇒ CSS 注入与事件绑定全都够不到子文档。实测 innerDocReadable=false。
#   把外壳页搬到 :8089 上，与预览页同源，两个问题一起解决。
#
# 安全性：target 只接受本机相对路径（/ 开头、无 "//" 与 ":"），
#         否则会被当成开放重定向 / 任意站点 iframe 的跳板。

_LITE_HIDE = {
    "kk": [
        "#toolbarContainer", "#toolbarViewer", "#toolbarViewerLeft",
        "#toolbarViewerMiddle", "#toolbarViewerRight", "#secondaryToolbar",
        "#sidebarContainer", "#sidebarToggle", "#outerContainer > #sidebarContainer",
        # ★ 新版 PDF.js 用 viewsManager* 取代了旧的 sidebarContainer ★
        #   实测（干净对照，不套 /lite）PDF.js 层里：
        #     #toolbarContainer 1478x32 ✅
        #     #toolbarViewer / Left / Middle / Right ✅
        #     #viewsManagerHeader 230x58 ← 左侧「视图管理」面板标题
        #     #viewsManagerTitle / #viewsManagerStatus
        #   而 #sidebarContainer / #sidebarToggle 在该版本里**根本不存在**（缺），
        #   所以必须补上 viewsManager* 这一组，否则会漏掉左边那块面板。
        "#viewsManager", "#viewsManagerHeader", "#viewsManagerTitle",
        "#viewsManagerStatus", "[id^='viewsManager']",
        ".toolbar", ".findbar", "#findbar", "#loadingBar", "#errorWrapper",
        "#download", "#print", "#secondaryDownload", "#secondaryPrint",
        "#openFile", "#viewBookmark",
        ".kk-file-view-header", "#kkFileViewHeader", ".file-preview-header",
        ".navbar", ".toolbar-header", "#header", ".header",
        "[class*='preview-header']", "[class*='preview-toolbar']",
    ],
    "cad": [
        ".ml-ui-simple-toolbar", ".ml-ui-simple-toolbar__menu",
        "[class*='simple-toolbar']", "[class*='ml-ui-toolbar']",
        ".ml-ui-panel", "[class*='ml-ui-panel']",
        ".ml-aci-loupe", "[class*='ml-aci-loupe']",
        "[class*='ml-polar-tra']", "[class*='ml-compass']", "[class*='ml-axis']",
        "[class*='status-bar']", "[class*='statusbar']",
        ".ml-cad-header",
        ".ml-ribbon-toolbar-container",
        ".ml-ribbon",
        ".ml-ribbon__header",
        ".ml-ribbon__panel",
        ".ml-cad-footer",
    ],
}

# 中键守卫：与插件里 guardMiddleButton 完全同一套判据与动作。
_LITE_GUARD_JS = """
function __nbGuard(doc){
  if(!doc || doc.__nbMidGuard) return;
  doc.__nbMidGuard = true;
  var stop = function(e){
    if(e.button === 1 || (e.buttons & 4)){
      try { e.preventDefault(); } catch(x){}
      try { e.stopPropagation(); } catch(x){}
    }
  };
  var opts = { capture: true, passive: false };
  try {
    doc.addEventListener("mousedown", stop, opts);
    doc.addEventListener("mouseup",   stop, opts);
    doc.addEventListener("auxclick",  stop, opts);
    doc.addEventListener("click",     stop, opts);
    doc.addEventListener("mousemove", function(e){
      if(e.buttons & 4){
        try { e.preventDefault(); } catch(x){}
        try { e.stopPropagation(); } catch(x){}
      }
    }, opts);
  } catch(e){}
}
"""


__NB_KILL_BACKLINK_JS = """
function __nbKillBackLink(doc){  try{    var as=doc.querySelectorAll('a');    for(var i=0;i<as.length;i++){      var a=as[i];      if(a.className) continue;      var t=(a.textContent||'');      if(t.indexOf('\u6587\u4ef6\u5e93')<0) continue;      try{ if(a.parentNode){a.parentNode.removeChild(a);} }catch(e){}    }  }catch(e){}}
"""



@router.get("/lite", response_class=HTMLResponse)
async def lite_shell(target: str = "", kind: str = "kk", title: str = ""):
    """轻量外壳页：把一个预览页包起来，去掉菜单栏并挡住中键穿透。

    - target 只允许本机相对路径（防开放重定向 / 任意站点 iframe）
    - kind   kk | cad，决定隐藏哪一组选择器
    """
    import json as _json

    t = str(target or "").strip()
    # 只收本机相对路径：必须 / 开头，且不能出现 "//"（协议相对）、":"（带 scheme）
    if not t.startswith("/") or "//" in t or ":" in t or "\\" in t:
        return HTMLResponse(
            "<h1>无效的 target</h1><p>只接受本站相对路径（以 / 开头）。</p>",
            status_code=400,
        )

    k = str(kind or "kk").strip().lower()
    if k not in _LITE_HIDE:
        k = "kk"
    sels = ",".join(_LITE_HIDE[k])

    css = (
        "html,body{margin:0!important;padding:0!important;height:100%!important;"
        "overflow:hidden!important;background:#fff;}"
        "#nb-lite-frame{position:absolute;inset:0;width:100%;height:100%;"
        "border:0;display:block;}"
        + sels
        + "{display:none!important;visibility:hidden!important;height:0!important;"
        "min-height:0!important;width:0!important;min-width:0!important;"
        "margin:0!important;padding:0!important;border:0!important;"
        "overflow:hidden!important;}"
        + "/* nb-cad-hide-v2 */.ml-cad-main{top:0!important;height:100%!important;}.ml-cad-container{top:0!important;height:100%!important;}"
    )

    html = (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>" + (title or "preview") + "</title>"
        "<style>" + css + "</style></head><body>"
        "<iframe id=\"nb-lite-frame\" src=\"" + t + "\" allowfullscreen=\"true\" "
        "referrerpolicy=\"no-referrer-when-downgrade\"></iframe>"
        "<script>(function(){"
        "var SEL=" + _json.dumps(sels) + ";"
        "var CSS=" + _json.dumps(css) + ";"
        + _LITE_GUARD_JS +
        __NB_KILL_BACKLINK_JS +
        "var frame=document.getElementById('nb-lite-frame');"
        "function hideIn(doc){"
        "  if(!doc) return 0;"
        "  var old=doc.getElementById('nb-lite-css');"
        "  if(old){try{old.remove();}catch(e){}}"
        "  var st=doc.createElement('style');"
        "  st.id='nb-lite-css'; st.textContent=CSS;"
        "  (doc.head||doc.documentElement).appendChild(st);"
        "  var n=0;"
        "  try{ var els=doc.querySelectorAll(SEL);"
        "    for(var i=0;i<els.length;i++){"
        "      var el=els[i];"
        "      el.style.setProperty('display','none','important');"
        "      el.style.setProperty('height','0','important');"
        "      n++; } }catch(e){}"
        "  try{ __nbKillBackLink(doc); }catch(e){}"
        "  __nbGuard(doc);"
        "  return n;"
        "}"
        "function pump(){"
        "  var d=null;"
        "  try{ d=frame.contentDocument; }catch(e){ return; }"
        "  if(!d||!d.documentElement) return;"
        "  hideIn(d);"
        "  try{"
        "    var sub=d.querySelectorAll('iframe');"
        "    for(var i=0;i<sub.length;i++){"
        "      var sd=null;"
        "      try{ sd=sub[i].contentDocument; }catch(e){ continue; }"
        "      if(sd&&sd.documentElement){ hideIn(sd); }"
        "    }"
        "  }catch(e){}"
        "}"
        "pump();"
        "try{"
        "  var mo=new MutationObserver(function(){pump();});"
        "  var att=function(){"
        "    try{ var d=frame.contentDocument;"
        "      if(d&&d.documentElement){ mo.observe(d.documentElement,"
        "        {childList:true,subtree:true}); return true; }"
        "    }catch(e){}"
        "    return false;"
        "  };"
        "  if(!att()){"
        "    var w=setInterval(function(){ if(att()) clearInterval(w); },120);"
        "    setTimeout(function(){clearInterval(w);},12000);"
        "  }"
        "}catch(e){}"
        "var t1=setInterval(pump,300);"
        "setTimeout(function(){clearInterval(t1);},9000);"
        "__nbGuard(document);"
        "try{ document.documentElement.style.overscrollBehavior='contain'; }catch(e){}"
        "})();</" + "script></body></html>"
    )
    return HTMLResponse(html)


# ===== LITE SHELL (task3/5) END =====


@router.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "mounts": len(settings.mounts),
        "onlyoffice": settings.oo_enabled,
        "cad": settings.cad_enabled,
        "time": int(time.time()),
    }
