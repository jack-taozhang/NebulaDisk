"""文件操作：列目录 / 新建 / 改名 / 删除 / 移动 / 解压 / 上传 / 属性 / 下载"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from .. import auth, files, shares, users
from ..config import settings
from ..webutil import _mount, _stream_file
import os
router = APIRouter()

@router.get("/api/list")
async def api_list(mount: str, path: str = "", user: dict = Depends(auth.current_user)):
    m = _mount(user["username"], mount)
    return files.list_dir(m, path, user["username"])


@router.post("/api/mkdir")
async def api_mkdir(
    mount: str = Form(...), path: str = Form(""), name: str = Form(...),
    user: dict = Depends(auth.current_user),
):
    m = _mount(user["username"], mount)
    r = files.mkdir(m, path, name)
    users.audit(user["username"], "mkdir", f"{mount}:{path}/{name}")
    return r


@router.post("/api/rename")
async def api_rename(
    mount: str = Form(...), path: str = Form(...), name: str = Form(...),
    user: dict = Depends(auth.current_user),
):
    m = _mount(user["username"], mount)
    r = files.rename(m, path, name)
    users.audit(user["username"], "rename", f"{mount}:{path}", f"-> {name}")
    # ★ 改名后旧分享路径已失效 → 清掉 ★
    #   否则用户会看到"分享记录还在，但链接打不开"——比直接消失更困惑。
    n = shares.revoke_under_path(user["username"], mount, path)
    if n:
        users.audit(user["username"], "share-invalidate", f"{mount}:{path}", f"{n} 条随改名失效")
    return r


@router.post("/api/delete")
async def api_delete(
    mount: str = Form(...), path: str = Form(...),
    user: dict = Depends(auth.current_user),
):
    m = _mount(user["username"], mount)
    files.delete(m, path)
    # ★ 顺手失效指向它的分享 ★
    #   否则"文件已删除，但旧分享链接还能下载"——既像 bug 又是信息泄漏。
    #   用 revoke_under_path：删目录时它下面所有分享都要一并清掉。
    n = shares.revoke_under_path(user["username"], mount, path)
    if n:
        users.audit(user["username"], "share-invalidate", f"{mount}:{path}", f"{n} 条随删除失效")
    users.audit(user["username"], "delete", f"{mount}:{path}")
    return {"ok": True, "sharesRevoked": n}


@router.post("/api/move")
async def api_move(
    mount: str = Form(...), path: str = Form(...), target: str = Form(...),
    move: bool = Form(True),
    user: dict = Depends(auth.current_user),
):
    m = _mount(user["username"], mount)
    r = files.copy_or_move(m, path, target, move=move)
    users.audit(user["username"], "move" if move else "copy", f"{mount}:{path}", f"-> {target}")
    return r


@router.post("/api/extract")
async def api_extract(
    mount: str = Form(...),
    path: str = Form(...),
    dest: str = Form(""),
    overwrite: bool = Form(False),
    user: dict = Depends(auth.current_user),
):
    """解压压缩包。dest 为空时解到同目录的「压缩包主名」文件夹。

    需求（原文）：「集成右键对压缩文件解压功能。」
    走的是 files.extract_archive（内含 zip-slip 防护与体积上限）。
    """
    m = _mount(user["username"], mount)
    r = files.extract_archive(m, path, dest_rel=(dest or None), overwrite=overwrite)
    users.audit(user["username"], "extract", f"{mount}:{path}",
                f"-> {r.get('dir')} ({r.get('files')} 个文件)")
    return r


@router.post("/api/upload")
async def api_upload(
    mount: str = Form(...),
    path: str = Form(""),
    file: UploadFile = File(...),
    user: dict = Depends(auth.current_user),
):
    m = _mount(user["username"], mount)
    size = getattr(file, "size", None) or 0
    if size and size > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"文件超过 {settings.max_upload_mb}MB 限制")

    r = files.save_upload(m, path, file.filename or "upload.bin", file.file)
    users.audit(user["username"], "upload", f"{mount}:{path}/{r['name']}", f"{r['size']}B")
    return r


@router.get("/api/stat")
async def api_stat(mount: str, path: str, user: dict = Depends(auth.current_user)):
    m = _mount(user["username"], mount)
    return files.stat_of(m, path)


# ===========================================================================
# 取流（内部引擎用）
# ===========================================================================
def _stream_file(p: Path, download: bool = False, filename: str | None = None):
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
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


@router.get("/api/download")
async def api_download(
    mount: str, path: str, inline: bool = False,
    user: dict = Depends(auth.current_user),
):
    m = _mount(user["username"], mount)
    p = files.resolve(m, path)
    return _stream_file(p, download=not inline)


# ===== NB SEARCH (task21/task24) =====
#   ★ task24 修复说明（2026-09-23）★
#
#   老实现有两个致命问题，用户报的是「所有的搜索功能结果都是不对的」：
#
#   ① ★ 在**采集阶段**就按 cap 截断 ★
#        `if len(hits) >= cap: break` 一旦凑够 500 条就彻底停止遍历，
#        而这 500 条是 **os.walk 的顺序**（≈目录自然顺序）里最先遇到的，
#        之后再 `hits.sort()` 排序 —— 于是用户看到的是
#        「500 条按字母排好的、看起来很像全量」的**任意子集**。
#        用户明知存在的文件（比如深层目录里的）根本不会出现，
#        而且没有任何提示能让他知道「还有 4000 条没给你」。
#        实测：盘上真实 4520 个 pdf，接口只返回 500 条且 truncated=True。
#
#   ② ★ 没有分页、没有真实总数 ★
#        超限后剩下的命中**永远拿不到**。用户只能缩小关键词反复猜。
#
#   新实现：
#     · 遍历**不因 hits 数量提前退出**，只在 scanned 触顶时停（防爆）。
#     · 收集到 `_SEARCH_MAX_COLLECT` 条上限后仍继续**计数**（total），
#       但不再存对象（省内存），这样 total 是真数。
#     · 排序后再 slice(offset, offset+limit) ⇒ 分页稳定可复现。
#     · 排序改成**相关性优先**：完全同名 > 前缀命中 > 子串命中，
#       再按「目录在前、名字升序」。
#     · 返回 offset/limit/total/hasMore，前端可翻页。

_SEARCH_MAX_HITS = 500
_SEARCH_MAX_DEPTH = 24
_SEARCH_MAX_SCANNED = 200000
# 单次请求最多「记住」多少条命中对象（再多的只计数不保存，避免吃内存）。
_SEARCH_MAX_COLLECT = 5000


def _search_terms(raw: str) -> list:
    """把输入解析成一组「小写子串」，与前端 tree.js 的 _filterTerms 保持一致。

      · 逗号 / 竖线 / 中文逗号 / 空格 都是分隔符（OR）
      · 全部转小写
      · 通配 "*.png" 去掉 "*." 只留 "png"
    """
    out = []
    seen = set()
    for part in str(raw or "").replace("|", ",").replace("\uFF0C", ",").split():
        for seg in part.split(","):
            t = seg.strip().lower()
            if not t:
                continue
            if t.startswith("*."):
                t = t[2:]
            elif t.startswith("."):
                t = t[1:]
            if t and t not in seen:
                seen.add(t)
                out.append(t)
    return out


def _hit_rank(name: str, ext: str, terms: list) -> int:
    """返回命中强度；0 = 未命中。数字越小越相关。

      1 = 文件名与关键词完全相同（忽略扩展名）
      2 = 文件名以关键词开头
      3 = 扩展名精确命中（用户搜 "pdf" 想找 .pdf）
      4 = 文件名里包含关键词（子串）
    """
    low = name.lower()
    e = (ext or "").lower()
    stem = low.rsplit(".", 1)[0] if "." in low else low
    best = 0
    for t in terms:
        if t == stem or t == low:
            return 1
        if low.startswith(t):
            r = 2
        elif t.isalnum() and e and t == e:
            r = 3
        elif t in low:
            r = 4
        else:
            continue
        if best == 0 or r < best:
            best = r
        if best == 1:
            return 1
    return best


def _hit(name: str, ext: str, terms: list) -> bool:
    """名称/扩展名按 OR 匹配（保留旧签名，供别处调用）。"""
    return _hit_rank(name, ext, terms) > 0


@router.get("/api/search")
async def api_search(
    mount: str,
    q: str = "",
    path: str = "",
    limit: int = _SEARCH_MAX_HITS,
    offset: int = 0,
    user: dict = Depends(auth.current_user),
):
    """在挂载点内**递归**搜索文件名（支持子目录、层级不限，直到深度/扫描上限）。

    参数
      mount   挂载名
      q       关键词，空格/逗号/竖线分隔 ⇒ OR
      path    起始子目录（默认挂载根）
      limit   本页大小（上限 _SEARCH_MAX_HITS）
      offset  起始偏移（分页用）

    返回
      { ok, mount, base, terms, hits:[entry...], total, offset, limit,
        hasMore, scanned, depthCapped, truncated }

    ★ task24 起语义变更 ★
      · hits **不再是** os.walk 顺序的任意子集 —— 先全量收集→相关性排序→按
        offset/limit 切片，同一关键词多次请求结果**稳定可复现**。
      · total 是**真实命中总数**（不受 limit 影响），前端据此显示「500 / 4520」。
      · truncated 表示「命中数 > 本次返回数」（还有更多，用 offset 翻页），
        depthCapped 表示「目录太深/太多没扫完」，两者语义不同，别混。
    """
    m = _mount(user["username"], mount)

    base_dir = files.resolve(m, path or "")
    if not base_dir.is_dir():
        raise HTTPException(400, "\u8d77\u59cb\u8def\u5f84\u4e0d\u662f\u76ee\u5f55")

    terms = _search_terms(q)
    if not terms:
        return {
            "ok": True, "mount": mount, "base": "", "terms": [],
            "hits": [], "total": 0, "offset": 0, "limit": 0, "hasMore": False,
            "scanned": 0, "depthCapped": False, "truncated": False,
        }

    root = files._resolve_root(m)
    cap = max(1, min(int(limit or _SEARCH_MAX_HITS), _SEARCH_MAX_HITS))
    off = max(0, int(offset or 0))

    # (rank, is_dir, lower_name, entry_dict)；只保留前 _SEARCH_MAX_COLLECT 条对象
    collected = []
    total = 0              # ★ 真实命中总数（超过 collect 上限后继续计数）
    scanned = 0
    depth_capped = False
    try:
        start_rel = "/" + str(base_dir.relative_to(root)).replace("\\", "/")
    except ValueError:
        start_rel = "/"
    if start_rel == "/.":
        start_rel = "/"

    for dirpath, dirnames, filenames in os.walk(base_dir, followlinks=False):
        rel_here = "/" + str(Path(dirpath).relative_to(root)).replace("\\", "/")
        if rel_here == "/.":
            rel_here = "/"
        depth = 0 if rel_here == "/" else rel_here.strip("/").count("/") + 1
        if depth >= _SEARCH_MAX_DEPTH:
            depth_capped = True
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if d not in files.HIDDEN_NAMES]

        names = list(dirnames) + list(filenames)
        for nm in names:
            if nm in files.HIDDEN_NAMES:
                continue
            scanned += 1
            if scanned > _SEARCH_MAX_SCANNED:
                depth_capped = True
                break
            p = Path(dirpath) / nm
            is_dir = p.is_dir()
            ext = "" if is_dir else files.ext_of(nm)
            rank = _hit_rank(nm, ext, terms)
            if not rank:
                continue
            total += 1
            # ★ 不再在采集阶段因 cap 退出 ★
            #   收集够了 _SEARCH_MAX_COLLECT 之后只计数（total 仍准确），
            #   不存对象，避免超大目录把内存吃光。
            if len(collected) < _SEARCH_MAX_COLLECT:
                e = files._entry(p, rel_here)
                if e is None:
                    total -= 1
                    continue
                collected.append((rank, 0 if is_dir else 1, nm.lower(), e.as_dict()))
        if scanned > _SEARCH_MAX_SCANNED:
            break

    # 排序：相关性 → 目录在前 → 名字升序
    collected.sort(key=lambda t: (t[0], t[1], t[2]))

    page = [t[3] for t in collected[off:off + cap]]
    # ★ hits 里也可能补上「只计数」那部分？不能 —— 没存对象。
    #   所以当 total > len(collected) 时，明确告诉前端「可翻页范围有限」。
    reachable = len(collected)
    has_more = total > off + len(page)

    return {
        "ok": True,
        "mount": mount,
        "base": start_rel,
        "terms": terms,
        "hits": page,
        "total": total,
        "reachable": reachable,
        "offset": off,
        "limit": cap,
        "hasMore": has_more,
        "scanned": scanned,
        "depthCapped": depth_capped,
        # truncated = 「还有更多命中没返回」（可翻页），与 depthCapped 区分
        "truncated": has_more,
    }


# ===== NB SEARCH (task21/task24) END =====

