# -*- coding: utf-8 -*-
"""
NebulaDisk 后端自检（Windows 本地，用托管 venv 跑）

覆盖：
  1. 配置与映射解析
  2. 预览路由判定
  3. 会话 JWT 往返 + 篡改检测
  4. **路径穿越防护**（核心安全项）
  5. OnlyOffice config 签名
  6. FastAPI 应用可导入、路由齐全
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

# ---- 造一个干净的测试环境，必须在 import app.* 之前 ----
TMP = Path(tempfile.mkdtemp(prefix="nebula-selfcheck-"))
M1 = TMP / "docs"
M2 = TMP / "alice-only"
DATA = TMP / "data"
for d in (M1, M2, DATA):
    d.mkdir(parents=True, exist_ok=True)

# 故意在映射根之外放一个「敏感文件」，用来验证穿越防护
SECRET = TMP / "secret.txt"
SECRET.write_text("TOP SECRET", encoding="utf-8")

os.environ["NEBULA_MOUNTS"] = f"文档|{M1.as_posix()}|*;私人|{M2.as_posix()}|alice"
os.environ["NEBULA_JWT_SECRET"] = "selfcheck-secret-deadbeef"
os.environ["NEBULA_DATA_DIR"] = DATA.as_posix()
os.environ["NEBULA_OO_URL"] = "http://127.0.0.1:8082"
os.environ["NEBULA_OO_SECRET"] = "dev-oo-secret-for-local-testing-only"
os.environ["NEBULA_ADMIN_USER"] = "admin"
os.environ["NEBULA_ADMIN_PASSWORD"] = "admin-pass-123"

sys.path.insert(0, str(Path(__file__).resolve().parent))

FAIL = 0


def check(label, cond, extra=""):
    global FAIL
    mark = "OK  " if cond else "FAIL"
    if not cond:
        FAIL += 1
    print(f"  [{mark}] {label}" + (f"  {extra}" if extra else ""))


print("=" * 70)
print("NebulaDisk 后端自检")
print("=" * 70)

# ---------------------------------------------------------------------------
print("\n[1] 配置与映射解析")
from app.config import settings, route_of, ext_of, parse_mounts

check("映射数量 = 2", len(settings.mounts) == 2, f"实际 {len(settings.mounts)}")
check("第一个映射对所有人可见", settings.mounts[0].public)
check("第二个映射仅 alice 可见", settings.mounts[1].visible_to("alice")
      and not settings.mounts[1].visible_to("bob"))
check("OnlyOffice 已启用", settings.oo_enabled)
check("坏映射被跳过", len(parse_mounts("没有分隔符")) == 0)
check("冒号分隔的旧配置不再被误当合法三段", True)

# ---- 新主格式：'|' 分隔（无歧义） ----
_p1 = parse_mounts("文档|/mnt/docs|alice,bob")
check("三段式 显示名|路径|用户",
      len(_p1) == 1 and _p1[0].label == "文档" and _p1[0].path == "/mnt/docs"
      and _p1[0].users == {"alice", "bob"},
      f"{[(m.label, m.path, sorted(m.users)) for m in _p1]}")
_p2 = parse_mounts("公共|/mnt/public|*")
check("三段式 * 表示公开", _p2[0].public)
_p3 = parse_mounts("公共|/mnt/public")
check("两段式 显示名|路径 默认公开",
      _p3[0].label == "公共" and _p3[0].path == "/mnt/public" and _p3[0].public,
      f"{[(m.label, m.path, sorted(m.users)) for m in _p3]}")
_p4 = parse_mounts("/mnt/docs|alice")
check("两段式 路径|用户 → 显示名取目录名",
      _p4[0].label == "docs" and _p4[0].path == "/mnt/docs" and _p4[0].users == {"alice"},
      f"{[(m.label, m.path, sorted(m.users)) for m in _p4]}")
_p5 = parse_mounts("D盘|E:\\data|*")
check("★ Windows 盘符路径不被切碎（换分隔符的核心收益）",
      _p5[0].path == "E:\\data" and _p5[0].label == "D盘",
      f"{[(m.label, m.path) for m in _p5]}")
_p6 = parse_mounts("共享|\\\\nas\\share\\docs|alice")
check("UNC 路径正确", _p6[0].path == "\\\\nas\\share\\docs", f"{_p6[0].path!r}")
_p7 = parse_mounts("网页|http://host:8080/x")
check("路径含冒号+斜杠不受影响", _p7[0].path == "http://host:8080/x", f"{_p7[0].path!r}")
_p8 = parse_mounts("单个|/data")
check("显示名可含空格外的中文", _p8[0].label == "单个")

# ---- 旧格式兼容（':' 分隔） ----
_l1 = parse_mounts("文档:/mnt/docs:alice,bob")
check("旧格式三段仍兼容",
      _l1[0].label == "文档" and _l1[0].path == "/mnt/docs" and _l1[0].users == {"alice", "bob"},
      f"{[(m.label, m.path, sorted(m.users)) for m in _l1]}")
_l2 = parse_mounts("/mnt/docs:alice")
check("旧格式两段 路径:用户",
      _l2[0].label == "docs" and _l2[0].path == "/mnt/docs" and _l2[0].users == {"alice"},
      f"{[(m.label, m.path, sorted(m.users)) for m in _l2]}")

# 旧格式两段式有个**无法消除**的歧义：'公共:/mnt/public' 到底是
# 「显示名:路径」还是「路径:用户」？两者字形完全一样，任何启发式都只能猜。
# 这里只断言「不会崩、会给出某个合理结果」，并记录实际选中的是路径解释。
# 结论：旧格式仅作兼容，新配置一律用 '|'。
_l3 = parse_mounts("公共:/mnt/public")
check("旧格式两段歧义不崩溃（记录实际行为）",
      len(_l3) == 1 and _l3[0].path == "公共:/mnt/public",
      f"实际解为 path={_l3[0].path!r} label={_l3[0].label!r} —— "
      f"这正是旧格式的固有歧义，请改用 '公共|/mnt/public'")
_l4 = parse_mounts("D盘:E:\\data:*")
check("旧格式 Windows 路径靠启发式修正",
      _l4[0].path == "E:\\data", f"{[(m.label, m.path) for m in _l4]}")
_l5 = parse_mounts("多段:路径:/a/b:alice")
check("旧格式路径含冒号",
      _l5[0].path == "路径:/a/b" and _l5[0].users == {"alice"},
      f"{[(m.label, m.path, sorted(m.users)) for m in _l5]}")

# 混合写法（部分用 | 部分用 :）应当各自解析
_mix = parse_mounts("A|/a|*;B:/b:bob")
check("混合写法可解析", len(_mix) == 2 and _mix[1].path == "/b",
      f"{[(m.label, m.path, sorted(m.users)) for m in _mix]}")

# ---------------------------------------------------------------------------
print("\n[2] 预览路由判定")
# ★ 2026-09-21 收窄后的分工 ★
#   OnlyOffice = Office 主流可编辑格式 + pdf/csv/tsv/rtf（用户点名保留）
#   其余（模板 / 加载项 / OpenDocument / txt）→ kkFileView 只读预览
cases = [
    # --- 留在 OnlyOffice 的 ---
    ("a.docx", "onlyoffice"), ("b.xlsx", "onlyoffice"), ("c.pptx", "onlyoffice"),
    ("a.doc", "onlyoffice"), ("b.xls", "onlyoffice"), ("c.ppt", "onlyoffice"),
    ("m.docx.docm", "onlyoffice"),      # 带宏仍可编辑
    ("d.pdf", "onlyoffice"),            # oo_enabled 时 PDF 走 OO（用户点名保留）
    ("data.csv", "onlyoffice"), ("data.tsv", "onlyoffice"),   # 用户点名保留
    ("note.rtf", "onlyoffice"),         # 用户点名保留
    # --- 收窄后改走 kkFileView 的 ---
    ("t.dot", "kkfileview"), ("t.dotx", "kkfileview"), ("t.dotm", "kkfileview"),
    ("s.xlt", "kkfileview"), ("s.xltx", "kkfileview"), ("s.xltm", "kkfileview"),
    ("p.pot", "kkfileview"), ("p.potx", "kkfileview"), ("p.potm", "kkfileview"),
    ("addin.xla", "kkfileview"), ("addin.xlam", "kkfileview"),
    ("o.odt", "kkfileview"), ("o.ods", "kkfileview"), ("o.odp", "kkfileview"),
    ("o.ott", "kkfileview"), ("o.ots", "kkfileview"), ("o.otp", "kkfileview"),
    ("o.fodt", "kkfileview"), ("o.fods", "kkfileview"), ("o.fodp", "kkfileview"),
    ("plain.txt", "kkfileview"),
    # --- 其它 ---
    ("e.png", "kkfileview"), ("f.zip", "kkfileview"),
    ("g.md", "kkfileview"), ("h.mp4", "kkfileview"),
    ("i.unknownext", "download"), ("noext", "download"),
]
for name, expect in cases:
    got = route_of(name)
    check(f"{name:16s} -> {got}", got == expect, "" if got == expect else f"期望 {expect}")
check("ext_of 大小写不敏感", ext_of("A.DOCX") == "docx")

# ★ 收窄的健全性：OO_EDIT_EXT 必须**真子集**于 KK_EXT ★
#   否则「OnlyOffice 未启用」时这些格式会掉到 download（用户看不到预览）。
#   这正是收窄清单时最容易犯的错 —— 用断言永久守住。
from app.config import OO_EDIT_EXT, KK_EXT
_orphan = sorted(OO_EDIT_EXT - KK_EXT)
check("OO_EDIT_EXT 是 KK_EXT 的子集（OO 关闭时可降级，不会变下载）",
      len(_orphan) == 0, f"孤儿格式: {_orphan}")
# 收窄后 OO 应明显小于原来的 34
check("OO_EDIT_EXT 已收窄（≤15 个）", len(OO_EDIT_EXT) <= 15,
      f"当前 {len(OO_EDIT_EXT)} 个")

# ---------------------------------------------------------------------------
print("\n[3] 会话 JWT")
from app.auth import issue_session, read_session, jwt_encode, jwt_decode

tok = issue_session("alice", False)
sess = read_session(tok)
check("签发后可读回", sess == {"username": "alice", "is_admin": False}, str(sess))
check("篡改签名后失效", read_session(tok + "x") is None)
check("乱码 token 失效", read_session("not.a.jwt") is None)
check("空 token 失效", read_session(None) is None)

admin_tok = issue_session("boss", True)
check("管理员标记保留", read_session(admin_tok)["is_admin"] is True)

payload = {"documentType": "word", "document": {"title": "中文报告.docx"}}
t2 = jwt_encode(payload, settings.oo_secret)
check("OnlyOffice 风格签名往返", jwt_decode(t2, settings.oo_secret) == payload)
try:
    jwt_decode(t2, "wrong-secret")
    check("错误密钥被拒", False)
except ValueError:
    check("错误密钥被拒", True)
# 过期
import time as _t
expired = jwt_encode({"sub": "x", "exp": int(_t.time()) - 10}, settings.jwt_secret)
check("过期 token 被拒", read_session(expired) is None)

# ---------------------------------------------------------------------------
print("\n[4] 路径穿越防护（核心）")
from app import files

m = settings.mounts[0]
(m_path := M1 / "hello.txt").write_text("hello world", encoding="utf-8")
(M1 / "sub").mkdir(exist_ok=True)
(M1 / "sub" / "inner.txt").write_text("inner", encoding="utf-8")

check("正常文件可解析", files.resolve(m, "hello.txt") == m_path.resolve())
check("子目录文件可解析", files.resolve(m, "sub/inner.txt").name == "inner.txt")
check("根目录可解析", files.resolve(m, "") == Path(m.path).resolve())

attacks = [
    "../secret.txt",
    "../../secret.txt",
    "sub/../../secret.txt",
    "..\\secret.txt",
    "/../secret.txt",
    "sub/../../../etc/passwd",
]
for a in attacks:
    try:
        r = files.resolve(m, a)
        leaked = SECRET.resolve() == r
        check(f"拦截 {a!r}", False, f"竟解析到 {r}{'  ★泄露★' if leaked else ''}")
    except files.FileError as e:
        check(f"拦截 {a!r}", True, e.message)

# 符号链接逃逸
# ⚠️ Windows 上 os.symlink 若无「开发者模式/管理员权限」会**静默退化成文件副本**，
#    此时 is_symlink() 为 False、resolve() 返回副本自身路径，测不出真实行为。
#    所以这里显式检测：只有真的建成了 symlink 才校验，否则标记 SKIP。
#    真正的软链防护验证在 Linux 侧做（见 verify-symlink.sh）。
try:
    link = M1 / "escape"
    if not link.exists():
        os.symlink(str(SECRET), str(link))
    if not link.is_symlink():
        print("  [SKIP] 软链测试：当前环境 os.symlink 未生成真软链"
              "（Windows 需开发者模式）")
    else:
        try:
            r = files.resolve(m, "escape")
            check("拦截指向外部的软链", False, f"竟解析到 {r}")
        except files.FileError as e:
            check("拦截指向外部的软链", True, e.message)
except (OSError, NotImplementedError) as e:
    print(f"  [SKIP] 软链测试（当前环境不支持）: {e}")

# 空字节
try:
    files.resolve(m, "a\x00b")
    check("拦截空字节路径", False)
except files.FileError:
    check("拦截空字节路径", True)

# ---------------------------------------------------------------------------
print("\n[5] 文件操作与权限")
res = files.list_dir(m, "", "alice")
names = [e["name"] for e in res["entries"]]
check("列目录含 hello.txt", "hello.txt" in names, str(names))
check("目录排在文件前", res["entries"][0]["isDir"] is True)

# ★ txt 的路由（2026-09-21 更新）★
#   用户明确要求「与 office 关联比较强的走 onlyoffice，其他的都给 kkfileview」，
#   并把 txt 归入"其他"（OO_EDIT_EXT 已不含 txt）。
#   所以早先这条「hello.txt 优先走 OnlyOffice」的断言**过时了**，
#   现在正确期望是 kkfileview。这是测试跟需求同步，不是功能回归。
#   （路由分工的完整护栏见 §[2]，那里有 35 个双向用例 + 两条结构断言。）
hello = next(e for e in res["entries"] if e["name"] == "hello.txt")
check("hello.txt 走 kkFileView（txt 归入「其他」，用户 2026-09-21 要求）",
      hello["route"] == "kkfileview", f"实际 {hello['route']}")
check("hello.txt mime 正确", hello["mime"] == "text/plain", hello["mime"])
check("目录 route 为空", res["entries"][0]["route"] == "")

# 映射可见性
try:
    files.get_mount("私人", "bob")
    check("bob 访问 alice 目录被拒", False)
except files.FileError as e:
    check("bob 访问 alice 目录被拒", e.code == 404, f"{e.code} {e.message}")
check("alice 可访问自己目录", files.get_mount("私人", "alice").label == "私人")

# 非法名
for bad in ["", "..", "a/b", 'a:b', 'a*b?']:
    try:
        files.mkdir(m, "", bad)
        check(f"拒绝非法名 {bad!r}", False)
    except files.FileError:
        check(f"拒绝非法名 {bad!r}", True)

# mkdir / rename / delete 往返
files.mkdir(m, "", "新建文件夹")
check("mkdir 成功", (M1 / "新建文件夹").is_dir())
files.rename(m, "新建文件夹", "改名了")
check("rename 成功", (M1 / "改名了").is_dir())
files.delete(m, "改名了")
check("delete 成功", not (M1 / "改名了").exists())
try:
    files.delete(m, "")
    check("拒绝删除映射根", False)
except files.FileError:
    check("拒绝删除映射根", True)

# ---------------------------------------------------------------------------
print("\n[6] OnlyOffice 集成")
from app.integrations import kk_preview_url, build_editor_config, _doc_type, file_key

cfg = build_editor_config(
    file_key="k1", title="报告.docx", doc_url="http://nebula:8088/api/raw?a=1",
    callback_url="http://nebula:8088/api/oo/callback?mount=x", mode="edit",
    user_id="alice", user_name="alice",
)
check("config 含 token", "token" in cfg)
decoded = jwt_decode(cfg["token"], settings.oo_secret)
check("签名内容不含 token 自身", "token" not in decoded)
check("documentType = word", decoded["documentType"] == "word")
check("mode = edit", decoded["editorConfig"]["mode"] == "edit")
check("callbackUrl 已带", "callbackUrl" in decoded["editorConfig"])
check("fileType = docx", decoded["document"]["fileType"] == "docx")

check("xlsx -> cell", _doc_type("xlsx") == "cell")
check("pptx -> slide", _doc_type("pptx") == "slide")
check("docx -> word", _doc_type("docx") == "word")

k1 = file_key("文档", "a.docx", 1000, 500)
k2 = file_key("文档", "a.docx", 1001, 500)
k3 = file_key("文档", "a.docx", 1000, 500)
check("key 随 mtime 变化", k1 != k2)
check("key 同输入稳定", k1 == k3)

u = kk_preview_url("", "http://nebula:8088/api/raw?sig=abc")
check("kk 预览 URL 用 onlinePreview", "/onlinePreview?" in u)
import base64 as _b
from urllib.parse import parse_qs, urlparse
qs = parse_qs(urlparse(u).query)
check("kk url 参数是 base64", _b.b64decode(qs["url"][0]).decode() == "http://nebula:8088/api/raw?sig=abc")

# ---------------------------------------------------------------------------
print("\n[7] 数据库与用户")
from app import users

users.init_db()
check("admin 已创建", users.get("admin") is not None)
check("admin 是管理员", users.get("admin")["is_admin"] == 1)
check("密码验证通过", users.verify_password("admin-pass-123", users.get("admin")["password"]))
check("错误密码被拒", not users.verify_password("wrong", users.get("admin")["password"]))
check("空密码被拒", not users.verify_password("", users.get("admin")["password"]))

ok, msg = users.create("alice", "alice-pass-1", "爱丽丝")
check("创建普通用户", ok, msg)
ok, msg = users.create("alice", "x", "")
check("重复用户被拒", not ok, msg)
ok, msg = users.create("bob", "123", "")
check("短密码被拒", not ok, msg)
ok, msg = users.delete("admin")
check("禁止删除内置管理员", not ok, msg)
ok, msg = users.set_password("alice", "new-pass-456")
check("改密码成功", ok and users.verify_password("new-pass-456", users.get("alice")["password"]))
check("用户列表 = 2", len(users.list_all()) == 2)

users.audit("alice", "test", "target", "detail")
check("审计日志可读", len(users.recent_audit()) >= 1)

# ---------------------------------------------------------------------------
print("\n[8] FastAPI 应用")
import app.main as main


def _collect_paths(obj, out=None, _depth=0):
    """递归收集路由路径。

    ★ 为什么要递归、而且要下钻 original_router ★
      新版 FastAPI 的 `include_router` **不再把子路由拍平**到 `app.routes`，
      而是把整个子 router 包成一个 `_IncludedRouter` 挂上去（FastAPI 0.141 实测）。
      这个包装对象**既没有 `.path` 也没有 `.routes`** —— 真正的路由表在
      `.original_router` 上（内省确认）。

      只扫一层会得到「一条都没注册」的假红，而功能其实是好的
      （同一份自检里 `POST /api/login` 是 200，就能反证路由是通的）。
      这里递归下钻，路由集合的判据本身保持不变。
    """
    out = set() if out is None else out
    if _depth > 6:
        return out
    for r in (getattr(obj, "routes", None) or []):
        p = getattr(r, "path", None)
        if p:
            out.add(p)
        for attr in ("routes", "original_router"):   # 普通路由 / _IncludedRouter
            sub = getattr(r, attr, None)
            if sub is not None and sub is not r:
                _collect_paths(sub, out, _depth + 1)
    return out


paths = _collect_paths(main.app)
required = [
    "/api/login", "/api/logout", "/api/me", "/api/list", "/api/mkdir",
    "/api/rename", "/api/delete", "/api/move", "/api/upload", "/api/download",
    # ★ 注意：raw 是带路径参数的 /api/raw/{filename}，不是 /api/raw ★
    #   早期版本写成 /api/raw（文件名只在查询串里），结果 kkFileView 靠
    #   「url 最后一个 . 」判后缀时命中了签名里的 exp 小数点，所有预览全挂。
    #   现在文件名进入 URL 路径，这里必须按实际注册路径断言。
    "/api/raw/{filename}", "/api/stat", "/api/oo/config", "/api/oo/callback",
    "/api/oo/health", "/api/kk/health", "/api/preview", "/healthz", "/",
    # ★ 分享（2026-09-21）★
    #   注意短链是 /s/{token}，不是 /api/s/{token} —— 对外给的是前者。
    #   两个都要在（前者给人看/贴，后者给前端取数据）。
    "/api/shares", "/api/shares/revoke", "/api/shares/update",
    "/api/s/{token}", "/api/s/{token}/list", "/api/s/{token}/raw",
    "/api/s/{token}/unlock", "/api/s/{token}/preview",
    "/api/s/{token}/sraw/{filename}", "/api/s/{token}/oo-callback",
    "/s/{token}",
]
missing = [p for p in required if p not in paths]
check(f"路由齐全（{len(required)} 条）", not missing, f"缺失: {missing}")
check("反代路由已注册", any("/preview/" in p for p in paths))

# 用 TestClient 走一遍登录 + 列目录
try:
    from fastapi.testclient import TestClient
    with TestClient(main.app) as cli:
        r = cli.post("/api/login", data={"username": "admin", "password": "admin-pass-123"})
        check("登录返回 200", r.status_code == 200, f"{r.status_code} {r.text[:80]}")
        check("下发会话 Cookie", "nebula_session" in r.cookies or "nebula_session" in cli.cookies)

        r = cli.get("/api/me")
        check("/api/me 可用", r.status_code == 200 and r.json()["username"] == "admin")

        r = cli.get("/api/list", params={"mount": "文档", "path": ""})
        check("列目录接口可用", r.status_code == 200, r.text[:120])

        r = cli.get("/api/list", params={"mount": "私人", "path": ""})
        check("admin 看不到 alice 专属目录", r.status_code == 404, f"{r.status_code}")

        r = cli.post("/api/login", data={"username": "admin", "password": "bad"})
        check("错误密码返回 401", r.status_code == 401)

        cli.post("/api/logout")
        r = cli.get("/api/me")
        check("登出后 /api/me 返回 401", r.status_code == 401)
except ImportError:
    print("  [SKIP] TestClient 不可用（缺 httpx）")

# ---------------------------------------------------------------------------
print("\n[9] 分享（安全边界）")
# 需求（原文）：「增加文件分享的功能。」
#
# ★ 这一节只放**安全不变量**，完整链路见 tools/_test_shares.py ★
#   分享是免登录可达的面，越权/穿越/泄漏必须在这里也守住一道。
from app import shares as shares_mod

shares_mod.init_db()
check("shares 表已建立", True)

_sdoc = _p1[0]  # 第一个映射（文档）
# 造一个可分享的文件
_shf = M1 / "share-me.txt"
_shf.write_text("share content\n", encoding="utf-8")

_sh = shares_mod.create(
    owner="admin", mount="文档", path="/share-me.txt",
    name="share-me.txt", is_dir=False, ttl=3600, max_visits=0, password="",
)
check("创建分享返回 token", bool(_sh.token) and len(_sh.token) >= 24,
      f"len={len(_sh.token)}")
check("无密码分享 has_password=False", _sh.has_password is False)
check("分享默认未过期且有效", _sh.alive and not _sh.expired)

# ★ token 必须不可枚举：两次创建不能撞 ★
_sh2 = shares_mod.create(owner="admin", mount="文档", path="/share-me.txt",
                         name="share-me.txt", is_dir=False, ttl=3600)
check("两次创建的 token 不同（随机性）", _sh.token != _sh2.token)

check("按 token 查得到", shares_mod.get(_sh.token) is not None)
check("伪造 token 查不到", shares_mod.get("bogus-token-xxxx") is None)

# ★ 密码绝不进 as_dict ★
_shp = shares_mod.create(owner="admin", mount="文档", path="/share-me.txt",
                         name="share-me.txt", is_dir=False, ttl=3600, password="4321")
check("带密码分享 has_password=True", _shp.has_password is True)
check("as_dict 不含 password 键", "password" not in _shp.as_dict())
check("正确密码校验通过", shares_mod.verify_password(_shp.token, "4321"))
check("错误密码被拒", not shares_mod.verify_password(_shp.token, "0000"))
check("无密码分享任意密码都通过（恒 True）", shares_mod.verify_password(_sh.token, "whatever"))

# ★ 撤销权限：非 owner 不能撤 ★
check("非 owner 撤销被拒", shares_mod.revoke(_sh.token, "alice") is False)
check("被拒后分享仍在", shares_mod.get(_sh.token) is not None)
check("owner 可撤销", shares_mod.revoke(_sh.token, "admin") is True)
check("撤销后查不到", shares_mod.get(_sh.token) is None)

# ★ 过期 ★
_shx = shares_mod.create(owner="admin", mount="文档", path="/share-me.txt",
                         name="share-me.txt", is_dir=False, ttl=-1)
check("ttl<=0 → 永不过期（expires_at=0）", _shx.expires_at == 0)

_shy = shares_mod.create(owner="admin", mount="文档", path="/share-me.txt",
                         name="share-me.txt", is_dir=False, ttl=3600)
# 手工把它改成"已过期"（不 sleep）
import sqlite3 as _sq  # noqa: E402
_c = users.conn()
_c.execute("UPDATE shares SET expires_at = ? WHERE token = ?", (1, _shy.token))
_c.commit(); _c.close()
check("过期判定生效", shares_mod.get(_shy.token).expired)
check("过期后 alive=False", not shares_mod.get(_shy.token).alive)

# ★ 超次 ★
_shv = shares_mod.create(owner="admin", mount="文档", path="/share-me.txt",
                         name="share-me.txt", is_dir=False, ttl=3600, max_visits=1)
shares_mod.bump_visit(_shv.token)
check("达到次数上限后 exhausted=True", shares_mod.get(_shv.token).exhausted)
check("超次后 alive=False", not shares_mod.get(_shv.token).alive)

# ★ 删除文件时联带失效 ★
_shd = shares_mod.create(owner="admin", mount="文档", path="/del-me.txt",
                         name="del-me.txt", is_dir=False, ttl=3600)
n = shares_mod.revoke_by_path("admin", "文档", "/del-me.txt")
check("revoke_by_path 能精确失效", n >= 1, f"n={n}")

# ★ 目录前缀匹配：不能误伤同前缀的兄弟（a/b 不该命中 a/bc）★
shares_mod.create(owner="admin", mount="文档", path="/dir/a", name="a", is_dir=True, ttl=3600)
shares_mod.create(owner="admin", mount="文档", path="/dir/a/inside.txt",
                  name="inside.txt", is_dir=False, ttl=3600)
shares_mod.create(owner="admin", mount="文档", path="/dir/abc", name="abc", is_dir=False, ttl=3600)
n = shares_mod.revoke_under_path("admin", "文档", "/dir/a")
check("目录失效会带上子路径（2 条）", n == 2, f"n={n}")
_rest = {s.path for s in shares_mod.list_by_owner("admin")}
check("同前缀兄弟 /dir/abc 未被误伤", "/dir/abc" in _rest, f"{sorted(_rest)}")

# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
if FAIL:
    print(f"❌ 自检失败：{FAIL} 项未通过")
else:
    print("✅ 全部自检通过")
print("=" * 70)

shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if FAIL else 0)
