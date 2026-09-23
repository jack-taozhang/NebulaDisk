# -*- coding: utf-8 -*-
"""
NebulaDisk —— 文件系统操作（路径安全是这里的核心职责）

安全模型（务必理解）：
  1. 用户接口传的永远是「映射名 + 相对路径」，绝不接受绝对路径。
  2. 拼出绝对路径后一律 resolve()，再校验它仍在映射根目录之下。
  3. resolve() 会解开符号链接 —— 若展开后跑出根目录，直接拒绝。
     这一条同时挡住了 `..` 穿越和指向外部的软链。
  4. 校验必须用「路径层级」比较而不是字符串前缀比较：
     /mnt/docs-evil 的字符串前缀是 /mnt/docs，但不是它的子路径。
     所以这里用 Path.is_relative_to()（Python 3.9+）。

注意：所有对外函数都要传 username，因为它参与映射可见性判断。
"""

from __future__ import annotations

import mimetypes
import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from .config import Mount, ext_of, route_of, settings

# 目录列表里默认隐藏的垃圾文件
HIDDEN_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini", ".git", "__MACOSX"}


class FileError(Exception):
    """业务层文件错误。main.py 会把它翻成 HTTP 4xx。"""

    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code


# ---------------------------------------------------------------------------
# 映射查找
# ---------------------------------------------------------------------------
def visible_mounts(username: str) -> list[Mount]:
    return [m for m in settings.mounts if m.visible_to(username)]


def get_mount(name: str, username: str) -> Mount:
    for m in settings.mounts:
        if m.label == name:
            if not m.visible_to(username):
                # 不说「无权限」而是「不存在」，避免探测他人目录名
                raise FileError("目录不存在", 404)
            return m
    raise FileError("目录不存在", 404)


# ---------------------------------------------------------------------------
# 路径解析（安全核心）
# ---------------------------------------------------------------------------
def _resolve_root(mount: Mount) -> Path:
    root = Path(mount.path)
    if not root.exists() or not root.is_dir():
        raise FileError(f"映射目录不可用: {mount.path}", 500)
    return root.resolve()


def resolve(mount: Mount, rel: str = "", *, must_exist: bool = True) -> Path:
    """把「映射 + 相对路径」解析成绝对路径，并做穿越校验。

    rel 允许以 / 开头（前端习惯），会被剥掉。
    """
    root = _resolve_root(mount)

    rel = (rel or "").strip().replace("\\", "/")
    rel = rel.lstrip("/")
    # 空字符串、"." 都表示根目录本身
    if rel in ("", ".", "./"):
        target = root
    else:
        # 提前挡掉空字节，某些 OS 调用会因此报诡异错误
        if "\x00" in rel:
            raise FileError("路径非法", 400)
        target = (root / rel)

    if must_exist:
        if not target.exists():
            raise FileError("文件或目录不存在", 404)
        resolved = target.resolve()
    else:
        # 创建场景：父目录必须存在且安全，目标本身还不能存在
        parent = target.parent
        if not parent.exists():
            raise FileError("上级目录不存在", 404)
        resolved = parent.resolve() / target.name

    # ---- 包含性校验 ----
    if not _inside(resolved, root):
        raise FileError("拒绝访问：路径超出映射范围", 403)

    return resolved


def _inside(path: Path, root: Path) -> bool:
    """path 是否等于 root 或位于 root 之下（按路径层级，不是字符串前缀）。"""
    try:
        return path == root or path.is_relative_to(root)
    except AttributeError:  # Python < 3.9 兜底
        return path == root or root in path.parents


def assert_writable(path: Path) -> None:
    """确认路径所在目录可写（挂载为 ro 时给出友好提示）。"""
    probe = path if path.is_dir() else path.parent
    if not os.access(probe, os.W_OK):
        raise FileError("该目录为只读挂载，无法写入", 403)


# ---------------------------------------------------------------------------
# 列目录
# ---------------------------------------------------------------------------
@dataclass
class Entry:
    name: str
    is_dir: bool
    size: int
    mtime: int
    ext: str
    route: str          # onlyoffice / kkfileview / download
    mime: str
    readonly: bool
    path: str = ""      # 相对挂载根的路径，如 "/a/b/c.txt"（根目录下为 "/c.txt"）

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "isDir": self.is_dir,
            "size": self.size,
            "mtime": self.mtime,
            "ext": self.ext,
            "route": self.route,
            "mime": self.mime,
            "readonly": self.readonly,
            # ★ 必须返回 path ★
            #   客户端（思源插件 / Web 前端）拿到列表后要能**继续下钻**：
            #   展开子目录、点击文件预览，都需要每条记录自带完整相对路径。
            #   历史版本只返回 name，调用方只能自己把父路径和 name 拼起来，
            #   一旦漏拼就会出现「缺少文件路径参数（path）」这类报错。
            "path": self.path,
        }


def _entry(p: Path, rel: str) -> Entry | None:
    try:
        st = p.stat()
    except OSError:
        return None  # 断链软链、权限不足等，静默跳过

    is_dir = p.is_dir()
    if is_dir:
        ext, route = "", ""
        mime = "inode/directory"
    else:
        ext = ext_of(p.name)
        route = route_of(p.name)
        mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"

    # 子项相对挂载根的路径：rel 是「父目录」的相对路径（根为 ""）
    parent = "/" + str(rel).strip("/") if str(rel).strip("/") else ""
    child_path = f"{parent}/{p.name}"

    return Entry(
        name=p.name,
        is_dir=is_dir,
        size=0 if is_dir else st.st_size,
        mtime=int(st.st_mtime),
        ext=ext,
        route=route,
        mime=mime,
        readonly=not os.access(p, os.W_OK),
        path=child_path,
    )


def list_dir(mount: Mount, rel: str = "", username: str = "") -> dict:
    """列目录。返回 { path, entries, mount:{...} }"""
    target = resolve(mount, rel)
    if not target.is_dir():
        raise FileError("不是目录", 400)

    entries: list[Entry] = []
    try:
        with os.scandir(target) as it:
            for de in it:
                if de.name in HIDDEN_NAMES:
                    continue
                e = _entry(Path(de.path), rel)
                if e:
                    entries.append(e)
    except PermissionError:
        raise FileError("目录无读取权限", 403) from None

    # 排序：目录在前，然后按名称不区分大小写（与 Windows 资源管理器一致）
    entries.sort(key=lambda e: (not e.is_dir, e.name.lower()))

    root = _resolve_root(mount)
    cur_rel = "/" + str(target.relative_to(root)).replace("\\", "/")
    if cur_rel == "/.":
        cur_rel = "/"

    # 逐条补上完整相对路径（scandir 阶段只知道父目录 rel，这里统一按
    # 规范化的 cur_rel 重算一次，避免 rel 传入 "/"、"//"、"a/" 等写法时拼歪）
    base = "" if cur_rel == "/" else cur_rel
    for e in entries:
        e.path = f"{base}/{e.name}"

    return {
        "path": cur_rel,
        "entries": [e.as_dict() for e in entries],
        "mount": {
            "label": mount.label,
            "readonly": not os.access(target, os.W_OK),
        },
    }


# ---------------------------------------------------------------------------
# 增删改
# ---------------------------------------------------------------------------
def mkdir(mount: Mount, rel: str, name: str) -> dict:
    name = (name or "").strip()
    _validate_name(name)
    target = resolve(mount, f"{rel}/{name}" if rel else name, must_exist=False)
    assert_writable(target)
    target.mkdir(parents=False, exist_ok=False)
    return {"ok": True, "name": name}


def _validate_name(name: str) -> None:
    if not name:
        raise FileError("名称不能为空", 400)
    if name in (".", ".."):
        raise FileError("名称非法", 400)
    # Windows 与 Linux 都禁用的字符 + 路径分隔符
    if any(ch in name for ch in '/\\:*?"<>|'):
        raise FileError('名称不能包含 / \\ : * ? " < > |', 400)
    if len(name) > 255:
        raise FileError("名称过长", 400)


def rename(mount: Mount, rel: str, new_name: str) -> dict:
    new_name = (new_name or "").strip()
    _validate_name(new_name)

    src = resolve(mount, rel)
    root = _resolve_root(mount)
    if src == root:
        raise FileError("不能重命名映射根目录", 400)
    assert_writable(src)

    dst = src.parent / new_name
    if dst.exists():
        raise FileError("同名文件已存在", 409)
    src.rename(dst)
    return {"ok": True, "name": new_name}


def delete(mount: Mount, rel: str) -> dict:
    """删除。目录会递归删除 —— 前端必须二次确认。"""
    target = resolve(mount, rel)
    root = _resolve_root(mount)
    if target == root:
        raise FileError("不能删除映射根目录", 400)
    assert_writable(target)

    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"ok": True}


def copy_or_move(mount: Mount, rel: str, dst_rel: str, *, move: bool) -> dict:
    src = resolve(mount, rel)
    root = _resolve_root(mount)
    if src == root:
        raise FileError("不能操作映射根目录", 400)

    dst_dir = resolve(mount, dst_rel or "")
    if not dst_dir.is_dir():
        raise FileError("目标不是目录", 400)
    assert_writable(dst_dir / src.name)

    dst = dst_dir / src.name
    if dst.exists():
        raise FileError("目标已存在同名项", 409)
    # 防止把目录移进自己的子目录（会无限递归 / 失败）
    if move and src.is_dir() and _inside(dst_dir, src):
        raise FileError("不能把目录移动到自身内部", 400)

    if move:
        shutil.move(str(src), str(dst))
    elif src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)
    return {"ok": True, "name": src.name}


# ---------------------------------------------------------------------------
# 解压
#
# 需求（原文）：「集成右键对压缩文件解压功能。」
#
# ★ 安全要点（解压是经典的目录穿越重灾区）★
#   压缩包里的条目名是可以任意构造的，`../../etc/passwd` 这种就是
#   zip-slip 攻击。所以**不能**直接把 zipfile.extractall 丢给磁盘，
#   必须自己逐个条目校验：
#     1. 条目名规范化后不得以 / 开头、不得含 .. 段
#     2. 拼出的绝对路径 resolve() 后必须在目标目录之下
#     3. 符号链接条目一律跳过（会指到包外）
#   另外设总量与条目数上限，避免 zip 炸弹把 NAS 磁盘写满。
# ---------------------------------------------------------------------------
ARCHIVE_EXT = {"zip", "tar", "gz", "gzip", "bz2", "xz", "tgz", "tbz2", "txz"}

# 解压上限：单文件 2GB、总量 20GB、条目 5 万 —— 家用 NAS 的合理护栏
_MAX_MEMBER_BYTES = 2 * 1024 * 1024 * 1024
_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024
_MAX_MEMBERS = 50000


def _safe_member_rel(name: str) -> str | None:
    """把压缩包内的条目名规范化成安全的相对路径；不安全则返回 None。"""
    # 统一分隔符：Windows 造的 zip 可能用反斜杠
    n = name.replace("\\", "/").strip()
    if not n or n.endswith("/"):
        return None                      # 纯目录条目，按需由父路径自动创建
    if n.startswith("/") or (len(n) > 1 and n[1] == ":"):
        return None                      # 绝对路径 / 盘符
    parts = []
    for seg in n.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            return None                  # 目录穿越，直接拒
        if any(ch in seg for ch in '\x00'):
            return None
        parts.append(seg)
    if not parts:
        return None
    return "/".join(parts)


def extract_archive(mount: Mount, rel: str, *, dest_rel: str | None = None,
                    overwrite: bool = False) -> dict:
    """把压缩包解压到 dest_rel（默认解到压缩包所在目录下的同名文件夹）。

    返回 {ok, dir, files, bytes, skipped}。
    """
    src = resolve(mount, rel)
    if not src.is_file():
        raise FileError("不是文件", 400)
    assert_writable(src)

    ext = ext_of(src.name)
    if ext not in ARCHIVE_EXT:
        raise FileError(f"不支持的压缩格式：.{ext}", 400)

    # 默认落点：同目录下「<压缩包主名>」文件夹；重名就加 (1)(2)…
    if dest_rel is None:
        base = src.name
        for suffix in (".tar.gz", ".tar.bz2", ".tar.xz"):
            if base.lower().endswith(suffix):
                base = base[: -len(suffix)]
                break
        else:
            base = src.stem
        parent_rel = str(src.parent.relative_to(_resolve_root(mount)))
        parent_rel = "" if parent_rel == "." else parent_rel
        name, i = base, 0
        while True:
            cand = f"{parent_rel}/{name}" if parent_rel else name
            try:
                p = resolve(mount, cand, must_exist=False)
            except FileError:
                raise
            if not p.exists():
                break
            i += 1
            name = f"{base}({i})"
        dest_rel = cand

    dest = resolve(mount, dest_rel, must_exist=False)
    assert_writable(dest)
    if dest.exists() and not overwrite:
        raise FileError("目标文件夹已存在", 409)
    dest.mkdir(parents=True, exist_ok=True)

    files = 0
    total = 0
    skipped = []

    try:
        with _open_archive(src) as members:
            for name, is_dir, size, opener in members:
                safe = _safe_member_rel(name)
                if safe is None:
                    if not is_dir:
                        skipped.append(name)
                    continue
                if is_dir:
                    continue
                files += 1
                if files > _MAX_MEMBERS:
                    raise FileError("压缩包条目过多，已中止", 400)
                if size and size > _MAX_MEMBER_BYTES:
                    skipped.append(f"{name}（单文件过大）")
                    continue
                total += size or 0
                if total > _MAX_TOTAL_BYTES:
                    raise FileError("解压后体积过大，已中止", 400)

                target = (dest / safe)
                # resolve 后必须仍在 dest 之下（双保险，_safe_member_rel 已挡一层）
                try:
                    if not _inside(target.parent.resolve(), dest.resolve()):
                        skipped.append(name)
                        continue
                except OSError:
                    skipped.append(name)
                    continue

                target.parent.mkdir(parents=True, exist_ok=True)
                with opener() as fsrc, open(target, "wb") as fdst:
                    shutil.copyfileobj(fsrc, fdst, 1024 * 256)
    except FileError:
        raise
    except Exception as e:  # noqa: BLE001
        raise FileError(f"解压失败：{e}", 400) from e

    return {
        "ok": True,
        "dir": dest_rel,
        "files": files,
        "bytes": total,
        "skipped": skipped[:20],
        "skippedCount": len(skipped),
    }


class _ArchiveMembers:
    """统一的「压缩包条目迭代器」上下文管理器。

    把 zip / tar 家族的差异收敛在这里，extract_archive 只管安全校验与落盘。
    每个条目产出 (name, is_dir, size, opener)，opener() 返回可读流。
    """

    def __init__(self, path: Path):
        self.path = path
        self._z = None
        self._t = None

    def __enter__(self):
        p = self.path
        low = p.name.lower()
        if low.endswith(".zip"):
            import zipfile
            self._z = zipfile.ZipFile(p)
            return self._iter_zip()
        # tar 家族：tarfile 能自动识别 gz/bz2/xz 压缩
        import tarfile
        self._t = tarfile.open(p, "r:*")
        return self._iter_tar()

    def _iter_zip(self):
        for info in self._z.infolist():
            if info.is_dir():
                yield info.filename, True, 0, None
                continue
            # 符号链接等特殊条目跳过
            mode = (info.external_attr >> 16) & 0xF000
            if mode == 0xA000:
                continue
            yield (info.filename, False, info.file_size,
                   (lambda n=info.filename: self._z.open(n)))

    def _iter_tar(self):
        for m in self._t:
            if m.issym() or m.islnk():
                continue
            if m.isdir():
                yield m.name, True, 0, None
                continue
            if not m.isfile():
                continue
            yield (m.name, False, m.size,
                   (lambda mm=m: self._t.extractfile(mm)))

    def __exit__(self, *exc):
        for h in (self._z, self._t):
            try:
                h and h.close()
            except Exception:  # noqa: BLE001
                pass
        return False


def _open_archive(path: Path) -> _ArchiveMembers:
    return _ArchiveMembers(path)


# ---------------------------------------------------------------------------
# 保存上传
# ---------------------------------------------------------------------------
def save_upload(mount: Mount, rel: str, filename: str, stream, *, overwrite: bool = False) -> dict:
    """把上传流写成文件。filename 已由调用方做过 basename 处理。"""
    filename = Path(filename).name
    _validate_name(filename)

    dest = resolve(mount, f"{rel}/{filename}" if rel else filename, must_exist=False)
    assert_writable(dest)

    if dest.exists() and not overwrite:
        # 自动改名 foo.txt → foo(1).txt，比直接报错友好
        stem, dot, suffix = filename.rpartition(".")
        for i in range(1, 1000):
            alt = f"{stem}({i}).{suffix}" if dot else f"{filename}({i})"
            cand = dest.parent / alt
            if not cand.exists():
                dest, filename = cand, alt
                break
        else:
            raise FileError("同名文件过多，请手动处理", 409)

    written = 0
    with open(dest, "wb") as f:
        while True:
            chunk = stream.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            written += len(chunk)
    return {"ok": True, "name": filename, "size": written}


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------
def stat_of(mount: Mount, rel: str) -> dict:
    target = resolve(mount, rel)
    st = target.stat()
    return {
        "name": target.name,
        "size": 0 if target.is_dir() else st.st_size,
        "mtime": int(st.st_mtime),
        "isDir": target.is_dir(),
        "ext": "" if target.is_dir() else ext_of(target.name),
        "route": "" if target.is_dir() else route_of(target.name),
        "mime": mimetypes.guess_type(target.name)[0] or "application/octet-stream",
    }


def disk_usage() -> dict:
    try:
        u = shutil.disk_usage(settings.data_dir)
        return {"total": u.total, "used": u.used, "free": u.free}
    except OSError:
        return {"total": 0, "used": 0, "free": 0}


def mtime_str(ts: int) -> str:
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
