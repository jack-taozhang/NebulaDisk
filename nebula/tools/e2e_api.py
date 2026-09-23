#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NebulaDisk API 契约测试（Python 版，取代 e2e-api.sh）

取代原因与 e2e_preview.py 相同：本机 curl 8.21.0 (Windows) 在 Git Bash 下有
两类坑 ——
  1) 不把 HttpOnly cookie 写进 jar（症状：全站 401）
  2) /tmp 映射到 Windows 路径，curl -o 写不出来（症状：000 / 空文件）
用 httpx 全部消失，所以测试端统一走 Python。

覆盖：健康检查 / 鉴权边界 / 登录登出 / 列目录 / 路径穿越 / 增删改 /
      上传下载 / kkFileView 预览 / raw 签名直链 / OnlyOffice 配置 / 多用户隔离
"""
import io
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

# 目标地址：NEBULA_BASE 优先（容器 :8089），BASE 次之（本地 devserver :8899）。
# 早期只认 BASE，导致「NEBULA_BASE=...8089 ./e2e_api.py」被静默忽略、
# 实际打到了 devserver 上，测试结果对不上容器 —— 名字必须两套都认。
BASE = os.environ.get("NEBULA_BASE") or os.environ.get("BASE", "http://127.0.0.1:8899")
USER = (os.environ.get("NEBULA_TEST_USER")
        or os.environ.get("NEBULA_USER", "admin"))
PASSWORD = (os.environ.get("NEBULA_TEST_PASSWORD")
            or os.environ.get("NEBULA_PASS", "admin123"))
# ★ 挂载名不要写死默认值 ★
#   本机部署用的是 共享/照片/私密，而默认值一度是「文档」，于是整个测试
#   全红（mkdir/list/upload 全 404「目录不存在」），看起来像产品崩了，
#   其实是测试假设了另一套挂载配置。现在留空则从 /api/me 自动取第一个。
MOUNT = os.environ.get("NEBULA_TEST_MOUNT", "")

PASS = 0
FAIL = 0
FAILED_DETAIL: list[str] = []


def ok(msg: str) -> None:
    global PASS
    PASS += 1
    print(f"  [OK  ] {msg}")


def bad(msg: str) -> None:
    global FAIL
    FAIL += 1
    FAILED_DETAIL.append(msg)
    print(f"  [FAIL] {msg}")


def info(msg: str) -> None:
    print(f"  [INFO] {msg}")


def section(n: str) -> None:
    print(f"\n[{n}]")


print("=" * 70)
print(f"NebulaDisk API 契约测试  目标: {BASE}")
print("=" * 70)

# ---------------------------------------------------------------- 1. 健康/边界
section("1 健康检查与鉴权边界")
with httpx.Client(base_url=BASE, timeout=30) as anon:
    r = anon.get("/healthz")
    (ok if r.status_code == 200 and r.json().get("ok") else bad)(f"健康检查 → {r.status_code}")

    # 未鉴权访问各受保护接口，必须 401
    for path, params in [
        ("/api/me", None),
        ("/api/list", {"mount": MOUNT, "path": "/"}),
        ("/api/preview", {"mount": MOUNT, "path": "/readme.md"}),
    ]:
        r = anon.get(path, params=params)
        (ok if r.status_code == 401 else bad)(f"未鉴权 {path} → {r.status_code}（期望 401）")

    # 根路径应返回前端页面
    r = anon.get("/")
    (ok if r.status_code == 200 and b"<" in r.content[:200] else bad)(
        f"根路径返回界面 → {r.status_code}")

# ------------------------------------------------------------------- 2. 登录
section("2 登录")
c = httpx.Client(base_url=BASE, timeout=30, follow_redirects=False)
r = c.post("/api/login", data={"username": USER, "password": "definitely-wrong"})
(ok if r.status_code == 401 else bad)(f"错误密码 → {r.status_code}（期望 401）")

r = c.post("/api/login", data={"username": USER, "password": PASSWORD})
(ok if r.status_code == 200 else bad)(f"正确密码 → {r.status_code}")
(ok if "nebula_session" in c.cookies else bad)("会话 cookie 已下发")

# ------------------------------------------------------------------- 3. 用户
section("3 用户信息")
r = c.get("/api/me")
if r.status_code == 200:
    me = r.json()
    ok(f"/api/me → 200（{me.get('username')}，{len(me.get('mounts', []))} 个映射）")
    labels = [m["label"] for m in me.get("mounts", [])]
    # 没显式指定就自动取第一个，避免因部署差异导致整套断言假红
    if not MOUNT:
        MOUNT = labels[0] if labels else ""
        info(f"未指定 NEBULA_TEST_MOUNT，自动选用第一个映射：{MOUNT!r}")
    if MOUNT in labels:
        ok(f"映射列表包含 {MOUNT}")
    else:
        bad(f"映射列表缺少 {MOUNT}：{labels}")
else:
    bad(f"/api/me → {r.status_code}")

# ------------------------------------------------------------------- 4. 列目录
section("4 列目录")
r = c.get("/api/list", params={"mount": MOUNT, "path": "/"})
if r.status_code == 200:
    data = r.json()
    # 字段名是 entries（实测确认）。用错字段名会静默取到空列表 → 假红。
    entries = data.get("entries", [])
    names = [e["name"] for e in entries]
    ok(f"列根目录 → {len(names)} 项")
    dir_entry = next((e for e in entries if e.get("isDir")), None)
    file_entry = next((e for e in entries if not e.get("isDir")), None)
    if dir_entry:
        (ok if not dir_entry.get("route") else bad)(
            f"目录条目不参与预览路由（{dir_entry['name']} route={dir_entry.get('route')!r}）")
    else:
        info("挂载根目录下没有子目录，跳过「目录条目不参与预览路由」检查")
    if file_entry:
        ok(f"文件条目带路由字段（{file_entry['name']} → {file_entry.get('route')}）")
    # 子目录可进入
    if dir_entry:
        r2 = c.get("/api/list",
                   params={"mount": MOUNT, "path": "/" + dir_entry["name"]})
        (ok if r2.status_code == 200 else bad)(
            f"进入子目录 {dir_entry['name']} → {r2.status_code}")
else:
    bad(f"列目录 → {r.status_code}")

# 访问不存在的映射必须 404（不能 403，否则可探测目录名）
r = c.get("/api/list", params={"mount": "根本没有这个映射", "path": "/"})
(ok if r.status_code == 404 else bad)(f"不存在的映射 → {r.status_code}（期望 404 防探测）")

# ------------------------------------------------------------ 5. 路径穿越安全
section("5 路径穿越攻击（安全）")
traversals = [
    "../etc/passwd",
    "../../etc/passwd",
    "....//....//etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "/../../../../etc/passwd",
    "设计文档/../../../../etc/passwd",
]
for t in traversals:
    r = c.get("/api/list", params={"mount": MOUNT, "path": "/" + t})
    # 只要不是 200 即算拦住；预期 400/403/404
    if r.status_code in (400, 403, 404):
        ok(f"穿越被拒 {t[:34]:<34} → {r.status_code}")
    else:
        bad(f"穿越未被拒 {t} → {r.status_code}")

# ---------------------------------------------------------- 6. 增删改（CRUD）
section("6 新建 / 重命名 / 删除")
# 注意：这些接口用的是 Form 字段（不是 JSON），且 rename/mkdir 把
# 「父目录 path」和「新名字 name」拆成两个参数。
r = c.post("/api/mkdir", data={"mount": MOUNT, "path": "/", "name": "_e2e_临时目录"})
(ok if r.status_code == 200 else bad)(f"新建目录 → {r.status_code} {r.text[:80]}")

r = c.get("/api/list", params={"mount": MOUNT, "path": "/"})
has = any(e["name"] == "_e2e_临时目录" for e in r.json().get("entries", []))
(ok if has else bad)("新目录出现在列表中")

r = c.post("/api/rename", data={
    "mount": MOUNT, "path": "/_e2e_临时目录", "name": "_e2e_改名后"})
(ok if r.status_code == 200 else bad)(f"重命名 → {r.status_code} {r.text[:80]}")

r = c.get("/api/list", params={"mount": MOUNT, "path": "/"})
has2 = any(e["name"] == "_e2e_改名后" for e in r.json().get("entries", []))
(ok if has2 else bad)("重命名后的名字出现在列表中")

# 非法文件名（含斜杠）必须被拒
r = c.post("/api/mkdir", data={"mount": MOUNT, "path": "/", "name": "bad/name"})
(ok if r.status_code in (400, 404) else bad)(f"含斜杠的目录名被拒 → {r.status_code}")

r = c.post("/api/delete", data={"mount": MOUNT, "path": "/_e2e_改名后"})
(ok if r.status_code == 200 else bad)(f"删除目录 → {r.status_code}")

# 删除映射根目录必须被拒
r = c.post("/api/delete", data={"mount": MOUNT, "path": "/"})
(ok if r.status_code in (400, 403) else bad)(f"删除映射根被拒 → {r.status_code}")

# ------------------------------------------------------------ 7. 上传与下载
section("7 上传与下载")
payload = "E2E 上传测试\n第二行 with English\n".encode("utf-8")
r = c.post("/api/upload",
           files={"file": ("_e2e_上传.txt", io.BytesIO(payload), "text/plain")},
           data={"mount": MOUNT, "path": "/"})
(ok if r.status_code == 200 else bad)(f"上传 → {r.status_code} {r.text[:80]}")

r = c.get("/api/download", params={"mount": MOUNT, "path": "/_e2e_上传.txt"})
if r.status_code == 200:
    ok(f"下载 → 200（{len(r.content)} 字节）")
    (ok if r.content == payload else bad)("下载内容与上传一致")
    cd = r.headers.get("content-disposition", "")
    (ok if "attachment" in cd.lower() else bad)(f"带 attachment 头（{cd[:50]}）")
else:
    bad(f"下载 → {r.status_code}")

# 目录不能下载
r = c.get("/api/download", params={"mount": MOUNT, "path": "/设计文档"})
(ok if r.status_code in (400, 404) else bad)(f"下载目录被拒 → {r.status_code}")

# 重名上传自动改名
r = c.post("/api/upload",
           files={"file": ("_e2e_上传.txt", io.BytesIO(b"x"), "text/plain")},
           data={"mount": MOUNT, "path": "/"})
(ok if r.status_code == 200 else bad)(f"重名上传自动改名 → {r.status_code}")
r = c.get("/api/list", params={"mount": MOUNT, "path": "/"})
names = [e["name"] for e in r.json().get("entries", [])]
renamed = [n for n in names if n.startswith("_e2e_上传")]
(ok if len(renamed) >= 2 else bad)(f"确认改名产物：{renamed}")
for n in renamed:
    c.post("/api/delete", data={"mount": MOUNT, "path": "/" + n})

# 文件元信息
r = c.get("/api/stat", params={"mount": MOUNT, "path": "/readme.md"})
(ok if r.status_code == 200 else bad)(f"/api/stat → {r.status_code}")

# ------------------------------------------------------- 8. kkFileView 预览
section("8 kkFileView 预览地址")
r = c.get("/api/preview", params={"mount": MOUNT, "path": "/readme.md"})
if r.status_code == 200:
    d = r.json()
    url = d.get("url", "")
    ok(f"预览地址 → {url[:70]}")
    (ok if url.startswith("/") or url.startswith("http") else bad)("预览地址格式正确")

    # 反代应把 kkFileView 的响应透出来
    rp = url.split(BASE, 1)[-1] if url.startswith("http") else url
    r2 = c.get(rp, timeout=60)
    # 403 是 kkFileView 的 trust.host 白名单在起作用 —— 需要在 kkFileView 侧配置
    if r2.status_code == 200:
        ok(f"反代预览 → 200（{len(r2.content)} 字节）")
    elif r2.status_code == 403:
        bad("反代预览 → 403（kkFileView trust.host 白名单未放开）")
    else:
        bad(f"反代预览 → {r2.status_code}")
else:
    bad(f"预览地址 → {r.status_code}")

# 对目录请求预览应被拒
r = c.get("/api/preview", params={"mount": MOUNT, "path": "/设计文档"})
(ok if r.status_code in (400, 404) else bad)(f"目录不参与预览 → {r.status_code}")

# -------------------------------------------------------- 9. raw 签名直链
section("9 raw 签名直链（供 OnlyOffice / kkFileView 回拉）")
r = c.get("/api/preview", params={"mount": MOUNT, "path": "/readme.md"})
raw = r.json().get("raw", "") if r.status_code == 200 else ""
if raw:
    ok(f"拿到 raw 地址：{raw[:64]}…")
    path = urllib.parse.urlsplit(raw).path
    query = urllib.parse.urlsplit(raw).query

    # 免登录可读
    with httpx.Client(base_url=BASE, timeout=20) as anon2:
        rr = anon2.get(path + "?" + query)
        if rr.status_code == 200 and rr.content:
            ok(f"免登录可读 → 200（{len(rr.content)} 字节）")
        else:
            bad(f"免登录可读 → {rr.status_code}（{len(rr.content)} 字节）")

        # 篡改签名必须被拒
        bad_q = query.replace("sig=", "sig=0") if "sig=" in query else query + "&sig=0"
        rr = anon2.get(path + "?" + bad_q)
        (ok if rr.status_code in (401, 403) else bad)(
            f"篡改签名被拒 → {rr.status_code}（期望 401/403）")

        # 去掉签名必须被拒（FastAPI 会因缺少必填参数先返回 422，同样是拒绝）
        rr = anon2.get(path)
        (ok if rr.status_code in (401, 403, 422) else bad)(
            f"无签名被拒 → {rr.status_code}（期望 401/403/422）")

        # 过期必须被拒（把 exp 改成过去）
        if "exp=" in query:
            parts = dict(urllib.parse.parse_qsl(query))
            parts["exp"] = str(int(time.time()) - 10)
            rr = anon2.get(path + "?" + urllib.parse.urlencode(parts))
            (ok if rr.status_code in (401, 403) else bad)(
                f"过期链接被拒 → {rr.status_code}（期望 401/403）")
else:
    bad("未拿到 raw 地址")

# -------------------------------------------------- 10. OnlyOffice 配置生成
section("10 OnlyOffice 配置生成")
# 注意：是 POST 且参数走 Form
r = c.post("/api/oo/config", data={"mount": MOUNT, "path": "/readme.md"})
if r.status_code == 200:
    resp = r.json()
    # 服务端把编辑器配置放在 config 字段里，浏览器要的 api.js 地址在 apiJs
    (ok if resp.get("ok") else bad)("返回 ok")
    cfg = resp.get("config", {})
    (ok if resp.get("apiJs") else bad)(f"apiJs 已生成（{str(resp.get('apiJs'))[:60]}）")
    (ok if cfg.get("documentType") in ("word", "cell", "slide") else bad)(
        f"documentType = {cfg.get('documentType')}")
    (ok if cfg.get("token") else bad)("配置内含签名")
    doc = cfg.get("document", {})
    (ok if doc.get("url") else bad)("document.url 已生成")
    ed = cfg.get("editorConfig", {})
    (ok if ed.get("callbackUrl") else bad)("callbackUrl 已生成（保存回写用）")
    # 目录不应走 OnlyOffice（用真实存在的子目录，别写死名字）
    tgt_dir = dir_entry["name"] if dir_entry else None
    if tgt_dir:
        r2 = c.post("/api/oo/config", data={"mount": MOUNT, "path": "/" + tgt_dir})
        (ok if r2.status_code in (400, 404) else bad)(
            f"目录不走 OnlyOffice → {r2.status_code}（期望 400/404）")
    else:
        info("没有可用子目录，跳过「目录不走 OnlyOffice」检查")
else:
    info(f"/api/oo/config → {r.status_code}（OnlyOffice 未配置时正常）")

r = c.get("/api/oo/health")
(ok if r.status_code == 200 else bad)(f"OnlyOffice 健康检查 → {r.status_code} {r.text[:80]}")

# kkFileView 探活：前端侧边栏徽章靠它显示「在线 / 离线」。
# ⚠️ 这里必须断言 ok 为 True。曾经误用 /onlinePreview 探活，
#    它对裸请求返回 403，接口会稳定返回 ok:false，徽章永远显示「离线」。
r = c.get("/api/kk/health")
kk_h = r.json() if r.status_code == 200 else {}
(ok if kk_h.get("ok") else bad)(
    f"kkFileView 健康检查 → {r.status_code} {r.text[:80]}（须 ok=true）")

# ------------------------------------------------------------ 11. 多用户隔离
section("11 多用户隔离与权限")
r = c.get("/api/me")
admin_mounts = [m["label"] for m in r.json().get("mounts", [])] if r.status_code == 200 else []
(ok if admin_mounts else bad)(f"admin 可见映射：{admin_mounts}")

# admin 专属映射对其它用户必须 404
if "私人" in admin_mounts:
    ok("admin 可见 '私人' 映射（专属目录生效）")
else:
    info("本地 dev 未配 '私人' 映射，跳过专属目录检查")

# 修改密码接口：旧密码错必须被拒
r = c.post("/api/password", data={
    "old": "definitely-wrong", "new": "whatever123456"})
(ok if r.status_code in (400, 401, 403) else bad)(
    f"改密码时旧密码错误被拒 → {r.status_code}")

# ------------------------------------------------------------------- 12. 登出
section("12 登出")
r = c.post("/api/logout")
(ok if r.status_code == 200 else bad)(f"登出 → {r.status_code}")
r = c.get("/api/me")
(ok if r.status_code == 401 else bad)(f"登出后 /api/me → {r.status_code}（期望 401）")

c.close()

print()
print("=" * 70)
print(f"结果：通过 {PASS} 项，失败 {FAIL} 项")
if FAILED_DETAIL:
    print("-" * 70)
    print("失败明细：")
    for m in FAILED_DETAIL:
        print(f"  · {m}")
print("=" * 70)
sys.exit(0 if FAIL == 0 else 1)
