"""页面与元信息：首页、分享落地页、统一短链/分享管理、错误页、健康检查"""

from __future__ import annotations

import time

from fastapi import APIRouter, Form, Query, Request
from fastapi.responses import HTMLResponse
from .. import shares, shortlink
from ..config import DANGEROUS_EXT, ext_of, settings
from ..webutil import WEB_DIR, _mount, _origin, _stream_file, probe_readable
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


# ===== OO STANDALONE SHELL (diskcanvas "在浏览器中打开") BEGIN =====
#
# 为什么承载页必须放在后端（而不是插件里用 data:/blob: 造）：
#
#   2026-09-30 实测（headless Chrome，同 origin=http://192.168.193.70:6806、
#   同 isSecureContext=false）：
#
#     宿主文档              请求                       Origin  Referer   结果
#     --------------------  -------------------------  ------  --------  ------
#     真实 http :6806       script → :8082/api.js      (无)    有        ✅ 200
#     blob(:6806)           script → :8082/api.js      (无)    (无)      ❌ InsecureLocalNetwork
#     blob(:6806)           script → 同源 :6806        (无)    (无)      ❌ InsecureLocalNetwork
#     blob(:6806)           fetch  → :8082/api.js      (无)    (无)      ❌ InsecureLocalNetwork
#
#   ⇒ blob:（不透明来源）文档里发起的所有子资源请求**都不带 Origin/Referer**，
#     Chrome Private Network Access 判定为「非安全上下文 + 更私有地址空间」
#     一律拦截（corsError = InsecureLocalNetwork）。连同源资源都取不到。
#   ⇒ 这与 CORS 头、CSP、混合内容都无关，改前端无解。
#
#   ⇒ 正确解法：让承载页运行在**真实 http origin** 上。实测 :8089 / :8082 / :6806
#     三个真实文档里加载 :8082/api.js 全部 ✅（docs:true, cors=[]）。
#     本页就放在 :8089（网盘），与插件同源，且能自动带上 nebula_session Cookie。
#
# 与 /lite 同款先例（pages.py 里 lite_shell 的注释写过同样结论）。

_OO_HTML_TMPL = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#f5f5f5;}
  #nb-oo-host{position:absolute;inset:0;}
  #nb-oo-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
    color:#666;text-align:center;padding:24px;box-sizing:border-box;}
  #nb-oo-msg code{background:#ececec;border-radius:3px;padding:1px 5px;font-size:12px;
    word-break:break-all;}
</style></head>
<body>
<div id="nb-oo-host"></div>
<div id="nb-oo-msg">正在加载编辑器…</div>
<script>
(function(){
  var APIJS = __APIJS__;
  var CFG   = __CFG__;
  var host  = document.getElementById("nb-oo-host");
  var msg   = document.getElementById("nb-oo-msg");

  function fail(text){
    try{ msg.style.display = "flex"; }catch(e){}
    msg.innerHTML = text;
  }
  function boot(){
    try{
      if(!(window.DocsAPI && window.DocsAPI.DocEditor)){ fail("OnlyOffice 脚本已加载但未暴露 DocsAPI"); return; }
      msg.style.display = "none";
      new window.DocsAPI.DocEditor("nb-oo-host", CFG);
    }catch(e){
      fail("OnlyOffice 初始化失败：<code>" + String((e && e.message) || e) + "</code>");
    }
  }
  var s = document.createElement("script");
  s.src = APIJS;
  s.onload = boot;
  s.onerror = function(){
    fail("无法加载 OnlyOffice api.js：<code>" + APIJS + "</code><br>"
       + "请确认 OnlyOffice 服务可达，且浏览器未拦截本页的跨端口脚本请求。");
  };
  document.head.appendChild(s);
})();
</script>
</body></html>
"""


@router.get("/oo", response_class=HTMLResponse)
async def oo_standalone(mount: str = "", path: str = "", embed: str = "", request: Request = None):
    """OnlyOffice 独立承载页 —— 给「在浏览器中打开」用。

    为什么由后端渲染 config 而不是前端传进来：
      config 里含 HS256 签名（对整份 config 签名），前端改任何字段都会失配；
      且 config 序列化后约 2.9KB，塞进 URL 会超长并把 JWT 写进访问日志。
      本页与网盘同源 ⇒ 浏览器自动带 nebula_session Cookie ⇒ 可直接鉴权。
    """
    import json as _json
    import os as _os
    import html as _html
    from urllib.parse import urlencode as _urlencode

    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, files as _files, integrations as _integrations, users as _users
    from ..webutil import (
        _origin as _req_origin,
        _internal_origin as _int_origin,
        _mount as _resolve_mount,
        make_raw_url as _make_raw_url,
    )

    if not mount:
        return HTMLResponse("<h1>缺少参数：mount</h1>", status_code=400)
    if not path:
        return HTMLResponse("<h1>缺少参数：path</h1>", status_code=400)

    # 鉴权：优先 Cookie（本页与网盘同源，浏览器会自动携带 nebula_session）
    # ★ auth.current_user 是**同步**函数（不是 async）—— 不要 await ★
    try:
        user = _auth.current_user(request)
    except _HTTPException:
        user = None
    except Exception:
        user = None
    if not user:
        return HTMLResponse(
            "<h1>未登录</h1><p>请先在 <a href=\"/\">NebulaDisk</a> 登录后重试。"
            "本页依赖站点的登录 Cookie。</p>",
            status_code=401,
        )

    if not settings.oo_enabled:
        return HTMLResponse("<h1>OnlyOffice 未配置</h1>", status_code=400)
    if not settings.oo_secret:
        return HTMLResponse("<h1>OnlyOffice 密钥未配置，无法签名</h1>", status_code=500)

    m = _resolve_mount(user["username"], mount)
    p = _files.resolve(m, path)
    if p.is_dir():
        return HTMLResponse("<h1>目录不能用 OnlyOffice 打开</h1>", status_code=400)

    st = p.stat()
    mode = "edit" if _os.access(p, _os.W_OK) else "view"
    doc_url = _make_raw_url(mount, path, ttl=3600)

    cb_base = settings.oo_callback_url or _int_origin()
    cb = f"{cb_base}/api/oo/callback?" + _urlencode({"mount": mount, "path": path})

    want_embed = str(embed).strip().lower() in ("1", "true", "yes", "on")

    cfg = _integrations.build_editor_config(
        file_key=_integrations.file_key(mount, path, int(st.st_mtime), st.st_size),
        title=p.name,
        doc_url=doc_url,
        callback_url=cb,
        mode=mode,
        user_id=user["username"],
        user_name=user["username"],
        embed=want_embed,
    )

    _users.audit(user["username"], "oo_open_browser", f"{mount}:{path}", mode)

    api_js = f"{_integrations.oo_public_base(_req_origin(request))}/web-apps/apps/api/documents/api.js"

    def _safe_json(obj):
        # 内联进 <script> 前必须掐死 </script> 与行分隔符
        t = _json.dumps(obj, ensure_ascii=False)
        return (
            t.replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        )

    import html as _html2
    out = (
        _OO_HTML_TMPL
        .replace("__TITLE__", _html2.escape(p.name))
        .replace("__APIJS__", _safe_json(api_js))
        .replace("__CFG__", _safe_json(cfg))
    )
    resp = HTMLResponse(out)
    # 承载页绝不能缓存：config 里的签名有过期时间
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


# ===== OO STANDALONE SHELL END =====


# ===== UNIFIED LINKS BEGIN =====
#
# 统一的「链接」出入口：短链 `/f/<token>` 与分享 `/s/<token>` 共用一张表
# （`links`，`kind='file'|'share'`）与**同一套管理接口**。
#
# 用户报障原话：
#   「在浏览器中打开 地址这么复杂？是否有必要」
#   「oo 打开的地址就是很简单，这个是不是不对」
#   「网盘里面自带的分享也纳入一起，采用短链的方式分享。管理纳入一起。」
#
# 前两句⇒ 原生类型（图片/pdf/视频/音频/文本）原先走
#   /api/raw/<文件名>?mount=..&path=..&exp=..&sig=..   实测 **324 字符**
# 长度是**结构性**的（path 与签名互相绑定、路径段还得为后缀重复一次），
# 前端减不掉 ⇒ 改由服务端记 (owner,mount,path) → 12 字符 token 的映射。
#
# 第三句⇒ 把「分享」也并进来：同表、同 token 规格（/s/ 的地址也跟着短了）、
# 同一个管理列表与同一个撤销入口。完整设计见 `app/shortlink.py` 的 docstring。
#
# ★ 为什么 /f/<token> 敢免登录（capability URL）★
#   · token 12 字符 base64url = 72 bit 随机 ⇒ 不可枚举、不可猜
#   · 危险扩展名（exe/bat/js/ps1…）一律强制 attachment，绝不 inline
#   · 映射可见性仍按链接的 owner 复核（owner 看不见该映射 ⇒ 链接同步失效）
#   · 收回手段：删/改名/移动文件时自动清 + 显式撤销
#
# ★ 为什么 /f 是「吐字节」而不是 302 跳到 /api/raw ★
#   302 一跟，地址栏立刻变回 324 字符那条 —— 等于白做。
#
# ★ 为什么签发接口（/api/shortlink）必须鉴权 ★
#   落地端不鉴权是因为"token 即凭证"；但**签发**必须鉴权，
#   否则任何人都能替别人的文件签一条长期有效的短链。


def _link_error(msg: str, status: int) -> HTMLResponse:
    """链接落地失败时的极简提示页（不依赖前端 SPA）。"""
    return HTMLResponse(
        '<!doctype html><meta charset="utf-8"><title>NebulaDisk</title>'
        '<div style="font:14px/1.7 system-ui,sans-serif;padding:48px;color:#444">'
        f'<h2 style="margin:0 0 8px">{msg}</h2>'
        '<p><a href="/">返回 NebulaDisk</a></p></div>',
        status_code=status,
    )


def _want_download(raw: str) -> bool:
    return str(raw).strip().lower() not in ("", "0", "false", "off", "no", "n")


@router.post("/api/shortlink")
async def api_shortlink(
    request: Request,
    mount: str = Form(""),
    path: str = Form(""),
    name: str = Form(""),
    ttl_days: float = Form(None),
):
    """为一个「映射 + 路径」签发/复用**直链**（kind='file'），返回可直接打开的短地址。

    ★ 有效期默认 **7 天**（与分享同规格）★
      用户要求（原话）：「直链 默认 也按7天来。」
      `ttl_days` 传 0 或负数表示永久；不传则用后端默认（7 天）。
      ⚠️ 复用已有直链时：**已过期**才会把到期时间往后推（token 不变），
        没过期就原样返回 —— 不会因为你多点一次"复制"就白送一轮有效期。

    ★ 入参用 Form 而不是 JSON body ★
      插件的 `apiPost()` 发的是 **multipart/form-data**；FastAPI 的 `Form()`
      对 multipart 与 urlencoded 都认，写成 JSON 模型会 422。
      （与 /api/login 同一约定，别改成 pydantic。）
    """
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, files as _files, users as _users

    if not mount:
        raise _HTTPException(400, "缺少参数：mount（网盘名称）")
    if not path:
        raise _HTTPException(400, "缺少参数：path（文件路径）")

    # auth.current_user 是**同步**函数（不是 async）—— 不要 await
    user = _auth.current_user(request)

    # 签之前先按调用者权限解一遍 → 越权签不出来（与 /oo 同一道闸）
    m = _mount(user["username"], mount)
    p = _files.resolve(m, path)
    if p.is_dir():
        # 目录不走直链：正确入口是「分享」(/s/<token>)，它有落地页与浏览能力
        raise _HTTPException(400, "目录不支持直链，请使用「分享」功能")

    # None = 「没指定」⇒ 交给后端默认（新签用 7 天、已存在的不动它的有效期）
    ttl = None if ttl_days is None else (0 if ttl_days <= 0 else int(ttl_days * 86400))
    lk = shortlink.get_or_create(user["username"], mount, path,
                                 name or p.name, ttl=ttl)
    _users.audit(user["username"], "shortlink_create", f"{mount}:{path}", lk.token)

    return {
        "token": lk.token,
        "kind": lk.kind,
        "url": shortlink.url_for(lk.token, _origin(request), lk.kind),
        "name": p.name,
        # 直链现在默认 7 天 ⇒ 调用方要能显示"到什么时候失效"（0 = 永久）
        "expiresAt": lk.expires_at,
    }


@router.get("/f/{token}")
async def short_open(token: str, request: Request, dl: str = ""):
    """**直链**落地端：按 token 取到文件并内联吐字节。"""
    from .. import files as _files

    lk = shortlink.get_kind(token, shortlink.KIND_FILE)
    if not lk:
        return _link_error("短链不存在或已被撤销", 404)
    # ★ 直链也会过期（默认 7 天）★ —— 过期后不能再吐字节。
    #   行**保留**不删（否则面板里看不到它、也就没法"续期"）。
    if lk.expired:
        return _link_error("短链已过期（可到「链接管理」里续期）", 410)

    # ★ 用链接的 owner 去解映射，而不是"无条件放行" ★
    #   短链不绕过映射可见性：owner 已看不到该映射时，链接同步失效。
    try:
        m = _mount(lk.owner, lk.mount)
    except Exception:  # noqa: BLE001 —— 映射暂时不可用
        # ⚠️ 这里**绝不能**走到下面的自清逻辑：盘抖一下就把好链接全清空了。
        return _link_error("文件已不存在或不可访问", 404)

    try:
        p = _files.resolve(m, lk.path)
    except _files.FileError as e:  # noqa: PERF203
        # ★ 惰性自清死链（2026-09-30 补）★
        #   路径确实没了（404）⇒ 顺手删掉这一行，免得挂在管理列表里当"死链"。
        #   只认「文件真没了」（404）；403/500 是权限或盘的问题，不动数据。
        if int(getattr(e, "code", 400) or 400) == 404:
            shortlink.revoke_by_path(lk.owner, lk.mount, lk.path)
        return _link_error("文件已不存在或不可访问", 404)
    except Exception:  # noqa: BLE001
        return _link_error("文件已不存在或不可访问", 404)

    if p.is_dir():
        return _link_error("短链指向的是一个目录", 404)

    want_dl = _want_download(dl)
    # ★ 危险类型强制下载 ★
    #   否则 /f/<token> 就等同于"免登录 + 长期有效 + 可直接执行/落盘"的通道。
    if ext_of(p.name) in DANGEROUS_EXT:
        want_dl = True

    # ★ 先探「内容读不读得出来」，**再**计数 ★
    #   顺序反了的话：一个读不出内容的文件会白烧 max_visits 配额，
    #   访问次数也会虚高 —— 用户根本没看到内容。
    probe_readable(p)

    shortlink.touch(token)

    resp = _stream_file(p, download=want_dl)
    # 短链语义是"取当前内容"，别让浏览器/中间层把旧字节缓存住
    resp.headers["Cache-Control"] = "no-store"
    return resp


@router.get("/api/links")
async def api_links(request: Request, all: str = Query("")):
    """**统一列表**：当前用户的直链 + 分享（管理员加 `?all=1` 看所有人的）。

    ★ 这是「管理纳入一起」的落点 ★
      前端只用这一个接口就能列出全部链接，不必再分别查 /api/shares。
      排序按 `created_at DESC`，前端可再自行分组。
    """
    from .. import auth as _auth

    user = _auth.current_user(request)
    origin = _origin(request)
    every = str(all).strip().lower() in ("1", "true", "yes", "on")

    if every and user.get("is_admin"):
        lks = shortlink.list_all()
    else:
        lks = shortlink.list_by_owner(user["username"])

    items = [lk.as_dict(origin=origin) for lk in lks]
    return {
        "items": items,
        "total": len(items),
        "files": sum(1 for i in items if i["kind"] == shortlink.KIND_FILE),
        "shares": sum(1 for i in items if i["kind"] == shortlink.KIND_SHARE),
        "all": bool(every and user.get("is_admin")),
    }


@router.get("/api/shortlinks")
async def api_shortlinks(request: Request):
    """只列**直链**（`/api/links` 的子集）。

    ★ 保留是为了不破坏 2026-09-30 合并前的接口形状 ★
      当时这个端点的响应是 `{"items": [...], "total": n}`，
      且 items 只有 file 类。统一后仍按这个形状返回（只是多了 kind 字段）。
      新代码请直接用 `/api/links`。
    """
    from .. import auth as _auth

    user = _auth.current_user(request)
    origin = _origin(request)
    items = [
        lk.as_dict(origin=origin)
        for lk in shortlink.list_by_owner(user["username"], shortlink.KIND_FILE)
    ]
    return {"items": items, "total": len(items)}


@router.post("/api/links/revoke")
async def api_links_revoke(request: Request, token: str = Form("")):
    """**统一撤销**：直链与分享都用它（拥有者或管理员）。"""
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, users as _users

    if not token:
        raise _HTTPException(400, "缺少参数：token")
    user = _auth.current_user(request)
    if not shortlink.revoke(token, user["username"], bool(user.get("is_admin"))):
        raise _HTTPException(404, "链接不存在，或你没有权限撤销它")
    _users.audit(user["username"], "link_revoke", token, "")
    return {"ok": True}


@router.post("/api/links/update")
async def api_links_update(
    request: Request,
    token: str = Form(...),
    note: str = Form(None),
    ttl_days: float = Form(None),
    max_visits: int = Form(None),
    password: str = Form(None),
):
    """改备注 / 有效期 / 次数 / 提取码。

    ★ 备注与有效期两类都开放；次数 / 提取码只对分享有意义 ★
      直链**有有效期**（默认 7 天，用户要求「直链 默认 也按7天来」），
      所以 `ttl_days` 对两类都收 —— 「续期」「改为永久」都要能作用在直链上。
      但次数上限 / 提取码是分享特有的，直链传了就是调用方理解错了：
      明确 400 比静默忽略好（静默忽略会让前端以为改成功了）。
    """
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, users as _users

    user = _auth.current_user(request)
    lk = shortlink.get(token)
    if not lk:
        raise _HTTPException(404, "链接不存在")
    if not user.get("is_admin") and lk.owner != user["username"]:
        raise _HTTPException(403, "无权修改该链接")
    if lk.kind != shortlink.KIND_SHARE and (
            max_visits is not None or password is not None):
        raise _HTTPException(400, "直链没有次数 / 提取码，只能改备注与有效期")

    shortlink.update(
        token,
        note=note,
        ttl_days=ttl_days,
        max_visits=max_visits,
        password_hash=None if password is None
        else (_users.hash_password(password) if password else ""),
    )
    _users.audit(user["username"], "link_update", token, "")
    fresh = shortlink.get(token)
    return {"ok": True, "link": fresh.as_dict(origin=_origin(request)) if fresh else None}


@router.post("/api/links/rotate")
async def api_links_rotate(request: Request, token: str = Form("")):
    """**换一条地址**：撤销旧的并立刻签一条新地址（目标与参数不变）。

    ★ 使用场景 ★
      短链免登录、发出去就收不回。真发错了地方（贴到群里、误发），
      用户要的是「换一条继续用」，而不是「把这个文件对外关掉」。
      没有这个接口就得手动两步（撤销 + 重新创建），分享那条还得把
      提取码 / 有效期 / 次数原样再填一遍。

    返回新的 `{ok, link}`；旧地址**立刻失效**。
    """
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, users as _users

    if not token:
        raise _HTTPException(400, "缺少参数：token")
    user = _auth.current_user(request)
    fresh = shortlink.rotate(token, user["username"], bool(user.get("is_admin")))
    if not fresh:
        raise _HTTPException(404, "链接不存在，或你没有权限操作它")
    _users.audit(user["username"], "link_rotate", token, fresh.token)
    return {"ok": True, "link": fresh.as_dict(origin=_origin(request))}


@router.post("/api/links/revoke-dead")
async def api_links_revoke_dead(request: Request):
    """一键清理**已失效的链接**：过期的（两类都会过期）+ 次数用尽的（只有分享）。

    ★ 还剩下的死链怎么处理 ★
      直链指向的文件被删除 ⇒ 链接只是"打不开"，行还在（没到过期时间）。
      那种由 `/f/<token>` 命中「文件真的不存在」时**惰性自清** ——
      不在批量清理里做，因为判"文件真没了"要真去解析路径，映射抖动会误删好链接。
    """
    from .. import auth as _auth, users as _users

    user = _auth.current_user(request)
    n = shortlink.revoke_dead(user["username"])
    if n:
        _users.audit(user["username"], "link_revoke_dead", user["username"], f"{n} 条")
    return {"ok": True, "revoked": n}


@router.post("/api/shortlink/revoke")
async def api_shortlink_revoke(request: Request, token: str = Form("")):
    """旧入口，保留兼容 —— 语义与 `/api/links/revoke` 完全相同。"""
    return await api_links_revoke(request, token)


# ===== UNIFIED LINKS END =====
