"""免登录取流端点 `/api/raw/{filename}` —— 只负责**提供**这条通道。

★ 签名与 URL 构造（`_raw_token` / `make_raw_url`）**不在这里** ★
  它们被 onlyoffice / preview / cad 三个 router 共用，所以放在 `..webutil`。
  R2 把 main.py 拆成 routers 包时，这两个函数留在了本文件里而另外三个
  router 没有导入它们 → 三个 handler 各抛 NameError → **OnlyOffice、CAD、
  kkFileView 三条预览链路全部 500**，而单测与 selfcheck 全绿
  （它们只校验「路由存在」，不校验「处理器能否执行」）。
  现在：共用助手一律进 webutil，本文件只 import。
"""

from __future__ import annotations

import hmac
import time

from fastapi import APIRouter, HTTPException
from .. import files
from ..config import settings
from ..webutil import _raw_token, _raw_token_v1, _stream_file


router = APIRouter()


# ---------------------------------------------------------------------------
# 免登录 raw 通道（给 OnlyOffice / kkFileView / CAD 反拉）
# ---------------------------------------------------------------------------
# 为什么需要它：
#   OnlyOffice 是用**服务端**去 GET 文档的，它带不了用户的会话 Cookie。
#   所以给一个签名 URL：token = HMAC(secret, mount+path+exp)，有效期短。
#   这比把整个目录开放给匿名访问安全得多 —— 单个链接只对一个文件有效、且会过期。
# ★ 下载语义的查询参数（T1，2026-09-23）★
#
#   /api/raw/...?dl=1                ⇒ 强制下载（Content-Disposition: attachment）
#   /api/raw/...?inline=0|false|off|no ⇒ 同上（兼容常见的另一个参数名）
#   不带 / 为真                      ⇒ 内联打开（默认，OnlyOffice/kkFileView/CAD 依赖它）
#
#   为什么默认必须是 inline：
#     这三个外部引擎都是用**服务端**去 GET 这个 URL 来取文件再渲染的。
#     一旦默认变成 attachment，它们的取流行为会退化（kk 会去走下载分支），
#     三条预览链路一起坏 —— 属于「改一个默认值炸三个功能」的典型。
_DL_FALSE_VALUES = {"0", "false", "off", "no", "n"}


def _wants_download(dl: str | None, inline: str | None) -> bool:
    """从 query 里解析「是否强制下载」。dl 优先，其次 inline。"""
    if dl is not None and str(dl).strip() != "":
        v = str(dl).strip().lower()
        return v not in _DL_FALSE_VALUES
    if inline is not None and str(inline).strip() != "":
        v = str(inline).strip().lower()
        # inline 是「反向」参数：inline=1 ⇒ 不下载；inline=0 ⇒ 下载
        return v in _DL_FALSE_VALUES
    return False


@router.get("/api/raw/{filename}")
async def api_raw(
    filename: str, mount: str, path: str, exp: int, sig: str,
    dl: str | None = None, inline: str | None = None,
):
    """免登录取流。filename 仅为让下游能正确识别扩展名，不参与鉴权。

    ★ 两个语义共用一个端点（T1，2026-09-23）★
      · 预览栏「复制直链」要的是**下载**链接（用户明确要求）
      · 右键菜单「复制直链」要的是**打开**链接（用户明确要求，保持原样）
      两者文件名、签名格式都一样，只差一个 dl 标记；用同一个端点最省事，
      也避免了再开一条无会话通道（多一条通道就多一份签名校验代码要维护）。
    """
    if exp < int(time.time()):
        raise HTTPException(403, "链接已过期")

    want_dl = _wants_download(dl, inline)

    # ★ 签名校验：v2（含 dl 维度）优先，v1（旧三字段）仅放行 inline ★
    #   顺序不能反：v1 校验不看 dl，如果先过 v1，就等于给了旧签名
    #   伪造 dl=1 的能力，那 v2 白加了维度。
    if hmac.compare_digest(_raw_token(mount, path, exp, dl=want_dl), sig):
        pass
    elif not want_dl and hmac.compare_digest(_raw_token_v1(mount, path, exp), sig):
        # 旧链接（OnlyOffice/kkFileView 可能还攥着）→ 只允许内联取流
        pass
    else:
        raise HTTPException(403, "签名校验失败")

    # 走第一个可见此映射的用户上下文（raw 通道无会话，按映射本身的可见性放行）
    target = None
    for m in settings.mounts:
        if m.label == mount:
            target = m
            break
    if target is None:
        raise HTTPException(404, "映射不存在")

    p = files.resolve(target, path)
    return _stream_file(p, download=want_dl)
