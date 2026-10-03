# -*- coding: utf-8 -*-
"""
NebulaDisk —— 外部引擎集成（OnlyOffice / kkFileView）

## OnlyOffice 的调用模型（务必先理解再改）

它不是一个「前端组件」，而是**三个角色互相拉取**：

    浏览器 ──①加载编辑器──▶ OnlyOffice 容器
       │                        │
       │                        │ ②OnlyOffice 主动 GET 文档
       │                        ▼
       │                   云盘 /api/raw/<...>   ← 必须是 OnlyOffice 可达的 URL
       │                        │
       └──③编辑完成后───────────┘
              OnlyOffice 主动 POST 回 callbackUrl
              ▼
           云盘 /api/oo/callback → 把新文档写回磁盘

关键推论：
  * `document.url` 和 `callbackUrl` 里的主机名，必须是**从 OnlyOffice 容器里
    能解析并连通的地址**。用 localhost 或浏览器侧域名都会失败。
  * 签名算法：把整个 config 对象（去掉 token 字段本身）做 JSON 序列化后
    HS256 签名。序列化必须紧凑且 ensure_ascii=False，否则签名对不上。
  * 回调里 OnlyOffice 只在 status==2 或 6 时给出可下载的 url，
    其余状态（1 编辑中、4 无改动关闭、7 强制保存失败）不要动文件。
"""

from __future__ import annotations

import json
import sys
import ipaddress
from urllib.parse import quote, urlencode, urlsplit

import httpx

from .auth import jwt_encode
from .config import settings


# ---------------------------------------------------------------------------
# kkFileView 预览地址拼装
# ---------------------------------------------------------------------------
def kk_preview_url(base: str, raw_url: str) -> str:
    """拼 kkFileView onlinePreview 地址。

    ⚠️ 两个必须记住的点（上一阶段实测踩过）：
      1. `url` 参数要做 **Base64 + urlEncode 双重编码**：
         kkFileView 的 WebUtils.decodeUrl() 会无条件 base64 解码。
      2. kkFileView 4.4+ 默认开启 SSRF 白名单（trust.host），
         传入的域名必须在白名单里，否则直接拒绝。
    """
    import base64

    b64 = base64.b64encode(raw_url.encode("utf-8")).decode("ascii")
    return f"{base}/onlinePreview?" + urlencode({"url": b64})


# ---------------------------------------------------------------------------
# 轻量外壳页 /lite 的地址拼装 —— 也就是「页面嵌入块」的预览形态
# ---------------------------------------------------------------------------
def lite_shell_url(kind: str, target: str, title: str = "") -> str:
    """把一个同源预览页包进 /lite 外壳，得到「嵌入块」形态的地址。

    ★ 为什么要有它（2026-09-30 用户明确要求）★
      用户原话：「DWG预览 应该用 页面嵌入块的预览模式」。
      直接打开 `/cad/?open=…` 是一整台 CAD 程序：顶部功能区（文件/视图/插入…）、
      右侧垂直工具条、底部命令行 + 状态栏全在。而分享页的读者多半在手机/微信里，
      那套 UI 既点不准又占地方。
      这个问题**思源插件的嵌入块**早就解决过：走 /lite 外壳，由 pages.py 的
      _LITE_HIDE 用一段 CSS 把那些块收掉，只剩图纸本身。

    ★ 为什么在**后端**拼，而不是让前端自己包 ★
      网盘（/api/cad/preview）与分享页（/api/s/<token>/preview）两条腿必须一致，
      各自在前端拼一遍就是两份真相，迟早漂移（这次的前提就是"两边要一样"）。

    ⚠️ target 必须整串 urlEncode ⚠️
      它自己带 `?` 与 `&`，不编码会被 /lite 自己的 query 吃掉。
      /lite 只收「本机相对路径」（见 lite_shell 的校验）：不能是绝对地址。
      而 inner 里的地址本身已 urlencode 过（`:` → `%3A`、`/` → `%2F`），
      所以解出来也不含字面 `//` 或 `:` —— 二次编码后仍然合规。
    """
    q = {"kind": kind, "target": target}
    if title:
        q["title"] = title
    return "/lite?" + urlencode(q)


# ---------------------------------------------------------------------------
# OnlyOffice 配置生成
# ---------------------------------------------------------------------------
def _sign(cfg: dict) -> str:
    """对 config 做 HS256 签名（OnlyOffice 的标准做法）。"""
    payload = json.dumps(cfg, separators=(",", ":"), ensure_ascii=False)
    # 用一个空 header 之外的直接签名并不符合规范；OnlyOffice 接受完整 JWT，
    # 其 payload 就是 config 本身。
    return jwt_encode(json.loads(payload), settings.oo_secret)


def build_editor_config(
    *,
    file_key: str,
    title: str,
    doc_url: str,
    callback_url: str,
    mode: str,              # "edit" | "view"
    user_id: str,
    user_name: str,
    lang: str = "zh-CN",
    embed: bool = False,
    editor_type: str = "desktop",   # ★ desktop | mobile（移动端布局，2026-10-03）
) -> dict:
    """生成 OnlyOffice DocsAPI config 对象（含 token）。

    embed=True ⇒ 嵌入块精简版：签名**之前**把 customization 换成
    「隐藏顶部工具栏 + 左右侧栏」的配置（2026-09-24 需求）。
    页签打开时不传 embed，保持完整工具栏。
    """
    ext = title.rsplit(".", 1)[-1].lower() if "." in title else "docx"

    customization = {
        "autosave": True,
        "forcesave": True,
        "compactHeader": True,
        "hideRightMenu": False,
        "uiTheme": "theme-light",
        # ---- 关掉 OnlyOffice 自带的面板（2026-09-22）----
        # 现象：编辑器左侧多出一条窄栏（插件 / 反馈&支持），
        #       右侧才是文档，看着像「两个画面」。
        # 这是 OO 自己的内置面板，不是调用方的布局。
        # 本来想在前端（思源插件）里改这两个字段，但**不行**：
        #   下面 `cfg["token"] = _sign(cfg)` 是对**整份 config 签名**的，
        #   前端再动任何字段都会让 token 与内容不一致 → OO 拒绝配置。
        #   而 compose 里 JWT_ENABLED=true，token 是强校验。
        # 所以只能在这里（签名之前）加，然后重建镜像。
        "plugins": False,     # 左栏「插件」面板
        "leftMenu": False,    # 左栏菜单
        "about": False,       # 「关于」
        "feedback": False,    # 「反馈 & 支持」
    }

    if embed:
        # ---- 嵌入块精简 UI（2026-09-24，两轮修正）----
        #
        #   【第一轮教训】layout（customization.layout）是 OnlyOffice
        #   **Developer Edition 付费功能**：社区版源码里被 canBrandingExt
        #   双重拦截（LayoutManager._applyCustomization 的 !_licensed 短路 +
        #   Main.js hidePreloader 里 if (canBrandingExt) 才调 applyCustomization）。
        #   配置写得再对，社区版也直接忽略 ⇒ 用户实测「还是有工具条」。
        #   不能改 OO 容器代码绕过 license 检查（破解付费功能）。
        #
        #   【正解】type="embedded"（官方内嵌查看器）：
        #   api.js 对 type=embedded 加载 /web-apps/apps/<app>/embed —— 天生
        #   无顶部工具栏、无左右侧栏，只有极简查看 UI。代价：**只读**，
        #   嵌入块里不能编辑（编辑走页签，页签仍是完整编辑器）。
        customization.update({
            "hideRightMenu": True,
            "layout": {
                "toolbar": False,
                "leftMenu": False,
                "rightMenu": False,
                "statusBar": False,
            },
        })

    cfg: dict = {
        "documentType": _doc_type(ext),
        "document": {
            "fileType": ext,
            "key": file_key,
            "title": title,
            "url": doc_url,
            "permissions": {
                "edit": mode == "edit",
                "download": True,
                "print": True,
                # 关闭「另存为」可减少用户把副本写回导致的状态混乱
                "copy": True,
            },
        },
        "editorConfig": {
            "mode": mode,
            "lang": lang,
            "callbackUrl": callback_url,
            "user": {"id": user_id, "name": user_name},
            "customization": customization,
        },
    }

    if embed:
        # type 是 config 顶层键（与 documentType 平级），必须在签名前、
        # cfg 建好之后设置 —— 见上方 embed 分支注释（embedded=官方无工具栏查看器）。
        cfg["type"] = "embedded"
    else:
        # ★★ 移动端用 `mobile` 布局（2026-10-03）★★
        #
        #  背景：手机（飞牛 App 的 webview）打开 Office 文件，OnlyOffice 弹
        #        「下载失败」，而电脑完全正常。日志上的现象是：
        #          手机把编辑器 UI 的 378 个资源全下来了、WS 也通了（~2KB 下行），
        #          **但从不请求文档数据**（`/cache/files/**/Editor.bin` 0 条，
        #          同期电脑 8 条）⇒ 编辑器拿不到文档 ⇒ 报 -4「下载失败」。
        #        OO 服务端侧一切正常（`/api/oo/callback` 一直 status=1「文档已打开」）。
        #
        #  这里不设 type 时，OO 默认按 **desktop** 装配编辑器 —— 那套 UI 是给
        #  大屏 + 鼠标设计的（完整工具栏 / 状态栏 / 右键菜单 / 大量 DOM），
        #  在手机 webview 里初始化路径不同、开销也大。
        #  改成官方支持的 `mobile`（api.js 会加载移动端布局）就是为了让手机
        #  走它自己的那条初始化路径，把"不请求文档"这一步带过去。
        #
        #  ⚠️ 必须在 `_sign(cfg)` **之前**设置：token 覆盖整份 config，
        #     签名后再动任何字段 OO 都会拒（见上面 customization 的注释）。
        #  ⚠️ embed 分支优先：嵌入块（思源插件）走的仍是 embedded，
        #     不受移动端判定影响。
        cfg["type"] = editor_type

    if settings.oo_secret:
        cfg["token"] = _sign(cfg)
    else:
        print("[onlyoffice] 未配置 NEBULA_OO_SECRET，token 缺失，编辑器将报错",
              file=sys.stderr)

    return cfg


def _doc_type(ext: str) -> str:
    """OnlyOffice 的三分法：word / cell / slide。"""
    if ext in {"xls", "xlsx", "xlsm", "xlt", "xltx", "xltm", "ods", "ots", "csv", "fods"}:
        return "cell"
    if ext in {"ppt", "pptx", "pptm", "pot", "potx", "potm", "odp", "otp", "fodp"}:
        return "slide"
    return "word"


def file_key(mount_label: str, rel: str, mtime: int, size: int) -> str:
    """生成 OnlyOffice 的 document key。

    要求：同一份文档在编辑期间 key 必须**保持不变**，改动后要**变化**，
    否则 OnlyOffice 会命中旧缓存、用户看到编辑前的内容。
    这里用 mtime+size 参与哈希：内容一变 key 就变，非常可靠。
    """
    import hashlib

    raw = f"{mount_label}|{rel}|{mtime}|{size}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:32]


# ---------------------------------------------------------------------------
# 回调下载新版本
# ---------------------------------------------------------------------------
async def fetch_edited(url: str, dest_path: str) -> int:
    """从 OnlyOffice 给的临时地址下载编辑后的文档，覆盖写入。

    用 .part 临时文件 + rename，避免下载中断把原文件损坏。
    """
    tmp = dest_path + ".nebula.part"
    total = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0), follow_redirects=True) as cli:
        async with cli.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(tmp, "wb") as f:
                async for chunk in resp.aiter_bytes(1024 * 256):
                    f.write(chunk)
                    total += len(chunk)

    import os

    os.replace(tmp, dest_path)
    return total


def oo_public_base(request_origin: str) -> str:
    """浏览器加载 api.js 用的地址（**必须浏览器可达**）。

    ★ 2026-10-03 修掉回退次序 bug ★
      原实现：`return settings.oo_public or (settings.oo_url or "") or request_origin`

      `oo_url` 是**容器内**地址（如 http://onlyoffice:80），浏览器永远不可达。
      它在链上 ⇒ `oo_public` 一旦留空，算出来就是那个容器内名，必然加载失败；
      而 `request_origin`（本该是最正确的**同源**选项）**永远轮不到**。

      改成 `oo_public or request_origin`：
        · oo_public 留空 ⇒ 自动同源（配合 routers/onlyoffice.py 里的根级反代，
          api.js 变成 {当前访问源}/web-apps/... ，HTTP/HTTPS、任意地址都成立）
        · 想指定绝对地址（老行为）⇒ 照旧在设置里填 oo_public

    ★ 2026-10-03 追加：**直连优先**（性能回退修复）★
      背景：把 `oo_public` 清空改成"永远同源"之后，OO 编辑器冷启动那 250+ 个请求
      全部落到本应用这个**单进程 Python 反代**上，实测把原来的"秒开"拖成 ~25s。
      （OO 原生 nginx 处理这些请求是毫秒级的，Python 追不上。）

      所以回退链改成三级：
        ① `settings.oo_public` 显式配了 ⇒ 用它（老行为，最高优先级）
        ② 能推出**浏览器可直连**的 OO 地址 ⇒ 用它（快，见 _oo_direct_origin）
        ③ 都不行 ⇒ 同源（走自己的反代；慢但 HTTP/HTTPS/任意地址都能用）
    """
    if settings.oo_public:
        return settings.oo_public
    return _oo_direct_origin(request_origin) or request_origin


def _oo_direct_origin(request_origin: str) -> str:
    """由"当前访问源"推一个**浏览器能直连**的 OO 地址；推不出就返回 ""。

    成立条件（**必须全满足**，缺一不可 —— 推错会让编辑器直接白屏）：
      · 配了 `settings.oo_direct_port`（空 = 关闭该优化）
      · 访问是 **http**：https 页面去加载 http 资源会被"混合内容"拦掉
      · host 是 **IP 字面量或 localhost**：域名的情况无法假定 :<port> 也被
        映射到 OO 上（FN Connect 之类就是这样）⇒ 宁可慢，也不能把地址指向不存在的地方
      · 端口不能等于当前访问端口（否则等于把自己指回自己，成环）
    """
    port = (settings.oo_direct_port or "").strip()
    if not port:
        return ""
    try:
        sp = urlsplit(request_origin)
    except ValueError:
        return ""
    if sp.scheme != "http" or not sp.hostname:
        return ""
    host = sp.hostname
    if host.lower() != "localhost":
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return ""      # 是域名 ⇒ 不敢假定端口被映射，回退同源
    try:
        if sp.port == int(port):
            return ""
    except ValueError:
        return ""
    return f"http://{host}:{port}"


def oo_internal_base() -> str:
    """云盘后端调 OnlyOffice 用的地址（一般同 oo_url）。"""
    return settings.oo_url.rstrip("/")


async def check_oo_health() -> dict:
    """探活，用于前端显示 OnlyOffice 是否可用。"""
    if not settings.oo_url:
        return {"ok": False, "reason": "未配置"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as cli:
            r = await cli.get(f"{oo_internal_base()}/healthcheck")
            return {"ok": r.status_code == 200, "status": r.status_code}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)[:120]}


async def check_kk_health() -> dict:
    """探活 kkFileView，用于前端显示「在线 / 离线」。

    和 OnlyOffice 一样做成**实时探测**，而不是写死「已内置」——
    kkFileView 是同一个容器里的独立 java 进程（supervisord 管着），
    它完全可能单独挂掉，此时写死的「已内置」会骗人。
    """
    base = (settings.preview_url or "").rstrip("/")
    if not base:
        return {"ok": False, "reason": "未配置"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as cli:
            # ★ 候选探活端点，按顺序取第一个返回 200 的 ★
            #   ① /actuator/health —— Spring Boot Actuator 健康端点。
            #      ⚠️ 实测：本项目用的 kkFileView 4.1.0 的 jar 里
            #      **完全不含 actuator**（`unzip -l` 搜 "actuate" = 0 条），
            #      该端点恒 404 ⇒ 不能作为唯一探针。
            #   ② /index —— 演示页，裸请求恒 200。这是 4.1.0 上**可靠**的那个。
            #      千万不要用 /onlinePreview —— 它对不带 url 参数的请求返回 **403**
            #      （kkFileView 的信任主机校验），拿它探活会永远显示「离线」。
            for path in ("/actuator/health", "/index"):
                r = await cli.get(f"{base}{path}")
                if r.status_code == 200:
                    return {"ok": True, "status": r.status_code, "probe": path}
            return {"ok": False, "status": r.status_code}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)[:120]}


async def check_cad_health() -> dict:
    """探活 CAD 查看器（独立服务），用于前端显示「在线 / 离线」。

    探针用 cad_probe（容器间地址），不用 cad_url（浏览器地址）——
    后者可能是 /cad 这种相对反代路径，从容器内根本发不出去。

    ★ 返回里带上 version 与 formats ★
      前端「此电脑」的服务卡片不只显示「在线」，还显示内核版本与支持的格式。
      原因：用户易把 3D 模型（3dm/stl/step）与 CAD 图纸（dwg/dxf）混为一谈，
      而本服务**只认 dwg/dxf**。把 formats 明明白白列出来，
      能省掉"为什么我的 step 打不开"这类误判。
    """
    base = (settings.cad_probe or settings.cad_url or "").rstrip("/")
    if not base:
        return {"ok": False, "reason": "未配置"}
    if base.startswith("/"):
        # 配成了相对路径：本容器无法直接探活，只能认为不可用。
        # 这是配置问题，明确报出来，不要静默通过。
        return {"ok": False, "reason": "NEBULA_CAD_PROBE 必须是容器可达的绝对地址"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as cli:
            # cad-viewer 自带 /health（见其 server.cjs），裸请求返回 200 + {"ok":true}
            r = await cli.get(f"{base}/health")
            ok = r.status_code == 200
            info: dict = {}
            try:
                info = r.json()
                ok = ok and bool(info.get("ok"))
            except Exception:  # noqa: BLE001
                pass
            out = {
                "ok": ok,
                "status": r.status_code,
                # 支持格式写死在这里而不是去探测：cad-viewer 的前端 bundle 只注册
                # 了 .dwg/.dxf（已 grep 验证），这是它的能力边界，不是可配置项。
                "formats": ["dwg", "dxf"],
            }
            if isinstance(info.get("version"), str):
                out["version"] = info["version"]
            if isinstance(info.get("uptime"), (int, float)):
                out["uptime"] = int(info["uptime"])
            return out
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": str(e)[:120]}
