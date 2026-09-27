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


# ---------------------------------------------------------------------------
# 新建文件
# ---------------------------------------------------------------------------
# 文本类文件：写入默认空内容
_TEXT_DEFAULT = {
    "txt": "",
    "md": "",
    "markdown": "",
    "csv": "",
    "tsv": "",
    "json": "{}",
    "xml": '<?xml version="1.0" encoding="UTF-8"?>\n',
    "yaml": "",
    "yml": "",
    "rtf": r"{\rtf1\ansi\deff0}",
    "html": "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"UTF-8\">\n  <title></title>\n</head>\n<body>\n\n</body>\n</html>\n",
    "css": "",
    "js": "",
    "py": "",
    "sh": "",
    "sql": "",
}


def create_file(mount: Mount, rel: str, name: str) -> dict:
    """新建一个空文件。根据扩展名决定初始内容。

    - 文本类：写入默认模板（可能是空字符串）
    - Office 类（docx/xlsx/pptx）：生成最小可用的 OOXML 文件
    - 其他：空文件
    """
    name = (name or "").strip()
    _validate_name(name)
    target = resolve(mount, f"{rel}/{name}" if rel else name, must_exist=False)
    assert_writable(target)
    if target.exists():
        raise FileError("同名文件已存在", 409)

    ext = ext_of(name).lower()

    # 1) 文本类 → 直接写默认内容
    if ext in _TEXT_DEFAULT:
        target.write_text(_TEXT_DEFAULT[ext], encoding="utf-8")
        return {"ok": True, "name": name}

    # 2) Office OOXML 类 → 从预生成的完整空白模板写出
    if ext in ("docx", "xlsx", "pptx"):
        _build_ooxml(target, ext)
        return {"ok": True, "name": name}

    # 3) 其他 → 空文件
    target.touch()
    return {"ok": True, "name": name}


# ===== 完整空白 Office 模板（base64 编码） =====
# 采用预生成的完整空白模板，确保 OnlyOffice / Microsoft Office / WPS 都能正常打开编辑。
# 模板包含：document/workbook/presentation 主部件 + styles + settings + theme +
#          numbering + fontTable + docProps 等所有必要部件。
# 文件大小均 < 6KB，base64 编码后直接嵌入，零外部依赖。

_BLANK_DOCX_B64 = """
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
cC54bWxQSwUGAAAAAAoACgB8AgAAyQsAAAAA
"""

_BLANK_XLSX_B64 = """
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
AAkACQA/AgAAMgoAAAAA
"""

_BLANK_PPTX_B64 = """
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
2JYLKYgNOtMHhFo+gOSqKfQ+hQiJPZDIAlItO+a4VIpsB4OhSY4xJ21Ig+F8posKbestbIIdB0BW
s6qaK7gzoANXxg8o3+Lyxv+iLthXPzodHjF7TSGEXsfYe2s472x2cB57s/F01er3X2j13dU8AVBL
AQIUABQAAAAIAHawOl2YXzOKSwEAANkEAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBl
c10ueG1sUEsBAhQAFAAAAAgAdrA6XfIYjd/rAAAAWgIAAAsAAAAAAAAAAAAAAIABfAEAAF9yZWxz
Ly5yZWxzUEsBAhQAFAAAAAgAdrA6XfXMoFboAAAA4AIAAB8AAAAAAAAAAAAAAIABkAIAAHBwdC9f
cmVscy9wcmVzZW50YXRpb24ueG1sLnJlbHNQSwECFAAUAAAACAB2sDpdUWmSiEwBAACvAgAAFAAA
AAAAAAAAAAAAgAG1AwAAcHB0L3ByZXNlbnRhdGlvbi54bWxQSwECFAAUAAAACAB2sDpdgDLUqLgA
AAA6AQAAIAAAAAAAAAAAAAAAgAEzBQAAcHB0L3NsaWRlcy9fcmVscy9zbGlkZTEueG1sLnJlbHNQ
SwECFAAUAAAACAB2sDpdNkHpISkBAABuAgAAFQAAAAAAAAAAAAAAgAEpBgAAcHB0L3NsaWRlcy9z
bGlkZTEueG1sUEsBAhQAFAAAAAgAdrA6XbSVk4q3AAAAOgEAACwAAAAAAAAAAAAAAIABhQcAAHBw
dC9zbGlkZUxheW91dHMvX3JlbHMvc2xpZGVMYXlvdXQxLnhtbC5yZWxzUEsBAhQAFAAAAAgAdrA6
XZhLy2c9AQAAlAIAACEAAAAAAAAAAAAAAIABhggAAHBwdC9zbGlkZUxheW91dHMvc2xpZGVMYXlv
dXQxLnhtbFBLAQIUABQAAAAIAHawOl1k1vattAAAACcBAAAsAAAAAAAAAAAAAACAAQIKAABwcHQv
c2xpZGVNYXN0ZXJzL19yZWxzL3NsaWRlTWFzdGVyMS54bWwucmVsc1BLAQIUABQAAAAIAHawOl2E
IPgR5AEAACAEAAAhAAAAAAAAAAAAAACAAQALAABwcHQvc2xpZGVNYXN0ZXJzL3NsaWRlTWFzdGVy
MS54bWxQSwECFAAUAAAACAB2sDpd+HE0u6QCAADPCAAAFAAAAAAAAAAAAAAAgAEjDQAAcHB0L3Ro
ZW1lL3RoZW1lMS54bWxQSwECFAAUAAAACAB2sDpd3hV3ADkBAACJAgAAEQAAAAAAAAAAAAAAgAH5
DwAAZG9jUHJvcHMvY29yZS54bWxQSwECFAAUAAAACAB2sDpd8yJ777EAAAAcAQAAEAAAAAAAAAAA
AAAAgAFhEQAAZG9jUHJvcHMvYXBwLnhtbFBLBQYAAAAADQANAKsDAABAEgAAAAA=
"""


def _build_ooxml(path: Path, ext: str) -> None:
    """从预生成的空白模板（base64）写出完整的 OOXML 文件。

    模板包含完整部件（styles/settings/theme/numbering/fontTable/docProps 等），
    确保 OnlyOffice / Microsoft Office / WPS 等编辑器都能正常打开和编辑。
    """
    import base64 as _base64
    b64map = {
        "docx": _BLANK_DOCX_B64,
        "xlsx": _BLANK_XLSX_B64,
        "pptx": _BLANK_PPTX_B64,
    }
    b64data = b64map.get(ext)
    if not b64data:
        path.touch()
        return
    # 去除空白字符（换行、空格）后再解码
    raw = _base64.b64decode("".join(b64data.split()))
    path.write_bytes(raw)


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
