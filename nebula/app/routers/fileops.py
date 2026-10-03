"""文件操作：列目录 / 新建 / 改名 / 删除 / 移动 / 解压 / 上传 / 属性 / 下载"""

from __future__ import annotations

import hashlib
import mimetypes
import subprocess
import threading
from io import BytesIO
from pathlib import Path
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from starlette.concurrency import run_in_threadpool
from .. import auth, files, shares, users
from ..config import settings
from ..webutil import _mount, _stream_file
import os

# ★ Pillow 是**可选**依赖 ★
#   没装也能跑：/api/thumb 会静默回退到「直接给原图」（= 旧行为）。
#   见下方 api_thumb 的说明。这样镜像里万一漏装，不至于整个网盘起不来。
try:
    from PIL import Image, ImageOps

    _HAS_PIL = True
except Exception:  # pragma: no cover
    Image = ImageOps = None  # type: ignore[assignment]
    _HAS_PIL = False

# ★ imageio-ffmpeg 同样是**可选**依赖 ★
#   它自带一个静态 ffmpeg 二进制（含 libx264 / aac），用来把 H.265 视频
#   按需转成 H.264。没装时 /api/play 直接回退原流 + 前端给提示。
try:
    import imageio_ffmpeg

    _HAS_FFMPEG = True
except Exception:  # pragma: no cover
    imageio_ffmpeg = None  # type: ignore[assignment]
    _HAS_FFMPEG = False

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


@router.post("/api/create-file")
async def api_create_file(
    mount: str = Form(...), path: str = Form(""), name: str = Form(...),
    user: dict = Depends(auth.current_user),
):
    """新建一个空文件。根据扩展名自动生成对应格式的初始内容。

    支持类型：
      - 文本类：txt / md / json / csv / xml / html / css / js / py / ...
      - Office 类：docx / xlsx / pptx（生成最小可用的 OOXML 文件）
      - 其他：空文件
    """
    m = _mount(user["username"], mount)
    r = files.create_file(m, path, name)
    users.audit(user["username"], "create-file", f"{mount}:{path}/{name}")
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
    """移动 / 复制。move=False 时为复制。

    ★ 移动后必须失效旧路径下的分享（2026-09-24 补）★
      原先 rename/delete 都调了 shares.revoke_under_path，唯独 move 漏了：
        · rename → 已清
        · delete → 已清
        · move   → **没清**  ← 就是这里
      结果「文件被移动后，旧分享链接仍能下载到它」，与另外两条行为不一致，
      而且是信息泄漏（用户以为改名/挪走就断了，实际没断）。

    ★ 为什么只对 move 清、copy 不清 ★
      · move：旧路径**不再指向该文件** ⇒ 旧分享是"死链指向新位置"，
        必须清（与 rename 同理）。
      · copy：源文件**还在原处** ⇒ 旧分享依然指向那个真实存在的文件，
        语义完全成立，**不能清**。清了反而是 bug（用户复制一份，
        原文件的分享却失效了）。

    ★ 要清两个位置 ★
      ① 源路径 path（及它下面的子路径）—— 移动前的分享
      ② 目标路径 target/name（及它下面的子路径）—— 该位置**历史上**可能
         分享过别的文件，现在被新文件顶替，旧分享会指到"同名的另一个文件"上。
      ①好理解；②容易被漏，但同样是泄漏：
        `/a/报告.pdf` 分享过 → 删掉 → 把 `/b/x.pdf` 移进 `/a/` 并改名成
        `报告.pdf` → 旧 token 会直接下载到这份**新文件**。
    """
    m = _mount(user["username"], mount)
    r = files.copy_or_move(m, path, target, move=move)
    op = "move" if move else "copy"
    users.audit(user["username"], op, f"{mount}:{path}", f"-> {target}")

    if not move:
        # 复制：源文件仍在，旧分享依然有效语义 ⇒ 不动分享
        return r

    n_src = shares.revoke_under_path(user["username"], mount, path)
    if n_src:
        users.audit(user["username"], "share-invalidate", f"{mount}:{path}",
                    f"{n_src} 条随移动失效（源路径）")

    # 目标位置：用「移动后的新路径」精确到这一项，连带清它下面的子路径
    name = r.get("name") or ""
    if name:
        new_rel = "/".join(p for p in ((target or "").strip("/"), name) if p)
        n_dst = shares.revoke_under_path(user["username"], mount, new_rel)
        if n_dst:
            users.audit(user["username"], "share-invalidate", f"{mount}:{new_rel}",
                        f"{n_dst} 条随移动失效（目标位置被顶替）")

    return {**r, "sharesRevoked": n_src + n_dst}


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


# ===========================================================================
# 缩略图  GET /api/thumb?mount=&path=&w=
#
# ★ 为什么需要它（2026-10-03 实测）★
#   列表/网格视图的缩略图**只显示 16px / 52px**，但此前的实现是把
#   **原图**丢给浏览器（`<img src="/api/download?…&inline=true">`），
#   只在 CSS 里缩小。手机相册里的照片动辄 3~5 MB：
#
#     实测：手机上打开「遂宁利和」目录，10 分钟内 61 次 /api/download、
#           合计 **271 MB** 原图 —— 只为画 16px 的小方块。
#           主线程被图片解码占住，页面发涩、双击都可能识别不出来。
#
#   这里按**需求宽度**生成缩略图并落盘缓存。设计要点：
#     · 任何失败一律**回退原图**（没装 Pillow / 非图片 / 解码失败 / 写缓存失败）
#       ⇒ 行为绝不比旧版差，也不会因为一张坏图让列表崩掉；
#     · `Image.draft()` 让 JPEG 走 DCT 缩放（只解 1/2、1/4、1/8…），
#       4000px 的照片毫秒级出图，峰值内存从几十 MB 降到几 MB；
#     · `exif_transpose` 处理手机竖拍的方向，否则缩略图是躺着的；
#     · 缓存 key 含 mtime_ns + size ⇒ 文件被覆盖后自动失效，不需要清缓存；
#     · 宽度限幅 `_THUMB_MAX_W`，避免这个接口被当成图床用。
# ===========================================================================
_THUMB_MAX_W = 512          # 请求宽度的上限
_THUMB_QUALITY = 82
_THUMB_CACHE_DIR = "thumbs"
_TRANSCODE_CACHE_DIR = "transcode"


def _cache_dir(name: str) -> Path:
    """按需生成物的落盘目录（跟数据库同盘，跟随 NEBULA_DATA_DIR 配置）。"""
    d = Path(settings.data_dir) / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def _thumb_cache_dir() -> Path:
    return _cache_dir(_THUMB_CACHE_DIR)


def _render_thumb(src: Path, w: int) -> bytes:
    """把 src 缩放成宽度不超过 w 的 JPEG，返回字节。**阻塞**，请放线程池里跑。"""
    im = Image.open(src)          # 只读文件头，不整图解码
    try:
        # ★ 关键：先让 JPEG 解码器自己降采样 ★
        #   传「目标 2 倍尺寸」给它，libjpeg 会挑 1/1、1/2、1/4、1/8 里最合适的一档，
        #   4000×3000 的图只需解 1000×750 —— 这是快与慢的分水岭。
        im.draft("RGB", (w * 2, w * 2))
        im = ImageOps.exif_transpose(im)   # 按 EXIF 摆正（手机竖拍）
        im.thumbnail((w, w), Image.LANCZOS)
        # 带透明通道的（PNG/WebP/GIF）要贴白底，否则转 RGB 后透明处变黑
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        elif im.mode != "RGB":
            im = im.convert("RGB")
        buf = BytesIO()
        im.save(buf, "JPEG", quality=_THUMB_QUALITY, optimize=True, progressive=True)
        return buf.getvalue()
    finally:
        try:
            im.close()
        except Exception:
            pass


@router.get("/api/thumb")
async def api_thumb(
    mount: str, path: str, w: int = 96,
    user: dict = Depends(auth.current_user),
):
    m = _mount(user["username"], mount)
    p = files.resolve(m, path)

    # 没装 Pillow ⇒ 完全回退旧行为（给原图），网盘照常可用
    if not _HAS_PIL:
        return _stream_file(p)

    w = max(16, min(int(w or 96), _THUMB_MAX_W))
    try:
        st = p.stat()
        if not p.is_file():
            raise OSError("not a file")
    except OSError:
        return _stream_file(p)

    key = hashlib.sha1(
        f"{p}|{st.st_mtime_ns}|{st.st_size}|{w}".encode("utf-8", "replace")
    ).hexdigest()[:32]

    try:
        cache = _thumb_cache_dir() / f"{key}.jpg"
    except OSError:
        cache = None

    if cache is not None and cache.is_file():
        return FileResponse(
            str(cache), media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=86400"},
        )

    try:
        # 解码是大头（且是 CPU 密集），必须丢线程池，别卡住事件循环
        data = await run_in_threadpool(_render_thumb, p, w)
    except Exception:
        # 不是图片 / 损坏 / 格式不支持 ⇒ 回退原图（浏览器端 onerror 会兜住）
        return _stream_file(p)

    if cache is not None:
        try:
            tmp = cache.with_suffix(".jpg.tmp")
            tmp.write_bytes(data)
            tmp.replace(cache)      # 原子替换，避免并发读到半截文件
        except OSError:
            pass                    # 写不进去也无所谓，直接返回字节

    return Response(
        content=data, media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


# ===========================================================================
# 视频「能播」接口  GET /api/play?mount=&path=
#
# ★ 为什么需要它（2026-10-03 实测）★
#   问题现象：同一个 mp4 电脑能播、手机报错。排查到最后是**编码**问题：
#
#     185c98aa….mp4  → 视频轨 `hvc1` = **H.265 / HEVC**  → 手机 ❌
#       手机端探针：media-meta 能解出 1280x720，紧接着
#       `MEDIA_ELEMENT_ERROR: Format error`（error.code=4 = 格式不支持）
#     0.mp4          → 视频轨 `avc1` = H.264          → 手机 ✅
#
#   飞牛 App 的 Android WebView **不解 HEVC**（Chromium 只在设备/系统
#   明确支持时才启用，很多 WebView 不启用）。这跟网络、反代、Host 都无关 ——
#   实测该文件的 206 分片请求全部 200，字节完整送到。
#
#   ⇒ 唯一能让它「真的能播」的做法是**服务端转码成 H.264**。
#
# ★ 设计（务必保持"零成本透传"这条路）★
#   · 探测不是 HEVC（H.264 / VP9 / AV1…）⇒ **302 跳到原来的下载流**
#     ⇒ 行为、Range、性能与改动前**完全一致**，没有任何转码开销。
#   · 探测到 HEVC ⇒ 用 ffmpeg 转 H.264 落盘缓存，之后直接发缓存文件。
#   · 没装 ffmpeg / 转码失败 ⇒ 一样 302 回原流，前端会给出提示（不白屏）。
#
#   ⚠️ 转码参数里 `-pix_fmt yuv420p` 是**必须**的：浏览器只解 4:2:0 8bit，
#      手机拍的 HEVC 常常是 10bit 或 4:2:2，不转就还是黑屏。
#      `-movflags +faststart` 让 moov 前置，才能边下边播。
# ===========================================================================
_HEVC_TAGS = (b"hvc1", b"hev1", b"dvhe", b"dvh1")     # H.265 / HEVC（含 Dolby Vision）
_H264_TAGS = (b"avc1", b"avc3")
_VP9_TAGS = (b"vp09",)
_AV1_TAGS = (b"av01",)

# 编码探测结果的内存缓存：{(路径, mtime_ns, size): 'hevc'|...}
# 为什么缓存：探测要读文件头尾各 1MB，而 <video> 播放期间会发**多个 Range 请求**，
# 每次都读盘就白费了。key 含 mtime/size ⇒ 文件被替换后自动失效。
_CODEC_CACHE: dict = {}
_CODEC_CACHE_LOCK = threading.Lock()

# 转码是 CPU 密集的，**同时只允许一个**（否则几个大文件一起转会打满 CPU）
_TRANSCODE_SLOT = threading.Semaphore(1)
_TRANSCODE_TIMEOUT = 60 * 30        # 单个文件最长转 30 分钟


def _ffmpeg_exe() -> str | None:
    if not _HAS_FFMPEG:
        return None
    try:
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _detect_vcodec(p: Path, st) -> str:
    """探测视频轨编码。只读头尾各 1MB（moov 可能在前也可能在后）。

    返回 'hevc' / 'h264' / 'vp9' / 'av1' / '?'（认不出）。
    """
    key = (str(p), st.st_mtime_ns, st.st_size)
    with _CODEC_CACHE_LOCK:
        hit = _CODEC_CACHE.get(key)
    if hit:
        return hit

    chunk = 1 << 20
    try:
        with open(p, "rb") as f:
            data = f.read(chunk)
            if st.st_size > chunk:
                f.seek(max(0, st.st_size - chunk))
                data += f.read(chunk)
    except OSError:
        return "?"

    codec = "?"
    for tags, name in ((_HEVC_TAGS, "hevc"), (_H264_TAGS, "h264"),
                       (_VP9_TAGS, "vp9"), (_AV1_TAGS, "av1")):
        if any(t in data for t in tags):
            codec = name
            break

    with _CODEC_CACHE_LOCK:
        if len(_CODEC_CACHE) > 8192:      # 简单防膨胀
            _CODEC_CACHE.clear()
        _CODEC_CACHE[key] = codec
    return codec


def _transcode_h264(src: Path, dst: Path) -> None:
    """把 src 转成「浏览器一定能播」的 H.264 MP4。**阻塞**，放线程池里跑。"""
    exe = _ffmpeg_exe()
    if not exe:
        raise RuntimeError("ffmpeg 不可用")

    dst.parent.mkdir(parents=True, exist_ok=True)
    with _TRANSCODE_SLOT:
        if dst.is_file() and dst.stat().st_size > 0:
            return                        # 别人刚转好
        tmp = dst.with_name(dst.name + ".part")
        cmd = [
            exe, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src),
            "-map", "0:v:0",              # 只取第一条视频轨（有的文件带封面图轨）
            "-map", "0:a:0?",             # 有音频就带上，没有也不报错
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p",        # ★ 必须：浏览器只解 4:2:0 8bit ★
            "-profile:v", "high", "-level", "4.1",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-movflags", "+faststart",
            "-f", "mp4", str(tmp),
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=_TRANSCODE_TIMEOUT)
        except subprocess.TimeoutExpired:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise RuntimeError("转码超时")
        if r.returncode != 0 or not tmp.is_file() or tmp.stat().st_size == 0:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise RuntimeError((r.stderr or b"").decode("utf-8", "replace")[:400])
        tmp.replace(dst)                  # 原子替换，避免并发读到半截文件


@router.get("/api/play")
async def api_play(
    mount: str, path: str,
    user: dict = Depends(auth.current_user),
):
    m = _mount(user["username"], mount)
    p = files.resolve(m, path)

    def _passthrough() -> RedirectResponse:
        """回退：跳到原来的下载流（支持 Range、零转码开销、= 改动前的行为）。"""
        q = urlencode({"mount": mount, "path": path, "inline": "true"})
        return RedirectResponse(url=f"/api/download?{q}", status_code=302)

    try:
        st = p.stat()
        if not p.is_file():
            raise OSError("not a file")
    except OSError:
        raise HTTPException(404, "文件不存在")

    codec = await run_in_threadpool(_detect_vcodec, p, st)

    # 不是 HEVC ⇒ 原样透传（H.264 本来就能播，别为它付转码成本）
    if codec != "hevc":
        return _passthrough()

    if _ffmpeg_exe() is None:
        return _passthrough()

    key = hashlib.sha1(
        f"{p}|{st.st_mtime_ns}|{st.st_size}".encode("utf-8", "replace")
    ).hexdigest()[:32]
    try:
        dst = _cache_dir(_TRANSCODE_CACHE_DIR) / f"{key}.mp4"
    except OSError:
        return _passthrough()

    if not (dst.is_file() and dst.stat().st_size > 0):
        try:
            await run_in_threadpool(_transcode_h264, p, dst)
        except Exception:
            # 转码失败（文件损坏 / 没有视频轨 / 超时）⇒ 还是给原流，
            # 前端会展示「编码不支持」的提示和下载入口，不会白屏。
            return _passthrough()

    return FileResponse(
        str(dst), media_type="video/mp4",
        headers={"Cache-Control": "private, max-age=86400"},
    )


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


def _search_scan(
    base_dir: Path, root: Path, terms: list, cap: int, off: int, mount: str
) -> dict:
    """搜索的**同步**内核 —— 真正的 os.walk 在这里。

    ★ 为什么单独抽成一个函数（2026-10-01 事故）★
      它原来直接写在 `async def api_search` 的函数体里。本进程是**单 worker 的
      uvicorn**（见 deploy/nebula-entrypoint.sh 的启动行，没有 --workers），
      于是「一次同步遍历」= 「把整个事件循环借出去」：

        · 遍历期间任何别的请求都拿不到时间片，连 /healthz（纯内存接口）都超时
        · docker 健康检查连续失败 ⇒ 容器被判 unhealthy
        · 用户侧表现为「点一下搜索，整个网盘全挂」

      py-spy 抓到的卡死栈正是这一行：
          stat (pathlib.py:842) → is_dir (pathlib.py:877)
          → api_search (app/routers/fileops.py:386)
      与 preview.py 里记的「压缩包自愈把单 worker 交给一次解压」是**同一类**故障；
      区别是那边收益太小可以直接删，这边是用户点名要的功能，
      所以正解是把它**卸载到线程池**（见 api_search 里的 run_in_threadpool）。

    参数
      base_dir  起始目录（已解析、已确认是目录）
      root      挂载根（用于算相对路径）
      terms     关键词列表（已解析、非空）
      cap       本页大小
      off       起始偏移
      mount     挂载名，仅为回显（保持响应字段顺序与旧版一致）

    返回就是 api_search 要吐的那个 dict。
    """
    try:
        start_rel = "/" + str(base_dir.relative_to(root)).replace("\\", "/")
    except ValueError:
        start_rel = "/"
    if start_rel == "/.":
        start_rel = "/"

    # (rank, is_dir, lower_name, entry_dict)；只保留前 _SEARCH_MAX_COLLECT 条对象
    collected = []
    total = 0              # ★ 真实命中总数（超过 collect 上限后继续计数）
    scanned = 0
    depth_capped = False

    for dirpath, dirnames, filenames in os.walk(base_dir, followlinks=False):
        rel_here = "/" + str(Path(dirpath).relative_to(root)).replace("\\", "/")
        if rel_here == "/.":
            rel_here = "/"
        depth = 0 if rel_here == "/" else rel_here.strip("/").count("/") + 1
        if depth >= _SEARCH_MAX_DEPTH:
            depth_capped = True
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if d not in files.HIDDEN_NAMES]

        # ★ 不再对每个条目调 Path.is_dir() ★
        #   os.walk 返回时**已经**把「目录」和「文件」分开装好了
        #   （dirnames / filenames），这里直接采信即可。
        #   旧写法对每个条目多打一次 stat()，在 20 万上限下就是 20 万次多余的
        #   系统调用；网络盘上这一项能占掉整个扫描时间的大头，
        #   而且正是 py-spy 抓到的那一帧。用 (名字, 是否目录) 元组顺序遍历，
        #   既不丢信息也不多一次 stat。
        for nm, is_dir in [(d, True) for d in dirnames] + [(f, False) for f in filenames]:
            if nm in files.HIDDEN_NAMES:
                continue
            scanned += 1
            if scanned > _SEARCH_MAX_SCANNED:
                depth_capped = True
                break
            p = Path(dirpath) / nm
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

    ★ 2026-10-01 起：扫描在**线程池**里跑 ★
      真正的 os.walk 在 _search_scan（同步函数），本路由只用 run_in_threadpool
      把它外派出去。**不要把遍历挪回本函数体** —— 本进程是单 worker 的 uvicorn，
      写在 async def 里就是「一次搜索冻结全站」（/healthz 超时 → 容器 unhealthy）。
      详见 _search_scan 的注释（含 py-spy 抓到的卡死栈）。
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

    # ★★ 扫描必须离开事件循环 ★★
    #   具体的内核在 _search_scan（同步、可阻塞）。这里用 run_in_threadpool
    #   把它丢到 anyio 的工作线程里跑：
    #     · 事件循环继续转 ⇒ 搜索期间 /healthz、别的目录、别的用户都照常响应
    #     · run_in_threadpool 来自 starlette（fastapi 的依赖），不引入新依赖
    #     · 默认线程池上限 40，够用；真被占满也只是搜索排队，不会拖垮全站
    #   反面教材就是上一版：同一个 async def 里直接 os.walk，
    #   单 worker 被占死 ⇒ 容器 unhealthy、全站打不开（详见 _search_scan 注释）。
    return await run_in_threadpool(_search_scan, base_dir, root, terms, cap, off, mount)


# ===== NB SEARCH (task21/task24) END =====

