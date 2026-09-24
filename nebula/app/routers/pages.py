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
    # ★★ CAD：只对「嵌入块」收 UI，用 CSS 注入；**绝不碰 localStorage** ★★
    #
    # ── 为什么最终弃用了「往 localStorage 播种查看器设置」这一版 ──────────
    #   v4/v5 曾经这么做，实测有效（三块工具条确实不渲染了）。
    #   但它有一个**设计级**的副作用，用户当场发现：
    #     · localStorage 是 **per-origin** 的，而 /lite 与 /cad/ 同源（都是 :8089）
    #       ⇒ 外壳为「嵌入块」写下的 isShowXxx=false，会被**页签**直连的 /cad/
    #         和在系统浏览器里打开的 /cad/ 一起读到
    #       ⇒ 页签 / 浏览器直连也变成了「被收掉的样子」，而且**是持久的**。
    #     · 用户诉求本来就是「嵌入块收 UI、页签保持完整」，
    #       两者同源共享存储 ⇒ 播种方案**天然做不到这个区分**。
    #   而 CSS 注入是注入到 **iframe 文档内部**的，天然只影响嵌入块那一个实例，
    #   对页签/直连零影响。所以回到 CSS，并把选择器按实测补全。
    #
    # ── 实测依据（真机枚举，不是读代码猜的）──────────────────────────
    #   用 headless Chrome 打开 /lite 深链，枚举 iframe 内「仍然可见」的元素：
    #     DIV .ml-cli-container        832x32 @213,580    命令行（含 INPUT.ml-cli-text）
    #     DIV .ml-cli-wrapper / __bar  （同上，同一元素链上的祖先）
    #     BUTTON .ml-cli-up / -down / DIV .ml-cli-close-btn
    #     DIV .ml-ex-ui-toolbar        46x359 @1200,132  右侧垂直工具栏
    #     BUTTON .ml-ex-ui-toolbar-btn ×10  选择/移动/范围缩放/矩形缩放/图层/
    #                                       切换背景色/阅读模式/测量/批注/折叠
    #     DIV .ml-vertical-toolbar-host .ml-ex-ui-toolbar-host   （它是全屏透明宿主）
    #     DIV .ml-ui-shortcut-toolbar-shell 23x42 @1223,12  右上角「收起工具栏」
    #     BUTTON .ml-ui-shortcut-collapse-btn（title=收起工具栏）
    #   而 v2 的选择器**一条都盖不到上面这些** ——
    #     例如 [class*='ml-ui-toolbar'] 匹配 "ml-ui-toolbar"，但
    #     "ml-ex-ui-toolbar" 里 "ml-" 后面接的是 "ex-"，并不是 "ui-"，所以不命中。
    #   ⇒ 这就是「菜单还在」的全部原因：**选择器照 Vue 层的 class 写的，
    #     而命令行/右侧工具栏/右上箭头是引擎层（cad-simple-viewer chunk）
    #     用原生 DOM 建的，class 完全不同**。
    #
    # ── 用户点名的四块（嵌入块里都不要显示）────────────────────────────
    #   ① 命令行          → .ml-cli-*
    #   ② 工具栏          → 顶部 .ml-ribbon* / .ml-cad-header（功能区）
    #                        右侧 .ml-ex-ui-toolbar*（垂直工具条）
    #   ③ 右上角「售前工具栏」菜单 → .ml-ui-shortcut-toolbar-shell
    #   ④ 底部状态栏      → .ml-status-bar（**整条**，含 .ml-status-bar-left 里的
    #                        布局页签 Model/Layout1/Layout2 —— 用户明确要求
    #                        「状态栏也不要显示」，所以不再只藏右半）
    "cad": [
        # ① 命令行（引擎层原生 DOM；藏了容器，其子元素随 display:none 一起消失）
        ".ml-cli-container", ".ml-cli-wrapper", ".ml-cli-bar",
        ".ml-cli-left", ".ml-cli-center", ".ml-cli-right",
        ".ml-cli-text", ".ml-cli-close-btn", ".ml-cli-up", ".ml-cli-down",
        "[class*='ml-cli']",
        # ② 顶部功能区（Vue 层 Ribbon 家族）
        ".ml-cad-header",
        ".ml-ribbon", ".ml-ribbon__header", ".ml-ribbon__panel",
        ".ml-ribbon__head-left", ".ml-ribbon__head-right",
        ".ml-ribbon__tabs", ".ml-ribbon__tabs-extra", ".ml-ribbon__tabs-after",
        ".ml-ribbon__minimized-anchor",
        ".ml-ribbon-toolbar-container",
        ".ml-ribbon-backstage", ".ml-ribbon-file-menu-submenu",
        ".ml-ribbon-contextual-tabs", ".ml-ribbon-overflow-trigger",
        "[class*='ml-ribbon']",
        ".ml-cad-footer",
        # ② 右侧垂直工具栏（引擎层原生 DOM）
        ".ml-ex-ui-toolbar", ".ml-ex-ui-toolbar-btn",
        ".ml-ex-ui-toolbar-collapse-btn", ".ml-ex-ui-toolbar-host",
        # ③ 右上角「收起工具栏」小箭头
        ".ml-ui-shortcut-toolbar-shell", ".ml-ui-shortcut-collapse-btn",
        # ④ 底部状态栏：整条藏（含布局页签），按用户要求
        ".ml-status-bar",
        ".ml-status-bar-left", ".ml-status-bar-right",
        ".ml-status-bar-right-button-group", ".ml-status-bar-current-pos",
        "[class*='ml-status-bar']",
        ".ml-layout-tabs", ".ml-layout-tabs-list", ".ml-layout-tabs-button",
        ".ml-overflow-tabs", ".ml-overflow-tabs-header", ".ml-overflow-tabs-body",
        # 旧版 / 其它版本可能出现的同类 UI（保留兜底）
        ".ml-ui-simple-toolbar", ".ml-ui-simple-toolbar__menu",
        "[class*='simple-toolbar']", "[class*='ml-ui-toolbar']",
        ".ml-ui-panel", "[class*='ml-ui-panel']",
        ".ml-aci-loupe", "[class*='ml-aci-loupe']",
        "[class*='ml-polar-tra']", "[class*='ml-compass']", "[class*='ml-axis']",
    ],
}

# ★★ 【已废弃·不要再加回来】往 localStorage 播种 CAD 查看器设置 ★★
#
# v4/v5 曾用过这套方案，现已**整段删除**，只留这段说明防止后人再踩：
#
#   查看器把显示开关存在 localStorage["mlightcad.settings.cad-viewer"] 里
#   （键名实测自 /cad/ 入口 assets/main-CoLbfQ3X.js 的
#     Qe.configure({ storageKey: "mlightcad.settings.cad-viewer" })）。
#   于是 v4/v5 在外壳页里先写 isShowXxx=false 再放 iframe，
#   让查看器自己「按设置不渲染」那几块 UI。功能上确实生效。
#
#   ★ 但它有一个设计级缺陷，用户当场发现 ★
#     localStorage 是 **per-origin** 的，而 /lite 与 /cad/ **同源**（都是 :8089）
#     ⇒ 外壳为「嵌入块」写下的 false，会被
#         · 思源「页签」里直连的 /cad/
#         · 系统浏览器里直接打开的 /cad/
#       一起读到，而且是**持久化**的
#     ⇒ 页签 / 浏览器直连也变成「被收掉的样子」，用户明确说这不对。
#
#   用户诉求是：「嵌入块收 UI、页签保持完整」。
#   同源共享存储 ⇒ **播种天然做不到这个区分**。
#
#   ✅ 正确解法：CSS 注入。CSS 是注入到 **iframe 文档内部**的，
#      天然只影响嵌入块那一个实例，对页签/直连零影响，也不写任何持久状态。
#      见上面 _LITE_HIDE["cad"]。

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
function __nbKillBackLink(doc){  try{    var as=doc.querySelectorAll('a');    for(var i=0;i<as.length;i++){      var a=as[i];      if(a.className) continue;      var t=(a.textContent||'');      if(t.indexOf('文件库')<0) continue;      try{ if(a.parentNode){a.parentNode.removeChild(a);} }catch(e){}    }  }catch(e){}}
"""


@router.get("/lite", response_class=HTMLResponse)
async def lite_shell(target: str = "", kind: str = "kk", title: str = ""):
    """轻量外壳页：把一个预览页包起来，去掉菜单栏并挡住中键穿透。

    - target 只允许本机相对路径（防开放重定向 / 任意站点 iframe）
    - kind   kk | cad，决定隐藏哪一组选择器
             （cad = 命令行 + 顶部功能区 + 右侧工具条 + 右上箭头 + 整条状态栏）
    - v6：只做 **CSS 注入**，不写任何 localStorage —— 见上方「已废弃」注释。
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
        # ★ nb-cad-hide-v6 ★
        #   v5 → v6 的改动：**彻底去掉 localStorage 播种**，回到纯 CSS 注入。
        #   原因见上方「已废弃」注释：/lite 与 /cad/ 同源 ⇒ 播种会污染页签
        #   与浏览器直连。现在嵌入块靠 CSS 收 UI，页签/直连完全不受影响。
        #   布局修正（每条都是实测出来的，不是推的）：
        #     · 顶部功能区（.ml-cad-header 1258x123）藏掉后，主画布要顶到 top:0
        #     · 底部状态栏（.ml-status-bar 1258x30）整条藏掉后，主画布要撑满 100%
        #     · 中键守卫 / 隐藏回链 与 CAD 无关，所有 kind 都跑
        + "/* nb-cad-hide-v6 */"
        ".ml-cad-main{top:0!important;height:100%!important;}"
        ".ml-cad-container{top:0!important;height:100%!important;}"
    )

    # ★ 页序（v6 定稿）★
    #   <head> 里的 <style>  →  <body> 的 <iframe>  →  body 里的 hide 脚本
    #   ① 收 UI 的 <style> 放 <head>：解析即生效，不用等 JS，也避免闪一下。
    #   ② <iframe> 必须排在 hide <script> **之前**：
    #      脚本在解析时就会 getElementById('nb-lite-frame')，排在后面能立刻拿到。
    #   ③ 不再有「播种」，所以也没有任何 localStorage 写入。
    html = (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>" + (title or "preview") + "</title>"
        "<style>" + css + "</style>"
        "</head><body>"
        + "<iframe id=\"nb-lite-frame\" src=\"" + t + "\" allowfullscreen=\"true\" "
        "referrerpolicy=\"no-referrer-when-downgrade\"></iframe>"
        + "<script>(function(){"
        "var SEL=" + _json.dumps(sels) + ";"
        "var CSS=" + _json.dumps(css) + ";"
        + _LITE_GUARD_JS +
        __NB_KILL_BACKLINK_JS +
        "/* ★ 惰性取 frame ★"
        "   这里**不能**写 `var frame=document.getElementById('nb-lite-frame')`："
        "   虽然 v6 已把 <iframe> 排在脚本之前，但脚本还有 MutationObserver 回调"
        "   等异步执行点，现取永远最稳（v5 曾因取到 null 导致整段 CSS 空转）。 */"
        "function __nbFrame(){ try{ return document.getElementById('nb-lite-frame'); }catch(e){ return null; } }"
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
        "  var fr=__nbFrame();"
        "  if(!fr) return;"
        "  try{ d=fr.contentDocument; }catch(e){ return; }"
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
        "    try{ var fr=__nbFrame(); var d=fr&&fr.contentDocument;"
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
        "})();</" + "script>"
        "</body></html>"
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
