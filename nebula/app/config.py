# -*- coding: utf-8 -*-
"""
NebulaDisk —— 配置与目录映射解析

环境变量一览：
  NEBULA_MOUNTS     目录映射，格式见下
  NEBULA_JWT_SECRET 自有会话签名密钥。留空则自动生成一份并持久化到
                    $NEBULA_DATA_DIR/secret.key（0600），重启/多进程共用同一把。
  NEBULA_OO_URL     OnlyOffice 地址（从本容器可达），如 http://onlyoffice/
  NEBULA_OO_SECRET  OnlyOffice 的 JWT 密钥（必须与 OnlyOffice 侧一致）
  NEBULA_OO_PUBLIC  OnlyOffice 的浏览器可见地址，如 http://192.168.1.10:8082/
  NEBULA_PREVIEW    kkFileView 地址，默认 http://127.0.0.1:8012
  NEBULA_PREVIEW_PUBLIC  kkFileView 的浏览器可见前缀，默认 /preview
  NEBULA_ADMIN_USER / NEBULA_ADMIN_PASSWORD  首次启动创建的管理员
  NEBULA_DATA_DIR   数据目录（SQLite、缩略图缓存），默认 /var/lib/nebula

NEBULA_MOUNTS 格式（**用 | 分隔字段**，用 ; 分隔多组）：
  显示名|容器内路径|可见用户
  例：文档|/mnt/docs|alice,bob;公共|/mnt/public|*

  第三段用 * 表示所有登录用户可见；留空 / 省略均等同于 *。
  用户在前端只会看到自己有权限的目录。

  ★ 为什么用 | 而不是 : 作分隔符（**这是踩过的坑**）★
    初版用冒号分隔，结果 Windows 盘符路径 `E:\\data` 被切成 ['E','\\data']。
    改成「从两端夹逼 + 盘符启发式」后虽然能跑，但两段式写法
    `公共:/mnt/public` 依然无法判定是「显示名:路径」还是「路径:用户」——
    格式本身有歧义，靠启发式永远修不干净。
    最终方案：**换一个绝不会出现在路径里的分隔符 |**。
    现在冒号可以随便出现在路径里（Windows 盘符、UNC、URL 片段都行），
    解析变成纯粹的无歧义 split。

  兼容：仍接受旧的冒号写法（走 _parse_colon_legacy），启动时会打印
  迁移提示。但新配置请一律用 |。
"""

from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


@dataclass
class Mount:
    """一个对外暴露的目录映射。"""

    label: str          # 显示名（前端侧边栏 / 桌面图标）
    path: str           # 容器内绝对路径
    users: set[str]     # 可见用户集合；{"*"} 表示所有人
    writable: bool = True

    @property
    def public(self) -> bool:
        return "*" in self.users

    def visible_to(self, username: str) -> bool:
        return self.public or username in self.users

    @property
    def exists(self) -> bool:
        return Path(self.path).is_dir()


@dataclass
class Settings:
    # ---- 目录映射 ----
    mounts: list[Mount] = field(default_factory=list)

    # ---- 自有会话 ----
    jwt_secret: str = ""
    session_hours: int = 12

    # ---- OnlyOffice ----
    oo_url: str = ""
    oo_secret: str = ""
    oo_public: str = ""
    oo_enabled: bool = False

    # ---- kkFileView ----
    preview_url: str = "http://127.0.0.1:8012"
    preview_public: str = "/preview"

    # ---- CAD 查看器（独立服务，可选）----
    # cad_url   : 给浏览器用的地址（必须浏览器可达）
    # cad_probe : 给本容器探活用的地址（容器间可达）；缺省同 cad_url
    cad_url: str = ""
    cad_probe: str = ""
    cad_enabled: bool = False

    # ---- 其它 ----
    data_dir: str = "/var/lib/nebula"
    admin_user: str = "admin"
    admin_password: str = ""
    title: str = "NebulaDisk"
    max_upload_mb: int = 2048
    # 对外基准地址（用于生成 OnlyOffice 能回访的文档 URL）。
    # 留空则按请求自动推断。反代/NAS 场景建议显式配置。
    base_url: str = ""

    # ---- 跨域（CORS）----
    # 允许哪些来源直接以 XHR/fetch 调用本服务的 /api/*。
    #
    # 为什么需要它：本服务的正常使用者是「同源的云盘前端」，所以历史上
    # 一个 CORS 头都没发 —— 同源请求不需要。但外部集成方（例如思源笔记插件）
    # 的页面跑在**另一个 origin**（http://127.0.0.1:6806），
    # 浏览器会先发 OPTIONS 预检再实际请求，服务端不回 CORS 头就一律被拦。
    # 早先的绕法是插件自带一个本地 Node 反向代理来"洗掉"跨域，
    # 但那个方案要求客户端能跑 Node，网页端/手机端用不了。
    #
    # 取值：
    #   "*"       允许任意来源（**只发 Access-Control-Allow-Origin，
    #             绝不发 Allow-Credentials**，见 main.py 的说明）
    #   "a,b"     逗号分隔的来源白名单；命中就回显该来源
    #   空字符串   不下发任何 CORS 头（保持旧行为，纯同源部署用）
    #
    # ⚠️ 安全提醒：本服务在内网。若同时暴露到公网，请务必改成显式白名单，
    #    不要留 "*"。
    cors_origins: str = "*"


def parse_cors_origins(raw: str) -> list[str]:
    """解析 NEBULA_CORS_ORIGINS。

    返回规范化的来源列表；空串返回空列表（= 不发 CORS 头）。

    规范化要点：来源比较是**逐字符**的（浏览器就是这么判的），
    所以 http://a.com 与 http://a.com/ 是两个不同来源，必须去掉尾部斜杠，
    否则用户填了个带斜杠的地址就会莫名其妙不生效。
    """
    items: list[str] = []
    for part in (raw or "").split(","):
        v = part.strip().rstrip("/")
        if v:
            items.append(v)
    return items

    # 每个映射的实际读写性（由挂载模式推断，非配置项，运行时填充）
    _mount_ro: dict[str, bool] = field(default_factory=dict)


def parse_mounts(raw: str) -> list[Mount]:
    """解析 NEBULA_MOUNTS 字符串。

    主格式（无歧义）：
        显示名|路径|用户段
        显示名|路径                （用户段缺省 = *）
        路径|用户段                （显示名缺省 = 目录名）
        路径                       （不行 —— 必须至少有一个 |）

    '|' 不会出现在文件路径里，所以 split("|") 是安全的，
    冒号可以自由出现在路径中（Windows 盘符、UNC、URL 都行）。

    旧格式（兼容）：用 ':' 分隔。因为格式本身有歧义，仅在检测到
    完全不含 '|' 时才走这条路径，并按 _parse_colon_legacy 的启发式处理。
    """
    mounts: list[Mount] = []
    if not raw:
        return mounts

    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue

        if "|" in chunk:
            m = _parse_pipe(chunk)
        else:
            m = _parse_colon_legacy(chunk)

        if m is not None:
            mounts.append(m)

    return mounts


def _parse_pipe(chunk: str) -> Mount | None:
    """解析 '|' 分隔的新格式。"""
    parts = [p.strip() for p in chunk.split("|")]

    if len(parts) == 1:
        print(f"[config] 跳过非法映射（缺少 '|' 分隔）: {chunk}", file=sys.stderr)
        return None

    if len(parts) == 2:
        # 二段式：哪一段像路径，哪一段就是路径
        a, b = parts
        if _looks_like_path(a) and not _looks_like_path(b):
            label, path, users_raw = "", a, b
        elif _looks_like_path(b) and not _looks_like_path(a):
            label, path, users_raw = a, b, ""
        else:
            # 两段都不像路径 → 当作 显示名|路径 的正常写法
            label, path, users_raw = a, b, ""
    else:
        # 三段及以上：只取前三段，多余的忽略（并在日志里提醒）
        if len(parts) > 3:
            print(f"[config] 映射段数过多，仅取前三段: {chunk}", file=sys.stderr)
        label, path, users_raw = parts[0], parts[1], parts[2]

    if not path:
        print(f"[config] 跳过空路径映射: {chunk}", file=sys.stderr)
        return None

    if not label:
        cleaned = path.replace("\\", "/").rstrip("/")
        label = Path(cleaned).name or path

    users = _parse_users(users_raw)
    return Mount(label=label, path=path, users=users)


def _parse_colon_legacy(chunk: str) -> Mount | None:
    """兼容旧的 ':' 分隔格式。

    ⚠️ 这条路只在整条配置完全没有 '|' 时才走。它带着已知歧义：
      Windows 盘符 `D:\\data` 的冒号、以及两段式的归属都只能靠启发式猜。
    启动时打印一次迁移提示，建议改用 '|'。
    """
    head, sep, users_raw = chunk.rpartition(":")
    if not sep:
        print(f"[config] 跳过非法映射（缺少分隔符）: {chunk}", file=sys.stderr)
        return None

    head, users_raw = head.strip(), users_raw.strip()

    # 两段式 "A:B"：B 像路径就说明 A:B 其实整体是路径
    if _looks_like_path(users_raw):
        label, path, users_raw = "", f"{head}:{users_raw}", ""
    else:
        label, sep2, path = head.partition(":")
        label, path = label.strip(), path.strip()
        if not sep2:
            # head 无冒号 → 是 "路径:用户"，省略了显示名
            label, path = "", head
        elif len(label) == 1 and path[:1] == "\\":
            # 盘符误判修正：只认反斜杠，避免误伤 POSIX 的 x:/tmp
            label, path = "", f"{label}:{path}"

    if not path:
        print(f"[config] 跳过空路径映射: {chunk}", file=sys.stderr)
        return None

    if not label:
        cleaned = path.replace("\\", "/").rstrip("/")
        label = Path(cleaned).name or path

    users = _parse_users(users_raw)
    return Mount(label=label, path=path, users=users)


def _parse_users(users_raw: str) -> set[str]:
    if users_raw in ("", "*"):
        return {"*"}
    users = {u.strip() for u in users_raw.split(",") if u.strip()}
    return users or {"*"}


def _looks_like_path(s: str) -> bool:
    """判断一个字符串更像文件路径而不是用户名列表。

    用户名只允许字母数字下划线短横点，不会含斜杠；
    所以出现 '/' 或 '\\' 基本可以断定是路径。
    """
    if not s:
        return False
    return "/" in s or "\\" in s


def _looks_like_path(s: str) -> bool:
    """判断一个字符串更像文件路径而不是用户名列表。

    用户名只允许字母数字下划线短横点，所以出现 / \\ 或含空格/中文
    基本可以断定是路径 —— 用户不会用这些字符当用户名。
    """
    if not s:
        return False
    if "/" in s or "\\" in s:
        return True
    # Windows 盘符起始（C:）在 rpartition 后不会留在 users 段，无需处理
    return False


def _load_or_create_secret_file(path: Path) -> str:
    """读取持久化密钥；不存在则生成一份并写入（权限 0600）。

    并发安全：多进程同时首次启动时，用 O_EXCL 抢占，抢输的一方重新读文件。
    写入失败（只读挂载等）时退回进程内随机值，保证服务仍能起来。
    """
    try:
        if path.exists():
            val = path.read_text(encoding="utf-8").strip()
            if val:
                return val
    except OSError:
        pass

    val = secrets.token_urlsafe(48)
    try:
        # 数据目录若是相对路径（例如 Windows 上 "/var/lib/nebula" 被当成相对路径），
        # 这里统一转成绝对路径，避免把 secret.key 散落到当前工作目录。
        path = Path(path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        # O_EXCL + mode 0600：防止两个进程各写一份，也防止密钥被别人读到
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(val)
        print(f"[config] 已生成会话密钥并持久化到 {path}", file=sys.stderr)
        return val
    except FileExistsError:
        # 另一个进程先写成功了，用它那份
        try:
            return path.read_text(encoding="utf-8").strip() or val
        except OSError:
            return val
    except OSError as e:
        print(f"[config] 会话密钥写入 {path} 失败（{e}），"
              f"改用进程内临时密钥；多进程/重启后会话将失效", file=sys.stderr)
        return val


def load_settings() -> Settings:
    s = Settings()

    s.mounts = parse_mounts(_env("NEBULA_MOUNTS"))

    # 会话密钥：未配置时生成一次并落盘复用。
    #
    # 这里踩过坑：早先每次进程启动都随机生成，看似"重启后需重新登录"可以接受，
    # 实际有两个真问题：
    #   1) 任何第二个进程（CLI 工具、定时任务、worker）拿到的密钥都不同，
    #      它签的 token 主服务验不过，反过来也一样 —— 联调时表现为满屏 401，
    #      而且看起来像"鉴权坏了"，极难定位。
    #   2) 容器重启 = 全员掉线，NAS 上体验很差。
    # 所以改成：生成后写进数据目录，之后的进程直接读同一份。
    s.jwt_secret = _env("NEBULA_JWT_SECRET")
    if not s.jwt_secret:
        s.jwt_secret = _load_or_create_secret_file(
            Path(_env("NEBULA_DATA_DIR", "/var/lib/nebula")) / "secret.key")

    s.session_hours = int(_env("NEBULA_SESSION_HOURS", "12") or 12)

    s.oo_url = _env("NEBULA_OO_URL").rstrip("/")
    s.oo_secret = _env("NEBULA_OO_SECRET")
    s.oo_public = _env("NEBULA_OO_PUBLIC").rstrip("/")
    # 只要配了地址就认为启用；密钥为空时 OnlyOffice 会拒绝，届时日志会提示
    s.oo_enabled = bool(s.oo_url)
    if s.oo_enabled and not s.oo_secret:
        print("[config] 警告：NEBULA_OO_URL 已配置但 NEBULA_OO_SECRET 为空，"
              "OnlyOffice 将无法签名，文档打不开。", file=sys.stderr)

    s.preview_url = _env("NEBULA_PREVIEW", "http://127.0.0.1:8012").rstrip("/")
    s.preview_public = _env("NEBULA_PREVIEW_PUBLIC", "/preview").rstrip("/")

    # CAD 查看器（独立服务，可选）。不配就自动降级给 kkFileView。
    #   NEBULA_CAD_URL    —— 给**浏览器**用的地址（必须浏览器可达，如 /cad 反代）
    #   NEBULA_CAD_PROBE  —— 给**本容器**探活用的地址（如 http://cadviewer:8080）
    # 这两个必须分开，原因和 OnlyOffice 一样：容器间地址与浏览器地址不是一个。
    s.cad_url = _env("NEBULA_CAD_URL").rstrip("/")
    s.cad_probe = _env("NEBULA_CAD_PROBE").rstrip("/") or s.cad_url
    s.cad_enabled = bool(s.cad_url)

    s.data_dir = _env("NEBULA_DATA_DIR", "/var/lib/nebula")
    s.admin_user = _env("NEBULA_ADMIN_USER", "admin")
    s.admin_password = _env("NEBULA_ADMIN_PASSWORD")
    s.title = _env("NEBULA_TITLE", "NebulaDisk")
    s.max_upload_mb = int(_env("NEBULA_MAX_UPLOAD_MB", "2048") or 2048)
    s.base_url = _env("NEBULA_BASE_URL").rstrip("/")
    # 默认 "*"：本服务是内网自托管网盘，默认允许外部集成方（笔记插件等）
    # 跨域调用；同时**不**下发 Allow-Credentials，所以浏览器不会带上
    # 本服务的会话 Cookie —— 跨域调用方必须自己用 Authorization: Bearer。
    # 这就把"允许跨域读取"和"凭据不泄漏"两件事分开了。
    s.cors_origins = _env("NEBULA_CORS_ORIGINS", "*")

    return s


# ---------------------------------------------------------------------------
# 全局单例
# ---------------------------------------------------------------------------
settings = load_settings()


# ---------------------------------------------------------------------------
# 文件类型判定 —— 三级引擎路由
# ---------------------------------------------------------------------------
# 路由优先级（route_of 里按此顺序判断）：
#   1. cad      —— dwg/dxf 交给独立 cad-viewer 服务（专门的 CAD 渲染引擎，
#                  能正确解析图元、支持图层/布局，比 kkFileView 转 SVG 好得多）
#   2. onlyoffice —— Office 文档交给 OnlyOffice（可编辑）
#   3. kkfileview —— 其余可在线预览的类型交给 kkFileView（只读，格式最全）
#   4. download  —— 都没有能力，只能下载
#
# ★ 关键前提：cad-viewer 是**独立服务**（不在本容器里）。
#   它的地址由 NEBULA_CAD_URL 配置；不配则该类型自动降级到 kkfileview，
#   这样单容器部署也不会因为少一个依赖就报错。

# --- CAD 图纸：交给独立 cad-viewer ---
#
# ★ 只放 dwg / dxf，这是实测结论，不是保守 ★
#   cad-viewer:1.7.0 的渲染内核是 WASM 版 ODA/Teigha 转换器，前端 bundle 里
#   只注册了 .dwg / .dxf 两个入口：
#       grep -oE '\.(dwg|dxf|dwf|dwt|...)' assets/main-*.js  →  只有 .dwg .dxf
#   用户列举的 dwf / dwt / dwfx / cf2 / plt / dng 等虽然同属 CAD 家族，
#   但把这个服务当成它们能开的引擎只会得到「打开失败」——
#   那些类型改由 kkFileView 走兜底（见下面 KK_EXT），至少还能转出图来。
#   哪天 cad-viewer 升级支持了更多格式，在这里加一项即可。
CAD_EXT = {"dwg", "dxf"}

# --- OnlyOffice 可直接编辑的类型 ---
#
# ★ 这份清单直接决定「哪些文件用 OnlyOffice 打开」★
#
#   ── 2026-09-21 重要收窄（用户要求）──
#   用户原文：「OnlyOffice 应该可以打开 pdf，csv/tsv，rtf，与 office 关联
#             比较强的走 onlyoffice，其他的都给 kkfileview 预览」
#
#   收窄前的问题：清单把 Office / WPS / OpenOffice 三大家族的**全部**可编辑
#   格式（共 34 个）都收了进来，导致 OnlyOffice 几乎抢走了所有 Office 系文件。
#   用户的实际期望是**分工**：
#     · OnlyOffice = 「确实是 Office、且编辑需求强」的那批
#     · 其余（模板 / 加载项 / OpenDocument / 纯文本）→ kkFileView 只读预览
#       （这些格式多数场景下只是"看一眼"，用只读预览更轻、更快，
#        也不必为每次打开拉起一个可编辑会话）
#
#   保留在 OnlyOffice 的判定标准（三条，满足其一即留）：
#     ① Office 家族的主流可编辑格式：doc(x/m)、xls(x/m)、ppt(x/m)
#     ② 用户明确点名要与 Office 关联处理的：pdf / csv / tsv / rtf
#        （pdf 是提交/流转文档的事实标准；csv/tsv 是表格数据；
#          rtf 是 Word 生态的交换格式 —— 这三类都保留了）
#
#   迁出到 kkFileView 的（共 21 个，全部 kkFileView 均支持，不会退化成下载）：
#     · 模板类：dot/dotx/dotm（Word）、xlt/xltx/xltm（Excel）、
#               pot/potx/potm（PPT）
#     · 加载项：xla/xlam
#     · OpenDocument：odt/ods/odp、ott/ots/otp、fodt/fods/fodp
#     · 纯文本：txt（浏览器/kkFileView 预览已足够，无需可编辑会话）
#
#   ★ 注意：这些迁出的格式在 KK_EXT 里**本来就有**（两表重叠是刻意设计，
#     用于 OnlyOffice 未启用时的降级），所以收窄清单不会造成任何
#     "无引擎可用"的空洞。selfcheck 里有专门断言守着这一点。
#
#   ★ 为什么不留模板/加载项在 OO：
#     OnlyOffice 打开模板时只是以普通文档呈现，并不会真的按模板语义工作；
#     而"打开一个 .dot 看着像 .doc"对用户来说反而是误导。交给 kkFileView
#     只读预览，语义更诚实。
OO_EDIT_EXT = {
    # --- Word 系（主流可编辑）---
    "doc", "docx", "docm",
    # --- Excel 系（主流可编辑）---
    "xls", "xlsx", "xlsm",
    # --- PowerPoint 系（主流可编辑）---
    "ppt", "pptx", "pptm",
    # --- 与 Office 关联强、用户点名保留的 ---
    "pdf",     # OnlyOffice 支持查看与批注；也是流转文档的事实标准
    "csv", "tsv",   # 表格数据（OO 当电子表格打开）
    "rtf",     # Word 生态的交换格式
}

# 可编辑但通常只做查看的类型（Office 里只读打开）
OO_VIEW_EXT = {"pdf"}

# --- 交给 kkFileView 只读预览的类型（它的强项：格式覆盖最广）---
#
# ★ 这里同时承担两个角色 ★
#   1) OnlyOffice 不可用时的**降级目标**（Office/WPS/OpenOffice 全系列都在下面重复列了一遍）
#   2) 本身就是 kkFileView 专属强项的类型（压缩包、图元、3D、视频转码…）
KK_EXT = {
    # ===== 文档（OnlyOffice 没启用时的兜底，故与 OO_EDIT_EXT 大量重叠）=====
    "doc", "docx", "docm", "dot", "dotx", "dotm",
    "xls", "xlsx", "xlsm", "xlt", "xltx", "xltm", "xlam", "xla", "csv", "tsv",
    "ppt", "pptx", "pptm", "pot", "potx", "potm",
    "odt", "ott", "fodt", "ods", "ots", "fods", "odp", "otp", "fodp",
    "rtf", "pdf", "ofd", "pages", "numbers", "key", "six",
    # ===== 国产 WPS =====
    "wps", "wpt", "et", "ett", "dps", "dpt",
    # ===== 文本 / 代码 / 标记 =====
    "txt", "md", "markdown", "log", "ini", "conf", "properties", "yaml", "yml",
    "json", "xml", "xbrl", "html", "htm", "css", "js", "ts", "java", "py", "go",
    "rs", "c", "cpp", "h", "hpp", "cs", "php", "rb", "sh", "bat", "sql", "vue",
    # ===== 图片 =====
    "jpg", "jpeg", "jfif", "png", "gif", "bmp", "webp", "svg", "ico",
    "tif", "tiff", "tga",
    # heic/heif：现代 iPhone 默认格式。kkFileView 5.x 依赖的 ImageIO 可能
    # 解不了，但列入后至少会尝试走图片通道，比直接「无预览」体验好；
    # 真解不了会退化成下载，行为与加入前一致，无副作用。
    "heic", "heif",
    # ===== 音视频 =====
    "mp4", "webm", "mkv", "mov", "avi", "flv", "wmv", "mp3", "wav", "flac",
    "aac", "ogg", "m4a",
    # 视频转码家族（kkFileView 会调 ffmpeg 转 mp4 再播）
    "rm", "rmvb", "mpeg", "mpg", "3gp", "ts", "vob", "asf",
    # ===== 压缩包 =====
    "zip", "rar", "7z", "tar", "gz", "gzip", "bz2", "xz", "jar",
    # ===== CAD：cad-viewer 不可用时由 kkFileView 转 SVG 顶上 =====
    "dwg", "dxf", "dwf", "dwfx", "dwt", "dng", "cf2", "plt",
    # ===== 3D 模型 =====
    "obj", "3ds", "stl", "ply", "gltf", "glb", "off", "3dm", "fbx", "dae",
    "wrl", "3mf", "ifc", "brep", "step", "stp", "iges", "igs", "fcstd", "bim",
    # ===== Windows 图元 / Photoshop =====
    "wmf", "emf", "psd", "eps",
    # ===== 邮件 / 电子书 / 其他 =====
    "eml", "msg", "epub", "mobi", "dcm", "drawio", "xmind",
    "bpmn", "vsd", "vsdx",
}


def ext_of(name: str) -> str:
    """取小写扩展名（不含点）。"""
    if "." not in name:
        return ""
    return name.rsplit(".", 1)[-1].lower()


def route_of(name: str) -> str:
    """决定文件用哪个引擎打开。

    返回：
      'cad'        —— 用独立 cad-viewer 服务打开（DWG/DXF，渲染质量最好）
      'onlyoffice' —— 用 OnlyOffice 打开（可编辑）
      'kkfileview' —— 用 kkFileView 只读预览
      'download'   —— 无在线预览能力，只能下载

    ★ 分工原则（2026-09-21 收窄后）★
      OnlyOffice 只处理「确实是 Office、编辑需求强」的那批
      （doc/xls/ppt 主流格式 + pdf/csv/tsv/rtf），
      其余（模板 / 加载项 / OpenDocument / txt 等）一律交给
      kkFileView 只读预览 —— 详见 OO_EDIT_EXT 上方注释。
    """
    ext = ext_of(name)

    # 1) CAD 优先（前提是配了 cad-viewer 地址，否则降级）
    if ext in CAD_EXT and settings.cad_enabled:
        return "cad"

    # 2) OnlyOffice（编辑能力）—— 仅限收窄后的 OO_EDIT_EXT
    if settings.oo_enabled and ext in OO_EDIT_EXT:
        return "onlyoffice"

    # 3) 其余交给 kkFileView
    #    注意：OO_EDIT_EXT 里的格式在 kk_enabled 时也都在 KK_EXT 中，
    #    所以「OnlyOffice 未启用」时会自然降级到 kkFileView，不会落空。
    if ext in KK_EXT:
        return "kkfileview"

    return "download"


# 危险类型：不在浏览器内联渲染，强制下载
DANGEROUS_EXT = {
    "exe", "msi", "bat", "cmd", "com", "scr", "pif", "vbs", "vbe", "js", "jse",
    "wsf", "wsh", "ps1", "psm1", "sh", "bash", "run", "jar", "app", "dmg",
    "iso", "img", "bin", "dll", "so", "dylib", "apk", "deb", "rpm",
}
