#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OnlyOffice 保存回写链路验证（模拟 OnlyOffice 服务端的真实行为）

链路：
  1. 登录 → /api/oo/config 拿到 document.url 和 callbackUrl
  2. 校验 document.url 用的是容器名（OnlyOffice 容器可解析）
  3. 造一份「编辑后」的文档，让 nebula 容器能回拉到它
  4. 按 OnlyOffice 协议 POST callbackUrl：{"status":2,"url":...,"token":HS256}
  5. 校验宿主机映射目录里的文件确实被替换成新内容

★ 为什么要模拟而不是真的点编辑器 ★
  浏览器交互测试在本环境不可用（agent-browser 守护进程无法跨调用保持、
  Chromium 下载被网络策略拦掉）。但 OnlyOffice 保存这一步的本质就是
  「带签名 POST + 一个可下载的 url」，忠实复现它就能覆盖「保存回写」
  这条最容易出问题的链路。

★ 为什么「编辑后文档」要靠一个 helper 容器来托管 ★
  nebula 跑在容器里，而容器访问不到 WSL 宿主机（WSL2 NAT 限制，实测
  一律 connection refused）。所以宿主机上起的临时 HTTP 服务 nebula 拉不到。
  本脚本的做法：在**同网络的 OnlyOffice 容器**里写一个小文件 + 起
  python3 -m http.server，用完即清理。这样不需要任何手工前置步骤。

用法：
  NEBULA_PASS=xxx python tools/e2e_oo_save.py

环境变量：
  NEBULA_BASE          默认 http://127.0.0.1:8089
  NEBULA_PASS          必填（也认 NEBULA_TEST_PASSWORD / P）
  NEBULA_OO_SECRET     OnlyOffice 的 JWT 密钥；不给则自动从容器里读
  NEBULA_TEST_MOUNT    默认「共享」
  NEBULA_TEST_OO_FILE  默认 Office测试.docx
  NEBULA_HOST_DIR      宿主机上该映射对应的目录
  NEBULA_HELPER_CONTAINER  用于托管编辑后文档的容器，默认 maple-onlyoffice
"""
import hashlib
import hmac
import io
import json
import os
import subprocess
import sys
import time
import zipfile
from urllib.parse import urlsplit

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

BASE = os.environ.get("NEBULA_BASE") or "http://127.0.0.1:8089"
USER = os.environ.get("NEBULA_USER") or os.environ.get("NEBULA_TEST_USER", "admin")
# 两套名字都认（早期只认 NEBULA_PASS，本机习惯用 P=... 时会被静默跳过）
PASSWORD = (os.environ.get("NEBULA_PASS")
            or os.environ.get("NEBULA_TEST_PASSWORD")
            or os.environ.get("P", ""))
MOUNT = os.environ.get("NEBULA_TEST_MOUNT", "共享")
TARGET = os.environ.get("NEBULA_TEST_OO_FILE", "Office测试.docx")
HOST_SAVE_DIR = os.environ.get(
    "NEBULA_HOST_DIR",
    os.path.join(os.path.dirname(__file__), "..", "sample", "share"),
)
HELPER = os.environ.get("NEBULA_HELPER_CONTAINER", "maple-onlyoffice")
HELPER_PORT = int(os.environ.get("NEBULA_HELPER_PORT", "9999"))

PASS = 0
FAIL = 0


def ok(m):
    global PASS
    PASS += 1
    print(f"  [OK  ] {m}")


def bad(m):
    global FAIL
    FAIL += 1
    print(f"  [FAIL] {m}")


def info(m):
    print(f"  [INFO] {m}")


NEW_DOCX_TEXT = "内容已被 OnlyOffice 编辑并保存回来"


def build_docx(text: str = NEW_DOCX_TEXT) -> bytes:
    ct = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
    doc = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


def docker(*args: str) -> subprocess.CompletedProcess:
    """在 WSL 里执行 docker 命令（本机 docker 只存在于 WSL 内）。"""
    cmd = ["wsl.exe", "-e", "docker", *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60)


def in_wsl_exists(path_win: str) -> bool:
    p = path_win.replace("\\", "/")
    if len(p) > 1 and p[1] == ":":
        p = "/mnt/" + p[0].lower() + p[2:]
    r = subprocess.run(["wsl.exe", "-e", "sh", "-c", f"test -f '{p}' && echo yes"],
                       capture_output=True, text=True, timeout=30)
    return "yes" in r.stdout


def b64url(b: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def hs256_jwt(payload: dict, secret: str) -> str:
    """OnlyOffice 要求回调带 token，payload 就是 callback body 本身。"""
    head = b64url(json.dumps({"alg": "HS256", "typ": "JWT"},
                             separators=(",", ":")).encode())
    body = b64url(json.dumps(payload, separators=(",", ":"),
                             ensure_ascii=False).encode())
    sig = b64url(hmac.new(secret.encode(), f"{head}.{body}".encode(),
                          hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"


def get_secret() -> str:
    """取 OnlyOffice 密钥：环境变量优先，否则从 nebula 容器里读。"""
    s = os.environ.get("NEBULA_OO_SECRET", "")
    if s:
        return s
    r = docker("exec", "nebula", "printenv", "NEBULA_OO_SECRET")
    return (r.stdout or "").strip()


def start_helper(edited: bytes) -> str:
    """在 helper 容器里托管编辑后的文档，返回 nebula 能访问的 URL。"""
    import base64

    b64 = base64.b64encode(edited).decode()
    in_container = "/tmp/_nebula_edited.docx"
    r = docker("exec", HELPER, "sh", "-c",
               f"echo '{b64}' | base64 -d > {in_container} && "
               f"ls -la {in_container}")
    if r.returncode != 0:
        raise RuntimeError(f"写入 helper 失败: {r.stderr[:200]}")
    # 起 http.server；先杀可能残留的
    docker("exec", HELPER, "sh", "-c",
           f"pkill -f 'http.server {HELPER_PORT}' 2>/dev/null; true")
    docker("exec", "-d", HELPER, "sh", "-c",
           f"cd /tmp && nohup python3 -m http.server {HELPER_PORT} "
           f"--bind 0.0.0.0 >/tmp/_nebula_hs.log 2>&1 &")
    url = f"http://{HELPER}:{HELPER_PORT}/_nebula_edited.docx"
    # 等它就绪
    for _ in range(20):
        time.sleep(0.4)
        rr = docker("exec", "nebula", "sh", "-c",
                    f"curl -s -o /dev/null -w '%{{http_code}}' "
                    f"--max-time 4 '{url}'")
        if rr.stdout.strip() == "200":
            return url
    raise RuntimeError("helper http 服务未就绪")


def stop_helper() -> None:
    docker("exec", HELPER, "sh", "-c",
           f"pkill -f 'http.server {HELPER_PORT}' 2>/dev/null; "
           f"rm -f /tmp/_nebula_edited.docx /tmp/_nebula_hs.log; true")


def read_host_file(path: str) -> bytes | None:
    if os.path.exists(path):
        return open(path, "rb").read()
    return None


print("=" * 70)
print(f"OnlyOffice 保存回写验证  目标: {BASE}")
print("=" * 70)

if not PASSWORD:
    print("  [SKIP] 未提供 NEBULA_PASS，跳过")
    sys.exit(0)

host_file = os.path.join(HOST_SAVE_DIR, TARGET)

print("\n[1] 准备：确认目标文件存在并记录原始内容")
before = read_host_file(host_file)
if before is not None:
    ok(f"宿主机目标文件存在（{len(before)} 字节）")
else:
    bad(f"宿主机目标文件不存在：{host_file}")
    sys.exit(1)

print("\n[2] 获取 OnlyOffice 配置")
with httpx.Client(base_url=BASE, timeout=30) as c:
    r = c.post("/api/login", data={"username": USER, "password": PASSWORD})
    if r.status_code != 200:
        bad(f"登录失败 {r.status_code}")
        sys.exit(1)
    ok("登录成功")

    r = c.post("/api/oo/config", data={"mount": MOUNT, "path": "/" + TARGET})
    if r.status_code != 200:
        bad(f"/api/oo/config → {r.status_code}")
        sys.exit(1)
    cfg = r.json()["config"]
    doc_url = cfg["document"]["url"]
    cb_url = cfg["editorConfig"]["callbackUrl"]
    ok("document.url 已生成")
    ok("callbackUrl 已生成")
    info(f"document.url = {doc_url[:90]}")

    if doc_url.startswith("http://nebula:"):
        ok("document.url 用容器名（OnlyOffice 容器可解析）")
    else:
        bad(f"document.url 主机名可疑：{doc_url[:70]}")

    sp = urlsplit(cb_url)
    cb_path = sp.path + (("?" + sp.query) if sp.query else "")

    print("\n[3] 托管「编辑后」的文档并触发保存回调")
    edited = build_docx()
    helper_url = None
    try:
        helper_url = start_helper(edited)
        ok(f"编辑后文档已就绪：{helper_url}（{len(edited)} 字节）")

        body = {
            "key": cfg["document"].get("key", "testkey"),
            "status": 2,
            "url": helper_url,
            "users": [USER],
        }
        secret = get_secret()
        if not secret:
            bad("拿不到 NEBULA_OO_SECRET，无法签名回调")
            sys.exit(1)
        body["token"] = hs256_jwt(body, secret)

        r = c.post(cb_path, json=body)
        if r.status_code == 200 and r.json().get("error") == 0:
            ok(f"回调被接受 → {r.text.strip()}")
        else:
            bad(f"回调失败 {r.status_code}: {r.text[:200]}")
    finally:
        stop_helper()

print("\n[4] 校验宿主机文件是否被新内容覆盖")
for _ in range(20):
    time.sleep(0.5)
    now = read_host_file(host_file)
    if now is not None and now != before:
        break
after = read_host_file(host_file)
if after is None:
    bad(f"目标文件不见了：{host_file}")
elif after == before:
    bad("文件内容没有变化，保存回写没生效")
else:
    ok(f"文件已被覆盖（{len(before)} → {len(after)} 字节）")
    try:
        with zipfile.ZipFile(io.BytesIO(after)) as z:
            inner = z.read("word/document.xml").decode("utf-8")
        if NEW_DOCX_TEXT in inner:
            ok("新内容确实写入了（解压 docx 找到编辑后的文本）")
        else:
            bad("文件变了但找不到编辑后的文本")
    except Exception as e:  # noqa: BLE001
        bad(f"写回的不是合法 docx：{e}")

print()
print("=" * 70)
print(f"结果：通过 {PASS} 项，失败 {FAIL} 项")
print("=" * 70)
sys.exit(0 if FAIL == 0 else 1)
