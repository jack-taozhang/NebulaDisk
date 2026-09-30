"""Web 层共用工具：访问源推断 / 挂载解析 / 文件流式响应 / **签名直链** / web 目录定位"""

from __future__ import annotations

import hashlib
import hmac
import mimetypes
import sys
import time
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlencode

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse
from . import files
from .config import settings


# ---------------------------------------------------------------------------
# 签名直链（给 OnlyOffice / kkFileView / CAD 这些**服务端**取流用）
# ---------------------------------------------------------------------------
# ★ 为什么放在 webutil 而不是 routers/rawlink.py ★
#   它被三个 router 共用（onlyoffice / preview / cad 都要给外部引擎一个
#   能免会话取流的 URL）。R2 拆分 main.py 时它留在 rawlink.py 里没被复用，
#   结果那三个 router 各自 NameError → **三条预览链路全 500**，
#   而单测与 selfcheck 全绿（只查路由存在、不查处理器能否执行）。
#   ⇒ 共用助手一律放 webutil；rawlink.py 只负责**提供** /api/raw 这个端点。
def _raw_token(mount: str, path: str, exp: int, dl: bool = False) -> str:
    """HMAC(secret, "mount\\npath\\nexp\\ndl")。签名与校验必须共用这一份。

    ★ dl 维度（T1，2026-09-23）★
      /api/raw 现在既能「内联打开」也能「强制下载」。如果 dl 不进签名，
      那么任何人都能把一条 inline 链接手改成 dl=1 强行触发下载
      —— 拿到的仍是同一条链接里的同一个文件，危害有限，
      但等于放弃了「签名覆盖该 URL 全部语义」这条规则。
      所以把 dl 并入签名串，v1（三字段）与 v2（四字段）同时接受，
      且 v1 只允许 dl=False —— 旧链接照旧可用，旧签名则无法伪造下载。
    """
    raw = f"{mount}\n{path}\n{exp}\n{1 if dl else 0}"
    return hmac.new(settings.jwt_secret.encode(), raw.encode(), hashlib.sha256).hexdigest()


def _raw_token_v1(mount: str, path: str, exp: int) -> str:
    """旧格式（三字段）签名，仅为向后兼容保留。

    OnlyOffice / kkFileView / CAD 可能已经把 URL 缓存/落盘（编辑器里存了
    一段时间），升级后我们要继续认这些老链接。它**不携带 dl 维度**，
    因此只允许用于 inline 取流（见 rawlink.api_raw 的校验分支）。
    """
    raw = f"{mount}\n{path}\n{exp}"
    return hmac.new(settings.jwt_secret.encode(), raw.encode(), hashlib.sha256).hexdigest()


def make_raw_url(mount: str, path: str, ttl: int = 3600, download: bool = False) -> str:
    """构造免登录取流地址。

    ★ 为什么把文件名放进 URL **路径**而不是只放查询串 ★
      kkFileView 判断文件类型的方式是「对 url 字符串取最后一个 . 之后的内容」。
      如果我们只给 /api/raw?mount=..&path=/readme.md&exp=1789882982&sig=..，
      它的 lastIndexOf(".") 会命中 exp 里的小数点，截出一个非法区间，
      抛 StringIndexOutOfBoundsException，前端只看到
      「系统还不支持该格式文件的在线预览」——极难排查。
      把文件名作为路径尾巴（/api/raw/readme.md?mount=...）后，
      后缀解析就正常了。文件名只用于「取后缀」，鉴权仍靠签名，不参与安全判断。
    """
    exp = int(time.time()) + ttl
    tok = _raw_token(mount, path, exp, dl=download)
    q = urlencode({"mount": mount, "path": path, "exp": exp, "sig": tok})
    if download:
        # ★ dl=1 必须显式出现在 URL 上 ★
        #   签名里带了 dl 维度，取流端也要从 query 里读出同一个值才能复算。
        #   漏了这一行 ⇒ 签名按 dl=True 算、校验按 dl=False 算 ⇒ 恒 403。
        q += "&dl=1"
    tail = PurePosixPath(path).name or "file.bin"
    return f"{_internal_origin()}/api/raw/{quote(tail)}?{q}"


# ---- web 目录（模板与静态资源）。放在这里是因为三处都要用它 ----
WEB_DIR = Path(__file__).resolve().parent.parent / "web"


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def _origin(request: Request) -> str:
    """推断**浏览器侧**访问源，用于拼浏览器要访问的绝对地址。

    ★ 这里绝对不能用 NEBULA_BASE_URL ★
      NEBULA_BASE_URL 是给**容器内其它服务**（OnlyOffice / kkFileView）用的，
      典型值是 http://nebula:8088 —— 那是 docker 网络里的名字，
      **浏览器根本解析不了**。

      曾经这里有 `if settings.base_url: return settings.base_url`，
      后果是 kkFileView 拿到的 X-Base-Url 变成 http://nebula:8088/preview，
      于是 DWG 预览页里 `var url = 'http://nebula:8088/preview/xxx.svg'`，
      浏览器请求该地址直接 DNS 失败 →
      **CAD 预览永远卡在「正在加载SVG...」**（而服务端一切正常、SVG 也已生成）。
      这个 bug 极隐蔽：转换成功、接口 200、日志无错，只有浏览器里打不开。

    正确来源是**本次真实请求**的 Host —— 它天然就是浏览器用的那个地址
    （含端口），反代场景下再由 X-Forwarded-Host/Proto 修正。
    """
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if not host:
        host = request.url.netloc
    return f"{proto}://{host}"


def _internal_origin() -> str:
    """外部引擎（OnlyOffice 容器）访问本服务的基地址。

    ★ 这个值必须填「OnlyOffice 容器能解析到的地址」，例如 http://nebula:8088 ★
      OnlyOffice 是**从它自己的容器里**去 GET 文档的，不是浏览器发的请求。
      所以：
        - 填 http://127.0.0.1:8088 → OnlyOffice 容器里的 127.0.0.1 是它自己，
          回拉必然失败（表现为编辑器一直转圈 / 报「下载文件失败」）。
        - 填宿主机 IP:8089    → 容器里未必有到宿主机的路由，也可能失败。
      正确做法是填容器名 + 容器端口（compose 服务名 nebula，端口 8088）。
    """
    if settings.base_url:
        return settings.base_url
    base = "http://127.0.0.1:8088"
    print(
        "[main] ⚠️ NEBULA_BASE_URL 未配置，raw 直链回退到 "
        f"{base}。\n"
        "[main]    该地址仅供 kkFileView（同容器）使用没问题；\n"
        "[main]    但 OnlyOffice 在**另一个容器**里，它无法回拉这个地址，\n"
        "[main]    编辑器会打不开文件。请设置 NEBULA_BASE_URL=http://nebula:8088",
        file=sys.stderr,
    )
    return base


# ===========================================================================
# 鉴权
# ===========================================================================


def _mount(username: str, label: str):
    return files.get_mount(label, username)




def probe_readable(p: Path) -> None:
    """探测「文件内容是不是真的读得出来」；读不出来就抛 503。

    ★★ 为什么必须有这一步（2026-09-30，用户报「本机 OO 打开文件有问题」）★★
      Windows 上的**云端占位文件**（OneDrive / Nextcloud 等按需同步的文件、
      脱机文件）会出现一种极坑的组合：

        stat()   → 报出真实大小（实测 42943 字节）
        read()   → 读到 **0 字节**（或直接 EIO）

      WSL 的 drvfs/9p 挂载尤其明显：连 `dd if=… of=/dev/null` 都只拿到 0 字节，
      而本项目的 `/mnt/d` 就是把 WSL 的 drvfs 再 bind 进容器 ⇒ 容器内同样读不出。

      **不做这一步的后果（全部实测）**：
        `FileResponse` 先按 stat 发出 `Content-Length: 42943`，然后一个字节
        也发不出去 ⇒ 客户端拿到「HTTP 200 + 0 字节」。
          · OnlyOffice：转圈约 20 秒后报「下载文件失败」，
            OO 容器日志 `error downloadFile … ESOCKETTIMEDOUT`；
          · kkFileView：预览页一直转圈；
          · 服务端只留一条 ASGI 层的
            `RuntimeError: Response content shorter than Content-Length`
            —— 看不出是哪个文件、更看不出「是文件读不出来」。
        排查时就是从「OO 打不开」一层层穿过这些假象，才落到文件本身。

      ⇒ 先只读 1 个字节：
          读得到        → 正常返回，走 FileResponse（多一次 pread，代价可忽略）；
          读不到 / OSError → 503 + 人话，让日志和调用方一眼看懂。

    ⚠️ 空文件（size == 0）是合法的，直接放行 —— 不能把它和"读不出来"混为一谈。
    """
    try:
        st = p.stat()
    except OSError as e:
        raise HTTPException(503, f"无法读取文件信息：{e.strerror or e}") from e
    if st.st_size <= 0:
        return

    _HINT = (
        "常见于**云端占位文件**（OneDrive / Nextcloud 等按需同步的文件）"
        "或脱机文件：路径与大小都在，内容却读不出来。"
        "请先在 Windows 侧把它设为「始终保留在此设备上 / 下载到本地」再试。"
    )
    try:
        with open(p, "rb") as fh:
            head = fh.read(1)
    except OSError as e:
        print(f"[stream] ❌ 读不出内容 {p}：{type(e).__name__}: {e}", file=sys.stderr)
        raise HTTPException(503, f"文件内容不可读（{e.strerror or e}）。{_HINT}") from e
    if not head:
        print(f"[stream] ❌ 读出 0 字节 {p}（stat 报 {st.st_size} 字节）",
              file=sys.stderr)
        raise HTTPException(
            503, f"文件内容不可读（读到 0 字节，但大小是 {st.st_size} 字节）。{_HINT}")


def _stream_file(p: Path, download: bool = False, filename: str | None = None):
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    # ★ 所有取流路径（/api/raw、/api/download、/f/<token>、分享落地页…）都过这里 ★
    #   所以探测放在这一层：一处修，五条链路一起受益。
    probe_readable(p)
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    if download:
        mime = "application/octet-stream"
        disp = "attachment"
    else:
        disp = "inline"
    name = filename or p.name
    headers = {
        "Content-Disposition": f"{disp}; filename*=UTF-8''{quote(name)}",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, no-cache",
    }
    return FileResponse(str(p), media_type=mime, headers=headers)
